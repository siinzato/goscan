import { getAuthState } from "../../auth.ts";
import { getMyActiveConference, listRecentConferences, type Conference } from "../../conferencesApi.ts";
import { escapeHtml, formatDateTime, initials, renderErrorWithRetry } from "../../utils.ts";
import { getNetworkStatus, subscribeNetwork, type NetworkStatus } from "../../offline.ts";
import { Icon } from "../icons.ts";

function statusLabel(status: Conference["status"]): string {
  return { draft: "Rascunho", in_progress: "Em andamento", completed: "Concluída", cancelled: "Cancelada" }[status];
}

function statusBadge(status: Conference["status"]): string {
  if (status === "completed") return `<span class="status-badge success">${Icon.checkCircle}${statusLabel(status)}</span>`;
  if (status === "cancelled") return `<span class="status-badge error">${Icon.xCircle}${statusLabel(status)}</span>`;
  return `<span class="status-badge warning">${Icon.info}${statusLabel(status)}</span>`;
}

const CONNECTION_META: Record<NetworkStatus, { label: string; cls: string; icon: string }> = {
  online: { label: "Conectado", cls: "online", icon: Icon.checkCircle },
  synced: { label: "Conectado", cls: "online", icon: Icon.checkCircle },
  offline: { label: "Offline", cls: "offline", icon: Icon.wifiOff },
  reconnecting: { label: "Sincronizando…", cls: "syncing", icon: Icon.loader },
  sync_error: { label: "Erro ao sincronizar", cls: "offline", icon: Icon.alertTriangle },
};

function connectionPill(): string {
  const meta = CONNECTION_META[getNetworkStatus()];
  return `<span class="connection-pill ${meta.cls}" id="home-connection-pill">${meta.icon}${meta.label}</span>`;
}

export async function renderHome(root: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  root.innerHTML = `
    <section class="home-screen">
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card" style="height:120px"></div>
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-card"></div>
    </section>`;

  let active: Conference | null = null;
  let recent: Conference[] = [];
  try {
    [active, recent] = await Promise.all([getMyActiveConference(), listRecentConferences(8)]);
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao carregar: " + (err instanceof Error ? err.message : String(err)), () => void renderHome(root));
    return;
  }

  root.innerHTML = `
    <section class="home-screen">
      <div class="operator-card">
        <span class="avatar-initials" aria-hidden="true">${escapeHtml(initials(profile?.full_name))}</span>
        <div>
          <strong>${escapeHtml(profile?.full_name || "Operador")}</strong>
          <span class="role-tag">${escapeHtml(profile?.role || "")}</span>
        </div>
        <div style="margin-left:auto">${connectionPill()}</div>
      </div>

      ${
        active
          ? `<div class="active-conference-card">
               <p class="hint-text">Conferência em andamento</p>
               <strong style="font-size:16px">${escapeHtml(active.name || formatDateTime(active.created_at))}</strong>
               <div class="active-conference-stats">
                 <span class="active-conference-stat">${active.total_skus || 0}<span>SKUs</span></span>
                 <span class="active-conference-stat">${active.total_units || 0}<span>Unidades</span></span>
               </div>
               <button class="btn-primary btn-block" id="btn-continue">Continuar conferência</button>
             </div>`
          : `<button class="btn-primary btn-block btn-large" id="btn-new">${Icon.camera}Iniciar nova conferência</button>`
      }

      <h2>Atividades recentes</h2>
      ${
        recent.length === 0
          ? `<div class="empty-state">${Icon.history}<p>Nenhuma conferência ainda. Suas conferências recentes vão aparecer aqui.</p></div>`
          : `<ul class="recent-list">
              ${recent
                .map(
                  (c) => `
                <li>
                  <div>
                    <strong>${escapeHtml(c.name || formatDateTime(c.created_at))}</strong>
                    <span class="hint-text" style="margin:0">${formatDateTime(c.created_at)}</span>
                  </div>
                  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                    ${statusBadge(c.status)}
                    <span class="hint-text" style="margin:0">${c.total_skus} SKU · ${c.total_units} un.</span>
                  </div>
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

  const unsubscribe = subscribeNetwork(() => {
    const pill = document.getElementById("home-connection-pill");
    if (!pill || !document.body.contains(pill)) {
      unsubscribe();
      return;
    }
    const meta = CONNECTION_META[getNetworkStatus()];
    pill.className = `connection-pill ${meta.cls}`;
    pill.innerHTML = `${meta.icon}${meta.label}`;
  });
}
