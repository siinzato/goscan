export function normalize(s: string | null | undefined): string {
  return (s || "")
    .toString()
    // "1.180" -> "1180" antes da limpeza geral, senão o "." vira espaço e a
    // separação de milhar sobra como "1 180" (não bate com "1180ml" digitado sem separador).
    .replace(/(\d)[.,](\d{3})(?!\d)/g, "$1$2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // "880 ml" e "880ml" devem comparar iguais — mesmo ajuste para outras unidades comuns.
    .replace(/(\d+)\s+(ml|l|kg|g|cm|mm)\b/g, "$1$2");
}

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

export class ValidationError extends Error {}

/** Iniciais para o avatar do operador (ex.: "Ana Souza" -> "AS"). */
export function initials(name: string | null | undefined): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Gera um id local temporário para itens ainda não persistidos no servidor. */
export function localId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

let retryHandlerSeq = 0;

/**
 * Estado de erro padrão pra carregamento de página inteira: mensagem +
 * "Tentar novamente" — nunca deixa o usuário preso numa mensagem estática
 * sem nenhuma ação de recuperação. `onRetry` é registrado automaticamente
 * (não precisa buscar o botão manualmente no elemento chamador).
 */
export function renderErrorWithRetry(container: Element, message: string, onRetry: () => void): void {
  const id = `retry-btn-${++retryHandlerSeq}`;
  container.innerHTML = `
    <div class="error-box-retry">
      <p class="error-box">${escapeHtml(message)}</p>
      <button type="button" class="btn-secondary" id="${id}">Tentar novamente</button>
    </div>`;
  document.getElementById(id)?.addEventListener("click", onRetry);
}
