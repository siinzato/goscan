// Importação segura de catálogo (XLSX/CSV): upsert por sku_code, nunca apaga
// produtos ausentes da nova planilha (bug conhecido do protótipo original).
// Requer manager/admin — a policy de RLS é a barreira real; aqui só evitamos
// mostrar um erro cru de "permission denied" pro usuário.
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState, isManagerOrAdmin } from "./auth.ts";
import { normalize } from "./utils.ts";
import { invalidateAliasCache } from "./matching.ts";
import { invalidateSearchCache } from "./catalogApi.ts";
import { buildColorCodeMap, resolveColorFromSuffix, type ColorCodeMapRow } from "./skuColorResolver.ts";

export interface ImportRowInput {
  produto?: string;
  sku_code?: string;
  gtin?: string;
  cor?: string;
  modelo?: string;
}

export interface ImportSummary {
  total_rows: number;
  inserted_rows: number;
  updated_rows: number;
  rejected_rows: number;
  errors: { row: number; reason: string }[];
}

const HEADER_ALIASES: Record<string, keyof ImportRowInput> = {
  produto: "produto",
  sku: "sku_code",
  "codigo sku": "sku_code",
  "codigo (sku)": "sku_code",
  codigo: "sku_code",
  "gtin ean": "gtin",
  "gtin/ean": "gtin",
  gtin: "gtin",
  ean: "gtin",
  cor: "cor",
  modelo: "modelo",
  model_code: "modelo",
  "model code": "modelo",
};

/** Recebe as linhas cruas do XLSX.utils.sheet_to_json (chaves = cabeçalhos originais). */
export function mapSheetRows(rawRows: Record<string, unknown>[]): ImportRowInput[] {
  return rawRows.map((raw) => {
    const mapped: ImportRowInput = {};
    for (const [key, value] of Object.entries(raw)) {
      const normalizedKey = normalize(key);
      const field = HEADER_ALIASES[normalizedKey];
      if (field && value !== undefined && value !== null && String(value).trim() !== "") {
        mapped[field] = String(value).trim();
      }
    }
    return mapped;
  });
}

interface NormalizedRow {
  rowIndex: number;
  produto: string;
  base: string;
  cor: string;
  sku_code: string;
  gtin: string;
  model_code: string;
}

export function deriveModelCode(skuCode: string, explicitModelo?: string): string {
  if (explicitModelo && explicitModelo.trim()) return explicitModelo.trim().toUpperCase();
  let code = skuCode.trim();
  if (code.toUpperCase().startsWith("OUT-")) code = code.slice(4);
  return code.replace(/-\d+$/, "");
}

function validateAndNormalize(rows: ImportRowInput[]): { valid: NormalizedRow[]; errors: { row: number; reason: string }[] } {
  const valid: NormalizedRow[] = [];
  const errors: { row: number; reason: string }[] = [];

  rows.forEach((r, idx) => {
    const rowIndex = idx + 2; // +1 header, +1 para índice humano (1-based)
    const produto = (r.produto || "").trim();
    const sku_code = (r.sku_code || "").trim();
    if (!produto || !sku_code) {
      errors.push({ row: rowIndex, reason: "Produto e SKU são obrigatórios." });
      return;
    }
    let base = produto;
    let cor = (r.cor || "").trim();
    if (!cor && produto.includes(" - ")) {
      const lastDash = produto.lastIndexOf(" - ");
      base = produto.slice(0, lastDash).trim();
      cor = produto.slice(lastDash + 3).trim();
    }
    const model_code = deriveModelCode(sku_code, r.modelo);
    if (!model_code) {
      errors.push({ row: rowIndex, reason: `Não foi possível determinar o modelo do SKU "${sku_code}".` });
      return;
    }
    valid.push({ rowIndex, produto, base, cor, sku_code, gtin: (r.gtin || "").trim(), model_code });
  });

  return { valid, errors };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface UpsertVariantRow {
  sku_code: string;
  base: string;
  cor: string;
  gtin: string;
  model_code: string;
  /** 'outlet' (default, preserva o comportamento atual) ou 'normal' — ver 0022_product_type_and_normal_products.sql. */
  product_type?: "outlet" | "normal";
}

export interface UpsertVariantsResult {
  variantIdBySku: Map<string, string>;
  insertedSkus: Set<string>;
  updatedSkus: Set<string>;
}

/**
 * Upsert compartilhado de products (por model_code) + product_variants (por
 * sku_code). Usado pelo importador de catálogo (SKU/cor/GTIN) e também pelo
 * importador do Catálogo Visual (SKU Outlet/nome/GTIN + imagens) — evita
 * duplicar a lógica de upsert em dois lugares.
 */
export async function upsertProductsAndVariants(rows: UpsertVariantRow[]): Promise<UpsertVariantsResult> {
  const supabase = getSupabase();

  // Chave composta (model_code + product_type): "TCGCM42-1" (Normal) e
  // "OUT-TCGCM42-1" (Outlet) derivam o MESMO model_code ("TCGCM42") —
  // sem o product_type na chave, o upsert de um tipo sobrescreveria o
  // registro do outro (ver comentário na migration 0022). Nunca funde as
  // duas famílias mesmo quando o texto do model_code coincide.
  const productKey = (modelCode: string, productType: string) => `${modelCode}::${productType}`;

  const productsByCode = new Map<string, { name: string; normalized_name: string; model_code: string; product_type: string }>();
  for (const row of rows) {
    const product_type = row.product_type || "outlet";
    const key = productKey(row.model_code, product_type);
    if (!productsByCode.has(key)) {
      productsByCode.set(key, { name: row.base, normalized_name: normalize(row.base), model_code: row.model_code, product_type });
    }
  }

  const productIdByCode = new Map<string, string>();
  for (const batch of chunk(Array.from(productsByCode.values()), 500)) {
    const { data, error } = await supabase.from("products").upsert(batch, { onConflict: "model_code,product_type" }).select("id, model_code, product_type");
    if (error) throw error;
    for (const row of data as { id: string; model_code: string; product_type: string }[]) {
      productIdByCode.set(productKey(row.model_code, row.product_type), row.id);
    }
  }

  const allSkus = rows.map((r) => r.sku_code);
  const existingSkus = new Set<string>();
  for (const batch of chunk(allSkus, 500)) {
    const { data, error } = await supabase.from("product_variants").select("sku_code").in("sku_code", batch);
    if (error) throw error;
    for (const row of data as { sku_code: string }[]) existingSkus.add(row.sku_code);
  }

  const variantRows = rows
    .map((row) => {
      const productId = productIdByCode.get(productKey(row.model_code, row.product_type || "outlet"));
      if (!productId) return null;
      return {
        product_id: productId,
        sku_code: row.sku_code,
        gtin: row.gtin || null,
        color: row.cor || null,
        normalized_color: normalize(row.cor),
        active: true,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const variantIdBySku = new Map<string, string>();
  for (const batch of chunk(variantRows, 500)) {
    const { data, error } = await supabase.from("product_variants").upsert(batch, { onConflict: "sku_code" }).select("id, sku_code");
    if (error) throw error;
    for (const row of data as { id: string; sku_code: string }[]) {
      variantIdBySku.set(row.sku_code, row.id);
    }
  }

  return {
    variantIdBySku,
    insertedSkus: new Set(variantRows.filter((r) => !existingSkus.has(r.sku_code)).map((r) => r.sku_code)),
    updatedSkus: new Set(variantRows.filter((r) => existingSkus.has(r.sku_code)).map((r) => r.sku_code)),
  };
}

export async function importCatalog(fileName: string, rawRows: Record<string, unknown>[]): Promise<ImportSummary> {
  const { profile } = getAuthState();
  if (!isManagerOrAdmin(profile)) {
    throw new Error("Apenas manager ou admin podem importar o catálogo.");
  }

  const supabase = getSupabase();
  const mapped = mapSheetRows(rawRows);
  const { valid, errors } = validateAndNormalize(mapped);

  const { data: importRow, error: importInsertError } = await supabase
    .from("catalog_imports")
    .insert({
      file_name: fileName,
      imported_by: profile!.id,
      total_rows: rawRows.length,
      status: "processing",
    })
    .select()
    .single();
  if (importInsertError) throw importInsertError;

  try {
    const { insertedSkus, updatedSkus } = await upsertProductsAndVariants(valid);
    const inserted_rows = insertedSkus.size;
    const updated_rows = updatedSkus.size;
    const rejected_rows = errors.length;

    await supabase
      .from("catalog_imports")
      .update({
        inserted_rows,
        updated_rows,
        rejected_rows,
        status: "completed",
        error_summary: errors.length ? { errors: errors.slice(0, 200), truncated: errors.length > 200 } : null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", importRow.id);

    invalidateAliasCache();
    invalidateSearchCache();

    return { total_rows: rawRows.length, inserted_rows, updated_rows, rejected_rows, errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("catalog_imports")
      .update({ status: "failed", error_summary: { fatal: message }, finished_at: new Date().toISOString() })
      .eq("id", importRow.id);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Produtos Normais — EXPANSÃO GOSCAN: planilha só com Nome/SKU/EAN, sem cor/
// imagem/treinamento. Reaproveita o MESMO upsert de products/product_variants
// (upsertProductsAndVariants), só marcando product_type='normal' — nunca cria
// tabela paralela (ver 0022_product_type_and_normal_products.sql).
// ---------------------------------------------------------------------------
export interface NormalImportRowInput {
  nome?: string;
  sku_code?: string;
  ean?: string;
}

const NORMAL_HEADER_ALIASES: Record<string, keyof NormalImportRowInput> = {
  nome: "nome",
  produto: "nome",
  descricao: "nome",
  "descrição": "nome",
  sku: "sku_code",
  "codigo sku": "sku_code",
  codigo: "sku_code",
  ean: "ean",
  gtin: "ean",
  "gtin ean": "ean",
  "gtin/ean": "ean",
};

export function mapNormalProductRows(rawRows: Record<string, unknown>[]): NormalImportRowInput[] {
  return rawRows.map((raw) => {
    const mapped: NormalImportRowInput = {};
    for (const [key, value] of Object.entries(raw)) {
      const normalizedKey = normalize(key);
      const field = NORMAL_HEADER_ALIASES[normalizedKey];
      if (field && value !== undefined && value !== null && String(value).trim() !== "") {
        mapped[field] = String(value).trim();
      }
    }
    return mapped;
  });
}

export function validateAndNormalizeNormalRows(rows: NormalImportRowInput[]): { valid: UpsertVariantRow[]; errors: { row: number; reason: string }[] } {
  const valid: UpsertVariantRow[] = [];
  const errors: { row: number; reason: string }[] = [];

  rows.forEach((r, idx) => {
    const rowIndex = idx + 2;
    const nome = (r.nome || "").trim();
    const sku_code = (r.sku_code || "").trim();
    if (!nome || !sku_code) {
      errors.push({ row: rowIndex, reason: "Nome e SKU são obrigatórios." });
      return;
    }
    // BUG REAL corrigido: sem isso, "Nome" completo (ex.: "Bolsa de Viagem
    // GoCase Joy - Off White") virava o nome da FAMÍLIA inteira em
    // products.name — como vários SKUs da mesma família (mesmo model_code)
    // compartilham essa mesma linha de products, só o nome do PRIMEIRO SKU
    // processado "vencia" e ficava colado em todas as cores da família.
    // Removendo o sufixo " - Cor" do nome (mesma convenção já usada no
    // import Outlet), a família agrupa com um nome limpo e consistente — a
    // cor de cada SKU vem separadamente do código de sufixo do SKU (ver
    // applySkuSuffixColors), não mais do texto livre do nome.
    let base = nome;
    if (nome.includes(" - ")) {
      const lastDash = nome.lastIndexOf(" - ");
      base = nome.slice(0, lastDash).trim();
    }
    // Mesma convenção de agrupamento por família do import Outlet (remove
    // sufixo -N de variação) — reaproveitada de propósito para permitir que
    // cores/variações do mesmo produto normal fiquem sob o mesmo "products".
    const model_code = deriveModelCode(sku_code);
    valid.push({ sku_code, base, cor: "", gtin: (r.ean || "").trim(), model_code, product_type: "normal" });
  });

  return { valid, errors };
}

interface ProductVariantRow {
  id: string;
  sku_code: string;
  color: string | null;
  [key: string]: unknown;
}

/**
 * Resolve e grava a cor dos SKUs informados pelo código de sufixo (mesma
 * regra do Modo Scan Outlet) — NUNCA sobrescreve uma cor já cadastrada
 * (fonte cadastral sempre vence, só preenche quando ainda está vazia).
 * Paginado em blocos de 1000 (limite real do Supabase por requisição — ver
 * bug já corrigido em fetchAllNormalProducts/nfeApi.ts) e faz upsert com a
 * linha INTEIRA (nunca um objeto parcial — ver bug real já corrigido em
 * finalizeReceipt/nfeApi.ts: upsert parcial viola colunas NOT NULL omitidas).
 */
async function applySkuSuffixColors(skuCodes: string[]): Promise<void> {
  const supabase = getSupabase();
  const uniqueSkus = Array.from(new Set(skuCodes.filter(Boolean)));
  if (uniqueSkus.length === 0) return;

  const codeMapRows: ColorCodeMapRow[] = [];
  const PAGE_SIZE = 1000;
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("product_variants")
      .select("sku_code, color, products(capacity_ml)")
      .not("color", "is", null)
      .eq("active", true)
      // BUG REAL corrigido: sem order(), o Postgres não garante linhas
      // estáveis entre chamadas .range() separadas — order() por uma coluna
      // que já vem no select (sku_code) torna a paginação determinística.
      .order("sku_code")
      .range(from, to);
    if (error) throw error;
    const batch = (data as unknown as { sku_code: string; color: string | null; products: { capacity_ml: number | null } | { capacity_ml: number | null }[] | null }[]) || [];
    for (const row of batch) {
      const product = Array.isArray(row.products) ? row.products[0] : row.products;
      codeMapRows.push({ sku_code: row.sku_code, color: row.color, capacity_ml: product?.capacity_ml ?? null });
    }
    if (batch.length < PAGE_SIZE) break;
  }

  const codeMap = buildColorCodeMap(codeMapRows);
  if (codeMap.size === 0) return;

  for (const batch of chunk(uniqueSkus, 500)) {
    const { data, error } = await supabase.from("product_variants").select("*").in("sku_code", batch);
    if (error) throw error;

    const updates: ProductVariantRow[] = [];
    for (const row of (data as ProductVariantRow[]) || []) {
      if (row.color) continue;
      const resolvedColor = resolveColorFromSuffix(row.sku_code, codeMap);
      if (!resolvedColor) continue;
      updates.push({ ...row, color: resolvedColor, normalized_color: normalize(resolvedColor) });
    }
    if (updates.length > 0) {
      const { error: updateError } = await supabase.from("product_variants").upsert(updates, { onConflict: "id" });
      if (updateError) throw updateError;
    }
  }
}

export async function importNormalProducts(fileName: string, rawRows: Record<string, unknown>[]): Promise<ImportSummary> {
  const { profile } = getAuthState();
  if (!isManagerOrAdmin(profile)) {
    throw new Error("Apenas manager ou admin podem importar produtos normais.");
  }

  const supabase = getSupabase();
  const mapped = mapNormalProductRows(rawRows);
  const { valid, errors } = validateAndNormalizeNormalRows(mapped);

  const { data: importRow, error: importInsertError } = await supabase
    .from("catalog_imports")
    .insert({
      file_name: fileName,
      imported_by: profile!.id,
      total_rows: rawRows.length,
      status: "processing",
      product_type: "normal",
    })
    .select()
    .single();
  if (importInsertError) throw importInsertError;

  try {
    const { insertedSkus, updatedSkus } = await upsertProductsAndVariants(valid);
    const inserted_rows = insertedSkus.size;
    const updated_rows = updatedSkus.size;
    const rejected_rows = errors.length;

    // EXPANSÃO GOSCAN — mesma lógica de resolução de cor pelo sufixo do SKU
    // já usada no Modo Scan Outlet (ver skuColorResolver.ts), aplicada aos
    // produtos normais recém-importados: Produtos Normais não têm coluna de
    // Cor própria, então a cor vem do código de sufixo do SKU (nunca do
    // texto livre do Nome, que não é confiável pra isso).
    await applySkuSuffixColors(valid.map((v) => v.sku_code));

    await supabase
      .from("catalog_imports")
      .update({
        inserted_rows,
        updated_rows,
        rejected_rows,
        status: "completed",
        error_summary: errors.length ? { errors: errors.slice(0, 200), truncated: errors.length > 200 } : null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", importRow.id);

    invalidateSearchCache();

    return { total_rows: rawRows.length, inserted_rows, updated_rows, rejected_rows, errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("catalog_imports")
      .update({ status: "failed", error_summary: { fatal: message }, finished_at: new Date().toISOString() })
      .eq("id", importRow.id);
    throw err;
  }
}
