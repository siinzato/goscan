// Geração real de embeddings visuais — CLIP (Xenova/clip-vit-base-patch32,
// via @xenova/transformers, ONNX rodando localmente em Node, sem chamada a
// serviço externo pago). Mesmo modelo é usável no navegador (Modo Scan,
// futuro) via @xenova/transformers com backend WASM/WebGPU — permite
// comparar embeddings gerados nos dois lados com o mesmo espaço vetorial.
import { pipeline, RawImage, type ImageFeatureExtractionPipeline } from "@xenova/transformers";

export const MODEL_NAME = "Xenova/clip-vit-base-patch32";
export const MODEL_VERSION = "v1";
export const EMBEDDING_DIMENSION = 512;

let extractorPromise: Promise<ImageFeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<ImageFeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("image-feature-extraction", MODEL_NAME) as Promise<ImageFeatureExtractionPipeline>;
  }
  return extractorPromise;
}

export class EmbeddingGenerationError extends Error {}

/** Gera o embedding real de uma imagem (buffer decodificado, ex.: webp já normalizado pelo imagePipeline). */
export async function generateImageEmbedding(buffer: Buffer): Promise<number[]> {
  const extractor = await getExtractor();
  let image: RawImage;
  try {
    image = await RawImage.fromBlob(new Blob([Uint8Array.from(buffer)]));
  } catch (err) {
    throw new EmbeddingGenerationError(`Não foi possível decodificar a imagem para gerar o embedding: ${err instanceof Error ? err.message : String(err)}`);
  }

  const output = await extractor(image);
  const vector = Array.from(output.data as Float32Array);
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new EmbeddingGenerationError(`Dimensão inesperada do embedding: esperado ${EMBEDDING_DIMENSION}, recebido ${vector.length}.`);
  }
  return vector;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
