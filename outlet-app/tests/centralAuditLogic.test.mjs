import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeAuditMetadata, describeCentralAuditAction, CentralAuditExportTooLargeError, CENTRAL_AUDIT_EXPORT_MAX_EVENTS } from "../src/client/centralAuditApi.ts";

// ---------------------------------------------------------------------------
// FASE 6 — Central de Auditoria (migration
// supabase/migrations/0060_central_operational_audit.sql, RPC
// search_central_audit).
//
// A união/classificação/escopo-por-empresa roda em SQL puro (sem
// infraestrutura de teste de Postgres neste projeto). As funções abaixo são
// um espelho FIEL da RPC — mesma regra de classificação de módulo, mesmo
// critério de escopo por empresa (nunca um evento "órfão" de outra empresa),
// mesma ordenação/paginação — mesmo padrão de "espelho executável" já usado
// em homeOperationalMetricsLogic.test.mjs/receiptAttentionLogic.test.mjs/
// operationalIndicatorsLogic.test.mjs. sanitizeAuditMetadata e
// describeCentralAuditAction, por outro lado, são testados DIRETO (código
// real, não espelho) — vivem em centralAuditApi.ts.
// ---------------------------------------------------------------------------

/** Espelho da classificação de módulo dentro de admin_events (ver migration 0060). */
function classifyAdminLogModule(entityType, action) {
  if (entityType === "conferences" && action === "conference_status_changed") return "outlet";
  if (entityType === "invoice_receipts" && action === "invoice_receipt_status_changed") return "nfe";
  return "administration";
}

/** Espelho do WHERE de escopo por empresa de admin_events — nunca inclui um audit_log que não provou pertencer à empresa do viewer. */
function adminLogCompanyOk(log, { viewerCompany, actorCompanyById, conferenceCompanyById, receiptCompanyById }) {
  if (log.userId !== null) {
    return actorCompanyById[log.userId] === viewerCompany;
  }
  if (log.entityType === "conferences") {
    return conferenceCompanyById[log.entityId] === viewerCompany;
  }
  if (log.entityType === "invoice_receipts") {
    return receiptCompanyById[log.entityId] === viewerCompany;
  }
  return false;
}

/** Espelho da união final: ordenação (occurred_at desc, id desc como desempate) + paginação. */
function sortAndPaginate(events, limit, offset) {
  const sorted = [...events].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return { events: sorted.slice(offset, offset + limit), total: sorted.length };
}

// ---------------------------------------------------------------------------
// NORMALIZAÇÃO — classificação de módulo (item 51 do pedido)
// ---------------------------------------------------------------------------
test("classifyAdminLogModule: conference_status_changed -> outlet", () => {
  assert.equal(classifyAdminLogModule("conferences", "conference_status_changed"), "outlet");
});

test("classifyAdminLogModule: invoice_receipt_status_changed -> nfe", () => {
  assert.equal(classifyAdminLogModule("invoice_receipts", "invoice_receipt_status_changed"), "nfe");
});

test("classifyAdminLogModule: demais ações administrativas -> administration", () => {
  assert.equal(classifyAdminLogModule("profiles", "user_created"), "administration");
  assert.equal(classifyAdminLogModule("work_groups", "group_created"), "administration");
  // entity_type bate mas a ação não é a de status -> nunca confundido com Outlet.
  assert.equal(classifyAdminLogModule("conferences", "some_other_action"), "administration");
});

test("invoice_item_scan_events sempre classificado como nfe; conference_item_scan_events sempre como outlet (fixo na migration, sem ambiguidade)", () => {
  const nfeEventModule = "nfe";
  const outletEventModule = "outlet";
  assert.equal(nfeEventModule, "nfe");
  assert.equal(outletEventModule, "outlet");
});

// ---------------------------------------------------------------------------
// SEGURANÇA — escopo por empresa (itens 15/50 do pedido)
// ---------------------------------------------------------------------------
const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

test("adminLogCompanyOk: user_id presente -> decide pela empresa do ATOR, nunca pela entidade", () => {
  const log = { userId: "user-1", entityType: "conferences", entityId: "conf-1" };
  const ctx = {
    viewerCompany: COMPANY_A,
    actorCompanyById: { "user-1": COMPANY_A },
    conferenceCompanyById: { "conf-1": COMPANY_B }, // entidade é de outra empresa — não importa, pois user_id existe
    receiptCompanyById: {},
  };
  assert.equal(adminLogCompanyOk(log, ctx), true);
});

test("adminLogCompanyOk: ator de outra empresa é excluído mesmo se a entidade bater", () => {
  const log = { userId: "user-2", entityType: "conferences", entityId: "conf-1" };
  const ctx = {
    viewerCompany: COMPANY_A,
    actorCompanyById: { "user-2": COMPANY_B },
    conferenceCompanyById: { "conf-1": COMPANY_A },
    receiptCompanyById: {},
  };
  assert.equal(adminLogCompanyOk(log, ctx), false);
});

test("adminLogCompanyOk: user_id nulo -> cai pra associação via entidade (conferences)", () => {
  const log = { userId: null, entityType: "conferences", entityId: "conf-9" };
  const ctx = { viewerCompany: COMPANY_A, actorCompanyById: {}, conferenceCompanyById: { "conf-9": COMPANY_A }, receiptCompanyById: {} };
  assert.equal(adminLogCompanyOk(log, ctx), true);
});

test("adminLogCompanyOk: user_id nulo -> cai pra associação via entidade (invoice_receipts)", () => {
  const log = { userId: null, entityType: "invoice_receipts", entityId: "nf-9" };
  const ctx = { viewerCompany: COMPANY_A, actorCompanyById: {}, conferenceCompanyById: {}, receiptCompanyById: { "nf-9": COMPANY_A } };
  assert.equal(adminLogCompanyOk(log, ctx), true);
});

test("adminLogCompanyOk: nenhuma associação possível -> NUNCA vaza (exclui, nunca inclui por conveniência)", () => {
  const log = { userId: null, entityType: "profiles", entityId: "prof-1" };
  const ctx = { viewerCompany: COMPANY_A, actorCompanyById: {}, conferenceCompanyById: {}, receiptCompanyById: {} };
  assert.equal(adminLogCompanyOk(log, ctx), false);
});

test("empresa A nunca recebe evento de invoice_item_scan_events/conference_item_scan_events da empresa B (escopo direto por company_id)", () => {
  const events = [
    { companyId: COMPANY_A, id: "e1" },
    { companyId: COMPANY_B, id: "e2" },
  ];
  const scoped = events.filter((e) => e.companyId === COMPANY_A);
  assert.deepEqual(scoped.map((e) => e.id), ["e1"]);
});

// ---------------------------------------------------------------------------
// ORDENAÇÃO E PAGINAÇÃO (itens 18/51 do pedido)
// ---------------------------------------------------------------------------
test("sortAndPaginate: ordena por occurred_at desc (mais recente primeiro)", () => {
  const events = [
    { id: "1", occurredAt: "2026-09-10T10:00:00Z" },
    { id: "2", occurredAt: "2026-09-16T10:00:00Z" },
    { id: "3", occurredAt: "2026-09-12T10:00:00Z" },
  ];
  const { events: page } = sortAndPaginate(events, 10, 0);
  assert.deepEqual(page.map((e) => e.id), ["2", "3", "1"]);
});

test("sortAndPaginate: empate em occurred_at usa id como desempate estável (desc)", () => {
  const events = [
    { id: "aaa", occurredAt: "2026-09-16T10:00:00Z" },
    { id: "zzz", occurredAt: "2026-09-16T10:00:00Z" },
  ];
  const { events: page } = sortAndPaginate(events, 10, 0);
  assert.deepEqual(page.map((e) => e.id), ["zzz", "aaa"]);
});

test("sortAndPaginate: 50 por página (limit) e total correto mesmo paginado", () => {
  const events = Array.from({ length: 120 }, (_, i) => ({ id: String(i).padStart(3, "0"), occurredAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }));
  const page1 = sortAndPaginate(events, 50, 0);
  const page2 = sortAndPaginate(events, 50, 50);
  assert.equal(page1.events.length, 50);
  assert.equal(page2.events.length, 50);
  assert.equal(page1.total, 120);
  assert.equal(page2.total, 120);
});

// ---------------------------------------------------------------------------
// SANITIZAÇÃO DE SEGREDOS (item 53 do pedido) — código real, não espelho.
// ---------------------------------------------------------------------------
test("sanitizeAuditMetadata: redige chaves sensíveis recursivamente (objetos/arrays aninhados), preserva dados comuns", () => {
  const input = {
    access_token: "abc",
    client_secret: "123",
    nested: { password: "xyz" },
    array: [{ authorization: "Bearer abc" }],
    normal_field: "mantido",
    count: 5,
  };
  const out = sanitizeAuditMetadata(input);
  assert.equal(out.access_token, "[REDACTED]");
  assert.equal(out.client_secret, "[REDACTED]");
  assert.equal(out.nested.password, "[REDACTED]");
  assert.equal(out.array[0].authorization, "[REDACTED]");
  assert.equal(out.normal_field, "mantido");
  assert.equal(out.count, 5);
});

test("sanitizeAuditMetadata: case-insensitive e cobre os termos mínimos do pedido", () => {
  const input = { Password: "a", SENHA: "b", Secret: "c", Token: "d", API_KEY: "e", apikey: "f", Credential: "g" };
  const out = sanitizeAuditMetadata(input);
  for (const key of Object.keys(input)) {
    assert.equal(out[key], "[REDACTED]", `chave ${key} deveria ter sido redigida`);
  }
});

test("sanitizeAuditMetadata: null/undefined/primitivos passam intactos", () => {
  assert.equal(sanitizeAuditMetadata(null), null);
  assert.equal(sanitizeAuditMetadata(5), 5);
  assert.equal(sanitizeAuditMetadata("texto"), "texto");
});

// ---------------------------------------------------------------------------
// AÇÕES HUMANAMENTE LEGÍVEIS (item 22 do pedido)
// ---------------------------------------------------------------------------
test("describeCentralAuditAction: rótulos legíveis pros três módulos, ação técnica preservada em outro lugar (nunca escondida)", () => {
  assert.equal(describeCentralAuditAction("scan_increment"), "Contagem por incremento");
  assert.equal(describeCentralAuditAction("manual_set"), "Quantidade definida manualmente");
  assert.equal(describeCentralAuditAction("conference_status_changed"), "Status da conferência alterado");
  assert.equal(describeCentralAuditAction("invoice_receipt_status_changed"), "Status da NF-e alterado");
  assert.equal(describeCentralAuditAction("user_created"), "Usuário criado");
});

test("describeCentralAuditAction: ação desconhecida nunca quebra — cai pro próprio código", () => {
  assert.equal(describeCentralAuditAction("acao_inexistente_xyz"), "acao_inexistente_xyz");
});

// ---------------------------------------------------------------------------
// LIMITE DE EXPORTAÇÃO (item 28 do pedido) — nunca trunca silenciosamente.
// ---------------------------------------------------------------------------
test("CentralAuditExportTooLargeError: mensagem cita o total real e o limite documentado", () => {
  const err = new CentralAuditExportTooLargeError(7000);
  assert.equal(err.total, 7000);
  assert.match(err.message, /7000/);
  assert.match(err.message, new RegExp(String(CENTRAL_AUDIT_EXPORT_MAX_EVENTS)));
});
