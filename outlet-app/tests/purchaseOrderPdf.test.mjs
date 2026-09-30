import test from "node:test";
import assert from "node:assert/strict";
import { parsePurchaseOrderItemsFromText, parsePurchaseOrderMetadataFromText } from "../src/server/purchaseOrderPdf.ts";

// Texto igual ao que o pdf-parse realmente devolve pra uma ordem de compra
// real (cabeçalho da empresa, tabela quebrada em 3 linhas pelo extrator,
// marcador de quebra de página "-- N of M --", seção de totais no fim) —
// achado testando contra o PDF de exemplo enviado pelo usuário.
const SAMPLE_TEXT = `Azbuy Comercio LTDA
10.256.416/0001-29
(11) 98086-8047
Rua Maria de Jesus, 9
Chácara Califórnia, São Paulo - SP
03317-050
148241764110
Ordem de Compra Nº 480
Fornecedor
Rearth 	Número do pedido 480
Data 	10/09/2026
Data prevista 	28/09/2026
Itens da compra
Item GTIN / Cod.
Fornecedor Qtde Un Valor IPI
% Total
Capa Ringke Fusion Compatível com iPhone 18
Pro Max - Transparente
SKU: CCRKM1IP18PM-8
8800380461505 	450,00 PC 0,0000000000 0,00 0,00
Capa Ringke Fusion X Compatível com iPhone 18
Pro Max - Preto
SKU: CCRKM2IP18PM-1
8800380461680 	100,00 PC 0,0000000000 0,00 0,00

-- 1 of 2 --

Kit Película de Vidro Ringke EASY SLIDE Para
iPhone 17 Pro Max
SKU: PVRKM28IP17PM
8800328810709 	100,00 PC 28,5017071350 0,00 2.850,17

Total de produtos
Total do IPI
Total do pedido
36.389,60
0,00
36.389,60
Observações
`;

test("parsePurchaseOrderItemsFromText extrai os itens da tabela real", () => {
  const items = parsePurchaseOrderItemsFromText(SAMPLE_TEXT);
  assert.equal(items.length, 3);
});

test("parsePurchaseOrderItemsFromText nunca deixa o cabeçalho da tabela grudar na descrição do 1º item", () => {
  const items = parsePurchaseOrderItemsFromText(SAMPLE_TEXT);
  assert.equal(items[0].Descrição, "Capa Ringke Fusion Compatível com iPhone 18 Pro Max - Transparente");
});

test("parsePurchaseOrderItemsFromText lê GTIN, SKU e quantidade (vírgula decimal) corretamente", () => {
  const items = parsePurchaseOrderItemsFromText(SAMPLE_TEXT);
  assert.deepEqual(items[1], { GTIN: "8800380461680", SKU: "CCRKM2IP18PM-1", "Descrição": "Capa Ringke Fusion X Compatível com iPhone 18 Pro Max - Preto", Quantidade: 100 });
});

test("parsePurchaseOrderItemsFromText ignora o marcador de quebra de página", () => {
  const items = parsePurchaseOrderItemsFromText(SAMPLE_TEXT);
  assert.ok(items.every((i) => !i.Descrição?.includes("of 2")));
});

test("parsePurchaseOrderItemsFromText para na seção de totais, nunca inventa um item ali", () => {
  const items = parsePurchaseOrderItemsFromText(SAMPLE_TEXT);
  assert.ok(items.every((i) => i.SKU !== null && !i.Descrição?.includes("Total")));
});

test("parsePurchaseOrderItemsFromText ignora tudo antes de 'Itens da compra' (cabeçalho da empresa)", () => {
  const items = parsePurchaseOrderItemsFromText(SAMPLE_TEXT);
  assert.ok(items.every((i) => !i.Descrição?.includes("Azbuy")));
});

test("parsePurchaseOrderItemsFromText devolve vazio pra texto sem a seção 'Itens da compra'", () => {
  const items = parsePurchaseOrderItemsFromText("Documento qualquer sem tabela nenhuma.");
  assert.deepEqual(items, []);
});

test("parsePurchaseOrderMetadataFromText extrai nº do pedido, fornecedor e datas do cabeçalho", () => {
  const metadata = parsePurchaseOrderMetadataFromText(SAMPLE_TEXT);
  assert.deepEqual(metadata, {
    orderNumber: "480",
    supplierName: "Rearth",
    orderDate: "2026-09-10",
    expectedDate: "2026-09-28",
  });
});

test("parsePurchaseOrderMetadataFromText devolve tudo nulo pra texto sem cabeçalho reconhecido", () => {
  const metadata = parsePurchaseOrderMetadataFromText("Documento qualquer sem cabeçalho nenhum.\nItens da compra\n");
  assert.deepEqual(metadata, { orderNumber: null, supplierName: null, orderDate: null, expectedDate: null });
});
