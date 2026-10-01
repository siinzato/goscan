import test from "node:test";
import assert from "node:assert/strict";
import { mapLoadingOrderRows, validateLoadingOrderRows, splitModeloECor } from "../src/client/loadingOrderApi.ts";

// Linhas reais da Ordem de Carregamento DOGA-22 enviada pelo usuário —
// cabeçalho exatamente como o remetente manda (varia: 1ª versão veio com
// "Sku Único"/"Descrição Webgex", 2ª com "Produto"/"Descrição" — por isso o
// mapeamento abaixo nunca depende do nome exato, só de "produto"/"descrição"
// OU da posição 1ª/3ª coluna).
const REAL_ROWS_NAMED = [
  { "Produto": "Bolsa de Viagem Voyage Off White", "Cód. Webgex": "0110788000003", "Descrição": "BOLSA VOYAGE OFF WHITE BB", "SKU": "TX222003", "Quantidade": 2 },
  { "Produto": "Bolsa Moove Preta", "Cód. Webgex": "0110785000002", "Descrição": "BOLSA FLIP MOOVE PRETA BB", "SKU": "TX221001", "Quantidade": 36 },
];

// Mesmas linhas, mas com cabeçalho totalmente diferente dos nomes esperados —
// só a POSIÇÃO (1ª e 3ª coluna) permite reconhecer produto/descrição.
const REAL_ROWS_UNNAMED_HEADERS = [
  { "Sku Único": "Bolsa de Viagem Voyage Off White", "Cód. Webgex": "0110788000003", "Descrição Webgex": "BOLSA VOYAGE OFF WHITE BB", "SKU": "TX222003", "Quantidade": 2 },
];

test("mapLoadingOrderRows reconhece 'Produto'/'Descrição'/'Quantidade' pelo nome do cabeçalho", () => {
  const mapped = mapLoadingOrderRows(REAL_ROWS_NAMED);
  assert.deepEqual(mapped[0], { produto: "Bolsa de Viagem Voyage Off White", descricao: "BOLSA VOYAGE OFF WHITE BB", quantidade: "2" });
  assert.deepEqual(mapped[1], { produto: "Bolsa Moove Preta", descricao: "BOLSA FLIP MOOVE PRETA BB", quantidade: "36" });
});

test("mapLoadingOrderRows cai pra posição 1ª/3ª coluna quando o cabeçalho não usa os nomes esperados", () => {
  const mapped = mapLoadingOrderRows(REAL_ROWS_UNNAMED_HEADERS);
  assert.equal(mapped[0].produto, "Bolsa de Viagem Voyage Off White");
  assert.equal(mapped[0].descricao, "BOLSA VOYAGE OFF WHITE BB");
});

test("mapLoadingOrderRows usa a última coluna como quantidade quando não há cabeçalho de quantidade reconhecido", () => {
  const mapped = mapLoadingOrderRows([{ "Col A": "Produto X", "Col B": "123", "Col C": "Descrição X", "Col D": "SKU1", "Col E": "5" }]);
  assert.equal(mapped[0].quantidade, "5");
});

test("validateLoadingOrderRows aceita linha válida e converte quantidade pra número", () => {
  const { valid, errors } = validateLoadingOrderRows([{ produto: "Bolsa Moove Preta", descricao: "desc", quantidade: "36" }]);
  assert.equal(errors.length, 0);
  assert.deepEqual(valid[0], { produto: "Bolsa Moove Preta", descricao: "desc", quantidade: 36 });
});

test("validateLoadingOrderRows rejeita linha sem produto", () => {
  const { valid, errors } = validateLoadingOrderRows([{ produto: "", descricao: "x", quantidade: "1" }]);
  assert.equal(valid.length, 0);
  assert.match(errors[0].reason, /Produto é obrigatório/);
});

test("validateLoadingOrderRows rejeita quantidade ausente, zero ou inválida", () => {
  const { errors: e1 } = validateLoadingOrderRows([{ produto: "X", quantidade: "" }]);
  const { errors: e2 } = validateLoadingOrderRows([{ produto: "X", quantidade: "0" }]);
  const { errors: e3 } = validateLoadingOrderRows([{ produto: "X", quantidade: "abc" }]);
  assert.equal(e1.length, 1);
  assert.equal(e2.length, 1);
  assert.equal(e3.length, 1);
});

const COLORS = [
  { normalized_alias: "off white", canonical_value: "Off White" },
  { normalized_alias: "preta", canonical_value: "Preta" },
  { normalized_alias: "marrom", canonical_value: "Marrom" },
];

test("splitModeloECor separa modelo e cor quando a cor aparece no final do texto (cor composta)", () => {
  const result = splitModeloECor("Bolsa de Viagem Voyage Off White", COLORS);
  assert.deepEqual(result, { modelo: "Bolsa de Viagem Voyage", cor: "Off White" });
});

test("splitModeloECor separa modelo e cor simples", () => {
  const result = splitModeloECor("Bolsa Moove Preta", COLORS);
  assert.deepEqual(result, { modelo: "Bolsa Moove", cor: "Preta" });
});

test("splitModeloECor devolve o texto inteiro como modelo (cor vazia) quando nenhuma cor conhecida aparece no final", () => {
  const result = splitModeloECor("Copo Daily Preto 600ml", COLORS);
  assert.deepEqual(result, { modelo: "Copo Daily Preto 600ml", cor: "" });
});

test("splitModeloECor nunca devolve o modelo vazio (cor sozinha, sem nome de produto antes, não conta)", () => {
  const result = splitModeloECor("Off White", COLORS);
  assert.deepEqual(result, { modelo: "Off White", cor: "" });
});
