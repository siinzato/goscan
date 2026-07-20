// Chama as rotas privilegiadas do backend (SSRF-safe fetch + Storage via
// service_role) passando o access_token da sessão atual — o backend
// revalida esse token e o papel (manager/admin) antes de fazer qualquer
// coisa (ver src/server/supabaseAdmin.ts).
import { getSupabase } from "./supabaseClient.ts";

async function authedPost<T>(path: string, body: unknown): Promise<T> {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Sessão inválida — faça login novamente.");

  const resp = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `Erro ${resp.status} ao chamar ${path}`);
  return data as T;
}

export interface BatchItemResult {
  id: string;
  row_number: number;
  sku_outlet: string;
  status: "success" | "success_no_image" | "error";
  error?: string;
  deduped?: boolean;
}

export interface BatchResponse {
  processed: BatchItemResult[];
  remainingPending: number;
  importStatus: string;
}

export function processImportBatch(importId: string, limit = 5): Promise<BatchResponse> {
  return authedPost<BatchResponse>("/api/catalog-images/process-batch", { import_id: importId, limit });
}

export function resetImportErrors(importId: string): Promise<{ reset: number }> {
  return authedPost<{ reset: number }>("/api/catalog-images/reset-errors", { import_id: importId });
}
