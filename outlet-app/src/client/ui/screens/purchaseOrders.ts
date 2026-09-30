// EXPANSÃO GOSCAN — Painel de Ordens de Compra: tela própria de gestão
// (inspirada na ideia do painel do Tiny ERP — abas por status, busca, lista
// com número/fornecedor/data — sem copiar layout/cores). Antes disso, uma OC
// só existia "dentro" da Conferência por NF-e, sem título, número do pedido
// nem fornecedor administráveis (ver migration 0063_purchase_orders_management.sql).
// Upload/vínculo/checagem de conflito continuam exatamente como já
// funcionavam — esta tela é só aditiva.
//
// CORREÇÃO DE UX — a primeira versão editava e expandia itens INLINE dentro
// da própria linha/card da lista, e ficou confuso ("bugado, confuso" — usuário
// testou e não gostou). Agora é Lista <-> Detalhe: a lista só lista, "Ver
// detalhes" abre uma tela própria (com voltar) que concentra edição, ação de
// cancelar/reativar e a listagem de itens — nunca os dois juntos na mesma tela.
import { escapeHtml, describeError } from "../../utils.ts";
import {
  listPurchaseOrders,
  updatePurchaseOrder,
  setPurchaseOrderCancelled,
  readPurchaseOrderFile,
  uploadPurchaseOrder,
  getPurchaseOrderItems,
  type PurchaseOrder,
  type PurchaseOrderStatus,
  type PurchaseOrderItemRow,
} from "../../purchaseOrderApi.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction } from "../confirmModal.ts";

type TabFilter = "todos" | PurchaseOrderStatus;

const TAB_LABEL: Record<TabFilter, string> = {
  todos: "Todos",
  avulsa: "Avulsas",
  vinculada: "Em andamento",
  conferida: "Conferidas",
  cancelada: "Canceladas",
};

const STATUS_BADGE: Record<PurchaseOrderStatus, { cls: string; label: string }> = {
  avulsa: { cls: "info", label: "Avulsa" },
  vinculada: { cls: "warning", label: "Em andamento" },
  conferida: { cls: "success", label: "Conferida" },
  cancelada: { cls: "error", label: "Cancelada" },
};

let allOrders: PurchaseOrder[] = [];
let activeTab: TabFilter = "todos";
let query = "";
let loadError: string | null = null;

// Navegação Lista <-> Detalhe (nenhuma das duas telas mistura a outra).
let screen: "list" | "detail" = "list";
let detailId: string | null = null;
let detailEditing = false;
const itemsCache = new Map<string, PurchaseOrderItemRow[]>();

function formatBrDate(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function matchesQuery(po: PurchaseOrder, q: string): boolean {
  if (!q) return true;
  const haystack = `${po.title || ""} ${po.order_number || ""} ${po.supplier_name || ""} ${po.file_name}`.toLowerCase();
  return haystack.includes(q.toLowerCase());
}

export async function renderPurchaseOrders(root: HTMLElement): Promise<void> {
  screen = "list";
  detailId = null;
  detailEditing = false;
  root.innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card" style="height:200px"></div>`;
  await reloadOrders(root);
}

async function reloadOrders(root: HTMLElement): Promise<void> {
  try {
    allOrders = await listPurchaseOrders();
    loadError = null;
  } catch (err) {
    loadError = describeError(err);
  }
  render(root);
}

function render(root: HTMLElement): void {
  if (loadError) {
    root.innerHTML = `
      <div class="card">
        <h2>Ordens de Compra</h2>
        <div class="warning-box">${Icon.info} Não foi possível carregar as ordens de compra: ${escapeHtml(loadError)}</div>
        <button type="button" class="btn-secondary" id="btnRetryPo">Tentar novamente</button>
      </div>`;
    root.querySelector("#btnRetryPo")!.addEventListener("click", () => void reloadOrders(root));
    return;
  }

  if (screen === "detail" && detailId) {
    const po = allOrders.find((o) => o.id === detailId);
    if (po) {
      renderDetailScreen(root, po);
      return;
    }
    // OC não existe mais na lista atual (ex.: reload após ação) — nunca trava numa tela órfã.
    screen = "list";
    detailId = null;
  }

  renderListScreen(root);
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------
function renderListScreen(root: HTMLElement): void {
  const counts: Record<TabFilter, number> = { todos: allOrders.length, avulsa: 0, vinculada: 0, conferida: 0, cancelada: 0 };
  allOrders.forEach((po) => counts[po.status]++);

  const filtered = allOrders.filter((po) => (activeTab === "todos" || po.status === activeTab) && matchesQuery(po, query));

  root.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0">Ordens de Compra</h2>
        <button type="button" class="btn-primary" id="btnNewPo">${Icon.plus}Nova ordem de compra</button>
      </div>
      <p class="hint-text">Título, número do pedido, fornecedor e datas são administráveis aqui, a qualquer momento — independente de estar vinculada a uma NF-e ou não.</p>

      <input type="file" id="poUploadInput" accept=".xlsx,.xls,.csv,.pdf" hidden />
      <div id="poUploadStatus"></div>

      <div class="input-mode-switch" style="margin-top:10px">
        ${(Object.keys(TAB_LABEL) as TabFilter[])
          .map((tab) => `<button class="mode-btn ${activeTab === tab ? "active" : ""}" data-po-tab="${tab}">${TAB_LABEL[tab]} <span class="chip-count">${counts[tab]}</span></button>`)
          .join("")}
      </div>

      <div class="search-row search-row-icon" style="margin-top:10px">
        ${Icon.search}
        <label for="poSearch" class="sr-only">Pesquisar por título, nº do pedido ou fornecedor</label>
        <input type="text" id="poSearch" placeholder="Pesquisar por título, nº do pedido ou fornecedor…" value="${escapeHtml(query)}" />
      </div>
    </div>

    <div class="card">
      <div id="poListWrap"></div>
    </div>`;

  renderOrdersList(root, filtered);

  root.querySelector("#btnNewPo")!.addEventListener("click", () => {
    root.querySelector<HTMLInputElement>("#poUploadInput")!.click();
  });

  wirePoUpload(root);

  root.querySelectorAll<HTMLButtonElement>("[data-po-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.poTab as TabFilter;
      render(root);
    });
  });

  const searchInput = root.querySelector<HTMLInputElement>("#poSearch")!;
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    render(root);
  });
}

function wirePoUpload(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("#poUploadInput");
  const status = root.querySelector<HTMLElement>("#poUploadStatus");
  if (!input || !status) return;

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    status.innerHTML = `<p class="hint-text">Lendo ${file.name.toLowerCase().endsWith(".pdf") ? "PDF" : "planilha"}…</p>`;
    try {
      const { rows, metadata } = await readPurchaseOrderFile(file);
      const result = await uploadPurchaseOrder(file.name, rows, undefined, metadata);
      status.innerHTML = "";
      showToast(
        `Ordem de compra recebida — ${result.inserted} linha(s) lida(s)${result.rejected > 0 ? `, ${result.rejected} rejeitada(s)` : ""}.`,
        "success"
      );
      await reloadOrders(root);
    } catch (err) {
      status.innerHTML = "";
      showToast("Erro ao enviar ordem de compra: " + describeError(err), "error");
    }
  });
}

function renderLinkInfo(po: PurchaseOrder): string {
  if (!po.receipt_id) return `<span class="hint-text">Avulsa (sem NF vinculada)</span>`;
  const label = po.receipt_invoice_number ? `NF ${escapeHtml(po.receipt_invoice_number)}` : "NF vinculada";
  return `<a href="#/conferir/nfe/${po.receipt_id}">${label}</a>`;
}

function renderOrdersList(root: HTMLElement, orders: PurchaseOrder[]): void {
  const wrap = root.querySelector<HTMLElement>("#poListWrap");
  if (!wrap) return;

  if (orders.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.package}<p>Nenhuma ordem de compra encontrada.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="product-card-list mobile-only">
      ${orders
        .map(
          (po) => `
        <div class="product-card" data-po-id="${po.id}">
          <div class="product-card-top">
            <p class="product-card-name">${escapeHtml(po.title || po.file_name)}</p>
            <span class="status-badge ${STATUS_BADGE[po.status].cls}">${STATUS_BADGE[po.status].label}</span>
          </div>
          <div class="product-card-meta">
            <span>Pedido: ${escapeHtml(po.order_number || "-")}</span>
            <span>Fornecedor: ${escapeHtml(po.supplier_name || "-")}</span>
            <span>${po.item_count} item(ns)</span>
          </div>
          <p class="hint-text">${renderLinkInfo(po)}</p>
          <button type="button" class="btn-secondary btn-block" data-po-open="${po.id}">${Icon.eye}Ver detalhes</button>
        </div>`
        )
        .join("")}
    </div>
    <div class="table-wrap desktop-only">
      <table>
        <thead><tr><th>Título</th><th>Nº pedido</th><th>Fornecedor</th><th>Data</th><th>Previsto</th><th>Itens</th><th>Status</th><th>Vínculo</th><th></th></tr></thead>
        <tbody>
          ${orders
            .map(
              (po) => `
            <tr data-po-id="${po.id}">
              <td>${escapeHtml(po.title || po.file_name)}</td>
              <td>${escapeHtml(po.order_number || "-")}</td>
              <td>${escapeHtml(po.supplier_name || "-")}</td>
              <td>${formatBrDate(po.order_date)}</td>
              <td>${formatBrDate(po.expected_date)}</td>
              <td>${po.item_count}</td>
              <td><span class="status-badge ${STATUS_BADGE[po.status].cls}">${STATUS_BADGE[po.status].label}</span></td>
              <td>${renderLinkInfo(po)}</td>
              <td><button type="button" class="btn-secondary" data-po-open="${po.id}">${Icon.eye}Ver detalhes</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;

  wrap.querySelectorAll<HTMLButtonElement>("[data-po-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      screen = "detail";
      detailId = btn.dataset.poOpen!;
      detailEditing = false;
      render(root);
    });
  });
}

// ---------------------------------------------------------------------------
// Detalhe — uma única tela: dados administráveis (visualização OU edição),
// itens da OC e as ações de cancelar/reativar. Nunca mistura com a lista.
// ---------------------------------------------------------------------------
function renderDetailScreen(root: HTMLElement, po: PurchaseOrder): void {
  const badge = STATUS_BADGE[po.status];

  root.innerHTML = `
    <div class="card">
      <button type="button" class="btn-secondary" id="btnPoBack">${Icon.chevronLeft}Voltar para a lista</button>
    </div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0">${escapeHtml(po.title || po.file_name)}</h2>
        <span class="status-badge ${badge.cls}">${badge.label}</span>
      </div>

      ${detailEditing ? renderDetailEditFields(po) : renderDetailViewFields(po)}

      <div class="review-actions" style="margin-top:12px">
        ${
          detailEditing
            ? `<button type="button" class="btn-secondary" id="btnPoEditCancel">Cancelar edição</button>
               <button type="button" class="btn-primary" id="btnPoEditSave">Salvar</button>`
            : `<button type="button" class="btn-secondary" id="btnPoEditStart">${Icon.pencil}Editar</button>
               ${
                 po.cancelled
                   ? `<button type="button" class="btn-secondary" id="btnPoReactivate">Reativar</button>`
                   : `<button type="button" class="btn-secondary" id="btnPoCancel">Cancelar ordem de compra</button>`
               }`
        }
      </div>
    </div>

    <div class="card">
      <h2>Itens da ordem de compra</h2>
      <div id="poItemsWrap"><p class="hint-text">Carregando itens…</p></div>
    </div>`;

  root.querySelector("#btnPoBack")!.addEventListener("click", () => {
    screen = "list";
    detailId = null;
    detailEditing = false;
    render(root);
  });

  if (detailEditing) {
    root.querySelector("#btnPoEditCancel")!.addEventListener("click", () => {
      detailEditing = false;
      render(root);
    });
    root.querySelector("#btnPoEditSave")!.addEventListener("click", () => void savePoEdit(root, po));
  } else {
    root.querySelector("#btnPoEditStart")!.addEventListener("click", () => {
      detailEditing = true;
      render(root);
    });
    root.querySelector("#btnPoCancel")?.addEventListener("click", () => void cancelPo(root, po));
    root.querySelector("#btnPoReactivate")?.addEventListener("click", () => void reactivatePo(root, po));
  }

  void loadDetailItems(root, po.id);
}

function renderDetailViewFields(po: PurchaseOrder): string {
  return `
    <div class="product-card-meta" style="margin-top:10px">
      <span>Nº do pedido: ${escapeHtml(po.order_number || "-")}</span>
      <span>Fornecedor: ${escapeHtml(po.supplier_name || "-")}</span>
      <span>Data do pedido: ${formatBrDate(po.order_date)}</span>
      <span>Data prevista: ${formatBrDate(po.expected_date)}</span>
    </div>
    <p class="hint-text" style="margin-top:8px">${renderLinkInfo(po)}</p>`;
}

function renderDetailEditFields(po: PurchaseOrder): string {
  return `
    <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
      <label for="poEditTitle">Título</label>
      <input type="text" id="poEditTitle" placeholder="Título" value="${escapeHtml(po.title || "")}" />
      <label for="poEditNumber">Número do pedido</label>
      <input type="text" id="poEditNumber" placeholder="Nº do pedido" value="${escapeHtml(po.order_number || "")}" />
      <label for="poEditSupplier">Fornecedor</label>
      <input type="text" id="poEditSupplier" placeholder="Fornecedor" value="${escapeHtml(po.supplier_name || "")}" />
      <label for="poEditDate">Data do pedido</label>
      <input type="date" id="poEditDate" value="${po.order_date || ""}" />
      <label for="poEditExpected">Data prevista</label>
      <input type="date" id="poEditExpected" value="${po.expected_date || ""}" />
    </div>`;
}

async function savePoEdit(root: HTMLElement, po: PurchaseOrder): Promise<void> {
  const btn = root.querySelector<HTMLButtonElement>("#btnPoEditSave")!;
  const getVal = (id: string) => (root.querySelector(`#${id}`) as HTMLInputElement)?.value.trim() || null;
  btn.disabled = true;
  try {
    await updatePurchaseOrder(po.id, {
      title: getVal("poEditTitle"),
      order_number: getVal("poEditNumber"),
      supplier_name: getVal("poEditSupplier"),
      order_date: getVal("poEditDate"),
      expected_date: getVal("poEditExpected"),
    });
    detailEditing = false;
    showToast("Ordem de compra atualizada.", "success");
    await reloadOrders(root);
  } catch (err) {
    btn.disabled = false;
    showToast("Erro ao salvar ordem de compra: " + describeError(err), "error");
  }
}

async function cancelPo(root: HTMLElement, po: PurchaseOrder): Promise<void> {
  const confirmed = await confirmAction({
    title: "Cancelar ordem de compra?",
    message: `"${po.title || po.file_name}" será marcada como cancelada — os itens e o histórico continuam guardados, e dá pra reativar depois.`,
    confirmLabel: "Cancelar OC",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await setPurchaseOrderCancelled(po.id, true);
    showToast("Ordem de compra cancelada.", "success");
    await reloadOrders(root);
  } catch (err) {
    showToast("Erro ao cancelar ordem de compra: " + describeError(err), "error");
  }
}

async function reactivatePo(root: HTMLElement, po: PurchaseOrder): Promise<void> {
  try {
    await setPurchaseOrderCancelled(po.id, false);
    showToast("Ordem de compra reativada.", "success");
    await reloadOrders(root);
  } catch (err) {
    showToast("Erro ao reativar ordem de compra: " + describeError(err), "error");
  }
}

async function loadDetailItems(root: HTMLElement, poId: string): Promise<void> {
  const wrap = root.querySelector<HTMLElement>("#poItemsWrap");
  if (!wrap) return;

  let items = itemsCache.get(poId);
  if (!items) {
    try {
      items = await getPurchaseOrderItems(poId);
      itemsCache.set(poId, items);
    } catch (err) {
      // Nunca troca de tela nem cancela a visualização por causa disso — só
      // avisa que os itens não carregaram, o resto da tela de detalhe segue normal.
      if (root.querySelector("#poItemsWrap")) {
        root.querySelector("#poItemsWrap")!.innerHTML = `<p class="hint-text">Não foi possível carregar os itens (${escapeHtml(describeError(err))}).</p>`;
      }
      return;
    }
  }
  // Detalhe pode ter sido trocado (voltou pra lista, abriu outra OC) enquanto a busca estava em voo.
  if (!root.querySelector("#poItemsWrap") || screen !== "detail" || detailId !== poId) return;

  if (items.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum item nesta ordem de compra.</p>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>GTIN</th><th>SKU</th><th>Descrição</th><th>Qtd</th></tr></thead>
        <tbody>
          ${items
            .map(
              (it) =>
                `<tr><td class="sku-code">${escapeHtml(it.gtin_normalized)}</td><td class="sku-code">${escapeHtml(it.sku_code)}</td><td>${escapeHtml(
                  it.description || "-"
                )}</td><td>${it.quantity ?? "-"}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}
