// Modo Scan — camada de dados para a Parte 2 (classificação visual e
// revisão administrativa). Reaproveita products/product_variants (colunas
// novas da migration 0010) — nenhuma tabela de produto paralela.
import { getSupabase } from "./supabaseClient.ts";

export interface VisualClassificationRow {
  product_id: string;
  product_name: string;
  model_code: string | null;
  category: string | null;
  visual_family_key: string | null;
  capacity_ml: number | null;
  recognition_group: string | null;
  active: boolean;
  variants: {
    variant_id: string;
    sku_code: string;
    color: string | null;
    variant_key: string | null;
    active: boolean;
    recognition_enabled_count: number;
  }[];
}

/**
 * Lista produtos + variantes para a tela de revisão de família/variante/
 * capacidade. `onlyUnclassified` mostra só o que ainda não foi classificado
 * (visual_family_key nulo) — útil para completar aos poucos sem re-revisar
 * tudo. Paginado (nunca carrega o catálogo inteiro de uma vez).
 */
export async function listVisualClassification(
  opts: { onlyUnclassified?: boolean; query?: string; page?: number; pageSize?: number } = {}
): Promise<{ rows: VisualClassificationRow[]; total: number }> {
  const supabase = getSupabase();
  const page = opts.page ?? 0;
  const pageSize = opts.pageSize ?? 30;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let builder = supabase
    .from("products")
    .select("id, name, model_code, category, visual_family_key, capacity_ml, recognition_group, active, product_variants(id, sku_code, color, variant_key, active, product_images(recognition_enabled, is_active))", {
      count: "exact",
    })
    .order("model_code", { ascending: true })
    .range(from, to);

  if (opts.onlyUnclassified) builder = builder.is("visual_family_key", null);
  if (opts.query?.trim()) {
    const q = opts.query.trim().replace(/[,()%]/g, "");
    builder = builder.or(`name.ilike.%${q}%,model_code.ilike.%${q}%`);
  }

  const { data, error, count } = await builder;
  if (error) throw error;

  const rows: VisualClassificationRow[] = ((data as unknown as any[]) || []).map((p) => ({
    product_id: p.id,
    product_name: p.name,
    model_code: p.model_code,
    category: p.category,
    visual_family_key: p.visual_family_key,
    capacity_ml: p.capacity_ml,
    recognition_group: p.recognition_group,
    active: p.active,
    variants: (p.product_variants || []).map((v: any) => ({
      variant_id: v.id,
      sku_code: v.sku_code,
      color: v.color,
      variant_key: v.variant_key,
      active: v.active,
      recognition_enabled_count: (v.product_images || []).filter((img: any) => img.recognition_enabled && img.is_active).length,
    })),
  }));

  return { rows, total: count ?? rows.length };
}

export async function updateProductClassification(
  productId: string,
  patch: { category?: string | null; visual_family_key?: string | null; capacity_ml?: number | null; recognition_group?: string | null }
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("products").update(patch).eq("id", productId);
  if (error) throw error;
}

export async function updateVariantKey(variantId: string, variantKey: string | null): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("product_variants").update({ variant_key: variantKey }).eq("id", variantId);
  if (error) throw error;
}

export interface ReadyEmbeddingRow {
  product_image_id: string;
  storage_path: string | null;
  sku_code: string;
  product_name: string;
}

/** Imagens com embedding "ready" — usadas para popular o seletor do teste interno (Parte 2). */
export async function listReadyEmbeddingImages(limit = 50): Promise<ReadyEmbeddingRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("image_embeddings")
    .select("product_image_id, product_images!inner(storage_path, product_variants!inner(sku_code, products!inner(name)))")
    .eq("status", "ready")
    .limit(limit);
  if (error) throw error;

  return ((data as unknown as any[]) || []).map((row) => ({
    product_image_id: row.product_image_id,
    storage_path: row.product_images?.storage_path ?? null,
    sku_code: row.product_images?.product_variants?.sku_code ?? "",
    product_name: row.product_images?.product_variants?.products?.name ?? "",
  }));
}

export async function getSignedImageUrl(storagePath: string, expiresInSeconds = 600): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from("product-images").createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}
