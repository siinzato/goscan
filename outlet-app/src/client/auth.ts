import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient.ts";

export type Role = "admin" | "manager" | "operator";

export interface Profile {
  id: string;
  full_name: string | null;
  role: Role;
  active: boolean;
}

export type AuthStatus = "loading" | "signed_out" | "signed_in" | "inactive";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  profile: Profile | null;
  error: string | null;
}

type Listener = (state: AuthState) => void;

let state: AuthState = { status: "loading", session: null, profile: null, error: null };
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

async function loadProfile(userId: string): Promise<Profile | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, active")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("Falha ao carregar perfil:", error.message);
    return null;
  }
  return data as Profile | null;
}

async function applySession(session: Session | null) {
  if (!session) {
    setState({ status: "signed_out", session: null, profile: null, error: null });
    return;
  }
  const profile = await loadProfile(session.user.id);
  if (!profile) {
    setState({ status: "signed_out", session, profile: null, error: "Perfil não encontrado para este usuário." });
    return;
  }
  if (!profile.active) {
    setState({ status: "inactive", session, profile, error: null });
    return;
  }
  setState({ status: "signed_in", session, profile, error: null });
}

/** Deve ser chamado uma vez, no boot da aplicação, antes de renderizar qualquer tela protegida. */
export async function initAuth(): Promise<void> {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  await applySession(data.session);
  supabase.auth.onAuthStateChange((_event, session) => {
    void applySession(session);
  });
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return translateAuthError(error.message);
  return null;
}

export async function signOut(): Promise<void> {
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
