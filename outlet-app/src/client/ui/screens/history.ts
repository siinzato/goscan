import {
  listRecentConferences,
  getConference,
  type Conference,
  type ConferenceWithOperator,
  type ConferenceItemWithVariant,
} from "../../conferencesApi.ts";
import { escapeHtml, formatDateTime } from "../../utils.ts";
import { Icon } from "../icons.ts";

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

export async function renderHistory(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <section class="history-screen">
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    </section>`;

  let conferences: ConferenceWithOperator[] = [];
  try {
    conferences = await listRecentConferences(50);
  } catch (err) {
    root.innerHTML = `<div class="error-box">Erro ao carregar histórico: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    return;
  }

  root.innerHTML = `
    <section class="history-screen">
      <div class="card">
        <h2>Histórico de conferências</h2>
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
      <div id="historyDetail"></div>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => void showDetail(root, btn.dataset.id!));
  });
}

async function showDetail(root: HTMLElement, id: string): Promise<void> {
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
    detailEl.innerHTML = `<div class="error-box">Erro: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}
