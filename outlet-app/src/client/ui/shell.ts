import { getAuthState } from "../auth.ts";
import { escapeHtml } from "../utils.ts";
import { renderHome } from "./screens/home.ts";
import { renderConference } from "./screens/conference.ts";
import { renderCatalog } from "./screens/catalog.ts";
import { renderHistory } from "./screens/history.ts";
import { renderProfile } from "./screens/profile.ts";

type Route = "inicio" | "conferir" | "catalogo" | "historico" | "perfil";

const TABS: { route: Route; label: string; icon: string }[] = [
  { route: "inicio", label: "Início", icon: "🏠" },
  { route: "conferir", label: "Conferir", icon: "📷" },
  { route: "catalogo", label: "Catálogo", icon: "📦" },
  { route: "historico", label: "Histórico", icon: "🕘" },
  { route: "perfil", label: "Perfil", icon: "👤" },
];

function currentRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "") as Route;
  return (TABS.some((t) => t.route === hash) ? hash : "inicio") as Route;
}

let shellMounted = false;

export function mountShell(root: HTMLElement): void {
  if (!shellMounted) {
    const { profile } = getAuthState();
    root.innerHTML = `
      <div class="app-shell">
        <header class="app-header">
          <span class="brand-mark">OUT</span>
          <div class="app-header-text">
            <strong>Conferência de Estoque</strong>
            <span class="app-header-sub">${escapeHtml(profile?.full_name || "")} · ${escapeHtml(profile?.role || "")}</span>
          </div>
        </header>
        <main id="screen-content" class="screen-content"></main>
        <nav class="bottom-nav" aria-label="Navegação principal">
          ${TABS.map(
            (t) => `
            <button class="bottom-nav-btn" data-route="${t.route}" aria-label="${t.label}">
              <span class="bottom-nav-icon" aria-hidden="true">${t.icon}</span>
              <span class="bottom-nav-label">${t.label}</span>
            </button>`
          ).join("")}
        </nav>
      </div>`;

    root.querySelectorAll<HTMLButtonElement>(".bottom-nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.location.hash = `/${btn.dataset.route}`;
      });
    });

    window.addEventListener("hashchange", renderCurrentScreen);
    shellMounted = true;
  }
  renderCurrentScreen();
}

function renderCurrentScreen(): void {
  const content = document.getElementById("screen-content");
  if (!content) return;
  const route = currentRoute();

  document.querySelectorAll<HTMLButtonElement>(".bottom-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === route);
    btn.setAttribute("aria-current", btn.dataset.route === route ? "page" : "false");
  });

  switch (route) {
    case "inicio":
      void renderHome(content);
      break;
    case "conferir":
      void renderConference(content);
      break;
    case "catalogo":
      void renderCatalog(content);
      break;
    case "historico":
      void renderHistory(content);
      break;
    case "perfil":
      void renderProfile(content);
      break;
  }
}
