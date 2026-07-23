import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient.ts";

export type Role = "admin" | "manager" | "operator";

export interface Profile {
  id: string;
  full_name: string | null;
  role: Role;
  active: boolean;
}

// "initializing": validando sessão/perfil no boot — nunca dura mais que
// BOOT_TIMEOUT_MS (ver initAuth) antes de virar "error". "error": o boot não
// terminou a tempo ou falhou de um jeito que não é simplesmente "sem sessão"
// — precisa de uma ação explícita do usuário (tentar de novo / voltar ao
// login), nunca fica preso num "Carregando…" para sempre.
export type AuthStatus = "initializing" | "signed_out" | "signed_in" | "inactive" | "error";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  profile: Profile | null;
  error: string | null;
  /** true quando o "signed_out" veio de uma sessão que expirou/foi invalidada (não um logout explícito do usuário) — main.ts usa isso pra decidir a mensagem certa. */
  sessionExpired: boolean;
  /** etapa real do boot, só pra exibição ("Validando sessão…"/"Carregando perfil…") — nunca inventada, sempre reflete o passo em andamento. */
  bootStep: string;
}

type Listener = (state: AuthState) => void;

let state: AuthState = { status: "initializing", session: null, profile: null, error: null, sessionExpired: false, bootStep: "Validando sessão…" };
const listeners = new Set<Listener>();

function setState(patch: Partial<AuthState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function getAuthState(): AuthState {
  return state;
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

// Logs estruturados do ciclo de vida da autenticação — nunca inclui senha,
// token completo ou dado sensível, só o nome do evento e metadados mínimos.
// Ajuda a responder "por que esse usuário ficou preso no carregamento" sem
// precisar reproduzir o bug ao vivo.
function logAuthEvent(event: string, meta?: Record<string, unknown>): void {
  console.info(`[auth] ${event}`, meta ?? "");
}

/** Marcado true só durante uma chamada explícita a signOut() — diferencia um
 * SIGNED_OUT "pedido pelo usuário" de um SIGNED_OUT causado por expiração/
 * falha de refresh do token (que dispara o mesmo evento no supabase-js). */
let manualSignOutInFlight = false;

async function loadProfile(userId: string): Promise<Profile | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("profiles").select("id, full_name, role, active").eq("id", userId).maybeSingle();
  if (error) {
    console.error("Falha ao carregar perfil:", error.message);
    return null;
  }
  return data as Profile | null;
}

async function applySession(session: Session | null, opts: { expired?: boolean } = {}): Promise<void> {
  if (!session) {
    const expired = !!opts.expired && !manualSignOutInFlight;
    if (expired) logAuthEvent("session_expired");
    setState({
      status: "signed_out",
      session: null,
      profile: null,
      error: null,
      sessionExpired: expired,
    });
    manualSignOutInFlight = false;
    return;
  }
  setState({ bootStep: "Carregando perfil…" });
  const profile = await loadProfile(session.user.id);
  if (!profile) {
    setState({ status: "signed_out", session, profile: null, error: "Perfil não encontrado para este usuário.", sessionExpired: false });
    return;
  }
  logAuthEvent("profile_loaded", { role: profile.role });
  if (!profile.active) {
    setState({ status: "inactive", session, profile, error: null, sessionExpired: false });
    return;
  }
  setState({ status: "signed_in", session, profile, error: null, sessionExpired: false });
}

const BOOT_TIMEOUT_MS = 10_000;

function withBootTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("BOOT_TIMEOUT")), BOOT_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

let authChangeListenerRegistered = false;

/**
 * Deve ser chamado uma vez, no boot da aplicação, antes de renderizar
 * qualquer tela protegida. Nunca fica pendurado: acima de BOOT_TIMEOUT_MS,
 * assume status "error" (com opção de tentar de novo) em vez de deixar a
 * tela de carregamento presa pra sempre.
 */
export async function initAuth(): Promise<void> {
  logAuthEvent("auth_initialize_started");
  const supabase = getSupabase();

  try {
    const { data } = await withBootTimeout(supabase.auth.getSession());
    logAuthEvent("session_recovered", { hasSession: !!data.session });
    await withBootTimeout(applySession(data.session));
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "BOOT_TIMEOUT";
    logAuthEvent("auth_initialize_failed", { timeout: isTimeout, message: err instanceof Error ? err.message : String(err) });
    setState({
      status: "error",
      error: isTimeout ? "Não foi possível concluir o carregamento da sua conta." : "Erro ao validar sua sessão. Tente novamente.",
    });
    return;
  }

  // Guarda contra registro duplicado: se initAuth() por algum motivo for
  // chamado mais de uma vez (ex.: um "tentar novamente" depois de um erro de
  // boot), nunca acumula um segundo listener ouvindo os mesmos eventos.
  if (!authChangeListenerRegistered) {
    authChangeListenerRegistered = true;
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED") logAuthEvent("token_refreshed");
      if (event === "SIGNED_OUT" && !manualSignOutInFlight) logAuthEvent("token_refresh_failed_or_signed_out_elsewhere");
      // event "SIGNED_OUT" cobre tanto logout explícito quanto falha de
      // refresh do token (sessão expirada/revogada) — applySession(null)
      // usa manualSignOutInFlight pra diferenciar a mensagem certa.
      void applySession(session, { expired: event === "SIGNED_OUT" });
    });

    // Mobile/PWA em segundo plano: o timer interno do supabase-js que agenda
    // o refresh automático do token fica CONGELADO enquanto a aba/app está
    // em background (o navegador pausa setTimeout) — ao voltar ao primeiro
    // plano, o token pode já estar expirado e o refresh agendado nunca
    // disparou. Revalidar a sessão explicitamente nesse momento é o que
    // efetivamente corrige o "deslogamento" que só aparece depois de um
    // tempo com o app em segundo plano no celular.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.status === "signed_in") {
        void supabase.auth.getSession();
      }
    });
  }
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return translateAuthError(error.message);
  return null;
}

export async function signOut(): Promise<void> {
  manualSignOutInFlight = true;
  const supabase = getSupabase();
  await supabase.auth.signOut();
}

export async function sendPasswordReset(email: string): Promise<string | null> {
  const supabase = getSupabase();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/`,
  });
  if (error) return translateAuthError(error.message);
  return null;
}

export async function updatePassword(newPassword: string): Promise<string | null> {
  const supabase = getSupabase();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return translateAuthError(error.message);
  return null;
}

export function isManagerOrAdmin(profile: Profile | null): boolean {
  return !!profile && (profile.role === "admin" || profile.role === "manager");
}

export function isAdmin(profile: Profile | null): boolean {
  return !!profile && profile.role === "admin";
}

function translateAuthError(message: string): string {
  const known: Record<string, string> = {
    "Invalid login credentials": "E-mail ou senha inválidos.",
    "Email not confirmed": "E-mail ainda não confirmado. Verifique sua caixa de entrada.",
  };
  return known[message] || message;
}
