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
import { startOrResumeConference, addItem, subscribeSession, type Session } from "../../conferenceSession.ts";

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
const STABLE_CONSECUTIVE = 2;
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

let stabilizer = new Stabilizer(STABLE_CONSECUTIVE, 6);
let noResultStreak = 0;
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

function setState(next: ScanState): void {
  const isNewFind = FOUND_SOUND_STATES.includes(next) && !FOUND_SOUND_STATES.includes(scanState);
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
  unsubscribeSession?.();
  scanState = "requesting_permission";
  currentResult = null;
  selectedCandidate = null;
  quantity = 1;
  stabilizer = new Stabilizer(STABLE_CONSECUTIVE, 6);
  noResultStreak = 0;
  cooldownProductKey = null;

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
  try {
    const blob = await camera.captureFrameBlob(FRAME_MAX_DIMENSION, FRAME_QUALITY);
    if (!blob) return;
    const base64 = await blobToBase64(blob);
    if (mySeq !== requestSeq) return; // uma requisição mais nova já foi disparada
    const result = await recognizeFrame(currentSession.conference.id, base64);
    if (mySeq !== requestSeq) return; // resposta obsoleta — descarta
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
    setState("stabilizing");
    return;
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

    case "no_result":
      sheet.innerHTML = `
        <div class="scan-card">
          <p>Produto não reconhecido.</p>
          <p class="hint-text">Aproxime mais o produto da câmera ou busque manualmente.</p>
          <button class="btn-primary btn-block" id="scanManual">${Icon.search}Buscar manualmente</button>
        </div>`;
      sheet.querySelector("#scanManual")!.addEventListener("click", () => setState("manual_search"));
      break;

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

  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">${scanState === "low_confidence" ? "Talvez seja este produto" : "Produto encontrado"}</p>
      <div class="scan-product-row">
        ${imgUrl ? `<img class="thumb-img-lg" src="${imgUrl}" alt="" style="max-width:96px" />` : `<span class="thumb-placeholder">${Icon.imageOff}</span>`}
        <div>
          <p class="product-card-name">${escapeHtml(candidate.nome)}</p>
          <p class="sku-code">${escapeHtml(candidate.sku_outlet)}</p>
          ${candidate.capacity_ml ? `<p class="hint-text">${candidate.capacity_ml}ml</p>` : ""}
          <span class="status-badge ${candidate.confidence_level === "high" ? "success" : "warning"}">${confidenceLabel[candidate.confidence_level]}</span>
        </div>
      </div>
      <div class="scan-actions">
        <button class="btn-primary btn-block" id="scanConfirmProduct">Confirmar</button>
        ${(result?.candidates.length ?? 0) > 1 ? `<button class="btn-secondary btn-block" id="scanSeeOthers">Ver outras opções</button>` : ""}
        <button class="btn-secondary btn-block" id="scanNotThis">Não é este produto</button>
        <button class="btn-secondary btn-block" id="scanManualFromFound">${Icon.search}Buscar manualmente</button>
      </div>
    </div>`;

  sheet.querySelector("#scanConfirmProduct")!.addEventListener("click", () => selectCandidateAndConfirm(candidate));
  sheet.querySelector("#scanSeeOthers")?.addEventListener("click", () => renderOtherOptions(sheet, result!.candidates));
  sheet.querySelector("#scanNotThis")!.addEventListener("click", () => {
    stabilizer.reset();
    currentResult = null;
    setState("analyzing");
  });
  sheet.querySelector("#scanManualFromFound")!.addEventListener("click", () => setState("manual_search"));
}

function renderOtherOptions(sheet: Element, candidates: RecognizeCandidate[]): void {
  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">Outras opções</p>
      <div class="ambiguous-suggestions">
        ${candidates
          .map(
            (c, idx) =>
              `<button type="button" class="btn-secondary" data-option-idx="${idx}">${escapeHtml(c.nome)}${
                c.capacity_ml ? " — " + c.capacity_ml + "ml" : ""
              } <span class="sku-code">${escapeHtml(c.sku_outlet)}</span></button>`
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
            <span>${escapeHtml(c.nome)}</span>
            <span class="sku-code">${escapeHtml(c.sku_outlet)}</span>
          </button>`
          )
          .join("")}
      </div>
      <button class="btn-secondary btn-block" id="scanManualFromCapacity">${Icon.search}Buscar manualmente</button>
    </div>`;

  sheet.querySelectorAll<HTMLButtonElement>("[data-capacity-idx]").forEach((btn) => {
    btn.addEventListener("click", () => selectCandidateAndConfirm(sortedByCapacity[Number(btn.dataset.capacityIdx)]));
  });
  sheet.querySelector("#scanManualFromCapacity")!.addEventListener("click", () => setState("manual_search"));
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
      <p class="scan-found-title">${escapeHtml(candidate.nome)}</p>
      <p class="sku-code">${escapeHtml(candidate.sku_outlet)}</p>
      <p>Qual é a quantidade?</p>
      <div class="qty-stepper scan-qty-stepper">
        <button type="button" id="scanQtyDec" aria-label="Diminuir quantidade">${Icon.minus}</button>
        <input type="number" id="scanQtyInput" min="1" value="${quantity}" aria-label="Quantidade" />
        <button type="button" id="scanQtyInc" aria-label="Aumentar quantidade">${Icon.plus}</button>
      </div>
      <div class="scan-actions">
        <button class="btn-primary btn-block" id="scanConfirmItem">Confirmar item</button>
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
      raw_color: candidate.variant_key || "",
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

// ---------------------------------------------------------------------------
// Busca manual (fallback)
// ---------------------------------------------------------------------------

function renderManualSearch(sheet: Element): void {
  sheet.innerHTML = `
    <div class="scan-card">
      <p class="scan-found-title">Buscar manualmente</p>
      <input type="text" id="scanManualInput" placeholder="Buscar por SKU ou nome…" aria-label="Buscar por SKU ou nome" />
      <div id="scanManualResults" class="scan-manual-results"></div>
      <button class="btn-secondary btn-block" id="scanBackFromManual">Voltar para a câmera</button>
    </div>`;

  const input = sheet.querySelector<HTMLInputElement>("#scanManualInput")!;
  const results = sheet.querySelector("#scanManualResults")!;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runManualSearch(input.value, results), 300);
  });

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
  const rows = await searchSkuForPicker(query, 15);
  renderManualResults(resultsEl, rows);
}

function renderManualResults(resultsEl: Element, rows: CatalogRow[]): void {
  if (rows.length === 0) {
    resultsEl.innerHTML = `<p class="hint-text">Nenhum SKU encontrado.</p>`;
    return;
  }
  resultsEl.innerHTML = rows
    .map(
      (r) =>
        `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-product="${r.product_id}" data-sku="${escapeHtml(
          r.sku_code
        )}" data-produto="${escapeHtml(r.produto)}">${escapeHtml(r.produto)} — ${escapeHtml(r.cor || "")} <span class="sku-code">${escapeHtml(
          r.sku_code
        )}</span></button>`
    )
    .join("");
  resultsEl.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedCandidate = {
        product_id: btn.dataset.product!,
        variant_id: btn.dataset.variant!,
        sku_outlet: btn.dataset.sku!,
        nome: btn.dataset.produto!,
        imagem: null,
        storage_path: null,
        capacity_ml: null,
        visual_family_key: null,
        variant_key: null,
        score: 0,
        confidence_level: "none",
        from_family_expansion: false,
      };
      selectedViaManualSearch = true;
      quantity = 1;
      setState("confirming");
    });
  });
}
