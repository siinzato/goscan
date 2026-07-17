// Fila local de operações pendentes por conferência + detecção online/offline.
//
// Estratégia (evita sobrescrever dado mais novo do servidor "silenciosamente"):
// o servidor é sempre a fonte de verdade para o que já foi confirmado salvo.
// O localStorage guarda só as operações AINDA NÃO confirmadas (create/update/
// delete de itens). Ao reabrir a página: carregamos os itens do servidor e
// reaplicamos por cima só a fila pendente local (que, por definição, o
// servidor ainda não tem) — nunca um "snapshot" local inteiro substituindo o
// servidor.
import type { ItemMatchStatus, ItemSource } from "./conferencesApi.ts";

export type PendingOpType = "create" | "update" | "delete";

export interface PendingOp {
  tempId: string;
  op: PendingOpType;
  targetId: string | null; // id real no servidor, quando já existe (update/delete)
  payload: {
    product_variant_id: string | null;
    raw_model: string;
    raw_color: string;
    quantity: number;
    match_status: ItemMatchStatus;
    source: ItemSource;
  } | null;
  clientTimestamp: number;
  attempts: number;
  lastError: string | null;
}

function storageKey(conferenceId: string): string {
  return `outlet:draft:${conferenceId}`;
}

export function loadQueue(conferenceId: string): PendingOp[] {
  try {
    const raw = localStorage.getItem(storageKey(conferenceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(conferenceId: string, queue: PendingOp[]): void {
  try {
    localStorage.setItem(storageKey(conferenceId), JSON.stringify(queue));
  } catch {
    // localStorage indisponível (modo privado, cota cheia etc.) — a operação
    // ainda tenta salvar direto no servidor, só perde a recuperação offline.
  }
}

export function clearQueue(conferenceId: string): void {
  try {
    localStorage.removeItem(storageKey(conferenceId));
  } catch {
    /* ignore */
  }
}

export function enqueue(conferenceId: string, op: Omit<PendingOp, "attempts" | "lastError">): PendingOp[] {
  const queue = loadQueue(conferenceId);
  queue.push({ ...op, attempts: 0, lastError: null });
  saveQueue(conferenceId, queue);
  return queue;
}

export function removeFromQueue(conferenceId: string, tempId: string): PendingOp[] {
  const queue = loadQueue(conferenceId).filter((o) => o.tempId !== tempId);
  saveQueue(conferenceId, queue);
  return queue;
}

export function markOpError(conferenceId: string, tempId: string, message: string): PendingOp[] {
  const queue = loadQueue(conferenceId);
  const idx = queue.findIndex((o) => o.tempId === tempId);
  if (idx >= 0) {
    queue[idx] = { ...queue[idx], attempts: queue[idx].attempts + 1, lastError: message };
  }
  saveQueue(conferenceId, queue);
  return queue;
}

// ---------------------------------------------------------------------------
// Estado de rede: online / offline / reconectando / sincronizado / erro
// ---------------------------------------------------------------------------
export type NetworkStatus = "online" | "offline" | "reconnecting" | "synced" | "sync_error";

type Listener = (status: NetworkStatus) => void;
const listeners = new Set<Listener>();
let current: NetworkStatus = navigator.onLine ? "synced" : "offline";

function emit(status: NetworkStatus) {
  current = status;
  listeners.forEach((l) => l(status));
}

export function getNetworkStatus(): NetworkStatus {
  return current;
}

export function subscribeNetwork(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

export function setSyncing() {
  emit("reconnecting");
}

export function setSynced() {
  emit("synced");
}

export function setSyncError() {
  emit("sync_error");
}

window.addEventListener("online", () => emit("reconnecting"));
window.addEventListener("offline", () => emit("offline"));
