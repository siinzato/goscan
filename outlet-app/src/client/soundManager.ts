// EXPANSÃO GOSCAN — Gerenciador de som operacional (seção 15 do pedido).
// Reutilizável (não específico de NF-e), mas usado hoje só na Conferência
// por NF — o beep único do Modo Scan (scan.ts, /sounds/scan-found.mp3)
// continua exatamente como está, nunca substituído por este módulo.
//
// Sons SINTETIZADOS via Web Audio API (osciladores + envelope de ganho) em
// vez de arquivos de áudio: zero risco de licenciamento, zero download de
// asset (não precisa de "pré-carregamento" de arquivo — o som é gerado na
// hora, instantaneamente), controle fino de tom/duração por situação.
let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

export interface SoundPreferences {
  enabled: boolean;
  /** 0..1 */
  volume: number;
}

let prefs: SoundPreferences = { enabled: true, volume: 0.6 };

export type SoundKind =
  | "product_correct"
  | "quantity_added"
  | "product_completed"
  | "product_incorrect"
  | "product_out_of_invoice"
  | "unknown_ean"
  | "excess"
  | "product_with_other_operator"
  | "connection_lost"
  | "connection_restored"
  | "receipt_finalized";

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  if (!ctx) {
    ctx = new AudioCtor();
    masterGain = ctx.createGain();
    masterGain.gain.value = prefs.volume;
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

export function setSoundPreferences(next: Partial<SoundPreferences>): void {
  prefs = { ...prefs, ...next };
  if (masterGain) masterGain.gain.value = prefs.volume;
}

export function getSoundPreferences(): SoundPreferences {
  return prefs;
}

/**
 * Deve ser chamada dentro de um gesto real do usuário (clique/toque) — a
 * maioria dos navegadores mobile cria o AudioContext SUSPENSO até uma
 * interação real destravá-lo (mesma razão de unlockScanSound em scan.ts).
 * Chamar de novo depois de já destravado é barato/no-op.
 */
export function unlockConferenceSounds(): void {
  const c = ensureContext();
  if (c && c.state === "suspended") {
    void c.resume().catch(() => {
      /* se nem isso for permitido, os sons simplesmente não tocam — nunca é crítico, sempre há fallback visual */
    });
  }
}

function tone(freqHz: number, startOffsetSec: number, durationMs: number, type: OscillatorType = "sine", peakGain = 1): void {
  const c = ensureContext();
  if (!c || !masterGain) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freqHz;
  const start = c.currentTime + startOffsetSec;
  const dur = durationMs / 1000;
  // Envelope curto de ataque/liberação — evita o "clique" de uma onda cortada abruptamente.
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peakGain, start + Math.min(0.012, dur / 4));
  gain.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

const PATTERNS: Record<SoundKind, () => void> = {
  product_correct: () => tone(880, 0, 90, "sine", 0.5),
  quantity_added: () => tone(660, 0, 70, "sine", 0.4),
  product_completed: () => {
    tone(523, 0, 110, "sine", 0.5);
    tone(784, 0.11, 170, "sine", 0.55);
  },
  product_incorrect: () => tone(220, 0, 230, "square", 0.32),
  product_out_of_invoice: () => {
    tone(330, 0, 110, "square", 0.4);
    tone(330, 0.15, 110, "square", 0.4);
  },
  unknown_ean: () => tone(440, 0, 170, "triangle", 0.4),
  excess: () => {
    tone(300, 0, 100, "square", 0.45);
    tone(300, 0.14, 100, "square", 0.45);
    tone(300, 0.28, 100, "square", 0.45);
  },
  product_with_other_operator: () => {
    tone(500, 0, 90, "sine", 0.4);
    tone(500, 0.13, 90, "sine", 0.4);
  },
  connection_lost: () => {
    tone(500, 0, 90, "sine", 0.3);
    tone(350, 0.1, 150, "sine", 0.3);
  },
  connection_restored: () => tone(700, 0, 80, "sine", 0.25),
  receipt_finalized: () => {
    tone(523, 0, 100, "sine", 0.5);
    tone(659, 0.1, 100, "sine", 0.5);
    tone(784, 0.2, 230, "sine", 0.55);
  },
};

const MIN_REPEAT_GAP_MS = 80;
const lastPlayedAt: Partial<Record<SoundKind, number>> = {};

/**
 * Toca o som da situação — NUNCA atrasa a bipagem (só agenda no clock do
 * Web Audio, não bloqueia nada) e nunca lança erro (fallback visual sempre
 * vem de outro lugar — toast/badge/cor). Ignora repetições da MESMA situação
 * em menos de 80ms (evita duplicar por um evento realmente duplicado, sem
 * bloquear leituras legítimas de EANs iguais em sequência — isso é resolvido
 * por idempotency_key no servidor, não aqui).
 */
export function playSound(kind: SoundKind): void {
  if (!prefs.enabled) return;
  const now = Date.now();
  const last = lastPlayedAt[kind];
  if (last && now - last < MIN_REPEAT_GAP_MS) return;
  lastPlayedAt[kind] = now;
  try {
    PATTERNS[kind]();
  } catch {
    /* áudio indisponível neste navegador/momento — silencioso, nunca trava a operação */
  }
}
