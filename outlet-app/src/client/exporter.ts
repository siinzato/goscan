// Exportação para Excel. Só gera o arquivo — a persistência da conferência
// (histórico) é responsabilidade do conferenceSession.finalize() (Outlet) ou
// nfeApi.finalizeReceipt() (Conferência por NF).
import type { InvoiceReceiptWithNames, InvoiceReceiptItem } from "./nfeApi.ts";
import type { ConferenceWithOperator, ConferenceItemWithVariant } from "./conferencesApi.ts";
import type { CentralAuditEvent, CentralAuditFilters } from "./centralAuditApi.ts";
import type { OperationalIndicators } from "./operationalIndicatorsApi.ts";
import { summarizeReceipt } from "./nfeMatching.ts";
import { formatDateTime, formatOperationDuration, formatSignedNumber } from "./utils.ts";
import { CENTRAL_AUDIT_MODULE_LABEL, describeCentralAuditAction } from "./centralAuditApi.ts";

declare const XLSX: {
  utils: {
    aoa_to_sheet(data: unknown[][]): unknown;
    book_new(): unknown;
    book_append_sheet(wb: unknown, ws: unknown, name: string): void;
  };
  writeFile(wb: unknown, filename: string): void;
};

/** FASE 4 — Resumo Final: forma mínima que exportItemsToXlsx realmente lê — permite reutilizar o mesmo exportador tanto pra SessionItem (fluxo em andamento) quanto pra ConferenceItemWithVariant (resumo final pós-finalização), sem criar um segundo exportador. */
export interface ExportableConferenceItem {
  sku_code: string | null;
  produto: string | null;
  raw_model: string | null;
  raw_color: string | null;
  quantity: number;
}

export function exportItemsToXlsx(items: ExportableConferenceItem[], fileNamePrefix = "conferencia_estoque"): string {
  const groups = new Map<string, { produto: string; cor: string; sku: string; qtd: number }>();

  for (const it of items) {
    const key = it.sku_code || `${it.raw_model}__${it.raw_color}`;
    const existing = groups.get(key);
    if (existing) {
      existing.qtd += Number(it.quantity) || 0;
    } else {
      groups.set(key, {
        produto: it.produto || it.raw_model || "",
        cor: it.raw_color || "",
        sku: it.sku_code || "",
        qtd: Number(it.quantity) || 0,
      });
    }
  }

  const rows = Array.from(groups.values());
  const wsData: unknown[][] = [["Produto", "Cor", "SKU", "Quantidade"]];
  rows.forEach((r) => wsData.push([r.produto, r.cor, r.sku, r.qtd]));
  wsData.push(["TOTAL GERAL", "", "", rows.reduce((acc, r) => acc + r.qtd, 0)]);

  const ws = XLSX.utils.aoa_to_sheet(wsData) as { "!cols"?: { wch: number }[] };
  ws["!cols"] = [{ wch: 40 }, { wch: 18 }, { wch: 20 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Conferencia");
  const fname = `${fileNamePrefix}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
  return fname;
}

// ---------------------------------------------------------------------------
// FASE 6 — Relatório final de Outlet (Histórico > detalhe de conferência
// finalizada). Duas abas: "Resumo" (protocolo/operador/tempo/totais oficiais)
// + "Itens" (mesma granularidade já mostrada na tela, nunca falta/sobra/
// divergência — Outlet não tem comparação esperado×físico como a NF-e).
// ---------------------------------------------------------------------------
const OUTLET_STATUS_LABEL_XLSX: Record<string, string> = {
  draft: "Rascunho",
  in_progress: "Em andamento",
  completed: "Concluída",
  cancelled: "Cancelada",
};

const MATCH_STATUS_LABEL_XLSX: Record<string, string> = {
  matched: "Vinculado automaticamente",
  partial: "Vinculado parcialmente",
  manual: "Vinculado manualmente",
  unresolved: "Sem vínculo",
};

const SOURCE_LABEL_XLSX: Record<string, string> = {
  manual: "Manual",
  text: "Texto",
  screenshot: "Print",
  import: "Importação",
  camera_scan: "Câmera",
};

/** Protocolo curto e legível derivado do UUID — mesmo critério usado no resto do app (ver protocol() em history.ts), nunca uma coluna nova no banco. */
function conferenceProtocol(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

/** Matriz pura da aba "Resumo" — separada do writeFile pra ser testável sem a lib XLSX (ver tests/exporterLogic.test.mjs). */
export function buildOutletSummaryRows(conference: ConferenceWithOperator, items: ConferenceItemWithVariant[]): (string | number)[][] {
  const unresolvedCount = items.filter((i) => !i.product_variant_id).length;
  return [
    ["Protocolo", `#${conferenceProtocol(conference.id)}`],
    ["Nome", conference.name || ""],
    ["Status", OUTLET_STATUS_LABEL_XLSX[conference.status] || conference.status],
    ["Operador", conference.operator_name || ""],
    ["Início", formatDateTime(conference.started_at)],
    ["Finalização", formatDateTime(conference.finished_at)],
    ["Duração", formatOperationDuration(conference.started_at, conference.finished_at)],
    ["SKUs", conference.total_skus],
    ["Unidades", conference.total_units],
    ["Itens sem SKU", unresolvedCount],
  ];
}

/** Matriz pura da aba "Itens" — mesma granularidade da tela, nunca inventa falta/sobra/divergência (Outlet não compara esperado×físico). */
export function buildOutletItemsRows(items: ConferenceItemWithVariant[]): (string | number)[][] {
  return [
    ["Produto", "Modelo lido", "Cor", "SKU", "Quantidade", "Match status", "Origem"],
    ...items.map((it) => [
      it.produto || "",
      it.raw_model || "",
      it.raw_color || "",
      it.sku_code || "",
      it.quantity,
      MATCH_STATUS_LABEL_XLSX[it.match_status] || it.match_status,
      SOURCE_LABEL_XLSX[it.source] || it.source,
    ]),
  ];
}

export function exportOutletReportToXlsx(conference: ConferenceWithOperator, items: ConferenceItemWithVariant[]): string {
  const summaryWs = XLSX.utils.aoa_to_sheet(buildOutletSummaryRows(conference, items)) as { "!cols"?: { wch: number }[] };
  summaryWs["!cols"] = [{ wch: 20 }, { wch: 40 }];
  const itemsWs = XLSX.utils.aoa_to_sheet(buildOutletItemsRows(items)) as { "!cols"?: { wch: number }[] };
  itemsWs["!cols"] = [{ wch: 40 }, { wch: 20 }, { wch: 16 }, { wch: 20 }, { wch: 12 }, { wch: 22 }, { wch: 16 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summaryWs, "Resumo");
  XLSX.utils.book_append_sheet(wb, itemsWs, "Itens");
  const fname = `relatorio_outlet_${conferenceProtocol(conference.id)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
  return fname;
}

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Relatório de Conferência por NF (encerramento definitivo)
// ---------------------------------------------------------------------------
const NFE_STATUS_LABEL: Record<InvoiceReceiptItem["status"], string> = {
  pending: "NÃO CONFERIDO",
  counted: "CONTADO",
  ok: "OK",
  missing: "FALTA",
  surplus: "SOBRA",
  unlinked: "NÃO LOCALIZADO",
};

function nfeItemDiff(it: InvoiceReceiptItem): number | string {
  if (it.physical_quantity === null) return "";
  return it.physical_quantity - it.expected_quantity;
}

/** Nunca null/undefined/"SEM GTIN" na planilha exportada — sempre "Não informado" quando realmente ausente. */
function nfeItemEan(it: InvoiceReceiptItem): string {
  const ean = it.linked_ean || it.ean;
  if (!ean || ean.trim() === "" || ean.trim().toUpperCase() === "SEM GTIN") return "Não informado";
  return ean;
}

/**
 * FASE 6 — Matriz pura da nova aba "Resumo" do relatório NF-e — mesma
 * fórmula/campos do Resumo Final padronizado da Fase 4 (summarizeReceipt),
 * nunca uma segunda regra pro mesmo conceito. "SKUs conferidos" = itens com
 * resultado real (ok+missing+surplus), nunca items.length.
 */
export function buildNfeSummaryRows(receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): (string | number)[][] {
  const summary = summarizeReceipt(items);
  const counted = summary.ok + summary.missing + summary.surplus;
  return [
    ["NF", receipt.invoice_number || ""],
    ["Série", receipt.series || ""],
    ["Chave", receipt.invoice_key],
    ["Fornecedor", receipt.supplier_name || ""],
    ["CNPJ", receipt.supplier_cnpj || ""],
    ["Emissão", formatDateTime(receipt.issued_at)],
    ["Criada/importada por", receipt.created_by_name || ""],
    ["Início", formatDateTime(receipt.started_at)],
    ["Finalização", formatDateTime(receipt.finished_at)],
    ["Finalizada por", receipt.finished_by_name || ""],
    ["Duração", formatOperationDuration(receipt.started_at, receipt.finished_at)],
    ["Total de SKUs", items.length],
    ["SKUs conferidos", counted],
    ["OK", summary.ok],
    ["Falta", summary.missing],
    ["Sobra", summary.surplus],
    ["Não conferidos", summary.pending],
    ["Quantidade NF", summary.totalExpectedQuantity],
    ["Quantidade física", summary.totalPhysicalQuantity],
    ["Diferença total", formatSignedNumber(summary.netDifference)],
    ["Conformidade dos itens conferidos", counted > 0 ? `${(summary.conformityRate * 100).toFixed(2)}%` : "—"],
  ];
}

/**
 * Usa o SNAPSHOT imutável (linked_*, gravado na finalização) como fonte
 * primária — nunca o cadastro ao vivo, pra a planilha exportada continuar
 * igual ao relatório que foi de fato apresentado na finalização.
 */
/** Matriz pura da aba "Itens" (nome original "Relatorio NF" preservado como conteúdo/colunas — só a aba mudou de nome, ver exportNfeReportToXlsx) — extraída pra ser testável sem a lib XLSX. */
export function buildNfeItemsRows(receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): (string | number)[][] {
  const wsData: (string | number)[][] = [
    ["NF", "Fornecedor", "Nome", "SKU", "EAN", "Quantidade NF", "Quantidade Física", "Diferença", "Status", "Emissão", "Data da Conferência", "Responsável", "Descrição Original NF"],
  ];
  for (const it of items) {
    wsData.push([
      receipt.invoice_number || "",
      receipt.supplier_name || "",
      it.linked_product_name || it.produto || it.description || "",
      it.linked_sku_code || it.sku_code || it.invoice_product_code || "",
      nfeItemEan(it),
      it.expected_quantity,
      it.physical_quantity ?? "",
      nfeItemDiff(it),
      NFE_STATUS_LABEL[it.status],
      receipt.issued_at ? new Date(receipt.issued_at).toLocaleString("pt-BR") : "",
      receipt.finished_at ? new Date(receipt.finished_at).toLocaleString("pt-BR") : "",
      receipt.finished_by_name || "",
      it.description || "",
    ]);
  }
  return wsData;
}

export function exportNfeReportToXlsx(receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): string {
  const ws = XLSX.utils.aoa_to_sheet(buildNfeItemsRows(receipt, items)) as { "!cols"?: { wch: number }[] };
  ws["!cols"] = [
    { wch: 10 },
    { wch: 30 },
    { wch: 40 },
    { wch: 20 },
    { wch: 16 },
    { wch: 14 },
    { wch: 16 },
    { wch: 12 },
    { wch: 16 },
    { wch: 18 },
    { wch: 18 },
    { wch: 20 },
    { wch: 40 },
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(buildNfeSummaryRows(receipt, items)) as { "!cols"?: { wch: number }[] };
  summaryWs["!cols"] = [{ wch: 28 }, { wch: 40 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summaryWs, "Resumo");
  // FASE 6 — aba renomeada de "Relatorio NF" para "Itens" (mesmas colunas,
  // nenhum dado removido) pra acompanhar a nova aba "Resumo" na frente.
  XLSX.utils.book_append_sheet(wb, ws, "Itens");
  const fname = `relatorio_nf_${receipt.invoice_number || receipt.invoice_key.slice(0, 10)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
  return fname;
}

// ---------------------------------------------------------------------------
// FASE 6 — Central de Auditoria: exportação do conjunto FILTRADO completo
// (nunca só a página atual — ver fetchAllCentralAuditEvents em
// centralAuditApi.ts). Metadata já chega SANITIZADA (CentralAuditEvent.metadata
// passou por sanitizeAuditMetadata) — esta função nunca faz JSON.stringify de
// dado cru.
// ---------------------------------------------------------------------------
function centralAuditDetails(ev: CentralAuditEvent): string {
  const parts: string[] = [];
  if (ev.reversesEventId) parts.push(`Reverte evento ${ev.reversesEventId}`);
  if (ev.excess) parts.push("Excesso confirmado");
  if (ev.origin) parts.push(`Origem: ${ev.origin}`);
  if (ev.deviceId) parts.push(`Dispositivo: ${ev.deviceId}`);
  if (ev.volumeId) parts.push(`Volume: ${ev.volumeId}`);
  if (ev.metadata && Object.keys(ev.metadata).length > 0) parts.push(JSON.stringify(ev.metadata));
  return parts.join(" · ");
}

export function buildCentralAuditRows(events: CentralAuditEvent[]): (string | number)[][] {
  return [
    ["Data/Hora", "Módulo", "Ação", "Ação técnica", "Usuário", "E-mail", "Operação", "ID da operação", "Entidade", "ID da entidade", "Item", "SKU", "EAN", "Delta", "Quantidade resultante", "Origem", "Detalhes"],
    ...events.map((ev) => [
      formatDateTime(ev.occurredAt),
      CENTRAL_AUDIT_MODULE_LABEL[ev.module] || ev.module,
      describeCentralAuditAction(ev.action),
      ev.action,
      ev.actorName || "",
      ev.actorEmail || "",
      ev.operationLabel || "",
      ev.operationId || "",
      ev.entityType || "",
      ev.entityId || "",
      ev.itemId || "",
      ev.sku || "",
      ev.ean || "",
      ev.deltaQuantity ?? "",
      ev.resultingQuantity ?? "",
      ev.origin || "",
      centralAuditDetails(ev),
    ]),
  ];
}

export function buildCentralAuditFiltersRows(filters: CentralAuditFilters, actorLabel: string, generatedAtIso: string): (string | number)[][] {
  return [
    ["Módulo", filters.module === "all" ? "Todos" : CENTRAL_AUDIT_MODULE_LABEL[filters.module] || filters.module],
    ["Ação", filters.action ? describeCentralAuditAction(filters.action) : "Todas"],
    ["Usuário", actorLabel],
    ["Data inicial", filters.dateFrom ? formatDateTime(filters.dateFrom) : "-"],
    ["Data final", filters.dateTo ? formatDateTime(filters.dateTo) : "-"],
    ["Pesquisa", filters.search || "-"],
    ["Gerado em", formatDateTime(generatedAtIso)],
  ];
}

/** Sanitiza o nome do arquivo — nunca inclui e-mail/nome de usuário (rule 30 do pedido), só o período. */
export function centralAuditFileName(filters: CentralAuditFilters): string {
  if (filters.dateFrom && filters.dateTo) {
    return `goscan_auditoria_${filters.dateFrom.slice(0, 10)}_a_${filters.dateTo.slice(0, 10)}.xlsx`;
  }
  return `goscan_auditoria_${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export function exportCentralAuditToXlsx(events: CentralAuditEvent[], filters: CentralAuditFilters, actorLabel: string): string {
  const eventsWs = XLSX.utils.aoa_to_sheet(buildCentralAuditRows(events)) as { "!cols"?: { wch: number }[] };
  eventsWs["!cols"] = [
    { wch: 18 },
    { wch: 14 },
    { wch: 26 },
    { wch: 20 },
    { wch: 22 },
    { wch: 26 },
    { wch: 16 },
    { wch: 24 },
    { wch: 18 },
    { wch: 24 },
    { wch: 24 },
    { wch: 18 },
    { wch: 16 },
    { wch: 10 },
    { wch: 16 },
    { wch: 12 },
    { wch: 40 },
  ];
  const filtersWs = XLSX.utils.aoa_to_sheet(buildCentralAuditFiltersRows(filters, actorLabel, new Date().toISOString())) as { "!cols"?: { wch: number }[] };
  filtersWs["!cols"] = [{ wch: 16 }, { wch: 40 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, eventsWs, "Auditoria");
  XLSX.utils.book_append_sheet(wb, filtersWs, "Filtros");
  const fname = centralAuditFileName(filters);
  XLSX.writeFile(wb, fname);
  return fname;
}

// ---------------------------------------------------------------------------
// FASE 6 — Exportação dos Indicadores Operacionais (Histórico > Indicadores).
// Usa EXATAMENTE os números já retornados por get_operational_indicators
// (ver operationalIndicatorsApi.ts) — nunca recalcula a partir do histórico
// no browser.
// ---------------------------------------------------------------------------
export function buildIndicatorsSummaryRows(data: OperationalIndicators, periodLabel: string, responsibleLabel: string): (string | number)[][] {
  return [
    ["Período", periodLabel],
    ["Responsável", responsibleLabel],
    ["Operações concluídas", data.summary.completedOperations],
    ["Conferências Outlet", data.summary.outletConferences],
    ["Conferências NF-e", data.summary.nfeReceipts],
    ["NF-e com divergências", data.summary.nfeWithDivergences],
    ["SKUs Outlet", data.outlet.skus],
    ["Unidades Outlet", data.outlet.units],
    ["Média SKUs/conferência (Outlet)", data.outlet.avgSkus],
    ["Média unidades/conferência (Outlet)", data.outlet.avgUnits],
    ["SKUs conferidos NF-e", data.nfe.countedSkus],
    ["Unidades físicas NF-e", data.nfe.physicalUnits],
    ["OK", data.nfe.okItems],
    ["Falta", data.nfe.missingItems],
    ["Sobra", data.nfe.surplusItems],
    ["Conformidade dos itens conferidos", data.nfe.conformityRate !== null ? `${(data.nfe.conformityRate * 100).toFixed(2)}%` : "—"],
  ];
}

export function buildIndicatorsDailyRows(data: OperationalIndicators): (string | number)[][] {
  return [
    ["Data", "Outlet", "NF-e", "SKUs", "Unidades", "Divergências"],
    ...data.daily.map((d) => [d.date, d.outletConferences, d.nfeReceipts, d.skus, d.units, d.divergenceReceipts]),
  ];
}

export function exportOperationalIndicatorsToXlsx(data: OperationalIndicators, periodLabel: string, responsibleLabel: string): string {
  const summaryWs = XLSX.utils.aoa_to_sheet(buildIndicatorsSummaryRows(data, periodLabel, responsibleLabel)) as { "!cols"?: { wch: number }[] };
  summaryWs["!cols"] = [{ wch: 32 }, { wch: 30 }];
  const dailyWs = XLSX.utils.aoa_to_sheet(buildIndicatorsDailyRows(data)) as { "!cols"?: { wch: number }[] };
  dailyWs["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summaryWs, "Resumo");
  XLSX.utils.book_append_sheet(wb, dailyWs, "Volume diário");
  const fname = `goscan_indicadores_${periodLabel.replace(/[^\w-]+/g, "_")}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
  return fname;
}
