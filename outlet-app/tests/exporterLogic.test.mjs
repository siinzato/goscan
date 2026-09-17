import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOutletSummaryRows,
  buildOutletItemsRows,
  buildNfeSummaryRows,
  buildNfeItemsRows,
  buildCentralAuditRows,
  buildCentralAuditFiltersRows,
  centralAuditFileName,
  buildIndicatorsSummaryRows,
  buildIndicatorsDailyRows,
} from "../src/client/exporter.ts";

// ---------------------------------------------------------------------------
// FASE 6 — item 54 do pedido: testar a construção das matrizes/dados ANTES
// do writeFile (a lib XLSX em si não é testada — sem infraestrutura/padrão
// pra isso neste projeto). Cada build* abaixo é uma função pura já usada
// pelas funções export*ToXlsx reais (mesmo código, não espelho).
// ---------------------------------------------------------------------------

// --- Outlet ---
const conference = {
  id: "a1b2c3d4-0000-0000-0000-000000000000",
  name: "Conferência Setor A",
  status: "completed",
  operator_name: "Victor Sinzato",
  started_at: "2026-09-16T10:00:00.000Z",
  finished_at: "2026-09-16T10:30:00.000Z",
  total_skus: 12,
  total_units: 48,
};
const outletItems = [
  { produto: "Bolsa Tote", raw_model: "TOTE01", raw_color: "Preto", sku_code: "SKU-1", product_variant_id: "variant-1", quantity: 3, match_status: "matched", source: "manual" },
  { produto: null, raw_model: "MOD-X", raw_color: "Azul", sku_code: null, product_variant_id: null, quantity: 2, match_status: "unresolved", source: "text" },
];

test("buildOutletSummaryRows: auditoria sem itens sem SKU -> contagem zero", () => {
  const rows = buildOutletSummaryRows(conference, [outletItems[0]]);
  const itensSemSku = rows.find((r) => r[0] === "Itens sem SKU");
  assert.equal(itensSemSku[1], 0);
});

test("buildOutletSummaryRows: conta itens sem product_variant_id como 'sem SKU', e traz os totais oficiais (não recalcula)", () => {
  const rows = buildOutletSummaryRows(conference, outletItems);
  const asObj = Object.fromEntries(rows);
  assert.equal(asObj["Protocolo"], "#A1B2C3D4");
  assert.equal(asObj["SKUs"], 12);
  assert.equal(asObj["Unidades"], 48);
  assert.equal(asObj["Itens sem SKU"], 1);
});

test("buildOutletItemsRows: nunca inventa falta/sobra/divergência — só as colunas do pedido", () => {
  const rows = buildOutletItemsRows(outletItems);
  assert.deepEqual(rows[0], ["Produto", "Modelo lido", "Cor", "SKU", "Quantidade", "Match status", "Origem"]);
  assert.equal(rows.length, 3); // header + 2 itens
  assert.ok(!rows[0].some((h) => /falta|sobra|diverg/i.test(String(h))));
});

// --- NF-e ---
const receipt = {
  invoice_number: "12320",
  series: "1",
  invoice_key: "31260936838707000119550050000123201000138821",
  supplier_name: "Fornecedor XYZ",
  supplier_cnpj: "12.345.678/0001-99",
  issued_at: "2026-09-01T00:00:00.000Z",
  created_by_name: "Victor Sinzato",
  started_at: "2026-09-15T09:00:00.000Z",
  finished_at: "2026-09-15T09:40:00.000Z",
  finished_by_name: "Victor Sinzato",
};
const nfeItems = [
  { expected_quantity: 5, physical_quantity: 5, status: "ok", linked_sku_code: "SKU-A", sku_code: null, linked_ean: "789", ean: null, description: "Item A" },
  { expected_quantity: 5, physical_quantity: 3, status: "missing", linked_sku_code: "SKU-B", sku_code: null, linked_ean: null, ean: null, description: "Item B" },
  { expected_quantity: 5, physical_quantity: null, status: "pending", linked_sku_code: "SKU-C", sku_code: null, linked_ean: null, ean: null, description: "Item C" },
];

test("buildNfeSummaryRows: SKUs conferidos usa ok+missing+surplus, nunca items.length (item corrigido na Fase 4, preservado aqui)", () => {
  const rows = buildNfeSummaryRows(receipt, nfeItems);
  const asObj = Object.fromEntries(rows);
  assert.equal(asObj["Total de SKUs"], 3);
  assert.equal(asObj["SKUs conferidos"], 2); // ok(1) + missing(1), pending não conta
  assert.equal(asObj["OK"], 1);
  assert.equal(asObj["Falta"], 1);
  assert.equal(asObj["Não conferidos"], 1);
  assert.equal(asObj["Série"], "1");
});

test("buildNfeSummaryRows: conformidade '—' quando nada foi conferido (nunca NaN/Infinity)", () => {
  const rows = buildNfeSummaryRows(receipt, [{ expected_quantity: 5, physical_quantity: null, status: "pending" }]);
  const asObj = Object.fromEntries(rows);
  assert.equal(asObj["Conformidade dos itens conferidos"], "—");
});

test("buildNfeItemsRows: preserva o snapshot linked_* como prioridade sobre o cadastro ao vivo", () => {
  const rows = buildNfeItemsRows(receipt, nfeItems);
  assert.equal(rows[1][3], "SKU-A"); // coluna SKU
  assert.equal(rows[1][4], "789"); // coluna EAN (linked_ean priorizado)
});

// --- Central de Auditoria ---
const auditEvents = [
  {
    id: "e1",
    module: "nfe",
    action: "scan_increment",
    actorName: "Victor",
    actorEmail: "victor@azbuy.com.br",
    occurredAt: "2026-09-16T14:32:00.000Z",
    operationLabel: "NF 45182",
    operationId: "nf-1",
    entityType: "invoice_receipts",
    entityId: "nf-1",
    itemId: "item-1",
    sku: "ABC123",
    ean: null,
    deltaQuantity: 1,
    resultingQuantity: 7,
    origin: "scanner",
    metadata: null,
  },
];

test("buildCentralAuditRows: auditoria sem registros -> só o cabeçalho", () => {
  const rows = buildCentralAuditRows([]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0][0], "Data/Hora");
});

test("buildCentralAuditRows: usa o rótulo humano na coluna 'Ação' e preserva a ação técnica numa coluna própria", () => {
  const rows = buildCentralAuditRows(auditEvents);
  assert.equal(rows[1][2], "Contagem por incremento");
  assert.equal(rows[1][3], "scan_increment");
});

test("buildCentralAuditRows: metadata já sanitizado (nunca reexpõe segredo) — evento sem metadata não gera lixo na coluna Detalhes", () => {
  const rows = buildCentralAuditRows(auditEvents);
  assert.equal(rows[1][rows[0].indexOf("Detalhes")].includes("REDACTED"), false);
});

test("buildCentralAuditRows: evento sanitizado com metadata mantém a marca [REDACTED] literal na planilha, nunca o valor original", () => {
  const withMeta = [{ ...auditEvents[0], metadata: { note: "ok", access_token: "[REDACTED]" } }];
  const rows = buildCentralAuditRows(withMeta);
  const detalhes = rows[1][rows[0].indexOf("Detalhes")];
  assert.match(detalhes, /\[REDACTED\]/);
  assert.doesNotMatch(detalhes, /abc123token/i);
});

test("buildCentralAuditFiltersRows: reflete os filtros exatamente como aplicados (não reformula)", () => {
  const filters = { search: "12320", module: "nfe", action: "scan_increment", actorId: "u1", dateFrom: "2026-09-01T00:00:00.000Z", dateTo: "2026-09-16T00:00:00.000Z" };
  const rows = buildCentralAuditFiltersRows(filters, "Victor Sinzato", "2026-09-16T18:00:00.000Z");
  const asObj = Object.fromEntries(rows);
  assert.equal(asObj["Módulo"], "Nota Fiscal");
  assert.equal(asObj["Pesquisa"], "12320");
  assert.equal(asObj["Usuário"], "Victor Sinzato");
});

test("centralAuditFileName: com período -> nome com as duas datas; sem período -> só a data de hoje; nunca inclui nome/e-mail", () => {
  const withRange = centralAuditFileName({ search: "", module: "all", action: "", actorId: "victor@azbuy.com.br", dateFrom: "2026-09-01T00:00:00.000Z", dateTo: "2026-09-16T00:00:00.000Z" });
  assert.equal(withRange, "goscan_auditoria_2026-09-01_a_2026-09-16.xlsx");
  assert.doesNotMatch(withRange, /victor/i);

  const withoutRange = centralAuditFileName({ search: "", module: "all", action: "", actorId: "", dateFrom: null, dateTo: null });
  assert.match(withoutRange, /^goscan_auditoria_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

// --- Indicadores (reconciliação — item 55 do pedido) ---
const indicatorsData = {
  summary: { completedOperations: 18, outletConferences: 7, nfeReceipts: 11, nfeWithDivergences: 3 },
  outlet: { conferences: 7, skus: 245, units: 1180, avgSkus: 35, avgUnits: 168.6 },
  nfe: { receipts: 11, countedSkus: 312, physicalUnits: 1426, okItems: 300, missingItems: 10, surplusItems: 2, divergenceReceipts: 3, conformityRate: 0.9615 },
  daily: [
    { date: "2026-09-15", outletConferences: 0, nfeReceipts: 0, skus: 0, units: 0, divergenceReceipts: 0 },
    { date: "2026-09-16", outletConferences: 2, nfeReceipts: 4, skus: 120, units: 540, divergenceReceipts: 1 },
  ],
};

test("buildIndicatorsSummaryRows: usa EXATAMENTE os números do objeto retornado pela RPC — nunca recalcula", () => {
  const rows = buildIndicatorsSummaryRows(indicatorsData, "Últimos 7 dias", "Todos");
  const asObj = Object.fromEntries(rows);
  assert.equal(asObj["Operações concluídas"], indicatorsData.summary.completedOperations);
  assert.equal(asObj["SKUs Outlet"], indicatorsData.outlet.skus);
  assert.equal(asObj["Unidades físicas NF-e"], indicatorsData.nfe.physicalUnits);
  assert.equal(asObj["Conformidade dos itens conferidos"], "96.15%");
});

test("buildIndicatorsDailyRows: dias zerados aparecem no Excel (nunca omitidos) e os valores batem 1:1 com o daily[]", () => {
  const rows = buildIndicatorsDailyRows(indicatorsData);
  assert.equal(rows.length, 3); // header + 2 dias
  assert.deepEqual(rows[1], ["2026-09-15", 0, 0, 0, 0, 0]);
  assert.deepEqual(rows[2], ["2026-09-16", 2, 4, 120, 540, 1]);
});

test("reconciliação: os valores da aba 'Volume diário' são os mesmos objetos de data.daily, nunca uma segunda consulta/recálculo", () => {
  const dailyRows = buildIndicatorsDailyRows(indicatorsData).slice(1);
  dailyRows.forEach((row, i) => {
    const d = indicatorsData.daily[i];
    assert.deepEqual(row, [d.date, d.outletConferences, d.nfeReceipts, d.skus, d.units, d.divergenceReceipts]);
  });
});
