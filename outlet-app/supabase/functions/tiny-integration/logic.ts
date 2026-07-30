// EXPANSÃO GOSCAN — Integração real com o Tiny ERP (API v3, OAuth2).
//
// Lógica pura (sem Deno.*, sem fetch, sem I/O) — mesmo padrão de
// supabase/functions/admin-users/logic.ts: extraída à parte pra ser
// testável com `node --test` (ver tests/tinyIntegrationLogic.test.mjs), já
// que index.ts usa Deno.serve/fetch e não pode ser importado fora do
// runtime Deno.
//
// Referência da API real (pesquisada e confirmada contra a documentação
// oficial/OpenAPI do Tiny antes de escrever qualquer chamada — nunca um
// endpoint inventado):
// - Base: https://api.tiny.com.br/public-api/v3
// - Auth: OAuth2 Bearer. access_token expira em 4h, refresh_token em 24h.
// - GET /produtos?codigo=<sku> ou ?gtin=<ean numérico> — busca produto.
// - GET /depositos — lista depósitos (id numérico, descricao).
// - POST /estoque/{idProduto} — cria movimentação. Campos obrigatórios no
//   schema real: tipo ('E'=entrada/'S'=saída/'B'=balanço), quantidade,
//   precoUnitario. deposito é objeto {id}. Resposta: { idLancamento }.
// - GET /info — dados da conta (usado como teste de conexão).
// - Erros: HTTP 400/401/403/404/500/503, corpo ErrorDTO
//   { mensagem, detalhes?: [{ campo, mensagem }] }.
// - NENHUMA das duas gerações da API do Tiny garante idempotência —
//   confirmado por ausência total de menção a isso na documentação oficial
//   (nem header, nem parâmetro de chave externa). A dedupe é 100%
//   responsabilidade nossa (ver tiny_stock_launches, migration 0051).

export const TINY_API_BASE = "https://api.tiny.com.br/public-api/v3";
export const TINY_OAUTH_TOKEN_URL = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token";

// Buffer de segurança antes do access_token expirar de verdade — evita usar
// um token que expira no meio de um lote com vários itens (cada chamada real
// leva um tempo; se o token vencer entre o item 1 e o item 5, a maioria das
// integrações mal-feitas simplesmente falha ali no meio). Refaz o refresh
// se faltar menos que isto.
export const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000; // 10 minutos

/** Nunca assume um token válido por omissão — expiresAt ausente conta como expirado (força refresh). */
export function isAccessTokenExpired(expiresAt: string | null | undefined, nowMs: number, bufferMs: number = TOKEN_EXPIRY_BUFFER_MS): boolean {
  if (!expiresAt) return true;
  const expiryMs = Date.parse(expiresAt);
  if (Number.isNaN(expiryMs)) return true;
  return expiryMs - bufferMs <= nowMs;
}

export type TinyLaunchSourceType = "return_batch_item" | "invoice_receipt_item";

/**
 * Chave de idempotência real do lançamento — mesmo item + mesmo depósito
 * NUNCA lança duas vezes (ver tiny_stock_launches.idempotency_key, unique).
 * Depósito diferente é uma tentativa nova de propósito (ex.: correção manual
 * decidindo usar outro depósito) — não é a mesma chave.
 */
export function buildTinyLaunchIdempotencyKey(sourceType: TinyLaunchSourceType, sourceId: string, depositoId: string): string {
  return `TINY_ESTOQUE:${sourceType}:${sourceId}:DEPOSITO:${depositoId}`;
}

export interface TinyErrorDetail {
  campo?: string;
  mensagem?: string;
}
export interface TinyErrorBody {
  mensagem?: string;
  detalhes?: TinyErrorDetail[] | null;
}

/**
 * Traduz uma resposta de erro real do Tiny v3 numa mensagem clara pro
 * operador — nunca expõe o corpo técnico bruto. HTTP status sempre reflete
 * o erro de verdade na v3 (ao contrário da v2, que sempre responde 200 — ver
 * header deste arquivo); por isso o status entra na decisão.
 */
export function describeTinyError(status: number, body: unknown): string {
  if (status === 401) return "Conexão com o Tiny expirada ou inválida. Reconecte em Administração > Integrações.";
  if (status === 403) return "Sem permissão no Tiny para esta operação. Verifique o usuário que autorizou a integração.";
  if (status === 404) return "Produto ou depósito não encontrado no Tiny.";
  if (status === 429) return "Limite de requisições do Tiny atingido — tente novamente em alguns instantes.";
  if (status >= 500) return "O Tiny está indisponível no momento. Tente novamente mais tarde.";

  const parsed = body as TinyErrorBody | null;
  if (parsed && typeof parsed === "object") {
    const fieldErrors = (parsed.detalhes ?? [])
      .filter((d): d is TinyErrorDetail & { mensagem: string } => !!d?.mensagem)
      .map((d) => (d.campo ? `${d.campo}: ${d.mensagem}` : d.mensagem))
      .join("; ");
    if (fieldErrors) return fieldErrors;
    if (parsed.mensagem) return parsed.mensagem;
  }
  return "Não foi possível concluir a operação no Tiny.";
}

/** Parâmetros de busca de produto por SKU (codigo) ou EAN (gtin, numérico na query — mas string na resposta, gotcha confirmado na documentação). Nunca os dois vazios. */
export function buildProdutoLookupParams(sku: string | null, ean: string | null): Record<string, string> {
  const params: Record<string, string> = {};
  if (sku && sku.trim()) params.codigo = sku.trim();
  else if (ean && /^\d+$/.test(ean.trim())) params.gtin = String(Number(ean.trim()));
  return params;
}

export interface StockMovementInput {
  tipo: "E" | "S" | "B";
  quantidade: number;
  precoUnitario: number;
  depositoId?: string;
  observacoes?: string;
}

/** Corpo exato de POST /estoque/{idProduto} — schema real confirmado via OpenAPI (tipo/quantidade/precoUnitario obrigatórios, deposito é objeto {id}). */
export function buildStockMovementBody(input: StockMovementInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tipo: input.tipo,
    quantidade: input.quantidade,
    precoUnitario: input.precoUnitario,
  };
  if (input.depositoId) body.deposito = { id: Number(input.depositoId) };
  if (input.observacoes) body.observacoes = input.observacoes;
  return body;
}

export interface LaunchItemResult {
  sourceId: string;
  status: "success" | "failed" | "skipped_already_done";
  externalMovementId?: string;
  error?: string;
}

export interface LaunchSummary {
  total: number;
  succeeded: number;
  failed: number;
  alreadyDone: number;
  allSucceeded: boolean;
}

/** Nunca conta "sucesso total" incluindo falhas — allSucceeded só é true quando não sobra nenhum item pendente/falho. */
export function summarizeLaunchResults(results: LaunchItemResult[]): LaunchSummary {
  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const alreadyDone = results.filter((r) => r.status === "skipped_already_done").length;
  return {
    total: results.length,
    succeeded,
    failed,
    alreadyDone,
    allSucceeded: results.length > 0 && failed === 0,
  };
}

export interface TokenRefreshInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Corpo real (application/x-www-form-urlencoded) do endpoint de refresh do Tiny — confirmado via documentação oficial (Keycloak-backed). */
export function buildTokenRefreshBody(input: TokenRefreshInput): URLSearchParams {
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  });
}

export const TINY_INTEGRATION_ACTIONS = ["test_connection", "list_warehouses", "launch_return_batch", "launch_invoice_receipt"] as const;
export type TinyIntegrationAction = (typeof TINY_INTEGRATION_ACTIONS)[number];

export function isValidTinyIntegrationAction(value: unknown): value is TinyIntegrationAction {
  return typeof value === "string" && (TINY_INTEGRATION_ACTIONS as readonly string[]).includes(value);
}
