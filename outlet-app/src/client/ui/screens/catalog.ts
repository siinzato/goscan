import { searchCatalog, getCatalogOverviewStats, getPrimaryThumbnailPath, type CatalogRow, type CatalogOverviewStats, type ProductType } from "../../catalogApi.ts";
import { importCatalog, importNormalProducts } from "../../importer.ts";
import { createManualProduct, updateProductName, updateVariantFields, deleteVariant, setVariantActive } from "../../catalogManageApi.ts";
import { getSignedImageUrls } from "../../catalogImagesApi.ts";
import { getAuthState, isManagerOrAdmin } from "../../auth.ts";
import { escapeHtml, debounce, renderErrorWithRetry, describeError } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction } from "../confirmModal.ts";
import { renderCatalogVisualSection } from "./catalogVisual.ts";
import { renderVisualScanSection } from "./visualScan.ts";
import { renderCatalogQualitySection } from "./catalogQuality.ts";

declare const XLSX: {
  read(data: ArrayBuffer): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_json(ws: unknown, opts?: Record<string, unknown>): Record<string, unknown>[] };
};

const PAGE_SIZE = 30;
let catalogTab: "skus" | "visual" | "scan" | "quality" = "skus";

// ---------------------------------------------------------------------------
// EVOLUÇÃO CATÁLOGO — antes, Outlet e Normal eram duas sub-abas com estado
// (busca/página/formulário) e código quase idênticos totalmente separados.
// Unificados aqui numa lista só com filtro de Tipo (Todos/Normais/Outlet),
// reaproveitando a MESMA searchCatalog de sempre (productType já era
// opcional — "Todos" nunca foi uma capacidade nova no backend, só uma opção
// nova na UI). Filtro/busca/paginação continuam batendo 1:1 com o que já
// existia por tipo — só passaram a viver num único estado.
// ---------------------------------------------------------------------------
type ProductTypeFilter = "all" | ProductType;
type EanFilter = "all" | "with" | "without";
type ProductFormMode = "closed" | "create" | "edit";

let prodPage = 0;
let prodQuery = "";
let prodTypeFilter: ProductTypeFilter = "all";
let prodEanFilter: EanFilter = "all";
let prodFiltersOpen = false;
let prodFormMode: ProductFormMode = "closed";
let prodEditingRow: CatalogRow | null = null;
let prodRows: CatalogRow[] = [];
let prodSearchController: AbortController | null = null;

const TYPE_LABEL: Record<ProductType, string> = { normal: "Normal", outlet: "Outlet" };

export async function renderCatalog(root: HTMLElement): Promise<void> {
  // catalogTab/prodQuery/prodPage/prodTypeFilter são preservados de propósito
  // entre chamadas — sair da rota "catalogo" (ou só voltar de segundo plano)
  // e reentrar não deve perder busca/página/filtro sem nenhuma ação do
  // usuário (mesmo princípio já valia antes desta evolução).
  const { profile } = getAuthState();
  const canImport = isManagerOrAdmin(profile);

  root.innerHTML = `
    <section class="catalog-screen">
      <div class="input-mode-switch">
        <button class="mode-btn ${catalogTab === "skus" ? "active" : ""}" data-catalog-tab="skus">${Icon.package}SKUs</button>
        <button class="mode-btn ${catalogTab === "visual" ? "active" : ""}" data-catalog-tab="visual">${Icon.imagePlus}Catálogo Visual</button>
        ${canImport ? `<button class="mode-btn ${catalogTab === "scan" ? "active" : ""}" data-catalog-tab="scan">${Icon.scan}Modo Scan (prep)</button>` : ""}
        ${canImport ? `<button class="mode-btn ${catalogTab === "quality" ? "active" : ""}" data-catalog-tab="quality">${Icon.checkCircle}Qualidade</button>` : ""}
      </div>
      <div id="catalogTabContent"></div>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>("[data-catalog-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      catalogTab = btn.dataset.catalogTab as "skus" | "visual" | "scan" | "quality";
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
  if (catalogTab === "quality" && canImport) {
    void renderCatalogQualitySection(content);
    return;
  }
  await renderProductsTab(content, canImport);
}

// ---------------------------------------------------------------------------
// Visão geral — contagens reais (getCatalogOverviewStats), nunca inventadas.
// ---------------------------------------------------------------------------
function renderOverviewSkeleton(): string {
  return `<div class="card"><h2>Visão geral</h2><div class="admin-stat-grid" id="prodOverviewGrid"><p class="hint-text">Carregando…</p></div></div>`;
}

function overviewTile(icon: string, value: number, label: string): string {
  return `<div class="admin-stat-tile">${icon}<strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

async function loadOverview(root: HTMLElement): Promise<void> {
  const grid = root.querySelector<HTMLElement>("#prodOverviewGrid");
  if (!grid) return;
  try {
    const stats: CatalogOverviewStats = await getCatalogOverviewStats();
    grid.innerHTML = [
      overviewTile(Icon.package, stats.totalSkus, "Total de SKUs"),
      overviewTile(Icon.receipt, stats.normalCount, "Produtos Normais"),
      overviewTile(Icon.package, stats.outletCount, "Produtos Outlet"),
      overviewTile(Icon.barcode, stats.withEan, "Com EAN"),
      overviewTile(Icon.searchX, stats.withoutEan, "Sem EAN"),
    ].join("");
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[GoScan] falha ao carregar visão geral do catálogo:", err);
    }
    grid.innerHTML = `<p class="hint-text">Não foi possível carregar a visão geral agora (${escapeHtml(describeError(err))}).</p>`;
  }
}

async function updateTypeTabCounts(root: HTMLElement): Promise<void> {
  try {
    const stats = await getCatalogOverviewStats();
    const counts: Record<ProductTypeFilter, number> = { all: stats.normalCount + stats.outletCount, normal: stats.normalCount, outlet: stats.outletCount };
    root.querySelectorAll<HTMLButtonElement>("[data-prod-type]").forEach((btn) => {
      const value = btn.dataset.prodType as ProductTypeFilter;
      if (btn.querySelector(".chip-count")) return;
      btn.insertAdjacentHTML("beforeend", ` <span class="chip-count">${counts[value]}</span>`);
    });
  } catch {
    // Sem contagem nas abas não impede o uso — a lista de produtos (loadProductsPage) já mostra o total real na paginação.
  }
}

// ---------------------------------------------------------------------------
// Formulário de criar/editar produto — único, compartilhado por Todos os
// tipos. Ao CRIAR, o operador escolhe o Tipo (Normal/Outlet) explicitamente;
// ao EDITAR, o Tipo é só exibido (mudar o tipo de um produto já cadastrado
// não é uma operação suportada pelas funções existentes — fora de escopo
// desta evolução, que só reorganiza a apresentação).
// ---------------------------------------------------------------------------
function renderProductForm(mode: ProductFormMode, editingRow: CatalogRow | null): string {
  if (mode === "closed") return "";
  const isEdit = mode === "edit" && editingRow;
  const defaultType: ProductType = prodTypeFilter === "all" ? "outlet" : prodTypeFilter;
  return `
    <div class="card" id="productFormCard">
      <h2>${isEdit ? "Editar produto" : "Novo produto"}</h2>
      ${
        isEdit
          ? `<div id="pfThumbWrap" class="product-detail-thumb"></div>
             <p class="hint-text">Tipo: <strong>${TYPE_LABEL[editingRow!.product_type]}</strong></p>`
          : `<label for="pfTipo">Tipo</label>
             <select id="pfTipo">
               <option value="outlet" ${defaultType === "outlet" ? "selected" : ""}>Outlet</option>
               <option value="normal" ${defaultType === "normal" ? "selected" : ""}>Normal</option>
             </select>`
      }
      <label for="pfNome">Nome do produto</label>
      <input type="text" id="pfNome" value="${escapeHtml(isEdit ? editingRow!.produto : "")}" />
      <label for="pfSku">SKU</label>
      <input type="text" id="pfSku" value="${escapeHtml(isEdit ? editingRow!.sku_code : "")}" />
      <label for="pfEan">EAN (opcional)</label>
      <input type="text" id="pfEan" value="${escapeHtml(isEdit ? editingRow!.gtin || "" : "")}" placeholder="8, 12, 13 ou 14 dígitos" />
      <label for="pfCor">Cor (opcional)</label>
      <input type="text" id="pfCor" value="${escapeHtml(isEdit ? editingRow!.cor || "" : "")}" />
      <p class="error-box" id="productFormError" hidden></p>
      <div class="review-actions" style="margin-top:10px">
        <button type="button" class="btn-primary" id="btnSaveProductForm">Salvar</button>
        <button type="button" class="btn-secondary" id="btnCancelProductForm">Cancelar</button>
      </div>
    </div>`;
}

/**
 * Miniatura no formulário de edição, quando o produto já tiver imagem
 * (product-images) — mesma fonte usada no Catálogo Visual, nunca uma segunda
 * consulta de imagem. A lista de produtos agora busca sem thumbnail
 * (PERFORMANCE — ver loadProductsPage), então row.thumbnail_path nunca vem
 * preenchido daqui; busca avulsa (1 variante) só na hora de editar.
 */
async function hydrateProductFormThumb(root: HTMLElement, row: CatalogRow): Promise<void> {
  const wrap = root.querySelector<HTMLElement>("#pfThumbWrap");
  if (!wrap) return;
  try {
    const thumbnailPath = row.thumbnail_path ?? (await getPrimaryThumbnailPath(row.variant_id));
    if (!thumbnailPath) {
      wrap.innerHTML = "";
      return;
    }
    const urls = await getSignedImageUrls([thumbnailPath]);
    const url = urls.get(thumbnailPath);
    wrap.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="" class="thumb-img-lg" />` : "";
  } catch {
    wrap.innerHTML = "";
  }
}

function readProductForm(root: HTMLElement): { nome: string; sku: string; ean: string; cor: string; tipo: ProductType | null } {
  const tipoInput = root.querySelector<HTMLSelectElement>("#pfTipo");
  return {
    nome: (root.querySelector<HTMLInputElement>("#pfNome")?.value || "").trim(),
    sku: (root.querySelector<HTMLInputElement>("#pfSku")?.value || "").trim(),
    ean: (root.querySelector<HTMLInputElement>("#pfEan")?.value || "").trim(),
    cor: (root.querySelector<HTMLInputElement>("#pfCor")?.value || "").trim(),
    tipo: tipoInput ? (tipoInput.value as ProductType) : null,
  };
}

async function saveProductForm(root: HTMLElement, mode: ProductFormMode, editingRow: CatalogRow | null, onDone: () => Promise<void>): Promise<void> {
  const { nome, sku, ean, cor, tipo } = readProductForm(root);
  const errorBox = root.querySelector<HTMLElement>("#productFormError")!;
  errorBox.hidden = true;

  try {
    if (mode === "create") {
      await createManualProduct({ produto: nome, sku_code: sku, gtin: ean, cor, product_type: tipo ?? "outlet" });
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

function wireProductForm(root: HTMLElement, mode: ProductFormMode, editingRow: CatalogRow | null, closeForm: () => void, rerender: () => Promise<void>): void {
  if (mode === "closed") return;
  if (mode === "edit" && editingRow) void hydrateProductFormThumb(root, editingRow);
  root.querySelector("#btnCancelProductForm")?.addEventListener("click", () => {
    closeForm();
    void rerender();
  });
  root.querySelector("#btnSaveProductForm")?.addEventListener("click", () => {
    void saveProductForm(root, mode, editingRow, async () => {
      closeForm();
      await rerender();
    });
  });
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

// ---------------------------------------------------------------------------
// Importação — mesma lógica/regra de sempre (importCatalog/importNormalProducts,
// intocadas). Só a experiência visual ganhou uma etapa de "Conferir" antes de
// efetivamente importar: a planilha é lida localmente (como já era) e as
// primeiras linhas são mostradas num resumo, com Cancelar/Confirmar — nunca
// importa nada sem essa confirmação explícita.
// ---------------------------------------------------------------------------
interface PendingImport {
  fileName: string;
  rows: Record<string, unknown>[];
}
let pendingImport: PendingImport | null = null;

function importPreviewHtml(pending: PendingImport): string {
  const cols = Array.from(new Set(pending.rows.slice(0, 5).flatMap((r) => Object.keys(r))));
  const previewRows = pending.rows.slice(0, 5);
  return `
    <div class="card">
      <h2>Conferir importação</h2>
      <p class="hint-text">${pending.fileName} · ${pending.rows.length} linha(s) encontrada(s). Mostrando as ${Math.min(5, pending.rows.length)} primeiras.</p>
      <div class="table-wrap">
        <table>
          <thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
          <tbody>${previewRows.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>
      <div class="review-actions" style="margin-top:10px">
        <button type="button" class="btn-primary" id="btnConfirmImport">Importar</button>
        <button type="button" class="btn-secondary" id="btnCancelImport">Cancelar</button>
      </div>
      <div id="catalogImportStatus" role="status" aria-live="polite"></div>
    </div>`;
}

function wireImportFlow(root: HTMLElement, type: ProductType, onImported: () => Promise<void>): void {
  const fileInput = root.querySelector<HTMLInputElement>("#catalogFileInput");
  const previewWrap = root.querySelector<HTMLElement>("#importPreviewWrap");
  if (!fileInput || !previewWrap) return;

  const renderPreview = (): void => {
    if (!pendingImport) {
      previewWrap.innerHTML = "";
      return;
    }
    previewWrap.innerHTML = importPreviewHtml(pendingImport);
    previewWrap.querySelector("#btnCancelImport")!.addEventListener("click", () => {
      pendingImport = null;
      renderPreview();
    });
    previewWrap.querySelector("#btnConfirmImport")!.addEventListener("click", async () => {
      const pending = pendingImport!;
      const statusEl = previewWrap.querySelector("#catalogImportStatus")!;
      statusEl.textContent = "Importando…";
      try {
        const summary = type === "outlet" ? await importCatalog(pending.fileName, pending.rows) : await importNormalProducts(pending.fileName, pending.rows);
        statusEl.textContent = `${summary.inserted_rows} inseridos, ${summary.updated_rows} atualizados, ${summary.rejected_rows} rejeitados (de ${summary.total_rows} linhas).`;
        showToast("Catálogo importado com sucesso.", "success");
        pendingImport = null;
        await onImported();
      } catch (err) {
        statusEl.textContent = `Erro na importação: ${describeError(err)}`;
        showToast("Erro na importação do catálogo.", "error");
      }
    });
  };

  fileInput.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      pendingImport = { fileName: file.name, rows };
      renderPreview();
    } catch (err) {
      showToast("Erro ao ler planilha: " + describeError(err), "error");
    } finally {
      fileInput.value = "";
    }
  });
}

// ---------------------------------------------------------------------------
// Lista de produtos (SKUs) — Todos/Normais/Outlet, busca, filtro de EAN.
// ---------------------------------------------------------------------------
async function renderProductsTab(root: HTMLElement, canImport: boolean): Promise<void> {
  // PERFORMANCE — causa raiz real do "Catálogo trava até terminar de
  // carregar": o HTML já desenhava tudo de imediato, mas os listeners (abas,
  // busca, paginação, filtros, formulário) só eram conectados DEPOIS de um
  // `await loadProductsPage(...)` — se a rede/banco demorasse ou desse
  // timeout, a tela aparecia mas ficava inteiramente inerte até essa resposta
  // chegar (exatamente o sintoma relatado: "aparece, mas fica inutilizável").
  // Corrigido abaixo: loadProductsPage() roda em paralelo (void), nunca
  // bloqueia a conexão dos eventos — a lista de produtos preenche assim que
  // chegar, mas o resto da tela já responde na hora.
  const typeTabs: { value: ProductTypeFilter; label: string; count: number | null }[] = [
    { value: "all", label: "Todos", count: null },
    { value: "normal", label: "Normais", count: null },
    { value: "outlet", label: "Outlet", count: null },
  ];

  const importType: ProductType | null = prodTypeFilter === "all" ? null : prodTypeFilter;

  root.innerHTML = `
    ${renderOverviewSkeleton()}

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0">Produtos</h2>
        ${canImport ? `<button type="button" class="btn-primary" id="btnNewProduct">${Icon.plus}Novo produto</button>` : ""}
      </div>

      <div class="input-mode-switch" style="margin-top:10px">
        ${typeTabs
          .map(
            (t) =>
              `<button class="mode-btn ${prodTypeFilter === t.value ? "active" : ""}" data-prod-type="${t.value}">${escapeHtml(t.label)}${
                t.count !== null ? ` <span class="chip-count">${t.count}</span>` : ""
              }</button>`
          )
          .join("")}
      </div>

      <div class="filters-inline" style="margin-top:10px">
        <div class="search-row search-row-icon">
          ${Icon.search}
          <label for="prodSearch" class="sr-only">Buscar produto, SKU ou EAN</label>
          <input type="text" id="prodSearch" placeholder="Buscar por produto, SKU ou EAN…" value="${escapeHtml(prodQuery)}" />
          <span class="icon-spin" id="prodSearchSpinner" hidden>${Icon.loader}</span>
        </div>
        <button type="button" class="btn-secondary" id="btnToggleFilters" aria-expanded="${prodFiltersOpen}">${Icon.settings}Filtros</button>
      </div>

      ${
        prodFiltersOpen
          ? `<div class="filters-inline" id="prodFiltersPanel">
              <label for="prodEanFilter" class="sr-only">EAN</label>
              <select id="prodEanFilter">
                <option value="all" ${prodEanFilter === "all" ? "selected" : ""}>EAN: Todos</option>
                <option value="with" ${prodEanFilter === "with" ? "selected" : ""}>Com EAN</option>
                <option value="without" ${prodEanFilter === "without" ? "selected" : ""}>Sem EAN</option>
              </select>
            </div>`
          : ""
      }
    </div>

    ${
      canImport && importType
        ? `<div class="card">
            <h2>Importar ${TYPE_LABEL[importType]}</h2>
            <p class="hint-text">${
              importType === "outlet"
                ? "Planilha .xlsx/.csv com colunas Produto, SKU/Código, GTIN/EAN, Cor e/ou Modelo. Produtos ausentes da planilha NÃO são apagados."
                : "Planilha .xlsx/.csv com colunas Nome, SKU e EAN. Produtos normais não precisam de imagem, treinamento ou reconhecimento visual."
            }</p>
            <label class="dropzone small">
              <input type="file" id="catalogFileInput" accept=".xlsx,.xls,.csv" hidden />
              <span class="dz-icon">${Icon.upload}</span>
              <span>Toque para subir a planilha</span>
            </label>
            <div id="importPreviewWrap"></div>
          </div>`
        : ""
    }

    ${renderProductForm(prodFormMode, prodEditingRow)}

    <div class="card">
      <h2 style="margin:0 0 10px">Catálogo de SKUs</h2>
      <div id="catalogResultsWrap"><p class="hint-text">Carregando…</p></div>
      <div class="pagination">
        <button class="icon-btn" id="btnPrevPage" disabled aria-label="Página anterior">${Icon.chevronLeft}</button>
        <span id="pageInfo" class="hint-text"></span>
        <button class="icon-btn" id="btnNextPage" disabled aria-label="Próxima página">${Icon.chevronRight}</button>
      </div>
    </div>`;

  void loadOverview(root);
  void updateTypeTabCounts(root);
  void loadProductsPage(root, canImport);

  root.querySelectorAll<HTMLButtonElement>("[data-prod-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.prodType as ProductTypeFilter;
      if (next === prodTypeFilter) return;
      prodTypeFilter = next;
      prodPage = 0;
      pendingImport = null;
      void renderProductsTab(root, canImport);
    });
  });

  const searchInput = root.querySelector<HTMLInputElement>("#prodSearch")!;
  const debouncedSearch = debounce((value: string) => {
    prodQuery = value;
    prodPage = 0;
    void loadProductsPage(root, canImport);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelector("#btnToggleFilters")!.addEventListener("click", () => {
    prodFiltersOpen = !prodFiltersOpen;
    void renderProductsTab(root, canImport);
  });
  root.querySelector("#prodEanFilter")?.addEventListener("change", (e) => {
    prodEanFilter = (e.target as HTMLSelectElement).value as EanFilter;
    prodPage = 0;
    void loadProductsPage(root, canImport);
  });

  root.querySelector("#btnPrevPage")!.addEventListener("click", () => {
    if (prodPage > 0) {
      prodPage--;
      void loadProductsPage(root, canImport);
    }
  });
  root.querySelector("#btnNextPage")!.addEventListener("click", () => {
    prodPage++;
    void loadProductsPage(root, canImport);
  });

  if (canImport && importType) {
    wireImportFlow(root, importType, async () => {
      prodPage = 0;
      prodQuery = "";
      await renderProductsTab(root, canImport);
    });
  }

  if (canImport) {
    root.querySelector("#btnNewProduct")?.addEventListener("click", () => {
      prodFormMode = "create";
      prodEditingRow = null;
      void renderProductsTab(root, canImport).then(() => document.getElementById("productFormCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    });
    wireProductForm(
      root,
      prodFormMode,
      prodEditingRow,
      () => {
        prodFormMode = "closed";
        prodEditingRow = null;
      },
      () => renderProductsTab(root, canImport)
    );
  }
}

async function loadProductsPage(root: HTMLElement, canImport: boolean): Promise<void> {
  prodSearchController?.abort();
  const controller = new AbortController();
  prodSearchController = controller;

  const wrap = root.querySelector("#catalogResultsWrap")!;
  const spinner = root.querySelector<HTMLElement>("#prodSearchSpinner");
  // LOADING VISUAL — só mostra o spinner se a busca realmente demorar mais
  // que um instante (threshold de 200ms) — nunca pisca em respostas rápidas
  // (ex.: vindas do cache de searchCatalog). A lista anterior continua
  // visível embaixo enquanto isso (só troca quando o resultado novo chega).
  const spinnerTimer = setTimeout(() => {
    if (!controller.signal.aborted && spinner) spinner.hidden = false;
  }, 200);

  try {
    const typeArg = prodTypeFilter === "all" ? undefined : prodTypeFilter;
    const eanArg = prodEanFilter === "all" ? undefined : prodEanFilter;
    // PERFORMANCE — renderResults() (abaixo) nunca exibe miniatura (só
    // Produto/SKU/EAN/Cor/Tipo/ações) — includeThumbnails=false pula a
    // consulta extra a product_images que essa tela nunca aproveitava.
    // Outros consumidores de searchCatalog (Catálogo Visual) continuam
    // pedindo imagem normalmente — este argumento é só desta chamada.
    const result = await searchCatalog(prodQuery, prodPage, PAGE_SIZE, typeArg, controller.signal, false, eanArg);
    if (controller.signal.aborted) return;
    prodRows = result.rows;
    renderResults(wrap, result.rows, canImport);
    wireProductActions(
      wrap,
      prodRows,
      (row) => {
        prodFormMode = "edit";
        prodEditingRow = row;
        void renderProductsTab(root, canImport).then(() => document.getElementById("productFormCard")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      },
      (row) => handleDeleteProduct(row, () => loadProductsPage(root, canImport))
    );
    const pageInfo = root.querySelector("#pageInfo")!;
    const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
    pageInfo.textContent = `Página ${prodPage + 1} de ${totalPages} (${result.total} SKUs)`;
    (root.querySelector("#btnPrevPage") as HTMLButtonElement).disabled = prodPage === 0;
    (root.querySelector("#btnNextPage") as HTMLButtonElement).disabled = prodPage + 1 >= totalPages;
  } catch (err) {
    if (controller.signal.aborted) return;
    renderErrorWithRetry(wrap, "Erro ao buscar catálogo: " + describeError(err), () => void loadProductsPage(root, canImport));
  } finally {
    clearTimeout(spinnerTimer);
    // Só esta chamada apaga o spinner se ela não foi cancelada — uma busca
    // cancelada (superada por uma mais nova) nunca mexe no spinner da busca
    // que a substituiu.
    if (!controller.signal.aborted && spinner) spinner.hidden = true;
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

  const typeBadge = (r: CatalogRow) => `<span class="status-badge ${r.product_type === "outlet" ? "info" : "success"}">${TYPE_LABEL[r.product_type]}</span>`;

  const cards = rows
    .map(
      (r) => `
      <div class="product-card">
        <div class="product-card-top">
          <p class="product-card-name">${escapeHtml(r.produto)}</p>
          ${typeBadge(r)}
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
        `<tr><td>${escapeHtml(r.produto)}</td><td class="sku-code">${escapeHtml(r.sku_code)}</td><td class="sku-code">${escapeHtml(r.gtin || "-")}</td><td>${escapeHtml(
          r.cor || ""
        )}</td><td>${typeBadge(r)}</td>${canManage ? `<td>${actions(r)}</td>` : ""}</tr>`
    )
    .join("");

  wrap.innerHTML = `
    <div class="product-card-list mobile-only">${cards}</div>
    <div class="table-wrap desktop-only">
      <table>
        <thead><tr><th>Produto</th><th>SKU</th><th>EAN</th><th>Cor</th><th>Tipo</th>${canManage ? "<th>Ações</th>" : ""}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}
