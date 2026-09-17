// FASE 6 — Central de Auditoria (Administração > Auditoria). Módulo isolado
// (per pedido explícito — adminPanel.ts só monta esta tela quando
// activeTab === "audit", sem crescer mais). Consulta unificada, admin/
// super_admin apenas — a RPC search_central_audit já rejeita quem não for
// (ver migration 0060); esta tela nunca decide autorização sozinha, só
// reflete o erro se a chamada for negada.
import {
  searchCentralAudit,
  fetchAllCentralAuditEvents,
  CentralAuditExportTooLargeError,
  CENTRAL_AUDIT_MODULE_LABEL,
  CENTRAL_AUDIT_KNOWN_ACTIONS,
  describeCentralAuditAction,
  type CentralAuditEvent,
  type CentralAuditFilters,
  type CentralAuditModuleFilter,
} from "../../centralAuditApi.ts";
import { listVisibleOperators, type VisibleOperator } from "../../conferencesApi.ts";
import { exportCentralAuditToXlsx } from "../../exporter.ts";
import { escapeHtml, formatDateTime, describeError, renderErrorWithRetry, debounce, parseLocalDateRangeIso } from "../../utils.ts";
import { showToast } from "../toast.ts";
import { Icon } from "../icons.ts";

const PAGE_SIZE = 50;

interface AuditState {
  filters: CentralAuditFilters;
  dateFromRaw: string;
  dateToRaw: string;
  offset: number;
  total: number;
  events: CentralAuditEvent[];
  loading: boolean;
  exporting: boolean;
  seq: number;
}

const state: AuditState = {
  filters: { search: "", module: "all", action: "", actorId: "", dateFrom: null, dateTo: null },
  dateFromRaw: "",
  dateToRaw: "",
  offset: 0,
  total: 0,
  events: [],
  loading: false,
  exporting: false,
  seq: 0,
};

let visibleUsers: VisibleOperator[] | null = null;
async function ensureVisibleUsers(): Promise<VisibleOperator[]> {
  if (visibleUsers) return visibleUsers;
  try {
    visibleUsers = await listVisibleOperators();
  } catch {
    visibleUsers = [];
  }
  return visibleUsers;
}

function hasActiveFilters(): boolean {
  return !!(state.filters.search || state.filters.module !== "all" || state.filters.action || state.filters.actorId || state.dateFromRaw || state.dateToRaw);
}

function clearFilters(): void {
  state.filters = { search: "", module: "all", action: "", actorId: "", dateFrom: null, dateTo: null };
  state.dateFromRaw = "";
  state.dateToRaw = "";
  state.offset = 0;
}

export async function renderCentralAudit(content: HTMLElement): Promise<void> {
  const users = await ensureVisibleUsers();

  content.innerHTML = `
    <div class="card">
      <h3>${Icon.history}Auditoria</h3>
      <div class="filters-inline">
        <div class="search-row search-row-icon">
          ${Icon.search}
          <label for="caSearch" class="sr-only">Pesquisar</label>
          <input type="text" id="caSearch" aria-label="Pesquisar" placeholder="Pesquisar por usuário, e-mail, NF, protocolo, SKU, EAN…" value="${escapeHtml(state.filters.search)}" />
        </div>
        <label for="caModule" class="sr-only">Módulo</label>
        <select id="caModule" aria-label="Módulo">
          <option value="all" ${state.filters.module === "all" ? "selected" : ""}>Todos os módulos</option>
          ${(Object.entries(CENTRAL_AUDIT_MODULE_LABEL) as [CentralAuditModuleFilter, string][])
            .map(([value, label]) => `<option value="${value}" ${state.filters.module === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
            .join("")}
        </select>
        <label for="caAction" class="sr-only">Ação</label>
        <select id="caAction" aria-label="Ação">
          <option value="">Todas as ações</option>
          ${CENTRAL_AUDIT_KNOWN_ACTIONS.map((a) => `<option value="${a.value}" ${state.filters.action === a.value ? "selected" : ""}>${escapeHtml(describeCentralAuditAction(a.value))}</option>`).join("")}
        </select>
        <label for="caActor" class="sr-only">Usuário</label>
        <select id="caActor" aria-label="Usuário">
          <option value="">Todos os usuários</option>
          ${users.map((u) => `<option value="${u.id}" ${state.filters.actorId === u.id ? "selected" : ""}>${escapeHtml(u.full_name || "—")}</option>`).join("")}
        </select>
        <label for="caDateFrom" class="sr-only">Data inicial</label>
        <input type="date" id="caDateFrom" aria-label="Data inicial" value="${escapeHtml(state.dateFromRaw)}" />
        <label for="caDateTo" class="sr-only">Data final</label>
        <input type="date" id="caDateTo" aria-label="Data final" value="${escapeHtml(state.dateToRaw)}" />
        <button class="btn-secondary" id="caClearFilters" type="button" ${hasActiveFilters() ? "" : "disabled"}>${Icon.close}Limpar filtros</button>
        <button class="btn-secondary" id="caExport" type="button">${Icon.fileSpreadsheet}Exportar Excel</button>
      </div>
      <p class="hint-text" id="caDateError" style="color:var(--status-error);display:none"></p>
      <div id="caResultsWrap"><div class="skeleton skeleton-card"></div></div>
      <div class="pagination" id="caPagination"></div>
    </div>`;

  const searchInput = content.querySelector<HTMLInputElement>("#caSearch")!;
  const moduleSelect = content.querySelector<HTMLSelectElement>("#caModule")!;
  const actionSelect = content.querySelector<HTMLSelectElement>("#caAction")!;
  const actorSelect = content.querySelector<HTMLSelectElement>("#caActor")!;
  const dateFromInput = content.querySelector<HTMLInputElement>("#caDateFrom")!;
  const dateToInput = content.querySelector<HTMLInputElement>("#caDateTo")!;
  const clearBtn = content.querySelector<HTMLButtonElement>("#caClearFilters")!;
  const dateError = content.querySelector<HTMLElement>("#caDateError")!;

  function refreshClearButton(): void {
    clearBtn.disabled = !hasActiveFilters();
  }

  function applyDateRange(): boolean {
    if (state.dateFromRaw && state.dateToRaw && state.dateFromRaw > state.dateToRaw) {
      dateError.textContent = "A data inicial não pode ser depois da data final.";
      dateError.style.display = "";
      return false;
    }
    dateError.style.display = "none";
    const { start, end } = parseLocalDateRangeIso(state.dateFromRaw || null, state.dateToRaw || null);
    state.filters = { ...state.filters, dateFrom: start, dateTo: end };
    return true;
  }

  const runSearch = () => {
    state.offset = 0;
    void loadPage(content);
  };
  const debouncedSearch = debounce(runSearch, 300);

  searchInput.addEventListener("input", () => {
    state.filters = { ...state.filters, search: searchInput.value };
    refreshClearButton();
    debouncedSearch();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  moduleSelect.addEventListener("change", () => {
    state.filters = { ...state.filters, module: moduleSelect.value as CentralAuditModuleFilter };
    refreshClearButton();
    runSearch();
  });
  actionSelect.addEventListener("change", () => {
    state.filters = { ...state.filters, action: actionSelect.value };
    refreshClearButton();
    runSearch();
  });
  actorSelect.addEventListener("change", () => {
    state.filters = { ...state.filters, actorId: actorSelect.value };
    refreshClearButton();
    runSearch();
  });
  dateFromInput.addEventListener("change", () => {
    state.dateFromRaw = dateFromInput.value;
    refreshClearButton();
    if (applyDateRange()) runSearch();
  });
  dateToInput.addEventListener("change", () => {
    state.dateToRaw = dateToInput.value;
    refreshClearButton();
    if (applyDateRange()) runSearch();
  });
  clearBtn.addEventListener("click", () => {
    clearFilters();
    void renderCentralAudit(content);
  });

  const exportBtn = content.querySelector<HTMLButtonElement>("#caExport")!;
  exportBtn.addEventListener("click", () => void runExport(exportBtn));

  await loadPage(content);
}

async function runExport(btn: HTMLButtonElement): Promise<void> {
  if (state.total === 0 || state.exporting) return;
  state.exporting = true;
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `${Icon.loader}Gerando…`;
  try {
    const events = await fetchAllCentralAuditEvents(state.filters);
    const actor = visibleUsers?.find((u) => u.id === state.filters.actorId);
    const actorLabel = state.filters.actorId ? actor?.full_name || "—" : "Todos";
    exportCentralAuditToXlsx(events, state.filters, actorLabel);
    showToast("Exportação concluída.", "success");
  } catch (err) {
    if (err instanceof CentralAuditExportTooLargeError) {
      showToast(err.message, "error");
    } else {
      showToast("Erro ao exportar: " + describeError(err), "error");
    }
  } finally {
    state.exporting = false;
    btn.disabled = state.total === 0;
    btn.innerHTML = originalLabel;
  }
}

async function loadPage(content: HTMLElement): Promise<void> {
  const wrap = content.querySelector<HTMLElement>("#caResultsWrap")!;
  const mySeq = ++state.seq;
  wrap.innerHTML = `<div class="skeleton skeleton-card"></div>`;

  let page;
  try {
    page = await searchCentralAudit(state.filters, PAGE_SIZE, state.offset);
  } catch (err) {
    if (mySeq !== state.seq) return;
    renderErrorWithRetry(wrap, "Erro ao buscar auditoria: " + describeError(err), () => void loadPage(content));
    return;
  }
  if (mySeq !== state.seq) return; // resposta obsoleta — usuário já trocou filtro/página

  state.events = page.events;
  state.total = page.total;

  const exportBtn = content.querySelector<HTMLButtonElement>("#caExport");
  if (exportBtn) exportBtn.disabled = state.total === 0;

  if (page.events.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum evento encontrado para os filtros selecionados.</p></div>`;
  } else {
    wrap.innerHTML = `<ul class="recent-list">${page.events.map(renderEventRow).join("")}</ul>`;
    wrap.querySelectorAll<HTMLElement>("[data-ca-details]").forEach((el) => {
      el.addEventListener("click", () => {
        const details = el.nextElementSibling as HTMLElement | null;
        if (details) details.hidden = !details.hidden;
      });
    });
  }

  const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  const currentPage = Math.floor(state.offset / PAGE_SIZE) + 1;
  const pag = content.querySelector<HTMLElement>("#caPagination")!;
  pag.innerHTML = `
    <button class="icon-btn" id="caPrevPage" ${state.offset === 0 ? "disabled" : ""} aria-label="Página anterior">${Icon.chevronLeft}</button>
    <span class="hint-text">Página ${currentPage} de ${totalPages} (${state.total} evento${state.total === 1 ? "" : "s"})</span>
    <button class="icon-btn" id="caNextPage" ${currentPage >= totalPages ? "disabled" : ""} aria-label="Próxima página">${Icon.chevronRight}</button>`;
  pag.querySelector("#caPrevPage")!.addEventListener("click", () => {
    if (state.offset > 0) {
      state.offset = Math.max(0, state.offset - PAGE_SIZE);
      void loadPage(content);
    }
  });
  pag.querySelector("#caNextPage")!.addEventListener("click", () => {
    state.offset += PAGE_SIZE;
    void loadPage(content);
  });
}

/** action=manual_set NUNCA aparece como "+delta" (rule 5 do pedido) — é uma definição absoluta, só o resultado importa. Exportada pra teste direto (ver tests/centralAuditLogic.test.mjs). */
export function quantityLine(ev: CentralAuditEvent): string {
  if (ev.deltaQuantity === null && ev.resultingQuantity === null) return "";
  if (ev.action === "manual_set") {
    return `Quantidade definida manualmente → Resultado: ${ev.resultingQuantity ?? "—"}`;
  }
  const sign = ev.deltaQuantity !== null && ev.deltaQuantity >= 0 ? "+" : "";
  return `${ev.deltaQuantity !== null ? sign + ev.deltaQuantity : "—"} → Resultado: ${ev.resultingQuantity ?? "—"}`;
}

function renderEventRow(ev: CentralAuditEvent): string {
  const moduleLabel = CENTRAL_AUDIT_MODULE_LABEL[ev.module] || ev.module;
  const isDenied = ev.action === "admin_action_denied";
  const qtyLine = quantityLine(ev);
  const skuLine = ev.sku || ev.ean ? `${ev.sku ? "SKU " + escapeHtml(ev.sku) : ""}${ev.sku && ev.ean ? " · " : ""}${ev.ean ? "EAN " + escapeHtml(ev.ean) : ""}` : "";

  return `
    <li data-ca-details="${ev.id}" style="cursor:pointer;flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;justify-content:space-between;width:100%;gap:8px">
        <div>
          <strong>${escapeHtml(describeCentralAuditAction(ev.action))}</strong>
          <span class="hint-text" style="margin:0">${escapeHtml(moduleLabel)}${ev.operationLabel ? " · " + escapeHtml(ev.operationLabel) : ""}</span>
          <span class="hint-text" style="margin:0">${escapeHtml(ev.actorName || ev.actorEmail || "-")}</span>
        </div>
        <span class="status-badge ${isDenied ? "error" : "info"}" style="margin:0;white-space:nowrap">${formatDateTime(ev.occurredAt)}</span>
      </div>
      ${skuLine ? `<span class="hint-text" style="margin:0">${skuLine}</span>` : ""}
      ${qtyLine ? `<span class="hint-text" style="margin:0">${escapeHtml(qtyLine)}</span>` : ""}
      ${ev.reversesEventId ? `<span class="status-badge warning" style="margin:0">${Icon.info}Desfazer/Reversão</span>` : ""}
      ${ev.excess ? `<span class="status-badge warning" style="margin:0">${Icon.alertTriangle}Excesso confirmado</span>` : ""}
      <div hidden style="width:100%;background:var(--bg-subtle);border-radius:8px;padding:8px;font-family:monospace;font-size:12px;overflow-x:auto;white-space:pre-wrap">
        id: ${escapeHtml(ev.id)}
source: ${escapeHtml(ev.source)}
action (técnica): ${escapeHtml(ev.action)}
entity_type: ${escapeHtml(ev.entityType || "-")}
entity_id: ${escapeHtml(ev.entityId || "-")}
operation_id: ${escapeHtml(ev.operationId || "-")}
item_id: ${escapeHtml(ev.itemId || "-")}
origin: ${escapeHtml(ev.origin || "-")}
device_id: ${escapeHtml(ev.deviceId || "-")}
volume_id: ${escapeHtml(ev.volumeId || "-")}
reverses_event_id: ${escapeHtml(ev.reversesEventId || "-")}
${ev.metadata ? "metadata: " + escapeHtml(JSON.stringify(ev.metadata, null, 2)) : ""}
      </div>
    </li>`;
}
