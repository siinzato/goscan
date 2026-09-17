import {
  getConference,
  searchConferenceHistory,
  listVisibleOperators,
  type Conference,
  type ConferenceWithOperator,
  type ConferenceItemWithVariant,
  type ConferenceStatus,
  type VisibleOperator,
} from "../../conferencesApi.ts";
import {
  getReceipt,
  searchReceiptHistory,
  searchReceiptAttention,
  getReceiptAttentionCounts,
  type ReceiptWithCounts,
  type ReceiptStatus,
  type ReceiptAttentionRow,
  type ReceiptAttentionCategory,
} from "../../nfeApi.ts";
import { RECEIPT_STATUS_LABEL, reportStatusStamp, itemTitle, itemCodeLabel, itemEanLabel } from "../../nfeReportFormat.ts";
import { summarizeReceipt } from "../../nfeMatching.ts";
import { renderOperationalIndicators } from "./operationalIndicators.ts";
import { exportOutletReportToXlsx, exportNfeReportToXlsx } from "../../exporter.ts";
import { showToast } from "../toast.ts";
import {
  escapeHtml,
  formatDateTime,
  formatOperationDuration,
  formatSignedNumber,
  describeError,
  renderErrorWithRetry,
  debounce,
  parseLocalDateRangeIso,
  parseHistoricoHash,
  hasActiveHistoryFilters,
  matchOperatorIdsByName,
} from "../../utils.ts";
import { Icon } from "../icons.ts";

// EXPANSÃO GOSCAN — o Histórico geral cobre dois fluxos de conferência
// totalmente separados (Outlet via scan/texto/print, e Produtos Normais via
// Nota Fiscal) — mesmo padrão de sub-abas já usado em catalog.ts
// (input-mode-switch/mode-btn). FASE 3 acrescenta uma terceira sub-aba
// ("Pendências") — ainda sem nenhuma rota nova no shell (que só olha o
// PRIMEIRO segmento do hash pra escolher a aba do bottom nav); só
// #/historico/pendencias é lido aqui dentro (ver parseHistoricoHash).
let historyTab: "outlet" | "nfe" | "pendencias" | "indicadores" = "outlet";

const OUTLET_STATUS_LABEL: Record<ConferenceStatus, string> = {
  draft: "Rascunho",
  in_progress: "Em andamento",
  completed: "Concluída",
  cancelled: "Cancelada",
};

function statusLabel(status: Conference["status"]): string {
  return OUTLET_STATUS_LABEL[status];
}

function statusBadge(status: Conference["status"]): string {
  if (status === "completed") return `<span class="status-badge success">${Icon.checkCircle}${statusLabel(status)}</span>`;
  if (status === "cancelled") return `<span class="status-badge error">${Icon.xCircle}${statusLabel(status)}</span>`;
  return `<span class="status-badge warning">${Icon.info}${statusLabel(status)}</span>`;
}

/** Protocolo curto e legível derivado do UUID — não é um campo separado no banco. */
function protocol(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function receiptBadgeClass(status: ReceiptWithCounts["status"]): string {
  if (status === "completed") return "success";
  if (status === "with_divergences") return "warning";
  return "info";
}

// ---------------------------------------------------------------------------
// FASE 2 — Pesquisa e Filtros Operacionais. Estado de filtro/paginação em
// memória do módulo (nunca persistido — nem banco, nem localStorage), SEPARADO
// por aba (item 9 do pedido): trocar de aba nunca apaga os filtros da outra.
// ---------------------------------------------------------------------------
const PAGE_SIZE = 25;

interface HistoryFilterState<S extends string> {
  search: string;
  status: S | "all";
  operatorId: string | "all";
  dateFrom: string; // "" ou "YYYY-MM-DD" (valor cru do <input type="date">)
  dateTo: string;
}

function emptyFilters<S extends string>(): HistoryFilterState<S> {
  return { search: "", status: "all", operatorId: "all", dateFrom: "", dateTo: "" };
}

interface HistoryPageState<T> {
  items: T[];
  total: number;
  offset: number;
  seq: number;
  loadingMore: boolean;
}

function emptyPage<T>(): HistoryPageState<T> {
  return { items: [], total: 0, offset: 0, seq: 0, loadingMore: false };
}

let outletFilters: HistoryFilterState<ConferenceStatus> = emptyFilters();
let nfeFilters: HistoryFilterState<ReceiptStatus> = emptyFilters();
let pendenciasFilters: HistoryFilterState<ReceiptAttentionCategory> = emptyFilters();
let outletPage: HistoryPageState<ConferenceWithOperator> = emptyPage();
let nfePage: HistoryPageState<ReceiptWithCounts> = emptyPage();
let pendenciasPage: HistoryPageState<ReceiptAttentionRow> = emptyPage();

interface PendenciasSummary {
  notStarted: number;
  inProgress: number;
  withDivergences: number;
  unlinked: number;
}
let pendenciasSummary: PendenciasSummary | null = null;
let pendenciasSummaryFailed = false;

// A lista de operadores visíveis (RLS já resolve o alcance — ver
// listVisibleOperators em conferencesApi.ts) é a MESMA pras duas abas
// (perfis, não conferências/NFs) — buscada uma vez por sessão desta tela.
let visibleOperators: VisibleOperator[] | null = null;
async function ensureVisibleOperators(): Promise<VisibleOperator[]> {
  if (visibleOperators) return visibleOperators;
  try {
    visibleOperators = await listVisibleOperators();
  } catch {
    // Filtro/pesquisa por operador simplesmente não aparece — nunca derruba o resto do Histórico por causa disso.
    visibleOperators = [];
  }
  return visibleOperators;
}

function operatorOptionsHtml(operators: VisibleOperator[], selected: string): string {
  return (
    `<option value="all">Todos os operadores</option>` +
    operators.map((o) => `<option value="${o.id}" ${selected === o.id ? "selected" : ""}>${escapeHtml(o.full_name || "—")}</option>`).join("")
  );
}

export async function renderHistory(root: HTMLElement): Promise<void> {
  // FASE 3 — deep link #/historico/pendencias: só FORÇA a aba quando o hash
  // diz isso explicitamente; qualquer outro hash preserva a aba já escolhida
  // nesta sessão (nunca força de volta pra "outlet" à toa).
  const deepLinkTab = parseHistoricoHash(window.location.hash);
  if (deepLinkTab === "pendencias" || deepLinkTab === "indicadores") {
    historyTab = deepLinkTab;
  }

  root.innerHTML = `
    <section class="history-screen">
      <div class="input-mode-switch">
        <button class="mode-btn ${historyTab === "outlet" ? "active" : ""}" data-history-tab="outlet">${Icon.package}Outlet</button>
        <button class="mode-btn ${historyTab === "nfe" ? "active" : ""}" data-history-tab="nfe">${Icon.receipt}Nota Fiscal</button>
        <button class="mode-btn ${historyTab === "pendencias" ? "active" : ""}" data-history-tab="pendencias">${Icon.alertTriangle}Pendências</button>
        <button class="mode-btn ${historyTab === "indicadores" ? "active" : ""}" data-history-tab="indicadores">${Icon.gauge}Indicadores</button>
      </div>
      <div id="historyTabContent"></div>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>("[data-history-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.historyTab as "outlet" | "nfe" | "pendencias" | "indicadores";
      if (next === historyTab) return;
      historyTab = next;
      void renderHistory(root);
    });
  });

  const content = root.querySelector<HTMLElement>("#historyTabContent")!;
  if (historyTab === "nfe") {
    await renderNfeHistoryTab(content);
  } else if (historyTab === "pendencias") {
    await renderPendenciasTab(content);
  } else if (historyTab === "indicadores") {
    await renderOperationalIndicators(content);
  } else {
    await renderOutletHistoryTab(content);
  }
}

// ---------------------------------------------------------------------------
// Outlet
// ---------------------------------------------------------------------------
async function renderOutletHistoryTab(root: HTMLElement): Promise<void> {
  const operators = await ensureVisibleOperators();

  root.innerHTML = `
    <div class="card">
      <h2>Histórico de conferências (Outlet)</h2>
      <div class="filters-inline">
        <div class="search-row search-row-icon">
          ${Icon.search}
          <label for="outletSearch" class="sr-only">Pesquisar</label>
          <input type="text" id="outletSearch" aria-label="Pesquisar por nome, protocolo ou operador" placeholder="Pesquisar por nome, protocolo ou operador…" value="${escapeHtml(outletFilters.search)}" />
        </div>
        <label for="outletStatus" class="sr-only">Status</label>
        <select id="outletStatus" aria-label="Status">
          <option value="all">Todos os status</option>
          ${Object.entries(OUTLET_STATUS_LABEL)
            .map(([value, label]) => `<option value="${value}" ${outletFilters.status === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <label for="outletOperator" class="sr-only">Operador</label>
        <select id="outletOperator" aria-label="Operador">${operatorOptionsHtml(operators, outletFilters.operatorId)}</select>
        <label for="outletDateFrom" class="sr-only">Data inicial</label>
        <input type="date" id="outletDateFrom" aria-label="Data inicial" value="${outletFilters.dateFrom}" />
        <label for="outletDateTo" class="sr-only">Data final</label>
        <input type="date" id="outletDateTo" aria-label="Data final" value="${outletFilters.dateTo}" />
        <button class="btn-secondary" id="outletClearFilters" type="button" ${hasActiveHistoryFilters(outletFilters) ? "" : "disabled"}>${Icon.close}Limpar filtros</button>
      </div>
      <p class="hint-text" id="outletDateError" style="color:var(--status-error);display:none"></p>
      <div id="outletResultsWrap"></div>
    </div>
    <div id="historyDetail"></div>`;

  const searchInput = root.querySelector<HTMLInputElement>("#outletSearch")!;
  const statusSelect = root.querySelector<HTMLSelectElement>("#outletStatus")!;
  const operatorSelect = root.querySelector<HTMLSelectElement>("#outletOperator")!;
  const dateFromInput = root.querySelector<HTMLInputElement>("#outletDateFrom")!;
  const dateToInput = root.querySelector<HTMLInputElement>("#outletDateTo")!;
  const clearBtn = root.querySelector<HTMLButtonElement>("#outletClearFilters")!;
  const dateError = root.querySelector<HTMLElement>("#outletDateError")!;
  const resultsWrap = root.querySelector<HTMLElement>("#outletResultsWrap")!;

  function refreshClearButton(): void {
    clearBtn.disabled = !hasActiveHistoryFilters(outletFilters);
  }

  const runSearch = () => void loadOutletPage(resultsWrap, root, { reset: true });

  // ~300ms — nem a cada tecla (sobrecarrega o banco à toa), nem tão lento que
  // pareça travado; Enter (abaixo) ignora esse atraso de propósito.
  const debouncedSearch = debounce(runSearch, 300);

  searchInput.addEventListener("input", () => {
    outletFilters = { ...outletFilters, search: searchInput.value };
    refreshClearButton();
    debouncedSearch();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  statusSelect.addEventListener("change", () => {
    outletFilters = { ...outletFilters, status: statusSelect.value as ConferenceStatus | "all" };
    refreshClearButton();
    runSearch();
  });
  operatorSelect.addEventListener("change", () => {
    outletFilters = { ...outletFilters, operatorId: operatorSelect.value };
    refreshClearButton();
    runSearch();
  });
  const onDateChange = () => {
    const dateFrom = dateFromInput.value;
    const dateTo = dateToInput.value;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      dateError.textContent = "A data inicial não pode ser depois da data final.";
      dateError.style.display = "block";
      return;
    }
    dateError.style.display = "none";
    outletFilters = { ...outletFilters, dateFrom, dateTo };
    refreshClearButton();
    runSearch();
  };
  dateFromInput.addEventListener("change", onDateChange);
  dateToInput.addEventListener("change", onDateChange);
  clearBtn.addEventListener("click", () => {
    outletFilters = emptyFilters();
    searchInput.value = "";
    statusSelect.value = "all";
    operatorSelect.value = "all";
    dateFromInput.value = "";
    dateToInput.value = "";
    dateError.style.display = "none";
    refreshClearButton();
    runSearch();
  });

  await loadOutletPage(resultsWrap, root, { reset: true, initial: true });
}

async function loadOutletPage(resultsWrap: HTMLElement, root: HTMLElement, opts: { reset: boolean; initial?: boolean }): Promise<void> {
  const filters = outletFilters;
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) return;

  const mySeq = ++outletPage.seq;
  const offset = opts.reset ? 0 : outletPage.offset;

  if (opts.initial) {
    resultsWrap.innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>`;
  } else if (!opts.reset) {
    outletPage = { ...outletPage, loadingMore: true };
    renderOutletResults(resultsWrap, root, filters);
  }

  const { start, end } = parseLocalDateRangeIso(filters.dateFrom || null, filters.dateTo || null);
  const operators = await ensureVisibleOperators();
  const searchOperatorIds = matchOperatorIdsByName(filters.search, operators);

  try {
    const page = await searchConferenceHistory({
      search: filters.search,
      searchOperatorIds,
      status: filters.status,
      operatorId: filters.operatorId,
      dateFrom: start,
      dateTo: end,
      limit: PAGE_SIZE,
      offset,
    });
    // Concorrência: uma resposta de uma pesquisa mais antiga nunca sobrescreve uma mais nova (mesmo padrão de mySeq === renderSeq já usado em shell.ts).
    if (mySeq !== outletPage.seq) return;
    outletPage = {
      items: opts.reset ? page.items : [...outletPage.items, ...page.items],
      total: page.total,
      offset: offset + page.items.length,
      seq: mySeq,
      loadingMore: false,
    };
    renderOutletResults(resultsWrap, root, filters);
  } catch (err) {
    if (mySeq !== outletPage.seq) return;
    renderErrorWithRetry(resultsWrap, "Erro ao carregar histórico: " + describeError(err), () => void loadOutletPage(resultsWrap, root, { reset: true, initial: true }));
  }
}

function renderOutletResults(resultsWrap: HTMLElement, root: HTMLElement, filters: HistoryFilterState<ConferenceStatus>): void {
  const { items, total, loadingMore } = outletPage;
  const hasMore = outletPage.offset < total;

  if (items.length === 0) {
    resultsWrap.innerHTML = hasActiveHistoryFilters(filters)
      ? `<div class="empty-state">${Icon.searchX}<p>Nenhum resultado encontrado para os filtros selecionados.</p><button class="btn-secondary" id="outletEmptyClear">Limpar filtros</button></div>`
      : `<div class="empty-state">${Icon.history}<p>Nenhuma conferência registrada ainda.</p></div>`;
    resultsWrap.querySelector("#outletEmptyClear")?.addEventListener("click", () => root.querySelector<HTMLButtonElement>("#outletClearFilters")?.click());
    return;
  }

  resultsWrap.innerHTML = `
    <p class="hint-text">${total} resultado${total === 1 ? "" : "s"}</p>
    <div class="product-card-list mobile-only">
      ${items
        .map(
          (c) => `
        <div class="product-card">
          <div class="product-card-top">
            <p class="product-card-name">${escapeHtml(c.name || protocol(c.id))}</p>
            ${statusBadge(c.status)}
          </div>
          <div class="product-card-meta">
            <span class="sku-code">#${protocol(c.id)}</span>
            <span>${formatDateTime(c.created_at)}</span>
            <span>${escapeHtml(c.operator_name || "-")}</span>
          </div>
          <div class="product-card-bottom">
            <span class="hint-text" style="margin:0">${c.total_skus} SKU · ${c.total_units} un.</span>
            <button class="btn-secondary" data-id="${c.id}">Ver detalhes</button>
          </div>
        </div>`
        )
        .join("")}
    </div>
    <div class="table-wrap desktop-only">
      <table>
        <thead><tr><th>Protocolo</th><th>Data</th><th>Operador</th><th>Status</th><th>SKUs</th><th>Unidades</th><th></th></tr></thead>
        <tbody>
          ${items
            .map(
              (c) => `
            <tr>
              <td class="sku-code">#${protocol(c.id)}</td>
              <td>${formatDateTime(c.created_at)}</td>
              <td>${escapeHtml(c.operator_name || "-")}</td>
              <td>${statusBadge(c.status)}</td>
              <td>${c.total_skus}</td>
              <td>${c.total_units}</td>
              <td><button class="link-btn" data-id="${c.id}">ver itens</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    ${
      hasMore
        ? `<div class="pagination-row"><button class="btn-secondary" id="outletLoadMore" ${loadingMore ? "disabled" : ""}>${loadingMore ? "Carregando…" : "Carregar mais"}</button></div>`
        : ""
    }`;

  resultsWrap.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Reaproveita a linha JÁ carregada pela listagem (tem operator_name/status/
      // started_at/finished_at/totais oficiais) — nunca uma segunda consulta só
      // pra montar o resumo (ver FASE 4).
      const row = outletPage.items.find((c) => c.id === btn.dataset.id);
      if (row) void showOutletDetail(root, row);
    });
  });
  resultsWrap.querySelector("#outletLoadMore")?.addEventListener("click", () => {
    if (outletPage.loadingMore) return;
    void loadOutletPage(resultsWrap, root, { reset: false });
  });
}

async function showOutletDetail(root: HTMLElement, conference: ConferenceWithOperator): Promise<void> {
  const detailEl = root.querySelector("#historyDetail")!;
  detailEl.innerHTML = `<div class="skeleton skeleton-card"></div>`;
  try {
    const { items } = await getConference(conference.id);
    const unresolvedCount = items.filter((i) => !i.product_variant_id).length;
    detailEl.innerHTML = `
      <div class="card">
        <h3>Resumo da conferência</h3>
        <p class="hint-text"><span class="sku-code">#${protocol(conference.id)}</span> ${statusBadge(conference.status)}</p>
        <div class="product-card-meta">
          <span>Operador: ${escapeHtml(conference.operator_name || "-")}</span>
          <span>Início: ${formatDateTime(conference.started_at)}</span>
          <span>Finalização: ${formatDateTime(conference.finished_at)}</span>
          <span>Duração: ${formatOperationDuration(conference.started_at, conference.finished_at)}</span>
        </div>
        <div class="active-conference-stats" style="flex-wrap:wrap">
          <span class="active-conference-stat">${conference.total_skus}<span>SKUs</span></span>
          <span class="active-conference-stat">${conference.total_units}<span>Unidades</span></span>
          ${unresolvedCount > 0 ? `<span class="active-conference-stat">${unresolvedCount}<span>sem SKU</span></span>` : ""}
        </div>
        ${
          conference.status === "completed"
            ? `<div class="review-actions"><button class="btn-secondary" id="btnOutletDetailExport">${Icon.fileSpreadsheet}Exportar Excel</button></div>`
            : ""
        }
      </div>
      <div class="card">
        <h3>Itens de "${escapeHtml(conference.name || protocol(conference.id))}"</h3>
        <div class="product-card-list mobile-only">
          ${items
            .map(
              (it: ConferenceItemWithVariant) => `
            <div class="product-card">
              <div class="product-card-top"><p class="product-card-name">${escapeHtml(it.produto || it.raw_model || "-")}</p></div>
              <div class="product-card-meta">
                <span class="sku-code">${escapeHtml(it.sku_code || "-")}</span>
                <span>${escapeHtml(it.raw_color || "")}</span>
                <span>Qtd: ${it.quantity}</span>
              </div>
            </div>`
            )
            .join("")}
        </div>
        <div class="table-wrap desktop-only">
          <table>
            <thead><tr><th>Produto</th><th>Modelo (lido)</th><th>Cor</th><th>Qtd</th><th>SKU</th></tr></thead>
            <tbody>
              ${items
                .map(
                  (it: ConferenceItemWithVariant) =>
                    `<tr><td>${escapeHtml(it.produto || "-")}</td><td>${escapeHtml(it.raw_model || "")}</td><td>${escapeHtml(it.raw_color || "")}</td><td>${it.quantity}</td><td class="sku-code">${escapeHtml(
                      it.sku_code || "-"
                    )}</td></tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`;
    detailEl.querySelector("#btnOutletDetailExport")?.addEventListener("click", () => {
      try {
        exportOutletReportToXlsx(conference, items);
      } catch (err) {
        showToast("Erro ao exportar: " + describeError(err), "error");
      }
    });
  } catch (err) {
    detailEl.innerHTML = `<div class="error-box">Erro: ${escapeHtml(describeError(err))}</div>`;
  }
}

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Nota Fiscal (Produtos Normais). Só leitura aqui: excluir
// uma NF continua sendo feito em Conferir → Nota Fiscal → Histórico de Notas
// (mesma tabela, mesma função deleteReceipt — não duplicado).
// ---------------------------------------------------------------------------
async function renderNfeHistoryTab(root: HTMLElement): Promise<void> {
  const operators = await ensureVisibleOperators();

  root.innerHTML = `
    <div class="card">
      <h2>Histórico de conferências (Nota Fiscal)</h2>
      <div class="filters-inline">
        <div class="search-row search-row-icon">
          ${Icon.search}
          <label for="nfeSearch" class="sr-only">Pesquisar</label>
          <input type="text" id="nfeSearch" aria-label="Pesquisar por número da NF, fornecedor, CNPJ ou operador" placeholder="Pesquisar por NF, fornecedor, CNPJ ou operador…" value="${escapeHtml(nfeFilters.search)}" />
        </div>
        <label for="nfeStatus" class="sr-only">Status</label>
        <select id="nfeStatus" aria-label="Status">
          <option value="all">Todos os status</option>
          ${Object.entries(RECEIPT_STATUS_LABEL)
            .map(([value, label]) => `<option value="${value}" ${nfeFilters.status === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
            .join("")}
        </select>
        <label for="nfeOperator" class="sr-only">Operador</label>
        <select id="nfeOperator" aria-label="Operador">${operatorOptionsHtml(operators, nfeFilters.operatorId)}</select>
        <label for="nfeDateFrom" class="sr-only">Data inicial</label>
        <input type="date" id="nfeDateFrom" aria-label="Data inicial" value="${nfeFilters.dateFrom}" />
        <label for="nfeDateTo" class="sr-only">Data final</label>
        <input type="date" id="nfeDateTo" aria-label="Data final" value="${nfeFilters.dateTo}" />
        <button class="btn-secondary" id="nfeClearFilters" type="button" ${hasActiveHistoryFilters(nfeFilters) ? "" : "disabled"}>${Icon.close}Limpar filtros</button>
      </div>
      <p class="hint-text" id="nfeDateError" style="color:var(--status-error);display:none"></p>
      <div id="nfeResultsWrap"></div>
    </div>
    <div id="nfeHistoryDetail"></div>`;

  const searchInput = root.querySelector<HTMLInputElement>("#nfeSearch")!;
  const statusSelect = root.querySelector<HTMLSelectElement>("#nfeStatus")!;
  const operatorSelect = root.querySelector<HTMLSelectElement>("#nfeOperator")!;
  const dateFromInput = root.querySelector<HTMLInputElement>("#nfeDateFrom")!;
  const dateToInput = root.querySelector<HTMLInputElement>("#nfeDateTo")!;
  const clearBtn = root.querySelector<HTMLButtonElement>("#nfeClearFilters")!;
  const dateError = root.querySelector<HTMLElement>("#nfeDateError")!;
  const resultsWrap = root.querySelector<HTMLElement>("#nfeResultsWrap")!;

  function refreshClearButton(): void {
    clearBtn.disabled = !hasActiveHistoryFilters(nfeFilters);
  }

  const runSearch = () => void loadNfePage(resultsWrap, root, { reset: true });
  const debouncedSearch = debounce(runSearch, 300);

  searchInput.addEventListener("input", () => {
    nfeFilters = { ...nfeFilters, search: searchInput.value };
    refreshClearButton();
    debouncedSearch();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  statusSelect.addEventListener("change", () => {
    nfeFilters = { ...nfeFilters, status: statusSelect.value as ReceiptStatus | "all" };
    refreshClearButton();
    runSearch();
  });
  operatorSelect.addEventListener("change", () => {
    nfeFilters = { ...nfeFilters, operatorId: operatorSelect.value };
    refreshClearButton();
    runSearch();
  });
  const onDateChange = () => {
    const dateFrom = dateFromInput.value;
    const dateTo = dateToInput.value;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      dateError.textContent = "A data inicial não pode ser depois da data final.";
      dateError.style.display = "block";
      return;
    }
    dateError.style.display = "none";
    nfeFilters = { ...nfeFilters, dateFrom, dateTo };
    refreshClearButton();
    runSearch();
  };
  dateFromInput.addEventListener("change", onDateChange);
  dateToInput.addEventListener("change", onDateChange);
  clearBtn.addEventListener("click", () => {
    nfeFilters = emptyFilters();
    searchInput.value = "";
    statusSelect.value = "all";
    operatorSelect.value = "all";
    dateFromInput.value = "";
    dateToInput.value = "";
    dateError.style.display = "none";
    refreshClearButton();
    runSearch();
  });

  await loadNfePage(resultsWrap, root, { reset: true, initial: true });
}

async function loadNfePage(resultsWrap: HTMLElement, root: HTMLElement, opts: { reset: boolean; initial?: boolean }): Promise<void> {
  const filters = nfeFilters;
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) return;

  const mySeq = ++nfePage.seq;
  const offset = opts.reset ? 0 : nfePage.offset;

  if (opts.initial) {
    resultsWrap.innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>`;
  } else if (!opts.reset) {
    nfePage = { ...nfePage, loadingMore: true };
    renderNfeResults(resultsWrap, root, filters);
  }

  const { start, end } = parseLocalDateRangeIso(filters.dateFrom || null, filters.dateTo || null);
  const operators = await ensureVisibleOperators();
  const searchOperatorIds = matchOperatorIdsByName(filters.search, operators);

  try {
    const page = await searchReceiptHistory({
      search: filters.search,
      searchOperatorIds,
      status: filters.status,
      operatorId: filters.operatorId,
      dateFrom: start,
      dateTo: end,
      limit: PAGE_SIZE,
      offset,
    });
    if (mySeq !== nfePage.seq) return;
    nfePage = {
      items: opts.reset ? page.items : [...nfePage.items, ...page.items],
      total: page.total,
      offset: offset + page.items.length,
      seq: mySeq,
      loadingMore: false,
    };
    renderNfeResults(resultsWrap, root, filters);
  } catch (err) {
    if (mySeq !== nfePage.seq) return;
    renderErrorWithRetry(resultsWrap, "Erro ao carregar histórico de Notas Fiscais: " + describeError(err), () => void loadNfePage(resultsWrap, root, { reset: true, initial: true }));
  }
}

function renderNfeResults(resultsWrap: HTMLElement, root: HTMLElement, filters: HistoryFilterState<ReceiptStatus>): void {
  const { items, total, loadingMore } = nfePage;
  const hasMore = nfePage.offset < total;

  if (items.length === 0) {
    resultsWrap.innerHTML = hasActiveHistoryFilters(filters)
      ? `<div class="empty-state">${Icon.searchX}<p>Nenhum resultado encontrado para os filtros selecionados.</p><button class="btn-secondary" id="nfeEmptyClear">Limpar filtros</button></div>`
      : `<div class="empty-state">${Icon.receipt}<p>Nenhuma Nota Fiscal importada ainda.</p></div>`;
    resultsWrap.querySelector("#nfeEmptyClear")?.addEventListener("click", () => root.querySelector<HTMLButtonElement>("#nfeClearFilters")?.click());
    return;
  }

  resultsWrap.innerHTML = `
    <p class="hint-text">${total} resultado${total === 1 ? "" : "s"}</p>
    <ul class="recent-list">
      ${items
        .map(
          (r) => `
        <li data-open-nfe="${r.id}" style="cursor:pointer">
          <div>
            <strong>NF ${escapeHtml(r.invoice_number || "-")} — ${escapeHtml(r.supplier_name || "-")}</strong>
            <span class="hint-text" style="margin:0">${formatDateTime(r.created_at)} · ${escapeHtml(r.operator_name || "-")}</span>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="status-badge ${receiptBadgeClass(r.status)}">${escapeHtml(RECEIPT_STATUS_LABEL[r.status])}</span>
            <span class="hint-text" style="margin:0">${r.item_count} item(ns)</span>
            <a class="link-btn" style="padding:2px 4px;width:auto" href="#/conferir/nfe/${r.id}" data-open-receipt-link>Abrir NF</a>
          </div>
        </li>`
        )
        .join("")}
    </ul>
    ${
      hasMore
        ? `<div class="pagination-row"><button class="btn-secondary" id="nfeLoadMore" ${loadingMore ? "disabled" : ""}>${loadingMore ? "Carregando…" : "Carregar mais"}</button></div>`
        : ""
    }`;

  resultsWrap.querySelectorAll<HTMLElement>("[data-open-nfe]").forEach((li) => {
    li.addEventListener("click", () => void showNfeDetail(root, li.dataset.openNfe!));
  });
  // FASE 4 — "Abrir NF" é um link real de propósito (Ctrl/Cmd+click, botão do
  // meio, menu de contexto e copiar endereço funcionam nativamente) — só
  // impede que o clique NORMAL borbulhe pro <li> e dispare TAMBÉM o detalhe
  // inline acima (os dois comportamentos nunca devem acontecer juntos).
  resultsWrap.querySelectorAll<HTMLAnchorElement>("[data-open-receipt-link]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  });
  resultsWrap.querySelector("#nfeLoadMore")?.addEventListener("click", () => {
    if (nfePage.loadingMore) return;
    void loadNfePage(resultsWrap, root, { reset: false });
  });
}

async function showNfeDetail(root: HTMLElement, id: string): Promise<void> {
  const detailEl = root.querySelector<HTMLElement>("#nfeHistoryDetail")!;
  detailEl.innerHTML = `<div class="skeleton skeleton-card"></div>`;
  try {
    const { receipt, items } = await getReceipt(id);
    const finalized = receipt.status === "completed" || receipt.status === "with_divergences";

    // Enquanto a NF não foi finalizada, a comparação NF×Física não pode
    // aparecer aqui (contagem cega — ver nfeConference.ts) — só um resumo de
    // progresso, sem revelar a quantidade esperada da nota.
    if (!finalized) {
      const counted = items.filter((it) => it.physical_quantity !== null).length;
      detailEl.innerHTML = `
        <div class="card">
          <h3>NF ${escapeHtml(receipt.invoice_number || "-")} — ${escapeHtml(receipt.supplier_name || "-")}</h3>
          <p class="hint-text">Status: ${escapeHtml(RECEIPT_STATUS_LABEL[receipt.status])} · ${counted}/${items.length} item(ns) já contado(s).</p>
          <div class="warning-box">${Icon.info} A comparação com a quantidade da nota só aparece depois de finalizada. Abra em <strong>Conferir → Nota Fiscal</strong> para continuar ou finalizar a contagem.</div>
        </div>`;
      return;
    }

    // FASE 4 — reaproveita summarizeReceipt (mesma fórmula do relatório dentro
    // de Conferir → Nota Fiscal, nunca uma segunda regra pro mesmo conceito).
    const summary = summarizeReceipt(items);
    const counted = summary.ok + summary.missing + summary.surplus;

    detailEl.innerHTML = `
      <div class="card">
        <h3>Relatório — NF ${escapeHtml(receipt.invoice_number || "-")}</h3>
        <div class="product-card-meta">
          <span>Fornecedor: ${escapeHtml(receipt.supplier_name || "-")}</span>
          <span>Importada por: ${escapeHtml(receipt.created_by_name || "-")}</span>
          <span>Início: ${formatDateTime(receipt.started_at)}</span>
          <span>Finalização: ${formatDateTime(receipt.finished_at)}</span>
          <span>Finalizada por: ${escapeHtml(receipt.finished_by_name || "-")}</span>
          <span>Duração: ${formatOperationDuration(receipt.started_at, receipt.finished_at)}</span>
        </div>
        <div class="active-conference-stats" style="flex-wrap:wrap">
          <span class="active-conference-stat">${items.length}<span>SKUs da NF</span></span>
          <span class="active-conference-stat">${counted}<span>Conferidos</span></span>
          <span class="active-conference-stat">${summary.ok}<span>OK</span></span>
          <span class="active-conference-stat">${summary.missing}<span>Com falta</span></span>
          <span class="active-conference-stat">${summary.surplus}<span>Com sobra</span></span>
          <span class="active-conference-stat">${summary.pending}<span>Não conferidos</span></span>
        </div>
        <p class="hint-text">
          Unidades NF: ${summary.totalExpectedQuantity} · Unidades físicas: ${summary.totalPhysicalQuantity} · Diferença: <strong>${formatSignedNumber(summary.netDifference)}</strong>
          · Conformidade dos itens conferidos: <strong>${(summary.conformityRate * 100).toFixed(2).replace(".", ",")}%</strong>
        </p>
        <div class="review-actions"><button class="btn-secondary" id="btnNfeDetailExport">${Icon.fileSpreadsheet}Exportar Excel</button></div>
        <div class="product-card-list mobile-only">
          ${items
            .map(
              (it) => `
            <div class="product-card">
              <div class="product-card-top">
                <p class="product-card-name">${escapeHtml(itemTitle(it))}</p>
                ${reportStatusStamp(it.status)}
              </div>
              <div class="product-card-meta">
                <span class="sku-code">${escapeHtml(itemCodeLabel(it))}</span>
                <span>EAN: ${escapeHtml(itemEanLabel(it))}</span>
              </div>
              <div class="product-card-bottom">
                <span class="hint-text" style="margin:0">NF: ${it.expected_quantity} · Física: ${it.physical_quantity ?? "—"} · Dif.: ${it.physical_quantity === null ? "—" : it.physical_quantity - it.expected_quantity}</span>
              </div>
            </div>`
            )
            .join("")}
        </div>
        <div class="table-wrap desktop-only">
          <table>
            <thead><tr><th>Produto</th><th>SKU</th><th>EAN</th><th>Qtd NF</th><th>Qtd Física</th><th>Dif.</th><th>Status</th></tr></thead>
            <tbody>
              ${items
                .map(
                  (it) => `
                <tr>
                  <td>${escapeHtml(itemTitle(it))}</td>
                  <td class="sku-code">${escapeHtml(itemCodeLabel(it))}</td>
                  <td>${escapeHtml(itemEanLabel(it))}</td>
                  <td>${it.expected_quantity}</td>
                  <td>${it.physical_quantity ?? "—"}</td>
                  <td>${it.physical_quantity === null ? "—" : it.physical_quantity - it.expected_quantity}</td>
                  <td>${reportStatusStamp(it.status)}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`;
    detailEl.querySelector("#btnNfeDetailExport")?.addEventListener("click", () => {
      try {
        exportNfeReportToXlsx(receipt, items);
      } catch (err) {
        showToast("Erro ao exportar: " + describeError(err), "error");
      }
    });
  } catch (err) {
    detailEl.innerHTML = `<div class="error-box">Erro: ${escapeHtml(describeError(err))}</div>`;
  }
}

// ---------------------------------------------------------------------------
// FASE 3 — Central de Pendências Operacionais de NF-e. Visão OPERACIONAL só:
// identifica a NF, explica o motivo e leva pro fluxo original (deep link
// #/conferir/nfe/<id> já existente — nunca um segundo fluxo de resolução
// aqui). Reaproveita a infraestrutura da Fase 2 (debounce, ensureVisibleOperators/
// matchOperatorIdsByName, parseLocalDateRangeIso, hasActiveHistoryFilters,
// mesmo padrão de sequência/paginação) — só a fonte dos dados muda (RPC
// search_receipt_attention, ver migration 0058, por causa da combinação
// status-da-NF OU tem-item-sem-vínculo, que os filtros simples do PostgREST
// não resolvem numa única consulta paginada/contada).
// ---------------------------------------------------------------------------
const ATTENTION_CATEGORY_LABEL: Record<ReceiptAttentionCategory, string> = {
  all: "Todos",
  not_started: "Não iniciadas",
  in_progress: "Em andamento",
  with_divergences: "Divergências",
  unlinked: "Sem vínculo",
};

/** Rótulo do MOTIVO mostrado no card — vocabulário operacional do pedido ("Em andamento"), distinto do rótulo de status já usado na aba Nota Fiscal (RECEIPT_STATUS_LABEL, ex.: "Em conferência") — não altera esse rótulo global existente. */
const ATTENTION_STATUS_REASON_LABEL: Record<"not_started" | "in_progress" | "with_divergences", string> = {
  not_started: "Não iniciada",
  in_progress: "Em andamento",
  with_divergences: "Com divergências",
};

function attentionStatusBadge(status: ReceiptAttentionRow["status"]): string {
  const cls = status === "with_divergences" ? "warning" : "info";
  const label = ATTENTION_STATUS_REASON_LABEL[status as "not_started" | "in_progress" | "with_divergences"] ?? status;
  return `<span class="status-badge ${cls}">${escapeHtml(label)}</span>`;
}

function attentionDateLine(row: ReceiptAttentionRow): string {
  if (row.status === "with_divergences") {
    return `Finalizada em ${formatDateTime(row.finished_at)}`;
  }
  return `Importada por ${escapeHtml(row.operator_name || "-")} · ${formatDateTime(row.created_at)}`;
}

function attentionActionLabel(status: ReceiptAttentionRow["status"]): string {
  return status === "with_divergences" ? "Ver NF" : "Continuar NF";
}

async function renderPendenciasTab(root: HTMLElement): Promise<void> {
  const operators = await ensureVisibleOperators();

  root.innerHTML = `
    <div class="card">
      <h2>Pendências operacionais (Nota Fiscal)</h2>
      <div id="pendenciasSummary"></div>
      <div class="filters-inline">
        <div class="search-row search-row-icon">
          ${Icon.search}
          <label for="pendSearch" class="sr-only">Pesquisar</label>
          <input type="text" id="pendSearch" aria-label="Pesquisar por número da NF, fornecedor, CNPJ ou operador" placeholder="Pesquisar por NF, fornecedor, CNPJ ou operador…" value="${escapeHtml(pendenciasFilters.search)}" />
        </div>
        <label for="pendCategory" class="sr-only">Tipo</label>
        <select id="pendCategory" aria-label="Tipo de pendência">
          ${Object.entries(ATTENTION_CATEGORY_LABEL)
            .map(([value, label]) => `<option value="${value}" ${pendenciasFilters.status === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <label for="pendOperator" class="sr-only">Operador</label>
        <select id="pendOperator" aria-label="Operador">${operatorOptionsHtml(operators, pendenciasFilters.operatorId)}</select>
        <label for="pendDateFrom" class="sr-only">Data inicial</label>
        <input type="date" id="pendDateFrom" aria-label="Data inicial" value="${pendenciasFilters.dateFrom}" />
        <label for="pendDateTo" class="sr-only">Data final</label>
        <input type="date" id="pendDateTo" aria-label="Data final" value="${pendenciasFilters.dateTo}" />
        <button class="btn-secondary" id="pendClearFilters" type="button" ${hasActiveHistoryFilters(pendenciasFilters) ? "" : "disabled"}>${Icon.close}Limpar filtros</button>
      </div>
      <p class="hint-text" id="pendDateError" style="color:var(--status-error);display:none"></p>
      <div id="pendResultsWrap"></div>
    </div>`;

  const searchInput = root.querySelector<HTMLInputElement>("#pendSearch")!;
  const categorySelect = root.querySelector<HTMLSelectElement>("#pendCategory")!;
  const operatorSelect = root.querySelector<HTMLSelectElement>("#pendOperator")!;
  const dateFromInput = root.querySelector<HTMLInputElement>("#pendDateFrom")!;
  const dateToInput = root.querySelector<HTMLInputElement>("#pendDateTo")!;
  const clearBtn = root.querySelector<HTMLButtonElement>("#pendClearFilters")!;
  const dateError = root.querySelector<HTMLElement>("#pendDateError")!;
  const resultsWrap = root.querySelector<HTMLElement>("#pendResultsWrap")!;

  function refreshClearButton(): void {
    clearBtn.disabled = !hasActiveHistoryFilters(pendenciasFilters);
  }

  const runSearch = () => void loadPendenciasPage(resultsWrap, root, { reset: true });
  const debouncedSearch = debounce(runSearch, 300);

  searchInput.addEventListener("input", () => {
    pendenciasFilters = { ...pendenciasFilters, search: searchInput.value };
    refreshClearButton();
    debouncedSearch();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  categorySelect.addEventListener("change", () => {
    pendenciasFilters = { ...pendenciasFilters, status: categorySelect.value as ReceiptAttentionCategory };
    refreshClearButton();
    runSearch();
  });
  operatorSelect.addEventListener("change", () => {
    pendenciasFilters = { ...pendenciasFilters, operatorId: operatorSelect.value };
    refreshClearButton();
    runSearch();
  });
  const onDateChange = () => {
    const dateFrom = dateFromInput.value;
    const dateTo = dateToInput.value;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      dateError.textContent = "A data inicial não pode ser depois da data final.";
      dateError.style.display = "block";
      return;
    }
    dateError.style.display = "none";
    pendenciasFilters = { ...pendenciasFilters, dateFrom, dateTo };
    refreshClearButton();
    runSearch();
  };
  dateFromInput.addEventListener("change", onDateChange);
  dateToInput.addEventListener("change", onDateChange);
  clearBtn.addEventListener("click", () => {
    pendenciasFilters = emptyFilters();
    searchInput.value = "";
    categorySelect.value = "all";
    operatorSelect.value = "all";
    dateFromInput.value = "";
    dateToInput.value = "";
    dateError.style.display = "none";
    refreshClearButton();
    runSearch();
  });

  void loadPendenciasSummary(root);
  await loadPendenciasPage(resultsWrap, root, { reset: true, initial: true });
}

/** Indicadores do topo — consulta INDEPENDENTE da lista (item 18 do pedido): se ela falhar, a lista continua funcionando normalmente, só os 4 números somem/mostram erro (nunca zero fingido). */
async function loadPendenciasSummary(root: HTMLElement): Promise<void> {
  const summaryEl = root.querySelector<HTMLElement>("#pendenciasSummary");
  if (!summaryEl) return;
  try {
    // notStarted/awaitingFinalization(in_progress)/withDivergences: MESMA
    // função/consulta usada no bloco "Atenção" da Home (getReceiptAttentionCounts)
    // — nunca duas regras diferentes pro mesmo conceito (item 14 do pedido).
    // unlinked: reaproveita a própria RPC da listagem (categoria "unlinked",
    // limit=1) só pra ler o total exato, sem baixar a lista.
    const [counts, unlinkedPage] = await Promise.all([
      getReceiptAttentionCounts(),
      searchReceiptAttention({ category: "unlinked", limit: 1, offset: 0 }),
    ]);
    pendenciasSummary = {
      notStarted: counts.notStarted,
      inProgress: counts.awaitingFinalization,
      withDivergences: counts.withDivergences,
      unlinked: unlinkedPage.total,
    };
    pendenciasSummaryFailed = false;
  } catch {
    pendenciasSummary = null;
    pendenciasSummaryFailed = true;
  }
  renderPendenciasSummary(summaryEl);
}

function renderPendenciasSummary(summaryEl: HTMLElement): void {
  if (pendenciasSummaryFailed || !pendenciasSummary) {
    summaryEl.innerHTML = `<p class="hint-text" style="color:var(--status-error)">${Icon.alertTriangle} Não foi possível carregar os indicadores agora.</p>`;
    return;
  }
  const tiles: { value: number; label: string }[] = [
    { value: pendenciasSummary.notStarted, label: "Não iniciadas" },
    { value: pendenciasSummary.inProgress, label: "Em andamento" },
    { value: pendenciasSummary.withDivergences, label: "Divergências" },
    { value: pendenciasSummary.unlinked, label: "Sem vínculo" },
  ];
  summaryEl.innerHTML = `
    <div class="admin-stat-grid" style="margin-bottom:14px">
      ${tiles
        .map(
          (t) => `
        <div class="admin-stat-tile">
          <strong>${t.value}</strong>
          <span>${t.label}</span>
        </div>`
        )
        .join("")}
    </div>`;
}

async function loadPendenciasPage(resultsWrap: HTMLElement, root: HTMLElement, opts: { reset: boolean; initial?: boolean }): Promise<void> {
  const filters = pendenciasFilters;
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) return;

  const mySeq = ++pendenciasPage.seq;
  const offset = opts.reset ? 0 : pendenciasPage.offset;

  if (opts.initial) {
    resultsWrap.innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>`;
  } else if (!opts.reset) {
    pendenciasPage = { ...pendenciasPage, loadingMore: true };
    renderPendenciasResults(resultsWrap, root, filters);
  }

  const { start, end } = parseLocalDateRangeIso(filters.dateFrom || null, filters.dateTo || null);
  const operators = await ensureVisibleOperators();
  const searchOperatorIds = matchOperatorIdsByName(filters.search, operators);

  try {
    const page = await searchReceiptAttention({
      search: filters.search,
      searchOperatorIds,
      category: filters.status,
      operatorId: filters.operatorId,
      dateFrom: start,
      dateTo: end,
      limit: PAGE_SIZE,
      offset,
    });
    if (mySeq !== pendenciasPage.seq) return;
    pendenciasPage = {
      items: opts.reset ? page.items : [...pendenciasPage.items, ...page.items],
      total: page.total,
      offset: offset + page.items.length,
      seq: mySeq,
      loadingMore: false,
    };
    renderPendenciasResults(resultsWrap, root, filters);
  } catch (err) {
    if (mySeq !== pendenciasPage.seq) return;
    renderErrorWithRetry(resultsWrap, "Erro ao carregar pendências: " + describeError(err), () => void loadPendenciasPage(resultsWrap, root, { reset: true, initial: true }));
  }
}

function renderPendenciasResults(resultsWrap: HTMLElement, root: HTMLElement, filters: HistoryFilterState<ReceiptAttentionCategory>): void {
  const { items, total, loadingMore } = pendenciasPage;
  const hasMore = pendenciasPage.offset < total;

  if (items.length === 0) {
    resultsWrap.innerHTML = hasActiveHistoryFilters(filters)
      ? `<div class="empty-state">${Icon.searchX}<p>Nenhum resultado encontrado para os filtros selecionados.</p><button class="btn-secondary" id="pendEmptyClear">Limpar filtros</button></div>`
      : `<div class="empty-state">${Icon.checkCircle}<p>Nenhuma pendência operacional no momento.</p></div>`;
    resultsWrap.querySelector("#pendEmptyClear")?.addEventListener("click", () => root.querySelector<HTMLButtonElement>("#pendClearFilters")?.click());
    return;
  }

  resultsWrap.innerHTML = `
    <p class="hint-text">${total} resultado${total === 1 ? "" : "s"}</p>
    <div class="product-card-list">
      ${items
        .map(
          (r) => `
        <div class="product-card">
          <div class="product-card-top">
            <p class="product-card-name">NF ${escapeHtml(r.invoice_number || "-")} — ${escapeHtml(r.supplier_name || "-")}</p>
          </div>
          <div class="product-card-meta" style="flex-wrap:wrap;gap:6px">
            ${attentionStatusBadge(r.status)}
            ${r.unlinked_count > 0 ? `<span class="status-badge warning">${r.unlinked_count} ${r.unlinked_count === 1 ? "item sem vínculo" : "itens sem vínculo"}</span>` : ""}
          </div>
          <div class="product-card-bottom">
            <span class="hint-text" style="margin:0">${attentionDateLine(r)}</span>
            <a class="btn-secondary" href="#/conferir/nfe/${r.id}">${attentionActionLabel(r.status)}</a>
          </div>
        </div>`
        )
        .join("")}
    </div>
    ${
      hasMore
        ? `<div class="pagination-row"><button class="btn-secondary" id="pendLoadMore" ${loadingMore ? "disabled" : ""}>${loadingMore ? "Carregando…" : "Carregar mais"}</button></div>`
        : ""
    }`;

  resultsWrap.querySelector("#pendLoadMore")?.addEventListener("click", () => {
    if (pendenciasPage.loadingMore) return;
    void loadPendenciasPage(resultsWrap, root, { reset: false });
  });
}
