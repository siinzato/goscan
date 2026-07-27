// EXPANSÃO GOSCAN — Conferência por Nota Fiscal (NF-e). Montado dentro de
// #nfeConferenceRoot por conference.ts (3º botão "Nota Fiscal"), como um
// fluxo totalmente separado do reconhecimento visual/matching Outlet — não
// reaproveita conferences/conference_items, tem suas próprias tabelas
// (invoice_receipts/invoice_receipt_items/receipt_counts).
import { escapeHtml, debounce, formatDateTime, describeError } from "../../utils.ts";
import { parseNfeXml, diagnoseNfeXml, type NfeXmlDiagnostics } from "../../nfeParser.ts";
import { normalizeKey, suggestBestMatch } from "../../nfeMatching.ts";
import { getAuthState, isAdmin, isManagerOrAdmin } from "../../auth.ts";
import {
  findReceiptByInvoiceKey,
  createReceiptFromParsed,
  resolveItemManually,
  startCounting,
  submitCount,
  getReceipt,
  finalizeReceipt,
  listReceiptHistory,
  deleteReceipt,
  fetchAllNormalProducts,
  type InvoiceReceipt,
  type InvoiceReceiptWithCreator,
  type InvoiceReceiptWithNames,
  type InvoiceReceiptItem,
  type ReceiptWithCounts,
} from "../../nfeApi.ts";
import { searchSkuForPicker, type CatalogRow } from "../../catalogApi.ts";
import { exportNfeReportToXlsx } from "../../exporter.ts";
import { RECEIPT_STATUS_LABEL, itemStamp, reportStatusStamp, itemTitle, itemCodeLabel, itemEanLabel } from "../../nfeReportFormat.ts";
import { startNfeKeyLookup, isNfeKeyLookupInFlight, type LookupHandle, type LookupProgress } from "../../nfeKeyLookup.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction } from "../confirmModal.ts";

type NfeView = "upload" | "prep" | "counting" | "result" | "history";

let view: NfeView = "upload";
let currentReceipt: InvoiceReceiptWithNames | null = null;
let currentItems: InvoiceReceiptItem[] = [];
let countingFilter: "all" | "pending" | "counted" = "all";
let countingQuery = "";
// Filtro do relatório final: os 5 estados pedidos + o atalho "divergências"
// (falta OU sobra OU não conferido — nunca inclui OK nem "não localizado").
type ResultFilter = "all" | "ok" | "missing" | "surplus" | "pending" | "divergent";
let resultFilter: ResultFilter = "all";
let resultQuery = "";
const recountingIds = new Set<string>();
let historyList: ReceiptWithCounts[] = [];

/** Decide de onde retomar uma nota já existente — nunca força voltar pra preparação se já não há pendências. */
function decideViewForReceipt(receipt: InvoiceReceipt, items: InvoiceReceiptItem[]): NfeView {
  if (receipt.status === "completed" || receipt.status === "with_divergences") return "result";
  if (items.some((i) => i.product_variant_id === null)) return "prep";
  return "counting";
}

export async function renderNfeConference(root: HTMLElement): Promise<void> {
  switch (view) {
    case "upload":
      renderUploadView(root);
      break;
    case "prep":
      await renderPrepView(root);
      break;
    case "counting":
      renderCountingView(root);
      break;
    case "result":
      renderResultView(root);
      break;
    case "history":
      await renderHistoryView(root);
      break;
  }
}

function goTo(root: HTMLElement, next: NfeView): void {
  view = next;
  void renderNfeConference(root);
}

// ---------------------------------------------------------------------------
// 1. Upload
// ---------------------------------------------------------------------------
function renderUploadView(root: HTMLElement): void {
  root.innerHTML = `
    <div class="card">
      <h2>Importar nova Nota Fiscal</h2>
      <p class="hint-text">Envie o arquivo XML da NF-e ou cole o conteúdo completo — os produtos são interpretados automaticamente para preparar a conferência.</p>

      <label class="dropzone small">
        <input type="file" id="nfeFileInput" accept=".xml,text/xml" hidden />
        <span class="dz-icon">${Icon.fileUp}</span>
        <span>Selecionar arquivo XML</span>
      </label>

      <p class="hint-text" style="text-align:center;margin:12px 0">ou</p>

      <label for="nfeXmlPaste" class="sr-only">Colar conteúdo XML da NF-e</label>
      <textarea id="nfeXmlPaste" rows="6" placeholder="Cole aqui o conteúdo XML completo da NF-e (começando com <?xml ... ou <nfeProc...)…"></textarea>
      <button class="btn-primary btn-block" id="btnProcessXml">Processar XML</button>

      <div id="nfeUploadStatus" role="status" aria-live="polite"></div>
    </div>

    <div class="card">
      <h2>Buscar NF-e pela chave de acesso</h2>
      <p class="hint-text">Informe os 44 dígitos da chave de acesso. O GoScan verifica primeiro se esta nota já foi importada e, se ainda não, consulta e baixa o XML automaticamente.</p>
      <label for="nfeKeySearch" class="sr-only">Chave de acesso da NF-e (44 dígitos)</label>
      <div class="search-row">
        <input type="text" id="nfeKeySearch" inputmode="numeric" autocomplete="off" placeholder="Chave de acesso (44 dígitos)…" />
      </div>
      <p class="hint-text" id="nfeKeyCounter" style="text-align:right;margin:4px 0 0">0/44</p>
      <button class="btn-primary btn-block" id="btnSearchKey" disabled>${Icon.barcode}Buscar NF-e</button>
      <button class="btn-secondary btn-block" id="btnCancelKeySearch" hidden>Cancelar consulta</button>
      <div id="nfeKeySearchStatus" role="status" aria-live="polite"></div>
    </div>

    <div class="card">
      <button class="btn-secondary btn-block" id="btnOpenHistory">${Icon.history}Histórico de Notas</button>
    </div>`;

  const statusEl = root.querySelector<HTMLElement>("#nfeUploadStatus")!;
  const fileInput = root.querySelector<HTMLInputElement>("#nfeFileInput")!;
  const dropzone = root.querySelector<HTMLLabelElement>(".dropzone")!;
  const pasteArea = root.querySelector<HTMLTextAreaElement>("#nfeXmlPaste")!;

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const xml = await file.text();
    await processXmlText(xml, statusEl, root);
    fileInput.value = "";
  });

  root.querySelector("#btnProcessXml")!.addEventListener("click", async () => {
    const xml = pasteArea.value.trim();
    if (!xml) {
      showToast("Cole o conteúdo do XML antes de processar.", "error");
      return;
    }
    await processXmlText(xml, statusEl, root);
  });

  wireKeySearchCard(root);

  root.querySelector("#btnOpenHistory")!.addEventListener("click", () => goTo(root, "history"));
}

/** Mesma apresentação para os dois caminhos que podem encontrar uma NF já existente a partir da chave (checagem local e sinal ALREADY_IMPORTED da Edge Function). */
function renderAlreadyImported(root: HTMLElement, statusEl: HTMLElement, existing: InvoiceReceiptWithCreator): void {
  statusEl.innerHTML = `
    <div class="warning-box">${Icon.info} Esta Nota Fiscal já foi importada.</div>
    <div class="product-card-meta">
      <span>NF-e: ${escapeHtml(existing.invoice_number || "-")}</span>
      <span>Fornecedor: ${escapeHtml(existing.supplier_name || "-")}</span>
      <span>Status: ${escapeHtml(RECEIPT_STATUS_LABEL[existing.status])}</span>
    </div>
    <button class="btn-primary btn-block" id="btnOpenByKey">Abrir conferência</button>`;
  statusEl.querySelector("#btnOpenByKey")!.addEventListener("click", async () => {
    const { receipt, items } = await getReceipt(existing.id);
    currentReceipt = receipt;
    currentItems = items;
    goTo(root, decideViewForReceipt(receipt, items));
  });
}

/**
 * Busca pela chave de acesso (44 dígitos): primeiro localmente (nunca chama
 * a API externa se a NF já estiver no GoScan), e só então consulta o Meu
 * Danfe via Edge Function — com polling seguro enquanto WAITING/SEARCHING.
 * Ao obter o XML, entrega para processXmlText (MESMO caminho do upload
 * manual/colagem — nenhuma lógica de criação de conferência duplicada aqui).
 */
function wireKeySearchCard(root: HTMLElement): void {
  const keyInput = root.querySelector<HTMLInputElement>("#nfeKeySearch")!;
  const counterEl = root.querySelector<HTMLElement>("#nfeKeyCounter")!;
  const searchBtn = root.querySelector<HTMLButtonElement>("#btnSearchKey")!;
  const cancelBtn = root.querySelector<HTMLButtonElement>("#btnCancelKeySearch")!;
  const statusEl = root.querySelector<HTMLElement>("#nfeKeySearchStatus")!;

  let activeHandle: LookupHandle | null = null;

  function refreshButtonState(): void {
    searchBtn.disabled = keyInput.value.length !== 44 || isNfeKeyLookupInFlight();
  }

  keyInput.addEventListener("input", () => {
    // Só dígitos, sempre — aceita colagem com espaços/pontos/traços, corta em 44.
    const digits = keyInput.value.replace(/\D/g, "").slice(0, 44);
    if (digits !== keyInput.value) keyInput.value = digits;
    counterEl.textContent = `${digits.length}/44`;
    refreshButtonState();
  });

  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !searchBtn.disabled) void runKeySearch();
  });

  searchBtn.addEventListener("click", () => void runKeySearch());

  cancelBtn.addEventListener("click", () => {
    activeHandle?.cancel();
    activeHandle = null;
  });

  async function renderLookupProgress(progress: LookupProgress): Promise<void> {
    if (!root.isConnected) return; // tela trocada enquanto a consulta rodava — nunca atualiza DOM morto.
    switch (progress.phase) {
      case "validating":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Validando chave de acesso…</p>`;
        return;
      case "requesting":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Solicitando NF-e…</p>`;
        return;
      case "waiting":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Consultando NF-e — tentativa ${progress.attempt} de ${progress.maxAttempts}…</p>`;
        return;
      case "still_processing":
        statusEl.innerHTML = `<p class="warning-box">${Icon.info}${escapeHtml(progress.message || "")}</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "not_found":
        statusEl.innerHTML = `<p class="error-box">${escapeHtml(progress.message || "NF-e não encontrada.")}</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "error":
        statusEl.innerHTML = `<p class="error-box">${escapeHtml(progress.message || "Não foi possível consultar esta NF-e.")}</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "cancelled":
        statusEl.innerHTML = `<p class="hint-text">Consulta cancelada.</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "already_imported": {
        cancelBtn.hidden = true;
        // Confirmado pela Edge Function, mas a visão final continua vindo do
        // caminho local de sempre (mesma RLS do resto do app) — pode ter
        // sido importada por OUTRO operador enquanto esta consulta rodava.
        let justImported: InvoiceReceiptWithCreator | null = null;
        try {
          justImported = await findReceiptByInvoiceKey(progress.accessKey!);
        } catch (err) {
          statusEl.innerHTML = `<p class="error-box">Erro ao buscar: ${escapeHtml(describeError(err))}</p>`;
          refreshButtonState();
          return;
        }
        if (justImported) {
          renderAlreadyImported(root, statusEl, justImported);
        } else {
          statusEl.innerHTML = `<p class="warning-box">${Icon.info} Esta NF-e já foi importada por outro operador. Peça a um gerente/administrador para localizá-la no Histórico.</p>`;
        }
        refreshButtonState();
        return;
      }
      case "done":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Baixando XML…</p>`;
        await processXmlText(progress.xml!, statusEl, root);
        refreshButtonState();
        return;
    }
  }

  async function runKeySearch(): Promise<void> {
    if (isNfeKeyLookupInFlight()) return; // trava contra clique duplo / operação concorrente
    const key = keyInput.value;
    if (key.length !== 44) return;

    searchBtn.disabled = true;
    cancelBtn.hidden = true;
    statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Validando chave de acesso…</p>`;

    // 1) Checagem local primeiro — sem custo, sem chamar o Meu Danfe.
    let existing: InvoiceReceiptWithCreator | null;
    try {
      existing = await findReceiptByInvoiceKey(key);
    } catch (err) {
      statusEl.innerHTML = `<p class="error-box">Erro ao buscar: ${escapeHtml(describeError(err))}</p>`;
      refreshButtonState();
      return;
    }
    if (existing) {
      renderAlreadyImported(root, statusEl, existing);
      refreshButtonState();
      return;
    }

    // 2) Não está localmente — consulta o Meu Danfe via Edge Function.
    cancelBtn.hidden = false;
    activeHandle = startNfeKeyLookup(key, (progress) => void renderLookupProgress(progress));
  }

  refreshButtonState();
}

/** Painel de debug técnico — só pra admin, nunca escondido atrás de um "NF não encontrada" genérico. */
function renderXmlDebugPanel(diag: NfeXmlDiagnostics): string {
  return `
    <details class="scan-diag-panel" style="margin-top:10px">
      <summary>Debug técnico (admin)</summary>
      <dl>
        <dt>Arquivo lido</dt><dd>${diag.arquivoLido ? "SIM" : "NÃO"}</dd>
        <dt>XML válido</dt><dd>${diag.xmlValido ? "SIM" : "NÃO"}</dd>
        <dt>Root</dt><dd>${escapeHtml(diag.root ?? "-")}</dd>
        <dt>NFe encontrada</dt><dd>${diag.nfeEncontrada ? "SIM" : "NÃO"}</dd>
        <dt>infNFe encontrada</dt><dd>${diag.infNFeEncontrada ? "SIM" : "NÃO"}</dd>
        <dt>Chave</dt><dd>${escapeHtml(diag.chave ?? "-")}</dd>
        <dt>Número</dt><dd>${escapeHtml(diag.numero ?? "-")}</dd>
        <dt>Itens &lt;det&gt; encontrados</dt><dd>${diag.itensDet}</dd>
        <dt>Etapa</dt><dd>${escapeHtml(diag.etapa ?? "-")}</dd>
        <dt>Erro técnico</dt><dd>${escapeHtml(diag.erro ?? "nenhum")}</dd>
      </dl>
    </details>`;
}

async function processXmlText(xml: string, statusEl: HTMLElement, root: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  const debugHtml = isAdmin(profile) ? renderXmlDebugPanel(diagnoseNfeXml(xml)) : "";

  statusEl.innerHTML = `<p class="hint-text">Lendo XML…</p>${debugHtml}`;

  let parsed;
  try {
    parsed = parseNfeXml(xml);
  } catch (err) {
    statusEl.innerHTML = `<p class="error-box">${escapeHtml(describeError(err))}</p>${debugHtml}`;
    return;
  }

  statusEl.innerHTML = `<p class="hint-text">Verificando se esta nota já foi importada…</p>${debugHtml}`;
  let existing;
  try {
    existing = await findReceiptByInvoiceKey(parsed.invoice_key);
  } catch (err) {
    statusEl.innerHTML = `<p class="error-box">Erro ao verificar NF: ${escapeHtml(describeError(err))}</p>${debugHtml}`;
    return;
  }

  if (existing) {
    statusEl.innerHTML = `
      <div class="warning-box">${Icon.info} Esta Nota Fiscal já foi importada.</div>
      <div class="product-card-meta">
        <span>Status: ${escapeHtml(RECEIPT_STATUS_LABEL[existing.status])}</span>
        <span>Importada em: ${formatDateTime(existing.created_at)}</span>
        <span>Responsável: ${escapeHtml(existing.created_by_name || "-")}</span>
      </div>
      <button class="btn-primary btn-block" id="btnOpenExisting">Abrir conferência existente</button>
      ${debugHtml}`;
    statusEl.querySelector("#btnOpenExisting")!.addEventListener("click", async () => {
      const { receipt, items } = await getReceipt(existing!.id);
      currentReceipt = receipt;
      currentItems = items;
      goTo(root, decideViewForReceipt(receipt, items));
    });
    return;
  }

  statusEl.innerHTML = `<p class="hint-text">NF-e reconhecida — ${parsed.items.length} item(ns) encontrados. Processando produtos…</p>${debugHtml}`;
  try {
    const { receipt, items } = await createReceiptFromParsed(parsed, xml);
    // Recibo recém-criado: ninguém finalizou ainda, então os nomes ficam
    // nulos até a próxima leitura via getReceipt (que já faz o join).
    currentReceipt = { ...receipt, created_by_name: null, finished_by_name: null };
    currentItems = items;
    goTo(root, "prep");
    showToast("NF-e importada. Resolva as pendências antes de iniciar a conferência.", "success");
  } catch (err) {
    statusEl.innerHTML = `<p class="error-box">Erro ao criar conferência: ${escapeHtml(describeError(err))}</p>${debugHtml}`;
  }
}

// ---------------------------------------------------------------------------
// 2. Preparação — resolver pendências antes de iniciar a contagem
// ---------------------------------------------------------------------------

// Sugestões dispensadas pelo operador ("Não" na pergunta "Esse produto é X?")
// não devem reaparecer a cada re-render da mesma tela de preparação.
const dismissedSuggestions = new Set<string>();

async function renderPrepView(root: HTMLElement): Promise<void> {
  const receipt = currentReceipt!;
  const pending = currentItems.filter((i) => i.product_variant_id === null);
  const linked = currentItems.length - pending.length;

  root.innerHTML = `
    <div class="card">
      <button class="btn-secondary" id="btnBackToUpload">${Icon.chevronLeft}Outra nota</button>
      <h2>Preparação da Conferência</h2>
      <div class="product-card-meta">
        <span>NF-e: ${escapeHtml(receipt.invoice_number || "-")}</span>
        <span>Fornecedor: ${escapeHtml(receipt.supplier_name || "-")}</span>
        <span>Emissão: ${formatDateTime(receipt.issued_at)}</span>
      </div>
      <div class="active-conference-stats">
        <span class="active-conference-stat">${currentItems.length}<span>Itens encontrados</span></span>
        <span class="active-conference-stat">${linked}<span>Vinculados</span></span>
        <span class="active-conference-stat">${pending.length}<span>Pendentes</span></span>
      </div>
    </div>

    ${
      pending.length > 0
        ? `<div class="card">
            <h2>Resolver pendências</h2>
            <p class="hint-text">Estes itens da NF não têm um produto normal correspondente exato por SKU ou EAN. Confirme a sugestão (quando houver) ou busque manualmente.</p>
            <div class="product-card-list" id="pendingList">
              ${pending.map(renderPendingItemCard).join("")}
            </div>
          </div>`
        : ""
    }

    <div class="card">
      <button class="btn-accent btn-block" id="btnStartCounting" ${pending.length > 0 ? "disabled" : ""}>Iniciar Conferência</button>
      ${pending.length > 0 ? `<p class="hint-text">Vincule todas as pendências acima para liberar o início da conferência.</p>` : ""}
    </div>`;

  root.querySelector("#btnBackToUpload")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    goTo(root, "upload");
  });

  wirePendingItemPickers(root);

  if (pending.length > 0) {
    void renderPendingSuggestions(root, pending);
  }

  root.querySelector("#btnStartCounting")!.addEventListener("click", async () => {
    const btn = root.querySelector("#btnStartCounting") as HTMLButtonElement;
    btn.disabled = true;
    try {
      await startCounting(receipt.id);
      currentReceipt = { ...receipt, status: "in_progress" };
      goTo(root, "counting");
    } catch (err) {
      showToast("Erro ao iniciar conferência: " + (describeError(err)), "error");
      btn.disabled = false;
    }
  });
}

/**
 * Sugestão automática por semelhança de nome ("Esse produto é X?") — nunca
 * vincula sozinha, só pergunta. Busca o catálogo de produtos normais UMA vez
 * pra todos os itens pendentes desta tela (não uma query por item).
 */
async function renderPendingSuggestions(root: HTMLElement, pending: InvoiceReceiptItem[]): Promise<void> {
  let candidates;
  try {
    candidates = await fetchAllNormalProducts();
  } catch {
    return; // sugestão é só um atalho — se falhar, a busca manual continua disponível normalmente.
  }

  for (const item of pending) {
    if (dismissedSuggestions.has(item.id) || !item.description) continue;
    const suggestion = suggestBestMatch(item.description, candidates);
    if (!suggestion) continue;

    const container = root.querySelector<HTMLElement>(`#pendingSuggestion-${item.id}`);
    if (!container) continue;
    container.innerHTML = `
      <div class="warning-box">
        Esse produto é <strong>${escapeHtml(suggestion.candidate.produto)}</strong>
        <span class="sku-code">${escapeHtml(suggestion.candidate.sku_code)}</span>?
      </div>
      <div class="review-actions" style="margin-top:0">
        <button type="button" class="btn-primary" data-suggestion-yes="${item.id}">Sim, vincular</button>
        <button type="button" class="btn-secondary" data-suggestion-no="${item.id}">Não, buscar manualmente</button>
      </div>`;

    container.querySelector(`[data-suggestion-yes="${item.id}"]`)!.addEventListener("click", async () => {
      const memorize = (root.querySelector(`[data-pending-memorize="${item.id}"]`) as HTMLInputElement)?.checked ?? false;
      try {
        const updated = await resolveItemManually(item.id, suggestion.candidate.variant_id, {
          memorize,
          invoiceProductCode: item.invoice_product_code,
          ean: item.ean,
        });
        currentItems = currentItems.map((i) => (i.id === item.id ? { ...i, ...updated, sku_code: suggestion.candidate.sku_code, produto: suggestion.candidate.produto } : i));
        showToast(`Vinculado a "${suggestion.candidate.produto}".`, "success");
        void renderNfeConference(root);
      } catch (err) {
        showToast("Erro ao vincular: " + (describeError(err)), "error");
      }
    });
    container.querySelector(`[data-suggestion-no="${item.id}"]`)!.addEventListener("click", () => {
      dismissedSuggestions.add(item.id);
      container.innerHTML = "";
    });
  }
}

function renderPendingItemCard(it: InvoiceReceiptItem): string {
  return `
    <div class="pending-item-card" data-pending-item="${it.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(it.description || "(sem descrição)")}</p>
      </div>
      <div class="product-card-meta">
        <span class="sku-code">Código NF: ${escapeHtml(it.invoice_product_code || "-")}</span>
        ${it.ean ? `<span>EAN ${escapeHtml(it.ean)}</span>` : ""}
      </div>
      <div id="pendingSuggestion-${it.id}"></div>
      <div class="sku-picker" data-pending-idx="${it.id}">
        <input type="text" class="sku-picker-input" aria-label="Buscar produto normal" placeholder="Buscar por palavra-chave do nome, SKU ou EAN…" data-pending-input="${it.id}" />
        <div class="sku-picker-results" hidden></div>
      </div>
      <label class="hint-text" style="display:flex;align-items:center;gap:6px;margin-top:6px">
        <input type="checkbox" data-pending-memorize="${it.id}" /> Memorizar associação para próximas notas
      </label>
    </div>`;
}

function wirePendingItemPickers(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>("[data-pending-input]").forEach((input) => {
    const itemId = input.dataset.pendingInput!;
    const resultsBox = input.parentElement!.querySelector<HTMLDivElement>(".sku-picker-results")!;

    const search = debounce(async (q: string) => {
      if (!q.trim()) {
        resultsBox.hidden = true;
        return;
      }
      const rows = await searchSkuForPicker(q, 15, "normal");
      renderResults(rows);
    }, 300);
    input.addEventListener("input", () => search(input.value));

    function renderResults(rows: CatalogRow[]): void {
      if (rows.length === 0) {
        resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum produto normal encontrado.</div>`;
        resultsBox.hidden = false;
        return;
      }
      resultsBox.innerHTML = rows
        .map(
          (r) =>
            `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-produto="${escapeHtml(r.produto)}">${escapeHtml(
              r.produto
            )} <span class="sku-code">${escapeHtml(r.sku_code)}</span></button>`
        )
        .join("");
      resultsBox.hidden = false;
      resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const item = currentItems.find((i) => i.id === itemId)!;
          const memorize = (root.querySelector(`[data-pending-memorize="${itemId}"]`) as HTMLInputElement)?.checked ?? false;
          try {
            const updated = await resolveItemManually(itemId, btn.dataset.variant!, {
              memorize,
              invoiceProductCode: item.invoice_product_code,
              ean: item.ean,
            });
            currentItems = currentItems.map((i) => (i.id === itemId ? { ...i, ...updated, sku_code: item.sku_code, produto: btn.dataset.produto! } : i));
            showToast(`Vinculado a "${btn.dataset.produto}".`, "success");
            void renderNfeConference(root);
          } catch (err) {
            showToast("Erro ao vincular: " + (describeError(err)), "error");
          }
        });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Contagem cega — NUNCA mostra expected_quantity/NF aqui.
// ---------------------------------------------------------------------------
function renderCountingView(root: HTMLElement): void {
  const receipt = currentReceipt!;

  root.innerHTML = `
    <div class="card">
      <h2>Contagem Física</h2>
      <div class="product-card-meta">
        <span>NF-e: ${escapeHtml(receipt.invoice_number || "-")}</span>
        <span>Fornecedor: ${escapeHtml(receipt.supplier_name || "-")}</span>
      </div>
      <p class="hint-text">Conte o que realmente foi recebido — a quantidade da nota só aparece depois de finalizar.</p>

      <label for="nfeEanInput" class="sr-only">Digitar ou ler EAN</label>
      <div class="search-row search-row-icon">
        ${Icon.barcode}
        <input type="text" id="nfeEanInput" placeholder="Digitar ou ler EAN (bipagem +1)…" />
      </div>

      <label for="nfeCountingSearch" class="sr-only">Buscar por nome, SKU ou EAN</label>
      <input type="text" id="nfeCountingSearch" placeholder="Buscar por nome, SKU ou EAN…" value="${escapeHtml(countingQuery)}" style="margin-top:8px" />

      <div class="input-mode-switch" style="margin-top:8px">
        <button class="mode-btn ${countingFilter === "all" ? "active" : ""}" data-count-filter="all">Todos</button>
        <button class="mode-btn ${countingFilter === "pending" ? "active" : ""}" data-count-filter="pending">Pendentes</button>
        <button class="mode-btn ${countingFilter === "counted" ? "active" : ""}" data-count-filter="counted">Conferidos</button>
      </div>
    </div>

    <div class="card">
      <div id="nfeCountingList"></div>
    </div>

    <div class="card">
      <button class="btn-accent btn-block" id="btnFinalizeReceipt">Finalizar Conferência</button>
    </div>`;

  renderCountingList(root);

  const eanInput = root.querySelector<HTMLInputElement>("#nfeEanInput")!;
  eanInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const code = normalizeKey(eanInput.value);
    eanInput.value = "";
    if (!code) return;
    const match = currentItems.find((i) => i.ean && normalizeKey(i.ean) === code);
    if (!match) {
      showToast("EAN não encontrado nesta nota.", "error");
      return;
    }
    const nextQty = (match.physical_quantity ?? 0) + 1;
    await confirmCount(root, match.id, nextQty);
  });

  const searchInput = root.querySelector<HTMLInputElement>("#nfeCountingSearch")!;
  const debouncedSearch = debounce((value: string) => {
    countingQuery = value;
    renderCountingList(root);
  }, 250);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelectorAll<HTMLButtonElement>("[data-count-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      countingFilter = btn.dataset.countFilter as "all" | "pending" | "counted";
      renderCountingList(root);
      root.querySelectorAll("[data-count-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  root.querySelector("#btnFinalizeReceipt")!.addEventListener("click", async () => {
    // Breakdown real (nunca "finalizar silenciosamente" com pendências escondidas).
    const totalItens = currentItems.length;
    const conferidos = currentItems.filter((i) => i.physical_quantity !== null).length;
    const pendentes = totalItens - conferidos;
    const breakdown = `NF: ${receipt.invoice_number || "-"} · Itens da NF: ${totalItens} · Itens conferidos: ${conferidos} · Pendentes: ${pendentes}`;
    const message =
      pendentes > 0
        ? `⚠️ Existem produtos ainda não conferidos. ${breakdown}. A quantidade da NF será revelada e comparada com a contagem física — itens não contados aparecem como "Não conferido" no relatório.`
        : `${breakdown}. A quantidade da NF será revelada e comparada com a contagem física.`;

    const confirmed = await confirmAction({
      title: "Finalizar Conferência?",
      message,
      confirmLabel: "Finalizar Conferência",
    });
    if (!confirmed) return;

    const btn = root.querySelector("#btnFinalizeReceipt") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Finalizando…";
    try {
      const { receipt: updated, items } = await finalizeReceipt(receipt.id);
      currentReceipt = updated;
      currentItems = items;
      goTo(root, "result");
    } catch (err) {
      showToast("Erro ao finalizar: " + (describeError(err)), "error");
      btn.disabled = false;
      btn.textContent = "Finalizar Conferência";
    }
  });
}

function filteredCountingItems(): InvoiceReceiptItem[] {
  const q = normalizeKey(countingQuery);
  return currentItems.filter((it) => {
    if (countingFilter === "pending" && it.status !== "pending" && it.status !== "unlinked") return false;
    if (countingFilter === "counted" && it.status !== "counted") return false;
    if (!q) return true;
    const haystack = normalizeKey(`${it.produto || ""} ${it.description || ""} ${it.sku_code || ""} ${it.invoice_product_code || ""} ${it.ean || ""}`);
    return haystack.includes(q);
  });
}

function renderCountingList(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>("#nfeCountingList")!;
  const rows = filteredCountingItems();
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum item encontrado.</p></div>`;
    return;
  }

  wrap.innerHTML = `<div class="product-card-list">${rows.map(renderCountingCard).join("")}</div>`;

  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-dec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = wrap.querySelector<HTMLInputElement>(`[data-qty-input="${btn.dataset.qtyDec}"]`)!;
      input.value = String(Math.max(0, Number(input.value || 0) - 1));
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-inc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = wrap.querySelector<HTMLInputElement>(`[data-qty-input="${btn.dataset.qtyInc}"]`)!;
      input.value = String(Number(input.value || 0) + 1);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-confirm-count]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.confirmCount!;
      const input = wrap.querySelector<HTMLInputElement>(`[data-qty-input="${itemId}"]`)!;
      await confirmCount(root, itemId, Math.max(0, Number(input.value) || 0));
    });
  });
}

async function confirmCount(root: HTMLElement, itemId: string, quantity: number): Promise<void> {
  try {
    const updated = await submitCount(itemId, quantity);
    currentItems = currentItems.map((i) => (i.id === itemId ? { ...i, ...updated } : i));
    renderCountingList(root);
    showToast("Contagem salva.", "success");
  } catch (err) {
    showToast("Erro ao salvar contagem: " + (describeError(err)), "error");
  }
}

function renderCountingCard(it: InvoiceReceiptItem): string {
  return `
    <div class="product-card">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(itemTitle(it))}</p>
        ${itemStamp(it.status)}
      </div>
      <div class="product-card-meta">
        <span class="sku-code">${escapeHtml(itemCodeLabel(it))}</span>
        ${it.ean ? `<span>EAN ${escapeHtml(it.ean)}</span>` : ""}
      </div>
      <div class="product-card-bottom">
        <div class="qty-stepper">
          <button type="button" data-qty-dec="${it.id}" aria-label="Diminuir quantidade">${Icon.minus}</button>
          <input type="number" min="0" inputmode="numeric" value="${it.physical_quantity ?? 0}" data-qty-input="${it.id}" aria-label="Quantidade física" />
          <button type="button" data-qty-inc="${it.id}" aria-label="Aumentar quantidade">${Icon.plus}</button>
        </div>
        <button class="btn-primary" data-confirm-count="${it.id}">Confirmar item</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// 4. Resultado / Relatório de Conferência — só aqui a quantidade da NF é
// revelada. Encerramento definitivo: fora de "Recontar" (ação explícita,
// preserva histórico em receipt_counts), nada aqui volta pra contagem cega.
// ---------------------------------------------------------------------------
const RESULT_FILTER_LABEL: Record<ResultFilter, string> = {
  all: "Todos",
  ok: "OK",
  missing: "Faltas",
  surplus: "Sobras",
  pending: "Não conferidos",
  divergent: "Divergências",
};

/** Formata like "91,04" (vírgula, 2 casas) — nunca inventa, sempre a partir da razão real ok/conferidos. */
function formatConformity(rate: number): string {
  return (Math.round(rate * 10000) / 100).toFixed(2).replace(".", ",");
}

function formatCnpj(cnpj: string | null): string {
  if (!cnpj) return "-";
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length !== 14) return cnpj;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function filteredResultItems(): InvoiceReceiptItem[] {
  const q = normalizeKey(resultQuery);
  return currentItems.filter((it) => {
    if (resultFilter === "ok" && it.status !== "ok") return false;
    if (resultFilter === "missing" && it.status !== "missing") return false;
    if (resultFilter === "surplus" && it.status !== "surplus") return false;
    if (resultFilter === "pending" && it.status !== "pending" && it.status !== "unlinked") return false;
    if (resultFilter === "divergent" && it.status === "ok") return false;
    if (!q) return true;
    const haystack = normalizeKey(`${itemTitle(it)} ${itemCodeLabel(it)} ${itemEanLabel(it)}`);
    return haystack.includes(q);
  });
}

function renderResultView(root: HTMLElement): void {
  const receipt = currentReceipt!;

  const ok = currentItems.filter((i) => i.status === "ok").length;
  const missing = currentItems.filter((i) => i.status === "missing").length;
  const surplus = currentItems.filter((i) => i.status === "surplus").length;
  const notCounted = currentItems.filter((i) => i.status === "pending" || i.status === "unlinked").length;
  const counted = ok + missing + surplus;
  const conformityRate = counted > 0 ? ok / counted : 0;
  const totalExpected = currentItems.reduce((acc, i) => acc + i.expected_quantity, 0);
  const totalPhysical = currentItems.reduce((acc, i) => acc + (i.physical_quantity ?? 0), 0);
  const filtered = filteredResultItems();

  root.innerHTML = `
    <div class="card">
      <button class="btn-secondary" id="btnBackToUpload2">${Icon.chevronLeft}Outra nota</button>
      <h2>${receipt.status === "completed" ? "Conferência Finalizada" : "Conferência Finalizada — Com Divergências"}</h2>
      <p class="hint-text">NF ${escapeHtml(receipt.invoice_number || "-")} · ${currentItems.length} SKUs conferidos</p>
      <div class="active-conference-stats" style="flex-wrap:wrap">
        <span class="active-conference-stat">${ok}<span>✓ OK</span></span>
        <span class="active-conference-stat">${missing}<span>⚠ Com falta</span></span>
        <span class="active-conference-stat">${surplus}<span>⚠ Com sobra</span></span>
      </div>
      <p class="hint-text">Conformidade: <strong>${formatConformity(conformityRate)}%</strong></p>
      <div class="review-actions">
        <button class="btn-secondary" id="btnScrollReport">Ver relatório completo</button>
        <button class="btn-secondary" id="btnScrollDivergences">Ver divergências</button>
        <button class="btn-secondary" id="btnExportPdf">${Icon.fileText}Exportar PDF</button>
        <button class="btn-secondary" id="btnExportExcel">${Icon.fileSpreadsheet}Exportar Excel</button>
        <button class="btn-secondary" id="btnBackToHistory">${Icon.history}Voltar ao histórico</button>
      </div>
    </div>

    <div class="card" id="nfeReportHeader">
      <h2>Relatório de Conferência</h2>
      <div class="product-card-meta">
        <span>NF-e: ${escapeHtml(receipt.invoice_number || "-")}</span>
        <span>Série: ${escapeHtml(receipt.series || "-")}</span>
        <span class="sku-code">Chave: ${escapeHtml(receipt.invoice_key)}</span>
        <span>Fornecedor: ${escapeHtml(receipt.supplier_name || "-")}</span>
        <span>CNPJ: ${escapeHtml(formatCnpj(receipt.supplier_cnpj))}</span>
        <span>Emissão: ${formatDateTime(receipt.issued_at)}</span>
        <span>Início da conferência: ${formatDateTime(receipt.started_at)}</span>
        <span>Finalização: ${formatDateTime(receipt.finished_at)}</span>
        <span>Finalizada por: ${escapeHtml(receipt.finished_by_name || "-")}</span>
      </div>
      <div class="active-conference-stats" style="flex-wrap:wrap">
        <span class="active-conference-stat">${currentItems.length}<span>SKUs da NF</span></span>
        <span class="active-conference-stat">${counted}<span>SKUs conferidos</span></span>
        <span class="active-conference-stat">${ok}<span>OK</span></span>
        <span class="active-conference-stat">${missing}<span>Com falta</span></span>
        <span class="active-conference-stat">${surplus}<span>Com sobra</span></span>
        <span class="active-conference-stat">${notCounted}<span>Não conferidos</span></span>
      </div>
      <p class="hint-text">Quantidade total NF: ${totalExpected} · Quantidade física: ${totalPhysical}</p>
    </div>

    <div class="card" id="nfeReportTable">
      <div class="input-mode-switch" style="flex-wrap:wrap">
        ${(Object.keys(RESULT_FILTER_LABEL) as ResultFilter[])
          .filter((f) => f !== "divergent")
          .map((f) => `<button class="mode-btn ${resultFilter === f ? "active" : ""}" data-result-filter="${f}">${RESULT_FILTER_LABEL[f]}</button>`)
          .join("")}
      </div>
      <label for="nfeReportSearch" class="sr-only">Buscar por nome, SKU ou EAN</label>
      <input type="text" id="nfeReportSearch" placeholder="Buscar por nome, SKU ou EAN…" value="${escapeHtml(resultQuery)}" style="margin-bottom:12px" />
      <div class="product-card-list mobile-only">${filtered.map(renderResultCard).join("")}</div>
      <div class="table-wrap desktop-only">
        <table>
          <thead><tr><th>Nome</th><th>SKU</th><th>EAN</th><th>NF</th><th>Físico</th><th>Diferença</th><th>Status</th><th></th></tr></thead>
          <tbody>${filtered.map(renderResultRow).join("")}</tbody>
        </table>
      </div>
      ${filtered.length === 0 ? `<div class="empty-state">${Icon.searchX}<p>Nenhum item encontrado com esse filtro/busca.</p></div>` : ""}
    </div>`;

  root.querySelector("#btnBackToUpload2")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    goTo(root, "upload");
  });
  root.querySelector("#btnBackToHistory")!.addEventListener("click", () => goTo(root, "history"));
  root.querySelector("#btnScrollReport")!.addEventListener("click", () => {
    root.querySelector("#nfeReportHeader")?.scrollIntoView({ behavior: "smooth" });
  });
  root.querySelector("#btnScrollDivergences")!.addEventListener("click", () => {
    resultFilter = "divergent";
    renderResultView(root);
    root.querySelector("#nfeReportTable")?.scrollIntoView({ behavior: "smooth" });
  });
  root.querySelector("#btnExportPdf")!.addEventListener("click", () => exportReportToPdf());
  root.querySelector("#btnExportExcel")!.addEventListener("click", () => exportReportToExcel(receipt, currentItems));

  root.querySelectorAll<HTMLButtonElement>("[data-result-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      resultFilter = btn.dataset.resultFilter as ResultFilter;
      renderResultView(root);
    });
  });

  const searchInput = root.querySelector<HTMLInputElement>("#nfeReportSearch")!;
  const debouncedSearch = debounce((value: string) => {
    resultQuery = value;
    renderResultView(root);
  }, 250);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  wireRecountButtons(root);
}

function diffLabel(it: InvoiceReceiptItem): string {
  if (it.physical_quantity === null) return "-";
  const diff = it.physical_quantity - it.expected_quantity;
  return diff > 0 ? `+${diff}` : String(diff);
}

function renderResultCard(it: InvoiceReceiptItem): string {
  const isRecounting = recountingIds.has(it.id);
  return `
    <div class="product-card">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(itemTitle(it))}</p>
        ${reportStatusStamp(it.status)}
      </div>
      <div class="product-card-meta">
        <span class="sku-code">${escapeHtml(itemCodeLabel(it))}</span>
        <span>EAN: ${escapeHtml(itemEanLabel(it))}</span>
        <span>NF: ${it.expected_quantity}</span>
        <span>Físico: ${it.physical_quantity ?? "—"}</span>
        <span>Diferença: ${diffLabel(it)}</span>
      </div>
      ${
        isRecounting
          ? `<div class="qty-stepper">
              <input type="number" min="0" inputmode="numeric" value="${it.physical_quantity ?? 0}" data-recount-input="${it.id}" aria-label="Nova contagem" />
              <button class="btn-primary" data-recount-confirm="${it.id}">Salvar</button>
            </div>`
          : `<button class="btn-secondary" data-recount-start="${it.id}">${Icon.refresh}Recontar</button>`
      }
    </div>`;
}

function renderResultRow(it: InvoiceReceiptItem): string {
  const isRecounting = recountingIds.has(it.id);
  return `
    <tr>
      <td>${escapeHtml(itemTitle(it))}</td>
      <td class="sku-code">${escapeHtml(itemCodeLabel(it))}</td>
      <td>${escapeHtml(itemEanLabel(it))}</td>
      <td>${it.expected_quantity}</td>
      <td>${it.physical_quantity ?? "—"}</td>
      <td>${diffLabel(it)}</td>
      <td>${reportStatusStamp(it.status)}</td>
      <td>
        ${
          isRecounting
            ? `<input type="number" min="0" inputmode="numeric" value="${it.physical_quantity ?? 0}" data-recount-input="${it.id}" style="width:70px" aria-label="Nova contagem" />
               <button class="btn-primary" data-recount-confirm="${it.id}">Salvar</button>`
            : `<button class="row-remove" data-recount-start="${it.id}" title="Recontar" aria-label="Recontar">${Icon.refresh}</button>`
        }
      </td>
    </tr>`;
}

function wireRecountButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-recount-start]").forEach((btn) => {
    btn.addEventListener("click", () => {
      recountingIds.add(btn.dataset.recountStart!);
      renderResultView(root);
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-recount-confirm]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.recountConfirm!;
      const input = root.querySelector<HTMLInputElement>(`[data-recount-input="${itemId}"]`)!;
      const quantity = Math.max(0, Number(input.value) || 0);
      try {
        await submitCount(itemId, quantity);
        // Recontagem pode mudar o resultado geral (ok/falta/sobra) — refinaliza
        // pra recalcular status de TODOS os itens, não só o recontado.
        const { receipt: updated, items } = await finalizeReceipt(currentReceipt!.id);
        currentReceipt = updated;
        currentItems = items;
        recountingIds.delete(itemId);
        renderResultView(root);
        showToast("Recontagem registrada — histórico anterior preservado.", "success");
      } catch (err) {
        showToast("Erro na recontagem: " + (describeError(err)), "error");
      }
    });
  });
}

/**
 * "Exportar PDF" via impressão do navegador (Salvar como PDF) — gera um PDF
 * real sem precisar de nenhuma biblioteca nova. O CSS de impressão (ver
 * style.css) esconde os controles (botões/filtro/busca/navegação) e força a
 * versão em tabela mesmo no celular, sem cortar colunas.
 */
function exportReportToPdf(): void {
  window.print();
}

function exportReportToExcel(receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): void {
  try {
    exportNfeReportToXlsx(receipt, items);
    showToast("Planilha exportada.", "success");
  } catch (err) {
    showToast("Erro ao exportar Excel: " + describeError(err), "error");
  }
}

// ---------------------------------------------------------------------------
// 5. Histórico de Notas
// ---------------------------------------------------------------------------
async function renderHistoryView(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="card">
      <button class="btn-secondary" id="btnBackToUpload3">${Icon.chevronLeft}Voltar</button>
      <h2>Histórico de Notas</h2>
      <div id="nfeHistoryWrap"><p class="hint-text">Carregando…</p></div>
    </div>`;

  root.querySelector("#btnBackToUpload3")!.addEventListener("click", () => goTo(root, "upload"));

  const wrap = root.querySelector<HTMLElement>("#nfeHistoryWrap")!;
  try {
    historyList = await listReceiptHistory(30);
  } catch (err) {
    wrap.innerHTML = `<p class="error-box">Erro ao carregar histórico: ${escapeHtml(describeError(err))}</p>`;
    return;
  }

  if (historyList.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.receipt}<p>Nenhuma nota importada ainda.</p></div>`;
    return;
  }

  const { profile } = getAuthState();
  const canManage = isManagerOrAdmin(profile);

  wrap.innerHTML = `
    <ul class="recent-list">
      ${historyList
        .map((r) => {
          // Dono só exclui enquanto a NF não foi finalizada (nenhum relatório
          // auditável em jogo ainda) — manager/admin pode sempre (ver migration
          // 0026). Corresponde exatamente à policy de DELETE no banco: esconder
          // o botão quando ele com certeza falharia evita um erro confuso.
          const canDelete = canManage || r.status === "not_started" || r.status === "in_progress";
          return `
        <li data-open-receipt="${r.id}" style="cursor:pointer">
          <div>
            <strong>NF ${escapeHtml(r.invoice_number || "-")} — ${escapeHtml(r.supplier_name || "-")}</strong>
            <span class="hint-text" style="margin:0">${formatDateTime(r.created_at)} · ${escapeHtml(r.operator_name || "-")}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
              <span class="status-badge ${r.status === "completed" ? "success" : r.status === "with_divergences" ? "warning" : "info"}">${escapeHtml(RECEIPT_STATUS_LABEL[r.status])}</span>
              <span class="hint-text" style="margin:0">${r.item_count} item(ns)</span>
            </div>
            ${canDelete ? `<button type="button" class="icon-btn danger" data-delete-receipt="${r.id}" aria-label="Excluir NF">${Icon.trash}</button>` : ""}
          </div>
        </li>`;
        })
        .join("")}
    </ul>`;

  wrap.querySelectorAll<HTMLElement>("[data-open-receipt]").forEach((li) => {
    li.addEventListener("click", async () => {
      const id = li.dataset.openReceipt!;
      try {
        const { receipt, items } = await getReceipt(id);
        currentReceipt = receipt;
        currentItems = items;
        goTo(root, decideViewForReceipt(receipt, items));
      } catch (err) {
        showToast("Erro ao abrir NF: " + (describeError(err)), "error");
      }
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-delete-receipt]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteReceipt!;
      const r = historyList.find((x) => x.id === id);
      const confirmed = await confirmAction({
        title: "Excluir Nota Fiscal?",
        message: `NF ${r?.invoice_number || "-"} — ${r?.supplier_name || "-"}. Esta ação não pode ser desfeita: a nota, seus itens e as contagens registradas serão removidos definitivamente.`,
        confirmLabel: "Excluir",
        danger: true,
      });
      if (!confirmed) return;

      try {
        await deleteReceipt(id);
        showToast("Nota Fiscal excluída.", "success");
        await renderHistoryView(root);
      } catch (err) {
        showToast("Erro ao excluir NF: " + describeError(err), "error");
      }
    });
  });
}
