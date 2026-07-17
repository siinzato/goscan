// Gera os ícones do app/PWA a partir do símbolo "g" oficial anexado
// (public/brand/goscan-symbol-source.png — blue "g" sobre fundo magenta).
//
// O que este script faz (e não faz):
//  - NÃO redesenha o símbolo: decodifica o PNG original pixel a pixel e
//    projeta cada pixel na reta entre as duas cores dominantes (fundo e
//    traço), preservando exatamente a mesma forma/proporção/anti-aliasing.
//  - Só então troca a paleta (mapeamento linear de cor, não um "filtro"):
//    fundo magenta -> azul institucional (--go-blue-900), traço azul -> branco.
//  - Redimensiona por média de área (box filter), sem serrilhado.
//
// Sem essa recoloração mecânica, o arquivo fornecido (azul sobre magenta)
// não serve como ícone do app (que precisa ser branco sobre azul) — ver
// nota no relatório final sobre essa decisão.
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const SRC = path.join(root, "public/brand/goscan-symbol-source.png");
const OUT_DIR = path.join(root, "public/icons");

const GO_BLUE_900 = [0x12, 0x3f, 0x78]; // --go-blue-900
const WHITE = [0xff, 0xff, 0xff];

// ---------------------------------------------------------------------------
// PNG decode (suporta color type 2 = truecolor RGB, bit depth 8 — é o formato
// do arquivo de origem; suficiente para este script, não é um decoder geral).
// ---------------------------------------------------------------------------
function readChunks(buf) {
  const chunks = [];
  let offset = 8; // pula assinatura
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 8 + length + 4; // length + type + data + crc
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth !== 8 || colorType !== 2) {
    throw new Error(`Formato de PNG não suportado por este script (bitDepth=${bitDepth}, colorType=${colorType}); esperado truecolor 8-bit.`);
  }
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const raw = inflateSync(idat);

  const bpp = 3; // RGB
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filterType = raw[rowStart];
    const srcRow = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const dstRow = pixels.subarray(y * stride, (y + 1) * stride);
    const prevRow = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dstRow[x - bpp] : 0;
      const b = prevRow ? prevRow[x] : 0;
      const c = prevRow && x >= bpp ? prevRow[x - bpp] : 0;
      let value = srcRow[x];
      switch (filterType) {
        case 0:
          break;
        case 1:
          value = (value + a) & 0xff;
          break;
        case 2:
          value = (value + b) & 0xff;
          break;
        case 3:
          value = (value + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          value = (value + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Filtro de PNG desconhecido: ${filterType}`);
      }
      dstRow[x] = value;
    }
  }

  return { width, height, pixels }; // pixels: RGB intercalado, sem alpha
}

// ---------------------------------------------------------------------------
// PNG encode (RGBA 8-bit) — mesmo encoder usado em generate-pwa-icons.mjs
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePngRGBA(size, pixelFn) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6; // RGBA
  const ihdr = chunk("IHDR", ihdrData);

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------------
// 1) Decodifica o símbolo original.
// ---------------------------------------------------------------------------
const src = decodePng(readFileSync(SRC));
console.log(`Fonte decodificada: ${src.width}x${src.height}`);

function getSrcPixel(x, y) {
  const i = (y * src.width + x) * 3;
  return [src.pixels[i], src.pixels[i + 1], src.pixels[i + 2]];
}

// ---------------------------------------------------------------------------
// 2) Descobre as duas cores dominantes (fundo magenta e traço azul).
//
// O arquivo de origem tem ruído/textura (não é vetor limpo) — um histograma
// de cor EXATA falha porque o ruído espalha o azul por milhares de tons
// levemente diferentes, nenhum deles vencendo o magenta em contagem bruta.
// Em vez disso: classifica cada pixel grosseiramente pelo canal R (magenta
// tem R alto, azul tem R baixo — esse canal isolado já separa bem as duas
// classes mesmo com ruído) e faz a MÉDIA de cada classe. Essa média vira a
// cor de referência (suaviza o ruído em vez de reproduzi-lo no ícone final).
// ---------------------------------------------------------------------------
let bgSum = [0, 0, 0], bgCount = 0;
let fgSum = [0, 0, 0], fgCount = 0;
for (let y = 0; y < src.height; y += 2) {
  for (let x = 0; x < src.width; x += 2) {
    const [r, g, b] = getSrcPixel(x, y);
    if (r > 180) {
      bgSum[0] += r; bgSum[1] += g; bgSum[2] += b; bgCount++;
    } else if (r < 80) {
      fgSum[0] += r; fgSum[1] += g; fgSum[2] += b; fgCount++;
    }
    // valores intermediários = pixels de anti-aliasing na borda; ignorados
    // aqui de propósito (não entram nas referências), mas continuam sendo
    // reprojetados/suavizados corretamente no passo 3 via blendFactor().
  }
}
if (bgCount === 0 || fgCount === 0) {
  throw new Error("Não foi possível separar fundo/traço no símbolo de origem (classificação por canal R falhou).");
}
const bg = bgSum.map((s) => Math.round(s / bgCount));
const fg = fgSum.map((s) => Math.round(s / fgCount));
console.log(`Cor de fundo detectada (média de ${bgCount} amostras): rgb(${bg.join(",")})`);
console.log(`Cor do traço detectada (média de ${fgCount} amostras): rgb(${fg.join(",")})`);

// ---------------------------------------------------------------------------
// 3) Para cada pixel, projeta na reta bg->fg pra achar o blend t (preserva
//    anti-aliasing), depois remapeia pra branco->azul institucional.
// ---------------------------------------------------------------------------
function blendFactor([r, g, b]) {
  const vx = fg[0] - bg[0];
  const vy = fg[1] - bg[1];
  const vz = fg[2] - bg[2];
  const wx = r - bg[0];
  const wy = g - bg[1];
  const wz = b - bg[2];
  const denom = vx * vx + vy * vy + vz * vz || 1;
  const t = (wx * vx + wy * vy + wz * vz) / denom;
  return Math.max(0, Math.min(1, t));
}

function recoloredSrcPixel(x, y) {
  const t = blendFactor(getSrcPixel(x, y));
  return [
    Math.round(GO_BLUE_900[0] + (WHITE[0] - GO_BLUE_900[0]) * t),
    Math.round(GO_BLUE_900[1] + (WHITE[1] - GO_BLUE_900[1]) * t),
    Math.round(GO_BLUE_900[2] + (WHITE[2] - GO_BLUE_900[2]) * t),
    255,
  ];
}

// ---------------------------------------------------------------------------
// 4) Downscale por média de área (box filter) pra cada tamanho de saída, com
//    uma margem de segurança (padding) proporcional pro ícone "maskable".
// ---------------------------------------------------------------------------
function sampleBox(targetSize, srcSizeUsed, srcOffset, x, y) {
  // Mapeia o pixel (x,y) do destino pra uma caixa de pixels da fonte e tira a média.
  const scale = srcSizeUsed / targetSize;
  const sx0 = srcOffset + x * scale;
  const sy0 = srcOffset + y * scale;
  const sx1 = sx0 + scale;
  const sy1 = sy0 + scale;
  let r = 0, g = 0, b = 0, a = 0, count = 0;
  const xStart = Math.max(0, Math.floor(sx0));
  const xEnd = Math.min(src.width - 1, Math.ceil(sx1) - 1);
  const yStart = Math.max(0, Math.floor(sy0));
  const yEnd = Math.min(src.height - 1, Math.ceil(sy1) - 1);
  for (let sy = yStart; sy <= yEnd; sy++) {
    for (let sx = xStart; sx <= xEnd; sx++) {
      const [pr, pg, pb, pa] = recoloredSrcPixel(sx, sy);
      r += pr; g += pg; b += pb; a += pa; count++;
    }
  }
  if (count === 0) return [...GO_BLUE_900, 255];
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count), Math.round(a / count)];
}

function renderIcon(targetSize, { maskablePadding = 0 } = {}) {
  // maskablePadding: fração (0-0.5) de fundo azul sólido ao redor, área seguro do "maskable".
  const pad = Math.round(targetSize * maskablePadding);
  const innerSize = targetSize - 2 * pad;
  return encodePngRGBA(targetSize, (x, y) => {
    if (x < pad || y < pad || x >= targetSize - pad || y >= targetSize - pad) {
      return [...GO_BLUE_900, 255];
    }
    return sampleBox(innerSize, src.width, 0, x - pad, y - pad);
  });
}

const targets = [
  { name: "icon-192.png", size: 192, maskablePadding: 0.06 },
  { name: "icon-512.png", size: 512, maskablePadding: 0.06 },
  { name: "icon-512-maskable.png", size: 512, maskablePadding: 0.18 },
  { name: "apple-touch-icon-180.png", size: 180, maskablePadding: 0.08 },
  { name: "favicon-32.png", size: 32, maskablePadding: 0.04 },
];

for (const t of targets) {
  const png = renderIcon(t.size, { maskablePadding: t.maskablePadding });
  writeFileSync(path.join(OUT_DIR, t.name), png);
  console.log(`OK: ${t.name} (${png.length} bytes)`);
}
