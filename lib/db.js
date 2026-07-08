import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Caminho do banco: usa DB_PATH se definido (ex.: disco persistente), senão local.
const DB_FILE = process.env.DB_PATH || path.join(__dirname, "..", "jobs.db");

export const db = new Database(DB_FILE);
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

  -- Fila vinda dos e-mails da Doctoralia (1 linha por consulta)
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    name TEXT NOT NULL,
    patient_email TEXT,
    appointment_at INTEGER,           -- ms da data/hora da consulta
    service TEXT,
    professional TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|skipped|cancelled|error|archived
    last_error TEXT,
    sent_at INTEGER,
    followup_sent_at INTEGER,          -- quando o lembrete (follow-up) foi enviado
    link_sent_at INTEGER,              -- quando o link (passo 2, texto livre) foi enviado
    source_answer TEXT,                -- resposta do paciente: como conheceu a Dra. (pesquisa)
    source TEXT DEFAULT 'doctoralia_email',
    raw_subject TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_unique ON appointments(phone, appointment_at);
  CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status, appointment_at);
`);

// Migração defensiva: garante as colunas novas mesmo em banco já existente
// (caso um dia haja disco persistente e a tabela seja antiga).
const cols = new Set(db.prepare("PRAGMA table_info(appointments)").all().map((c) => c.name));
for (const [name, def] of [["followup_sent_at", "INTEGER"], ["link_sent_at", "INTEGER"], ["source_answer", "TEXT"]]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE appointments ADD COLUMN ${name} ${def}`);
}

export default db;
