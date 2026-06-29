// Teste de integração: webhook de e-mail -> fila -> enviar/pular.
// Sobe o servidor real em DRY_RUN (não envia WhatsApp) e bate nos endpoints.
import fs from "fs";
import path from "path";

const PORT = 3999;
const TOKEN = "segredo-teste";
const DBP = path.join(process.cwd(), "test", "_int.db");
for (const f of [DBP, DBP + "-wal", DBP + "-shm"]) { try { fs.unlinkSync(f); } catch {} }

process.env.PORT = String(PORT);
process.env.INBOUND_TOKEN = TOKEN;
process.env.DRY_RUN = "1";
process.env.DB_PATH = DBP;
process.env.PHONE_NUMBER_ID = "x";
process.env.WHATSAPP_TOKEN = "x";

await import("../server.js");
await new Promise((r) => setTimeout(r, 400)); // espera o listen

const base = `http://localhost:${PORT}`;
const post = (p, body) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(base + p).then((r) => r.json());

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✅" : "❌"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (esperado ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
};

const mk = (subject, name, phone, dataStr) => ({
  from: "Doctoralia <contato@doctoralia.com.br>",
  subject,
  html: `<h1>${subject}</h1><p>Paciente</p><p>${name} (${phone} teste@gmail.com)</p>
         <p>Data e hora</p><p>${dataStr}</p><p>Consulta Urologia (15 min)</p><p>Carolina Silva Figurelli</p>`,
});

// 1) Consulta JÁ ocorrida (passado) -> deve ficar "ready"
console.log("\n# 1. e-mail agendada (data passada)");
const r1 = await post(`/api/inbound/email?token=${TOKEN}`,
  mk("Você tem um novo paciente que agendou a consulta pela Doctoralia", "Joao da Silva", "+5551984238462", "Sábado, 20 de junho de 2026 às 10:00"));
check("queued", r1.action, "queued");

// 2) Consulta futura -> deve ficar "upcoming"
console.log("\n# 2. e-mail agendada (data futura)");
const r2 = await post(`/api/inbound/email?token=${TOKEN}`,
  mk("Você tem um novo paciente que agendou a consulta pela Doctoralia", "Maria Lima", "+5551991619722", "Quarta-feira, 1 de julho de 2026 às 16:00"));
check("queued", r2.action, "queued");

// 3) Sem token -> 401
console.log("\n# 3. webhook sem token");
const r3 = await fetch(base + "/api/inbound/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
check("status", r3.status, 401);

console.log("\n# 4. fila 'ready' deve ter só o João (consulta passada)");
const ready = await get("/api/appointments?filter=ready");
check("qtd ready", ready.items.length, 1);
check("nome ready", ready.items[0]?.name, "Joao da Silva");

console.log("\n# 5. fila 'upcoming' deve ter só a Maria (consulta futura)");
const up = await get("/api/appointments?filter=upcoming");
check("qtd upcoming", up.items.length, 1);
check("nome upcoming", up.items[0]?.name, "Maria Lima");

// 6) Cancelamento da Maria -> some do 'upcoming'
console.log("\n# 6. e-mail de cancelamento da Maria");
const r6 = await post(`/api/inbound/email?token=${TOKEN}`,
  mk("Maria Lima cancelou a consulta", "Maria Lima", "+5551991619722", "Quarta-feira, 1 de julho de 2026 às 16:00"));
check("cancelled", r6.action, "cancelled");
const up2 = await get("/api/appointments?filter=upcoming");
check("upcoming após cancelar", up2.items.length, 0);

// 7) Enviar o João -> status sent
console.log("\n# 7. enviar avaliação do João (DRY_RUN)");
const joaoId = ready.items[0].id;
const r7 = await post(`/api/appointments/${joaoId}/send`, {});
check("send ok", r7.ok, true);
const hist = await get("/api/appointments?filter=history");
check("João no histórico como sent", hist.items.find((i) => i.id === joaoId)?.status, "sent");

// 8) Idempotência do upsert: reenviar o mesmo agendado não duplica
console.log("\n# 8. e-mail duplicado não cria linha nova");
await post(`/api/inbound/email?token=${TOKEN}`,
  mk("Você tem um novo paciente que agendou a consulta pela Doctoralia", "Joao da Silva", "+5551984238462", "Sábado, 20 de junho de 2026 às 10:00"));
const all = await get("/api/appointments?filter=all");
check("total de linhas = 2", all.items.length, 2);

// 9) Envio em massa: 2 consultas passadas (ready) -> send-batch
console.log("\n# 9. envio em massa (send-batch)");
await post(`/api/inbound/email?token=${TOKEN}`,
  mk("Você tem um novo paciente que agendou a consulta pela Doctoralia", "Pedro Antunes", "+5551970000001", "Sábado, 21 de junho de 2026 às 11:00"));
await post(`/api/inbound/email?token=${TOKEN}`,
  mk("Você tem um novo paciente que agendou a consulta pela Doctoralia", "Lucia Mendes", "+5551970000002", "Domingo, 22 de junho de 2026 às 15:00"));
const ready2 = await get("/api/appointments?filter=ready");
const batchIds = ready2.items.map(i => i.id);
check("ready tem 2 p/ enviar", batchIds.length, 2);
const rb = await post(`/api/appointments/send-batch`, { ids: batchIds });
check("send-batch sent=2", rb.sent, 2);
const ready3 = await get("/api/appointments?filter=ready");
check("ready vazio após batch", ready3.items.length, 0);

console.log(`\n${fail === 0 ? "🎉" : "⚠️"} ${pass} passou, ${fail} falhou`);
for (const f of [DBP, DBP + "-wal", DBP + "-shm"]) { try { fs.unlinkSync(f); } catch {} }
process.exit(fail === 0 ? 0 : 1);
