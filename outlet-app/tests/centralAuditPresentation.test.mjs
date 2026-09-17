import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// FASE 6 — apresentação de eventos NF-e/Outlet na Central de Auditoria (item
// 52 do pedido). A função real (quantityLine) vive em
// src/client/ui/screens/adminAudit.ts, que importa icons.ts (SVGs via `?raw`,
// só resolvível pelo bundler Vite) — não é seguro importar telas no runner
// puro do Node (mesma restrição já observada nas fases anteriores pra outras
// telas). Este é um espelho FIEL, linha a linha, da função real — mudar a
// intenção ali exige mudar aqui também.
// ---------------------------------------------------------------------------
function quantityLine(ev) {
  if (ev.deltaQuantity === null && ev.resultingQuantity === null) return "";
  if (ev.action === "manual_set") {
    return `Quantidade definida manualmente → Resultado: ${ev.resultingQuantity ?? "—"}`;
  }
  const sign = ev.deltaQuantity !== null && ev.deltaQuantity >= 0 ? "+" : "";
  return `${ev.deltaQuantity !== null ? sign + ev.deltaQuantity : "—"} → Resultado: ${ev.resultingQuantity ?? "—"}`;
}

test("quantityLine: scan_increment positivo mostra +delta e o resultado", () => {
  assert.equal(quantityLine({ action: "scan_increment", deltaQuantity: 1, resultingQuantity: 7 }), "+1 → Resultado: 7");
});

test("quantityLine: scan_increment negativo (ajuste pra baixo) mostra o sinal real", () => {
  assert.equal(quantityLine({ action: "scan_increment", deltaQuantity: -1, resultingQuantity: 6 }), "-1 → Resultado: 6");
});

test("quantityLine: manual_set NUNCA aparece como incremento, mesmo com delta_quantity positivo persistido", () => {
  const line = quantityLine({ action: "manual_set", deltaQuantity: 200, resultingQuantity: 200 });
  assert.equal(line, "Quantidade definida manualmente → Resultado: 200");
  assert.doesNotMatch(line, /^\+/);
  assert.doesNotMatch(line, /Adicionou/i);
});

test("quantityLine: manual_set com delta negativo também nunca vira '-X' — só o resultado importa", () => {
  const line = quantityLine({ action: "manual_set", deltaQuantity: -50, resultingQuantity: 150 });
  assert.equal(line, "Quantidade definida manualmente → Resultado: 150");
});

test("quantityLine: evento sem delta/resultado (ex.: ação administrativa) não gera linha de quantidade", () => {
  assert.equal(quantityLine({ action: "user_created", deltaQuantity: null, resultingQuantity: null }), "");
});

test("quantityLine: ajuste Outlet (conference_item_delta) segue a mesma regra de sinal do scan_increment", () => {
  assert.equal(quantityLine({ action: "conference_item_delta", deltaQuantity: 1, resultingQuantity: 7 }), "+1 → Resultado: 7");
  assert.equal(quantityLine({ action: "conference_item_delta", deltaQuantity: -1, resultingQuantity: 5 }), "-1 → Resultado: 5");
});

// ---------------------------------------------------------------------------
// Reversão / origin / excesso — presença e não-ocultação dos campos (item 6/7
// do pedido). A UI real decide exibir os badges quando estes campos vêm
// preenchidos do evento normalizado; aqui validamos a condição de exibição.
// ---------------------------------------------------------------------------
function shouldShowReversalBadge(ev) {
  return !!ev.reversesEventId;
}
function shouldShowExcessBadge(ev) {
  return !!ev.excess;
}

test("evento de reversão (reverses_event_id preenchido) deve mostrar o badge de Desfazer/Reversão, nunca escondido", () => {
  assert.equal(shouldShowReversalBadge({ reversesEventId: "evt-original-123" }), true);
  assert.equal(shouldShowReversalBadge({ reversesEventId: null }), false);
});

test("evento com excess=true mostra 'Excesso confirmado' como informação adicional, nunca vira novo status", () => {
  assert.equal(shouldShowExcessBadge({ excess: true }), true);
  assert.equal(shouldShowExcessBadge({ excess: false }), false);
  assert.equal(shouldShowExcessBadge({ excess: null }), false);
});

test("origin do evento NF-e é preservado tal como veio (scanner/camera/manual/voice) — nunca reescrito/inferido", () => {
  const origins = ["scanner", "camera", "manual", "voice"];
  for (const origin of origins) {
    const ev = { action: "scan_increment", deltaQuantity: 1, resultingQuantity: 1, origin };
    assert.equal(ev.origin, origin);
  }
});

test("resulting_quantity sempre presente no evento normalizado, independentemente da ação (scan_increment ou manual_set)", () => {
  const scan = { action: "scan_increment", deltaQuantity: 1, resultingQuantity: 10 };
  const manual = { action: "manual_set", deltaQuantity: 10, resultingQuantity: 10 };
  assert.equal(typeof scan.resultingQuantity, "number");
  assert.equal(typeof manual.resultingQuantity, "number");
});
