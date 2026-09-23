import { getSupabase } from "./supabaseClient.ts";
import { normalize, normalizeEan, isValidEanFormat } from "./utils.ts";

export type ProductType = "outlet" | "normal";

export type CatalogMatchType = "exact_ean" | "exact_sku" | "text";

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
  product_type: ProductType;
  /** Só definido quando a busca tinha um termo — por que esta linha apareceu (seção 12/18.6 do pedido de correção de EAN). Null ao navegar sem busca. */
  match_type: CatalogMatchType | null;
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
  product_type: ProductType;
}

interface VariantJoinRow {
  id: string;
  product_id: string;
  sku_code: string;
  color: string | null;
  gtin: string | null;
  gtin_normalized: string | null;
  products: ProductJoin | ProductJoin[] | null;
}

function productJoin(row: VariantJoinRow): ProductJoin {
  const p = row.products;
  const empty: ProductJoin = { name: "", category: null, visual_family_key: null, capacity_ml: null, product_type: "outlet" };
  if (!p) return empty;
  return Array.isArray(p) ? p[0] ?? empty : p;
}

// ---------------------------------------------------------------------------
// CORREÇÃO — Reconhecimento automático e busca por EAN (ver diagnóstico):
// cache de sessão (nunca persistido — some ao recarregar a página) pras
// buscas do catálogo, evitando reconsultar o banco pro MESMO termo repetido
// na mesma conferência. SEMPRE invalidado (limpo) quando o catálogo muda —
// import em massa (importer.ts) ou CRUD manual (catalogManageApi.ts) — nunca
// serve um resultado que já ficou desatualizado.
// ---------------------------------------------------------------------------
const searchCache = new Map<string, CatalogPage>();
const SEARCH_CACHE_MAX = 200;

export function invalidateSearchCache(): void {
  searchCache.clear();
  pickerRpcCache.clear();
}

function cacheKey(query: string, page: number, pageSize: number, productType?: ProductType, includeThumbnails = true): string {
  return `${productType ?? "*"}::${page}::${pageSize}::${includeThumbnails ? "thumb" : "nothumb"}::${query.trim().toLowerCase()}`;
}

/**
 * Busca paginada no catálogo (substitui o antigo "carrega os primeiros 500 e pronto").
 * Sempre passa por range()/count no servidor — nunca traz a tabela inteira para o cliente.
 * Aceita SKU, nome, categoria, família visual, capacidade (em ml) OU EAN como termo de
 * busca — usado tanto pela tela de importação/gestão quanto pela correção manual do Modo
 * Scan e pelo vínculo manual da Conferência por NF ("Resolver pendências").
 *
 * CORREÇÃO — causa raiz de "buscar por EAN nunca encontra o produto": esta função nunca
 * filtrava por `gtin`, só o selecionava pra exibição. Agora, quando o termo digitado
 * "parece" um EAN (só dígitos, 6+ caracteres), soma ao filtro um match EXATO por
 * gtin_normalized (usa índice, igualdade após normalização — nunca substring) e, se o
 * código ainda não fechou um comprimento válido, também um prefixo. `signal` permite
 * cancelar uma busca anterior ainda em voo quando o operador continua digitando — nunca
 * deixa uma resposta antiga sobrescrever uma mais recente.
 */
export async function searchCatalog(
  query: string,
  page = 0,
  pageSize = 50,
  productType?: ProductType,
  signal?: AbortSignal,
  // PERFORMANCE — vários pickers de SKU (busca de vínculo manual na
  // conferência/NF-e/devolução) renderizam só texto (produto/cor/SKU), nunca
  // a miniatura — mas pagavam a mesma 3ª ida-e-volta de rede (product_images)
  // do catálogo visual, que É quem precisa da miniatura. false pula essa
  // consulta inteira pra quem não vai exibir a imagem mesmo.
  includeThumbnails = true
): Promise<CatalogPage> {
  const key = cacheKey(query, page, pageSize, productType, includeThumbnails);
  const cached = searchCache.get(key);
  if (cached) return cached;

  const supabase = getSupabase();
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const q = query.trim();
  const safeQ = q.replace(/[,()%]/g, "");
  const normalizedEanQuery = normalizeEan(safeQ);
  const looksLikeFullEan = isValidEanFormat(normalizedEanQuery);
  // 6+ dígitos mas ainda sem fechar um comprimento válido: início plausível
  // de um EAN sendo digitado/colado aos poucos — busca por PREFIXO (usa
  // índice via ilike sem wildcard à esquerda, nunca substring solta).
  const eanPrefix = !looksLikeFullEan && normalizedEanQuery.length >= 6 ? normalizedEanQuery : null;
  const upperSafeQ = safeQ.toUpperCase();

  let builder = supabase
    .from("product_variants")
    .select("id, product_id, sku_code, color, gtin, gtin_normalized, products!inner(name, category, visual_family_key, capacity_ml, product_type)", { count: "exact" })
    .eq("active", true)
    .order("sku_code", { ascending: true })
    .range(from, to);

  if (productType) {
    builder = builder.eq("products.product_type", productType);
  }
  if (signal) {
    builder = builder.abortSignal(signal);
  }

  if (q) {
    // Busca por SKU direto na variante, ou por nome/categoria/família/capacidade
    // do produto (via join não é filtrável com or() do PostgREST diretamente;
    // então buscamos os product_id que batem em cada campo e unimos os ids).
    // Caracteres especiais da sintaxe de filtro do PostgREST (, ( ) %) já
    // foram removidos em safeQ — nunca interpolamos texto do usuário sem
    // neutralizar esses separadores.
    const lowerQ = normalize(safeQ);
    const digitsOnly = safeQ.match(/\d+/)?.[0];

    // Busca por nome é por PALAVRA-CHAVE, não frase exata: cada palavra
    // digitada precisa aparecer em algum lugar do nome (em qualquer ordem) —
    // "termica bolsa" e "bolsa termica" encontram o mesmo produto. Cada
    // .ilike() encadeado no mesmo builder vira AND no PostgREST.
    const nameWords = lowerQ.split(" ").filter(Boolean);
    let byNameBuilder = supabase.from("products").select("id").limit(200);
    for (const word of nameWords) byNameBuilder = byNameBuilder.ilike("normalized_name", `%${word}%`);
    let byCategoryBuilder = supabase.from("products").select("id").ilike("category", `%${lowerQ}%`).limit(200);
    let byFamilyBuilder = supabase.from("products").select("id").ilike("visual_family_key", `%${lowerQ}%`).limit(200);
    let byCapacityBuilder = digitsOnly ? supabase.from("products").select("id").eq("capacity_ml", Number(digitsOnly)).limit(200) : null;
    if (signal) {
      byNameBuilder = byNameBuilder.abortSignal(signal);
      byCategoryBuilder = byCategoryBuilder.abortSignal(signal);
      byFamilyBuilder = byFamilyBuilder.abortSignal(signal);
      byCapacityBuilder = byCapacityBuilder?.abortSignal(signal) ?? null;
    }

    const [byName, byCategory, byFamily, byCapacity] = await Promise.all([
      nameWords.length > 0 ? byNameBuilder : Promise.resolve({ data: [] as { id: string }[] }),
      byCategoryBuilder,
      byFamilyBuilder,
      byCapacityBuilder ?? Promise.resolve({ data: [] as { id: string }[] }),
    ]);
    const productIds = Array.from(
      new Set(
        [byName.data, byCategory.data, byFamily.data, byCapacity.data]
          .filter((d): d is { id: string }[] => !!d)
          .flatMap((d) => d.map((p) => p.id))
      )
    );

    const orParts: string[] = [`sku_code.ilike.%${safeQ}%`];
    if (productIds.length > 0) orParts.push(`product_id.in.(${productIds.join(",")})`);
    if (looksLikeFullEan) orParts.push(`gtin_normalized.eq.${normalizedEanQuery}`);
    else if (eanPrefix) orParts.push(`gtin_normalized.ilike.${eanPrefix}%`);
    builder = builder.or(orParts.join(","));
  }

  const { data, error, count } = await builder;
  if (error) throw error;

  const variantRows = (data as unknown as VariantJoinRow[]) || [];
  const thumbnails = includeThumbnails ? await fetchPrimaryThumbnails(supabase, variantRows.map((r) => r.id), signal) : new Map<string, string>();

  let rows: CatalogRow[] = variantRows.map((r) => {
    const product = productJoin(r);
    let matchType: CatalogMatchType | null = null;
    if (q) {
      if (looksLikeFullEan && r.gtin_normalized === normalizedEanQuery) matchType = "exact_ean";
      else if (r.sku_code.toUpperCase() === upperSafeQ) matchType = "exact_sku";
      else matchType = "text";
    }
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
      product_type: product.product_type,
      match_type: matchType,
    };
  });

  // Prioriza match exato (EAN primeiro, depois SKU) no topo — sort ESTÁVEL
  // preserva a ordem original (sku_code) entre linhas do mesmo tipo de match,
  // então nunca embaralha o resto da lista à toa.
  if (q) {
    const rank = (m: CatalogMatchType | null) => (m === "exact_ean" ? 0 : m === "exact_sku" ? 1 : 2);
    rows = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r.match_type) - rank(b.r.match_type) || a.i - b.i)
      .map((x) => x.r);
  }

  const result: CatalogPage = { rows, total: count ?? rows.length, page, pageSize };
  // CORREÇÃO — mesmo motivo do pickerRpcCache logo abaixo: nunca cacheia
  // página vazia, pra nunca esconder um produto recém-criado em outra
  // aba/tela por trás de um "não encontrado" que nunca expira sozinho.
  if (rows.length > 0) {
    searchCache.set(key, result);
    if (searchCache.size > SEARCH_CACHE_MAX) searchCache.clear();
  }
  return result;
}

/** Foto principal (is_primary) por variante — usada nos resultados de busca (ex.: correção manual do scan). */
async function fetchPrimaryThumbnails(supabase: ReturnType<typeof getSupabase>, variantIds: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  if (variantIds.length === 0) return new Map();
  let builder = supabase
    .from("product_images")
    .select("product_variant_id, storage_path")
    .in("product_variant_id", variantIds)
    .eq("is_primary", true)
    .eq("is_active", true)
    .not("storage_path", "is", null);
  if (signal) builder = builder.abortSignal(signal);
  const { data } = await builder;
  const map = new Map<string, string>();
  for (const row of (data || []) as { product_variant_id: string; storage_path: string | null }[]) {
    if (row.storage_path) map.set(row.product_variant_id, row.storage_path);
  }
  return map;
}

// ---------------------------------------------------------------------------
// PERFORMANCE — RPC do picker de SKU (ver migration
// 0054_search_sku_picker_rpc.sql): colapsa as 2 idas-e-voltas de
// searchCatalog (achar product_id por nome/categoria/família/capacidade,
// SÓ DEPOIS buscar as variantes) numa única .rpc(), para quem não precisa
// de miniatura/paginação/count — só os pickers de vínculo manual
// (conferência Outlet, NF-e, devolução, treino visual). Reaproveita
// EXATAMENTE os mesmos valores já normalizados que searchCatalog calcula
// (normalize()/normalizeEan()/isValidEanFormat() — nenhuma segunda regra de
// normalização). searchCatalog continua intocada para catálogo/paginação/
// contagem/miniatura.
// ---------------------------------------------------------------------------
interface SearchSkuPickerRpcRow {
  variant_id: string;
  product_id: string;
  sku_code: string;
  color: string | null;
  gtin: string | null;
  gtin_normalized: string | null;
  produto: string;
  category: string | null;
  visual_family_key: string | null;
  capacity_ml: number | null;
  product_type: ProductType;
  match_type: CatalogMatchType;
}

const pickerRpcCache = new Map<string, CatalogRow[]>();
const PICKER_RPC_CACHE_MAX = 200;

function pickerRpcCacheKey(query: string, limit: number, productType?: ProductType): string {
  return `${productType ?? "*"}::${limit}::${query.trim().toLowerCase()}`;
}

async function searchSkuForPickerRpc(query: string, limit: number, productType: ProductType | undefined, signal: AbortSignal | undefined): Promise<CatalogRow[]> {
  const key = pickerRpcCacheKey(query, limit, productType);
  const cached = pickerRpcCache.get(key);
  if (cached) return cached;

  const supabase = getSupabase();
  const q = query.trim();
  const safeQ = q.replace(/[,()%]/g, "");
  const normalizedEanQuery = normalizeEan(safeQ);
  const looksLikeFullEan = isValidEanFormat(normalizedEanQuery);
  const eanPrefix = !looksLikeFullEan && normalizedEanQuery.length >= 6 ? normalizedEanQuery : null;
  const upperSafeQ = safeQ.toUpperCase();
  const lowerQ = normalize(safeQ);
  const digitsOnly = safeQ.match(/\d+/)?.[0];
  const nameWords = lowerQ.split(" ").filter(Boolean);
  // CORREÇÃO — um EAN completo (13+ dígitos) também "parece" um grupo
  // numérico de capacidade pro regex acima; sem este limite, o valor
  // estourava o range de integer do Postgres (p_capacity_ml integer) e
  // derrubava a chamada RPC inteira antes de sequer tentar o match por
  // gtin_normalized. Fora do range válido de integer, capacidade
  // simplesmente não é um critério aplicável — vai null, a busca por
  // SKU/EAN/texto continua normalmente pelos outros critérios.
  const PG_INTEGER_MAX = 2147483647;
  const capacityCandidate = digitsOnly ? Number(digitsOnly) : null;
  const capacityMl = capacityCandidate !== null && Number.isSafeInteger(capacityCandidate) && capacityCandidate <= PG_INTEGER_MAX ? capacityCandidate : null;

  let builder = supabase.rpc("search_sku_picker", {
    p_name_words: nameWords,
    p_category_ilike: `%${lowerQ}%`,
    p_family_ilike: `%${lowerQ}%`,
    p_capacity_ml: capacityMl,
    p_sku_ilike: `%${safeQ}%`,
    p_gtin_exact: looksLikeFullEan ? normalizedEanQuery : null,
    p_gtin_prefix_ilike: eanPrefix ? `${eanPrefix}%` : null,
    p_product_type: productType ?? null,
    p_upper_sku: upperSafeQ,
    p_limit: limit,
  });
  if (signal) builder = builder.abortSignal(signal);

  const { data, error } = await builder;
  if (error) throw error;

  const rows: CatalogRow[] = ((data as unknown as SearchSkuPickerRpcRow[]) || []).map((r) => ({
    variant_id: r.variant_id,
    product_id: r.product_id,
    produto: r.produto,
    base: r.produto,
    cor: r.color,
    sku_code: r.sku_code,
    gtin: r.gtin,
    category: r.category,
    visual_family_key: r.visual_family_key,
    capacity_ml: r.capacity_ml,
    thumbnail_path: null,
    product_type: r.product_type,
    match_type: r.match_type,
  }));

  // CORREÇÃO — nunca cacheia um resultado VAZIO: é exatamente o cenário em
  // que o operador está prestes a cadastrar o produto que faltava (ex.:
  // "Resolver pendências" da NF-e) e precisa que a PRÓXIMA busca pelo mesmo
  // termo veja o produto novo — mesmo que invalidateSearchCache() não tenha
  // rodado nesta aba (ex.: produto criado em outra aba/tela). Um resultado
  // com itens continua cacheado normalmente (custo de staleness ali é baixo:
  // edição/exclusão desses mesmos itens já invalida via invalidateSearchCache()).
  if (rows.length > 0) {
    pickerRpcCache.set(key, rows);
    if (pickerRpcCache.size > PICKER_RPC_CACHE_MAX) pickerRpcCache.clear();
  }
  return rows;
}

/**
 * Combobox de SKU/EAN com busca — nunca renderiza milhares de <option>. Usado
 * na revisão manual (Resolver pendências) e no Modo Scan.
 * `includeThumbnails` default true (Modo Scan exibe miniatura); os pickers
 * só-texto (conferência Outlet, edição de vínculo na NF-e, devolução) passam
 * false — ver comentário de performance em searchCatalog.
 *
 * PERFORMANCE — quando includeThumbnails é false, tenta primeiro a RPC de
 * busca em ida única (ver bloco acima). Se ela falhar por qualquer motivo
 * que não seja o próprio cancelamento do operador (função ainda não
 * migrada pro banco dessa instalação, erro pontual etc.), cai pro caminho
 * antigo (searchCatalog) sem quebrar o picker nem mostrar erro técnico —
 * nunca deixa o GoScan parar de funcionar por causa desta otimização.
 */
export async function searchSkuForPicker(
  query: string,
  limit = 20,
  productType?: ProductType,
  signal?: AbortSignal,
  includeThumbnails = true
): Promise<CatalogRow[]> {
  if (!includeThumbnails && query.trim()) {
    try {
      return await searchSkuForPickerRpc(query, limit, productType, signal);
    } catch (err) {
      if (signal?.aborted) throw err; // cancelamento do operador — nunca é "falha da RPC", deixa o chamador tratar como sempre tratou
      if (import.meta.env.DEV) {
        console.warn("[GoScan] search_sku_picker RPC indisponível, usando busca antiga:", err);
      }
      // cai pro caminho antigo — nunca quebra o picker por causa desta otimização.
    }
  }
  const page = await searchCatalog(query, 0, limit, productType, signal, includeThumbnails);
  return page.rows;
}
