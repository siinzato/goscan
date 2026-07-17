import type { NetworkStatus } from "../offline.ts";

const LABELS: Record<NetworkStatus, string | null> = {
  online: null,
  synced: null,
  offline: "📴 Sem conexão — suas alterações serão salvas ao reconectar.",
  reconnecting: "🔄 Reconectando e sincronizando…",
  sync_error: "⚠️ Erro ao sincronizar. Toque para tentar novamente.",
};

export function renderNetworkBanner(el: HTMLElement, status: NetworkStatus): void {
  const label = LABELS[status];
  if (!label) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = label;
  el.className = `network-banner network-banner--${status}`;
}
