// Estágio de FAMÍLIA (Categoria → FAMÍLIA → SKU/cor) — cobre o bug real
// reportado depois do gate de categoria já estar funcionando: a cor/SKU
// específico de uma garrafa oscilava entre ticks (GFGCM13OUT-28, -1, -19...)
// porque categoria e cor eram decididas juntas, numa competição só. As
// distâncias cross-família usadas aqui (copo-vibe vs copo-life, ~0.22)
// vieram de medições reais já registradas em scanCategoryGate.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { detectFamily, applyFamilyGate } from "../src/server/scanRecognize.ts";

function match({ sku, family, dist }) {
  return {
    product_image_id: `img-${sku}`,
    product_id: `prod-${sku}`,
    variant_id: `var-${sku}`,
    distance: dist,
    score_raw: 1 - dist,
    score_normalized: 1 - dist,
    storage_path: null,
    sku_code: sku,
    product_name: sku,
    category: "garrafa",
    visual_family_key: family,
    variant_key: null,
    capacity_ml: null,
    source: "catalog",
  };
}

test("detectFamily identifica a família certa dentro de uma categoria já filtrada", () => {
  const matches = [
    match({ sku: "GFGCM13OUT-1", family: "garrafa-fresh", dist: 0 }),
    match({ sku: "GFGCM13OUT-27", family: "garrafa-fresh", dist: 0.0662 }),
    match({ sku: "GFGCM73", family: "garrafa-flip-pro", dist: 0.25 }),
    match({ sku: "GFGCM21", family: "garrafa-urban", dist: 0.3 }),
  ];
  const detection = detectFamily(matches);
  assert.equal(detection.family, "garrafa-fresh");
  assert.equal(detection.confidence, "clear");
});

test("applyFamilyGate BLOQUEIA um SKU de família diferente de vencer — impede a cor/SKU errado dentro da categoria certa", () => {
  // reprodução do padrão real: dois SKUs de família diferente perto o
  // suficiente pra competir se não houvesse o gate.
  const grouped = [
    match({ sku: "GFGCM21", family: "garrafa-urban", dist: 0.15 }), // vencedor bruto — família errada
    match({ sku: "GFGCM13OUT-28", family: "garrafa-fresh", dist: 0.18 }),
  ];
  const detection = detectFamily([
    match({ sku: "GFGCM13OUT-1", family: "garrafa-fresh", dist: 0.05 }),
    match({ sku: "GFGCM13OUT-2", family: "garrafa-fresh", dist: 0.08 }),
    match({ sku: "GFGCM21", family: "garrafa-urban", dist: 0.15 }),
  ]); // categoria detecta garrafa-fresh como família (2 vizinhos bem mais perto)
  const filtered = applyFamilyGate(grouped, detection);
  assert.equal(filtered.some((m) => m.sku_code === "GFGCM21"), false, "SKU de outra família nunca sobrevive ao gate quando a família é clara");
  assert.equal(filtered[0].sku_code, "GFGCM13OUT-28");
});

test("applyFamilyGate não bloqueia nada quando a família está incerta (evidência insuficiente)", () => {
  const grouped = [match({ sku: "a", family: "garrafa-urban", dist: 0.1 }), match({ sku: "b", family: "garrafa-fresh", dist: 0.11 })];
  const uncertain = { family: "garrafa-fresh", confidence: "uncertain", bestDistanceByFamily: { "garrafa-fresh": 0.11, "garrafa-urban": 0.1 } };
  assert.deepEqual(applyFamilyGate(grouped, uncertain), grouped);
});

test("applyFamilyGate nunca bloqueia produtos sem família cadastrada", () => {
  const grouped = [match({ sku: "sem-familia", family: null, dist: 0.12 }), match({ sku: "fresh-legitima", family: "garrafa-fresh", dist: 0.15 })];
  const detection = { family: "garrafa-fresh", confidence: "clear", bestDistanceByFamily: { "garrafa-fresh": 0.15 } };
  const filtered = applyFamilyGate(grouped, detection);
  assert.equal(filtered.length, 2);
});

test("detectFamily retorna 'unknown' quando nenhum candidato tem família cadastrada", () => {
  const detection = detectFamily([match({ sku: "a", family: null, dist: 0.1 })]);
  assert.equal(detection.family, null);
  assert.equal(detection.confidence, "unknown");
});
