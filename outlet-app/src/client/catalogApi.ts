import { getSupabase } from "./supabaseClient.ts";

export interface CatalogRow {
  variant_id: string;
  product_id: string;
  produto: string;
  base: string;
  cor: string | null;
  sku_code: string;
  gtin: string | null;
}

export interface CatalogPage {
  rows: CatalogRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface VariantJoinRow {
  id: string;
  product_id: string;
  sku_code: string;
  color: string | null;
  gtin: string | null;
  products: { name: string } | { name: string }[] | null;
}

function productName(row: VariantJoinRow): string {
  const p = row.products;
  if (!p) return "";
  return Array.isArray(p) ? p[0]?.name ?? "" : p.name;
}

/**
 * Busca paginada no catálogo (substitui o antigo "carrega os primeiros 500 e pronto").
 * Sempre passa por range()/count no servidor — nunca traz a tabela inteira para o cliente.
 */
export async function searchCatalog(query: string, page = 0, pageSize = 50): Promise<CatalogPage> {
  const supabase = getSupabase();
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let builder = supabase
    .from("product_variants")
    .select("id, product_id, sku_code, color, gtin, products(name)", { count: "exact" })
    .eq("active", true)
    .order("sku_code", { ascending: true })
    .range(from, to);

  const q = query.trim();
  if (q) {
    // Busca por SKU direto na variante, ou por nome do produto (via join não é
    // filtrável com or() do PostgREST diretamente; então buscamos por sku_code
    // OU delegamos o filtro de nome a uma segunda consulta e unimos os ids).
    // Caracteres especiais da sintaxe de filtro do PostgREST (, ( ) %) são
    // removidos de "q" antes de compor o .or() — nunca interpolamos texto do
    // usuário sem neutralizar esses separadores.
    const safeQ = q.replace(/[,()%]/g, "");
    const { data: matchingProducts } = await supabase
      .from("products")
      .select("id")
      .ilike("normalized_name", `%${safeQ.toLowerCase()}%`)
      .limit(200);
    const productIds = (matchingProducts || []).map((p: { id: string }) => p.id);
    if (productIds.length > 0) {
      builder = builder.or(`sku_code.ilike.%${safeQ}%,product_id.in.(${productIds.join(",")})`);
    } else {
      builder = builder.ilike("sku_code", `%${safeQ}%`);
    }
  }

  const { data, error, count } = await builder;
  if (error) throw error;

  const rows: CatalogRow[] = ((data as unknown as VariantJoinRow[]) || []).map((r) => ({
    variant_id: r.id,
    product_id: r.product_id,
    produto: productName(r),
    base: productName(r),
    cor: r.color,
    sku_code: r.sku_code,
    gtin: r.gtin,
  }));

  return { rows, total: count ?? rows.length, page, pageSize };
}

/** Combobox de SKU com busca — nunca renderiza milhares de <option>. Usado na revisão manual. */
export async function searchSkuForPicker(query: string, limit = 20): Promise<CatalogRow[]> {
  const page = await searchCatalog(query, 0, limit);
  return page.rows;
}
