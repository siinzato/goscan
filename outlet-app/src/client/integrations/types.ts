// EXPANSÃO GOSCAN — Módulo Devolução, seção 20 do pedido: contratos
// desacoplados pra futuras integrações com marketplaces e Tiny/Olist. Nada
// aqui faz uma chamada de rede real nesta etapa — cada implementação
// concreta (ver marketplaceProviders/*.ts e tinyProvider.ts) responde
// "não configurado" de forma honesta, nunca finge sucesso.
//
// Regra de ouro (pedido, seção 20): o produto FISICAMENTE bipado continua
// sendo a principal evidência operacional. Uma API futura só AUXILIA
// (preenche dados, sugere), nunca substitui a conferência física nem
// corrige silenciosamente uma divergência — sempre mantém os dois valores e
// exige avaliação humana.

export type IntegrationMode = "manual" | "assisted" | "automated";

export type ProviderResultReason = "not_configured" | "auth_error" | "not_found" | "provider_error";

export interface ProviderResult<T> {
  ok: boolean;
  data?: T;
  reason?: ProviderResultReason;
  message?: string;
}

export interface MarketplaceOrderInfo {
  externalOrderId: string;
  externalPackageId?: string;
  externalReturnId?: string;
  sellerSku?: string;
  ean?: string;
  invoiceNumber?: string;
  invoiceSituation?: string;
  returnReason?: string;
}

/**
 * 1 adaptador por marketplace (ver marketplaceProviders/*.ts) — nunca regra
 * de um marketplace implementada dentro do adaptador de outro, mesmo que a
 * maioria dos métodos comece idêntica (sempre "não configurado").
 */
export interface MarketplaceProvider {
  readonly key: string;
  validateConnection(): Promise<ProviderResult<{ connected: boolean }>>;
  lookupOrder(orderCode: string): Promise<ProviderResult<MarketplaceOrderInfo>>;
  lookupPackage(trackingCode: string): Promise<ProviderResult<MarketplaceOrderInfo>>;
  getReturnStatus(externalReturnId: string): Promise<ProviderResult<{ status: string }>>;
  getReturnReason(externalReturnId: string): Promise<ProviderResult<{ reason: string }>>;
  registerWebhookEvent(payload: unknown): Promise<ProviderResult<void>>;
  syncUpdates(): Promise<ProviderResult<void>>;
}

export interface TinyStockMovementInput {
  productExternalId?: string;
  skuCode: string;
  ean?: string;
  warehouse: string;
  quantity: number;
  movementType: "entrada";
  note?: string;
  referenceReturnBatchId: string;
  idempotencyKey: string;
}

export interface TinyProvider {
  readonly key: "tiny";
  validateConnection(): Promise<ProviderResult<{ connected: boolean }>>;
  findProduct(query: { sku?: string; ean?: string; externalId?: string }): Promise<ProviderResult<{ externalId: string; sku: string }>>;
  getInvoiceStatus(invoiceNumber: string): Promise<ProviderResult<{ cancelled: boolean }>>;
  /** Nunca cria uma entrada duplicada — o fluxo futuro sempre consulta isto ANTES de enviar uma movimentação (ver pedido, seção 20.9). */
  hasStockChargeback(invoiceNumber: string): Promise<ProviderResult<{ chargedBack: boolean }>>;
  listWarehouses(): Promise<ProviderResult<{ id: string; name: string }[]>>;
  getWarehouseBalance(warehouseId: string, sku: string): Promise<ProviderResult<{ balance: number }>>;
  /** Sempre movimentação de ENTRADA — nunca substituição de saldo absoluto (ver pedido, seção 20.9). */
  sendStockMovement(input: TinyStockMovementInput): Promise<ProviderResult<{ externalMovementId: string }>>;
  getMovementResult(externalMovementId: string): Promise<ProviderResult<{ status: string }>>;
}
