// EXPANSÃO GOSCAN — Módulo Devolução: lógica pura (sem Supabase/DOM), testável
// isoladamente, mesmo padrão de nfeMatching.ts. A resolução de EAN em si
// reaproveita searchCatalog (catalogApi.ts) — que já faz o match EXATO por
// gtin_normalized — então não há uma segunda regra de normalização aqui.

export type ReturnClassification = "vendavel" | "avariado" | "divergente" | "pacote_vazio" | "aguardando_analise";
export type InvoiceSituation = "pendente_cancelamento" | "cancelada" | "nao_se_aplica";

export interface ReturnItemForSummary {
  classification: ReturnClassification;
  quantity: number;
  invoice_situation: InvoiceSituation;
  is_pending: boolean;
}

/**
 * Regra central (ver pedido, seção 7): só item "vendável" cuja nota NÃO
 * esteja "pendente de cancelamento" libera quantidade pra estoque. Item
 * pendente (EAN não resolvido) nunca libera, independente da classificação.
 * Reaproveitada tanto pelo preview client-side (antes de enviar) quanto
 * espelhada na RPC send_return_batch_to_logistics (0048) — a fonte da
 * verdade que de fato grava é sempre a RPC; esta função é só para exibição.
 */
export function isEligibleForStock(item: ReturnItemForSummary): boolean {
  return item.classification === "vendavel" && item.invoice_situation !== "pendente_cancelamento" && !item.is_pending;
}

export interface BatchPreviewSummary {
  totalItems: number;
  totalUnits: number;
  vendavelUnits: number;
  avariadoUnits: number;
  divergenteUnits: number;
  pacoteVazioUnits: number;
  aguardandoAnaliseUnits: number;
  pendingUnits: number;
  blockedByPendingInvoiceUnits: number;
  releasedToStockUnits: number;
}

/** Resumo mostrado antes de "Enviar para a Logística"/exportar relatório (ver pedido, seção 7 e 10). Nunca soma líquida — sempre contagem/soma por categoria, cada uma explícita. */
export function summarizeReturnItemsForBatchPreview(items: ReturnItemForSummary[]): BatchPreviewSummary {
  const summary: BatchPreviewSummary = {
    totalItems: 0,
    totalUnits: 0,
    vendavelUnits: 0,
    avariadoUnits: 0,
    divergenteUnits: 0,
    pacoteVazioUnits: 0,
    aguardandoAnaliseUnits: 0,
    pendingUnits: 0,
    blockedByPendingInvoiceUnits: 0,
    releasedToStockUnits: 0,
  };

  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    summary.totalItems++;
    summary.totalUnits += qty;

    if (item.is_pending) summary.pendingUnits += qty;

    switch (item.classification) {
      case "vendavel":
        summary.vendavelUnits += qty;
        break;
      case "avariado":
        summary.avariadoUnits += qty;
        break;
      case "divergente":
        summary.divergenteUnits += qty;
        break;
      case "pacote_vazio":
        summary.pacoteVazioUnits += qty;
        break;
      case "aguardando_analise":
        summary.aguardandoAnaliseUnits += qty;
        break;
    }

    if (item.classification === "vendavel" && item.invoice_situation === "pendente_cancelamento") {
      summary.blockedByPendingInvoiceUnits += qty;
    }
    if (isEligibleForStock(item)) {
      summary.releasedToStockUnits += qty;
    }
  }

  return summary;
}

/**
 * Guarda simples contra o "mesmo código enviado duas vezes rapidamente pelo
 * leitor" (ruído de hardware, ver pedido seção 5) — nunca impede bipagens
 * intencionais consecutivas do mesmo produto (janela curta, só rejeita um
 * segundo evento praticamente instantâneo).
 */
const RAPID_REPEAT_WINDOW_MS = 400;

export interface LastScanState {
  code: string;
  atMs: number;
}

export function isRapidDuplicateScan(code: string, last: LastScanState | null, nowMs: number): boolean {
  if (!last) return false;
  return last.code === code && nowMs - last.atMs < RAPID_REPEAT_WINDOW_MS;
}
