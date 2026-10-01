import test from "node:test";
import assert from "node:assert/strict";
import { mapLoadingOrderRows, validateLoadingOrderRows, splitModeloECor, canonicalizeCapacity, matchLoadingOrderRow, buildOutletSkuIndex } from "../src/client/loadingOrderApi.ts";

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

// NOTA — splitModeloECor devolve `modelo` já NORMALIZADO (minúsculo, sem
// acento) desde a correção abaixo: os 3 chamadores (matchItem,
// searchSkuForPicker) sempre re-normalizam o texto de qualquer jeito, então
// preservar a grafia original nunca teve efeito prático — e evitar essa
// reconstrução é o que permite achar a cor em QUALQUER posição do texto
// (não só no final) sem se perder contando palavras entre a versão original
// e a normalizada (que não casam 1:1 quando normalize() junta/separa
// palavras, ex.: "500 ml" -> "500ml").
test("splitModeloECor separa modelo e cor quando a cor aparece no final do texto (cor composta)", () => {
  const result = splitModeloECor("Bolsa de Viagem Voyage Off White", COLORS);
  assert.deepEqual(result, { modelo: "bolsa de viagem voyage", cor: "Off White" });
});

test("splitModeloECor separa modelo e cor simples", () => {
  const result = splitModeloECor("Bolsa Moove Preta", COLORS);
  assert.deepEqual(result, { modelo: "bolsa moove", cor: "Preta" });
});

test("splitModeloECor devolve o texto inteiro normalizado (cor vazia) quando nenhuma cor conhecida é reconhecida", () => {
  const result = splitModeloECor("Copo Daily Preto 600ml", COLORS);
  assert.deepEqual(result, { modelo: "copo daily preto 600ml", cor: "" });
});

test("splitModeloECor nunca devolve o modelo vazio (cor sozinha, sem nome de produto antes, não conta)", () => {
  const result = splitModeloECor("Off White", COLORS);
  assert.deepEqual(result, { modelo: "off white", cor: "" });
});

// ---------------------------------------------------------------------------
// CORREÇÃO REAL — causa raiz confirmada com a planilha de produção (receipt
// "carregamento novo", 167/208 itens sem vínculo): a `descricao` real do
// remetente segue "[MODELO] [COR] [texto adicional do remetente]" — a cor
// NUNCA está no final, sempre tem um texto extra depois (mínimo "BB", no
// pior caso "COM TECNOLOGIA GOCASE CONNECT(QR CODE) E MANUAL"). A versão
// antiga só reconhecia cor no FINAL do texto, então o texto inteiro
// (incluindo as palavras do remetente que não existem em NENHUM nome do
// catálogo) virava "modelo" e zerava os candidatos sempre.
// ---------------------------------------------------------------------------
test("splitModeloECor acha a cor NO MEIO do texto e descarta o texto adicional do remetente depois dela (caso real)", () => {
  const result = splitModeloECor("BOLSA TOTE MARROM COM TECNOLOGIA GOCASE CONNECT(QR CODE) E MANUAL", COLORS);
  assert.deepEqual(result, { modelo: "bolsa tote", cor: "Marrom" });
});

test("splitModeloECor acha a cor no meio mesmo com sufixo curto do remetente (BB)", () => {
  const result = splitModeloECor("BOLSA TOTE MINI PRETA BB COM TECNOLOGIA GOCASE CONNECT(QR CODE) E MANUAL", COLORS);
  assert.deepEqual(result, { modelo: "bolsa tote mini", cor: "Preta" });
});

test("splitModeloECor nunca casa cor dentro de outra palavra (fronteira de palavra obrigatória)", () => {
  // "marrom" não pode casar dentro de "marromzinho" (palavra fictícia pra garantir a fronteira)
  const result = splitModeloECor("Bolsa Marromzinho Estilo", COLORS);
  assert.deepEqual(result, { modelo: "bolsa marromzinho estilo", cor: "" });
});

// ---------------------------------------------------------------------------
// canonicalizeCapacity — "500ml"/"500 ML"/"0,5L"/"0.5L"/"1L"/"1 litro"/
// "1000ml" precisam virar a MESMA unidade comparável (o catálogo Outlet só
// usa "NNNml" nos nomes, ex.: "Copo Térmico Life 880ml").
// ---------------------------------------------------------------------------
// canonicalizeCapacity só converte L/litro -> ml (valor numérico). Juntar
// "500 ML" -> "500ml" (sem converter nada, só remove o espaço) já é
// responsabilidade do normalize() existente — splitModeloECor já aplica os
// dois em sequência (ver teste abaixo), então o resultado final bate mesmo
// a planilha usando "500 ML" (com espaço) e o catálogo usando "500ml".
test("canonicalizeCapacity: não mexe em litragem já em ml (isso é o normalize() que junta o espaço)", () => {
  assert.equal(canonicalizeCapacity("Copo 500 ML Preto"), "Copo 500 ML Preto");
  assert.equal(canonicalizeCapacity("Copo 500ml Preto"), "Copo 500ml Preto");
});

test("splitModeloECor: '500 ML' (com espaço) e '500ml' extraem o mesmo modelo (canonicalizeCapacity + normalize juntos)", () => {
  const r1 = splitModeloECor("Copo 500 ML Marrom", COLORS);
  const r2 = splitModeloECor("Copo 500ml Marrom", COLORS);
  assert.deepEqual(r1, { modelo: "copo 500ml", cor: "Marrom" });
  assert.deepEqual(r2, r1);
});

test("canonicalizeCapacity: '0,5L' e '0.5L' convertem pra '500ml' (0,5 litro = 500ml)", () => {
  assert.equal(canonicalizeCapacity("Garrafa 0,5L Preta"), "Garrafa 500ml Preta");
  assert.equal(canonicalizeCapacity("Garrafa 0.5L Preta"), "Garrafa 500ml Preta");
});

test("canonicalizeCapacity: '1L' e '1 litro' convertem pra '1000ml'", () => {
  assert.equal(canonicalizeCapacity("Garrafa 1L Preta"), "Garrafa 1000ml Preta");
  assert.equal(canonicalizeCapacity("Garrafa 1 litro Preta"), "Garrafa 1000ml Preta");
});

test("canonicalizeCapacity: nunca mexe em litragem já no formato ml (nenhuma conversão dupla)", () => {
  assert.equal(canonicalizeCapacity("Copo Térmico Life 1180ml Gocase"), "Copo Térmico Life 1180ml Gocase");
});

test("canonicalizeCapacity: texto sem litragem nenhuma passa intacto", () => {
  assert.equal(canonicalizeCapacity("Bolsa Moove Preta"), "Bolsa Moove Preta");
});

test("splitModeloECor usa canonicalizeCapacity ANTES de procurar a cor — '1 litro' vira '1000ml' no modelo extraído", () => {
  const result = splitModeloECor("Copo Termico Life 1 litro Marrom", COLORS);
  assert.deepEqual(result, { modelo: "copo termico life 1000ml", cor: "Marrom" });
});

// ---------------------------------------------------------------------------
// matchLoadingOrderRow — prioridade determinística do vínculo da Ordem de
// Carregamento (SKU interno exato -> descrição -> produto como texto ->
// conflito = ambiguous). Catálogo Outlet sintético, 2 produtos/3 variantes,
// SEM nenhum produto 'normal' — bulk/aliasLists são passados diretos (nunca
// tocam Supabase), por isso roda como função pura em `node --test` puro.
// ---------------------------------------------------------------------------
const ALIAS_LISTS = { models: [], colors: COLORS };

function buildBulk() {
  const products = [
    { id: "pA", name: "Bolsa Fitness Puffer", normalized_name: "bolsa fitness puffer" },
    { id: "pB", name: "Bolsa Moove", normalized_name: "bolsa moove" },
  ];
  const variantsByProduct = new Map([
    [
      "pA",
      [
        { id: "v1", sku_code: "OUT-BFP-MARROM", color: "Marrom", normalized_color: "marrom", gtin: null },
        { id: "v2", sku_code: "OUT-BFP-PRETA", color: "Preta", normalized_color: "preta", gtin: null },
      ],
    ],
    ["pB", [{ id: "v3", sku_code: "OUT-BM-PRETA", color: "Preta", normalized_color: "preta", gtin: null }]],
  ]);
  return { products, variantsByProduct };
}

test("buildOutletSkuIndex indexa só os SKUs do catálogo Outlet já carregado (bulk), 1 entrada por sku_code", () => {
  const index = buildOutletSkuIndex(buildBulk());
  assert.deepEqual(index.get("OUT-BFP-MARROM"), [{ variantId: "v1", productId: "pA", skuCode: "OUT-BFP-MARROM", color: "Marrom" }]);
  assert.equal(index.get("SKU-QUE-NAO-EXISTE"), undefined);
});

test("matchLoadingOrderRow: PRIORIDADE 1 — SKU interno Outlet exato e único vincula direto", async () => {
  const bulk = buildBulk();
  const row = { produto: "OUT-BFP-MARROM", descricao: null, quantidade: 5 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "sku_exact");
  assert.equal(match.status, "matched");
  assert.equal(match.variant_id, "v1");
  assert.equal(match.qtd, 5);
});

test("matchLoadingOrderRow: SKU de um catálogo Normal (fora do bulk Outlet) NUNCA vincula — cai pra pendente", async () => {
  const bulk = buildBulk();
  // Simula o SKU interno de um produto Normal: nunca existe no bulk (que já
  // vem só de fetchBulkCatalogData("outlet")) nem tem texto reconhecível.
  const row = { produto: "NORMAL-SKU-999", descricao: null, quantidade: 1 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "unlinked");
  assert.equal(match.variant_id, null);
});

test("matchLoadingOrderRow: PRIORIDADE 2 — descrição identifica unicamente um Outlet quando produto é um código externo", async () => {
  const bulk = buildBulk();
  const row = { produto: "TX999-FORNECEDOR", descricao: "Bolsa Moove Preta", quantidade: 10 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "description_match");
  assert.equal(match.status, "matched");
  assert.equal(match.variant_id, "v3");
});

test("matchLoadingOrderRow: descrição ambígua (acha mais de um Outlet) nunca escolhe sozinho", async () => {
  const bulk = buildBulk();
  const row = { produto: "TX888-FORNECEDOR", descricao: "Bolsa Preta", quantidade: 2 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "ambiguous");
  assert.equal(match.status, "ambiguous");
  assert.equal(match.variant_id, null);
  assert.equal(match.candidates.length, 2);
});

test("matchLoadingOrderRow: produto externo + descrição sem correspondência fica pendente", async () => {
  const bulk = buildBulk();
  const row = { produto: "TX333-FORNECEDOR", descricao: "Produto Que Nao Existe No Catalogo XYZ", quantidade: 1 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "unlinked");
  assert.equal(match.variant_id, null);
});

test("matchLoadingOrderRow: PRIORIDADE 1+2 confirmando — SKU exato e descrição apontam pra mesma variante vincula", async () => {
  const bulk = buildBulk();
  const row = { produto: "OUT-BFP-MARROM", descricao: "Bolsa Fitness Puffer Marrom", quantidade: 3 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "sku_exact");
  assert.equal(match.variant_id, "v1");
});

test("matchLoadingOrderRow: REGRA DE CONFLITO — SKU exato e descrição apontam pra variantes diferentes vira ambiguous (nunca escolhe sozinho)", async () => {
  const bulk = buildBulk();
  const row = { produto: "OUT-BFP-MARROM", descricao: "Bolsa Moove Preta", quantidade: 7 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "ambiguous");
  assert.equal(match.status, "ambiguous");
  assert.equal(match.variant_id, null);
  assert.equal(match.qtd, 7);
  const variantIds = match.candidates.map((c) => c.variant_id).sort();
  assert.deepEqual(variantIds, ["v1", "v3"]);
});

test("matchLoadingOrderRow: PRIORIDADE 3 — sem SKU exato e sem descrição útil, usa o produto como texto livre (fallback)", async () => {
  const bulk = buildBulk();
  const row = { produto: "Bolsa Moove Preta", descricao: null, quantidade: 4 };
  const { match, source } = await matchLoadingOrderRow(row, bulk, ALIAS_LISTS);
  assert.equal(source, "produto_text_match");
  assert.equal(match.variant_id, "v3");
});
