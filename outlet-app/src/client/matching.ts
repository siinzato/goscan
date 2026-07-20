// Portado de src/server/server.ts (motor de matching que rodava contra o SQLite).
// Agora roda no cliente, contra o catálogo/aliases lidos do Supabase (RLS permite
// leitura para qualquer usuário autenticado e ativo — ver supabase/migrations).
//
// IMPORTANTE (bug real encontrado ao testar com o catálogo importado de
// verdade): product_aliases é uma tabela curada manualmente (seed-data.ts /
// aliases-seed.ts) — os produtos trazidos pela importação de planilha
// (Catálogo Visual / importer.ts) NUNCA ganham uma linha em product_aliases.
// Se o matcher só olhasse para aliases, todo produto importado por planilha
// seria sempre "modelo_nao_encontrado", mesmo existindo no catálogo. Por
// isso, quando nenhum alias bate, caímos para uma busca direta em
// products.normalized_name (findProductIdsByNameTokens) antes de desistir.
import { getSupabase } from "./supabaseClient.ts";
import { normalize } from "./utils.ts";

export interface ModelAliasRow {
  normalized_alias: string;
  product_id: string;
}

export interface ColorAliasRow {
  normalized_alias: string;
  canonical_value: string;
}

export interface AliasLists {
  models: ModelAliasRow[];
  colors: ColorAliasRow[];
}

export interface VariantRow {
  id: string;
  sku_code: string;
  color: string | null;
  normalized_color: string | null;
  gtin: string | null;
}

export type MatchStatus =
  | "matched"
  | "matched_parcial"
  | "modelo_nao_encontrado"
  | "sku_nao_cadastrado"
  | "cor_nao_encontrada"
  | "ambiguous";

export interface MatchCandidate {
  variant_id: string;
  sku_code: string;
  color: string | null;
  product_name: string;
}

export interface MatchResult {
  modelo_bruto: string;
  cor_bruta: string;
  qtd: number;
  product_id: string | null;
  product_name: string | null;
  color_matched: string | null;
  variant_id: string | null;
  sku_code: string | null;
  status: MatchStatus;
  /** Preenchido apenas quando status === "ambiguous": até 5 opções para o operador escolher. */
  candidates?: MatchCandidate[];
}

let cache: AliasLists | null = null;

export function invalidateAliasCache(): void {
  cache = null;
}

export async function fetchAliasLists(): Promise<AliasLists> {
  if (cache) return cache;
  const supabase = getSupabase();

  const [modelsRes, colorsRes] = await Promise.all([
    supabase
      .from("product_aliases")
      .select("normalized_alias, product_id")
      .eq("alias_type", "model")
      .eq("active", true)
      .not("product_id", "is", null),
    supabase
      .from("product_aliases")
      .select("normalized_alias, canonical_value")
      .eq("alias_type", "color")
      .eq("active", true),
  ]);

  if (modelsRes.error) throw modelsRes.error;
  if (colorsRes.error) throw colorsRes.error;

  // Aliases mais longos/específicos são checados primeiro (mesma regra do backend original).
  const models = (modelsRes.data as ModelAliasRow[]).sort((a, b) => b.normalized_alias.length - a.normalized_alias.length);
  const colors = (colorsRes.data as ColorAliasRow[]).sort((a, b) => b.normalized_alias.length - a.normalized_alias.length);

  cache = { models, colors };
  return cache;
}

function findProductIdByAlias(normalized: string, models: ModelAliasRow[]): string | null {
  for (const m of models) {
    if (normalized.includes(m.normalized_alias)) return m.product_id;
  }
  return null;
}

function findColor(normalized: string, colors: ColorAliasRow[]): string | null {
  for (const c of colors) {
    if (normalized.includes(c.normalized_alias)) return c.canonical_value;
  }
  return null;
}

interface CandidateProduct {
  id: string;
  name: string;
  normalized_name: string;
}

/**
 * Fallback quando não existe alias curado: procura produtos ativos cujo
 * normalized_name contenha TODOS os tokens do texto digitado (AND, não OR) —
 * evita casar "Copo 880ml" com um "Copo 1180ml" só por "copo" ser comum.
 */
async function findProductIdsByNameTokens(normModelo: string): Promise<CandidateProduct[]> {
  const tokens = normModelo.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const supabase = getSupabase();
  let builder = supabase.from("products").select("id, name, normalized_name").eq("active", true);
  for (const t of tokens) builder = builder.ilike("normalized_name", `%${t}%`);
  const { data, error } = await builder.limit(20);
  if (error) throw error;
  return (data as CandidateProduct[]) || [];
}

async function fetchVariantsForProducts(productIds: string[]): Promise<Map<string, VariantRow[]>> {
  if (productIds.length === 0) return new Map();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("product_variants")
    .select("id, product_id, sku_code, color, normalized_color, gtin")
    .in("product_id", productIds)
    .eq("active", true);
  if (error) throw error;
  const map = new Map<string, VariantRow[]>();
  for (const row of (data as (VariantRow & { product_id: string })[]) || []) {
    const list = map.get(row.product_id) || [];
    list.push(row);
    map.set(row.product_id, list);
  }
  return map;
}

/**
 * Reduz uma palavra normalizada a um "radical" tolerante a variação de
 * gênero/número/forma nominal — cobre os casos do catálogo real: Preto/Preta,
 * Estampa/Estampada/Estampado/Estampas todos caem no mesmo radical.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("s")) w = w.slice(0, -1);
  if (w.length > 5 && (w.endsWith("ada") || w.endsWith("ado"))) w = w.slice(0, -3);
  else if (w.length > 3 && /[ao]$/.test(w)) w = w.slice(0, -1);
  return w;
}

function tokenStems(normalizedText: string): string[] {
  return normalizedText.split(" ").filter(Boolean).map(stem);
}

/** Todo token (radicalizado) da consulta precisa aparecer em algum token do candidato. */
/**
 * Contenção "fuzzy" só é aceita quando ambos os radicais têm pelo menos 3
 * caracteres — sem esse piso, um resto de tokenização como "c" (de "C/Nome")
 * bate por substring dentro de qualquer palavra que contenha a letra "c"
 * (ex.: "c" está contido em "branc", radical de "branco"), gerando falsos
 * positivos. Radicais curtos só contam como iguais na forma exata.
 */
function tokenMatches(candidateToken: string, queryToken: string): boolean {
  if (candidateToken === queryToken) return true;
  if (candidateToken.length < 3 || queryToken.length < 3) return false;
  return candidateToken.includes(queryToken) || queryToken.includes(candidateToken);
}

function allQueryTokensFoundIn(candidateText: string, queryText: string): boolean {
  const queryTokens = tokenStems(queryText);
  if (queryTokens.length === 0) return false;
  const candTokens = tokenStems(candidateText);
  return queryTokens.every((qt) => candTokens.some((ct) => tokenMatches(ct, qt)));
}

interface ResolvedVariant {
  product: CandidateProduct;
  variant: VariantRow;
  /** true quando o próprio campo color da variante bateu (mais confiável que casar só pelo nome do produto). */
  matchedOnColorField: boolean;
}

export async function matchItem(modelo: string, cor: string, qtd = 1): Promise<MatchResult> {
  const { models, colors } = await fetchAliasLists();
  const normModelo = normalize(modelo);
  const normCor = normalize(cor);

  const base: Pick<MatchResult, "modelo_bruto" | "cor_bruta" | "qtd"> = {
    modelo_bruto: modelo || "",
    cor_bruta: cor || "",
    qtd,
  };

  if (!normModelo) {
    return { ...base, product_id: null, product_name: null, color_matched: null, variant_id: null, sku_code: null, status: "modelo_nao_encontrado" };
  }

  const colorMatched = findColor(normCor, colors) || (cor ? cor.trim() : null);

  // 1) Alias curado (mais preciso, quando existe) resolve um único produto direto.
  const aliasedProductId = findProductIdByAlias(normModelo, models);
  let candidateProducts: CandidateProduct[];
  if (aliasedProductId) {
    const supabase = getSupabase();
    const { data: product, error } = await supabase.from("products").select("id, name, normalized_name").eq("id", aliasedProductId).maybeSingle();
    if (error) throw error;
    candidateProducts = product ? [product as CandidateProduct] : [];
  } else {
    // 2) Sem alias: busca direta no catálogo real por todos os tokens do modelo.
    candidateProducts = await findProductIdsByNameTokens(normModelo);
  }

  if (candidateProducts.length === 0) {
    return { ...base, product_id: null, product_name: null, color_matched: colorMatched, variant_id: null, sku_code: null, status: "modelo_nao_encontrado" };
  }

  const variantsByProduct = await fetchVariantsForProducts(candidateProducts.map((p) => p.id));
  const anyVariants = candidateProducts.some((p) => (variantsByProduct.get(p.id) || []).length > 0);
  if (!anyVariants) {
    const only = candidateProducts[0];
    return {
      ...base,
      product_id: only.id,
      product_name: only.name,
      color_matched: colorMatched,
      variant_id: null,
      sku_code: null,
      status: "sku_nao_cadastrado",
    };
  }

  const normColorMatched = colorMatched ? normalize(colorMatched) : "";
  const resolved: ResolvedVariant[] = [];

  for (const product of candidateProducts) {
    const variants = variantsByProduct.get(product.id) || [];
    for (const variant of variants) {
      if (!normCor) {
        // Nenhuma cor informada: só aceita automaticamente se o produto tiver uma única variante (sem ambiguidade).
        if (variants.length === 1) resolved.push({ product, variant, matchedOnColorField: false });
        continue;
      }
      const normVariantColor = normalize(variant.color);
      if (normVariantColor && normVariantColor === normColorMatched) {
        resolved.push({ product, variant, matchedOnColorField: true });
        continue;
      }
      // Cor bate como texto (via campo color, embutida no nome do produto — casos
      // como "Estampadas"/"Flamengo"/"Time Vitoria" — ou só no próprio SKU, como
      // "OUT-GFGCM87-ESTAMPADA" onde nem nome nem color trazem "estampada").
      const descriptor = `${product.normalized_name} ${normVariantColor} ${normalize(variant.sku_code)}`.trim();
      if (allQueryTokensFoundIn(descriptor, normCor)) {
        resolved.push({ product, variant, matchedOnColorField: Boolean(normVariantColor) });
      }
    }
  }

  // Um acerto exato no campo color é sempre mais confiável que um acerto por
  // texto solto no nome do produto/SKU — se existe pelo menos um exato, os
  // fuzzy não competem com ele (evita "Rosa" virar ambíguo com "Rosa e Lilás").
  const exactHits = resolved.filter((r) => r.matchedOnColorField && normColorMatched && normalize(r.variant.color) === normColorMatched);
  const finalResolved = exactHits.length > 0 ? exactHits : resolved;

  const toCandidate = (r: ResolvedVariant): MatchCandidate => ({
    variant_id: r.variant.id,
    sku_code: r.variant.sku_code,
    color: r.variant.color,
    product_name: r.product.name,
  });

  if (finalResolved.length === 1) {
    const r = finalResolved[0];
    const exactColor = normColorMatched && normalize(r.variant.color) === normColorMatched;
    return {
      ...base,
      product_id: r.product.id,
      product_name: r.product.name,
      color_matched: r.variant.color || colorMatched,
      variant_id: r.variant.id,
      sku_code: r.variant.sku_code,
      status: exactColor || !normCor ? "matched" : "matched_parcial",
    };
  }

  if (finalResolved.length > 1) {
    // Nunca escolhe silenciosamente entre várias opções — mostra até 5 para o operador decidir.
    return {
      ...base,
      product_id: null,
      product_name: candidateProducts.length === 1 ? candidateProducts[0].name : null,
      color_matched: colorMatched,
      variant_id: null,
      sku_code: null,
      status: "ambiguous",
      candidates: finalResolved.slice(0, 5).map(toCandidate),
    };
  }

  // Nenhuma variante resolvida: se reconhecemos exatamente um produto, é a cor que não bateu.
  const only = candidateProducts.length === 1 ? candidateProducts[0] : null;
  return {
    ...base,
    product_id: only?.id ?? null,
    product_name: only?.name ?? null,
    color_matched: colorMatched,
    variant_id: null,
    sku_code: null,
    status: "cor_nao_encontrada",
  };
}

export async function matchItems(items: { modelo: string; cor: string; quantidade?: number; qtd?: number }[]): Promise<MatchResult[]> {
  const results: MatchResult[] = [];
  for (const it of items) {
    results.push(await matchItem(it.modelo || "", it.cor || "", Number(it.quantidade || it.qtd || 1)));
  }
  return results;
}
