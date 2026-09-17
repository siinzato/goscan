// FASE 5 — Indicadores Operacionais (Histórico > aba "Indicadores"). Visão
// gerencial/operacional consolidada de OPERAÇÕES FINALIZADAS num período —
// conceito DIFERENTE da Home 2.0 (que mede atividade do dia via eventos, ver
// home.ts/0057): aqui a referência é sempre finished_at (ver migration 0059).
// Módulo isolado por pedido explícito — history.ts só monta a aba/deep link e
// delega todo o conteúdo pra cá.
import { getOperationalIndicators, type OperationalIndicators } from "../../operationalIndicatorsApi.ts";
import { listVisibleOperators, type VisibleOperator } from "../../conferencesApi.ts";
import { escapeHtml, describeError, renderErrorWithRetry, todayLocalRangeIso, lastNDaysLocalRangeIso, parseLocalDateRangeIso, getLocalTimeZone } from "../../utils.ts";
import { exportOperationalIndicatorsToXlsx } from "../../exporter.ts";
import { showToast } from "../toast.ts";
import { Icon } from "../icons.ts";

type Period = "today" | "7d" | "30d" | "custom";

interface IndicatorsState {
  period: Period;
  customFrom: string;
  customTo: string;
  responsibleId: string; // "all" ou um profile id
  data: OperationalIndicators | null;
  loading: boolean;
  error: string | null;
  seq: number;
}

const state: IndicatorsState = {
  period: "7d",
  customFrom: "",
  customTo: "",
  responsibleId: "all",
  data: null,
  loading: false,
  error: null,
  seq: 0,
};

let visibleOperators: VisibleOperator[] | null = null;
async function ensureVisibleOperators(): Promise<VisibleOperator[]> {
  if (visibleOperators) return visibleOperators;
  try {
    visibleOperators = await listVisibleOperators();
  } catch {
    visibleOperators = [];
  }
  return visibleOperators;
}

/** Nunca dispara consulta pra um período personalizado incompleto/inválido. */
function resolveRange(): { start: string; end: string } | null {
  if (state.period === "today") return todayLocalRangeIso();
  if (state.period === "7d") return lastNDaysLocalRangeIso(7);
  if (state.period === "30d") return lastNDaysLocalRangeIso(30);
  if (!state.customFrom || !state.customTo) return null;
  if (state.customFrom > state.customTo) return null;
  const { start, end } = parseLocalDateRangeIso(state.customFrom, state.customTo);
  if (!start || !end) return null;
  return { start, end };
}

const numberFormat = new Intl.NumberFormat("pt-BR");
const percentFormat = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtNum(n: number): string {
  return numberFormat.format(n);
}

function fmtConformity(rate: number | null): string {
  if (rate === null) return "—";
  return `${percentFormat.format(rate * 100)}%`;
}

function fmtDayLabel(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}

/** FASE 6 — usado como rótulo do período tanto na tela (título) quanto na aba "Filtros" do Excel exportado — nunca duas descrições diferentes do mesmo período selecionado. */
function periodLabel(): string {
  if (state.period === "today") return "Hoje";
  if (state.period === "7d") return "Últimos 7 dias";
  if (state.period === "30d") return "Últimos 30 dias";
  if (state.customFrom && state.customTo) return `${state.customFrom} a ${state.customTo}`;
  return "Personalizado";
}

function responsibleLabel(operators: VisibleOperator[]): string {
  if (state.responsibleId === "all") return "Todos";
  return operators.find((o) => o.id === state.responsibleId)?.full_name || "—";
}

export async function renderOperationalIndicators(root: HTMLElement): Promise<void> {
  const operators = await ensureVisibleOperators();

  root.innerHTML = `
    <div class="card indicators-screen">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">Indicadores operacionais</h2>
        <button class="btn-secondary" id="indExport" type="button" disabled>${Icon.fileSpreadsheet}Exportar Excel</button>
      </div>
      <div class="input-mode-switch" role="group" aria-label="Período">
        <button class="mode-btn ${state.period === "today" ? "active" : ""}" data-period="today" aria-pressed="${state.period === "today"}">Hoje</button>
        <button class="mode-btn ${state.period === "7d" ? "active" : ""}" data-period="7d" aria-pressed="${state.period === "7d"}">7 dias</button>
        <button class="mode-btn ${state.period === "30d" ? "active" : ""}" data-period="30d" aria-pressed="${state.period === "30d"}">30 dias</button>
        <button class="mode-btn ${state.period === "custom" ? "active" : ""}" data-period="custom" aria-pressed="${state.period === "custom"}">Personalizado</button>
      </div>
      <div class="filters-inline" style="margin-top:10px">
        ${
          state.period === "custom"
            ? `
          <label for="indFrom" class="sr-only">Data inicial</label>
          <input type="date" id="indFrom" aria-label="Data inicial" value="${escapeHtml(state.customFrom)}" />
          <label for="indTo" class="sr-only">Data final</label>
          <input type="date" id="indTo" aria-label="Data final" value="${escapeHtml(state.customTo)}" />
          <button class="btn-secondary" id="indApply" type="button">Aplicar</button>`
            : ""
        }
        <label for="indResponsible" class="sr-only">Responsável</label>
        <select id="indResponsible" aria-label="Responsável">
          <option value="all" ${state.responsibleId === "all" ? "selected" : ""}>Responsável: Todos</option>
          ${operators.map((o) => `<option value="${o.id}" ${state.responsibleId === o.id ? "selected" : ""}>${escapeHtml(o.full_name || "—")}</option>`).join("")}
        </select>
      </div>
      ${state.period === "custom" ? `<p class="hint-text" id="indDateError" style="color:var(--status-error);display:none"></p>` : ""}
      <div id="indicatorsContent" style="margin-top:14px"></div>
    </div>`;

  root.querySelectorAll<HTMLButtonElement>("[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.period as Period;
      if (next === state.period) return;
      state.period = next;
      void renderOperationalIndicators(root);
    });
  });

  const applyBtn = root.querySelector<HTMLButtonElement>("#indApply");
  applyBtn?.addEventListener("click", () => {
    const from = root.querySelector<HTMLInputElement>("#indFrom")!.value;
    const to = root.querySelector<HTMLInputElement>("#indTo")!.value;
    const errorEl = root.querySelector<HTMLElement>("#indDateError")!;
    if (!from || !to) {
      errorEl.textContent = "Informe a data inicial e a data final.";
      errorEl.style.display = "";
      return;
    }
    if (from > to) {
      errorEl.textContent = "A data inicial não pode ser depois da data final.";
      errorEl.style.display = "";
      return;
    }
    errorEl.style.display = "none";
    state.customFrom = from;
    state.customTo = to;
    void loadAndRenderContent(root);
  });

  root.querySelector<HTMLSelectElement>("#indResponsible")?.addEventListener("change", (e) => {
    state.responsibleId = (e.target as HTMLSelectElement).value;
    void loadAndRenderContent(root);
  });

  const exportBtn = root.querySelector<HTMLButtonElement>("#indExport")!;
  exportBtn.addEventListener("click", () => {
    if (!state.data) return;
    const originalLabel = exportBtn.innerHTML;
    exportBtn.disabled = true;
    exportBtn.innerHTML = `${Icon.loader}Gerando…`;
    try {
      exportOperationalIndicatorsToXlsx(state.data, periodLabel(), responsibleLabel(operators));
      showToast("Exportação concluída.", "success");
    } catch (err) {
      showToast("Erro ao exportar: " + describeError(err), "error");
    } finally {
      exportBtn.disabled = !state.data || state.data.summary.completedOperations === 0;
      exportBtn.innerHTML = originalLabel;
    }
  });

  await loadAndRenderContent(root);
}

async function loadAndRenderContent(root: HTMLElement): Promise<void> {
  const content = root.querySelector<HTMLElement>("#indicatorsContent");
  if (!content) return;
  const exportBtn = root.querySelector<HTMLButtonElement>("#indExport");

  const range = resolveRange();
  if (!range) {
    // Personalizado sem os dois extremos válidos ainda: não dispara request nenhuma.
    content.innerHTML = `<p class="hint-text">Informe um período válido para carregar os indicadores.</p>`;
    if (exportBtn) exportBtn.disabled = true;
    return;
  }

  const mySeq = ++state.seq;
  content.innerHTML = `<p class="hint-text">${Icon.loader} Carregando indicadores…</p>`;
  if (exportBtn) exportBtn.disabled = true;

  try {
    const data = await getOperationalIndicators({
      start: range.start,
      end: range.end,
      timezone: getLocalTimeZone(),
      responsibleId: state.responsibleId === "all" ? null : state.responsibleId,
    });
    if (mySeq !== state.seq) return; // resposta obsoleta (usuário já trocou período/responsável)
    state.data = data;
    state.error = null;
    renderContent(content, data);
    if (exportBtn) exportBtn.disabled = data.summary.completedOperations === 0;
  } catch (err) {
    if (mySeq !== state.seq) return;
    state.error = describeError(err);
    state.data = null;
    renderErrorWithRetry(content, "Não foi possível carregar os indicadores agora.", () => void loadAndRenderContent(root));
  }
}

function statTile(icon: string, value: string, label: string): string {
  return `
    <div class="admin-stat-tile">
      ${icon}
      <strong>${value}</strong>
      <span>${label}</span>
    </div>`;
}

function renderContent(content: HTMLElement, data: OperationalIndicators): void {
  const noData = data.summary.completedOperations === 0;

  const visaoGeral = `
    <h2>Visão geral</h2>
    <div class="admin-stat-grid">
      ${statTile(Icon.listChecks, fmtNum(data.summary.completedOperations), "Operações concluídas")}
      ${statTile(Icon.package, fmtNum(data.summary.outletConferences), "Conferências Outlet")}
      ${statTile(Icon.receipt, fmtNum(data.summary.nfeReceipts), "Conferências NF-e")}
      ${statTile(Icon.alertTriangle, fmtNum(data.summary.nfeWithDivergences), "NF-e com divergências")}
    </div>
    ${noData ? `<p class="hint-text">Nenhuma operação concluída neste período.</p>` : ""}`;

  const outlet = `
    <h2>Outlet</h2>
    <div class="admin-stat-grid">
      ${statTile(Icon.package, fmtNum(data.outlet.conferences), "Conferências")}
      ${statTile(Icon.barcode, fmtNum(data.outlet.skus), "SKUs processados")}
      ${statTile(Icon.box, fmtNum(data.outlet.units), "Unidades conferidas")}
      ${statTile(Icon.gauge, fmtNum(data.outlet.avgSkus), "Média SKUs/conferência")}
      ${statTile(Icon.gauge, fmtNum(data.outlet.avgUnits), "Média unidades/conferência")}
    </div>
    <p class="hint-text">Somatório dos SKUs processados nas operações do período — não é a contagem de SKUs únicos do catálogo.</p>`;

  const nfe = `
    <h2>Nota Fiscal</h2>
    <div class="admin-stat-grid">
      ${statTile(Icon.receipt, fmtNum(data.nfe.receipts), "NFs concluídas")}
      ${statTile(Icon.barcode, fmtNum(data.nfe.countedSkus), "SKUs conferidos")}
      ${statTile(Icon.box, fmtNum(data.nfe.physicalUnits), "Unidades físicas conferidas")}
      ${statTile(Icon.alertTriangle, fmtNum(data.nfe.divergenceReceipts), "NFs com divergências")}
      ${statTile(Icon.checkCircle, fmtConformity(data.nfe.conformityRate), "Conformidade dos itens conferidos")}
    </div>
    <p class="hint-text">Itens com falta: ${fmtNum(data.nfe.missingItems)} · Itens com sobra: ${fmtNum(data.nfe.surplusItems)}</p>`;

  const dailyRows = data.daily
    .map(
      (d) => `
    <div class="product-card">
      <div class="product-card-top">
        <p class="product-card-name">${fmtDayLabel(d.date)}</p>
        ${d.divergenceReceipts > 0 ? `<span class="status-badge warning">${Icon.alertTriangle}${fmtNum(d.divergenceReceipts)}</span>` : ""}
      </div>
      <div class="product-card-meta">
        <span>Outlet ${fmtNum(d.outletConferences)}</span>
        <span>NF-e ${fmtNum(d.nfeReceipts)}</span>
        <span>${fmtNum(d.skus)} SKUs</span>
        <span>${fmtNum(d.units)} un.</span>
      </div>
    </div>`
    )
    .join("");

  const dailyTableRows = data.daily
    .map(
      (d) => `
      <tr>
        <td>${fmtDayLabel(d.date)}</td>
        <td>${fmtNum(d.outletConferences)}</td>
        <td>${fmtNum(d.nfeReceipts)}</td>
        <td>${fmtNum(d.skus)}</td>
        <td>${fmtNum(d.units)}</td>
        <td>${fmtNum(d.divergenceReceipts)}</td>
      </tr>`
    )
    .join("");

  const volumePorDia =
    data.daily.length > 0
      ? `
    <h2>Volume por dia</h2>
    <div class="product-card-list mobile-only">${dailyRows}</div>
    <div class="table-wrap desktop-only">
      <table>
        <thead>
          <tr><th>Data</th><th>Outlet</th><th>NF-e</th><th>SKUs</th><th>Unidades</th><th>Divergências</th></tr>
        </thead>
        <tbody>${dailyTableRows}</tbody>
      </table>
    </div>`
      : "";

  content.innerHTML = `${visaoGeral}${outlet}${nfe}${volumePorDia}`;
}
