// MODO SCAN — Parte 3: serviço de reconhecimento visual. Recebe um quadro
// temporário (já validado pelo endpoint em server.ts), gera o embedding com
// o MESMO modelo/versão da base do catálogo (embeddingPipeline.ts), busca os
// vizinhos mais próximos (visualEmbeddings.ts) e devolve sugestões
// estruturadas — nunca confirma um produto sozinho, nunca usa nome/SKU como
// parte da pontuação visual.
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateImageEmbedding, MODEL_NAME, MODEL_VERSION } from "./embeddingPipeline.ts";
import { findSimilarImages, type SimilarityMatch } from "./visualEmbeddings.ts";
import { SCAN_CONFIG, type ConfidenceLevel } from "./scanConfig.ts";

export interface RecognizeCandidate {
  product_id: string;
  variant_id: string | null;
  sku_outlet: string;
  nome: string;
  imagem: string | null; // product_image_id da melhor imagem que sustentou este candidato
  storage_path: string | null;
  capacity_ml: number | null;
  visual_family_key: string | null;
  variant_key: string | null;
  score: number;
  confidence_level: ConfidenceLevel;
  /** true quando este candidato foi incluído por expansão de família (capacidade irmã), não por match visual direto. */
  from_family_expansion: boolean;
}

// Códigos internos de diagnóstico — nunca mostrados ao operador como estão
// (a UI sempre traduz pra uma mensagem amigável); servem pra distinguir no
// log/telemetria POR QUE não houve resultado, sem adivinhação.
export type RecognizeErrorCode = "NO_EMBEDDINGS_FOUND" | "NO_MATCH_ABOVE_THRESHOLD";

export interface RecognizeResult {
  recognition_id: string;
  status: "matched" | "ambiguous" | "no_result";
  confidence_level: ConfidenceLevel;
  candidates: RecognizeCandidate[];
  visual_family: string | null;
  variant: string | null;
  requires_capacity_selection: boolean;
  processing_time_ms: number;
  used_pgvector: boolean;
  /** Só presente quando status="no_result" — diferencia "base vazia" de "achou mas sem confiança". */
  code?: RecognizeErrorCode;
}

/** Agrupa matches de imagens por produto, usando a MELHOR imagem (menor distância) por
 * produto — nunca soma/conta imagens, exatamente para que um produto com muitas fotos
 * não domine o ranking só por ter mais imagens cadastradas do que outro. */
function groupByProduct(matches: SimilarityMatch[]): SimilarityMatch[] {
  const bestByProduct = new Map<string, SimilarityMatch>();
  for (const m of matches) {
    const current = bestByProduct.get(m.product_id);
    if (!current || m.distance < current.distance) bestByProduct.set(m.product_id, m);
  }
  return Array.from(bestByProduct.values()).sort((a, b) => a.distance - b.distance);
}

function computeConfidence(best: SimilarityMatch | undefined, second: SimilarityMatch | undefined): ConfidenceLevel {
  if (!best) return "none";
  const { noResultMinDistance, mediumMaxDistance, highMaxDistance, highMinGapToSecond } = SCAN_CONFIG.confidence;
  if (best.distance > noResultMinDistance) return "none";
  const gapToSecond = second ? second.distance - best.distance : Infinity;
  if (best.distance <= highMaxDistance && gapToSecond >= highMinGapToSecond) return "high";
  if (best.distance <= mediumMaxDistance) return "medium";
  return "low";
}

/**
 * Famílias com capacidades diferentes (copo-life, garrafa-fresh): quando o
 * melhor candidato pertence a uma família visual e tem variant_key
 * conhecido, procura no catálogo REAL (products/product_variants, nunca
 * texto inventado) outros produtos da mesma família+variante em capacidades
 * diferentes, e os inclui como candidatos adicionais — sem pré-selecionar
 * qual capacidade é a certa.
 */
async function expandFamilySiblings(admin: SupabaseClient, best: SimilarityMatch): Promise<RecognizeCandidate[]> {
  if (!best.visual_family_key || !best.variant_key) return [];

  // active=true filtrado no produto E na variante — a variante irmã (mesma
  // variant_key) precisa existir e estar ativa pra virar candidato real.
  const { data, error } = await admin
    .from("products")
    .select("id, name, capacity_ml, visual_family_key, active, product_variants!inner(id, sku_code, variant_key, active)")
    .eq("visual_family_key", best.visual_family_key)
    .eq("product_variants.variant_key", best.variant_key)
    .eq("product_variants.active", true)
    .eq("active", true)
    .neq("id", best.product_id);
  if (error || !data) return [];

  interface SiblingRow {
    id: string;
    name: string;
    capacity_ml: number | null;
    visual_family_key: string | null;
    product_variants: { id: string; sku_code: string; variant_key: string | null }[];
  }

  return (data as unknown as SiblingRow[])
    .filter((p) => p.product_variants.length > 0)
    .map((p) => {
      const variant = p.product_variants[0];
      return {
        product_id: p.id,
        variant_id: variant.id,
        sku_outlet: variant.sku_code,
        nome: p.name,
        imagem: null,
        storage_path: null,
        capacity_ml: p.capacity_ml,
        visual_family_key: p.visual_family_key,
        variant_key: best.variant_key,
        score: best.score_raw, // mesma variante/estampa — herda o score do candidato visualmente confirmado
        confidence_level: computeConfidence(best, undefined),
        from_family_expansion: true,
      };
    });
}

export async function recognizeFrame(admin: SupabaseClient, imageBuffer: Buffer): Promise<RecognizeResult> {
  const startedAt = Date.now();
  const recognitionId = crypto.randomUUID();

  const queryVector = await generateImageEmbedding(imageBuffer);
  const { matches, usedPgvector } = await findSimilarImages(admin, queryVector, SCAN_CONFIG.rawMatchLimit);

  const grouped = groupByProduct(matches);
  const top = grouped.slice(0, SCAN_CONFIG.topCandidates);
  const best = top[0];
  const second = top[1];
  const confidenceLevel = computeConfidence(best, second);

  const baseCandidates: RecognizeCandidate[] = top.map((m) => ({
    product_id: m.product_id,
    variant_id: m.variant_id,
    sku_outlet: m.sku_code,
    nome: m.product_name,
    imagem: m.product_image_id,
    storage_path: m.storage_path,
    capacity_ml: m.capacity_ml,
    visual_family_key: m.visual_family_key,
    variant_key: m.variant_key,
    score: m.score_raw,
    confidence_level: computeConfidence(m, undefined),
    from_family_expansion: false,
  }));

  let requiresCapacitySelection = false;
  let candidates = baseCandidates;

  if (best && confidenceLevel !== "none") {
    const siblings = await expandFamilySiblings(admin, best);
    if (siblings.length > 0) {
      requiresCapacitySelection = true;
      const existingIds = new Set(candidates.map((c) => c.product_id));
      candidates = [...candidates, ...siblings.filter((s) => !existingIds.has(s.product_id))];
    }
  }

  const status: RecognizeResult["status"] = confidenceLevel === "none" ? "no_result" : requiresCapacitySelection ? "ambiguous" : "matched";
  // "Sem resultado: nenhum candidato confiável" — se a confiança é "none", não
  // devolve os candidatos brutos (que podem ter score negativo/sem sentido);
  // o chamador nunca deve ter a tentação de usar um SKU de baixíssima confiança.
  const code: RecognizeErrorCode | undefined =
    status === "no_result" ? (matches.length === 0 ? "NO_EMBEDDINGS_FOUND" : "NO_MATCH_ABOVE_THRESHOLD") : undefined;
  if (status === "no_result") candidates = [];

  // Diagnóstico dev-only: os 5 melhores candidatos brutos, nunca a imagem/vetor.
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[scan/recognize/debug] top5=${JSON.stringify(
        grouped.slice(0, 5).map((m) => ({ sku: m.sku_code, product: m.product_name, score: Number(m.score_raw.toFixed(4)) }))
      )} code=${code ?? "-"}`
    );
  }

  return {
    recognition_id: recognitionId,
    status,
    confidence_level: confidenceLevel,
    candidates,
    visual_family: best?.visual_family_key ?? null,
    variant: best?.variant_key ?? null,
    requires_capacity_selection: requiresCapacitySelection,
    processing_time_ms: Date.now() - startedAt,
    used_pgvector: usedPgvector,
    code,
  };
}

export { MODEL_NAME, MODEL_VERSION };
