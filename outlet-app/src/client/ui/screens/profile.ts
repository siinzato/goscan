// EXPANSÃO GOSCAN — "Perfil" virou uma central com 3 sub-áreas
// (Configurações/Ajuda/Sobre), reaproveitando o MESMO hash router do shell
// (ver shell.ts: currentRoute() por prefixo) — profile.ts é quem decide qual
// sub-tela desenhar a partir do restante do hash, sem nenhuma rota nova no
// shell nem um router paralelo.
import { getAuthState, signOut } from "../../auth.ts";
import { escapeHtml, initials } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { APP_NAME, APP_COMPANY } from "../../brand.ts";
import { renderProfileSettings } from "./profileSettings.ts";
import { renderProfileHelp } from "./profileHelp.ts";
import { renderProfileAbout } from "./profileAbout.ts";
import { renderProfileIntegrations } from "./profileIntegrations.ts";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Administrador",
  admin: "Administrador",
  operator: "Operador",
  viewer: "Visualizador",
};

/** Segmentos depois de "perfil" — "#/perfil/configuracoes/administracao" -> ["configuracoes", "administracao"]. */
function profileSubPath(): string[] {
  return window.location.hash
    .replace(/^#\/?/, "")
    .split("/")
    .slice(1)
    .filter(Boolean);
}

export function renderProfile(root: HTMLElement): void {
  const sub = profileSubPath();
  if (sub[0] === "configuracoes") {
    void renderProfileSettings(root, sub.slice(1));
    return;
  }
  if (sub[0] === "ajuda") {
    renderProfileHelp(root);
    return;
  }
  if (sub[0] === "sobre") {
    renderProfileAbout(root);
    return;
  }
  if (sub[0] === "integracoes") {
    void renderProfileIntegrations(root);
    return;
  }
  renderProfileHub(root);
}

function renderProfileHub(root: HTMLElement): void {
  const { profile, session } = getAuthState();

  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        <div class="operator-card">
          <span class="avatar-initials" aria-hidden="true">${escapeHtml(initials(profile?.full_name))}</span>
          <div>
            <strong>${escapeHtml(profile?.full_name || "Operador")}</strong>
            ${profile?.job_title ? `<p class="hint-text" style="margin:2px 0 4px">${escapeHtml(profile.job_title)}</p>` : ""}
            <span class="role-tag">${escapeHtml(ROLE_LABELS[profile?.role || ""] || "")}</span>
          </div>
        </div>
        <p class="hint-text" style="margin-top:12px">${escapeHtml(session?.user.email || "")}</p>
        ${profile?.work_group ? `<p class="hint-text" style="margin-top:-10px">${escapeHtml(profile.work_group)}</p>` : ""}
        <button class="btn-secondary btn-block" id="btnLogout">${Icon.logOut}Sair</button>
      </div>

      <div class="profile-menu">
        <button type="button" class="profile-menu-item" data-goto="configuracoes">
          <span class="profile-menu-icon">${Icon.settings}</span>
          <span class="profile-menu-text">
            <strong>Configurações</strong>
            <span>Personalize sua experiência, gerencie sua conta e acesse recursos administrativos.</span>
          </span>
          <span class="profile-menu-chevron">${Icon.chevronRight}</span>
        </button>
        <button type="button" class="profile-menu-item" data-goto="ajuda">
          <span class="profile-menu-icon">${Icon.helpCircle}</span>
          <span class="profile-menu-text">
            <strong>Ajuda</strong>
            <span>Aprenda a utilizar as conferências, escaneamentos e demais recursos do GoScan.</span>
          </span>
          <span class="profile-menu-chevron">${Icon.chevronRight}</span>
        </button>
        <button type="button" class="profile-menu-item" data-goto="sobre">
          <span class="profile-menu-icon">${Icon.info}</span>
          <span class="profile-menu-text">
            <strong>Sobre o GoScan</strong>
            <span>Conheça a história, a missão e a evolução do GoScan.</span>
          </span>
          <span class="profile-menu-chevron">${Icon.chevronRight}</span>
        </button>
        <button type="button" class="profile-menu-item" data-goto="integracoes">
          <span class="profile-menu-icon">${Icon.link}</span>
          <span class="profile-menu-text">
            <strong>Integrações</strong>
            <span>Estrutura preparada para futuras integrações com ERP e marketplaces.</span>
          </span>
          <span class="profile-menu-chevron">${Icon.chevronRight}</span>
        </button>
      </div>

      <p class="hint-text" style="text-align:center">${escapeHtml(APP_NAME)} · uma ferramenta ${escapeHtml(APP_COMPANY)}</p>
    </section>`;

  root.querySelector("#btnLogout")!.addEventListener("click", async () => {
    const btn = root.querySelector("#btnLogout") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Saindo…";
    await signOut();
  });

  root.querySelectorAll<HTMLButtonElement>("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.location.hash = `/perfil/${btn.dataset.goto}`;
    });
  });
}
