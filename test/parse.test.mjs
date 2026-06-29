import { parseDoctoraliaEmail } from "../lib/parseDoctoralia.js";

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

console.log(`\n${fail === 0 ? "🎉" : "⚠️"} ${pass} passou, ${fail} falhou`);
process.exit(fail === 0 ? 0 : 1);
