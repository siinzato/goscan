// EXPANSÃO GOSCAN — Módulo Devolução: rótulos/ícones compartilhados entre as
// sub-telas (registro, fila da Logística, relatórios). Só apresentação —
// nenhuma regra de negócio aqui (isso fica em returnsApi.ts/returnsMatching.ts).
import { Icon } from "../../icons.ts";
import type { Marketplace, ReturnStatus, ReturnBatchStatus } from "../../../returnsApi.ts";
import type { ReturnClassification, InvoiceSituation } from "../../../returnsMatching.ts";

export const MARKETPLACE_LABEL: Record<Marketplace, string> = {
  mercado_livre: "Mercado Livre",
  shopee: "Shopee",
  shein: "Shein",
  amazon: "Amazon",
  tiktok: "TikTok",
  outro: "Outro",
};

export const MARKETPLACE_OPTIONS: { value: Marketplace; label: string }[] = [
  { value: "mercado_livre", label: "Mercado Livre" },
  { value: "shopee", label: "Shopee" },
  { value: "shein", label: "Shein" },
  { value: "amazon", label: "Amazon" },
  { value: "tiktok", label: "TikTok" },
  { value: "outro", label: "Outro" },
];

export const INVOICE_SITUATION_LABEL: Record<InvoiceSituation, string> = {
  pendente_cancelamento: "Pendente de cancelamento",
  cancelada: "Nota cancelada",
  nao_se_aplica: "Não se aplica",
};

export const INVOICE_SITUATION_OPTIONS: { value: InvoiceSituation; label: string }[] = [
  { value: "pendente_cancelamento", label: "Pendente de cancelamento" },
  { value: "cancelada", label: "Nota cancelada" },
  { value: "nao_se_aplica", label: "Não se aplica" },
];

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  em_registro: "Em registro",
  aguardando_avaliacao: "Aguardando avaliação",
  pendente_cancelamento_nota: "Pendente de cancelamento da nota",
  pronta_logistica: "Pronta para a Logística",
  enviada_logistica: "Enviada para a Logística",
  lancada_tiny: "Lançada no Tiny",
  concluida: "Concluída",
  com_pendencias: "Com pendências",
  cancelada: "Cancelada",
};

export const BATCH_STATUS_LABEL: Record<ReturnBatchStatus, string> = {
  aguardando_lancamento: "Aguardando lançamento",
  lancada_tiny: "Lançada no Tiny",
  concluida: "Concluída",
};

export const CLASSIFICATION_LABEL: Record<ReturnClassification, string> = {
  vendavel: "Vendável",
  avariado: "Avariado",
  divergente: "Produto divergente",
  pacote_vazio: "Pacote vazio",
  aguardando_analise: "Aguardando análise",
};

export const CLASSIFICATION_OPTIONS: { value: ReturnClassification; label: string }[] = [
  { value: "vendavel", label: "Vendável" },
  { value: "avariado", label: "Avariado" },
  { value: "divergente", label: "Produto divergente" },
  { value: "pacote_vazio", label: "Pacote vazio" },
  { value: "aguardando_analise", label: "Aguardando análise" },
];

const CLASSIFICATION_BADGE: Record<ReturnClassification, { cls: string; icon: string }> = {
  vendavel: { cls: "success", icon: Icon.checkCircle },
  avariado: { cls: "error", icon: Icon.alertTriangle },
  divergente: { cls: "warning", icon: Icon.alertTriangle },
  pacote_vazio: { cls: "info", icon: Icon.package },
  aguardando_analise: { cls: "warning", icon: Icon.clock },
};

export function classificationBadge(c: ReturnClassification): string {
  const m = CLASSIFICATION_BADGE[c];
  return `<span class="status-badge ${m.cls}">${m.icon}${CLASSIFICATION_LABEL[c]}</span>`;
}

const STATUS_BADGE_CLASS: Record<ReturnStatus, string> = {
  em_registro: "info",
  aguardando_avaliacao: "warning",
  pendente_cancelamento_nota: "warning",
  pronta_logistica: "info",
  enviada_logistica: "info",
  lancada_tiny: "success",
  concluida: "success",
  com_pendencias: "warning",
  cancelada: "error",
};

export function returnStatusBadge(status: ReturnStatus): string {
  return `<span class="status-badge ${STATUS_BADGE_CLASS[status]}">${RETURN_STATUS_LABEL[status]}</span>`;
}

const BATCH_STATUS_BADGE_CLASS: Record<ReturnBatchStatus, string> = {
  aguardando_lancamento: "warning",
  lancada_tiny: "success",
  concluida: "success",
};

export function batchStatusBadge(status: ReturnBatchStatus): string {
  return `<span class="status-badge ${BATCH_STATUS_BADGE_CLASS[status]}">${BATCH_STATUS_LABEL[status]}</span>`;
}

/** Nunca deixa o EAN aparecer vazio/nulo cru — mesma regra de robustez já usada na Conferência por NF. */
export function safeEanDisplay(value: string | null | undefined): string {
  return value && value.trim() ? value : "Não informado";
}
