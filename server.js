import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import xlsx from "xlsx";
import fs from "fs";

import { db } from "./lib/db.js";
import { parseDoctoraliaEmail } from "./lib/parseDoctoralia.js";
import { normalizeInbound } from "./lib/inbound.js";

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
const INBOUND_TOKEN = process.env.INBOUND_TOKEN || "";     // segredo do webhook
const DRY_RUN = process.env.DRY_RUN === "1";               // não envia de verdade (teste)

if (!PHONE_NUMBER_ID || !TOKEN) {
  console.warn("⚠️ Configure PHONE_NUMBER_ID e WHATSAPP_TOKEN antes de iniciar.");
}
if (!INBOUND_TOKEN) {
  console.warn("⚠️ INBOUND_TOKEN não definido — o webhook de e-mail está SEM proteção.");
}

// --- Multer (upload de Excel) ---
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".xlsx" || ext === ".xls") cb(null, true);
    else cb(new Error("Apenas arquivos Excel (.xlsx, .xls) são permitidos"));
  },
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Utils ---
function toE164Brazil(raw, cc = DEFAULT_CC) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  const noLeadingZero = digits.replace(/^0+/, "");
  return `+${cc}${noLeadingZero}`;
}

async function sendWhatsAppTemplate({ to, name }) {
  const destination = to.startsWith("+") ? to : toE164Brazil(to);
  if (DRY_RUN) {
    console.log(`🧪 [DRY_RUN] enviaria template '${TEMPLATE_NAME}' para ${destination} (${name})`);
    return { dry_run: true, to: destination };
  }
  const payload = {
    messaging_product: "whatsapp",
    to: destination,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: "pt_BR" },
      components: [
        { type: "body", parameters: [{ type: "text", text: String(name).trim() }] },
      ],
    },
  };
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || JSON.stringify(data));
  return data;
}

// =====================================================================
//  FILA AUTOMÁTICA (e-mails da Doctoralia)
// =====================================================================

// Parser p/ multipart (SendGrid/Mailgun/CloudMailin entregam form-data)
const inboundForm = multer().none();
function maybeMultipart(req, res, next) {
  if ((req.headers["content-type"] || "").includes("multipart/form-data")) {
    return inboundForm(req, res, next);
  }
  next();
}

function checkInboundAuth(req) {
  if (!INBOUND_TOKEN) return true; // sem token configurado, não bloqueia (mas avisa no boot)
  const provided =
    req.query.token ||
    req.headers["x-inbound-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return provided === INBOUND_TOKEN;
}

// GET só pra conferir no navegador que o endpoint está no ar (o real é POST).
app.get("/api/inbound/email", (_req, res) => {
  res.json({
    ok: true,
    live: true,
    info: "Endpoint ativo. O envio real é via POST (o Pipedream faz isso). Abrir no navegador faz GET, por isso você só vê esta mensagem.",
  });
});

// Webhook: recebe o e-mail encaminhado da Doctoralia e alimenta a fila.
app.post("/api/inbound/email", maybeMultipart, (req, res) => {
  if (!checkInboundAuth(req)) {
    return res.status(401).json({ error: "Token inválido" });
  }
  try {
    const email = normalizeInbound(req.body);
    const parsed = parseDoctoraliaEmail(email);

    // Modo teste: ?debug=1 mostra o que foi entendido, sem gravar na fila.
    if (req.query.debug === "1" || req.body?.debug === true) {
      return res.json({
        ok: true,
        debug: true,
        normalized: { from: email.from, subject: email.subject, has_text: !!email.text, has_html: !!email.html },
        parsed,
      });
    }

    if (!parsed.isDoctoralia) {
      return res.json({ ok: true, ignored: "não é e-mail da Doctoralia" });
    }
    if (!parsed.phone) {
      return res.json({ ok: true, ignored: "sem telefone", type: parsed.type });
    }

    const now = Date.now();

    // Cancelamento: marca o agendamento correspondente como 'cancelled'.
    if (parsed.type === "cancelled") {
      const row = parsed.appointmentMs
        ? db.prepare(
            "SELECT * FROM appointments WHERE phone=? AND appointment_at=? AND status='pending'"
          ).get(parsed.phone, parsed.appointmentMs)
        : db.prepare(
            "SELECT * FROM appointments WHERE phone=? AND status='pending' ORDER BY appointment_at DESC LIMIT 1"
          ).get(parsed.phone);
      if (row) {
        db.prepare(
          "UPDATE appointments SET status='cancelled', updated_at=? WHERE id=?"
        ).run(now, row.id);
        return res.json({ ok: true, action: "cancelled", id: row.id });
      }
      return res.json({ ok: true, action: "cancel_no_match", phone: parsed.phone });
    }

    // Agendada/remarcada: insere ou atualiza (upsert por phone+data).
    const stmt = db.prepare(`
      INSERT INTO appointments
        (phone, name, patient_email, appointment_at, service, professional,
         status, source, raw_subject, created_at, updated_at)
      VALUES (@phone, @name, @patient_email, @appointment_at, @service, @professional,
         'pending', 'doctoralia_email', @raw_subject, @now, @now)
      ON CONFLICT(phone, appointment_at) DO UPDATE SET
        name=excluded.name,
        patient_email=excluded.patient_email,
        service=excluded.service,
        professional=excluded.professional,
        status=CASE WHEN appointments.status='cancelled' THEN 'pending' ELSE appointments.status END,
        updated_at=excluded.updated_at
    `);
    const info = stmt.run({
      phone: parsed.phone,
      name: parsed.name || "Paciente",
      patient_email: parsed.patientEmail || null,
      appointment_at: parsed.appointmentMs || null,
      service: parsed.service,
      professional: parsed.professional,
      raw_subject: email.subject || null,
      now,
    });
    return res.json({ ok: true, action: "queued", type: parsed.type, id: info.lastInsertRowid });
  } catch (err) {
    console.error("inbound erro:", err);
    return res.status(500).json({ error: "Falha ao processar e-mail: " + err.message });
  }
});

// Lista a fila. ?filter=ready|upcoming|history|all
app.get("/api/appointments", (req, res) => {
  const now = Date.now();
  const filter = req.query.filter || "ready";
  let rows;
  if (filter === "ready") {
    rows = db.prepare(
      "SELECT * FROM appointments WHERE status='pending' AND (appointment_at IS NULL OR appointment_at <= ?) ORDER BY appointment_at DESC"
    ).all(now);
  } else if (filter === "upcoming") {
    rows = db.prepare(
      "SELECT * FROM appointments WHERE status='pending' AND appointment_at > ? ORDER BY appointment_at ASC"
    ).all(now);
  } else if (filter === "history") {
    rows = db.prepare(
      "SELECT * FROM appointments WHERE status IN ('sent','skipped','cancelled','error') ORDER BY updated_at DESC LIMIT 100"
    ).all();
  } else {
    rows = db.prepare("SELECT * FROM appointments ORDER BY id DESC LIMIT 200").all();
  }
  res.json({ now, items: rows });
});

// Contadores p/ os badges das abas
app.get("/api/appointments/counts", (req, res) => {
  const now = Date.now();
  const ready = db.prepare(
    "SELECT COUNT(*) c FROM appointments WHERE status='pending' AND (appointment_at IS NULL OR appointment_at <= ?)"
  ).get(now).c;
  const upcoming = db.prepare(
    "SELECT COUNT(*) c FROM appointments WHERE status='pending' AND appointment_at > ?"
  ).get(now).c;
  res.json({ ready, upcoming });
});

// Enviar agora o pedido de avaliação de um item da fila.
app.post("/api/appointments/:id/send", async (req, res) => {
  const row = db.prepare("SELECT * FROM appointments WHERE id=?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Não encontrado" });
  if (row.status === "sent") return res.json({ ok: true, already: true });
  try {
    await sendWhatsAppTemplate({ to: row.phone, name: row.name });
    db.prepare(
      "UPDATE appointments SET status='sent', sent_at=?, last_error=NULL, updated_at=? WHERE id=?"
    ).run(Date.now(), Date.now(), row.id);
    res.json({ ok: true, id: row.id });
  } catch (e) {
    db.prepare(
      "UPDATE appointments SET status='error', last_error=?, updated_at=? WHERE id=?"
    ).run(String(e.message || e), Date.now(), row.id);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Pular (não enviar) um item da fila.
app.post("/api/appointments/:id/skip", (req, res) => {
  const info = db.prepare(
    "UPDATE appointments SET status='skipped', updated_at=? WHERE id=? AND status='pending'"
  ).run(Date.now(), req.params.id);
  res.json({ ok: info.changes > 0 });
});

// =====================================================================
//  ENVIO MANUAL (fallback) — individual + planilha
// =====================================================================

app.post("/api/send-one", async (req, res) => {
  try {
    const { to, name, delayMinutes } = req.body || {};
    if (!to || !name) return res.status(400).json({ error: "Campos obrigatórios: to, name" });
    const delayMs = Math.max(0, Number(delayMinutes ?? 10)) * 60_000;
    const dueAt = Date.now() + delayMs;
    const info = db
      .prepare("INSERT INTO jobs (recipient, name, due_at) VALUES (?, ?, ?)")
      .run(to, name, dueAt);
    return res.json({ ok: true, job_id: info.lastInsertRowid, scheduled_for: new Date(dueAt).toISOString() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao agendar envio." });
  }
});

app.post("/api/upload-excel", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo foi enviado" });
    const delayMinutes = Number(req.body.delayMinutes ?? 10);
    const delayMs = Math.max(0, delayMinutes) * 60_000;
    const workbook = xlsx.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(worksheet);
    if (!data || data.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Planilha vazia ou formato inválido" });
    }
    const batchId = `batch_${Date.now()}`;
    const dueAt = Date.now() + delayMs;
    const inserted = [], errors = [];
    const stmt = db.prepare("INSERT INTO jobs (recipient, name, due_at, batch_id) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const phone = row.telefone || row.to || row.numero || row.phone || row.Telefone || row.TO || row.Numero || row.Phone;
      const name = row.nome || row.name || row.paciente || row.Name || row.Nome || row.Paciente;
      if (!phone || !name) { errors.push({ linha: i + 2, erro: "Telefone ou nome ausente", dados: row }); continue; }
      try {
        const info = stmt.run(phone, String(name).trim(), dueAt, batchId);
        inserted.push({ job_id: info.lastInsertRowid, recipient: phone, name });
      } catch (e) { errors.push({ linha: i + 2, erro: e.message, dados: row }); }
    }
    fs.unlinkSync(req.file.path);
    return res.json({
      ok: true, batch_id: batchId, total_rows: data.length,
      inserted: inserted.length, errors: errors.length,
      scheduled_for: new Date(dueAt).toISOString(),
      details: { inserted_jobs: inserted.slice(0, 10), errors },
    });
  } catch (err) {
    console.error(err);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Erro ao processar planilha: " + err.message });
  }
});

app.get("/api/jobs", (req, res) => {
  const { batch_id } = req.query;
  const rows = batch_id
    ? db.prepare("SELECT * FROM jobs WHERE batch_id = ? ORDER BY id DESC").all(batch_id)
    : db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 50").all();
  res.json(rows);
});

app.get("/api/batch-stats/:batch_id", (req, res) => {
  const stats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors
    FROM jobs WHERE batch_id = ?
  `).get(req.params.batch_id);
  res.json(stats);
});

// Agendador dos envios manuais com delay (a cada 15s)
async function tick() {
  const now = Date.now();
  const due = db
    .prepare("SELECT * FROM jobs WHERE status='pending' AND due_at <= ? ORDER BY id LIMIT 10")
    .all(now);
  for (const job of due) {
    try {
      await sendWhatsAppTemplate({ to: job.recipient, name: job.name });
      db.prepare("UPDATE jobs SET status='sent', sent_at=?, last_error=NULL WHERE id=?").run(Date.now(), job.id);
      console.log(`✅ Enviado job #${job.id} ${job.batch_id ? `(lote: ${job.batch_id})` : ""}`);
    } catch (e) {
      db.prepare("UPDATE jobs SET status='error', last_error=? WHERE id=?").run(String(e.message || e), job.id);
      console.error(`❌ Falha job #${job.id}:`, e.message || e);
    }
  }
}
setInterval(tick, 15_000);
app.get("/tick", async (_req, res) => { await tick(); res.json({ ok: true }); });

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`✅ Servidor em http://localhost:${PORT}`));
