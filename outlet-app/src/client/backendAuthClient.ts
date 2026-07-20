// Helper genérico para chamar rotas privilegiadas do backend (Catálogo
// Visual, Modo Scan) passando o access_token da sessão atual — o backend
// revalida esse token e o papel (manager/admin) antes de fazer qualquer
// coisa (ver src/server/supabaseAdmin.ts). Extraído de catalogImagesBackendClient.ts
// para ser reaproveitado pelo Modo Scan sem duplicar a lógica de refresh.
import { getSupabase } from "./supabaseClient.ts";

// Lotes longos (dezenas de chamadas em sequência) são tempo suficiente para
// o access_token expirar no meio do processo. getSession() sozinho não
// garante um token fresco: se expirou, forçamos um refreshSession() antes de
// montar a requisição, e se mesmo assim o backend responder 401 (ex.: token
// revogado em outra aba), tentamos renovar e reenviar uma única vez antes de
// desistir.
async function getFreshAccessToken(forceRefresh: boolean): Promise<string> {
  const supabase = getSupabase();
  if (forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) return data.session.access_token;
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Sessão inválida — faça login novamente.");

  const expiresInMs = (session.expires_at ?? 0) * 1000 - Date.now();
  if (expiresInMs < 60_000) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) return data.session.access_token;
  }
  return session.access_token;
}

async function requestOnce(path: string, method: string, body: unknown, accessToken: string): Promise<{ resp: Response; data: unknown }> {
  const resp = await fetch(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

async function authedRequest<T>(path: string, method: string, body: unknown): Promise<T> {
  const token = await getFreshAccessToken(false);
  let { resp, data } = await requestOnce(path, method, body, token);

  if (resp.status === 401) {
    const retryToken = await getFreshAccessToken(true);
    ({ resp, data } = await requestOnce(path, method, body, retryToken));
  }

  if (!resp.ok) throw new Error((data as { error?: string })?.error || `Erro ${resp.status} ao chamar ${path}`);
  return data as T;
}

export function authedPost<T>(path: string, body?: unknown): Promise<T> {
  return authedRequest<T>(path, "POST", body);
}

export function authedGet<T>(path: string): Promise<T> {
  return authedRequest<T>(path, "GET", undefined);
}
