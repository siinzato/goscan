import { listRecentConferences, getConference, type Conference, type ConferenceItemWithVariant } from "../../conferencesApi.ts";
import { escapeHtml, formatDateTime } from "../../utils.ts";

function statusLabel(status: Conference["status"]): string {
  return { draft: "Rascunho", in_progress: "Em andamento", completed: "Concluída", cancelled: "Cancelada" }[status];
}

export async function renderHistory(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="screen-loading">Carregando histórico…</div>`;

  let conferences: Conference[] = [];
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
            ? `<p class="hint-text">Nenhuma conferência registrada ainda.</p>`
            : `<div class="table-wrap">
                <table>
                  <thead><tr><th>Data</th><th>Nome</th><th>Status</th><th>SKUs</th><th>Unidades</th><th></th></tr></thead>
                  <tbody>
                    ${conferences
                      .map(
                        (c) => `
                      <tr>
                        <td>${formatDateTime(c.created_at)}</td>
                        <td>${escapeHtml(c.name || "-")}</td>
                        <td>${statusLabel(c.status)}</td>
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
  detailEl.innerHTML = `<p class="hint-text">Carregando itens…</p>`;
  try {
    const { conference, items } = await getConference(id);
    detailEl.innerHTML = `
      <div class="card">
        <h3>Itens de "${escapeHtml(conference.name || formatDateTime(conference.created_at))}"</h3>
        <p class="hint-text">${conference.total_skus} SKUs · ${conference.total_units} unidades</p>
        <div class="table-wrap">
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
