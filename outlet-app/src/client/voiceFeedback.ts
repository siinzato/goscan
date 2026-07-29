// EXPANSÃO GOSCAN — Avisos falados (seção 16 do pedido). SpeechSynthesis
// nativa do navegador — sem serviço externo, sem custo, sem chave de API.
// NUNCA fala em toda bipagem normal (isso seria uma voz gritando o tempo
// todo num galpão) — só nos avisos explicitamente listados no pedido.
export type VoicePriority = "normal" | "high";

export interface VoicePreferences {
  enabled: boolean;
  speakProductName: boolean;
}

let prefs: VoicePreferences = { enabled: true, speakProductName: true };

interface QueuedUtterance {
  text: string;
  priority: VoicePriority;
}

let queue: QueuedUtterance[] = [];
let speaking = false;
let lastKey: string | null = null;
let lastKeyAt = 0;

export function isVoiceSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function setVoicePreferences(next: Partial<VoicePreferences>): void {
  prefs = { ...prefs, ...next };
}

export function getVoicePreferences(): VoicePreferences {
  return prefs;
}

function pump(): void {
  if (speaking || queue.length === 0 || !isVoiceSupported()) return;
  // Prioriza avisos de alta prioridade (erros/excesso) sobre confirmações normais.
  queue.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "high" ? -1 : 1));
  const next = queue.shift();
  if (!next) return;
  speaking = true;
  const utterance = new SpeechSynthesisUtterance(next.text);
  utterance.lang = "pt-BR";
  const finish = () => {
    speaking = false;
    pump();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  window.speechSynthesis.speak(utterance);
}

export interface SpeakOptions {
  priority?: VoicePriority;
  /** Quando informado, impede repetir o MESMO aviso dentro da janela de tempo (evita "Produto finalizado" repetido por eventos Realtime duplicados). */
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

/**
 * Enfileira uma frase — nunca sobrepõe áudio (fila serializada), nunca fala
 * se a voz estiver desativada ou não suportada. Prioridade "high" interrompe
 * o que estiver tocando e descarta o restante da fila normal (erros nunca
 * esperam atrás de confirmações antigas).
 */
export function speak(text: string, opts: SpeakOptions = {}): void {
  if (!prefs.enabled || !isVoiceSupported()) return;

  if (opts.dedupeKey) {
    const now = Date.now();
    if (opts.dedupeKey === lastKey && now - lastKeyAt < (opts.dedupeWindowMs ?? 4000)) return;
    lastKey = opts.dedupeKey;
    lastKeyAt = now;
  }

  if (opts.priority === "high") {
    queue = queue.filter((q) => q.priority === "high");
    window.speechSynthesis.cancel();
    speaking = false;
  }

  queue.push({ text, priority: opts.priority ?? "normal" });
  pump();
}

/** Cancela tudo que está na fila/tocando — chamado ao sair da tela de conferência. */
export function stopVoiceQueue(): void {
  queue = [];
  speaking = false;
  if (isVoiceSupported()) window.speechSynthesis.cancel();
}
