// EXPANSÃO GOSCAN — Consulta automática de NF-e pela chave de acesso.
//
// Cliente da Edge Function consultar-nfe-meudanfe + controle do polling
// seguro enquanto a consulta está em WAITING/SEARCHING. Nunca fala com
// api.meudanfe.com.br diretamente — toda chamada de rede externa acontece
// dentro da Edge Function; aqui só existe supabase.functions.invoke(...).
//
// Contrato de resposta da Edge Function (mantido em sincronia manual com
// supabase/functions/consultar-nfe-meudanfe/index.ts — arquivos que rodam em
// runtimes diferentes, Deno vs. bundle Vite, não podem compartilhar um
// módulo importado diretamente).
import { getSupabase } from "./supabaseClient.ts";

export type NfeLookupStatus = "WAITING" | "SEARCHING" | "OK" | "ALREADY_IMPORTED";

interface EdgeSuccessResponse {
  success: true;
  status: NfeLookupStatus;
  accessKey: string;
  attempt?: number;
  message?: string;
  documentType?: string;
  fileName?: string | null;
  xml?: string;
}

interface EdgeErrorResponse {
  success: false;
  code: string;
  message: string;
}

type EdgeResponse = EdgeSuccessResponse | EdgeErrorResponse;

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 10;

export type LookupPhase =
  | "validating"
  | "requesting"
  | "waiting"
  | "done"
  | "already_imported"
  | "not_found"
  | "error"
  | "still_processing"
  | "cancelled";

export interface LookupProgress {
  phase: LookupPhase;
  attempt?: number;
  maxAttempts?: number;
  message?: string;
  xml?: string;
  accessKey?: string;
}

export interface LookupHandle {
  cancel(): void;
}

// Uma única operação ativa por vez (esta tela só tem um campo/botão de
// busca) — bloqueia clique duplo e múltiplos timers concorrentes mesmo que
// o botão seja clicado antes de desabilitar visualmente.
let activeKey: string | null = null;

export function isNfeKeyLookupInFlight(): boolean {
  return activeKey !== null;
}

/** Extrai a mensagem sanitizada do corpo JSON de erro devolvido pela Edge Function — nunca expõe o corpo técnico cru do erro de invoke. */
async function describeEdgeError(error: { context?: unknown }): Promise<{ code: string; message: string }> {
  const context = error?.context as { json?: () => Promise<unknown>; clone?: () => { json: () => Promise<unknown> } } | undefined;
  if (context && typeof context.json === "function") {
    try {
      const raw = typeof context.clone === "function" ? await context.clone().json() : await context.json();
      const parsed = raw as { code?: unknown; message?: unknown };
      if (parsed && typeof parsed.message === "string") {
        return { code: typeof parsed.code === "string" ? parsed.code : "NFE_QUERY_ERROR", message: parsed.message };
      }
    } catch {
      // corpo não era JSON (ou já foi consumido) — cai no fallback genérico abaixo.
    }
  }
  return { code: "NFE_QUERY_ERROR", message: "Não foi possível consultar esta NF-e. Você ainda pode importar o XML manualmente." };
}

async function callEdgeFunction(accessKey: string): Promise<EdgeResponse> {
  const supabase = getSupabase();
  const { data, error } = await supabase.functions.invoke("consultar-nfe-meudanfe", { body: { accessKey } });
  if (error) {
    const described = await describeEdgeError(error as { context?: unknown });
    return { success: false, code: described.code, message: described.message };
  }
  return data as EdgeResponse;
}

/**
 * Orquestra a consulta pela chave de acesso: chama a Edge Function e faz o
 * polling seguro enquanto WAITING/SEARCHING — 2s entre tentativas, máximo 10,
 * nunca duas operações ao mesmo tempo, sempre cancelável, nunca atualiza
 * estado depois de cancelado. Retorna um handle cujo cancel() deve ser
 * chamado se o operador sair da tela antes de terminar.
 */
export function startNfeKeyLookup(accessKey: string, onProgress: (p: LookupProgress) => void): LookupHandle {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handle: LookupHandle = {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (activeKey === accessKey) activeKey = null;
      onProgress({ phase: "cancelled", message: "Consulta cancelada." });
    },
  };

  if (activeKey !== null) {
    onProgress({ phase: "error", message: "Já existe uma consulta em andamento. Aguarde terminar." });
    return handle;
  }
  activeKey = accessKey;
  onProgress({ phase: "validating" });

  void (async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (cancelled) return;
      onProgress(attempt === 1 ? { phase: "requesting" } : { phase: "waiting", attempt, maxAttempts: MAX_ATTEMPTS });

      const result = await callEdgeFunction(accessKey);
      if (cancelled) return;

      if (!result.success) {
        // activeKey precisa ser limpo ANTES do onProgress: o handler do
        // chamador (ex.: reabilitar o botão) roda de forma síncrona dentro
        // deste mesmo callback e consultaria isNfeKeyLookupInFlight() com o
        // valor antigo se a ordem fosse invertida (bug real encontrado ao
        // testar no navegador — o botão "Buscar NF-e" nunca reabilitava).
        activeKey = null;
        onProgress({ phase: result.code === "NFE_NOT_FOUND" ? "not_found" : "error", message: result.message });
        return;
      }

      if (result.status === "ALREADY_IMPORTED") {
        activeKey = null;
        onProgress({ phase: "already_imported", accessKey: result.accessKey });
        return;
      }

      if (result.status === "OK") {
        activeKey = null;
        onProgress({ phase: "done", xml: result.xml, accessKey: result.accessKey });
        return;
      }

      // WAITING / SEARCHING — continua tentando, respeitando o intervalo mínimo.
      onProgress({ phase: "waiting", attempt, maxAttempts: MAX_ATTEMPTS, message: result.message });

      if (attempt < MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, POLL_INTERVAL_MS);
        });
      }
    }

    if (!cancelled) {
      activeKey = null;
      onProgress({
        phase: "still_processing",
        message: "A consulta está demorando mais que o normal. Aguarde alguns instantes e tente novamente.",
      });
    }
  })();

  return handle;
}
