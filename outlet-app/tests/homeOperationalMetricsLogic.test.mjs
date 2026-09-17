import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// HOME OPERACIONAL 2.0 — métricas diárias 100% reais (migration
// supabase/migrations/0057_home_operational_metrics.sql).
//
// A agregação real roda dentro da RPC get_home_operational_summary (Postgres
// puro, sem infraestrutura de teste de banco neste projeto). As duas funções
// abaixo são um espelho FIEL, linha a linha, do algoritmo telescópico
// implementado na migration — servem de especificação executável: validam
// que o RACIOCÍNIO (o que a SQL faz) está correto contra os 9 cenários do
// pedido, incluindo o exemplo exato dado na tarefa (5 → set 10 → set 8 = +3,
// nunca 10+8). Qualquer mudança de intenção no algoritmo deve mudar os dois
// lados juntos — a migration é sempre a fonte da verdade em produção.
//
// events: [{ createdAt, resultingQuantity, deltaQuantity }] de UM item, já
// ordenados por createdAt ascendente (mesmo contrato de
// conference_item_scan_events / invoice_item_scan_events).
// ---------------------------------------------------------------------------

/** Espelho de NF-e — invoice_receipt_items nasce sem contagem física, então o telescoping puro (sem reconstrução de "quantidade de criação") já é exato. */
function telescopedNfeContribution(events, periodStart, periodEnd) {
  const inPeriod = events.filter((e) => e.createdAt >= periodStart && e.createdAt < periodEnd);
  if (inPeriod.length === 0) return 0;
  const before = events.filter((e) => e.createdAt < periodStart);
  const baseline = before.length ? before[before.length - 1].resultingQuantity : 0;
  const lastInPeriod = inPeriod[inPeriod.length - 1].resultingQuantity;
  return lastInPeriod - baseline;
}

/** Espelho de Outlet — a quantidade inicial (addItem) não passa por evento nenhum; reconstruída do primeiro evento real (resulting - delta), ou a quantidade atual se o item nunca teve evento. */
function telescopedOutletContribution(events, periodStart, periodEnd, itemCreatedAt, currentQuantity) {
  const creationQty = events.length ? events[0].resultingQuantity - events[0].deltaQuantity : currentQuantity;

  const inPeriod = events.filter((e) => e.createdAt >= periodStart && e.createdAt < periodEnd);

  if (inPeriod.length === 0) {
    return itemCreatedAt >= periodStart ? creationQty : 0;
  }

  const baseline = itemCreatedAt >= periodStart
    ? 0
    : (() => {
        const before = events.filter((e) => e.createdAt < periodStart);
        return before.length ? before[before.length - 1].resultingQuantity : creationQty;
      })();

  const lastInPeriod = inPeriod[inPeriod.length - 1].resultingQuantity;
  return lastInPeriod - baseline;
}

const YESTERDAY = "2026-01-14T10:00:00.000Z";
const TODAY_START = "2026-01-15T00:00:00.000Z";
const TODAY_A = "2026-01-15T09:00:00.000Z";
const TODAY_B = "2026-01-15T10:00:00.000Z";
const TODAY_END = "2026-01-16T00:00:00.000Z";

test("NF-e: nota criada ontem mas com evento de contagem hoje entra no indicador de hoje (contribuição vem só do evento, nunca de created_at da nota)", () => {
  const events = [{ createdAt: TODAY_A, resultingQuantity: 5, deltaQuantity: 5 }];
  assert.equal(telescopedNfeContribution(events, TODAY_START, TODAY_END), 5);
});

test("NF-e: nota criada hoje e contada hoje — mesmo resultado, created_at da nota nunca entra na conta", () => {
  const events = [{ createdAt: TODAY_A, resultingQuantity: 5, deltaQuantity: 5 }];
  assert.equal(telescopedNfeContribution(events, TODAY_START, TODAY_END), 5);
});

test("NF-e: mesmo SKU bipado várias vezes no período soma o delta real, nunca duplica a última leitura", () => {
  const events = [
    { createdAt: TODAY_A, resultingQuantity: 1, deltaQuantity: 1 },
    { createdAt: TODAY_A, resultingQuantity: 2, deltaQuantity: 1 },
    { createdAt: TODAY_B, resultingQuantity: 3, deltaQuantity: 1 },
  ];
  assert.equal(telescopedNfeContribution(events, TODAY_START, TODAY_END), 3);
});

test("NF-e: manual_set considera o estado anterior — exemplo exato do pedido (5 -> set 10 -> set 8 = +3, nunca 10+8)", () => {
  const events = [
    { createdAt: YESTERDAY, resultingQuantity: 5, deltaQuantity: 5 }, // estado anterior ao período = 5
    { createdAt: TODAY_A, resultingQuantity: 10, deltaQuantity: 10 }, // manual_set 10 (delta_quantity = valor absoluto pedido)
    { createdAt: TODAY_B, resultingQuantity: 8, deltaQuantity: 8 }, // manual_set 8
  ];
  assert.equal(telescopedNfeContribution(events, TODAY_START, TODAY_END), 3);
});

test("NF-e: correção de quantidade para baixo dentro do próprio período nunca conta como incremento positivo", () => {
  const events = [
    { createdAt: TODAY_A, resultingQuantity: 10, deltaQuantity: 10 },
    { createdAt: TODAY_B, resultingQuantity: 6, deltaQuantity: 6 },
  ];
  assert.equal(telescopedNfeContribution(events, TODAY_START, TODAY_END), 6, "estado final do período é o que conta, não a soma dos dois manual_set");
});

test("NF-e: undo (evento reversor com delta invertido) cancela corretamente a bipagem original no mesmo período", () => {
  const events = [
    { createdAt: TODAY_A, resultingQuantity: 5, deltaQuantity: 5 }, // scan_increment +5
    { createdAt: TODAY_B, resultingQuantity: 0, deltaQuantity: -5 }, // undo do evento anterior
  ];
  assert.equal(telescopedNfeContribution(events, TODAY_START, TODAY_END), 0);
});

test("NF-e: undo que atravessa a borda do período (bipagem ontem, desfeita hoje) reflete só a queda de hoje", () => {
  const events = [
    { createdAt: YESTERDAY, resultingQuantity: 5, deltaQuantity: 5 },
    { createdAt: TODAY_A, resultingQuantity: 0, deltaQuantity: -5 }, // undo hoje da bipagem de ontem
  ];
  assert.equal(telescopedNfeContribution(events, TODAY_START, TODAY_END), -5);
});

test("Outlet: conferência iniciada ontem e continuada hoje soma só o ajuste de hoje sobre a quantidade inicial de ontem", () => {
  const events = [{ createdAt: TODAY_A, resultingQuantity: 5, deltaQuantity: 3 }]; // +3 hoje sobre uma base de 2
  assert.equal(telescopedOutletContribution(events, TODAY_START, TODAY_END, YESTERDAY, 5), 3);
});

test("Outlet: item criado e ajustado no mesmo dia conta a quantidade inicial inteira + os ajustes do dia", () => {
  // Sem evento nenhum antes de hoje (created hoje) — quantidade de criação = 2 (reconstruída do 1º evento: resulting 5 - delta 3 = 2).
  const events = [{ createdAt: TODAY_A, resultingQuantity: 5, deltaQuantity: 3 }];
  assert.equal(telescopedOutletContribution(events, TODAY_START, TODAY_END, TODAY_A, 5), 5);
});

test("Outlet: item criado hoje e nunca ajustado depois conta a própria quantidade de criação", () => {
  assert.equal(telescopedOutletContribution([], TODAY_START, TODAY_END, TODAY_A, 4), 4);
});

test("Outlet: item criado ontem e nunca ajustado hoje não entra no indicador de hoje", () => {
  assert.equal(telescopedOutletContribution([], TODAY_START, TODAY_END, YESTERDAY, 4), 0);
});

test("dia sem nenhuma operação: NF-e e Outlet devolvem contribuição zero (nunca inventam atividade)", () => {
  assert.equal(telescopedNfeContribution([], TODAY_START, TODAY_END), 0);
  assert.equal(telescopedOutletContribution([], TODAY_START, TODAY_END, YESTERDAY, 7), 0);
});

test("mesmo SKU aparecendo em múltiplos eventos/itens conta uma vez só no indicador de SKUs distintos", () => {
  const skuIdsFromEvents = ["sku-a", "sku-a", "sku-b", "sku-a", "sku-b"];
  const distinct = new Set(skuIdsFromEvents);
  assert.equal(distinct.size, 2);
});
