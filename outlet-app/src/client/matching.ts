// Portado de src/server/server.ts (motor de matching que rodava contra o SQLite).
// Agora roda no cliente, contra o catálogo/aliases lidos do Supabase (RLS permite
// leitura para qualquer usuário autenticado e ativo — ver supabase/migrations).
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

export type MatchStatus = "matched" | "matched_parcial" | "modelo_nao_encontrado" | "sku_nao_cadastrado" | "cor_nao_encontrada";

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

function findProductId(normalized: string, models: ModelAliasRow[]): string | null {
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

async function fetchVariantsForProduct(productId: string): Promise<{ id: string; name: string; variants: VariantRow[] }> {
  const supabase = getSupabase();
  const [{ data: product, error: productError }, { data: variants, error: variantsError }] = await Promise.all([
    supabase.from("products").select("id, name").eq("id", productId).maybeSingle(),
    supabase
      .from("product_variants")
      .select("id, sku_code, color, normalized_color, gtin")
      .eq("product_id", productId)
      .eq("active", true),
  ]);
  if (productError) throw productError;
  if (variantsError) throw variantsError;
  return { id: productId, name: product?.name ?? "", variants: (variants as VariantRow[]) || [] };
}

export async function matchItem(modelo: string, cor: string, qtd = 1): Promise<MatchResult> {
  const { models, colors } = await fetchAliasLists();
  const normModelo = normalize(modelo);
  const normCor = normalize(cor);

  const productId = findProductId(normModelo, models);
  const colorMatched = findColor(normCor, colors) || (cor ? cor.trim() : null);

  const base: Pick<MatchResult, "modelo_bruto" | "cor_bruta" | "qtd"> = {
    modelo_bruto: modelo || "",
    cor_bruta: cor || "",
    qtd,
  };

  if (!productId) {
    return {
      ...base,
      product_id: null,
      product_name: null,
      color_matched: colorMatched,
      variant_id: null,
      sku_code: null,
      status: "modelo_nao_encontrado",
    };
  }

  const { name, variants } = await fetchVariantsForProduct(productId);

  if (variants.length === 0) {
    return {
      ...base,
      product_id: productId,
      product_name: name,
      color_matched: colorMatched,
      variant_id: null,
      sku_code: null,
      status: "sku_nao_cadastrado",
    };
  }

  if (colorMatched) {
    const normColorMatched = normalize(colorMatched);
    const exact = variants.find((v) => normalize(v.color) === normColorMatched);
    if (exact) {
      return {
        ...base,
        product_id: productId,
        product_name: name,
        color_matched: exact.color,
        variant_id: exact.id,
        sku_code: exact.sku_code,
        status: "matched",
      };
    }
    const partial = variants.find(
      (v) => normalize(v.color).includes(normColorMatched) || normColorMatched.includes(normalize(v.color))
    );
    if (partial) {
      return {
        ...base,
        product_id: productId,
        product_name: name,
        color_matched: partial.color,
        variant_id: partial.id,
        sku_code: partial.sku_code,
        status: "matched_parcial",
      };
    }
  }

  return {
    ...base,
    product_id: productId,
    product_name: name,
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
