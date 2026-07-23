// Memória visual — cobre a heurística de qualidade que decide se uma captura
// confirmada/corrigida pode virar referência (assessFrameQuality). Imagens
// sintéticas geradas com sharp (não são fotos reais, mas testam exatamente
// os limiares reais usados em produção).
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { assessFrameQuality } from "../src/server/visualLearning.ts";

async function solidColor(value) {
  return sharp({ create: { width: 200, height: 200, channels: 3, background: { r: value, g: value, b: value } } })
    .jpeg()
    .toBuffer();
}

async function highContrastNoise() {
  const size = 200 * 200 * 3;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 2 === 0 ? 10 : 245; // alterna extremos — contraste alto de propósito
  return sharp(buf, { raw: { width: 200, height: 200, channels: 3 } }).jpeg().toBuffer();
}

test("assessFrameQuality rejeita imagem muito escura", async () => {
  const dark = await solidColor(5);
  const result = await assessFrameQuality(dark);
  assert.equal(result.ok, false);
  assert.match(result.reason, /escura/i);
});

test("assessFrameQuality rejeita imagem estourada de luz", async () => {
  const bright = await solidColor(254); // acima do teto real calibrado (253) — fotos de catálogo legítimas chegam a ~249.6
  const result = await assessFrameQuality(bright);
  assert.equal(result.ok, false);
  assert.match(result.reason, /estourada|luz/i);
});

test("assessFrameQuality ACEITA uma foto de produto legítima com fundo claro (evidência real: mean=249.6, stdev=9.1)", async () => {
  // fundo quase branco com uma faixa mais escura simulando o corpo do
  // produto — reproduz a composição real de uma foto de catálogo (fundo
  // dominante claro, pouco contraste global) sem depender de um arquivo
  // externo no teste.
  const width = 200, height = 200, channels = 3;
  const buf = Buffer.alloc(width * height * channels, 250);
  for (let y = 60; y < 140; y++) {
    for (let x = 70; x < 130; x++) {
      const i = (y * width + x) * channels;
      buf[i] = buf[i + 1] = buf[i + 2] = 60;
    }
  }
  const productPhoto = await sharp(buf, { raw: { width, height, channels } }).jpeg({ quality: 90 }).toBuffer();
  const result = await assessFrameQuality(productPhoto);
  assert.equal(result.ok, true, `deveria aceitar uma foto de produto legítima com fundo claro, motivo da rejeição: ${result.reason}`);
});

test("assessFrameQuality rejeita imagem sem contraste (cor sólida uniforme)", async () => {
  const flat = await solidColor(128);
  const result = await assessFrameQuality(flat);
  assert.equal(result.ok, false);
});

test("assessFrameQuality aceita imagem com brilho médio e contraste real", async () => {
  const good = await highContrastNoise();
  const result = await assessFrameQuality(good);
  assert.equal(result.ok, true);
  assert.ok(result.score > 0);
});

test("assessFrameQuality nunca derruba o processo em imagem inválida — retorna rejeição controlada", async () => {
  const result = await assessFrameQuality(Buffer.from("não é uma imagem"));
  assert.equal(result.ok, false);
});
