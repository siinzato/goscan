// EXPANSÃO GOSCAN — Módulo Devolução: relatórios (filtros + exportação).
// Reaproveita o mesmo padrão de exportação já usado na Conferência por NF —
// Excel/CSV via returnsExport.ts (mesmo global XLSX), PDF via window.print()
// (nenhuma biblioteca nova).
import { Icon } from "../../icons.ts";
import { showToast } from "../../toast.ts";
import { escapeHtml, describeError, renderErrorWithRetry, formatDateTime } from "../../../utils.ts";
import { fetchReportDetailRows, fetchStockSummaryRows, fetchPendingAndOccurrenceRows, type ListReturnsFilters, type Marketplace, type ReturnStatus } from "../../../returnsApi.ts";
import type { InvoiceSituation, ReturnClassification } from "../../../returnsMatching.ts";
import { exportReturnsReportToXlsx, exportReturnsDetailedToCsv } from "../../../returnsExport.ts";
import { MARKETPLACE_LABEL, MARKETPLACE_OPTIONS, INVOICE_SITUATION_LABEL, INVOICE_SITUATION_OPTIONS, RETURN_STATUS_LABEL, CLASSIFICATION_LABEL, CLASSIFICATION_OPTIONS, safeEanDisplay } from "./shared.ts";

interface ReportFiltersState extends ListReturnsFilters {
  classification?: ReturnClassification;
}

let filters: ReportFiltersState = {};

export async function renderReportsView(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="card report-controls">
      <h2>Relatórios</h2>
      <div class="filters-inline">
        <label for="rpFrom" class="sr-only">De</label>
        <input type="date" id="rpFrom" aria-label="Data inicial" value="${filters.fromDate ? filters.fromDate.slice(0, 10) : ""}" />
        <label for="rpTo" class="sr-only">Até</label>
        <input type="date" id="rpTo" aria-label="Data final" value="${filters.toDate ? filters.toDate.slice(0, 10) : ""}" />
        <select id="rpMarketplace" aria-label="Marketplace">
          <option value="">Todos os marketplaces</option>
          ${MARKETPLACE_OPTIONS.map((o) => `<option value="${o.value}" ${filters.marketplace === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
        <select id="rpStatus" aria-label="Status">
          <option value="">Todos os status</option>
          ${Object.entries(RETURN_STATUS_LABEL)
            .map(([value, label]) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <select id="rpInvoiceSituation" aria-label="Situação da nota">
          <option value="">Todas as situações</option>
          ${INVOICE_SITUATION_OPTIONS.map((o) => `<option value="${o.value}" ${filters.invoiceSituation === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
        <select id="rpClassification" aria-label="Classificação">
          <option value="">Todas as classificações</option>
          ${CLASSIFICATION_OPTIONS.map((o) => `<option value="${o.value}" ${filters.classification === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
        <div class="search-row search-row-icon">
          ${Icon.search}
          <input type="text" id="rpPackageOrInvoice" placeholder="Pacote/pedido ou nº da NF…" value="${escapeHtml(filters.packageOrInvoiceQuery || "")}" />
        </div>
        <div class="search-row search-row-icon">
          ${Icon.barcode}
          <input type="text" id="rpSkuOrEan" placeholder="SKU ou EAN…" value="${escapeHtml(filters.skuOrEanQuery || "")}" />
        </div>
      </div>
      <button class="btn-primary btn-block" id="btnGenerateReport">${Icon.search}Gerar prévia</button>
    </div>

    <div id="reportResultWrap"></div>`;

  root.querySelector("#btnGenerateReport")!.addEventListener("click", () => {
    filters = {
      fromDate: (root.querySelector("#rpFrom") as HTMLInputElement).value || undefined,
      toDate: (root.querySelector("#rpTo") as HTMLInputElement).value || undefined,
      marketplace: ((root.querySelector("#rpMarketplace") as HTMLSelectElement).value || undefined) as Marketplace | undefined,
      status: ((root.querySelector("#rpStatus") as HTMLSelectElement).value || undefined) as ReturnStatus | undefined,
      invoiceSituation: ((root.querySelector("#rpInvoiceSituation") as HTMLSelectElement).value || undefined) as InvoiceSituation | undefined,
      classification: ((root.querySelector("#rpClassification") as HTMLSelectElement).value || undefined) as ReturnClassification | undefined,
      packageOrInvoiceQuery: (root.querySelector("#rpPackageOrInvoice") as HTMLInputElement).value || undefined,
      skuOrEanQuery: (root.querySelector("#rpSkuOrEan") as HTMLInputElement).value || undefined,
    };
    void generateAndRenderReport(root);
  });
}

async function generateAndRenderReport(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector<HTMLElement>("#reportResultWrap")!;
  wrap.innerHTML = `<div class="screen-loading">Gerando relatório…</div>`;

  let detailed;
  try {
    detailed = await fetchReportDetailRows(filters);
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao gerar relatório: " + describeError(err), () => void generateAndRenderReport(root));
    return;
  }

  const classificationFiltered = filters.classification ? detailed.filter((r) => r.classification === filters.classification) : detailed;
  const stockSummary = await fetchStockSummaryRows(filters);
  const pending = await fetchPendingAndOccurrenceRows(filters);

  if (classificationFiltered.length === 0) {
    wrap.innerHTML = `<div class="card"><div class="empty-state">${Icon.package}<p>Nenhum registro encontrado para estes filtros.</p></div></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="card report-controls">
      <div class="review-actions">
        <button class="btn-secondary" id="btnExportXlsx">${Icon.fileSpreadsheet}Exportar Excel</button>
        <button class="btn-secondary" id="btnExportCsv">${Icon.fileText}Exportar CSV</button>
        <button class="btn-secondary" id="btnExportPdf">${Icon.download}Exportar PDF</button>
      </div>
    </div>

    <div class="card">
      <h2>Devoluções detalhadas (${classificationFiltered.length})</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Marketplace</th><th>Pacote/Pedido</th><th>Nº NF</th><th>Situação</th><th>SKU</th><th>EAN</th><th>Produto</th><th>Qtd</th><th>Classificação</th><th>Status</th><th>Data</th></tr></thead>
          <tbody>
            ${classificationFiltered
              .map(
                (r) => `
              <tr>
                <td>${escapeHtml(MARKETPLACE_LABEL[r.marketplace])}</td>
                <td>${escapeHtml(r.package_code)}</td>
                <td>${escapeHtml(r.invoice_number || "-")}</td>
                <td>${escapeHtml(INVOICE_SITUATION_LABEL[r.invoice_situation])}</td>
                <td class="sku-code">${escapeHtml(r.sku_code || "-")}</td>
                <td>${escapeHtml(safeEanDisplay(r.ean))}</td>
                <td>${escapeHtml(r.produto || "-")}</td>
                <td>${r.quantity}</td>
                <td>${escapeHtml(CLASSIFICATION_LABEL[r.classification])}</td>
                <td>${escapeHtml(RETURN_STATUS_LABEL[r.status])}</td>
                <td>${formatDateTime(r.created_at)}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>`;

  root.querySelector("#btnExportXlsx")!.addEventListener("click", () => {
    try {
      const fname = exportReturnsReportToXlsx(stockSummary, classificationFiltered, pending);
      showToast(`Planilha exportada: ${fname}`, "success");
    } catch (err) {
      showToast("Erro ao exportar Excel: " + describeError(err), "error");
    }
  });
  root.querySelector("#btnExportCsv")!.addEventListener("click", () => {
    try {
      exportReturnsDetailedToCsv(classificationFiltered);
      showToast("CSV exportado.", "success");
    } catch (err) {
      showToast("Erro ao exportar CSV: " + describeError(err), "error");
    }
  });
  root.querySelector("#btnExportPdf")!.addEventListener("click", () => window.print());
}
