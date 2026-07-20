// Orquestra o processamento em lote das imagens de uma importação do
// Catálogo Visual: para cada item pendente, baixa a URL (SSRF-safe),
// valida/normaliza, sobe pro Storage e grava product_images — isolando o
// erro por linha (uma imagem com problema nunca derruba a importação
// inteira). Roda com o cliente service_role (só chamado depois de
// requireManagerOrAdmin no server.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadUrlSafely, SsrfBlockedError, DownloadTooLargeError, DownloadFailedError } from "./ssrfSafeFetch.ts";
import { processAndNormalizeImage, ImageValidationError } from "./imagePipeline.ts";

const BUCKET = "product-images";

interface ImportItemRow {
  id: string;
  import_id: string;
  row_number: number;
  sku_outlet: string;
  source_url: string | null;
  product_variant_id: string | null;
  status: string;
}

export interface BatchItemResult {
  id: string;
  row_number: number;
  sku_outlet: string;
  status: "success" | "success_no_image" | "error";
  error?: string;
  deduped?: boolean;
}

export interface BatchResult {
  processed: BatchItemResult[];
  remainingPending: number;
  importStatus: string;
}

async function processOneItem(admin: SupabaseClient, item: ImportItemRow, importedBy: string | null): Promise<BatchItemResult> {
  await admin.from("catalog_image_import_items").update({ status: "processing" }).eq("id", item.id);

  if (!item.source_url || !item.source_url.trim()) {
    await admin
      .from("catalog_image_import_items")
      .update({ status: "success_no_image", error_message: null })
      .eq("id", item.id);
    return { id: item.id, row_number: item.row_number, sku_outlet: item.sku_outlet, status: "success_no_image" };
  }

  try {
    if (!item.product_variant_id) {
      throw new Error(`SKU Outlet "${item.sku_outlet}" não pôde ser localizado/criado — nada para associar a imagem.`);
    }

    const { buffer: rawBuffer } = await downloadUrlSafely(item.source_url);
    const processed = await processAndNormalizeImage(rawBuffer);

    const { data: existing } = await admin
      .from("product_images")
      .select("id")
      .eq("product_variant_id", item.product_variant_id)
      .eq("image_hash", processed.hash)
      .eq("is_active", true)
      .maybeSingle();

    if (existing) {
      await admin
        .from("catalog_image_import_items")
        .update({ status: "success", product_image_id: existing.id, error_message: null })
        .eq("id", item.id);
      return { id: item.id, row_number: item.row_number, sku_outlet: item.sku_outlet, status: "success", deduped: true };
    }

    const imageId = crypto.randomUUID();
    const storagePath = `${item.product_variant_id}/${imageId}.webp`;

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(storagePath, processed.buffer, { contentType: "image/webp", upsert: false });
    if (uploadError) throw new Error(`Falha ao gravar no Storage: ${uploadError.message}`);

    const { count: primaryCount } = await admin
      .from("product_images")
      .select("id", { count: "exact", head: true })
      .eq("product_variant_id", item.product_variant_id)
      .eq("is_primary", true)
      .eq("is_active", true);

    const { data: inserted, error: insertError } = await admin
      .from("product_images")
      .insert({
        id: imageId,
        product_variant_id: item.product_variant_id,
        storage_path: storagePath,
        source_url: item.source_url,
        image_hash: processed.hash,
        mime_type: processed.mimeType,
        file_size: processed.buffer.length,
        width: processed.width,
        height: processed.height,
        is_primary: (primaryCount ?? 0) === 0,
        is_active: true,
        image_type: "catalogo",
        view_angle: "nao_informado",
        recognition_enabled: true,
        quality_status: "pendente",
        processing_status: "pronta",
        uploaded_by: importedBy,
      })
      .select("id")
      .single();
    if (insertError) throw new Error(`Falha ao gravar o registro da imagem: ${insertError.message}`);

    await admin
      .from("catalog_image_import_items")
      .update({ status: "success", product_image_id: inserted.id, error_message: null })
      .eq("id", item.id);

    return { id: item.id, row_number: item.row_number, sku_outlet: item.sku_outlet, status: "success" };
  } catch (err) {
    const message =
      err instanceof SsrfBlockedError || err instanceof DownloadTooLargeError || err instanceof DownloadFailedError || err instanceof ImageValidationError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await admin.from("catalog_image_import_items").update({ status: "error", error_message: message }).eq("id", item.id);
    return { id: item.id, row_number: item.row_number, sku_outlet: item.sku_outlet, status: "error", error: message };
  }
}

async function recomputeImportCounts(admin: SupabaseClient, importId: string): Promise<string> {
  const { data: items } = await admin.from("catalog_image_import_items").select("status").eq("import_id", importId);
  const all = (items as { status: string }[]) || [];
  const total = all.length;
  const processed = all.filter((i) => i.status !== "pending" && i.status !== "processing").length;
  const success = all.filter((i) => i.status === "success" || i.status === "success_no_image").length;
  const errors = all.filter((i) => i.status === "error").length;
  const allDone = total > 0 && processed === total;
  const status = !allDone ? "processing" : errors > 0 ? "completed_with_errors" : "completed";

  await admin
    .from("catalog_image_imports")
    .update({
      processed_rows: processed,
      success_rows: success,
      error_rows: errors,
      status,
      completed_at: allDone ? new Date().toISOString() : null,
    })
    .eq("id", importId);

  return status;
}

export async function processImportBatch(admin: SupabaseClient, importId: string, limit = 5): Promise<BatchResult> {
  const { data: importRow, error: importError } = await admin
    .from("catalog_image_imports")
    .select("id, created_by")
    .eq("id", importId)
    .maybeSingle();
  if (importError || !importRow) throw new Error("Importação não encontrada.");

  const { data: items, error } = await admin
    .from("catalog_image_import_items")
    .select("id, import_id, row_number, sku_outlet, source_url, product_variant_id, status")
    .eq("import_id", importId)
    .eq("status", "pending")
    .order("row_number", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const results: BatchItemResult[] = [];
  for (const item of (items as ImportItemRow[]) || []) {
    results.push(await processOneItem(admin, item, importRow.created_by));
  }

  const importStatus = await recomputeImportCounts(admin, importId);

  const { count: remainingPending } = await admin
    .from("catalog_image_import_items")
    .select("id", { count: "exact", head: true })
    .eq("import_id", importId)
    .eq("status", "pending");

  return { processed: results, remainingPending: remainingPending ?? 0, importStatus };
}

/** "Reprocessar apenas os itens com erro" — devolve as linhas com erro pro estado pendente. */
export async function resetErrorItems(admin: SupabaseClient, importId: string): Promise<number> {
  const { data, error } = await admin
    .from("catalog_image_import_items")
    .update({ status: "pending", error_message: null })
    .eq("import_id", importId)
    .eq("status", "error")
    .select("id");
  if (error) throw error;
  await recomputeImportCounts(admin, importId);
  return (data || []).length;
}
