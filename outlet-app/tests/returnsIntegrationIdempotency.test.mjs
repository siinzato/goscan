import test from "node:test";
import assert from "node:assert/strict";
import { buildStockMovementIdempotencyKey } from "../src/client/integrations/idempotency.ts";

test("buildStockMovementIdempotencyKey: formato deterministico DEVOLUCAO:{id}:ITEM:{id}:ENTRADA_ESTOQUE:{deposito}", () => {
  const key = buildStockMovementIdempotencyKey({ returnId: "ret-1", returnItemId: "item-1", warehouse: "Depósito Central" });
  assert.equal(key, "DEVOLUCAO:ret-1:ITEM:item-1:ENTRADA_ESTOQUE:DEPÓSITO_CENTRAL");
});

test("buildStockMovementIdempotencyKey: mesmos parametros SEMPRE geram a mesma chave (idempotencia real)", () => {
  const parts = { returnId: "ret-2", returnItemId: "item-9", warehouse: "SP" };
  assert.equal(buildStockMovementIdempotencyKey(parts), buildStockMovementIdempotencyKey({ ...parts }));
});

test("buildStockMovementIdempotencyKey: depositos diferentes (mesmo produto/devolucao) geram chaves diferentes", () => {
  const base = { returnId: "ret-3", returnItemId: "item-3" };
  const keySp = buildStockMovementIdempotencyKey({ ...base, warehouse: "SP" });
  const keyRj = buildStockMovementIdempotencyKey({ ...base, warehouse: "RJ" });
  assert.notEqual(keySp, keyRj);
});

test("buildStockMovementIdempotencyKey: espacos no nome do deposito viram underscore (chave sempre segura pra usar como identificador)", () => {
  const key = buildStockMovementIdempotencyKey({ returnId: "r", returnItemId: "i", warehouse: "Depósito  Zona Sul" });
  assert.ok(!key.includes(" "));
});
