import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// FASE 5 — Indicadores Operacionais (migration
// supabase/migrations/0059_operational_indicators.sql, RPC
// get_operational_indicators).
//
// A agregação real roda em SQL puro (sem infraestrutura de teste de Postgres
// neste projeto). As funções abaixo são um espelho FIEL, linha a linha, da
// lógica implementada na migration — mesmo critério de inclusão (Outlet:
// status=completed + finished_at no período; NF-e: status IN
// (completed,with_divergences) + finished_at no período), mesma definição de
// "item efetivamente conferido" (physical_quantity IS NOT NULL — idêntica à
// de summarizeReceipt/computeItemStatus, Fase 4), mesma conformidade
// PONDERADA pelos itens (nunca média das porcentagens por NF). Mesmo padrão
// de "espelho executável" já usado em homeOperationalMetricsLogic.test.mjs e
// receiptAttentionLogic.test.mjs — a migration continua sendo a fonte da
// verdade em produção.
// ---------------------------------------------------------------------------

function inRange(iso, start, end) {
  return iso !== null && iso !== undefined && iso >= start && iso < end;
}

/** Espelho do bloco OUTLET da RPC. */
function aggregateOutlet(conferences, { start, end, responsibleId }) {
  const included = conferences.filter(
    (c) => c.status === "completed" && inRange(c.finishedAt, start, end) && (!responsibleId || c.operatorId === responsibleId)
  );
  const count = included.length;
  const skus = included.reduce((a, c) => a + c.totalSkus, 0);
  const units = included.reduce((a, c) => a + c.totalUnits, 0);
  return {
    conferences: count,
    skus,
    units,
    avgSkus: count > 0 ? Math.round((skus / count) * 10) / 10 : 0,
    avgUnits: count > 0 ? Math.round((units / count) * 10) / 10 : 0,
  };
}

/** Espelho do bloco NF-e da RPC — "conferido" = physical_quantity não nulo (unlinked/pending nunca têm físico contado). */
function computeCountedStatus(expected, physical) {
  if (physical === null || physical === undefined) return "pending";
  if (physical === expected) return "ok";
  return physical < expected ? "missing" : "surplus";
}

function aggregateNfe(receipts, { start, end, responsibleId }) {
  const included = receipts.filter(
    (r) => (r.status === "completed" || r.status === "with_divergences") && inRange(r.finishedAt, start, end) && (!responsibleId || r.createdBy === responsibleId)
  );
  let ok = 0;
  let missing = 0;
  let surplus = 0;
  let physicalUnits = 0;
  let countedSkus = 0;
  let divergenceReceipts = 0;
  for (const r of included) {
    if (r.status === "with_divergences") divergenceReceipts++;
    for (const item of r.items) {
      const status = computeCountedStatus(item.expected, item.physical);
      if (status === "pending") continue;
      countedSkus++;
      physicalUnits += item.physical;
      if (status === "ok") ok++;
      else if (status === "missing") missing++;
      else surplus++;
    }
  }
  const counted = ok + missing + surplus;
  return {
    receipts: included.length,
    countedSkus,
    physicalUnits,
    okItems: ok,
    missingItems: missing,
    surplusItems: surplus,
    divergenceReceipts,
    conformityRate: counted > 0 ? ok / counted : null,
  };
}

/** Espelho da série diária — um bucket por dia local, incluindo dias zerados. */
function dailySeries(conferences, receipts, { days, responsibleId }) {
  return days.map((day) => {
    const outletAgg = aggregateOutlet(conferences, { start: day.start, end: day.end, responsibleId });
    const nfeAgg = aggregateNfe(receipts, { start: day.start, end: day.end, responsibleId });
    return {
      date: day.date,
      outletConferences: outletAgg.conferences,
      nfeReceipts: nfeAgg.receipts,
      skus: outletAgg.skus + nfeAgg.countedSkus,
      units: outletAgg.units + nfeAgg.physicalUnits,
      divergenceReceipts: nfeAgg.divergenceReceipts,
    };
  });
}

const START = "2026-09-01T00:00:00.000Z";
const END = "2026-09-08T00:00:00.000Z"; // [start, end) — 7 dias

// ---------------------------------------------------------------------------
// OUTLET
// ---------------------------------------------------------------------------
test("aggregateOutlet: nenhuma conferência -> tudo zero, sem NaN/Infinity", () => {
  const r = aggregateOutlet([], { start: START, end: END });
  assert.deepEqual(r, { conferences: 0, skus: 0, units: 0, avgSkus: 0, avgUnits: 0 });
});

test("aggregateOutlet: 1 conferência completed no período", () => {
  const conferences = [{ status: "completed", finishedAt: "2026-09-03T10:00:00.000Z", operatorId: "op1", totalSkus: 10, totalUnits: 40 }];
  const r = aggregateOutlet(conferences, { start: START, end: END });
  assert.deepEqual(r, { conferences: 1, skus: 10, units: 40, avgSkus: 10, avgUnits: 40 });
});

test("aggregateOutlet: draft/in_progress/cancelled são excluídas; completed é incluída", () => {
  const conferences = [
    { status: "draft", finishedAt: null, operatorId: "op1", totalSkus: 5, totalUnits: 5 },
    { status: "in_progress", finishedAt: null, operatorId: "op1", totalSkus: 5, totalUnits: 5 },
    { status: "cancelled", finishedAt: "2026-09-03T10:00:00.000Z", operatorId: "op1", totalSkus: 5, totalUnits: 5 },
    { status: "completed", finishedAt: "2026-09-03T10:00:00.000Z", operatorId: "op1", totalSkus: 20, totalUnits: 100 },
  ];
  const r = aggregateOutlet(conferences, { start: START, end: END });
  assert.equal(r.conferences, 1);
  assert.equal(r.skus, 20);
  assert.equal(r.units, 100);
});

test("aggregateOutlet: finished_at fora do período é excluída", () => {
  const conferences = [{ status: "completed", finishedAt: "2026-08-15T10:00:00.000Z", operatorId: "op1", totalSkus: 10, totalUnits: 40 }];
  const r = aggregateOutlet(conferences, { start: START, end: END });
  assert.equal(r.conferences, 0);
});

test("aggregateOutlet: múltiplas conferências -> soma de SKUs/unidades e médias corretas", () => {
  const conferences = [
    { status: "completed", finishedAt: "2026-09-02T10:00:00.000Z", operatorId: "op1", totalSkus: 10, totalUnits: 40 },
    { status: "completed", finishedAt: "2026-09-05T10:00:00.000Z", operatorId: "op2", totalSkus: 20, totalUnits: 60 },
  ];
  const r = aggregateOutlet(conferences, { start: START, end: END });
  assert.equal(r.conferences, 2);
  assert.equal(r.skus, 30);
  assert.equal(r.units, 100);
  assert.equal(r.avgSkus, 15);
  assert.equal(r.avgUnits, 50);
});

test("aggregateOutlet: filtro por responsável (operator_id)", () => {
  const conferences = [
    { status: "completed", finishedAt: "2026-09-02T10:00:00.000Z", operatorId: "op1", totalSkus: 10, totalUnits: 40 },
    { status: "completed", finishedAt: "2026-09-05T10:00:00.000Z", operatorId: "op2", totalSkus: 20, totalUnits: 60 },
  ];
  const r = aggregateOutlet(conferences, { start: START, end: END, responsibleId: "op2" });
  assert.equal(r.conferences, 1);
  assert.equal(r.skus, 20);
});

// ---------------------------------------------------------------------------
// NF-e
// ---------------------------------------------------------------------------
test("aggregateNfe: completed e with_divergences incluídas; not_started/in_progress excluídas", () => {
  const receipts = [
    { status: "not_started", finishedAt: null, createdBy: "op1", items: [] },
    { status: "in_progress", finishedAt: null, createdBy: "op1", items: [] },
    { status: "completed", finishedAt: "2026-09-03T10:00:00.000Z", createdBy: "op1", items: [{ expected: 5, physical: 5 }] },
    { status: "with_divergences", finishedAt: "2026-09-04T10:00:00.000Z", createdBy: "op1", items: [{ expected: 5, physical: 3 }] },
  ];
  const r = aggregateNfe(receipts, { start: START, end: END });
  assert.equal(r.receipts, 2);
  assert.equal(r.divergenceReceipts, 1);
});

test("aggregateNfe: finished_at fora do período é excluída", () => {
  const receipts = [{ status: "completed", finishedAt: "2026-08-15T10:00:00.000Z", createdBy: "op1", items: [{ expected: 5, physical: 5 }] }];
  const r = aggregateNfe(receipts, { start: START, end: END });
  assert.equal(r.receipts, 0);
  assert.equal(r.countedSkus, 0);
});

test("aggregateNfe: pending e unlinked (physical null) NUNCA contam como conferido", () => {
  const receipts = [
    {
      status: "completed",
      finishedAt: "2026-09-03T10:00:00.000Z",
      createdBy: "op1",
      items: [
        { expected: 5, physical: 5 }, // ok
        { expected: 3, physical: null }, // pending — nunca conferido
        { expected: 2, physical: null }, // unlinked — physical sempre null, mesmo tratamento de pending
      ],
    },
  ];
  const r = aggregateNfe(receipts, { start: START, end: END });
  assert.equal(r.countedSkus, 1);
  assert.equal(r.okItems, 1);
  assert.equal(r.physicalUnits, 5);
});

test("aggregateNfe: ok/missing/surplus classificados corretamente e físico somado só dos conferidos", () => {
  const receipts = [
    {
      status: "completed",
      finishedAt: "2026-09-03T10:00:00.000Z",
      createdBy: "op1",
      items: [
        { expected: 5, physical: 5 }, // ok
        { expected: 5, physical: 3 }, // missing
        { expected: 5, physical: 8 }, // surplus
      ],
    },
  ];
  const r = aggregateNfe(receipts, { start: START, end: END });
  assert.equal(r.okItems, 1);
  assert.equal(r.missingItems, 1);
  assert.equal(r.surplusItems, 1);
  assert.equal(r.physicalUnits, 16);
});

test("aggregateNfe: filtro por responsável (created_by) — nunca finished_by", () => {
  const receipts = [
    { status: "completed", finishedAt: "2026-09-03T10:00:00.000Z", createdBy: "op1", items: [{ expected: 5, physical: 5 }] },
    { status: "completed", finishedAt: "2026-09-04T10:00:00.000Z", createdBy: "op2", items: [{ expected: 5, physical: 5 }] },
  ];
  const r = aggregateNfe(receipts, { start: START, end: END, responsibleId: "op1" });
  assert.equal(r.receipts, 1);
  assert.equal(r.okItems, 1);
});

test("aggregateNfe: nenhum item conferido -> conformidade null (nunca NaN)", () => {
  const receipts = [{ status: "completed", finishedAt: "2026-09-03T10:00:00.000Z", createdBy: "op1", items: [{ expected: 5, physical: null }] }];
  const r = aggregateNfe(receipts, { start: START, end: END });
  assert.equal(r.conformityRate, null);
});

// ---------------------------------------------------------------------------
// TESTE CRÍTICO — conformidade PONDERADA pelos itens, nunca média das médias
// (item 44 do pedido).
// ---------------------------------------------------------------------------
test("aggregateNfe: conformidade é ponderada pelos itens, nunca a média simples das porcentagens por NF", () => {
  const receipts = [
    {
      status: "completed",
      finishedAt: "2026-09-03T10:00:00.000Z",
      createdBy: "op1",
      items: [
        { expected: 5, physical: 5 }, // ok
        { expected: 5, physical: 3 }, // missing
      ],
    },
    {
      status: "completed",
      finishedAt: "2026-09-04T10:00:00.000Z",
      createdBy: "op1",
      items: Array.from({ length: 98 }, () => ({ expected: 1, physical: 1 })).concat([
        { expected: 1, physical: 0 },
        { expected: 1, physical: 0 },
      ]),
    },
  ];
  const r = aggregateNfe(receipts, { start: START, end: END });
  assert.equal(r.okItems, 99);
  assert.equal(r.okItems + r.missingItems + r.surplusItems, 102);
  assert.equal(r.conformityRate, 99 / 102);
  // NUNCA (50% + 98%) / 2 = 74%.
  assert.notEqual(Math.round(r.conformityRate * 100), 74);
});

// ---------------------------------------------------------------------------
// SÉRIE DIÁRIA
// ---------------------------------------------------------------------------
const DAYS = [
  { date: "2026-09-14", start: "2026-09-14T00:00:00.000Z", end: "2026-09-15T00:00:00.000Z" },
  { date: "2026-09-15", start: "2026-09-15T00:00:00.000Z", end: "2026-09-16T00:00:00.000Z" },
  { date: "2026-09-16", start: "2026-09-16T00:00:00.000Z", end: "2026-09-17T00:00:00.000Z" },
];

test("dailySeries: dia sem nenhuma operação aparece zerado (nunca omitido)", () => {
  const conferences = [{ status: "completed", finishedAt: "2026-09-14T10:00:00.000Z", operatorId: "op1", totalSkus: 5, totalUnits: 20 }];
  const receipts = [];
  const series = dailySeries(conferences, receipts, { days: DAYS });
  assert.equal(series.length, 3);
  assert.equal(series[0].outletConferences, 1);
  assert.deepEqual(series[1], { date: "2026-09-15", outletConferences: 0, nfeReceipts: 0, skus: 0, units: 0, divergenceReceipts: 0 });
});

test("dailySeries: Outlet e NF-e no mesmo dia somam no mesmo bucket", () => {
  const conferences = [{ status: "completed", finishedAt: "2026-09-16T08:00:00.000Z", operatorId: "op1", totalSkus: 5, totalUnits: 20 }];
  const receipts = [{ status: "completed", finishedAt: "2026-09-16T18:00:00.000Z", createdBy: "op1", items: [{ expected: 3, physical: 3 }] }];
  const series = dailySeries(conferences, receipts, { days: DAYS });
  const day16 = series.find((d) => d.date === "2026-09-16");
  assert.equal(day16.outletConferences, 1);
  assert.equal(day16.nfeReceipts, 1);
  assert.equal(day16.skus, 6); // 5 outlet + 1 SKU conferido da NF
  assert.equal(day16.units, 23); // 20 outlet + 3 físicos
});

test("dailySeries: dia com divergência reflete no bucket certo", () => {
  const receipts = [{ status: "with_divergences", finishedAt: "2026-09-15T12:00:00.000Z", createdBy: "op1", items: [{ expected: 5, physical: 3 }] }];
  const series = dailySeries([], receipts, { days: DAYS });
  assert.equal(series.find((d) => d.date === "2026-09-15").divergenceReceipts, 1);
  assert.equal(series.find((d) => d.date === "2026-09-14").divergenceReceipts, 0);
});

test("dailySeries: a soma diária reconcilia com o agregado do período inteiro", () => {
  const conferences = [
    { status: "completed", finishedAt: "2026-09-14T08:00:00.000Z", operatorId: "op1", totalSkus: 5, totalUnits: 20 },
    { status: "completed", finishedAt: "2026-09-16T08:00:00.000Z", operatorId: "op1", totalSkus: 7, totalUnits: 30 },
  ];
  const receipts = [{ status: "completed", finishedAt: "2026-09-15T08:00:00.000Z", createdBy: "op1", items: [{ expected: 4, physical: 4 }] }];

  const periodStart = "2026-09-14T00:00:00.000Z";
  const periodEnd = "2026-09-17T00:00:00.000Z";
  const overallOutlet = aggregateOutlet(conferences, { start: periodStart, end: periodEnd });
  const overallNfe = aggregateNfe(receipts, { start: periodStart, end: periodEnd });

  const series = dailySeries(conferences, receipts, { days: DAYS });
  const sumSkus = series.reduce((a, d) => a + d.skus, 0);
  const sumUnits = series.reduce((a, d) => a + d.units, 0);
  const sumOutlet = series.reduce((a, d) => a + d.outletConferences, 0);
  const sumNfe = series.reduce((a, d) => a + d.nfeReceipts, 0);

  assert.equal(sumSkus, overallOutlet.skus + overallNfe.countedSkus);
  assert.equal(sumUnits, overallOutlet.units + overallNfe.physicalUnits);
  assert.equal(sumOutlet, overallOutlet.conferences);
  assert.equal(sumNfe, overallNfe.receipts);
});
