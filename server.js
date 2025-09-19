import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";

dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configurações de ambiente ---
const PORT = process.env.PORT || 3000;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || "avaliacao_pos_consulta_v1";
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || "55"; // Brasil

if (!PHONE_NUMBER_ID || !TOKEN) {
  console.warn("⚠️ Configure PHONE_NUMBER_ID e WHATSAPP_TOKEN no .env antes de iniciar o servidor.");
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Função utilitária para formatar telefone em E.164
function toE164Brazil(raw, cc = DEFAULT_CC) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  const noLeadingZero = digits.replace(/^0+/, "");
  return `+${cc}${noLeadingZero}`;
}

// Endpoint: envia UM pedido de avaliação
app.post("/api/send-one", async (req, res) => {
  try {
    const { to, name } = req.body || {};
    if (!to || !name) {
      return res.status(400).json({ error: "Campos obrigatórios: to, name" });
    }

    const destination = to.startsWith("+") ? to : toE164Brazil(to);

    const payload = {
      messaging_product: "whatsapp",
      to: destination,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: String(name).trim() }]
          }
        ]
      }
    };

    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("❌ Erro WhatsApp API:", data);
      return res.status(r.status).json(data);
    }

    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro interno ao enviar mensagem." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});