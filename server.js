import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import multer from "multer";
import xlsx from "xlsx";
import fs from "fs";

dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- ENV ---
const PORT = process.env.PORT || 3000;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || "avaliacao_pos_consulta_v1";
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || "55";

if (!PHONE_NUMBER_ID || !TOKEN) {
  console.warn("⚠️ Configure PHONE_NUMBER_ID e WHATSAPP_TOKEN nas variáveis de ambiente antes de iniciar.");
}

// --- Multer config para upload ---
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".xlsx" || ext === ".xls") {
      cb(null, true);
    } else {
      cb(new Error("Apenas arquivos Excel (.xlsx, .xls) são permitidos"));
    }
  }
});

// --- DB (SQLite) ---
const db = new Database(path.join(__dirname, "jobs.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    name TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    sent_at INTEGER,
    batch_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Utils
function toE164Brazil(raw, cc = DEFAULT_CC) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  const noLeadingZero = digits.replace(/^0+/, "");
  return `+${cc}${noLeadingZero}`;
}

async function sendWhatsAppTemplate({ to, name }) {
  const destination = to.startsWith("+") ? to : toE164Brazil(to);
  const payload = {
    messaging_product: "whatsapp",
    to: destination,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: "pt_BR" },
      components: [
        { type: "body", parameters: [{ type: "text", text: String(name).trim() }] }
      ]
    }
  };
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || JSON.stringify(data));
  return data;
}

// Endpoint: agenda envio individual
app.post("/api/send-one", async (req, res) => {
  try {
    const { to, name, delayMinutes } = req.body || {};
    if (!to || !name) return res.status(400).json({ error: "Campos obrigatórios: to, name" });

    const delayMs = Math.max(0, Number(delayMinutes ?? 10)) * 60_000;
    const dueAt = Date.now() + delayMs;

    const stmt = db.prepare("INSERT INTO jobs (recipient, name, due_at) VALUES (?, ?, ?)");
    const info = stmt.run(to, name, dueAt);

    return res.json({
      ok: true,
      job_id: info.lastInsertRowid,
      scheduled_for: new Date(dueAt).toISOString()
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao agendar envio." });
  }
});

// 🆕 Endpoint: upload e processamento em lote de Excel
app.post("/api/upload-excel", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo foi enviado" });
    }

    const delayMinutes = Number(req.body.delayMinutes ?? 10);
    const delayMs = Math.max(0, delayMinutes) * 60_000;
    
    // Ler o arquivo Excel
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);

    // Validar dados
    if (!data || data.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Planilha vazia ou formato inválido" });
    }

    // Gerar ID único para este lote
    const batchId = `batch_${Date.now()}`;
    const dueAt = Date.now() + delayMs;
    
    const inserted = [];
    const errors = [];
    
    const stmt = db.prepare(
      "INSERT INTO jobs (recipient, name, due_at, batch_id) VALUES (?, ?, ?, ?)"
    );

    // Processar cada linha
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      
      // Aceitar diferentes formatos de coluna
      const phone = row.telefone || row.to || row.numero || row.phone || 
                    row.Telefone || row.TO || row.Numero || row.Phone;
      const name = row.nome || row.name || row.paciente || 
                   row.Name || row.Nome || row.Paciente;
      
      if (!phone || !name) {
        errors.push({
          linha: i + 2,
          erro: "Telefone ou nome ausente",
          dados: row
        });
        continue;
      }

      try {
        const info = stmt.run(phone, String(name).trim(), dueAt, batchId);
        inserted.push({
          job_id: info.lastInsertRowid,
          recipient: phone,
          name: name
        });
      } catch (e) {
        errors.push({
          linha: i + 2,
          erro: e.message,
          dados: row
        });
      }
    }

    // Limpar arquivo temporário
    fs.unlinkSync(req.file.path);

    return res.json({
      ok: true,
      batch_id: batchId,
      total_rows: data.length,
      inserted: inserted.length,
      errors: errors.length,
      scheduled_for: new Date(dueAt).toISOString(),
      details: {
        inserted_jobs: inserted.slice(0, 10), // Limitar a 10 primeiros para não sobrecarregar a resposta
        errors: errors
      }
    });

  } catch (err) {
    console.error(err);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ error: "Erro ao processar planilha: " + err.message });
  }
});

// Listar jobs (com filtro opcional por batch)
app.get("/api/jobs", (req, res) => {
  const { batch_id } = req.query;
  let rows;
  
  if (batch_id) {
    rows = db.prepare("SELECT * FROM jobs WHERE batch_id = ? ORDER BY id DESC").all(batch_id);
  } else {
    rows = db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 50").all();
  }
  
  res.json(rows);
});

// 🆕 Estatísticas de um lote
app.get("/api/batch-stats/:batch_id", (req, res) => {
  const { batch_id } = req.params;
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
    FROM jobs 
    WHERE batch_id = ?
  `).get(batch_id);
  
  res.json(stats);
});

// Agendador: roda a cada 15s
async function tick() {
  const now = Date.now();
  const due = db
    .prepare("SELECT * FROM jobs WHERE status='pending' AND due_at <= ? ORDER BY id LIMIT 10")
    .all(now);

  for (const job of due) {
    try {
      await sendWhatsAppTemplate({ to: job.recipient, name: job.name });
      db.prepare("UPDATE jobs SET status='sent', sent_at=?, last_error=NULL WHERE id=?")
        .run(Date.now(), job.id);
      console.log(`✅ Enviado job #${job.id} ${job.batch_id ? `(lote: ${job.batch_id})` : ''}`);
    } catch (e) {
      db.prepare("UPDATE jobs SET status='error', last_error=? WHERE id=?")
        .run(String(e.message || e), job.id);
      console.error(`❌ Falha job #${job.id}:`, e.message || e);
    }
  }
}
setInterval(tick, 15_000);

app.get("/tick", async (_req, res) => { await tick(); res.json({ ok: true }); });

app.listen(PORT, () => {
  console.log(`✅ Servidor em http://localhost:${PORT}`);
});
