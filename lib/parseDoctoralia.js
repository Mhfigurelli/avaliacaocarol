// Parser dos e-mails da Doctoralia (contato@doctoralia.com.br)
// Lida com 3 situações: consulta agendada, consulta cancelada e (best-effort) remarcada.
// Recebe o e-mail já entregue por um webhook de inbound (subject + html + text)
// e devolve um objeto normalizado pronto pra virar item da fila.

const MONTHS = {
  janeiro: 1, fevereiro: 2, marco: 3, "março": 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&aacute;": "á", "&eacute;": "é", "&iacute;": "í",
  "&oacute;": "ó", "&uacute;": "ú", "&atilde;": "ã", "&otilde;": "õ",
  "&ccedil;": "ç", "&agrave;": "à", "&ecirc;": "ê", "&ocirc;": "ô", "&acirc;": "â",
};

export function htmlToText(html = "") {
  return String(html)
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Remove acento pra casar nomes de mês ("março" -> "marco")
function deburr(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// "1 de julho de 2026 às 16:00" -> { iso, ms } (assume fuso de Brasília -03:00)
function parseDateBR(hay) {
  const m = hay.match(
    /(\d{1,2})\s+de\s+([A-Za-zÀ-ÿ]+)\s+de\s+(\d{4})\s+[àa]s\s+(\d{1,2})[:h](\d{2})/i
  );
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[deburr(m[2].toLowerCase())];
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const min = Number(m[5]);
  if (!month) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:00-03:00`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : { iso, ms };
}

function cleanName(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "")
    .trim();
}

// Telefone do paciente vem como "+5551984238462" (E.164 completo).
function normalizePhone(raw, defaultCC = "55") {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (raw.trim().startsWith("+")) return "+" + d;
  d = d.replace(/^0+/, "");
  if (!d.startsWith(defaultCC)) d = defaultCC + d;
  return "+" + d;
}

/**
 * @param {{subject?:string, html?:string, text?:string, from?:string}} email
 * @returns {{
 *   type: 'scheduled'|'cancelled'|'rescheduled'|'unknown',
 *   isDoctoralia: boolean,
 *   name: string, phone: string, patientEmail: string,
 *   appointmentIso: string|null, appointmentMs: number|null,
 *   service: string|null, professional: string|null
 * }}
 */
export function parseDoctoraliaEmail(email = {}) {
  const subject = email.subject || "";
  const text = (email.text || "").trim();
  const body = text || htmlToText(email.html || "");
  const hay = `${subject}\n${body}`;
  const from = (email.from || "").toLowerCase();

  const isDoctoralia =
    from.includes("doctoralia") || /doctoralia/i.test(hay);

  // --- Tipo de evento ---
  let type = "unknown";
  if (/cancelou a consulta|consulta\s+cancelada/i.test(hay)) type = "cancelled";
  else if (/remarcou|reagendou|consulta\s+remarcada|alterou a consulta/i.test(hay))
    type = "rescheduled";
  else if (
    /agendou a consulta|nova consulta|consulta\s+agendada|novo paciente que agendou|agendou um[a]? (consulta|hor[áa]rio)/i.test(hay)
  )
    type = "scheduled";

  // --- Paciente: "Nome (+55XXXXXXXXXXX email@dominio)" ---
  // e-mail é opcional; telefone é o que importa.
  let name = "", phone = "", patientEmail = "";
  const m = hay.match(
    /([A-Za-zÀ-ÿ'’.\- ]{2,80}?)\s*\(\s*(\+?\d[\d\s().-]{9,16}\d)\s*(?:[ ,;]\s*([^\s)]+@[^\s)]+))?\s*\)/
  );
  if (m) {
    name = cleanName(m[1]);
    phone = normalizePhone(m[2]);
    patientEmail = (m[3] || "").trim();
  }

  // Fallback do nome pelo título de cancelamento: "Flavio Pretto cancelou a consulta"
  if (!name) {
    const t = hay.match(/^\s*(.+?)\s+cancelou a consulta/im);
    if (t) name = cleanName(t[1]);
  }

  const dt = parseDateBR(hay);
  const service = (hay.match(/Consulta[^\n(]*\([^)]*\)/i) || [])[0]?.trim() || null;
  const professional =
    (hay.match(/Carolina[^\n]*Figurelli/i) || [])[0]?.trim() || null;

  return {
    type,
    isDoctoralia,
    name,
    phone,
    patientEmail,
    appointmentIso: dt?.iso ?? null,
    appointmentMs: dt?.ms ?? null,
    service,
    professional,
  };
}
