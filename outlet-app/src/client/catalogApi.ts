import { getSupabase } from "./supabaseClient.ts";

export interface CatalogRow {
  variant_id: string;
  product_id: string;
  produto: string;
  base: string;
  cor: string | null;
  sku_code: string;
  gtin: string | null;
  category: string | null;
  visual_family_key: string | null;
  capacity_ml: number | null;
  /** storage_path da foto principal do catálogo (product-images) — null quando o produto ainda não tem imagem. */
  thumbnail_path: string | null;
}

export interface CatalogPage {
  rows: CatalogRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface ProductJoin {
  name: string;
  category: string | null;
  visual_family_key: string | null;
  capacity_ml: number | null;
}

interface VariantJoinRow {
  id: string;
  product_id: string;
  sku_code: string;
  color: string | null;
  gtin: string | null;
  products: ProductJoin | ProductJoin[] | null;
}

function productJoin(row: VariantJoinRow): ProductJoin {
  const p = row.products;
  const empty: ProductJoin = { name: "", category: null, visual_family_key: null, capacity_ml: null };
  if (!p) return empty;
  return Array.isArray(p) ? p[0] ?? empty : p;
}

/**
 * Busca paginada no catálogo (substitui o antigo "carrega os primeiros 500 e pronto").
 * Sempre passa por range()/count no servidor — nunca traz a tabela inteira para o cliente.
 * Aceita SKU, nome, categoria, família visual ou capacidade (em ml) como termo de busca —
 * usado tanto pela tela de importação quanto pela correção manual do Modo Scan
 * ("Nenhuma dessas opções"), onde o operador pode não lembrar o nome exato do produto.
 */
export async function searchCatalog(query: string, page = 0, pageSize = 50): Promise<CatalogPage> {
  const supabase = getSupabase();
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let builder = supabase
    .from("product_variants")
    .select("id, product_id, sku_code, color, gtin, products(name, category, visual_family_key, capacity_ml)", { count: "exact" })
    .eq("active", true)
    .order("sku_code", { ascending: true })
    .range(from, to);

  const q = query.trim();
  if (q) {
    // Busca por SKU direto na variante, ou por nome/categoria/família/capacidade
    // do produto (via join não é filtrável com or() do PostgREST diretamente;
    // então buscamos os product_id que batem em cada campo e unimos os ids).
    // Caracteres especiais da sintaxe de filtro do PostgREST (, ( ) %) são
    // removidos de "q" antes de compor o .or() — nunca interpolamos texto do
    // usuário sem neutralizar esses separadores.
    const safeQ = q.replace(/[,()%]/g, "");
    const lowerQ = safeQ.toLowerCase();
    const digitsOnly = safeQ.match(/\d+/)?.[0];

    const [byName, byCategory, byFamily, byCapacity] = await Promise.all([
      supabase.from("products").select("id").ilike("normalized_name", `%${lowerQ}%`).limit(200),
      supabase.from("products").select("id").ilike("category", `%${lowerQ}%`).limit(200),
      supabase.from("products").select("id").ilike("visual_family_key", `%${lowerQ}%`).limit(200),
      digitsOnly ? supabase.from("products").select("id").eq("capacity_ml", Number(digitsOnly)).limit(200) : Promise.resolve({ data: [] as { id: string }[] }),
    ]);
    const productIds = Array.from(
      new Set(
        [byName.data, byCategory.data, byFamily.data, byCapacity.data]
          .filter((d): d is { id: string }[] => !!d)
          .flatMap((d) => d.map((p) => p.id))
      )
    );
    if (productIds.length > 0) {
      builder = builder.or(`sku_code.ilike.%${safeQ}%,product_id.in.(${productIds.join(",")})`);
    } else {
      builder = builder.ilike("sku_code", `%${safeQ}%`);
    }
  }

  const { data, error, count } = await builder;
  if (error) throw error;

  const variantRows = (data as unknown as VariantJoinRow[]) || [];
  const thumbnails = await fetchPrimaryThumbnails(
    supabase,
    variantRows.map((r) => r.id)
  );

  const rows: CatalogRow[] = variantRows.map((r) => {
    const product = productJoin(r);
    return {
      variant_id: r.id,
      product_id: r.product_id,
      produto: product.name,
      base: product.name,
      cor: r.color,
      sku_code: r.sku_code,
      gtin: r.gtin,
      category: product.category,
      visual_family_key: product.visual_family_key,
      capacity_ml: product.capacity_ml,
      thumbnail_path: thumbnails.get(r.id) ?? null,
    };
  });

  return { rows, total: count ?? rows.length, page, pageSize };
}

/** Foto principal (is_primary) por variante — usada nos resultados de busca (ex.: correção manual do scan). */
async function fetchPrimaryThumbnails(supabase: ReturnType<typeof getSupabase>, variantIds: string[]): Promise<Map<string, string>> {
  if (variantIds.length === 0) return new Map();
  const { data } = await supabase
    .from("product_images")
    .select("product_variant_id, storage_path")
    .in("product_variant_id", variantIds)
    .eq("is_primary", true)
    .eq("is_active", true)
    .not("storage_path", "is", null);
  const map = new Map<string, string>();
  for (const row of (data || []) as { product_variant_id: string; storage_path: string | null }[]) {
    if (row.storage_path) map.set(row.product_variant_id, row.storage_path);
  }
  return map;
}

/** Combobox de SKU com busca — nunca renderiza milhares de <option>. Usado na revisão manual. */
export async function searchSkuForPicker(query: string, limit = 20): Promise<CatalogRow[]> {
  const page = await searchCatalog(query, 0, limit);
  return page.rows;
}
