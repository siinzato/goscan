// MODO SCAN — sinal estrutural REAL, complementar ao embedding CLIP: mede a
// proporção altura/largura do produto recortando o fundo da imagem (nunca
// depende do embedding, nunca depende de nome/SKU). Ver scanConfig.ts para
// a evidência real (fotos de catálogo medidas) por trás do limiar usado.
//
// LIMITAÇÃO HONESTA: isto NÃO é detecção de objeto — é um recorte por
// contraste de fundo (sharp .trim()). Funciona bem em fotos de estúdio
// (fundo uniforme, como as do catálogo). Numa foto de câmera real com fundo
// poluído (mesa de escritório, prateleira), o .trim() frequentemente não
// encontra uma borda de fundo clara e devolve o quadro quase inteiro — nesse
// caso a "proporção" medida seria a do enquadramento da câmera, não do
// produto, e usá-la só atrapalharia. Por isso `measureAspectRatio` sinaliza
// explicitamente quando a medição não é confiável, e o chamador deve
// ignorá-la nesse caso. Detecção real de tampa/alça/gargalo exigiria um
// modelo de segmentação/detecção de objeto dedicado, que não existe neste
// projeto — não fingimos medir isso.
import sharp from "sharp";
import { SCAN_CONFIG } from "./scanConfig.ts";

export interface AspectRatioMeasurement {
  /** altura / largura da caixa delimitadora do produto após recorte de fundo. */
  ratio: number;
  /** true só quando o recorte encontrou algo genuinamente menor que o quadro inteiro — caso contrário a medida não deve ser usada pra eliminar nada. */
  trustworthy: boolean;
}

const MIN_TRUSTWORTHY_AREA_FRACTION = 0.02; // recorte não pode ser quase nada (ruído)
const MAX_TRUSTWORTHY_AREA_FRACTION = 0.85; // recorte quase igual ao quadro inteiro = fundo não foi removido de verdade

export async function measureAspectRatio(buffer: Buffer): Promise<AspectRatioMeasurement | null> {
  try {
    const original = await sharp(buffer).metadata();
    if (!original.width || !original.height) return null;

    const trimmed = await sharp(buffer).trim({ threshold: 15 }).toBuffer({ resolveWithObject: true });
    const { width, height } = trimmed.info;
    if (!width || !height) return null;

    const areaFraction = (width * height) / (original.width * original.height);
    const trustworthy = areaFraction >= MIN_TRUSTWORTHY_AREA_FRACTION && areaFraction <= MAX_TRUSTWORTHY_AREA_FRACTION;

    return { ratio: height / width, trustworthy };
  } catch {
    return null; // nunca derruba o reconhecimento por causa de um sinal secundário
  }
}

/**
 * Regra eliminatória real: só atua quando a medição é confiável. Retorna
 * `true` quando a proporção medida é INCOMPATÍVEL com a categoria decidida
 * pelo embedding — ex.: embedding disse "garrafa" mas o objeto medido é
 * visivelmente mais largo que alto que qualquer garrafa Fresh no catálogo.
 */
export function isAspectRatioInconsistentWithCategory(measurement: AspectRatioMeasurement | null, category: string | null): boolean {
  if (!measurement || !measurement.trustworthy || !category) return false;
  const { garrafaMinRatio } = SCAN_CONFIG.aspectRatio;
  if (category === "garrafa") return measurement.ratio < garrafaMinRatio;
  if (category === "copo") return measurement.ratio >= garrafaMinRatio;
  return false; // outras categorias ainda não têm faixa real medida — nunca elimina sem evidência
}
