// Sinal estrutural real (proporção altura/largura via recorte de fundo).
// Limiar calibrado com medição real das fotos de catálogo (ver
// scanConfig.ts): garrafa-fresh 3.11-3.35, copo-vibe/life 1.74-2.69.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { measureAspectRatio, isAspectRatioInconsistentWithCategory } from "../src/server/structuralSignals.ts";

const CANVAS = 400;

/** Retângulo escuro (produto) sobre fundo branco uniforme (como as fotos de catálogo). */
async function shapeOnWhiteBackground(rectWidth, rectHeight) {
  const left = Math.round((CANVAS - rectWidth) / 2);
  const top = Math.round((CANVAS - rectHeight) / 2);
  return sharp({ create: { width: CANVAS, height: CANVAS, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([
      {
        input: await sharp({ create: { width: rectWidth, height: rectHeight, channels: 3, background: { r: 40, g: 40, b: 40 } } }).png().toBuffer(),
        left,
        top,
      },
    ])
    .jpeg()
    .toBuffer();
}

test("measureAspectRatio mede corretamente a proporção de um objeto alto e estreito (formato garrafa)", async () => {
  const bottleShaped = await shapeOnWhiteBackground(60, 300); // 300/60 = 5.0
  const result = await measureAspectRatio(bottleShaped);
  assert.ok(result.trustworthy, "deveria confiar na medição — fundo uniforme, objeto bem menor que o quadro");
  assert.ok(result.ratio > 3, `esperava proporção alta (formato garrafa), obteve ${result.ratio}`);
});

test("measureAspectRatio mede corretamente a proporção de um objeto largo e baixo (formato copo)", async () => {
  const cupShaped = await shapeOnWhiteBackground(200, 300); // 300/200 = 1.5
  const result = await measureAspectRatio(cupShaped);
  assert.ok(result.trustworthy);
  assert.ok(result.ratio < 2, `esperava proporção baixa (formato copo), obteve ${result.ratio}`);
});

test("measureAspectRatio marca a medição como NÃO confiável quando o recorte não reduz o quadro (fundo poluído/sem contraste)", async () => {
  // objeto ocupando quase 100% do quadro — trim() não consegue achar uma
  // borda de fundo real, simulando uma foto de câmera com fundo poluído.
  const fullFrame = await shapeOnWhiteBackground(CANVAS - 4, CANVAS - 4);
  const result = await measureAspectRatio(fullFrame);
  assert.equal(result.trustworthy, false);
});

test("isAspectRatioInconsistentWithCategory NUNCA elimina quando a medição não é confiável", () => {
  const untrustworthy = { ratio: 1.0, trustworthy: false };
  assert.equal(isAspectRatioInconsistentWithCategory(untrustworthy, "garrafa"), false);
});

test("isAspectRatioInconsistentWithCategory sinaliza conflito: categoria 'garrafa' mas objeto medido é baixo/largo", () => {
  const cupShapedMeasurement = { ratio: 1.74, trustworthy: true }; // exatamente a proporção real medida do copo-vibe
  assert.equal(isAspectRatioInconsistentWithCategory(cupShapedMeasurement, "garrafa"), true);
});

test("isAspectRatioInconsistentWithCategory sinaliza conflito: categoria 'copo' mas objeto medido é alto/estreito", () => {
  const bottleShapedMeasurement = { ratio: 3.26, trustworthy: true }; // proporção real medida da garrafa-fresh
  assert.equal(isAspectRatioInconsistentWithCategory(bottleShapedMeasurement, "copo"), true);
});

test("isAspectRatioInconsistentWithCategory NÃO sinaliza conflito quando a proporção bate com a categoria", () => {
  assert.equal(isAspectRatioInconsistentWithCategory({ ratio: 3.26, trustworthy: true }, "garrafa"), false);
  assert.equal(isAspectRatioInconsistentWithCategory({ ratio: 1.74, trustworthy: true }, "copo"), false);
});

test("isAspectRatioInconsistentWithCategory nunca elimina categorias sem faixa real medida ainda", () => {
  assert.equal(isAspectRatioInconsistentWithCategory({ ratio: 1.0, trustworthy: true }, "mochila"), false);
});
