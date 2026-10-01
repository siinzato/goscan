// EXPANSÃO GOSCAN — Conferência por Ordem de Carregamento (Outlet). Lê a
// planilha de carregamento (Produto/Descrição/Quantidade — nomes de coluna
// variam entre remetentes, por isso a detecção por cabeçalho com fallback
// posicional abaixo) e cria uma invoice_receipts/invoice_receipt_items com
// source_type='carregamento' (ver migration 0064) — MESMA estrutura da
// Conferência por NF-e, reaproveitando TODAS as funções de contagem/
// finalização de nfeApi.ts sem alterar nenhuma delas.
//
// O vínculo usa o MESMO motor de texto já usado no "Colar texto" do Outlet
// (matchItem, matching.ts) — nunca o motor por SKU/EAN da NF-e — porque a
// maioria dos produtos de um carregamento ainda não existe no catálogo (SKU
// "TX/TR..." da planilha é do remetente, nunca o SKU interno do GoScan).
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";
import { normalize } from "./utils.ts";
import {
  matchItem,
  fetchAliasLists,
  fetchBulkCatalogData,
  type MatchStatus,
  type MatchResult,
  type MatchCandidate,
  type ColorAliasRow,
  type AliasLists,
  type BulkCatalogData,
} from "./matching.ts";
import type { InvoiceReceipt, InvoiceReceiptItem } from "./nfeApi.ts";

function requireUserId(): string {
  const { session } = getAuthState();
  if (!session) throw new Error("Sessão inválida — faça login novamente.");
  return session.user.id;
}

export interface LoadingOrderRowInput {
  produto?: string;
  descricao?: string;
  quantidade?: string;
}

// Procura pelo NOME do cabeçalho primeiro (tolerante a variação de
// remetente) — "produto"/"descrição" é o pedido explícito, mas cobre
// sinônimos comuns do mesmo jeito que já fazemos em purchaseOrderApi.ts.
const HEADER_ALIASES: Record<string, keyof LoadingOrderRowInput> = {
  produto: "produto",
  "sku unico": "produto",
  "sku único": "produto",
  item: "produto",
  descricao: "descricao",
  "descrição": "descricao",
  "descricao webgex": "descricao",
  quantidade: "quantidade",
  qtd: "quantidade",
  qtde: "quantidade",
};

function normalizeHeader(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Mapeia as linhas cruas do XLSX.utils.sheet_to_json. Pedido explícito do
 * usuário: "produto" e "descrição" são SEMPRE a 1ª e a 3ª coluna quando o
 * cabeçalho não usa esses nomes — por isso o fallback por posição abaixo,
 * nunca só por nome de cabeçalho (diferente de purchaseOrderApi.ts).
 */
export function mapLoadingOrderRows(rawRows: Record<string, unknown>[]): LoadingOrderRowInput[] {
  return rawRows.map((raw) => {
    const keys = Object.keys(raw);
    const mapped: LoadingOrderRowInput = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = HEADER_ALIASES[normalizeHeader(key)];
      if (field && value !== undefined && value !== null && String(value).trim() !== "") {
        if (!mapped[field]) mapped[field] = String(value).trim();
      }
    }
    // Fallback posicional — só pros 2 campos que o pedido do usuário cobre
    // explicitamente (coluna 1 = produto, coluna 3 = descrição).
    if (!mapped.produto && keys[0] !== undefined) {
      const v = raw[keys[0]];
      if (v !== undefined && v !== null && String(v).trim() !== "") mapped.produto = String(v).trim();
    }
    if (!mapped.descricao && keys[2] !== undefined) {
      const v = raw[keys[2]];
      if (v !== undefined && v !== null && String(v).trim() !== "") mapped.descricao = String(v).trim();
    }
    // Quantidade não foi pedida explicitamente por posição — mas sem ela não
    // dá pra conferir nada, então cai pra ÚLTIMA coluna da linha (padrão
    // observado nos 2 arquivos reais de carregamento já vistos).
    if (!mapped.quantidade && keys.length > 0) {
      const lastKey = keys[keys.length - 1];
      const v = raw[lastKey];
      if (v !== undefined && v !== null && String(v).trim() !== "") mapped.quantidade = String(v).trim();
    }
    return mapped;
  });
}

export interface LoadingOrderRow {
  produto: string;
  descricao: string | null;
  quantidade: number;
}

export interface LoadingOrderValidation {
  valid: LoadingOrderRow[];
  errors: { row: number; reason: string }[];
}

export function validateLoadingOrderRows(rows: LoadingOrderRowInput[]): LoadingOrderValidation {
  const valid: LoadingOrderRow[] = [];
  const errors: { row: number; reason: string }[] = [];

  rows.forEach((r, idx) => {
    const rowIndex = idx + 2;
    const produto = (r.produto || "").trim();
    if (!produto) {
      errors.push({ row: rowIndex, reason: "Produto é obrigatório (1ª coluna da planilha)." });
      return;
    }
    const quantidade = Number((r.quantidade || "").replace(",", "."));
    if (!r.quantidade || !Number.isFinite(quantidade) || quantidade <= 0) {
      errors.push({ row: rowIndex, reason: "Quantidade inválida ou ausente." });
      return;
    }
    valid.push({ produto, descricao: r.descricao?.trim() || null, quantidade });
  });

  return { valid, errors };
}

/**
 * Converte litragem pra UMA unidade comparável ("NNNml", mesmo formato que o
 * catálogo Outlet já usa nos nomes de produto — ex.: "Copo Térmico Life
 * 880ml") ANTES de qualquer busca por nome. Sem isso, "0,5L"/"1L"/"1 litro"
 * nunca batem com "500ml"/"1000ml" do catálogo mesmo sendo o mesmo valor —
 * causa real confirmada: planilha e catálogo raramente escrevem litragem do
 * mesmo jeito. Roda ANTES de normalize() (que só junta "500 ml" -> "500ml",
 * nunca converte L->ml) pra nunca disputar com a regra de separador de milhar
 * de normalize() (que leria "0,5" como milhar incompleto).
 */
export function canonicalizeCapacity(text: string): string {
  return text.replace(/(\d+(?:[.,]\d+)?)\s*(?:litros?|l)\b/gi, (_match, numStr: string) => {
    const value = parseFloat(numStr.replace(",", "."));
    return `${Math.round(value * 1000)}ml`;
  });
}

/** Acha `needle` em `haystack` como PALAVRA INTEIRA (fronteira de espaço dos 2 lados) — nunca como substring solta dentro de outra palavra (ex.: "rosa" não pode casar dentro de "rosado"). -1 se não achar. */
function findWholeWord(haystack: string, needle: string): number {
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return -1;
    const startOk = idx === 0 || haystack[idx - 1] === " ";
    const endIdx = idx + needle.length;
    const endOk = endIdx === haystack.length || haystack[endIdx] === " ";
    if (startOk && endOk) return idx;
    from = idx + 1;
  }
}

/**
 * Separa "Bolsa de Viagem Voyage Off White" em modelo="bolsa de viagem
 * voyage" + cor="Off White".
 *
 * CORREÇÃO — causa real confirmada com a planilha de verdade: a cor NÃO
 * aparece sempre no final do texto. A `descricao` real do remetente segue o
 * padrão "[MODELO] [COR] [texto adicional do remetente]" — ex.: "BOLSA TOTE
 * MARROM COM TECNOLOGIA GOCASE CONNECT(QR CODE) E MANUAL". A versão antiga
 * só reconhecia cor no FINAL do texto, então nunca achava "Marrom" aqui — o
 * texto inteiro (incluindo o texto adicional do remetente) virava "modelo",
 * poluindo a busca por nome com palavras que nunca existem em nome nenhum do
 * catálogo ("tecnologia", "connect", "qr", "code", "manual" etc.) e zerando
 * os candidatos. Agora a cor é procurada em QUALQUER posição do texto — ao
 * achar, só as palavras ANTES dela viram modelo (o que vem depois dela é
 * descartado, pois na prática é sempre texto adicional do remetente, nunca
 * parte do nome do produto).
 */
export function splitModeloECor(produto: string, colors: ColorAliasRow[]): { modelo: string; cor: string } {
  const normalized = normalize(canonicalizeCapacity(produto));
  const sorted = [...colors].sort((a, b) => b.normalized_alias.length - a.normalized_alias.length);

  for (const c of sorted) {
    const alias = c.normalized_alias;
    if (!alias) continue;
    const idx = findWholeWord(normalized, alias);
    if (idx <= 0) continue; // -1 = não achou; 0 = cor sozinha no início, sem nome de produto antes — nunca um modelo válido
    const modelo = normalized.slice(0, idx).trim();
    if (!modelo) continue;
    return { modelo, cor: c.canonical_value };
  }

  return { modelo: normalized, cor: "" };
}

// ---------------------------------------------------------------------------
// CORREÇÃO — vínculo automático incompleto: antes, só `row.produto` (texto)
// participava do matching via matchItem(); `row.descricao` era lido/salvo mas
// nunca usado pra achar o produto. Planilhas reais trazem SKU do remetente em
// "produto" (nunca o SKU interno GoScan) e um texto descritivo mais completo
// em "descricao" — ambos podem ajudar a identificar o produto Outlet certo.
// Prioridade determinística (nunca fuzzy/score/IA):
//   1) SKU INTERNO EXATO — `produto` bate, exato e único, com um sku_code
//      ativo do catálogo Outlet já carregado em `bulk` (nunca Normal, porque
//      `bulk` já vem só de fetchBulkCatalogData("outlet")).
//   2) DESCRIÇÃO — quando (1) não resolve, usa `descricao` com o mesmo motor
//      de texto (splitModeloECor + matchItem) já usado no Outlet "Colar
//      texto", restrito ao mesmo catálogo Outlet de `bulk`.
//   3) PRODUTO COMO TEXTO — quando nem (1) nem (2) resolvem, tenta o mesmo
//      motor usando `produto` como texto livre (comportamento de antes,
//      agora como ÚLTIMO recurso, não o único).
// CONFLITO — se o SKU exato aponta pra uma variante e a descrição aponta pra
// OUTRA variante diferente, nunca escolhe arbitrariamente: vira 'ambiguous'
// (pendência manual). Confirmação (SKU e descrição apontam pro mesmo lugar,
// ou só a descrição resolve sozinha) vincula automaticamente.
// ---------------------------------------------------------------------------
export type LoadingOrderMatchSource = "sku_exact" | "description_match" | "produto_text_match" | "ambiguous" | "unlinked";

interface SkuIndexEntry {
  variantId: string;
  productId: string;
  skuCode: string;
  color: string | null;
}

/** Índice sku_code (normalizado) -> variante(s), construído 1x por importação a partir do catálogo Outlet já em memória (`bulk`) — nunca consulta o banco. */
export function buildOutletSkuIndex(bulk: BulkCatalogData): Map<string, SkuIndexEntry[]> {
  const index = new Map<string, SkuIndexEntry[]>();
  for (const [productId, variants] of bulk.variantsByProduct) {
    for (const v of variants) {
      const key = v.sku_code.trim().toUpperCase();
      const list = index.get(key) ?? [];
      list.push({ variantId: v.id, productId, skuCode: v.sku_code, color: v.color });
      index.set(key, list);
    }
  }
  return index;
}

function isResolvedMatch(m: MatchResult | null): m is MatchResult & { variant_id: string } {
  return !!m && (m.status === "matched" || m.status === "matched_parcial") && !!m.variant_id;
}

function unresolvedMatch(modelo: string, cor: string, qtd: number): MatchResult {
  return { modelo_bruto: modelo, cor_bruta: cor, qtd, product_id: null, product_name: null, color_matched: null, variant_id: null, sku_code: null, status: "modelo_nao_encontrado" };
}

function buildSkuExactMatch(row: LoadingOrderRow, hit: SkuIndexEntry, bulk: BulkCatalogData): MatchResult {
  const product = bulk.products.find((p) => p.id === hit.productId);
  return {
    modelo_bruto: row.produto,
    cor_bruta: row.descricao || "",
    qtd: row.quantidade,
    product_id: hit.productId,
    product_name: product?.name ?? null,
    color_matched: hit.color,
    variant_id: hit.variantId,
    sku_code: hit.skuCode,
    status: "matched",
  };
}

/** SKU exato e descrição apontam pra variantes DIFERENTES — nunca escolhe sozinho, vira pendência com as 2 opções pro operador decidir. */
function buildConflictMatch(row: LoadingOrderRow, hit: SkuIndexEntry, descMatch: MatchResult & { variant_id: string }, bulk: BulkCatalogData): MatchResult {
  const product = bulk.products.find((p) => p.id === hit.productId);
  const skuCandidate: MatchCandidate = { variant_id: hit.variantId, sku_code: hit.skuCode, color: hit.color, product_name: product?.name ?? "" };
  const descCandidate: MatchCandidate = {
    variant_id: descMatch.variant_id,
    sku_code: descMatch.sku_code || "",
    color: descMatch.color_matched,
    product_name: descMatch.product_name || "",
  };
  return {
    modelo_bruto: row.produto,
    cor_bruta: row.descricao || "",
    qtd: row.quantidade,
    product_id: null,
    product_name: null,
    color_matched: null,
    variant_id: null,
    sku_code: null,
    status: "ambiguous",
    candidates: [skuCandidate, descCandidate],
  };
}

/**
 * Decide o vínculo de UMA linha seguindo a prioridade determinística acima.
 * Função pura (dado o mesmo bulk/aliasLists/skuIndex, sempre decide igual) —
 * só faz I/O se `bulk`/`aliasLists` não forem passados (nunca é o caso em
 * createLoadingOrderReceipt, que sempre os carrega 1x antes do loop).
 */
export interface LoadingOrderMatchExtraction {
  modelo: string;
  cor: string;
}

export async function matchLoadingOrderRow(
  row: LoadingOrderRow,
  bulk: BulkCatalogData,
  aliasLists: AliasLists,
  skuIndex?: Map<string, SkuIndexEntry[]>
): Promise<{ match: MatchResult; source: LoadingOrderMatchSource; extracted: LoadingOrderMatchExtraction | null }> {
  const index = skuIndex ?? buildOutletSkuIndex(bulk);

  const skuKey = row.produto.trim().toUpperCase();
  const hits = index.get(skuKey);
  const skuHit = hits && hits.length === 1 ? hits[0] : null;

  let descMatch: MatchResult | null = null;
  let descExtraction: LoadingOrderMatchExtraction | null = null;
  if (row.descricao && row.descricao.trim()) {
    descExtraction = splitModeloECor(row.descricao, aliasLists.colors);
    try {
      descMatch = await matchItem(descExtraction.modelo, descExtraction.cor, row.quantidade, bulk, aliasLists);
    } catch {
      descMatch = null;
    }
  }

  if (skuHit) {
    if (isResolvedMatch(descMatch) && descMatch.variant_id !== skuHit.variantId) {
      // DIAGNÓSTICO — conflito entre fontes: o atributo relevante aqui é
      // QUAL fonte apontou pra qual variante, não um modelo/cor extraído —
      // `extracted` fica null de propósito (ver candidates do match).
      return { match: buildConflictMatch(row, skuHit, descMatch, bulk), source: "ambiguous", extracted: null };
    }
    // SKU exato e único é suficiente sozinho (confirmado ainda mais forte
    // quando a descrição aponta pro mesmo lugar, mas não é obrigatório).
    return { match: buildSkuExactMatch(row, skuHit, bulk), source: "sku_exact", extracted: null };
  }

  if (isResolvedMatch(descMatch)) {
    return { match: descMatch, source: "description_match", extracted: descExtraction };
  }
  if (descMatch?.status === "ambiguous") {
    return { match: descMatch, source: "ambiguous", extracted: descExtraction };
  }

  // PRIORIDADE 3 — último recurso: produto como texto livre (comportamento
  // original, preservado como fallback pra quando a planilha não trouxer uma
  // descrição útil).
  const produtoExtraction = splitModeloECor(row.produto, aliasLists.colors);
  let produtoMatch: MatchResult;
  try {
    produtoMatch = await matchItem(produtoExtraction.modelo, produtoExtraction.cor, row.quantidade, bulk, aliasLists);
  } catch {
    produtoMatch = unresolvedMatch(produtoExtraction.modelo, produtoExtraction.cor, row.quantidade);
  }
  if (isResolvedMatch(produtoMatch)) {
    return { match: produtoMatch, source: "produto_text_match", extracted: produtoExtraction };
  }
  if (produtoMatch.status === "ambiguous") {
    return { match: produtoMatch, source: "ambiguous", extracted: produtoExtraction };
  }
  // DIAGNÓSTICO — item unlinked: guarda o que foi extraído da DESCRIÇÃO
  // (fonte principal) quando ela existiu, senão do produto — ver "quais
  // atributos foram extraídos" no diagnóstico de LoadingOrderMatchDiagnostic.
  return { match: produtoMatch, source: "unlinked", extracted: descExtraction ?? produtoExtraction };
}

export interface LoadingOrderMatchDiagnostic {
  produto: string;
  descricao: string | null;
  quantidade: number;
  status: MatchStatus;
  source: LoadingOrderMatchSource;
  /** Modelo/cor extraídos de descricao (ou produto, quando descricao não existia/não resolveu) — null quando o vínculo veio só do SKU exato. Permite responder "por que esse item não vinculou?" sem adivinhar. */
  extracted: LoadingOrderMatchExtraction | null;
  /** Só preenchido quando status === "ambiguous": nº de variantes Outlet candidatas (o "motivo" é sempre "mais de uma variante compatível"). */
  candidateCount: number | null;
}

export interface CreateLoadingOrderResult {
  receipt: InvoiceReceipt;
  items: InvoiceReceiptItem[];
  linked: number;
  pending: number;
  /** Diagnóstico por linha — nunca usado pra decidir nada, só pro resumo mostrado ao operador após o upload. */
  diagnostics: LoadingOrderMatchDiagnostic[];
}

/**
 * Cria a Conferência por Ordem de Carregamento: 1 invoice_receipts
 * (source_type='carregamento') + 1 invoice_receipt_item por linha válida,
 * já tentando vincular cada um via matchItem (texto) — item que não bater
 * fica com product_variant_id nulo e status 'unlinked', pronto pra aparecer
 * nas pendências (mesmo tratamento que a NF-e já dá a item sem SKU).
 */
// Tamanho do lote de GRAVAÇÃO (insert) — o casamento em si não usa mais o
// banco por item (ver fetchBulkCatalogData acima), só a escrita final
// continua em lotes, pra nunca mandar um payload gigante de uma vez e pra
// nunca perder o que já foi salvo se um lote mais à frente falhar de verdade.
const INSERT_BATCH_SIZE = 25;

export async function createLoadingOrderReceipt(
  fileName: string,
  rawRows: Record<string, unknown>[],
  onProgress?: (done: number, total: number) => void
): Promise<CreateLoadingOrderResult> {
  const mapped = mapLoadingOrderRows(rawRows);
  const { valid, errors } = validateLoadingOrderRows(mapped);
  if (valid.length === 0) {
    throw new Error(`Nenhuma linha válida encontrada na planilha (${errors.length} rejeitada(s) — confira as colunas Produto e Quantidade).`);
  }

  const supabase = getSupabase();
  const createdBy = requireUserId();
  // PERFORMANCE — busca o catálogo INTEIRO de uma vez (produtos + variantes
  // ativos) em vez de 1 consulta por linha da planilha (achado real: 208
  // linhas = 208+ idas e vindas ao banco, lento o bastante pra estourar
  // timeout e disputar conexão com outras telas abertas ao mesmo tempo). A
  // partir daqui, casar cada linha é só processamento em memória — nenhuma
  // consulta nova por item.
  // Carregamento SEMPRE é Outlet — nunca pode casar/sugerir um produto
  // 'normal' (são catálogos e SKUs diferentes, mesmo quando o nome é
  // parecido). Restringir aqui também elimina uma fonte real de falso
  // "ambíguo": vários produtos existem cadastrados nos dois tipos com o
  // mesmo nome/cor.
  const [aliasLists, bulk] = await Promise.all([fetchAliasLists(), fetchBulkCatalogData("outlet")]);

  const { data: receiptRow, error: receiptError } = await supabase
    .from("invoice_receipts")
    .insert({
      // Carregamento não tem "chave de acesso" — a própria planilha não se
      // repete com o mesmo nome por acaso, mas inclui um sufixo aleatório
      // pra nunca colidir mesmo com 2 uploads do mesmo arquivo no mesmo segundo.
      invoice_key: `carregamento:${fileName}:${crypto.randomUUID()}`,
      invoice_number: fileName.replace(/\.(xlsx|xls|csv)$/i, ""),
      source_type: "carregamento",
      xml: null,
      status: "not_started",
      created_by: createdBy,
    })
    .select()
    .single();
  if (receiptError) throw receiptError;
  const receipt = receiptRow as InvoiceReceipt;

  const diagnostics: LoadingOrderMatchDiagnostic[] = [];
  const insertedItems: InvoiceReceiptItem[] = [];
  let linked = 0;
  let done = 0;

  // Casa TODAS as linhas usando o catálogo já carregado em memória (`bulk`) —
  // matchLoadingOrderRow()/matchItem() com bulk+aliasLists nunca consultam o
  // banco de novo, então isto é só processamento local, quase instantâneo
  // mesmo pra 200+ linhas. skuIndex é construído 1x (não por linha).
  const skuIndex = buildOutletSkuIndex(bulk);
  const allMatches = await Promise.all(
    valid.map(async (row) => {
      try {
        const { match, source, extracted } = await matchLoadingOrderRow(row, bulk, aliasLists, skuIndex);
        return { row, match, source, extracted };
      } catch {
        // Uma falha pontual nunca pode derrubar a importação inteira — cai
        // como pendente, igual a "não achei nada".
        return { row, match: unresolvedMatch(row.produto, row.descricao || "", row.quantidade), source: "unlinked" as LoadingOrderMatchSource, extracted: null };
      }
    })
  );

  for (let start = 0; start < allMatches.length; start += INSERT_BATCH_SIZE) {
    const batch = allMatches.slice(start, start + INSERT_BATCH_SIZE);

    // Insere o lote JÁ (não espera a planilha inteira terminar) — se um lote
    // mais à frente falhar de verdade, os itens já processados continuam
    // salvos na conferência, nunca se perde o que já foi feito.
    const batchRows = batch.map(({ row, match, source, extracted }) => {
      const isLinked = match.status === "matched" || match.status === "matched_parcial";
      if (isLinked) linked++;
      diagnostics.push({
        produto: row.produto,
        descricao: row.descricao,
        quantidade: row.quantidade,
        status: match.status,
        source,
        extracted,
        candidateCount: match.status === "ambiguous" ? (match.candidates?.length ?? null) : null,
      });
      return {
        receipt_id: receipt.id,
        product_variant_id: match.variant_id,
        invoice_product_code: row.produto,
        description: row.descricao,
        ean: null,
        expected_quantity: row.quantidade,
        status: isLinked ? "pending" : "unlinked",
        // link_source reaproveita o check constraint já existente (migration
        // 0064) — 'sku' pra vínculo por SKU interno exato (confirmado ou não
        // pela descrição), 'text_match' pra vínculo só por texto (descrição
        // ou produto). Diagnóstico mais fino (de qual das 3 prioridades veio)
        // fica em `diagnostics`, sem precisar de coluna nova.
        link_source: isLinked ? (source === "sku_exact" ? "sku" : "text_match") : null,
      };
    });

    // RETRY — achado real testando com a planilha de 208 linhas: uma
    // renovação silenciosa de token (ver auth.ts/TOKEN_REFRESHED) no meio de
    // uma importação longa pode deixar UMA request isolada com a sessão
    // momentaneamente inválida, rejeitada pela RLS mesmo sendo o mesmo
    // usuário/empresa de sempre — nunca é falta de permissão de verdade.
    // 2 tentativas extras com pausa curta cobre essa janela sem precisar
    // reiniciar a importação inteira.
    // CORREÇÃO — causa raiz real da "importação para silenciosamente em N
    // itens sem erro nenhum": `[]` (array vazio) é um valor *truthy* em JS —
    // se o insert "tecnicamente funcionasse" mas o `.select()` de retorno
    // viesse vazio (mesma instabilidade de sessão descrita acima, só que
    // afetando a leitura de volta em vez da escrita), o código antigo
    // considerava isso sucesso e seguia em frente sem salvar nada daquele
    // lote — nenhum erro, nenhum aviso, só menos itens no final. Agora exige
    // que o banco confirme a MESMA quantidade de linhas que foi enviada.
    let batchInserted: InvoiceReceiptItem[] | null = null;
    let lastError: { message: string } | null = null;
    for (let attempt = 0; attempt < 3 && !batchInserted; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800));
      const { data, error } = await supabase.from("invoice_receipt_items").insert(batchRows).select();
      if (!error && data && data.length === batchRows.length) {
        batchInserted = data as InvoiceReceiptItem[];
      } else {
        lastError = error || { message: `O banco confirmou ${data?.length ?? 0} de ${batchRows.length} linha(s) esperada(s).` };
      }
    }
    if (!batchInserted) {
      throw new Error(
        `Falha ao salvar o lote ${start + 1}-${start + batch.length} (${lastError?.message}). ${insertedItems.length} item(ns) já foram salvos — abra esta ordem de carregamento no histórico pra continuar de onde parou.`
      );
    }
    insertedItems.push(...batchInserted);

    done += batch.length;
    onProgress?.(done, valid.length);
  }

  return {
    receipt,
    items: insertedItems,
    linked,
    pending: insertedItems.length - linked,
    diagnostics,
  };
}
