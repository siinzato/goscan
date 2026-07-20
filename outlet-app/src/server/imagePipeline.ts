// Validação real (magic bytes + decodificação) e normalização de imagens do
// Catálogo Visual. Sempre re-codifica para WEBP (formato final único em
// Storage, como sugerido: product-images/{product_variant_id}/{id}.webp) —
// isso também serve de segunda validação: sharp só decodifica arquivo íntegro.
import { createHash } from "node:crypto";
import sharp from "sharp";

export class ImageValidationError extends Error {}

const MAX_OUTPUT_DIMENSION = 2048;
const MIN_USABLE_DIMENSION = 150; // abaixo disso, só sinaliza para revisão — não rejeita

export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return null;
}

export interface ProcessedImage {
  buffer: Buffer;
  mimeType: string; // sempre "image/webp" (formato normalizado)
  width: number;
  height: number;
  hash: string; // sha256 do arquivo ORIGINAL (dedup por conteúdo-fonte)
  originalMimeType: string;
  originalFileSize: number;
  lowResolution: boolean;
}

/**
 * Valida (magic bytes + decodificação real) e normaliza uma imagem baixada.
 * Lança ImageValidationError para qualquer defeito técnico (formato não
 * suportado, corrompida, download incompleto) — esses casos NÃO devem virar
 * uma linha em product_images, só um erro no item de importação. Baixa
 * resolução não lança erro (fica marcada em `lowResolution` para revisão
 * humana, conforme pedido — "não rejeite por critério subjetivo").
 */
export async function processAndNormalizeImage(buffer: Buffer): Promise<ProcessedImage> {
  if (!buffer || buffer.length === 0) {
    throw new ImageValidationError("Download incompleto ou vazio.");
  }

  const sniffed = sniffMime(buffer);
  if (!sniffed) {
    throw new ImageValidationError("Formato de imagem não suportado (esperado JPEG, PNG, WEBP ou GIF).");
  }

  let metadata: Awaited<ReturnType<typeof sharp.prototype.metadata>>;
  try {
    metadata = await sharp(buffer, { failOn: "error" }).metadata();
  } catch {
    throw new ImageValidationError("Arquivo de imagem corrompido ou ilegível.");
  }
  if (!metadata.width || !metadata.height) {
    throw new ImageValidationError("Não foi possível determinar as dimensões da imagem.");
  }

  const hash = createHash("sha256").update(buffer).digest("hex");
  const lowResolution = metadata.width < MIN_USABLE_DIMENSION || metadata.height < MIN_USABLE_DIMENSION;

  let pipeline = sharp(buffer, { failOn: "error" });
  if (metadata.width > MAX_OUTPUT_DIMENSION || metadata.height > MAX_OUTPUT_DIMENSION) {
    pipeline = pipeline.resize({ width: MAX_OUTPUT_DIMENSION, height: MAX_OUTPUT_DIMENSION, fit: "inside", withoutEnlargement: true });
  }

  let webpBuffer: Buffer;
  try {
    webpBuffer = await pipeline.webp({ quality: 90 }).toBuffer();
  } catch {
    throw new ImageValidationError("Falha ao normalizar a imagem para WEBP.");
  }
  const finalMeta = await sharp(webpBuffer).metadata();

  return {
    buffer: webpBuffer,
    mimeType: "image/webp",
    width: finalMeta.width || metadata.width,
    height: finalMeta.height || metadata.height,
    hash,
    originalMimeType: sniffed,
    originalFileSize: buffer.length,
    lowResolution,
  };
}
