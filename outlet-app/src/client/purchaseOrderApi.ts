// Ordem de Compra por NF-e — anexa a ordem de compra (planilha GTIN/SKU/
// descrição/quantidade) a uma conferência de NF-e, só para CONFERIR e
// SUGERIR vínculos — nunca aplica nada sozinha (ver migration
// 0061_invoice_purchase_orders.sql). Mesmo padrão de upload/mapeamento de
// coluna já usado em importer.ts, reaproveitado aqui em vez de inventado.
import { getSupabase } from "./supabaseClient.ts";
import { normalizeEan } from "./utils.ts";
import { getAuthState } from "./auth.ts";
import { authedPost } from "./backendAuthClient.ts";

export interface PurchaseOrderRowInput {
  gtin?: string;
  sku_code?: string;
  description?: string;
  quantity?: string;
}

const HEADER_ALIASES: Record<string, keyof PurchaseOrderRowInput> = {
  gtin: "gtin",
  ean: "gtin",
  "gtin ean": "gtin",
  "gtin/ean": "gtin",
  "gtin cod fornecedor": "gtin",
  "gtin / cod fornecedor": "gtin",
  "cod fornecedor": "gtin",
  sku: "sku_code",
  "sku:": "sku_code",
  "codigo sku": "sku_code",
  "codigo (sku)": "sku_code",
  codigo: "sku_code",
  item: "description",
  produto: "description",
  descricao: "description",
  "descrição": "description",
  qtde: "quantity",
  qtd: "quantity",
  quantidade: "quantity",
};

function normalizeHeader(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** Recebe as linhas cruas do XLSX.utils.sheet_to_json (chaves = cabeçalhos originais). */
export function mapPurchaseOrderRows(rawRows: Record<string, unknown>[]): PurchaseOrderRowInput[] {
  return rawRows.map((raw) => {
    const mapped: PurchaseOrderRowInput = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = HEADER_ALIASES[normalizeHeader(key)];
      if (field && value !== undefined && value !== null && String(value).trim() !== "") {
        // "description" é o único campo que pode vir de mais de uma coluna
        // reconhecida (ex.: "Item" e "Produto") — nunca sobrescreve um valor
        // já encontrado por engano de uma coluna posterior menos específica.
        if (!mapped[field]) mapped[field] = String(value).trim();
      }
    }
    return mapped;
  });
}

export interface PurchaseOrderRow {
  gtin_normalized: string;
  sku_code: string;
  description: string | null;
  quantity: number | null;
}

export interface PurchaseOrderValidation {
  valid: PurchaseOrderRow[];
  errors: { row: number; reason: string }[];
}

/**
 * A maioria das ordens de compra reais é PDF, não planilha — usa a mesma IA
 * (Claude) já usada pro "Colar texto"/print de WhatsApp, só que lendo o PDF
 * direto (suporte nativo da API da Anthropic a documento, sem OCR à parte).
 * Devolve linhas já no formato de cabeçalho (GTIN/SKU/Descrição/Quantidade),
 * pra passar direto em mapPurchaseOrderRows — nunca duplica a validação.
 */
export async function parsePurchaseOrderPdf(file: File): Promise<Record<string, unknown>[]> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);

  const result = await authedPost<{ items?: Record<string, unknown>[]; error?: string }>("/api/parse-purchase-order-pdf", { pdf_base64: base64 });
  if (result.error) throw new Error(result.error);
  return result.items || [];
}

/** GTIN dentro do texto de "Item" (ex.: PDF de OC com "SKU: CCRKM1IP18PM-8" numa segunda linha) — quando a
 * planilha só tem uma coluna de texto livre por item, tenta achar o SKU embutido antes de rejeitar a linha. */
function extractEmbeddedSku(description: string | undefined): string | null {
  if (!description) return null;
  const match = description.match(/SKU\s*:\s*([A-Z0-9-]+)/i);
  return match ? match[1].toUpperCase() : null;
}

export function validatePurchaseOrderRows(rows: PurchaseOrderRowInput[]): PurchaseOrderValidation {
  const valid: PurchaseOrderRow[] = [];
  const errors: { row: number; reason: string }[] = [];

  rows.forEach((r, idx) => {
    const rowIndex = idx + 2;
    const gtin_normalized = normalizeEan(r.gtin || "");
    const sku_code = (r.sku_code || extractEmbeddedSku(r.description) || "").trim();
    if (!gtin_normalized) {
      errors.push({ row: rowIndex, reason: "GTIN é obrigatório." });
      return;
    }
    if (!sku_code) {
      errors.push({ row: rowIndex, reason: "SKU é obrigatório (não encontrado na planilha nem embutido na descrição)." });
      return;
    }
    const quantity = r.quantity ? Number(r.quantity.replace(",", ".")) : null;
    valid.push({ gtin_normalized, sku_code, description: r.description?.trim() || null, quantity: quantity !== null && Number.isFinite(quantity) ? quantity : null });
  });

  return { valid, errors };
}

export interface UploadPurchaseOrderResult {
  purchaseOrderId: string;
  inserted: number;
  rejected: number;
  errors: { row: number; reason: string }[];
}

/**
 * Envia a planilha da ordem de compra. `receiptId` é OPCIONAL — na prática a
 * ordem de compra quase sempre existe ANTES da NF-e chegar, então o mais
 * comum é enviar sem nota nenhuma ainda (`receiptId` omitido, fica "avulsa")
 * e vincular depois com `linkPurchaseOrderToReceipt` quando a carga chegar.
 * Enviar já com `receiptId` continua funcionando (vínculo direto na hora).
 */
export async function uploadPurchaseOrder(fileName: string, rawRows: Record<string, unknown>[], receiptId?: string): Promise<UploadPurchaseOrderResult> {
  const mapped = mapPurchaseOrderRows(rawRows);
  const { valid, errors } = validatePurchaseOrderRows(mapped);
  if (valid.length === 0) {
    throw new Error(`Nenhuma linha válida encontrada na planilha (${errors.length} rejeitada(s) — confira as colunas GTIN e SKU).`);
  }

  const supabase = getSupabase();
  const { session } = (await supabase.auth.getSession()).data;
  const { profile } = getAuthState();
  if (!profile?.company_id) throw new Error("Empresa do usuário não identificada.");

  const { data: po, error: poError } = await supabase
    .from("invoice_purchase_orders")
    .insert({ receipt_id: receiptId ?? null, file_name: fileName, uploaded_by: session?.user.id ?? null, company_id: profile.company_id })
    .select()
    .single();
  if (poError) throw poError;

  const { error: itemsError } = await supabase.from("invoice_purchase_order_items").insert(
    valid.map((r) => ({
      purchase_order_id: po.id,
      gtin_normalized: r.gtin_normalized,
      sku_code: r.sku_code,
      description: r.description,
      quantity: r.quantity,
    }))
  );
  if (itemsError) throw itemsError;

  return { purchaseOrderId: po.id, inserted: valid.length, rejected: errors.length, errors };
}

export interface UnlinkedPurchaseOrder {
  id: string;
  file_name: string;
  item_count: number;
  created_at: string;
}

/** Ordens de compra já enviadas mas ainda sem NF-e vinculada — pra escolher qual pertence à nota em mãos. */
export async function listUnlinkedPurchaseOrders(): Promise<UnlinkedPurchaseOrder[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("list_unlinked_purchase_orders");
  if (error) throw error;
  return (data as UnlinkedPurchaseOrder[]) || [];
}

/** Vínculo explícito e deliberado — nunca automático/adivinhado (ver migration 0062). */
export async function linkPurchaseOrderToReceipt(purchaseOrderId: string, receiptId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.rpc("link_purchase_order_to_receipt", { p_purchase_order_id: purchaseOrderId, p_receipt_id: receiptId });
  if (error) throw error;
}

export interface PurchaseOrderConflict {
  item_id: string;
  invoice_product_code: string | null;
  description: string | null;
  gtin_normalized: string;
  po_sku_code: string;
  po_description: string | null;
  po_quantity: number | null;
  linked_sku_code: string | null;
  suggested_variant_id: string | null;
  kind: "conflict" | "suggestion";
}

/** Nunca aplica nada sozinho — só relata pro operador decidir (ver comentário na migration). */
export async function getPurchaseOrderConflicts(receiptId: string): Promise<PurchaseOrderConflict[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("check_purchase_order_conflicts", { p_receipt_id: receiptId });
  if (error) throw error;
  return (data as PurchaseOrderConflict[]) || [];
}

export async function hasPurchaseOrder(receiptId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { count, error } = await supabase.from("invoice_purchase_orders").select("id", { count: "estimated", head: true }).eq("receipt_id", receiptId);
  if (error) throw error;
  return (count ?? 0) > 0;
}
