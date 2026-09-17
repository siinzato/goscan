import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// FASE 3 — Central de Pendências Operacionais de NF-e (migration
// supabase/migrations/0058_receipt_attention_search.sql, RPC
// search_receipt_attention).
//
// A regra de inclusão/filtro/ordenação/paginação roda em SQL puro (sem
// infraestrutura de teste de Postgres neste projeto). A função abaixo é um
// espelho FIEL da RPC — mesma regra de inclusão (status <> completed), mesma
// combinação de categoria/pesquisa/operador/período, mesma ordenação
// determinística — servindo de especificação executável pros cenários do
// pedido. A migration continua sendo a fonte da verdade em produção; mudar a
// intenção do algoritmo exige mudar os dois lados juntos (mesmo padrão já
// usado pra get_home_operational_summary em homeOperationalMetricsLogic.test.mjs).
// ---------------------------------------------------------------------------

function isPendency(r) {
  return r.status !== "completed";
}

function matchesCategory(r, category) {
  if (!category || category === "all") return true;
  if (category === "unlinked") return r.unlinkedCount > 0;
  return r.status === category;
}

function matchesSearch(r, term, matchingOperatorIds) {
  if (!term) return true;
  const t = term.toLowerCase();
  if ((r.invoiceNumber || "").toLowerCase().includes(t)) return true;
  if ((r.supplierName || "").toLowerCase().includes(t)) return true;
  const cnpjDigits = term.replace(/\D/g, "");
  if (cnpjDigits && (r.supplierCnpj || "").includes(cnpjDigits)) return true;
  if (matchingOperatorIds.includes(r.createdBy)) return true;
  return false;
}

const STATUS_RANK = { in_progress: 0, not_started: 1, with_divergences: 2 };

function orderKey(r) {
  const rank = STATUS_RANK[r.status] ?? 3;
  const ts = new Date(r.startedAt || r.finishedAt || r.createdAt).getTime();
  return [rank, -ts];
}

function searchReceiptAttentionMirror(receipts, opts) {
  const { category, search, matchingOperatorIds = [], operatorId, dateFrom, dateTo, limit = 25, offset = 0 } = opts;
  let rows = receipts.filter(isPendency).filter((r) => matchesCategory(r, category));
  if (operatorId && operatorId !== "all") rows = rows.filter((r) => r.createdBy === operatorId);
  if (dateFrom) rows = rows.filter((r) => new Date(r.createdAt).getTime() >= new Date(dateFrom).getTime());
  if (dateTo) rows = rows.filter((r) => new Date(r.createdAt).getTime() < new Date(dateTo).getTime());
  if (search) rows = rows.filter((r) => matchesSearch(r, search, matchingOperatorIds));

  rows = rows.slice().sort((a, b) => {
    const [ra, ta] = orderKey(a);
    const [rb, tb] = orderKey(b);
    return ra - rb || ta - tb;
  });

  const total = rows.length;
  const items = rows.slice(offset, offset + limit);
  return { items, total, hasMore: offset + items.length < total };
}

const R = (over) => ({
  id: "r1",
  invoiceNumber: "0001",
  supplierName: "Fornecedor X",
  supplierCnpj: "12345678000190",
  status: "not_started",
  createdBy: "op-1",
  createdAt: "2026-01-10T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  unlinkedCount: 0,
  ...over,
});

test("nenhuma pendência: lista vazia -> total 0, sem itens", () => {
  const page = searchReceiptAttentionMirror([], { limit: 25, offset: 0 });
  assert.deepEqual(page, { items: [], total: 0, hasMore: false });
});

test("completed nunca é pendência, mesmo com itens sem vínculo (item 3 do pedido)", () => {
  const receipts = [R({ id: "done", status: "completed", unlinkedCount: 3 })];
  const page = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.equal(page.total, 0);
});

test("somente not_started aparece quando é o único caso", () => {
  const receipts = [R({ id: "a", status: "not_started" })];
  const page = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["a"]);
});

test("somente in_progress aparece quando é o único caso", () => {
  const receipts = [R({ id: "a", status: "in_progress" })];
  const page = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["a"]);
});

test("somente with_divergences aparece quando é o único caso", () => {
  const receipts = [R({ id: "a", status: "with_divergences" })];
  const page = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["a"]);
});

test("NF in_progress com itens sem vínculo consolida os dois motivos na MESMA linha (nunca duplica a NF)", () => {
  const receipts = [R({ id: "a", status: "in_progress", unlinkedCount: 2 })];
  const page = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].status, "in_progress");
  assert.equal(page.items[0].unlinkedCount, 2);
});

test("NF com vários itens sem vínculo aparece apenas uma vez (contagem consolidada, não uma linha por item)", () => {
  // O agrupamento por receipt_id já garante 1 linha por NF na própria RPC —
  // este teste fixa a expectativa de que o unlinkedCount é um atributo da
  // NF (somado), nunca um motivo que a duplica.
  const receipts = [R({ id: "a", status: "not_started", unlinkedCount: 5 })];
  const page = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].unlinkedCount, 5);
});

test("filtro por tipo: category='unlinked' só traz NFs (não completed) com pelo menos 1 item sem vínculo", () => {
  const receipts = [
    R({ id: "a", status: "not_started", unlinkedCount: 0 }),
    R({ id: "b", status: "in_progress", unlinkedCount: 1 }),
    R({ id: "c", status: "with_divergences", unlinkedCount: 2 }),
  ];
  const page = searchReceiptAttentionMirror(receipts, { category: "unlinked", limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id).sort(), ["b", "c"]);
});

test("filtro por tipo: category='with_divergences' só traz esse status, mesmo que outras tenham itens sem vínculo", () => {
  const receipts = [
    R({ id: "a", status: "in_progress", unlinkedCount: 4 }),
    R({ id: "b", status: "with_divergences" }),
  ];
  const page = searchReceiptAttentionMirror(receipts, { category: "with_divergences", limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["b"]);
});

test("pesquisa por número da NF", () => {
  const receipts = [R({ id: "a", invoiceNumber: "004218" }), R({ id: "b", invoiceNumber: "999999" })];
  const page = searchReceiptAttentionMirror(receipts, { search: "4218", limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["a"]);
});

test("pesquisa por fornecedor (case-insensitive)", () => {
  const receipts = [R({ id: "a", supplierName: "GoCase Indústria" }), R({ id: "b", supplierName: "Outra Ltda" })];
  const page = searchReceiptAttentionMirror(receipts, { search: "gocase", limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["a"]);
});

test("pesquisa por CNPJ funciona com ou sem pontuação (dígitos do termo contra o CNPJ, gravado só em dígitos)", () => {
  const receipts = [R({ id: "a", supplierCnpj: "12345678000190" })];
  const page1 = searchReceiptAttentionMirror(receipts, { search: "12.345.678/0001-90", limit: 25, offset: 0 });
  const page2 = searchReceiptAttentionMirror(receipts, { search: "12345678000190", limit: 25, offset: 0 });
  assert.equal(page1.items.length, 1);
  assert.equal(page2.items.length, 1);
});

test("pesquisa por operador (nome resolvido em ids pelo chamador, mesmo padrão da Fase 2)", () => {
  const receipts = [R({ id: "a", createdBy: "op-victor" }), R({ id: "b", createdBy: "op-outro" })];
  const page = searchReceiptAttentionMirror(receipts, { search: "victor", matchingOperatorIds: ["op-victor"], limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["a"]);
});

test("filtro por período: [dateFrom, dateTo) exclui fora do intervalo", () => {
  const receipts = [
    R({ id: "fora-antes", createdAt: "2026-01-01T00:00:00.000Z" }),
    R({ id: "dentro", createdAt: "2026-01-05T00:00:00.000Z" }),
    R({ id: "fora-depois", createdAt: "2026-01-10T00:00:00.000Z" }),
  ];
  const page = searchReceiptAttentionMirror(receipts, { dateFrom: "2026-01-03T00:00:00.000Z", dateTo: "2026-01-06T00:00:00.000Z", limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["dentro"]);
});

test("paginação: limit/offset e hasMore corretos", () => {
  const receipts = Array.from({ length: 30 }, (_, i) => R({ id: `r${i}`, status: "not_started", createdAt: new Date(2026, 0, i + 1).toISOString() }));
  const page1 = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.equal(page1.items.length, 25);
  assert.equal(page1.total, 30);
  assert.equal(page1.hasMore, true);

  const page2 = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 25 });
  assert.equal(page2.items.length, 5);
  assert.equal(page2.hasMore, false);
});

test("ordenação determinística: in_progress antes de not_started antes de with_divergences; dentro do grupo, mais recente primeiro", () => {
  const receipts = [
    R({ id: "div-velha", status: "with_divergences", finishedAt: "2026-01-01T00:00:00.000Z" }),
    R({ id: "nao-iniciada", status: "not_started", createdAt: "2026-01-02T00:00:00.000Z" }),
    R({ id: "andamento-nova", status: "in_progress", startedAt: "2026-01-05T00:00:00.000Z" }),
    R({ id: "andamento-velha", status: "in_progress", startedAt: "2026-01-01T00:00:00.000Z" }),
  ];
  const page = searchReceiptAttentionMirror(receipts, { limit: 25, offset: 0 });
  assert.deepEqual(page.items.map((r) => r.id), ["andamento-nova", "andamento-velha", "nao-iniciada", "div-velha"]);
});
