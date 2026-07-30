// EXPANSÃO GOSCAN — Módulo Devolução: fila da Logística ("Aguardando
// lançamento") — resumo consolidado por SKU + confirmação MANUAL do
// lançamento no Tiny (nunca automática, ver pedido seção 9).
import { Icon } from "../../icons.ts";
import { showToast } from "../../toast.ts";
import { confirmAction, promptText } from "../../confirmModal.ts";
import { escapeHtml, describeError, renderErrorWithRetry, formatDateTime } from "../../../utils.ts";
import { getAuthState, isManagerOrAdmin } from "../../../auth.ts";
import { listBatches, getBatchDetail, confirmBatchTinyLaunch, reopenBatch, type ReturnBatchSummary, type BatchItemDetail, type ReturnBatchStatus } from "../../../returnsApi.ts";
import { getTinyWarehouses, launchReturnBatchToTiny, TinyIntegrationError, type TinyWarehouse, type TinyLaunchOutcome } from "../../../tinyIntegrationApi.ts";
import { MARKETPLACE_LABEL, batchStatusBadge, safeEanDisplay } from "./shared.ts";

// Cache de sessão simples (mesmo padrão de cachedGroups em adminPanel.ts) —
// a lista de depósitos do Tiny não muda a cada clique; evita bater na API de
// novo toda vez que o admin abre o formulário automático de novo.
let cachedTinyWarehouses: TinyWarehouse[] | null = null;

function describeLaunchOutcome(outcome: TinyLaunchOutcome): string {
  const { summary } = outcome;
  const parts = [`${summary.succeeded} lançado(s)`];
  if (summary.alreadyDone > 0) parts.push(`${summary.alreadyDone} já lançado(s) antes`);
  if (summary.failed > 0) parts.push(`${summary.failed} com falha`);
  return parts.join(", ") + ".";
}

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
  // "lancada_tiny" = um lançamento automático anterior ficou parcial (alguns
  // itens deram certo, outros não) — continua podendo confirmar/retentar,
  // nunca trava o lote nesse estado intermediário.
  const canConfirm = batch.status === "aguardando_lancamento" || batch.status === "lancada_tiny";
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
            <h2>${Icon.link}Lançar automaticamente via API do Tiny</h2>
            <p class="hint-text">Se a integração com o Tiny estiver configurada, o GoScan cria a movimentação de estoque de verdade — item a item — e só confirma o lote quando tudo for aceito pelo Tiny.</p>
            <div id="tinyAutoLaunchWrap">
              <button type="button" class="btn-secondary btn-block" id="btnLoadWarehouses">${Icon.refresh}Buscar depósitos do Tiny</button>
            </div>
          </div>
          <div class="card">
            <h2>Ou registre manualmente</h2>
            <div class="warning-box">${Icon.info} Esta confirmação informa que as quantidades acima foram lançadas manualmente no Tiny (por fora do GoScan). Ela não atualiza o estoque automaticamente.</div>
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
    wireAutoTinyLaunch(root, ctx, batch.id, batchId, totalUnits);

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

/**
 * Botão "Buscar depósitos do Tiny" busca a lista real sob demanda (nunca ao
 * carregar a tela — sem chamada externa desnecessária) e só então revela o
 * formulário de lançamento automático. Se a integração não estiver
 * configurada (NOT_CONFIGURED), avisa e mantém só a confirmação manual
 * disponível — nunca trava o fluxo por falta de API.
 */
function wireAutoTinyLaunch(root: HTMLElement, ctx: LogisticsNavContext, batchId: string, batchIdForReload: string, totalUnits: number): void {
  const wrap = root.querySelector<HTMLElement>("#tinyAutoLaunchWrap")!;
  const loadBtn = root.querySelector<HTMLButtonElement>("#btnLoadWarehouses")!;

  loadBtn.addEventListener("click", async () => {
    loadBtn.disabled = true;
    loadBtn.textContent = "Buscando…";
    try {
      if (!cachedTinyWarehouses) cachedTinyWarehouses = await getTinyWarehouses();
      renderAutoLaunchForm(wrap, cachedTinyWarehouses, batchId, batchIdForReload, totalUnits, root, ctx);
    } catch (err) {
      if (err instanceof TinyIntegrationError && err.code === "NOT_CONFIGURED") {
        showToast("Integração com o Tiny ainda não configurada — use a confirmação manual abaixo.", "error");
      } else {
        showToast("Erro ao buscar depósitos: " + describeError(err), "error");
      }
      loadBtn.disabled = false;
      loadBtn.textContent = "Buscar depósitos do Tiny";
    }
  });
}

function renderAutoLaunchForm(
  wrap: HTMLElement,
  warehouses: TinyWarehouse[],
  batchId: string,
  batchIdForReload: string,
  totalUnits: number,
  root: HTMLElement,
  ctx: LogisticsNavContext
): void {
  if (warehouses.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum depósito encontrado no Tiny.</p>`;
    return;
  }
  wrap.innerHTML = `
    <label for="tinyWarehouseSelect">Depósito (Tiny)</label>
    <select id="tinyWarehouseSelect">${warehouses.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("")}</select>
    <label for="tinyUnitPrice">Valor unitário (opcional)</label>
    <input type="number" id="tinyUnitPrice" min="0" step="0.01" placeholder="0,00" />
    <label for="tinyNote">Observação (opcional)</label>
    <textarea id="tinyNote" rows="2"></textarea>
    <button type="button" class="btn-accent btn-block" id="btnLaunchViaApi">${Icon.link}Lançar ${totalUnits} unidade(s) via Tiny</button>
    <p class="hint-text" id="tinyLaunchResult"></p>`;

  wrap.querySelector("#btnLaunchViaApi")!.addEventListener("click", async () => {
    const select = wrap.querySelector<HTMLSelectElement>("#tinyWarehouseSelect")!;
    const warehouseId = select.value;
    const warehouseName = select.options[select.selectedIndex]?.text || "";
    const unitPriceRaw = (wrap.querySelector<HTMLInputElement>("#tinyUnitPrice")!).value;
    const note = (wrap.querySelector<HTMLTextAreaElement>("#tinyNote")!).value;

    const confirmed = await confirmAction({
      title: "Lançar via API do Tiny?",
      message: `O GoScan vai chamar a API do Tiny agora e criar a entrada de estoque real pra cada SKU do lote no depósito "${warehouseName}". Isso não pode ser desfeito automaticamente.`,
      confirmLabel: "Lançar agora",
    });
    if (!confirmed) return;

    const btn = wrap.querySelector<HTMLButtonElement>("#btnLaunchViaApi")!;
    const resultEl = wrap.querySelector<HTMLElement>("#tinyLaunchResult")!;
    btn.disabled = true;
    btn.textContent = "Lançando…";
    try {
      const outcome = await launchReturnBatchToTiny(batchId, {
        warehouseId,
        warehouseName,
        unitPrice: unitPriceRaw ? Number(unitPriceRaw) : undefined,
        note: note || undefined,
      });
      showToast(describeLaunchOutcome(outcome), outcome.summary.allSucceeded ? "success" : "error");
      if (!outcome.summary.allSucceeded) {
        const failedList = outcome.results
          .filter((r) => r.status === "failed")
          .map((r) => r.error)
          .join(" | ");
        resultEl.textContent = `Itens com falha: ${failedList}`;
      }
      void renderBatchDetailView(root, ctx, batchIdForReload);
    } catch (err) {
      showToast("Erro ao lançar via Tiny: " + describeError(err), "error");
      btn.disabled = false;
      btn.textContent = `Lançar ${totalUnits} unidade(s) via Tiny`;
    }
  });
}
