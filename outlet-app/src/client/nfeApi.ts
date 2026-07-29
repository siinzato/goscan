// EXPANSÃO GOSCAN — Conferência por Nota Fiscal, Parte 3: CRUD via Supabase
// (mesmo padrão de conferencesApi.ts — RLS é a barreira real, aqui só
// modelamos as operações). Candidatos de resolução são buscados SEMPRE
// filtrados por products.product_type='normal' — um item de NF nunca pode
// ser vinculado a um SKU Outlet, mesmo que o texto pareça bater.
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";
import { normalizeEan, isValidEanFormat } from "./utils.ts";
import type { NfeParsed } from "./nfeParser.ts";
import {
  resolveInvoiceItem,
  normalizeKey,
  summarizeReceipt,
  type NormalVariantCandidate,
  type AliasMaps,
  type LinkSource,
  type ReceiptSummary,
  type NameCandidate,
} from "./nfeMatching.ts";

export type ReceiptStatus = "not_started" | "in_progress" | "completed" | "with_divergences";
export type ItemStatus = "pending" | "counted" | "ok" | "missing" | "surplus" | "unlinked";
// CORREÇÃO ESTRUTURAL — Conferência Colaborativa (ver 0042_collab_conference_schema.sql):
// volume = divisão por caixa/pallet/área física (mesmo SKU pode ser contado por
// pessoas diferentes em volumes diferentes, nunca bloqueia); product = reserva
// temporária por produto (só quem reservou bipa aquele item enquanto ativo);
// free = compartilhado sem bloqueio automático (só alerta visualmente via presença).
export type WorkMode = "volume" | "product" | "free";

export interface InvoiceReceipt {
  id: string;
  invoice_key: string;
  invoice_number: string | null;
  series: string | null;
  supplier_name: string | null;
  supplier_cnpj: string | null;
  issued_at: string | null;
  status: ReceiptStatus;
  work_mode: WorkMode;
  created_by: string;
  finished_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface InvoiceReceiptItem {
  id: string;
  receipt_id: string;
  product_variant_id: string | null;
  invoice_product_code: string | null;
  description: string | null;
  ean: string | null;
  unit: string | null;
  unit_value: number | null;
  total_value: number | null;
  expected_quantity: number;
  physical_quantity: number | null;
  status: ItemStatus;
  link_source: LinkSource;
  counted_by: string | null;
  created_at: string;
  updated_at: string;
  // Snapshot IMUTÁVEL gravado só na finalização (ver finalizeReceipt) — nulo
  // antes disso. O relatório final usa estes campos, nunca o join ao vivo,
  // pra não mudar sozinho se o cadastro do produto for editado depois.
  linked_sku_code: string | null;
  linked_product_name: string | null;
  linked_ean: string | null;
  // Enriquecido via join (getReceipt) — não existe como coluna própria.
  // Reflete o cadastro ATUAL, útil enquanto a conferência ainda está em
  // andamento (prep/contagem); depois de finalizada, prefira os campos
  // linked_* acima.
  sku_code?: string | null;
  produto?: string | null;
  /**
   * EXPANSÃO GOSCAN — Exibição de EAN no card de conferência: EAN
   * REGISTRADO no cadastro do produto vinculado (product_variants.gtin),
   * vindo do MESMO join de getReceipt() — nunca uma consulta extra por
   * item. Usado como fallback só quando `ean` (o valor que veio na própria
   * NF) está ausente — a NF sempre tem prioridade quando existe.
   */
  catalog_ean?: string | null;
}

export interface ReceiptCount {
  id: string;
  item_id: string;
  user_id: string;
  quantity: number;
  count_number: number;
  created_at: string;
}

function requireUserId(): string {
  const { session } = getAuthState();
  if (!session) throw new Error("Sessão inválida — faça login novamente.");
  return session.user.id;
}

export interface InvoiceReceiptWithCreator extends InvoiceReceipt {
  created_by_name: string | null;
}

/**
 * Usada pra checar duplicidade ANTES de criar — junto com o nome de quem
 * importou, pro aviso "Esta Nota Fiscal já foi importada."
 *
 * BUG REAL corrigido (causa raiz de "o sistema não reconhece a nota"):
 * invoice_receipts tem DUAS foreign keys pra profiles (created_by e
 * finished_by) — um embed genérico `profiles(full_name)` é ambíguo pro
 * PostgREST e falha com erro PGRST201 em TODA chamada, mesmo pra uma NF
 * nova nunca importada antes (esta função roda antes de criar qualquer
 * recibo). Precisa apontar explicitamente qual FK usar.
 */
export async function findReceiptByInvoiceKey(invoiceKey: string): Promise<InvoiceReceiptWithCreator | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("invoice_receipts")
    .select("*, profiles!invoice_receipts_created_by_fkey(full_name)")
    .eq("invoice_key", invoiceKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as InvoiceReceipt & { profiles: { full_name: string | null } | { full_name: string | null }[] | null };
  const { profiles, ...receipt } = row;
  const operator = Array.isArray(profiles) ? profiles[0] : profiles;
  return { ...receipt, created_by_name: operator?.full_name ?? null };
}

interface NormalVariantRow {
  id: string;
  sku_code: string;
  gtin_normalized: string | null;
}

/**
 * Busca só os candidatos relevantes (por código/EAN presentes NESTA nota) —
 * nunca a tabela toda. Sempre restrito a product_type='normal'.
 *
 * CORREÇÃO — causa raiz do "EAN já cadastrado não reconhece automaticamente":
 * antes filtrava pela coluna CRUA (.in("gtin", eans)), sem normalizar — uma
 * diferença de espaço/pontuação entre o EAN da NF e o gravado fazia o
 * produto nunca sequer ENTRAR nesta lista de candidatos (a normalização em
 * memória de resolveInvoiceItem nunca chegava a rodar sobre ele). Agora
 * filtra por gtin_normalized (mantida por trigger — ver migration 0046),
 * usando exatamente a mesma normalização (normalizeEan) do lado da NF.
 */
async function fetchNormalCandidates(codes: string[], eans: string[]): Promise<NormalVariantCandidate[]> {
  const supabase = getSupabase();
  const cleanCodes = Array.from(new Set(codes.filter((c) => c && c.trim())));
  const cleanEans = Array.from(new Set(eans.map(normalizeEan).filter((e) => isValidEanFormat(e))));
  if (cleanCodes.length === 0 && cleanEans.length === 0) return [];

  const [byCode, byEan] = await Promise.all([
    cleanCodes.length > 0
      ? supabase.from("product_variants").select("id, sku_code, gtin_normalized, products!inner(product_type)").eq("products.product_type", "normal").in("sku_code", cleanCodes)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    cleanEans.length > 0
      ? supabase.from("product_variants").select("id, sku_code, gtin_normalized, products!inner(product_type)").eq("products.product_type", "normal").in("gtin_normalized", cleanEans)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (byCode.error) throw byCode.error;
  if (byEan.error) throw byEan.error;

  const merged = new Map<string, NormalVariantCandidate>();
  for (const row of [...((byCode.data as unknown as NormalVariantRow[]) || []), ...((byEan.data as unknown as NormalVariantRow[]) || [])]) {
    merged.set(row.id, { variant_id: row.id, sku_code: row.sku_code, gtin_normalized: row.gtin_normalized });
  }
  return Array.from(merged.values());
}

interface NormalProductNameRow {
  id: string;
  sku_code: string;
  gtin: string | null;
  products: { name: string } | { name: string }[] | null;
}

/**
 * Busca TODOS os produtos normais ativos — usado só pra sugestão por
 * semelhança de nome (suggestBestMatch em nfeMatching.ts) quando
 * SKU/EAN/alias não resolveram nada. Sempre product_type='normal'.
 *
 * BUG REAL encontrado e corrigido durante a verificação: o Supabase (via
 * PostgREST) tem um teto de linhas por requisição (confirmado na prática:
 * 1000, mesmo pedindo mais via .limit()/.range()) — com o catálogo real de
 * ~2.650 produtos normais já importados, uma única chamada só trazia os
 * primeiros 1000 e "esquecia" o resto silenciosamente, sem erro nenhum.
 * Agora pagina em blocos de 1000 até a página vir incompleta (fim dos dados).
 */
export async function fetchAllNormalProducts(): Promise<NameCandidate[]> {
  const supabase = getSupabase();
  const PAGE_SIZE = 1000;
  const rows: NormalProductNameRow[] = [];

  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("product_variants")
      .select("id, sku_code, gtin, products!inner(name, product_type)")
      .eq("products.product_type", "normal")
      .eq("active", true)
      // BUG REAL corrigido: sem order(), o Postgres não garante a mesma
      // ordem de linhas entre chamadas .range() separadas — linhas podiam
      // aparecer em duas páginas (duplicadas) ou em nenhuma (perdidas).
      // order() por uma coluna estável (id) torna a paginação determinística.
      .order("id")
      .range(from, to);
    if (error) throw error;

    const batch = (data as unknown as NormalProductNameRow[]) || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return rows.map((row) => {
    const product = Array.isArray(row.products) ? row.products[0] : row.products;
    return { variant_id: row.id, sku_code: row.sku_code, produto: product?.name ?? "", gtin: row.gtin };
  });
}

interface AliasCodeRow {
  invoice_product_code: string | null;
  product_variant_id: string;
}

interface AliasEanRow {
  ean_normalized: string | null;
  product_variant_id: string;
}

/**
 * CORREÇÃO — mesmo bug de fetchNormalCandidates: filtrava `.in("ean", eans)`
 * pela coluna crua, então uma associação memorizada com EAN formatado
 * diferente do que vem na NF nunca era encontrada. Agora usa ean_normalized
 * (mantida por trigger — migration 0046) dos dois lados da comparação.
 */
async function fetchAliasMaps(codes: string[], eans: string[]): Promise<AliasMaps> {
  const supabase = getSupabase();
  const cleanCodes = Array.from(new Set(codes.filter((c) => c && c.trim())));
  const cleanEans = Array.from(new Set(eans.map(normalizeEan).filter((e) => isValidEanFormat(e))));
  const byCode = new Map<string, string>();
  const byEan = new Map<string, string>();
  if (cleanCodes.length === 0 && cleanEans.length === 0) return { byCode, byEan };

  const [codeRes, eanRes] = await Promise.all([
    cleanCodes.length > 0
      ? supabase.from("invoice_sku_aliases").select("invoice_product_code, product_variant_id").in("invoice_product_code", cleanCodes)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    cleanEans.length > 0
      ? supabase.from("invoice_sku_aliases").select("ean_normalized, product_variant_id").in("ean_normalized", cleanEans)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (codeRes.error) throw codeRes.error;
  if (eanRes.error) throw eanRes.error;

  for (const row of (codeRes.data as unknown as AliasCodeRow[]) || []) {
    if (row.invoice_product_code) byCode.set(normalizeKey(row.invoice_product_code), row.product_variant_id);
  }
  for (const row of (eanRes.data as unknown as AliasEanRow[]) || []) {
    if (row.ean_normalized) byEan.set(row.ean_normalized, row.product_variant_id);
  }
  return { byCode, byEan };
}

export interface CreateReceiptResult {
  receipt: InvoiceReceipt;
  items: InvoiceReceiptItem[];
}

/** Cria a nota + já resolve automaticamente (SKU > EAN > alias) o que der — o resto fica 'unlinked' pra resolução manual na tela de preparação. */
export async function createReceiptFromParsed(parsed: NfeParsed, xml: string): Promise<CreateReceiptResult> {
  const supabase = getSupabase();
  const createdBy = requireUserId();

  const codes = parsed.items.map((i) => i.invoice_product_code);
  const eans = parsed.items.map((i) => i.ean).filter((e): e is string => !!e);
  const [candidates, aliases] = await Promise.all([fetchNormalCandidates(codes, eans), fetchAliasMaps(codes, eans)]);

  const { data: receiptRow, error: receiptError } = await supabase
    .from("invoice_receipts")
    .insert({
      invoice_key: parsed.invoice_key,
      invoice_number: parsed.invoice_number,
      series: parsed.series,
      supplier_name: parsed.supplier_name,
      supplier_cnpj: parsed.supplier_cnpj,
      issued_at: parsed.issued_at,
      xml,
      status: "not_started",
      created_by: createdBy,
    })
    .select()
    .single();
  if (receiptError) throw receiptError;
  const receipt = receiptRow as InvoiceReceipt;

  const itemRows = parsed.items.map((item) => {
    const resolved = resolveInvoiceItem({ invoice_product_code: item.invoice_product_code, ean: item.ean }, candidates, aliases);
    // Diagnóstico (seção 14 do pedido) — só em desenvolvimento, nunca exposto ao operador.
    if (import.meta.env.DEV) {
      console.debug("[GoScan NF Match]", {
        descricao: item.description,
        cProd: item.invoice_product_code,
        eanOriginal: item.ean,
        eanNormalizado: normalizeEan(item.ean),
        encontrado: resolved.variant_id !== null,
        criterio: resolved.link_source,
      });
    }
    return {
      receipt_id: receipt.id,
      product_variant_id: resolved.variant_id,
      invoice_product_code: item.invoice_product_code,
      description: item.description,
      ean: item.ean,
      unit: item.unit,
      unit_value: item.unit_value,
      total_value: item.total_value,
      expected_quantity: item.quantity,
      status: resolved.variant_id ? "pending" : "unlinked",
      link_source: resolved.link_source,
    };
  });

  const { data: insertedItems, error: itemsError } = await supabase.from("invoice_receipt_items").insert(itemRows).select();
  if (itemsError) throw itemsError;

  return { receipt, items: (insertedItems as InvoiceReceiptItem[]) || [] };
}

/** Vínculo manual (busca do operador na tela de preparação) — sempre marca link_source='manual'. */
export async function resolveItemManually(
  itemId: string,
  variantId: string,
  opts?: { memorize?: boolean; invoiceProductCode?: string | null; ean?: string | null }
): Promise<InvoiceReceiptItem> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("invoice_receipt_items")
    .update({ product_variant_id: variantId, link_source: "manual", status: "pending" })
    .eq("id", itemId)
    .select()
    .single();
  if (error) throw error;

  if (opts?.memorize) {
    await memorizeAlias({ invoiceProductCode: opts.invoiceProductCode ?? null, ean: opts.ean ?? null, variantId });
  }

  return data as InvoiceReceiptItem;
}

/** "Memorizar associação" — só usada como fallback em NFs futuras (ver resolveInvoiceItem), nunca sobrepõe SKU/EAN exatos. */
export async function memorizeAlias(input: { invoiceProductCode: string | null; ean: string | null; variantId: string }): Promise<void> {
  const supabase = getSupabase();
  const createdBy = requireUserId();
  const code = input.invoiceProductCode?.trim() || null;
  const ean = input.ean?.trim() || null;
  if (!code && !ean) return;

  // Índices únicos parciais são separados (invoice_product_code / ean) — só dá pra
  // dar onConflict em um de cada vez. Prioriza o código (mais específico ao fornecedor).
  const conflictTarget = code ? "invoice_product_code" : "ean";
  const { error } = await supabase
    .from("invoice_sku_aliases")
    .upsert({ invoice_product_code: code, ean: code ? null : ean, product_variant_id: input.variantId, created_by: createdBy }, { onConflict: conflictTarget });
  if (error) throw error;
}

/** Chamado ao entrar na tela de contagem — no-op se já não estiver 'not_started'. Marca started_at só na 1ª vez (usado no cabeçalho do relatório final). */
export async function startCounting(receiptId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("invoice_receipts")
    .update({ status: "in_progress", started_at: new Date().toISOString() })
    .eq("id", receiptId)
    .eq("status", "not_started");
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// CORREÇÃO ESTRUTURAL — Conferência Colaborativa Segura (ver
// 0043_collab_conference_rpcs.sql). record_invoice_count_event agora devolve
// um resultado RICO em jsonb (não mais a linha crua da tabela) porque passou
// a cobrir 3 desfechos possíveis, nunca silenciosos:
//   - sucesso normal (code "OK"), com total/restante/conclusão/excesso;
//   - RESERVATION_CONFLICT: outro operador já reservou este item (modo
//     "product") — nada é gravado, o chamador decide (ir pra outro produto/
//     solicitar colaboração/assumir se inativo/cancelar);
//   - EXCESS_CONFIRMATION_REQUIRED: esta bipagem ultrapassaria a quantidade
//     da NF — nada é gravado até reenviar com confirmExcess=true (o servidor
//     recalcula tudo de novo nesse reenvio, nunca reaplica um cálculo velho).
// ---------------------------------------------------------------------------
export interface CountEventSuccess {
  success: true;
  code: "OK";
  item: InvoiceReceiptItem;
  newTotal: number;
  expectedQuantity: number;
  remaining: number;
  itemCompleted: boolean;
  firstCompletion: boolean;
  excess: number;
  performedBy: string | null;
  eventId: string | null;
}

export interface ReservationConflictInfo {
  userId: string;
  fullName: string;
  since: string;
  lastActivity: string;
}

export interface CountEventReservationConflict {
  success: false;
  code: "RESERVATION_CONFLICT";
  reservation: ReservationConflictInfo;
}

export interface CountEventExcessConfirmationRequired {
  success: false;
  code: "EXCESS_CONFIRMATION_REQUIRED";
  currentTotal: number;
  attemptedTotal: number;
  expectedQuantity: number;
  completedBy: string | null;
  completedAt: string | null;
}

export type CountEventResult = CountEventSuccess | CountEventReservationConflict | CountEventExcessConfirmationRequired;

export interface CountEventOptions {
  /** Identifica o dispositivo físico (não o usuário) — usado pra reserva e auditoria. */
  deviceId?: string;
  /** Como esta contagem foi originada — nunca inventado, sempre o canal real usado. */
  origin?: "scanner" | "camera" | "manual" | "voice";
  volumeId?: string | null;
  /** Reenvio explícito e deliberado depois de EXCESS_CONFIRMATION_REQUIRED. */
  confirmExcess?: boolean;
  idempotencyKey?: string;
}

/**
 * CORREÇÃO ESTRUTURAL — Concorrência segura: antes lia count_number/
 * physical_quantity e sobrescrevia em duas chamadas separadas (janela real de
 * corrida entre duas bipagens concorrentes no mesmo item — ver migration
 * 0039_atomic_scan_events.sql). Agora delega inteiramente pra
 * record_invoice_count_event(), que trava a linha no banco e faz tudo (evento
 * + receipt_counts + physical_quantity + reserva + excesso) numa única
 * transação atômica.
 *
 * idempotencyKey: gerado pelo chamador (crypto.randomUUID()) e REUTILIZADO em
 * caso de retry — o banco garante que a mesma tentativa nunca é aplicada duas
 * vezes, mesmo que o retry aconteça por falha de rede após o servidor já ter
 * processado a primeira chamada. Também é reutilizada no reenvio explícito
 * com confirmExcess=true (a 1ª tentativa nunca grava nada quando pede
 * confirmação, então reaproveitar a chave é seguro).
 *
 * mode='set': define o valor absoluto (usado pela recontagem manual e pelo
 * card "Confirmar item"). mode='increment': soma um delta ATOMICAMENTE no
 * banco (bipagem por EAN/scanner/câmera/voz — nunca calcula "atual + 1" no
 * frontend).
 */
async function recordCountEvent(itemId: string, value: number, mode: "set" | "increment", opts: CountEventOptions = {}): Promise<CountEventResult> {
  const supabase = getSupabase();
  const key = opts.idempotencyKey ?? crypto.randomUUID();
  const { data, error } = await supabase.rpc("record_invoice_count_event", {
    p_item_id: itemId,
    p_delta: value,
    p_mode: mode,
    p_idempotency_key: key,
    p_device_id: opts.deviceId ?? null,
    p_origin: opts.origin ?? "manual",
    p_volume_id: opts.volumeId ?? null,
    p_confirm_excess: opts.confirmExcess ?? false,
  });
  if (error) throw error;
  return data as CountEventResult;
}

/** Define a quantidade física ABSOLUTA de um item (recontagem/"Confirmar item"). */
export async function submitCount(itemId: string, quantity: number, opts?: CountEventOptions): Promise<CountEventResult> {
  return recordCountEvent(itemId, quantity, "set", opts);
}

/** Soma `delta` à quantidade física ATUAL de forma atômica (bipagem por EAN/scanner/câmera/voz). */
export async function submitCountDelta(itemId: string, delta: number, opts?: CountEventOptions): Promise<CountEventResult> {
  return recordCountEvent(itemId, delta, "increment", opts);
}

export interface UndoCountResult {
  success: boolean;
  item: InvoiceReceiptItem;
  newTotal: number;
  expectedQuantity?: number;
  performedBy?: string | null;
  undoneEventId: string;
  eventId: string | null;
}

/** "Desfazer minha última bipagem" (seção 13) — nunca apaga o evento original, grava um evento compensatório referenciando-o. */
export async function undoLastCount(eventId: string, reason?: string, idempotencyKey?: string): Promise<UndoCountResult> {
  const supabase = getSupabase();
  const key = idempotencyKey ?? crypto.randomUUID();
  const { data, error } = await supabase.rpc("undo_last_invoice_count_event", {
    p_event_id: eventId,
    p_idempotency_key: key,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return data as UndoCountResult;
}

export interface ReservationState {
  id: string;
  itemId: string;
  userId: string;
  expiresAt: string;
}

export type ReserveItemResult =
  | { success: true; code: "OK"; reservation: ReservationState }
  | { success: false; code: "RESERVATION_CONFLICT"; reservation: ReservationConflictInfo };

/** Reserva explícita de um item no modo "product" (ao abrir/tocar o produto pra contar, antes mesmo de bipar). */
export async function reserveItem(itemId: string, deviceId: string, volumeId?: string | null): Promise<ReserveItemResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("reserve_invoice_receipt_item", {
    p_item_id: itemId,
    p_device_id: deviceId,
    p_volume_id: volumeId ?? null,
  });
  if (error) throw error;
  return data as ReserveItemResult;
}

/** Renovação periódica da reserva enquanto o operador continua na tela do produto — chamado a cada ~30s. */
export async function heartbeatReservation(reservationId: string): Promise<{ success: boolean; code: string; expiresAt?: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("heartbeat_invoice_receipt_item_reservation", { p_reservation_id: reservationId });
  if (error) throw error;
  return data;
}

/** Libera a reserva ativa de um item — pelo próprio dono (mudou de produto) ou por um gerente/admin ("liberação por supervisor"). */
export async function releaseReservation(itemId: string, reason: string = "manual"): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("release_invoice_receipt_item_reservation", { p_item_id: itemId, p_reason: reason });
  if (error) throw error;
}

export interface ReceiptVolume {
  id: string;
  receipt_id: string;
  label: string;
  created_by: string;
  created_at: string;
}

export async function listVolumes(receiptId: string): Promise<ReceiptVolume[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("invoice_receipt_volumes").select("*").eq("receipt_id", receiptId).order("created_at", { ascending: true });
  if (error) throw error;
  return (data as ReceiptVolume[]) || [];
}

/** Cria um volume físico simples (Caixa 01, Pallet 02…) — texto livre, não é um módulo de WMS. */
export async function createVolume(receiptId: string, label: string): Promise<ReceiptVolume> {
  const supabase = getSupabase();
  const createdBy = requireUserId();
  const { data, error } = await supabase.from("invoice_receipt_volumes").insert({ receipt_id: receiptId, label: label.trim(), created_by: createdBy }).select().single();
  if (error) throw error;
  return data as ReceiptVolume;
}

/** Define o modo de divisão do trabalho da conferência colaborativa — escolhido uma vez, ao iniciar a contagem. */
export async function setWorkMode(receiptId: string, mode: WorkMode): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("invoice_receipts").update({ work_mode: mode }).eq("id", receiptId);
  if (error) throw error;
}

export async function listItemCounts(itemId: string): Promise<ReceiptCount[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("receipt_counts").select("*").eq("item_id", itemId).order("count_number", { ascending: true });
  if (error) throw error;
  return (data as ReceiptCount[]) || [];
}

interface VariantJoinForItem {
  sku_code: string;
  gtin: string | null;
  products: { name: string } | { name: string }[] | null;
}

export interface InvoiceReceiptWithNames extends InvoiceReceipt {
  created_by_name: string | null;
  finished_by_name: string | null;
}

interface ProfileNameJoin {
  full_name: string | null;
}

export async function getReceipt(receiptId: string): Promise<{ receipt: InvoiceReceiptWithNames; items: InvoiceReceiptItem[] }> {
  const supabase = getSupabase();
  // FKs explícitas (created_by/finished_by apontam pra profiles) — ver
  // comentário em findReceiptByInvoiceKey sobre o erro PGRST201 de embed ambíguo.
  const [{ data: receipt, error: rErr }, { data: items, error: iErr }] = await Promise.all([
    supabase
      .from("invoice_receipts")
      .select("*, creator:profiles!invoice_receipts_created_by_fkey(full_name), finisher:profiles!invoice_receipts_finished_by_fkey(full_name)")
      .eq("id", receiptId)
      .single(),
    supabase
      .from("invoice_receipt_items")
      // EXPANSÃO GOSCAN — Exibição de EAN no card de conferência: gtin
      // incluído no MESMO join já existente (nunca uma consulta por item).
      .select("*, product_variants(sku_code, gtin, products(name))")
      .eq("receipt_id", receiptId)
      .order("created_at", { ascending: true }),
  ]);
  if (rErr) throw rErr;
  if (iErr) throw iErr;

  const receiptRow = receipt as InvoiceReceipt & { creator: ProfileNameJoin | ProfileNameJoin[] | null; finisher: ProfileNameJoin | ProfileNameJoin[] | null };
  const { creator, finisher, ...receiptFields } = receiptRow;
  const creatorObj = Array.isArray(creator) ? creator[0] : creator;
  const finisherObj = Array.isArray(finisher) ? finisher[0] : finisher;
  const receiptWithNames: InvoiceReceiptWithNames = {
    ...receiptFields,
    created_by_name: creatorObj?.full_name ?? null,
    finished_by_name: finisherObj?.full_name ?? null,
  };

  const mapped = ((items as (InvoiceReceiptItem & { product_variants: VariantJoinForItem | null })[]) || []).map(({ product_variants: v, ...item }) => {
    const productObj = v?.products;
    const produto = Array.isArray(productObj) ? productObj[0]?.name : productObj?.name;
    return { ...item, sku_code: v?.sku_code ?? null, produto: produto ?? null, catalog_ean: v?.gtin ?? null };
  });

  return { receipt: receiptWithNames, items: mapped };
}

export interface FinalizeResult {
  receipt: InvoiceReceiptWithNames;
  items: InvoiceReceiptItem[];
  summary: ReceiptSummary;
}

export type FinalizeOutcome =
  | ({ ok: true } & FinalizeResult)
  | { ok: false; alreadyFinalized: true; finishedByName: string | null; finishedAt: string | null; status: ReceiptStatus };

/**
 * CORREÇÃO ESTRUTURAL — Finalização colaborativa atômica (seção 21 do
 * pedido). Antes, esta função recalculava e gravava em VÁRIAS chamadas
 * separadas do cliente sem nenhum lock — dois usuários finalizando quase ao
 * mesmo tempo podiam os dois recalcular e escrever, um sobrescrevendo o
 * finished_by/finished_at do outro silenciosamente. Agora TUDO (recálculo de
 * status/snapshot + transição de status da NF) acontece dentro de
 * finalize_invoice_receipt_atomic() (ver 0044), com a NF travada — quem
 * chegar depois do primeiro commit recebe ALREADY_FINALIZED de volta, nunca
 * reprocessa nem sobrescreve. Idempotente pra recontagem: pode ser chamada de
 * novo (só reabre-se implicitamente porque uma recontagem de manager/admin já
 * teria voltado o status, ver RLS) para recalcular o resultado.
 */
export async function finalizeReceipt(receiptId: string, opts: { recompute?: boolean } = {}): Promise<FinalizeOutcome> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("finalize_invoice_receipt_atomic", { p_receipt_id: receiptId, p_recompute: opts.recompute ?? false });
  if (error) throw error;
  const result = data as { success: boolean; code: string; status?: ReceiptStatus; finishedBy?: string | null; finishedAt?: string | null };

  if (!result.success && result.code === "ALREADY_FINALIZED") {
    let finishedByName: string | null = null;
    if (result.finishedBy) {
      const { data: p } = await supabase.from("profiles").select("full_name").eq("id", result.finishedBy).maybeSingle();
      finishedByName = (p as { full_name: string | null } | null)?.full_name ?? null;
    }
    return { ok: false, alreadyFinalized: true, finishedByName, finishedAt: result.finishedAt ?? null, status: result.status ?? "with_divergences" };
  }

  // Busca de novo já com o nome de quem finalizou (join) e os itens com o snapshot/status recém-gravados pela RPC.
  const { receipt: refreshedReceipt, items: refreshedItems } = await getReceipt(receiptId);
  const summary = summarizeReceipt(refreshedItems.map((r) => ({ expected_quantity: r.expected_quantity, physical_quantity: r.physical_quantity })));
  return { ok: true, receipt: refreshedReceipt, items: refreshedItems, summary };
}

export interface ReceiptWithCounts extends InvoiceReceipt {
  operator_name: string | null;
  item_count: number;
}

interface HistoryRow extends InvoiceReceipt {
  profiles: { full_name: string | null } | { full_name: string | null }[] | null;
  invoice_receipt_items: { count: number }[];
}

/**
 * Exclui uma NF importada por engano (ver migration 0026: RLS restringe a
 * exclusão ao próprio operador enquanto not_started/in_progress, ou a
 * manager/admin em qualquer status). invoice_receipt_items/receipt_counts
 * são removidos junto via "on delete cascade".
 *
 * RLS nega silenciosamente (0 linhas afetadas, sem erro) quando a policy não
 * bate — por isso confere de verdade quantas linhas vieram de volta, senão o
 * botão "Excluir" pareceria funcionar sem ter apagado nada.
 */
export async function deleteReceipt(receiptId: string): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("invoice_receipts").delete().eq("id", receiptId).select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("Não foi possível excluir esta NF — ela já foi finalizada. Apenas um gerente/admin pode excluir notas finalizadas.");
  }
}

export async function listReceiptHistory(limit = 20): Promise<ReceiptWithCounts[]> {
  const supabase = getSupabase();
  // Mesmo ajuste de FK explícita que findReceiptByInvoiceKey (ver comentário lá).
  const { data, error } = await supabase
    .from("invoice_receipts")
    .select("*, profiles!invoice_receipts_created_by_fkey(full_name), invoice_receipt_items(count)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return ((data as unknown as HistoryRow[]) || []).map(({ profiles, invoice_receipt_items, ...receipt }) => {
    const operator = Array.isArray(profiles) ? profiles[0] : profiles;
    const itemCount = invoice_receipt_items?.[0]?.count ?? 0;
    return { ...receipt, operator_name: operator?.full_name ?? null, item_count: itemCount };
  });
}
