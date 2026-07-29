// CORREÇÃO ESTRUTURAL — Conferência colaborativa em tempo real.
//
// Módulo genérico de colaboração via Supabase Realtime (postgres_changes +
// presence), reutilizado por nfeConference.ts e conference.ts: quando dois
// usuários da mesma empresa estão na mesma NF/conferência, cada bipagem de
// um aparece pro outro sem F5.
//
// Singleton (mesmo padrão de conferenceSession.ts): só existe UMA sessão de
// colaboração ativa por vez. Entrar numa nova (topicKey diferente) encerra
// a anterior automaticamente — nunca acumula subscriptions duplicadas, e a
// tela que sai (rota trocada) SEMPRE deve chamar stopCollabSession() no seu
// teardown (mesmo padrão de teardownScan em shell.ts).
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";
import type { RealtimeChannel } from "@supabase/supabase-js";

// EXPANSÃO GOSCAN — Conferência Colaborativa Segura (seção 6 do pedido):
// "counting" = ativamente bipando/interagindo agora; "online" = com a tela
// aberta mas sem ação recente; "paused" = aba em segundo plano
// (visibilitychange) — os únicos 3 estados que dá pra reportar de forma
// HONESTA e auto-relatada. "Desconectado"/"temporariamente sem conexão" pra
// OUTROS participantes não é um 4º estado fabricado aqui: é o próprio evento
// de presence "leave" do Supabase (o participante simplesmente some da lista
// depois do timeout nativo do Presence) — inventar um heartbeat paralelo só
// pra fingir um estado intermediário mais preciso adicionaria complexidade
// sem um sinal mais confiável do que o que o Presence já garante.
export type PresenceStatus = "online" | "counting" | "paused";

// Prioridade pra deduplicar múltiplas conexões simultâneas do MESMO usuário
// (duas abas, ou uma reconexão rápida cuja conexão antiga ainda não expirou)
// sob a mesma presence key — fica só a entrada com o estado mais "ativo".
const PRESENCE_STATUS_RANK: Record<PresenceStatus, number> = { counting: 2, online: 1, paused: 0 };

export interface PresenceUser {
  userId: string;
  fullName: string;
  status: PresenceStatus;
  /** Rótulo curto do produto/volume que este usuário está conferindo agora — nulo quando não aplicável (modo livre) ou parado. */
  currentItemLabel?: string | null;
}

export type ChangeEvent = "INSERT" | "UPDATE" | "DELETE";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TableWatch<T = any> {
  table: string;
  /** Filtro no formato do Realtime, ex.: `receipt_id=eq.<uuid>`. */
  filter: string;
  onChange: (row: T, eventType: ChangeEvent) => void;
}

export interface CollabOptions {
  /** Lista COMPLETA de quem está com esta mesma tela aberta agora (inclusive você mesmo). */
  onPresenceChange?: (users: PresenceUser[]) => void;
  /** Reconectou depois de ficar OFFLINE — bom momento pra um toast discreto "sincronizado novamente". */
  onReconnect?: () => void;
  /** Caiu a conexão em tempo real — feedback visual discreto ("sincronizando…"), nunca bloqueia a tela. */
  onDisconnected?: () => void;
  /** Mensagem efêmera de outro participante (nunca persistida) — ex.: "Davi pediu colaboração no item X". */
  onBroadcast?: (type: string, data: Record<string, unknown>) => void;
}

export interface CollabSession {
  stop(): void;
}

interface ActiveSession {
  key: string;
  channel: RealtimeChannel;
  myState: Omit<PresenceUser, "userId" | "fullName">;
}

let active: ActiveSession | null = null;

/**
 * Entra numa sessão de colaboração: assina mudanças de uma ou mais tabelas
 * (cada uma com seu próprio filtro, ex.: `receipt_id=eq.<uuid>`) + presença
 * de quem mais está na mesma tela. `topicKey` identifica a sessão (ex.:
 * `nfe-receipt:<uuid>`) — chamar de novo com uma key diferente da atual
 * encerra a anterior sozinho; chamar de novo com a MESMA key é um no-op
 * (evita recriar a subscription a cada re-render da mesma tela).
 */
export function joinCollabSession(topicKey: string, watches: TableWatch[], opts: CollabOptions = {}): CollabSession {
  if (active && active.key === topicKey) {
    return { stop: stopCollabSession };
  }
  stopCollabSession();

  const supabase = getSupabase();
  const { profile, session: authSession } = getAuthState();
  const userId = authSession?.user.id ?? "anon";
  const fullName = profile?.full_name || "Alguém";

  const channel = supabase.channel(`collab:${topicKey}`, {
    config: { presence: { key: userId } },
  });

  for (const watch of watches) {
    channel.on(
      "postgres_changes" as never,
      { event: "*", schema: "public", table: watch.table, filter: watch.filter } as never,
      (payload: { eventType: ChangeEvent; new: unknown; old: unknown }) => {
        const row = payload.eventType === "DELETE" ? payload.old : payload.new;
        watch.onChange(row, payload.eventType);
      }
    );
  }

  if (opts.onBroadcast) {
    channel.on("broadcast", { event: "collab-signal" }, (msg: { payload: { type: string; data: Record<string, unknown> } }) => {
      opts.onBroadcast?.(msg.payload.type, msg.payload.data);
    });
  }

  channel.on("presence", { event: "sync" }, () => {
    const state = channel.presenceState<{ userId: string; fullName: string; status: PresenceStatus; currentItemLabel?: string | null }>();
    const byUser = new Map<string, PresenceUser>();
    for (const metas of Object.values(state)) {
      for (const p of metas) {
        const candidate: PresenceUser = { userId: p.userId, fullName: p.fullName, status: p.status ?? "online", currentItemLabel: p.currentItemLabel ?? null };
        const existing = byUser.get(p.userId);
        if (!existing || PRESENCE_STATUS_RANK[candidate.status] > PRESENCE_STATUS_RANK[existing.status]) {
          byUser.set(p.userId, candidate);
        }
      }
    }
    opts.onPresenceChange?.(Array.from(byUser.values()));
  });

  const myState: Omit<PresenceUser, "userId" | "fullName"> = { status: "online", currentItemLabel: null };

  let everConnected = false;
  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      if (everConnected) opts.onReconnect?.();
      everConnected = true;
      await channel.track({ userId, fullName, ...myState });
      return;
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      opts.onDisconnected?.();
    }
  });

  active = { key: topicKey, channel, myState };

  // Aba em segundo plano = "paused" (auto-relatado, honesto); volta a
  // "online" ao reaparecer, preservando o que a tela já tiver marcado como
  // currentItemLabel (nunca sobrescreve o produto/volume em andamento).
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return { stop: stopCollabSession };
}

function handleVisibilityChange(): void {
  if (!active) return;
  updateMyPresenceState({ status: document.visibilityState === "visible" ? "online" : "paused" });
}

/**
 * Atualiza o próprio estado de presença (status/produto atual) sem recriar a
 * subscription — usado quando o operador começa/para de contar um item
 * específico (ver nfeConference.ts). Idempotente/seguro chamar sem sessão ativa.
 */
export function updateMyPresenceState(patch: { status?: PresenceStatus; currentItemLabel?: string | null }): void {
  if (!active) return;
  active.myState = { ...active.myState, ...patch };
  const { profile, session: authSession } = getAuthState();
  const userId = authSession?.user.id ?? "anon";
  const fullName = profile?.full_name || "Alguém";
  void active.channel.track({ userId, fullName, ...active.myState });
}

/** Envia um sinal efêmero (nunca persistido) pros demais participantes da sessão ativa — ex.: "pedido de colaboração". Sem sessão ativa, é um no-op silencioso. */
export function sendBroadcast(type: string, data: Record<string, unknown> = {}): void {
  if (!active) return;
  void active.channel.send({ type: "broadcast", event: "collab-signal", payload: { type, data } });
}

/** Encerra a sessão de colaboração ativa (se houver) — idempotente, seguro chamar mesmo sem sessão ativa. */
export function stopCollabSession(): void {
  if (!active) return;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  const { channel } = active;
  active = null;
  void getSupabase().removeChannel(channel);
}
