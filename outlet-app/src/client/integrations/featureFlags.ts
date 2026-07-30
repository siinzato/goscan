// Leitura das feature flags de integração (todas desligadas por padrão — ver
// migration 0049). Cache de sessão simples: uma tela que só precisa checar
// "está habilitado?" várias vezes não bate no banco repetidamente. Falha de
// rede/RLS nunca trava a UI — sempre assume desabilitado (fail-safe).
import { getSupabase } from "../supabaseClient.ts";

let cache: Map<string, boolean> | null = null;
let inflight: Promise<Map<string, boolean>> | null = null;

async function loadFlags(): Promise<Map<string, boolean>> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("integration_feature_flags").select("key, enabled");
  const map = new Map<string, boolean>();
  if (error) {
    console.error("[integrations] falha ao carregar feature flags, assumindo tudo desabilitado:", error.message);
    return map;
  }
  for (const row of (data as { key: string; enabled: boolean }[]) || []) {
    map.set(row.key, row.enabled);
  }
  return map;
}

export async function isIntegrationFeatureEnabled(key: string): Promise<boolean> {
  if (!cache) {
    inflight = inflight ?? loadFlags();
    cache = await inflight;
    inflight = null;
  }
  return cache.get(key) ?? false;
}

export function invalidateFeatureFlagsCache(): void {
  cache = null;
}
