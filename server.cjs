// server.cjs

const express = require("express");
const path = require("path");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const multer = require("multer");

const app = express();

// ===== Настройки =====
const PORT = process.env.PORT || 3000;
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "app.sqlite");

// Папка для платежек (рядом с базой, обычно /mnt/data/payments)
const uploadsRoot = path.dirname(dbPath);
const paymentsDir = path.join(uploadsRoot, "payments");
if (!fs.existsSync(paymentsDir)) {
  fs.mkdirSync(paymentsDir, { recursive: true });
}

// Статика для скачивания файлов
app.use("/payments", express.static(paymentsDir));

// ===== База данных =====
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // основная таблица
  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier TEXT,
      organization_type TEXT,
      amount REAL,
      created_at TEXT,
      need_new_request INTEGER DEFAULT 0,
      paid INTEGER DEFAULT 0
    )
  `);

  // добиваем недостающие поля (если таблица уже была)
  db.run(`ALTER TABLE invoices ADD COLUMN payment_file TEXT`, err => {
    if (err && !String(err.message).includes("duplicate column")) {
      console.error("ALTER TABLE payment_file error:", err.message);
    }
  });

  db.run(`ALTER TABLE invoices ADD COLUMN paid_at TEXT`, err => {
    if (err && !String(err.message).includes("duplicate column")) {
      console.error("ALTER TABLE paid_at error:", err.message);
    }
  });
});

// ===== Мидлвары =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== Multer для загрузки PDF =====
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, paymentsDir);
  },
  filename: function (req, file, cb) {
    const id = req.params.id || "inv";
    const ts = Date.now();
    cb(null, `invoice_${id}_${ts}.pdf`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Можно загружать только PDF-файлы"));
    }
  }
});

// ===== Вспомогательное: чистим платежки старше 10 дней =====
function cleanupOldPayments() {
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  db.all(
    `SELECT id, payment_file, paid_at FROM invoices
     WHERE payment_file IS NOT NULL AND paid_at IS NOT NULL`,
    [],
    (err, rows) => {
      if (err) {
        console.error("cleanup select error:", err.message);
        return;
      }

      rows.forEach(row => {
        const paidAtTime = Date.parse(row.paid_at);
        if (!paidAtTime) return;

        if (now - paidAtTime > tenDaysMs) {
          // удаляем файл
          const filePath = path.join(uploadsRoot, row.payment_file.replace(/^\/?payments\//, "payments/"));
          fs.unlink(filePath, unlinkErr => {
            if (unlinkErr && unlinkErr.code !== "ENOENT") {
              console.error("unlink payment error:", unlinkErr.message);
            }
          });

          // чистим ссылку в базе (оплата остаётся)
          db.run(
            `UPDATE invoices SET payment_file = NULL WHERE id = ?`,
            [row.id],
            updateErr => {
              if (updateErr) {
                console.error("cleanup update error:", updateErr.message);
              }
            }
          );
        }
      });
    }
  );
}

// Вызовем при старте
cleanupOldPayments();

// ===== Маршруты API =====

// Создать накладную
app.post("/api/invoice/create", (req, res) => {
  const { supplier, organization_type, amount, need_new_request } = req.body || {};

  if (!supplier || !organization_type || !amount) {
    return res.status(400).json({ error: "Не хватает данных (supplier, organization_type, amount)" });
  }

  const created_at = new Date().toISOString();
  const needFlag = need_new_request ? 1 : 0;

  db.run(
    `
      INSERT INTO invoices (supplier, organization_type, amount, created_at, need_new_request, paid, payment_file, paid_at)
      VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
    `,
    [supplier, organization_type, amount, created_at, needFlag],
    function (err) {
      if (err) {
        console.error("DB insert error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json({ id: this.lastID, message: "Invoice created" });
    }
  );
});

// Список всех НЕОПЛАЧЕННЫХ накладных (для руководителя и менеджера-актив)
app.get("/api/invoice/list", (req, res) => {
  db.all(
    `SELECT * FROM invoices WHERE paid = 0 ORDER BY id DESC`,
    [],
    (err, rows) => {
      if (err) {
        console.error("DB select error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json(rows);
    }
  );
});

// История оплат за 10 дней (для менеджера)
app.get("/api/invoice/history", (req, res) => {
  cleanupOldPayments(); // заодно подчистим

  // оплаченные, у которых есть дата оплаты и она не старше 10 дней
  db.all(
    `
    SELECT * FROM invoices
    WHERE paid = 1
      AND paid_at IS NOT NULL
      AND datetime(paid_at) >= datetime('now', '-10 days')
    ORDER BY datetime(paid_at) DESC
    `,
    [],
    (err, rows) => {
      if (err) {
        console.error("DB history error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json(rows);
    }
  );
});

// Обновить флаг "нужно делать новую заявку"
app.post("/api/invoice/update/:id", (req, res) => {
  const id = req.params.id;
  const { need_new_request } = req.body || {};
  const needFlag = need_new_request ? 1 : 0;

  db.run(
    `UPDATE invoices SET need_new_request = ? WHERE id = ?`,
    [needFlag, id],
    function (err) {
      if (err) {
        console.error("DB update error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Invoice not found" });
      }
      res.json({ message: "Updated" });
    }
  );
});

// Загрузка платёжки + отметка оплаты
app.post("/api/invoice/upload-payment/:id", upload.single("payment"), (req, res) => {
  const id = req.params.id;

  if (!req.file) {
    return res.status(400).json({ error: "Файл не загружен" });
  }

  const paid_at = new Date().toISOString();
  const relativePath = `/payments/${req.file.filename}`;

  db.run(
    `UPDATE invoices
     SET paid = 1,
         paid_at = ?,
         payment_file = ?
     WHERE id = ?`,
    [paid_at, relativePath, id],
    function (err) {
      if (err) {
        console.error("DB upload-payment error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Invoice not found" });
      }
      res.json({ message: "Payment uploaded", paid_at, payment_file: relativePath });
    }
  );
});

// Старый маршрут mark-paid оставим (без файла, если вдруг нужен)
app.post("/api/invoice/mark-paid/:id", (req, res) => {
  const id = req.params.id;
  const paid_at = new Date().toISOString();

  db.run(
    `UPDATE invoices SET paid = 1, paid_at = ? WHERE id = ?`,
    [paid_at, id],
    function (err) {
      if (err) {
        console.error("DB mark-paid error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Invoice not found" });
      }
      res.json({ message: "Invoice marked as paid (без файла)", paid_at });
    }
  );
});

// ===== Маршрут главной страницы =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ===== Старт сервера =====
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
