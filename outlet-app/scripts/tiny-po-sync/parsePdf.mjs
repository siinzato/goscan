// Cópia standalone (deliberada) da extração determinística de src/server/purchaseOrderPdf.ts —
// esse script roda fora do build do app (via Task Scheduler, sem tsx/tsc), então em vez de
// importar TypeScript, mantém sua própria cópia da MESMA lógica. Se o layout do PDF de compra
// mudar e src/server/purchaseOrderPdf.ts for ajustado, replique o ajuste aqui também.
import { PDFParse } from "pdf-parse";

const START_MARKER_RE = /^Itens da compra$/i;
const END_MARKER_RE = /^Total de produtos$/i;
const PAGE_BREAK_RE = /^--\s*\d+\s+of\s+\d+\s*--$/i;
const HEADER_ROW_RE = /^(Item\s+GTIN\s*\/\s*Cod\.?|Fornecedor\s+Qtde\s+Un\s+Valor\s+IPI|%\s*Total)$/i;
const SKU_LINE_RE = /^SKU:\s*(.+)$/i;
const DATA_LINE_RE = /^(\d{6,14})\s+([\d.,]+)\s+(\S+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$/;

const ORDER_NUMBER_HEADER_RE = /^Ordem de Compra\s*N[ºo]\.?\s*(\d+)/i;
const SUPPLIER_AND_NUMBER_RE = /^(.+?)\s+N[úu]mero do pedido\s+(\d+)/i;
const EXPECTED_DATE_RE = /^Data prevista\s+(\d{2}\/\d{2}\/\d{4})/i;
const ORDER_DATE_RE = /^Data\s+(\d{2}\/\d{2}\/\d{4})/i;

function parseBrazilianNumber(raw) {
  const n = Number(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function brDateToIso(raw) {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function normalizeEan(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[^\d]/g, "");
}

export function parsePurchaseOrderItemsFromText(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const items = [];
  let descriptionBuffer = [];
  let pendingSku = null;
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
        gtin_normalized: normalizeEan(dataMatch[1]),
        sku_code: pendingSku,
        description: descriptionBuffer.join(" ").trim() || null,
        quantity: parseBrazilianNumber(dataMatch[2]),
      });
      pendingSku = null;
      descriptionBuffer = [];
      continue;
    }

    if (!pendingSku) descriptionBuffer.push(line);
  }

  return items;
}

export function parsePurchaseOrderMetadataFromText(text) {
  const metadata = { orderNumber: null, supplierName: null, orderDate: null, expectedDate: null };
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

/** Lê o PDF (buffer) e devolve { items, metadata } — mesmo shape do endpoint /api/parse-purchase-order-pdf do GoScan. */
export async function extractPurchaseOrderFromPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }
  return { items: parsePurchaseOrderItemsFromText(text), metadata: parsePurchaseOrderMetadataFromText(text) };
}
