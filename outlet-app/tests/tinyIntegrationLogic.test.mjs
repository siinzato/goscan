import test from "node:test";
import assert from "node:assert/strict";
import {
  isAccessTokenExpired,
  buildTinyLaunchIdempotencyKey,
  describeTinyError,
  buildProdutoLookupParams,
  buildStockMovementBody,
  summarizeLaunchResults,
  buildTokenRefreshBody,
  isValidTinyIntegrationAction,
  TOKEN_EXPIRY_BUFFER_MS,
} from "../supabase/functions/tiny-integration/logic.ts";

test("isAccessTokenExpired: ausente conta como expirado (nunca assume válido por omissão)", () => {
  assert.equal(isAccessTokenExpired(null, 1_000_000), true);
  assert.equal(isAccessTokenExpired(undefined, 1_000_000), true);
  assert.equal(isAccessTokenExpired("data-invalida", 1_000_000), true);
});

test("isAccessTokenExpired: dentro do buffer de segurança conta como expirado (refresh proativo)", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const expiresInBufferWindow = new Date(now + TOKEN_EXPIRY_BUFFER_MS - 1000).toISOString();
  assert.equal(isAccessTokenExpired(expiresInBufferWindow, now), true);
});

test("isAccessTokenExpired: bem dentro da validade real -> não expirado", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const expiresIn2h = new Date(now + 2 * 60 * 60 * 1000).toISOString();
  assert.equal(isAccessTokenExpired(expiresIn2h, now), false);
});

test("isAccessTokenExpired: já passou da validade -> expirado", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const expiredAgo = new Date(now - 1000).toISOString();
  assert.equal(isAccessTokenExpired(expiredAgo, now), true);
});

test("buildTinyLaunchIdempotencyKey: determinístico — mesmos parâmetros SEMPRE geram a mesma chave", () => {
  const a = buildTinyLaunchIdempotencyKey("return_batch_item", "item-1", "42");
  const b = buildTinyLaunchIdempotencyKey("return_batch_item", "item-1", "42");
  assert.equal(a, b);
  assert.equal(a, "TINY_ESTOQUE:return_batch_item:item-1:DEPOSITO:42");
});

test("buildTinyLaunchIdempotencyKey: depósito diferente gera chave diferente (nova tentativa legítima)", () => {
  const a = buildTinyLaunchIdempotencyKey("invoice_receipt_item", "item-9", "1");
  const b = buildTinyLaunchIdempotencyKey("invoice_receipt_item", "item-9", "2");
  assert.notEqual(a, b);
});

test("buildTinyLaunchIdempotencyKey: source_type diferente (mesmo id/depósito) nunca colide entre Devolução e NF-e", () => {
  const a = buildTinyLaunchIdempotencyKey("return_batch_item", "same-id", "1");
  const b = buildTinyLaunchIdempotencyKey("invoice_receipt_item", "same-id", "1");
  assert.notEqual(a, b);
});

test("describeTinyError: status conhecidos viram mensagem clara em português, nunca o corpo técnico", () => {
  assert.match(describeTinyError(401, {}), /reconecte/i);
  assert.match(describeTinyError(403, {}), /permissão/i);
  assert.match(describeTinyError(404, {}), /não encontrado/i);
  assert.match(describeTinyError(429, {}), /limite/i);
  assert.match(describeTinyError(503, {}), /indisponível/i);
});

test("describeTinyError: ErrorDTO com detalhes de campo -> mensagem por campo", () => {
  const msg = describeTinyError(400, { mensagem: "Ocorreram erros de validação", detalhes: [{ campo: "codigo", mensagem: "O campo código é obrigatório" }] });
  assert.match(msg, /codigo/i);
  assert.match(msg, /obrigatório/i);
});

test("describeTinyError: ErrorDTO só com mensagem geral (sem detalhes) usa a mensagem geral", () => {
  assert.equal(describeTinyError(400, { mensagem: "Requisição inválida" }), "Requisição inválida");
});

test("describeTinyError: corpo vazio/inesperado nunca quebra, sempre devolve mensagem genérica segura", () => {
  assert.equal(typeof describeTinyError(400, null), "string");
  assert.equal(typeof describeTinyError(400, undefined), "string");
  assert.equal(typeof describeTinyError(400, "texto solto"), "string");
});

test("buildProdutoLookupParams: prioriza SKU (codigo) quando presente", () => {
  assert.deepEqual(buildProdutoLookupParams("ABC-123", "7891234567890"), { codigo: "ABC-123" });
});

test("buildProdutoLookupParams: usa EAN (gtin) só quando SKU ausente e o EAN é só dígitos", () => {
  assert.deepEqual(buildProdutoLookupParams(null, "7891234567890"), { gtin: "7891234567890" });
  assert.deepEqual(buildProdutoLookupParams(null, "abc-nao-e-ean"), {});
});

test("buildProdutoLookupParams: nunca os dois vazios quebra, devolve objeto vazio", () => {
  assert.deepEqual(buildProdutoLookupParams(null, null), {});
  assert.deepEqual(buildProdutoLookupParams("", ""), {});
});

test("buildStockMovementBody: sempre inclui tipo/quantidade/precoUnitario (obrigatórios no schema real da v3)", () => {
  const body = buildStockMovementBody({ tipo: "E", quantidade: 5, precoUnitario: 0 });
  assert.equal(body.tipo, "E");
  assert.equal(body.quantidade, 5);
  assert.equal(body.precoUnitario, 0);
  assert.equal("deposito" in body, false);
});

test("buildStockMovementBody: deposito vira objeto {id: number}, nunca string solta", () => {
  const body = buildStockMovementBody({ tipo: "E", quantidade: 1, precoUnitario: 10.5, depositoId: "42" });
  assert.deepEqual(body.deposito, { id: 42 });
});

test("buildStockMovementBody: observacoes só aparece quando informada", () => {
  const withObs = buildStockMovementBody({ tipo: "E", quantidade: 1, precoUnitario: 0, observacoes: "teste" });
  assert.equal(withObs.observacoes, "teste");
  const withoutObs = buildStockMovementBody({ tipo: "E", quantidade: 1, precoUnitario: 0 });
  assert.equal("observacoes" in withoutObs, false);
});

test("summarizeLaunchResults: allSucceeded só é true quando NENHUM item falhou", () => {
  const allOk = summarizeLaunchResults([
    { sourceId: "1", status: "success" },
    { sourceId: "2", status: "skipped_already_done" },
  ]);
  assert.equal(allOk.allSucceeded, true);
  assert.equal(allOk.succeeded, 1);
  assert.equal(allOk.alreadyDone, 1);

  const mixed = summarizeLaunchResults([
    { sourceId: "1", status: "success" },
    { sourceId: "2", status: "failed", error: "erro X" },
  ]);
  assert.equal(mixed.allSucceeded, false);
  assert.equal(mixed.failed, 1);
});

test("summarizeLaunchResults: lista vazia nunca conta como sucesso total (nada foi de fato lançado)", () => {
  const empty = summarizeLaunchResults([]);
  assert.equal(empty.allSucceeded, false);
  assert.equal(empty.total, 0);
});

test("buildTokenRefreshBody: grant_type refresh_token com os 3 campos reais exigidos pelo Tiny", () => {
  const body = buildTokenRefreshBody({ clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken" });
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("client_id"), "cid");
  assert.equal(body.get("client_secret"), "csecret");
  assert.equal(body.get("refresh_token"), "rtoken");
});

test("isValidTinyIntegrationAction aceita só as 4 ações reais do dispatcher", () => {
  for (const a of ["test_connection", "list_warehouses", "launch_return_batch", "launch_invoice_receipt"]) {
    assert.equal(isValidTinyIntegrationAction(a), true);
  }
  assert.equal(isValidTinyIntegrationAction("lancar_tudo"), false);
  assert.equal(isValidTinyIntegrationAction(""), false);
  assert.equal(isValidTinyIntegrationAction(undefined), false);
});
