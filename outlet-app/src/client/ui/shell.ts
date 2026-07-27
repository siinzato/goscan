import { getAuthState } from "../auth.ts";
import { escapeHtml } from "../utils.ts";
import { APP_NAME } from "../brand.ts";
import { Icon } from "./icons.ts";
import { renderHome } from "./screens/home.ts";
import { renderScan, teardownScan, unlockScanSound } from "./screens/scan.ts";

type Route = "inicio" | "conferir" | "escanear" | "catalogo" | "historico" | "perfil";

const TABS: { route: Route; label: string; icon: string }[] = [
  { route: "inicio", label: "Início", icon: Icon.home },
  { route: "conferir", label: "Conferir", icon: Icon.camera },
  { route: "escanear", label: "Escanear", icon: Icon.scan },
  { route: "catalogo", label: "Catálogo", icon: Icon.package },
  { route: "historico", label: "Histórico", icon: Icon.history },
  { route: "perfil", label: "Perfil", icon: Icon.user },
];

// EXPANSÃO GOSCAN — Central de Perfil: sub-rotas internas
// (#/perfil/configuracoes, #/perfil/ajuda, #/perfil/sobre,
// #/perfil/configuracoes/administracao). O shell só decide a ABA ativa
// (primeiro segmento do hash) — profile.ts é quem olha o hash completo e
// decide qual sub-tela desenhar, com seu próprio "voltar". Nenhum router
// novo: mesmo hashchange já existente disparando renderCurrentScreen().
function currentRoute(): Route {
  const first = window.location.hash.replace(/^#\/?/, "").split("/")[0] as Route;
  return (TABS.some((t) => t.route === first) ? first : "inicio") as Route;
}

// Lazy loading por rota (nunca baixa código que a rota atual não precisa):
// "Início" e "Escanear" ficam FORA de propósito. "Início" é sempre a
// primeira tela mostrada — adiar o download dela não ganha nada. "Escanear"
// precisa estar pronto no MESMO gesto de clique que destrava o áudio do
// beep de reconhecimento no Safari/iOS (ver unlockScanSound) — um import()
// dinâmico bem ali arrisca perder a "janela de gesto do usuário" em
// aparelhos mais lentos, quebrando esse fix real de produção. As outras 4
// rotas (Conferir/Catálogo/Histórico/Perfil) só baixam o código quando
// abertas pela primeira vez.
let catalogModule: typeof import("./screens/catalog.ts") | null = null;
let catalogVisualModule: typeof import("./screens/catalogVisual.ts") | null = null;
let conferenceModule: typeof import("./screens/conference.ts") | null = null;
let historyModule: typeof import("./screens/history.ts") | null = null;
let profileModule: typeof import("./screens/profile.ts") | null = null;

async function ensureCatalogModule(): Promise<typeof import("./screens/catalog.ts")> {
  if (!catalogVisualModule) catalogVisualModule = await import("./screens/catalogVisual.ts");
  if (!catalogModule) catalogModule = await import("./screens/catalog.ts");
  return catalogModule;
}
async function ensureConferenceModule(): Promise<typeof import("./screens/conference.ts")> {
  if (!conferenceModule) conferenceModule = await import("./screens/conference.ts");
  return conferenceModule;
}
async function ensureHistoryModule(): Promise<typeof import("./screens/history.ts")> {
  if (!historyModule) historyModule = await import("./screens/history.ts");
  return historyModule;
}
async function ensureProfileModule(): Promise<typeof import("./screens/profile.ts")> {
  if (!profileModule) profileModule = await import("./screens/profile.ts");
  return profileModule;
}

const ROUTE_SKELETON = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card" style="height:120px"></div>`;

let shellMounted = false;

export function mountShell(root: HTMLElement): void {
  // Idempotente de propósito: subscribeAuth (main.ts) chama mountShell() de
  // novo toda vez que o estado de auth notifica "signed_in" — inclusive numa
  // renovação silenciosa de token depois que a aba volta do segundo plano
  // (ver visibilitychange em auth.ts). Sem esse guard, cada uma dessas
  // notificações redundantes forçava renderCurrentScreen() de novo, e isso
  // era o "reset" real: tela atual recarregada do zero, scroll voltando pro
  // topo e filtros/página perdidos, mesmo sem o usuário ter navegado.
  if (shellMounted) return;

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
      // sem gesto (ver unlockScanSound). scan.ts nunca é lazy-loaded — ver
      // comentário acima — exatamente para essa chamada poder ser síncrona.
      if (btn.dataset.route === "escanear") unlockScanSound();
      window.location.hash = `/${btn.dataset.route}`;
    });
  });

  window.addEventListener("hashchange", renderCurrentScreen);
  shellMounted = true;
  renderCurrentScreen();
}

let previousRoute: Route | null = null;
let renderSeq = 0;

function renderCurrentScreen(): void {
  const content = document.getElementById("screen-content");
  if (!content) return;
  const route = currentRoute();
  const mySeq = ++renderSeq;

  // Sair da tela de câmera precisa sempre encerrar as tracks — nunca deixar
  // a câmera aberta em segundo plano enquanto o usuário navega para outra aba.
  if (previousRoute === "escanear" && route !== "escanear") teardownScan();
  // Só chama se o módulo já tiver sido carregado alguma vez (o usuário
  // precisa ter visitado "catalogo" antes pra isso não ser null) — nunca
  // dispara um import() dentro do teardown, que precisa ser síncrono.
  if (previousRoute === "catalogo" && route !== "catalogo") catalogVisualModule?.teardownTraining();
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
      if (!conferenceModule) content.innerHTML = ROUTE_SKELETON;
      void ensureConferenceModule().then((m) => {
        if (mySeq === renderSeq) void m.renderConference(content);
      });
      break;
    case "escanear":
      void renderScan(content);
      break;
    case "catalogo":
      if (!catalogModule) content.innerHTML = ROUTE_SKELETON;
      void ensureCatalogModule().then((m) => {
        if (mySeq === renderSeq) void m.renderCatalog(content);
      });
      break;
    case "historico":
      if (!historyModule) content.innerHTML = ROUTE_SKELETON;
      void ensureHistoryModule().then((m) => {
        if (mySeq === renderSeq) void m.renderHistory(content);
      });
      break;
    case "perfil":
      if (!profileModule) content.innerHTML = ROUTE_SKELETON;
      void ensureProfileModule().then((m) => {
        if (mySeq === renderSeq) void m.renderProfile(content);
      });
      break;
  }
}

window.addEventListener("beforeunload", () => {
  if (previousRoute === "escanear") teardownScan();
  if (previousRoute === "catalogo") catalogVisualModule?.teardownTraining();
});
