// Catálogo Visual — base de imagens por SKU Outlet (product_variants) para
// o futuro Modo Scan. Sub-seção dentro da tela "Catálogo" (não ocupa um
// ícone novo na bottom nav). Gerencia sua própria sub-navegação em memória
// (lista / detalhe / importações), sem tocar no roteador global do app.
import { escapeHtml, debounce, renderErrorWithRetry } from "../../utils.ts";
import { getAuthState, isManagerOrAdmin } from "../../auth.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction } from "../confirmModal.ts";
import {
  getCatalogVisualSummary,
  listCatalogVisualProducts,
  getProductVisualDetail,
  getSignedImageUrl,
  getImageHistory,
  setPrimaryImage,
  archiveImage,
  setImageQuality,
  setRecognitionEnabled,
  setImageTypeAndAngle,
  uploadManualImage,
  listCatalogImageImports,
  getImportItems,
  type CatalogVisualFilter,
  type CatalogVisualProduct,
  type ProductImage,
  type ImageType,
  type CatalogImageImport,
} from "../../catalogImagesApi.ts";
import { parseCatalogVisualSheet, buildImportPreview, createCatalogImageImport, type ImportPreview } from "../../catalogImagesImporter.ts";
import { processImportBatch, resetImportErrors } from "../../catalogImagesBackendClient.ts";
import { startCamera, blobToBase64, CameraPermissionDeniedError, CameraUnavailableError, type CameraController } from "../../scanCamera.ts";
import {
  assessScanFrameQuality,
  recordAdminReference,
  getLibrarySummary,
  type LibrarySummary,
  recalcRecognitionQuality,
  getRecognitionQualityBatch,
  listRecognitionQuality,
  type RecognitionQuality,
  type RecognitionQualityListRow,
} from "../../visualLearningApi.ts";
import { searchSkuForPicker, type CatalogRow } from "../../catalogApi.ts";

declare const XLSX: {
  read(data: ArrayBuffer): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_json(ws: unknown, opts?: Record<string, unknown>): unknown[][] };
};

type SubView = "list" | "detail" | "imports" | "training";
let subView: SubView = "list";
let selectedVariantId: string | null = null;

// estado da lista
let listQuery = "";
let listFilter: CatalogVisualFilter = "all";
let listPage = 0;
const LIST_PAGE_SIZE = 20;

// estado do filtro de Qualidade de Reconhecimento — quando definido, a lista
// passa a vir de listRecognitionQuality (banda/ordenação) em vez de
// listCatalogVisualProducts; "todos" volta pro fluxo normal de sempre.
type QualityBandFilter = "todos" | "excelente" | "bom" | "regular" | "fraco" | "critico" | "sem_referencias";
let qualityBandFilter: QualityBandFilter = "todos";
let qualitySort: "score_asc" | "score_desc" = "score_asc";

const QUALITY_BAND_LABELS: Record<QualityBandFilter, string> = {
  todos: "Todos",
  excelente: "Excelente",
  bom: "Bom",
  regular: "Regular",
  fraco: "Fraco",
  critico: "Crítico",
  sem_referencias: "Sem referências",
};

const FILTER_LABELS: Record<CatalogVisualFilter, string> = {
  all: "Todos",
  with_image: "Com imagem",
  without_image: "Sem imagem",
  pending_quality: "Pendente",
  error: "Com erro",
  recognition_enabled: "Reconhecimento habilitado",
  recognition_disabled: "Reconhecimento desabilitado",
  inactive: "Inativos",
};

export async function renderCatalogVisualSection(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div id="catalogVisualBody"></div>`;
  const body = root.querySelector<HTMLElement>("#catalogVisualBody")!;
  await renderCurrentSubView(body);
}

async function renderCurrentSubView(body: HTMLElement): Promise<void> {
  // Sair de qualquer subView pra uma diferente de "training" precisa sempre
  // encerrar a câmera de treinamento — nunca deixar tracks abertas em segundo
  // plano (mesmo princípio de teardownScan em scan.ts).
  if (subView !== "training") teardownTraining();

  if (subView === "detail" && selectedVariantId) {
    await renderProductDetail(body, selectedVariantId);
  } else if (subView === "imports") {
    await renderImportsView(body);
  } else if (subView === "training") {
    await renderTrainingView(body);
  } else {
    await renderListView(body);
  }
}

async function hydrateThumbnails(container: Element): Promise<void> {
  const imgs = [...container.querySelectorAll<HTMLImageElement>("img.thumb-img[data-storage-path], img.thumb-img-lg[data-storage-path], img.gallery-thumb[data-storage-path]")];
  await Promise.all(
    imgs.map(async (img) => {
      const path = img.dataset.storagePath;
      if (!path) return;
      const url = await getSignedImageUrl(path);
      if (url) img.src = url;
    })
  );
}

function thumbHtml(image: ProductImage | null, extraClass = "thumb-img"): string {
  if (!image || !image.storage_path) {
    return `<div class="thumb-placeholder">${Icon.imageOff}</div>`;
  }
  return `<img class="${extraClass}" data-storage-path="${escapeHtml(image.storage_path)}" alt="" />`;
}

// ---------------------------------------------------------------------------
// RESUMO
// ---------------------------------------------------------------------------
async function renderSummary(container: HTMLElement): Promise<void> {
  try {
    const s = await getCatalogVisualSummary();
    container.innerHTML = `
      <div class="summary-grid">
        <div class="summary-stat"><strong>${s.total_products}</strong><span>Produtos (SKU Outlet)</span></div>
        <div class="summary-stat"><strong>${s.with_image}</strong><span>Com imagem</span></div>
        <div class="summary-stat warn"><strong>${s.without_image}</strong><span>Sem imagem</span></div>
        <div class="summary-stat"><strong>${s.with_multiple_images}</strong><span>Com várias imagens</span></div>
        <div class="summary-stat warn"><strong>${s.pending_quality}</strong><span>Pendentes de validação</span></div>
        <div class="summary-stat"><strong>${s.recognition_ready}</strong><span>Disponíveis p/ reconhecimento</span></div>
        <div class="summary-stat error"><strong>${s.processing_errors}</strong><span>Com erro</span></div>
        <div class="summary-stat"><strong>${s.last_import ? new Date(s.last_import.created_at).toLocaleDateString("pt-BR") : "-"}</strong><span>Última importação</span></div>
      </div>`;
  } catch (err) {
    renderErrorWithRetry(container, "Erro ao carregar resumo: " + (err instanceof Error ? err.message : String(err)), () => void renderSummary(container));
  }
}

// ---------------------------------------------------------------------------
// LISTA
// ---------------------------------------------------------------------------
async function renderListView(body: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  const canManage = isManagerOrAdmin(profile);

  body.innerHTML = `
    <div class="card"><h2>Resumo do Catálogo Visual</h2><div id="cvSummary"><div class="skeleton skeleton-card"></div></div></div>
    <div class="card">
      <div class="product-card-top">
        <h2 style="margin:0">Produtos</h2>
        <div class="chip-row" style="margin:0">
          ${canManage ? `<button class="btn-primary" id="btnGoTraining">${Icon.scan}Criar Reconhecimento</button>` : ""}
          ${canManage ? `<button class="btn-secondary" id="btnGoImports">${Icon.fileUp}Importações</button>` : ""}
        </div>
      </div>
      <div class="search-row">
        <label for="cvSearch" class="sr-only">Buscar por SKU ou nome</label>
        <input type="text" id="cvSearch" placeholder="Buscar por SKU Outlet ou nome…" value="${escapeHtml(listQuery)}" />
      </div>
      <div class="chip-row" id="cvFilterChips">
        ${(Object.keys(FILTER_LABELS) as CatalogVisualFilter[])
          .map((f) => `<button type="button" class="chip ${listFilter === f ? "active" : ""}" data-filter="${f}">${FILTER_LABELS[f]}</button>`)
          .join("")}
      </div>
      <p class="hint-text" style="margin:10px 0 4px">${Icon.gauge}Qualidade de Reconhecimento</p>
      <div class="chip-row" id="cvQualityChips">
        ${(Object.keys(QUALITY_BAND_LABELS) as QualityBandFilter[])
          .map((b) => `<button type="button" class="chip ${qualityBandFilter === b ? "active" : ""}" data-quality-band="${b}">${QUALITY_BAND_LABELS[b]}</button>`)
          .join("")}
        ${
          qualityBandFilter !== "todos"
            ? `<button type="button" class="chip" id="cvQualitySortToggle">${Icon.refresh}${qualitySort === "score_asc" ? "Quem mais precisa de treinamento" : "Melhor qualidade primeiro"}</button>`
            : ""
        }
      </div>
      <div id="cvListWrap"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>
      <div class="pagination">
        <button class="icon-btn" id="cvPrevPage" disabled aria-label="Página anterior">${Icon.chevronLeft}</button>
        <span id="cvPageInfo" class="hint-text"></span>
        <button class="icon-btn" id="cvNextPage" disabled aria-label="Próxima página">${Icon.chevronRight}</button>
      </div>
    </div>`;

  void renderSummary(body.querySelector("#cvSummary")!);

  body.querySelector("#btnGoImports")?.addEventListener("click", () => {
    subView = "imports";
    void renderCurrentSubView(body);
  });
  body.querySelector("#btnGoTraining")?.addEventListener("click", () => {
    resetTrainingState();
    subView = "training";
    void renderCurrentSubView(body);
  });

  const searchInput = body.querySelector<HTMLInputElement>("#cvSearch")!;
  const debouncedSearch = debounce((value: string) => {
    listQuery = value;
    listPage = 0;
    void loadListPage(body);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  body.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      listFilter = btn.dataset.filter as CatalogVisualFilter;
      listPage = 0;
      void renderListView(body);
    });
  });

  body.querySelectorAll<HTMLButtonElement>("[data-quality-band]").forEach((btn) => {
    btn.addEventListener("click", () => {
      qualityBandFilter = btn.dataset.qualityBand as QualityBandFilter;
      listPage = 0;
      void renderListView(body);
    });
  });
  body.querySelector("#cvQualitySortToggle")?.addEventListener("click", () => {
    qualitySort = qualitySort === "score_asc" ? "score_desc" : "score_asc";
    void renderListView(body);
  });

  body.querySelector("#cvPrevPage")!.addEventListener("click", () => {
    if (listPage > 0) {
      listPage--;
      void loadListPage(body);
    }
  });
  body.querySelector("#cvNextPage")!.addEventListener("click", () => {
    listPage++;
    void loadListPage(body);
  });

  await loadListPage(body);
}

async function loadListPage(body: HTMLElement): Promise<void> {
  const wrap = body.querySelector("#cvListWrap")!;
  try {
    if (qualityBandFilter !== "todos") {
      const { rows, total } = await listRecognitionQuality({
        band: qualityBandFilter === "sem_referencias" ? "critico" : qualityBandFilter,
        onlyNoReferences: qualityBandFilter === "sem_referencias",
        page: listPage,
        pageSize: LIST_PAGE_SIZE,
        sort: qualitySort,
      });
      renderQualityCards(wrap, rows);
      const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
      body.querySelector("#cvPageInfo")!.textContent = `Página ${listPage + 1} de ${totalPages} (${total})`;
      (body.querySelector("#cvPrevPage") as HTMLButtonElement).disabled = listPage === 0;
      (body.querySelector("#cvNextPage") as HTMLButtonElement).disabled = listPage + 1 >= totalPages;
      return;
    }
    const { rows, total } = await listCatalogVisualProducts(listQuery, listFilter, listPage, LIST_PAGE_SIZE);
    renderProductCards(wrap, rows);
    void hydrateThumbnails(wrap);
    const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    body.querySelector("#cvPageInfo")!.textContent = `Página ${listPage + 1} de ${totalPages} (${total})`;
    (body.querySelector("#cvPrevPage") as HTMLButtonElement).disabled = listPage === 0;
    (body.querySelector("#cvNextPage") as HTMLButtonElement).disabled = listPage + 1 >= totalPages;
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao buscar: " + (err instanceof Error ? err.message : String(err)), () => void loadListPage(body));
  }
}

function renderQualityCards(wrap: Element, rows: RecognitionQualityListRow[]): void {
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum produto nessa faixa de qualidade.</p></div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="product-card-list">
      ${rows
        .map((q) => {
          const css = BAND_CSS[q.band] ?? "info";
          const label = BAND_LABELS[q.band] ?? q.band;
          return `
        <div class="product-card" data-open-variant="${q.variant_id}" style="cursor:pointer">
          <div class="product-card-top">
            <div style="flex:1;min-width:0">
              <p class="product-card-name">${escapeHtml(q.product_name)}</p>
              <div class="product-card-meta">
                <span class="sku-code">${escapeHtml(q.sku_code)}</span>
                <span>${q.reference_count} referência(s)</span>
              </div>
            </div>
          </div>
          <div class="product-card-bottom">
            <span class="status-badge ${css}">${Icon.gauge}${q.score_percent}% ${escapeHtml(label)}${q.estimated_only ? " (estimado)" : ""}</span>
          </div>
        </div>`;
        })
        .join("")}
    </div>`;

  wrap.querySelectorAll<HTMLElement>("[data-open-variant]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedVariantId = el.dataset.openVariant!;
      subView = "detail";
      const body = wrap.closest("#catalogVisualBody") as HTMLElement;
      void renderCurrentSubView(body);
    });
  });
}

function productStatusBadges(p: CatalogVisualProduct): string {
  const parts: string[] = [];
  if (p.image_count === 0) parts.push(`<span class="status-badge warning">${Icon.imageOff}Sem imagem</span>`);
  if (p.has_pending_quality) parts.push(`<span class="status-badge info">${Icon.info}Pendente</span>`);
  if (p.has_error) parts.push(`<span class="status-badge error">${Icon.alertTriangle}Erro</span>`);
  if (p.primary_image?.recognition_enabled && p.primary_image.quality_status === "aprovada") {
    parts.push(`<span class="status-badge success">${Icon.checkCircle}Pronta p/ reconhecimento</span>`);
  }
  return parts.join("");
}

const BAND_LABELS: Record<string, string> = { excelente: "Excelente", bom: "Bom", regular: "Regular", fraco: "Fraco", critico: "Crítico" };
const BAND_CSS: Record<string, string> = { excelente: "success", bom: "success", regular: "warning", fraco: "warning", critico: "error" };

function qualityBadgeHtml(variantId: string): string {
  return `<span class="status-badge quality-badge-placeholder" data-quality-variant="${variantId}">…</span>`;
}

function renderQualityBadgeInto(el: Element, q: RecognitionQuality | undefined): void {
  if (!q) {
    el.outerHTML = "";
    return;
  }
  const css = BAND_CSS[q.band] ?? "info";
  const label = BAND_LABELS[q.band] ?? q.band;
  el.outerHTML = `<span class="status-badge ${css}" title="Qualidade de Reconhecimento">${Icon.gauge}${q.score_percent}% ${escapeHtml(label)}${q.estimated_only ? " (estimado)" : ""}</span>`;
}

const ANGLE_LABELS: Record<string, string> = { frente: "Frente", traseira: "Traseira", lateral: "Lateral", superior: "Superior/tampa", base: "Base", detalhe: "Detalhe" };

function renderQualityCardHtml(q: RecognitionQuality): string {
  const css = BAND_CSS[q.band] ?? "info";
  const label = BAND_LABELS[q.band] ?? q.band;
  return `
    <div class="card">
      <div class="product-card-top">
        <h2 style="margin:0">${Icon.gauge}Qualidade de Reconhecimento</h2>
        <span class="status-badge ${css}" style="font-size:14px">${q.score_percent}% — ${escapeHtml(label)}</span>
      </div>
      ${q.estimated_only ? `<p class="hint-text">Qualidade estimada pelas referências cadastradas — ainda não há uso operacional (scans reais) suficiente para confirmar com dados de campo.</p>` : `<p class="hint-text">Calculada com ${q.historical_sample_count} reconhecimento(s) reais registrados, além das referências cadastradas.</p>`}
      <div class="summary-grid">
        <div class="summary-stat"><strong>${q.reference_count}</strong><span>Referências (${q.official_count} oficiais, ${q.learned_count} aprendidas)</span></div>
        <div class="summary-stat"><strong>${q.quality_technical_percent}%</strong><span>Qualidade técnica</span></div>
        <div class="summary-stat"><strong>${q.angle_coverage_percent}%</strong><span>Cobertura de ângulos${q.angles_present.length ? ` (${q.angles_present.map((a) => ANGLE_LABELS[a] ?? a).join(", ")})` : ""}</span></div>
        <div class="summary-stat"><strong>${q.embedding_consistency_percent ?? "-"}${q.embedding_consistency_percent !== null ? "%" : ""}</strong><span>Consistência das referências</span></div>
        ${q.historical_accuracy_percent !== null ? `<div class="summary-stat"><strong>${q.historical_accuracy_percent}%</strong><span>Taxa de acerto real</span></div>` : ""}
        ${q.avg_recognition_ms !== null ? `<div class="summary-stat"><strong>${(q.avg_recognition_ms / 1000).toFixed(1)}s</strong><span>Tempo médio real</span></div>` : ""}
      </div>
      ${
        q.top_confusion_sku
          ? `<div class="error-box" style="margin-top:10px">Confundido com <strong>${escapeHtml(q.top_confusion_sku)}</strong> em ${q.top_confusion_count} ocorrência(s) registradas.</div>`
          : ""
      }
      <h3 style="margin:14px 0 6px;font-size:14px">Recomendações</h3>
      <ul class="quality-recommendations">
        ${q.recommendations.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
      </ul>
    </div>`;
}

async function hydrateQualityBadges(container: Element, variantIds: string[]): Promise<void> {
  if (variantIds.length === 0) return;
  try {
    const batch = await getRecognitionQualityBatch(variantIds);
    container.querySelectorAll<HTMLElement>("[data-quality-variant]").forEach((el) => {
      renderQualityBadgeInto(el, batch.get(el.dataset.qualityVariant!));
    });
  } catch {
    // indicador é um bônus informativo — nunca quebra a lista principal por causa dele
  }
}

function renderProductCards(wrap: Element, rows: CatalogVisualProduct[]): void {
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum produto encontrado para esse filtro.</p></div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="product-card-list">
      ${rows
        .map(
          (p) => `
        <div class="product-card" data-open-variant="${p.variant_id}" style="cursor:pointer">
          <div class="product-card-top">
            ${thumbHtml(p.primary_image)}
            <div style="flex:1;min-width:0">
              <p class="product-card-name">${escapeHtml(p.nome)}</p>
              <div class="product-card-meta">
                <span class="sku-code">${escapeHtml(p.sku_outlet)}</span>
                <span>${p.image_count} imagem(ns)</span>
              </div>
            </div>
          </div>
          <div class="product-card-bottom">${productStatusBadges(p)}${qualityBadgeHtml(p.variant_id)}</div>
        </div>`
        )
        .join("")}
    </div>`;

  wrap.querySelectorAll<HTMLElement>("[data-open-variant]").forEach((el) => {
    el.addEventListener("click", () => {
      selectedVariantId = el.dataset.openVariant!;
      subView = "detail";
      const body = wrap.closest("#catalogVisualBody") as HTMLElement;
      void renderCurrentSubView(body);
    });
  });

  void hydrateQualityBadges(
    wrap,
    rows.map((p) => p.variant_id)
  );
}

// ---------------------------------------------------------------------------
// DETALHE DO PRODUTO
// ---------------------------------------------------------------------------
const IMAGE_TYPE_LABELS: Record<ImageType, string> = {
  catalogo: "Catálogo",
  frontal: "Frontal",
  lateral: "Lateral",
  traseira: "Traseira",
  detalhe: "Detalhe",
  embalagem: "Embalagem",
};

async function renderProductDetail(body: HTMLElement, variantId: string): Promise<void> {
  body.innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card" style="height:200px"></div>`;
  const { profile } = getAuthState();
  const canManage = isManagerOrAdmin(profile);

  let detail;
  let librarySummary: LibrarySummary | null = null;
  let quality: RecognitionQuality | null = null;
  try {
    detail = await getProductVisualDetail(variantId);
    librarySummary = await getLibrarySummary(variantId).catch(() => null);
    quality = (await getRecognitionQualityBatch([variantId]).catch(() => new Map())).get(variantId) ?? null;
  } catch (err) {
    renderErrorWithRetry(body, "Erro: " + (err instanceof Error ? err.message : String(err)), () => void renderProductDetail(body, variantId));
    return;
  }
  const { variant, images } = detail;
  const activeImages = images.filter((i) => i.is_active);
  const archivedImages = images.filter((i) => !i.is_active);

  body.innerHTML = `
    <button class="link-btn" id="cvBackToList" style="text-align:left">${Icon.chevronLeft} Voltar ao catálogo visual</button>
    <div class="card">
      <div class="product-card-top">
        ${thumbHtml(variant.primary_image, "thumb-img-lg")}
      </div>
      <h2 style="margin-top:12px">${escapeHtml(variant.nome)}</h2>
      <div class="product-card-meta" style="margin-bottom:10px">
        <span class="sku-code">${escapeHtml(variant.sku_outlet)}</span>
        ${variant.gtin_ean ? `<span class="sku-code">EAN ${escapeHtml(variant.gtin_ean)}</span>` : ""}
      </div>
      <p class="hint-text" style="margin:0">${activeImages.length} imagem(ns) ativa(s)${archivedImages.length ? `, ${archivedImages.length} arquivada(s)` : ""}</p>
    </div>

    ${
      librarySummary
        ? `<div class="card">
            <h2>Memória de reconhecimento</h2>
            <div class="summary-grid">
              <div class="summary-stat"><strong>${librarySummary.official_count}</strong><span>Fotos oficiais</span></div>
              <div class="summary-stat"><strong>${librarySummary.admin_training_count}</strong><span>Treinamentos</span></div>
              <div class="summary-stat"><strong>${librarySummary.corrected_count}</strong><span>Correções</span></div>
              <div class="summary-stat"><strong>${librarySummary.confirmed_count}</strong><span>Confirmações</span></div>
              <div class="summary-stat"><strong>${librarySummary.total}</strong><span>Total de referências</span></div>
            </div>
          </div>`
        : ""
    }

    ${quality ? renderQualityCardHtml(quality) : ""}

    ${
      canManage
        ? `<div class="card">
            <h2>Adicionar imagem</h2>
            <p class="hint-text">Pelo computador ou pela câmera do celular.</p>
            <label class="dropzone small" for="cvUploadInput">
              <span class="dz-icon">${Icon.camera}</span>
              <span>Toque para escolher uma foto</span>
            </label>
            <input type="file" id="cvUploadInput" accept="image/*" capture="environment" hidden />
            <label for="cvUploadType">Tipo da imagem</label>
            <select id="cvUploadType">
              ${Object.entries(IMAGE_TYPE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
            </select>
            <label for="cvUploadAngle">Ângulo (opcional)</label>
            <input type="text" id="cvUploadAngle" placeholder="ex.: frente, 45 graus, topo..." />
            <div id="cvUploadStatus" role="status" aria-live="polite"></div>
          </div>`
        : ""
    }

    <div class="card">
      <h2>Galeria</h2>
      <div class="gallery-grid" id="cvGallery">
        ${activeImages
          .map(
            (img) => `
          <div class="gallery-item ${img.is_primary ? "selected" : ""}" data-image-id="${img.id}">
            ${
              img.storage_path
                ? `<img class="gallery-thumb" data-storage-path="${escapeHtml(img.storage_path)}" alt="" />`
                : `<div class="thumb-placeholder">${Icon.imageOff}</div>`
            }
            ${img.is_primary ? `<span class="status-badge success">${Icon.star}Principal</span>` : ""}
          </div>`
          )
          .join("")}
      </div>
      <div id="cvImageDetail"></div>
    </div>

    ${
      archivedImages.length
        ? `<div class="card"><h2>Imagens arquivadas</h2><div class="gallery-grid">${archivedImages
            .map(
              (img) => `<div class="gallery-item" data-image-id="${img.id}">${
                img.storage_path ? `<img class="gallery-thumb" data-storage-path="${escapeHtml(img.storage_path)}" alt="" />` : `<div class="thumb-placeholder">${Icon.archive}</div>`
              }</div>`
            )
            .join("")}</div></div>`
        : ""
    }

    <div class="card">
      <h2>Histórico de alterações</h2>
      <div id="cvHistory"><p class="hint-text">Carregando…</p></div>
    </div>`;

  void hydrateThumbnails(body);

  body.querySelector("#cvBackToList")!.addEventListener("click", () => {
    subView = "list";
    void renderCurrentSubView(body);
  });

  body.querySelectorAll<HTMLElement>("#cvGallery [data-image-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const img = activeImages.find((i) => i.id === el.dataset.imageId);
      if (img) renderImageActions(body, variantId, img, canManage);
    });
  });

  void loadHistory(body, images.map((i) => i.id));

  if (canManage) {
    wireManualUpload(body, variantId);
  }
}

function renderImageActions(body: HTMLElement, variantId: string, image: ProductImage, canManage: boolean): void {
  const container = body.querySelector("#cvImageDetail")!;
  container.innerHTML = `
    <div class="card" style="background:var(--neutral-100)">
      <div class="product-card-meta">
        <span>${image.width ?? "?"}×${image.height ?? "?"}</span>
        <span>${((image.file_size ?? 0) / 1024).toFixed(0)} KB</span>
      </div>
      ${
        canManage
          ? `<label for="cvImageType">Tipo da imagem</label>
             <select id="cvImageType">
               ${Object.entries(IMAGE_TYPE_LABELS)
                 .map(([v, l]) => `<option value="${v}" ${v === image.image_type ? "selected" : ""}>${l}</option>`)
                 .join("")}
             </select>
             <label for="cvImageAngle">Ângulo</label>
             <input type="text" id="cvImageAngle" value="${escapeHtml(image.view_angle)}" />
             <button class="btn-secondary btn-block" id="actSaveTypeAngle">Salvar tipo/ângulo</button>`
          : `<div class="product-card-meta"><span>${IMAGE_TYPE_LABELS[image.image_type]}</span><span>${escapeHtml(image.view_angle)}</span></div>`
      }
      <div class="chip-row">
        <span class="status-badge ${image.quality_status === "aprovada" ? "success" : image.quality_status === "rejeitada" ? "error" : "warning"}">
          ${image.quality_status === "aprovada" ? Icon.checkCircle : image.quality_status === "rejeitada" ? Icon.xCircle : Icon.info}
          Qualidade: ${image.quality_status}
        </span>
        <span class="status-badge ${image.recognition_enabled ? "success" : "offline"}">
          ${image.recognition_enabled ? Icon.eye : Icon.eyeOff}
          Reconhecimento ${image.recognition_enabled ? "habilitado" : "desabilitado"}
        </span>
      </div>
      ${
        canManage
          ? `<div class="review-actions" style="flex-wrap:wrap">
              ${!image.is_primary ? `<button class="btn-secondary" id="actSetPrimary">${Icon.star}Definir como principal</button>` : ""}
              <button class="btn-secondary" id="actToggleRecognition">${image.recognition_enabled ? Icon.eyeOff + "Desabilitar reconhecimento" : Icon.eye + "Habilitar reconhecimento"}</button>
              <button class="btn-secondary" id="actApprove">${Icon.checkCircle}Aprovar qualidade</button>
              <button class="btn-secondary" id="actReject">${Icon.xCircle}Rejeitar qualidade</button>
              <button class="btn-danger" id="actArchive">${Icon.archive}Arquivar</button>
            </div>`
          : ""
      }
    </div>`;

  container.querySelector("#actSetPrimary")?.addEventListener("click", async () => {
    await setPrimaryImage(variantId, image.id);
    showToast("Imagem definida como principal.", "success");
    void renderProductDetail(body, variantId);
  });
  container.querySelector("#actToggleRecognition")?.addEventListener("click", async () => {
    await setRecognitionEnabled(image.id, !image.recognition_enabled);
    void recalcRecognitionQuality(variantId);
    showToast("Atualizado.", "success");
    void renderProductDetail(body, variantId);
  });
  container.querySelector("#actApprove")?.addEventListener("click", async () => {
    await setImageQuality(image.id, "aprovada");
    void recalcRecognitionQuality(variantId);
    showToast("Imagem aprovada.", "success");
    void renderProductDetail(body, variantId);
  });
  container.querySelector("#actReject")?.addEventListener("click", async () => {
    await setImageQuality(image.id, "rejeitada");
    void recalcRecognitionQuality(variantId);
    showToast("Imagem rejeitada.", "success");
    void renderProductDetail(body, variantId);
  });
  container.querySelector("#actArchive")?.addEventListener("click", async () => {
    const confirmed = await confirmAction({
      title: "Arquivar imagem?",
      message: "A imagem sai de uso ativo mas fica preservada no histórico.",
      confirmLabel: "Arquivar",
      danger: true,
    });
    if (!confirmed) return;
    await archiveImage(image.id);
    void recalcRecognitionQuality(variantId);
    showToast("Imagem arquivada.", "success");
    void renderProductDetail(body, variantId);
  });

  container.querySelector("#actSaveTypeAngle")?.addEventListener("click", async () => {
    const imageType = (container.querySelector("#cvImageType") as HTMLSelectElement).value as ImageType;
    const viewAngle = (container.querySelector("#cvImageAngle") as HTMLInputElement).value || "nao_informado";
    await setImageTypeAndAngle(image.id, imageType, viewAngle);
    void recalcRecognitionQuality(variantId);
    showToast("Tipo/ângulo atualizado.", "success");
    void renderProductDetail(body, variantId);
  });
}

async function loadHistory(body: HTMLElement, imageIds: string[]): Promise<void> {
  const container = body.querySelector("#cvHistory")!;
  try {
    const history = await getImageHistory(imageIds);
    if (history.length === 0) {
      container.innerHTML = `<p class="hint-text">Nenhuma alteração registrada ainda.</p>`;
      return;
    }
    container.innerHTML = history
      .map(
        (h) => `
      <div class="import-item-row">
        <span>${escapeHtml(h.action)}</span>
        <span class="hint-text" style="margin:0">${new Date(h.created_at).toLocaleString("pt-BR")}</span>
      </div>`
      )
      .join("");
  } catch (err) {
    container.innerHTML = `<div class="error-box">Erro ao carregar histórico: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function wireManualUpload(body: HTMLElement, variantId: string): void {
  const input = body.querySelector<HTMLInputElement>("#cvUploadInput")!;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const statusEl = body.querySelector("#cvUploadStatus")!;
    const imageType = (body.querySelector("#cvUploadType") as HTMLSelectElement).value as ImageType;
    const viewAngle = (body.querySelector("#cvUploadAngle") as HTMLInputElement).value;
    statusEl.textContent = "Enviando…";
    try {
      await uploadManualImage({ variantId, file, imageType, viewAngle });
      void recalcRecognitionQuality(variantId);
      showToast("Imagem adicionada.", "success");
      void renderProductDetail(body, variantId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `Erro: ${message}`;
      showToast("Erro ao enviar imagem.", "error");
    } finally {
      input.value = "";
    }
  });
}

// ---------------------------------------------------------------------------
// IMPORTAÇÕES
// ---------------------------------------------------------------------------
let pendingPreview: { fileName: string; rows: ReturnType<typeof parseCatalogVisualSheet>; preview: ImportPreview } | null = null;

async function renderImportsView(body: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  const canManage = isManagerOrAdmin(profile);

  body.innerHTML = `
    <button class="link-btn" id="cvBackFromImports" style="text-align:left">${Icon.chevronLeft} Voltar ao catálogo visual</button>
    ${
      canManage
        ? `<div class="card">
            <h2>Importar planilha</h2>
            <p class="hint-text">Colunas esperadas: SKU Outlet, Nome do produto, GTIN/EAN (opcional), URL da imagem (opcional). A posição das colunas não importa.</p>
            <label class="dropzone small" for="cvImportFile">
              <span class="dz-icon">${Icon.fileUp}</span>
              <span>Toque para subir XLSX/XLS/CSV</span>
            </label>
            <input type="file" id="cvImportFile" accept=".xlsx,.xls,.csv" hidden />
            <div id="cvImportPreviewWrap"></div>
          </div>`
        : ""
    }
    <div class="card">
      <h2>Importações recentes</h2>
      <div id="cvImportsList"><p class="hint-text">Carregando…</p></div>
    </div>`;

  body.querySelector("#cvBackFromImports")!.addEventListener("click", () => {
    subView = "list";
    void renderCurrentSubView(body);
  });

  if (canManage) {
    const fileInput = body.querySelector<HTMLInputElement>("#cvImportFile")!;
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const previewWrap = body.querySelector("#cvImportPreviewWrap")!;
      previewWrap.innerHTML = `<p class="hint-text">Lendo planilha…</p>`;
      try {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const rows = parseCatalogVisualSheet(rawRows as unknown[][]);
        const preview = await buildImportPreview(rows);
        pendingPreview = { fileName: file.name, rows, preview };
        renderPreview(body, previewWrap);
      } catch (err) {
        previewWrap.innerHTML = `<div class="error-box">Erro ao ler planilha: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
      } finally {
        fileInput.value = "";
      }
    });
  }

  await loadImportsList(body);
}

function renderPreview(body: HTMLElement, previewWrap: Element): void {
  if (!pendingPreview) return;
  const { fileName, preview } = pendingPreview;
  previewWrap.innerHTML = `
    <div class="card" style="background:var(--go-sky-100)">
      <h3 style="margin-top:0">Prévia: ${escapeHtml(fileName)}</h3>
      <div class="summary-grid">
        <div class="summary-stat"><strong>${preview.total}</strong><span>Linhas na planilha</span></div>
        <div class="summary-stat"><strong>${preview.valid.length}</strong><span>Válidas</span></div>
        <div class="summary-stat"><strong>${preview.newProducts.length}</strong><span>Produtos novos</span></div>
        <div class="summary-stat"><strong>${preview.existingProducts.length}</strong><span>Já existem (serão atualizados)</span></div>
        <div class="summary-stat warn"><strong>${preview.withoutImage.length}</strong><span>Sem imagem</span></div>
        <div class="summary-stat ${preview.duplicateSkus.length ? "warn" : ""}"><strong>${preview.duplicateSkus.length}</strong><span>SKUs duplicados na planilha</span></div>
        <div class="summary-stat ${preview.invalidUrls.length ? "error" : ""}"><strong>${preview.invalidUrls.length}</strong><span>URLs inválidas</span></div>
        <div class="summary-stat ${preview.rejected.length ? "error" : ""}"><strong>${preview.rejected.length}</strong><span>Registros rejeitados</span></div>
      </div>
      <button class="btn-primary btn-block" id="cvConfirmImport">Confirmar importação</button>
    </div>`;

  previewWrap.querySelector("#cvConfirmImport")!.addEventListener("click", async () => {
    if (!pendingPreview) return;
    const btn = previewWrap.querySelector("#cvConfirmImport") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Criando importação…";
    try {
      const outcome = await createCatalogImageImport(pendingPreview.fileName, pendingPreview.rows);
      showToast(`Importação criada: ${outcome.createdItems} itens.`, "success");
      pendingPreview = null;
      previewWrap.innerHTML = "";
      await runBatchLoop(body, outcome.importId);
    } catch (err) {
      showToast("Erro ao criar importação: " + (err instanceof Error ? err.message : String(err)), "error");
      btn.disabled = false;
      btn.textContent = "Confirmar importação";
    }
  });
}

async function runBatchLoop(body: HTMLElement, importId: string): Promise<void> {
  const progressWrap = body.querySelector("#cvImportPreviewWrap")!;
  progressWrap.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">Processando imagens…</h3>
      <div class="progress-bar-track"><div class="progress-bar-fill" id="cvProgressFill" style="width:0%"></div></div>
      <p class="hint-text" id="cvProgressText">Iniciando…</p>
    </div>`;

  let guard = 0;
  while (guard < 500) {
    guard++;
    try {
      const result = await processImportBatch(importId, 5);
      const text = progressWrap.querySelector("#cvProgressText")!;
      const fill = progressWrap.querySelector<HTMLElement>("#cvProgressFill")!;
      text.textContent = `${result.processed.length} processado(s) neste lote · ${result.remainingPending} restante(s) · status: ${result.importStatus}`;
      if (result.remainingPending === 0) {
        fill.style.width = "100%";
        showToast("Importação de imagens concluída.", "success");
        break;
      }
      const done = result.remainingPending;
      fill.style.width = done === 0 ? "100%" : "50%";
    } catch (err) {
      progressWrap.innerHTML += `<div class="error-box">Erro no processamento em lote: ${escapeHtml(
        err instanceof Error ? err.message : String(err)
      )} — os produtos já criados e as imagens já processadas foram salvos; use "Continuar" na lista de importações para retomar de onde parou.</div>`;
      break;
    }
  }
  await loadImportsList(body);
}

async function loadImportsList(body: HTMLElement): Promise<void> {
  const wrap = body.querySelector("#cvImportsList")!;
  try {
    const imports = await listCatalogImageImports(30);
    if (imports.length === 0) {
      wrap.innerHTML = `<p class="hint-text">Nenhuma importação ainda.</p>`;
      return;
    }
    wrap.innerHTML = imports
      .map(
        (imp) => `
      <div class="product-card">
        <div class="product-card-top">
          <p class="product-card-name">${escapeHtml(imp.filename || "planilha")}</p>
          ${importStatusBadge(imp)}
        </div>
        <div class="product-card-meta">
          <span>${new Date(imp.created_at).toLocaleString("pt-BR")}</span>
          <span>${imp.success_rows}/${imp.total_rows} ok</span>
          ${imp.error_rows ? `<span>${imp.error_rows} erro(s)</span>` : ""}
        </div>
        <div class="product-card-bottom">
          <button class="btn-secondary" data-report="${imp.id}">Ver relatório</button>
          ${imp.error_rows > 0 ? `<button class="btn-secondary" data-retry="${imp.id}">${Icon.refresh}Reprocessar erros</button>` : ""}
          ${imp.processed_rows < imp.total_rows ? `<button class="btn-primary" data-resume="${imp.id}">${Icon.play}Continuar</button>` : ""}
        </div>
        <div class="import-report" id="report-${imp.id}" hidden></div>
      </div>`
      )
      .join("");

    wrap.querySelectorAll<HTMLButtonElement>("[data-report]").forEach((btn) => {
      btn.addEventListener("click", () => void toggleReport(btn.dataset.report!));
    });
    wrap.querySelectorAll<HTMLButtonElement>("[data-retry]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { reset } = await resetImportErrors(btn.dataset.retry!);
        showToast(`${reset} item(ns) voltaram para pendente.`, "success");
        await runBatchLoop(body, btn.dataset.retry!);
      });
    });
    wrap.querySelectorAll<HTMLButtonElement>("[data-resume]").forEach((btn) => {
      btn.addEventListener("click", () => runBatchLoop(body, btn.dataset.resume!));
    });
  } catch (err) {
    wrap.innerHTML = `<div class="error-box">Erro ao listar importações: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function importStatusBadge(imp: CatalogImageImport): string {
  const map: Record<string, { cls: string; icon: string }> = {
    pending: { cls: "warning", icon: Icon.clock },
    processing: { cls: "info", icon: Icon.loader },
    completed: { cls: "success", icon: Icon.checkCircle },
    completed_with_errors: { cls: "warning", icon: Icon.alertTriangle },
    failed: { cls: "error", icon: Icon.xCircle },
  };
  const m = map[imp.status] || map.pending;
  return `<span class="status-badge ${m.cls}">${m.icon}${imp.status}</span>`;
}

async function toggleReport(importId: string): Promise<void> {
  const el = document.getElementById(`report-${importId}`);
  if (!el) return;
  if (!el.hidden) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<p class="hint-text">Carregando…</p>`;
  try {
    const items = await getImportItems(importId);
    el.innerHTML = items
      .map(
        (it) => `
      <div class="import-item-row">
        <span>#${it.row_number} · ${escapeHtml(it.sku_outlet)} · ${escapeHtml(it.product_name || "")}</span>
        <span>${escapeHtml(it.status)}${it.error_message ? " — " + escapeHtml(it.error_message) : ""}</span>
      </div>`
      )
      .join("");
  } catch (err) {
    el.innerHTML = `<div class="error-box">${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

// ---------------------------------------------------------------------------
// CRIAR RECONHECIMENTO — treinamento guiado multi-ângulo. Reaproveita a MESMA
// câmera do Modo Scan (scanCamera.ts) e a MESMA busca de produto do modo
// manual (catalogApi.ts) — nenhum SKU novo pode ser criado aqui, só vinculado
// a um produto que já existe. Cada foto aceita vira uma referência real em
// visual_learning_samples (source_type="admin_upload"), que entra IMEDIATAMENTE
// na busca de reconhecimento (mesma tabela que scans confirmados/corrigidos
// já alimentam) — sem precisar de novo deploy/reinício.
// ---------------------------------------------------------------------------
interface AngleStep {
  key: string;
  label: string;
}
const ANGLE_STEPS: AngleStep[] = [
  { key: "frente", label: "Fotografe a frente do produto" },
  { key: "traseira", label: "Agora fotografe a parte traseira" },
  { key: "esquerda", label: "Agora fotografe o lado esquerdo" },
  { key: "direita", label: "Agora fotografe o lado direito" },
  { key: "superior", label: "Agora fotografe a parte superior (tampa)" },
  { key: "base", label: "Agora fotografe a parte inferior (base)" },
];

interface CapturedShot {
  angleKey: string;
  base64: string;
}

type TrainingPhase = "capturing" | "select_product" | "submitting" | "done";

let trainingCamera: CameraController | null = null;
let trainingStepIndex = 0;
let trainingCaptures: CapturedShot[] = [];
let trainingPhase: TrainingPhase = "capturing";
let trainingSelectedVariant: CatalogRow | null = null;
let trainingSubmitResults: { angleKey: string; saved: boolean; reinforced: boolean; reason?: string }[] = [];
let trainingError = "";

function resetTrainingState(): void {
  trainingStepIndex = 0;
  trainingCaptures = [];
  trainingPhase = "capturing";
  trainingSelectedVariant = null;
  trainingSubmitResults = [];
  trainingError = "";
}

/** Nunca deixa a câmera de treinamento aberta em segundo plano — mesmo princípio de teardownScan (scan.ts). */
export function teardownTraining(): void {
  trainingCamera?.stop();
  trainingCamera = null;
}

async function renderTrainingView(body: HTMLElement): Promise<void> {
  if (trainingPhase === "capturing") {
    await renderTrainingCapture(body);
  } else if (trainingPhase === "select_product") {
    renderTrainingProductSelect(body);
  } else if (trainingPhase === "submitting") {
    renderTrainingSubmitting(body);
  } else {
    renderTrainingDone(body);
  }
}

async function renderTrainingCapture(body: HTMLElement): Promise<void> {
  const step = ANGLE_STEPS[trainingStepIndex];
  body.innerHTML = `
    <button class="link-btn" id="trainCancel" style="text-align:left">${Icon.chevronLeft} Cancelar treinamento</button>
    <div class="card">
      <h2>Criar Reconhecimento</h2>
      <p class="hint-text">Etapa ${trainingStepIndex + 1} de ${ANGLE_STEPS.length} — ${trainingCaptures.length} foto(s) capturada(s) até agora.</p>
      <div class="scan-camera-wrap" style="position:relative;max-width:420px">
        <video id="trainVideo" class="scan-video" playsinline muted></video>
      </div>
      <p class="scan-found-title" style="margin-top:12px">${escapeHtml(step.label)}</p>
      <div id="trainCaptureStatus" role="status" aria-live="polite"></div>
      <div class="scan-actions">
        <button class="btn-primary btn-block" id="trainCaptureBtn">${Icon.camera}Capturar</button>
        <button class="btn-secondary btn-block" id="trainSkipBtn">Pular esta etapa</button>
      </div>
    </div>`;

  body.querySelector("#trainCancel")!.addEventListener("click", () => {
    teardownTraining();
    subView = "list";
    void renderCurrentSubView(body);
  });

  const videoEl = body.querySelector<HTMLVideoElement>("#trainVideo")!;
  try {
    if (!trainingCamera) {
      trainingCamera = await startCamera(videoEl, "environment");
    }
  } catch (err) {
    const statusEl = body.querySelector("#trainCaptureStatus")!;
    const message =
      err instanceof CameraPermissionDeniedError
        ? "Permissão de câmera negada. Habilite o acesso à câmera nas configurações do navegador."
        : err instanceof CameraUnavailableError
          ? "Não foi possível acessar a câmera: " + err.message
          : "Erro inesperado ao abrir a câmera.";
    statusEl.innerHTML = `<p class="error-box">${escapeHtml(message)}</p>`;
    return;
  }

  body.querySelector("#trainSkipBtn")!.addEventListener("click", () => {
    advanceTrainingStep(body);
  });

  body.querySelector("#trainCaptureBtn")!.addEventListener("click", async () => {
    const btn = body.querySelector<HTMLButtonElement>("#trainCaptureBtn")!;
    const statusEl = body.querySelector("#trainCaptureStatus")!;
    btn.disabled = true;
    statusEl.innerHTML = `<p class="hint-text">Analisando qualidade da foto…</p>`;
    try {
      const blob = await trainingCamera!.captureFrameBlob(900, 0.9);
      if (!blob) {
        statusEl.innerHTML = `<p class="error-box">Não foi possível capturar o quadro. Tente novamente.</p>`;
        return;
      }
      const base64 = await blobToBase64(blob);
      const assessment = await assessScanFrameQuality(base64);
      if (!assessment.ok) {
        statusEl.innerHTML = `<p class="error-box">${escapeHtml(assessment.reason || "Qualidade insuficiente.")} Capture novamente.</p>`;
        return;
      }
      trainingCaptures.push({ angleKey: step.key, base64 });
      statusEl.innerHTML = `<p class="hint-text" style="color:var(--go-success-600, green)">${Icon.checkCircle} Foto aceita.</p>`;
      advanceTrainingStep(body);
    } catch (err) {
      statusEl.innerHTML = `<div class="error-box">Erro: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
}

function advanceTrainingStep(body: HTMLElement): void {
  trainingStepIndex++;
  if (trainingStepIndex >= ANGLE_STEPS.length) {
    teardownTraining();
    trainingPhase = "select_product";
  }
  void renderTrainingView(body);
}

function renderTrainingProductSelect(body: HTMLElement): void {
  body.innerHTML = `
    <div class="card">
      <h2>Selecione o produto</h2>
      <p class="hint-text">${trainingCaptures.length} foto(s) prontas. Vincule a um produto já existente no catálogo — não é possível criar um SKU novo aqui.</p>
      <input type="text" id="trainProductSearch" placeholder="Buscar por SKU, nome, categoria, família ou capacidade…" />
      <div id="trainProductResults" class="scan-manual-results"></div>
    </div>`;

  const input = body.querySelector<HTMLInputElement>("#trainProductSearch")!;
  const results = body.querySelector("#trainProductResults")!;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const rows = input.value.trim() ? await searchSkuForPicker(input.value, 15) : [];
      renderTrainingProductResults(results, rows, body);
    }, 300);
  });
}

function renderTrainingProductResults(resultsEl: Element, rows: CatalogRow[], body: HTMLElement): void {
  if (rows.length === 0) {
    resultsEl.innerHTML = `<p class="hint-text">Nenhum SKU encontrado.</p>`;
    return;
  }
  resultsEl.innerHTML = rows
    .map(
      (r) =>
        `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}">${escapeHtml(r.produto)} — ${escapeHtml(r.cor || "")} <span class="sku-code">${escapeHtml(r.sku_code)}</span></button>`
    )
    .join("");
  resultsEl.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = rows.find((r) => r.variant_id === btn.dataset.variant)!;
      trainingSelectedVariant = row;
      trainingPhase = "submitting";
      void renderTrainingView(body);
    });
  });
}

function renderTrainingSubmitting(body: HTMLElement): void {
  body.innerHTML = `
    <div class="card">
      <h2>Enviando referências…</h2>
      <p class="hint-text">${escapeHtml(trainingSelectedVariant?.produto ?? "")} <span class="sku-code">${escapeHtml(trainingSelectedVariant?.sku_code ?? "")}</span></p>
      <div class="progress-bar-track"><div class="progress-bar-fill" id="trainProgressFill" style="width:0%"></div></div>
      <p class="hint-text" id="trainProgressText">Iniciando…</p>
    </div>`;
  void submitTrainingCaptures(body);
}

async function submitTrainingCaptures(body: HTMLElement): Promise<void> {
  const variant = trainingSelectedVariant;
  if (!variant) return;
  trainingSubmitResults = [];
  for (let i = 0; i < trainingCaptures.length; i++) {
    const capture = trainingCaptures[i];
    try {
      const result = await recordAdminReference({ variant_id: variant.variant_id, image_base64: capture.base64, view_angle: capture.angleKey });
      trainingSubmitResults.push({ angleKey: capture.angleKey, saved: result.saved, reinforced: result.reinforcedExisting, reason: result.reason });
    } catch (err) {
      trainingSubmitResults.push({ angleKey: capture.angleKey, saved: false, reinforced: false, reason: err instanceof Error ? err.message : String(err) });
    }
    const fill = body.querySelector<HTMLElement>("#trainProgressFill");
    const text = body.querySelector("#trainProgressText");
    if (fill) fill.style.width = `${Math.round(((i + 1) / trainingCaptures.length) * 100)}%`;
    if (text) text.textContent = `${i + 1} de ${trainingCaptures.length} processada(s)…`;
  }
  trainingPhase = "done";
  void renderTrainingView(body);
}

function renderTrainingDone(body: HTMLElement): void {
  const saved = trainingSubmitResults.filter((r) => r.saved).length;
  const reinforced = trainingSubmitResults.filter((r) => r.reinforced).length;
  const rejected = trainingSubmitResults.filter((r) => !r.saved && !r.reinforced).length;

  body.innerHTML = `
    <div class="card success">
      <h2>${Icon.checkCircle} Reconhecimento criado</h2>
      <p>${escapeHtml(trainingSelectedVariant?.produto ?? "")} <span class="sku-code">${escapeHtml(trainingSelectedVariant?.sku_code ?? "")}</span></p>
      <div class="summary-grid">
        <div class="summary-stat"><strong>${saved}</strong><span>Novas referências</span></div>
        <div class="summary-stat"><strong>${reinforced}</strong><span>Reforçaram referência existente</span></div>
        <div class="summary-stat ${rejected ? "warn" : ""}"><strong>${rejected}</strong><span>Rejeitadas (qualidade)</span></div>
      </div>
      ${
        rejected > 0
          ? `<p class="hint-text">Fotos rejeitadas: ${trainingSubmitResults
              .filter((r) => !r.saved && !r.reinforced)
              .map((r) => `${escapeHtml(r.angleKey)} (${escapeHtml(r.reason ?? "")})`)
              .join(", ")}</p>`
          : ""
      }
      <p class="hint-text">Essas referências já participam do próximo escaneamento — sem precisar reiniciar nada.</p>
      <div class="scan-actions">
        <button class="btn-primary btn-block" id="trainAgain">Treinar outro produto</button>
        <button class="btn-secondary btn-block" id="trainBackToList">Voltar ao catálogo</button>
      </div>
    </div>`;

  body.querySelector("#trainAgain")!.addEventListener("click", () => {
    resetTrainingState();
    void renderCurrentSubView(body);
  });
  body.querySelector("#trainBackToList")!.addEventListener("click", () => {
    resetTrainingState();
    subView = "list";
    void renderCurrentSubView(body);
  });
}
