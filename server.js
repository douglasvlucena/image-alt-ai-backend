import express from "express";
import axios from "axios";
import sharp from "sharp";
import dotenv from "dotenv";
import OpenAI from "openai";
import pkg from "pg";
import crypto from "crypto";

dotenv.config();

const { Pool } = pkg;

const app = express();

// aceitar JSON grande (imagem em base64)
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin-default";

// 👇 coloca isso no Render
// FREEMIUS_WEBHOOK_SECRET=qualquer-string-grande
const FREEMIUS_WEBHOOK_SECRET =
  process.env.FREEMIUS_WEBHOOK_SECRET || "freemius-secret-dev";

// 🔢 mapa oficial dos planos
const PLAN_QUOTAS = {
  starter: 300,
  pro: 1500,
  enterprise: 5000,
};

// conexão com Postgres (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// cria tabela se não existir e garante colunas novas
async function ensureTable() {
  const baseTable = `
    CREATE TABLE IF NOT EXISTS licenses (
      license_key TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'starter',
      monthly_quota INTEGER NOT NULL DEFAULT 300,
      used_this_month INTEGER NOT NULL DEFAULT 0,
      site_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_reset_at TIMESTAMPTZ
    );
  `;
  await pool.query(baseTable);

  // se alguém criou antes sem last_reset_at
  await pool.query(
    "ALTER TABLE licenses ADD COLUMN IF NOT EXISTS last_reset_at TIMESTAMPTZ"
  );
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

async function generateAltFromImage(
  imageBuffer,
  template = "Descrição: {description}"
) {
  const base64Image = imageBuffer.toString("base64");

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "Você gera descrições curtas de imagem para atributo alt, em português, focadas em SEO.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Descreva a imagem em até 120 caracteres, dizendo o que aparece.",
          },
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

/**
 * Aplica as regras do plano:
 * - força nome em minúsculo
 * - se for starter/pro/enterprise, sobrescreve a quota pelo valor oficial
 * - faz reset mensal se mudou o mês
 */
async function normalizeLicenseRow(row) {
  if (!row) return null;

  let {
    plan,
    monthly_quota,
    used_this_month,
    last_reset_at,
    license_key,
  } = row;

  const now = new Date();
  const planLower = (plan || "starter").toLowerCase();

  // quota oficial
  const officialQuota =
    PLAN_QUOTAS[planLower] !== undefined
      ? PLAN_QUOTAS[planLower]
      : monthly_quota;

  let finalUsed = used_this_month;
  let needReset = false;

  if (last_reset_at) {
    const last = new Date(last_reset_at);
    const sameMonth =
      last.getUTCFullYear() === now.getUTCFullYear() &&
      last.getUTCMonth() === now.getUTCMonth();
    if (!sameMonth) {
      needReset = true;
    }
  } else {
    needReset = true;
  }

  if (needReset) {
    finalUsed = 0;
    await pool.query(
      "UPDATE licenses SET used_this_month = 0, last_reset_at = $2 WHERE license_key = $1",
      [license_key, now.toISOString()]
    );
  }

  // se o plano é starter/pro/enterprise e quota tá diferente do oficial → corrige
  if (officialQuota !== monthly_quota) {
    await pool.query(
      "UPDATE licenses SET monthly_quota = $2 WHERE license_key = $1",
      [license_key, officialQuota]
    );
  }

  return {
    ...row,
    plan: planLower,
    monthly_quota: officialQuota,
    used_this_month: finalUsed,
  };
}

// util: pega licença no banco
async function getLicenseFromDB(license_key) {
  const { rows } = await pool.query(
    "SELECT license_key, plan, monthly_quota, used_this_month, site_url, created_at, last_reset_at FROM licenses WHERE license_key = $1",
    [license_key]
  );
  const raw = rows[0] || null;
  return await normalizeLicenseRow(raw);
}

// util: atualiza uso
async function incrementUsage(license_key) {
  await pool.query(
    "UPDATE licenses SET used_this_month = used_this_month + 1 WHERE license_key = $1",
    [license_key]
  );
}

// ------------------ ROTAS ------------------ //

// healthcheck pro Render
app.get("/", (req, res) => {
  res.json({ ok: true, message: "WP Image Alt AI backend up" });
});

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
    return res
      .status(500)
      .json({ success: false, message: "Erro no servidor." });
  }
});

// rota que o plugin vai chamar pra otimizar
app.post("/optimize/image", async (req, res) => {
  const { license_key, image_url, image_base64, template } = req.body || {};

  if (!license_key) {
    return res
      .status(400)
      .json({ success: false, message: "license_key obrigatória" });
  }

  try {
    const lic = await getLicenseFromDB(license_key);
    if (!lic) {
      return res.json({ success: false, message: "Licença inválida" });
    }

    // ⚠️ checa limite
    if (lic.used_this_month >= lic.monthly_quota) {
      return res.json({
        success: false,
        message: "Limite do plano atingido",
      });
    }

    let imgBuffer;

    if (image_base64) {
      const rawBuffer = Buffer.from(image_base64, "base64");
      imgBuffer = await resizeFromBuffer(rawBuffer);
    } else if (image_url) {
      imgBuffer = await downloadAndResize(image_url);
    } else {
      return res
        .status(400)
        .json({ success: false, message: "Nenhuma imagem recebida." });
    }

    const { alt } = await generateAltFromImage(
      imgBuffer,
      template || "Descrição: {description}"
    );

    await incrementUsage(license_key);
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
    return res
      .status(500)
      .json({ success: false, message: "Erro ao processar imagem" });
  }
});

// ------------------ ADMIN ------------------ //

// criar licença manualmente (pra teste)
app.post("/admin/create-license", async (req, res) => {
  const { admin_token, license_key, plan, site_url } = req.body || {};

  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res
      .status(401)
      .json({ success: false, message: "Token de admin inválido." });
  }

  if (!license_key) {
    return res
      .status(400)
      .json({ success: false, message: "license_key é obrigatória." });
  }

  try {
    const exists = await getLicenseFromDB(license_key);
    if (exists) {
      return res.json({ success: false, message: "Essa licença já existe." });
    }

    const planLower = (plan || "starter").toLowerCase();
    const quota =
      PLAN_QUOTAS[planLower] !== undefined ? PLAN_QUOTAS[planLower] : 300;

    await pool.query(
      "INSERT INTO licenses (license_key, plan, monthly_quota, used_this_month, site_url, last_reset_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        license_key,
        planLower,
        quota,
        0,
        site_url || null,
        new Date().toISOString(),
      ]
    );

    const lic = await getLicenseFromDB(license_key);

    return res.json({
      success: true,
      message: "Licença criada com sucesso.",
      license: lic,
    });
  } catch (err) {
    console.error("Erro /admin/create-license:", err);
    return res
      .status(500)
      .json({ success: false, message: "Erro ao criar licença." });
  }
});

// listar
app.post("/admin/list-licenses", async (req, res) => {
  const { admin_token } = req.body || {};
  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res
      .status(401)
      .json({ success: false, message: "Token de admin inválido." });
  }

  const { rows } = await pool.query(
    "SELECT * FROM licenses ORDER BY created_at DESC"
  );

  const normalized = [];
  for (const row of rows) {
    normalized.push(await normalizeLicenseRow(row));
  }

  return res.json({ success: true, licenses: normalized });
});

// reset
app.post("/admin/reset-license", async (req, res) => {
  const { admin_token, license_key } = req.body || {};

  if (!admin_token || admin_token !== ADMIN_TOKEN) {
    return res
      .status(401)
      .json({ success: false, message: "Token de admin inválido." });
  }

  if (!license_key) {
    return res
      .status(400)
      .json({ success: false, message: "license_key é obrigatória." });
  }

  const now = new Date().toISOString();

  await pool.query(
    "UPDATE licenses SET used_this_month = 0, last_reset_at = $2 WHERE license_key = $1",
    [license_key, now]
  );

  const lic = await getLicenseFromDB(license_key);

  return res.json({
    success: true,
    message: `Licença ${license_key} resetada.`,
    license: lic,
  });
});

// ------------------ FREEMIUS WEBHOOK ------------------ //
// objetivo: quando alguém comprar / ativar no Freemius, ele manda pra cá
// e a gente cria/atualiza a licença no Postgres

function verifyFreemiusSignature(rawBody, signature) {
  if (!signature) return false;
  const hmac = crypto
    .createHmac("sha256", FREEMIUS_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");
  return hmac === signature;
}

// precisamos do raw body pra validar a assinatura
app.post(
  "/freemius/webhook",
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req, res) => {
    const sig = req.header("x-freemius-signature");
    const raw = req.body.toString("utf8");

    if (!verifyFreemiusSignature(raw, sig)) {
      return res.status(401).json({ success: false, message: "assinatura inválida" });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      return res.status(400).json({ success: false, message: "json inválido" });
    }

    // Freemius manda muitas chaves; vamos pegar o que interessa
    // tentar achar a licença
    const licenseObj =
      payload.license ||
      payload.subscription?.license ||
      payload.install?.license ||
      null;

    // tentar achar o plano
    const planObj = payload.plan || payload.subscription?.plan || null;

    const licenseKey =
      licenseObj?.secret_key ||
      licenseObj?.key ||
      payload.secret_key ||
      null;

    if (!licenseKey) {
      return res
        .status(400)
        .json({ success: false, message: "sem licença no payload" });
    }

    // nome do plano (Starter, Pro, Enterprise)
    const planNameRaw =
      planObj?.title ||
      planObj?.name ||
      payload.plan_title ||
      payload.plan_name ||
      "starter";

    const planLower = planNameRaw.toLowerCase();

    let selectedPlan = "starter";
    if (planLower.includes("enterprise")) {
      selectedPlan = "enterprise";
    } else if (planLower.includes("pro")) {
      selectedPlan = "pro";
    } else {
      selectedPlan = "starter";
    }

    const quota = PLAN_QUOTAS[selectedPlan] || 300;

    // upsert no Postgres
    await pool.query(
      `
      INSERT INTO licenses (license_key, plan, monthly_quota, used_this_month, site_url, last_reset_at)
      VALUES ($1,$2,$3,0,$4,$5)
      ON CONFLICT (license_key)
      DO UPDATE SET
        plan = EXCLUDED.plan,
        monthly_quota = EXCLUDED.monthly_quota
    `,
      [
        licenseKey,
        selectedPlan,
        quota,
        payload.site?.url || null,
        new Date().toISOString(),
      ]
    );

    return res.json({ success: true });
  }
);

app.listen(PORT, () => {
  console.log("🚀 API rodando na porta " + PORT);
});