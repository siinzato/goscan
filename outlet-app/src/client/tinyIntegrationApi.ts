// EXPANSÃO GOSCAN — Cliente da Edge Function tiny-integration (integração
// real com o Tiny ERP v3). Mesmo padrão de invoke de adminApi.ts, mas esta
// Edge Function não é admin-only — qualquer usuário ativo pode listar
// depósitos e lançar estoque (mesmo gate de confirm_return_batch_tiny_launch
// já existente); só test_connection exige a permissão granular
// 'integrations.manage'.
import { getSupabase } from "./supabaseClient.ts";
import { describeEdgeError } from "./adminApi.ts";

export interface TinyWarehouse {
  id: string;
  name: string;
}

export interface TinyLaunchItemResult {
  sourceId: string;
  status: "success" | "failed" | "skipped_already_done";
  externalMovementId?: string;
  error?: string;
}

export interface TinyLaunchSummary {
  total: number;
  succeeded: number;
  failed: number;
  alreadyDone: number;
  allSucceeded: boolean;
}

export interface TinyLaunchOutcome {
  summary: TinyLaunchSummary;
  results: TinyLaunchItemResult[];
}

/** Erro estruturado — sempre carrega o `code` devolvido pela Edge Function (ex.: "NOT_CONFIGURED") pra quem chama decidir o fallback certo, nunca só o texto. */
export class TinyIntegrationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TinyIntegrationError";
  }
}

async function invokeTiny<T = Record<string, unknown>>(action: string, payload: object = {}): Promise<T> {
  const supabase = getSupabase();
  const { data, error } = await supabase.functions.invoke("tiny-integration", { body: { action, ...payload } });
  if (error) throw new TinyIntegrationError("EDGE_ERROR", await describeEdgeError(error as { context?: unknown }));
  const parsed = data as { success: boolean; code?: string; message?: string } & Record<string, unknown>;
  if (!parsed?.success) throw new TinyIntegrationError(parsed?.code || "UNKNOWN_ERROR", parsed?.message || "Não foi possível concluir a operação.");
  return parsed as T;
}

export async function testTinyConnection(): Promise<{ connected: boolean; account: unknown }> {
  return invokeTiny("test_connection");
}

export async function getTinyWarehouses(): Promise<TinyWarehouse[]> {
  const data = await invokeTiny<{ warehouses: TinyWarehouse[] }>("list_warehouses");
  return data.warehouses;
}

export interface LaunchToTinyParams {
  warehouseId: string;
  warehouseName: string;
  unitPrice?: number;
  note?: string;
}

export async function launchReturnBatchToTiny(batchId: string, params: LaunchToTinyParams): Promise<TinyLaunchOutcome> {
  return invokeTiny<TinyLaunchOutcome>("launch_return_batch", { batchId, ...params });
}

export async function launchInvoiceReceiptToTiny(receiptId: string, params: LaunchToTinyParams): Promise<TinyLaunchOutcome> {
  return invokeTiny<TinyLaunchOutcome>("launch_invoice_receipt", { receiptId, ...params });
}
