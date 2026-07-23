// MODO SCAN — "Qualidade de Reconhecimento": o quanto uma variante está
// preparada para ser reconhecida rápido e com segurança pelo scanner,
// calculado a partir de dados reais (nunca um número aleatório, nunca só a
// contagem de fotos). Ver migration 0021 para o cache por variante.
//
// Fórmula (pesos pedidos): quantidade/diversidade de referências 25%,
// qualidade técnica das imagens 20%, cobertura de ângulos 20%, consistência
// dos embeddings 15%, histórico real de acertos 15%, tempo médio de
// identificação 5%. Os dois últimos (20% juntos) só entram quando existe
// histórico operacional real suficiente (MIN_OPERATIONAL_SAMPLES) — antes
// disso, redistribuídos proporcionalmente entre os 4 primeiros (ver
// WEIGHTS_ESTIMATED) para nunca fingir uso real que não aconteceu.
import type { SupabaseClient } from "@supabase/supabase-js";
import { cosineSimilarity, MODEL_NAME, MODEL_VERSION } from "./embeddingPipeline.ts";

const MIN_OPERATIONAL_SAMPLES = 5;

const WEIGHTS_ESTIMATED = {
  referenceCount: 25 / 80,
  technical: 20 / 80,
  angleCoverage: 20 / 80,
  consistency: 15 / 80,
};
const WEIGHTS_FULL = {
  referenceCount: 0.25,
  technical: 0.2,
  angleCoverage: 0.2,
  consistency: 0.15,
  accuracy: 0.15,
  speed: 0.05,
};

// Curva de saturação: cada referência adicional ajuda menos que a anterior —
// medido contra o próprio bom-senso do pedido ("não pode ser baseado só na
// quantidade"), não uma métrica científica, mas documentada e reproduzível.
function referenceCountScore(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 35;
  if (count === 2) return 55;
  if (count === 3) return 70;
  if (count <= 5) return 82;
  if (count <= 8) return 90;
  if (count <= 11) return 96;
  return 100;
}

const CANONICAL_ANGLES = ["frente", "traseira", "lateral", "superior", "base"] as const;

/** Normaliza os dois vocabulários de ângulo existentes (product_images.image_type e
 * visual_learning_samples.view_angle) para um conjunto único e comparável. */
function normalizeAngle(raw: string | null): string | null {
  if (!raw) return null;
  const map: Record<string, string> = {
    frontal: "frente",
    frente: "frente",
    traseira: "traseira",
    lateral: "lateral",
    esquerda: "lateral",
    direita: "lateral",
    superior: "superior",
    base: "base",
    detalhe: "detalhe",
  };
  return map[raw] ?? null;
}

interface ReferenceRow {
  sourceKind: "official" | "admin_upload" | "confirmed_scan" | "corrected_scan";
  qualityPercent: number;
  angle: string | null;
  embedding: number[] | null;
}

function bandFor(scorePercent: number): string {
  if (scorePercent >= 90) return "excelente";
  if (scorePercent >= 75) return "bom";
  if (scorePercent >= 55) return "regular";
  if (scorePercent >= 30) return "fraco";
  return "critico";
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Similaridade média entre TODOS os pares de embeddings — O(n²), mas n é
 * sempre pequeno (poucas dezenas de referências por variante no máximo). */
function averagePairwiseSimilarity(vectors: number[][]): number | null {
  if (vectors.length < 2) return null;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosineSimilarity(vectors[i], vectors[j]);
      pairs++;
    }
  }
  return pairs === 0 ? null : total / pairs;
}

interface VariantIdentity {
  id: string;
  product_id: string;
  sku_code: string;
}

/**
 * Recalcula e grava a Qualidade de Reconhecimento de uma variante — chamado
 * depois de eventos reais que mudam a base (nova referência, correção,
 * confirmação, desativação — ver chamadores em visualLearning.ts/
 * catalogImages.ts). Nunca lança: uma falha aqui não pode derrubar a
 * operação principal que a disparou.
 */
export async function recalculateRecognitionQuality(admin: SupabaseClient, variantId: string): Promise<void> {
  try {
    const { data: variant, error: variantError } = await admin
      .from("product_variants")
      .select("id, product_id, sku_code")
      .eq("id", variantId)
      .maybeSingle();
    if (variantError || !variant) return; // variante não existe (mais) — nada a calcular

    const references = await collectReferences(admin, variant as VariantIdentity);
    const operational = await collectOperationalHistory(admin, variantId);

    const referenceCount = references.length;
    const officialCount = references.filter((r) => r.sourceKind === "official").length;
    const learnedCount = referenceCount - officialCount;
    const distinctSourceTypes = new Set(references.map((r) => r.sourceKind)).size;

    let refScore = referenceCountScore(referenceCount);
    if (distinctSourceTypes <= 1 && referenceCount > 0) refScore = Math.max(0, refScore - 8);
    else if (distinctSourceTypes >= 3) refScore = Math.min(100, refScore + 5);

    const technicalPercent = referenceCount === 0 ? 0 : Math.round(average(references.map((r) => r.qualityPercent)));

    const anglesPresent = Array.from(new Set(references.map((r) => r.angle).filter((a): a is string => !!a)));
    const angleCoveragePercent = Math.round((anglesPresent.length / CANONICAL_ANGLES.length) * 100);

    const embeddingVectors = references.map((r) => r.embedding).filter((e): e is number[] => !!e);
    const consistencyRaw = averagePairwiseSimilarity(embeddingVectors);
    const consistencyPercent = consistencyRaw === null ? null : Math.round(Math.max(0, Math.min(1, consistencyRaw)) * 100);

    const hasOperationalData = operational.resolvedSampleCount >= MIN_OPERATIONAL_SAMPLES;

    let scorePercent: number;
    if (hasOperationalData && operational.accuracyPercent !== null) {
      const speedPercent = operational.avgMs === null ? 70 : scoreForSpeed(operational.avgMs);
      scorePercent =
        refScore * WEIGHTS_FULL.referenceCount +
        technicalPercent * WEIGHTS_FULL.technical +
        angleCoveragePercent * WEIGHTS_FULL.angleCoverage +
        (consistencyPercent ?? 75) * WEIGHTS_FULL.consistency +
        operational.accuracyPercent * WEIGHTS_FULL.accuracy +
        speedPercent * WEIGHTS_FULL.speed;
    } else {
      scorePercent =
        refScore * WEIGHTS_ESTIMATED.referenceCount +
        technicalPercent * WEIGHTS_ESTIMATED.technical +
        angleCoveragePercent * WEIGHTS_ESTIMATED.angleCoverage +
        (consistencyPercent ?? 75) * WEIGHTS_ESTIMATED.consistency;
    }
    scorePercent = Math.round(Math.max(0, Math.min(100, scorePercent)));

    const recommendations = buildRecommendations({
      referenceCount,
      technicalPercent,
      angleCoveragePercent,
      anglesPresent,
      consistencyPercent,
      operational,
    });

    await admin.from("product_recognition_quality").upsert(
      {
        variant_id: variant.id,
        product_id: variant.product_id,
        score_percent: scorePercent,
        band: bandFor(scorePercent),
        estimated_only: !hasOperationalData,
        reference_count: referenceCount,
        official_count: officialCount,
        learned_count: learnedCount,
        distinct_source_types: distinctSourceTypes,
        quality_technical_percent: technicalPercent,
        angle_coverage_percent: angleCoveragePercent,
        angles_present: anglesPresent,
        embedding_consistency_percent: consistencyPercent,
        historical_accuracy_percent: hasOperationalData ? operational.accuracyPercent : null,
        historical_sample_count: operational.resolvedSampleCount,
        avg_recognition_ms: operational.avgMs,
        top_confusion_variant_id: operational.topConfusion?.variantId ?? null,
        top_confusion_sku: operational.topConfusion?.sku ?? null,
        top_confusion_count: operational.topConfusion?.count ?? null,
        recommendations,
        computed_at: new Date().toISOString(),
      },
      { onConflict: "variant_id" }
    );
  } catch (err) {
    console.warn("[recognitionQuality] falha ao recalcular (não afeta a operação principal):", err instanceof Error ? err.message : err);
  }
}

async function collectReferences(admin: SupabaseClient, variant: VariantIdentity): Promise<ReferenceRow[]> {
  const rows: ReferenceRow[] = [];

  const { data: images } = await admin
    .from("product_images")
    .select("id, image_type, view_angle, image_embeddings(embedding, status, model_name, model_version)")
    .eq("product_variant_id", variant.id)
    .eq("is_active", true)
    .is("archived_at", null)
    .eq("quality_status", "aprovada");
  for (const img of (images as unknown as { id: string; image_type: string; view_angle: string; image_embeddings: { embedding: number[] | null; status: string; model_name: string; model_version: string }[] | null }[]) || []) {
    const readyEmbedding = (img.image_embeddings || []).find((e) => e.status === "ready" && e.model_name === MODEL_NAME && e.model_version === MODEL_VERSION);
    rows.push({
      sourceKind: "official",
      qualityPercent: 88, // proxy fixo — foto de catálogo curada por humano, sem medida numérica própria (limitação documentada no relatório)
      angle: normalizeAngle(img.view_angle) ?? normalizeAngle(img.image_type),
      embedding: readyEmbedding?.embedding ?? null,
    });
  }

  const { data: samples } = await admin
    .from("visual_learning_samples")
    .select("source_type, quality_score, view_angle, embedding")
    .eq("variant_id", variant.id)
    .eq("validation_status", "validated")
    .eq("active", true);
  for (const s of (samples as { source_type: string; quality_score: number | null; view_angle: string | null; embedding: number[] | null }[]) || []) {
    rows.push({
      sourceKind: s.source_type === "admin_upload" || s.source_type === "official_catalog" ? "admin_upload" : s.source_type === "corrected_scan" ? "corrected_scan" : "confirmed_scan",
      qualityPercent: Math.round(Math.max(0, Math.min(1, s.quality_score ?? 0.7)) * 100),
      angle: normalizeAngle(s.view_angle),
      embedding: s.embedding ?? null,
    });
  }

  return rows;
}

// Tempo "bom" (100%) até 800ms; degrada linearmente até 0% em 4s — só entra
// na nota com peso 5%, então mesmo um caso lento não derruba o score sozinho.
function scoreForSpeed(avgMs: number): number {
  const GOOD_MS = 800;
  const BAD_MS = 4000;
  if (avgMs <= GOOD_MS) return 100;
  if (avgMs >= BAD_MS) return 0;
  return Math.round((1 - (avgMs - GOOD_MS) / (BAD_MS - GOOD_MS)) * 100);
}

interface OperationalHistory {
  resolvedSampleCount: number;
  accuracyPercent: number | null;
  avgMs: number | null;
  topConfusion: { variantId: string; sku: string; count: number } | null;
}

/**
 * Cruza scan_recognition_log (o que o sistema sugeriu) com
 * visual_learning_samples.original_prediction_id (o que o operador
 * confirmou/corrigiu de verdade) para medir taxa de acerto REAL — nunca
 * inventada. Só considera linhas onde existe essa resposta do operador;
 * scans nunca confirmados/corrigidos não entram no denominador (não há como
 * saber se estavam certos).
 */
async function collectOperationalHistory(admin: SupabaseClient, variantId: string): Promise<OperationalHistory> {
  const { data: logRows } = await admin
    .from("scan_recognition_log")
    .select("recognition_id, total_ms")
    .eq("variant_id", variantId)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (logRows as { recognition_id: string; total_ms: number }[]) || [];
  if (rows.length === 0) return { resolvedSampleCount: 0, accuracyPercent: null, avgMs: null, topConfusion: null };

  const avgMs = Math.round(average(rows.map((r) => r.total_ms)));

  const recognitionIds = rows.map((r) => r.recognition_id);
  const { data: outcomeRows } = await admin
    .from("visual_learning_samples")
    .select("original_prediction_id, variant_id, sku_code")
    .in("original_prediction_id", recognitionIds);
  const outcomes = (outcomeRows as { original_prediction_id: string; variant_id: string; sku_code: string }[]) || [];

  let hits = 0;
  let misses = 0;
  const confusionCounts = new Map<string, { sku: string; count: number }>();
  for (const outcome of outcomes) {
    if (outcome.variant_id === variantId) {
      hits++;
    } else {
      misses++;
      const current = confusionCounts.get(outcome.variant_id);
      confusionCounts.set(outcome.variant_id, { sku: outcome.sku_code, count: (current?.count ?? 0) + 1 });
    }
  }
  const resolvedSampleCount = hits + misses;
  const accuracyPercent = resolvedSampleCount === 0 ? null : Math.round((hits / resolvedSampleCount) * 100);

  let topConfusion: OperationalHistory["topConfusion"] = null;
  for (const [confusedVariantId, info] of confusionCounts.entries()) {
    if (info.count >= 2 && (!topConfusion || info.count > topConfusion.count)) {
      topConfusion = { variantId: confusedVariantId, sku: info.sku, count: info.count };
    }
  }

  return { resolvedSampleCount, accuracyPercent, avgMs, topConfusion };
}

function buildRecommendations(input: {
  referenceCount: number;
  technicalPercent: number;
  angleCoveragePercent: number;
  anglesPresent: string[];
  consistencyPercent: number | null;
  operational: OperationalHistory;
}): string[] {
  const recs: string[] = [];

  if (input.referenceCount === 0) {
    recs.push("Nenhuma referência cadastrada — adicione ao menos uma foto (Catálogo Visual ou Criar Reconhecimento) para habilitar o reconhecimento deste produto.");
  } else if (input.referenceCount <= 2) {
    recs.push(`Apenas ${input.referenceCount} referência(s) cadastrada(s) — adicione mais fotos em ângulos diferentes para aumentar a confiança.`);
  }

  const missingAngles = CANONICAL_ANGLES.filter((a) => !input.anglesPresent.includes(a));
  if (input.referenceCount > 0 && missingAngles.length > 0 && input.angleCoveragePercent < 80) {
    const labels: Record<string, string> = { frente: "frontal", traseira: "traseira", lateral: "lateral", superior: "da tampa/parte superior", base: "da base" };
    recs.push(`Sem imagem ${missingAngles.map((a) => labels[a]).join(", ")} — cadastre pelo(s) ângulo(s) faltante(s) via "Criar Reconhecimento".`);
  }

  if (input.referenceCount > 1 && input.technicalPercent < 70) {
    recs.push("Qualidade técnica das fotos abaixo do ideal (iluminação/nitidez) — recadastre com melhor iluminação e fundo mais uniforme.");
  }

  if (input.consistencyPercent !== null && input.consistencyPercent < 70) {
    recs.push("As referências atuais deste produto estão visualmente pouco parecidas entre si — confira se alguma foto foi associada ao produto errado.");
  }

  if (input.operational.resolvedSampleCount >= MIN_OPERATIONAL_SAMPLES) {
    if (input.operational.accuracyPercent !== null && input.operational.accuracyPercent < 70) {
      recs.push(`A taxa de acerto real está em ${input.operational.accuracyPercent}% — considere adicionar mais referências ou revisar as existentes.`);
    }
    if (input.operational.avgMs !== null && input.operational.avgMs > 1500) {
      recs.push(`Tempo médio de identificação real (${(input.operational.avgMs / 1000).toFixed(1)}s) acima do esperado — geralmente indica poucas referências claras.`);
    }
  }
  if (input.operational.topConfusion) {
    recs.push(`Está sendo confundido com o SKU ${input.operational.topConfusion.sku} em ${input.operational.topConfusion.count} ocorrência(s) registradas.`);
  }

  if (recs.length === 0) recs.push("Nenhuma melhoria específica identificada — este produto está bem preparado para o reconhecimento.");
  return recs;
}

export interface RecognitionQualityRow {
  variant_id: string;
  product_id: string;
  score_percent: number;
  band: string;
  estimated_only: boolean;
  reference_count: number;
  official_count: number;
  learned_count: number;
  distinct_source_types: number;
  quality_technical_percent: number;
  angle_coverage_percent: number;
  angles_present: string[];
  embedding_consistency_percent: number | null;
  historical_accuracy_percent: number | null;
  historical_sample_count: number;
  avg_recognition_ms: number | null;
  top_confusion_variant_id: string | null;
  top_confusion_sku: string | null;
  top_confusion_count: number | null;
  recommendations: string[];
  computed_at: string;
}

export async function getRecognitionQualityForVariants(admin: SupabaseClient, variantIds: string[]): Promise<RecognitionQualityRow[]> {
  if (variantIds.length === 0) return [];
  const { data, error } = await admin.from("product_recognition_quality").select("*").in("variant_id", variantIds);
  if (error) throw error;
  return (data as RecognitionQualityRow[]) || [];
}

export interface RecognitionQualityFilter {
  band?: string;
  onlyNoReferences?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: "score_asc" | "score_desc";
}

/** Lista para o Catálogo Visual: filtro por faixa + ordenação "quem mais precisa de treinamento" (score_asc). */
export async function listRecognitionQuality(
  admin: SupabaseClient,
  opts: RecognitionQualityFilter = {}
): Promise<{ rows: (RecognitionQualityRow & { sku_code: string; product_name: string })[]; total: number }> {
  const page = opts.page ?? 0;
  const pageSize = opts.pageSize ?? 20;
  // BUG REAL corrigido: a tabela tem DUAS foreign keys pra product_variants
  // (variant_id e top_confusion_variant_id) — o PostgREST não consegue
  // adivinhar qual delas usar num embed implícito ("product_variants!inner"),
  // e a consulta falhava com erro PGRST201 (ambiguidade de relacionamento)
  // toda vez que um filtro de faixa era aplicado. Precisa nomear a FK
  // explicitamente (o hint completo, ver mensagem de erro do PostgREST).
  let query = admin
    .from("product_recognition_quality")
    .select("*, variant:product_variants!product_recognition_quality_variant_id_fkey!inner(sku_code, active, products!inner(name, active))", {
      count: "exact",
    })
    .eq("variant.active", true)
    .eq("variant.products.active", true)
    .order("score_percent", { ascending: opts.sortBy !== "score_desc" })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (opts.band) query = query.eq("band", opts.band);
  if (opts.onlyNoReferences) query = query.eq("reference_count", 0);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = ((data as unknown as (RecognitionQualityRow & { variant: { sku_code: string; products: { name: string } } })[]) || []).map((r) => ({
    ...r,
    sku_code: r.variant.sku_code,
    product_name: r.variant.products.name,
  }));
  return { rows, total: count ?? rows.length };
}
