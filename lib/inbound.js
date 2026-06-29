// Normaliza o payload de diferentes serviços de "inbound email" (webhook)
// para um formato único { from, subject, text, html }.
// Suporta: SendGrid Inbound Parse, Mailgun Routes, CloudMailin, Postmark,
// e payloads JSON simples (Make/Zapier/manual).

export function normalizeInbound(body = {}) {
  // Pipedream/Make às vezes embrulham tudo em event/email/payload.
  let b = body || {};
  for (const wrap of ["event", "email", "payload", "data"]) {
    if (b && typeof b[wrap] === "object" && b[wrap]) b = { ...b[wrap], ...b };
  }

  // "from" pode ser string ou objeto ({ text, value:[{address}] })
  const fromStr = (v) => {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (v.text) return String(v.text);
    if (Array.isArray(v.value) && v.value[0]) return String(v.value[0].address || "");
    if (v.address) return String(v.address);
    return "";
  };

  const pick = (...keys) => {
    for (const k of keys) {
      const val = b[k];
      if (val != null && typeof val !== "object" && String(val).length) return String(val);
    }
    return "";
  };

  return {
    from: fromStr(b.from) || pick("From", "sender", "envelope_from", "Origem"),
    subject: pick("subject", "Subject", "Assunto"),
    text: pick(
      "text", "plain", "TextBody", "body-plain", "bodyPlain", "stripped-text", "Texto", "body"
    ),
    html: pick("html", "HtmlBody", "body-html", "bodyHtml", "Html"),
  };
}

// Algumas integrações entregam o e-mail bruto (MIME) num único campo.
// Extrai subject/from e um corpo aproximado quando só temos isso.
export function looksRawMime(s = "") {
  return /\nContent-Type:/i.test(s) || /^From:.*\nSubject:/im.test(s);
}
