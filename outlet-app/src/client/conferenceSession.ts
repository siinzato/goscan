// Camada de orquestração: liga conferencesApi (Supabase) + offline.ts (fila local)
// + matching.ts, expondo o ciclo "iniciar/retomar -> adicionar item -> salvar
// (com estado visível) -> finalizar" que a UI consome.
import * as api from "./conferencesApi.ts";
import * as offline from "./offline.ts";
import { localId } from "./utils.ts";
import type { ItemMatchStatus, ItemSource } from "./conferencesApi.ts";

export type SyncState = "saving" | "saved" | "error" | "pending_offline";

export interface SessionItem {
  uiId: string; // tempId (ainda não sincronizado) ou o id real do servidor
  serverId: string | null;
  product_variant_id: string | null;
  sku_code: string | null;
  produto: string | null;
  raw_model: string;
  raw_color: string;
  quantity: number;
  match_status: ItemMatchStatus;
  source: ItemSource;
  syncState: SyncState;
  errorMessage: string | null;
}

export interface Session {
  conference: api.Conference;
  items: SessionItem[];
}

type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();
let session: Session | null = null;

function emit() {
  listeners.forEach((l) => l(session));
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  listener(session);
  return () => listeners.delete(listener);
}

export function getSession(): Session | null {
  return session;
}

function applyPendingQueueOnTop(conferenceId: string, items: SessionItem[]): SessionItem[] {
  const queue = offline.loadQueue(conferenceId);
  const result = [...items];
  for (const op of queue) {
    if (op.op === "create" && op.payload) {
      result.push({
        uiId: op.tempId,
        serverId: null,
        product_variant_id: op.payload.product_variant_id,
        sku_code: null,
        produto: null,
        raw_model: op.payload.raw_model,
        raw_color: op.payload.raw_color,
        quantity: op.payload.quantity,
        match_status: op.payload.match_status,
        source: op.payload.source,
        syncState: op.lastError ? "error" : "pending_offline",
        errorMessage: op.lastError,
      });
    }
    if (op.op === "delete" && op.targetId) {
      const idx = result.findIndex((r) => r.serverId === op.targetId);
      if (idx >= 0) result.splice(idx, 1);
    }
    // "update" pendente: marcações visuais adicionais poderiam ser feitas aqui;
    // mantido simples nesta fase — updates são pouco frequentes (correção manual de SKU).
  }
  return result;
}

export async function startOrResumeConference(): Promise<Session> {
  const existing = await api.getMyActiveConference();
  const conference = existing || (await api.createConference());
  const { items } = existing ? await api.getConference(conference.id) : { items: [] };

  const baseItems: SessionItem[] = items.map((it) => ({
    uiId: it.id,
    serverId: it.id,
    product_variant_id: it.product_variant_id,
    sku_code: null,
    produto: null,
    raw_model: it.raw_model || "",
    raw_color: it.raw_color || "",
    quantity: it.quantity,
    match_status: it.match_status,
    source: it.source,
    syncState: "saved",
    errorMessage: null,
  }));

  session = { conference, items: applyPendingQueueOnTop(conference.id, baseItems) };
  emit();
  void flushPendingQueue();
  return session;
}

export async function addItem(input: {
  product_variant_id: string | null;
  raw_model: string;
  raw_color: string;
  quantity: number;
  match_status: ItemMatchStatus;
  source: ItemSource;
}): Promise<void> {
  if (!session) throw new Error("Nenhuma conferência ativa.");
  const conferenceId = session.conference.id;
  const tempId = localId();

  const uiItem: SessionItem = {
    uiId: tempId,
    serverId: null,
    ...input,
    sku_code: null,
    produto: null,
    syncState: "saving",
    errorMessage: null,
  };
  session = { ...session, items: [...session.items, uiItem] };
  emit();

  offline.enqueue(conferenceId, {
    tempId,
    op: "create",
    targetId: null,
    payload: input,
    clientTimestamp: Date.now(),
  });

  if (session.conference.status === "draft") {
    try {
      await api.markInProgress(conferenceId);
      session = { ...session, conference: { ...session.conference, status: "in_progress" } };
    } catch {
      /* segue tentando salvar o item mesmo se essa transição falhar agora */
    }
  }

  await trySaveOp(conferenceId, tempId);
}

async function trySaveOp(conferenceId: string, tempId: string): Promise<void> {
  const queue = offline.loadQueue(conferenceId);
  const op = queue.find((o) => o.tempId === tempId);
  if (!op) return;

  try {
    if (op.op === "create" && op.payload) {
      const saved = await api.addItem({ conference_id: conferenceId, ...op.payload });
      offline.removeFromQueue(conferenceId, tempId);
      if (session) {
        session = {
          ...session,
          items: session.items.map((it) =>
            it.uiId === tempId
              ? { ...it, uiId: saved.id, serverId: saved.id, syncState: "saved", errorMessage: null }
              : it
          ),
        };
        emit();
      }
    } else if (op.op === "delete" && op.targetId) {
      await api.removeItem(op.targetId);
      offline.removeFromQueue(conferenceId, tempId);
    }
    offline.setSynced();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    offline.markOpError(conferenceId, tempId, message);
    offline.setSyncError();
    if (session) {
      session = {
        ...session,
        items: session.items.map((it) => (it.uiId === tempId ? { ...it, syncState: "error", errorMessage: message } : it)),
      };
      emit();
    }
  }
}

/** Ajusta a quantidade de um item já na conferência (stepper +/- no card mobile). */
export async function updateItemQuantity(uiId: string, quantity: number): Promise<void> {
  if (!session || quantity < 1) return;
  const item = session.items.find((it) => it.uiId === uiId);
  if (!item) return;
  const conferenceId = session.conference.id;

  session = {
    ...session,
    items: session.items.map((it) => (it.uiId === uiId ? { ...it, quantity, syncState: "saving" } : it)),
  };
  emit();

  if (!item.serverId) {
    // ainda nem foi confirmado salvo: só atualiza o payload da operação de create pendente.
    const queue = offline.loadQueue(conferenceId);
    const op = queue.find((o) => o.tempId === uiId);
    if (op && op.payload) {
      offline.removeFromQueue(conferenceId, uiId);
      offline.enqueue(conferenceId, { ...op, payload: { ...op.payload, quantity } });
    }
    if (session) {
      session = { ...session, items: session.items.map((it) => (it.uiId === uiId ? { ...it, syncState: "pending_offline" } : it)) };
      emit();
    }
    return;
  }

  try {
    await api.updateItem(item.serverId, { quantity });
    if (session) {
      session = { ...session, items: session.items.map((it) => (it.uiId === uiId ? { ...it, syncState: "saved", errorMessage: null } : it)) };
      emit();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (session) {
      session = { ...session, items: session.items.map((it) => (it.uiId === uiId ? { ...it, syncState: "error", errorMessage: message } : it)) };
      emit();
    }
  }
}

export async function removeItem(uiId: string): Promise<void> {
  if (!session) return;
  const item = session.items.find((it) => it.uiId === uiId);
  if (!item) return;
  const conferenceId = session.conference.id;

  session = { ...session, items: session.items.filter((it) => it.uiId !== uiId) };
  emit();

  if (item.serverId) {
    const tempId = localId();
    offline.enqueue(conferenceId, {
      tempId,
      op: "delete",
      targetId: item.serverId,
      payload: null,
      clientTimestamp: Date.now(),
    });
    await trySaveOp(conferenceId, tempId);
  } else {
    // item ainda nem tinha sido confirmado salvo: só remove a operação de create pendente da fila.
    offline.removeFromQueue(conferenceId, uiId);
  }
}

/** Tenta sincronizar tudo que ficou pendente (reconexão, retry manual, ao retomar). */
export async function flushPendingQueue(): Promise<{ ok: number; failed: number }> {
  if (!session) return { ok: 0, failed: 0 };
  const conferenceId = session.conference.id;
  if (!navigator.onLine) return { ok: 0, failed: offline.loadQueue(conferenceId).length };

  offline.setSyncing();
  const queue = offline.loadQueue(conferenceId);
  let ok = 0;
  let failed = 0;
  for (const op of queue) {
    const before = offline.loadQueue(conferenceId).some((o) => o.tempId === op.tempId);
    if (!before) continue;
    await trySaveOp(conferenceId, op.tempId);
    const stillThere = offline.loadQueue(conferenceId).some((o) => o.tempId === op.tempId);
    if (stillThere) failed++;
    else ok++;
  }
  if (failed === 0) offline.setSynced();
  return { ok, failed };
}

export interface FinalizeOutcome {
  ok: boolean;
  reason?: string;
  totals?: api.FinalizeSummary;
}

export async function finalize(): Promise<FinalizeOutcome> {
  if (!session) return { ok: false, reason: "Nenhuma conferência ativa." };
  const { failed } = await flushPendingQueue();
  if (failed > 0) {
    return { ok: false, reason: `${failed} item(ns) ainda não foram salvos no servidor. Tente novamente com conexão.` };
  }
  const totals = await api.finalizeConference(session.conference.id);
  session = {
    ...session,
    conference: { ...session.conference, status: "completed", finished_at: new Date().toISOString(), ...totals },
  };
  emit();
  return { ok: true, totals };
}

window.addEventListener("online", () => {
  void flushPendingQueue();
});
