// Helper compartilhado só pra construir a resposta "não configurado" de
// forma consistente — nunca contém regra de negócio de nenhum provedor
// específico (isso fica em cada adaptador, ver marketplaceProviders/*.ts).
import type { ProviderResult } from "./types.ts";

export function notConfigured<T>(message: string): ProviderResult<T> {
  return { ok: false, reason: "not_configured", message };
}
