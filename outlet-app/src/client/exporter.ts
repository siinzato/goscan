// Exportação para Excel. Só gera o arquivo — a persistência da conferência
// (histórico) é responsabilidade do conferenceSession.finalize() (Outlet) ou
// nfeApi.finalizeReceipt() (Conferência por NF).
import type { SessionItem } from "./conferenceSession.ts";
import type { InvoiceReceiptWithNames, InvoiceReceiptItem } from "./nfeApi.ts";

declare const XLSX: {
  utils: {
    aoa_to_sheet(data: unknown[][]): unknown;
    book_new(): unknown;
    book_append_sheet(wb: unknown, ws: unknown, name: string): void;
  };
  writeFile(wb: unknown, filename: string): void;
};

export function exportItemsToXlsx(items: SessionItem[], fileNamePrefix = "conferencia_estoque"): string {
  const groups = new Map<string, { produto: string; cor: string; sku: string; qtd: number }>();

  for (const it of items) {
    const key = it.sku_code || `${it.raw_model}__${it.raw_color}`;
    const existing = groups.get(key);
    if (existing) {
      existing.qtd += Number(it.quantity) || 0;
    } else {
      groups.set(key, {
        produto: it.produto || it.raw_model,
        cor: it.raw_color,
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
 * Usa o SNAPSHOT imutável (linked_*, gravado na finalização) como fonte
 * primária — nunca o cadastro ao vivo, pra a planilha exportada continuar
 * igual ao relatório que foi de fato apresentado na finalização.
 */
export function exportNfeReportToXlsx(receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): string {
  const wsData: unknown[][] = [
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

  const ws = XLSX.utils.aoa_to_sheet(wsData) as { "!cols"?: { wch: number }[] };
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
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Relatorio NF");
  const fname = `relatorio_nf_${receipt.invoice_number || receipt.invoice_key.slice(0, 10)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);
  return fname;
}
