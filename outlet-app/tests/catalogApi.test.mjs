import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalogIdFilter, classifyExactLookupTerm } from "../src/client/catalogApi.ts";

// ---------------------------------------------------------------------------
// PERFORMANCE — buildCatalogIdFilter() substitui 4 requests paralelas
// separadas (nome/categoria/família/capacidade) por UMA única, usando o
// mesmo mecanismo `.or()`/`and()` do PostgREST que o resto do arquivo já usa
// (orParts.join(",") na busca principal). Travando a string exata aqui
// porque um erro de sintaxe de filtro quebraria a busca inteira em
// silêncio (PostgREST rejeitaria com 400, ou pior, mudaria o resultado).
// Equivalência numérica com as 4 queries antigas (união de resultados,
// nenhum perdido) foi verificada separadamente com EXPLAIN/dados reais.
// ---------------------------------------------------------------------------
test("buildCatalogIdFilter: palavra única de nome + categoria/família (sem capacidade)", () => {
  const filter = buildCatalogIdFilter("moove", ["moove"], undefined);
  assert.equal(filter, "and(normalized_name.ilike.%moove%),category.ilike.%moove%,visual_family_key.ilike.%moove%");
});

test("buildCatalogIdFilter: múltiplas palavras de nome viram AND dentro do and(...)", () => {
  const filter = buildCatalogIdFilter("garrafa termica", ["garrafa", "termica"], undefined);
  assert.equal(
    filter,
    "and(normalized_name.ilike.%garrafa%,normalized_name.ilike.%termica%),category.ilike.%garrafa termica%,visual_family_key.ilike.%garrafa termica%"
  );
});

test("buildCatalogIdFilter: inclui capacidade só quando há dígitos na busca", () => {
  const filter = buildCatalogIdFilter("copo 600", ["copo", "600"], "600");
  assert.equal(
    filter,
    "and(normalized_name.ilike.%copo%,normalized_name.ilike.%600%),category.ilike.%copo 600%,visual_family_key.ilike.%copo 600%,capacity_ml.eq.600"
  );
});

test("buildCatalogIdFilter: sem palavras de nome (nameWords vazio) nunca inclui o and() de nome", () => {
  const filter = buildCatalogIdFilter("", [], undefined);
  assert.equal(filter, "category.ilike.%%,visual_family_key.ilike.%%");
});

test("buildCatalogIdFilter: categoria e família sempre participam, mesmo buscando só por um número (capacidade)", () => {
  const filter = buildCatalogIdFilter("880", ["880"], "880");
  assert.equal(filter, "and(normalized_name.ilike.%880%),category.ilike.%880%,visual_family_key.ilike.%880%,capacity_ml.eq.880");
});

// ---------------------------------------------------------------------------
// PERFORMANCE — classifyExactLookupTerm() decide quando o picker/catálogo tenta
// primeiro o atalho EXATO por índice (sku_code = X / gtin_normalized = X) antes
// da busca difusa. Travando os limites: termo de nome/modelo/cor NUNCA gera a
// consulta extra, e um SKU com letras nunca vira "EAN" (normalizeEan descarta
// letras, então "ABC12345678" viraria um EAN-8 falso sem a trava de só-dígitos).
// ---------------------------------------------------------------------------
test("classifyExactLookupTerm: SKU real vira candidato a SKU (maiúsculas), nunca EAN", () => {
  assert.deepEqual(classifyExactLookupTerm("GFGCM13OUT-2"), { ean: null, sku: "GFGCM13OUT-2" });
  assert.deepEqual(classifyExactLookupTerm("  gfgcm13out-2 "), { ean: null, sku: "GFGCM13OUT-2" });
  assert.deepEqual(classifyExactLookupTerm("OUT-BTGCM63-1"), { ean: null, sku: "OUT-BTGCM63-1" });
});

test("classifyExactLookupTerm: EAN válido (8/12/13/14 dígitos) vira candidato a EAN e também a SKU numérico", () => {
  assert.deepEqual(classifyExactLookupTerm("7908918701572"), { ean: "7908918701572", sku: "7908918701572" });
  assert.deepEqual(classifyExactLookupTerm("7908918 701572"), { ean: "7908918701572", sku: null });
});

test("classifyExactLookupTerm: SKU com letras + 8 dígitos NÃO é tratado como EAN", () => {
  assert.equal(classifyExactLookupTerm("ABC12345678").ean, null);
  assert.equal(classifyExactLookupTerm("ABC12345678").sku, "ABC12345678");
});

test("classifyExactLookupTerm: nome/modelo/cor/frase não gera atalho (sem consulta extra)", () => {
  assert.deepEqual(classifyExactLookupTerm("moove"), { ean: null, sku: null });
  assert.deepEqual(classifyExactLookupTerm("garrafa termica"), { ean: null, sku: null });
  assert.deepEqual(classifyExactLookupTerm("garrafa fresh 650"), { ean: null, sku: null });
  assert.deepEqual(classifyExactLookupTerm(""), { ean: null, sku: null });
});

test("classifyExactLookupTerm: separadores do PostgREST são neutralizados e dígitos curtos não viram EAN", () => {
  assert.equal(classifyExactLookupTerm("ABC1,2)3(").sku, "ABC123");
  assert.equal(classifyExactLookupTerm("12345").ean, null);
});

// ---------------------------------------------------------------------------
// Painel de qualidade do catálogo (somente leitura) — análises puras.
// ---------------------------------------------------------------------------
import { findWithoutEan, findDuplicateEans, findOutletAsNormal, buildCatalogQualityReport } from "../src/client/catalogQualityApi.ts";
const qv = (sku, ean, pid, name, type = "normal") => ({ variant_id: sku, sku_code: sku, ean, product_id: pid, product_name: name, product_type: type });

test("qualidade: findWithoutEan lista só variantes sem EAN, ordenadas por SKU", () => {
  const rows = [qv("B-2", null, "p1", "B"), qv("A-1", "7908918701572", "p2", "A"), qv("A-0", "", "p3", "C")];
  assert.deepEqual(findWithoutEan(rows).map((r) => r.sku_code), ["A-0", "B-2"]);
});

test("qualidade: findDuplicateEans só considera EAN em produtos DIFERENTES", () => {
  const rows = [
    qv("S1", "111", "p1", "X"), qv("S2", "111", "p2", "Y"), // duplicado entre produtos → entra
    qv("S3", "222", "p3", "Z"), qv("S4", "222", "p3", "Z"), // mesmo produto → não entra
    qv("S5", "333", "p4", "W"), qv("S6", null, "p5", "V"),
  ];
  const groups = findDuplicateEans(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ean, "111");
  assert.deepEqual(groups[0].variants.map((v) => v.sku_code), ["S1", "S2"]);
});

test("qualidade: findOutletAsNormal pega OUT- no SKU ou nome Outlet, só com tipo normal", () => {
  const rows = [
    qv("OUT-ABC-1", "1", "p1", "Garrafa", "normal"),
    qv("XYZ-1", "2", "p2", "Outlet Gocase Copo", "normal"),
    qv("OUT-OK-1", "3", "p3", "Garrafa", "outlet"),
    qv("NORM-1", "4", "p4", "Copo outlet de verdade", "normal"), // "outlet" no meio do nome não conta
  ];
  assert.deepEqual(findOutletAsNormal(rows).map((r) => r.sku_code), ["OUT-ABC-1", "XYZ-1"]);
});

test("qualidade: buildCatalogQualityReport junta tudo e conta o total", () => {
  const r = buildCatalogQualityReport([qv("A", null, "p1", "A"), qv("B", "9", "p2", "B")]);
  assert.equal(r.total, 2);
  assert.equal(r.withoutEan.length, 1);
  assert.equal(r.duplicateEans.length, 0);
});
