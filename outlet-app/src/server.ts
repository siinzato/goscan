import { SEED_SKUS, type SkuRecord } from "./seed-data.ts";
import { MODEL_ALIASES, COLOR_ALIASES } from "./aliases-seed.ts";

interface Env {
  DB: any;
  ANTHROPIC_API_KEY?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function normalize(s: string): string {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureSchema(env: Env) {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS skus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto TEXT,
      base TEXT,
      color TEXT,
      sku_code TEXT UNIQUE,
      gtin TEXT,
      model_code TEXT
    )`,
    []
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS model_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT UNIQUE,
      model_code TEXT
    )`,
    []
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS color_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT UNIQUE,
      color_canonical TEXT
    )`,
    []
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS conferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT,
      name TEXT
    )`,
    []
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS conference_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conference_id INTEGER,
      modelo_bruto TEXT,
      cor_bruta TEXT,
      qtd INTEGER,
      model_code TEXT,
      sku_matched TEXT,
      produto_matched TEXT,
      color_matched TEXT,
      status TEXT
    )`,
    []
  );

  const countRes = await env.DB.query("SELECT COUNT(*) as c FROM skus", []);
  const count = countRes.rows[0]?.c ?? 0;
  if (count === 0) {
    await seedCatalog(env, SEED_SKUS);
  }

  const aliasCountRes = await env.DB.query(
    "SELECT COUNT(*) as c FROM model_aliases",
    []
  );
  if ((aliasCountRes.rows[0]?.c ?? 0) === 0) {
    for (const [alias, code] of Object.entries(MODEL_ALIASES)) {
      await env.DB.exec(
        "INSERT OR IGNORE INTO model_aliases (alias, model_code) VALUES (?, ?)",
        [normalize(alias), code]
      );
    }
    for (const [alias, color] of Object.entries(COLOR_ALIASES)) {
      await env.DB.exec(
        "INSERT OR IGNORE INTO color_aliases (alias, color_canonical) VALUES (?, ?)",
        [normalize(alias), color]
      );
    }
  }
}

async function seedCatalog(env: Env, records: SkuRecord[]) {
  await env.DB.exec("DELETE FROM skus", []);
  for (const r of records) {
    await env.DB.exec(
      `INSERT OR IGNORE INTO skus (produto, base, color, sku_code, gtin, model_code)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r.produto, r.base, r.color, r.sku_code, r.gtin, r.model_code_guess]
    );
  }
}

async function getAliasLists(env: Env) {
  const models = await env.DB.query(
    "SELECT alias, model_code FROM model_aliases ORDER BY LENGTH(alias) DESC",
    []
  );
  const colors = await env.DB.query(
    "SELECT alias, color_canonical FROM color_aliases ORDER BY LENGTH(alias) DESC",
    []
  );
  return { models: models.rows as any[], colors: colors.rows as any[] };
}

function findModelCode(normalized: string, models: any[]): string | null {
  for (const m of models) {
    if (normalized.includes(m.alias)) return m.model_code;
  }
  return null;
}

function findColor(normalized: string, colors: any[]): string | null {
  for (const c of colors) {
    if (normalized.includes(c.alias)) return c.color_canonical;
  }
  return null;
}

async function matchItem(
  env: Env,
  modelo: string,
  cor: string
): Promise<{
  model_code: string | null;
  color_matched: string | null;
  sku_code: string | null;
  produto_matched: string | null;
  status: string;
}> {
  const { models, colors } = await getAliasLists(env);
  const normModelo = normalize(modelo);
  const normCor = normalize(cor);

  const model_code = findModelCode(normModelo, models);
  const color_matched = findColor(normCor, colors) || (cor ? cor.trim() : null);

  if (!model_code) {
    return {
      model_code: null,
      color_matched,
      sku_code: null,
      produto_matched: null,
      status: "modelo_nao_encontrado",
    };
  }

  const skuRows = await env.DB.query(
    "SELECT * FROM skus WHERE model_code = ?",
    [model_code]
  );

  if (skuRows.rows.length === 0) {
    return {
      model_code,
      color_matched,
      sku_code: null,
      produto_matched: null,
      status: "sku_nao_cadastrado",
    };
  }

  if (color_matched) {
    const normColorMatched = normalize(color_matched);
    const exact = skuRows.rows.find(
      (r: any) => normalize(r.color) === normColorMatched
    );
    if (exact) {
      return {
        model_code,
        color_matched: exact.color,
        sku_code: exact.sku_code,
        produto_matched: exact.produto,
        status: "matched",
      };
    }
    const partial = skuRows.rows.find(
      (r: any) =>
        normalize(r.color).includes(normColorMatched) ||
        normColorMatched.includes(normalize(r.color))
    );
    if (partial) {
      return {
        model_code,
        color_matched: partial.color,
        sku_code: partial.sku_code,
        produto_matched: partial.produto,
        status: "matched_parcial",
      };
    }
  }

  return {
    model_code,
    color_matched,
    sku_code: null,
    produto_matched: skuRows.rows[0]?.base ?? null,
    status: "cor_nao_encontrada",
  };
}

async function callClaudeVision(
  env: Env,
  images: { data: string; media_type: string }[]
) {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      error:
        "ANTHROPIC_API_KEY não configurada. Peça para o administrador cadastrar a chave da API Anthropic (console.anthropic.com) nas configurações do app.",
    };
  }

  const modelListText = Object.keys(MODEL_ALIASES).join(", ");

  const systemPrompt = `Você está lendo prints de uma conversa de WhatsApp onde um funcionário de estoque conferiu produtos manualmente. Cada mensagem/balão pode conter um ou mais produtos, cores e quantidades, em formatos variados como:
"Tote pop micro\\n4 marrom\\n1 off WHITE\\n1 preta" (um modelo, várias cores)
"Tote Mini preto 1uni" (modelo cor quantidade na mesma linha)
"Puffer marrom 3 uni" (as vezes o modelo aparece abreviado)
"Necessarie Puffer M\\nRosa 2 uni\\nPreta 2 uni" (um modelo, várias cores, várias linhas)

Quando não houver número de quantidade explícito, assuma 1 unidade.
Alguns nomes de modelo conhecidos (apelidos que os funcionários usam) incluem: ${modelListText}.

Extraia TODOS os itens de TODAS as imagens fornecidas e retorne SOMENTE um JSON válido (sem markdown, sem texto antes ou depois), no formato:
{"items": [{"modelo": "texto exato como escrito", "cor": "texto exato como escrito", "quantidade": numero}]}`;

  const content: any[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.media_type, data: img.data },
  }));
  content.push({
    type: "text",
    text: "Extraia os itens dessas imagens seguindo as instruções do sistema.",
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Erro na API Anthropic (${resp.status}): ${text}` };
  }

  const data: any = await resp.json();
  const textBlock = (data.content || []).find((c: any) => c.type === "text");
  if (!textBlock) return { error: "Resposta da IA sem conteúdo de texto." };

  let cleaned = textBlock.text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    return { items: parsed.items || [] };
  } catch (e) {
    return { error: "Não foi possível interpretar a resposta da IA como JSON." };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      await ensureSchema(env);

      if (path === "/api/catalog" && request.method === "GET") {
        const q = url.searchParams.get("q");
        let rows;
        if (q) {
          const like = `%${q}%`;
          rows = await env.DB.query(
            "SELECT * FROM skus WHERE produto LIKE ? OR sku_code LIKE ? ORDER BY produto LIMIT 200",
            [like, like]
          );
        } else {
          rows = await env.DB.query(
            "SELECT * FROM skus ORDER BY produto LIMIT 500",
            []
          );
        }
        return json({ skus: rows.rows });
      }

      if (path === "/api/catalog/import" && request.method === "POST") {
        const body: any = await request.json();
        const records: SkuRecord[] = (body.records || []).map((r: any) => {
          const produto = String(r.produto || "").trim();
          const sku_code = String(r.sku_code || "").trim();
          const gtin = String(r.gtin || "").trim();
          let base = produto;
          let color = "";
          if (produto.includes(" - ")) {
            const idx = produto.lastIndexOf(" - ");
            base = produto.slice(0, idx).trim();
            color = produto.slice(idx + 3).trim();
          }
          let code = sku_code;
          if (code.startsWith("OUT-")) code = code.slice(4);
          const model_code_guess = code.replace(/-\d+$/, "");
          return { produto, base, color, sku_code, gtin, model_code_guess };
        });
        await seedCatalog(env, records);
        return json({ imported: records.length });
      }

      if (path === "/api/aliases" && request.method === "GET") {
        const { models, colors } = await getAliasLists(env);
        return json({ models, colors });
      }

      if (path === "/api/aliases/model" && request.method === "POST") {
        const body: any = await request.json();
        const alias = normalize(String(body.alias || ""));
        const model_code = String(body.model_code || "").trim();
        if (!alias || !model_code) return json({ error: "dados incompletos" }, 400);
        await env.DB.exec(
          "INSERT OR REPLACE INTO model_aliases (alias, model_code) VALUES (?, ?)",
          [alias, model_code]
        );
        return json({ ok: true });
      }

      if (path === "/api/aliases/color" && request.method === "POST") {
        const body: any = await request.json();
        const alias = normalize(String(body.alias || ""));
        const color_canonical = String(body.color || "").trim();
        if (!alias || !color_canonical) return json({ error: "dados incompletos" }, 400);
        await env.DB.exec(
          "INSERT OR REPLACE INTO color_aliases (alias, color_canonical) VALUES (?, ?)",
          [alias, color_canonical]
        );
        return json({ ok: true });
      }

      if (path === "/api/match" && request.method === "POST") {
        const body: any = await request.json();
        const items = body.items || [];
        const results = [];
        for (const it of items) {
          const m = await matchItem(env, it.modelo || "", it.cor || "");
          results.push({
            modelo_bruto: it.modelo || "",
            cor_bruta: it.cor || "",
            qtd: Number(it.quantidade || it.qtd || 1),
            ...m,
          });
        }
        return json({ results });
      }

      if (path === "/api/parse-images" && request.method === "POST") {
        const body: any = await request.json();
        const images = body.images || [];
        const result = await callClaudeVision(env, images);
        return json(result);
      }

      if (path === "/api/conferences" && request.method === "POST") {
        const body: any = await request.json();
        const name = body.name || new Date().toISOString();
        const items = body.items || [];
        const now = new Date().toISOString();
        await env.DB.exec(
          "INSERT INTO conferences (created_at, name) VALUES (?, ?)",
          [now, name]
        );
        const idRes = await env.DB.query(
          "SELECT last_insert_rowid() as id",
          []
        );
        const conferenceId = idRes.rows[0].id;
        for (const it of items) {
          await env.DB.exec(
            `INSERT INTO conference_items
             (conference_id, modelo_bruto, cor_bruta, qtd, model_code, sku_matched, produto_matched, color_matched, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              conferenceId,
              it.modelo_bruto || "",
              it.cor_bruta || "",
              Number(it.qtd || 1),
              it.model_code || "",
              it.sku_code || "",
              it.produto_matched || "",
              it.color_matched || "",
              it.status || "",
            ]
          );
        }
        return json({ id: conferenceId });
      }

      if (path === "/api/conferences" && request.method === "GET") {
        const rows = await env.DB.query(
          "SELECT * FROM conferences ORDER BY id DESC LIMIT 100",
          []
        );
        return json({ conferences: rows.rows });
      }

      if (path.startsWith("/api/conferences/") && request.method === "GET") {
        const id = path.split("/").pop();
        const conf = await env.DB.query(
          "SELECT * FROM conferences WHERE id = ?",
          [id]
        );
        const items = await env.DB.query(
          "SELECT * FROM conference_items WHERE conference_id = ?",
          [id]
        );
        return json({ conference: conf.rows[0], items: items.rows });
      }

      if (path === "/api/status" && request.method === "GET") {
        return json({ has_anthropic_key: !!env.ANTHROPIC_API_KEY });
      }

      return json({ error: "not found" }, 404);
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};
