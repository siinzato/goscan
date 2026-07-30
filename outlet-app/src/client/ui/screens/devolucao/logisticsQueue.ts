// EXPANSÃO GOSCAN — Módulo Devolução: fila da Logística ("Aguardando
// lançamento") — resumo consolidado por SKU + confirmação MANUAL do
// lançamento no Tiny (nunca automática, ver pedido seção 9).
import { Icon } from "../../icons.ts";
import { showToast } from "../../toast.ts";
import { confirmAction, promptText } from "../../confirmModal.ts";
import { escapeHtml, describeError, renderErrorWithRetry, formatDateTime } from "../../../utils.ts";
import { getAuthState, isManagerOrAdmin } from "../../../auth.ts";
import { listBatches, getBatchDetail, confirmBatchTinyLaunch, reopenBatch, type ReturnBatchSummary, type BatchItemDetail, type ReturnBatchStatus } from "../../../returnsApi.ts";
import { MARKETPLACE_LABEL, batchStatusBadge, safeEanDisplay } from "./shared.ts";

export interface LogisticsNavContext {
  goToBatchDetail(batchId: string): void;
  goToQueueList(): void;
}

let queueStatusFilter: ReturnBatchStatus | "" = "aguardando_lancamento";
let queuePage = 0;
const QUEUE_PAGE_SIZE = 20;

export async function renderLogisticsQueueView(root: HTMLElement, ctx: LogisticsNavContext): Promise<void> {
  root.innerHTML = `<div class="screen-loading">Carregando fila da Logística…</div>`;

  let page;
  try {
    page = await listBatches(queueStatusFilter || undefined, queuePage, QUEUE_PAGE_SIZE);
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao carregar lotes: " + describeError(err), () => void renderLogisticsQueueView(root, ctx));
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h2>Aguardando lançamento</h2>
      <p class="hint-text">Lotes consolidados por SKU, enviados pela responsável pelas devoluções.</p>
      <select id="queueStatusFilter" aria-label="Status do lote">
        <option value="aguardando_lancamento" ${queueStatusFilter === "aguardando_lancamento" ? "selected" : ""}>Aguardando lançamento</option>
        <option value="concluida" ${queueStatusFilter === "concluida" ? "selected" : ""}>Concluídos</option>
        <option value="" ${queueStatusFilter === "" ? "selected" : ""}>Todos</option>
      </select>

      ${
        page.rows.length === 0
          ? `<div class="empty-state">${Icon.package}<p>Nenhum lote encontrado.</p></div>`
          : `<div class="product-card-list">${page.rows.map(renderBatchRow).join("")}</div>`
      }

      <div class="pagination-row">
        <button class="btn-secondary" id="btnPrevPage" ${queuePage === 0 ? "disabled" : ""}>${Icon.chevronLeft}Anterior</button>
        <span class="hint-text">${queuePage * QUEUE_PAGE_SIZE + 1}–${Math.min((queuePage + 1) * QUEUE_PAGE_SIZE, page.total)} de ${page.total}</span>
        <button class="btn-secondary" id="btnNextPage" ${(queuePage + 1) * QUEUE_PAGE_SIZE >= page.total ? "disabled" : ""}>Próxima${Icon.chevronRight}</button>
      </div>
    </div>`;

  root.querySelector<HTMLSelectElement>("#queueStatusFilter")!.addEventListener("change", (e) => {
    queueStatusFilter = (e.target as HTMLSelectElement).value as ReturnBatchStatus | "";
    queuePage = 0;
    void renderLogisticsQueueView(root, ctx);
  });
  root.querySelector("#btnPrevPage")?.addEventListener("click", () => {
    if (queuePage > 0) {
      queuePage--;
      void renderLogisticsQueueView(root, ctx);
    }
  });
  root.querySelector("#btnNextPage")?.addEventListener("click", () => {
    queuePage++;
    void renderLogisticsQueueView(root, ctx);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-open-batch]").forEach((btn) => {
    btn.addEventListener("click", () => ctx.goToBatchDetail(btn.dataset.openBatch!));
  });
}

function renderBatchRow(b: ReturnBatchSummary): string {
  return `
    <div class="product-card">
      <div class="product-card-top">
        <p class="product-card-name">Lote ${b.id.slice(0, 8)}</p>
        ${batchStatusBadge(b.status)}
      </div>
      <div class="product-card-meta">
        <span>${b.total_returns} devolução(ões)</span>
        <span>${b.total_skus} SKU(s)</span>
        <span>${b.total_units} unidade(s)</span>
        <span>${b.marketplaces.map((m) => MARKETPLACE_LABEL[m]).join(", ")}</span>
        <span>${formatDateTime(b.created_at)}</span>
      </div>
      <button type="button" class="btn-secondary btn-block" data-open-batch="${b.id}">Abrir</button>
    </div>`;
}

export async function renderBatchDetailView(root: HTMLElement, ctx: LogisticsNavContext, batchId: string): Promise<void> {
  root.innerHTML = `<div class="screen-loading">Carregando lote…</div>`;
  let batch;
  let items: BatchItemDetail[];
  try {
    ({ batch, items } = await getBatchDetail(batchId));
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao carregar lote: " + describeError(err), () => void renderBatchDetailView(root, ctx, batchId));
    return;
  }

  const { profile } = getAuthState();
  const canReopen = isManagerOrAdmin(profile) && batch.status === "concluida";
  const canConfirm = batch.status === "aguardando_lancamento";
  const totalUnits = items.reduce((acc, it) => acc + it.total_quantity, 0);

  root.innerHTML = `
    <button class="btn-secondary" id="btnBackToQueue">${Icon.chevronLeft}Voltar</button>

    <div class="card">
      <div class="product-card-top">
        <h2 style="margin:0">Lote ${batch.id.slice(0, 8)}</h2>
        ${batchStatusBadge(batch.status)}
      </div>
      <p class="hint-text">${items.length} SKU(s) — ${totalUnits} unidade(s) no total.</p>

      <div class="table-wrap">
        <table>
          <thead><tr><th>SKU</th><th>EAN</th><th>Produto</th><th>Quantidade</th><th></th></tr></thead>
          <tbody>
            ${items
              .map(
                (it) => `
              <tr>
                <td class="sku-code">${escapeHtml(it.sku_code)}</td>
                <td>${escapeHtml(safeEanDisplay(it.gtin))}</td>
                <td>${escapeHtml(it.produto)}</td>
                <td>${it.total_quantity}</td>
                <td><button type="button" class="btn-secondary" data-expand-item="${it.id}">Detalhar</button></td>
              </tr>
              <tr class="batch-item-sources" data-sources-row="${it.id}" hidden>
                <td colspan="5">
                  <div class="table-wrap">
                    <table>
                      <thead><tr><th>Marketplace</th><th>Pacote/Pedido</th><th>Nº NF</th><th>Classificação</th><th>Qtd</th></tr></thead>
                      <tbody>
                        ${it.sources
                          .map(
                            (s) => `<tr><td>${escapeHtml(MARKETPLACE_LABEL[s.marketplace])}</td><td>${escapeHtml(s.package_code)}</td><td>${escapeHtml(s.invoice_number || "-")}</td><td>${escapeHtml(s.classification)}</td><td>${s.quantity}</td></tr>`
                          )
                          .join("")}
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>

    ${
      canConfirm
        ? `<div class="card">
            <h2>Confirmar lançamento no Tiny</h2>
            <div class="warning-box">${Icon.info} Esta confirmação informa que as quantidades acima foram lançadas manualmente no Tiny. Ela não atualiza o estoque automaticamente.</div>
            <label for="bdWarehouse">Depósito utilizado</label>
            <input type="text" id="bdWarehouse" placeholder="Ex.: Depósito Central" />
            <label for="bdLaunchedAt">Data do lançamento</label>
            <input type="datetime-local" id="bdLaunchedAt" value="${new Date().toISOString().slice(0, 16)}" />
            <label for="bdNote">Observação (opcional)</label>
            <textarea id="bdNote" rows="2"></textarea>
            <button class="btn-accent btn-block" id="btnConfirmLaunch">Confirmar lançamento no Tiny</button>
          </div>`
        : ""
    }

    ${
      canReopen
        ? `<div class="card">
            <button class="btn-secondary" id="btnReopenBatch">${Icon.undo2}Reabrir lote (administrador)</button>
          </div>`
        : ""
    }`;

  root.querySelector("#btnBackToQueue")!.addEventListener("click", ctx.goToQueueList);

  root.querySelectorAll<HTMLButtonElement>("[data-expand-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = root.querySelector<HTMLElement>(`[data-sources-row="${btn.dataset.expandItem}"]`)!;
      row.hidden = !row.hidden;
    });
  });

  if (canConfirm) {
    root.querySelector("#btnConfirmLaunch")!.addEventListener("click", async () => {
      const warehouse = (root.querySelector("#bdWarehouse") as HTMLInputElement).value;
      const launchedAtRaw = (root.querySelector("#bdLaunchedAt") as HTMLInputElement).value;
      const note = (root.querySelector("#bdNote") as HTMLTextAreaElement).value;
      if (!warehouse.trim()) {
        showToast("Informe o depósito utilizado.", "error");
        return;
      }
      if (!launchedAtRaw) {
        showToast("Informe a data do lançamento.", "error");
        return;
      }
      const confirmed = await confirmAction({
        title: "Confirmar lançamento?",
        message: `Confirma que ${totalUnits} unidade(s) foram lançadas manualmente no depósito "${warehouse}"? Esta ação não pode ser desfeita sem intervenção de um administrador.`,
        confirmLabel: "Confirmar lançamento",
      });
      if (!confirmed) return;

      const btn = root.querySelector("#btnConfirmLaunch") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Confirmando…";
      try {
        await confirmBatchTinyLaunch({ batchId: batch.id, warehouse, launchedAt: new Date(launchedAtRaw).toISOString(), note });
        showToast("Lançamento confirmado.", "success");
        void renderBatchDetailView(root, ctx, batchId);
      } catch (err) {
        showToast("Erro ao confirmar lançamento: " + describeError(err), "error");
        btn.disabled = false;
        btn.textContent = "Confirmar lançamento no Tiny";
      }
    });
  }

  if (canReopen) {
    root.querySelector("#btnReopenBatch")!.addEventListener("click", async () => {
      const reason = await promptText({ title: "Reabrir lote", message: "Informe o motivo da reabertura (fica registrado na auditoria).", placeholder: "Motivo…", confirmLabel: "Reabrir" });
      if (!reason) return;
      try {
        await reopenBatch(batch.id, reason);
        showToast("Lote reaberto.", "success");
        void renderBatchDetailView(root, ctx, batchId);
      } catch (err) {
        showToast("Erro ao reabrir lote: " + describeError(err), "error");
      }
    });
  }
}
