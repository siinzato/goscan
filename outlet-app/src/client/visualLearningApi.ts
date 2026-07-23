// MODO SCAN — memória visual: registra uma captura confirmada/corrigida por
// um operador como referência validada (ver src/server/visualLearning.ts).
// Só chamado depois de uma confirmação humana explícita — nunca automático.
import { authedPost, authedGet } from "./backendAuthClient.ts";
import { getSupabase } from "./supabaseClient.ts";

export interface RecordScanLearningResult {
  saved: boolean;
  reinforcedExisting: boolean;
  reason?: string;
  sampleId?: string;
}

export function recordScanLearning(params: {
  variant_id: string;
  image_base64: string;
  source_type: "confirmed_scan" | "corrected_scan";
  original_prediction_id: string | null;
  original_confidence: number | null;
  recognition_status: string | null;
}): Promise<RecordScanLearningResult> {
  return authedPost<RecordScanLearningResult>("/api/scan/learn", params);
}

export interface LearningSampleRow {
  id: string;
  product_id: string;
  variant_id: string;
  category: string | null;
  family: string | null;
  capacity_ml: number | null;
  color: string | null;
  sku_code: string;
  product_name: string;
  storage_path: string;
  source_type: string;
  validation_status: string;
  confirmation_count: number;
  rejection_count: number;
  quality_score: number | null;
  original_confidence: number | null;
  corrected_by: string | null;
  corrected_at: string | null;
  created_at: string;
  active: boolean;
}

export function listLearningSamples(opts: { status?: string; page?: number; pageSize?: number } = {}): Promise<{ rows: LearningSampleRow[]; total: number }> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  params.set("page", String(opts.page ?? 0));
  params.set("page_size", String(opts.pageSize ?? 30));
  return authedGet<{ rows: LearningSampleRow[]; total: number }>(`/api/visual-learning/list?${params.toString()}`);
}

export function updateLearningSampleStatus(sampleId: string, status: "validated" | "rejected" | "disabled"): Promise<{ ok: true }> {
  return authedPost<{ ok: true }>("/api/visual-learning/update-status", { sample_id: sampleId, status });
}

/** Bucket dedicado da memória visual (separado de "product-images") — RLS restringe a manager/admin. */
export async function getLearningSampleSignedUrl(storagePath: string, expiresInSeconds = 600): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from("scan-learning-samples").createSignedUrl(storagePath, expiresInSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// "Criar Reconhecimento" — treinamento guiado multi-ângulo (Catálogo Visual)
// ---------------------------------------------------------------------------
export interface FrameQualityAssessment {
  ok: boolean;
  score: number;
  reason?: string;
}

/** Só avalia qualidade — nunca salva nada. Usada durante a captura guiada pra dar feedback antes de aceitar cada foto. */
export function assessScanFrameQuality(imageBase64: string): Promise<FrameQualityAssessment> {
  return authedPost<FrameQualityAssessment>("/api/scan/assess-quality", { image_base64: imageBase64 });
}

export interface RecordAdminReferenceResult {
  saved: boolean;
  reinforcedExisting: boolean;
  reason?: string;
  sampleId?: string;
}

export function recordAdminReference(params: { variant_id: string; image_base64: string; view_angle: string | null }): Promise<RecordAdminReferenceResult> {
  return authedPost<RecordAdminReferenceResult>("/api/visual-learning/admin-reference", params);
}

export interface LibrarySummary {
  official_count: number;
  admin_training_count: number;
  confirmed_count: number;
  corrected_count: number;
  total: number;
}

export function getLibrarySummary(variantId: string): Promise<LibrarySummary> {
  return authedGet<LibrarySummary>(`/api/visual-learning/library-summary?variant_id=${encodeURIComponent(variantId)}`);
}

// ---------------------------------------------------------------------------
// "Nenhuma dessas opções" → produto ainda não cadastrado
// ---------------------------------------------------------------------------
export interface ReportUnclassifiedProductResult {
  ok: true;
  reportId: string;
}

/** Abre uma pendência de catalogação — nenhum SKU é criado, só a foto+observação ficam salvas para revisão manual. */
export function reportUnclassifiedProduct(params: { image_base64: string; observation: string | null }): Promise<ReportUnclassifiedProductResult> {
  return authedPost<ReportUnclassifiedProductResult>("/api/visual-learning/report-unclassified", params);
}
