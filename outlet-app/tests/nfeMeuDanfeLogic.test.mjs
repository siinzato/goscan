import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeAccessKey,
  describeUpstreamHttpError,
  describeUpstreamException,
  normalizeBusinessStatus,
  lookupRowToResponse,
} from "../supabase/functions/consultar-nfe-meudanfe/logic.ts";

// ---------------------------------------------------------------------------
// sanitizeAccessKey — testes obrigatórios 1-7 da seção 23 do pedido.
// ---------------------------------------------------------------------------
test("sanitizeAccessKey rejeita campo vazio", () => {
  assert.equal(sanitizeAccessKey(""), null);
});

test("sanitizeAccessKey rejeita chave com menos de 44 dígitos", () => {
  assert.equal(sanitizeAccessKey("1".repeat(43)), null);
});

test("sanitizeAccessKey rejeita chave com mais de 44 dígitos", () => {
  assert.equal(sanitizeAccessKey("1".repeat(45)), null);
});

test("sanitizeAccessKey remove espaços e aceita quando sobram exatamente 44 dígitos", () => {
  const withSpaces = "1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 1234";
  assert.equal(withSpaces.replace(/\s/g, "").length, 44);
  assert.equal(sanitizeAccessKey(withSpaces), "12345678901234567890123456789012345678901234");
});

test("sanitizeAccessKey remove pontuação (pontos/traços)", () => {
  const withPunctuation = "1234.5678-9012.3456-7890.1234-5678-9012.3456.7890.1234";
  assert.equal(sanitizeAccessKey(withPunctuation), "12345678901234567890123456789012345678901234");
});

test("sanitizeAccessKey rejeita chave contendo letras (mesmo com 44 caracteres)", () => {
  const withLetters = "A".repeat(44);
  assert.equal(sanitizeAccessKey(withLetters), null);
  // 43 dígitos reais + 1 letra nunca deve "colar" em 44 dígitos válidos.
  assert.equal(sanitizeAccessKey("1".repeat(43) + "A"), null);
});

test("sanitizeAccessKey aceita chave válida (44 dígitos) e preserva como string", () => {
  const valid = "35260720123456000199550010000001231000001230";
  assert.equal(sanitizeAccessKey(valid), valid);
});

test("sanitizeAccessKey rejeita valores que não são string", () => {
  assert.equal(sanitizeAccessKey(undefined), null);
  assert.equal(sanitizeAccessKey(null), null);
  assert.equal(sanitizeAccessKey(12345), null);
});

// ---------------------------------------------------------------------------
// describeUpstreamHttpError — mapeamento de erros da seção 17 do pedido.
// ---------------------------------------------------------------------------
test("describeUpstreamHttpError mapeia 400 para chave inválida", () => {
  const e = describeUpstreamHttpError(400);
  assert.equal(e.code, "NFE_INVALID_KEY");
  assert.match(e.message, /Chave de acesso inválida/);
});

test("describeUpstreamHttpError mapeia 401/403 para integração não configurada, sem detalhes técnicos", () => {
  for (const status of [401, 403]) {
    const e = describeUpstreamHttpError(status);
    assert.equal(e.code, "NFE_INTEGRATION_UNAVAILABLE");
    assert.match(e.message, /Procure um administrador/);
    assert.doesNotMatch(e.message, /key|token|secret/i);
  }
});

test("describeUpstreamHttpError mapeia 402 para saldo insuficiente", () => {
  const e = describeUpstreamHttpError(402);
  assert.equal(e.code, "NFE_INSUFFICIENT_BALANCE");
  assert.match(e.message, /Saldo insuficiente/);
});

test("describeUpstreamHttpError mapeia 404 (download de XML) para 'ainda não disponível'", () => {
  const e = describeUpstreamHttpError(404);
  assert.equal(e.code, "NFE_XML_NOT_READY");
  assert.match(e.message, /XML ainda não está disponível/);
});

test("describeUpstreamHttpError mapeia 429 para 'muitas consultas'", () => {
  const e = describeUpstreamHttpError(429);
  assert.equal(e.code, "NFE_RATE_LIMITED");
  assert.match(e.message, /Muitas consultas/);
});

test("describeUpstreamHttpError mapeia 500 (e qualquer status não previsto) para indisponibilidade temporária", () => {
  for (const status of [500, 502, 503, 418]) {
    const e = describeUpstreamHttpError(status);
    assert.equal(e.code, "NFE_SERVICE_UNAVAILABLE");
    assert.match(e.message, /temporariamente indisponível/);
  }
});

// ---------------------------------------------------------------------------
// describeUpstreamException — falha de rede/timeout.
// ---------------------------------------------------------------------------
test("describeUpstreamException identifica timeout (mesmo formato de erro do AbortSignal.timeout) sem expor a exceção crua", () => {
  // AbortSignal.timeout() rejeita com um erro cujo .name é "TimeoutError" —
  // describeUpstreamException só olha essa propriedade (ver implementação),
  // então um objeto simples com o mesmo formato já prova o comportamento sem
  // depender do global DOMException.
  const timeoutErr = { name: "TimeoutError", message: "signal timed out" };
  const e = describeUpstreamException(timeoutErr);
  assert.equal(e.code, "NFE_TIMEOUT");
  assert.doesNotMatch(e.message, /signal timed out/);
});

test("describeUpstreamException trata qualquer outra falha como erro de rede genérico", () => {
  const e = describeUpstreamException(new Error("ECONNREFUSED 1.2.3.4:443"));
  assert.equal(e.code, "NFE_NETWORK_ERROR");
  assert.doesNotMatch(e.message, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// normalizeBusinessStatus — corpo JSON do PUT do Meu Danfe.
// ---------------------------------------------------------------------------
test("normalizeBusinessStatus normaliza caixa e espaços, e trata ausência como string vazia", () => {
  assert.equal(normalizeBusinessStatus(" waiting "), "WAITING");
  assert.equal(normalizeBusinessStatus("Ok"), "OK");
  assert.equal(normalizeBusinessStatus(undefined), "");
  assert.equal(normalizeBusinessStatus(null), "");
  assert.equal(normalizeBusinessStatus(123), "");
});

// ---------------------------------------------------------------------------
// lookupRowToResponse — resposta servida a partir do cache local (throttle <1s).
// ---------------------------------------------------------------------------
test("lookupRowToResponse repete WAITING/SEARCHING sem inventar um resultado", () => {
  const waiting = lookupRowToResponse({ status: "waiting", attempt_count: 2, sanitized_error: null }, "X".repeat(44));
  assert.equal(waiting.body.success, true);
  assert.equal(waiting.body.status, "WAITING");

  const searching = lookupRowToResponse({ status: "searching", attempt_count: 3, sanitized_error: null }, "X".repeat(44));
  assert.equal(searching.body.status, "SEARCHING");
});

test("lookupRowToResponse NUNCA devolve XML em cache mesmo se o último status salvo for 'ok'", () => {
  const row = { status: "ok", attempt_count: 5, sanitized_error: null };
  const result = lookupRowToResponse(row, "X".repeat(44));
  assert.equal(result.body.status, "SEARCHING");
  assert.equal("xml" in result.body, false);
});

test("lookupRowToResponse mapeia not_found e error corretamente a partir do cache", () => {
  const notFound = lookupRowToResponse({ status: "not_found", attempt_count: 1, sanitized_error: null }, "X".repeat(44));
  assert.equal(notFound.body.success, false);
  assert.equal(notFound.body.code, "NFE_NOT_FOUND");
  assert.equal(notFound.httpStatus, 404);

  const error = lookupRowToResponse({ status: "error", attempt_count: 4, sanitized_error: "Saldo insuficiente na integração de NF-e. Procure um administrador." }, "X".repeat(44));
  assert.equal(error.body.success, false);
  assert.equal(error.body.message, "Saldo insuficiente na integração de NF-e. Procure um administrador.");
});
