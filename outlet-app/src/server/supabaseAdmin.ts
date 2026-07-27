// Cliente Supabase com service_role — só existe no backend, nunca no bundle
// do navegador. Usado exclusivamente para as operações privilegiadas do
// Catálogo Visual (baixar URL externa, gravar no Storage/produto_images).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface AdminEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(env: AdminEnv): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas no servidor. Veja .env.example."
    );
  }
  if (!cached) {
    cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

// EXPANSÃO GOSCAN — 4 papéis reais pós-migration 0027 (ver
// 0027_profile_role_expansion.sql): "admin" (antigo) virou "super_admin",
// "manager" (antigo) virou "admin" — nomes de função mantidos
// (requireManagerOrAdmin etc.), só o que eles verificam mudou.
export interface CallerProfile {
  id: string;
  role: "super_admin" | "admin" | "operator" | "viewer";
  active: boolean;
}

export type AuthCheckResult = { ok: true; profile: CallerProfile } | { ok: false; status: number; error: string };

/**
 * Valida o Bearer token do chamador contra o Supabase Auth e carrega o
 * perfil correspondente (sem checar role ainda) — base comum de
 * requireManagerOrAdmin e requireActiveUser.
 */
async function requireAuthenticatedProfile(request: Request, env: AdminEnv): Promise<AuthCheckResult> {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "Token de autenticação ausente." };

  const admin = getSupabaseAdmin(env);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    return { ok: false, status: 401, error: "Token inválido ou expirado." };
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, role, active")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) return { ok: false, status: 403, error: "Perfil não encontrado." };
  if (!profile.active) return { ok: false, status: 403, error: "Usuário inativo." };

  return { ok: true, profile: profile as CallerProfile };
}

/**
 * Exige manager/admin ativo. Toda rota privilegiada do Catálogo Visual e do
 * Modo Scan (preparo/administração) passa por aqui antes de tocar em
 * Storage ou nas tabelas — o service_role nunca age "às cegas" a partir de
 * uma requisição não verificada.
 */
export async function requireManagerOrAdmin(request: Request, env: AdminEnv): Promise<AuthCheckResult> {
  const result = await requireAuthenticatedProfile(request, env);
  if (!result.ok) return result;
  if (result.profile.role !== "super_admin" && result.profile.role !== "admin") {
    return { ok: false, status: 403, error: "Ação restrita a administradores." };
  }
  return result;
}

/** Exige super_admin — topo da hierarquia (ver migration 0027). */
export async function requireSuperAdmin(request: Request, env: AdminEnv): Promise<AuthCheckResult> {
  const result = await requireAuthenticatedProfile(request, env);
  if (!result.ok) return result;
  if (result.profile.role !== "super_admin") {
    return { ok: false, status: 403, error: "Ação restrita ao super administrador." };
  }
  return result;
}

/**
 * Exige qualquer usuário ativo (operator/manager/admin) — usado pelo Modo
 * Scan em tempo de conferência, já que quem aponta a câmera é normalmente o
 * operador, não um manager/admin.
 */
export async function requireActiveUser(request: Request, env: AdminEnv): Promise<AuthCheckResult> {
  return requireAuthenticatedProfile(request, env);
}
