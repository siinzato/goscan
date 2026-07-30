// Adaptador TikTok Shop — inerte nesta etapa (sem credenciais configuradas
// ainda). Nunca simula sucesso; todo método responde "não configurado" de
// forma honesta (ver pedido, seção 20).
import type { MarketplaceProvider } from "../types.ts";
import { notConfigured } from "../shared.ts";

const MSG = "Integração com TikTok Shop ainda não configurada.";

export const tiktokProvider: MarketplaceProvider = {
  key: "marketplace_tiktok",
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
