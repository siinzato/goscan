// MODO SCAN — memória visual persistente. Quando um operador confirma ou
// corrige o resultado de um scan, a captura vira uma referência visual
// validada (tabela visual_learning_samples, migration 0016) que passa a
// participar de reconhecimentos futuros — sem depender de estado
// local/sessão/cache, sobrevivendo a logout, F5 e novo deploy.
//
// Regras de segurança do aprendizado (nunca relaxadas):
// - só grava com confirmação humana explícita (chamador é sempre uma ação
//   de operador/admin, nunca automático);
// - categoria/família/capacidade/cor são sempre uma CÓPIA do cadastro
//   oficial do produto/variante no momento do registro — nunca texto livre,
//   nunca inferido da sugestão da IA;
// - imagem de baixa qualidade (muito escura, estourada, sem contraste) nunca
//   entra na memória, mesmo com produto confirmado;
// - referência quase idêntica a uma já existente não vira cópia nova, só
//   reforça a existente (confirmation_count);
// - nada é apagado de verdade — limite de referências por variante desativa
//   (validation_status="disabled"), nunca deleta.
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { generateImageEmbedding, cosineSimilarity, MODEL_NAME, MODEL_VERSION, EMBEDDING_DIMENSION } from "./embeddingPipeline.ts";
import { processAndNormalizeImage } from "./imagePipeline.ts";

const BUCKET = "scan-learning-samples";
const DEDUP_MAX_DISTANCE = 0.03; // distância cosseno tão baixa que é praticamente a mesma foto
const MAX_ACTIVE_SAMPLES_PER_VARIANT = 20;

export interface QualityAssessment {
  ok: boolean;
  score: number; // 0-1, heurística — não é detecção real de nitidez/objeto
  reason?: string;
}

// Heurísticas via estatística de pixel (sharp .stats()) — proxy razoável pra
// "muito escura"/"sem contraste (desfoque ou fundo dominante)", mas NÃO
// substitui detecção real de objeto/nitidez (exigiria um modelo de visão
// dedicado, fora do escopo atual). Documentado como limitação no relatório.
//
// CALIBRADO com evidência real: medi a própria foto de catálogo (estúdio,
// fundo bem claro) de GFGCM13OUT-26 — mean=249.6, stdev=9.1. Os valores
// genéricos originais (teto de brilho 235, piso de contraste 12) REJEITARIAM
// essa foto legítima, porque fotos de produto com fundo claro/branco são
// naturalmente claras e de baixo contraste global (a maior parte do quadro é
// fundo uniforme, só o produto tem variação). Ajustado pra dar folga real
// sobre esse caso medido, mantendo o piso baixo o bastante pra ainda pegar
// quadro realmente vazio/sólido (stdev=0 numa cor lisa, testado).
const MIN_MEAN_BRIGHTNESS = 20; // 0-255 — abaixo disso, ambiente sem luz nenhuma
const MAX_MEAN_BRIGHTNESS = 253; // só rejeita quadro praticamente estourado (~branco puro)
const MIN_STDDEV = 4; // abaixo da foto de catálogo medida (9.1) com folga, mas acima de uma cor sólida (0)

export async function assessFrameQuality(buffer: Buffer): Promise<QualityAssessment> {
  try {
    const stats = await sharp(buffer).greyscale().stats();
    const channel = stats.channels[0];
    if (channel.mean < MIN_MEAN_BRIGHTNESS) return { ok: false, score: 0, reason: "Imagem muito escura." };
    if (channel.mean > MAX_MEAN_BRIGHTNESS) return { ok: false, score: 0, reason: "Imagem estourada de luz/reflexo excessivo." };
    if (channel.stdev < MIN_STDDEV) return { ok: false, score: 0.2, reason: "Imagem sem contraste suficiente (possível desfoque ou fundo dominando o quadro)." };
    return { ok: true, score: Math.min(1, channel.stdev / 60) };
  } catch {
    return { ok: false, score: 0, reason: "Não foi possível analisar a qualidade da imagem." };
  }
}

// Peso de confiança por origem — 1.0 pra referência curada por admin
// (treinamento guiado ou foto oficial), menor pra correções/confirmações de
// operador em campo (evidência real, mas sem a mesma curadoria intencional).
// Guardado por linha; o ranking de busca hoje continua só por distância —
// este valor fica pronto pra uma reordenação ponderada futura.
const CONFIDENCE_WEIGHT_BY_SOURCE: Record<string, number> = {
  admin_upload: 1.0,
  official_catalog: 1.0,
  corrected_scan: 0.8,
  confirmed_scan: 0.6,
};

export interface RecordLearningSampleParams {
  variantId: string;
  imageBuffer: Buffer;
  sourceType: "confirmed_scan" | "corrected_scan" | "admin_upload";
  originalPredictionId: string | null;
  originalConfidence: number | null;
  recognitionStatus: string | null;
  /** id do profile que corrigiu — null quando foi uma confirmação simples (não correção). */
  correctedBy: string | null;
  /** Ângulo da captura guiada (frente/traseira/esquerda/direita/superior/base) — só usado por "Criar Reconhecimento". */
  viewAngle?: string | null;
}

export interface RecordLearningSampleResult {
  saved: boolean;
  reinforcedExisting: boolean;
  reason?: string;
  sampleId?: string;
}

interface VariantWithProduct {
  id: string;
  sku_code: string;
  variant_key: string | null;
  normalized_color: string | null;
  active: boolean;
  products: { id: string; name: string; category: string | null; visual_family_key: string | null; capacity_ml: number | null; active: boolean } | null;
}

export async function recordLearningSample(admin: SupabaseClient, params: RecordLearningSampleParams): Promise<RecordLearningSampleResult> {
  const quality = await assessFrameQuality(params.imageBuffer);
  if (!quality.ok) {
    return { saved: false, reinforcedExisting: false, reason: quality.reason };
  }

  const { data: variantData, error: variantError } = await admin
    .from("product_variants")
    .select("id, sku_code, variant_key, normalized_color, active, products!inner(id, name, category, visual_family_key, capacity_ml, active)")
    .eq("id", params.variantId)
    .maybeSingle();
  const variant = variantData as unknown as VariantWithProduct | null;
  if (variantError || !variant || !variant.active || !variant.products?.active) {
    return { saved: false, reinforcedExisting: false, reason: "Variante ou produto não encontrado/inativo." };
  }
  const product = variant.products;

  const normalized = await processAndNormalizeImage(params.imageBuffer);
  const embedding = await generateImageEmbedding(normalized.buffer);

  // Deduplicação: compara contra as referências VALIDADAS já existentes desta
  // mesma variante — nunca cria uma cópia quase idêntica, só reforça a
  // confirmação da que já existe.
  const { data: existingRows, error: existingError } = await admin
    .from("visual_learning_samples")
    .select("id, embedding, confirmation_count")
    .eq("variant_id", params.variantId)
    .eq("validation_status", "validated")
    .eq("active", true)
    .not("embedding", "is", null);
  if (existingError) throw existingError;

  for (const row of (existingRows || []) as { id: string; embedding: number[]; confirmation_count: number }[]) {
    const distance = 1 - cosineSimilarity(embedding, row.embedding);
    if (distance <= DEDUP_MAX_DISTANCE) {
      await admin
        .from("visual_learning_samples")
        .update({ confirmation_count: row.confirmation_count + 1 })
        .eq("id", row.id);
      return { saved: false, reinforcedExisting: true, sampleId: row.id };
    }
  }

  const storagePath = `${params.variantId}/${createHash("sha256").update(normalized.buffer).digest("hex").slice(0, 20)}.webp`;
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, normalized.buffer, {
    contentType: "image/webp",
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const baseRow = {
    product_id: product.id,
    variant_id: params.variantId,
    category: product.category,
    family: product.visual_family_key,
    capacity_ml: product.capacity_ml,
    color: variant.variant_key || variant.normalized_color || null,
    sku_code: variant.sku_code,
    product_name: product.name,
    storage_path: storagePath,
    embedding,
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    dimension: EMBEDDING_DIMENSION,
    source_type: params.sourceType,
    original_prediction_id: params.originalPredictionId,
    original_confidence: params.originalConfidence,
    recognition_status: params.recognitionStatus,
    corrected_by: params.correctedBy,
    corrected_at: params.correctedBy ? new Date().toISOString() : null,
    validation_status: "validated" as const,
    quality_score: quality.score,
    confirmation_count: 1,
    rejection_count: 0,
    active: true,
    view_angle: params.viewAngle ?? null,
    confidence_weight: CONFIDENCE_WEIGHT_BY_SOURCE[params.sourceType] ?? 0.6,
  };

  const { data: inserted, error: insertError } = await admin
    .from("visual_learning_samples")
    .insert({ ...baseRow, embedding_vector: embedding })
    .select("id")
    .single();

  if (insertError && /embedding_vector/.test(insertError.message)) {
    // pgvector indisponível neste projeto — grava só o jsonb (mesmo fallback de visualEmbeddings.ts).
    const { data: retryData, error: retryError } = await admin.from("visual_learning_samples").insert(baseRow).select("id").single();
    if (retryError) throw retryError;
    await enforceSampleLimit(admin, params.variantId);
    return { saved: true, reinforcedExisting: false, sampleId: retryData.id };
  }
  if (insertError) throw insertError;

  await enforceSampleLimit(admin, params.variantId);
  return { saved: true, reinforcedExisting: false, sampleId: inserted.id };
}

/** Nunca apaga — quando o limite por variante é excedido, desativa as referências menos confirmadas/mais antigas primeiro. */
async function enforceSampleLimit(admin: SupabaseClient, variantId: string): Promise<void> {
  const { data: rows, error } = await admin
    .from("visual_learning_samples")
    .select("id, confirmation_count, created_at")
    .eq("variant_id", variantId)
    .eq("validation_status", "validated")
    .eq("active", true)
    .order("confirmation_count", { ascending: true })
    .order("created_at", { ascending: true });
  if (error || !rows || rows.length <= MAX_ACTIVE_SAMPLES_PER_VARIANT) return;

  const toDisable = rows.slice(0, rows.length - MAX_ACTIVE_SAMPLES_PER_VARIANT);
  for (const row of toDisable) {
    await admin.from("visual_learning_samples").update({ validation_status: "disabled" }).eq("id", row.id);
  }
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

/** Listagem paginada para a tela administrativa de revisão (Catálogo Visual). */
export async function listLearningSamples(
  admin: SupabaseClient,
  opts: { status?: string; variantId?: string; page?: number; pageSize?: number } = {}
): Promise<{ rows: LearningSampleRow[]; total: number }> {
  const page = opts.page ?? 0;
  const pageSize = opts.pageSize ?? 30;
  let query = admin
    .from("visual_learning_samples")
    .select("id, product_id, variant_id, category, family, capacity_ml, color, sku_code, product_name, storage_path, source_type, validation_status, confirmation_count, rejection_count, quality_score, original_confidence, corrected_by, corrected_at, created_at, active", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (opts.status) query = query.eq("validation_status", opts.status);
  if (opts.variantId) query = query.eq("variant_id", opts.variantId);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data as LearningSampleRow[]) || [], total: count ?? 0 };
}

export async function updateLearningSampleStatus(
  admin: SupabaseClient,
  sampleId: string,
  status: "validated" | "rejected" | "disabled"
): Promise<void> {
  const { error } = await admin.from("visual_learning_samples").update({ validation_status: status }).eq("id", sampleId);
  if (error) throw error;
}

export interface LibrarySummary {
  official_count: number;
  admin_training_count: number;
  confirmed_count: number;
  corrected_count: number;
  total: number;
}

/**
 * Contagem de referências por origem pra um produto/variante — "Fotos
 * oficiais" vem de product_images (catálogo real), o resto vem de
 * visual_learning_samples (só validation_status="validated"+active, que é o
 * que realmente participa da busca). Nunca conta pending/rejected/disabled
 * como se estivessem "disponíveis".
 */
export async function getLibrarySummary(admin: SupabaseClient, variantId: string): Promise<LibrarySummary> {
  const [officialRes, adminRes, confirmedRes, correctedRes] = await Promise.all([
    admin.from("product_images").select("id", { count: "exact", head: true }).eq("product_variant_id", variantId).eq("is_active", true),
    admin
      .from("visual_learning_samples")
      .select("id", { count: "exact", head: true })
      .eq("variant_id", variantId)
      .eq("source_type", "admin_upload")
      .eq("validation_status", "validated")
      .eq("active", true),
    admin
      .from("visual_learning_samples")
      .select("id", { count: "exact", head: true })
      .eq("variant_id", variantId)
      .eq("source_type", "confirmed_scan")
      .eq("validation_status", "validated")
      .eq("active", true),
    admin
      .from("visual_learning_samples")
      .select("id", { count: "exact", head: true })
      .eq("variant_id", variantId)
      .eq("source_type", "corrected_scan")
      .eq("validation_status", "validated")
      .eq("active", true),
  ]);
  const official_count = officialRes.count ?? 0;
  const admin_training_count = adminRes.count ?? 0;
  const confirmed_count = confirmedRes.count ?? 0;
  const corrected_count = correctedRes.count ?? 0;
  return {
    official_count,
    admin_training_count,
    confirmed_count,
    corrected_count,
    total: official_count + admin_training_count + confirmed_count + corrected_count,
  };
}

// ---------------------------------------------------------------------------
// "Nenhuma dessas opções" → produto ainda não cadastrado (migration 0019)
// ---------------------------------------------------------------------------
export interface ReportUnclassifiedProductResult {
  ok: true;
  reportId: string;
}

/**
 * Registra a pendência de um produto escaneado que não existe no catálogo —
 * não gera embedding nem vincula a nenhum SKU (não há SKU correto pra
 * vincular ainda); só guarda a foto + observação pra um manager/admin
 * cadastrar o produto de verdade depois. Nunca cria SKU sozinha.
 */
export async function reportUnclassifiedProduct(
  admin: SupabaseClient,
  params: { reportedBy: string; imageBuffer: Buffer; observation: string | null }
): Promise<ReportUnclassifiedProductResult> {
  const normalized = await processAndNormalizeImage(params.imageBuffer);
  const storagePath = `unclassified/${randomUUID()}.webp`;

  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, normalized.buffer, {
    contentType: "image/webp",
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const { data: inserted, error: insertError } = await admin
    .from("unclassified_product_reports")
    .insert({
      reported_by: params.reportedBy,
      storage_path: storagePath,
      observation: params.observation,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  return { ok: true, reportId: inserted.id };
}
