// Importação segura de catálogo (XLSX/CSV): upsert por sku_code, nunca apaga
// produtos ausentes da nova planilha (bug conhecido do protótipo original).
// Requer manager/admin — a policy de RLS é a barreira real; aqui só evitamos
// mostrar um erro cru de "permission denied" pro usuário.
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState, isManagerOrAdmin } from "./auth.ts";
import { normalize } from "./utils.ts";
import { invalidateAliasCache } from "./matching.ts";

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

  const productsByCode = new Map<string, { name: string; normalized_name: string; model_code: string }>();
  for (const row of rows) {
    if (!productsByCode.has(row.model_code)) {
      productsByCode.set(row.model_code, { name: row.base, normalized_name: normalize(row.base), model_code: row.model_code });
    }
  }

  const productIdByCode = new Map<string, string>();
  for (const batch of chunk(Array.from(productsByCode.values()), 500)) {
    const { data, error } = await supabase.from("products").upsert(batch, { onConflict: "model_code" }).select("id, model_code");
    if (error) throw error;
    for (const row of data as { id: string; model_code: string }[]) {
      productIdByCode.set(row.model_code, row.id);
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
      const productId = productIdByCode.get(row.model_code);
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
