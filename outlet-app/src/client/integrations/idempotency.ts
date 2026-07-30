// Chave de idempotência determinística pra futura movimentação de estoque no
// Tiny (ver pedido, seção 20.7) — função pura, testável, sem nenhuma chamada
// de rede. Formato conceitual do pedido:
// DEVOLUCAO:{id}:ITEM:{id}:ENTRADA_ESTOQUE:{deposito}

export interface StockMovementIdempotencyParts {
  returnId: string;
  returnItemId: string;
  warehouse: string;
}

export function buildStockMovementIdempotencyKey(parts: StockMovementIdempotencyParts): string {
  const warehouseKey = parts.warehouse.trim().toUpperCase().replace(/\s+/g, "_");
  return `DEVOLUCAO:${parts.returnId}:ITEM:${parts.returnItemId}:ENTRADA_ESTOQUE:${warehouseKey}`;
}
