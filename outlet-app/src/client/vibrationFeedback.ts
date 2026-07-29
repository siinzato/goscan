// EXPANSÃO GOSCAN — Vibração com compatibilidade (seção 17 do pedido).
// navigator.vibrate não existe no Safari/iOS — feature-detected sempre;
// a operação NUNCA depende de vibração, é só um reforço tátil quando disponível.
export type VibrationKind = "success" | "completed" | "error" | "excess";

const PATTERNS: Record<VibrationKind, number | number[]> = {
  success: 30,
  completed: [30, 60, 30],
  error: 180,
  excess: [80, 60, 80, 60, 80],
};

let enabled = true;

export function setVibrationEnabled(value: boolean): void {
  enabled = value;
}

export function isVibrationSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/** Nunca lança erro nem atrasa nada — se o navegador não suportar (iPhone/Safari), simplesmente não vibra. */
export function vibrate(kind: VibrationKind): void {
  if (!enabled || !isVibrationSupported()) return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    /* silencioso — vibração é só reforço tátil, nunca crítico */
  }
}
