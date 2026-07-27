import test from "node:test";
import assert from "node:assert/strict";
import { extractSkuColorCode, resolveSkuColor } from "../src/server/scanRecognize.ts";

test("extractSkuColorCode pega o segmento numérico após o ÚLTIMO hífen", () => {
  assert.equal(extractSkuColorCode("GFGCM13OUT-1"), "1");
  assert.equal(extractSkuColorCode("GFGCM13OUT-20"), "20");
  assert.equal(extractSkuColorCode("OUT-GFGCM13-ATLETICOMG-20"), "20");
});

test("extractSkuColorCode retorna null quando o SKU não termina em número", () => {
  assert.equal(extractSkuColorCode("OUT-GFGCM13-CEARA"), null);
  assert.equal(extractSkuColorCode("GFGCM13OUT"), null);
});

test("resolveSkuColor usa a cor cadastrada da variante exata quando existe (BUG REAL corrigido: servidor stale ignorava isso)", () => {
  const codeMap = new Map([["1", "Preto"]]);
  const resolved = resolveSkuColor("GFGCM13OUT-1", "Preto", codeMap);
  assert.equal(resolved.cor, "Preto");
  assert.equal(resolved.source, "cadastro");
});

test("resolveSkuColor cai pro código de sufixo só quando NÃO há cor cadastrada", () => {
  const codeMap = new Map([["2", "Azul"]]);
  const resolved = resolveSkuColor("GFGCM13OUT-2", null, codeMap);
  assert.equal(resolved.cor, "Azul");
  assert.equal(resolved.source, "codigo_sufixo");
});

test("resolveSkuColor NUNCA usa o código de sufixo se já existe cor cadastrada, mesmo discordando (loga, não sobrescreve)", () => {
  const codeMap = new Map([["1", "Azul"]]); // mapa diz Azul, cadastro diz Preto — cadastro sempre vence
  const resolved = resolveSkuColor("GFGCM13OUT-1", "Preto", codeMap);
  assert.equal(resolved.cor, "Preto");
  assert.equal(resolved.source, "cadastro");
});

test("resolveSkuColor retorna null (Cor não informada) quando nenhuma fonte tem a cor", () => {
  const resolved = resolveSkuColor("OUT-GFGCM13-ESTAMPAS", null, new Map());
  assert.equal(resolved.cor, null);
  assert.equal(resolved.source, "nenhuma");
});

test("resolveSkuColor nunca inventa cor pra SKU sem sufixo numérico e sem cadastro", () => {
  const codeMap = new Map([["1", "Preto"]]);
  const resolved = resolveSkuColor("OUT-GFGCM13-CORINTHIANS", null, codeMap);
  assert.equal(resolved.cor, null);
  assert.equal(resolved.source, "nenhuma");
});
