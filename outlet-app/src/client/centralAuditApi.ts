// FASE 6 — Central de Auditoria (Administração > Auditoria). Camada tipada
// isolada em cima da RPC search_central_audit (ver migration
// 0060_central_operational_audit.sql) — une, SÓ PARA CONSULTA, audit_logs +
// invoice_item_scan_events + conference_item_scan_events. Nenhuma tabela
// nova; nenhuma duplicação de evento; admin/super_admin apenas (a RPC já
// rejeita quem não for — esta camada nunca decide autorização sozinha).
import { getSupabase } from "./supabaseClient.ts";

export type CentralAuditModule = "administration" | "outlet" | "nfe";
export type CentralAuditModuleFilter = "all" | CentralAuditModule;

export interface CentralAuditEvent {
  id: string;
  source: "admin" | "nfe" | "outlet";
  module: CentralAuditModule;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  occurredAt: string;
  entityType: string | null;
  entityId: string | null;
  operationId: string | null;
  operationLabel: string | null;
  itemId: string | null;
  sku: string | null;
  ean: string | null;
  deltaQuantity: number | null;
  resultingQuantity: number | null;
  origin: string | null;
  deviceId: string | null;
  volumeId: string | null;
  reversesEventId: string | null;
  excess: boolean | null;
  /** Sempre sanitizado (ver sanitizeAuditMetadata) — nunca o metadata cru do banco. */
  metadata: Record<string, unknown> | null;
}

export interface CentralAuditFilters {
  search: string;
  module: CentralAuditModuleFilter;
  action: string; // "" = todas
  actorId: string; // "" = todos
  dateFrom: string | null; // ISO, ver parseLocalDateRangeIso
  dateTo: string | null; // ISO, ver parseLocalDateRangeIso
}

export interface CentralAuditPage {
  events: CentralAuditEvent[];
  total: number;
}

// ---------------------------------------------------------------------------
// Rótulos humanamente legíveis (rule 22 do pedido) — usados pela tela
// (adminAudit.ts) E pela exportação (exporter.ts), sempre a partir daqui,
// pra UI e Excel nunca divergirem. A ação técnica original é sempre
// preservada nos detalhes/planilha, nunca perdida.
// ---------------------------------------------------------------------------
export const CENTRAL_AUDIT_MODULE_LABEL: Record<CentralAuditModule, string> = {
  administration: "Administração",
  outlet: "Outlet",
  nfe: "Nota Fiscal",
};

const ACTION_LABELS: Record<string, string> = {
  // Outlet/NF-e — sintéticos desta Central (ver migration 0060).
  conference_item_delta: "Ajuste de quantidade",
  conference_status_changed: "Status da conferência alterado",
  invoice_receipt_status_changed: "Status da NF-e alterado",
  scan_increment: "Contagem por incremento",
  manual_set: "Quantidade definida manualmente",
  // Administração — mesmos rótulos já usados no painel administrativo
  // (AUDIT_ACTION_LABELS em adminPanel.ts), preservados aqui pra Central
  // nunca depender de importar uma tela pra pegar um rótulo.
  user_created: "Usuário criado",
  user_updated: "Dados alterados",
  user_activated: "Usuário ativado",
  user_deactivated: "Usuário desativado",
  password_reset_sent: "Link de recuperação enviado",
  temp_password_set: "Senha temporária definida",
  permissions_updated: "Permissões alteradas",
  group_created: "Grupo criado",
  group_updated: "Grupo editado",
  group_deactivated: "Grupo desativado",
  admin_action_denied: "Tentativa administrativa negada",
  user_create_partial_failure: "Criação de usuário incompleta",
  integration_credentials_saved: "Credenciais de integração salvas",
  integration_credentials_cleared: "Credenciais de integração removidas",
  integration_connection_created: "Loja de integração criada",
  integration_connection_updated: "Loja de integração editada",
  integration_connection_activated: "Loja de integração ativada",
  integration_connection_deactivated: "Loja de integração desativada",
  integration_connection_removed: "Loja de integração removida",
  profile_role_or_active_changed: "Papel/ativação de usuário alterado",
};

/** Rótulo legível da ação; nunca esconde a ação técnica original (sempre disponível em details/exportação). */
export function describeCentralAuditAction(action: string): string {
  return ACTION_LABELS[action] || action;
}

/** Lista curada pro filtro [Ação ▼] da Central — só ações realmente emitidas por alguma das 3 fontes (ver migration 0060). */
export const CENTRAL_AUDIT_KNOWN_ACTIONS: { value: string; module: CentralAuditModuleFilter }[] = [
  { value: "scan_increment", module: "nfe" },
  { value: "manual_set", module: "nfe" },
  { value: "conference_item_delta", module: "outlet" },
  { value: "conference_status_changed", module: "outlet" },
  { value: "invoice_receipt_status_changed", module: "nfe" },
  { value: "user_created", module: "administration" },
  { value: "user_updated", module: "administration" },
  { value: "user_activated", module: "administration" },
  { value: "user_deactivated", module: "administration" },
  { value: "password_reset_sent", module: "administration" },
  { value: "temp_password_set", module: "administration" },
  { value: "permissions_updated", module: "administration" },
  { value: "group_created", module: "administration" },
  { value: "group_updated", module: "administration" },
  { value: "group_deactivated", module: "administration" },
  { value: "admin_action_denied", module: "administration" },
  { value: "user_create_partial_failure", module: "administration" },
  { value: "integration_credentials_saved", module: "administration" },
  { value: "integration_credentials_cleared", module: "administration" },
  { value: "integration_connection_created", module: "administration" },
  { value: "integration_connection_updated", module: "administration" },
  { value: "integration_connection_activated", module: "administration" },
  { value: "integration_connection_deactivated", module: "administration" },
  { value: "integration_connection_removed", module: "administration" },
  { value: "profile_role_or_active_changed", module: "administration" },
];

// ---------------------------------------------------------------------------
// Sanitização defensiva de metadata — nenhuma tela/exportação desta Central
// pode revelar segredo nenhum, mesmo que audit_logs hoje não grave nenhum
// (defesa em profundidade: rule 25 do pedido). Percorre objetos/arrays
// recursivamente; chave sensível (case-insensitive) tem o VALOR substituído,
// nunca a chave removida (preserva a forma do dado pra quem for auditar).
// ---------------------------------------------------------------------------
const SENSITIVE_KEY_PATTERN = /password|senha|secret|token|authorization|credential|api[_-]?key/i;

export function sanitizeAuditMetadata<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeAuditMetadata(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeAuditMetadata(v);
    }
    return out as unknown as T;
  }
  return value;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function normalizeEvent(raw: Record<string, unknown>): CentralAuditEvent {
  return {
    id: String(raw.id),
    source: raw.source as CentralAuditEvent["source"],
    module: raw.module as CentralAuditModule,
    action: String(raw.action),
    actorId: str(raw.actor_id),
    actorName: str(raw.actor_name),
    actorEmail: str(raw.actor_email),
    occurredAt: String(raw.occurred_at),
    entityType: str(raw.entity_type),
    entityId: str(raw.entity_id),
    operationId: str(raw.operation_id),
    operationLabel: str(raw.operation_label),
    itemId: str(raw.item_id),
    sku: str(raw.sku),
    ean: str(raw.ean),
    deltaQuantity: num(raw.delta_quantity),
    resultingQuantity: num(raw.resulting_quantity),
    origin: str(raw.origin),
    deviceId: str(raw.device_id),
    volumeId: str(raw.volume_id),
    reversesEventId: str(raw.reverses_event_id),
    excess: raw.excess === null || raw.excess === undefined ? null : Boolean(raw.excess),
    metadata: raw.metadata ? sanitizeAuditMetadata(raw.metadata as Record<string, unknown>) : null,
  };
}

export async function searchCentralAudit(filters: CentralAuditFilters, limit: number, offset: number): Promise<CentralAuditPage> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("search_central_audit", {
    p_search: filters.search || null,
    p_module: filters.module === "all" ? null : filters.module,
    p_action: filters.action || null,
    p_actor_id: filters.actorId || null,
    p_date_from: filters.dateFrom,
    p_date_to: filters.dateTo,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;

  const raw = (data || {}) as { events?: Record<string, unknown>[]; total?: unknown };
  return {
    events: (raw.events || []).map(normalizeEvent),
    total: num(raw.total) ?? 0,
  };
}

/** Limite de segurança pra exportação — acima disso, pede pro usuário reduzir o período/filtro em vez de truncar silenciosamente (ver rule 28 do pedido). */
export const CENTRAL_AUDIT_EXPORT_MAX_EVENTS = 5000;
const EXPORT_BATCH_SIZE = 500;

export class CentralAuditExportTooLargeError extends Error {
  readonly total: number;
  constructor(total: number) {
    super(`O período/filtro selecionado tem ${total} eventos — acima do limite de ${CENTRAL_AUDIT_EXPORT_MAX_EVENTS} para exportação. Reduza o período ou aplique mais filtros.`);
    this.total = total;
  }
}

/** Busca o conjunto FILTRADO COMPLETO (nunca só a página atual), em lotes sequenciais — nunca dezenas de chamadas em paralelo. */
export async function fetchAllCentralAuditEvents(filters: CentralAuditFilters): Promise<CentralAuditEvent[]> {
  const first = await searchCentralAudit(filters, EXPORT_BATCH_SIZE, 0);
  if (first.total > CENTRAL_AUDIT_EXPORT_MAX_EVENTS) {
    throw new CentralAuditExportTooLargeError(first.total);
  }
  const events = [...first.events];
  let offset = EXPORT_BATCH_SIZE;
  while (offset < first.total) {
    const page = await searchCentralAudit(filters, EXPORT_BATCH_SIZE, offset);
    events.push(...page.events);
    offset += EXPORT_BATCH_SIZE;
  }
  return events;
}
