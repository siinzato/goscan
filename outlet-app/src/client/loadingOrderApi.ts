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
import { matchItem, fetchAliasLists, fetchBulkCatalogData, type MatchStatus, type ColorAliasRow } from "./matching.ts";
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
 * Separa "Bolsa de Viagem Voyage Off White" em modelo="Bolsa de Viagem
 * Voyage" + cor="Off White" procurando a cor conhecida mais longa que
 * aparece no FINAL do texto (cores compostas como "Off White" não podem
 * perder pro match mais curto "White" sozinho). Sem cor reconhecida, devolve
 * o texto inteiro como modelo e cor vazia — matchItem() já lida bem com cor
 * vazia (só resolve sozinho se o produto tiver uma única variação).
 */
export function splitModeloECor(produto: string, colors: ColorAliasRow[]): { modelo: string; cor: string } {
  const normalized = normalize(produto);
  const sorted = [...colors].sort((a, b) => b.normalized_alias.length - a.normalized_alias.length);

  for (const c of sorted) {
    const alias = c.normalized_alias;
    if (!alias) continue;
    if (normalized === alias || normalized.endsWith(" " + alias)) {
      const modeloNormalized = normalized.slice(0, normalized.length - alias.length).trim();
      if (!modeloNormalized) continue; // cor sozinha não é um modelo válido
      // Reconstrói o modelo a partir do texto ORIGINAL (não normalizado) —
      // só corta a mesma quantidade de palavras que a cor ocupa.
      const colorWordCount = alias.split(" ").length;
      const originalWords = produto.trim().split(/\s+/);
      const modelo = originalWords.slice(0, originalWords.length - colorWordCount).join(" ");
      return { modelo: modelo || produto, cor: c.canonical_value };
    }
  }

  return { modelo: produto, cor: "" };
}

export interface LoadingOrderMatchDiagnostic {
  produto: string;
  descricao: string | null;
  quantidade: number;
  status: MatchStatus;
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
  const [{ colors }, bulk] = await Promise.all([fetchAliasLists(), fetchBulkCatalogData("outlet")]);

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
  // matchItem() com esse 4º parâmetro nunca consulta o banco de novo, então
  // isto é só processamento local, quase instantâneo mesmo pra 200+ linhas.
  const allMatches = await Promise.all(
    valid.map(async (row) => {
      try {
        const { modelo, cor } = splitModeloECor(row.produto, colors);
        const match = await matchItem(modelo, cor, row.quantidade, bulk);
        return { row, match };
      } catch {
        // Uma falha pontual nunca pode derrubar a importação inteira — cai
        // como pendente, igual a "não achei nada".
        return { row, match: { status: "modelo_nao_encontrado" as const, variant_id: null } };
      }
    })
  );

  for (let start = 0; start < allMatches.length; start += INSERT_BATCH_SIZE) {
    const batch = allMatches.slice(start, start + INSERT_BATCH_SIZE);

    // Insere o lote JÁ (não espera a planilha inteira terminar) — se um lote
    // mais à frente falhar de verdade, os itens já processados continuam
    // salvos na conferência, nunca se perde o que já foi feito.
    const batchRows = batch.map(({ row, match }) => {
      const isLinked = match.status === "matched" || match.status === "matched_parcial";
      if (isLinked) linked++;
      diagnostics.push({ produto: row.produto, descricao: row.descricao, quantidade: row.quantidade, status: match.status });
      return {
        receipt_id: receipt.id,
        product_variant_id: match.variant_id,
        invoice_product_code: row.produto,
        description: row.descricao,
        ean: null,
        expected_quantity: row.quantidade,
        status: isLinked ? "pending" : "unlinked",
        link_source: isLinked ? "text_match" : null,
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
