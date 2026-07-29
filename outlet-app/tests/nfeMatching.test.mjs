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
