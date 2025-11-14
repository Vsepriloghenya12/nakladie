// server.cjs

const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const multer = require("multer");
const Database = require("better-sqlite3");

const app = express();

// ===== Настройки =====
const PORT = process.env.PORT || 3000;
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "app.sqlite");

// Папка для платежек
const uploadsRoot = path.dirname(dbPath);
const paymentsDir = path.join(uploadsRoot, "payments");
if (!fs.existsSync(paymentsDir)) {
    fs.mkdirSync(paymentsDir, { recursive: true });
}

// Раздаём файлы платежек
app.use("/payments", express.static(paymentsDir));

// ===== База данных =====
const db = new Database(dbPath);

// Создание таблицы, если нет
db.prepare(`
CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier TEXT,
    organization_type TEXT,
    amount REAL,
    created_at TEXT,
    need_new_request INTEGER DEFAULT 0,
    paid INTEGER DEFAULT 0,
    payment_file TEXT,
    paid_at TEXT
)
`).run();

// ===== Миддлвары =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== Multer для загрузки PDF =====
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, paymentsDir);
    },
    filename: function (req, file, cb) {
        const id = req.params.id;
        const name = `invoice_${id}_${Date.now()}.pdf`;
        cb(null, name);
    }
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === "application/pdf") cb(null, true);
        else cb(new Error("Разрешены только PDF-файлы"));
    }
});

// ============================================================
//                    ОЧИСТКА ПЛАТЁЖЕК > 10 дней
// ============================================================
function cleanupPayments() {
    const rows = db.prepare(`
        SELECT id, payment_file, paid_at FROM invoices 
        WHERE payment_file IS NOT NULL AND paid_at IS NOT NULL
    `).all();

    const now = Date.now();
    const maxAge = 10 * 24 * 60 * 60 * 1000;

    rows.forEach(row => {
        const paidTime = Date.parse(row.paid_at);
        if (!paidTime) return;

        if (now - paidTime > maxAge) {
            // удалить файл
            const full = path.join(uploadsRoot, row.payment_file);
            if (fs.existsSync(full)) fs.unlinkSync(full);

            // удалить ссылку в базе (оплата остаётся)
            db.prepare(`
                UPDATE invoices SET payment_file=NULL WHERE id=?
            `).run(row.id);
        }
    });
}

cleanupPayments();

// ============================================================
//                      API МАРШРУТЫ
// ============================================================

// Создать накладную
app.post("/api/invoice/create", (req, res) => {
    const { supplier, organization_type, amount, need_new_request } = req.body;

    if (!supplier || !organization_type || !amount) {
        return res.status(400).json({ error: "Не хватает данных" });
    }

    const created_at = new Date().toISOString();
    const stmt = db.prepare(`
        INSERT INTO invoices (supplier, organization_type, amount, created_at, need_new_request)
        VALUES (?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
        supplier,
        organization_type,
        amount,
        created_at,
        need_new_request ? 1 : 0
    );

    res.json({ id: info.lastInsertRowid });
});

// Получить НЕОПЛАЧЕННЫЕ накладные
app.get("/api/invoice/list", (req, res) => {
    const rows = db.prepare(`
        SELECT * FROM invoices WHERE paid=0 ORDER BY id DESC
    `).all();

    res.json(rows);
});

// Обновить галочку
app.post("/api/invoice/update/:id", (req, res) => {
    db.prepare(`
        UPDATE invoices SET need_new_request=? WHERE id=?
    `).run(req.body.need_new_request ? 1 : 0, req.params.id);

    res.json({ message: "updated" });
});

// История оплат (10 дней)
app.get("/api/invoice/history", (req, res) => {
    cleanupPayments();

    const rows = db.prepare(`
        SELECT * FROM invoices
        WHERE paid=1 
        AND paid_at IS NOT NULL
        AND datetime(paid_at) >= datetime('now', '-10 days')
        ORDER BY datetime(paid_at) DESC
    `).all();

    res.json(rows);
});

// Загрузка PDF + пометка оплачено
app.post("/api/invoice/upload-payment/:id", upload.single("payment"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Файл не загружен" });

    const id = req.params.id;
    const paid_at = new Date().toISOString();
    const filePath = `/payments/${req.file.filename}`;

    db.prepare(`
        UPDATE invoices 
        SET paid=1, paid_at=?, payment_file=?
        WHERE id=?
    `).run(paid_at, filePath, id);

    res.json({
        message: "uploaded",
        payment_file: filePath,
        paid_at
    });
});

// Ручная пометка оплачено (без файла) — оставил на всякий случай
app.post("/api/invoice/mark-paid/:id", (req, res) => {
    const paid_at = new Date().toISOString();

    db.prepare(`
        UPDATE invoices SET paid=1, paid_at=? WHERE id=?
    `).run(paid_at, req.params.id);

    res.json({ message: "paid", paid_at });
});

// Главная → login.html
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ============================================================
//                         СТАРТ СЕРВЕРА
// ============================================================
app.listen(PORT, () => {
    console.log("Server started on port", PORT);
});
