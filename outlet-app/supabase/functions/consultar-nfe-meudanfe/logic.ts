// EXPANSÃO GOSCAN — Consulta automática de NF-e pela chave de acesso.
//
// Lógica pura (sem Deno.*, sem fetch, sem I/O) da Edge Function
// consultar-nfe-meudanfe, extraída num módulo à parte de propósito: o
// arquivo index.ts usa Deno.serve/Deno.env e não pode ser importado fora do
// runtime Deno, mas esta parte (validação de chave, mapeamento de erros) não
// depende de nada específico do Deno — pode ser testada com `node --test`
// (ver tests/nfeMeuDanfeLogic.test.mjs), no mesmo padrão de nfeParser.ts/
// nfeMatching.ts (funções puras testáveis isoladamente).

export interface SanitizedUpstreamError {
  code: string;
  message: string;
  httpStatus: number;
}

/**
 * Remove tudo que não for dígito e exige exatamente 44 — nunca aceita menos
 * nem mais, nunca converte pra número (perderia zero à esquerda de uma
 * chave real, embora chaves de NF-e não costumem ter zeros à esquerda, a
 * regra vale por princípio — ver mesma regra aplicada a EAN/SKU).
 */
export function sanitizeAccessKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === 44 ? digits : null;
}

/**
 * Mapeia o HTTP status devolvido pelo Meu Danfe (PUT ou GET) para uma
 * mensagem sanitizada — nunca o corpo/stack técnico real (seção 17 do
 * pedido). httpStatus é o status que a NOSSA resposta usa, não repassa o
 * status cru do upstream.
 */
export function describeUpstreamHttpError(status: number): SanitizedUpstreamError {
  switch (status) {
    case 400:
      return { code: "NFE_INVALID_KEY", message: "Chave de acesso inválida. Confira os 44 dígitos.", httpStatus: 400 };
    case 401:
    case 403:
      return { code: "NFE_INTEGRATION_UNAVAILABLE", message: "Integração com NF-e não configurada. Procure um administrador.", httpStatus: 502 };
    case 402:
      return { code: "NFE_INSUFFICIENT_BALANCE", message: "Saldo insuficiente na integração de NF-e. Procure um administrador.", httpStatus: 502 };
    case 404:
      return { code: "NFE_XML_NOT_READY", message: "O XML ainda não está disponível. Aguarde alguns segundos e tente novamente.", httpStatus: 404 };
    case 429:
      return { code: "NFE_RATE_LIMITED", message: "Muitas consultas em pouco tempo. Aguarde antes de tentar novamente.", httpStatus: 429 };
    default:
      return {
        code: "NFE_SERVICE_UNAVAILABLE",
        message: "O serviço de consulta de NF-e está temporariamente indisponível. Tente novamente mais tarde.",
        httpStatus: 503,
      };
  }
}

/** Falha de rede/timeout ao chamar o Meu Danfe — nunca expõe a exceção crua ao cliente (só no log do servidor). */
export function describeUpstreamException(err: unknown): SanitizedUpstreamError {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  const isTimeout = name === "TimeoutError" || name === "AbortError";
  return {
    code: isTimeout ? "NFE_TIMEOUT" : "NFE_NETWORK_ERROR",
    message: "O serviço de consulta de NF-e está temporariamente indisponível. Tente novamente mais tarde.",
    httpStatus: 503,
  };
}

/** Status de negócio (corpo JSON) do PUT do Meu Danfe — normaliza maiúsculas/minúsculas e espaços acidentais. */
export function normalizeBusinessStatus(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export interface LookupRow {
  status: string;
  attempt_count: number;
  sanitized_error: string | null;
}

/**
 * Serve o último estado conhecido de nfe_lookup_requests sem bater no Meu
 * Danfe de novo — usado quando a última tentativa foi há menos de 1s (ver
 * migration 0031 e seção 7.1 do pedido: várias consultas da mesma chave em
 * menos de 1s podem bloquear conta/IP). Esta tabela nunca guarda o XML, então
 * mesmo um status salvo como 'ok' nunca "reserva" um resultado em cache —
 * trata como 'searching' e pede pra tentar de novo, nunca inventa um XML.
 */
export function lookupRowToResponse(row: LookupRow, accessKey: string): { body: Record<string, unknown>; httpStatus: number } {
  switch (row.status) {
    case "waiting":
      return { body: { success: true, status: "WAITING", accessKey, attempt: row.attempt_count, message: "NF-e aguardando consulta." }, httpStatus: 200 };
    case "searching":
    case "ok":
      return { body: { success: true, status: "SEARCHING", accessKey, attempt: row.attempt_count, message: "Consulta em andamento." }, httpStatus: 200 };
    case "not_found":
      return {
        body: { success: false, code: "NFE_NOT_FOUND", message: "NF-e não encontrada. Confira a chave de acesso ou envie o XML manualmente." },
        httpStatus: 404,
      };
    default:
      return {
        body: {
          success: false,
          code: "NFE_QUERY_ERROR",
          message: row.sanitized_error || "Não foi possível consultar esta NF-e. Você ainda pode importar o XML manualmente.",
        },
        httpStatus: 502,
      };
  }
}

export const MEUDANFE_BASE_URL = "https://api.meudanfe.com.br/v2";
export const UPSTREAM_TIMEOUT_MS = 15_000;
/** Intervalo mínimo real entre chamadas ao Meu Danfe pela MESMA chave — imposto no servidor, não só como convenção do polling no cliente. */
export const MIN_POLL_INTERVAL_MS = 1_000;
