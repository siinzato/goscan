// Adaptador Tiny/Olist ERP — inerte nesta etapa (sem credenciais
// configuradas ainda). Nunca simula sucesso, nunca lança uma movimentação de
// verdade (ver pedido, seção 20.9) — todo método responde "não configurado".
import type { TinyProvider } from "./types.ts";
import { notConfigured } from "./shared.ts";

const MSG = "Integração com Tiny/Olist ainda não configurada.";

export const tinyProvider: TinyProvider = {
  key: "tiny",
  async validateConnection() {
    return notConfigured(MSG);
  },
  async findProduct() {
    return notConfigured(MSG);
  },
  async getInvoiceStatus() {
    return notConfigured(MSG);
  },
  async hasStockChargeback() {
    return notConfigured(MSG);
  },
  async listWarehouses() {
    return notConfigured(MSG);
  },
  async getWarehouseBalance() {
    return notConfigured(MSG);
  },
  async sendStockMovement() {
    return notConfigured(MSG);
  },
  async getMovementResult() {
    return notConfigured(MSG);
  },
};
