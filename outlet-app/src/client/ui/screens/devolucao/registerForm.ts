// EXPANSÃO GOSCAN — Módulo Devolução: registro (marketplace/pacote/NF),
// bipagem por EAN (reaproveita o catálogo já existente) e avaliação por
// item. Segue o mesmo padrão visual/estrutural da Conferência por NF
// (nfeConference.ts) — cards, status-badge, sku-picker, confirmModal, toast,
// som/vibração — sem reinventar nenhum desses componentes.
import { Icon } from "../../icons.ts";
import { showToast } from "../../toast.ts";
import { confirmAction, promptText } from "../../confirmModal.ts";
import { escapeHtml, debounce, describeError, renderErrorWithRetry, formatDateTime } from "../../../utils.ts";
import { searchSkuForPicker, type CatalogRow } from "../../../catalogApi.ts";
import { playSound, unlockConferenceSounds } from "../../../soundManager.ts";
import { vibrate } from "../../../vibrationFeedback.ts";
import { getAuthState, isManagerOrAdmin } from "../../../auth.ts";
import { isRapidDuplicateScan, type LastScanState } from "../../../returnsMatching.ts";
import {
  createReturn,
  checkDuplicatePackageCode,
  listReturns,
  getReturnWithItems,
  addReturnItemByEan,
  addReturnItemByVariant,
  linkReturnItemManually,
  setReturnItemQuantity,
  classifyReturnItem,
  removeReturnItem,
  uploadReturnItemPhoto,
  getReturnPhotoSignedUrl,
  markInvoiceSituation,
  updateReturnNotes,
  deleteReturn,
  getBatchPreviewSummary,
  sendBatchToLogistics,
  validateReturnInvoiceNumber,
  type Marketplace,
  type ReturnStatus,
  type ReturnWithNames,
  type ReturnItemRecord,
} from "../../../returnsApi.ts";
import type { InvoiceSituation, ReturnClassification } from "../../../returnsMatching.ts";
import { MARKETPLACE_LABEL, MARKETPLACE_OPTIONS, INVOICE_SITUATION_LABEL, INVOICE_SITUATION_OPTIONS, RETURN_STATUS_LABEL, CLASSIFICATION_OPTIONS, classificationBadge, returnStatusBadge, safeEanDisplay } from "./shared.ts";

export interface DevolucaoNavContext {
  goToDetail(returnId: string): void;
  goToList(): void;
}

const PRE_SEND_STATUSES: ReturnStatus[] = ["em_registro", "aguardando_avaliacao", "pendente_cancelamento_nota", "pronta_logistica", "com_pendencias"];

function isPreSend(status: ReturnStatus): boolean {
  return PRE_SEND_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Lista de devoluções + criação rápida.
// ---------------------------------------------------------------------------
let listPage = 0;
const LIST_PAGE_SIZE = 20;
let listMarketplaceFilter: Marketplace | "" = "";
let listStatusFilter: ReturnStatus | "" = "";
let listSearchQuery = "";
const listSelection = new Set<string>();

export async function renderReturnsListView(root: HTMLElement, ctx: DevolucaoNavContext): Promise<void> {
  root.innerHTML = `<div class="screen-loading">Carregando devoluções…</div>`;

  let page;
  try {
    page = await listReturns(
      { marketplace: listMarketplaceFilter || undefined, status: listStatusFilter || undefined, packageOrInvoiceQuery: listSearchQuery || undefined },
      listPage,
      LIST_PAGE_SIZE
    );
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao carregar devoluções: " + describeError(err), () => void renderReturnsListView(root, ctx));
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h2>Registrar devolução</h2>
      <p class="hint-text">Registre, avalie e organize devoluções recebidas dos marketplaces.</p>
      <button class="btn-primary btn-block" id="btnNewReturn">${Icon.plus}Registrar devolução</button>
      <div id="newReturnFormWrap"></div>
    </div>

    <div class="card">
      <h2>Devoluções</h2>
      <div class="filters-inline">
        <select id="filterMarketplace" aria-label="Marketplace">
          <option value="">Todos os marketplaces</option>
          ${MARKETPLACE_OPTIONS.map((o) => `<option value="${o.value}" ${listMarketplaceFilter === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
        <select id="filterStatus" aria-label="Status">
          <option value="">Todos os status</option>
          ${Object.entries(RETURN_STATUS_LABEL)
            .map(([value, label]) => `<option value="${value}" ${listStatusFilter === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <div class="search-row search-row-icon">
          ${Icon.search}
          <input type="text" id="filterSearch" placeholder="Buscar por pacote/pedido ou nº da NF…" value="${escapeHtml(listSearchQuery)}" />
        </div>
      </div>

      <div id="bulkSendWrap"></div>

      ${
        page.rows.length === 0
          ? `<div class="empty-state">${Icon.package}<p>Nenhuma devolução encontrada.</p></div>`
          : `<div class="product-card-list" id="returnsList">
              ${page.rows.map(renderReturnRow).join("")}
            </div>`
      }

      <div class="pagination-row">
        <button class="btn-secondary" id="btnPrevPage" ${listPage === 0 ? "disabled" : ""}>${Icon.chevronLeft}Anterior</button>
        <span class="hint-text">${listPage * LIST_PAGE_SIZE + 1}–${Math.min((listPage + 1) * LIST_PAGE_SIZE, page.total)} de ${page.total}</span>
        <button class="btn-secondary" id="btnNextPage" ${(listPage + 1) * LIST_PAGE_SIZE >= page.total ? "disabled" : ""}>Próxima${Icon.chevronRight}</button>
      </div>
    </div>`;

  wireListFilters(root, ctx);
  wireNewReturnForm(root, ctx);
  wireListRows(root, ctx);
  renderBulkSendBar(root, ctx);
}

function renderReturnRow(r: ReturnWithNames): string {
  const selectable = isPreSend(r.status);
  return `
    <div class="product-card" data-return-row="${r.id}">
      <div class="product-card-top">
        ${selectable ? `<input type="checkbox" data-return-select="${r.id}" aria-label="Selecionar devolução" ${listSelection.has(r.id) ? "checked" : ""} />` : ""}
        <p class="product-card-name">${escapeHtml(MARKETPLACE_LABEL[r.marketplace])} — ${escapeHtml(r.package_code)}</p>
        ${returnStatusBadge(r.status)}
      </div>
      <div class="product-card-meta">
        <span>NF: ${escapeHtml(r.invoice_number || "-")}</span>
        <span>${escapeHtml(INVOICE_SITUATION_LABEL[r.invoice_situation])}</span>
        <span>${escapeHtml(r.created_by_name || "-")}</span>
        <span>${formatDateTime(r.created_at)}</span>
      </div>
      <button type="button" class="btn-secondary btn-block" data-open-return="${r.id}">Abrir</button>
    </div>`;
}

function wireListFilters(root: HTMLElement, ctx: DevolucaoNavContext): void {
  root.querySelector<HTMLSelectElement>("#filterMarketplace")!.addEventListener("change", (e) => {
    listMarketplaceFilter = (e.target as HTMLSelectElement).value as Marketplace | "";
    listPage = 0;
    void renderReturnsListView(root, ctx);
  });
  root.querySelector<HTMLSelectElement>("#filterStatus")!.addEventListener("change", (e) => {
    listStatusFilter = (e.target as HTMLSelectElement).value as ReturnStatus | "";
    listPage = 0;
    void renderReturnsListView(root, ctx);
  });
  const search = debounce((value: string) => {
    listSearchQuery = value;
    listPage = 0;
    void renderReturnsListView(root, ctx);
  }, 300);
  root.querySelector<HTMLInputElement>("#filterSearch")!.addEventListener("input", (e) => search((e.target as HTMLInputElement).value));

  root.querySelector("#btnPrevPage")?.addEventListener("click", () => {
    if (listPage > 0) {
      listPage--;
      void renderReturnsListView(root, ctx);
    }
  });
  root.querySelector("#btnNextPage")?.addEventListener("click", () => {
    listPage++;
    void renderReturnsListView(root, ctx);
  });
}

function wireListRows(root: HTMLElement, ctx: DevolucaoNavContext): void {
  root.querySelectorAll<HTMLButtonElement>("[data-open-return]").forEach((btn) => {
    btn.addEventListener("click", () => ctx.goToDetail(btn.dataset.openReturn!));
  });
  root.querySelectorAll<HTMLInputElement>("[data-return-select]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.returnSelect!;
      if (cb.checked) listSelection.add(id);
      else listSelection.delete(id);
      renderBulkSendBar(root, ctx);
    });
  });
}

function renderBulkSendBar(root: HTMLElement, ctx: DevolucaoNavContext): void {
  const wrap = root.querySelector("#bulkSendWrap");
  if (!wrap) return;
  if (listSelection.size === 0) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = `
    <div class="warning-box">
      ${Icon.info} ${listSelection.size} devolução(ões) selecionada(s).
      <button class="btn-accent" id="btnBulkSend">Enviar selecionadas para a Logística</button>
    </div>`;
  wrap.querySelector("#btnBulkSend")!.addEventListener("click", () => void handleSendToLogistics(root, ctx, Array.from(listSelection), () => listSelection.clear()));
}

function wireNewReturnForm(root: HTMLElement, ctx: DevolucaoNavContext): void {
  const wrap = root.querySelector<HTMLElement>("#newReturnFormWrap")!;
  root.querySelector("#btnNewReturn")!.addEventListener("click", () => {
    wrap.innerHTML = `
      <label for="nrMarketplace">Marketplace</label>
      <select id="nrMarketplace">
        ${MARKETPLACE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}
      </select>
      <label for="nrPackageCode">Código do pacote, pedido ou rastreio</label>
      <input type="text" id="nrPackageCode" placeholder="Digite, cole ou bipe com o leitor…" autocomplete="off" />
      <div id="nrDuplicateWarning"></div>
      <label for="nrInvoiceSituation">Situação da nota</label>
      <select id="nrInvoiceSituation">
        ${INVOICE_SITUATION_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === "nao_se_aplica" ? "selected" : ""}>${o.label}</option>`).join("")}
      </select>
      <div id="nrInvoiceNumberWrap">
        <label for="nrInvoiceNumber">Número da NF</label>
        <input type="text" id="nrInvoiceNumber" placeholder="Opcional" />
      </div>
      <label for="nrNotes">Observações gerais</label>
      <textarea id="nrNotes" rows="2" placeholder="Opcional"></textarea>
      <button class="btn-primary btn-block" id="btnCreateReturn">Criar devolução</button>`;

    const packageInput = wrap.querySelector<HTMLInputElement>("#nrPackageCode")!;
    const dupWarning = wrap.querySelector<HTMLElement>("#nrDuplicateWarning")!;
    const situationSelect = wrap.querySelector<HTMLSelectElement>("#nrInvoiceSituation")!;
    const invoiceNumberWrap = wrap.querySelector<HTMLElement>("#nrInvoiceNumberWrap")!;

    const checkDup = debounce(async (code: string) => {
      if (!code.trim()) {
        dupWarning.innerHTML = "";
        return;
      }
      try {
        const matches = await checkDuplicatePackageCode(code);
        dupWarning.innerHTML =
          matches.length > 0
            ? `<div class="warning-box">${Icon.alertTriangle} Este código já foi registrado ${matches.length}x antes. Isso pode ser normal (mesmo pacote com mais de um produto/devolução) — confira antes de continuar.</div>`
            : "";
      } catch {
        // aviso não-crítico — silencioso em caso de falha
      }
    }, 350);
    packageInput.addEventListener("input", () => checkDup(packageInput.value));

    function refreshInvoiceNumberRequirement() {
      const label = invoiceNumberWrap.querySelector("label")!;
      label.textContent = situationSelect.value === "cancelada" ? "Número da NF (obrigatório)" : "Número da NF";
    }
    situationSelect.addEventListener("change", refreshInvoiceNumberRequirement);
    refreshInvoiceNumberRequirement();

    wrap.querySelector("#btnCreateReturn")!.addEventListener("click", async () => {
      const marketplace = (wrap.querySelector("#nrMarketplace") as HTMLSelectElement).value as Marketplace;
      const packageCode = packageInput.value;
      const invoiceSituation = situationSelect.value as InvoiceSituation;
      const invoiceNumber = (wrap.querySelector("#nrInvoiceNumber") as HTMLInputElement).value;
      const notes = (wrap.querySelector("#nrNotes") as HTMLTextAreaElement).value;

      if (!packageCode.trim()) {
        showToast("Informe o código do pacote/pedido/rastreio.", "error");
        return;
      }
      const validationError = validateReturnInvoiceNumber(invoiceSituation, invoiceNumber);
      if (validationError) {
        showToast(validationError, "error");
        return;
      }

      const btn = wrap.querySelector("#btnCreateReturn") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Criando…";
      try {
        const created = await createReturn({ marketplace, package_code: packageCode, invoice_situation: invoiceSituation, invoice_number: invoiceNumber, notes });
        showToast("Devolução criada.", "success");
        ctx.goToDetail(created.id);
      } catch (err) {
        showToast("Erro ao criar devolução: " + describeError(err), "error");
        btn.disabled = false;
        btn.textContent = "Criar devolução";
      }
    });
  });
}

async function handleSendToLogistics(root: HTMLElement, ctx: DevolucaoNavContext, returnIds: string[], onDone: () => void): Promise<void> {
  let summary;
  try {
    summary = await getBatchPreviewSummary(returnIds);
  } catch (err) {
    showToast("Erro ao calcular resumo: " + describeError(err), "error");
    return;
  }

  const message =
    `${returnIds.length} devolução(ões), ${summary.totalUnits} unidade(s) no total. ` +
    `Vendável: ${summary.vendavelUnits}. Avariado: ${summary.avariadoUnits}. Divergente: ${summary.divergenteUnits}. ` +
    `Pacote vazio: ${summary.pacoteVazioUnits}. Aguardando análise: ${summary.aguardandoAnaliseUnits}. ` +
    `${summary.pendingUnits > 0 ? `Pendências (EAN não localizado): ${summary.pendingUnits}. ` : ""}` +
    `${summary.blockedByPendingInvoiceUnits > 0 ? `Bloqueado por nota pendente: ${summary.blockedByPendingInvoiceUnits}. ` : ""}` +
    `Quantidade que será liberada para lançamento: ${summary.releasedToStockUnits}.`;

  const confirmed = await confirmAction({ title: "Enviar para a Logística?", message, confirmLabel: "Enviar" });
  if (!confirmed) return;

  try {
    const result = await sendBatchToLogistics(returnIds);
    showToast(`Enviado: ${result.total_skus} SKU(s), ${result.total_units} unidade(s) liberada(s) para a Logística.`, "success");
    onDone();
    void renderReturnsListView(root, ctx);
  } catch (err) {
    showToast("Erro ao enviar para a Logística: " + describeError(err), "error");
  }
}

// ---------------------------------------------------------------------------
// Detalhe de 1 devolução — registro/situação da nota + bipagem + avaliação.
// ---------------------------------------------------------------------------
let lastScan: LastScanState | null = null;
let lastAction: { itemId: string; type: "inserted" | "incremented"; previousQuantity?: number } | null = null;
let soundUnlocked = false;

export function resetReturnDetailState(): void {
  lastScan = null;
  lastAction = null;
}

export async function renderReturnDetailView(root: HTMLElement, ctx: DevolucaoNavContext, returnId: string): Promise<void> {
  root.innerHTML = `<div class="screen-loading">Carregando devolução…</div>`;
  let ret: ReturnWithNames;
  let items: ReturnItemRecord[];
  try {
    ({ ret, items } = await getReturnWithItems(returnId));
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao carregar devolução: " + describeError(err), () => void renderReturnDetailView(root, ctx, returnId));
    return;
  }

  const editable = isPreSend(ret.status);
  const { profile } = getAuthState();
  const canDelete = editable && isManagerOrAdmin(profile);

  root.innerHTML = `
    <button class="btn-secondary" id="btnBackToList">${Icon.chevronLeft}Voltar</button>

    <div class="card">
      <div class="product-card-top">
        <h2 style="margin:0">${escapeHtml(MARKETPLACE_LABEL[ret.marketplace])} — ${escapeHtml(ret.package_code)}</h2>
        ${returnStatusBadge(ret.status)}
      </div>
      <p class="hint-text">Registrada por ${escapeHtml(ret.created_by_name || "-")} em ${formatDateTime(ret.created_at)}</p>
      ${canDelete ? `<button class="btn-secondary" id="btnDeleteReturn">${Icon.trash}Excluir devolução</button>` : ""}

      <label for="drInvoiceSituation">Situação da nota</label>
      <select id="drInvoiceSituation" ${editable ? "" : "disabled"}>
        ${INVOICE_SITUATION_OPTIONS.map((o) => `<option value="${o.value}" ${ret.invoice_situation === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
      </select>
      <div id="drInvoiceNumberWrap">
        <label for="drInvoiceNumber">Número da NF</label>
        <input type="text" id="drInvoiceNumber" value="${escapeHtml(ret.invoice_number || "")}" ${editable ? "" : "disabled"} />
      </div>
      ${ret.invoice_cancelled_at ? `<p class="hint-text">${Icon.checkCircle} Nota marcada como cancelada em ${formatDateTime(ret.invoice_cancelled_at)}.</p>` : ""}
      ${editable ? `<button class="btn-secondary" id="btnSaveInvoiceSituation">Salvar situação da nota</button>` : ""}

      <label for="drNotes">Observações gerais</label>
      <textarea id="drNotes" rows="2" ${editable ? "" : "disabled"}>${escapeHtml(ret.notes || "")}</textarea>
      ${editable ? `<button class="btn-secondary" id="btnSaveNotes">Salvar observações</button>` : ""}

      ${!editable ? `<p class="hint-text">${Icon.lock} Esta devolução já foi enviada para a Logística — alterações agora exigem correção auditada (administradores).</p>` : ""}
    </div>

    ${editable ? renderBipagemCard() : ""}

    <div class="card">
      <div class="product-card-top">
        <h2 style="margin:0">Produtos (${items.length})</h2>
      </div>
      <div id="returnItemsList">${renderItemsList(items, editable)}</div>
    </div>

    ${
      editable
        ? `<div class="card">
            <button class="btn-accent btn-block" id="btnSendThisReturn">Enviar para a Logística</button>
          </div>`
        : ""
    }`;

  root.querySelector("#btnBackToList")!.addEventListener("click", ctx.goToList);

  if (canDelete) {
    root.querySelector("#btnDeleteReturn")!.addEventListener("click", async () => {
      const confirmed = await confirmAction({ title: "Excluir devolução?", message: "Esta devolução e seus itens registrados serão excluídos permanentemente.", confirmLabel: "Excluir", danger: true });
      if (!confirmed) return;
      try {
        await deleteReturn(ret.id);
        showToast("Devolução excluída.", "success");
        ctx.goToList();
      } catch (err) {
        showToast("Erro ao excluir devolução: " + describeError(err), "error");
      }
    });
  }

  if (editable) {
    wireInvoiceSituationForm(root, ret);
    root.querySelector("#btnSaveNotes")!.addEventListener("click", async () => {
      try {
        await updateReturnNotes(ret.id, (root.querySelector("#drNotes") as HTMLTextAreaElement).value);
        showToast("Observações salvas.", "success");
      } catch (err) {
        showToast("Erro ao salvar observações: " + describeError(err), "error");
      }
    });
    if (!soundUnlocked) {
      root.addEventListener(
        "click",
        () => {
          unlockConferenceSounds();
          soundUnlocked = true;
        },
        { once: true }
      );
    }
    wireBipagem(root, ctx, ret.id);
    wireItemsList(root, ctx, ret.id, items, editable);
    root.querySelector("#btnSendThisReturn")!.addEventListener("click", () => void handleSendToLogistics(root, ctx, [ret.id], () => {}));
  } else {
    wireItemsList(root, ctx, ret.id, items, editable);
  }
}

function wireInvoiceSituationForm(root: HTMLElement, ret: ReturnWithNames): void {
  const situationSelect = root.querySelector<HTMLSelectElement>("#drInvoiceSituation")!;
  const invoiceNumberInput = root.querySelector<HTMLInputElement>("#drInvoiceNumber")!;

  root.querySelector("#btnSaveInvoiceSituation")!.addEventListener("click", async () => {
    const situation = situationSelect.value as InvoiceSituation;
    const invoiceNumber = invoiceNumberInput.value;
    const validationError = validateReturnInvoiceNumber(situation, invoiceNumber);
    if (validationError) {
      showToast(validationError, "error");
      return;
    }
    const confirmed =
      situation === "cancelada" && ret.invoice_situation !== "cancelada"
        ? await confirmAction({ title: "Confirmar cancelamento da nota?", message: "Isto registra que VOCÊ confirmou o cancelamento manualmente — não é uma consulta automática à SEFAZ/Tiny.", confirmLabel: "Confirmar" })
        : true;
    if (!confirmed) return;
    try {
      await markInvoiceSituation(ret.id, situation, invoiceNumber);
      showToast("Situação da nota atualizada.", "success");
    } catch (err) {
      showToast("Erro ao atualizar situação da nota: " + describeError(err), "error");
    }
  });
}

function renderBipagemCard(): string {
  return `
    <div class="card">
      <h2>Bipar produtos</h2>
      <label for="drEanInput" class="sr-only">Digitar ou ler EAN</label>
      <div class="search-row search-row-icon">
        ${Icon.barcode}
        <input type="text" id="drEanInput" placeholder="Digitar ou ler EAN (bipagem +1)…" autocomplete="off" />
      </div>
      <div id="drUndoWrap"></div>
      <p class="hint-text">Ou busque manualmente por SKU/nome:</p>
      <div class="sku-picker" id="drManualPicker">
        <input type="text" class="sku-picker-input" aria-label="Buscar SKU ou nome" placeholder="Buscar SKU ou nome…" />
        <div class="sku-picker-results" hidden></div>
      </div>
    </div>`;
}

function renderUndoButton(root: HTMLElement): void {
  const wrap = root.querySelector("#drUndoWrap");
  if (!wrap) return;
  wrap.innerHTML = lastAction ? `<button class="btn-secondary" id="btnUndoLastScan">${Icon.undo2}Desfazer última bipagem</button>` : "";
  wrap.querySelector("#btnUndoLastScan")?.addEventListener("click", async () => {
    if (!lastAction) return;
    const action = lastAction;
    lastAction = null;
    try {
      if (action.type === "inserted") await removeReturnItem(action.itemId);
      else if (action.previousQuantity !== undefined) await setReturnItemQuantity(action.itemId, action.previousQuantity);
      showToast("Última bipagem desfeita.", "success");
      const emit = (root.closest("[data-return-detail]") as HTMLElement) || root;
      void refreshItemsOnly(emit);
    } catch (err) {
      showToast("Erro ao desfazer: " + describeError(err), "error");
    }
    renderUndoButton(root);
  });
}

let currentDetailReturnId: string | null = null;
let currentDetailCtx: DevolucaoNavContext | null = null;

async function refreshItemsOnly(root: HTMLElement): Promise<void> {
  if (!currentDetailReturnId || !currentDetailCtx) return;
  const { items } = await getReturnWithItems(currentDetailReturnId);
  const wrap = root.querySelector("#returnItemsList");
  if (wrap) {
    wrap.innerHTML = renderItemsList(items, true);
    wireItemsList(root, currentDetailCtx, currentDetailReturnId, items, true);
  }
}

function wireBipagem(root: HTMLElement, ctx: DevolucaoNavContext, returnId: string): void {
  currentDetailReturnId = returnId;
  currentDetailCtx = ctx;
  renderUndoButton(root);

  const eanInput = root.querySelector<HTMLInputElement>("#drEanInput")!;
  eanInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const raw = eanInput.value.trim();
    eanInput.value = "";
    if (!raw) return;

    const now = Date.now();
    if (isRapidDuplicateScan(raw, lastScan, now)) return;
    lastScan = { code: raw, atMs: now };

    try {
      const result = await addReturnItemByEan(returnId, raw);
      if (result.found) {
        playSound(result.incremented ? "quantity_added" : "product_correct");
        vibrate("success");
        showToast(`${result.item.resolved_product_name || result.item.resolved_sku_code}: ${result.item.quantity} unidade(s).`, "success");
        lastAction = result.incremented
          ? { itemId: result.item.id, type: "incremented", previousQuantity: result.item.quantity - 1 }
          : { itemId: result.item.id, type: "inserted" };
      } else {
        playSound("unknown_ean");
        vibrate("error");
        showToast("EAN não encontrado no catálogo — salvo como pendência. Use a busca manual para resolver.", "error");
        lastAction = { itemId: result.item.id, type: "inserted" };
      }
      renderUndoButton(root);
      await refreshItemsOnly(root);
    } catch (err) {
      showToast("Erro ao registrar bipagem: " + describeError(err), "error");
    }
  });

  wireManualPicker(root.querySelector<HTMLElement>("#drManualPicker")!, async (variant) => {
    try {
      const result = await addReturnItemByVariant(returnId, variant);
      showToast(`${result.item.resolved_product_name}: ${result.item.quantity} unidade(s).`, "success");
      await refreshItemsOnly(root);
    } catch (err) {
      showToast("Erro ao adicionar produto: " + describeError(err), "error");
    }
  });
}

function wireManualPicker(container: HTMLElement, onPick: (variant: CatalogRow) => void): void {
  const input = container.querySelector<HTMLInputElement>(".sku-picker-input")!;
  const resultsBox = container.querySelector<HTMLDivElement>(".sku-picker-results")!;
  let controller: AbortController | null = null;

  const search = debounce(async (query: string) => {
    if (!query.trim()) {
      resultsBox.hidden = true;
      return;
    }
    controller?.abort();
    controller = new AbortController();
    try {
      const rows = await searchSkuForPicker(query, 15, undefined, controller.signal, false);
      renderResults(rows);
    } catch {
      // busca cancelada/abortada — ignora silenciosamente
    }
  }, 300);

  input.addEventListener("input", () => search(input.value));

  function renderResults(rows: CatalogRow[]) {
    if (rows.length === 0) {
      resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum SKU encontrado.</div>`;
      resultsBox.hidden = false;
      return;
    }
    resultsBox.innerHTML = rows
      .map(
        (r) =>
          `<button type="button" class="sku-picker-item" data-variant-id="${r.variant_id}">${escapeHtml(r.produto)} — ${escapeHtml(r.cor || "")} <span class="sku-code">${escapeHtml(r.sku_code)}</span></button>`
      )
      .join("");
    resultsBox.hidden = false;
    resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((btn, idx) => {
      btn.addEventListener("click", () => {
        resultsBox.hidden = true;
        input.value = "";
        onPick(rows[idx]);
      });
    });
  }
}

function renderItemsList(items: ReturnItemRecord[], editable: boolean): string {
  if (items.length === 0) return `<div class="empty-state">${Icon.package}<p>Nenhum produto adicionado ainda.</p></div>`;
  return `<div class="product-card-list">${items.map((it) => renderItemCard(it, editable)).join("")}</div>`;
}

function renderItemCard(it: ReturnItemRecord, editable: boolean): string {
  const showConditionNotes = it.classification === "avariado" || it.classification === "divergente";
  return `
    <div class="product-card" data-item-card="${it.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(it.resolved_product_name || (it.is_pending ? "Produto não identificado" : "-"))}</p>
        ${it.is_pending ? `<span class="status-badge warning">${Icon.alertTriangle}Pendência</span>` : classificationBadge(it.classification)}
      </div>
      <div class="product-card-meta">
        <span class="sku-code">${escapeHtml(it.resolved_sku_code || "-")}</span>
        <span class="ean-copy-chip" data-item-ean>${safeEanDisplay(it.ean_normalized || it.scanned_ean_raw)}</span>
      </div>

      ${
        it.is_pending
          ? `<div class="sku-picker" data-resolve-pending="${it.id}">
              <input type="text" class="sku-picker-input" aria-label="Resolver pendência: buscar SKU ou nome" placeholder="Buscar SKU ou nome pra resolver…" />
              <div class="sku-picker-results" hidden></div>
            </div>`
          : ""
      }

      <div class="product-card-bottom">
        <div class="qty-stepper">
          <button type="button" data-qty-dec="${it.id}" aria-label="Diminuir quantidade" ${editable ? "" : "disabled"}>${Icon.minus}</button>
          <input type="text" inputmode="numeric" aria-label="Quantidade" value="${it.quantity}" readonly data-qty-value="${it.id}" />
          <button type="button" data-qty-inc="${it.id}" aria-label="Aumentar quantidade" ${editable ? "" : "disabled"}>${Icon.plus}</button>
        </div>
        ${editable ? `<button class="icon-btn danger" data-remove-item="${it.id}" aria-label="Remover item">${Icon.trash}</button>` : ""}
      </div>

      ${
        editable && !it.is_pending
          ? `<label for="cls-${it.id}" class="sr-only">Classificação</label>
             <select id="cls-${it.id}" data-classification-select="${it.id}">
               ${CLASSIFICATION_OPTIONS.map((o) => `<option value="${o.value}" ${it.classification === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
             </select>`
          : ""
      }
      ${
        editable && showConditionNotes
          ? `<label for="notes-${it.id}" class="sr-only">Observação/justificativa</label>
             <textarea id="notes-${it.id}" data-condition-notes="${it.id}" rows="2" placeholder="Observação ou justificativa (foto opcional)…">${escapeHtml(it.condition_notes || "")}</textarea>
             <input type="file" accept="image/*" data-photo-input="${it.id}" hidden />
             <button type="button" class="btn-secondary" data-photo-btn="${it.id}">${Icon.imagePlus}${it.photo_path ? "Trocar foto" : "Adicionar foto"}</button>
             ${it.photo_path ? `<button type="button" class="btn-secondary" data-view-photo="${it.id}">${Icon.eye}Ver foto</button>` : ""}`
          : ""
      }
    </div>`;
}

function wireItemsList(root: HTMLElement, ctx: DevolucaoNavContext, returnId: string, items: ReturnItemRecord[], editable: boolean): void {
  const wrap = root.querySelector<HTMLElement>("#returnItemsList")!;

  wrap.querySelectorAll<HTMLElement>("[data-item-ean]").forEach((el) => {
    el.addEventListener("click", async () => {
      const text = el.textContent?.trim();
      if (!text || text === "Não informado") return;
      try {
        await navigator.clipboard.writeText(text);
        showToast("EAN copiado.", "success");
      } catch {
        showToast("Não foi possível copiar o EAN.", "error");
      }
    });
  });

  if (!editable) return;

  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-dec]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const it = items.find((i) => i.id === btn.dataset.qtyDec);
      if (!it || it.quantity <= 1) return;
      try {
        await setReturnItemQuantity(it.id, it.quantity - 1);
        await refreshItemsOnly(root);
      } catch (err) {
        showToast("Erro ao ajustar quantidade: " + describeError(err), "error");
      }
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-inc]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const it = items.find((i) => i.id === btn.dataset.qtyInc);
      if (!it) return;
      try {
        await setReturnItemQuantity(it.id, it.quantity + 1);
        await refreshItemsOnly(root);
      } catch (err) {
        showToast("Erro ao ajustar quantidade: " + describeError(err), "error");
      }
    });
  });
  wrap.querySelectorAll<HTMLElement>("[data-qty-value]").forEach((el) => {
    el.addEventListener("click", async () => {
      const itemId = el.dataset.qtyValue!;
      const it = items.find((i) => i.id === itemId);
      if (!it) return;
      const value = await promptText({ title: "Alterar quantidade", message: "Informe a nova quantidade.", placeholder: String(it.quantity), confirmLabel: "Confirmar" });
      if (!value) return;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        showToast("Quantidade inválida.", "error");
        return;
      }
      try {
        await setReturnItemQuantity(itemId, Math.floor(parsed));
        await refreshItemsOnly(root);
      } catch (err) {
        showToast("Erro ao ajustar quantidade: " + describeError(err), "error");
      }
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-remove-item]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = await confirmAction({ title: "Remover item?", message: "Este item será removido da devolução.", confirmLabel: "Remover", danger: true });
      if (!confirmed) return;
      try {
        await removeReturnItem(btn.dataset.removeItem!);
        await refreshItemsOnly(root);
      } catch (err) {
        showToast("Erro ao remover item: " + describeError(err), "error");
      }
    });
  });

  wrap.querySelectorAll<HTMLSelectElement>("[data-classification-select]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const itemId = sel.dataset.classificationSelect!;
      try {
        await classifyReturnItem(itemId, { classification: sel.value as ReturnClassification });
        showToast("Classificação atualizada.", "success");
        await refreshItemsOnly(root);
      } catch (err) {
        showToast("Erro ao classificar item: " + describeError(err), "error");
      }
    });
  });

  wrap.querySelectorAll<HTMLTextAreaElement>("[data-condition-notes]").forEach((ta) => {
    ta.addEventListener("blur", async () => {
      const itemId = ta.dataset.conditionNotes!;
      const it = items.find((i) => i.id === itemId);
      if (!it) return;
      try {
        await classifyReturnItem(itemId, { classification: it.classification, condition_notes: ta.value });
      } catch (err) {
        showToast("Erro ao salvar observação: " + describeError(err), "error");
      }
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-photo-btn]").forEach((btn) => {
    const itemId = btn.dataset.photoBtn!;
    const fileInput = wrap.querySelector<HTMLInputElement>(`[data-photo-input="${itemId}"]`)!;
    btn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        await uploadReturnItemPhoto(returnId, itemId, file);
        showToast("Foto enviada.", "success");
        await refreshItemsOnly(root);
      } catch (err) {
        showToast("Erro ao enviar foto: " + describeError(err), "error");
      }
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-view-photo]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const it = items.find((i) => i.id === btn.dataset.viewPhoto);
      if (!it?.photo_path) return;
      const url = await getReturnPhotoSignedUrl(it.photo_path);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else showToast("Não foi possível carregar a foto.", "error");
    });
  });

  wrap.querySelectorAll<HTMLElement>("[data-resolve-pending]").forEach((container) => {
    const itemId = container.dataset.resolvePending!;
    wireManualPicker(container, async (variant) => {
      try {
        await linkReturnItemManually(itemId, variant);
        showToast(`Vinculado a ${variant.produto}.`, "success");
        await refreshItemsOnly(root);
      } catch (err) {
        showToast("Erro ao vincular produto: " + describeError(err), "error");
      }
    });
  });
}
