// EXPANSÃO GOSCAN — Conferência por Ordem de Carregamento (Outlet). Mesmo
// princípio da Conferência por NF-e — vínculo automático + pendência manual
// — reaproveitando as MESMAS funções de contagem/finalização de nfeApi.ts
// (record_invoice_count_event, finalize_invoice_receipt_atomic) sem alterar
// nenhuma delas. O que é genuinamente novo aqui: ler a planilha de
// carregamento (loadingOrderApi.ts) e permitir cadastrar o produto novo
// direto de um item pendente — a maioria dos itens de um carregamento real
// ainda não existe no catálogo.
//
// V1 deliberadamente mais simples que a Conferência por NF-e: sem
// colaboração em tempo real, comandos de voz, volumes ou reserva por
// produto (work_mode fica 'free', o default já seguro pra contagem
// individual) — pode ganhar paridade depois, se for pedido.
import { escapeHtml, describeError, formatDateTime, normalize, runPickerSearch } from "../../utils.ts";
import { createLoadingOrderReceipt, splitModeloECor } from "../../loadingOrderApi.ts";
import { fetchAliasLists } from "../../matching.ts";
import {
  getReceipt,
  resolveItemManually,
  startCounting,
  submitCount,
  submitCountDelta,
  finalizeReceipt,
  listReceiptHistory,
  deleteReceipt,
  type InvoiceReceipt,
  type InvoiceReceiptItem,
  type FinalizeResult,
} from "../../nfeApi.ts";
import { searchSkuForPicker, type CatalogRow } from "../../catalogApi.ts";
import { createManualProduct } from "../../catalogManageApi.ts";
import { getSupabase } from "../../supabaseClient.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction, promptText } from "../confirmModal.ts";

declare const XLSX: {
  read(data: ArrayBuffer): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_json(ws: unknown, opts?: Record<string, unknown>): Record<string, unknown>[] };
};

type View = "upload" | "prep" | "counting" | "result";
let view: View = "upload";
let currentReceipt: InvoiceReceipt | null = null;
let currentItems: InvoiceReceiptItem[] = [];
let finalizeResult: FinalizeResult | null = null;

function decideView(receipt: InvoiceReceipt, items: InvoiceReceiptItem[]): View {
  if (receipt.status === "completed" || receipt.status === "with_divergences") return "result";
  if (items.some((i) => i.product_variant_id === null)) return "prep";
  return "counting";
}

export async function renderLoadingOrderConference(root: HTMLElement): Promise<void> {
  switch (view) {
    case "upload":
      await renderUploadView(root);
      break;
    case "prep":
      renderPrepView(root);
      break;
    case "counting":
      renderCountingView(root);
      break;
    case "result":
      renderResultView(root);
      break;
  }
}

function goTo(root: HTMLElement, next: View): void {
  view = next;
  void renderLoadingOrderConference(root);
}

// ---------------------------------------------------------------------------
// 1. Upload
// ---------------------------------------------------------------------------
async function renderUploadView(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="card">
      <h2>Nova Ordem de Carregamento</h2>
      <p class="hint-text">Planilha com os produtos que vão chegar (Produto, Descrição e Quantidade — nomes de coluna podem variar, as colunas 1ª e 3ª sempre são usadas como referência). Sem IA — leitura determinística, igual à importação de catálogo.</p>
      <label class="dropzone small">
        <input type="file" id="loFileInput" accept=".xlsx,.xls,.csv" hidden />
        <span class="dz-icon">${Icon.upload}</span>
        <span>Toque para subir a ordem de carregamento</span>
      </label>
      <div id="loUploadStatus" role="status" aria-live="polite"></div>
    </div>
    <div class="card">
      <h2>Carregamentos recentes</h2>
      <div id="loHistoryWrap"><p class="hint-text">Carregando…</p></div>
    </div>`;

  const input = root.querySelector<HTMLInputElement>("#loFileInput")!;
  const status = root.querySelector<HTMLElement>("#loUploadStatus")!;
  const dropzone = root.querySelector<HTMLLabelElement>(".dropzone")!;
  dropzone.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    status.innerHTML = `<p class="hint-text">Lendo planilha…</p>`;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer);
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
      const result = await createLoadingOrderReceipt(file.name, rows, (done, total) => {
        status.innerHTML = `<p class="hint-text">Vinculando produtos… ${done}/${total}</p>`;
      });
      status.innerHTML = "";
      showToast(`Ordem de carregamento recebida — ${result.linked} vinculado(s) automaticamente, ${result.pending} pendente(s).`, "success");
      currentReceipt = result.receipt;
      currentItems = result.items;
      goTo(root, decideView(result.receipt, result.items));
    } catch (err) {
      status.innerHTML = "";
      showToast("Erro ao enviar ordem de carregamento: " + describeError(err), "error");
    }
  });

  void loadHistory(root);
}

async function loadHistory(root: HTMLElement): Promise<void> {
  const wrap = root.querySelector<HTMLElement>("#loHistoryWrap");
  if (!wrap) return;
  try {
    const all = await listReceiptHistory(50);
    const carregamentos = all.filter((r) => r.source_type === "carregamento");
    if (carregamentos.length === 0) {
      wrap.innerHTML = `<p class="hint-text">Nenhuma ordem de carregamento enviada ainda.</p>`;
      return;
    }
    wrap.innerHTML = `<div class="product-card-list">${carregamentos
      .map(
        (r) => `
      <div class="product-card">
        <button type="button" data-lo-open="${r.id}" style="all:unset;cursor:pointer;display:block;width:100%">
          <div class="product-card-top">
            <p class="product-card-name">${escapeHtml(r.invoice_number || "Carregamento")}</p>
            <span class="status-badge ${r.status === "completed" ? "success" : r.status === "with_divergences" ? "warning" : "info"}">${escapeHtml(r.status)}</span>
          </div>
          <p class="hint-text">${r.item_count} item(ns) · enviada em ${formatDateTime(r.created_at)}</p>
        </button>
        <button type="button" class="btn-secondary btn-block" data-lo-delete="${r.id}" style="margin-top:8px">${Icon.trash}Apagar</button>
      </div>`
      )
      .join("")}</div>`;
    wrap.querySelectorAll<HTMLButtonElement>("[data-lo-open]").forEach((btn) => {
      btn.addEventListener("click", () => void openReceipt(root, btn.dataset.loOpen!));
    });
    wrap.querySelectorAll<HTMLButtonElement>("[data-lo-delete]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.loDelete!;
        const r = carregamentos.find((c) => c.id === id);
        const confirmed = await confirmAction({
          title: "Apagar ordem de carregamento?",
          message: `"${r?.invoice_number || "Carregamento"}" e todos os seus itens/contagens serão apagados permanentemente. Essa ação não pode ser desfeita.`,
          confirmLabel: "Apagar",
          danger: true,
        });
        if (!confirmed) return;
        try {
          await deleteReceipt(id);
          showToast("Ordem de carregamento apagada.", "success");
          void loadHistory(root);
        } catch (err) {
          showToast("Erro ao apagar: " + describeError(err), "error");
        }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<p class="hint-text">Não foi possível carregar o histórico (${escapeHtml(describeError(err))}).</p>`;
  }
}

async function openReceipt(root: HTMLElement, receiptId: string): Promise<void> {
  try {
    const { receipt, items } = await getReceipt(receiptId);
    currentReceipt = receipt;
    currentItems = items;
    goTo(root, decideView(receipt, items));
  } catch (err) {
    showToast("Erro ao abrir carregamento: " + describeError(err), "error");
  }
}

// ---------------------------------------------------------------------------
// 2. Preparação — resolver pendências (vincular existente ou cadastrar novo)
// ---------------------------------------------------------------------------
function renderPrepView(root: HTMLElement): void {
  const receipt = currentReceipt!;
  const pending = currentItems.filter((i) => i.product_variant_id === null);
  const linked = currentItems.length - pending.length;

  root.innerHTML = `
    <div class="card">
      <button type="button" class="btn-secondary" id="btnLoBackToList">${Icon.chevronLeft}Voltar para a lista</button>
    </div>
    <div class="card">
      <h2>${escapeHtml(receipt.invoice_number || "Carregamento")}</h2>
      <div class="active-conference-stats">
        <span class="active-conference-stat">${currentItems.length}<span>itens</span></span>
        <span class="active-conference-stat">${linked}<span>vinculados</span></span>
        <span class="active-conference-stat">${pending.length}<span>pendentes</span></span>
      </div>
      ${pending.length === 0 ? `<button class="btn-primary btn-block" id="btnStartCounting">Iniciar contagem</button>` : `<p class="hint-text">Resolva as pendências abaixo (vincule a um produto já existente ou cadastre como produto novo) antes de iniciar a contagem.</p>`}
    </div>
    <div class="card">
      <h2>Pendências (${pending.length})</h2>
      <div id="loPendingWrap">${pending.length === 0 ? `<p class="hint-text">Nenhuma pendência — pode iniciar a contagem.</p>` : `<div class="product-card-list">${pending.map(renderPendingCard).join("")}</div>`}</div>
    </div>`;

  root.querySelector("#btnLoBackToList")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    goTo(root, "upload");
  });

  root.querySelector("#btnStartCounting")?.addEventListener("click", async () => {
    try {
      await startCounting(receipt.id);
      currentReceipt = { ...receipt, status: "in_progress" };
      goTo(root, "counting");
    } catch (err) {
      showToast("Erro ao iniciar contagem: " + describeError(err), "error");
    }
  });

  wirePendingActions(root);
  void autoSuggestPending(root, pending);
}

function renderPendingCard(item: InvoiceReceiptItem): string {
  return `
    <div class="product-card" data-lo-pending="${item.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(item.invoice_product_code || "(sem nome)")}</p>
        <span>${item.expected_quantity} un.</span>
      </div>
      ${item.description ? `<p class="hint-text">${escapeHtml(item.description)}</p>` : ""}
      <div id="loSuggest-${item.id}"></div>
      <div class="sku-picker" data-lo-link="${item.id}">
        <input type="text" class="sku-picker-input" aria-label="Buscar produto outlet já cadastrado" placeholder="Buscar produto outlet por nome ou SKU…" data-lo-link-input="${item.id}" />
        <div class="sku-picker-results" hidden></div>
      </div>
      <button type="button" class="btn-secondary btn-block" data-lo-create="${item.id}">${Icon.plus}Cadastrar como produto novo</button>
      <div id="loCreateForm-${item.id}"></div>
    </div>`;
}

// PERFORMANCE/CORREÇÃO — busca automática de sugestões pra TODAS as
// pendências ao abrir a tela de preparação: nunca restringe por
// product_type ("outlet" só) porque uma parte real do catálogo tem produtos
// outlet cadastrados com product_type='normal' por engano (dado legado —
// restringir por tipo escondia produto que claramente já existe).
//
// CORREÇÃO — Carregamento é SEMPRE Outlet: nunca pode sugerir/vincular um
// produto 'normal', mesmo com nome idêntico (são catálogos diferentes — e
// misturar os dois tipos é a causa real de muitos falsos "ambíguo", já que
// vários produtos existem cadastrados nos dois tipos com o mesmo nome/cor).
// Processa em lotes pequenos, mesmo motivo da importação: muitas buscas
// concorrentes de uma vez estouram o banco.
const SUGGEST_BATCH_SIZE = 4;

async function autoSuggestPending(root: HTMLElement, pending: InvoiceReceiptItem[]): Promise<void> {
  // CORREÇÃO — causa raiz real de "tem a informação e não vincula": a busca
  // usava o texto INTEIRO da linha ("Bolsa Fitness Puffer Marrom"), mas o
  // NOME do produto no catálogo nunca inclui a cor ("Outlet Bolsa Fitness
  // Puffer Gocase Leves Defeitos" — a cor é só da variação, campo separado).
  // Buscar com a cor junto ao nome nunca batia, mesmo o produto existindo de
  // verdade. Agora separa modelo/cor do mesmo jeito que o vínculo automático
  // da importação já faz (splitModeloECor) — busca só pelo modelo, e se UMA
  // única variação bater exatamente na cor da planilha, vincula direto
  // (nunca adivinha entre duas ou mais opções — aí só sugere).
  const { colors } = await fetchAliasLists();
  let autoLinked = 0;

  for (let start = 0; start < pending.length; start += SUGGEST_BATCH_SIZE) {
    const batch = pending.slice(start, start + SUGGEST_BATCH_SIZE);
    await Promise.all(
      batch.map(async (item) => {
        const raw = item.invoice_product_code || item.description || "";
        if (!raw.trim()) return;
        const { modelo, cor } = splitModeloECor(raw, colors);
        try {
          const rows = await searchSkuForPicker(modelo, 5, "outlet", undefined, false);
          if (rows.length === 0) return;

          const normCor = normalize(cor);
          const exactColorHits = normCor ? rows.filter((r) => normalize(r.cor) === normCor) : [];
          if (exactColorHits.length === 1) {
            // Sem re-render aqui de propósito — vincula vários itens em
            // sequência e só redesenha a pendências 1 vez, no final (ver
            // applyLink). Re-renderizar a cada item reiniciaria esta mesma
            // função várias vezes em paralelo.
            await applyLink(item.id, exactColorHits[0].variant_id);
            autoLinked++;
            return;
          }

          const box = root.querySelector<HTMLElement>(`#loSuggest-${item.id}`);
          if (!box) return;
          box.innerHTML = `
            <p class="hint-text">Parecido(s) no catálogo:</p>
            ${rows
              .map(
                (r) =>
                  `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}">${escapeHtml(r.produto)} — ${escapeHtml(
                    r.cor || ""
                  )} <span class="sku-code">${escapeHtml(r.sku_code)}</span></button>`
              )
              .join("")}`;
          box.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((el, idx) => {
            el.addEventListener("click", () => void linkPendingItem(root, item.id, rows[idx].variant_id));
          });
        } catch {
          // Sugestão é só um atalho — nunca trava nem avisa erro por causa disso, o operador sempre pode buscar manualmente.
        }
      })
    );
  }

  if (autoLinked > 0) {
    showToast(`${autoLinked} produto(s) vinculado(s) automaticamente.`, "success");
    renderPrepView(root);
  }
}

function wirePendingActions(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>("[data-lo-link-input]").forEach((input) => {
    const itemId = input.dataset.loLinkInput!;
    const resultsBox = input.parentElement!.querySelector<HTMLDivElement>(".sku-picker-results")!;
    let activeController: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // LOADING VISUAL — antes o campo ficava "parado" sem nenhum feedback
    // enquanto a busca rodava, e um erro de rede não mostrava nada (usuário
    // sem saber se travou). runPickerSearch mostra "Buscando…" e, se falhar
    // de verdade, erro com retry — nunca uma busca cancelada (troca de termo).
    const runSearch = (): void => {
      activeController?.abort();
      if (!input.value.trim()) {
        resultsBox.hidden = true;
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      void runPickerSearch(
        resultsBox,
        controller.signal,
        async () => {
          // Sempre restringe a Outlet — ver comentário em autoSuggestPending.
          const rows = await searchSkuForPicker(input.value, 15, "outlet", controller.signal, false);
          if (controller.signal.aborted) return;
          renderPickerResults(resultsBox, rows, (row) => void linkPendingItem(root, itemId, row.variant_id));
        },
        runSearch
      );
    };

    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(runSearch, 300);
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-lo-create]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const itemId = btn.dataset.loCreate!;
      const item = currentItems.find((i) => i.id === itemId);
      if (!item) return;
      const formWrap = root.querySelector<HTMLElement>(`#loCreateForm-${itemId}`)!;
      formWrap.innerHTML = renderCreateProductForm(item);
      wireCreateProductForm(root, formWrap, item);
    });
  });
}

function renderPickerResults(resultsBox: HTMLDivElement, rows: CatalogRow[], onPick: (row: CatalogRow) => void): void {
  if (rows.length === 0) {
    resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum produto encontrado.</div>`;
    resultsBox.hidden = false;
    return;
  }
  resultsBox.innerHTML = rows
    .map(
      (r) =>
        `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}">${escapeHtml(r.produto)} — ${escapeHtml(r.cor || "")} <span class="sku-code">${escapeHtml(
          r.sku_code
        )}</span></button>`
    )
    .join("");
  resultsBox.hidden = false;
  resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((el, idx) => {
    el.addEventListener("click", () => onPick(rows[idx]));
  });
}

/** Só grava o vínculo e atualiza o estado local — nunca re-renderiza (ver autoSuggestPending, que vincula vários itens em sequência e só redesenha a tela 1 vez no final). */
async function applyLink(itemId: string, variantId: string): Promise<void> {
  const updated = await resolveItemManually(itemId, variantId);
  currentItems = currentItems.map((i) => (i.id === itemId ? { ...i, ...updated } : i));
}

/** Vínculo disparado por um clique do operador — grava e já redesenha a tela na hora. */
async function linkPendingItem(root: HTMLElement, itemId: string, variantId: string): Promise<void> {
  try {
    await applyLink(itemId, variantId);
    showToast("Produto vinculado.", "success");
    renderPrepView(root);
  } catch (err) {
    showToast("Erro ao vincular produto: " + describeError(err), "error");
  }
}

function renderCreateProductForm(item: InvoiceReceiptItem): string {
  return `
    <div class="card" style="margin-top:8px">
      <label for="loNewNome-${item.id}">Nome do produto</label>
      <input type="text" id="loNewNome-${item.id}" value="${escapeHtml(item.invoice_product_code || "")}" />
      <label for="loNewCor-${item.id}">Cor</label>
      <input type="text" id="loNewCor-${item.id}" placeholder="Cor" />
      <label for="loNewSku-${item.id}">SKU (interno GoScan, obrigatório)</label>
      <input type="text" id="loNewSku-${item.id}" placeholder="ex.: OUT-NOVOPRODUTO-1" />
      <label for="loNewGtin-${item.id}">GTIN/EAN (opcional)</label>
      <input type="text" id="loNewGtin-${item.id}" placeholder="Deixe em branco se não tiver um código de barras real" />
      <div class="review-actions">
        <button type="button" class="btn-secondary" data-lo-create-cancel="${item.id}">Cancelar</button>
        <button type="button" class="btn-primary" data-lo-create-save="${item.id}">Cadastrar e vincular</button>
      </div>
    </div>`;
}

function wireCreateProductForm(root: HTMLElement, formWrap: HTMLElement, item: InvoiceReceiptItem): void {
  formWrap.querySelector(`[data-lo-create-cancel="${item.id}"]`)!.addEventListener("click", () => {
    formWrap.innerHTML = "";
  });

  formWrap.querySelector(`[data-lo-create-save="${item.id}"]`)!.addEventListener("click", async () => {
    const nome = (root.querySelector(`#loNewNome-${item.id}`) as HTMLInputElement).value.trim();
    const cor = (root.querySelector(`#loNewCor-${item.id}`) as HTMLInputElement).value.trim();
    const sku = (root.querySelector(`#loNewSku-${item.id}`) as HTMLInputElement).value.trim();
    const gtin = (root.querySelector(`#loNewGtin-${item.id}`) as HTMLInputElement).value.trim();
    const btn = formWrap.querySelector<HTMLButtonElement>(`[data-lo-create-save="${item.id}"]`)!;
    btn.disabled = true;
    try {
      await createManualProduct({ produto: nome, sku_code: sku, gtin, cor, product_type: "outlet" });
      const supabase = getSupabase();
      const { data: variant, error } = await supabase.from("product_variants").select("id").eq("sku_code", sku.trim()).single();
      if (error) throw error;
      await linkPendingItem(root, item.id, (variant as { id: string }).id);
    } catch (err) {
      btn.disabled = false;
      showToast("Erro ao cadastrar produto: " + describeError(err), "error");
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Contagem — contagem cega (nunca mostra expected_quantity antes de finalizar)
// ---------------------------------------------------------------------------
function renderCountingView(root: HTMLElement): void {
  const receipt = currentReceipt!;
  root.innerHTML = `
    <div class="card">
      <button type="button" class="btn-secondary" id="btnLoBackToList">${Icon.chevronLeft}Voltar para a lista</button>
    </div>
    <div class="card">
      <h2>${escapeHtml(receipt.invoice_number || "Carregamento")}</h2>
      <div class="search-row search-row-icon">
        ${Icon.search}
        <label for="loCountSearch" class="sr-only">Buscar item</label>
        <input type="text" id="loCountSearch" placeholder="Buscar por nome…" />
      </div>
    </div>
    <div class="card">
      <div id="loCountListWrap"></div>
      <button class="btn-accent btn-block" id="btnFinalizeLoadingOrder" style="margin-top:12px">Finalizar conferência</button>
    </div>`;

  root.querySelector("#btnLoBackToList")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    goTo(root, "upload");
  });

  renderCountList(root, currentItems);

  const search = root.querySelector<HTMLInputElement>("#loCountSearch")!;
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    const filtered = q ? currentItems.filter((i) => (i.invoice_product_code || "").toLowerCase().includes(q)) : currentItems;
    renderCountList(root, filtered);
  });

  root.querySelector("#btnFinalizeLoadingOrder")!.addEventListener("click", async () => {
    const confirmed = await confirmAction({
      title: "Finalizar conferência?",
      message: "Depois de finalizada, as quantidades contadas ficam registradas e a conferência não pode mais ser editada por um operador comum.",
      confirmLabel: "Finalizar",
    });
    if (!confirmed) return;
    try {
      const outcome = await finalizeReceipt(receipt.id);
      if (!outcome.ok) {
        showToast("Esta conferência já foi finalizada por outra pessoa.", "error");
        return;
      }
      currentReceipt = outcome.receipt;
      currentItems = outcome.items;
      finalizeResult = outcome;
      goTo(root, "result");
    } catch (err) {
      showToast("Erro ao finalizar: " + describeError(err), "error");
    }
  });
}

function renderCountList(root: HTMLElement, items: InvoiceReceiptItem[]): void {
  const wrap = root.querySelector<HTMLElement>("#loCountListWrap");
  if (!wrap) return;
  if (items.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum item encontrado.</p>`;
    return;
  }
  wrap.innerHTML = `<div class="product-card-list">${items.map(renderCountCard).join("")}</div>`;

  wrap.querySelectorAll<HTMLButtonElement>("[data-lo-inc]").forEach((btn) => {
    btn.addEventListener("click", () => void bumpCount(root, btn.dataset.loInc!, 1));
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-lo-dec]").forEach((btn) => {
    btn.addEventListener("click", () => void bumpCount(root, btn.dataset.loDec!, -1));
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-lo-set]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.loSet!;
      const value = await promptText({ title: "Definir quantidade contada", placeholder: "Quantidade" });
      if (value === null) return;
      const n = Number(value.replace(",", "."));
      if (!Number.isFinite(n) || n < 0) {
        showToast("Quantidade inválida.", "error");
        return;
      }
      await setCount(root, itemId, n);
    });
  });
}

function renderCountCard(item: InvoiceReceiptItem): string {
  const counted = item.physical_quantity ?? 0;
  return `
    <div class="product-card">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(item.invoice_product_code || item.produto || "(sem nome)")}</p>
      </div>
      <div class="qty-stepper">
        <button type="button" data-lo-dec="${item.id}" aria-label="Diminuir">${Icon.minus}</button>
        <input type="text" inputmode="numeric" value="${counted}" readonly data-lo-set="${item.id}" style="cursor:pointer" aria-label="Tocar para definir quantidade" />
        <button type="button" data-lo-inc="${item.id}" aria-label="Aumentar">${Icon.plus}</button>
      </div>
    </div>`;
}

async function bumpCount(root: HTMLElement, itemId: string, delta: number): Promise<void> {
  try {
    const result = await submitCountDelta(itemId, delta);
    if (!result.success) {
      showToast("Não foi possível registrar a contagem agora.", "error");
      return;
    }
    currentItems = currentItems.map((i) => (i.id === itemId ? { ...i, physical_quantity: result.newTotal } : i));
    renderCountList(root, currentItems);
  } catch (err) {
    showToast("Erro ao contar: " + describeError(err), "error");
  }
}

async function setCount(root: HTMLElement, itemId: string, value: number): Promise<void> {
  try {
    const result = await submitCount(itemId, value);
    if (!result.success) {
      showToast("Não foi possível registrar a contagem agora.", "error");
      return;
    }
    currentItems = currentItems.map((i) => (i.id === itemId ? { ...i, physical_quantity: result.newTotal } : i));
    renderCountList(root, currentItems);
  } catch (err) {
    showToast("Erro ao definir quantidade: " + describeError(err), "error");
  }
}

// ---------------------------------------------------------------------------
// 4. Resultado
// ---------------------------------------------------------------------------
function renderResultView(root: HTMLElement): void {
  const receipt = currentReceipt!;
  const summary = finalizeResult?.summary;
  root.innerHTML = `
    <div class="card">
      <h2>Carregamento Finalizado</h2>
      <p class="hint-text"><span class="status-badge ${receipt.status === "completed" ? "success" : "warning"}">${escapeHtml(receipt.status)}</span></p>
      ${
        summary
          ? `<div class="active-conference-stats" style="flex-wrap:wrap">
              <span class="active-conference-stat">${summary.ok}<span>OK</span></span>
              <span class="active-conference-stat">${summary.missing}<span>faltando</span></span>
              <span class="active-conference-stat">${summary.surplus}<span>excedente</span></span>
            </div>`
          : ""
      }
      <button class="btn-primary btn-block" id="btnLoNewReceipt" style="margin-top:12px">Nova Ordem de Carregamento</button>
    </div>`;

  root.querySelector("#btnLoNewReceipt")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    finalizeResult = null;
    goTo(root, "upload");
  });
}
