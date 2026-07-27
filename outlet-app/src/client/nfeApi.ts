// EXPANSÃO GOSCAN — Conferência por Nota Fiscal, Parte 3: CRUD via Supabase
// (mesmo padrão de conferencesApi.ts — RLS é a barreira real, aqui só
// modelamos as operações). Candidatos de resolução são buscados SEMPRE
// filtrados por products.product_type='normal' — um item de NF nunca pode
// ser vinculado a um SKU Outlet, mesmo que o texto pareça bater.
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";
import type { NfeParsed } from "./nfeParser.ts";
import {
  resolveInvoiceItem,
  normalizeKey,
  computeItemStatus,
  summarizeReceipt,
  type NormalVariantCandidate,
  type AliasMaps,
  type LinkSource,
  type ReceiptSummary,
  type NameCandidate,
} from "./nfeMatching.ts";

export type ReceiptStatus = "not_started" | "in_progress" | "completed" | "with_divergences";
export type ItemStatus = "pending" | "counted" | "ok" | "missing" | "surplus" | "unlinked";

export interface InvoiceReceipt {
  id: string;
  invoice_key: string;
  invoice_number: string | null;
  series: string | null;
  supplier_name: string | null;
  supplier_cnpj: string | null;
  issued_at: string | null;
  status: ReceiptStatus;
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
  gtin: string | null;
}

/** Busca só os candidatos relevantes (por código/EAN presentes NESTA nota) — nunca a tabela toda. Sempre restrito a product_type='normal'. */
async function fetchNormalCandidates(codes: string[], eans: string[]): Promise<NormalVariantCandidate[]> {
  const supabase = getSupabase();
  const cleanCodes = Array.from(new Set(codes.filter((c) => c && c.trim())));
  const cleanEans = Array.from(new Set(eans.filter((e) => e && e.trim())));
  if (cleanCodes.length === 0 && cleanEans.length === 0) return [];

  const [byCode, byEan] = await Promise.all([
    cleanCodes.length > 0
      ? supabase.from("product_variants").select("id, sku_code, gtin, products!inner(product_type)").eq("products.product_type", "normal").in("sku_code", cleanCodes)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    cleanEans.length > 0
      ? supabase.from("product_variants").select("id, sku_code, gtin, products!inner(product_type)").eq("products.product_type", "normal").in("gtin", cleanEans)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (byCode.error) throw byCode.error;
  if (byEan.error) throw byEan.error;

  const merged = new Map<string, NormalVariantCandidate>();
  for (const row of [...((byCode.data as unknown as NormalVariantRow[]) || []), ...((byEan.data as unknown as NormalVariantRow[]) || [])]) {
    merged.set(row.id, { variant_id: row.id, sku_code: row.sku_code, gtin: row.gtin });
  }
  return Array.from(merged.values());
}

interface NormalProductNameRow {
  id: string;
  sku_code: string;
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
      .select("id, sku_code, products!inner(name, product_type)")
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
    return { variant_id: row.id, sku_code: row.sku_code, produto: product?.name ?? "" };
  });
}

interface AliasRow {
  invoice_product_code: string | null;
  ean: string | null;
  product_variant_id: string;
}

async function fetchAliasMaps(codes: string[], eans: string[]): Promise<AliasMaps> {
  const supabase = getSupabase();
  const cleanCodes = Array.from(new Set(codes.filter((c) => c && c.trim())));
  const cleanEans = Array.from(new Set(eans.filter((e) => e && e.trim())));
  const byCode = new Map<string, string>();
  const byEan = new Map<string, string>();
  if (cleanCodes.length === 0 && cleanEans.length === 0) return { byCode, byEan };

  const [codeRes, eanRes] = await Promise.all([
    cleanCodes.length > 0
      ? supabase.from("invoice_sku_aliases").select("invoice_product_code, ean, product_variant_id").in("invoice_product_code", cleanCodes)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    cleanEans.length > 0
      ? supabase.from("invoice_sku_aliases").select("invoice_product_code, ean, product_variant_id").in("ean", cleanEans)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (codeRes.error) throw codeRes.error;
  if (eanRes.error) throw eanRes.error;

  for (const row of (codeRes.data as unknown as AliasRow[]) || []) {
    if (row.invoice_product_code) byCode.set(normalizeKey(row.invoice_product_code), row.product_variant_id);
  }
  for (const row of (eanRes.data as unknown as AliasRow[]) || []) {
    if (row.ean) byEan.set(normalizeKey(row.ean), row.product_variant_id);
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

/**
 * Registra uma contagem (inicial ou recontagem) — NUNCA sobrescreve o
 * histórico em receipt_counts, só acrescenta uma linha nova com count_number
 * incrementado. invoice_receipt_items.physical_quantity sempre reflete a
 * contagem MAIS RECENTE.
 */
export async function submitCount(itemId: string, quantity: number): Promise<InvoiceReceiptItem> {
  const supabase = getSupabase();
  const userId = requireUserId();

  const { data: prevCounts, error: prevError } = await supabase
    .from("receipt_counts")
    .select("count_number")
    .eq("item_id", itemId)
    .order("count_number", { ascending: false })
    .limit(1);
  if (prevError) throw prevError;
  const nextCountNumber = ((prevCounts as { count_number: number }[] | null)?.[0]?.count_number ?? 0) + 1;

  const { error: countError } = await supabase.from("receipt_counts").insert({ item_id: itemId, user_id: userId, quantity, count_number: nextCountNumber });
  if (countError) throw countError;

  const { data, error } = await supabase
    .from("invoice_receipt_items")
    .update({ physical_quantity: quantity, status: "counted", counted_by: userId })
    .eq("id", itemId)
    .select()
    .single();
  if (error) throw error;
  return data as InvoiceReceiptItem;
}

export async function listItemCounts(itemId: string): Promise<ReceiptCount[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("receipt_counts").select("*").eq("item_id", itemId).order("count_number", { ascending: true });
  if (error) throw error;
  return (data as ReceiptCount[]) || [];
}

interface VariantJoinForItem {
  sku_code: string;
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
      .select("*, product_variants(sku_code, products(name))")
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
    return { ...item, sku_code: v?.sku_code ?? null, produto: produto ?? null };
  });

  return { receipt: receiptWithNames, items: mapped };
}

export interface FinalizeResult {
  receipt: InvoiceReceiptWithNames;
  items: InvoiceReceiptItem[];
  summary: ReceiptSummary;
}

/**
 * Calcula OK/Falta/Sobra por item (nunca por soma líquida — ver
 * summarizeReceipt) e grava. Idempotente: pode ser chamada de novo após uma
 * recontagem para recalcular o resultado.
 */
export async function finalizeReceipt(receiptId: string): Promise<FinalizeResult> {
  const supabase = getSupabase();
  const userId = requireUserId();

  const { data: items, error: itemsError } = await supabase.from("invoice_receipt_items").select("*").eq("receipt_id", receiptId);
  if (itemsError) throw itemsError;
  const rows = (items as InvoiceReceiptItem[]) || [];

  // SNAPSHOT imutável (ver migration 0025): busca o produto vinculado de cada
  // item EXATAMENTE agora e grava nome/SKU/EAN direto na linha — o relatório
  // final nunca mais muda sozinho se o cadastro for editado depois. Rodada
  // de novo numa recontagem só atualiza o snapshot pro estado atual naquele
  // NOVO momento de finalização, o que continua sendo a regra correta.
  const variantIds = [...new Set(rows.map((r) => r.product_variant_id).filter((id): id is string => !!id))];
  const linkedByVariantId = new Map<string, { sku_code: string; name: string; gtin: string | null }>();
  if (variantIds.length > 0) {
    const { data: variantRows, error: variantError } = await supabase
      .from("product_variants")
      .select("id, sku_code, gtin, products(name)")
      .in("id", variantIds);
    if (variantError) throw variantError;
    for (const v of (variantRows as { id: string; sku_code: string; gtin: string | null; products: { name: string } | { name: string }[] | null }[]) || []) {
      const product = Array.isArray(v.products) ? v.products[0] : v.products;
      linkedByVariantId.set(v.id, { sku_code: v.sku_code, name: product?.name ?? "", gtin: v.gtin });
    }
  }

  // Item sem produto vinculado mantém status 'unlinked' — sem um SKU real não
  // há "quantidade esperada" confiável pra comparar, mas ele continua
  // aparecendo no relatório de divergências como "produto não localizado".
  //
  // BUG REAL encontrado e corrigido durante a verificação: upsert() do
  // PostgREST monta um INSERT de verdade (com ON CONFLICT DO UPDATE) — as
  // constraints NOT NULL das colunas OMITIDAS (receipt_id, expected_quantity
  // etc.) são validadas contra a linha proposta ANTES do conflito ser
  // resolvido, então um payload parcial ({id, status}) falha com "null value
  // in column ... violates not-null constraint" mesmo a linha já existindo.
  // A correção é reenviar a linha JÁ BUSCADA por inteiro, só trocando o
  // campo status — as outras colunas voltam com o mesmo valor que já tinham.
  const statusUpdates = rows
    .filter((r) => r.product_variant_id !== null)
    .map((r) => {
      const linked = linkedByVariantId.get(r.product_variant_id!);
      return {
        ...r,
        status: computeItemStatus(r.expected_quantity, r.physical_quantity),
        linked_sku_code: linked?.sku_code ?? r.linked_sku_code,
        linked_product_name: linked?.name ?? r.linked_product_name,
        linked_ean: linked?.gtin ?? r.linked_ean,
      };
    });

  if (statusUpdates.length > 0) {
    const { error: updateError } = await supabase.from("invoice_receipt_items").upsert(statusUpdates, { onConflict: "id" });
    if (updateError) throw updateError;
  }

  const summary = summarizeReceipt(rows.map((r) => ({ expected_quantity: r.expected_quantity, physical_quantity: r.physical_quantity })));
  const hasUnresolved = rows.some((r) => r.product_variant_id === null) || summary.pending > 0;
  const allOk = summary.missing === 0 && summary.surplus === 0 && !hasUnresolved;

  const { error: receiptError } = await supabase
    .from("invoice_receipts")
    .update({ status: allOk ? "completed" : "with_divergences", finished_at: new Date().toISOString(), finished_by: userId })
    .eq("id", receiptId);
  if (receiptError) throw receiptError;

  // Busca de novo já com o nome de quem finalizou (join) e os itens com o snapshot recém-gravado.
  const { receipt: refreshedReceipt, items: refreshedItems } = await getReceipt(receiptId);
  return { receipt: refreshedReceipt, items: refreshedItems, summary };
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
