// EXPANSÃO GOSCAN — Módulo Devolução: exportação de relatório. Reaproveita o
// MESMO global XLSX (SheetJS, carregado via CDN em index.html — ver
// exporter.ts) e o mesmo padrão de declare const/aoa_to_sheet/book_append_sheet
// — nunca uma segunda biblioteca. 3 abas num único arquivo (Resumo para
// Estoque / Devoluções Detalhadas / Pendências e Ocorrências, ver pedido
// seção 10) — só chama book_append_sheet mais vezes antes do writeFile.
import type { ReportDetailRow, StockSummaryRow } from "./returnsApi.ts";

declare const XLSX: {
  utils: {
    aoa_to_sheet(data: unknown[][]): unknown;
    book_new(): unknown;
    book_append_sheet(wb: unknown, ws: unknown, name: string): void;
    sheet_to_csv(ws: unknown): string;
  };
  writeFile(wb: unknown, filename: string): void;
};

const MARKETPLACE_LABEL: Record<string, string> = {
  mercado_livre: "Mercado Livre",
  shopee: "Shopee",
  shein: "Shein",
  amazon: "Amazon",
  tiktok: "TikTok",
  outro: "Outro",
};

const CLASSIFICATION_LABEL: Record<string, string> = {
  vendavel: "Vendável",
  avariado: "Avariado",
  divergente: "Divergente",
  pacote_vazio: "Pacote vazio",
  aguardando_analise: "Aguardando análise",
};

const INVOICE_SITUATION_LABEL: Record<string, string> = {
  pendente_cancelamento: "Pendente de cancelamento",
  cancelada: "Nota cancelada",
  nao_se_aplica: "Não se aplica",
};

function safeEan(value: string | null): string {
  return value && value.trim() ? value : "Não informado";
}

function buildResumoEstoqueSheet(rows: StockSummaryRow[]): unknown {
  const wsData: unknown[][] = [["SKU", "EAN", "Produto", "Quantidade a lançar"]];
  rows.forEach((r) => wsData.push([r.sku_code, safeEan(r.ean), r.produto, r.total_quantity]));
  wsData.push(["TOTAL", "", "", rows.reduce((acc, r) => acc + r.total_quantity, 0)]);
  const ws = XLSX.utils.aoa_to_sheet(wsData) as { "!cols"?: { wch: number }[] };
  ws["!cols"] = [{ wch: 20 }, { wch: 16 }, { wch: 40 }, { wch: 18 }];
  return ws;
}

function buildDetalhadoSheet(rows: ReportDetailRow[]): unknown {
  const wsData: unknown[][] = [
    [
      "Marketplace",
      "Pacote/Pedido",
      "Nº NF",
      "Situação da Nota",
      "SKU",
      "EAN",
      "Produto",
      "Quantidade",
      "Classificação",
      "Observação",
      "Responsável pelo registro",
      "Status",
      "Data",
    ],
  ];
  rows.forEach((r) =>
    wsData.push([
      MARKETPLACE_LABEL[r.marketplace] || r.marketplace,
      r.package_code,
      r.invoice_number || "",
      INVOICE_SITUATION_LABEL[r.invoice_situation] || r.invoice_situation,
      r.sku_code || "",
      safeEan(r.ean),
      r.produto || "",
      r.quantity,
      CLASSIFICATION_LABEL[r.classification] || r.classification,
      r.condition_notes || "",
      r.created_by_name || "",
      r.status,
      r.created_at ? new Date(r.created_at).toLocaleString("pt-BR") : "",
    ])
  );
  const ws = XLSX.utils.aoa_to_sheet(wsData) as { "!cols"?: { wch: number }[] };
  ws["!cols"] = [
    { wch: 14 },
    { wch: 20 },
    { wch: 14 },
    { wch: 20 },
    { wch: 20 },
    { wch: 16 },
    { wch: 30 },
    { wch: 12 },
    { wch: 18 },
    { wch: 30 },
    { wch: 20 },
    { wch: 18 },
    { wch: 18 },
  ];
  return ws;
}

function buildPendenciasSheet(rows: ReportDetailRow[]): unknown {
  const wsData: unknown[][] = [["Marketplace", "Pacote/Pedido", "SKU", "EAN", "Produto", "Quantidade", "Classificação", "Motivo/Observação", "Data"]];
  rows.forEach((r) =>
    wsData.push([
      MARKETPLACE_LABEL[r.marketplace] || r.marketplace,
      r.package_code,
      r.sku_code || "",
      r.is_pending ? "Não localizado" : safeEan(r.ean),
      r.produto || (r.is_pending ? "EAN não localizado no catálogo" : ""),
      r.quantity,
      CLASSIFICATION_LABEL[r.classification] || r.classification,
      r.condition_notes || "",
      r.created_at ? new Date(r.created_at).toLocaleString("pt-BR") : "",
    ])
  );
  const ws = XLSX.utils.aoa_to_sheet(wsData) as { "!cols"?: { wch: number }[] };
  ws["!cols"] = [{ wch: 14 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 30 }, { wch: 12 }, { wch: 18 }, { wch: 30 }, { wch: 18 }];
  return ws;
}

export function exportReturnsReportToXlsx(stockSummary: StockSummaryRow[], detailed: ReportDetailRow[], pending: ReportDetailRow[]): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildResumoEstoqueSheet(stockSummary), "Resumo para Estoque");
  XLSX.utils.book_append_sheet(wb, buildDetalhadoSheet(detailed), "Devolucoes Detalhadas");
  XLSX.utils.book_append_sheet(wb, buildPendenciasSheet(pending), "Pendencias e Ocorrencias");
  const fname = `devolucoes_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
  return fname;
}

/** CSV é sempre só a aba "Devoluções Detalhadas" (a mais usada fora do GoScan) — sheet_to_csv já vem no mesmo global XLSX carregado (index.html), sem nova dependência. */
export function exportReturnsDetailedToCsv(detailed: ReportDetailRow[]): string {
  const ws = buildDetalhadoSheet(detailed);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const fname = `devolucoes_detalhado_${new Date().toISOString().slice(0, 10)}.csv`;
  const link = document.createElement("a");
  link.href = url;
  link.download = fname;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return fname;
}
