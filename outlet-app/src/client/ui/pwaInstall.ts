// Botão + modal "Como instalar no iOS/Android" — só aparece na tela de login
// (ver login.ts). Ensina o operador a adicionar o GoScan à tela inicial do
// celular via navegador (nunca App Store/Play Store, que não se aplicam aqui).
import { Icon } from "./icons.ts";
import { showToast } from "./toast.ts";

type Platform = "ios" | "android";

interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

interface StandaloneNavigator extends Navigator {
  standalone?: boolean;
}

interface StepContent {
  icon: string;
  title: string;
  description: string;
}

const IOS_STEPS: StepContent[] = [
  { icon: Icon.smartphone, title: "Abra no Safari", description: "Acesse o GoScan pelo navegador Safari." },
  { icon: Icon.share, title: "Toque em Compartilhar", description: "Toque no ícone de compartilhamento na barra do Safari." },
  { icon: Icon.squarePlus, title: "Adicione à Tela de Início", description: 'Role as opções e toque em "Adicionar à Tela de Início".' },
  { icon: Icon.checkCircle, title: "Pronto!", description: 'Confirme o nome "GoScan" e toque em "Adicionar". O ícone aparecerá na tela inicial.' },
];

const ANDROID_STEPS: StepContent[] = [
  { icon: Icon.smartphone, title: "Abra no Chrome", description: "Acesse o GoScan pelo Google Chrome." },
  { icon: Icon.moreVertical, title: "Abra o menu", description: "Toque no menu de três pontos no canto superior." },
  { icon: Icon.download, title: "Instale o aplicativo", description: 'Toque em "Instalar aplicativo" ou "Adicionar à tela inicial".' },
  { icon: Icon.checkCircle, title: "Pronto!", description: "Confirme a instalação. O ícone do GoScan aparecerá na tela inicial." },
];

// --- Detecção de dispositivo -----------------------------------------------

function isIOSDevice(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ se identifica como "MacIntel" no userAgent — só distingue de um
  // Mac de verdade pela presença de touch points.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isAndroidDevice(): boolean {
  return /Android/.test(navigator.userAgent);
}

function isIOSSafari(): boolean {
  if (!isIOSDevice()) return false;
  // No iOS, Chrome/Firefox/Edge/Opera incluem "Safari" no UA por compatibilidade —
  // só o Safari de verdade NÃO carrega nenhum desses tokens de terceiros.
  return !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(navigator.userAgent);
}

function isStandalone(): boolean {
  const nav = navigator as StandaloneNavigator;
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function defaultPlatform(): Platform {
  return isAndroidDevice() ? "android" : "ios";
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// --- Instalação direta (Android/Chromium) ----------------------------------

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let onDeferredPromptChange: (() => void) | null = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  onDeferredPromptChange?.();
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  onDeferredPromptChange?.();
});

async function copyInstallLink(): Promise<void> {
  const url = `${window.location.origin}/`;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showToast("Link copiado.", "success");
  } catch {
    showToast("Não foi possível copiar o link. Copie o endereço manualmente.", "error");
  }
}

async function handleDirectInstall(): Promise<void> {
  const promptEvent = deferredPrompt;
  if (!promptEvent) return;
  deferredPrompt = null; // consumido: só pode ser usado uma vez pelo navegador

  const btn = document.getElementById("pwa-direct-install") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  showToast("Instalação iniciada.", "default");

  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    showToast(
      choice.outcome === "accepted" ? "Instalação concluída." : "A instalação foi cancelada.",
      choice.outcome === "accepted" ? "success" : "default"
    );
  } catch {
    showToast("Não foi possível iniciar a instalação.", "error");
  } finally {
    renderBody();
  }
}

// --- Botão de entrada (tela de login) ---------------------------------------

const BUTTON_ID = "pwa-install-guide-btn";

export function installGuideButtonHtml(): string {
  return `<button type="button" class="install-guide-btn" id="${BUTTON_ID}">
    ${Icon.smartphone}
    <span>Como instalar no iOS/Android</span>
  </button>`;
}

export function wireInstallGuideButton(): void {
  document.getElementById(BUTTON_ID)?.addEventListener("click", (e) => {
    openInstallGuideModal(e.currentTarget as HTMLElement);
  });
}

// --- Modal -------------------------------------------------------------------

let overlayEl: HTMLDivElement | null = null;
let panelEl: HTMLDivElement | null = null;
let triggerEl: HTMLElement | null = null;
let currentPlatform: Platform = defaultPlatform();

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
}

function handlePanelKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== "Tab" || !panelEl) return;
  const focusable = getFocusable(panelEl);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function handleTabKeydown(e: KeyboardEvent): void {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  switchPlatform(currentPlatform === "ios" ? "android" : "ios");
}

function switchPlatform(platform: Platform): void {
  if (platform === currentPlatform) return;
  currentPlatform = platform;
  renderBody();
  document.getElementById(`pwa-tab-${platform}`)?.focus();
}

function renderBody(): void {
  const body = document.getElementById("pwa-install-body");
  if (!body) return;

  if (isStandalone()) {
    body.innerHTML = `
      <h2 id="pwa-install-title">O GoScan já está instalado neste dispositivo.</h2>
      <p class="hint-text" id="pwa-install-subtitle">Você está utilizando o GoScan diretamente pela tela inicial.</p>
      <div class="pwa-install-footer">
        <button type="button" class="btn-primary" id="pwa-install-done">Entendi</button>
      </div>`;
    document.getElementById("pwa-install-done")!.addEventListener("click", closeModal);
    return;
  }

  const steps = currentPlatform === "ios" ? IOS_STEPS : ANDROID_STEPS;
  const showSafariWarning = currentPlatform === "ios" && isIOSDevice() && !isIOSSafari();
  const showDirectInstall = currentPlatform === "android" && deferredPrompt !== null;

  body.innerHTML = `
    <h2 id="pwa-install-title">Instale o GoScan no seu celular</h2>
    <p class="hint-text" id="pwa-install-subtitle">Adicione o GoScan à tela inicial e acesse como um aplicativo.</p>

    <div class="pwa-tabs" role="tablist" aria-label="Escolha a plataforma">
      <button type="button" role="tab" id="pwa-tab-ios" aria-selected="${currentPlatform === "ios"}" aria-controls="pwa-tabpanel" class="pwa-tab ${currentPlatform === "ios" ? "active" : ""}" tabindex="${currentPlatform === "ios" ? "0" : "-1"}">iPhone/iPad</button>
      <button type="button" role="tab" id="pwa-tab-android" aria-selected="${currentPlatform === "android"}" aria-controls="pwa-tabpanel" class="pwa-tab ${currentPlatform === "android" ? "active" : ""}" tabindex="${currentPlatform === "android" ? "0" : "-1"}">Android</button>
    </div>

    <div role="tabpanel" id="pwa-tabpanel" aria-labelledby="pwa-tab-${currentPlatform}">
      ${
        showSafariWarning
          ? `<div class="warning-box">Para instalar no iPhone, abra este endereço no Safari e siga as instruções.</div>
             <button type="button" class="btn-secondary btn-block" id="pwa-copy-link">${Icon.copy}<span>Copiar endereço do GoScan</span></button>`
          : ""
      }

      <div class="pwa-steps">
        ${steps
          .map(
            (s, i) => `
          <div class="pwa-step-card">
            <div class="pwa-step-number">${i + 1}</div>
            <div class="pwa-step-icon">${s.icon}</div>
            <div class="pwa-step-text">
              <strong>${s.title}</strong>
              <p>${s.description}</p>
            </div>
          </div>`
          )
          .join("")}
      </div>

      <p class="hint-text">${
        currentPlatform === "ios"
          ? "No iPhone e no iPad, utilize preferencialmente o Safari para adicionar o GoScan à tela inicial."
          : "O nome da opção pode variar conforme o navegador e a versão do Android."
      }</p>

      ${showDirectInstall ? `<button type="button" class="btn-primary btn-block" id="pwa-direct-install">${Icon.download}<span>Instalar GoScan agora</span></button>` : ""}
    </div>

    <div class="pwa-install-footer">
      <button type="button" class="btn-secondary" id="pwa-install-close-footer">Fechar</button>
      ${!showDirectInstall ? `<button type="button" class="btn-primary" id="pwa-install-done">Entendi</button>` : ""}
    </div>`;

  document.getElementById("pwa-tab-ios")!.addEventListener("click", () => switchPlatform("ios"));
  document.getElementById("pwa-tab-android")!.addEventListener("click", () => switchPlatform("android"));
  document.getElementById("pwa-tab-ios")!.addEventListener("keydown", handleTabKeydown);
  document.getElementById("pwa-tab-android")!.addEventListener("keydown", handleTabKeydown);
  document.getElementById("pwa-install-close-footer")!.addEventListener("click", closeModal);
  document.getElementById("pwa-install-done")?.addEventListener("click", closeModal);
  document.getElementById("pwa-copy-link")?.addEventListener("click", () => void copyInstallLink());
  document.getElementById("pwa-direct-install")?.addEventListener("click", () => void handleDirectInstall());
}

export function openInstallGuideModal(trigger?: HTMLElement | null): void {
  if (overlayEl) return;
  triggerEl = trigger ?? null;
  currentPlatform = defaultPlatform();

  overlayEl = document.createElement("div");
  overlayEl.className = "pwa-install-overlay";
  overlayEl.innerHTML = `
    <div class="pwa-install-panel" role="dialog" aria-modal="true" aria-labelledby="pwa-install-title" aria-describedby="pwa-install-subtitle" id="pwa-install-panel">
      <button type="button" class="icon-btn pwa-install-close" id="pwa-install-close" aria-label="Fechar">${Icon.close}</button>
      <div class="pwa-install-body" id="pwa-install-body"></div>
    </div>`;
  document.body.appendChild(overlayEl);
  panelEl = overlayEl.querySelector<HTMLDivElement>(".pwa-install-panel")!;

  renderBody();
  onDeferredPromptChange = renderBody;

  document.body.classList.add("pwa-modal-open");
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) closeModal();
  });
  document.getElementById("pwa-install-close")!.addEventListener("click", () => closeModal());
  panelEl.addEventListener("keydown", handlePanelKeydown);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlayEl?.classList.add("pwa-open");
    });
  });

  document.getElementById("pwa-install-close")!.focus();
}

function closeModal(): void {
  if (!overlayEl) return;
  const overlay = overlayEl;
  overlayEl = null;
  panelEl = null;
  onDeferredPromptChange = null;
  document.body.classList.remove("pwa-modal-open");
  overlay.classList.remove("pwa-open");

  const finish = () => {
    overlay.remove();
    triggerEl?.focus();
    triggerEl = null;
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }
  let done = false;
  const onEnd = () => {
    if (done) return;
    done = true;
    finish();
  };
  overlay.addEventListener("transitionend", onEnd, { once: true });
  setTimeout(onEnd, 350);
}
