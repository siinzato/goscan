import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient.ts";

// EXPANSÃO GOSCAN — 4 papéis reais pós-migration 0027: "admin" (antigo) virou
// "super_admin", "manager" (antigo) virou "admin" — ver
// supabase/migrations/0027_profile_role_expansion.sql pro remapeamento de
// dados sem regressão (mesmos usuários reais continuam nos mesmos dois
// níveis de privilégio, is_admin()/is_manager_or_admin() em nome idêntico).
export type Role = "super_admin" | "admin" | "operator" | "viewer";

export interface Profile {
  id: string;
  full_name: string | null;
  role: Role;
  active: boolean;
  job_title: string | null;
  work_group: string | null;
  phone: string | null;
  recovery_email: string | null;
  recovery_email_verified: boolean;
  theme: "light" | "dark";
  must_change_password: boolean;
  last_login_at: string | null;
  /** CORREÇÃO ESTRUTURAL — empresa à qual este usuário pertence (ver 0037_companies.sql); fonte real de compartilhamento de NFs/conferências. */
  company_id: string;
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

// CORREÇÃO ESTRUTURAL — condição de corrida real no fluxo de troca de senha
// obrigatória (Parte 14 do pedido). CAUSA RAIZ: supabase.auth.updateUser()
// dispara internamente um evento onAuthStateChange("USER_UPDATED") ANTES da
// própria chamada retornar — o listener registrado em initAuth() reage a
// TODO evento chamando applySession(), que busca o perfil (ainda com
// must_change_password=true, porque a RPC de limpeza só roda DEPOIS, dentro
// de updatePassword()). Como applySession() e o refreshProfile() explícito
// de updatePassword() disparam buscas de perfil CONCORRENTES e sem
// coordenação, o setState() que resolve por último "vencia" — se a busca
// disparada pelo evento USER_UPDATED (que pegou o perfil ainda com a flag
// antiga) resolvesse DEPOIS do refreshProfile() (que já pegava a flag
// correta), o estado global regredia pra must_change_password=true de novo,
// prendendo o usuário na tela de troca de senha até um F5 (que refaz tudo
// numa única carga, sem concorrência).
//
// Fix: cada busca de perfil captura um número de sequência ao COMEÇAR: só
// aplica seu resultado via setState() se nenhuma busca mais nova tiver
// começado nesse meio-tempo. Como updatePassword() sempre chama
// refreshProfile() DEPOIS de qualquer evento que updateUser() possa ter
// disparado (JS é single-thread — o listener síncrono já rodou e já
// incrementou o contador antes da nossa próxima linha executar), a busca do
// refreshProfile() é sempre a mais recente e sempre vence, não importa a
// ordem em que as respostas de rede realmente cheguem.
let profileLoadSeq = 0;

const PROFILE_COLUMNS =
  "id, full_name, role, active, job_title, work_group, phone, recovery_email, recovery_email_verified, theme, must_change_password, last_login_at, company_id";

async function loadProfile(userId: string): Promise<Profile | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", userId).maybeSingle();
  if (error) {
    console.error("Falha ao carregar perfil:", error.message);
    return null;
  }
  return data as Profile | null;
}

async function applySession(session: Session | null, opts: { expired?: boolean; recordLastLogin?: boolean } = {}): Promise<void> {
  const mySeq = ++profileLoadSeq;
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
  // Uma busca MAIS NOVA já começou enquanto esta estava em andamento (ver
  // comentário de profileLoadSeq acima) — descarta este resultado por
  // inteiro, mesmo que a rede tenha respondido "certinho": aplicá-lo agora
  // regrediria o estado global pra um instantâneo mais antigo do perfil.
  if (mySeq !== profileLoadSeq) return;
  if (!profile) {
    setState({ status: "signed_out", session, profile: null, error: "Perfil não encontrado para este usuário.", sessionExpired: false });
    return;
  }
  logAuthEvent("profile_loaded", { role: profile.role });
  if (!profile.active) {
    setState({ status: "inactive", session, profile, error: null, sessionExpired: false });
    return;
  }
  // "Últimos acessos" do painel administrativo — só grava numa sessão nova
  // de verdade (boot ou SIGNED_IN explícito), nunca a cada renovação
  // silenciosa de token (TOKEN_REFRESHED dispararia isto várias vezes por
  // hora à toa). Fire-and-forget: nunca atrasa nem derruba o login por causa
  // disso — é só exibição, não uma trilha de auditoria de segurança.
  if (opts.recordLastLogin) {
    void getSupabase()
      .from("profiles")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", session.user.id)
      .then(({ error: e }) => {
        if (e) console.error("Falha ao registrar last_login_at:", e.message);
      });
  }
  setState({ status: "signed_in", session, profile, error: null, sessionExpired: false });
}

/**
 * Recarrega o perfil do usuário logado e notifica os assinantes — usado
 * depois de uma edição em "Minha conta"/troca de senha pra refletir a
 * mudança na UI sem precisar de F5 (ver regra explícita do pedido).
 */
export async function refreshProfile(): Promise<void> {
  if (!state.session) return;
  const mySeq = ++profileLoadSeq;
  const profile = await loadProfile(state.session.user.id);
  // Mesma trava de sequência de applySession() — nunca deixa uma busca mais
  // antiga (ex.: disparada por um onAuthStateChange concorrente) sobrescrever
  // o resultado desta, que é sempre a mais recente no fluxo de troca de senha.
  if (mySeq !== profileLoadSeq) return;
  if (profile) setState({ profile });
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
    await withBootTimeout(applySession(data.session, { recordLastLogin: true }));
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
      void applySession(session, { expired: event === "SIGNED_OUT", recordLastLogin: event === "SIGNED_IN" });
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

/**
 * Garante que o access_token da sessão atual não expira nos próximos
 * segundos — chamado antes de operações que usam o cliente Supabase
 * diretamente (Storage, tabelas), que não passam pelo retry-com-refresh do
 * backendAuthClient.ts. Sem isso, uma ação que começa logo depois da aba
 * voltar do segundo plano (ex.: escolher uma foto pra upload) pode correr em
 * paralelo com o refresh silencioso do visibilitychange (mais abaixo) e
 * perder a corrida, batendo num token já expirado no meio da operação —
 * exatamente o "exp claim timestamp check failed" visto no upload manual.
 */
export async function ensureFreshSession(): Promise<void> {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return;
  const expiresInMs = (session.expires_at ?? 0) * 1000 - Date.now();
  if (expiresInMs < 60_000) {
    await supabase.auth.refreshSession();
  }
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

/**
 * Toda troca de senha bem-sucedida (tanto pelo link de recuperação em
 * login.ts quanto pelo formulário "Segurança" em Configurações, quanto pela
 * troca obrigatória de primeiro acesso) também limpa must_change_password
 * automaticamente — é o ÚNICO caminho real pra esse flag sair de true (ver
 * clear_own_must_change_password() na migration 0028: só mexe na própria
 * linha do chamador, nunca na de outro usuário).
 *
 * refreshProfile() ao final é o que faz main.ts sair do gate de troca
 * obrigatória e montar o app normal SEM F5 — a senha em si já mudou de
 * verdade no Supabase Auth acima; o que falta é só a UI perceber que
 * must_change_password virou false (ver profileLoadSeq: refreshProfile()
 * aqui é sempre a busca de perfil mais recente, então sempre vence mesmo
 * que updateUser() tenha disparado um onAuthStateChange concorrente com o
 * perfil ainda desatualizado).
 *
 * Nunca finge sucesso total se a flag não foi limpa: tenta 1 retry
 * automático (falha transitória de rede) antes de reportar um erro
 * específico — a senha JÁ mudou nesse ponto, então nunca é "erro
 * desconhecido" nem um loading infinito, é uma mensagem acionável.
 */
export async function updatePassword(newPassword: string): Promise<string | null> {
  const supabase = getSupabase();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return translateAuthError(error.message);

  let clearError = (await supabase.rpc("clear_own_must_change_password")).error;
  if (clearError) {
    clearError = (await supabase.rpc("clear_own_must_change_password")).error;
  }
  await refreshProfile();

  if (clearError) {
    console.error("Falha ao limpar must_change_password após 2 tentativas:", clearError.message);
    return "Sua senha foi alterada, mas houve um problema ao liberar seu acesso. Tente novamente ou saia e entre de novo.";
  }

  return null;
}

export function isManagerOrAdmin(profile: Profile | null): boolean {
  return !!profile && (profile.role === "super_admin" || profile.role === "admin");
}

export function isAdmin(profile: Profile | null): boolean {
  return !!profile && profile.role === "super_admin";
}

function translateAuthError(message: string): string {
  const known: Record<string, string> = {
    "Invalid login credentials": "E-mail ou senha inválidos.",
    "Email not confirmed": "E-mail ainda não confirmado. Verifique sua caixa de entrada.",
  };
  return known[message] || message;
}
