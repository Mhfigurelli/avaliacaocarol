// Teste de integração: webhook -> fila -> enviar/pular/batch + regra "antigo".
// Sobe o servidor real em DRY_RUN e bate nos endpoints. Datas são relativas
// a hoje (a regra de "consulta antiga" depende da data atual).
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
process.env.FOLLOWUP_ENABLED = "1";
process.env.FOLLOWUP_DELAY_HOURS = "0"; // elegível na hora (teste)

await import("../server.js");
await new Promise((r) => setTimeout(r, 400));

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

// datas em português relativas a hoje (fuso Brasília)
const MES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function brDate(offsetDays, hh = 10, mm = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 + offsetDays * 86400000);
  return `${d.getUTCDate()} de ${MES[d.getUTCMonth()]} de ${d.getUTCFullYear()} às ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
const TODAY = brDate(0, 0, 1);   // hoje 00:01 -> pronto pra enviar
const FUTURE = brDate(3, 16, 0); // daqui 3 dias -> aguardando consulta
const YEST = brDate(-1, 14, 0);  // ontem -> antiga (archived)

const SCHED = "Você tem um novo paciente que agendou a consulta pela Doctoralia";
const mk = (subject, name, phone, dataStr) => ({
  from: "Doctoralia <contato@doctoralia.com.br>",
  subject,
  html: `<h1>${subject}</h1><p>Paciente</p><p>${name} (${phone} t@gmail.com)</p>
         <p>Data e hora</p><p>${dataStr}</p><p>Consulta Urologia (15 min)</p><p>Carolina Silva Figurelli</p>`,
});

console.log("# 1. agendada HOJE -> pronto pra enviar");
check("queued", (await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Joao da Silva", "+5551984238462", TODAY))).action, "queued");

console.log("\n# 2. agendada FUTURA -> aguardando");
check("queued", (await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Maria Lima", "+5551991619722", FUTURE))).action, "queued");

console.log("\n# 3. sem token -> 401");
check("status", (await fetch(base + "/api/inbound/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);

console.log("\n# 4. ready = só o João (hoje)");
const ready = await get("/api/appointments?filter=ready");
check("qtd", ready.items.length, 1);
check("nome", ready.items[0]?.name, "Joao da Silva");

console.log("\n# 5. upcoming = só a Maria (futura)");
const up = await get("/api/appointments?filter=upcoming");
check("qtd", up.items.length, 1);
check("nome", up.items[0]?.name, "Maria Lima");

console.log("\n# 6. cancelamento da Maria -> some de upcoming");
check("cancelled", (await post(`/api/inbound/email?token=${TOKEN}`, mk("Maria Lima cancelou a consulta", "Maria Lima", "+5551991619722", FUTURE))).action, "cancelled");
check("upcoming após cancelar", (await get("/api/appointments?filter=upcoming")).items.length, 0);

console.log("\n# 7. enviar o João (DRY_RUN)");
check("send ok", (await post(`/api/appointments/${ready.items[0].id}/send`, {})).ok, true);
check("João no histórico", (await get("/api/appointments?filter=history")).items.find((i) => i.id === ready.items[0].id)?.status, "sent");

console.log("\n# 8. e-mail duplicado não cria linha nova");
await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Joao da Silva", "+5551984238462", TODAY));
check("total = 2", (await get("/api/appointments?filter=all")).items.length, 2);

console.log("\n# 9. envio em massa (send-batch)");
await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Pedro Antunes", "+5551970000001", TODAY));
await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Lucia Mendes", "+5551970000002", TODAY));
const ready2 = await get("/api/appointments?filter=ready");
check("ready = 2", ready2.items.length, 2);
const rb = await post(`/api/appointments/send-batch`, { ids: ready2.items.map((i) => i.id) });
check("send-batch sent=2", rb.sent, 2);
check("ready vazio após batch", (await get("/api/appointments?filter=ready")).items.length, 0);

console.log("\n# 10. outros tipos de e-mail são ignorados");
const before = (await get("/api/appointments?filter=all")).items.length;
check("código verificação ignorado", !!(await post(`/api/inbound/email?token=${TOKEN}`, { from: "Doctoralia <contato@doctoralia.com.br>", subject: "Código de verificação do Docplanner", html: "<p>Seu código é 123456</p>" })).ignored, true);
check("opiniões ignorado", (await post(`/api/inbound/email?token=${TOKEN}`, { from: "Doctoralia <contato@doctoralia.com.br>", subject: "Consulte as novas opiniões", html: "<p>Fulano (+5551999998888 x@y.com)</p>" })).ignored, "tipo não tratado");
check("fila não cresceu", (await get("/api/appointments?filter=all")).items.length, before);

console.log("\n# 11. consulta ANTIGA (ontem) -> archived, não aparece em ready");
check("action archived", (await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Antiga Paciente", "+5551960000009", YEST))).action, "archived");
check("não está em ready", (await get("/api/appointments?filter=ready")).items.find((i) => i.name === "Antiga Paciente"), undefined);
check("está no histórico como archived", (await get("/api/appointments?filter=history")).items.find((i) => i.name === "Antiga Paciente")?.status, "archived");

console.log("\n# 12. follow-up simples (lembrete pra quem foi enviado, 1x só)");
await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Lembrar A", "+5551970001111", TODAY));
await post(`/api/inbound/email?token=${TOKEN}`, mk(SCHED, "Lembrar B", "+5551970002222", TODAY));
const r12 = await get("/api/appointments?filter=ready");
const ids12 = r12.items.map((i) => i.id);
await post(`/api/appointments/send-batch`, { ids: ids12 }); // 1ª msg enviada
await fetch(`${base}/followup-tick`); // roda o lembrete
const h12 = await get("/api/appointments?filter=history");
const a = h12.items.find((i) => i.name === "Lembrar A");
const b = h12.items.find((i) => i.name === "Lembrar B");
check("Lembrar A recebeu follow-up", !!a.followup_sent_at, true);
check("Lembrar B recebeu follow-up", !!b.followup_sent_at, true);
const fuA = a.followup_sent_at;
await fetch(`${base}/followup-tick`); // roda de novo
const a2 = (await get("/api/appointments?filter=history")).items.find((i) => i.name === "Lembrar A");
check("não reenvia follow-up (1x só)", a2.followup_sent_at, fuA);

console.log(`\n${fail === 0 ? "🎉" : "⚠️"} ${pass} passou, ${fail} falhou`);
for (const f of [DBP, DBP + "-wal", DBP + "-shm"]) { try { fs.unlinkSync(f); } catch {} }
process.exit(fail === 0 ? 0 : 1);
