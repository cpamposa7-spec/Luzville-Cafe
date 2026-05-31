const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT:", err.message);
  process.exit(1);
});

app.use(cors({ origin: "*" }));
app.use(express.json());

app.use(express.json());
app.use(express.static(__dirname));

// ================= DATABASE =================

// ================= DATABASE =================
const db = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  connectionLimit: 10
});

// ================= TEST DB =================
db.getConnection((err, connection) => {
  if (err) {
    console.log("❌ DB ERROR:", err.message);
  } else {
    console.log("✅ DB CONNECTED");

    connection.release();
  }
});

// ================= SERVER =================
const server = http.createServer(app);

// ================= SOCKET =================
const io = new Server(server, {
  cors: { origin: "*" }
});

const onlineUsers = new Map();

// ================= SOCKET =================
io.on("connection", (socket) => {

  console.log("🟢 SOCKET CONNECTED:", socket.id);

  socket.on("user-online", (userId) => {
    if (!userId) return;

    socket.userId = userId;
    onlineUsers.set(userId, socket.id);

    db.query("UPDATE users SET status='online' WHERE id=?", [userId]);

    io.emit("status-update", { userId, status: "online" });
  });

  socket.on("user-offline", () => {
    const userId = socket.userId;
    if (!userId) return;

    onlineUsers.delete(userId);

    db.query("UPDATE users SET status='offline' WHERE id=?", [userId]);

    io.emit("status-update", { userId, status: "offline" });
  });

  socket.on("disconnect", () => {
    const userId = socket.userId;

    if (userId && onlineUsers.get(userId) === socket.id) {
      onlineUsers.delete(userId);

      db.query("UPDATE users SET status='offline' WHERE id=?", [userId]);

      io.emit("status-update", { userId, status: "offline" });
    }

    console.log("🔴 DISCONNECTED:", socket.id);
  });
});

// ================= HOME =================
app.get("/", (req, res) => {
  res.json({ success: true, message: "API Running" });
});

// ================= LOGIN =================
app.post("/login", (req, res) => {

  const { username, password, role } = req.body;

  db.query(
    "SELECT * FROM users WHERE username=? AND password=?",
    [username, password],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      if (result.length === 0) {
        return res.status(401).json({ error: "Invalid login" });
      }

      const user = result[0];

      if (role && user.role !== role) {
        return res.status(403).json({ error: "Wrong role" });
      }

      res.json({ success: true, user });
    }
  );
});

// ================= USERS =================
app.get("/users", (req, res) => {
  db.query(
    "SELECT id, username, role, status FROM users WHERE role='cashier'",
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(result);
    }
  );
});

// ================= MENU =================
app.get("/menu", (req, res) => {
  db.query("SELECT * FROM menu ORDER BY id DESC", (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(result);
  });
});

app.post("/menu", (req, res) => {
  const { name, price } = req.body;

  if (!name || price === undefined) {
    return res.status(400).json({ error: "Name and price required" });
  }

  db.query(
    "INSERT INTO menu (name, price) VALUES (?, ?)",
    [name, Number(price)],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      res.json({ success: true, id: result.insertId });
    }
  );
});

app.put("/menu/:id", (req, res) => {
  const { name, price } = req.body;

  db.query(
    "UPDATE menu SET name=?, price=? WHERE id=?",
    [name, Number(price), req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      res.json({ success: true });
    }
  );
});

app.delete("/menu/:id", (req, res) => {
  db.query(
    "DELETE FROM menu WHERE id=?",
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      res.json({ success: true });
    }
  );
});

// ================= ORDERS =================
app.get("/orders", (req, res) => {
  db.query("SELECT * FROM orders ORDER BY id DESC", (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(result);
  });
});

app.post("/orders", (req, res) => {
  const { user_id, items, total, payment_status } = req.body;

  db.query(
    `INSERT INTO orders (user_id, items, total, payment_status, created_at)
     VALUES (?, ?, ?, ?, NOW())`,
    [
      user_id,
      JSON.stringify(items || []),
      Number(total || 0),
      (payment_status || "pending").toLowerCase()
    ],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      io.emit("new-order", {
        orderId: result.insertId,
        total: Number(total),
        payment_status: payment_status || "pending"
      });

      res.json({ success: true, orderId: result.insertId });
    }
  );
});

app.put("/orders/:id/status", (req, res) => {
  const { payment_status } = req.body;

  db.query(
    "UPDATE orders SET payment_status=? WHERE id=?",
    [payment_status.toLowerCase(), req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      io.emit("order-updated", {
        id: Number(req.params.id),
        payment_status: payment_status.toLowerCase()
      });

      res.json({ success: true });
    }
  );
});

app.delete("/orders/:id", (req, res) => {
  db.query(
    "DELETE FROM orders WHERE id=?",
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      io.emit("order-deleted", { id: Number(req.params.id) });

      res.json({ success: true });
    }
  );
});

// ================= DASHBOARD =================
app.get("/dashboard-summary", (req, res) => {
  db.query(
    `SELECT
      COUNT(*) as total_orders,
      COALESCE(SUM(CASE WHEN payment_status='paid' THEN total ELSE 0 END), 0) as total_sales
     FROM orders`,
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      res.json(result[0]);
    }
  );
});

// ================= ANALYTICS FIX =================

// TOTAL / WEEK / MONTH SALES
app.get("/sales/summary", (req, res) => {

  const query = `
    SELECT
      COALESCE(SUM(total),0) as total_sales,
      COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN total ELSE 0 END),0) as weekly_sales,
      COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN total ELSE 0 END),0) as monthly_sales,
      COUNT(*) as total_orders
    FROM orders
    WHERE payment_status='paid'
  `;

  db.query(query, (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(result[0]);
  });
});

// DAILY SALES (CHART)
app.get("/sales/daily", (req, res) => {

  const query = `
    SELECT 
      DATE(created_at) as date,
      SUM(total) as total
    FROM orders
    WHERE payment_status='paid'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `;

  db.query(query, (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(result);
  });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("🚀 Server running at http://localhost:" + PORT);
});