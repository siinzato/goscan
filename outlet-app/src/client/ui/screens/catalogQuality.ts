import { loadCatalogQualityReport, type CatalogQualityReport, type QualityVariant, type DuplicateEanGroup } from "../../catalogQualityApi.ts";
import { escapeHtml, describeError, renderErrorWithRetry } from "../../utils.ts";
import { Icon } from "../icons.ts";

const MAX_ROWS = 100;

function tile(value: number, label: string): string {
  return `<div class="admin-stat-tile"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

function variantRow(v: QualityVariant): string {
  const type = v.product_type === "outlet" ? "Outlet" : "Normal";
  return `<li><div><strong>${escapeHtml(v.sku_code)}</strong><span class="hint-text" style="margin:0">${escapeHtml(v.product_name)} · ${type}${v.ean ? ` · EAN ${escapeHtml(v.ean)}` : ""}</span></div></li>`;
}

function groupRow(g: DuplicateEanGroup): string {
  return `<li><div><strong>EAN ${escapeHtml(g.ean)} · ${g.variants.length} SKUs</strong>${g.variants
    .map((v) => `<span class="hint-text" style="margin:0">${escapeHtml(v.sku_code)} — ${escapeHtml(v.product_name)}</span>`)
    .join("")}</div></li>`;
}

function section<T>(title: string, hint: string, items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, MAX_ROWS);
  const more = items.length > shown.length ? `<p class="hint-text">Mostrando ${shown.length} de ${items.length}.</p>` : "";
  const body =
    items.length === 0
      ? `<p class="hint-text">Nada a corrigir aqui.</p>`
      : `<p class="hint-text">${escapeHtml(hint)}</p><ul class="recent-list">${shown.map(render).join("")}</ul>${more}`;
  return `<details class="card"><summary><strong>${escapeHtml(title)}</strong> <span class="status-badge ${items.length === 0 ? "success" : "warning"}">${items.length}</span></summary>${body}</details>`;
}

function renderReport(report: CatalogQualityReport): string {
  return `
    <div class="card">
      <h2>${Icon.checkCircle}Qualidade do catálogo</h2>
      <p class="hint-text">Só consulta — para corrigir, use a edição de produto na aba SKUs.</p>
      <div class="admin-stat-grid">
        ${tile(report.total, "SKUs ativos analisados")}
        ${tile(report.withoutEan.length, "Sem EAN")}
        ${tile(report.duplicateEans.length, "EAN em produtos diferentes")}
        ${tile(report.outletAsNormal.length, "Outlet cadastrado como Normal")}
      </div>
    </div>
    ${section("EAN repetido em produtos diferentes", "Mesmo EAN em mais de um produto pode vincular o item errado na bipagem e na NF-e.", report.duplicateEans, groupRow)}
    ${section("Outlet cadastrado como Normal", "SKU com OUT- ou nome começando por Outlet, mas com tipo Normal — fica de fora das buscas e vínculos Outlet.", report.outletAsNormal, variantRow)}
    ${section("SKUs sem EAN", "Sem EAN a bipagem não encontra o produto pelo código de barras.", report.withoutEan, variantRow)}`;
}

export async function renderCatalogQualitySection(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="card"><h2>Qualidade do catálogo</h2><p class="hint-text">Analisando o catálogo…</p></div>`;
  try {
    const report = await loadCatalogQualityReport();
    root.innerHTML = renderReport(report);
  } catch (err) {
    renderErrorWithRetry(root, "Não foi possível analisar o catálogo agora: " + describeError(err), () => void renderCatalogQualitySection(root));
  }
}
