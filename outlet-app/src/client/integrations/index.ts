// Barril do módulo de integrações (ver pedido, seção 20). Ponto único de
// resolução: quem consome nunca importa um adaptador específico direto,
// sempre passa por getMarketplaceProvider/getTinyProvider — assim trocar a
// implementação futuramente (quando houver credenciais reais) não exige
// mexer em nenhuma tela.
import type { Marketplace } from "../returnsApi.ts";
import type { MarketplaceProvider, TinyProvider } from "./types.ts";
import { mercadoLivreProvider } from "./marketplaceProviders/mercadoLivreProvider.ts";
import { shopeeProvider } from "./marketplaceProviders/shopeeProvider.ts";
import { sheinProvider } from "./marketplaceProviders/sheinProvider.ts";
import { amazonProvider } from "./marketplaceProviders/amazonProvider.ts";
import { tiktokProvider } from "./marketplaceProviders/tiktokProvider.ts";
import { genericMarketplaceProvider } from "./marketplaceProviders/genericMarketplaceProvider.ts";
import { tinyProvider } from "./tinyProvider.ts";

export * from "./types.ts";
export * from "./idempotency.ts";
export * from "./featureFlags.ts";

const MARKETPLACE_PROVIDERS: Record<Marketplace, MarketplaceProvider> = {
  mercado_livre: mercadoLivreProvider,
  shopee: shopeeProvider,
  shein: sheinProvider,
  amazon: amazonProvider,
  tiktok: tiktokProvider,
  outro: genericMarketplaceProvider,
};

/** Nunca retorna null/undefined — mesmo "Outro" resolve pro adaptador genérico, sempre inerte (ver pedido, seção 20.11: nunca deixar a tela travada por falta de configuração). */
export function getMarketplaceProvider(marketplace: Marketplace): MarketplaceProvider {
  return MARKETPLACE_PROVIDERS[marketplace] ?? genericMarketplaceProvider;
}

export function getTinyProvider(): TinyProvider {
  return tinyProvider;
}
