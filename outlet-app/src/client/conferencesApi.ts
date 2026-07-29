import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";

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

  const mapped = ((items as (ConferenceItem & { product_variants: VariantJoin | null })[]) || []).map(
    ({ product_variants: variant, ...item }): ConferenceItemWithVariant => {
      const productObj = variant?.products;
      const produto = Array.isArray(productObj) ? productObj[0]?.name : productObj?.name;
      return { ...item, sku_code: variant?.sku_code ?? null, produto: produto ?? null };
    }
  );

  return { conference: conference as Conference, items: mapped };
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

export async function listRecentConferences(limit = 10): Promise<ConferenceWithOperator[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("conferences")
    .select("*, profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return ((data as unknown as (Conference & { profiles: OperatorJoin | OperatorJoin[] | null })[]) || []).map(
    ({ profiles, ...conference }) => {
      const operator = Array.isArray(profiles) ? profiles[0] : profiles;
      return { ...conference, operator_name: operator?.full_name ?? null };
    }
  );
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
