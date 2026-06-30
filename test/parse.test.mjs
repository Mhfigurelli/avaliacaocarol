import { parseDoctoraliaEmail } from "../lib/parseDoctoralia.js";
import { normalizeInbound } from "../lib/inbound.js";
import { firstName } from "../lib/util.js";

// Reproduz o conteúdo dos e-mails reais (prints) como chegaria no corpo.
const agendada = {
  from: "Doctoralia <contato@doctoralia.com.br>",
  subject: "Você tem um novo paciente que agendou a consulta pela Doctoralia",
  html: `<h1>Você tem um novo paciente que agendou a consulta pela Doctoralia</h1>
    <p>Paciente</p>
    <p>Arthur Ferro Wenzel (+5551984238462 camilaferro07@gmail.com)</p>
    <p>Primeira consulta deste paciente</p>
    <p>Data e hora</p><p>Quarta-feira, 1 de julho de 2026 às 16:00</p>
    <p>Serviço</p><p>Consulta Urologia (15 min)</p>
    <p>Profissional</p><p>Carolina Silva Figurelli</p>
    <p>Endereço</p><p>CONSULTÓRIO MEDPLEX</p>`,
};

const cancelada = {
  from: "Doctoralia <contato@doctoralia.com.br>",
  subject: "Flavio Pretto cancelou a consulta",
  html: `<h1>Flavio Pretto cancelou a consulta</h1>
    <p>Paciente</p>
    <p>Flavio Pretto (+5551991619722 Apretto@gmail.com)</p>
    <p>Sexta-feira, 26 de junho de 2026 às 16:15</p>
    <p>Consulta Urologia (15 min)</p>
    <p>Carolina Silva Figurelli</p>
    <p>Rua Gomes Jardim, 201 - Sala 1602, Porto Alegre</p>`,
};

// Variante encaminhada (Hotmail adiciona "Enc:" e indentação)
const agendadaEncaminhada = {
  from: "Marcelo <marcelo@hotmail.com>",
  subject: "Enc: Você tem um novo paciente que agendou a consulta pela Doctoralia",
  text: `> De: Doctoralia <contato@doctoralia.com.br>
> Você tem um novo paciente que agendou a consulta pela Doctoralia
> Paciente
> Maria de Souza Lima (+5551988887777 maria.souza@gmail.com)
> Data e hora
> Segunda-feira, 13 de julho de 2026 às 09:30
> Serviço
> Consulta Urologia (15 min)
> Profissional
> Carolina Silva Figurelli`,
};

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "✅" : "❌"} ${label}: ${JSON.stringify(actual)}${ok ? "" : `  (esperado ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}

console.log("=== E-mail: AGENDADA ===");
const a = parseDoctoraliaEmail(agendada);
console.log(a);
check("type", a.type, "scheduled");
check("name", a.name, "Arthur Ferro Wenzel");
check("phone", a.phone, "+5551984238462");
check("patientEmail", a.patientEmail, "camilaferro07@gmail.com");
check("appointmentIso", a.appointmentIso, "2026-07-01T16:00:00-03:00");
check("isDoctoralia", a.isDoctoralia, true);

console.log("\n=== E-mail: CANCELADA ===");
const c = parseDoctoraliaEmail(cancelada);
console.log(c);
check("type", c.type, "cancelled");
check("name", c.name, "Flavio Pretto");
check("phone", c.phone, "+5551991619722");
check("appointmentIso", c.appointmentIso, "2026-06-26T16:15:00-03:00");

console.log("\n=== E-mail: AGENDADA (encaminhada/forward) ===");
const f = parseDoctoraliaEmail(agendadaEncaminhada);
console.log(f);
check("type", f.type, "scheduled");
check("name", f.name, "Maria de Souza Lima");
check("phone", f.phone, "+5551988887777");
check("appointmentIso", f.appointmentIso, "2026-07-13T09:30:00-03:00");

console.log("\n=== Payload estilo Pipedream (from objeto, dentro de event) ===");
const pd = normalizeInbound({
  event: {
    from: { text: "Doctoralia <contato@doctoralia.com.br>", value: [{ address: "contato@doctoralia.com.br" }] },
    subject: "Você tem um novo paciente que agendou a consulta pela Doctoralia",
    text: "Paciente\nAna Paula Reis (+5551984238462 ana@gmail.com)\nData e hora\nQuarta-feira, 1 de julho de 2026 às 16:00",
  },
});
const p = parseDoctoraliaEmail(pd);
console.log(p);
check("from normalizado", pd.from.includes("doctoralia"), true);
check("type", p.type, "scheduled");
check("name", p.name, "Ana Paula Reis");
check("phone", p.phone, "+5551984238462");

console.log("\n=== Payload REAL do Pipedream (encaminhado do Hotmail) ===");
// Estrutura exata capturada: event = { body:{text,html}, headers:{subject,from} }
const real = normalizeInbound({
  headers: {
    subject: "ENC: Nova consulta: Arthur Ferro Wenzel agendou pela Doctoralia",
    from: { text: "Carolina Silva <carolinasilva.cs@hotmail.com>", value: [{ address: "carolinasilva.cs@hotmail.com" }] },
  },
  body: {
    html: "<html><body>irrelevante</body></html>",
    text: `Dra. Carolina Silva Figurelli
Médica Urologista
CREMERS 34531
Tel: (51) 99880-0358
________________________________
De: Doctoralia <contato@doctoralia.com.br>
Enviado: domingo, 28 de junho de 2026 16:41
Para: carolinasilva.cs@hotmail.com
Assunto: Nova consulta: Arthur Ferro Wenzel agendou pela Doctoralia

Você tem um novo paciente que agendou a consulta pela Doctoralia
Paciente
Arthur Ferro Wenzel (+5551984238462 camilaferro07@gmail.com)
Data e hora
Quarta-feira, 1 de julho de 2026 às 16:00
Serviço
Consulta Urologia (15 min)
Profissional
Carolina Silva Figurelli`,
  },
  rawUrl: "https://pipedream-emails.s3.amazonaws.com/abc",
});
const rp = parseDoctoraliaEmail(real);
console.log(rp);
check("subject normalizado", real.subject.includes("Nova consulta"), true);
check("text normalizado", real.text.includes("+5551984238462"), true);
check("isDoctoralia", rp.isDoctoralia, true);
check("type", rp.type, "scheduled");
check("name", rp.name, "Arthur Ferro Wenzel");
check("phone (do paciente, não da assinatura)", rp.phone, "+5551984238462");
check("appointmentIso (consulta, não 'Enviado')", rp.appointmentIso, "2026-07-01T16:00:00-03:00");

console.log("\n=== firstName (cumprimento só com primeiro nome) ===");
check("nome completo", firstName("Eleci Amoedo Gonçalves"), "Eleci");
check("com tag de convênio", firstName("Sergio Luis Alves Campos- Ipê"), "Sergio");
check("nome simples", firstName("Marcelo"), "Marcelo");
check("espaços extras", firstName("  Ana  Paula "), "Ana");

console.log(`\n${fail === 0 ? "🎉" : "⚠️"} ${pass} passou, ${fail} falhou`);
process.exit(fail === 0 ? 0 : 1);
