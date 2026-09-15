import test from "node:test";
import assert from "node:assert/strict";
import { resolveInvoiceItem, computeItemStatus, summarizeReceipt, scoreNameSimilarity, suggestBestMatch } from "../src/client/nfeMatching.ts";

const candidates = [
  { variant_id: "v1", sku_code: "TCGCM42-1", gtin_normalized: "7891234567890" },
  { variant_id: "v2", sku_code: "GFGCM13-2", gtin_normalized: null },
];

test("resolveInvoiceItem prioriza SKU exato sobre EAN", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "TCGCM42-1", ean: "7891234567890" }, candidates);
  assert.equal(result.variant_id, "v1");
  assert.equal(result.link_source, "sku");
});

test("resolveInvoiceItem cai para EAN exato quando o código da NF não bate com nenhum SKU", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "CODIGO-DO-FORNECEDOR-XYZ", ean: "7891234567890" }, candidates);
  assert.equal(result.variant_id, "v1");
  assert.equal(result.link_source, "ean");
});

// ---------------------------------------------------------------------------
// CORREÇÃO — gtin_normalized não tem constraint de unicidade no banco
// (diferente de sku_code): dois produtos ATIVOS distintos cadastrados por
// engano com o mesmo EAN nunca podem ser escolhidos silenciosamente — antes
// o .find() pegava o primeiro da lista sem avisar ninguém.
// ---------------------------------------------------------------------------
test("resolveInvoiceItem NUNCA vincula sozinho quando o EAN bate em mais de um produto ativo (EAN duplicado)", () => {
  const duplicated = [
    { variant_id: "v3", sku_code: "AAA-1", gtin_normalized: "1112223334445" },
    { variant_id: "v4", sku_code: "BBB-1", gtin_normalized: "1112223334445" },
  ];
  const result = resolveInvoiceItem({ invoice_product_code: "CODIGO-DESCONHECIDO", ean: "1112223334445" }, duplicated);
  assert.equal(result.variant_id, null);
  assert.equal(result.link_source, null);
});

// ---------------------------------------------------------------------------
// FASE 2 — CORREÇÃO cEANTrib: confirmado com dados reais (4 casos históricos)
// que cEAN válido às vezes não bate em NADA do catálogo, enquanto cEANTrib
// válido bate com exatamente um produto — sem isso, esse segundo
// identificador nunca chegava ao matcher (nfeParser descartava). Só usa
// quando cEAN não achou NENHUM candidato (nunca compete com um cEAN que já
// resolveu ou que é ambíguo).
// ---------------------------------------------------------------------------
test("resolveInvoiceItem vincula por EAN tributável quando o cEAN comercial é válido mas não bate em nenhum produto", () => {
  const result = resolveInvoiceItem(
    { invoice_product_code: "CODIGO-DESCONHECIDO", ean: "9999999999999", ean_tributable: "7891234567890" },
    candidates
  );
  assert.equal(result.variant_id, "v1");
  assert.equal(result.link_source, "ean");
});

test("resolveInvoiceItem NUNCA usa EAN tributável se o cEAN comercial já resolveu sozinho (cEAN sempre vence)", () => {
  const conflitantes = [
    { variant_id: "v1", sku_code: "TCGCM42-1", gtin_normalized: "7891234567890" },
    { variant_id: "v9", sku_code: "OUTRO-9", gtin_normalized: "1231231231231" },
  ];
  const result = resolveInvoiceItem(
    { invoice_product_code: "CODIGO-DESCONHECIDO", ean: "7891234567890", ean_tributable: "1231231231231" },
    conflitantes
  );
  assert.equal(result.variant_id, "v1");
  assert.equal(result.link_source, "ean");
});

test("resolveInvoiceItem NUNCA usa EAN tributável pra desempatar quando o cEAN comercial é ambíguo (2+ produtos)", () => {
  const duplicated = [
    { variant_id: "v3", sku_code: "AAA-1", gtin_normalized: "1112223334445" },
    { variant_id: "v4", sku_code: "BBB-1", gtin_normalized: "1112223334445" },
    { variant_id: "v9", sku_code: "OUTRO-9", gtin_normalized: "9998887776665" },
  ];
  const result = resolveInvoiceItem(
    { invoice_product_code: "CODIGO-DESCONHECIDO", ean: "1112223334445", ean_tributable: "9998887776665" },
    duplicated
  );
  assert.equal(result.variant_id, null);
  assert.equal(result.link_source, null);
});

test("resolveInvoiceItem NUNCA decide arbitrariamente quando cEAN e cEANTrib apontam pra produtos DIFERENTES (ambos batem em algo)", () => {
  const doisProdutos = [
    { variant_id: "vA", sku_code: "PRODUTO-A", gtin_normalized: "1111111111111" },
    { variant_id: "vB", sku_code: "PRODUTO-B", gtin_normalized: "2222222222222" },
  ];
  const result = resolveInvoiceItem(
    { invoice_product_code: "CODIGO-DESCONHECIDO", ean: "1111111111111", ean_tributable: "2222222222222" },
    doisProdutos
  );
  // cEAN já bate sozinho (byEan.length === 1) — vence, não é ambíguo de verdade.
  assert.equal(result.variant_id, "vA");
  assert.equal(result.link_source, "ean");
});

test("resolveInvoiceItem ignora EAN tributável igual ao cEAN após normalização (não é um segundo identificador)", () => {
  const result = resolveInvoiceItem(
    { invoice_product_code: "CODIGO-DESCONHECIDO", ean: "9999999999999", ean_tributable: "9999999999999" },
    candidates
  );
  assert.equal(result.variant_id, null);
  assert.equal(result.link_source, null);
});

// ---------------------------------------------------------------------------
// CORREÇÃO — cProd-como-EAN: medido contra o backlog real de pendências do
// usuário, 27 de 31 itens sem EAN declarado (cEAN "SEM GTIN") tinham cProd
// batendo com EXATAMENTE 1 produto ativo cadastrado por gtin_normalized —
// fornecedores importadores gravam o GTIN de verdade do fabricante em cProd
// quando não preenchem cEAN/cEANTrib. Vincula automaticamente só quando a NF
// não declarou EAN nenhum e a correspondência por cProd-como-EAN é única.
// ---------------------------------------------------------------------------
test("resolveInvoiceItem vincula por cProd-como-EAN quando a NF não declara EAN nenhum e o código do fornecedor bate com o GTIN de exatamente um produto ativo", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "6902048304918", ean: null }, [
    { variant_id: "v5", sku_code: "CCNKM3GA17-1", gtin_normalized: "6902048304918" },
  ]);
  assert.equal(result.variant_id, "v5");
  assert.equal(result.link_source, "cprod_ean");
});

test("resolveInvoiceItem NUNCA usa cProd-como-EAN se a NF já declarou um EAN próprio (mesmo que esse EAN não resolva sozinho)", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "6902048304918", ean: "0000000000000" }, [
    { variant_id: "v5", sku_code: "CCNKM3GA17-1", gtin_normalized: "6902048304918" },
  ]);
  assert.equal(result.variant_id, null);
  assert.equal(result.link_source, null);
});

test("resolveInvoiceItem NUNCA vincula sozinho por cProd-como-EAN quando bate em mais de um produto ativo", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "6902048304918", ean: null }, [
    { variant_id: "v5", sku_code: "CCNKM3GA17-1", gtin_normalized: "6902048304918" },
    { variant_id: "v6", sku_code: "OUTRO-1", gtin_normalized: "6902048304918" },
  ]);
  assert.equal(result.variant_id, null);
  assert.equal(result.link_source, null);
});

// ---------------------------------------------------------------------------
// CORREÇÃO — causa raiz do bug relatado ("EAN já cadastrado não vincula
// automaticamente"): o EAN da NF pode chegar com espaço/pontuação/traço que o
// EAN cadastrado (já normalizado em gtin_normalized) não tem — a comparação
// TEM que tolerar isso via normalizeEan, nunca por igualdade de texto cru.
// ---------------------------------------------------------------------------
test("resolveInvoiceItem encontra por EAN mesmo com espaços ao redor (formatação da NF)", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "CODIGO-DESCONHECIDO", ean: " 7891234567890 " }, candidates);
  assert.equal(result.variant_id, "v1");
  assert.equal(result.link_source, "ean");
});

test("resolveInvoiceItem encontra por EAN formatado com espaços/traços internos", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "CODIGO-DESCONHECIDO", ean: "789-1234-567890" }, candidates);
  assert.equal(result.variant_id, "v1");
  assert.equal(result.link_source, "ean");
});

test("resolveInvoiceItem nunca trata um EAN de formato inválido (ex.: '0') como correspondência", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "CODIGO-DESCONHECIDO", ean: "0" }, candidates);
  assert.equal(result.variant_id, null);
});

test("resolveInvoiceItem usa associação aprendida só quando SKU e EAN exatos não batem", () => {
  const aliases = { byCode: new Map([["CODIGO-FORNECEDOR-9", "v2"]]), byEan: new Map() };
  const result = resolveInvoiceItem({ invoice_product_code: "CODIGO-FORNECEDOR-9", ean: null }, candidates, aliases);
  assert.equal(result.variant_id, "v2");
  assert.equal(result.link_source, "alias");
});

test("resolveInvoiceItem NUNCA usa o alias se já existe correspondência exata de SKU (cadastro sempre vence)", () => {
  const aliases = { byCode: new Map([["TCGCM42-1", "v2"]]), byEan: new Map() }; // alias errado de propósito
  const result = resolveInvoiceItem({ invoice_product_code: "TCGCM42-1", ean: null }, candidates, aliases);
  assert.equal(result.variant_id, "v1");
  assert.equal(result.link_source, "sku");
});

test("resolveInvoiceItem retorna null quando nenhuma fonte resolve (exige vínculo manual)", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "DESCONHECIDO", ean: null }, candidates);
  assert.equal(result.variant_id, null);
  assert.equal(result.link_source, null);
});

test("resolveInvoiceItem ignora variação de hífen Unicode e caixa alta/baixa na comparação (nunca reescreve o SKU original)", () => {
  const result = resolveInvoiceItem({ invoice_product_code: "tcgcm42‐1", ean: null }, candidates);
  assert.equal(result.variant_id, "v1");
});

test("computeItemStatus: 10 esperado / 10 físico = ok", () => {
  assert.equal(computeItemStatus(10, 10), "ok");
});

test("computeItemStatus: 20 esperado / 18 físico = missing (falta 2)", () => {
  assert.equal(computeItemStatus(20, 18), "missing");
});

test("computeItemStatus: 15 esperado / 17 físico = surplus (sobra 2)", () => {
  assert.equal(computeItemStatus(15, 17), "surplus");
});

test("computeItemStatus: physical null = pending (ainda não contado)", () => {
  assert.equal(computeItemStatus(10, null), "pending");
});

test("summarizeReceipt NUNCA cancela divergências pela soma líquida (produto A -10, produto B +10 = 2 divergências, não 0)", () => {
  const summary = summarizeReceipt([
    { expected_quantity: 10, physical_quantity: 0 }, // falta 10
    { expected_quantity: 10, physical_quantity: 20 }, // sobra 10
  ]);
  assert.equal(summary.netDifference, 0);
  assert.equal(summary.missing, 1);
  assert.equal(summary.surplus, 1);
  assert.equal(summary.ok, 0);
});

test("summarizeReceipt calcula taxa de conformidade só sobre itens já conferidos", () => {
  const summary = summarizeReceipt([
    { expected_quantity: 10, physical_quantity: 10 }, // ok
    { expected_quantity: 5, physical_quantity: 5 }, // ok
    { expected_quantity: 8, physical_quantity: null }, // pending, não entra no denominador
  ]);
  assert.equal(summary.ok, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.conformityRate, 1);
});

// Exemplo REAL reportado: a NF-e descreve "BOLSA TERMICA MIX BB BRUTA MARROM"
// (maiúsculas, com marca/cor extra) e o produto cadastrado no GoScan é só
// "Bolsa Térmica Mix" (com acento, sem marca/cor) — precisa achar mesmo assim.
test("scoreNameSimilarity encontra o produto real mesmo com acento, caixa e palavras extras na NF", () => {
  const score = scoreNameSimilarity("BOLSA TERMICA MIX BB BRUTA MARROM", "Bolsa Térmica Mix");
  assert.ok(score > 0.25, `esperava score > 0.25, recebeu ${score}`);
});

test("scoreNameSimilarity não inventa semelhança entre produtos sem nenhuma palavra em comum", () => {
  const score = scoreNameSimilarity("BOLSA TERMICA MIX BB BRUTA MARROM", "Fone de Ouvido Bluetooth");
  assert.equal(score, 0);
});

test("scoreNameSimilarity é 0 quando uma das strings é vazia (nunca divide por zero)", () => {
  assert.equal(scoreNameSimilarity("", "Bolsa Térmica Mix"), 0);
  assert.equal(scoreNameSimilarity("Bolsa Térmica Mix", ""), 0);
});

const normalCandidates = [
  { variant_id: "n1", sku_code: "BTM-1", produto: "Bolsa Térmica Mix" },
  { variant_id: "n2", sku_code: "BVJ-1", produto: "Bolsa de Viagem Joy" },
  { variant_id: "n3", sku_code: "BTP-1", produto: "Bolsa Tote Puff" },
];

test("suggestBestMatch acha o candidato certo entre vários parecidos (Bolsa X vs Bolsa Y)", () => {
  const result = suggestBestMatch("BOLSA TERMICA MIX BB BRUTA MARROM", normalCandidates);
  assert.ok(result, "esperava uma sugestão");
  assert.equal(result.candidate.sku_code, "BTM-1");
});

test("suggestBestMatch retorna null quando nada passa do limiar (nunca sugere qualquer coisa)", () => {
  const result = suggestBestMatch("Fone de Ouvido Bluetooth Premium", normalCandidates);
  assert.equal(result, null);
});

test("suggestBestMatch retorna null pra lista vazia de candidatos", () => {
  assert.equal(suggestBestMatch("Bolsa Térmica Mix", []), null);
});

// ---------------------------------------------------------------------------
// CORREÇÃO — causa raiz de "sugere produto errado": duas variantes (cor/
// tamanho) do mesmo produto-base compartilham o campo `produto`, então
// empatam na similaridade de nome contra a mesma descrição da NF. Escolher
// a de maior score sozinha vira um cara-ou-coroa que erra a variante — igual
// ao EAN duplicado, quando ambíguo não deve sugerir, só pedir busca manual.
// ---------------------------------------------------------------------------
test("suggestBestMatch NUNCA sugere quando duas variantes empatam de perto na similaridade (ambíguo)", () => {
  const tiedVariants = [
    { variant_id: "v-azul", sku_code: "BTM-AZ", produto: "Bolsa Térmica Mix" },
    { variant_id: "v-verde", sku_code: "BTM-VD", produto: "Bolsa Térmica Mix" },
  ];
  const result = suggestBestMatch("BOLSA TERMICA MIX BB BRUTA MARROM", tiedVariants);
  assert.equal(result, null, "esperava null por ambiguidade entre variantes empatadas");
});

test("suggestBestMatch ainda sugere normalmente quando o 2º colocado fica bem abaixo do 1º (não é empate)", () => {
  const result = suggestBestMatch("BOLSA TERMICA MIX BB BRUTA MARROM", normalCandidates);
  assert.ok(result, "esperava uma sugestão quando não há ambiguidade real");
  assert.equal(result.candidate.sku_code, "BTM-1");
});
