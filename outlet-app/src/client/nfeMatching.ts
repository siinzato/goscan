// EXPANSÃO GOSCAN — Conferência por Nota Fiscal, Parte 2: relacionamento
// item-da-NF → produto cadastrado e cálculo de divergência. Funções puras
// (sem Supabase/DOM) para serem testáveis isoladamente. A responsabilidade
// de nunca misturar com produtos Outlet é da QUERY que monta `candidates`
// (nfeApi.ts filtra product_variants por products.product_type='normal') —
// esta função só decide, dentro do que já veio filtrado, qual candidato bate.
import { normalize, normalizeEan, isValidEanFormat } from "./utils.ts";

export type LinkSource = "sku" | "ean" | "alias" | null;

export interface InvoiceItemKey {
  invoice_product_code: string;
  ean: string | null;
}

export interface NormalVariantCandidate {
  variant_id: string;
  sku_code: string;
  /**
   * CORREÇÃO — Reconhecimento automático por EAN: coluna JÁ NORMALIZADA
   * (dígitos apenas, mantida por trigger no banco — ver migration 0046),
   * nunca o `gtin` cru. Comparar direto contra ela evita reintroduzir uma
   * segunda regra de normalização divergente aqui.
   */
  gtin_normalized: string | null;
}

export interface AliasMaps {
  byCode: Map<string, string>; // invoice_product_code normalizado (normalizeKey) -> variant_id
  byEan: Map<string, string>; // ean normalizado (normalizeEan — dígitos apenas) -> variant_id
}

export interface ResolvedLink {
  variant_id: string | null;
  link_source: LinkSource;
}

/**
 * Normaliza só para efeito de COMPARAÇÃO — nunca usado para regravar o
 * SKU/EAN original. Exportada porque quem monta os mapas de alias
 * (nfeApi.ts) precisa normalizar exatamente do mesmo jeito, senão uma
 * divergência de caixa/hífen entre a gravação e a leitura faria o alias
 * nunca ser encontrado.
 */
export function normalizeKey(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toUpperCase()
    .replace(/[‐-―−]/g, "-"); // hífens Unicode variantes (en/em dash etc.) -> hífen comum
}

/**
 * Prioridade de resolução (ver spec): SKU exato > EAN exato > associação
 * aprendida (invoice_sku_aliases) > nenhuma (exige vínculo manual). Nunca
 * inventa correspondência por similaridade textual/nome aqui — isso fica a
 * cargo da UI, que pode SUGERIR via busca, mas o operador sempre confirma.
 *
 * CORREÇÃO — EAN nunca usa normalizeKey (que só maiúsculiza/trima): usa
 * normalizeEan (dígitos apenas) contra candidate.gtin_normalized, a MESMA
 * regra usada no banco (fetchNormalCandidates já filtra por essa coluna) e
 * na busca manual do catálogo — uma só regra, nunca duas divergentes.
 */
export function resolveInvoiceItem(item: InvoiceItemKey, candidates: NormalVariantCandidate[], aliases?: AliasMaps): ResolvedLink {
  const code = normalizeKey(item.invoice_product_code);
  const ean = normalizeEan(item.ean);

  if (code) {
    const bySku = candidates.find((c) => normalizeKey(c.sku_code) === code);
    if (bySku) return { variant_id: bySku.variant_id, link_source: "sku" };
  }

  if (ean && isValidEanFormat(ean)) {
    // CORREÇÃO — gtin_normalized não tem constraint de unicidade no banco
    // (diferente de sku_code, que tem): se dois produtos ativos distintos
    // estiverem cadastrados com o mesmo EAN (erro de cadastro), o antigo
    // `.find()` escolhia o primeiro silenciosamente. Agora, mais de uma
    // correspondência nunca vincula sozinho — vai para pendência, igual a
    // "não encontrado" (ver mensagem diferenciada na UI).
    const byEan = candidates.filter((c) => c.gtin_normalized === ean);
    if (byEan.length === 1) return { variant_id: byEan[0].variant_id, link_source: "ean" };
  }

  if (aliases) {
    const aliasByCode = code ? aliases.byCode.get(code) : undefined;
    if (aliasByCode) return { variant_id: aliasByCode, link_source: "alias" };
    const aliasByEan = ean ? aliases.byEan.get(ean) : undefined;
    if (aliasByEan) return { variant_id: aliasByEan, link_source: "alias" };
  }

  return { variant_id: null, link_source: null };
}

export type ItemDivergenceStatus = "ok" | "missing" | "surplus" | "pending";

/**
 * Só pode ser chamada na finalização — nunca durante a contagem cega (ver
 * invoice_receipt_items.physical_quantity: NUNCA exibir expected_quantity
 * antes disso). physical=null significa "operador não contou este item".
 */
export function computeItemStatus(expectedQuantity: number, physicalQuantity: number | null): ItemDivergenceStatus {
  if (physicalQuantity === null) return "pending";
  if (physicalQuantity === expectedQuantity) return "ok";
  return physicalQuantity < expectedQuantity ? "missing" : "surplus";
}

export interface ReceiptItemForSummary {
  expected_quantity: number;
  physical_quantity: number | null;
}

export interface ReceiptSummary {
  totalItems: number;
  ok: number;
  missing: number;
  surplus: number;
  pending: number;
  totalExpectedQuantity: number;
  totalPhysicalQuantity: number;
  /** Informativo apenas — NUNCA usado para decidir se a nota está OK (ver regra: -10/+10 em SKUs diferentes não é "zero divergência"). */
  netDifference: number;
  conformityRate: number;
}

/**
 * Resume a conferência por CONTAGEM DE ITENS divergentes, nunca pela soma
 * líquida das diferenças — duas divergências que numericamente se cancelam
 * (ex.: produto A -10, produto B +10) continuam sendo DUAS divergências.
 */
export function summarizeReceipt(items: ReceiptItemForSummary[]): ReceiptSummary {
  let ok = 0;
  let missing = 0;
  let surplus = 0;
  let pending = 0;
  let totalExpectedQuantity = 0;
  let totalPhysicalQuantity = 0;

  for (const item of items) {
    const status = computeItemStatus(item.expected_quantity, item.physical_quantity);
    if (status === "ok") ok++;
    else if (status === "missing") missing++;
    else if (status === "surplus") surplus++;
    else pending++;

    totalExpectedQuantity += item.expected_quantity;
    totalPhysicalQuantity += item.physical_quantity ?? 0;
  }

  const counted = ok + missing + surplus;
  return {
    totalItems: items.length,
    ok,
    missing,
    surplus,
    pending,
    totalExpectedQuantity,
    totalPhysicalQuantity,
    netDifference: totalPhysicalQuantity - totalExpectedQuantity,
    conformityRate: counted > 0 ? ok / counted : 0,
  };
}

// ---------------------------------------------------------------------------
// Sugestão por semelhança de nome — pra quando SKU/EAN/alias não resolveram
// nada (item realmente "unlinked"). NUNCA vincula sozinho: só sugere, sempre
// pede confirmação do operador ("Esse produto é X?"). Comparação por
// conjunto de palavras normalizadas (mesma função normalize() usada em todo
// o resto do app) — encontra "Bolsa Térmica Mix" mesmo que a NF escreva
// "BOLSA TERMICA MIX BB BRUTA MARROM" (ordem/palavras extras não importam).
// ---------------------------------------------------------------------------
export interface NameCandidate {
  variant_id: string;
  sku_code: string;
  produto: string;
  /** EAN cadastrado no produto — carregado pela MESMA consulta que já busca os candidatos (fetchAllNormalProducts), nunca uma query extra. */
  gtin: string | null;
}

export interface NameSuggestion {
  candidate: NameCandidate;
  score: number;
}

function wordsOf(value: string): Set<string> {
  return new Set(normalize(value).split(" ").filter(Boolean));
}

/** Similaridade de Jaccard (interseção/união de palavras) — 0 a 1, nunca inventa pontuação fora dessa faixa. */
export function scoreNameSimilarity(a: string, b: string): number {
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let intersection = 0;
  for (const w of wa) if (wb.has(w)) intersection++;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 ? intersection / union : 0;
}

// PERFORMANCE — causa raiz medida do "tempo de busca pra relacionar
// produtos" lento na importação de NF: a tela de pendências chama
// suggestBestMatch UMA VEZ POR ITEM pendente contra o MESMO array de
// candidatos (catálogo inteiro — 4.018 produtos normais ativos hoje). A
// versão anterior recomputava wordsOf(candidate.produto) (normalize +
// split + Set) do zero em TODA comparação — com N itens pendentes isso é
// N × 4.018 tokenizações repetidas do mesmo texto, sem nenhum motivo (o
// nome do candidato não muda entre itens). Este cache, por referência de
// objeto, tokeniza cada candidato só uma vez e reaproveita nas chamadas
// seguintes — medido: ~29ms/item pendente antes vs. bem menos depois,
// contra o catálogo real (ver measure-nfe-matching.tmp.mjs). scoreNameSimilarity
// continua intocada (mesma assinatura/comportamento, ainda usada direto pelos
// testes) — o cache vive só dentro de suggestBestMatch.
const candidateWordsCache = new WeakMap<NameCandidate, Set<string>>();

function cachedCandidateWords(candidate: NameCandidate): Set<string> {
  let words = candidateWordsCache.get(candidate);
  if (!words) {
    words = wordsOf(candidate.produto);
    candidateWordsCache.set(candidate, words);
  }
  return words;
}

/** threshold default 0.25: exige uma sobreposição real de palavras, não uma coincidência de uma letra/número solto. */
export function suggestBestMatch(description: string, candidates: NameCandidate[], threshold = 0.25): NameSuggestion | null {
  const queryWords = wordsOf(description);
  if (queryWords.size === 0) return null;

  let best: NameCandidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const candidateWords = cachedCandidateWords(candidate);
    if (candidateWords.size === 0) continue;
    let intersection = 0;
    for (const w of queryWords) if (candidateWords.has(w)) intersection++;
    const union = new Set([...queryWords, ...candidateWords]).size;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best && bestScore >= threshold ? { candidate: best, score: bestScore } : null;
}
