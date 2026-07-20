// Modo Scan — Parte 4: controle da câmera ao vivo (getUserMedia). Nenhum
// quadro é gravado/persistido aqui — captureFrameBlob() só desenha o frame
// atual num canvas em memória e devolve um Blob comprimido, descartado pelo
// chamador assim que a requisição termina.
export class CameraPermissionDeniedError extends Error {}
export class CameraUnavailableError extends Error {}

export type FacingMode = "environment" | "user";

export interface CameraController {
  videoEl: HTMLVideoElement;
  facingMode: FacingMode;
  hasTorch(): boolean;
  torchOn: boolean;
  toggleTorch(): Promise<boolean>;
  switchCamera(): Promise<void>;
  captureFrameBlob(maxDimension?: number, quality?: number): Promise<Blob | null>;
  stop(): void;
}

async function requestStream(facingMode: FacingMode): Promise<MediaStream> {
  // navigator.mediaDevices só existe em "contexto seguro" (HTTPS, ou localhost
  // no PC onde o servidor roda) — um celular acessando por http://<ip-da-rede>
  // nunca vê essa API, mesmo com permissão concedida. Detectar isso aqui evita
  // um TypeError críptico ("undefined is not an object") chegando à tela.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new CameraUnavailableError(
      "Câmera indisponível neste endereço. O navegador só libera a câmera em conexão segura (HTTPS) — acessar por http://<ip> na rede local não é suficiente, mesmo com a permissão concedida."
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
      throw new CameraPermissionDeniedError("Permissão de câmera negada.");
    }
    throw new CameraUnavailableError(err instanceof Error ? err.message : "Não foi possível acessar a câmera.");
  }
}

/**
 * Abre a câmera (preferindo a traseira) e conecta ao <video> fornecido.
 * O chamador é responsável por chamar stop() ao sair da tela (nunca deixar
 * tracks abertas em segundo plano).
 */
export async function startCamera(videoEl: HTMLVideoElement, initialFacingMode: FacingMode = "environment"): Promise<CameraController> {
  let facingMode = initialFacingMode;
  let stream = await requestStream(facingMode);
  let torchOn = false;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  async function attach(newStream: MediaStream) {
    videoEl.srcObject = newStream;
    videoEl.setAttribute("playsinline", "true"); // essencial pro Safari iOS não abrir em tela cheia
    videoEl.muted = true;
    await videoEl.play().catch(() => {
      /* alguns navegadores exigem gesto do usuário — o botão "Iniciar câmera" já serve como esse gesto */
    });
  }

  await attach(stream);

  function currentTrack(): MediaStreamTrack | undefined {
    return stream.getVideoTracks()[0];
  }

  function hasTorch(): boolean {
    const track = currentTrack();
    if (!track) return false;
    const capabilities = track.getCapabilities?.();
    return Boolean(capabilities && "torch" in capabilities);
  }

  async function toggleTorch(): Promise<boolean> {
    const track = currentTrack();
    if (!track || !hasTorch()) return false;
    torchOn = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: torchOn } as unknown as MediaTrackConstraintSet] });
    } catch {
      torchOn = !torchOn; // reverte se o navegador recusar
    }
    return torchOn;
  }

  async function switchCamera(): Promise<void> {
    const nextFacingMode: FacingMode = facingMode === "environment" ? "user" : "environment";
    const nextStream = await requestStream(nextFacingMode);
    stream.getTracks().forEach((t) => t.stop());
    stream = nextStream;
    facingMode = nextFacingMode;
    torchOn = false;
    await attach(stream);
  }

  async function captureFrameBlob(maxDimension = 640, quality = 0.85): Promise<Blob | null> {
    if (!ctx || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return null;

    const videoW = videoEl.videoWidth;
    const videoH = videoEl.videoHeight;
    const displayW = videoEl.clientWidth || videoW;
    const displayH = videoEl.clientHeight || videoH;

    // BUG REAL corrigido na Parte 5: a moldura central (.scan-frame-guide no
    // CSS) era só decorativa — o quadro inteiro da câmera (com todo o fundo
    // ao redor do produto) era enviado pro reconhecimento, não só a área que
    // o operador vê como "o que estou escaneando". Testado com dados reais:
    // recortar pra essa mesma região reduziu a distância de embedding de
    // ~0.21 para ~0.10 contra a imagem de referência do catálogo.
    //
    // .scan-video usa object-fit:cover — o vídeo "renderizado" é maior que a
    // caixa visível (senão sobraria espaço vazio) e é cortado nas bordas;
    // precisa desfazer esse corte pra mapear a moldura (em % de exibição,
    // mesmos valores do CSS `inset: 12% 10%`) de volta pras coordenadas
    // intrínsecas do vídeo que drawImage entende.
    const GUIDE_INSET_X = 0.1;
    const GUIDE_INSET_Y = 0.12;
    const coverScale = Math.max(displayW / videoW, displayH / videoH);
    const renderedW = videoW * coverScale;
    const renderedH = videoH * coverScale;
    const offsetX = (renderedW - displayW) / 2;
    const offsetY = (renderedH - displayH) / 2;

    const guideDisplayX = displayW * GUIDE_INSET_X;
    const guideDisplayY = displayH * GUIDE_INSET_Y;
    const guideDisplayW = displayW * (1 - 2 * GUIDE_INSET_X);
    const guideDisplayH = displayH * (1 - 2 * GUIDE_INSET_Y);

    const srcX = Math.max(0, (guideDisplayX + offsetX) / coverScale);
    const srcY = Math.max(0, (guideDisplayY + offsetY) / coverScale);
    const srcW = Math.min(videoW - srcX, guideDisplayW / coverScale);
    const srcH = Math.min(videoH - srcY, guideDisplayH / coverScale);

    const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
    canvas.width = Math.round(srcW * scale);
    canvas.height = Math.round(srcH * scale);
    ctx.drawImage(videoEl, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
  }

  function stop(): void {
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }

  return {
    videoEl,
    get facingMode() {
      return facingMode;
    },
    hasTorch,
    get torchOn() {
      return torchOn;
    },
    toggleTorch,
    switchCamera,
    captureFrameBlob,
    stop,
  };
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
