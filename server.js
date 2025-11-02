import express from "express";
import axios from "axios";
import sharp from "sharp";
import dotenv from "dotenv";
import OpenAI from "openai";
import { Pool } from "pg";

dotenv.config();

// ===========================
// CONFIG BÁSICA
// ===========================
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin-default";

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Postgres (Render)
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false }, // Render usa SSL
});

// só pra garantir que conecta
pool
  .connect()
  .then((client) => {
    console.log("✅ Conectado ao Postgres!");
    client.release();
  })
  .catch((err) => {
    console.error("❌ Erro ao conectar no Postgres:", err);
  });

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ===========================
// HELPERS DE BANCO
// ===========================

// busca uma licença pelo código
async function getLicense(licenseKey) {
  const { rows } = await pool.query(
    "SELECT * FROM licenses WHERE license_key = $1",
    [licenseKey]
  );
  return rows[0] || null;
}

// cria licença (admin)
async function createLicense({ license_key, plan = "starter", monthly_quota = 100, site_url = null }) {
  const { rows } = await pool.query(
    `INSERT INTO licenses (license_key, plan, monthly_quota, used_this_month, site_url)
     VALUES ($1, $2, $3, 0, COALESCE($4, ''))
     RETURNING *`,
    [license_key, plan, monthly_quota, site_url]
  );
  return rows[0];
}

// atualiza uso (+1)
async function increaseUsage(licenseKey) {
  const { rows } = await pool.query(
    `UPDATE licenses
     SET used_this_month = used_this_month + 1
     WHERE license_key = $1
     RETURNING *`,
    [licenseKey]
  );
  return rows[0];
}

// zera uso
async function resetUsage(licenseKey) {
  const { rows } = await pool.query(
    `UPDATE licenses
     SET used_this_month = 0
     WHERE license_key = $1
     RETURNING *`,
    [licenseKey]
  );
  return rows[0];
}

// lista todas (admin)
async function listLicenses() {
  const { rows } = await pool.query(
    `SELECT license_key, plan, monthly_quota, used_this_month, site_url, created_at
     FROM licenses
     ORDER BY created_at DESC`
  );
  return rows;
}

// ===========================
// HELPERS DE IMAGEM / IA
// ===========================
async function downloadAndResize(imageUrl) {
  const resp = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const buffer = Buffer.from(resp.data);
  // redimensiona só pra não mandar imagem gigante pra IA
  const resized = await sharp(buffer).resize(1024).toBuffer();
  return resized;
}

async function generateAltFromImage(
  imageBuffer,
  template = "Descrição: {description}",
  lang = "pt-BR"
) {
  const base64Image = imageBuffer.toString("base64");

  // escolhe idioma do prompt
  const langPrompts = {
    "pt-BR": {
      system:
        "Você gera descrições curtas de imagem para atributo alt, em português do Brasil, focadas em SEO.",
      user: "Descreva a imagem em até 120 caracteres, dizendo o que aparece.",
    },
    "en-US": {
      system:
        "You generate short image descriptions for the alt attribute, in US English, SEO-friendly.",
      user: "Describe the image in up to 120 characters, saying what is shown.",
    },
  };

  const promptSet = langPrompts[lang] || langPrompts["pt-BR"];

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: promptSet.system,
      },
      {
        role: "user",
        content: [
          { type: "text", text: promptSet.user },
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

// ===========================
// ROTAS
// ===========================

// 1) WP checa licença
app.post("/auth/check-license", async (req, res) => {
  const { license_key } = req.body;

  if (!license_key) {
    return res.json({ success: false, message: "license_key obrigatória" });
  }

  try {
    const lic = await getLicense(license_key);
    if (!lic) {
      return res.json({ success: false, message: "Licença inválida" });
    }

    return res.json({
      success: true,
      plan: lic.plan,
      monthly_quota: lic.monthly_quota,
      used_this_month: lic.used_this_month,
    });
  } catch (err) {
    console.error("Erro em /auth/check-license:", err);
    return res.status(500).json({ success: false, message: "Erro interno" });
  }
});

// 2) WP pega uso atual
app.post("/usage", async (req, res) => {
  const { license_key } = req.body || {};
  if (!license_key) {
    return res.json({ success: false, message: "license_key obrigatória" });
  }

  try {
    const lic = await getLicense(license_key);
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
    console.error("Erro em /usage:", err);
    return res.status(500).json({ success: false, message: "Erro interno" });
  }
});

// 3) rota que o plugin chama pra otimizar
app.post("/optimize/image", async (req, res) => {
  const {
    license_key,
    image_url,
    template = "Descrição: {description}",
    lang = "pt-BR",
    site_url = null,
  } = req.body;

  if (!license_key) {
    return res.status(400).json({ success: false, message: "license_key obrigatória" });
  }
  if (!image_url) {
    return res.status(400).json({ success: false, message: "image_url obrigatória" });
  }

  try {
    const lic = await getLicense(license_key);
    if (!lic) {
      return res.json({ success: false, message: "Licença inválida" });
    }

    // checa limite
    if (lic.used_this_month >= lic.monthly_quota) {
      return res.json({ success: false, message: "Limite do plano atingido" });
    }

    // baixa img, manda pra IA
    const buffer = await downloadAndResize(image_url);
    const { alt } = await generateAltFromImage(buffer, template, lang);

    // soma 1
    await increaseUsage(license_key);

    // devolve
    return res.json({
      success: true,
      alt,
      remaining: lic.monthly_quota - (lic.used_this_month + 1),
    });
  } catch (err) {
    console.error("Erro em /optimize/image:", err);
    return res.status(500).json({ success: false, message: "Erro ao processar imagem" });
  }
});

// 4) ADMIN: cria licença
app.post("/admin/create-license", async (req, res) => {
  const { admin_token, license_key, plan, monthly_quota, site_url } = req.body || {};

  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: "Token de admin inválido." });
  }

  if (!license_key) {
    return res.status(400).json({ success: false, message: "license_key é obrigatória." });
  }

  try {
    const exists = await getLicense(license_key);
    if (exists) {
      return res.json({ success: false, message: "Essa licença já existe." });
    }

    const lic = await createLicense({
      license_key,
      plan,
      monthly_quota,
      site_url,
    });

    return res.json({
      success: true,
      message: "Licença criada com sucesso.",
      license: lic,
    });
  } catch (err) {
    console.error("Erro em /admin/create-license:", err);
    return res.status(500).json({ success: false, message: "Erro interno" });
  }
});

// 5) ADMIN: lista licenças
app.post("/admin/list-licenses", async (req, res) => {
  const { admin_token } = req.body || {};
  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: "Token de admin inválido." });
  }

  try {
    const rows = await listLicenses();
    return res.json({ success: true, licenses: rows });
  } catch (err) {
    console.error("Erro em /admin/list-licenses:", err);
    return res.status(500).json({ success: false, message: "Erro interno" });
  }
});

// 6) ADMIN: reset licença
app.post("/admin/reset-license", async (req, res) => {
  const { admin_token, license_key } = req.body || {};

  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, message: "Token de admin inválido." });
  }
  if (!license_key) {
    return res.status(400).json({ success: false, message: "license_key é obrigatória." });
  }

  try {
    const lic = await resetUsage(license_key);
    if (!lic) {
      return res.json({ success: false, message: "Licença não encontrada." });
    }

    return res.json({
      success: true,
      message: `Licença ${license_key} resetada.`,
      license: lic,
    });
  } catch (err) {
    console.error("Erro em /admin/reset-license:", err);
    return res.status(500).json({ success: false, message: "Erro interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 API rodando na porta " + PORT);
});
