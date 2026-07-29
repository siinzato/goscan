// EXPANSÃO GOSCAN — Comandos de voz (seção 18 do pedido). Push-to-talk
// (nunca ouve continuamente) via SpeechRecognition/webkitSpeechRecognition,
// só quando o navegador suporta. Nenhum comando chega ao banco sem
// confirmação explícita — este módulo só INTERPRETA o texto reconhecido;
// quem decide agir é sempre a tela (nfeConference.ts), depois de confirmar.

// TypeScript não inclui os tipos de SpeechRecognition no lib.dom padrão
// (API não padronizada/prefixada) — declaração mínima do que este módulo
// realmente usa, em vez de puxar uma lib externa só por causa disso.
interface MinimalSpeechRecognitionResult {
  transcript: string;
  confidence: number;
}
interface MinimalSpeechRecognitionAlternativeList {
  length: number;
  [index: number]: MinimalSpeechRecognitionResult;
}
interface MinimalSpeechRecognitionResultList {
  length: number;
  [index: number]: MinimalSpeechRecognitionAlternativeList;
}
interface MinimalSpeechRecognitionEvent extends Event {
  results: MinimalSpeechRecognitionResultList;
}
interface MinimalSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: MinimalSpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionWindow {
  SpeechRecognition?: new () => MinimalSpeechRecognition;
  webkitSpeechRecognition?: new () => MinimalSpeechRecognition;
}

export type VoiceCommand =
  | { kind: "add_quantity"; amount: number }
  | { kind: "remove_quantity"; amount: number }
  | { kind: "finish_product" }
  | { kind: "next_product" }
  | { kind: "show_pending" }
  | { kind: "undo_last" }
  | { kind: "pause_conference" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "unrecognized"; raw: string };

const NUMBER_WORDS: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  três: 3,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  vinte: 20,
  trinta: 30,
};

function parseAmount(text: string): number | null {
  const digitMatch = text.match(/\d+/);
  if (digitMatch) return parseInt(digitMatch[0], 10);
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return n;
  }
  return null;
}

/**
 * Interpreta o texto já reconhecido (pt-BR) num comando estruturado — função
 * PURA (testável sem navegador/microfone). Nunca decide uma ação sozinha:
 * quem chama decide o que fazer com o resultado, sempre exigindo confirmação
 * antes de qualquer efeito real (ver seção 18: "Não envie comandos ao banco
 * antes da confirmação").
 */
export function parseVoiceCommand(rawText: string): VoiceCommand {
  const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");
  const text = rawText
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "") // remove acentos (marcas de combinação Unicode) pra casar "proximo"/"próximo" igual
    .trim();

  if (/\b(adicionar|adiciona|somar|soma|mais)\b/.test(text)) {
    const amount = parseAmount(text);
    if (amount !== null) return { kind: "add_quantity", amount };
  }
  if (/\b(remover|remove|retirar|tirar|menos)\b/.test(text)) {
    const amount = parseAmount(text);
    if (amount !== null) return { kind: "remove_quantity", amount };
  }
  if (/finalizar produto|concluir produto/.test(text)) return { kind: "finish_product" };
  if (/proximo produto|proximo item|proxima produto/.test(text)) return { kind: "next_product" };
  if (/mostrar pendentes|listar pendentes|^pendentes$/.test(text)) return { kind: "show_pending" };
  if (/desfazer/.test(text)) return { kind: "undo_last" };
  if (/pausar conferencia|pausar/.test(text)) return { kind: "pause_conference" };
  if (/^confirmar$|^confirmo$|^confirma$|^sim$/.test(text)) return { kind: "confirm" };
  if (/^cancelar$|^cancela$|^nao$/.test(text)) return { kind: "cancel" };

  return { kind: "unrecognized", raw: rawText };
}

export function isVoiceCommandSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as SpeechRecognitionWindow;
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

let recognition: MinimalSpeechRecognition | null = null;
let listening = false;

function getRecognition(): MinimalSpeechRecognition | null {
  if (!isVoiceCommandSupported()) return null;
  if (!recognition) {
    const w = window as unknown as SpeechRecognitionWindow;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return null;
    recognition = new Ctor();
    recognition.lang = "pt-BR";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
  }
  return recognition;
}

const MIN_CONFIDENCE = 0.55;

export interface PushToTalkHandlers {
  onResult: (command: VoiceCommand, confidence: number, transcript: string) => void;
  onLowConfidence: () => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

/**
 * Inicia UMA captura de voz (nunca contínua — "segure para falar"). Retorna
 * false sem fazer nada se o navegador não suportar ou se já houver uma
 * captura em andamento (nunca duas simultâneas).
 */
export function startPushToTalk(handlers: PushToTalkHandlers): boolean {
  const rec = getRecognition();
  if (!rec || listening) return false;

  listening = true;
  rec.onresult = (event: MinimalSpeechRecognitionEvent) => {
    const alternatives = event.results[0];
    const result = alternatives && alternatives.length > 0 ? alternatives[0] : null;
    if (!result) {
      handlers.onLowConfidence();
      return;
    }
    if (typeof result.confidence === "number" && result.confidence > 0 && result.confidence < MIN_CONFIDENCE) {
      handlers.onLowConfidence();
      return;
    }
    handlers.onResult(parseVoiceCommand(result.transcript), result.confidence ?? 1, result.transcript);
  };
  rec.onerror = () => {
    listening = false;
    handlers.onError("Não foi possível reconhecer o áudio. Tente novamente.");
  };
  rec.onend = () => {
    listening = false;
    handlers.onEnd();
  };

  try {
    rec.start();
    return true;
  } catch {
    listening = false;
    return false;
  }
}

export function stopPushToTalk(): void {
  if (recognition && listening) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
}

export function isListening(): boolean {
  return listening;
}
