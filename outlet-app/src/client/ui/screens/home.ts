import { getAuthState } from "../../auth.ts";
import { getMyActiveConference, listRecentConferences, type Conference } from "../../conferencesApi.ts";
import { escapeHtml, formatDateTime } from "../../utils.ts";

function statusLabel(status: Conference["status"]): string {
  return { draft: "Rascunho", in_progress: "Em andamento", completed: "Concluída", cancelled: "Cancelada" }[status];
}

export async function renderHome(root: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  root.innerHTML = `<div class="screen-loading">Carregando…</div>`;

  let active: Conference | null = null;
  let recent: Conference[] = [];
  try {
    [active, recent] = await Promise.all([getMyActiveConference(), listRecentConferences(8)]);
  } catch (err) {
    root.innerHTML = `<div class="error-box">Erro ao carregar: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`;
    return;
  }

  root.innerHTML = `
    <section class="home-screen">
      <div class="operator-card">
        <span class="operator-avatar" aria-hidden="true">👤</span>
        <div>
          <strong>${escapeHtml(profile?.full_name || "Operador")}</strong>
          <span class="role-tag">${escapeHtml(profile?.role || "")}</span>
        </div>
      </div>

      ${
        active
          ? `<button class="btn-primary btn-block btn-large" id="btn-continue">
               Continuar conferência em andamento (${active.total_skus || 0} SKU · status: ${statusLabel(active.status)})
             </button>`
          : `<button class="btn-primary btn-block btn-large" id="btn-new">Iniciar nova conferência</button>`
      }

      <h2>Conferências recentes</h2>
      ${
        recent.length === 0
          ? `<p class="hint-text">Nenhuma conferência ainda.</p>`
          : `<ul class="recent-list">
              ${recent
                .map(
                  (c) => `
                <li>
                  <div>
                    <strong>${escapeHtml(c.name || formatDateTime(c.created_at))}</strong>
                    <span class="hint-text">${formatDateTime(c.created_at)} · ${statusLabel(c.status)}</span>
                  </div>
                  <span class="stamp ${c.status === "completed" ? "ok" : "warn"}">${c.total_skus} SKU · ${c.total_units} un.</span>
                </li>`
                )
                .join("")}
            </ul>`
      }
    </section>`;

  document.getElementById("btn-continue")?.addEventListener("click", () => {
    window.location.hash = "/conferir";
  });
  document.getElementById("btn-new")?.addEventListener("click", () => {
    window.location.hash = "/conferir";
  });
}
