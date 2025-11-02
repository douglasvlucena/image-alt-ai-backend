import express from "express";
import axios from "axios";
import sharp from "sharp";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;

const app = express();

// aceitar JSON grande (imagem em base64)
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin-default";

// conexão com Postgres (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// cria tabela se não existir
async function ensureTable() {
  const sql = `
    CREATE TABLE IF NOT EXISTS licenses (
      license_key TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'starter',
      monthly_quota INTEGER NOT NULL DEFAULT 100,
      used_this_month INTEGER NOT NULL DEFAULT 0,
      site_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await pool.query(sql);
}

ensureTable()
  .then(() => console.log("✅ Conectado ao Postgres!"))
  .catch((err) => console.error("❌ Erro ao conectar no Postgres:", err));

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// baixa e redimensiona quando vier por URL
async function downloadAndResize(imageUrl) {
  const resp = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const buffer = Buffer.from(resp.data);
  const resized = await sharp(buffer).resize(1024).toBuffer();
  return resized;
}

// quando vier base64, também redimensiona pra não estourar
async function resizeFromBuffer(buffer) {
  const resized = await sharp(buffer).resize(1024).toBuffer();
  return resized;
}

async function generateAltFromImage(imageBuffer, template = "Descrição: {description}") {
  const base64Image = imageBuffer.toString("base64");

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "Você gera descrições curtas de imagem para atributo alt, em português, focadas em SEO.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Descreva a imagem em até 120 caracteres, dizendo o que aparece." },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    max_tokens: 80,
  });

  const desc = completion.choices[0].message.content.trim();
  const alt = template.replace("{description}", desc);
  return { alt };
}

// util: pega licença no banco
async function getLicenseFromDB(license_key) {
  const { rows } = await pool.query(
    "SELECT license_key, plan, monthly_quota, used_this_month, site_url FROM licenses WHERE license_key = $1",
    [license_key]
  );
  return rows[0] || null;
}

// util: atualiza uso
async function incrementUsage(license_key) {
  await pool.query(
    "UPDATE licenses SET used_this_month = used_this_month + 1 WHERE license_key = $1",
    [license_key]
  );
}

// ------------------ ROTAS ------------------ //

// WP checa licença / uso
app.post("/usage", async (req, res) => {
  const { license_key } = req.body || {};

  if (!license_key) {
    return res.json({ success: false, message: "license_key obrigatória" });
  }

  try {
    const lic = await getLicenseFromDB(license_key);
    if (!lic) {
      return res.json({ success: false, message: "Licença não encontrada." });
    }

    return res.json({
      success: true,
      plan: lic.plan,
      monthly_quota: lic.monthly_quota,
      used_this_month: lic.used_this_month,
    });
  } catch (err) {
    console.error("Erro /usage:", err);
    return res.status(500).json({ success: false, message: "Erro no servidor." });
  }
});

// rota que o plugin vai chamar pra otimizar
app.post("/optimize/image", async (req, res) => {
  const { license_key, image_url, image_base64, template } = req.body || {};

  if (!license_key) {
    return res.status(400).json({ success: false, message: "license_key obrigatória" });
  }

  try {
    const lic = await getLicenseFromDB(license_key);
    if (!lic) {
      return res.json({ success: false, message: "Licença inválida" });
    }

    if (lic.used_this_month >= lic.monthly_quota) {
      return res.json({ success: false, message: "Limite do plano atingido" });
    }

    let imgBuffer;

    if (image_base64) {
      // veio direto do WP
      const rawBuffer = Buffer.from(image_base64, "base64");
      imgBuffer = await resizeFromBuffer(rawBuffer);
    } else if (image_url) {
      // fallback: do jeito antigo
      imgBuffer = await downloadAndResize(image_url);
    } else {
      return res.status(400).json({ success: false, message: "Nenhuma imagem recebida." });
    }

    const { alt } = await generateAltFromImage(imgBuffer, template || "Descrição: {description}");

    // marca uso
    await incrementUsage(license_key);

    // pega de novo o uso atualizado
    const licUpdated = await getLicenseFromDB(license_key);

    return res.json({
      success: true,
      alt,
      remaining: licUpdated.monthly_quota - licUpdated.used_this_month,
      usage: {
        plan: licUpdated.plan,
        monthly_quota: licUpdated.monthly_quota,
        used_this_month: licUpdated.used_this_month,
      },
    });
  } catch (err) {
    console.error("Erro /optimize/image:", err);
    return res.status(500).json({ success: false, message: "Erro ao processar imagem" });
  }
});

// ADMIN: criar licença
app.post("/admin/create-license", async (req, res) => {
  const { admin_token, license_key, plan, monthly_quota, site_url } = req.body || {};

  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: "Token de admin inválido." });
  }

  if (!license_key) {
    return res.status(400).json({ success: false, message: "license_key é obrigatória." });
  }

  try {
    const exists = await getLicenseFromDB(license_key);
    if (exists) {
      return res.json({ success: false, message: "Essa licença já existe." });
    }

    await pool.query(
      "INSERT INTO licenses (license_key, plan, monthly_quota, used_this_month, site_url) VALUES ($1,$2,$3,$4,$5)",
      [license_key, plan || "starter", monthly_quota ? Number(monthly_quota) : 100, 0, site_url || null]
    );

    const lic = await getLicenseFromDB(license_key);

    return res.json({
      success: true,
      message: "Licença criada com sucesso.",
      license: lic,
    });
  } catch (err) {
    console.error("Erro /admin/create-license:", err);
    return res.status(500).json({ success: false, message: "Erro ao criar licença." });
  }
});

// ADMIN: listar
app.post("/admin/list-licenses", async (req, res) => {
  const { admin_token } = req.body || {};
  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: "Token de admin inválido." });
  }

  const { rows } = await pool.query("SELECT * FROM licenses ORDER BY created_at DESC");
  return res.json({ success: true, licenses: rows });
});

// ADMIN: reset
app.post("/admin/reset-license", async (req, res) => {
  const { admin_token, license_key } = req.body || {};

  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: "Token de admin inválido." });
  }

  if (!license_key) {
    return res.status(400).json({ success: false, message: "license_key é obrigatória." });
  }

  await pool.query("UPDATE licenses SET used_this_month = 0 WHERE license_key = $1", [license_key]);

  const lic = await getLicenseFromDB(license_key);

  return res.json({
    success: true,
    message: `Licença ${license_key} resetada.`,
    license: lic,
  });
});

app.listen(PORT, () => {
  console.log("🚀 API rodando na porta " + PORT);
});