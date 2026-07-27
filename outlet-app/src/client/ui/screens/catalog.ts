import { searchCatalog, type CatalogRow } from "../../catalogApi.ts";
import { importCatalog, importNormalProducts } from "../../importer.ts";
import { getAuthState, isManagerOrAdmin } from "../../auth.ts";
import { escapeHtml, debounce, renderErrorWithRetry } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { renderCatalogVisualSection } from "./catalogVisual.ts";
import { renderVisualScanSection } from "./visualScan.ts";

declare const XLSX: {
  read(data: ArrayBuffer): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_json(ws: unknown, opts?: Record<string, unknown>): Record<string, unknown>[] };
};

const PAGE_SIZE = 30;
// Estado do sub-catálogo Outlet (comportamento 100% preservado).
let page = 0;
let query = "";
// EXPANSÃO GOSCAN — Produtos Normais: estado próprio e separado, pra trocar
// de sub-aba não perder filtro/página de nenhum dos dois lados (mesmo
// princípio já aplicado ao bug de reset desta sessão).
let normalPage = 0;
let normalQuery = "";
let skuSubTab: "outlet" | "normal" = "outlet";
let catalogTab: "skus" | "visual" | "scan" = "skus";

export async function renderCatalog(root: HTMLElement): Promise<void> {
  // page/query/catalogTab são preservados de propósito entre chamadas — o
  // usuário pode sair da rota "catalogo" (ou só voltar de segundo plano) e
  // reentrar sem perder busca/página/aba. Resetar aqui incondicionalmente
  // era exatamente o "reset" reportado: filtro e paginação voltavam ao
  // padrão mesmo sem nenhuma ação do usuário.
  const { profile } = getAuthState();
  const canImport = isManagerOrAdmin(profile);

  root.innerHTML = `
    <section class="catalog-screen">
      <div class="input-mode-switch">
        <button class="mode-btn ${catalogTab === "skus" ? "active" : ""}" data-catalog-tab="skus">${Icon.package}SKUs</button>
        <button class="mode-btn ${catalogTab === "visual" ? "active" : ""}" data-catalog-tab="visual">${Icon.imagePlus}Catálogo Visual</button>
        ${canImport ? `<button class="mode-btn ${catalogTab === "scan" ? "active" : ""}" data-catalog-tab="scan">${Icon.scan}Modo Scan (prep)</button>` : ""}
      </div>
      <div id="catalogTabContent"></div>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>("[data-catalog-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      catalogTab = btn.dataset.catalogTab as "skus" | "visual" | "scan";
      void renderCatalog(root);
    });
  });

  const content = root.querySelector<HTMLElement>("#catalogTabContent")!;
  if (catalogTab === "visual") {
    void renderCatalogVisualSection(content);
    return;
  }
  if (catalogTab === "scan" && canImport) {
    void renderVisualScanSection(content);
    return;
  }

  // EXPANSÃO GOSCAN — dentro da aba "SKUs", separa Produtos Outlet (o que já
  // existia, comportamento preservado) de Produtos Normais (novo). Sub-abas
  // seguem o mesmo padrão de catalogTab acima — nenhuma rota nova no shell.
  content.innerHTML = `
    <div class="input-mode-switch">
      <button class="mode-btn ${skuSubTab === "outlet" ? "active" : ""}" data-sku-subtab="outlet">${Icon.package}Produtos Outlet</button>
      <button class="mode-btn ${skuSubTab === "normal" ? "active" : ""}" data-sku-subtab="normal">${Icon.receipt}Produtos Normais</button>
    </div>
    <div id="skuSubTabContent"></div>`;

  content.querySelectorAll<HTMLButtonElement>("[data-sku-subtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      skuSubTab = btn.dataset.skuSubtab as "outlet" | "normal";
      void renderCatalog(root);
    });
  });

  const subContent = content.querySelector<HTMLElement>("#skuSubTabContent")!;
  if (skuSubTab === "normal") {
    await renderNormalProductsTab(subContent, canImport);
  } else {
    await renderOutletSkusTab(subContent, canImport);
  }
}

async function renderOutletSkusTab(root: HTMLElement, canImport: boolean): Promise<void> {
  root.innerHTML = `
      ${
        canImport
          ? `<div class="card">
              <h2>Importar catálogo</h2>
              <p class="hint-text">Planilha .xlsx/.csv com colunas Produto, SKU/Código, GTIN/EAN, Cor e/ou Modelo. Produtos ausentes da planilha NÃO são apagados.</p>
              <label class="dropzone small">
                <input type="file" id="catalogFileInput" accept=".xlsx,.xls,.csv" hidden />
                <span class="dz-icon">${Icon.upload}</span>
                <span>Toque para subir a planilha</span>
              </label>
              <div id="catalogImportStatus" role="status" aria-live="polite"></div>
            </div>`
          : ""
      }

      <div class="card">
        <h2>Catálogo de SKUs (Outlet)</h2>
        <div class="search-row">
          <label for="catalogSearch" class="sr-only">Buscar produto ou SKU</label>
          <input type="text" id="catalogSearch" placeholder="Buscar por produto, SKU ou EAN…" value="${escapeHtml(query)}" />
        </div>
        <div id="catalogResultsWrap"><p class="hint-text">Carregando…</p></div>
        <div class="pagination">
          <button class="icon-btn" id="btnPrevPage" disabled aria-label="Página anterior">${Icon.chevronLeft}</button>
          <span id="pageInfo" class="hint-text"></span>
          <button class="icon-btn" id="btnNextPage" disabled aria-label="Próxima página">${Icon.chevronRight}</button>
        </div>
      </div>`;

  await loadOutletPage(root);

  const searchInput = root.querySelector<HTMLInputElement>("#catalogSearch")!;
  const debouncedSearch = debounce((value: string) => {
    query = value;
    page = 0;
    void loadOutletPage(root);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelector("#btnPrevPage")!.addEventListener("click", () => {
    if (page > 0) {
      page--;
      void loadOutletPage(root);
    }
  });
  root.querySelector("#btnNextPage")!.addEventListener("click", () => {
    page++;
    void loadOutletPage(root);
  });

  if (canImport) {
    const fileInput = root.querySelector<HTMLInputElement>("#catalogFileInput")!;
    fileInput.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const statusEl = root.querySelector("#catalogImportStatus")!;
      statusEl.textContent = "Lendo planilha…";
      try {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        statusEl.textContent = "Importando…";
        const summary = await importCatalog(file.name, rows);
        statusEl.textContent = `${summary.inserted_rows} inseridos, ${summary.updated_rows} atualizados, ${summary.rejected_rows} rejeitados (de ${summary.total_rows} linhas).`;
        showToast("Catálogo importado com sucesso.", "success");
        page = 0;
        query = "";
        (root.querySelector("#catalogSearch") as HTMLInputElement).value = "";
        await loadOutletPage(root);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statusEl.textContent = `Erro na importação: ${message}`;
        showToast("Erro na importação do catálogo.", "error");
      } finally {
        fileInput.value = "";
      }
    });
  }
}

async function loadOutletPage(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector("#catalogResultsWrap")!;
  try {
    const result = await searchCatalog(query, page, PAGE_SIZE, "outlet");
    renderResults(wrap, result.rows);
    const pageInfo = root.querySelector("#pageInfo")!;
    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    pageInfo.textContent = `Página ${page + 1} de ${totalPages} (${result.total} SKUs)`;
    (root.querySelector("#btnPrevPage") as HTMLButtonElement).disabled = page === 0;
    (root.querySelector("#btnNextPage") as HTMLButtonElement).disabled = page + 1 >= totalPages;
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao buscar catálogo: " + (err instanceof Error ? err.message : String(err)), () => void loadOutletPage(root));
  }
}

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Produtos Normais: mesmíssimo padrão de import+lista
// acima, só que com product_type='normal' e planilha de 3 colunas
// (Nome/SKU/EAN — sem cor/imagem/treinamento).
// ---------------------------------------------------------------------------
async function renderNormalProductsTab(root: HTMLElement, canImport: boolean): Promise<void> {
  root.innerHTML = `
      ${
        canImport
          ? `<div class="card">
              <h2>Importar Produtos Normais</h2>
              <p class="hint-text">Planilha .xlsx/.csv com colunas Nome, SKU e EAN. Produtos normais não precisam de imagem, treinamento ou reconhecimento visual.</p>
              <label class="dropzone small">
                <input type="file" id="normalFileInput" accept=".xlsx,.xls,.csv" hidden />
                <span class="dz-icon">${Icon.upload}</span>
                <span>Toque para subir a planilha</span>
              </label>
              <div id="normalImportStatus" role="status" aria-live="polite"></div>
            </div>`
          : ""
      }

      <div class="card">
        <h2>Catálogo de Produtos Normais</h2>
        <div class="search-row">
          <label for="normalSearch" class="sr-only">Buscar produto, SKU ou EAN</label>
          <input type="text" id="normalSearch" placeholder="Buscar por produto, SKU ou EAN…" value="${escapeHtml(normalQuery)}" />
        </div>
        <div id="normalResultsWrap"><p class="hint-text">Carregando…</p></div>
        <div class="pagination">
          <button class="icon-btn" id="btnNormalPrevPage" disabled aria-label="Página anterior">${Icon.chevronLeft}</button>
          <span id="normalPageInfo" class="hint-text"></span>
          <button class="icon-btn" id="btnNormalNextPage" disabled aria-label="Próxima página">${Icon.chevronRight}</button>
        </div>
      </div>`;

  await loadNormalPage(root);

  const searchInput = root.querySelector<HTMLInputElement>("#normalSearch")!;
  const debouncedSearch = debounce((value: string) => {
    normalQuery = value;
    normalPage = 0;
    void loadNormalPage(root);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelector("#btnNormalPrevPage")!.addEventListener("click", () => {
    if (normalPage > 0) {
      normalPage--;
      void loadNormalPage(root);
    }
  });
  root.querySelector("#btnNormalNextPage")!.addEventListener("click", () => {
    normalPage++;
    void loadNormalPage(root);
  });

  if (canImport) {
    const fileInput = root.querySelector<HTMLInputElement>("#normalFileInput")!;
    fileInput.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const statusEl = root.querySelector("#normalImportStatus")!;
      statusEl.textContent = "Lendo planilha…";
      try {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        statusEl.textContent = "Importando…";
        const summary = await importNormalProducts(file.name, rows);
        statusEl.textContent = `${summary.inserted_rows} inseridos, ${summary.updated_rows} atualizados, ${summary.rejected_rows} rejeitados (de ${summary.total_rows} linhas).`;
        showToast("Produtos normais importados com sucesso.", "success");
        normalPage = 0;
        normalQuery = "";
        (root.querySelector("#normalSearch") as HTMLInputElement).value = "";
        await loadNormalPage(root);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statusEl.textContent = `Erro na importação: ${message}`;
        showToast("Erro na importação de produtos normais.", "error");
      } finally {
        fileInput.value = "";
      }
    });
  }
}

async function loadNormalPage(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector("#normalResultsWrap")!;
  try {
    const result = await searchCatalog(normalQuery, normalPage, PAGE_SIZE, "normal");
    renderResults(wrap, result.rows);
    const pageInfo = root.querySelector("#normalPageInfo")!;
    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    pageInfo.textContent = `Página ${normalPage + 1} de ${totalPages} (${result.total} produtos)`;
    (root.querySelector("#btnNormalPrevPage") as HTMLButtonElement).disabled = normalPage === 0;
    (root.querySelector("#btnNormalNextPage") as HTMLButtonElement).disabled = normalPage + 1 >= totalPages;
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao buscar produtos normais: " + (err instanceof Error ? err.message : String(err)), () => void loadNormalPage(root));
  }
}

function renderResults(wrap: Element, rows: CatalogRow[]): void {
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum produto encontrado.</p></div>`;
    return;
  }

  const cards = rows
    .map(
      (r) => `
      <div class="product-card">
        <div class="product-card-top">
          <p class="product-card-name">${escapeHtml(r.produto)}</p>
        </div>
        <div class="product-card-meta">
          <span class="sku-code">${escapeHtml(r.sku_code)}</span>
          ${r.gtin ? `<span class="sku-code">EAN ${escapeHtml(r.gtin)}</span>` : ""}
          <span>${escapeHtml(r.cor || "-")}</span>
        </div>
      </div>`
    )
    .join("");

  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.produto)}</td><td>${escapeHtml(r.cor || "")}</td><td class="sku-code">${escapeHtml(
          r.sku_code
        )}</td><td class="sku-code">${escapeHtml(r.gtin || "-")}</td></tr>`
    )
    .join("");

  wrap.innerHTML = `
    <div class="product-card-list mobile-only">${cards}</div>
    <div class="table-wrap desktop-only">
      <table>
        <thead><tr><th>Produto</th><th>Cor</th><th>SKU</th><th>GTIN/EAN</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}
