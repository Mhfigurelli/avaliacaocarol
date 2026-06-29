// Normaliza o payload de diferentes serviços de "inbound email" (webhook)
// para um formato único { from, subject, text, html }.
// Suporta: SendGrid Inbound Parse, Mailgun Routes, CloudMailin, Postmark,
// e payloads JSON simples (Make/Zapier/manual).

export function normalizeInbound(body = {}) {
  // Pipedream/Make às vezes embrulham tudo em event/email/payload.
  let b = body || {};
  for (const wrap of ["event", "email", "payload", "data", "message"]) {
    if (b && typeof b[wrap] === "object" && b[wrap]) b = { ...b[wrap], ...b };
  }

  // Pipedream (Email trigger) aninha: { body: {text, html}, headers: {subject, from, ...} }
  const H = b.headers && typeof b.headers === "object" ? b.headers : {};
  const BODY = b.body && typeof b.body === "object" ? b.body : {};

  // "from" pode ser string ou objeto ({ text, value:[{address}] })
  const fromStr = (v) => {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (v.text) return String(v.text);
    if (Array.isArray(v.value) && v.value[0]) return String(v.value[0].address || "");
    if (v.address) return String(v.address);
    return "";
  };

  // primeiro valor de string não-vazio entre vários candidatos
  const first = (...vals) => {
    for (const v of vals) {
      if (v != null && typeof v !== "object" && String(v).length) return String(v);
    }
    return "";
  };

  return {
    from:
      fromStr(b.from) || fromStr(H.from) ||
      first(b.From, b.sender, b.envelope_from, b.Origem),
    subject: first(b.subject, H.subject, b.Subject, b.Assunto),
    text: first(
      b.text, BODY.text, b.plain, b.TextBody, b["body-plain"],
      b.bodyPlain, b["stripped-text"], b.Texto
    ),
    html: first(b.html, BODY.html, b.HtmlBody, b["body-html"], b.bodyHtml, b.Html),
  };
}

// Algumas integrações entregam o e-mail bruto (MIME) num único campo.
// Extrai subject/from e um corpo aproximado quando só temos isso.
export function looksRawMime(s = "") {
  return /\nContent-Type:/i.test(s) || /^From:.*\nSubject:/im.test(s);
}
