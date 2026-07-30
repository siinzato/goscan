// Adaptador genérico usado quando o marketplace é "Outro" (sem um adaptador
// dedicado) — sempre inerte, nunca finge suportar uma plataforma específica.
import type { MarketplaceProvider } from "../types.ts";
import { notConfigured } from "../shared.ts";

const MSG = "Este marketplace não possui integração disponível.";

export const genericMarketplaceProvider: MarketplaceProvider = {
  key: "marketplace_outro",
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
