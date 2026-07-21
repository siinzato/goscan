import { getAuthState } from "../auth.ts";
import { escapeHtml } from "../utils.ts";
import { APP_NAME } from "../brand.ts";
import { Icon } from "./icons.ts";
import { renderHome } from "./screens/home.ts";
import { renderConference } from "./screens/conference.ts";
import { renderScan, teardownScan, unlockScanSound } from "./screens/scan.ts";
import { renderCatalog } from "./screens/catalog.ts";
import { renderHistory } from "./screens/history.ts";
import { renderProfile } from "./screens/profile.ts";

type Route = "inicio" | "conferir" | "escanear" | "catalogo" | "historico" | "perfil";

const TABS: { route: Route; label: string; icon: string }[] = [
  { route: "inicio", label: "Início", icon: Icon.home },
  { route: "conferir", label: "Conferir", icon: Icon.camera },
  { route: "escanear", label: "Escanear", icon: Icon.scan },
  { route: "catalogo", label: "Catálogo", icon: Icon.package },
  { route: "historico", label: "Histórico", icon: Icon.history },
  { route: "perfil", label: "Perfil", icon: Icon.user },
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
          <img class="app-header-logo" src="/brand/goscan-wordmark.png" alt="${APP_NAME}" />
          <div class="app-header-text">
            <span class="app-header-sub">${escapeHtml(profile?.full_name || "")} · ${escapeHtml(profile?.role || "")}</span>
          </div>
        </header>
        <main id="screen-content" class="screen-content"></main>
        <nav class="bottom-nav" aria-label="Navegação principal">
          ${TABS.map(
            (t) => `
            <button class="bottom-nav-btn" data-route="${t.route}" aria-label="${t.label}">
              <span class="bottom-nav-icon" aria-hidden="true">${t.icon}</span>
              <span class="bottom-nav-label">${escapeHtml(t.label)}</span>
            </button>`
          ).join("")}
        </nav>
      </div>`;

    root.querySelectorAll<HTMLButtonElement>(".bottom-nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        // Precisa acontecer dentro deste clique (gesto real do usuário) — é a
        // única chance de "destravar" o áudio do beep de reconhecimento antes
        // do primeiro achado, já que o navegador bloqueia play() assíncrono
        // sem gesto (ver unlockScanSound).
        if (btn.dataset.route === "escanear") unlockScanSound();
        window.location.hash = `/${btn.dataset.route}`;
      });
    });

    window.addEventListener("hashchange", renderCurrentScreen);
    shellMounted = true;
  }
  renderCurrentScreen();
}

let previousRoute: Route | null = null;

function renderCurrentScreen(): void {
  const content = document.getElementById("screen-content");
  if (!content) return;
  const route = currentRoute();

  // Sair da tela de câmera precisa sempre encerrar as tracks — nunca deixar
  // a câmera aberta em segundo plano enquanto o usuário navega para outra aba.
  if (previousRoute === "escanear" && route !== "escanear") teardownScan();
  previousRoute = route;

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
    case "escanear":
      void renderScan(content);
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

window.addEventListener("beforeunload", () => {
  if (previousRoute === "escanear") teardownScan();
});
