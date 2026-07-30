// EXPANSÃO GOSCAN — Painel de Administração.
//
// Lógica pura (sem Deno.*, sem fetch, sem I/O) da Edge Function
// admin-users — mesmo padrão de supabase/functions/consultar-nfe-meudanfe/
// logic.ts: extraída à parte pra ser testável com `node --test`
// (ver tests/adminUsersLogic.test.mjs), já que index.ts usa Deno.serve/
// Deno.env e não pode ser importado fora do runtime Deno.

export type Role = "super_admin" | "admin" | "operator" | "viewer";
export const ROLES: readonly Role[] = ["super_admin", "admin", "operator", "viewer"];

export function isValidRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Pode o papel do CHAMADOR gerenciar (editar dados, ativar/desativar,
 * redefinir senha) um usuário com este papel-ALVO?
 * - super_admin: gerencia qualquer um (inclusive outro super_admin — a
 *   trava de "nunca zero super_admin ativo" é feita à parte, por contagem
 *   real, não por esta regra de hierarquia).
 * - admin: só operator/viewer (nunca outro admin, nunca super_admin — "Não
 *   edita super administradores" é explícito no pedido; "gerencia
 *   operadores e visualizadores" não inclui outros admins).
 * - operator/viewer: nunca gerenciam ninguém (nem acessam o painel).
 */
export function canManageRole(callerRole: Role, targetRole: Role): boolean {
  if (callerRole === "super_admin") return true;
  if (callerRole === "admin") return targetRole === "operator" || targetRole === "viewer";
  return false;
}

/**
 * Pode o papel do CHAMADOR criar um usuário com este papel-ALVO?
 * hasCreateAdminPermission = tem a permissão granular 'users.create_admin'
 * (concedida via user_permission_overrides — nunca por padrão pro papel
 * admin, ver role_default_permissions).
 */
export function canCreateRole(callerRole: Role, targetRole: Role, hasCreateAdminPermission: boolean): boolean {
  if (callerRole === "super_admin") return true;
  if (callerRole === "admin") {
    if (targetRole === "operator" || targetRole === "viewer") return true;
    if (targetRole === "admin") return hasCreateAdminPermission;
    return false; // admin nunca cria super_admin, com ou sem permissão extra
  }
  return false;
}

export interface SuperAdminTarget {
  role: Role;
  active: boolean;
}

/**
 * Decide, de forma pura, se uma alteração deixaria o GoScan sem nenhum
 * super_admin ativo — dado o estado atual do alvo, a mudança proposta, e
 * quantos OUTROS super_admins ativos já se sabe que existem (contagem real
 * feita à parte, em index.ts, contra o banco). Extraída assim de propósito:
 * testar esta regra de verdade (contagem chegando a zero) contra o banco de
 * produção exigiria zerar temporariamente os super_admins reais existentes
 * — inclusive o único super_admin real de hoje — o que nunca deve
 * acontecer nem por um instante. Como função pura, os testes cobrem
 * exaustivamente contagem=0 (bloqueia) e contagem>=1 (libera) sem tocar em
 * nenhum dado real. O trigger protect_last_super_admin no banco aplica
 * exatamente a mesma regra como defesa em profundidade incondicional.
 */
export function wouldLeaveZeroSuperAdmins(target: SuperAdminTarget, patch: { role?: Role; active?: boolean }, otherActiveSuperAdminCount: number): boolean {
  if (target.role !== "super_admin" || !target.active) return false;
  const nextRole = patch.role ?? target.role;
  const nextActive = patch.active ?? target.active;
  if (nextRole === "super_admin" && nextActive) return false;
  return otherActiveSuperAdminCount <= 0;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Mesma regra de src/client/utils.ts (duplicada de propósito — runtimes/deployáveis diferentes, ver header). */
export function isValidBrPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "").replace(/^55/, "");
  return digits.length === 10 || digits.length === 11;
}

/** Mesmo mínimo pedido em toda a troca de senha do GoScan: 8+ caracteres, maiúscula, minúscula, número. */
export function passwordMeetsMinimum(password: string): boolean {
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password);
}

export interface PaginationInput {
  page?: unknown;
  pageSize?: unknown;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function sanitizePagination(input: PaginationInput): { page: number; pageSize: number } {
  const rawPage = typeof input.page === "number" && Number.isFinite(input.page) ? Math.floor(input.page) : 0;
  const rawPageSize = typeof input.pageSize === "number" && Number.isFinite(input.pageSize) ? Math.floor(input.pageSize) : DEFAULT_PAGE_SIZE;
  return {
    page: Math.max(0, rawPage),
    pageSize: Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE),
  };
}

export const ADMIN_ACTIONS = [
  "overview",
  "list_users",
  "create_user",
  "update_user",
  "activate_user",
  "deactivate_user",
  "send_password_reset",
  "set_temp_password",
  "list_groups",
  "create_group",
  "update_group",
  "deactivate_group",
  "get_user_permissions",
  "set_user_permissions",
  "list_audit_logs",
  "list_integrations",
  "save_integration_credentials",
  "clear_integration_credentials",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export function isValidAction(value: unknown): value is AdminAction {
  return typeof value === "string" && (ADMIN_ACTIONS as readonly string[]).includes(value);
}

/** Nunca deixa passar um nome de grupo vazio/só espaços — mesma regra usada tanto pra criar quanto editar. */
export function sanitizeGroupName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Sanitiza um termo de busca livre antes de embutir num filtro `.or()` do
 * PostgREST — vírgula/parênteses têm significado especial nessa DSL (separam
 * condições) e quebrariam o filtro (nunca uma injeção de SQL de verdade,
 * PostgREST sempre parametriza o valor, mas um termo com "," criaria uma
 * condição extra indesejada). "%"/"_" (curingas do ILIKE) são mantidos de
 * propósito — permitir isso é inofensivo e às vezes até útil pra busca.
 */
export function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[,()]/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Integrações (ERP/marketplace) — credenciais reais, nunca expostas de volta
// ao navegador. Mesmos 6 provedores da migration 0049
// (returns_integration_scaffolding) — nunca duas listas divergentes.
// ---------------------------------------------------------------------------
export const INTEGRATION_PROVIDERS = [
  "tiny",
  "marketplace_mercado_livre",
  "marketplace_shopee",
  "marketplace_shein",
  "marketplace_amazon",
  "marketplace_tiktok",
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export function isValidIntegrationProvider(value: unknown): value is IntegrationProvider {
  return typeof value === "string" && (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
}

export interface IntegrationCredentialInput {
  client_id?: string;
  client_secret?: string;
  access_token?: string;
  refresh_token?: string;
  external_account_id?: string;
  scopes?: string;
}

const CREDENTIAL_FIELDS = ["client_id", "client_secret", "access_token", "refresh_token", "external_account_id", "scopes"] as const;

/** Só os campos de credencial reconhecidos, aparados e não-vazios — nunca deixa um campo arbitrário do corpo da requisição chegar no insert/update. */
export function sanitizeCredentialFields(body: Record<string, unknown>): IntegrationCredentialInput {
  const out: IntegrationCredentialInput = {};
  for (const field of CREDENTIAL_FIELDS) {
    const value = body[field];
    if (typeof value === "string" && value.trim()) out[field] = value.trim();
  }
  return out;
}

export function hasAnyCredentialField(input: IntegrationCredentialInput): boolean {
  return Object.values(input).some((v) => !!v);
}

/** Nunca deixa o segredo real voltar ao navegador — só um resumo (últimos 4 caracteres) pra confirmar visualmente qual valor está salvo, sem reconstituir a chave inteira. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}
