// Leitura de Ordem de Compra em PDF — EXTRAÇÃO DE TEXTO DETERMINÍSTICA
// (pdf-parse), nunca IA. O formato do PDF (gerado pelo próprio sistema de
// compras da empresa) é sempre o mesmo, item a item:
//   <descrição, 1+ linhas>
//   SKU: <codigo>
//   <GTIN> <quantidade>,00 <unidade> <valor> <ipi> <total>
// Mesmo nível de confiabilidade que a importação de XLSX/CSV — sem
// adivinhação, sem custo de API externa, sem depender de crédito de conta.
import { PDFParse } from "pdf-parse";

export interface ParsedPurchaseOrderItem {
  GTIN: string | null;
  SKU: string | null;
  "Descrição": string | null;
  Quantidade: number | null;
}

export interface ParsedPurchaseOrderMetadata {
  orderNumber: string | null;
  supplierName: string | null;
  orderDate: string | null;
  expectedDate: string | null;
}

// Linhas de cabeçalho ANTES de "Itens da compra" (sempre nesta ordem no
// layout do sistema de compras da empresa):
//   Ordem de Compra Nº 480
//   Fornecedor
//   Rearth 	Número do pedido 480
//   Data 	10/09/2026
//   Data prevista 	28/09/2026
const ORDER_NUMBER_HEADER_RE = /^Ordem de Compra\s*N[ºo]\.?\s*(\d+)/i;
const SUPPLIER_AND_NUMBER_RE = /^(.+?)\s+N[úu]mero do pedido\s+(\d+)/i;
const EXPECTED_DATE_RE = /^Data prevista\s+(\d{2}\/\d{2}\/\d{4})/i;
const ORDER_DATE_RE = /^Data\s+(\d{2}\/\d{2}\/\d{4})/i;

function brDateToIso(raw: string): string | null {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Miolo puro (texto -> metadados do cabeçalho), mesmo padrão testável de parsePurchaseOrderItemsFromText. */
export function parsePurchaseOrderMetadataFromText(text: string): ParsedPurchaseOrderMetadata {
  const metadata: ParsedPurchaseOrderMetadata = { orderNumber: null, supplierName: null, orderDate: null, expectedDate: null };
  const lines = text.split("\n").map((l) => l.trim());

  for (const line of lines) {
    if (!line) continue;
    if (START_MARKER_RE.test(line)) break;

    const supplierMatch = line.match(SUPPLIER_AND_NUMBER_RE);
    if (supplierMatch) {
      metadata.supplierName = supplierMatch[1].trim();
      metadata.orderNumber = supplierMatch[2];
      continue;
    }
    const expectedMatch = line.match(EXPECTED_DATE_RE);
    if (expectedMatch) {
      metadata.expectedDate = brDateToIso(expectedMatch[1]);
      continue;
    }
    const orderDateMatch = line.match(ORDER_DATE_RE);
    if (orderDateMatch) {
      metadata.orderDate = brDateToIso(orderDateMatch[1]);
      continue;
    }
    if (!metadata.orderNumber) {
      const headerMatch = line.match(ORDER_NUMBER_HEADER_RE);
      if (headerMatch) metadata.orderNumber = headerMatch[1];
    }
  }

  return metadata;
}

const START_MARKER_RE = /^Itens da compra$/i;
const END_MARKER_RE = /^Total de produtos$/i;
const PAGE_BREAK_RE = /^--\s*\d+\s+of\s+\d+\s*--$/i;
// Cabeçalho da tabela ("Item | GTIN/Cod. Fornecedor | Qtde | Un | Valor | IPI | Total")
// sai quebrado em 3 linhas pelo extrator de texto do PDF — nunca faz parte de item real.
const HEADER_ROW_RE = /^(Item\s+GTIN\s*\/\s*Cod\.?|Fornecedor\s+Qtde\s+Un\s+Valor\s+IPI|%\s*Total)$/i;
const SKU_LINE_RE = /^SKU:\s*(.+)$/i;
// GTIN, depois quantidade (vírgula decimal), unidade, valor unit., IPI, total.
const DATA_LINE_RE = /^(\d{6,14})\s+([\d.,]+)\s+(\S+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$/;

function parseBrazilianNumber(raw: string): number | null {
  const n = Number(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrai os itens de uma ordem de compra em PDF (texto real, nunca OCR/IA).
 * Devolve linhas já no formato de cabeçalho (GTIN/SKU/Descrição/Quantidade)
 * que o mapeamento de planilha do cliente (purchaseOrderApi.ts) já entende —
 * nunca duplica a validação/normalização do lado do cliente.
 */
export async function extractPurchaseOrderItemsFromPdf(buffer: Buffer): Promise<ParsedPurchaseOrderItem[]> {
  const { items } = await extractPurchaseOrderFromPdf(buffer);
  return items;
}

/**
 * Mesma extração acima, mas devolvendo também os metadados do cabeçalho
 * (nº do pedido, fornecedor, datas) — usados pra pré-preencher os campos
 * administráveis da OC (sempre editáveis depois, nunca aplicados às cegas).
 */
export async function extractPurchaseOrderFromPdf(
  buffer: Buffer
): Promise<{ items: ParsedPurchaseOrderItem[]; metadata: ParsedPurchaseOrderMetadata }> {
  const parser = new PDFParse({ data: buffer });
  let text: string;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }
  return { items: parsePurchaseOrderItemsFromText(text), metadata: parsePurchaseOrderMetadataFromText(text) };
}

/** Miolo puro (texto -> itens), testável sem precisar de um PDF real como fixture. */
export function parsePurchaseOrderItemsFromText(text: string): ParsedPurchaseOrderItem[] {
  const lines = text.split("\n").map((l) => l.trim());
  const items: ParsedPurchaseOrderItem[] = [];
  let descriptionBuffer: string[] = [];
  let pendingSku: string | null = null;
  let started = false;

  for (const line of lines) {
    if (!line) continue;
    if (END_MARKER_RE.test(line)) break;
    if (!started) {
      if (START_MARKER_RE.test(line)) started = true;
      continue;
    }
    if (PAGE_BREAK_RE.test(line) || HEADER_ROW_RE.test(line)) continue;

    const skuMatch = line.match(SKU_LINE_RE);
    if (skuMatch) {
      pendingSku = skuMatch[1].trim();
      continue;
    }

    const dataMatch = line.match(DATA_LINE_RE);
    if (dataMatch && pendingSku) {
      items.push({
        GTIN: dataMatch[1],
        SKU: pendingSku,
        "Descrição": descriptionBuffer.join(" ").trim() || null,
        Quantidade: parseBrazilianNumber(dataMatch[2]),
      });
      pendingSku = null;
      descriptionBuffer = [];
      continue;
    }

    if (!pendingSku) descriptionBuffer.push(line);
  }

  return items;
}
