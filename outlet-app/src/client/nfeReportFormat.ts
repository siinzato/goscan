// Formatação compartilhada da Conferência por Nota Fiscal — usada tanto por
// ui/screens/nfeConference.ts (fluxo completo dentro de Conferir → Nota
// Fiscal) quanto por ui/screens/history.ts (menu Histórico geral, aba Nota
// Fiscal). Extraído num módulo próprio pra não puxar upload/preparação/
// contagem (o resto de nfeConference.ts) pro bundle da tela de Histórico —
// preserva o code-splitting por rota já estabelecido em shell.ts.
import { Icon } from "./ui/icons.ts";
import type { InvoiceReceipt, InvoiceReceiptItem } from "./nfeApi.ts";

export const RECEIPT_STATUS_LABEL: Record<InvoiceReceipt["status"], string> = {
  not_started: "Não iniciada",
  in_progress: "Em conferência",
  completed: "Finalizada",
  with_divergences: "Com divergências",
};

const ITEM_STATUS_META: Record<InvoiceReceiptItem["status"], { cls: string; icon: string; label: string }> = {
  pending: { cls: "warning", icon: Icon.clock, label: "Pendente" },
  counted: { cls: "info", icon: Icon.checkCircle, label: "Contado" },
  ok: { cls: "success", icon: Icon.checkCircle, label: "OK" },
  missing: { cls: "error", icon: Icon.alertTriangle, label: "Falta" },
  surplus: { cls: "warning", icon: Icon.alertTriangle, label: "Sobra" },
  unlinked: { cls: "error", icon: Icon.xCircle, label: "Não localizado" },
};

export function itemStamp(status: InvoiceReceiptItem["status"]): string {
  const m = ITEM_STATUS_META[status];
  return `<span class="status-badge ${m.cls}">${m.icon}${m.label}</span>`;
}

/**
 * Mesmo selo de itemStamp, mas no RELATÓRIO FINAL "pending" precisa dizer
 * "Não conferido" (nunca "Pendente" — essa palavra é da tela de contagem em
 * andamento). Nunca confundir com quantidade zero: physical_quantity
 * continua null aqui, só o texto do selo muda.
 */
export function reportStatusStamp(status: InvoiceReceiptItem["status"]): string {
  if (status === "pending") return `<span class="status-badge warning">${Icon.clock}Não conferido</span>`;
  return itemStamp(status);
}

/** Nome pro relatório: prioriza o SNAPSHOT gravado na finalização (imutável), senão o produto vinculado ao vivo, senão a descrição bruta da NF. */
export function itemTitle(it: InvoiceReceiptItem): string {
  return it.linked_product_name || it.produto || it.description || "(sem descrição)";
}

/** SKU pro relatório: mesma prioridade de itemTitle. */
export function itemCodeLabel(it: InvoiceReceiptItem): string {
  return it.linked_sku_code || it.sku_code || it.invoice_product_code || "-";
}

/**
 * EAN pro relatório — NUNCA mostra null/undefined/"SEM GTIN" na tela, sempre
 * "Não informado" quando realmente ausente (ver spec: distinguir "não
 * informado" de um erro de exibição).
 */
export function itemEanLabel(it: InvoiceReceiptItem): string {
  const ean = it.linked_ean || it.ean;
  if (!ean || ean.trim() === "" || ean.trim().toUpperCase() === "SEM GTIN") return "Não informado";
  return ean;
}
