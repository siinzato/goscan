// OCR local (Tesseract.js, via CDN) + heurística para separar modelo/cor/quantidade,
// usando os mesmos dicionários de alias do Supabase que o matching "de verdade" usa.
import { normalize } from "./utils.ts";
import { fetchAliasLists } from "./matching.ts";

declare const Tesseract: {
  recognize(
    image: string,
    lang: string,
    options?: Record<string, unknown>
  ): Promise<{ data: { text: string } }>;
};

export interface OcrItemCandidate {
  modelo: string;
  cor: string;
  quantidade: number;
}

function splitQtyAndText(line: string): { qty: number | null; text: string } {
  let m = line.match(/^(\d+)\s*(?:x|un\.?|uni\.?)?\s*(.+)$/i);
  if (m && m[2]) return { qty: parseInt(m[1], 10), text: m[2].trim() };
  m = line.match(/^(.+?)\s*(\d+)\s*(?:x|un\.?|uni\.?)?\s*$/i);
  if (m && m[1]) return { qty: parseInt(m[2], 10), text: m[1].trim() };
  return { qty: null, text: line };
}

export async function parseOcrText(text: string): Promise<OcrItemCandidate[]> {
  const { models, colors } = await fetchAliasLists();
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items: OcrItemCandidate[] = [];
  let currentModelo = "";

  for (const line of lines) {
    const norm = normalize(line);
    const modelMatch = models.find((m) => norm.includes(m.normalized_alias));
    const colorMatch = colors.find((c) => norm.includes(c.normalized_alias));
    const { qty, text: rest } = splitQtyAndText(line);

    if (modelMatch && !colorMatch && qty === null) {
      currentModelo = line;
      continue;
    }
    if (colorMatch || qty !== null) {
      items.push({ modelo: currentModelo || line, cor: rest || line, quantidade: qty || 1 });
      continue;
    }
    currentModelo = line;
  }
  return items;
}

export async function runOcr(
  image: { data: string; media_type: string },
  onProgress?: (info: unknown) => void
): Promise<string> {
  const dataUrl = `data:${image.media_type};base64,${image.data}`;
  const { data } = await Tesseract.recognize(dataUrl, "por", { logger: onProgress });
  return data.text;
}

export async function parseImagesLocally(
  images: { data: string; media_type: string }[],
  onImageProgress?: (index: number, total: number) => void
): Promise<OcrItemCandidate[]> {
  const all: OcrItemCandidate[] = [];
  for (let i = 0; i < images.length; i++) {
    onImageProgress?.(i, images.length);
    const text = await runOcr(images[i]);
    all.push(...(await parseOcrText(text)));
  }
  return all;
}
