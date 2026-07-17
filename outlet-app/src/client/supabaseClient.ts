import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Optional chaining on import.meta.env: in the built app (Vite) it's always
// defined; the fallback only matters when this module is imported outside
// Vite (e.g. plain Node running unit tests against other exports of a
// sibling module), where import.meta.env doesn't exist at all.
const url = import.meta.env?.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined;

export class MissingSupabaseConfigError extends Error {
  constructor() {
    super(
      "Configuração do Supabase ausente. Crie um arquivo .env (veja .env.example) com " +
        "VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY e reinicie o servidor de desenvolvimento."
    );
    this.name = "MissingSupabaseConfigError";
  }
}

export function hasSupabaseConfig(): boolean {
  return Boolean(url && anonKey);
}

let client: SupabaseClient | null = null;

/** Lança MissingSupabaseConfigError com uma mensagem amigável se as env vars não estiverem definidas. */
export function getSupabase(): SupabaseClient {
  if (!hasSupabaseConfig()) {
    throw new MissingSupabaseConfigError();
  }
  if (!client) {
    client = createClient(url as string, anonKey as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}
