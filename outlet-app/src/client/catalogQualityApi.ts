import { getSupabase } from "./supabaseClient.ts";

/**
 * Painel de qualidade do catálogo — SOMENTE LEITURA. Aponta inconsistências
 * que atrapalham a busca/vínculo (SKU sem EAN, EAN repetido entre produtos
 * diferentes, produto Outlet cadastrado como Normal). Nenhuma escrita: quem
 * corrige continua sendo a tela de edição do Catálogo. Usa a mesma leitura
 * (RLS) de product_variants/products que o resto do app; sem RPC nova.
 */
export interface QualityVariant {
  variant_id: string;
  sku_code: string;
  ean: string | null;
  product_id: string;
  product_name: string;
  product_type: "outlet" | "normal";
}

interface QualityVariantRow {
  id: string;
  sku_code: string;
  gtin_normalized: string | null;
  product_id: string;
  products: { name: string; product_type: "outlet" | "normal" } | { name: string; product_type: "outlet" | "normal" }[] | null;
}

const PAGE_SIZE = 1000; // teto de linhas por request do PostgREST

/** Todas as variantes ATIVAS, paginadas em blocos de 1000 com order() estável (mesmo cuidado de fetchAllNormalProducts). */
export async function fetchActiveVariantsForQuality(): Promise<QualityVariant[]> {
  const supabase = getSupabase();
  const out: QualityVariant[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("product_variants")
      .select("id, sku_code, gtin_normalized, product_id, products!inner(name, product_type)")
      .eq("active", true)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data as unknown as QualityVariantRow[]) || [];
    for (const r of rows) {
      const p = Array.isArray(r.products) ? r.products[0] : r.products;
      out.push({ variant_id: r.id, sku_code: r.sku_code, ean: r.gtin_normalized, product_id: r.product_id, product_name: p?.name ?? "", product_type: p?.product_type ?? "outlet" });
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

export interface DuplicateEanGroup {
  ean: string;
  variants: QualityVariant[];
}

export interface CatalogQualityReport {
  total: number;
  withoutEan: QualityVariant[];
  duplicateEans: DuplicateEanGroup[];
  outletAsNormal: QualityVariant[];
}

/** SKUs ativos sem EAN cadastrado. */
export function findWithoutEan(rows: QualityVariant[]): QualityVariant[] {
  return rows.filter((r) => !r.ean).sort((a, b) => a.sku_code.localeCompare(b.sku_code));
}

/**
 * EAN que aparece em produtos DIFERENTES — o caso que causa vínculo errado na
 * bipagem/NF-e. O mesmo EAN repetido em variantes do MESMO produto não entra
 * (não gera ambiguidade entre produtos).
 */
export function findDuplicateEans(rows: QualityVariant[]): DuplicateEanGroup[] {
  const byEan = new Map<string, QualityVariant[]>();
  for (const r of rows) {
    if (!r.ean) continue;
    const list = byEan.get(r.ean);
    if (list) list.push(r);
    else byEan.set(r.ean, [r]);
  }
  const groups: DuplicateEanGroup[] = [];
  for (const [ean, variants] of byEan) {
    if (new Set(variants.map((v) => v.product_id)).size > 1) {
      groups.push({ ean, variants: variants.slice().sort((a, b) => a.sku_code.localeCompare(b.sku_code)) });
    }
  }
  return groups.sort((a, b) => b.variants.length - a.variants.length || a.ean.localeCompare(b.ean));
}

/** Produtos que PARECEM Outlet (SKU com "OUT-" ou nome começando por "Outlet") mas estão como tipo Normal. */
export function findOutletAsNormal(rows: QualityVariant[]): QualityVariant[] {
  return rows
    .filter((r) => r.product_type === "normal" && (/OUT-/i.test(r.sku_code) || /^\s*outlet\b/i.test(r.product_name)))
    .sort((a, b) => a.sku_code.localeCompare(b.sku_code));
}

export function buildCatalogQualityReport(rows: QualityVariant[]): CatalogQualityReport {
  return { total: rows.length, withoutEan: findWithoutEan(rows), duplicateEans: findDuplicateEans(rows), outletAsNormal: findOutletAsNormal(rows) };
}

export async function loadCatalogQualityReport(): Promise<CatalogQualityReport> {
  return buildCatalogQualityReport(await fetchActiveVariantsForQuality());
}
