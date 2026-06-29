// Normaliza o payload de diferentes serviços de "inbound email" (webhook)
// para um formato único { from, subject, text, html }.
// Suporta: SendGrid Inbound Parse, Mailgun Routes, CloudMailin, Postmark,
// e payloads JSON simples (Make/Zapier/manual).

export function normalizeInbound(body = {}) {
  const b = body || {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (b[k] != null && String(b[k]).length) return String(b[k]);
    }
    return "";
  };

  return {
    from: pick("from", "From", "sender", "envelope_from", "Origem"),
    subject: pick("subject", "Subject", "Assunto"),
    text: pick(
      "text", "plain", "TextBody", "body-plain", "stripped-text", "Texto"
    ),
    html: pick("html", "HtmlBody", "body-html", "Html"),
  };
}

// Algumas integrações entregam o e-mail bruto (MIME) num único campo.
// Extrai subject/from e um corpo aproximado quando só temos isso.
export function looksRawMime(s = "") {
  return /\nContent-Type:/i.test(s) || /^From:.*\nSubject:/im.test(s);
}
