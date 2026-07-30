import test from "node:test";
import assert from "node:assert/strict";
import { isEligibleForStock, summarizeReturnItemsForBatchPreview, isRapidDuplicateScan } from "../src/client/returnsMatching.ts";

test("isEligibleForStock: vendavel + nota nao pendente + nao pendente de EAN libera estoque", () => {
  assert.equal(isEligibleForStock({ classification: "vendavel", quantity: 1, invoice_situation: "nao_se_aplica", is_pending: false }), true);
  assert.equal(isEligibleForStock({ classification: "vendavel", quantity: 1, invoice_situation: "cancelada", is_pending: false }), true);
});

test("isEligibleForStock: nota pendente de cancelamento NUNCA libera, mesmo sendo vendavel", () => {
  assert.equal(isEligibleForStock({ classification: "vendavel", quantity: 1, invoice_situation: "pendente_cancelamento", is_pending: false }), false);
});

test("isEligibleForStock: avariado/divergente/pacote_vazio/aguardando_analise nunca liberam", () => {
  for (const classification of ["avariado", "divergente", "pacote_vazio", "aguardando_analise"]) {
    assert.equal(isEligibleForStock({ classification, quantity: 1, invoice_situation: "nao_se_aplica", is_pending: false }), false);
  }
});

test("isEligibleForStock: item pendente (EAN nao localizado) nunca libera, mesmo marcado vendavel", () => {
  assert.equal(isEligibleForStock({ classification: "vendavel", quantity: 1, invoice_situation: "nao_se_aplica", is_pending: true }), false);
});

test("summarizeReturnItemsForBatchPreview: soma por categoria, nunca soma liquida", () => {
  const items = [
    { classification: "vendavel", quantity: 5, invoice_situation: "nao_se_aplica", is_pending: false },
    { classification: "avariado", quantity: 2, invoice_situation: "nao_se_aplica", is_pending: false },
    { classification: "divergente", quantity: 1, invoice_situation: "nao_se_aplica", is_pending: false },
    { classification: "pacote_vazio", quantity: 1, invoice_situation: "nao_se_aplica", is_pending: false },
    { classification: "aguardando_analise", quantity: 3, invoice_situation: "nao_se_aplica", is_pending: false },
  ];
  const summary = summarizeReturnItemsForBatchPreview(items);
  assert.equal(summary.totalItems, 5);
  assert.equal(summary.totalUnits, 12);
  assert.equal(summary.vendavelUnits, 5);
  assert.equal(summary.avariadoUnits, 2);
  assert.equal(summary.divergenteUnits, 1);
  assert.equal(summary.pacoteVazioUnits, 1);
  assert.equal(summary.aguardandoAnaliseUnits, 3);
  assert.equal(summary.releasedToStockUnits, 5);
  assert.equal(summary.blockedByPendingInvoiceUnits, 0);
  assert.equal(summary.pendingUnits, 0);
});

test("summarizeReturnItemsForBatchPreview: vendavel com nota pendente de cancelamento fica bloqueado, nao liberado", () => {
  const items = [{ classification: "vendavel", quantity: 4, invoice_situation: "pendente_cancelamento", is_pending: false }];
  const summary = summarizeReturnItemsForBatchPreview(items);
  assert.equal(summary.vendavelUnits, 4);
  assert.equal(summary.blockedByPendingInvoiceUnits, 4);
  assert.equal(summary.releasedToStockUnits, 0);
});

test("summarizeReturnItemsForBatchPreview: item pendente (EAN nao localizado) conta em pendingUnits e nunca em releasedToStockUnits", () => {
  const items = [{ classification: "aguardando_analise", quantity: 2, invoice_situation: "nao_se_aplica", is_pending: true }];
  const summary = summarizeReturnItemsForBatchPreview(items);
  assert.equal(summary.pendingUnits, 2);
  assert.equal(summary.releasedToStockUnits, 0);
});

test("summarizeReturnItemsForBatchPreview: lista vazia nunca quebra (todos os totais zerados)", () => {
  const summary = summarizeReturnItemsForBatchPreview([]);
  assert.equal(summary.totalItems, 0);
  assert.equal(summary.totalUnits, 0);
  assert.equal(summary.releasedToStockUnits, 0);
});

test("isRapidDuplicateScan: mesmo codigo dentro da janela curta é ignorado (ruido do leitor)", () => {
  const last = { code: "7891234567890", atMs: 1000 };
  assert.equal(isRapidDuplicateScan("7891234567890", last, 1100), true);
});

test("isRapidDuplicateScan: mesmo codigo APOS a janela é uma bipagem intencional, nunca ignorada", () => {
  const last = { code: "7891234567890", atMs: 1000 };
  assert.equal(isRapidDuplicateScan("7891234567890", last, 1500), false);
});

test("isRapidDuplicateScan: codigos diferentes nunca sao tratados como duplicados", () => {
  const last = { code: "7891234567890", atMs: 1000 };
  assert.equal(isRapidDuplicateScan("0000000000000", last, 1050), false);
});

test("isRapidDuplicateScan: sem bipagem anterior, nunca é duplicado", () => {
  assert.equal(isRapidDuplicateScan("7891234567890", null, 1000), false);
});
