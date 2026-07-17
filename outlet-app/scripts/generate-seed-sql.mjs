// Gera supabase/seed.sql a partir dos dados legados em src/server/seed-data.ts e
// src/server/aliases-seed.ts, sem perder nenhum SKU ou alias.
//
// Uso:  node scripts/generate-seed-sql.mjs
//
// O SQL gerado é idempotente (ON CONFLICT ...), então pode ser rodado mais de
// uma vez com segurança (ex.: depois de editar o seed de origem).

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const { SEED_SKUS } = await import(pathToFileURL(path.join(root, "src/server/seed-data.ts")));
const { MODEL_ALIASES, COLOR_ALIASES } = await import(pathToFileURL(path.join(root, "src/server/aliases-seed.ts")));

function normalize(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// UUID v5 determinístico (namespace fixo + nome) — permite referenciar
// product_id/variant_id nos INSERTs sem depender de RETURNING encadeado.
const NAMESPACE = "6f2a8f2e-6f8b-4b8e-9f0a-8f0a2e6f2a8f"; // arbitrário, fixo para este projeto
function uuidV5(name) {
  const nsHex = NAMESPACE.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sqlStr(v) {
  if (v === null || v === undefined || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

// --- 1. Agrupa SEED_SKUS em produtos (por model_code_guess) ------------------
const productsByCode = new Map(); // model_code -> { name, id }
const warnings = [];

for (const r of SEED_SKUS) {
  const code = (r.model_code_guess || "").trim();
  if (!code) {
    warnings.push(`SKU sem model_code_guess ignorado na criação de produto: ${r.sku_code}`);
    continue;
  }
  if (!productsByCode.has(code)) {
    productsByCode.set(code, { name: r.base || r.produto, id: uuidV5(`product:${code}`) });
  }
}

// --- 2. Monta os INSERTs de products -----------------------------------------
const productLines = [];
for (const [code, p] of productsByCode) {
  productLines.push(
    `(${sqlStr(p.id)}, ${sqlStr(p.name)}, ${sqlStr(normalize(p.name))}, ${sqlStr(code)}, NULL, true)`
  );
}

// --- 3. Monta os INSERTs de product_variants ---------------------------------
const variantLines = [];
const seenSku = new Set();
for (const r of SEED_SKUS) {
  const code = (r.model_code_guess || "").trim();
  const product = productsByCode.get(code);
  if (!product) continue; // já reportado acima
  if (seenSku.has(r.sku_code)) {
    warnings.push(`sku_code duplicado no seed, mantida a primeira ocorrência: ${r.sku_code}`);
    continue;
  }
  seenSku.add(r.sku_code);
  const variantId = uuidV5(`variant:${r.sku_code}`);
  variantLines.push(
    `(${sqlStr(variantId)}, ${sqlStr(product.id)}, ${sqlStr(r.sku_code)}, ${sqlStr(r.gtin)}, ${sqlStr(r.color)}, ${sqlStr(normalize(r.color))}, true)`
  );
}

// --- 4. Monta os INSERTs de product_aliases ----------------------------------
const modelAliasLines = [];
for (const [alias, code] of Object.entries(MODEL_ALIASES)) {
  const product = productsByCode.get(code);
  if (!product) {
    warnings.push(`alias de modelo "${alias}" aponta para model_code "${code}" que não existe no catálogo — não migrado, revisar manualmente.`);
    continue;
  }
  modelAliasLines.push(
    `(${sqlStr(product.id)}, ${sqlStr(alias)}, ${sqlStr(normalize(alias))}, 'model', NULL, NULL, true)`
  );
}

const colorAliasLines = [];
for (const [alias, canonical] of Object.entries(COLOR_ALIASES)) {
  colorAliasLines.push(
    `(NULL, ${sqlStr(alias)}, ${sqlStr(normalize(alias))}, 'color', ${sqlStr(canonical)}, NULL, true)`
  );
}

// --- 5. Emite o SQL -----------------------------------------------------------
const header = `-- supabase/seed.sql (GERADO — não editar à mão, rode scripts/generate-seed-sql.mjs)
-- Fonte: src/server/seed-data.ts (${SEED_SKUS.length} SKUs) e src/server/aliases-seed.ts
-- (${Object.keys(MODEL_ALIASES).length} aliases de modelo, ${Object.keys(COLOR_ALIASES).length} aliases de cor).
--
-- Nota sobre cor: COLOR_ALIASES mapeia "preta" -> "Preto" (nome canônico de exibição).
-- Aqui migramos o alias em si (para o motor de matching reconhecer variações de
-- digitação); o nome canônico de cada variante já vem pronto em product_variants.color
-- a partir do catálogo original (seed-data.ts), então nenhuma informação é perdida.
--
-- Idempotente: pode ser rodado mais de uma vez (ON CONFLICT).
begin;
`;

const productsSql = productLines.length
  ? `insert into public.products (id, name, normalized_name, model_code, category, active) values\n${productLines.join(",\n")}\non conflict (id) do update set name = excluded.name, normalized_name = excluded.normalized_name, active = true;\n`
  : "-- nenhum produto a inserir\n";

const variantsSql = variantLines.length
  ? `insert into public.product_variants (id, product_id, sku_code, gtin, color, normalized_color, active) values\n${variantLines.join(",\n")}\non conflict (id) do update set gtin = excluded.gtin, color = excluded.color, normalized_color = excluded.normalized_color, active = true;\n`
  : "-- nenhuma variante a inserir\n";

const modelAliasesSql = modelAliasLines.length
  ? `insert into public.product_aliases (product_id, alias, normalized_alias, alias_type, canonical_value, created_by, active) values\n${modelAliasLines.join(",\n")}\non conflict (product_id, normalized_alias, alias_type) where product_id is not null do nothing;\n`
  : "-- nenhum alias de modelo a inserir\n";

const colorAliasesSql = colorAliasLines.length
  ? `insert into public.product_aliases (product_id, alias, normalized_alias, alias_type, canonical_value, created_by, active) values\n${colorAliasLines.join(",\n")}\non conflict (normalized_alias, alias_type) where product_id is null do nothing;\n`
  : "-- nenhum alias de cor a inserir\n";

const warningsBlock = warnings.length
  ? `-- AVISOS DA GERAÇÃO (${warnings.length}) — nada foi apagado, só não migrado automaticamente:\n${warnings.map((w) => `--   ${w}`).join("\n")}\n`
  : "-- Sem avisos: todos os SKUs e aliases foram migrados.\n";

const sql = `${header}
-- products (${productLines.length})
${productsSql}
-- product_variants (${variantLines.length})
${variantsSql}
-- product_aliases: modelo (${modelAliasLines.length})
${modelAliasesSql}
-- product_aliases: cor (${colorAliasLines.length})
${colorAliasesSql}
commit;

${warningsBlock}`;

const outPath = path.join(root, "supabase", "seed.sql");
writeFileSync(outPath, sql, "utf8");

console.log(`OK: ${outPath}`);
console.log(`  produtos: ${productLines.length}`);
console.log(`  variantes: ${variantLines.length}`);
console.log(`  aliases de modelo: ${modelAliasLines.length}`);
console.log(`  aliases de cor: ${colorAliasLines.length}`);
if (warnings.length) {
  console.log(`  avisos: ${warnings.length} (ver comentários no final do seed.sql)`);
}
