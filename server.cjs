// server.cjs

const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const initSqlJs = require("sql.js");

const app = express();

const PORT = process.env.PORT || 3000;
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "app.sqlite");

// Папка для платёжек
const rootDir = path.dirname(dbPath);
const paymentsDir = path.join(rootDir, "payments");
if (!fs.existsSync(paymentsDir)) fs.mkdirSync(paymentsDir, { recursive: true });

// Раздача платёжек
app.use("/payments", express.static(paymentsDir));

let db;

// ====== ЗАГРУЗКА WASM SQLite ======
async function initDB() {
    const SQL = await initSqlJs({
        locateFile: file => path.join(__dirname, "node_modules/sql.js/dist/", file),
    });

    let fileBuffer = null;
    if (fs.existsSync(dbPath)) {
        fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // создаём таблицу
    db.run(`
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
    );
    `);

    saveDB();
}

// ====== СОХРАНЕНИЕ БАЗЫ НА ДИСК ======
function saveDB() {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
}

// ====== ОЧИСТКА ПЛАТЁЖЕК > 10 дней ======
function cleanupPayments() {
    const stmt = db.prepare("SELECT id, payment_file, paid_at FROM invoices WHERE payment_file IS NOT NULL");
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());

    const now = Date.now();
    const maxAge = 10 * 24 * 60 * 60 * 1000;

    rows.forEach(row => {
        if (!row.paid_at) return;
        const paidAt = Date.parse(row.paid_at);
        if (now - paidAt > maxAge) {
            const fullPath = path.join(rootDir, row.payment_file);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

            db.run(`UPDATE invoices SET payment_file=NULL WHERE id=${row.id}`);
        }
    });

    saveDB();
}

// ====== Multer (PDF upload) ======
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, paymentsDir),
        filename: (req, file, cb) => {
            cb(null, `invoice_${req.params.id}_${Date.now()}.pdf`);
        }
    }),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === "application/pdf") cb(null, true);
        else cb(new Error("Только PDF разрешён"));
    }
});

// ====== Мидлвары ======
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
//                         API
// ============================================================

// Создание накладной
app.post("/api/invoice/create", (req, res) => {
    const { supplier, organization_type, amount, need_new_request } = req.body;
    const created_at = new Date().toISOString();

    db.run(`
        INSERT INTO invoices (supplier, organization_type, amount, created_at, need_new_request)
        VALUES (?, ?, ?, ?, ?)
    `, [supplier, organization_type, amount, created_at, need_new_request ? 1 : 0]);

    saveDB();
    res.json({ success: true });
});

// Неоплаченные накладные
app.get("/api/invoice/list", (req, res) => {
    const stmt = db.prepare("SELECT * FROM invoices WHERE paid = 0 ORDER BY id DESC");
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    res.json(rows);
});

// История 10 дней
app.get("/api/invoice/history", (req, res) => {
    cleanupPayments();

    const stmt = db.prepare(`
        SELECT * FROM invoices 
        WHERE paid = 1 
        AND paid_at >= datetime('now','-10 days')
        ORDER BY paid_at DESC
    `);

    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    res.json(rows);
});

// Обновить галочку
app.post("/api/invoice/update/:id", (req, res) => {
    db.run(
        `UPDATE invoices SET need_new_request = ? WHERE id = ?`,
        [req.body.need_new_request ? 1 : 0, req.params.id]
    );
    saveDB();
    res.json({ success: true });
});

// Загрузка PDF + оплата
app.post("/api/invoice/upload-payment/:id", upload.single("payment"), (req, res) => {
    const id = req.params.id;
    const paid_at = new Date().toISOString();
    const filePath = "/payments/" + req.file.filename;

    db.run(
        `UPDATE invoices SET paid = 1, paid_at=?, payment_file=? WHERE id=?`,
        [paid_at, filePath, id]
    );

    saveDB();
    res.json({ success: true, paid_at, payment_file: filePath });
});

// Главная
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Старт
initDB().then(() => {
    app.listen(PORT, () => console.log("Server running on port", PORT));
});
