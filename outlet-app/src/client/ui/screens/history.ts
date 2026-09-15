import {
  listRecentConferences,
  getConference,
  type Conference,
  type ConferenceWithOperator,
  type ConferenceItemWithVariant,
} from "../../conferencesApi.ts";
import { listReceiptHistory, getReceipt, type ReceiptWithCounts } from "../../nfeApi.ts";
import { RECEIPT_STATUS_LABEL, reportStatusStamp, itemTitle, itemCodeLabel, itemEanLabel } from "../../nfeReportFormat.ts";
import { escapeHtml, formatDateTime, describeError, renderErrorWithRetry } from "../../utils.ts";
import { Icon } from "../icons.ts";

// EXPANSÃO GOSCAN — o Histórico geral cobre dois fluxos de conferência
// totalmente separados (Outlet via scan/texto/print, e Produtos Normais via
// Nota Fiscal) — mesmo padrão de sub-abas já usado em catalog.ts
// (input-mode-switch/mode-btn), sem criar nenhuma rota nova no shell.
let historyTab: "outlet" | "nfe" = "outlet";

function statusLabel(status: Conference["status"]): string {
  return { draft: "Rascunho", in_progress: "Em andamento", completed: "Concluída", cancelled: "Cancelada" }[status];
}

function statusBadge(status: Conference["status"]): string {
  if (status === "completed") return `<span class="status-badge success">${Icon.checkCircle}${statusLabel(status)}</span>`;
  if (status === "cancelled") return `<span class="status-badge error">${Icon.xCircle}${statusLabel(status)}</span>`;
  return `<span class="status-badge warning">${Icon.info}${statusLabel(status)}</span>`;
}

/** Protocolo curto e legível derivado do UUID — não é um campo separado no banco. */
function protocol(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function receiptBadgeClass(status: ReceiptWithCounts["status"]): string {
  if (status === "completed") return "success";
  if (status === "with_divergences") return "warning";
  return "info";
}

export async function renderHistory(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <section class="history-screen">
      <div class="input-mode-switch">
        <button class="mode-btn ${historyTab === "outlet" ? "active" : ""}" data-history-tab="outlet">${Icon.package}Outlet</button>
        <button class="mode-btn ${historyTab === "nfe" ? "active" : ""}" data-history-tab="nfe">${Icon.receipt}Nota Fiscal</button>
      </div>
      <div id="historyTabContent"></div>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>("[data-history-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      historyTab = btn.dataset.historyTab as "outlet" | "nfe";
      void renderHistory(root);
    });
  });

  const content = root.querySelector<HTMLElement>("#historyTabContent")!;
  if (historyTab === "nfe") {
    await renderNfeHistoryTab(content);
  } else {
    await renderOutletHistoryTab(content);
  }
}

// ---------------------------------------------------------------------------
// Outlet (comportamento 100% preservado — só extraído pra uma sub-função).
// ---------------------------------------------------------------------------
async function renderOutletHistoryTab(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>`;

  let conferences: ConferenceWithOperator[] = [];
  try {
    conferences = await listRecentConferences(50);
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao carregar histórico: " + describeError(err), () => void renderOutletHistoryTab(root));
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h2>Histórico de conferências (Outlet)</h2>
      ${
        conferences.length === 0
          ? `<div class="empty-state">${Icon.history}<p>Nenhuma conferência registrada ainda.</p></div>`
          : `
            <div class="product-card-list mobile-only">
              ${conferences
                .map(
                  (c) => `
                <div class="product-card">
                  <div class="product-card-top">
                    <p class="product-card-name">${escapeHtml(c.name || protocol(c.id))}</p>
                    ${statusBadge(c.status)}
                  </div>
                  <div class="product-card-meta">
                    <span class="sku-code">#${protocol(c.id)}</span>
                    <span>${formatDateTime(c.created_at)}</span>
                    <span>${escapeHtml(c.operator_name || "-")}</span>
                  </div>
                  <div class="product-card-bottom">
                    <span class="hint-text" style="margin:0">${c.total_skus} SKU · ${c.total_units} un.</span>
                    <button class="btn-secondary" data-id="${c.id}">Ver detalhes</button>
                  </div>
                </div>`
                )
                .join("")}
            </div>
            <div class="table-wrap desktop-only">
              <table>
                <thead><tr><th>Protocolo</th><th>Data</th><th>Operador</th><th>Status</th><th>SKUs</th><th>Unidades</th><th></th></tr></thead>
                <tbody>
                  ${conferences
                    .map(
                      (c) => `
                    <tr>
                      <td class="sku-code">#${protocol(c.id)}</td>
                      <td>${formatDateTime(c.created_at)}</td>
                      <td>${escapeHtml(c.operator_name || "-")}</td>
                      <td>${statusBadge(c.status)}</td>
                      <td>${c.total_skus}</td>
                      <td>${c.total_units}</td>
                      <td><button class="link-btn" data-id="${c.id}">ver itens</button></td>
                    </tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
      }
    </div>
    <div id="historyDetail"></div>`;

  root.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => void showOutletDetail(root, btn.dataset.id!));
  });
}

async function showOutletDetail(root: HTMLElement, id: string): Promise<void> {
  const detailEl = root.querySelector("#historyDetail")!;
  detailEl.innerHTML = `<div class="skeleton skeleton-card"></div>`;
  try {
    const { conference, items } = await getConference(id);
    detailEl.innerHTML = `
      <div class="card">
        <h3>Itens de "${escapeHtml(conference.name || protocol(conference.id))}"</h3>
        <p class="hint-text">${conference.total_skus} SKUs · ${conference.total_units} unidades</p>
        <div class="product-card-list mobile-only">
          ${items
            .map(
              (it: ConferenceItemWithVariant) => `
            <div class="product-card">
              <div class="product-card-top"><p class="product-card-name">${escapeHtml(it.produto || it.raw_model || "-")}</p></div>
              <div class="product-card-meta">
                <span class="sku-code">${escapeHtml(it.sku_code || "-")}</span>
                <span>${escapeHtml(it.raw_color || "")}</span>
                <span>Qtd: ${it.quantity}</span>
              </div>
            </div>`
            )
            .join("")}
        </div>
        <div class="table-wrap desktop-only">
          <table>
            <thead><tr><th>Produto</th><th>Modelo (lido)</th><th>Cor</th><th>Qtd</th><th>SKU</th></tr></thead>
            <tbody>
              ${items
                .map(
                  (it: ConferenceItemWithVariant) =>
                    `<tr><td>${escapeHtml(it.produto || "-")}</td><td>${escapeHtml(it.raw_model || "")}</td><td>${escapeHtml(it.raw_color || "")}</td><td>${it.quantity}</td><td class="sku-code">${escapeHtml(
                      it.sku_code || "-"
                    )}</td></tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    detailEl.innerHTML = `<div class="error-box">Erro: ${escapeHtml(describeError(err))}</div>`;
  }
}

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Nota Fiscal (Produtos Normais). Só leitura aqui: excluir
// uma NF continua sendo feito em Conferir → Nota Fiscal → Histórico de Notas
// (mesma tabela, mesma função deleteReceipt — não duplicado).
// ---------------------------------------------------------------------------
async function renderNfeHistoryTab(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>
    <div class="skeleton skeleton-card"></div>`;

  let receipts: ReceiptWithCounts[] = [];
  try {
    receipts = await listReceiptHistory(50);
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao carregar histórico de Notas Fiscais: " + describeError(err), () => void renderNfeHistoryTab(root));
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h2>Histórico de conferências (Nota Fiscal)</h2>
      ${
        receipts.length === 0
          ? `<div class="empty-state">${Icon.receipt}<p>Nenhuma Nota Fiscal importada ainda.</p></div>`
          : `<ul class="recent-list">
              ${receipts
                .map(
                  (r) => `
                <li data-open-nfe="${r.id}" style="cursor:pointer">
                  <div>
                    <strong>NF ${escapeHtml(r.invoice_number || "-")} — ${escapeHtml(r.supplier_name || "-")}</strong>
                    <span class="hint-text" style="margin:0">${formatDateTime(r.created_at)} · ${escapeHtml(r.operator_name || "-")}</span>
                  </div>
                  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                    <span class="status-badge ${receiptBadgeClass(r.status)}">${escapeHtml(RECEIPT_STATUS_LABEL[r.status])}</span>
                    <span class="hint-text" style="margin:0">${r.item_count} item(ns)</span>
                    <a class="link-btn" style="padding:2px 4px;width:auto" href="#/conferir/nfe/${r.id}" data-open-receipt-link>Abrir NF</a>
                  </div>
                </li>`
                )
                .join("")}
            </ul>`
      }
    </div>
    <div id="nfeHistoryDetail"></div>`;

  root.querySelectorAll<HTMLElement>("[data-open-nfe]").forEach((li) => {
    li.addEventListener("click", () => void showNfeDetail(root, li.dataset.openNfe!));
  });
  // FASE 4 — "Abrir NF" é um link real de propósito (Ctrl/Cmd+click, botão do
  // meio, menu de contexto e copiar endereço funcionam nativamente) — só
  // impede que o clique NORMAL borbulhe pro <li> e dispare TAMBÉM o detalhe
  // inline acima (os dois comportamentos nunca devem acontecer juntos).
  root.querySelectorAll<HTMLAnchorElement>("[data-open-receipt-link]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  });
}

async function showNfeDetail(root: HTMLElement, id: string): Promise<void> {
  const detailEl = root.querySelector<HTMLElement>("#nfeHistoryDetail")!;
  detailEl.innerHTML = `<div class="skeleton skeleton-card"></div>`;
  try {
    const { receipt, items } = await getReceipt(id);
    const finalized = receipt.status === "completed" || receipt.status === "with_divergences";

    // Enquanto a NF não foi finalizada, a comparação NF×Física não pode
    // aparecer aqui (contagem cega — ver nfeConference.ts) — só um resumo de
    // progresso, sem revelar a quantidade esperada da nota.
    if (!finalized) {
      const counted = items.filter((it) => it.physical_quantity !== null).length;
      detailEl.innerHTML = `
        <div class="card">
          <h3>NF ${escapeHtml(receipt.invoice_number || "-")} — ${escapeHtml(receipt.supplier_name || "-")}</h3>
          <p class="hint-text">Status: ${escapeHtml(RECEIPT_STATUS_LABEL[receipt.status])} · ${counted}/${items.length} item(ns) já contado(s).</p>
          <div class="warning-box">${Icon.info} A comparação com a quantidade da nota só aparece depois de finalizada. Abra em <strong>Conferir → Nota Fiscal</strong> para continuar ou finalizar a contagem.</div>
        </div>`;
      return;
    }

    detailEl.innerHTML = `
      <div class="card">
        <h3>Relatório — NF ${escapeHtml(receipt.invoice_number || "-")}</h3>
        <p class="hint-text">${escapeHtml(receipt.supplier_name || "-")} · Finalizada em ${receipt.finished_at ? formatDateTime(receipt.finished_at) : "-"} por ${escapeHtml(receipt.finished_by_name || "-")}</p>
        <div class="product-card-list mobile-only">
          ${items
            .map(
              (it) => `
            <div class="product-card">
              <div class="product-card-top">
                <p class="product-card-name">${escapeHtml(itemTitle(it))}</p>
                ${reportStatusStamp(it.status)}
              </div>
              <div class="product-card-meta">
                <span class="sku-code">${escapeHtml(itemCodeLabel(it))}</span>
                <span>EAN: ${escapeHtml(itemEanLabel(it))}</span>
              </div>
              <div class="product-card-bottom">
                <span class="hint-text" style="margin:0">NF: ${it.expected_quantity} · Física: ${it.physical_quantity ?? "—"} · Dif.: ${it.physical_quantity === null ? "—" : it.physical_quantity - it.expected_quantity}</span>
              </div>
            </div>`
            )
            .join("")}
        </div>
        <div class="table-wrap desktop-only">
          <table>
            <thead><tr><th>Produto</th><th>SKU</th><th>EAN</th><th>Qtd NF</th><th>Qtd Física</th><th>Dif.</th><th>Status</th></tr></thead>
            <tbody>
              ${items
                .map(
                  (it) => `
                <tr>
                  <td>${escapeHtml(itemTitle(it))}</td>
                  <td class="sku-code">${escapeHtml(itemCodeLabel(it))}</td>
                  <td>${escapeHtml(itemEanLabel(it))}</td>
                  <td>${it.expected_quantity}</td>
                  <td>${it.physical_quantity ?? "—"}</td>
                  <td>${it.physical_quantity === null ? "—" : it.physical_quantity - it.expected_quantity}</td>
                  <td>${reportStatusStamp(it.status)}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    detailEl.innerHTML = `<div class="error-box">Erro: ${escapeHtml(describeError(err))}</div>`;
  }
}
