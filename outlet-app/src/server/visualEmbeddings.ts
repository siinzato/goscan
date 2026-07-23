// Orquestra a geração de embeddings visuais em lote ("Preparar imagens para
// o Scan") e a busca por similaridade usada pelo teste interno da Parte 2.
// Mesmo padrão de catalogImages.ts: erro isolado por linha, nunca derruba o
// lote inteiro; estado inteiramente no banco (retomável a qualquer momento).
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateImageEmbedding, cosineSimilarity, MODEL_NAME, MODEL_VERSION, EMBEDDING_DIMENSION } from "./embeddingPipeline.ts";

const BUCKET = "product-images";

interface EligibleImageRow {
  id: string;
  storage_path: string | null;
  image_hash: string | null;
  product_variant_id: string;
}

export interface EmbeddingBatchItemResult {
  product_image_id: string;
  status: "success" | "error" | "skipped_deduped";
  error?: string;
}

export interface EmbeddingBatchResult {
  processed: EmbeddingBatchItemResult[];
  remainingPending: number;
}

/**
 * Imagens elegíveis: ativas, não arquivadas, aprovadas, com reconhecimento
 * habilitado, já processadas (pronta) e vinculadas a variante/produto ativos.
 * Uma imagem rejeitada/arquivada nunca aparece aqui — é filtrado direto na
 * query, não é uma checagem "depois".
 *
 * BUG REAL corrigido: a versão anterior buscava `.limit(limit * 3)` SEM
 * excluir as já processadas na própria query e sem `order by`. Quando o
 * total de imagens elegíveis passava desse limite, uma imagem podia cair
 * fora da janela retornada e nunca mais ser buscada — mesmo rodando o lote
 * dezenas de vezes, ela ficava presa em "pendente" pra sempre (reproduzido
 * de verdade: 16 elegíveis, limit=5 => janela de 15, a 16ª nunca aparecia).
 * Agora o anti-join contra image_embeddings acontece ANTES do corte por
 * `limit`, garantindo que toda chamada avança de verdade.
 */
async function fetchEligibleImages(admin: SupabaseClient, limit: number, variantId?: string): Promise<EligibleImageRow[]> {
  let query = admin
    .from("product_images")
    .select("id, storage_path, image_hash, product_variant_id, product_variants!inner(active)")
    .eq("is_active", true)
    .is("archived_at", null)
    .eq("quality_status", "aprovada")
    .eq("recognition_enabled", true)
    .eq("processing_status", "pronta")
    .eq("product_variants.active", true)
    .not("storage_path", "is", null)
    .order("id", { ascending: true });
  if (variantId) query = query.eq("product_variant_id", variantId);
  const { data: eligible, error } = await query;
  if (error) throw error;

  const rows = (eligible as unknown as EligibleImageRow[]) || [];
  if (rows.length === 0) return [];

  const { data: readyRows, error: readyError } = await admin
    .from("image_embeddings")
    .select("product_image_id, image_hash")
    .eq("model_name", MODEL_NAME)
    .eq("model_version", MODEL_VERSION)
    .eq("status", "ready")
    .in(
      "product_image_id",
      rows.map((r) => r.id)
    );
  if (readyError) throw readyError;

  const readyKeys = new Set((readyRows || []).map((r) => `${r.product_image_id}:${r.image_hash}`));
  const pending = rows.filter((r) => !readyKeys.has(`${r.id}:${r.image_hash}`));
  return pending.slice(0, limit);
}

// fetchEligibleImages já garante que só candidatos genuinamente pendentes
// chegam aqui (anti-join contra image_embeddings feito na própria query) —
// não precisa reconferir por imagem.
async function processOneImage(admin: SupabaseClient, img: EligibleImageRow): Promise<EmbeddingBatchItemResult> {
  await admin.from("image_embeddings").upsert(
    {
      product_image_id: img.id,
      model_name: MODEL_NAME,
      model_version: MODEL_VERSION,
      status: "processing",
      image_hash: img.image_hash,
    },
    { onConflict: "product_image_id,model_name,model_version" }
  );

  try {
    const { data: fileData, error: downloadError } = await admin.storage.from(BUCKET).download(img.storage_path!);
    if (downloadError || !fileData) throw new Error(`Falha ao baixar a imagem do Storage: ${downloadError?.message || "arquivo não encontrado"}`);
    const buffer = Buffer.from(await fileData.arrayBuffer());

    const vector = await generateImageEmbedding(buffer);

    const { error: updateError } = await admin
      .from("image_embeddings")
      .update({
        embedding: vector,
        // embedding_vector (pgvector, migration 0012) é opcional — só existe
        // se a extensão estiver disponível no projeto. Tenta escrever nela
        // também (mantém o índice pgvector sincronizado); se a coluna não
        // existir, cai para gravar só o jsonb (ver catch abaixo).
        embedding_vector: vector,
        dimension: EMBEDDING_DIMENSION,
        status: "ready",
        error_message: null,
        processed_at: new Date().toISOString(),
        image_hash: img.image_hash,
      })
      .eq("product_image_id", img.id)
      .eq("model_name", MODEL_NAME)
      .eq("model_version", MODEL_VERSION);

    if (updateError && /embedding_vector/.test(updateError.message)) {
      // Migration 0012 (pgvector) não aplicada neste projeto — grava só o jsonb.
      const { error: fallbackError } = await admin
        .from("image_embeddings")
        .update({
          embedding: vector,
          dimension: EMBEDDING_DIMENSION,
          status: "ready",
          error_message: null,
          processed_at: new Date().toISOString(),
          image_hash: img.image_hash,
        })
        .eq("product_image_id", img.id)
        .eq("model_name", MODEL_NAME)
        .eq("model_version", MODEL_VERSION);
      if (fallbackError) throw fallbackError;
    } else if (updateError) {
      throw updateError;
    }

    return { product_image_id: img.id, status: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin
      .from("image_embeddings")
      .update({ status: "error", error_message: message })
      .eq("product_image_id", img.id)
      .eq("model_name", MODEL_NAME)
      .eq("model_version", MODEL_VERSION);
    return { product_image_id: img.id, status: "error", error: message };
  }
}

export async function processEmbeddingBatch(admin: SupabaseClient, limit = 5): Promise<EmbeddingBatchResult> {
  const candidates = await fetchEligibleImages(admin, limit);
  const results: EmbeddingBatchItemResult[] = [];

  for (const img of candidates) {
    results.push(await processOneImage(admin, img));
  }

  const remainingPending = await countPendingEligible(admin);
  return { processed: results, remainingPending };
}

/**
 * Reprocessa só as imagens de UMA variante (produto) — pedido explícito para
 * quem acabou de adicionar/trocar fotos de um produto específico e não quer
 * esperar o lote geral. Mesma lógica de elegibilidade/dedup, só filtrada por
 * product_variant_id; processa tudo de uma vez (um produto tem poucas fotos).
 */
export async function processEmbeddingsForVariant(admin: SupabaseClient, variantId: string): Promise<EmbeddingBatchResult> {
  const results: EmbeddingBatchItemResult[] = [];
  let guard = 0;
  while (guard < 20) {
    guard++;
    const candidates = await fetchEligibleImages(admin, 5, variantId);
    if (candidates.length === 0) break;
    for (const img of candidates) {
      results.push(await processOneImage(admin, img));
    }
  }
  return { processed: results, remainingPending: 0 };
}

/** "Pendente" = elegível e sem embedding pronto+atual ainda — mesmo anti-join de fetchEligibleImages, sem cortar por limit. */
async function countPendingEligible(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin
    .from("product_images")
    .select("id, image_hash, product_variants!inner(active)")
    .eq("is_active", true)
    .is("archived_at", null)
    .eq("quality_status", "aprovada")
    .eq("recognition_enabled", true)
    .eq("processing_status", "pronta")
    .eq("product_variants.active", true);
  if (error) throw error;

  const rows = (data as { id: string; image_hash: string | null }[]) || [];
  if (rows.length === 0) return 0;

  const { data: readyRows, error: readyError } = await admin
    .from("image_embeddings")
    .select("product_image_id, image_hash")
    .eq("model_name", MODEL_NAME)
    .eq("model_version", MODEL_VERSION)
    .eq("status", "ready")
    .in(
      "product_image_id",
      rows.map((r) => r.id)
    );
  if (readyError) throw readyError;

  const readyKeys = new Set((readyRows || []).map((r) => `${r.product_image_id}:${r.image_hash}`));
  return rows.filter((r) => !readyKeys.has(`${r.id}:${r.image_hash}`)).length;
}

export interface EmbeddingStatusSummary {
  eligible_total: number;
  ready: number;
  pending: number;
  processing: number;
  error: number;
}

export async function getEmbeddingStatusSummary(admin: SupabaseClient): Promise<EmbeddingStatusSummary> {
  const { count: eligibleTotal } = await admin
    .from("product_images")
    .select("id, product_variants!inner(active)", { count: "exact", head: true })
    .eq("is_active", true)
    .is("archived_at", null)
    .eq("quality_status", "aprovada")
    .eq("recognition_enabled", true)
    .eq("processing_status", "pronta")
    .eq("product_variants.active", true);

  const { count: ready } = await admin
    .from("image_embeddings")
    .select("id", { count: "exact", head: true })
    .eq("model_name", MODEL_NAME)
    .eq("model_version", MODEL_VERSION)
    .eq("status", "ready");
  const { count: processing } = await admin
    .from("image_embeddings")
    .select("id", { count: "exact", head: true })
    .eq("model_name", MODEL_NAME)
    .eq("model_version", MODEL_VERSION)
    .eq("status", "processing");
  const { count: error } = await admin
    .from("image_embeddings")
    .select("id", { count: "exact", head: true })
    .eq("model_name", MODEL_NAME)
    .eq("model_version", MODEL_VERSION)
    .eq("status", "error");

  const pending = await countPendingEligible(admin);

  return {
    eligible_total: eligibleTotal ?? 0,
    ready: ready ?? 0,
    pending,
    processing: processing ?? 0,
    error: error ?? 0,
  };
}

export async function resetErrorEmbeddings(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin
    .from("image_embeddings")
    .update({ status: "pending", error_message: null })
    .eq("model_name", MODEL_NAME)
    .eq("model_version", MODEL_VERSION)
    .eq("status", "error")
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

export interface SimilarityMatch {
  product_image_id: string;
  product_id: string;
  variant_id: string;
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
  /** "catalog": foto oficial (product_images). "learned": referência da memória visual (visual_learning_samples, migration 0016) — ver visualLearning.ts. */
  source: "catalog" | "learned";
}

interface LearningSampleJoinRow {
  id: string;
  product_id: string;
  variant_id: string;
  storage_path: string;
  category: string | null;
  family: string | null;
  capacity_ml: number | null;
  color: string | null;
  sku_code: string;
  product_name: string;
}

/**
 * Busca nas referências APRENDIDAS (scans confirmados/corrigidos por
 * operadores, migration 0016) — mesmo padrão de findSimilarImages: tenta
 * pgvector primeiro, cai para JS se indisponível. Só "validated"+"active"
 * participam; nunca inclui pending/rejected/disabled.
 */
async function findSimilarLearningSamples(
  admin: SupabaseClient,
  queryVector: number[],
  limit: number
): Promise<SimilarityMatch[]> {
  const { data: rpcData, error: rpcError } = await admin.rpc("match_visual_learning_samples", {
    query_embedding: queryVector,
    match_model: MODEL_NAME,
    match_model_version: MODEL_VERSION,
    match_count: limit,
  });

  let ranked: { sample_id: string; distance: number }[];
  if (!rpcError && rpcData) {
    ranked = (rpcData as { sample_id: string; distance: number }[]).map((r) => ({ sample_id: r.sample_id, distance: r.distance }));
  } else {
    const { data: rows, error: rowsError } = await admin
      .from("visual_learning_samples")
      .select("id, embedding")
      .eq("model_name", MODEL_NAME)
      .eq("model_version", MODEL_VERSION)
      .eq("validation_status", "validated")
      .eq("active", true)
      .not("embedding", "is", null);
    if (rowsError) throw rowsError; // função pode não existir se 0016 não foi aplicada — erro real, não silencia
    ranked = ((rows as { id: string; embedding: number[] }[]) || [])
      .map((r) => ({ sample_id: r.id, distance: 1 - cosineSimilarity(queryVector, r.embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }
  if (ranked.length === 0) return [];

  // Refiltra pelo estado ATUAL — mesmo princípio de findSimilarImages: uma
  // amostra pode ter sido desativada pelo admin depois de "ready".
  const sampleIds = ranked.map((r) => r.sample_id);
  const { data: samplesData, error: samplesError } = await admin
    .from("visual_learning_samples")
    .select("id, product_id, variant_id, storage_path, category, family, capacity_ml, color, sku_code, product_name")
    .in("id", sampleIds)
    .eq("validation_status", "validated")
    .eq("active", true);
  if (samplesError) throw samplesError;

  const byId = new Map((samplesData as LearningSampleJoinRow[]).map((row) => [row.id, row]));
  return ranked
    .map((r): SimilarityMatch | null => {
      const row = byId.get(r.sample_id);
      if (!row) return null;
      return {
        product_image_id: row.id, // amostra aprendida não tem product_image_id real — usa o próprio id da amostra
        product_id: row.product_id,
        variant_id: row.variant_id,
        distance: r.distance,
        score_raw: 1 - r.distance,
        score_normalized: 0, // recalculado depois do merge com o pool completo
        storage_path: row.storage_path,
        sku_code: row.sku_code,
        product_name: row.product_name,
        category: row.category,
        visual_family_key: row.family,
        variant_key: row.color,
        capacity_ml: row.capacity_ml,
        source: "learned",
      };
    })
    .filter((m): m is SimilarityMatch => m !== null);
}

/**
 * Busca as imagens mais semelhantes a um vetor de consulta. Tenta pgvector
 * (match_image_embeddings, migration 0012) primeiro; se a função/extensão não
 * existir (0012 não aplicada ou pgvector indisponível no projeto), cai para
 * comparação em JavaScript sobre os embeddings "ready" — o resultado é o
 * mesmo, só muda a performance. Nunca usa nome/SKU como parte do score.
 */
export async function findSimilarImages(
  admin: SupabaseClient,
  queryVector: number[],
  limit = 5
): Promise<{ matches: SimilarityMatch[]; usedPgvector: boolean }> {
  const { data: rpcData, error: rpcError } = await admin.rpc("match_image_embeddings", {
    query_embedding: queryVector,
    match_model: MODEL_NAME,
    match_model_version: MODEL_VERSION,
    match_count: limit,
  });

  let ranked: { product_image_id: string; distance: number }[];
  let usedPgvector: boolean;

  if (!rpcError && rpcData) {
    ranked = (rpcData as { product_image_id: string; distance: number }[]).map((r) => ({ product_image_id: r.product_image_id, distance: r.distance }));
    usedPgvector = true;
  } else {
    const { data: readyRows, error: readyError } = await admin
      .from("image_embeddings")
      .select("product_image_id, embedding")
      .eq("model_name", MODEL_NAME)
      .eq("model_version", MODEL_VERSION)
      .eq("status", "ready");
    if (readyError) throw readyError;

    ranked = ((readyRows as { product_image_id: string; embedding: number[] }[]) || [])
      .map((r) => ({ product_image_id: r.product_image_id, distance: 1 - cosineSimilarity(queryVector, r.embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
    usedPgvector = false;
  }

  if (ranked.length === 0) return { matches: [], usedPgvector };

  interface ImageJoinRow {
    id: string;
    storage_path: string | null;
    product_variants: {
      id: string;
      sku_code: string;
      variant_key: string | null;
      products: { id: string; name: string; category: string | null; visual_family_key: string | null; capacity_ml: number | null };
    } | null;
  }

  // Refiltra pelo estado ATUAL da imagem/variante/produto — um embedding
  // "ready" pode ter sido gerado antes de a imagem ser arquivada/rejeitada ou
  // o produto ser desativado; nunca confiamos só na existência do embedding.
  const imageIds = ranked.map((r) => r.product_image_id);
  const { data: imagesData, error: imagesError } = await admin
    .from("product_images")
    .select("id, storage_path, product_variants!inner(id, sku_code, variant_key, products!inner(id, name, category, visual_family_key, capacity_ml))")
    .in("id", imageIds)
    .eq("is_active", true)
    .is("archived_at", null)
    .eq("quality_status", "aprovada")
    .eq("recognition_enabled", true)
    .eq("product_variants.active", true)
    .eq("product_variants.products.active", true);
  if (imagesError) throw imagesError;

  const byId = new Map((imagesData as unknown as ImageJoinRow[]).map((row) => [row.id, row]));
  const maxDistance = Math.max(...ranked.map((r) => r.distance), 1e-9);

  const matches: SimilarityMatch[] = ranked
    .map((r): SimilarityMatch | null => {
      const row = byId.get(r.product_image_id);
      if (!row) return null;
      const variant = row.product_variants;
      const product = variant?.products;
      if (!product || !variant) return null;
      const scoreRaw = 1 - r.distance;
      return {
        product_image_id: r.product_image_id,
        product_id: product.id,
        variant_id: variant.id,
        distance: r.distance,
        score_raw: scoreRaw,
        score_normalized: Math.max(0, 1 - r.distance / maxDistance),
        storage_path: row.storage_path,
        sku_code: variant?.sku_code ?? "",
        product_name: product?.name ?? "",
        category: product?.category ?? null,
        visual_family_key: product?.visual_family_key ?? null,
        variant_key: variant?.variant_key ?? null,
        capacity_ml: product?.capacity_ml ?? null,
        source: "catalog" as const,
      };
    })
    .filter((m): m is SimilarityMatch => m !== null);

  // Memória visual (migration 0016): referências de scans reais confirmados/
  // corrigidos por operadores participam do MESMO pool de busca, não de uma
  // lista separada — mesclado aqui e reordenado por distância antes de
  // devolver, pra que groupByProduct (scanRecognize.ts) trate as duas fontes
  // igual. Erro ao buscar aprendizado não derruba o reconhecimento normal —
  // fotos oficiais continuam funcionando mesmo se a memória visual falhar.
  let learned: SimilarityMatch[] = [];
  try {
    learned = await findSimilarLearningSamples(admin, queryVector, limit);
  } catch (err) {
    console.warn("[visualEmbeddings] falha ao buscar memória visual (seguindo só com catálogo oficial):", err instanceof Error ? err.message : err);
  }

  const merged = [...matches, ...learned].sort((a, b) => a.distance - b.distance).slice(0, limit);
  const mergedMaxDistance = Math.max(...merged.map((m) => m.distance), 1e-9);
  const normalized = merged.map((m) => ({ ...m, score_normalized: Math.max(0, 1 - m.distance / mergedMaxDistance) }));

  return { matches: normalized, usedPgvector };
}
