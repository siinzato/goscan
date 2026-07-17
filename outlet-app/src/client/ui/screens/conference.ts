import { escapeHtml, debounce } from "../../utils.ts";
import { matchItems, type MatchResult } from "../../matching.ts";
import { parseImagesLocally } from "../../ocr.ts";
import { searchSkuForPicker, type CatalogRow } from "../../catalogApi.ts";
import {
  startOrResumeConference,
  addItem,
  removeItem,
  finalize,
  subscribeSession,
  type Session,
} from "../../conferenceSession.ts";
import { exportItemsToXlsx } from "../../exporter.ts";

let pendingImages: { data: string; media_type: string; name: string }[] = [];
let candidates: MatchResult[] = [];
let unsubscribeSession: (() => void) | null = null;

function statusStamp(status: string): string {
  const map: Record<string, string> = {
    matched: `<span class="stamp ok">OK</span>`,
    matched_parcial: `<span class="stamp warn">Parcial</span>`,
    modelo_nao_encontrado: `<span class="stamp err">Modelo?</span>`,
    cor_nao_encontrada: `<span class="stamp warn">Cor?</span>`,
    sku_nao_cadastrado: `<span class="stamp err">Sem SKU</span>`,
    manual: `<span class="stamp warn">Manual</span>`,
  };
  return map[status] || `<span class="stamp warn">Revisar</span>`;
}

function syncStamp(state: string): string {
  const map: Record<string, string> = {
    saving: `<span class="stamp warn">Salvando…</span>`,
    saved: `<span class="stamp ok">Salvo</span>`,
    error: `<span class="stamp err">Erro ao salvar</span>`,
    pending_offline: `<span class="stamp warn">Pendente (offline)</span>`,
  };
  return map[state] || "";
}

export async function renderConference(root: HTMLElement): Promise<void> {
  unsubscribeSession?.();
  root.innerHTML = `<div class="screen-loading">Carregando conferência…</div>`;

  let session: Session;
  try {
    session = await startOrResumeConference();
  } catch (err) {
    root.innerHTML = `<div class="error-box">Erro ao iniciar conferência: ${escapeHtml(
      err instanceof Error ? err.message : String(err)
    )}</div>`;
    return;
  }

  root.innerHTML = `
    <section class="conference-screen">
      <div class="card">
        <h2>1. Envie os prints ou cole o texto</h2>
        <div class="input-mode-switch">
          <button class="mode-btn active" data-mode="imagens">📷 Prints (imagens)</button>
          <button class="mode-btn" data-mode="texto">✍️ Colar texto</button>
        </div>

        <div class="mode-panel active" id="mode-imagens">
          <label class="dropzone" id="dropzone">
            <input type="file" id="fileInput" accept="image/*" multiple hidden />
            <span class="dz-icon">＋</span>
            <span>Toque para escolher os prints</span>
            <span class="dz-hint">Vários arquivos de uma vez são aceitos</span>
          </label>
          <div id="imagePreviewList" class="image-preview-list"></div>
          <div class="warning-box">🔎 Leitura via OCR local no navegador (gratuita). Revise os itens antes de confirmar.</div>
          <button class="btn-primary btn-block" id="btnParseImages">Ler prints e gerar itens</button>
        </div>

        <div class="mode-panel" id="mode-texto">
          <p class="hint-text">Um item por linha: <code>Modelo - Cor - Quantidade</code> (quantidade opcional).</p>
          <label for="textInput" class="sr-only">Itens (um por linha)</label>
          <textarea id="textInput" rows="6" placeholder="Tote Mini - Preto - 3&#10;Joy Pro - Marrom - 1"></textarea>
          <button class="btn-primary btn-block" id="btnParseText">Gerar itens do texto</button>
        </div>
      </div>

      <div class="card">
        <h2>2. Revise antes de adicionar</h2>
        <div class="table-wrap" id="candidatesWrap">
          <p class="hint-text">Nenhum item gerado ainda.</p>
        </div>
        <div class="review-actions">
          <button class="btn-secondary" id="btnAddManualRow">+ Linha manual</button>
          <button class="btn-primary" id="btnConfirmAll" disabled>Adicionar tudo à conferência</button>
        </div>
      </div>

      <div class="card">
        <h2>3. Itens da conferência</h2>
        <div class="table-wrap" id="sessionWrap"></div>
        <div class="review-actions">
          <button class="btn-secondary" id="btnExport">Exportar Excel (.xlsx)</button>
          <button class="btn-primary" id="btnFinalize">Finalizar conferência</button>
        </div>
      </div>
    </section>`;

  wireInputModeSwitch(root);
  wireImageInput(root);
  wireTextInput(root);
  wireCandidateActions(root);

  document.getElementById("btnExport")!.addEventListener("click", () => {
    const current = sessionSnapshot();
    if (!current || current.items.length === 0) {
      alert("Não há itens para exportar.");
      return;
    }
    exportItemsToXlsx(current.items);
  });

  document.getElementById("btnFinalize")!.addEventListener("click", async () => {
    const btn = document.getElementById("btnFinalize") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Finalizando…";
    const outcome = await finalize();
    btn.disabled = false;
    btn.textContent = "Finalizar conferência";
    if (!outcome.ok) {
      alert(outcome.reason || "Não foi possível finalizar.");
      return;
    }
    alert(`Conferência finalizada: ${outcome.totals?.total_skus} SKUs, ${outcome.totals?.total_units} unidades.`);
    window.location.hash = "/historico";
  });

  let currentSession: Session | null = session;
  unsubscribeSession = subscribeSession((s) => {
    currentSession = s;
    if (s) renderSessionTable(root, s);
  });

  function sessionSnapshot(): Session | null {
    return currentSession;
  }
}

function wireInputModeSwitch(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      root.querySelectorAll(".mode-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      root.querySelector(`#mode-${btn.dataset.mode}`)?.classList.add("active");
    });
  });
}

function wireImageInput(root: HTMLElement): void {
  const dropzone = root.querySelector<HTMLLabelElement>("#dropzone")!;
  const fileInput = root.querySelector<HTMLInputElement>("#fileInput")!;
  const previewList = root.querySelector<HTMLDivElement>("#imagePreviewList")!;

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => handleFiles((e.target as HTMLInputElement).files));
  dropzone.addEventListener("dragover", (e) => e.preventDefault());
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer?.files ?? null);
  });

  function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    Array.from(fileList).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(",")[1];
        pendingImages.push({ data: base64, media_type: file.type, name: file.name });
        const img = document.createElement("img");
        img.src = String(reader.result);
        img.alt = file.name;
        previewList.appendChild(img);
      };
      reader.readAsDataURL(file);
    });
  }

  root.querySelector("#btnParseImages")!.addEventListener("click", async () => {
    if (pendingImages.length === 0) {
      alert("Selecione ao menos um print.");
      return;
    }
    const btn = root.querySelector("#btnParseImages") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const items = await parseImagesLocally(pendingImages, (i, total) => {
        btn.textContent = `Lendo print ${i + 1}/${total}…`;
      });
      if (items.length === 0) {
        alert('Não consegui identificar itens nos prints. Tente a opção "Colar texto".');
        return;
      }
      candidates = await matchItems(items);
      renderCandidatesTable(root);
    } catch (err) {
      alert("Erro ao ler prints: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      btn.textContent = "Ler prints e gerar itens";
      btn.disabled = false;
    }
  });
}

function wireTextInput(root: HTMLElement): void {
  root.querySelector("#btnParseText")!.addEventListener("click", async () => {
    const raw = (root.querySelector("#textInput") as HTMLTextAreaElement).value;
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const items = lines.map((line) => {
      const parts = line.split(" - ").map((p) => p.trim());
      let modelo = "";
      let cor = "";
      let quantidade = 1;
      if (parts.length >= 3) {
        modelo = parts[0];
        cor = parts[1];
        quantidade = parseInt(parts[2], 10) || 1;
      } else if (parts.length === 2) {
        modelo = parts[0];
        const m = parts[1].match(/^(.*?)(\d+)?$/);
        cor = m && m[1] ? m[1].trim() : parts[1];
        quantidade = m && m[2] ? parseInt(m[2], 10) : 1;
      } else {
        modelo = line;
      }
      return { modelo, cor, quantidade };
    });
    candidates = await matchItems(items);
    renderCandidatesTable(root);
  });
}

function renderCandidatesTable(root: HTMLElement): void {
  const wrap = root.querySelector("#candidatesWrap")!;
  const confirmBtn = root.querySelector("#btnConfirmAll") as HTMLButtonElement;
  confirmBtn.disabled = candidates.length === 0;

  if (candidates.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum item gerado ainda.</p>`;
    return;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Modelo</th><th>Cor</th><th>Qtd</th><th>SKU</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        ${candidates
          .map(
            (c, idx) => `
          <tr>
            <td><input type="text" aria-label="Modelo" value="${escapeHtml(c.modelo_bruto)}" data-field="modelo" data-idx="${idx}" /></td>
            <td><input type="text" aria-label="Cor" value="${escapeHtml(c.cor_bruta)}" data-field="cor" data-idx="${idx}" /></td>
            <td><input type="number" aria-label="Quantidade" min="1" value="${c.qtd}" data-field="qtd" data-idx="${idx}" style="width:60px" /></td>
            <td>
              <div class="sku-picker" data-idx="${idx}">
                <input type="text" class="sku-picker-input" aria-label="Buscar SKU" placeholder="buscar SKU…" value="${escapeHtml(c.sku_code || "")}" data-idx="${idx}" />
                <div class="sku-picker-results" hidden></div>
              </div>
            </td>
            <td>${statusStamp(c.status)}</td>
            <td><button class="row-remove" data-idx="${idx}" title="Remover" aria-label="Remover linha">✕</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  wrap.querySelectorAll<HTMLInputElement>('input[data-field="modelo"], input[data-field="cor"]').forEach((el) => {
    el.addEventListener("change", async (e) => {
      const idx = Number((e.target as HTMLElement).dataset.idx);
      const field = (e.target as HTMLElement).dataset.field as "modelo" | "cor";
      const value = (e.target as HTMLInputElement).value;
      const c = candidates[idx];
      const modelo = field === "modelo" ? value : c.modelo_bruto;
      const cor = field === "cor" ? value : c.cor_bruta;
      candidates[idx] = (await matchItems([{ modelo, cor, quantidade: c.qtd }]))[0];
      renderCandidatesTable(root);
    });
  });

  wrap.querySelectorAll<HTMLInputElement>('input[data-field="qtd"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number((e.target as HTMLElement).dataset.idx);
      candidates[idx].qtd = Number((e.target as HTMLInputElement).value) || 1;
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>(".row-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      candidates.splice(Number(btn.dataset.idx), 1);
      renderCandidatesTable(root);
    });
  });

  wireSkuPickers(wrap);
}

function wireSkuPickers(wrap: Element): void {
  wrap.querySelectorAll<HTMLInputElement>(".sku-picker-input").forEach((input) => {
    const idx = Number(input.dataset.idx);
    const resultsBox = input.parentElement!.querySelector<HTMLDivElement>(".sku-picker-results")!;

    const search = debounce(async (query: string) => {
      if (!query.trim()) {
        resultsBox.hidden = true;
        return;
      }
      const rows = await searchSkuForPicker(query, 15);
      renderResults(rows);
    }, 300);

    input.addEventListener("input", () => search(input.value));
    input.addEventListener("focus", () => {
      if (input.value.trim()) search(input.value);
    });

    function renderResults(rows: CatalogRow[]) {
      if (rows.length === 0) {
        resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum SKU encontrado.</div>`;
        resultsBox.hidden = false;
        return;
      }
      resultsBox.innerHTML = rows
        .map(
          (r) =>
            `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-product="${r.product_id}" data-sku="${escapeHtml(
              r.sku_code
            )}" data-produto="${escapeHtml(r.produto)}">${escapeHtml(r.produto)} — ${escapeHtml(r.cor || "")} <span class="sku-code">${escapeHtml(
              r.sku_code
            )}</span></button>`
        )
        .join("");
      resultsBox.hidden = false;
      resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((item) => {
        item.addEventListener("click", () => {
          candidates[idx] = {
            ...candidates[idx],
            product_id: item.dataset.product!,
            variant_id: item.dataset.variant!,
            sku_code: item.dataset.sku!,
            product_name: item.dataset.produto!,
            status: "matched",
          };
          const wrapEl = resultsBox.closest("#candidatesWrap")!;
          renderCandidatesTable(wrapEl.parentElement as HTMLElement);
        });
      });
    }
  });
}

function wireCandidateActions(root: HTMLElement): void {
  root.querySelector("#btnAddManualRow")!.addEventListener("click", () => {
    candidates.push({
      modelo_bruto: "",
      cor_bruta: "",
      qtd: 1,
      product_id: null,
      product_name: null,
      color_matched: null,
      variant_id: null,
      sku_code: null,
      status: "modelo_nao_encontrado",
    });
    renderCandidatesTable(root);
  });

  root.querySelector("#btnConfirmAll")!.addEventListener("click", async () => {
    const toAdd = [...candidates];
    candidates = [];
    renderCandidatesTable(root);
    const previewList = root.querySelector("#imagePreviewList")!;
    previewList.innerHTML = "";
    pendingImages = [];

    for (const c of toAdd) {
      await addItem({
        product_variant_id: c.variant_id,
        raw_model: c.modelo_bruto,
        raw_color: c.cor_bruta,
        quantity: c.qtd,
        match_status: c.status === "matched" || c.status === "matched_parcial" ? "matched" : c.variant_id ? "partial" : "unresolved",
        source: "text",
      });
    }
  });
}

function renderSessionTable(root: HTMLElement, session: Session): void {
  const wrap = root.querySelector("#sessionWrap");
  if (!wrap) return;
  if (session.items.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum item adicionado ainda.</p>`;
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Modelo</th><th>Cor</th><th>Qtd</th><th>SKU</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${session.items
          .map(
            (it) => `
          <tr>
            <td>${escapeHtml(it.raw_model)}</td>
            <td>${escapeHtml(it.raw_color)}</td>
            <td>${it.quantity}</td>
            <td class="sku-code">${escapeHtml(it.sku_code || "-")}</td>
            <td>${syncStamp(it.syncState)}</td>
            <td><button class="row-remove" data-ui-id="${it.uiId}" title="Remover" aria-label="Remover item">✕</button></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  wrap.querySelectorAll<HTMLButtonElement>(".row-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      void removeItem(btn.dataset.uiId!);
    });
  });
}
