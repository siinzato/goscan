// MODO SCAN — Parte 3: validação do quadro recebido antes de gastar tempo
// gerando embedding. Nunca grava o buffer em disco/Storage, nunca loga o
// conteúdo — só metadados (tamanho, dimensões, mime), e mesmo assim só em
// caso de rejeição (para dar um erro útil ao operador).
import sharp from "sharp";
import { sniffMime } from "./imagePipeline.ts";
import { SCAN_CONFIG } from "./scanConfig.ts";

export class InvalidFrameError extends Error {}

export interface ValidatedFrame {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Valida um quadro de câmera: tamanho máximo, MIME real (magic bytes, nunca
 * confiando em Content-Type/extensão), decodificação íntegra e dimensões
 * dentro de limites plausíveis. Não normaliza/recodifica — o quadro nunca é
 * persistido, então não precisa virar WEBP como as imagens do catálogo.
 */
export async function validateScanFrame(buffer: Buffer): Promise<ValidatedFrame> {
  if (!buffer || buffer.length === 0) {
    throw new InvalidFrameError("Quadro vazio.");
  }
  if (buffer.length > SCAN_CONFIG.maxFrameBytes) {
    throw new InvalidFrameError(`Quadro excede o tamanho máximo permitido (${Math.round(SCAN_CONFIG.maxFrameBytes / 1024)}KB).`);
  }

  const mimeType = sniffMime(buffer);
  if (!mimeType) {
    throw new InvalidFrameError("Formato de imagem não reconhecido (esperado JPEG, PNG ou WEBP).");
  }

  let metadata: Awaited<ReturnType<typeof sharp.prototype.metadata>>;
  try {
    metadata = await sharp(buffer, { failOn: "error" }).metadata();
  } catch {
    throw new InvalidFrameError("Quadro corrompido ou ilegível.");
  }
  if (!metadata.width || !metadata.height) {
    throw new InvalidFrameError("Não foi possível determinar as dimensões do quadro.");
  }
  if (
    metadata.width < SCAN_CONFIG.minDimensionPx ||
    metadata.height < SCAN_CONFIG.minDimensionPx ||
    metadata.width > SCAN_CONFIG.maxDimensionPx ||
    metadata.height > SCAN_CONFIG.maxDimensionPx
  ) {
    throw new InvalidFrameError(
      `Dimensões fora do intervalo permitido (${SCAN_CONFIG.minDimensionPx}-${SCAN_CONFIG.maxDimensionPx}px), recebido ${metadata.width}x${metadata.height}.`
    );
  }

  return { buffer, mimeType, width: metadata.width, height: metadata.height };
}
