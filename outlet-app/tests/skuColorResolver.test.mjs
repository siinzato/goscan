import test from "node:test";
import assert from "node:assert/strict";
import { extractSkuColorCode, buildColorCodeMap, resolveColorFromSuffix } from "../src/client/skuColorResolver.ts";

test("extractSkuColorCode pega o segmento numérico após o ÚLTIMO hífen", () => {
  assert.equal(extractSkuColorCode("CCAZM8IP15PM-8"), "8");
  assert.equal(extractSkuColorCode("BOLSA-JOY-20"), "20");
});

test("extractSkuColorCode retorna null quando o SKU não termina em número", () => {
  assert.equal(extractSkuColorCode("BOLSA-JOY-BRANCA"), null);
});

// Exemplo REAL reportado: "Bolsa de Viagem GoCase Joy - Off White" aparecendo
// em SKUs de cores diferentes — o mapa precisa vir de cores JÁ cadastradas
// de verdade (aqui simulando o cadastro real do Outlet), nunca inventadas.
const realWorldRows = [
  { sku_code: "GFGCM13OUT-1", color: "Preto", capacity_ml: null },
  { sku_code: "GFGCM14OUT-1", color: "Preto", capacity_ml: null },
  { sku_code: "GFGCM13OUT-2", color: "Azul", capacity_ml: null },
  { sku_code: "GFGCM13OUT-33", color: "Off White", capacity_ml: null },
  { sku_code: "GFGCM21OUT-33", color: "Off White", capacity_ml: null },
  { sku_code: "GFGCM13OUT-650", color: null, capacity_ml: 650 }, // capacidade vazando no sufixo, não é cor
];

test("buildColorCodeMap monta o mapa a partir de cores REAIS já cadastradas (maioria vence)", () => {
  const map = buildColorCodeMap(realWorldRows);
  assert.equal(map.get("1"), "Preto");
  assert.equal(map.get("2"), "Azul");
  assert.equal(map.get("33"), "Off White");
});

test("buildColorCodeMap exclui sufixo que na verdade é capacidade vazando (ex.: -650)", () => {
  const map = buildColorCodeMap(realWorldRows);
  assert.equal(map.has("650"), false);
});

test("buildColorCodeMap ignora linhas sem cor ou sem sufixo numérico", () => {
  const map = buildColorCodeMap([
    { sku_code: "SEM-SUFIXO", color: "Preto", capacity_ml: null },
    { sku_code: "SEM-COR-5", color: null, capacity_ml: null },
  ]);
  assert.equal(map.size, 0);
});

// Caso real do bug reportado: SKUs de Produtos Normais com sufixos -1/-2/-33
// devem resolver pra cores DIFERENTES, nunca todas "Off White".
test("resolveColorFromSuffix resolve cores diferentes pra SKUs de sufixos diferentes (nunca a mesma cor pra todos)", () => {
  const map = buildColorCodeMap(realWorldRows);
  assert.equal(resolveColorFromSuffix("BOLSA-JOY-1", map), "Preto");
  assert.equal(resolveColorFromSuffix("BOLSA-JOY-2", map), "Azul");
  assert.equal(resolveColorFromSuffix("BOLSA-JOY-33", map), "Off White");
});

test("resolveColorFromSuffix retorna null quando o código não está no mapa (nunca inventa)", () => {
  const map = buildColorCodeMap(realWorldRows);
  assert.equal(resolveColorFromSuffix("BOLSA-JOY-999", map), null);
});

test("resolveColorFromSuffix retorna null quando o SKU não tem sufixo numérico", () => {
  const map = buildColorCodeMap(realWorldRows);
  assert.equal(resolveColorFromSuffix("BOLSA-JOY-BRANCA", map), null);
});
