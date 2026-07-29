// EXPANSÃO GOSCAN — Painel de Administração real.
//
// Cliente da Edge Function admin-users — toda operação administrativa passa
// por aqui, nunca lê/escreve profiles/auth.users diretamente pra fins
// administrativos (a Edge Function é quem valida hierarquia/permissão e usa
// service_role). Mesmo padrão de nfeKeyLookup.ts pra extrair mensagem
// sanitizada de erro de invoke — mas aqui não há polling, então cada função
// é só um request/response que joga uma Error real em caso de falha (mesmo
// estilo de describeError()+try/catch usado no resto do app).
import { getSupabase } from "./supabaseClient.ts";

export type Role = "super_admin" | "admin" | "operator" | "viewer";

export interface AdminOverview {
  total_users: number;
  active_users: number;
  inactive_users: number;
  super_admins: number;
  admins: number;
  operators: number;
  viewers: number;
  work_groups: number;
  recent_logins: { id: string; full_name: string | null; role: Role; last_login_at: string }[];
}

export interface AdminUserRow {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  role: Role;
  active: boolean;
  work_group_id: string | null;
  work_groups: { name: string } | { name: string }[] | null;
  last_login_at: string | null;
  created_at: string;
  must_change_password: boolean;
}

export interface WorkGroup {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  created_at: string;
  user_count: number;
}

export interface PermissionRow {
  key: string;
  label: string;
  description: string | null;
  category: string | null;
  role_default: boolean;
  override: boolean | null;
  effective: boolean;
}

export interface AuditLogRow {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  admin_name: string | null;
  admin_email: string | null;
  target_name: string | null;
}

async function describeEdgeError(error: { context?: unknown }): Promise<string> {
  const context = error?.context as { json?: () => Promise<unknown>; clone?: () => { json: () => Promise<unknown> } } | undefined;
  if (context && typeof context.json === "function") {
    try {
      const raw = typeof context.clone === "function" ? await context.clone().json() : await context.json();
      const parsed = raw as { message?: unknown };
      if (parsed && typeof parsed.message === "string") return parsed.message;
    } catch {
      // corpo não era JSON — cai no fallback genérico abaixo.
    }
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

async function invokeAdmin<T = Record<string, unknown>>(action: string, payload: object = {}): Promise<T> {
  const supabase = getSupabase();
  const { data, error } = await supabase.functions.invoke("admin-users", { body: { action, ...payload } });
  if (error) {
    throw new Error(await describeEdgeError(error as { context?: unknown }));
  }
  const body = data as { success: boolean; message?: string } & Record<string, unknown>;
  if (!body?.success) {
    throw new Error(body?.message || "Não foi possível concluir a operação.");
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------
export async function getOverview(): Promise<AdminOverview> {
  const data = await invokeAdmin<{ overview: AdminOverview }>("overview");
  return data.overview;
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------
export interface ListUsersParams {
  search?: string;
  role?: Role;
  status?: "active" | "inactive";
  workGroupId?: string;
  sortField?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}
export interface ListUsersResult {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
}
export async function listUsers(params: ListUsersParams): Promise<ListUsersResult> {
  return invokeAdmin<ListUsersResult>("list_users", params);
}

export interface CreateUserParams {
  fullName: string;
  email: string;
  phone?: string;
  jobTitle?: string;
  workGroupId?: string | null;
  role: Role;
  active?: boolean;
  mustChangePassword?: boolean;
  sendInvite?: boolean;
  tempPassword?: string;
  permissionOverrides?: Record<string, boolean>;
}
export async function createUser(params: CreateUserParams): Promise<{ userId: string; partial?: boolean; message?: string }> {
  return invokeAdmin("create_user", params);
}

export interface UpdateUserParams {
  userId: string;
  fullName?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  workGroupId?: string | null;
  role?: Role;
}
export async function updateUser(params: UpdateUserParams): Promise<void> {
  await invokeAdmin("update_user", params);
}

export async function activateUser(userId: string): Promise<void> {
  await invokeAdmin("activate_user", { userId });
}
export async function deactivateUser(userId: string): Promise<void> {
  await invokeAdmin("deactivate_user", { userId });
}
export async function sendPasswordResetToUser(userId: string): Promise<string> {
  const data = await invokeAdmin<{ message: string }>("send_password_reset", { userId });
  return data.message;
}
export async function setTempPassword(userId: string, tempPassword: string): Promise<void> {
  await invokeAdmin("set_temp_password", { userId, tempPassword });
}

// ---------------------------------------------------------------------------
// Grupos de trabalho
// ---------------------------------------------------------------------------
export async function listGroups(): Promise<WorkGroup[]> {
  const data = await invokeAdmin<{ groups: WorkGroup[] }>("list_groups");
  return data.groups;
}
export async function createGroup(name: string, description?: string): Promise<WorkGroup> {
  const data = await invokeAdmin<{ group: WorkGroup }>("create_group", { name, description });
  return data.group;
}
export async function updateGroup(groupId: string, patch: { name?: string; description?: string | null }): Promise<void> {
  await invokeAdmin("update_group", { groupId, ...patch });
}
export async function deactivateGroup(groupId: string): Promise<void> {
  await invokeAdmin("deactivate_group", { groupId });
}

// ---------------------------------------------------------------------------
// Permissões granulares
// ---------------------------------------------------------------------------
export async function getUserPermissions(userId: string): Promise<PermissionRow[]> {
  const data = await invokeAdmin<{ permissions: PermissionRow[] }>("get_user_permissions", { userId });
  return data.permissions;
}
export async function setUserPermissions(userId: string, overrides: Record<string, boolean | null>): Promise<void> {
  await invokeAdmin("set_user_permissions", { userId, overrides });
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
export interface ListAuditParams {
  adminUserId?: string;
  actionFilter?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}
export interface ListAuditResult {
  logs: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
}
export async function listAuditLogs(params: ListAuditParams): Promise<ListAuditResult> {
  return invokeAdmin<ListAuditResult>("list_audit_logs", params);
}
