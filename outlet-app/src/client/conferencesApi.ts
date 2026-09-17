import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";
import { escapeOrFilterValue } from "./utils.ts";

export type ConferenceStatus = "draft" | "in_progress" | "completed" | "cancelled";
export type ItemSource = "manual" | "text" | "screenshot" | "import" | "camera_scan";
export type ItemMatchStatus = "matched" | "partial" | "manual" | "unresolved";

export interface Conference {
  id: string;
  name: string | null;
  status: ConferenceStatus;
  operator_id: string;
  started_at: string;
  finished_at: string | null;
  notes: string | null;
  total_units: number;
  total_skus: number;
  created_at: string;
  updated_at: string;
}

export interface ConferenceItem {
  id: string;
  conference_id: string;
  product_variant_id: string | null;
  raw_model: string | null;
  raw_color: string | null;
  quantity: number;
  match_status: ItemMatchStatus;
  match_confidence: number | null;
  source: ItemSource;
  recognition_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function requireUserId(): string {
  const { session } = getAuthState();
  if (!session) throw new Error("Sessão inválida — faça login novamente.");
  return session.user.id;
}

export async function createConference(name?: string): Promise<Conference> {
  const supabase = getSupabase();
  const operatorId = requireUserId();
  const { data, error } = await supabase
    .from("conferences")
    .insert({ name: name || null, status: "draft", operator_id: operatorId })
    .select()
    .single();
  if (error) throw error;
  return data as Conference;
}

export interface ConferenceItemWithVariant extends ConferenceItem {
  sku_code: string | null;
  produto: string | null;
}

interface VariantJoin {
  sku_code: string;
  color: string | null;
  products: { name: string } | { name: string }[] | null;
}

function mapConferenceItemWithVariant({ product_variants: variant, ...item }: ConferenceItem & { product_variants: VariantJoin | null }): ConferenceItemWithVariant {
  const productObj = variant?.products;
  const produto = Array.isArray(productObj) ? productObj[0]?.name : productObj?.name;
  return { ...item, sku_code: variant?.sku_code ?? null, produto: produto ?? null };
}

export async function getConference(id: string): Promise<{ conference: Conference; items: ConferenceItemWithVariant[] }> {
  const supabase = getSupabase();
  const [{ data: conference, error: cErr }, { data: items, error: iErr }] = await Promise.all([
    supabase.from("conferences").select("*").eq("id", id).single(),
    supabase
      .from("conference_items")
      .select("*, product_variants(sku_code, color, products(name))")
      .eq("conference_id", id)
      .order("created_at", { ascending: true }),
  ]);
  if (cErr) throw cErr;
  if (iErr) throw iErr;

  const mapped = ((items as (ConferenceItem & { product_variants: VariantJoin | null })[]) || []).map(mapConferenceItemWithVariant);

  return { conference: conference as Conference, items: mapped };
}

export interface ConferenceFinalSummary {
  conference: ConferenceWithOperator;
  items: ConferenceItemWithVariant[];
  /** Itens sem product_variant_id — "para revisão", NUNCA chamado de divergência (Outlet não tem esperado × físico). */
  unresolvedCount: number;
  matchStatusCounts: Record<ItemMatchStatus, number>;
}

/**
 * FASE 4 — Resumo Final Padronizado (Outlet). Igual a getConference, mas
 * também junta profiles pra ter operator_name (getConference não precisa
 * disso hoje — outras telas que já o consomem continuam com o mesmo
 * contrato, sem quebra) — mesmo mapeamento de item (mapConferenceItemWithVariant),
 * nunca duplicado. Uma única ida ao banco (conference+items em paralelo),
 * sem N+1.
 */
export async function getConferenceFinalSummary(id: string): Promise<ConferenceFinalSummary> {
  const supabase = getSupabase();
  const [{ data: conference, error: cErr }, { data: items, error: iErr }] = await Promise.all([
    supabase.from("conferences").select("*, profiles(full_name)").eq("id", id).single(),
    supabase
      .from("conference_items")
      .select("*, product_variants(sku_code, color, products(name))")
      .eq("conference_id", id)
      .order("created_at", { ascending: true }),
  ]);
  if (cErr) throw cErr;
  if (iErr) throw iErr;

  const mappedConference = mapConferenceWithOperator(conference as Conference & { profiles: OperatorJoin | OperatorJoin[] | null });
  const mappedItems = ((items as (ConferenceItem & { product_variants: VariantJoin | null })[]) || []).map(mapConferenceItemWithVariant);
  const unresolvedCount = mappedItems.filter((i) => !i.product_variant_id).length;
  const matchStatusCounts: Record<ItemMatchStatus, number> = { matched: 0, partial: 0, manual: 0, unresolved: 0 };
  for (const i of mappedItems) matchStatusCounts[i.match_status]++;

  return { conference: mappedConference, items: mappedItems, unresolvedCount, matchStatusCounts };
}

/** Conferência draft/in_progress mais recente do operador logado — para "Continuar conferência". */
export async function getMyActiveConference(): Promise<Conference | null> {
  const supabase = getSupabase();
  const operatorId = requireUserId();
  const { data, error } = await supabase
    .from("conferences")
    .select("*")
    .eq("operator_id", operatorId)
    .in("status", ["draft", "in_progress"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Conference) || null;
}

export interface ConferenceWithOperator extends Conference {
  operator_name: string | null;
}

interface OperatorJoin {
  full_name: string | null;
}

export interface HomeOperationalSummary {
  outletConferences: number;
  outletUnits: number;
  outletSkuIds: string[];
  nfeReceipts: number;
  nfeUnits: number;
  nfeSkuIds: string[];
}

/**
 * HOME OPERACIONAL 2.0 — resumo do período (bloco "Operação de hoje"), 100%
 * derivado dos eventos reais de contagem (nunca de aproximação por
 * updated_at/physical_quantity corrente — ver migration 0057). Cobre Outlet
 * E NF-e numa única chamada porque a RPC agrega os dois lados no banco (nunca
 * baixa evento nenhum pro navegador, só os totais já prontos).
 *
 * periodStart/periodEnd definem [início, fim) — o FRONTEND decide o que é
 * "hoje" (dia local do operador, ver todayLocalRangeIso em utils.ts); o
 * servidor nunca assume um fuso horário sozinho.
 */
export async function getHomeOperationalSummary(periodStart: string, periodEnd: string): Promise<HomeOperationalSummary> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("get_home_operational_summary", {
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });
  if (error) throw error;
  return data as HomeOperationalSummary;
}

function mapConferenceWithOperator(row: Conference & { profiles: OperatorJoin | OperatorJoin[] | null }): ConferenceWithOperator {
  const { profiles, ...conference } = row;
  const operator = Array.isArray(profiles) ? profiles[0] : profiles;
  return { ...conference, operator_name: operator?.full_name ?? null };
}

export async function listRecentConferences(limit = 10): Promise<ConferenceWithOperator[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("conferences")
    .select("*, profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return ((data as unknown as (Conference & { profiles: OperatorJoin | OperatorJoin[] | null })[]) || []).map(mapConferenceWithOperator);
}

export interface VisibleOperator {
  id: string;
  full_name: string | null;
}

/**
 * HISTÓRICO — FASE 2 (filtro por operador). Reaproveita a policy de SELECT
 * já existente em profiles (própria linha, ou todas se manager/admin — ver
 * 0002_rls_policies.sql, não alterada aqui) — nunca busca "todos os usuários
 * da empresa" por fora dela: a própria RLS já limita o que volta pra cada
 * papel, sem código extra de permissão neste arquivo.
 */
export async function listVisibleOperators(): Promise<VisibleOperator[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("profiles").select("id, full_name").order("full_name", { ascending: true });
  if (error) throw error;
  return (data as VisibleOperator[]) || [];
}

export interface ConferenceHistoryFilters {
  search?: string;
  /** Ids de operador cujo nome bateu com `search` (resolvidos pelo chamador a partir de listVisibleOperators — mesma lista já usada no seletor de operador, sem consulta extra). */
  searchOperatorIds?: string[];
  status?: ConferenceStatus | "all";
  operatorId?: string | "all";
  /** [início, fim) em ISO — ver parseLocalDateRangeIso em utils.ts. */
  dateFrom?: string | null;
  dateTo?: string | null;
  limit: number;
  offset: number;
}

export interface ConferenceHistoryPage {
  items: ConferenceWithOperator[];
  total: number;
  hasMore: boolean;
}

/**
 * HISTÓRICO — FASE 2. Pesquisa/filtra/pagina no servidor (nunca baixa o
 * histórico inteiro pro navegador) — count exato e página de dados na MESMA
 * requisição (`{ count: "exact" }` + `.range()`), nunca duas consultas
 * completas separadas. Pesquisa por nome/protocolo/operador vira um único
 * `or()` no banco; "protocolo" é sempre os 8 primeiros caracteres do próprio
 * UUID (nunca uma coluna nova — ver protocol() em history.ts), buscado via
 * cast `id::text` (recurso padrão do PostgREST, sem exigir schema novo).
 */
export async function searchConferenceHistory(filters: ConferenceHistoryFilters): Promise<ConferenceHistoryPage> {
  const supabase = getSupabase();
  let query = supabase.from("conferences").select("*, profiles(full_name)", { count: "exact" }).order("created_at", { ascending: false });

  if (filters.status && filters.status !== "all") {
    query = query.eq("status", filters.status);
  }
  if (filters.operatorId && filters.operatorId !== "all") {
    query = query.eq("operator_id", filters.operatorId);
  }
  if (filters.dateFrom) query = query.gte("created_at", filters.dateFrom);
  if (filters.dateTo) query = query.lt("created_at", filters.dateTo);

  const term = filters.search?.trim();
  if (term) {
    const pattern = `%${term}%`;
    const orParts = [`name.ilike.${escapeOrFilterValue(pattern)}`];
    const protocolPrefix = term.replace(/\s+/g, "");
    if (protocolPrefix) {
      orParts.push(`id::text.ilike.${escapeOrFilterValue(`${protocolPrefix}%`)}`);
    }
    if (filters.searchOperatorIds && filters.searchOperatorIds.length > 0) {
      orParts.push(`operator_id.in.(${filters.searchOperatorIds.join(",")})`);
    }
    query = query.or(orParts.join(","));
  }

  const { data, error, count } = await query.range(filters.offset, filters.offset + filters.limit - 1);
  if (error) throw error;

  const items = ((data as unknown as (Conference & { profiles: OperatorJoin | OperatorJoin[] | null })[]) || []).map(mapConferenceWithOperator);
  const total = count ?? items.length;
  return { items, total, hasMore: filters.offset + items.length < total };
}

/**
 * CORREÇÃO ESTRUTURAL — soma `delta` à quantidade ATUAL de forma atômica no
 * banco (record_conference_item_delta, ver migration
 * 0039_atomic_scan_events.sql), em vez de calcular "quantidade atual + delta"
 * no frontend e sobrescrever — dois usuários ajustando o mesmo item ao mesmo
 * tempo (stepper +/-) podiam perder um incremento um do outro.
 * idempotencyKey evita reaplicar o mesmo ajuste em caso de retry de rede.
 */
export async function updateItemQuantityDelta(itemId: string, delta: number, idempotencyKey?: string): Promise<ConferenceItem> {
  const supabase = getSupabase();
  const key = idempotencyKey ?? crypto.randomUUID();
  const { data, error } = await supabase.rpc("record_conference_item_delta", {
    p_item_id: itemId,
    p_delta: delta,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as ConferenceItem;
}

export async function markInProgress(conferenceId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("conferences")
    .update({ status: "in_progress" })
    .eq("id", conferenceId)
    .eq("status", "draft");
  if (error) throw error;
}

export interface NewItemInput {
  conference_id: string;
  product_variant_id: string | null;
  raw_model: string;
  raw_color: string;
  quantity: number;
  match_status: ItemMatchStatus;
  source: ItemSource;
  match_confidence?: number | null;
  recognition_id?: string | null;
}

export async function addItem(input: NewItemInput): Promise<ConferenceItem> {
  const supabase = getSupabase();
  const createdBy = requireUserId();
  const { data, error } = await supabase
    .from("conference_items")
    .insert({ ...input, created_by: createdBy })
    .select()
    .single();
  if (error) throw error;
  return data as ConferenceItem;
}

export async function updateItem(itemId: string, patch: Partial<NewItemInput>): Promise<ConferenceItem> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("conference_items")
    .update(patch)
    .eq("id", itemId)
    .select()
    .single();
  if (error) throw error;
  return data as ConferenceItem;
}

export async function removeItem(itemId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("conference_items").delete().eq("id", itemId);
  if (error) throw error;
}

export interface FinalizeSummary {
  total_units: number;
  total_skus: number;
}

/** Consolida totais e passa a conferência para completed. */
export async function finalizeConference(conferenceId: string): Promise<FinalizeSummary> {
  const supabase = getSupabase();
  const { data: items, error: itemsError } = await supabase
    .from("conference_items")
    .select("quantity, product_variant_id")
    .eq("conference_id", conferenceId);
  if (itemsError) throw itemsError;

  const rows = (items as { quantity: number; product_variant_id: string | null }[]) || [];
  const total_units = rows.reduce((acc, r) => acc + (Number(r.quantity) || 0), 0);
  const distinctSkus = new Set(rows.map((r) => r.product_variant_id).filter(Boolean));
  const total_skus = distinctSkus.size;

  const { error } = await supabase
    .from("conferences")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      total_units,
      total_skus,
    })
    .eq("id", conferenceId);
  if (error) throw error;

  return { total_units, total_skus };
}
