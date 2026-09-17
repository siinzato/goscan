import test from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  escapeHtml,
  debounce,
  normalizeEan,
  isValidEanFormat,
  parseConferirHash,
  parseHistoricoHash,
  todayLocalRangeIso,
  parseLocalDateRangeIso,
  escapeOrFilterValue,
  hasActiveHistoryFilters,
  matchOperatorIdsByName,
  formatOperationDuration,
  formatSignedNumber,
  lastNDaysLocalRangeIso,
  getLocalTimeZone,
} from "../src/client/utils.ts";

test("normalize strips accents, case and punctuation", () => {
  assert.equal(normalize("Preço: Rosa e Lilás!"), "preco rosa e lilas");
  assert.equal(normalize("  Tote   Mini  "), "tote mini");
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
});

test("escapeHtml neutralizes HTML-significant characters", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("O'Brien & Cia"), "O&#39;Brien &amp; Cia");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

// ---------------------------------------------------------------------------
// CORREÇÃO — Reconhecimento automático e busca por EAN: normalizeEan é a
// ÚNICA regra de normalização de código de barras usada em todo o app
// (parser, matching, busca, importer, CRUD manual).
// ---------------------------------------------------------------------------
test("normalizeEan remove espaços, pontos e traços, mantendo só dígitos", () => {
  assert.equal(normalizeEan("8800328810198"), "8800328810198");
  assert.equal(normalizeEan(" 8800328810198 "), "8800328810198");
  assert.equal(normalizeEan("8800 3288 10198"), "8800328810198");
  assert.equal(normalizeEan("8800-3288-10198"), "8800328810198");
  assert.equal(normalizeEan("8800.3288.10198"), "8800328810198");
});

test("normalizeEan nunca perde zero à esquerda (nunca converte para número)", () => {
  assert.equal(normalizeEan("0078955555555"), "0078955555555");
});

test("normalizeEan lida com null/undefined/vazio sem lançar exceção", () => {
  assert.equal(normalizeEan(null), "");
  assert.equal(normalizeEan(undefined), "");
  assert.equal(normalizeEan(""), "");
  assert.equal(normalizeEan("SEM GTIN"), "");
});

test("isValidEanFormat aceita só 8, 12, 13 ou 14 dígitos", () => {
  assert.equal(isValidEanFormat("12345678"), true); // EAN-8
  assert.equal(isValidEanFormat("123456789012"), true); // UPC-A
  assert.equal(isValidEanFormat("1234567890123"), true); // EAN-13
  assert.equal(isValidEanFormat("12345678901234"), true); // ITF-14/GTIN-14
});

test("isValidEanFormat rejeita lixo comum de XML de NF-e (nunca finge que é um EAN válido)", () => {
  assert.equal(isValidEanFormat(normalizeEan("0")), false);
  assert.equal(isValidEanFormat(normalizeEan("N/A")), false);
  assert.equal(isValidEanFormat(normalizeEan("SEMGTIN")), false);
  assert.equal(isValidEanFormat(normalizeEan("SEM GTIN")), false);
  assert.equal(isValidEanFormat(normalizeEan("")), false);
  assert.equal(isValidEanFormat(normalizeEan("123")), false); // curto demais
});

test("debounce only invokes the last call within the window", async () => {
  let calls = 0;
  let lastArg = null;
  const fn = debounce((arg) => {
    calls++;
    lastArg = arg;
  }, 20);

  fn("a");
  fn("b");
  fn("c");

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(calls, 1);
  assert.equal(lastArg, "c");
});

// ---------------------------------------------------------------------------
// FASE 4 — rota canônica da NF-e (#/conferir/nfe/<id>). Função pura, sem DOM.
// ---------------------------------------------------------------------------
test("parseConferirHash: #/conferir vira modo imagens (comportamento atual preservado)", () => {
  const result = parseConferirHash("#/conferir");
  assert.equal(result.mode, "imagens");
  assert.equal(result.nfeReceiptId, null);
});

test("parseConferirHash: #/conferir/nfe seleciona o modo Nota Fiscal sem receipt", () => {
  const result = parseConferirHash("#/conferir/nfe");
  assert.equal(result.mode, "nfe");
  assert.equal(result.nfeReceiptId, null);
});

test("parseConferirHash: #/conferir/nfe/<uuid> preserva o receiptId no modo Nota Fiscal", () => {
  const result = parseConferirHash("#/conferir/nfe/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(result.mode, "nfe");
  assert.equal(result.nfeReceiptId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("parseConferirHash nunca lança exceção pra hash ausente/vazio/malformado", () => {
  assert.doesNotThrow(() => parseConferirHash(""));
  assert.doesNotThrow(() => parseConferirHash("#"));
  assert.doesNotThrow(() => parseConferirHash("#/"));
  assert.doesNotThrow(() => parseConferirHash("lixo-qualquer"));
  assert.equal(parseConferirHash("#/conferir/nfe/").nfeReceiptId, null); // receiptId ausente nunca vira string vazia
});

test("parseConferirHash ignora outras rotas (nunca confunde com o módulo NF)", () => {
  assert.equal(parseConferirHash("#/historico").mode, "imagens");
  assert.equal(parseConferirHash("#/conferir/devolucao").mode, "imagens");
});

// ---------------------------------------------------------------------------
// FASE 3 — Central de Pendências: deep link #/historico/pendencias.
// ---------------------------------------------------------------------------
test("parseHistoricoHash: #/historico/pendencias sinaliza a aba Pendências", () => {
  assert.equal(parseHistoricoHash("#/historico/pendencias"), "pendencias");
});

test("parseHistoricoHash: #/historico puro NÃO força nenhuma aba (preserva a já selecionada)", () => {
  assert.equal(parseHistoricoHash("#/historico"), null);
  assert.equal(parseHistoricoHash("#/historico/"), null);
});

test("parseHistoricoHash: nunca confunde outras rotas com o Histórico", () => {
  assert.equal(parseHistoricoHash("#/conferir/nfe"), null);
  assert.equal(parseHistoricoHash("#/pendencias"), null);
  assert.equal(parseHistoricoHash(""), null);
});

// ---------------------------------------------------------------------------
// FASE 5 — Indicadores Operacionais: deep link #/historico/indicadores.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FASE 5 — Indicadores Operacionais: lastNDaysLocalRangeIso (atalhos "7
// dias"/"30 dias") e getLocalTimeZone (fuso enviado à RPC).
// ---------------------------------------------------------------------------
test("lastNDaysLocalRangeIso(7): cobre hoje + 6 dias anteriores (7 dias de diferença entre início e fim)", () => {
  const { start, end } = lastNDaysLocalRangeIso(7);
  const diffDays = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
  assert.equal(diffDays, 7);
  assert.equal(new Date(start).getHours(), 0);
});

test("lastNDaysLocalRangeIso(30): 30 dias de diferença", () => {
  const { start, end } = lastNDaysLocalRangeIso(30);
  const diffDays = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
  assert.equal(diffDays, 30);
});

test("lastNDaysLocalRangeIso: fim sempre é o fim do dia de hoje (mesmo fim de todayLocalRangeIso)", () => {
  const today = todayLocalRangeIso();
  const week = lastNDaysLocalRangeIso(7);
  assert.equal(week.end, today.end);
});

test("getLocalTimeZone: nunca lança erro e nunca devolve vazio", () => {
  const tz = getLocalTimeZone();
  assert.equal(typeof tz, "string");
  assert.ok(tz.length > 0);
});

test("parseHistoricoHash: #/historico/indicadores sinaliza a aba Indicadores", () => {
  assert.equal(parseHistoricoHash("#/historico/indicadores"), "indicadores");
});

test("parseHistoricoHash: indicadores e pendencias nunca se confundem", () => {
  assert.equal(parseHistoricoHash("#/historico/indicadores"), "indicadores");
  assert.equal(parseHistoricoHash("#/historico/pendencias"), "pendencias");
});

// ---------------------------------------------------------------------------
// HOME OPERACIONAL 2.0 — métricas diárias 100% reais (migration 0057). O
// frontend decide o que é "hoje" (nunca o servidor, que não deve assumir o
// fuso do operador) — todayLocalRangeIso é o único ponto de verdade desse
// corte, enviado como [início, fim) pra get_home_operational_summary.
// ---------------------------------------------------------------------------
test("todayLocalRangeIso devolve um intervalo [meia-noite local, meia-noite local + 1 dia)", () => {
  const { start, end } = todayLocalRangeIso();
  const startDate = new Date(start);
  const endDate = new Date(end);
  assert.equal(startDate.getHours(), 0);
  assert.equal(startDate.getMinutes(), 0);
  assert.equal(startDate.getSeconds(), 0);
  assert.equal(startDate.getMilliseconds(), 0);
  assert.equal(endDate.getTime() - startDate.getTime(), 24 * 60 * 60 * 1000);
});

test("todayLocalRangeIso nunca devolve fim <= início", () => {
  const { start, end } = todayLocalRangeIso();
  assert.ok(new Date(end).getTime() > new Date(start).getTime());
});

// ---------------------------------------------------------------------------
// HISTÓRICO — FASE 2 (pesquisa e filtros operacionais). Filtro por período:
// parseLocalDateRangeIso monta [início, fim) local a partir dos valores crus
// de <input type="date"> — mesmo princípio de todayLocalRangeIso, mas a
// partir de uma data escolhida pelo operador em vez de "agora".
// ---------------------------------------------------------------------------
test("parseLocalDateRangeIso: só data inicial -> fim fica aberto (null)", () => {
  const { start, end } = parseLocalDateRangeIso("2026-01-10", null);
  assert.equal(new Date(start).getDate(), 10);
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(end, null);
});

test("parseLocalDateRangeIso: só data final -> início fica aberto (null), fim é o INÍCIO do dia seguinte (exclusivo)", () => {
  const { start, end } = parseLocalDateRangeIso(null, "2026-01-10");
  assert.equal(start, null);
  const endDate = new Date(end);
  assert.equal(endDate.getDate(), 11);
  assert.equal(endDate.getHours(), 0);
});

test("parseLocalDateRangeIso: as duas datas -> intervalo [início do dia inicial, início do dia seguinte ao final)", () => {
  const { start, end } = parseLocalDateRangeIso("2026-01-05", "2026-01-08");
  assert.equal(new Date(start).getDate(), 5);
  assert.equal(new Date(end).getDate(), 9);
});

test("parseLocalDateRangeIso: nenhuma data -> intervalo totalmente aberto", () => {
  assert.deepEqual(parseLocalDateRangeIso(null, null), { start: null, end: null });
  assert.deepEqual(parseLocalDateRangeIso("", ""), { start: null, end: null });
});

test("escapeOrFilterValue: sempre entre aspas, escapando aspas e barras internas (protege o combinador or() do PostgREST)", () => {
  assert.equal(escapeOrFilterValue("simples"), '"simples"');
  assert.equal(escapeOrFilterValue("a,b"), '"a,b"');
  assert.equal(escapeOrFilterValue('com "aspas"'), '"com \\"aspas\\""');
  assert.equal(escapeOrFilterValue("back\\slash"), '"back\\\\slash"');
});

// ---------------------------------------------------------------------------
// HISTÓRICO — FASE 2: "Limpar filtros" só precisa fazer sentido (habilitado/
// destacado) quando algum filtro está de fato ativo; resultado vazio também
// usa isso pra diferenciar "sem dados" de "sem correspondência" (item 12).
// ---------------------------------------------------------------------------
const NO_FILTERS = { search: "", status: "all", operatorId: "all", dateFrom: "", dateTo: "" };

test("hasActiveHistoryFilters: nenhum filtro ativo -> false", () => {
  assert.equal(hasActiveHistoryFilters(NO_FILTERS), false);
  assert.equal(hasActiveHistoryFilters({ ...NO_FILTERS, search: "   " }), false, "espaços em branco não contam como pesquisa ativa");
});

test("hasActiveHistoryFilters: qualquer filtro sozinho já conta como ativo", () => {
  assert.equal(hasActiveHistoryFilters({ ...NO_FILTERS, search: "victor" }), true);
  assert.equal(hasActiveHistoryFilters({ ...NO_FILTERS, status: "completed" }), true);
  assert.equal(hasActiveHistoryFilters({ ...NO_FILTERS, operatorId: "abc-123" }), true);
  assert.equal(hasActiveHistoryFilters({ ...NO_FILTERS, dateFrom: "2026-01-01" }), true);
  assert.equal(hasActiveHistoryFilters({ ...NO_FILTERS, dateTo: "2026-01-01" }), true);
});

// ---------------------------------------------------------------------------
// HISTÓRICO — FASE 2: pesquisa por operador dentro da caixa de texto livre
// (ex.: digitar "Victor" deve incluir as conferências/NFs dele mesmo sem usar
// o seletor de operador) — accent/case-insensitive via normalize().
// ---------------------------------------------------------------------------
const OPERATORS = [
  { id: "op-1", full_name: "Victor Hugo" },
  { id: "op-2", full_name: "José Antônio" },
  { id: "op-3", full_name: null },
];

test("matchOperatorIdsByName: encontra por substring, case-insensitive", () => {
  assert.deepEqual(matchOperatorIdsByName("victor", OPERATORS), ["op-1"]);
  assert.deepEqual(matchOperatorIdsByName("HUGO", OPERATORS), ["op-1"]);
});

test("matchOperatorIdsByName: ignora acentos (José -> jose)", () => {
  assert.deepEqual(matchOperatorIdsByName("jose", OPERATORS), ["op-2"]);
});

test("matchOperatorIdsByName: termo vazio nunca retorna todo mundo", () => {
  assert.deepEqual(matchOperatorIdsByName("", OPERATORS), []);
  assert.deepEqual(matchOperatorIdsByName("   ", OPERATORS), []);
});

test("matchOperatorIdsByName: nunca quebra com full_name nulo, e sem correspondência devolve lista vazia", () => {
  assert.deepEqual(matchOperatorIdsByName("ninguem", OPERATORS), []);
});

// ---------------------------------------------------------------------------
// FASE 4 — Resumo Final Padronizado: duração da operação (Outlet/NF-e) e
// diferença de unidades com sinal.
// ---------------------------------------------------------------------------
test("formatOperationDuration: 18 minutos", () => {
  assert.equal(formatOperationDuration("2026-01-01T09:00:00.000Z", "2026-01-01T09:18:00.000Z"), "18 min");
});

test("formatOperationDuration: 1h12min", () => {
  assert.equal(formatOperationDuration("2026-01-01T09:00:00.000Z", "2026-01-01T10:12:00.000Z"), "1h 12min");
});

test("formatOperationDuration: mais de 24h continua contando horas (nunca vira dias escondidos)", () => {
  assert.equal(formatOperationDuration("2026-01-01T00:00:00.000Z", "2026-01-02T01:30:00.000Z"), "25h 30min");
});

test("formatOperationDuration: minutos de 1 dígito ganham zero à esquerda (2h 04min)", () => {
  assert.equal(formatOperationDuration("2026-01-01T09:00:00.000Z", "2026-01-01T11:04:00.000Z"), "2h 04min");
});

test("formatOperationDuration: started_at ausente -> Não registrada", () => {
  assert.equal(formatOperationDuration(null, "2026-01-01T10:00:00.000Z"), "Não registrada");
  assert.equal(formatOperationDuration(undefined, "2026-01-01T10:00:00.000Z"), "Não registrada");
});

test("formatOperationDuration: finished_at ausente -> Não registrada", () => {
  assert.equal(formatOperationDuration("2026-01-01T09:00:00.000Z", null), "Não registrada");
});

test("formatOperationDuration: data inválida -> Não registrada, nunca inventa valor", () => {
  assert.equal(formatOperationDuration("data-invalida", "2026-01-01T10:00:00.000Z"), "Não registrada");
  assert.equal(formatOperationDuration("2026-01-01T09:00:00.000Z", "data-invalida"), "Não registrada");
});

test("formatOperationDuration: finished_at anterior ao início -> Não registrada, nunca duração negativa", () => {
  assert.equal(formatOperationDuration("2026-01-01T10:00:00.000Z", "2026-01-01T09:00:00.000Z"), "Não registrada");
});

test("formatSignedNumber: positivo, negativo e zero", () => {
  assert.equal(formatSignedNumber(10), "+10");
  assert.equal(formatSignedNumber(-3), "-3");
  assert.equal(formatSignedNumber(0), "0");
});
