// Modo Scan — Parte 4: câmera ao vivo + sugestões + quantidade + inclusão na
// conferência. Consome o serviço real da Parte 3 (/api/scan/recognize) e o
// mesmo serviço central de inclusão do modo manual (conferenceSession.addItem).
import { escapeHtml } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import {
  startCamera,
  blobToBase64,
  CameraPermissionDeniedError,
  CameraUnavailableError,
  type CameraController,
} from "../../scanCamera.ts";
import { recognizeFrame, type RecognizeResult, type RecognizeCandidate } from "../../scanApi.ts";
import { Stabilizer, stabilityKeyFor } from "../../scanStabilizer.ts";
import { searchSkuForPicker, type CatalogRow } from "../../catalogApi.ts";
import { getSignedImageUrl } from "../../visualScanApi.ts";
import { recordScanLearning, reportUnclassifiedProduct } from "../../visualLearningApi.ts";
import { startOrResumeConference, addItem, subscribeSession, type Session } from "../../conferenceSession.ts";
import { getAuthState, isAdmin } from "../../auth.ts";

type ScanState =
  | "requesting_permission"
  | "analyzing"
  | "stabilizing"
  | "product_found"
  | "multiple_capacities"
  | "low_confidence"
  | "no_result"
  | "confirming"
  | "item_added"
  | "cooldown"
  | "error"
  | "manual_search"
  | "offline";

const TICK_INTERVAL_MS = 1000;
// BUG REAL corrigido: teste físico no iPhone mostrou a categoria detectada
// pelo backend (garrafa vs copo) oscilando de ciclo a ciclo pro MESMO objeto
// parado — 2 leituras seguidas por acaso na categoria errada já bastavam
// pra "estabilizar" (ver stabilityKeyFor). Subir pra 3 dá mais defesa contra
// esse ruído real, com custo de ~1s a mais até a primeira sugestão.
const STABLE_CONSECUTIVE = 3;
// BUG REAL corrigido (30-40s presos em "Estabilizando..."): Stabilizer agora
// tolera ruído isolado (ver scanStabilizer.ts), mas ruído PERSISTENTE (sem
// maioria clara) ainda podia deixar o operador esperando indefinidamente.
// Depois desse tempo tentando estabilizar o MESMO produto, usa o resultado
// mais recente mesmo sem 3 leituras concordantes — nunca fica preso pra
// sempre. Não muda confidence_level/threshold algum, só decide não esperar
// mais por confirmação repetida do que o algoritmo já está vendo agora.
const STABILIZATION_TIMEOUT_MS = 3000;
const NO_RESULT_STREAK_TO_SHOW = 3;
const COOLDOWN_MIN_MS = 2000;
// Calibrado na Parte 5: 480px/0.7 preservava mal detalhes finos (logo, brilho
// do aro metálico) que ajudam a diferenciar produtos parecidos. 640px/0.85
// ainda gera um payload pequeno (dezenas de KB), bem abaixo de maxFrameBytes.
const FRAME_MAX_DIMENSION = 640;
const FRAME_QUALITY = 0.85;

let camera: CameraController | null = null;
let currentSession: Session | null = null;
let unsubscribeSession: (() => void) | null = null;

let scanState: ScanState = "requesting_permission";
let currentResult: RecognizeResult | null = null;
let selectedCandidate: RecognizeCandidate | null = null;
let selectedViaManualSearch = false;
let quantity = 1;
let errorMessage = "";

// Memória visual: o frame + resultado da ÚLTIMA tentativa de reconhecimento
// (independente de ter estabilizado ou não), usados pra alimentar o
// aprendizado quando o operador confirma/corrige — precisam sobreviver a
// entrar em "manual_search" (o loop de análise para, mas o contexto da
// última tentativa real continua sendo o certo pra registrar).
let lastAnalyzedFrameBase64: string | null = null;
let lastRecognitionAttempt: RecognizeResult | null = null;

let stabilizer = new Stabilizer(STABLE_CONSECUTIVE, 6);
// Marca QUANDO entramos em "stabilizing" pela última vez (não a cada ciclo,
// só na transição) — gerenciado inteiramente dentro de setState(), nunca
// precisa ser sincronizado manualmente com os vários stabilizer.reset()
// espalhados pelo arquivo (sair de "stabilizing" pra qualquer outro estado
// já limpa isso sozinho).
let stabilizingEnteredAt: number | null = null;
let noResultStreak = 0;

// Diagnóstico (só admin, ver renderDiagnosticPanel) — dados reais medidos
// nesta sessão de scan, nunca inventados/estimados.
let diagTickCount = 0;
let diagLastCycleMs = 0;
let loopTimer: ReturnType<typeof setInterval> | null = null;
let isRequesting = false;
let requestSeq = 0;
let cooldownProductKey: string | null = null;
let cooldownStartedAt = 0;

let rootEl: HTMLElement | null = null;

// Tocado só na transição pra "encontrou o produto" — nunca a cada ciclo de
// análise (isso soaria a cada ~1s enquanto a câmera está só procurando).
// Criado sob demanda (não no carregamento do módulo) pra não baixar o áudio
// de quem nunca abre a tela de Escanear.
let foundSound: HTMLAudioElement | null = null;
function getFoundSound(): HTMLAudioElement {
  if (!foundSound) {
    foundSound = new Audio("/sounds/scan-found.mp3");
    foundSound.preload = "auto";
  }
  return foundSound;
}
const FOUND_SOUND_STATES: ScanState[] = ["product_found", "multiple_capacities"];

/**
 * Safari (e a maioria dos navegadores mobile) só libera play() programático
 * de áudio quando ele acontece dentro do mesmo gesto do usuário (clique/toque)
 * — o beep de "produto encontrado" dispara depois, de forma assíncrona (após
 * o reconhecimento), fora dessa janela, e o navegador bloqueia silenciosamente
 * (sem erro visível, só não toca). Chamar isto dentro do próprio clique que
 * abre a tela de Escanear "destrava" o elemento de áudio pro resto da sessão
 * da página — os play() posteriores (assíncronos) passam a funcionar.
 */
export function unlockScanSound(): void {
  const sound = getFoundSound();
  sound
    .play()
    .then(() => {
      sound.pause();
      sound.currentTime = 0;
    })
    .catch(() => {
      /* se nem isso for permitido, o beep simplesmente não toca — não é crítico */
    });
}

function setState(next: ScanState): void {
  const isNewFind = FOUND_SOUND_STATES.includes(next) && !FOUND_SOUND_STATES.includes(scanState);
  // Só marca a ENTRADA em "stabilizing" (não a cada ciclo que continua nele)
  // — usado pra saber há quanto tempo estamos tentando estabilizar o mesmo
  // produto, sem precisar sincronizar isso com os vários stabilizer.reset()
  // espalhados pelo arquivo (sair de "stabilizing" já limpa isso sozinho).
  if (next === "stabilizing") {
    if (scanState !== "stabilizing") stabilizingEnteredAt = Date.now();
  } else {
    stabilizingEnteredAt = null;
  }
  scanState = next;
  if (isNewFind) {
    const sound = getFoundSound();
    sound.currentTime = 0;
    void sound.play().catch(() => {
      /* navegador pode bloquear autoplay sem gesto do usuário — silencioso, não trava o fluxo */
    });
  }
  renderOverlay();
}

export async function renderScan(root: HTMLElement): Promise<void> {
  rootEl = root;
  // Reforço: se por algum motivo o clique no menu inferior não bastou pra
  // destravar o áudio (ex.: navegação direta por hash), o primeiro toque
  // em qualquer lugar desta tela tenta de novo.
  root.addEventListener("click", unlockScanSound, { once: true });
  unsubscribeSession?.();
  scanState = "requesting_permission";
  currentResult = null;
  selectedCandidate = null;
  quantity = 1;
  stabilizer = new Stabilizer(STABLE_CONSECUTIVE, 6);
  noResultStreak = 0;
  cooldownProductKey = null;
  stabilizingEnteredAt = null;
  diagTickCount = 0;
  diagLastCycleMs = 0;

  root.innerHTML = `
    <section class="scan-screen">
      <div class="scan-camera-wrap">
        <video id="scanVideo" class="scan-video" playsinline muted></video>
        <div class="scan-frame-guide" aria-hidden="true"></div>
        <div class="scan-top-controls">
          <button class="scan-icon-btn" id="scanClose" aria-label="Fechar câmera">${Icon.close}</button>
          <div class="scan-top-right">
            <button class="scan-icon-btn" id="scanTorch" aria-label="Lanterna" hidden>${Icon.flashlight}</button>
            <button class="scan-icon-btn" id="scanSwitchCamera" aria-label="Trocar câmera">${Icon.switchCamera}</button>
          </div>
        </div>
        <div id="scanStatusBadge" class="scan-status-badge"></div>
      </div>
      <div id="scanDiagPanel"></div>
      <div id="scanBottomSheet" class="scan-bottom-sheet"></div>
    </section>`;

  document.getElementById("scanClose")!.addEventListener("click", () => {
    window.location.hash = "/conferir";
  });

  try {
    currentSession = await startOrResumeConference();
  } catch (err) {
    showToast("Erro ao carregar conferência: " + (err instanceof Error ? err.message : String(err)), "error");
    window.location.hash = "/conferir";
    return;
  }
  unsubscribeSession = subscribeSession((s) => {
    currentSession = s;
  });

  await initCamera(root);

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

/** Chamado pelo router ao sair da tela — nunca deixa a câmera aberta em segundo plano. */
export function teardownScan(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  camera?.stop();
  camera = null;
  unsubscribeSession?.();
  unsubscribeSession = null;
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function handleOnline(): void {
  if (scanState === "offline") setState("analyzing");
}
function handleOffline(): void {
  setState("offline");
}

/**
 * App em segundo plano: o navegador costuma suspender a track de vídeo
 * sozinho, mas o loop de análise continuaria tentando capturar/enviar
 * quadros de uma câmera efetivamente parada — desperdiçando bateria/rede e
 * só gerando erro a cada ciclo. Ao voltar ao app, a câmera é reaberta do
 * zero (mais confiável do que assumir que a track antiga ainda está viva).
 */
function handleVisibilityChange(): void {
  if (document.hidden) {
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = null;
  } else if (rootEl && camera) {
    camera.stop();
    camera = null;
    void initCamera(rootEl);
  }
}

async function initCamera(root: HTMLElement): Promise<void> {
  const videoEl = root.querySelector<HTMLVideoElement>("#scanVideo")!;
  setState("requesting_permission");
  try {
    camera = await startCamera(videoEl, "environment");
    document.getElementById("scanTorch")!.hidden = !camera.hasTorch();
    wireCameraControls(root);
    setState("analyzing");
    startLoop();
  } catch (err) {
    if (err instanceof CameraPermissionDeniedError) {
      errorMessage = "Permissão de câmera negada. Habilite o acesso à câmera nas configurações do navegador e tente novamente.";
    } else if (err instanceof CameraUnavailableError) {
      errorMessage = "Não foi possível acessar a câmera: " + err.message;
    } else {
      errorMessage = "Erro inesperado ao abrir a câmera.";
    }
    setState("error");
  }
}

function wireCameraControls(root: HTMLElement): void {
  root.querySelector("#scanSwitchCamera")!.addEventListener("click", async () => {
    try {
      await camera!.switchCamera();
      document.getElementById("scanTorch")!.hidden = !camera!.hasTorch();
    } catch {
      showToast("Não foi possível trocar de câmera.", "error");
    }
  });
  root.querySelector("#scanTorch")!.addEventListener("click", async () => {
    const on = await camera!.toggleTorch();
    const btn = document.getElementById("scanTorch")!;
    btn.innerHTML = on ? Icon.flashlightOff : Icon.flashlight;
  });
}

function startLoop(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

const ACTIVE_TICK_STATES: ScanState[] = ["analyzing", "stabilizing", "no_result", "cooldown"];

async function tick(): Promise<void> {
  if (isRequesting || !camera || !currentSession) return;
  if (!ACTIVE_TICK_STATES.includes(scanState)) return;
  if (!navigator.onLine) {
    setState("offline");
    return;
  }

  const mySeq = ++requestSeq;
  isRequesting = true;
  diagTickCount++;
  const cycleStartedAt = performance.now();
  try {
    const blob = await camera.captureFrameBlob(FRAME_MAX_DIMENSION, FRAME_QUALITY);
    if (!blob) return;
    const base64 = await blobToBase64(blob);
    if (mySeq !== requestSeq) return; // uma requisição mais nova já foi disparada
    const result = await recognizeFrame(currentSession.conference.id, base64);
    if (mySeq !== requestSeq) return; // resposta obsoleta — descarta
    diagLastCycleMs = Math.round(performance.now() - cycleStartedAt);
    // Sempre atualiza, independente de a leitura ter estabilizado — é o
    // contexto usado pra registrar aprendizado (recognition_id/confiança da
    // TENTATIVA real, não só das que viraram sugestão na tela).
    lastAnalyzedFrameBase64 = base64;
    lastRecognitionAttempt = result;
    handleResult(result);
  } catch (err) {
    if (mySeq !== requestSeq) return;
    // Erro de rede/rate-limit num ciclo isolado não trava a experiência —
    // só tenta de novo no próximo tick.
    console.warn("[scan] falha num ciclo de análise:", err instanceof Error ? err.message : err);
  } finally {
    isRequesting = false;
  }
}

function handleResult(result: RecognizeResult): void {
  const key = stabilityKeyFor(result);

  if (scanState === "cooldown") {
    const stillSameProduct = cooldownProductKey && key === cooldownProductKey;
    const cooldownElapsed = Date.now() - cooldownStartedAt >= COOLDOWN_MIN_MS;
    if (stillSameProduct || !cooldownElapsed) {
      return; // mesma cena ainda — continua em cooldown, silenciosamente
    }
    // cena mudou (produto diferente ou nada) — sai do cooldown e processa normalmente
    cooldownProductKey = null;
    stabilizer.reset();
    noResultStreak = 0;
  }

  if (key === null) {
    noResultStreak++;
    stabilizer.reset();
    setState(noResultStreak >= NO_RESULT_STREAK_TO_SHOW ? "no_result" : "analyzing");
    return;
  }
  noResultStreak = 0;

  const { isStable } = stabilizer.push(key);
  currentResult = result;

  if (!isStable) {
    const elapsedStabilizing = stabilizingEnteredAt ? Date.now() - stabilizingEnteredAt : 0;
    if (elapsedStabilizing < STABILIZATION_TIMEOUT_MS) {
      setState("stabilizing");
      return;
    }
    // Timeout: tentamos estabilizar o mesmo produto por tempo suficiente sem
    // 3 leituras concordantes (ruído persistente, não só um blip isolado).
    // Segue com o resultado MAIS RECENTE em vez de esperar pra sempre — usa
    // exatamente a mesma confidence_level/requires_capacity_selection que o
    // algoritmo já calculou, nunca afrouxa o critério de confiança.
  }

  if (result.requires_capacity_selection) {
    setState("multiple_capacities");
  } else if (result.confidence_level === "high") {
    setState("product_found");
  } else {
    setState("low_confidence");
  }
}

// ---------------------------------------------------------------------------
// Renderização do overlay/bottom sheet por estado
// ---------------------------------------------------------------------------

function renderOverlay(): void {
  if (!rootEl) return;
  const badge = rootEl.querySelector("#scanStatusBadge");
  const sheet = rootEl.querySelector("#scanBottomSheet");
  if (!badge || !sheet) return;

  const badges: Partial<Record<ScanState, string>> = {
    requesting_permission: "Solicitando permissão da câmera…",
    analyzing: "Analisando…",
    stabilizing: "Estabilizando…",
    cooldown: "Retire ou troque o produto",
    offline: "Sem conexão — aguardando rede…",
  };
  badge.textContent = badges[scanState] ?? "";
  badge.className = `scan-status-badge${scanState === "offline" ? " warning" : ""}`;

  const diagPanel = rootEl.querySelector("#scanDiagPanel");
  if (diagPanel) diagPanel.innerHTML = renderDiagnosticPanelHtml();

  switch (scanState) {
    case "error":
      sheet.innerHTML = `
        <div class="scan-card">
          <p class="error-box">${escapeHtml(errorMessage)}</p>
          <button class="btn-primary btn-block" id="scanRetry">Tentar novamente</button>
          <button class="btn-secondary btn-block" id="scanManualFromError">${Icon.search}Buscar manualmente</button>
        </div>`;
      sheet.querySelector("#scanRetry")!.addEventListener("click", () => void initCamera(rootEl!));
      sheet.querySelector("#scanManualFromError")!.addEventListener("click", () => setState("manual_search"));
      break;

    case "no_result": {
      // BUG REAL corrigido: esta checagem usava `currentResult`, que
      // handleResult() nunca atualiza no caminho de no_result (key===null
      // retorna cedo) — ficava com o código de uma leitura ESTÁVEL antiga,
      // não da tentativa atual. `lastRecognitionAttempt` é atualizado a
      // cada tick, sem depender de estabilização — reflete a tentativa real
      // que gerou este "não reconhecido".
      //
      // CATEGORY_MISMATCH/CATEGORY_UNCERTAIN: categoria não pôde ser
      // confirmada com segurança. FAMILY_MISMATCH: categoria certa, mas
      // nenhum candidato da família detectada sobrou. ASPECT_RATIO_MISMATCH:
      // a proporção altura/largura medida do objeto é incompatível com a
      // categoria (ex.: embedding achou "garrafa", mas o objeto medido é
      // visivelmente baixo/largo, formato de copo). Mensagem diferente da
      // genérica "não reconhecido" pra deixar claro que foi uma rejeição de
      // segurança, não falta de nitidez.
      const safetyRejectCodes = ["CATEGORY_MISMATCH", "CATEGORY_UNCERTAIN", "FAMILY_MISMATCH", "ASPECT_RATIO_MISMATCH"];
      const isCategorySafetyReject = !!lastRecognitionAttempt?.code && safetyRejectCodes.includes(lastRecognitionAttempt.code);
      const noReferencesAtAll = lastRecognitionAttempt?.code === "NO_EMBEDDINGS_FOUND";
      sheet.innerHTML = `
        <div class="scan-card">
          <p class="scan-found-title">${isCategorySafetyReject ? "Não foi possível reconhecer este produto com segurança." : "Produto não encontrado."}</p>
          <p class="hint-text">${
            isCategorySafetyReject
              ? "Não há evidência visual suficiente pra confirmar a categoria do produto (garrafa, copo, etc.) com segurança — por precaução, nada foi sugerido. Aproxime mais o produto ou melhore a iluminação."
              : noReferencesAtAll
                ? "Ainda não existe nenhuma referência visual cadastrada no sistema."
                : "O GoScan não localizou este produto nem nenhuma referência parecida o suficiente."
          }</p>
          <p>Quer vincular este produto a um SKU e ensinar o GoScan a reconhecê-lo da próxima vez?</p>
          <div class="scan-actions">
            <button class="btn-primary btn-block" id="scanLinkSku">${Icon.search}Sim, vincular a um SKU</button>
            <button class="btn-secondary btn-block" id="scanKeepTrying">Continuar tentando</button>
          </div>
        </div>`;
      sheet.querySelector("#scanLinkSku")!.addEventListener("click", () => setState("manual_search"));
      sheet.querySelector("#scanKeepTrying")!.addEventListener("click", () => {
        noResultStreak = 0;
        setState("analyzing");
      });
      break;
    }

    case "product_found":
    case "low_confidence":
      void renderProductFound(sheet);
      break;

    case "multiple_capacities":
      void renderMultipleCapacities(sheet);
      break;

    case "confirming":
      renderConfirmingQuantity(sheet);
      break;

    case "item_added":
      sheet.innerHTML = `<div class="scan-card success"><p>${Icon.checkCircle} Item adicionado!</p></div>`;
      break;

    case "cooldown":
      sheet.innerHTML = `
        <div class="scan-card">
          <p>Retire ou troque o produto para continuar escaneando.</p>
          <button class="btn-secondary btn-block" id="scanAgain">${Icon.refresh}Escanear novamente</button>
        </div>`;
      sheet.querySelector("#scanAgain")!.addEventListener("click", () => {
        cooldownProductKey = null;
        stabilizer.reset();
        noResultStreak = 0;
        setState("analyzing");
      });
      break;

    case "manual_search":
      renderManualSearch(sheet);
      break;

    default:
      sheet.innerHTML = "";
  }
}

/**
 * Diagnóstico temporário (só admin) do gargalo de estabilização — mostra
 * exclusivamente dados REAIS medidos nesta sessão de scan (nunca motion
 * score/sharpness estimados, já que o app não calcula isso hoje). Ajuda a
 * ver AO VIVO por que o scanner ainda não estabilizou: quantos ciclos já
 * rodaram, quanto tempo o ciclo mais recente levou, e a janela real de
 * chaves que o Stabilizer está comparando.
 */
function renderDiagnosticPanelHtml(): string {
  if (!isAdmin(getAuthState().profile)) return "";
  const result = lastRecognitionAttempt;
  const elapsedStabilizing = stabilizingEnteredAt ? Date.now() - stabilizingEnteredAt : 0;
  const window = stabilizer.getHistory();

  return `
    <details class="scan-diag-panel">
      <summary>Diagnóstico</summary>
      <dl>
        <dt>Estado</dt><dd>${escapeHtml(scanState)}</dd>
        <dt>Ciclos avaliados nesta sessão</dt><dd>${diagTickCount}</dd>
        <dt>Tempo do último ciclo (captura + reconhecimento)</dt><dd>${diagLastCycleMs} ms</dd>
        <dt>Tempo tentando estabilizar</dt><dd>${scanState === "stabilizing" ? `${elapsedStabilizing} ms (limite ${STABILIZATION_TIMEOUT_MS} ms)` : "-"}</dd>
        <dt>Janela do estabilizador (mais recente por último)</dt><dd>${window.length ? escapeHtml(window.map((k) => k ?? "∅").join(" → ")) : "-"}</dd>
        <dt>Status do último resultado</dt><dd>${escapeHtml(result?.status ?? "-")}</dd>
        <dt>Confiança do último resultado</dt><dd>${escapeHtml(result?.confidence_level ?? "-")}</dd>
        <dt>Categoria detectada</dt><dd>${escapeHtml(result?.detected_category ?? "-")}</dd>
        <dt>Família detectada</dt><dd>${escapeHtml(result?.detected_family ?? "-")}</dd>
        <dt>Exige escolha de capacidade</dt><dd>${result?.requires_capacity_selection ? "sim" : "não"}</dd>
      </dl>
    </details>`;
}

/** "garrafa-fresh" → "Garrafa Fresh" — só formatação, nunca inventa família nova. */
function friendlyFamilyLabel(familyKey: string): string {
  return familyKey
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Cor cadastrada da variação EXATA do SKU (nunca inferida da família ou da
 * imagem) — texto sempre visível; nunca inventa cor quando não cadastrada.
 * Não existe campo de cor hexadecimal confiável no catálogo hoje, então não
 * há bolinha colorida — só o texto, que já é a informação obrigatória.
 */
function colorBadgeHtml(cor: string | null): string {
  const trimmed = (cor || "").trim();
  if (!trimmed) return `<span class="scan-color-badge unknown">Cor não informada</span>`;
  return `<span class="scan-color-badge">${escapeHtml(trimmed)}</span>`;
}

async function renderProductFound(sheet: Element): Promise<void> {
  const result = currentResult;
  const candidate = result?.candidates[0];
  if (!candidate) {
    sheet.innerHTML = "";
    return;
  }
  const imgUrl = candidate.storage_path ? await getSignedImageUrl(candidate.storage_path, 300) : null;
  if (scanState !== "product_found" && scanState !== "low_confidence") return; // estado mudou enquanto buscava a imagem

  const confidenceLabel: Record<string, string> = { high: "Confiança alta", medium: "Confiança média", low: "Confiança baixa", none: "" };

  // Estágio de família (Categoria → Família → SKU/cor): quando a FAMÍLIA já
  // foi confirmada com segurança mas a confiança final não é alta e existe
  // mais de um candidato, o mais provável é que a incerteza seja só de
  // COR/capacidade dentro da família certa — não do produto em si. Mensagem
  // diferente pra deixar isso claro e empurrar o operador pra "ver outras
  // opções" em vez de confirmar uma cor no escuro.
  const colorUncertain = scanState === "low_confidence" && !!result?.detected_family && (result?.candidates.length ?? 0) > 1;
  const familyLabel = result?.detected_family ? friendlyFamilyLabel(result.detected_family) : null;

  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">${
        colorUncertain ? `Família identificada: ${escapeHtml(familyLabel ?? "")}` : scanState === "low_confidence" ? "Talvez seja este produto" : "Produto encontrado"
      }</p>
      ${colorUncertain ? `<p class="hint-text">A cor/variante exata não está confirmada — confira as opções abaixo antes de confirmar.</p>` : ""}
      <div class="scan-product-row">
        ${imgUrl ? `<img class="thumb-img-lg" src="${imgUrl}" alt="" style="max-width:96px" />` : `<span class="thumb-placeholder">${Icon.imageOff}</span>`}
        <div class="scan-product-info">
          ${candidate.capacity_ml ? `<p class="hint-text" style="margin:0">${candidate.capacity_ml}ml</p>` : ""}
          ${colorBadgeHtml(candidate.cor)}
          <p class="product-card-name">${escapeHtml(candidate.nome)}</p>
          <p class="sku-code">${escapeHtml(candidate.sku_outlet)}</p>
          <span class="status-badge ${candidate.confidence_level === "high" ? "success" : "warning"}">${confidenceLabel[candidate.confidence_level]}</span>
        </div>
      </div>
      <div class="scan-actions">
        <button class="btn-primary btn-block" id="scanConfirmProduct">Confirmar</button>
        ${(result?.candidates.length ?? 0) > 1 ? `<button class="btn-secondary btn-block" id="scanSeeOthers">Ver outras opções</button>` : ""}
        <button class="btn-secondary btn-block" id="scanNoneOfThese">${Icon.search}Nenhuma dessas opções</button>
        <button class="btn-secondary btn-block" id="scanNotThis">Não é este produto</button>
      </div>
    </div>`;

  sheet.querySelector("#scanConfirmProduct")!.addEventListener("click", () => selectCandidateAndConfirm(candidate));
  sheet.querySelector("#scanSeeOthers")?.addEventListener("click", () => renderOtherOptions(sheet, result!.candidates));
  sheet.querySelector("#scanNoneOfThese")!.addEventListener("click", () => setState("manual_search"));
  sheet.querySelector("#scanNotThis")!.addEventListener("click", () => {
    stabilizer.reset();
    currentResult = null;
    setState("analyzing");
  });
}

function renderOtherOptions(sheet: Element, candidates: RecognizeCandidate[]): void {
  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">Outras opções</p>
      <div class="ambiguous-suggestions">
        ${candidates
          .map(
            (c, idx) => `
          <button type="button" class="scan-capacity-card" data-option-idx="${idx}">
            ${c.capacity_ml ? `<strong>${c.capacity_ml}ml</strong>` : ""}
            ${colorBadgeHtml(c.cor)}
            <span>${escapeHtml(c.nome)}</span>
            <span class="sku-code">${escapeHtml(c.sku_outlet)}</span>
          </button>`
          )
          .join("")}
      </div>
      <button class="btn-secondary btn-block" id="scanBackToFound">Voltar</button>
    </div>`;
  sheet.querySelectorAll<HTMLButtonElement>("[data-option-idx]").forEach((btn) => {
    btn.addEventListener("click", () => selectCandidateAndConfirm(candidates[Number(btn.dataset.optionIdx)]));
  });
  sheet.querySelector("#scanBackToFound")!.addEventListener("click", () => renderOverlay());
}

async function renderMultipleCapacities(sheet: Element): Promise<void> {
  const result = currentResult;
  if (!result) {
    sheet.innerHTML = "";
    return;
  }
  const sortedByCapacity = [...result.candidates].sort((a, b) => (a.capacity_ml ?? 0) - (b.capacity_ml ?? 0));

  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">Encontramos este produto em duas capacidades. Qual é o item conferido?</p>
      <div class="scan-capacity-cards">
        ${sortedByCapacity
          .map(
            (c, idx) => `
          <button type="button" class="scan-capacity-card" data-capacity-idx="${idx}">
            <strong>${c.capacity_ml ? c.capacity_ml + "ml" : "?"}</strong>
            ${colorBadgeHtml(c.cor)}
            <span>${escapeHtml(c.nome)}</span>
            <span class="sku-code">${escapeHtml(c.sku_outlet)}</span>
          </button>`
          )
          .join("")}
      </div>
      <button class="btn-secondary btn-block" id="scanNoneOfTheseCapacity">${Icon.search}Nenhuma dessas opções</button>
    </div>`;

  sheet.querySelectorAll<HTMLButtonElement>("[data-capacity-idx]").forEach((btn) => {
    btn.addEventListener("click", () => selectCandidateAndConfirm(sortedByCapacity[Number(btn.dataset.capacityIdx)]));
  });
  sheet.querySelector("#scanNoneOfTheseCapacity")!.addEventListener("click", () => setState("manual_search"));
}

function selectCandidateAndConfirm(candidate: RecognizeCandidate): void {
  selectedCandidate = candidate;
  selectedViaManualSearch = false;
  quantity = 1;
  setState("confirming");
}

function renderConfirmingQuantity(sheet: Element): void {
  const candidate = selectedCandidate;
  if (!candidate) {
    sheet.innerHTML = "";
    return;
  }
  sheet.innerHTML = `
    <div class="scan-card">
      ${selectedViaManualSearch ? `<p class="scan-found-title">Você confirma que este produto é:</p>` : ""}
      ${candidate.capacity_ml ? `<p class="hint-text" style="margin:0">${candidate.capacity_ml}ml</p>` : ""}
      ${colorBadgeHtml(candidate.cor)}
      <p class="scan-found-title">${escapeHtml(candidate.nome)}</p>
      <p class="sku-code">${escapeHtml(candidate.sku_outlet)}</p>
      <p>Qual é a quantidade?</p>
      <div class="qty-stepper scan-qty-stepper">
        <button type="button" id="scanQtyDec" aria-label="Diminuir quantidade">${Icon.minus}</button>
        <input type="number" id="scanQtyInput" min="1" value="${quantity}" aria-label="Quantidade" />
        <button type="button" id="scanQtyInc" aria-label="Aumentar quantidade">${Icon.plus}</button>
      </div>
      <div class="scan-actions">
        <button class="btn-primary btn-block" id="scanConfirmItem">${selectedViaManualSearch ? `${Icon.checkCircle}Confirmar e ensinar ao GoScan` : "Confirmar item"}</button>
        <button class="btn-secondary btn-block" id="scanCancelConfirm">Cancelar</button>
      </div>
    </div>`;

  const qtyInput = sheet.querySelector<HTMLInputElement>("#scanQtyInput")!;
  sheet.querySelector("#scanQtyDec")!.addEventListener("click", () => {
    quantity = Math.max(1, quantity - 1);
    qtyInput.value = String(quantity);
  });
  sheet.querySelector("#scanQtyInc")!.addEventListener("click", () => {
    quantity = quantity + 1;
    qtyInput.value = String(quantity);
  });
  qtyInput.addEventListener("change", () => {
    quantity = Math.max(1, Number(qtyInput.value) || 1);
    qtyInput.value = String(quantity);
  });
  sheet.querySelector("#scanConfirmItem")!.addEventListener("click", () => void confirmItem());
  sheet.querySelector("#scanCancelConfirm")!.addEventListener("click", () => {
    selectedCandidate = null;
    stabilizer.reset();
    setState("analyzing");
  });
}

async function confirmItem(): Promise<void> {
  const candidate = selectedCandidate;
  if (!candidate) return;

  try {
    // Mesmo serviço central de inclusão do modo manual — nenhuma tabela paralela.
    await addItem({
      product_variant_id: candidate.variant_id,
      raw_model: candidate.nome,
      raw_color: candidate.cor || "",
      quantity,
      match_status: selectedViaManualSearch ? "manual" : candidate.confidence_level === "high" ? "matched" : "partial",
      source: selectedViaManualSearch ? "manual" : "camera_scan",
      sku_code: candidate.sku_outlet,
      produto: candidate.nome,
      match_confidence: selectedViaManualSearch ? null : candidate.score,
      recognition_id: selectedViaManualSearch ? null : (currentResult?.recognition_id ?? null),
    });
    showToast(`${candidate.sku_outlet} adicionado à conferência.`, "success");
    setState("item_added");

    void submitVisualLearning(candidate);

    if (!selectedViaManualSearch) {
      const confirmedKey = candidate.variant_key
        ? `family:${candidate.visual_family_key ?? ""}:${candidate.variant_key}`
        : candidate.product_id;
      cooldownProductKey = confirmedKey;
      cooldownStartedAt = Date.now();
    }
    selectedCandidate = null;
    currentResult = null;

    setTimeout(() => {
      if (scanState === "item_added") setState(selectedViaManualSearch ? "analyzing" : "cooldown");
    }, 1200);
  } catch (err) {
    showToast("Erro ao adicionar item: " + (err instanceof Error ? err.message : String(err)), "error");
  }
}

/**
 * Memória visual: registra a captura que gerou esta confirmação como
 * referência validada (ver visualLearning.ts) — só roda DEPOIS do item já
 * ter sido adicionado à conferência (nunca bloqueia a ação principal). Se o
 * operador confirmou uma sugestão da IA, é "confirmed_scan"; se veio da
 * busca manual (a sugestão original estava errada, ou não houve sugestão
 * nenhuma), é "corrected_scan". Falha aqui nunca aparece como erro pro
 * operador — a conferência já foi feita, o aprendizado é só um bônus.
 */
async function submitVisualLearning(candidate: RecognizeCandidate): Promise<void> {
  if (!lastAnalyzedFrameBase64 || !candidate.variant_id) return;
  const wasCorrection = selectedViaManualSearch;
  try {
    const result = await recordScanLearning({
      variant_id: candidate.variant_id,
      image_base64: lastAnalyzedFrameBase64,
      source_type: wasCorrection ? "corrected_scan" : "confirmed_scan",
      original_prediction_id: lastRecognitionAttempt?.recognition_id ?? null,
      original_confidence: wasCorrection ? (lastRecognitionAttempt?.candidates[0]?.score ?? null) : candidate.score,
      recognition_status: lastRecognitionAttempt?.status ?? null,
    });
    if (result.saved) {
      showToast("Correção registrada. Esta imagem ajudará o GoScan a reconhecer este produto nos próximos escaneamentos.", "success");
    } else if (result.reinforcedExisting) {
      showToast("Produto confirmado. Esta captura reforçou uma referência já existente.", "default");
    } else if (result.reason) {
      showToast("Produto confirmado, mas a imagem não foi adicionada à memória visual porque sua qualidade é insuficiente. Faça um novo scan para melhorar o aprendizado.", "default");
    }
  } catch (err) {
    console.warn("[scan] falha ao registrar aprendizado visual (item já foi confirmado normalmente):", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Busca manual (fallback)
// ---------------------------------------------------------------------------

function renderManualSearch(sheet: Element): void {
  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">Qual é o SKU correto deste produto?</p>
      <input type="text" id="scanManualInput" placeholder="Buscar por SKU, nome, categoria, família ou capacidade…" aria-label="Buscar por SKU, nome, categoria, família ou capacidade" />
      <div id="scanManualResults" class="scan-manual-results"></div>
      <button class="btn-secondary btn-block" id="scanReportUnclassified">${Icon.imagePlus}Produto ainda não cadastrado</button>
      <button class="btn-secondary btn-block" id="scanBackFromManual">Voltar para a câmera</button>
    </div>`;

  const input = sheet.querySelector<HTMLInputElement>("#scanManualInput")!;
  const results = sheet.querySelector("#scanManualResults")!;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runManualSearch(input.value, results), 300);
  });

  sheet.querySelector("#scanReportUnclassified")!.addEventListener("click", () => renderReportUnclassifiedForm(sheet));
  sheet.querySelector("#scanBackFromManual")!.addEventListener("click", () => {
    stabilizer.reset();
    setState("analyzing");
  });
}

async function runManualSearch(query: string, resultsEl: Element): Promise<void> {
  if (!query.trim()) {
    resultsEl.innerHTML = "";
    return;
  }
  const rows = await searchSkuForPicker(query, 15, "outlet");
  renderManualResults(resultsEl, rows);
}

function renderManualResults(resultsEl: Element, rows: CatalogRow[]): void {
  if (rows.length === 0) {
    resultsEl.innerHTML = `<p class="hint-text">Nenhum SKU encontrado — se o produto realmente não existe no catálogo, use "Produto ainda não cadastrado" abaixo.</p>`;
    return;
  }
  resultsEl.innerHTML = rows
    .map(
      (r) => `
      <button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-product="${r.product_id}" data-sku="${escapeHtml(
        r.sku_code
      )}" data-produto="${escapeHtml(r.produto)}" data-category="${escapeHtml(r.category || "")}" data-family="${escapeHtml(
        r.visual_family_key || ""
      )}" data-capacity="${r.capacity_ml ?? ""}" data-color="${escapeHtml(r.cor || "")}">
        ${r.thumbnail_path ? `<img class="thumb-img" data-storage-path="${escapeHtml(r.thumbnail_path)}" alt="" />` : `<span class="thumb-placeholder">${Icon.imageOff}</span>`}
        <span class="sku-picker-item-info">
          ${r.capacity_ml ? `<span class="hint-text" style="margin:0">${r.capacity_ml}ml</span>` : ""}
          ${colorBadgeHtml(r.cor)}
          <span class="product-card-name">${escapeHtml(r.produto)}</span>
          <span class="sku-code">${escapeHtml(r.sku_code)}</span>
        </span>
      </button>`
    )
    .join("");
  void hydrateManualResultThumbnails(resultsEl);
  resultsEl.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedCandidate = {
        product_id: btn.dataset.product!,
        variant_id: btn.dataset.variant!,
        sku_outlet: btn.dataset.sku!,
        nome: btn.dataset.produto!,
        imagem: null,
        storage_path: null,
        capacity_ml: btn.dataset.capacity ? Number(btn.dataset.capacity) : null,
        category: btn.dataset.category || null,
        visual_family_key: btn.dataset.family || null,
        variant_key: null,
        score: 0,
        confidence_level: "none",
        from_family_expansion: false,
        cor: btn.dataset.color || null,
      };
      selectedViaManualSearch = true;
      quantity = 1;
      setState("confirming");
    });
  });
}

async function hydrateManualResultThumbnails(resultsEl: Element): Promise<void> {
  const imgs = [...resultsEl.querySelectorAll<HTMLImageElement>("img.thumb-img[data-storage-path]")];
  await Promise.all(
    imgs.map(async (img) => {
      const path = img.dataset.storagePath;
      if (!path) return;
      const url = await getSignedImageUrl(path, 300);
      if (url) img.src = url;
    })
  );
}

/**
 * "Produto ainda não cadastrado": abre uma pendência (foto + observação) em
 * vez de forçar um vínculo com um SKU errado — nenhum SKU é criado aqui.
 */
function renderReportUnclassifiedForm(sheet: Element): void {
  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">Produto ainda não cadastrado</p>
      <p class="hint-text">A foto atual será salva para um manager/admin cadastrar este produto no catálogo. Descreva o que é, se possível.</p>
      <textarea id="scanUnclassifiedObservation" rows="3" placeholder="Observação (opcional): nome do produto, cor, onde encontrar mais informações…" aria-label="Observação"></textarea>
      <div class="scan-actions">
        <button class="btn-primary btn-block" id="scanSubmitUnclassified">Enviar pendência</button>
        <button class="btn-secondary btn-block" id="scanCancelUnclassified">Cancelar</button>
      </div>
    </div>`;

  sheet.querySelector("#scanCancelUnclassified")!.addEventListener("click", () => setState("manual_search"));
  sheet.querySelector("#scanSubmitUnclassified")!.addEventListener("click", () => void submitUnclassifiedReport(sheet));
}

async function submitUnclassifiedReport(sheet: Element): Promise<void> {
  if (!lastAnalyzedFrameBase64) {
    showToast("Nenhuma imagem capturada ainda — aponte a câmera para o produto antes de reportar.", "error");
    return;
  }
  const observation = sheet.querySelector<HTMLTextAreaElement>("#scanUnclassifiedObservation")?.value ?? "";
  const submitBtn = sheet.querySelector<HTMLButtonElement>("#scanSubmitUnclassified")!;
  submitBtn.disabled = true;
  submitBtn.textContent = "Enviando…";
  try {
    await reportUnclassifiedProduct({ image_base64: lastAnalyzedFrameBase64, observation: observation.trim() || null });
    showToast("Pendência registrada. Um manager/admin vai cadastrar este produto.", "success");
    stabilizer.reset();
    setState("analyzing");
  } catch (err) {
    showToast("Erro ao registrar pendência: " + (err instanceof Error ? err.message : String(err)), "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Enviar pendência";
  }
}
