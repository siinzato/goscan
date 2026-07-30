// Adaptador Mercado Livre — inerte nesta etapa (sem credenciais configuradas
// ainda). Nunca simula sucesso; todo método responde "não configurado" de
// forma honesta (ver pedido, seção 20).
import type { MarketplaceProvider } from "../types.ts";
import { notConfigured } from "../shared.ts";

const MSG = "Integração com Mercado Livre ainda não configurada.";

export const mercadoLivreProvider: MarketplaceProvider = {
  key: "marketplace_mercado_livre",
  async validateConnection() {
    return notConfigured(MSG);
  },
  async lookupOrder() {
    return notConfigured(MSG);
  },
  async lookupPackage() {
    return notConfigured(MSG);
  },
  async getReturnStatus() {
    return notConfigured(MSG);
  },
  async getReturnReason() {
    return notConfigured(MSG);
  },
  async registerWebhookEvent() {
    return notConfigured(MSG);
  },
  async syncUpdates() {
    return notConfigured(MSG);
  },
};
