// Chama as rotas privilegiadas do backend do Catálogo Visual (SSRF-safe
// fetch + Storage via service_role). Ver backendAuthClient.ts para a lógica
// de autenticação/refresh compartilhada com o Modo Scan.
import { authedPost } from "./backendAuthClient.ts";

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
