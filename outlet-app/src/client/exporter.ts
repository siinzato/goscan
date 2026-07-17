// Exportação para Excel. Só gera o arquivo — a persistência da conferência
// (histórico) é responsabilidade do conferenceSession.finalize().
import type { SessionItem } from "./conferenceSession.ts";

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
