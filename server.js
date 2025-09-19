import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import Database from "better-sqlite3";

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
  console.warn("⚠️ Configure PHONE_NUMBER_ID e WHATSAPP_TOKEN no .env/Render antes de iniciar.");
}

// --- DB (SQLite) ---
const db = new Database(path.join(__dirname, "jobs.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to TEXT NOT NULL,
    name TEXT NOT NULL,
    due_at INTEGER NOT NULL,   -- epoch ms
    status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|error
    last_error TEXT,
    sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, due_at);
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

// Endpoint: agenda envio (delay padrão 10 min)
app.post("/api/send-one", async (req, res) => {
  try {
    const { to, name, delayMinutes } = req.body || {};
    if (!to || !name) return res.status(400).json({ error: "Campos obrigatórios: to, name" });
    const delayMs = Math.max(0, Number(delayMinutes ?? 10)) * 60_000; // default 10 min
    const dueAt = Date.now() + delayMs;

    const stmt = db.prepare("INSERT INTO jobs (to, name, due_at) VALUES (?, ?, ?)");
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

// (Opcional) Listar últimos jobs p/ auditoria
app.get("/api/jobs", (req, res) => {
  const rows = db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 50").all();
  res.json(rows);
});

// Agendador: roda a cada 15s, envia vencidos
async function tick() {
  const now = Date.now();
  const due = db.prepare("SELECT * FROM jobs WHERE status='pending' AND due_at <= ? ORDER BY id LIMIT 10").all(now);
  for (const job of due) {
    try {
      const resp = await sendWhatsAppTemplate({ to: job.to, name: job.name });
      db.prepare("UPDATE jobs SET status='sent', sent_at=?, last_error=NULL WHERE id=?")
        .run(Date.now(), job.id);
      console.log(`✅ Enviado job #${job.id}`, resp?.messages?.[0]?.id || "");
    } catch (e) {
      db.prepare("UPDATE jobs SET status='error', last_error=? WHERE id=?")
        .run(String(e.message || e), job.id);
      console.error(`❌ Falha job #${job.id}:`, e.message || e);
    }
  }
}
setInterval(tick, 15_000);

// Endpoint manual para forçar verificação (útil no Render ao “acordar”)
app.get("/tick", async (_req, res) => { await tick(); res.json({ ok: true }); });

app.listen(PORT, () => {
  console.log(`✅ Servidor em http://localhost:${PORT}`);
});
