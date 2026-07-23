// Cobre o bug real corrigido: Garrafa Fresh 650ml (GFGCM13OUT) sendo sugerida
// como Copo Vibe 470ml (B-TCGCM25OUT). As distâncias usadas nos fixtures
// abaixo são MEDIDAS DE VERDADE contra os embeddings reais do catálogo
// (auditoria rodada em 2026-07-21, RPC match_image_embeddings com <=> já
// corrigido pela migration 0014) — não são valores inventados.
//
// A primeira versão de detectCategory (votação por CONTAGEM de vizinhos por
// categoria) foi testada de ponta a ponta contra o catálogo real e falhou no
// caso inverso: consultando a própria foto do Copo Vibe preto (o caso mais
// fácil possível, distância 0 pra si mesma), a contagem respondia "garrafa"
// — porque a família garrafa-fresh tinha muito mais imagens no catálogo do
// que copo-vibe, enviesando a contagem bruta. Os testes abaixo cobrem os 4
// SKUs-âncora reais (garrafa preto/branco, copo preto/branco) exatamente
// pra impedir essa regressão de voltar.
import test from "node:test";
import assert from "node:assert/strict";
import { detectCategory, applyCategoryGate, resolveCandidateList } from "../src/server/scanRecognize.ts";

function match({ sku, category, dist }) {
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
    category,
    visual_family_key: null,
    variant_key: null,
    capacity_ml: null,
  };
}

// Réplica dos 15 vizinhos brutos reais medidos consultando a própria foto da
// Garrafa Fresh 650ml preta (GFGCM13OUT-1) contra o catálogo.
const GARRAFA_ANCHOR_NEIGHBORS = [
  match({ sku: "GFGCM13OUT-1", category: "garrafa", dist: 0 }),
  match({ sku: "GFGCM13OUT-27", category: "garrafa", dist: 0.0662 }),
  match({ sku: "GFGCM13OUT-36", category: "garrafa", dist: 0.0806 }),
  match({ sku: "GFGCM13OUT-28", category: "garrafa", dist: 0.0811 }),
  match({ sku: "GFGCM13OUT-14", category: "garrafa", dist: 0.0811 }),
  match({ sku: "GFGCM13OUT-3", category: "garrafa", dist: 0.0821 }),
  match({ sku: "GFGCM13OUT-20", category: "garrafa", dist: 0.0984 }),
  match({ sku: "GFGCM13OUT-2", category: "garrafa", dist: 0.1005 }),
  match({ sku: "GFGCM13OUT-26", category: "garrafa", dist: 0.104 }),
  match({ sku: "GFGCM13OUT-35", category: "garrafa", dist: 0.1158 }),
  match({ sku: "GFGCM13OUT-19", category: "garrafa", dist: 0.1249 }),
  match({ sku: "OUT-TCGCM42-1", category: "copo", dist: 0.1277 }),
  match({ sku: "OUT-TCGCM40-20", category: "copo", dist: 0.2004 }),
  match({ sku: "GFGCM13OUT-33", category: "garrafa", dist: 0.2147 }),
  // este é o vizinho que causava o bug original: mais perto que 3 garrafas
  // legítimas, mas de categoria totalmente diferente.
  match({ sku: "B-TCGCM25OUT-1", category: "copo", dist: 0.215 }),
];

// Réplica dos vizinhos brutos reais medidos consultando a própria foto do
// Copo Vibe 470ml preto (B-TCGCM25OUT-1) — MUITOS MENOS vizinhos da própria
// categoria (copo-vibe só tem ~5 imagens no catálogo hoje), justamente o
// cenário que expôs o viés da votação por contagem.
const COPO_ANCHOR_NEIGHBORS = [
  match({ sku: "B-TCGCM25OUT-1", category: "copo", dist: 0 }),
  match({ sku: "B-TCGCM25OUT-20", category: "copo", dist: 0.1266 }),
  match({ sku: "GFGCM13OUT-1", category: "garrafa", dist: 0.215 }),
  match({ sku: "OUT-TCGCM42-1", category: "copo", dist: 0.2296 }),
  match({ sku: "GFGCM13OUT-19", category: "garrafa", dist: 0.2305 }),
  match({ sku: "GFGCM13OUT-27", category: "garrafa", dist: 0.2535 }),
  match({ sku: "GFGCM13OUT-36", category: "garrafa", dist: 0.2628 }),
  match({ sku: "GFGCM13OUT-2", category: "garrafa", dist: 0.2632 }),
  match({ sku: "GFGCM13OUT-28", category: "garrafa", dist: 0.2639 }),
  match({ sku: "GFGCM13OUT-14", category: "garrafa", dist: 0.2639 }),
  match({ sku: "OUT-TCGCM40-20", category: "copo", dist: 0.2728 }),
  match({ sku: "GFGCM13OUT-20", category: "garrafa", dist: 0.2735 }),
  match({ sku: "GFGCM13OUT-3", category: "garrafa", dist: 0.2752 }),
  match({ sku: "GFGCM13OUT-26", category: "garrafa", dist: 0.2885 }),
];

test("detectCategory acerta 'garrafa' mesmo com copos misturados no top-15 (distância, não contagem)", () => {
  const detection = detectCategory(GARRAFA_ANCHOR_NEIGHBORS);
  assert.equal(detection.category, "garrafa");
  assert.equal(detection.confidence, "clear");
  assert.equal(detection.bestDistanceByCategory.garrafa, 0);
});

test("detectCategory não depende da ordem dos vizinhos", () => {
  const shuffled = [...GARRAFA_ANCHOR_NEIGHBORS].reverse();
  const detection = detectCategory(shuffled);
  assert.equal(detection.category, "garrafa");
  assert.equal(detection.confidence, "clear");
});

test("REGRESSÃO: detectCategory acerta 'copo' mesmo com a família copo-vibe tendo poucas fotos no catálogo", () => {
  // Este é o teste que a primeira versão (votação por contagem) reprovava:
  // 9 dos 14 vizinhos brutos são "garrafa" (a família tem mais fotos), mas o
  // copo continua ganhando porque sua MELHOR distância (0, a própria foto)
  // é muito menor que a melhor distância de qualquer garrafa (0.215).
  const detection = detectCategory(COPO_ANCHOR_NEIGHBORS);
  assert.equal(detection.category, "copo");
  assert.equal(detection.confidence, "clear");
  assert.equal(detection.bestDistanceByCategory.copo, 0);
});

test("detectCategory retorna 'uncertain' quando as duas melhores categorias estão perto demais (gap < 0.05)", () => {
  const closeCall = [
    match({ sku: "a", category: "garrafa", dist: 0.2 }),
    match({ sku: "b", category: "copo", dist: 0.22 }), // gap de só 0.02
  ];
  const detection = detectCategory(closeCall);
  assert.equal(detection.confidence, "uncertain");
});

test("detectCategory retorna 'unknown' quando nenhum candidato tem categoria cadastrada", () => {
  const noCategory = [match({ sku: "a", category: null, dist: 0.1 }), match({ sku: "b", category: null, dist: 0.2 })];
  const detection = detectCategory(noCategory);
  assert.equal(detection.category, null);
  assert.equal(detection.confidence, "unknown");
});

test("applyCategoryGate BLOQUEIA o copo de vencer uma garrafa — reprodução exata do bug corrigido", () => {
  // agrupado por produto (1 linha por SKU), ordenado por distância — como
  // groupByProduct faria — com o copo (B-TCGCM25OUT-1) na 1ª posição, mais
  // perto que a própria garrafa GFGCM13OUT-33.
  const grouped = [
    match({ sku: "B-TCGCM25OUT-1", category: "copo", dist: 0.19 }), // vencedor bruto — categoria errada
    match({ sku: "GFGCM13OUT-33", category: "garrafa", dist: 0.2147 }),
    match({ sku: "GFGCM13OUT-1", category: "garrafa", dist: 0 }),
  ];
  const detection = detectCategory(GARRAFA_ANCHOR_NEIGHBORS); // categoria real detectada: garrafa
  const filtered = applyCategoryGate(grouped, detection);

  assert.equal(filtered.some((m) => m.sku_code === "B-TCGCM25OUT-1"), false, "o copo nunca pode sobrar na lista final quando a categoria detectada é garrafa");
  assert.equal(filtered[0].sku_code, "GFGCM13OUT-33", "a garrafa correta assume o topo depois do gate");
});

test("applyCategoryGate NÃO bloqueia o copo legítimo quando a categoria detectada é a própria copo", () => {
  const grouped = [
    match({ sku: "B-TCGCM25OUT-1", category: "copo", dist: 0 }),
    match({ sku: "GFGCM13OUT-1", category: "garrafa", dist: 0.215 }),
  ];
  const detection = detectCategory(COPO_ANCHOR_NEIGHBORS); // categoria real detectada: copo
  const filtered = applyCategoryGate(grouped, detection);
  assert.equal(filtered[0].sku_code, "B-TCGCM25OUT-1", "o copo legítimo continua reconhecido normalmente");
});

test("applyCategoryGate não bloqueia nada quando a confiança da categoria é 'uncertain' ou 'unknown'", () => {
  const grouped = [match({ sku: "x", category: "copo", dist: 0.1 }), match({ sku: "y", category: "garrafa", dist: 0.15 })];
  const uncertain = { category: "garrafa", confidence: "uncertain", bestDistanceByCategory: { garrafa: 0.1, copo: 0.12 } };
  assert.deepEqual(applyCategoryGate(grouped, uncertain), grouped);

  const unknown = { category: null, confidence: "unknown", bestDistanceByCategory: {} };
  assert.deepEqual(applyCategoryGate(grouped, unknown), grouped);
});

test("applyCategoryGate nunca bloqueia produtos sem categoria cadastrada (catálogo incompleto)", () => {
  const grouped = [
    match({ sku: "sem-categoria", category: null, dist: 0.12 }),
    match({ sku: "garrafa-legitima", category: "garrafa", dist: 0.15 }),
  ];
  const detection = { category: "garrafa", confidence: "clear", bestDistanceByCategory: { garrafa: 0.15 } };
  const filtered = applyCategoryGate(grouped, detection);
  assert.equal(filtered.length, 2, "produto sem categoria cadastrada nunca é excluído — não há dado pra bloquear com segurança");
});

// ---------------------------------------------------------------------------
// Piso absoluto de confiança — SEGUNDO bug real corrigido em produção: uma
// captura real de Garrafa Fresh media 0.57 contra "garrafa" (péssimo) e 0.36
// contra "copo" (mediano) — folga relativa grande (0.20) fazia detectCategory
// declarar "copo" como categoria "clear", mesmo 0.36 sendo, em termos
// absolutos, evidência fraca demais pra confiar. Réplica exata desse log.
// ---------------------------------------------------------------------------
const REAL_BUG_MATCHES = [
  match({ sku: "B-TCGCM25OUT-1", category: "copo", dist: 0.362899642430041 }),
  match({ sku: "OUT-TCGCM40-20", category: "copo", dist: 0.4586 }),
  match({ sku: "GFGCM13OUT-2", category: "garrafa", dist: 0.570989696886301 }),
];

test("detectCategory recusa 'clear' quando a vencedora não é um bom match em termos absolutos (mesmo com folga relativa grande)", () => {
  const detection = detectCategory(REAL_BUG_MATCHES);
  assert.equal(detection.confidence, "uncertain", "0.36 de distância não é confiável o suficiente pra travar uma categoria, mesmo vencendo por folga de 0.20 sobre a 2ª colocada");
});

test("resolveCandidateList BLOQUEIA a sugestão — reprodução exata do 2º bug real (log de produção)", () => {
  const detection = detectCategory(REAL_BUG_MATCHES);
  const resolved = resolveCandidateList(REAL_BUG_MATCHES, detection);
  assert.equal(resolved.resolution, "uncertain_blocked");
  assert.equal(resolved.candidates.length, 0, "nem o copo (vencedor bruto) pode ser sugerido quando a evidência absoluta é fraca demais");
});

test("resolveCandidateList AINDA aceita o vencedor bruto quando a categoria é incerta MAS o match é excelente (alta confiança absoluta)", () => {
  // categoria incerta (só 1 vizinho, sem 2ª categoria pra comparar seria
  // 'unknown'; aqui simulamos duas categorias empatadas de perto, mas com
  // distância ótima) — não deve travar um match excelente por falta de
  // corroboração de categoria.
  const excellentButAmbiguous = [match({ sku: "x", category: "copo", dist: 0.05 }), match({ sku: "y", category: "garrafa", dist: 0.07 })];
  const detection = detectCategory(excellentButAmbiguous);
  assert.equal(detection.confidence, "uncertain"); // gap 0.02 < 0.05
  const resolved = resolveCandidateList(excellentButAmbiguous, detection);
  assert.equal(resolved.resolution, "uncertain_high_confidence_override");
  assert.equal(resolved.candidates[0].sku_code, "x", "o vencedor bruto (alta confiança absoluta) ainda é aceito, incerteza de categoria aqui é só ruído de catálogo esparso");
});

test("resolveCandidateList aplica o gate normalmente quando a categoria é 'clear'", () => {
  const detection = detectCategory(GARRAFA_ANCHOR_NEIGHBORS);
  const grouped = [
    match({ sku: "B-TCGCM25OUT-1", category: "copo", dist: 0.19 }),
    match({ sku: "GFGCM13OUT-33", category: "garrafa", dist: 0.2147 }),
  ];
  const resolved = resolveCandidateList(grouped, detection);
  assert.equal(resolved.resolution, "gated");
  assert.equal(resolved.candidates[0].sku_code, "GFGCM13OUT-33");
});
