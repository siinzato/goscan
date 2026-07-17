import { searchCatalog, type CatalogRow } from "../../catalogApi.ts";
import { importCatalog } from "../../importer.ts";
import { getAuthState, isManagerOrAdmin } from "../../auth.ts";
import { escapeHtml, debounce } from "../../utils.ts";

declare const XLSX: {
  read(data: ArrayBuffer): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_json(ws: unknown, opts?: Record<string, unknown>): Record<string, unknown>[] };
};

const PAGE_SIZE = 30;
let page = 0;
let query = "";

export async function renderCatalog(root: HTMLElement): Promise<void> {
  page = 0;
  query = "";
  const { profile } = getAuthState();
  const canImport = isManagerOrAdmin(profile);

  root.innerHTML = `
    <section class="catalog-screen">
      ${
        canImport
          ? `<div class="card">
              <h2>Importar catálogo</h2>
              <p class="hint-text">Planilha .xlsx/.csv com colunas Produto, SKU/Código, GTIN/EAN, Cor e/ou Modelo. Produtos ausentes da planilha NÃO são apagados.</p>
              <label class="dropzone small">
                <input type="file" id="catalogFileInput" accept=".xlsx,.xls,.csv" hidden />
                <span class="dz-icon">⇧</span>
                <span>Toque para subir a planilha</span>
              </label>
              <div id="catalogImportStatus" role="status" aria-live="polite"></div>
            </div>`
          : ""
      }

      <div class="card">
        <h2>Catálogo de SKUs</h2>
        <div class="search-row">
          <label for="catalogSearch" class="sr-only">Buscar produto ou SKU</label>
          <input type="text" id="catalogSearch" placeholder="Buscar por produto ou SKU…" />
        </div>
        <div class="table-wrap" id="catalogTableWrap"><p class="hint-text">Carregando…</p></div>
        <div class="pagination">
          <button class="btn-secondary" id="btnPrevPage" disabled>‹ Anterior</button>
          <span id="pageInfo" class="hint-text"></span>
          <button class="btn-secondary" id="btnNextPage" disabled>Próxima ›</button>
        </div>
      </div>
    </section>`;

  await loadPage(root);

  const searchInput = root.querySelector<HTMLInputElement>("#catalogSearch")!;
  const debouncedSearch = debounce((value: string) => {
    query = value;
    page = 0;
    void loadPage(root);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelector("#btnPrevPage")!.addEventListener("click", () => {
    if (page > 0) {
      page--;
      void loadPage(root);
    }
  });
  root.querySelector("#btnNextPage")!.addEventListener("click", () => {
    page++;
    void loadPage(root);
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
        statusEl.textContent = `✓ ${summary.inserted_rows} inseridos, ${summary.updated_rows} atualizados, ${summary.rejected_rows} rejeitados (de ${summary.total_rows} linhas).`;
        page = 0;
        query = "";
        (root.querySelector("#catalogSearch") as HTMLInputElement).value = "";
        await loadPage(root);
      } catch (err) {
        statusEl.textContent = `Erro na importação: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        fileInput.value = "";
      }
    });
  }
}

async function loadPage(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector("#catalogTableWrap")!;
  try {
    const result = await searchCatalog(query, page, PAGE_SIZE);
    renderTable(wrap, result.rows);
    const pageInfo = root.querySelector("#pageInfo")!;
    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    pageInfo.textContent = `Página ${page + 1} de ${totalPages} (${result.total} SKUs)`;
    (root.querySelector("#btnPrevPage") as HTMLButtonElement).disabled = page === 0;
    (root.querySelector("#btnNextPage") as HTMLButtonElement).disabled = page + 1 >= totalPages;
  } catch (err) {
    wrap.innerHTML = `<div class="error-box">Erro ao buscar catálogo: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function renderTable(wrap: Element, rows: CatalogRow[]): void {
  if (rows.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum produto encontrado.</p>`;
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Produto</th><th>Cor</th><th>SKU</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr><td>${escapeHtml(r.produto)}</td><td>${escapeHtml(r.cor || "")}</td><td class="sku-code">${escapeHtml(r.sku_code)}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}
