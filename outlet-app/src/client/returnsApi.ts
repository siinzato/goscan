// EXPANSÃO GOSCAN — Módulo Devolução: camada de dados (Supabase). Reaproveita
// searchCatalog (catalogApi.ts) pra resolução de EAN — nunca uma segunda
// consulta/regra de normalização — e o mesmo padrão de guarda client-side
// "requireManager" já usado em catalogManageApi.ts (a RLS/RPC no banco é
// sempre a barreira real; isto é só uma mensagem de erro melhor na UI).
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState, isManagerOrAdmin } from "./auth.ts";
import { normalizeEan, isValidEanFormat } from "./utils.ts";
import { searchCatalog, invalidateSearchCache as invalidateCatalogSearchCache, type CatalogRow } from "./catalogApi.ts";
import type { ReturnClassification, InvoiceSituation, BatchPreviewSummary } from "./returnsMatching.ts";
import { summarizeReturnItemsForBatchPreview } from "./returnsMatching.ts";

export type Marketplace = "mercado_livre" | "shopee" | "shein" | "amazon" | "tiktok" | "outro";
export type ReturnStatus =
  | "em_registro"
  | "aguardando_avaliacao"
  | "pendente_cancelamento_nota"
  | "pronta_logistica"
  | "enviada_logistica"
  | "lancada_tiny"
  | "concluida"
  | "com_pendencias"
  | "cancelada";
export type ReturnBatchStatus = "aguardando_lancamento" | "lancada_tiny" | "concluida";
export type LinkSource = "ean" | "sku" | "manual";

function requireManagerForCorrection(): void {
  const { profile } = getAuthState();
  if (!isManagerOrAdmin(profile)) throw new Error("Apenas administradores podem corrigir um registro já enviado.");
}

export interface ReturnRecord {
  id: string;
  marketplace: Marketplace;
  package_code: string;
  invoice_situation: InvoiceSituation;
  invoice_number: string | null;
  invoice_access_key: string | null;
  invoice_cancelled_at: string | null;
  invoice_cancelled_by: string | null;
  notes: string | null;
  status: ReturnStatus;
  created_by: string;
  batch_id: string | null;
  sent_to_logistics_at: string | null;
  sent_to_logistics_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReturnWithNames extends ReturnRecord {
  created_by_name: string | null;
}

export interface ReturnItemRecord {
  id: string;
  return_id: string;
  product_variant_id: string | null;
  scanned_ean_raw: string | null;
  ean_normalized: string | null;
  resolved_sku_code: string | null;
  resolved_product_name: string | null;
  quantity: number;
  classification: ReturnClassification;
  condition_notes: string | null;
  photo_path: string | null;
  link_source: LinkSource | null;
  is_pending: boolean;
  expected_description: string | null;
  last_change_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateReturnInput {
  marketplace: Marketplace;
  package_code: string;
  invoice_situation: InvoiceSituation;
  invoice_number?: string | null;
  notes?: string | null;
}

/** Situação da nota decide obrigatoriedade do número — mesma regra da constraint do banco (returns_invoice_number_required_check), validada aqui só pra uma mensagem melhor antes de ir ao servidor. */
export function validateReturnInvoiceNumber(situation: InvoiceSituation, invoiceNumber: string | null | undefined): string | null {
  if (situation === "cancelada" && (!invoiceNumber || !invoiceNumber.trim())) {
    return 'Número da NF é obrigatório quando a situação é "Nota cancelada".';
  }
  return null;
}

export async function createReturn(input: CreateReturnInput): Promise<ReturnRecord> {
  const { profile } = getAuthState();
  if (!profile) throw new Error("Sessão inválida.");
  const validationError = validateReturnInvoiceNumber(input.invoice_situation, input.invoice_number);
  if (validationError) throw new Error(validationError);

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("returns")
    .insert({
      marketplace: input.marketplace,
      package_code: input.package_code.trim(),
      invoice_situation: input.invoice_situation,
      invoice_number: input.invoice_number?.trim() || null,
      notes: input.notes?.trim() || null,
      created_by: profile.id,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ReturnRecord;
}

export interface DuplicatePackageMatch {
  id: string;
  marketplace: Marketplace;
  status: ReturnStatus;
  created_at: string;
}

/** Só ALERTA — nunca bloqueia (pacote com múltiplas devoluções legítimas é um caso real, ver pedido seção 3). */
export async function checkDuplicatePackageCode(packageCode: string, excludeReturnId?: string): Promise<DuplicatePackageMatch[]> {
  const trimmed = packageCode.trim();
  if (!trimmed) return [];
  const supabase = getSupabase();
  let builder = supabase.from("returns").select("id, marketplace, status, created_at").eq("package_code", trimmed).order("created_at", { ascending: false }).limit(5);
  if (excludeReturnId) builder = builder.neq("id", excludeReturnId);
  const { data, error } = await builder;
  if (error) throw error;
  return (data as DuplicatePackageMatch[]) || [];
}

export interface ListReturnsFilters {
  marketplace?: Marketplace;
  status?: ReturnStatus;
  invoiceSituation?: InvoiceSituation;
  fromDate?: string;
  toDate?: string;
  packageOrInvoiceQuery?: string;
  skuOrEanQuery?: string;
}

export interface ReturnsPage {
  rows: ReturnWithNames[];
  total: number;
}

export async function listReturns(filters: ListReturnsFilters, page = 0, pageSize = 20): Promise<ReturnsPage> {
  const supabase = getSupabase();
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let itemMatchedReturnIds: string[] | null = null;
  const skuOrEanQuery = filters.skuOrEanQuery?.trim();
  if (skuOrEanQuery) {
    const safeQ = skuOrEanQuery.replace(/[,()%]/g, "");
    const normalizedEan = normalizeEan(safeQ);
    let itemBuilder = supabase.from("return_items").select("return_id").limit(500);
    if (isValidEanFormat(normalizedEan)) {
      itemBuilder = itemBuilder.eq("ean_normalized", normalizedEan);
    } else {
      itemBuilder = itemBuilder.ilike("resolved_sku_code", `%${safeQ}%`);
    }
    const { data: itemRows, error: itemErr } = await itemBuilder;
    if (itemErr) throw itemErr;
    itemMatchedReturnIds = Array.from(new Set((itemRows || []).map((r) => r.return_id as string)));
    if (itemMatchedReturnIds.length === 0) return { rows: [], total: 0 };
  }

  let builder = supabase
    .from("returns")
    .select("*, profiles!returns_created_by_fkey(full_name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.marketplace) builder = builder.eq("marketplace", filters.marketplace);
  if (filters.status) builder = builder.eq("status", filters.status);
  if (filters.invoiceSituation) builder = builder.eq("invoice_situation", filters.invoiceSituation);
  if (filters.fromDate) builder = builder.gte("created_at", filters.fromDate);
  if (filters.toDate) builder = builder.lte("created_at", filters.toDate);
  if (filters.packageOrInvoiceQuery?.trim()) {
    const safeQ = filters.packageOrInvoiceQuery.trim().replace(/[,()%]/g, "");
    builder = builder.or(`package_code.ilike.%${safeQ}%,invoice_number.ilike.%${safeQ}%`);
  }
  if (itemMatchedReturnIds) builder = builder.in("id", itemMatchedReturnIds);

  const { data, error, count } = await builder;
  if (error) throw error;

  const rows = ((data as (ReturnRecord & { profiles: { full_name: string | null } | { full_name: string | null }[] | null })[]) || []).map((row) => {
    const { profiles, ...rest } = row;
    const creator = Array.isArray(profiles) ? profiles[0] : profiles;
    return { ...rest, created_by_name: creator?.full_name ?? null } as ReturnWithNames;
  });

  return { rows, total: count ?? rows.length };
}

export async function getReturnWithItems(returnId: string): Promise<{ ret: ReturnWithNames; items: ReturnItemRecord[] }> {
  const supabase = getSupabase();
  const [{ data: ret, error: retErr }, { data: items, error: itemsErr }] = await Promise.all([
    supabase.from("returns").select("*, profiles!returns_created_by_fkey(full_name)").eq("id", returnId).single(),
    supabase.from("return_items").select("*").eq("return_id", returnId).order("created_at", { ascending: true }),
  ]);
  if (retErr) throw retErr;
  if (itemsErr) throw itemsErr;

  const row = ret as ReturnRecord & { profiles: { full_name: string | null } | { full_name: string | null }[] | null };
  const { profiles, ...rest } = row;
  const creator = Array.isArray(profiles) ? profiles[0] : profiles;
  return { ret: { ...rest, created_by_name: creator?.full_name ?? null }, items: (items as ReturnItemRecord[]) || [] };
}

export interface AddReturnItemResult {
  item: ReturnItemRecord;
  found: boolean;
  incremented: boolean;
}

/**
 * Bipagem principal — busca EXATA por EAN (reaproveita searchCatalog, que já
 * usa gtin_normalized com igualdade, nunca substring). Se o mesmo produto já
 * está nesta devolução, incrementa a quantidade em vez de duplicar a linha
 * (ver pedido seção 5: "Se o mesmo EAN for bipado novamente, aumentar a
 * quantidade em uma unidade"). Nunca trava a devolução quando não encontra —
 * salva como pendência explícita.
 */
/**
 * Núcleo compartilhado de "adicionar um produto já resolvido" — usado tanto
 * pela bipagem por EAN (match exato) quanto pela escolha manual (picker de
 * SKU/nome). Se o mesmo variant já está nesta devolução, incrementa em vez
 * de duplicar a linha (mesma regra do pedido, seção 5).
 */
async function addResolvedReturnItem(
  returnId: string,
  variant: { variant_id: string; sku_code: string; produto: string },
  linkSource: LinkSource,
  scannedEanRaw: string | null,
  eanNormalized: string | null
): Promise<AddReturnItemResult> {
  const { profile } = getAuthState();
  if (!profile) throw new Error("Sessão inválida.");
  const supabase = getSupabase();

  const { data: existing, error: existingErr } = await supabase
    .from("return_items")
    .select("*")
    .eq("return_id", returnId)
    .eq("product_variant_id", variant.variant_id)
    .limit(1)
    .maybeSingle();
  if (existingErr) throw existingErr;

  if (existing) {
    const { data: updated, error: updErr } = await supabase
      .from("return_items")
      .update({ quantity: (existing as ReturnItemRecord).quantity + 1 })
      .eq("id", (existing as ReturnItemRecord).id)
      .select("*")
      .single();
    if (updErr) throw updErr;
    return { item: updated as ReturnItemRecord, found: true, incremented: true };
  }

  const { data: inserted, error: insErr } = await supabase
    .from("return_items")
    .insert({
      return_id: returnId,
      product_variant_id: variant.variant_id,
      scanned_ean_raw: scannedEanRaw,
      ean_normalized: eanNormalized,
      resolved_sku_code: variant.sku_code,
      resolved_product_name: variant.produto,
      link_source: linkSource,
      is_pending: false,
      created_by: profile.id,
    })
    .select("*")
    .single();
  if (insErr) throw insErr;
  return { item: inserted as ReturnItemRecord, found: true, incremented: false };
}

/** Adição manual (picker de SKU/nome) — nunca finge que veio de uma bipagem por EAN. */
export async function addReturnItemByVariant(returnId: string, variant: CatalogRow): Promise<AddReturnItemResult> {
  return addResolvedReturnItem(returnId, variant, "manual", null, null);
}

export async function addReturnItemByEan(returnId: string, rawEan: string): Promise<AddReturnItemResult> {
  const { profile } = getAuthState();
  if (!profile) throw new Error("Sessão inválida.");
  const supabase = getSupabase();
  const normalized = normalizeEan(rawEan);
  const isValid = isValidEanFormat(normalized);

  let match: CatalogRow | null = null;
  if (isValid) {
    const page = await searchCatalog(rawEan, 0, 5);
    match = page.rows.find((r) => r.match_type === "exact_ean") || null;
  }

  if (match) {
    return addResolvedReturnItem(returnId, match, "ean", rawEan, normalized);
  }

  const { data: pending, error: pendErr } = await supabase
    .from("return_items")
    .insert({
      return_id: returnId,
      product_variant_id: null,
      scanned_ean_raw: rawEan,
      ean_normalized: isValid ? normalized : null,
      link_source: null,
      is_pending: true,
      created_by: profile.id,
    })
    .select("*")
    .single();
  if (pendErr) throw pendErr;
  return { item: pending as ReturnItemRecord, found: false, incremented: false };
}

/** Vínculo manual (Resolver pendências) — busca já existente do catálogo (searchCatalog), nunca uma correspondência automática por semelhança de nome. */
export async function linkReturnItemManually(itemId: string, variant: CatalogRow): Promise<ReturnItemRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("return_items")
    .update({
      product_variant_id: variant.variant_id,
      resolved_sku_code: variant.sku_code,
      resolved_product_name: variant.produto,
      link_source: "manual",
      is_pending: false,
    })
    .eq("id", itemId)
    .select("*")
    .single();
  if (error) throw error;
  return data as ReturnItemRecord;
}

export async function setReturnItemQuantity(itemId: string, quantity: number): Promise<ReturnItemRecord> {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantidade inválida.");
  const supabase = getSupabase();
  const { data, error } = await supabase.from("return_items").update({ quantity: Math.floor(quantity) }).eq("id", itemId).select("*").single();
  if (error) throw error;
  return data as ReturnItemRecord;
}

export interface ClassifyReturnItemInput {
  classification: ReturnClassification;
  condition_notes?: string | null;
  expected_description?: string | null;
}

export async function classifyReturnItem(itemId: string, input: ClassifyReturnItemInput): Promise<ReturnItemRecord> {
  const supabase = getSupabase();
  const patch: Record<string, unknown> = { classification: input.classification };
  if (input.condition_notes !== undefined) patch.condition_notes = input.condition_notes?.trim() || null;
  if (input.expected_description !== undefined) patch.expected_description = input.expected_description?.trim() || null;
  const { data, error } = await supabase.from("return_items").update(patch).eq("id", itemId).select("*").single();
  if (error) throw error;
  return data as ReturnItemRecord;
}

export async function removeReturnItem(itemId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("return_items").delete().eq("id", itemId);
  if (error) throw error;
}

/** Foto opcional (nunca obrigatória pra item vendável — ver pedido seção 6). Bucket privado 'return-photos' (0047). */
export async function uploadReturnItemPhoto(returnId: string, itemId: string, file: File): Promise<string> {
  const supabase = getSupabase();
  const ext = file.name.split(".").pop() || "jpg";
  const path = `${returnId}/${itemId}-${Date.now()}.${ext}`;
  const { error: uploadErr } = await supabase.storage.from("return-photos").upload(path, file, { upsert: false });
  if (uploadErr) throw uploadErr;
  const { error: updErr } = await supabase.from("return_items").update({ photo_path: path }).eq("id", itemId);
  if (updErr) throw updErr;
  return path;
}

export async function getReturnPhotoSignedUrl(path: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from("return-photos").createSignedUrl(path, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function markInvoiceSituation(returnId: string, situation: InvoiceSituation, invoiceNumber?: string | null): Promise<ReturnRecord> {
  const validationError = validateReturnInvoiceNumber(situation, invoiceNumber);
  if (validationError) throw new Error(validationError);
  const supabase = getSupabase();
  const patch: Record<string, unknown> = { invoice_situation: situation };
  if (invoiceNumber !== undefined) patch.invoice_number = invoiceNumber?.trim() || null;
  const { data, error } = await supabase.from("returns").update(patch).eq("id", returnId).select("*").single();
  if (error) throw error;
  return data as ReturnRecord;
}

export async function updateReturnNotes(returnId: string, notes: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("returns").update({ notes: notes.trim() || null }).eq("id", returnId);
  if (error) throw error;
}

export async function deleteReturn(returnId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("returns").delete().eq("id", returnId);
  if (error) throw error;
}

export interface ReturnItemForBatchPreview {
  classification: ReturnClassification;
  quantity: number;
  is_pending: boolean;
  invoice_situation: InvoiceSituation;
}

/** Preview client-side (mostrado ANTES de "Enviar para a Logística") — a fonte de verdade que de fato grava é sempre a RPC send_return_batch_to_logistics. */
export async function getBatchPreviewSummary(returnIds: string[]): Promise<BatchPreviewSummary> {
  if (returnIds.length === 0) return summarizeReturnItemsForBatchPreview([]);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("return_items")
    .select("classification, quantity, is_pending, returns!inner(invoice_situation)")
    .in("return_id", returnIds);
  if (error) throw error;

  const items: ReturnItemForBatchPreview[] = ((data as unknown as { classification: ReturnClassification; quantity: number; is_pending: boolean; returns: { invoice_situation: InvoiceSituation } | { invoice_situation: InvoiceSituation }[] }[]) || []).map((row) => {
    const r = Array.isArray(row.returns) ? row.returns[0] : row.returns;
    return { classification: row.classification, quantity: row.quantity, is_pending: row.is_pending, invoice_situation: r?.invoice_situation ?? "nao_se_aplica" };
  });
  return summarizeReturnItemsForBatchPreview(items);
}

export interface SendBatchResult {
  batch_id: string;
  total_returns: number;
  total_skus: number;
  total_units: number;
}

export async function sendBatchToLogistics(returnIds: string[]): Promise<SendBatchResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("send_return_batch_to_logistics", { p_return_ids: returnIds });
  if (error) throw error;
  invalidateCatalogSearchCache();
  return data as SendBatchResult;
}

export interface ReturnBatchRecord {
  id: string;
  status: ReturnBatchStatus;
  created_by: string;
  created_at: string;
}

export interface ReturnBatchSummary extends ReturnBatchRecord {
  total_returns: number;
  total_skus: number;
  total_units: number;
  marketplaces: Marketplace[];
}

export async function listBatches(status?: ReturnBatchStatus, page = 0, pageSize = 20): Promise<{ rows: ReturnBatchSummary[]; total: number }> {
  const supabase = getSupabase();
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let builder = supabase.from("return_batches").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(from, to);
  if (status) builder = builder.eq("status", status);
  const { data: batches, error, count } = await builder;
  if (error) throw error;

  const batchIds = ((batches as ReturnBatchRecord[]) || []).map((b) => b.id);
  if (batchIds.length === 0) return { rows: [], total: count ?? 0 };

  const [{ data: batchItems, error: biErr }, { data: returns, error: rErr }] = await Promise.all([
    supabase.from("return_batch_items").select("batch_id, total_quantity").in("batch_id", batchIds),
    supabase.from("returns").select("id, batch_id, marketplace").in("batch_id", batchIds),
  ]);
  if (biErr) throw biErr;
  if (rErr) throw rErr;

  const rows: ReturnBatchSummary[] = ((batches as ReturnBatchRecord[]) || []).map((b) => {
    const itemsOfBatch = ((batchItems as { batch_id: string; total_quantity: number }[]) || []).filter((bi) => bi.batch_id === b.id);
    const returnsOfBatch = ((returns as { id: string; batch_id: string; marketplace: Marketplace }[]) || []).filter((r) => r.batch_id === b.id);
    return {
      ...b,
      total_skus: itemsOfBatch.length,
      total_units: itemsOfBatch.reduce((acc, it) => acc + it.total_quantity, 0),
      total_returns: returnsOfBatch.length,
      marketplaces: Array.from(new Set(returnsOfBatch.map((r) => r.marketplace))),
    };
  });

  return { rows, total: count ?? rows.length };
}

export interface BatchItemDetail {
  id: string;
  product_variant_id: string;
  sku_code: string;
  gtin: string | null;
  produto: string;
  total_quantity: number;
  sources: BatchItemSource[];
}

export interface BatchItemSource {
  return_item_id: string;
  quantity: number;
  return_id: string;
  marketplace: Marketplace;
  package_code: string;
  invoice_number: string | null;
  classification: ReturnClassification;
  created_by_name: string | null;
  created_at: string;
}

export async function getBatchDetail(batchId: string): Promise<{ batch: ReturnBatchRecord; items: BatchItemDetail[] }> {
  const supabase = getSupabase();
  const [{ data: batch, error: batchErr }, { data: batchItems, error: biErr }] = await Promise.all([
    supabase.from("return_batches").select("*").eq("id", batchId).single(),
    supabase.from("return_batch_items").select("id, product_variant_id, total_quantity, product_variants(sku_code, gtin, products(name))").eq("batch_id", batchId),
  ]);
  if (batchErr) throw batchErr;
  if (biErr) throw biErr;

  const batchItemRows = (batchItems as unknown as {
    id: string;
    product_variant_id: string;
    total_quantity: number;
    product_variants: { sku_code: string; gtin: string | null; products: { name: string } | { name: string }[] | null } | null;
  }[]) || [];
  const batchItemIds = batchItemRows.map((r) => r.id);

  const { data: sources, error: srcErr } =
    batchItemIds.length === 0
      ? { data: [] as unknown[], error: null }
      : await supabase
          .from("return_batch_sources")
          .select(
            "batch_item_id, quantity, return_items!inner(id, return_id, classification, created_by, returns!inner(marketplace, package_code, invoice_number))"
          )
          .in("batch_item_id", batchItemIds);
  if (srcErr) throw srcErr;

  const sourceRows = (sources as unknown as {
    batch_item_id: string;
    quantity: number;
    return_items: {
      id: string;
      return_id: string;
      classification: ReturnClassification;
      created_by: string;
      returns: { marketplace: Marketplace; package_code: string; invoice_number: string | null } | { marketplace: Marketplace; package_code: string; invoice_number: string | null }[];
    };
  }[]) || [];

  const items: BatchItemDetail[] = batchItemRows.map((bi) => {
    const productJoin = Array.isArray(bi.product_variants?.products) ? bi.product_variants?.products[0] : bi.product_variants?.products;
    const sourcesOfItem: BatchItemSource[] = sourceRows
      .filter((s) => s.batch_item_id === bi.id)
      .map((s) => {
        const ret = Array.isArray(s.return_items.returns) ? s.return_items.returns[0] : s.return_items.returns;
        return {
          return_item_id: s.return_items.id,
          quantity: s.quantity,
          return_id: s.return_items.return_id,
          marketplace: ret?.marketplace ?? "outro",
          package_code: ret?.package_code ?? "",
          invoice_number: ret?.invoice_number ?? null,
          classification: s.return_items.classification,
          created_by_name: null,
          created_at: "",
        };
      });
    return {
      id: bi.id,
      product_variant_id: bi.product_variant_id,
      sku_code: bi.product_variants?.sku_code ?? "",
      gtin: bi.product_variants?.gtin ?? null,
      produto: productJoin?.name ?? "",
      total_quantity: bi.total_quantity,
      sources: sourcesOfItem,
    };
  });

  return { batch: batch as ReturnBatchRecord, items };
}

export interface ConfirmTinyLaunchInput {
  batchId: string;
  warehouse: string;
  launchedAt: string;
  note?: string | null;
}

export async function confirmBatchTinyLaunch(input: ConfirmTinyLaunchInput): Promise<{ batch_id: string; confirmed_quantities: unknown }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("confirm_return_batch_tiny_launch", {
    p_batch_id: input.batchId,
    p_warehouse: input.warehouse.trim(),
    p_launched_at: input.launchedAt,
    p_note: input.note?.trim() || null,
  });
  if (error) throw error;
  return data as { batch_id: string; confirmed_quantities: unknown };
}

export async function reopenBatch(batchId: string, reason: string): Promise<void> {
  requireManagerForCorrection();
  if (!reason.trim()) throw new Error("Informe o motivo da reabertura.");
  const supabase = getSupabase();
  const { error } = await supabase.rpc("reopen_return_batch", { p_batch_id: batchId, p_reason: reason.trim() });
  if (error) throw error;
}

export type CorrectableReturnField = "invoice_number" | "invoice_situation" | "notes" | "package_code";
export type CorrectableReturnItemField = "classification" | "quantity" | "condition_notes" | "expected_description";

export async function correctReturnField(returnId: string, field: CorrectableReturnField, newValue: string, reason: string): Promise<void> {
  requireManagerForCorrection();
  if (!reason.trim()) throw new Error("Informe o motivo da correção.");
  const supabase = getSupabase();
  const { error } = await supabase.rpc("correct_return_record", {
    p_entity_type: "return",
    p_entity_id: returnId,
    p_field: field,
    p_new_value: newValue,
    p_reason: reason.trim(),
  });
  if (error) throw error;
}

export async function correctReturnItemField(itemId: string, field: CorrectableReturnItemField, newValue: string, reason: string): Promise<void> {
  requireManagerForCorrection();
  if (!reason.trim()) throw new Error("Informe o motivo da correção.");
  const supabase = getSupabase();
  const { error } = await supabase.rpc("correct_return_record", {
    p_entity_type: "return_item",
    p_entity_id: itemId,
    p_field: field,
    p_new_value: newValue,
    p_reason: reason.trim(),
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Relatórios — linhas planas pra exportação (ver returnsExport.ts). Sempre
// com paginação/limite explícito no servidor, nunca "traz tudo pro cliente".
// ---------------------------------------------------------------------------
export interface ReportFilters extends ListReturnsFilters {
  limit?: number;
}

export interface ReportDetailRow {
  marketplace: Marketplace;
  package_code: string;
  invoice_number: string | null;
  invoice_situation: InvoiceSituation;
  sku_code: string | null;
  ean: string | null;
  produto: string | null;
  quantity: number;
  classification: ReturnClassification;
  condition_notes: string | null;
  is_pending: boolean;
  created_by_name: string | null;
  invoice_cancelled_by_name: string | null;
  sent_to_logistics_by_name: string | null;
  status: ReturnStatus;
  created_at: string;
}

const REPORT_ROW_LIMIT_DEFAULT = 5000;

export async function fetchReportDetailRows(filters: ReportFilters): Promise<ReportDetailRow[]> {
  const { rows: returns } = await listReturns(filters, 0, filters.limit ?? REPORT_ROW_LIMIT_DEFAULT);
  if (returns.length === 0) return [];
  const returnIds = returns.map((r) => r.id);
  const returnById = new Map(returns.map((r) => [r.id, r]));

  const supabase = getSupabase();
  const { data: items, error } = await supabase.from("return_items").select("*").in("return_id", returnIds);
  if (error) throw error;

  return ((items as ReturnItemRecord[]) || []).map((item) => {
    const ret = returnById.get(item.return_id)!;
    return {
      marketplace: ret.marketplace,
      package_code: ret.package_code,
      invoice_number: ret.invoice_number,
      invoice_situation: ret.invoice_situation,
      sku_code: item.resolved_sku_code,
      ean: item.ean_normalized,
      produto: item.resolved_product_name,
      quantity: item.quantity,
      classification: item.classification,
      condition_notes: item.condition_notes,
      is_pending: item.is_pending,
      created_by_name: ret.created_by_name,
      invoice_cancelled_by_name: null,
      sent_to_logistics_by_name: null,
      status: ret.status,
      created_at: item.created_at,
    };
  });
}

export interface StockSummaryRow {
  sku_code: string;
  ean: string | null;
  produto: string;
  total_quantity: number;
}

/** "Resumo para Estoque" — mesma regra de elegibilidade da RPC de envio (vendável + nota não pendente), agregada por SKU no escopo dos filtros (não de um lote específico). */
export async function fetchStockSummaryRows(filters: ListReturnsFilters): Promise<StockSummaryRow[]> {
  const rows = await fetchReportDetailRows(filters);
  const eligible = rows.filter((r) => r.classification === "vendavel" && r.invoice_situation !== "pendente_cancelamento" && !r.is_pending && r.sku_code);
  const bySku = new Map<string, StockSummaryRow>();
  for (const r of eligible) {
    const key = r.sku_code!;
    const existing = bySku.get(key);
    if (existing) existing.total_quantity += r.quantity;
    else bySku.set(key, { sku_code: key, ean: r.ean, produto: r.produto || "", total_quantity: r.quantity });
  }
  return Array.from(bySku.values());
}

/** "Pendências e Ocorrências" — nunca inclui vendável liberado; sempre o que precisa de atenção humana. */
export async function fetchPendingAndOccurrenceRows(filters: ListReturnsFilters): Promise<ReportDetailRow[]> {
  const rows = await fetchReportDetailRows(filters);
  return rows.filter((r) => r.is_pending || r.classification === "avariado" || r.classification === "divergente" || r.classification === "aguardando_analise" || r.classification === "pacote_vazio");
}
