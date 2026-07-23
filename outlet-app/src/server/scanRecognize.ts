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
import { measureAspectRatio, isAspectRatioInconsistentWithCategory } from "./structuralSignals.ts";

export interface RecognizeCandidate {
  product_id: string;
  variant_id: string | null;
  sku_outlet: string;
  nome: string;
  imagem: string | null; // product_image_id da melhor imagem que sustentou este candidato
  storage_path: string | null;
  capacity_ml: number | null;
  category: string | null;
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
export type RecognizeErrorCode =
  | "NO_EMBEDDINGS_FOUND"
  | "NO_MATCH_ABOVE_THRESHOLD"
  | "CATEGORY_MISMATCH"
  | "CATEGORY_UNCERTAIN"
  | "FAMILY_MISMATCH"
  | "ASPECT_RATIO_MISMATCH";

export interface RecognizeResult {
  recognition_id: string;
  status: "matched" | "ambiguous" | "no_result";
  confidence_level: ConfidenceLevel;
  candidates: RecognizeCandidate[];
  visual_family: string | null;
  variant: string | null;
  /** Categoria (garrafa/copo/...) decidida por votação entre os vizinhos brutos — null quando não há evidência suficiente (sem maioria clara ou catálogo sem categoria cadastrada). Nunca deduzida do nome do candidato. */
  detected_category: string | null;
  /** Família visual (ex.: "garrafa-fresh") decidida DEPOIS da categoria já confirmada — null quando a categoria não estava clara o suficiente pra tentar família, ou sem evidência. */
  detected_family: string | null;
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

/**
 * BUG REAL corrigido: uma Garrafa Fresh 650ml (categoria "garrafa") era
 * sugerida como Copo Vibe 470ml (categoria "copo") porque o pipeline nunca
 * teve noção de categoria — só distância. Medição real contra os embeddings
 * do catálogo mostrou que a distância cruzada garrafa-fresh↔copo-vibe fica
 * em 0.19-0.29, DENTRO do threshold de confiança média (0.38); nada impedia
 * o vizinho mais próximo (por cor/fundo parecidos) de vencer mesmo sendo de
 * categoria diferente.
 *
 * TENTATIVA DESCARTADA (registrada aqui pra não repetir o erro): a primeira
 * versão votava a categoria por CONTAGEM de vizinhos brutos por categoria.
 * Testando de ponta a ponta contra o catálogo real após a migration 0015,
 * essa versão quebrou o caso inverso: usando a própria foto do Copo Vibe
 * preto como consulta (o caso mais fácil possível — distância 0 pra si
 * mesmo), a votação por contagem respondia "garrafa", porque a família
 * garrafa-fresh tinha muito mais imagens no catálogo (33 produtos) do que
 * copo-vibe (12, a maioria sem foto ainda) — contagem bruta é enviesada
 * pelo TAMANHO do catálogo por categoria, não pela similaridade real.
 *
 * Versão corrigida: compara a MELHOR distância de cada categoria entre os
 * vizinhos brutos (não quantos vizinhos ela tem, só o melhor) — imune ao
 * desbalanceamento do catálogo, porque uma foto idêntica (distância 0)
 * sempre vence qualquer quantidade de vizinhos de outra categoria, não
 * importa quantos existam. Só declara "clear" quando a categoria vencedora
 * tem uma vantagem mínima (categoryGateMinGap) sobre a 2ª melhor categoria
 * presente — evita travar decisões em empates/quase-empates. Validado
 * contra os 4 SKUs-âncora reais (garrafa preto/branco, copo preto/branco)
 * antes de entrar no código.
 *
 * Produtos sem `category` cadastrada (catálogo incompleto) não entram na
 * comparação e não são bloqueados como candidatos — não há como aplicar uma
 * rede de segurança sobre um dado que não existe; isso é reportado no
 * diagnóstico, nunca inventado.
 *
 * SEGUNDO BUG REAL corrigido (evidência de produção, não simulação): a folga
 * relativa acima só prova que a categoria vencedora é MELHOR que a 2ª — não
 * prova que ela é um bom match em termos absolutos. Um caso real mediu
 * garrafa=0.57 (péssimo) vs copo=0.37 (mediano, mas ainda dentro de
 * mediumMaxDistance) — folga de 0.20, "clara" pelo critério de gap, mas
 * copo=0.37 não é evidência confiável o suficiente pra apostar a categoria.
 * Por isso `detectCategory` agora também exige que a distância da vencedora
 * fique dentro de `categoryMaxDistance` (mais rígido que mediumMaxDistance)
 * — ver scanConfig.ts para a evidência completa por trás desse valor.
 */
const CATEGORY_GATE_MIN_GAP = 0.05;
// Família (subdivisão dentro de uma categoria já confirmada — ex.: dentro de
// "garrafa": fresh/flip-pro/urban/mini/magsafe/fun) usa a MESMA técnica e uma
// margem inicial igual à de categoria. Única medição real disponível até
// agora (copo-vibe vs copo-life, mesma categoria "copo"): distância cruzada
// ~0.22-0.23 contra intra-família ~0.13 — gap de ~0.09, folgado sobre 0.05.
// Reutiliza também o teto absoluto de categoria (categoryMaxDistance) até
// haver medição própria de família — mesma ordem de grandeza observada.
const FAMILY_GATE_MIN_GAP = 0.05;

/**
 * Núcleo compartilhado por detectCategory/detectFamily: compara a MELHOR
 * distância de cada valor do campo indicado entre os matches recebidos (não
 * conta quantos matches cada valor tem — ver comentário grande acima sobre
 * por que contagem é enviesada pelo tamanho do catálogo). Só declara "clear"
 * quando a vencedora tem folga mínima sobre a 2ª colocada E é um bom match em
 * termos absolutos.
 */
function detectBestByField(
  matches: SimilarityMatch[],
  field: "category" | "visual_family_key",
  minGap: number,
  maxDistance: number
): { value: string | null; confidence: "clear" | "uncertain" | "unknown"; bestDistanceByValue: Record<string, number> } {
  const bestByValue = new Map<string, number>();
  for (const m of matches) {
    const key = m[field];
    if (!key) continue;
    const current = bestByValue.get(key);
    if (current === undefined || m.distance < current) bestByValue.set(key, m.distance);
  }
  if (bestByValue.size === 0) return { value: null, confidence: "unknown", bestDistanceByValue: {} };

  const sorted = Array.from(bestByValue.entries()).sort((a, b) => a[1] - b[1]); // menor distância primeiro
  const [topValue, topDistance] = sorted[0];
  const secondDistance = sorted[1]?.[1];
  const hasSufficientGap = secondDistance === undefined || secondDistance - topDistance >= minGap;
  const isGoodAbsoluteMatch = topDistance <= maxDistance;
  const isClear = hasSufficientGap && isGoodAbsoluteMatch;

  return {
    value: topValue,
    confidence: isClear ? "clear" : "uncertain",
    bestDistanceByValue: Object.fromEntries(sorted),
  };
}

export interface CategoryDetection {
  category: string | null;
  /** "clear": vantagem suficiente pra usar como gate. "uncertain": evidência insuficiente — não bloqueia nada. */
  confidence: "clear" | "uncertain" | "unknown";
  /** Melhor (menor) distância bruta por categoria — só diagnóstico. */
  bestDistanceByCategory: Record<string, number>;
}

export function detectCategory(rawMatches: SimilarityMatch[]): CategoryDetection {
  const result = detectBestByField(rawMatches, "category", CATEGORY_GATE_MIN_GAP, SCAN_CONFIG.confidence.categoryMaxDistance);
  return { category: result.value, confidence: result.confidence, bestDistanceByCategory: result.bestDistanceByValue };
}

/**
 * Gate de categoria isolado em função pura (testável sem banco/embeddings
 * reais): só filtra quando `detection.confidence === "clear"` — evidência
 * fraca ou catálogo sem categoria cadastrada nunca bloqueia nada. Produtos
 * sem `category` (dado incompleto) passam sempre, nunca são tratados como
 * incompatíveis por omissão.
 */
export function applyCategoryGate(grouped: SimilarityMatch[], detection: CategoryDetection): SimilarityMatch[] {
  if (detection.confidence !== "clear") return grouped;
  return grouped.filter((m) => !m.category || m.category === detection.category);
}

/**
 * ESTÁGIO DE FAMÍLIA (Categoria → FAMÍLIA → SKU/cor) — refatoração pedida
 * depois de confirmar, com logs reais de produção, que o gate de categoria
 * sozinho impede garrafa↔copo mas NÃO impede a cor/SKU específico de oscilar
 * dentro da própria garrafa (ex.: GFGCM13OUT-28, depois -1, depois -19 em
 * ticks consecutivos do mesmo objeto parado). A causa: categoria e SKU eram
 * decididos juntos, numa competição só. Este estágio decide a FAMÍLIA visual
 * (ex.: "garrafa-fresh" dentro de "garrafa") antes de qualquer disputa de
 * cor — só entra em ação quando a categoria já está confirmada
 * (CategoryResolution "gated"), pra não votar família com ruído de outras
 * categorias misturado.
 */
export interface FamilyDetection {
  family: string | null;
  confidence: "clear" | "uncertain" | "unknown";
  bestDistanceByFamily: Record<string, number>;
}

export function detectFamily(categoryFilteredMatches: SimilarityMatch[]): FamilyDetection {
  const result = detectBestByField(
    categoryFilteredMatches,
    "visual_family_key",
    FAMILY_GATE_MIN_GAP,
    SCAN_CONFIG.confidence.categoryMaxDistance
  );
  return { family: result.value, confidence: result.confidence, bestDistanceByFamily: result.bestDistanceByValue };
}

/** Mesmo princípio de applyCategoryGate: só filtra com família "clear"; produto sem família cadastrada nunca é bloqueado. */
export function applyFamilyGate(matches: SimilarityMatch[], detection: FamilyDetection): SimilarityMatch[] {
  if (detection.confidence !== "clear") return matches;
  return matches.filter((m) => !m.visual_family_key || m.visual_family_key === detection.family);
}

export type CategoryResolution = "gated" | "uncertain_high_confidence_override" | "uncertain_blocked" | "no_evidence";

/**
 * Decide a lista final de candidatos considerando a categoria:
 *
 * - categoria "clear": aplica o gate normalmente (bloqueia categoria
 *   incompatível).
 * - categoria "uncertain"/"unknown" (sem evidência confiável o suficiente):
 *   NÃO cai de volta pro ranking bruto sem proteção — isso foi exatamente o
 *   bug original. Só aceita o vencedor bruto se ele JÁ for de confiança alta
 *   por si só (distância dentro de highMaxDistance): nesse caso a incerteza
 *   de categoria é provavelmente só ruído de catálogo esparso em torno de um
 *   match excelente, não um risco real. Fora isso, zera a lista — "não
 *   identificado com segurança" é a resposta correta quando nem a categoria
 *   nem o produto têm evidência forte.
 */
export function resolveCandidateList(
  grouped: SimilarityMatch[],
  detection: CategoryDetection
): { candidates: SimilarityMatch[]; resolution: CategoryResolution } {
  if (grouped.length === 0) return { candidates: [], resolution: "no_evidence" };

  if (detection.confidence === "clear") {
    return { candidates: applyCategoryGate(grouped, detection), resolution: "gated" };
  }

  const rawBest = grouped[0];
  const rawBestIsHighConfidence = rawBest.distance <= SCAN_CONFIG.confidence.highMaxDistance;
  return rawBestIsHighConfidence
    ? { candidates: grouped, resolution: "uncertain_high_confidence_override" }
    : { candidates: [], resolution: "uncertain_blocked" };
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
 *
 * BUG REAL corrigido: o catálogo tem produtos DUPLICADOS por engano (ex.:
 * "TCGCM25OUT" e "B-TCGCM25OUT" são o mesmo Copo Vibe 470ml cadastrado duas
 * vezes, mesma capacidade). Sem o filtro de capacidade abaixo, a duplicata
 * aparecia como se fosse uma "capacidade irmã" real, mostrando ao operador
 * uma tela de "escolha entre 470ml e 470ml" — nunca uma capacidade
 * genuinamente diferente. Só entra como candidato de expansão quem tem
 * `capacity_ml` preenchido E diferente do candidato vencedor.
 */
async function expandFamilySiblings(admin: SupabaseClient, best: SimilarityMatch): Promise<RecognizeCandidate[]> {
  if (!best.visual_family_key || !best.variant_key) return [];

  // active=true filtrado no produto E na variante — a variante irmã (mesma
  // variant_key) precisa existir e estar ativa pra virar candidato real.
  const { data, error } = await admin
    .from("products")
    .select("id, name, capacity_ml, category, visual_family_key, active, product_variants!inner(id, sku_code, variant_key, active)")
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
    category: string | null;
    visual_family_key: string | null;
    product_variants: { id: string; sku_code: string; variant_key: string | null }[];
  }

  const siblingRows = (data as unknown as SiblingRow[])
    .filter((p) => p.product_variants.length > 0)
    // só é uma capacidade "irmã" de verdade se tiver capacidade cadastrada E
    // diferente da do candidato vencedor — do contrário é duplicata de
    // cadastro (mesmo produto, mesma capacidade, cadastrado 2x).
    .filter((p) => p.capacity_ml !== null && p.capacity_ml !== best.capacity_ml);

  // BUG REAL corrigido: além da duplicata contra o vencedor, o catálogo
  // também tem casos de duas variantes IRMÃS com a MESMA capacidade entre
  // si (ex.: "GFGCM14OUT-1" e "OUT-GFGCM14-BAHIA-1", ambas garrafa-fresh
  // preta 950ml — SKUs de origem diferente, mesmo visual). Mostrar as duas
  // como se fossem opções de capacidades diferentes confundiria o operador
  // do mesmo jeito que a duplicata original — mantém só uma por capacidade.
  const seenCapacities = new Set<number>();
  const deduped = siblingRows.filter((p) => {
    if (seenCapacities.has(p.capacity_ml as number)) return false;
    seenCapacities.add(p.capacity_ml as number);
    return true;
  });

  return deduped.map((p) => {
    const variant = p.product_variants[0];
    return {
      product_id: p.id,
      variant_id: variant.id,
      sku_outlet: variant.sku_code,
      nome: p.name,
      imagem: null,
      storage_path: null,
      capacity_ml: p.capacity_ml,
      category: p.category,
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

  // Categoria detectada por votação entre os vizinhos BRUTOS (antes de
  // agrupar por produto) — ver comentário de detectCategory() sobre por que
  // isso resolve o falso positivo garrafa→copo sem depender do nome do
  // candidato vencedor.
  const categoryDetection = detectCategory(matches);

  const grouped = groupByProduct(matches);
  const { candidates: categoryFiltered, resolution } = resolveCandidateList(grouped, categoryDetection);
  // true quando o filtro de categoria efetivamente descartou o vencedor global
  // (ex.: copo venceu globalmente, mas a categoria detectada foi "garrafa").
  const categoryConflict = !!grouped[0] && categoryFiltered[0] !== grouped[0];

  // Estágio de FAMÍLIA — só roda quando a categoria já foi confirmada com
  // clareza (resolution="gated"); nos outros casos (incerta, aceita por
  // alta confiança isolada, sem evidência) não há uma categoria "limpa" o
  // suficiente pra votar família com segurança, então esse estágio some
  // (family fica null) e o pipeline segue só com o filtro de categoria.
  const familyDetection: FamilyDetection =
    resolution === "gated" ? detectFamily(applyCategoryGate(matches, categoryDetection)) : { family: null, confidence: "unknown", bestDistanceByFamily: {} };
  const familyFiltered = resolution === "gated" ? applyFamilyGate(categoryFiltered, familyDetection) : categoryFiltered;
  // true quando o filtro de família descartou o vencedor pós-categoria (ex.:
  // Fresh venceu a disputa de categoria "garrafa", mas a família detectada
  // foi "garrafa-urban" — SKU de família diferente nunca decide a cor certa).
  const familyConflict = resolution === "gated" && !!categoryFiltered[0] && familyFiltered[0] !== categoryFiltered[0];

  const top = familyFiltered.slice(0, SCAN_CONFIG.topCandidates);
  const best = top[0];
  const second = top[1];
  const confidenceLevel = computeConfidence(best, second);

  // Sinal estrutural REAL (não embedding): proporção altura/largura medida
  // recortando o fundo do PRÓPRIO frame recebido — ver structuralSignals.ts.
  //
  // BUG REAL corrigido antes de qualquer uso em produção: a primeira versão
  // usava isto como VETO (rejeitava "garrafa" se a proporção medida fosse
  // baixa/larga). Calibrei o limiar (2.9) só com a família garrafa-fresh
  // (3.11-3.35) e copo (1.74-2.69). Ao importar fotos reais das 5 famílias
  // novas de garrafa (auditoria desta sessão), medi proporções REAIS muito
  // diferentes dentro da própria categoria "garrafa": Urban=1.43,
  // Fun=0.83, Mini=2.55, Fresh=3.1+, Magsafe=4.03 — um limiar único
  // "garrafa vs copo" não se sustenta quando o catálogo tem formatos de
  // garrafa tão diferentes entre si (baixa/larga a alta/estreita). Usar
  // isso como veto rejeitava incorretamente Urban/Mini/Fun, mesmo com
  // categoria E família corretas por embedding com confiança alta. Por
  // isso isto agora é só DIAGNÓSTICO (nunca muda o resultado) até haver
  // medição real por FAMÍLIA (não por categoria) o suficiente pra calibrar
  // uma faixa própria de cada uma.
  const aspectMeasurement = await measureAspectRatio(imageBuffer);
  const aspectRatioConflict = false;
  void isAspectRatioInconsistentWithCategory; // mantido para uso futuro (faixa por família), não removido

  const baseCandidates: RecognizeCandidate[] = top.map((m) => ({
    product_id: m.product_id,
    variant_id: m.variant_id,
    sku_outlet: m.sku_code,
    nome: m.product_name,
    imagem: m.product_image_id,
    storage_path: m.storage_path,
    capacity_ml: m.capacity_ml,
    category: m.category,
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

  // "Sem candidato compatível": o gate de categoria OU o de família zerou a
  // lista. Categoria: seja porque foi detectada com clareza e todo mundo que
  // sobrou era incompatível (resolution="gated" + lista vazia), seja porque
  // ficou incerta e o vencedor bruto não tinha confiança absoluta alta o
  // suficiente pra confiar mesmo assim (resolution="uncertain_blocked").
  // Família: a categoria foi confirmada, mas a família vencedora não tinha
  // candidatos daquela família específica sobrando (raro — normalmente
  // significa catálogo incompleto pra aquela família). Nunca cai pro
  // candidato bruto vencedor nesses casos, mesmo com distância baixa — é
  // exatamente o caso real Garrafa Fresh 650ml → Copo Vibe 470ml.
  const noCompatibleCategoryCandidate = grouped.length > 0 && categoryFiltered.length === 0;
  const noCompatibleFamilyCandidate = categoryFiltered.length > 0 && familyFiltered.length === 0;
  const noCompatibleCandidate = noCompatibleCategoryCandidate || noCompatibleFamilyCandidate;

  const status: RecognizeResult["status"] =
    aspectRatioConflict || confidenceLevel === "none" || noCompatibleCandidate
      ? "no_result"
      : requiresCapacitySelection
        ? "ambiguous"
        : "matched";
  // "Sem resultado: nenhum candidato confiável" — se a confiança é "none", não
  // devolve os candidatos brutos (que podem ter score negativo/sem sentido);
  // o chamador nunca deve ter a tentação de usar um SKU de baixíssima confiança.
  const code: RecognizeErrorCode | undefined =
    status === "no_result"
      ? matches.length === 0
        ? "NO_EMBEDDINGS_FOUND"
        : aspectRatioConflict
          ? "ASPECT_RATIO_MISMATCH"
          : !noCompatibleCandidate
            ? "NO_MATCH_ABOVE_THRESHOLD"
            : noCompatibleFamilyCandidate
              ? "FAMILY_MISMATCH"
              : resolution === "uncertain_blocked"
                ? "CATEGORY_UNCERTAIN"
                : "CATEGORY_MISMATCH"
      : undefined;
  if (status === "no_result") candidates = [];

  // Diagnóstico dev-only: os 5 melhores candidatos brutos (globais, sem
  // filtro) + categoria e família decididas, nunca a imagem/vetor.
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[scan/recognize/debug] top5=${JSON.stringify(
        grouped.slice(0, 5).map((m) => ({ sku: m.sku_code, product: m.product_name, category: m.category, family: m.visual_family_key, source: m.source, score: Number(m.score_raw.toFixed(4)) }))
      )} categoria=${categoryDetection.category ?? "-"} (${categoryDetection.confidence}) familia=${familyDetection.family ?? "-"} (${
        familyDetection.confidence
      }, melhores_distancias=${JSON.stringify(familyDetection.bestDistanceByFamily)}) resolucao=${resolution} conflito_categoria=${categoryConflict} conflito_familia=${familyConflict} proporcao=${
        aspectMeasurement ? `${aspectMeasurement.ratio.toFixed(2)}(${aspectMeasurement.trustworthy ? "confiavel" : "nao-confiavel"})` : "-"
      } conflito_proporcao=${aspectRatioConflict} code=${code ?? "-"}`
    );
  }

  return {
    recognition_id: recognitionId,
    status,
    confidence_level: confidenceLevel,
    candidates,
    visual_family: best?.visual_family_key ?? null,
    variant: best?.variant_key ?? null,
    detected_category: categoryDetection.category,
    detected_family: familyDetection.family,
    requires_capacity_selection: requiresCapacitySelection,
    processing_time_ms: Date.now() - startedAt,
    used_pgvector: usedPgvector,
    code,
  };
}

export { MODEL_NAME, MODEL_VERSION };
