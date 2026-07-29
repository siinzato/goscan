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

/**
 * Extrai uma mensagem legível de QUALQUER erro capturado — não só
 * instâncias de Error. Erros do Supabase/PostgREST (PostgrestError) são
 * objetos simples ({message, code, details, hint}), não instâncias de
 * Error: `err instanceof Error` dá false pra eles, e o fallback antigo
 * `String(err)` virava literalmente o texto "[object Object]", escondendo
 * a causa real (BUG REAL corrigido: mensagem de erro inútil ao vincular
 * produto na Conferência por NF).
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) {
      const code = typeof obj.code === "string" ? ` (${obj.code})` : "";
      return obj.message + code;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

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

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Central de Perfil: validações reais (Minha Conta/Segurança).
// ---------------------------------------------------------------------------

/** RFC-simplificado, suficiente pra pegar erro de digitação sem rejeitar e-mails válidos incomuns. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Telefone BR: aceita com/sem DDI (+55), com/sem DDD, fixo (10 dígitos) ou celular (11) — só valida a contagem de dígitos, não formata. */
export function isValidBrPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "").replace(/^55/, "");
  return digits.length === 10 || digits.length === 11;
}

export interface PasswordRequirement {
  key: string;
  label: string;
  met: boolean;
}

/** Mesmo mínimo pedido: 8+ caracteres, maiúscula, minúscula, número. */
export function passwordRequirements(password: string): PasswordRequirement[] {
  return [
    { key: "length", label: "Pelo menos 8 caracteres", met: password.length >= 8 },
    { key: "upper", label: "Uma letra maiúscula", met: /[A-Z]/.test(password) },
    { key: "lower", label: "Uma letra minúscula", met: /[a-z]/.test(password) },
    { key: "number", label: "Um número", met: /[0-9]/.test(password) },
  ];
}

export function passwordMeetsRequirements(password: string): boolean {
  return passwordRequirements(password).every((r) => r.met);
}

// ---------------------------------------------------------------------------
// CORREÇÃO — Reconhecimento automático e busca por EAN na Conferência por NF.
// Função ÚNICA de normalização de código de barras — usada em TODO o app
// (parser da NF-e, matching, busca do catálogo, importador, CRUD manual,
// associações memorizadas). Nunca duplicar esta regra em outro lugar.
//
// EAN/GTIN nunca é convertido para número em nenhuma etapa (perderia zero à
// esquerda) — sempre string, do XML até o banco.
// ---------------------------------------------------------------------------

/** Remove tudo que não for dígito (espaços, pontos, traços, tabs, caracteres invisíveis). Nunca usado pra regravar o valor original — só para comparação/busca. */
export function normalizeEan(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[^\d]/g, "");
}

/** Um EAN/GTIN real tem 8 (EAN-8), 12 (UPC-A), 13 (EAN-13) ou 14 (ITF-14/GTIN-14) dígitos — qualquer outro comprimento (incluindo "0", "SEMGTIN" sem espaço, "N/A") não é um código de barras válido. */
export function isValidEanFormat(normalized: string): boolean {
  return normalized.length === 8 || normalized.length === 12 || normalized.length === 13 || normalized.length === 14;
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
