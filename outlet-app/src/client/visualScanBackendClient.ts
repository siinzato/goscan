// Chama as rotas privilegiadas do backend do Modo Scan (geração real de
// embeddings via service_role — nunca no navegador). Ver
// src/server/visualEmbeddings.ts e src/server/embeddingPipeline.ts.
import { authedPost, authedGet } from "./backendAuthClient.ts";

export interface EmbeddingStatusSummary {
  eligible_total: number;
  ready: number;
  pending: number;
  processing: number;
  error: number;
}

export function getEmbeddingStatus(): Promise<EmbeddingStatusSummary> {
  return authedGet<EmbeddingStatusSummary>("/api/visual-embeddings/status");
}

export interface EmbeddingBatchItemResult {
  product_image_id: string;
  status: "success" | "error" | "skipped_deduped";
  error?: string;
}

export interface EmbeddingBatchResponse {
  processed: EmbeddingBatchItemResult[];
  remainingPending: number;
}

export function processEmbeddingBatch(limit = 5): Promise<EmbeddingBatchResponse> {
  return authedPost<EmbeddingBatchResponse>("/api/visual-embeddings/process-batch", { limit });
}

export function resetEmbeddingErrors(): Promise<{ reset: number }> {
  return authedPost<{ reset: number }>("/api/visual-embeddings/reset-errors", {});
}

/** Reprocessa só as imagens de uma variante (produto) — sem esperar o lote geral. */
export function processEmbeddingsForVariant(variantId: string): Promise<EmbeddingBatchResponse> {
  return authedPost<EmbeddingBatchResponse>("/api/visual-embeddings/process-variant", { variant_id: variantId });
}

export interface SimilarityMatch {
  product_image_id: string;
  distance: number;
  score_raw: number;
  score_normalized: number;
  storage_path: string | null;
  sku_code: string;
  product_name: string;
  category: string | null;
  visual_family_key: string | null;
  variant_key: string | null;
  capacity_ml: number | null;
}

export interface TestQueryResponse {
  query_source: string;
  used_pgvector: boolean;
  matches: SimilarityMatch[];
}

export function testQueryByProductImage(productImageId: string, limit = 5): Promise<TestQueryResponse> {
  return authedPost<TestQueryResponse>("/api/visual-embeddings/test-query", { product_image_id: productImageId, limit });
}

export function testQueryByUpload(imageBase64: string, limit = 5): Promise<TestQueryResponse> {
  return authedPost<TestQueryResponse>("/api/visual-embeddings/test-query", { image_base64: imageBase64, limit });
}
