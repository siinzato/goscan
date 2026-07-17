// Gera ícones PWA (192, 512, 512 maskable) como PNGs válidos, sem nenhuma
// dependência externa — apenas node:zlib para compressão DEFLATE do PNG.
// São ícones placeholder simples (retângulo com a marca "OUT"); troque os
// arquivos em public/icons/ por uma arte definitiva quando tiver uma.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "icons");

const RUST = [0xb8, 0x50, 0x1c];
const PAPER = [0xf3, 0xee, 0xe4];

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

/** pixelFn(x, y) -> [r, g, b, a] */
function encodePng(size, pixelFn) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk("IHDR", ihdrData);

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // no filter
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

// Desenha um quadrado rust com uma borda "paper" e um bloco central (o
// bloco simula a marca "OUT" sem precisar renderizar texto).
function iconPixel(size, maskable) {
  const pad = maskable ? Math.round(size * 0.2) : 0;
  const borderW = Math.max(2, Math.round(size * 0.03));
  const inset = pad + Math.round(size * 0.08);
  const markW = size - 2 * pad;

  return (x, y) => {
    if (x < pad || y < pad || x >= size - pad || y >= size - pad) {
      return maskable ? [...RUST, 255] : [...RUST, 255];
    }
    const onBorder =
      x >= inset && x < size - inset && y >= inset && y < size - inset
        ? x < inset + borderW || x >= size - inset - borderW || y < inset + borderW || y >= size - inset - borderW
        : false;
    if (onBorder) return [...PAPER, 255];

    // bloco central retangular (representa a marca "OUT")
    const cx = size / 2;
    const cy = size / 2;
    const halfW = markW * 0.22;
    const halfH = markW * 0.1;
    if (Math.abs(x - cx) < halfW && Math.abs(y - cy) < halfH) return [...PAPER, 255];

    return [...RUST, 255];
  };
}

for (const { name, size, maskable } of [
  { name: "icon-192.png", size: 192, maskable: false },
  { name: "icon-512.png", size: 512, maskable: false },
  { name: "icon-512-maskable.png", size: 512, maskable: true },
]) {
  const png = encodePng(size, iconPixel(size, maskable));
  writeFileSync(path.join(outDir, name), png);
  console.log(`OK: ${name} (${png.length} bytes)`);
}
