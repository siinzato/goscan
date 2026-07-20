// Catálogo Visual — camada de dados. Cada "produto" aqui é uma linha de
// product_variants (= SKU Outlet, a mesma tabela já usada pelo catálogo de
// SKUs da Fase 1 — não duplicamos "produto" numa tabela nova).
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";
import { normalize } from "./utils.ts";

export type ImageType = "catalogo" | "frontal" | "lateral" | "traseira" | "detalhe" | "embalagem";
export type QualityStatus = "pendente" | "aprovada" | "rejeitada";
export type ProcessingStatus = "pendente" | "processando" | "pronta" | "erro";

export interface ProductImage {
  id: string;
  product_variant_id: string;
  storage_path: string | null;
  source_url: string | null;
  image_hash: string | null;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  is_primary: boolean;
  is_active: boolean;
  image_type: ImageType;
  view_angle: string;
  recognition_enabled: boolean;
  quality_status: QualityStatus;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CatalogVisualProduct {
  variant_id: string;
  product_id: string;
  sku_outlet: string;
  nome: string;
  gtin_ean: string | null;
  ativo: boolean;
  image_count: number;
  primary_image: ProductImage | null;
  has_pending_quality: boolean;
  has_error: boolean;
}

export type CatalogVisualFilter =
  | "all"
  | "with_image"
  | "without_image"
  | "pending_quality"
  | "error"
  | "recognition_enabled"
  | "recognition_disabled"
  | "inactive";

export interface CatalogVisualSummary {
  total_products: number;
  with_image: number;
  without_image: number;
  with_multiple_images: number;
  pending_quality: number;
  recognition_ready: number;
  processing_errors: number;
  last_import: { id: string; filename: string | null; created_at: string; status: string } | null;
}

interface VariantJoinRow {
  id: string;
  product_id: string;
  sku_code: string;
  gtin: string | null;
  active: boolean;
  products: { name: string } | { name: string }[] | null;
}

function productName(row: VariantJoinRow): string {
  const p = row.products;
  if (!p) return "";
  return Array.isArray(p) ? p[0]?.name ?? "" : p.name;
}

export async function getCatalogVisualSummary(): Promise<CatalogVisualSummary> {
  const supabase = getSupabase();

  const [totalRes, withImageRows, pendingRes, errorRes, recognitionRes, lastImportRes] = await Promise.all([
    supabase.from("product_variants").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.from("product_images").select("product_variant_id").eq("is_active", true),
    supabase.from("product_images").select("id", { count: "exact", head: true }).eq("is_active", true).eq("quality_status", "pendente"),
    supabase.from("product_images").select("id", { count: "exact", head: true }).eq("processing_status", "erro"),
    supabase
      .from("product_images")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .eq("recognition_enabled", true)
      .eq("quality_status", "aprovada"),
    supabase.from("catalog_image_imports").select("id, filename, created_at, status").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const variantCounts = new Map<string, number>();
  for (const row of (withImageRows.data as { product_variant_id: string }[]) || []) {
    variantCounts.set(row.product_variant_id, (variantCounts.get(row.product_variant_id) || 0) + 1);
  }
  const withImage = variantCounts.size;
  const withMultiple = [...variantCounts.values()].filter((n) => n > 1).length;
  const total = totalRes.count ?? 0;

  return {
    total_products: total,
    with_image: withImage,
    without_image: Math.max(0, total - withImage),
    with_multiple_images: withMultiple,
    pending_quality: pendingRes.count ?? 0,
    recognition_ready: recognitionRes.count ?? 0,
    processing_errors: errorRes.count ?? 0,
    last_import: (lastImportRes.data as CatalogVisualSummary["last_import"]) ?? null,
  };
}

const PAGE_SIZE_DEFAULT = 30;

export async function listCatalogVisualProducts(
  query: string,
  filter: CatalogVisualFilter,
  page = 0,
  pageSize = PAGE_SIZE_DEFAULT
): Promise<{ rows: CatalogVisualProduct[]; total: number }> {
  const supabase = getSupabase();

  // Filtros que dependem de product_images: primeiro descobrimos o conjunto
  // de variant_id relevante, depois filtramos product_variants por ele.
  let variantIdFilter: string[] | null = null;
  if (filter === "with_image" || filter === "without_image") {
    const { data } = await supabase.from("product_images").select("product_variant_id").eq("is_active", true);
    const withImageIds = [...new Set(((data as { product_variant_id: string }[]) || []).map((r) => r.product_variant_id))];
    if (filter === "with_image") variantIdFilter = withImageIds;
    else {
      const { data: allVariants } = await supabase.from("product_variants").select("id").eq("active", true);
      const withImageSet = new Set(withImageIds);
      variantIdFilter = ((allVariants as { id: string }[]) || []).map((v) => v.id).filter((id) => !withImageSet.has(id));
    }
  } else if (filter === "pending_quality" || filter === "error" || filter === "recognition_enabled" || filter === "recognition_disabled") {
    let imgQuery = supabase.from("product_images").select("product_variant_id").eq("is_active", true);
    if (filter === "pending_quality") imgQuery = imgQuery.eq("quality_status", "pendente");
    if (filter === "error") imgQuery = imgQuery.eq("processing_status", "erro");
    if (filter === "recognition_enabled") imgQuery = imgQuery.eq("recognition_enabled", true);
    if (filter === "recognition_disabled") imgQuery = imgQuery.eq("recognition_enabled", false);
    const { data } = await imgQuery;
    variantIdFilter = [...new Set(((data as { product_variant_id: string }[]) || []).map((r) => r.product_variant_id))];
  }

  let builder = supabase
    .from("product_variants")
    .select("id, product_id, sku_code, gtin, active, products(name)", { count: "exact" })
    .order("sku_code", { ascending: true });

  if (filter === "inactive") builder = builder.eq("active", false);
  else builder = builder.eq("active", true);

  if (variantIdFilter !== null) {
    if (variantIdFilter.length === 0) return { rows: [], total: 0 };
    builder = builder.in("id", variantIdFilter);
  }

  const q = query.trim();
  if (q) {
    const safeQ = q.replace(/[,()%]/g, "");
    const { data: matchingProducts } = await supabase.from("products").select("id").ilike("normalized_name", `%${normalize(safeQ)}%`).limit(500);
    const productIds = (matchingProducts as { id: string }[] | null)?.map((p) => p.id) || [];
    if (productIds.length > 0) {
      builder = builder.or(`sku_code.ilike.%${safeQ}%,product_id.in.(${productIds.join(",")})`);
    } else {
      builder = builder.ilike("sku_code", `%${safeQ}%`);
    }
  }

  const from = page * pageSize;
  const { data, error, count } = await builder.range(from, from + pageSize - 1);
  if (error) throw error;

  const variants = (data as unknown as VariantJoinRow[]) || [];
  const variantIds = variants.map((v) => v.id);

  const imagesByVariant = new Map<string, ProductImage[]>();
  if (variantIds.length > 0) {
    const { data: images } = await supabase.from("product_images").select("*").in("product_variant_id", variantIds).eq("is_active", true);
    for (const img of (images as ProductImage[]) || []) {
      const list = imagesByVariant.get(img.product_variant_id) || [];
      list.push(img);
      imagesByVariant.set(img.product_variant_id, list);
    }
  }

  const rows: CatalogVisualProduct[] = variants.map((v) => {
    const images = imagesByVariant.get(v.id) || [];
    const primary = images.find((i) => i.is_primary) || images[0] || null;
    return {
      variant_id: v.id,
      product_id: v.product_id,
      sku_outlet: v.sku_code,
      nome: productName(v),
      gtin_ean: v.gtin,
      ativo: v.active,
      image_count: images.length,
      primary_image: primary,
      has_pending_quality: images.some((i) => i.quality_status === "pendente"),
      has_error: images.some((i) => i.processing_status === "erro"),
    };
  });

  return { rows, total: count ?? rows.length };
}

export async function getProductVisualDetail(
  variantId: string
): Promise<{ variant: CatalogVisualProduct; images: ProductImage[] }> {
  const supabase = getSupabase();
  const { data: variantRow, error: variantError } = await supabase
    .from("product_variants")
    .select("id, product_id, sku_code, gtin, active, products(name)")
    .eq("id", variantId)
    .single();
  if (variantError) throw variantError;

  const { data: images, error: imagesError } = await supabase
    .from("product_images")
    .select("*")
    .eq("product_variant_id", variantId)
    .order("created_at", { ascending: false });
  if (imagesError) throw imagesError;

  const v = variantRow as unknown as VariantJoinRow;
  const activeImages = ((images as ProductImage[]) || []).filter((i) => i.is_active);
  const primary = activeImages.find((i) => i.is_primary) || activeImages[0] || null;

  return {
    variant: {
      variant_id: v.id,
      product_id: v.product_id,
      sku_outlet: v.sku_code,
      nome: productName(v),
      gtin_ean: v.gtin,
      ativo: v.active,
      image_count: activeImages.length,
      primary_image: primary,
      has_pending_quality: activeImages.some((i) => i.quality_status === "pendente"),
      has_error: activeImages.some((i) => i.processing_status === "erro"),
    },
    images: (images as ProductImage[]) || [],
  };
}

export async function getSignedImageUrl(storagePath: string, expiresInSeconds = 600): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from("product-images").createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

export interface ImageHistoryEntry {
  id: string;
  action: string;
  metadata: { previous_data?: Record<string, unknown>; new_data?: Record<string, unknown> } | null;
  created_at: string;
  user_id: string | null;
}

export async function getImageHistory(imageIds: string[]): Promise<ImageHistoryEntry[]> {
  if (imageIds.length === 0) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, metadata, created_at, user_id")
    .eq("entity_type", "product_images")
    .in("entity_id", imageIds)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as ImageHistoryEntry[]) || [];
}

export async function setPrimaryImage(variantId: string, imageId: string): Promise<void> {
  const supabase = getSupabase();
  const { error: unsetError } = await supabase
    .from("product_images")
    .update({ is_primary: false })
    .eq("product_variant_id", variantId)
    .neq("id", imageId);
  if (unsetError) throw unsetError;
  const { error } = await supabase.from("product_images").update({ is_primary: true }).eq("id", imageId);
  if (error) throw error;
}

export async function archiveImage(imageId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("product_images")
    .update({ is_active: false, is_primary: false, archived_at: new Date().toISOString() })
    .eq("id", imageId);
  if (error) throw error;
}

export async function setImageQuality(imageId: string, quality: QualityStatus): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("product_images").update({ quality_status: quality }).eq("id", imageId);
  if (error) throw error;
}

export async function setRecognitionEnabled(imageId: string, enabled: boolean): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("product_images").update({ recognition_enabled: enabled }).eq("id", imageId);
  if (error) throw error;
}

export async function setImageTypeAndAngle(imageId: string, imageType: ImageType, viewAngle: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("product_images").update({ image_type: imageType, view_angle: viewAngle }).eq("id", imageId);
  if (error) throw error;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normaliza pro mesmo formato final da importação (WEBP), via canvas — sem depender de lib de imagem no navegador. */
async function normalizeToWebp(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const MAX_DIM = 2048;
  let { width, height } = bitmap;
  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Falha ao converter imagem."))), "image/webp", 0.9);
  });
  return { blob, width, height };
}

export interface ManualUploadInput {
  variantId: string;
  file: File;
  imageType: ImageType;
  viewAngle: string;
}

/** Upload manual (computador ou celular) direto pro Storage, sem passar pelo backend — não há URL externa, então não há risco de SSRF aqui. */
export interface CatalogImageImport {
  id: string;
  filename: string | null;
  status: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  error_rows: number;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CatalogImageImportItem {
  id: string;
  import_id: string;
  row_number: number;
  sku_outlet: string;
  product_name: string | null;
  gtin_ean: string | null;
  source_url: string | null;
  product_variant_id: string | null;
  product_image_id: string | null;
  status: string;
  error_message: string | null;
}

export async function listCatalogImageImports(limit = 30): Promise<CatalogImageImport[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("catalog_image_imports").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as CatalogImageImport[]) || [];
}

export async function getImportItems(importId: string): Promise<CatalogImageImportItem[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("catalog_image_import_items")
    .select("*")
    .eq("import_id", importId)
    .order("row_number", { ascending: true });
  if (error) throw error;
  return (data as CatalogImageImportItem[]) || [];
}

export async function uploadManualImage(input: ManualUploadInput): Promise<ProductImage> {
  const { profile } = getAuthState();
  const supabase = getSupabase();

  const { blob, width, height } = await normalizeToWebp(input.file);
  const arrayBuffer = await blob.arrayBuffer();
  const hash = await sha256Hex(arrayBuffer);

  const { data: existing } = await supabase
    .from("product_images")
    .select("id")
    .eq("product_variant_id", input.variantId)
    .eq("image_hash", hash)
    .eq("is_active", true)
    .maybeSingle();
  if (existing) throw new Error("Esta imagem (mesmo conteúdo) já está cadastrada para este produto.");

  const imageId = crypto.randomUUID();
  const storagePath = `${input.variantId}/${imageId}.webp`;

  const { error: uploadError } = await supabase.storage.from("product-images").upload(storagePath, blob, {
    contentType: "image/webp",
    upsert: false,
  });
  if (uploadError) throw new Error(`Falha ao enviar imagem: ${uploadError.message}`);

  const { count: primaryCount } = await supabase
    .from("product_images")
    .select("id", { count: "exact", head: true })
    .eq("product_variant_id", input.variantId)
    .eq("is_primary", true)
    .eq("is_active", true);

  const { data: inserted, error: insertError } = await supabase
    .from("product_images")
    .insert({
      id: imageId,
      product_variant_id: input.variantId,
      storage_path: storagePath,
      source_url: null,
      image_hash: hash,
      mime_type: "image/webp",
      file_size: blob.size,
      width,
      height,
      is_primary: (primaryCount ?? 0) === 0,
      is_active: true,
      image_type: input.imageType,
      view_angle: input.viewAngle || "nao_informado",
      recognition_enabled: true,
      quality_status: "pendente",
      processing_status: "pronta",
      uploaded_by: profile?.id ?? null,
    })
    .select("*")
    .single();
  if (insertError) throw new Error(`Falha ao gravar registro da imagem: ${insertError.message}`);

  return inserted as ProductImage;
}
