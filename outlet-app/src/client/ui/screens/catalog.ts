import { searchCatalog, type CatalogRow } from "../../catalogApi.ts";
import { importCatalog, importNormalProducts } from "../../importer.ts";
import { createManualProduct, updateProductName, updateVariantFields, deleteVariant, setVariantActive } from "../../catalogManageApi.ts";
import { getAuthState, isManagerOrAdmin } from "../../auth.ts";
import { escapeHtml, debounce, renderErrorWithRetry, describeError } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction } from "../confirmModal.ts";
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

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Gestão direta do catálogo (criar/editar/excluir sem
// planilha). Estado do formulário é separado por sub-aba, igual a page/query.
// ---------------------------------------------------------------------------
type ProductFormMode = "closed" | "create" | "edit";
let outletFormMode: ProductFormMode = "closed";
let outletEditingRow: CatalogRow | null = null;
let outletRows: CatalogRow[] = [];
let normalFormMode: ProductFormMode = "closed";
let normalEditingRow: CatalogRow | null = null;
let normalRows: CatalogRow[] = [];

// CORREÇÃO — cancelamento de buscas antigas: cada chamada de carregamento
// aborta a anterior sozinha (nunca uma resposta lenta e desatualizada
// sobrescreve uma mais recente) — um controller por sub-aba, guardado aqui
// em vez de passado por parâmetro, pra TODO caminho que recarrega a lista
// (busca, paginação, retry, ou recarregar depois de criar/editar/excluir)
// se beneficiar automaticamente, sem precisar lembrar de criar um novo toda vez.
let outletSearchController: AbortController | null = null;
let normalSearchController: AbortController | null = null;

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

// ---------------------------------------------------------------------------
// Formulário de criar/editar produto — compartilhado entre as duas sub-abas.
// "Excluir planilha em massa" continua existindo do lado; isto é só o
// caminho pra um produto avulso (seção final do pedido de correção de EAN).
// ---------------------------------------------------------------------------
function renderProductForm(mode: ProductFormMode, editingRow: CatalogRow | null, showColor: boolean): string {
  if (mode === "closed") return "";
  const isEdit = mode === "edit" && editingRow;
  return `
    <div class="card" id="productFormCard">
      <h2>${isEdit ? "Editar produto" : "Novo produto"}</h2>
      <label for="pfNome">Nome do produto</label>
      <input type="text" id="pfNome" value="${escapeHtml(isEdit ? editingRow!.produto : "")}" />
      <label for="pfSku">SKU</label>
      <input type="text" id="pfSku" value="${escapeHtml(isEdit ? editingRow!.sku_code : "")}" />
      <label for="pfEan">EAN (opcional)</label>
      <input type="text" id="pfEan" value="${escapeHtml(isEdit ? editingRow!.gtin || "" : "")}" placeholder="8, 12, 13 ou 14 dígitos" />
      ${
        showColor
          ? `<label for="pfCor">Cor (opcional)</label><input type="text" id="pfCor" value="${escapeHtml(isEdit ? editingRow!.cor || "" : "")}" />`
          : ""
      }
      <p class="error-box" id="productFormError" hidden></p>
      <div class="review-actions" style="margin-top:10px">
        <button type="button" class="btn-primary" id="btnSaveProductForm">Salvar</button>
        <button type="button" class="btn-secondary" id="btnCancelProductForm">Cancelar</button>
      </div>
    </div>`;
}

function readProductForm(root: HTMLElement): { nome: string; sku: string; ean: string; cor: string } {
  return {
    nome: (root.querySelector<HTMLInputElement>("#pfNome")?.value || "").trim(),
    sku: (root.querySelector<HTMLInputElement>("#pfSku")?.value || "").trim(),
    ean: (root.querySelector<HTMLInputElement>("#pfEan")?.value || "").trim(),
    cor: (root.querySelector<HTMLInputElement>("#pfCor")?.value || "").trim(),
  };
}

async function saveProductForm(
  root: HTMLElement,
  mode: ProductFormMode,
  editingRow: CatalogRow | null,
  productType: "outlet" | "normal",
  onDone: () => Promise<void>
): Promise<void> {
  const { nome, sku, ean, cor } = readProductForm(root);
  const errorBox = root.querySelector<HTMLElement>("#productFormError")!;
  errorBox.hidden = true;

  try {
    if (mode === "create") {
      await createManualProduct({ produto: nome, sku_code: sku, gtin: ean, cor, product_type: productType });
      showToast("Produto criado.", "success");
    } else if (editingRow) {
      const tasks: Promise<void>[] = [];
      if (nome !== editingRow.produto) tasks.push(updateProductName(editingRow.product_id, nome));
      const skuChanged = sku !== editingRow.sku_code;
      const eanChanged = ean !== (editingRow.gtin || "");
      const corChanged = cor !== (editingRow.cor || "");
      if (skuChanged || eanChanged || corChanged) {
        tasks.push(
          updateVariantFields(editingRow.variant_id, {
            sku_code: skuChanged ? sku : undefined,
            gtin: eanChanged ? ean : undefined,
            color: corChanged ? cor : undefined,
          })
        );
      }
      await Promise.all(tasks);
      showToast("Produto atualizado.", "success");
    }
    await onDone();
  } catch (err) {
    errorBox.textContent = describeError(err);
    errorBox.hidden = false;
  }
}

async function handleDeleteProduct(row: CatalogRow, reload: () => Promise<void>): Promise<void> {
  const confirmed = await confirmAction({
    title: "Excluir produto?",
    message: `"${row.produto}" (SKU ${row.sku_code}) será excluído permanentemente. Esta ação não pode ser desfeita.`,
    confirmLabel: "Excluir",
    danger: true,
  });
  if (!confirmed) return;

  try {
    const result = await deleteVariant(row.variant_id);
    if (result.deleted) {
      showToast("Produto excluído.", "success");
      await reload();
      return;
    }
    const deactivate = await confirmAction({
      title: "Não é possível excluir",
      message: `"${row.produto}" tem histórico de conferências ou notas fiscais vinculado — excluir apagaria esse registro. Deseja apenas DESATIVAR? Produtos desativados somem da busca, mas o histórico é preservado.`,
      confirmLabel: "Desativar",
      danger: true,
    });
    if (!deactivate) return;
    await setVariantActive(row.variant_id, false);
    showToast("Produto desativado.", "success");
    await reload();
  } catch (err) {
    showToast("Erro: " + describeError(err), "error");
  }
}

/** Liga os botões de editar/excluir de cada linha renderizada — `rows` é a lista JÁ na tela (mesma referência usada pra montar o HTML), usada só pra localizar o objeto completo a partir do id no data-attribute. */
function wireProductActions(scope: Element, rows: CatalogRow[], onEdit: (row: CatalogRow) => void, onDelete: (row: CatalogRow) => Promise<void>): void {
  scope.querySelectorAll<HTMLButtonElement>("[data-edit-variant]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rows.find((r) => r.variant_id === btn.dataset.editVariant);
      if (row) onEdit(row);
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-delete-variant]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rows.find((r) => r.variant_id === btn.dataset.deleteVariant);
      if (row) void onDelete(row);
    });
  });
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

      ${renderProductForm(outletFormMode, outletEditingRow, true)}

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <h2 style="margin:0">Catálogo de SKUs (Outlet)</h2>
          ${canImport ? `<button type="button" class="btn-secondary" id="btnNewOutletProduct">${Icon.plus}Novo produto</button>` : ""}
        </div>
        <div class="search-row">
          <label for="catalogSearch" class="sr-only">Buscar produto, SKU ou EAN</label>
          <input type="text" id="catalogSearch" placeholder="Buscar por produto, SKU ou EAN…" value="${escapeHtml(query)}" />
        </div>
        <div id="catalogResultsWrap"><p class="hint-text">Carregando…</p></div>
        <div class="pagination">
          <button class="icon-btn" id="btnPrevPage" disabled aria-label="Página anterior">${Icon.chevronLeft}</button>
          <span id="pageInfo" class="hint-text"></span>
          <button class="icon-btn" id="btnNextPage" disabled aria-label="Próxima página">${Icon.chevronRight}</button>
        </div>
      </div>`;

  await loadOutletPage(root, canImport);

  const searchInput = root.querySelector<HTMLInputElement>("#catalogSearch")!;
  const debouncedSearch = debounce((value: string) => {
    query = value;
    page = 0;
    void loadOutletPage(root, canImport);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelector("#btnPrevPage")!.addEventListener("click", () => {
    if (page > 0) {
      page--;
      void loadOutletPage(root, canImport);
    }
  });
  root.querySelector("#btnNextPage")!.addEventListener("click", () => {
    page++;
    void loadOutletPage(root, canImport);
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
        await loadOutletPage(root, canImport);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statusEl.textContent = `Erro na importação: ${message}`;
        showToast("Erro na importação do catálogo.", "error");
      } finally {
        fileInput.value = "";
      }
    });
  }

  if (canImport) {
    root.querySelector("#btnNewOutletProduct")?.addEventListener("click", () => {
      outletFormMode = "create";
      outletEditingRow = null;
      void renderOutletSkusTab(root, canImport).then(() => document.getElementById("productFormCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    });
    wireProductForm(root, outletFormMode, outletEditingRow, "outlet", () => {
      outletFormMode = "closed";
      outletEditingRow = null;
    }, () => renderOutletSkusTab(root, canImport));
  }
}

/** Liga Salvar/Cancelar do formulário de produto (create ou edit) quando ele está aberto. */
function wireProductForm(
  root: HTMLElement,
  mode: ProductFormMode,
  editingRow: CatalogRow | null,
  productType: "outlet" | "normal",
  closeForm: () => void,
  rerender: () => Promise<void>
): void {
  if (mode === "closed") return;
  root.querySelector("#btnCancelProductForm")?.addEventListener("click", () => {
    closeForm();
    void rerender();
  });
  root.querySelector("#btnSaveProductForm")?.addEventListener("click", () => {
    void saveProductForm(root, mode, editingRow, productType, async () => {
      closeForm();
      await rerender();
    });
  });
}

async function loadOutletPage(root: HTMLElement, canImport: boolean): Promise<void> {
  outletSearchController?.abort();
  const controller = new AbortController();
  outletSearchController = controller;

  const wrap = root.querySelector("#catalogResultsWrap")!;
  try {
    const result = await searchCatalog(query, page, PAGE_SIZE, "outlet", controller.signal);
    if (controller.signal.aborted) return;
    outletRows = result.rows;
    renderResults(wrap, result.rows, canImport);
    wireProductActions(
      wrap,
      outletRows,
      (row) => {
        outletFormMode = "edit";
        outletEditingRow = row;
        void renderOutletSkusTab(root, canImport).then(() => document.getElementById("productFormCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      },
      (row) => handleDeleteProduct(row, () => loadOutletPage(root, canImport))
    );
    const pageInfo = root.querySelector("#pageInfo")!;
    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    pageInfo.textContent = `Página ${page + 1} de ${totalPages} (${result.total} SKUs)`;
    (root.querySelector("#btnPrevPage") as HTMLButtonElement).disabled = page === 0;
    (root.querySelector("#btnNextPage") as HTMLButtonElement).disabled = page + 1 >= totalPages;
  } catch (err) {
    if (controller.signal.aborted) return;
    renderErrorWithRetry(wrap, "Erro ao buscar catálogo: " + (err instanceof Error ? err.message : String(err)), () => void loadOutletPage(root, canImport));
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

      ${renderProductForm(normalFormMode, normalEditingRow, false)}

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <h2 style="margin:0">Catálogo de Produtos Normais</h2>
          ${canImport ? `<button type="button" class="btn-secondary" id="btnNewNormalProduct">${Icon.plus}Novo produto</button>` : ""}
        </div>
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

  await loadNormalPage(root, canImport);

  const searchInput = root.querySelector<HTMLInputElement>("#normalSearch")!;
  const debouncedSearch = debounce((value: string) => {
    normalQuery = value;
    normalPage = 0;
    void loadNormalPage(root, canImport);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelector("#btnNormalPrevPage")!.addEventListener("click", () => {
    if (normalPage > 0) {
      normalPage--;
      void loadNormalPage(root, canImport);
    }
  });
  root.querySelector("#btnNormalNextPage")!.addEventListener("click", () => {
    normalPage++;
    void loadNormalPage(root, canImport);
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
        await loadNormalPage(root, canImport);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statusEl.textContent = `Erro na importação: ${message}`;
        showToast("Erro na importação de produtos normais.", "error");
      } finally {
        fileInput.value = "";
      }
    });
  }

  if (canImport) {
    root.querySelector("#btnNewNormalProduct")?.addEventListener("click", () => {
      normalFormMode = "create";
      normalEditingRow = null;
      void renderNormalProductsTab(root, canImport).then(() => document.getElementById("productFormCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    });
    wireProductForm(root, normalFormMode, normalEditingRow, "normal", () => {
      normalFormMode = "closed";
      normalEditingRow = null;
    }, () => renderNormalProductsTab(root, canImport));
  }
}

async function loadNormalPage(root: HTMLElement, canImport: boolean): Promise<void> {
  normalSearchController?.abort();
  const controller = new AbortController();
  normalSearchController = controller;

  const wrap = root.querySelector("#normalResultsWrap")!;
  try {
    const result = await searchCatalog(normalQuery, normalPage, PAGE_SIZE, "normal", controller.signal);
    if (controller.signal.aborted) return;
    normalRows = result.rows;
    renderResults(wrap, result.rows, canImport);
    wireProductActions(
      wrap,
      normalRows,
      (row) => {
        normalFormMode = "edit";
        normalEditingRow = row;
        void renderNormalProductsTab(root, canImport).then(() => document.getElementById("productFormCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      },
      (row) => handleDeleteProduct(row, () => loadNormalPage(root, canImport))
    );
    const pageInfo = root.querySelector("#normalPageInfo")!;
    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    pageInfo.textContent = `Página ${normalPage + 1} de ${totalPages} (${result.total} produtos)`;
    (root.querySelector("#btnNormalPrevPage") as HTMLButtonElement).disabled = normalPage === 0;
    (root.querySelector("#btnNormalNextPage") as HTMLButtonElement).disabled = normalPage + 1 >= totalPages;
  } catch (err) {
    if (controller.signal.aborted) return;
    renderErrorWithRetry(wrap, "Erro ao buscar produtos normais: " + (err instanceof Error ? err.message : String(err)), () => void loadNormalPage(root, canImport));
  }
}

function renderResults(wrap: Element, rows: CatalogRow[], canManage: boolean): void {
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum produto encontrado.</p></div>`;
    return;
  }

  const actions = (r: CatalogRow) =>
    canManage
      ? `<div class="product-card-actions">
          <button type="button" class="icon-btn" data-edit-variant="${r.variant_id}" aria-label="Editar produto">${Icon.pencil}</button>
          <button type="button" class="icon-btn" data-delete-variant="${r.variant_id}" aria-label="Excluir produto">${Icon.trash}</button>
        </div>`
      : "";

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
        ${actions(r)}
      </div>`
    )
    .join("");

  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.produto)}</td><td>${escapeHtml(r.cor || "")}</td><td class="sku-code">${escapeHtml(
          r.sku_code
        )}</td><td class="sku-code">${escapeHtml(r.gtin || "-")}</td>${canManage ? `<td>${actions(r)}</td>` : ""}</tr>`
    )
    .join("");

  wrap.innerHTML = `
    <div class="product-card-list mobile-only">${cards}</div>
    <div class="table-wrap desktop-only">
      <table>
        <thead><tr><th>Produto</th><th>Cor</th><th>SKU</th><th>GTIN/EAN</th>${canManage ? "<th>Ações</th>" : ""}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}
