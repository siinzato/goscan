// Modo Scan — Parte 2: "Preparar imagens para o Scan" (geração de
// embeddings em lote) + revisão de família/variante/capacidade + teste
// interno de similaridade visual, sem câmera (isso é a Parte 4).
import { escapeHtml } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import {
  listVisualClassification,
  updateProductClassification,
  updateVariantKey,
  listReadyEmbeddingImages,
  getSignedImageUrl,
  type VisualClassificationRow,
} from "../../visualScanApi.ts";
import {
  getEmbeddingStatus,
  processEmbeddingBatch,
  processEmbeddingsForVariant,
  resetEmbeddingErrors,
  testQueryByProductImage,
  testQueryByUpload,
  type SimilarityMatch,
} from "../../visualScanBackendClient.ts";
import { listLearningSamples, updateLearningSampleStatus, getLearningSampleSignedUrl, type LearningSampleRow } from "../../visualLearningApi.ts";

let classificationPage = 0;
const PAGE_SIZE = 20;
let onlyUnclassified = false;
let classificationQuery = "";
let learningStatusFilter = "pending";

export async function renderVisualScanSection(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="card" id="vsSummaryCard">
      <h2>${Icon.scan}Preparar imagens para o Scan</h2>
      <p class="hint-text">Gera o embedding visual (vetor de similaridade) de cada imagem aprovada e habilitada para reconhecimento. Só isso entra na busca do futuro Modo Scan — imagem rejeitada ou arquivada nunca participa.</p>
      <div id="vsSummary" class="skeleton skeleton-card"></div>
      <div class="review-actions">
        <button class="btn-primary" id="vsBtnProcess">${Icon.play}Processar lote</button>
        <button class="btn-secondary" id="vsBtnResetErrors">${Icon.refresh}Reprocessar erros</button>
      </div>
      <div id="vsProgress"></div>
    </div>

    <div class="card">
      <h2>${Icon.layers}Famílias visuais (revisão)</h2>
      <p class="hint-text">Produtos visualmente idênticos entre capacidades diferentes (ex.: Copo Life 880ml/1180ml). Classificação já aplicada nas famílias conhecidas — revise ou complete aqui.</p>
      <div class="search-row">
        <input type="text" id="vsClassQuery" placeholder="Buscar produto ou código do modelo…" />
        <label class="checkbox-label"><input type="checkbox" id="vsOnlyUnclassified" /> Só não classificados</label>
      </div>
      <datalist id="scanCategoryOptions">
        <option value="copo"></option>
        <option value="garrafa"></option>
        <option value="mochila"></option>
        <option value="bolsa"></option>
        <option value="mala"></option>
        <option value="case"></option>
        <option value="lancheira"></option>
        <option value="acessorio"></option>
        <option value="pet"></option>
        <option value="outros"></option>
      </datalist>
      <div id="vsClassificationWrap"><p class="hint-text">Carregando…</p></div>
      <div class="pagination">
        <button class="icon-btn" id="vsPrevPage" disabled aria-label="Página anterior">${Icon.chevronLeft}</button>
        <span id="vsPageInfo" class="hint-text"></span>
        <button class="icon-btn" id="vsNextPage" disabled aria-label="Próxima página">${Icon.chevronRight}</button>
      </div>
    </div>

    <div class="card">
      <h2>${Icon.target}Teste interno de reconhecimento</h2>
      <p class="hint-text">Sem câmera — usa uma imagem já do catálogo ou um upload manual como consulta e mostra os produtos mais parecidos. O score nunca usa nome/SKU, só o vetor visual.</p>
      <div id="vsTestPanel"><p class="hint-text">Carregando imagens disponíveis…</p></div>
      <div id="vsTestResults"></div>
    </div>

    <div class="card">
      <h2>${Icon.layers}Memória visual (aprendizado com scans reais)</h2>
      <p class="hint-text">Capturas de câmera confirmadas ou corrigidas por operadores. Só entram na comparação de reconhecimento quando aprovadas aqui. Fotos oficiais do catálogo continuam com prioridade — isso é só um complemento.</p>
      <div class="search-row">
        <select id="vsLearningStatus" aria-label="Filtrar por status">
          <option value="pending">Pendentes</option>
          <option value="validated">Validadas (em uso)</option>
          <option value="rejected">Rejeitadas</option>
          <option value="disabled">Desativadas</option>
        </select>
      </div>
      <div id="vsLearningWrap"><p class="hint-text">Carregando…</p></div>
    </div>`;

  await loadSummary(root);
  await loadClassification(root);
  await loadTestPanel(root);
  await loadLearningSamples(root);

  root.querySelector("#vsBtnProcess")!.addEventListener("click", () => void runProcessLoop(root));
  root.querySelector("#vsBtnResetErrors")!.addEventListener("click", async () => {
    try {
      const { reset } = await resetEmbeddingErrors();
      showToast(`${reset} embedding(s) com erro voltaram para pendente.`, "success");
      await loadSummary(root);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), "error");
    }
  });

  root.querySelector("#vsClassQuery")!.addEventListener("input", (e) => {
    classificationQuery = (e.target as HTMLInputElement).value;
    classificationPage = 0;
    void loadClassification(root);
  });
  root.querySelector("#vsOnlyUnclassified")!.addEventListener("change", (e) => {
    onlyUnclassified = (e.target as HTMLInputElement).checked;
    classificationPage = 0;
    void loadClassification(root);
  });
  root.querySelector("#vsPrevPage")!.addEventListener("click", () => {
    if (classificationPage > 0) {
      classificationPage--;
      void loadClassification(root);
    }
  });
  root.querySelector("#vsNextPage")!.addEventListener("click", () => {
    classificationPage++;
    void loadClassification(root);
  });

  const learningSelect = root.querySelector<HTMLSelectElement>("#vsLearningStatus")!;
  learningSelect.value = learningStatusFilter;
  learningSelect.addEventListener("change", () => {
    learningStatusFilter = learningSelect.value;
    void loadLearningSamples(root);
  });
}

async function loadSummary(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector("#vsSummary")!;
  try {
    const s = await getEmbeddingStatus();
    wrap.className = "";
    wrap.innerHTML = `
      <div class="summary-grid">
        <div class="summary-stat"><strong>${s.eligible_total}</strong><span>Imagens elegíveis</span></div>
        <div class="summary-stat"><strong>${s.ready}</strong><span>Prontas (embedding gerado)</span></div>
        <div class="summary-stat"><strong>${s.pending}</strong><span>Pendentes</span></div>
        <div class="summary-stat"><strong>${s.processing}</strong><span>Processando</span></div>
        <div class="summary-stat"><strong>${s.error}</strong><span>Erro</span></div>
      </div>`;
  } catch (err) {
    wrap.className = "";
    wrap.innerHTML = `<div class="error-box">Erro ao carregar status: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

async function runProcessLoop(root: HTMLElement): Promise<void> {
  const btn = root.querySelector("#vsBtnProcess") as HTMLButtonElement;
  const progress = root.querySelector("#vsProgress")!;
  btn.disabled = true;
  let guard = 0;
  try {
    while (guard < 500) {
      guard++;
      const result = await processEmbeddingBatch(5);
      const successes = result.processed.filter((p) => p.status === "success").length;
      const errors = result.processed.filter((p) => p.status === "error").length;
      const deduped = result.processed.filter((p) => p.status === "skipped_deduped").length;
      progress.innerHTML = `<p class="hint-text">Lote: ${successes} gerado(s), ${errors} erro(s), ${deduped} já preparada(s) · ${result.remainingPending} pendente(s) restante(s)</p>`;
      if (result.processed.length === 0 || result.remainingPending === 0) break;
    }
    showToast("Processamento concluído.", "success");
  } catch (err) {
    progress.innerHTML = `<div class="error-box">Erro no processamento: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  } finally {
    btn.disabled = false;
    await loadSummary(root);
    await loadTestPanel(root);
  }
}

async function loadClassification(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector("#vsClassificationWrap")!;
  try {
    const { rows, total } = await listVisualClassification({
      onlyUnclassified,
      query: classificationQuery,
      page: classificationPage,
      pageSize: PAGE_SIZE,
    });
    renderClassificationRows(wrap, rows);

    const pageInfo = root.querySelector("#vsPageInfo")!;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pageInfo.textContent = `Página ${classificationPage + 1} de ${totalPages} (${total} produtos)`;
    (root.querySelector("#vsPrevPage") as HTMLButtonElement).disabled = classificationPage === 0;
    (root.querySelector("#vsNextPage") as HTMLButtonElement).disabled = classificationPage + 1 >= totalPages;
  } catch (err) {
    wrap.innerHTML = `<div class="error-box">Erro ao carregar classificação: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function renderClassificationRows(wrap: Element, rows: VisualClassificationRow[]): void {
  if (rows.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum produto encontrado.</p>`;
    return;
  }

  wrap.innerHTML = rows
    .map(
      (p) => `
      <div class="product-card" data-product-row="${p.product_id}">
        <div class="product-card-top">
          <p class="product-card-name">${escapeHtml(p.product_name)}</p>
          <span class="sku-code">${escapeHtml(p.model_code || "-")}</span>
        </div>
        <div class="classification-fields">
          <label>Categoria
            <input type="text" data-field="category" data-product="${p.product_id}" value="${escapeHtml(p.category || "")}" placeholder="ex.: copo, garrafa" list="scanCategoryOptions" />
          </label>
          <label>Família visual
            <input type="text" data-field="visual_family_key" data-product="${p.product_id}" value="${escapeHtml(p.visual_family_key || "")}" placeholder="ex.: copo-life" />
          </label>
          <label>Capacidade (ml)
            <input type="number" data-field="capacity_ml" data-product="${p.product_id}" value="${p.capacity_ml ?? ""}" placeholder="ex.: 880" />
          </label>
          <label>Grupo de reconhecimento
            <input type="text" data-field="recognition_group" data-product="${p.product_id}" value="${escapeHtml(p.recognition_group || "")}" placeholder="ex.: copo-life" />
          </label>
        </div>
        <div class="variant-key-list">
          ${p.variants
            .map(
              (v) => `
            <div class="variant-key-row">
              <span class="sku-code">${escapeHtml(v.sku_code)}</span>
              <span>${escapeHtml(v.color || "(sem cor)")}</span>
              <input type="text" data-variant-key data-variant="${v.variant_id}" value="${escapeHtml(v.variant_key || "")}" placeholder="variant_key" />
              <span class="hint-text">${v.recognition_enabled_count} img. p/ reconhecimento</span>
            </div>`
            )
            .join("")}
        </div>
        <div class="review-actions">
          <button class="btn-secondary" data-save-classification="${p.product_id}">Salvar</button>
          <button class="btn-secondary" data-reprocess-product="${p.product_id}">${Icon.refresh}Reprocessar imagens deste produto</button>
        </div>
      </div>`
    )
    .join("");

  wrap.querySelectorAll<HTMLButtonElement>("[data-save-classification]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const productId = btn.dataset.saveClassification!;
      const card = wrap.querySelector(`[data-product-row="${productId}"]`)!;
      const categoryEl = card.querySelector<HTMLInputElement>('[data-field="category"]')!;
      const familyEl = card.querySelector<HTMLInputElement>('[data-field="visual_family_key"]')!;
      const capacityEl = card.querySelector<HTMLInputElement>('[data-field="capacity_ml"]')!;
      const groupEl = card.querySelector<HTMLInputElement>('[data-field="recognition_group"]')!;

      try {
        await updateProductClassification(productId, {
          category: categoryEl.value.trim() || null,
          visual_family_key: familyEl.value.trim() || null,
          capacity_ml: capacityEl.value.trim() ? Number(capacityEl.value) : null,
          recognition_group: groupEl.value.trim() || null,
        });
        for (const input of Array.from(card.querySelectorAll<HTMLInputElement>("[data-variant-key]"))) {
          await updateVariantKey(input.dataset.variant!, input.value.trim() || null);
        }
        showToast("Classificação salva.", "success");
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-reprocess-product]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const productId = btn.dataset.reprocessProduct!;
      const card = wrap.querySelector(`[data-product-row="${productId}"]`)!;
      const variantIds = Array.from(card.querySelectorAll<HTMLInputElement>("[data-variant-key]")).map((el) => el.dataset.variant!);
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.textContent = "Reprocessando…";
      try {
        let totalSuccess = 0;
        let totalError = 0;
        for (const variantId of variantIds) {
          const result = await processEmbeddingsForVariant(variantId);
          totalSuccess += result.processed.filter((p) => p.status === "success").length;
          totalError += result.processed.filter((p) => p.status === "error").length;
        }
        showToast(`${totalSuccess} imagem(ns) processada(s)${totalError ? `, ${totalError} erro(s)` : ""}.`, totalError ? "error" : "success");
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    });
  });
}

async function loadTestPanel(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector("#vsTestPanel")!;
  try {
    const images = await listReadyEmbeddingImages(50);
    if (images.length === 0) {
      wrap.innerHTML = `<p class="hint-text">Nenhuma imagem com embedding pronto ainda — processe um lote primeiro.</p>`;
      return;
    }
    wrap.innerHTML = `
      <label>Testar com uma imagem já do catálogo
        <select id="vsTestSelect">
          ${images.map((img) => `<option value="${img.product_image_id}">${escapeHtml(img.sku_code)} — ${escapeHtml(img.product_name)}</option>`).join("")}
        </select>
      </label>
      <button class="btn-primary" id="vsBtnTestCatalog">${Icon.scan}Testar com imagem do catálogo</button>
      <label class="dropzone small" style="margin-top:12px">
        <input type="file" id="vsTestUpload" accept="image/*" hidden />
        <span class="dz-icon">${Icon.upload}</span>
        <span>Ou teste com uma imagem externa (upload)</span>
      </label>`;

    root.querySelector("#vsBtnTestCatalog")!.addEventListener("click", async () => {
      const select = root.querySelector("#vsTestSelect") as HTMLSelectElement;
      await runTest(root, () => testQueryByProductImage(select.value, 5));
    });

    root.querySelector<HTMLInputElement>("#vsTestUpload")!.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const base64 = await fileToBase64(file);
      await runTest(root, () => testQueryByUpload(base64, 5));
    });
  } catch (err) {
    wrap.innerHTML = `<div class="error-box">Erro ao carregar imagens de teste: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function runTest(root: HTMLElement, run: () => Promise<{ query_source: string; used_pgvector: boolean; matches: SimilarityMatch[] }>): Promise<void> {
  const wrap = root.querySelector("#vsTestResults")!;
  wrap.innerHTML = `<p class="hint-text">Buscando produtos semelhantes…</p>`;
  try {
    const result = await run();
    if (result.matches.length === 0) {
      wrap.innerHTML = `<p class="hint-text">Nenhum resultado (nenhum embedding pronto no catálogo ainda).</p>`;
      return;
    }
    const rowsHtml = await Promise.all(
      result.matches.map(async (m) => {
        const url = m.storage_path ? await getSignedImageUrl(m.storage_path, 300) : null;
        return `
        <div class="product-card">
          <div class="product-card-top">
            ${url ? `<img class="thumb-img" src="${url}" alt="" />` : `<span class="thumb-placeholder">${Icon.imageOff}</span>`}
            <p class="product-card-name">${escapeHtml(m.product_name)}</p>
          </div>
          <div class="product-card-meta">
            <span class="sku-code">${escapeHtml(m.sku_code)}</span>
            <span>${escapeHtml(m.category || "-")}</span>
            <span>${escapeHtml(m.visual_family_key || "-")}</span>
            <span>${escapeHtml(m.variant_key || "-")}</span>
            <span>${m.capacity_ml ? m.capacity_ml + "ml" : "-"}</span>
          </div>
          <p class="hint-text">distância: ${m.distance.toFixed(4)} · score bruto: ${m.score_raw.toFixed(4)} · score normalizado: ${(m.score_normalized * 100).toFixed(1)}%</p>
        </div>`;
      })
    );
    wrap.innerHTML = `<p class="hint-text">Motor: ${result.used_pgvector ? "pgvector (índice)" : "comparação em JavaScript (fallback)"}</p>${rowsHtml.join("")}`;
  } catch (err) {
    wrap.innerHTML = `<div class="error-box">Erro no teste: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

const SOURCE_TYPE_LABEL: Record<string, string> = {
  official_catalog: "Foto oficial",
  confirmed_scan: "Scan confirmado",
  corrected_scan: "Scan corrigido",
  admin_upload: "Upload manual (admin)",
};

async function loadLearningSamples(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector("#vsLearningWrap")!;
  wrap.innerHTML = `<p class="hint-text">Carregando…</p>`;
  try {
    const { rows, total } = await listLearningSamples({ status: learningStatusFilter, pageSize: 30 });
    if (rows.length === 0) {
      wrap.innerHTML = `<p class="hint-text">Nenhuma referência ${learningStatusFilter === "pending" ? "pendente" : "neste status"}.</p>`;
      return;
    }

    const cardsHtml = await Promise.all(
      rows.map(async (s) => {
        const url = await getLearningSampleSignedUrl(s.storage_path, 300);
        return renderLearningSampleCard(s, url);
      })
    );
    wrap.innerHTML = `<p class="hint-text">${total} referência(s) neste status.</p>${cardsHtml.join("")}`;

    wrap.querySelectorAll<HTMLButtonElement>("[data-learning-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sampleId = btn.dataset.sampleId!;
        const status = btn.dataset.learningAction as "validated" | "rejected" | "disabled";
        try {
          await updateLearningSampleStatus(sampleId, status);
          showToast("Status da referência atualizado.", "success");
          await loadLearningSamples(root);
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), "error");
        }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div class="error-box">Erro ao carregar memória visual: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function renderLearningSampleCard(s: LearningSampleRow, imgUrl: string | null): string {
  const correctedInfo = s.corrected_by ? `<span class="hint-text">Corrigido por operador em ${new Date(s.corrected_at || s.created_at).toLocaleString("pt-BR")}</span>` : "";
  return `
    <div class="product-card">
      <div class="product-card-top">
        ${imgUrl ? `<img class="thumb-img" src="${imgUrl}" alt="" />` : `<span class="thumb-placeholder">${Icon.imageOff}</span>`}
        <p class="product-card-name">${escapeHtml(s.product_name ?? "")}</p>
      </div>
      <div class="product-card-meta">
        <span class="sku-code">${escapeHtml(s.sku_code ?? "")}</span>
        <span>${escapeHtml(s.category || "-")}</span>
        <span>${escapeHtml(s.family || "-")}</span>
        <span>${s.capacity_ml ? s.capacity_ml + "ml" : "-"}</span>
      </div>
      <p class="hint-text">
        ${SOURCE_TYPE_LABEL[s.source_type] ?? s.source_type} · confirmações: ${s.confirmation_count} · qualidade: ${s.quality_score != null ? (s.quality_score * 100).toFixed(0) + "%" : "-"}
        ${s.original_confidence != null ? ` · confiança original: ${(s.original_confidence * 100).toFixed(0)}%` : ""}
      </p>
      ${correctedInfo}
      <div class="review-actions">
        ${s.validation_status !== "validated" ? `<button class="btn-secondary" data-learning-action="validated" data-sample-id="${s.id}">Aprovar</button>` : ""}
        ${s.validation_status !== "rejected" ? `<button class="btn-secondary" data-learning-action="rejected" data-sample-id="${s.id}">Rejeitar</button>` : ""}
        ${s.validation_status !== "disabled" ? `<button class="btn-secondary" data-learning-action="disabled" data-sample-id="${s.id}">Desativar</button>` : ""}
      </div>
    </div>`;
}
