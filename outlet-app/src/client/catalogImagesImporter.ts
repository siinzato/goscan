// Importador do Catálogo Visual: planilha SKU Outlet + Nome + GTIN/EAN + URL
// da imagem. Não assume que a linha 1 é o cabeçalho (a planilha real de
// referência tem título/resumo antes do cabeçalho de verdade) — procura a
// linha de cabeçalho pelo conteúdo, normalizado, aceitando variações comuns.
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState, isManagerOrAdmin } from "./auth.ts";
import { normalize } from "./utils.ts";
import { deriveModelCode, upsertProductsAndVariants } from "./importer.ts";

export interface ParsedCatalogImageRow {
  row_number: number; // 1-based, relativo à planilha original (pra bater com o que o usuário vê no Excel)
  sku_outlet: string;
  product_name: string;
  gtin_ean: string;
  source_url: string;
}

const HEADER_ALIASES: Record<string, keyof ParsedCatalogImageRow | "status_hint"> = {
  "sku outlet": "sku_outlet",
  "codigo sku outlet": "sku_outlet",
  "sku": "sku_outlet",
  "nome do produto": "product_name",
  "nome produto": "product_name",
  "nome": "product_name",
  "produto": "product_name",
  "gtin ean": "gtin_ean",
  "gtin": "gtin_ean",
  "ean": "gtin_ean",
  "url da imagem": "source_url",
  "url imagem": "source_url",
  "url": "source_url",
  "link da imagem": "source_url",
  "link imagem": "source_url",
  "status da imagem": "status_hint",
  "status": "status_hint",
};

interface HeaderMap {
  rowIndex: number;
  columns: Partial<Record<keyof ParsedCatalogImageRow, number>>;
}

export function findHeaderRow(rawRows: unknown[][]): HeaderMap | null {
  let best: HeaderMap | null = null;
  let bestScore = 0;

  rawRows.forEach((row, rowIndex) => {
    const columns: Partial<Record<keyof ParsedCatalogImageRow, number>> = {};
    row.forEach((cell, colIndex) => {
      const key = normalize(String(cell ?? ""));
      const field = HEADER_ALIASES[key];
      if (field && field !== "status_hint" && columns[field] === undefined) {
        columns[field] = colIndex;
      }
    });
    const score = Object.keys(columns).length;
    if (columns.sku_outlet !== undefined && columns.product_name !== undefined && score > bestScore) {
      best = { rowIndex, columns };
      bestScore = score;
    }
  });

  return best;
}

export function parseCatalogVisualSheet(rawRows: unknown[][]): ParsedCatalogImageRow[] {
  const header = findHeaderRow(rawRows);
  if (!header) {
    throw new Error('Não encontrei as colunas esperadas ("SKU Outlet" e "Nome do produto") na planilha.');
  }

  const dataRows = rawRows.slice(header.rowIndex + 1);
  const cell = (row: unknown[], col: number | undefined): string => {
    if (col === undefined) return "";
    const v = row[col];
    return v === null || v === undefined ? "" : String(v).trim();
  };

  return dataRows
    .map((row, idx) => ({
      row_number: header.rowIndex + 2 + idx, // +1 pra virar 1-based, +1 pra pular a própria linha de cabeçalho
      sku_outlet: cell(row, header.columns.sku_outlet),
      product_name: cell(row, header.columns.product_name),
      gtin_ean: cell(row, header.columns.gtin_ean),
      source_url: cell(row, header.columns.source_url),
    }))
    .filter((r) => r.sku_outlet || r.product_name);
}

function isValidHttpUrl(value: string): boolean {
  if (!value) return true; // vazio é válido (produto sem imagem)
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface ImportPreview {
  total: number;
  valid: ParsedCatalogImageRow[];
  withoutImage: ParsedCatalogImageRow[];
  duplicateSkus: { sku_outlet: string; rows: number[] }[];
  invalidUrls: ParsedCatalogImageRow[];
  existingProducts: ParsedCatalogImageRow[];
  newProducts: ParsedCatalogImageRow[];
  rejected: { row: ParsedCatalogImageRow; reason: string }[];
}

export async function buildImportPreview(rows: ParsedCatalogImageRow[]): Promise<ImportPreview> {
  const supabase = getSupabase();

  const rejected: { row: ParsedCatalogImageRow; reason: string }[] = [];
  const candidates: ParsedCatalogImageRow[] = [];
  for (const row of rows) {
    if (!row.sku_outlet) {
      rejected.push({ row, reason: "SKU Outlet ausente." });
      continue;
    }
    if (!row.product_name) {
      rejected.push({ row, reason: "Nome do produto ausente." });
      continue;
    }
    candidates.push(row);
  }

  const skuCounts = new Map<string, number[]>();
  for (const row of candidates) {
    const list = skuCounts.get(row.sku_outlet) || [];
    list.push(row.row_number);
    skuCounts.set(row.sku_outlet, list);
  }
  const duplicateSkus = [...skuCounts.entries()].filter(([, rowsN]) => rowsN.length > 1).map(([sku_outlet, rowsN]) => ({ sku_outlet, rows: rowsN }));

  const invalidUrls = candidates.filter((r) => r.source_url && !isValidHttpUrl(r.source_url));
  const withoutImage = candidates.filter((r) => !r.source_url);

  const uniqueSkus = [...new Set(candidates.map((r) => r.sku_outlet))];
  const existingSkuSet = new Set<string>();
  for (let i = 0; i < uniqueSkus.length; i += 500) {
    const batch = uniqueSkus.slice(i, i + 500);
    const { data, error } = await supabase.from("product_variants").select("sku_code").in("sku_code", batch);
    if (error) throw error;
    for (const row of (data as { sku_code: string }[]) || []) existingSkuSet.add(row.sku_code);
  }

  const existingProducts = candidates.filter((r) => existingSkuSet.has(r.sku_outlet));
  const newProducts = candidates.filter((r) => !existingSkuSet.has(r.sku_outlet));

  return {
    total: rows.length,
    valid: candidates.filter((r) => isValidHttpUrl(r.source_url)),
    withoutImage,
    duplicateSkus,
    invalidUrls,
    existingProducts,
    newProducts,
    rejected,
  };
}

export interface CatalogImageImportOutcome {
  importId: string;
  totalRows: number;
  createdItems: number;
  rejectedRows: number;
}

/**
 * Cria a importação + upsert dos produtos (SKU Outlet) + os itens de
 * importação (um por linha válida, já com product_variant_id preenchido).
 * NÃO baixa nenhuma imagem aqui — isso é feito em lotes pelo backend
 * (ver src/client/ui/screens/catalogVisual/*), chamando /api/catalog-images/process-batch.
 */
export async function createCatalogImageImport(fileName: string, rows: ParsedCatalogImageRow[]): Promise<CatalogImageImportOutcome> {
  const { profile } = getAuthState();
  if (!isManagerOrAdmin(profile)) {
    throw new Error("Apenas manager ou admin podem importar o Catálogo Visual.");
  }
  const supabase = getSupabase();

  const preview = await buildImportPreview(rows);
  const usable = [...preview.valid]; // válidos = sku+nome ok e URL bem formada (ou vazia)

  const { data: importRow, error: importError } = await supabase
    .from("catalog_image_imports")
    .insert({ filename: fileName, status: "processing", total_rows: rows.length, created_by: profile!.id })
    .select("id")
    .single();
  if (importError) throw importError;
  const importId = importRow.id as string;

  try {
    const upsertRows = usable.map((r) => {
      let base = r.product_name;
      let cor = "";
      if (base.includes(" - ")) {
        const lastDash = base.lastIndexOf(" - ");
        cor = base.slice(lastDash + 3).trim();
        base = base.slice(0, lastDash).trim();
      }
      return { sku_code: r.sku_outlet, base, cor, gtin: r.gtin_ean, model_code: deriveModelCode(r.sku_outlet) };
    });

    const { variantIdBySku } = await upsertProductsAndVariants(upsertRows);

    const itemRows = usable.map((r) => ({
      import_id: importId,
      row_number: r.row_number,
      sku_outlet: r.sku_outlet,
      product_name: r.product_name,
      gtin_ean: r.gtin_ean || null,
      source_url: r.source_url || null,
      product_variant_id: variantIdBySku.get(r.sku_outlet) || null,
      status: "pending" as const,
    }));

    for (let i = 0; i < itemRows.length; i += 500) {
      const { error } = await supabase.from("catalog_image_import_items").insert(itemRows.slice(i, i + 500));
      if (error) throw error;
    }

    const rejectedTotal = preview.rejected.length + preview.invalidUrls.length;
    await supabase
      .from("catalog_image_imports")
      .update({ total_rows: rows.length, error_rows: rejectedTotal })
      .eq("id", importId);

    return { importId, totalRows: rows.length, createdItems: itemRows.length, rejectedRows: rejectedTotal };
  } catch (err) {
    await supabase.from("catalog_image_imports").update({ status: "failed", completed_at: new Date().toISOString() }).eq("id", importId);
    throw err;
  }
}
