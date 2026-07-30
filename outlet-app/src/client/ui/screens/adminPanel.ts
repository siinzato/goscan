// EXPANSÃO GOSCAN — Painel de Administração real (substitui o placeholder
// "chega na próxima etapa"). Toda operação passa pela Edge Function
// admin-users (ver src/client/adminApi.ts) — esta tela nunca lê/escreve
// profiles/auth.users direto pra fins administrativos.
import { escapeHtml, debounce, formatDateTime, describeError, renderErrorWithRetry, passwordRequirements } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction } from "../confirmModal.ts";
import { getAuthState } from "../../auth.ts";
import {
  getOverview,
  listUsers,
  createUser,
  updateUser,
  activateUser,
  deactivateUser,
  sendPasswordResetToUser,
  setTempPassword,
  listGroups,
  createGroup,
  updateGroup,
  deactivateGroup,
  getUserPermissions,
  setUserPermissions,
  listAuditLogs,
  listIntegrationConnections,
  createIntegrationConnection,
  updateIntegrationConnection,
  setIntegrationConnectionActive,
  removeIntegrationConnection,
  saveIntegrationConnectionCredentials,
  clearIntegrationConnectionCredentials,
  type Role,
  type AdminOverview,
  type AdminUserRow,
  type WorkGroup,
  type PermissionRow,
  type AuditLogRow,
  type IntegrationProvider,
  type IntegrationConnection,
  type IntegrationProviderGroup,
} from "../../adminApi.ts";
import { INTEGRATION_PROVIDER_META, INTEGRATION_STATUS_META, type ProviderInfo } from "./profileIntegrations.ts";
import { testTinyConnection } from "../../tinyIntegrationApi.ts";

const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Administrador",
  admin: "Administrador",
  operator: "Operador",
  viewer: "Visualizador",
};

const ROLE_ICON: Record<Role, string> = {
  super_admin: Icon.shieldCheck,
  admin: Icon.shield,
  operator: Icon.user,
  viewer: Icon.eye,
};

type AdminTab = "overview" | "users" | "groups" | "permissions" | "audit" | "integrations";
const ADMIN_TABS: readonly AdminTab[] = ["overview", "users", "groups", "permissions", "audit", "integrations"];
let activeTab: AdminTab = "overview";

// Usuários
let usersPage = 0;
const USERS_PAGE_SIZE = 20;
let usersSearch = "";
let usersRoleFilter: Role | "" = "";
let usersStatusFilter: "active" | "inactive" | "" = "";
let usersGroupFilter = "";
let usersSortField = "full_name";
let usersSortDir: "asc" | "desc" = "asc";

// Grupos (cache curto pra popular selects de grupo em vários lugares)
let cachedGroups: WorkGroup[] = [];

// Auditoria
let auditPage = 0;
const AUDIT_PAGE_SIZE = 20;
let auditActionFilter = "";
let auditDateFrom = "";
let auditDateTo = "";

// Permissões
let permissionsSelectedUserId = "";
let permissionsSelectedUserLabel = "";

function statTile(icon: string, value: number, label: string): string {
  return `<div class="admin-stat-tile">${icon}<strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

function roleBadge(role: Role): string {
  return `<span class="status-badge info">${ROLE_ICON[role]}${escapeHtml(ROLE_LABELS[role])}</span>`;
}

function statusBadge(active: boolean): string {
  return active ? `<span class="status-badge success">${Icon.checkCircle}Ativo</span>` : `<span class="status-badge error">${Icon.userX}Inativo</span>`;
}

function groupNameOf(user: Pick<AdminUserRow, "work_groups">): string {
  const wg = user.work_groups;
  const obj = Array.isArray(wg) ? wg[0] : wg;
  return obj?.name || "-";
}

async function ensureGroupsCached(): Promise<WorkGroup[]> {
  if (cachedGroups.length === 0) {
    try {
      cachedGroups = await listGroups();
    } catch {
      cachedGroups = [];
    }
  }
  return cachedGroups;
}

// ---------------------------------------------------------------------------
// Entrada — cadeado real (Fase A) + shell de abas.
// ---------------------------------------------------------------------------
export function isAllowedIntoAdminPanel(role: Role | undefined): boolean {
  return role === "super_admin" || role === "admin";
}

export async function renderAdminPanel(root: HTMLElement, initialTab?: AdminTab): Promise<void> {
  // Só aplicado num deep-link explícito (ex.: vindo de Perfil > Integrações)
  // — nunca sobrescreve a aba em navegação normal, onde initialTab vem undefined.
  if (initialTab && ADMIN_TABS.includes(initialTab)) activeTab = initialTab;

  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        <button class="btn-secondary" id="btnBackToSettings">${Icon.chevronLeft}Voltar</button>
        <h2>${Icon.shieldCheck}Administração</h2>
        <p class="hint-text">Gerencie usuários, grupos, permissões, integrações e auditoria do GoScan.</p>
        <div class="input-mode-switch admin-tabs" role="tablist" aria-label="Seções da Administração">
          <button class="mode-btn ${activeTab === "overview" ? "active" : ""}" data-admin-tab="overview">${Icon.gauge}Visão geral</button>
          <button class="mode-btn ${activeTab === "users" ? "active" : ""}" data-admin-tab="users">${Icon.users}Usuários</button>
          <button class="mode-btn ${activeTab === "groups" ? "active" : ""}" data-admin-tab="groups">${Icon.usersRound}Grupos</button>
          <button class="mode-btn ${activeTab === "permissions" ? "active" : ""}" data-admin-tab="permissions">${Icon.key}Permissões</button>
          <button class="mode-btn ${activeTab === "integrations" ? "active" : ""}" data-admin-tab="integrations">${Icon.link}Integrações</button>
          <button class="mode-btn ${activeTab === "audit" ? "active" : ""}" data-admin-tab="audit">${Icon.history}Auditoria</button>
        </div>
      </div>
      <div id="adminTabContent"><div class="skeleton skeleton-card"></div></div>
    </section>`;

  root.querySelector("#btnBackToSettings")!.addEventListener("click", () => {
    window.location.hash = "/perfil/configuracoes";
  });
  root.querySelectorAll<HTMLButtonElement>("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.adminTab as AdminTab;
      void renderAdminPanel(root);
    });
  });

  const content = root.querySelector<HTMLElement>("#adminTabContent")!;
  switch (activeTab) {
    case "overview":
      await renderOverviewTab(root, content);
      break;
    case "users":
      await renderUsersTab(root, content);
      break;
    case "groups":
      await renderGroupsTab(root, content);
      break;
    case "permissions":
      await renderPermissionsTab(root, content);
      break;
    case "integrations":
      await renderIntegrationsTab(content);
      break;
    case "audit":
      await renderAuditTab(content);
      break;
  }
}

function switchTab(root: HTMLElement, tab: AdminTab): void {
  activeTab = tab;
  void renderAdminPanel(root);
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------
async function renderOverviewTab(root: HTMLElement, content: HTMLElement): Promise<void> {
  let overview: AdminOverview;
  try {
    overview = await getOverview();
  } catch (err) {
    renderErrorWithRetry(content, "Erro ao carregar visão geral: " + describeError(err), () => void renderOverviewTab(root, content));
    return;
  }

  content.innerHTML = `
    <div class="card">
      <div class="admin-stat-grid">
        ${statTile(Icon.users, overview.total_users, "Total de usuários")}
        ${statTile(Icon.checkCircle, overview.active_users, "Ativos")}
        ${statTile(Icon.userX, overview.inactive_users, "Inativos")}
        ${statTile(Icon.shieldCheck, overview.super_admins, "Super administradores")}
        ${statTile(Icon.shield, overview.admins, "Administradores")}
        ${statTile(Icon.user, overview.operators, "Operadores")}
        ${statTile(Icon.eye, overview.viewers, "Visualizadores")}
        ${statTile(Icon.usersRound, overview.work_groups, "Grupos de trabalho")}
      </div>
    </div>
    <div class="card">
      <h3>Atalhos</h3>
      <div class="review-actions">
        <button class="btn-primary" id="btnQuickNewUser">${Icon.userPlus}Novo usuário</button>
        <button class="btn-secondary" id="btnQuickPermissions">${Icon.key}Gerenciar permissões</button>
        <button class="btn-secondary" id="btnQuickAudit">${Icon.history}Consultar auditoria</button>
      </div>
    </div>
    <div class="card">
      <h3>Acessos recentes</h3>
      ${
        overview.recent_logins.length === 0
          ? `<p class="hint-text">Nenhum acesso registrado ainda.</p>`
          : `<ul class="recent-list">${overview.recent_logins
              .map(
                (r) => `
            <li>
              <div><strong>${escapeHtml(r.full_name || "-")}</strong><span class="hint-text" style="margin:0">${escapeHtml(ROLE_LABELS[r.role])}</span></div>
              <span class="hint-text" style="margin:0">${formatDateTime(r.last_login_at)}</span>
            </li>`
              )
              .join("")}</ul>`
      }
    </div>`;

  content.querySelector("#btnQuickNewUser")!.addEventListener("click", () => {
    switchTab(root, "users");
    // O próximo renderAdminPanel monta a aba Usuários do zero; adia a abertura do modal pro próximo tick.
    setTimeout(() => root.querySelector<HTMLButtonElement>("#btnNewUser")?.click(), 0);
  });
  content.querySelector("#btnQuickPermissions")!.addEventListener("click", () => switchTab(root, "permissions"));
  content.querySelector("#btnQuickAudit")!.addEventListener("click", () => switchTab(root, "audit"));
}

// ---------------------------------------------------------------------------
// Usuários
// ---------------------------------------------------------------------------
async function renderUsersTab(root: HTMLElement, content: HTMLElement): Promise<void> {
  await ensureGroupsCached();

  content.innerHTML = `
    <div class="card">
      <div class="product-card-top">
        <h3 style="margin:0">${Icon.users}Usuários</h3>
        <button class="btn-primary" id="btnNewUser">${Icon.userPlus}Novo usuário</button>
      </div>
      <div class="search-row">
        <input type="text" id="usersSearch" placeholder="Buscar por nome ou e-mail…" value="${escapeHtml(usersSearch)}" />
      </div>
      <div class="chip-row" id="usersFilters">
        <select id="usersRoleFilter" aria-label="Filtrar por papel">
          <option value="">Todos os papéis</option>
          ${(Object.keys(ROLE_LABELS) as Role[]).map((r) => `<option value="${r}" ${usersRoleFilter === r ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("")}
        </select>
        <select id="usersStatusFilter" aria-label="Filtrar por status">
          <option value="">Todos os status</option>
          <option value="active" ${usersStatusFilter === "active" ? "selected" : ""}>Ativo</option>
          <option value="inactive" ${usersStatusFilter === "inactive" ? "selected" : ""}>Inativo</option>
        </select>
        <select id="usersGroupFilter" aria-label="Filtrar por grupo">
          <option value="">Todos os grupos</option>
          ${cachedGroups.map((g) => `<option value="${g.id}" ${usersGroupFilter === g.id ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}
        </select>
      </div>
      <div id="usersResultsWrap"><div class="skeleton skeleton-card"></div></div>
      <div class="pagination" id="usersPagination"></div>
    </div>`;

  content.querySelector("#btnNewUser")!.addEventListener("click", () => void openUserFormModal(root, content, null));

  const searchInput = content.querySelector<HTMLInputElement>("#usersSearch")!;
  const debouncedSearch = debounce((value: string) => {
    usersSearch = value;
    usersPage = 0;
    void loadUsersPage(root, content);
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  content.querySelector("#usersRoleFilter")!.addEventListener("change", (e) => {
    usersRoleFilter = (e.target as HTMLSelectElement).value as Role | "";
    usersPage = 0;
    void loadUsersPage(root, content);
  });
  content.querySelector("#usersStatusFilter")!.addEventListener("change", (e) => {
    usersStatusFilter = (e.target as HTMLSelectElement).value as "active" | "inactive" | "";
    usersPage = 0;
    void loadUsersPage(root, content);
  });
  content.querySelector("#usersGroupFilter")!.addEventListener("change", (e) => {
    usersGroupFilter = (e.target as HTMLSelectElement).value;
    usersPage = 0;
    void loadUsersPage(root, content);
  });

  await loadUsersPage(root, content);
}

async function loadUsersPage(root: HTMLElement, content: HTMLElement): Promise<void> {
  const wrap = content.querySelector<HTMLElement>("#usersResultsWrap")!;
  wrap.innerHTML = `<div class="skeleton skeleton-card"></div>`;
  let result;
  try {
    result = await listUsers({
      search: usersSearch || undefined,
      role: usersRoleFilter || undefined,
      status: usersStatusFilter || undefined,
      workGroupId: usersGroupFilter || undefined,
      sortField: usersSortField,
      sortDir: usersSortDir,
      page: usersPage,
      pageSize: USERS_PAGE_SIZE,
    });
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao buscar usuários: " + describeError(err), () => void loadUsersPage(root, content));
    return;
  }

  if (result.users.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum usuário encontrado com esse filtro/busca.</p></div>`;
  } else {
    wrap.innerHTML = `
      <div class="product-card-list mobile-only">${result.users.map(renderUserCard).join("")}</div>
      <div class="table-wrap desktop-only">
        <table>
          <thead>
            <tr>
              ${sortableHeader("full_name", "Nome")}
              ${sortableHeader("email", "E-mail")}
              <th>Cargo</th>
              <th>Grupo</th>
              ${sortableHeader("role", "Papel")}
              ${sortableHeader("active", "Status")}
              ${sortableHeader("last_login_at", "Último acesso")}
              <th></th>
            </tr>
          </thead>
          <tbody>${result.users.map(renderUserRow).join("")}</tbody>
        </table>
      </div>`;
    wireUserRowActions(root, content, wrap, result.users);
    wrap.querySelectorAll<HTMLButtonElement>("[data-sort-field]").forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sortField!;
        if (usersSortField === field) usersSortDir = usersSortDir === "asc" ? "desc" : "asc";
        else {
          usersSortField = field;
          usersSortDir = "asc";
        }
        void loadUsersPage(root, content);
      });
    });
  }

  const totalPages = Math.max(1, Math.ceil(result.total / USERS_PAGE_SIZE));
  const pag = content.querySelector<HTMLElement>("#usersPagination")!;
  pag.innerHTML = `
    <button class="icon-btn" id="usersPrevPage" ${usersPage === 0 ? "disabled" : ""} aria-label="Página anterior">${Icon.chevronLeft}</button>
    <span class="hint-text">Página ${usersPage + 1} de ${totalPages} (${result.total} usuário${result.total === 1 ? "" : "s"})</span>
    <button class="icon-btn" id="usersNextPage" ${usersPage + 1 >= totalPages ? "disabled" : ""} aria-label="Próxima página">${Icon.chevronRight}</button>`;
  pag.querySelector("#usersPrevPage")!.addEventListener("click", () => {
    if (usersPage > 0) {
      usersPage--;
      void loadUsersPage(root, content);
    }
  });
  pag.querySelector("#usersNextPage")!.addEventListener("click", () => {
    usersPage++;
    void loadUsersPage(root, content);
  });
}

function sortableHeader(field: string, label: string): string {
  const active = usersSortField === field;
  return `<th data-sort-field="${field}" style="cursor:pointer;white-space:nowrap">${escapeHtml(label)} ${active ? Icon.arrowUpDown : ""}</th>`;
}

function renderUserCard(u: AdminUserRow): string {
  return `
    <div class="product-card" data-user-row="${u.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(u.full_name || "(sem nome)")}</p>
        ${statusBadge(u.active)}
      </div>
      <div class="product-card-meta">
        <span>${escapeHtml(u.email || "-")}</span>
        <span>${escapeHtml(u.job_title || "-")}</span>
        <span>${escapeHtml(groupNameOf(u))}</span>
        ${roleBadge(u.role)}
      </div>
      <div class="product-card-meta">
        <span>Último acesso: ${formatDateTime(u.last_login_at)}</span>
        ${u.must_change_password ? `<span class="status-badge warning">${Icon.key}Troca de senha pendente</span>` : ""}
      </div>
      <div class="product-card-actions" data-user-actions="${u.id}"></div>
    </div>`;
}

function renderUserRow(u: AdminUserRow): string {
  return `
    <tr data-user-row="${u.id}">
      <td>${escapeHtml(u.full_name || "-")}</td>
      <td>${escapeHtml(u.email || "-")}</td>
      <td>${escapeHtml(u.job_title || "-")}</td>
      <td>${escapeHtml(groupNameOf(u))}</td>
      <td>${roleBadge(u.role)}</td>
      <td>${statusBadge(u.active)}</td>
      <td>${formatDateTime(u.last_login_at)}</td>
      <td data-user-actions="${u.id}"></td>
    </tr>`;
}

function userActionsMenu(u: AdminUserRow, canManage: boolean): string {
  if (!canManage) return `<span class="hint-text" style="margin:0">${Icon.lock}Sem acesso</span>`;
  return `
    <div class="review-actions" style="margin:0">
      <button type="button" class="icon-btn" data-action-edit="${u.id}" title="Editar" aria-label="Editar">${Icon.pencil}</button>
      <button type="button" class="icon-btn" data-action-permissions="${u.id}" title="Permissões" aria-label="Gerenciar permissões">${Icon.key}</button>
      <button type="button" class="icon-btn" data-action-reset="${u.id}" title="Enviar link de recuperação" aria-label="Enviar link de recuperação">${Icon.mail}</button>
      <button type="button" class="icon-btn" data-action-temp-password="${u.id}" title="Definir senha temporária" aria-label="Definir senha temporária">${Icon.lock}</button>
      ${
        u.active
          ? `<button type="button" class="icon-btn danger" data-action-deactivate="${u.id}" title="Desativar" aria-label="Desativar">${Icon.userX}</button>`
          : `<button type="button" class="icon-btn" data-action-activate="${u.id}" title="Ativar" aria-label="Ativar">${Icon.checkCircle}</button>`
      }
    </div>`;
}

function wireUserRowActions(root: HTMLElement, content: HTMLElement, wrap: HTMLElement, users: AdminUserRow[]): void {
  const { profile } = getAuthState();
  const callerRole = profile?.role as Role | undefined;

  for (const u of users) {
    const canManage = !!callerRole && (callerRole === "super_admin" ? true : callerRole === "admin" ? u.role === "operator" || u.role === "viewer" : false);
    wrap.querySelectorAll(`[data-user-actions="${u.id}"]`).forEach((el) => {
      el.innerHTML = userActionsMenu(u, canManage);
    });
  }

  wrap.querySelectorAll<HTMLButtonElement>("[data-action-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const user = users.find((u) => u.id === btn.dataset.actionEdit);
      if (user) void openUserFormModal(root, content, user);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-action-permissions]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const user = users.find((u) => u.id === btn.dataset.actionPermissions);
      if (!user) return;
      permissionsSelectedUserId = user.id;
      permissionsSelectedUserLabel = `${user.full_name || user.email || "-"} (${ROLE_LABELS[user.role]})`;
      switchTab(root, "permissions");
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-action-reset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.actionReset!;
      btn.disabled = true;
      try {
        const message = await sendPasswordResetToUser(userId);
        showToast(message, "success");
      } catch (err) {
        showToast(describeError(err), "error");
      } finally {
        btn.disabled = false;
      }
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-action-temp-password]").forEach((btn) => {
    btn.addEventListener("click", () => openTempPasswordModal(btn.dataset.actionTempPassword!, () => void loadUsersPage(root, content)));
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-action-deactivate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const user = users.find((u) => u.id === btn.dataset.actionDeactivate);
      const confirmed = await confirmAction({
        title: "Desativar usuário?",
        message: `${user?.full_name || "Este usuário"} não conseguirá mais acessar o GoScan. O histórico de conferências já realizadas é preservado.`,
        confirmLabel: "Desativar",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await deactivateUser(btn.dataset.actionDeactivate!);
        showToast("Usuário desativado.", "success");
        void loadUsersPage(root, content);
      } catch (err) {
        showToast(describeError(err), "error");
      }
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-action-activate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await activateUser(btn.dataset.actionActivate!);
        showToast("Usuário ativado.", "success");
        void loadUsersPage(root, content);
      } catch (err) {
        showToast(describeError(err), "error");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Modal genérico (mesma linguagem visual de confirmModal.ts: .modal-overlay/.modal-sheet)
// ---------------------------------------------------------------------------
function openModal(bodyHtml: string, labelledBy: string): { overlay: HTMLDivElement; sheet: HTMLDivElement; close: () => void } {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="${labelledBy}">${bodyHtml}</div>`;
  document.body.appendChild(overlay);
  const sheet = overlay.querySelector<HTMLDivElement>(".modal-sheet")!;

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  }
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKeydown);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, sheet: sheet as HTMLDivElement, close };
}

// ---------------------------------------------------------------------------
// Criar/editar usuário
// ---------------------------------------------------------------------------
async function openUserFormModal(root: HTMLElement, content: HTMLElement, existing: AdminUserRow | null): Promise<void> {
  await ensureGroupsCached();
  const { profile } = getAuthState();
  const callerRole = profile?.role as Role | undefined;
  const isEdit = !!existing;

  const roleOptions: Role[] = callerRole === "super_admin" ? ["super_admin", "admin", "operator", "viewer"] : ["admin", "operator", "viewer"];

  const { close } = openModal(
    `
    <h3 id="userFormTitle">${isEdit ? "Editar usuário" : "Novo usuário"}</h3>
    <form id="userForm" novalidate>
      <label for="ufFullName">Nome completo</label>
      <input type="text" id="ufFullName" required value="${escapeHtml(existing?.full_name || "")}" />

      <label for="ufEmail">E-mail de trabalho</label>
      <input type="email" id="ufEmail" required value="${escapeHtml(existing?.email || "")}" />

      <label for="ufPhone">Telefone</label>
      <input type="tel" id="ufPhone" placeholder="(11) 91234-5678" value="${escapeHtml(existing?.phone || "")}" />

      <label for="ufJobTitle">Cargo</label>
      <input type="text" id="ufJobTitle" value="${escapeHtml(existing?.job_title || "")}" />

      <label for="ufWorkGroup">Grupo de trabalho</label>
      <select id="ufWorkGroup">
        <option value="">Nenhum</option>
        ${cachedGroups.map((g) => `<option value="${g.id}" ${existing?.work_group_id === g.id ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("")}
      </select>

      <label for="ufRole">Papel</label>
      <select id="ufRole">
        ${roleOptions.map((r) => `<option value="${r}" ${(existing?.role || "operator") === r ? "selected" : ""}>${ROLE_LABELS[r]}</option>`).join("")}
      </select>
      ${callerRole === "admin" ? `<p class="hint-text" style="margin-top:-10px">Criar/definir um Administrador exige uma permissão especial concedida pelo super administrador.</p>` : ""}

      <label for="ufStatus">Status</label>
      <select id="ufStatus">
        <option value="active" ${existing?.active !== false ? "selected" : ""}>Ativo</option>
        <option value="inactive" ${existing?.active === false ? "selected" : ""}>Inativo</option>
      </select>

      ${
        isEdit
          ? ""
          : `
      <div class="input-mode-switch" style="margin:12px 0">
        <button type="button" class="mode-btn active" id="ufModeSenha">${Icon.lock}Senha temporária</button>
        <button type="button" class="mode-btn" id="ufModeConvite">${Icon.mail}Enviar convite</button>
      </div>
      <div id="ufPasswordFields">
        <label for="ufTempPassword">Senha temporária</label>
        <div class="password-field">
          <input type="password" id="ufTempPassword" autocomplete="new-password" />
          <button type="button" class="icon-btn" id="ufTogglePassword" aria-label="Mostrar senha">${Icon.eye}</button>
        </div>
        <ul class="password-requirements" id="ufPasswordReqs"></ul>
        <label for="ufTempPasswordConfirm">Confirmar senha temporária</label>
        <input type="password" id="ufTempPasswordConfirm" autocomplete="new-password" />
        <label class="hint-text" style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <input type="checkbox" id="ufMustChange" checked /> Exigir alteração de senha no primeiro acesso
        </label>
      </div>
      <p class="hint-text" id="ufInviteHint" hidden>Um e-mail de convite será enviado — o próprio usuário define a senha inicial.</p>`
      }

      <p class="error-box" id="ufError" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="ufCancel">Cancelar</button>
        <button type="submit" class="btn-primary" id="ufSubmit">${isEdit ? "Salvar alterações" : "Criar usuário"}</button>
      </div>
    </form>`,
    "userFormTitle"
  );

  const modalRoot = document.querySelector(".modal-overlay:last-of-type")!;
  const form = modalRoot.querySelector<HTMLFormElement>("#userForm")!;
  const errorEl = modalRoot.querySelector<HTMLElement>("#ufError")!;
  const submitBtn = modalRoot.querySelector<HTMLButtonElement>("#ufSubmit")!;

  modalRoot.querySelector("#ufCancel")!.addEventListener("click", close);

  let sendInvite = false;
  const passwordFields = modalRoot.querySelector<HTMLElement>("#ufPasswordFields");
  const inviteHint = modalRoot.querySelector<HTMLElement>("#ufInviteHint");
  const modeSenhaBtn = modalRoot.querySelector<HTMLButtonElement>("#ufModeSenha");
  const modeConviteBtn = modalRoot.querySelector<HTMLButtonElement>("#ufModeConvite");
  modeSenhaBtn?.addEventListener("click", () => {
    sendInvite = false;
    modeSenhaBtn.classList.add("active");
    modeConviteBtn?.classList.remove("active");
    if (passwordFields) passwordFields.hidden = false;
    if (inviteHint) inviteHint.hidden = true;
  });
  modeConviteBtn?.addEventListener("click", () => {
    sendInvite = true;
    modeConviteBtn.classList.add("active");
    modeSenhaBtn?.classList.remove("active");
    if (passwordFields) passwordFields.hidden = true;
    if (inviteHint) inviteHint.hidden = false;
  });

  const tempPasswordInput = modalRoot.querySelector<HTMLInputElement>("#ufTempPassword");
  const reqsEl = modalRoot.querySelector<HTMLElement>("#ufPasswordReqs");
  function renderReqs(): void {
    if (!reqsEl || !tempPasswordInput) return;
    const reqs = passwordRequirements(tempPasswordInput.value);
    reqsEl.innerHTML = reqs.map((r) => `<li class="${r.met ? "met" : ""}">${r.met ? Icon.checkCircle : Icon.xCircle}<span>${escapeHtml(r.label)}</span></li>`).join("");
  }
  tempPasswordInput?.addEventListener("input", renderReqs);
  renderReqs();

  modalRoot.querySelector("#ufTogglePassword")?.addEventListener("click", () => {
    if (!tempPasswordInput) return;
    tempPasswordInput.type = tempPasswordInput.type === "password" ? "text" : "password";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    const fullName = (modalRoot.querySelector<HTMLInputElement>("#ufFullName")!).value.trim();
    const email = (modalRoot.querySelector<HTMLInputElement>("#ufEmail")!).value.trim();
    const phone = (modalRoot.querySelector<HTMLInputElement>("#ufPhone")!).value.trim();
    const jobTitle = (modalRoot.querySelector<HTMLInputElement>("#ufJobTitle")!).value.trim();
    const workGroupId = (modalRoot.querySelector<HTMLSelectElement>("#ufWorkGroup")!).value || null;
    const role = (modalRoot.querySelector<HTMLSelectElement>("#ufRole")!).value as Role;
    const active = (modalRoot.querySelector<HTMLSelectElement>("#ufStatus")!).value === "active";

    if (!fullName) {
      errorEl.textContent = "Nome completo é obrigatório.";
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = isEdit ? "Salvando…" : "Criando…";
    try {
      if (isEdit && existing) {
        await updateUser({ userId: existing.id, fullName, email, phone, jobTitle, workGroupId, role });
        if (active !== existing.active) {
          if (active) await activateUser(existing.id);
          else await deactivateUser(existing.id);
        }
        showToast("Usuário atualizado.", "success");
      } else {
        const tempPassword = (modalRoot.querySelector<HTMLInputElement>("#ufTempPassword") as HTMLInputElement)?.value || "";
        const tempPasswordConfirm = (modalRoot.querySelector<HTMLInputElement>("#ufTempPasswordConfirm") as HTMLInputElement)?.value || "";
        const mustChangePassword = (modalRoot.querySelector<HTMLInputElement>("#ufMustChange") as HTMLInputElement)?.checked ?? true;

        if (!sendInvite && tempPassword !== tempPasswordConfirm) {
          errorEl.textContent = "As senhas temporárias não coincidem.";
          errorEl.hidden = false;
          submitBtn.disabled = false;
          submitBtn.textContent = "Criar usuário";
          return;
        }

        const result = await createUser({
          fullName,
          email,
          phone: phone || undefined,
          jobTitle: jobTitle || undefined,
          workGroupId,
          role,
          active,
          mustChangePassword,
          sendInvite,
          tempPassword: sendInvite ? undefined : tempPassword,
        });
        showToast(result.partial ? result.message || "Usuário criado parcialmente." : "Usuário criado com sucesso.", result.partial ? "error" : "success");
      }
      close();
      await loadUsersPage(root, content);
    } catch (err) {
      errorEl.textContent = describeError(err);
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? "Salvar alterações" : "Criar usuário";
    }
  });
}

function openTempPasswordModal(userId: string, onDone: () => void): void {
  const { close } = openModal(
    `
    <h3 id="tempPwTitle">${Icon.lock}Definir senha temporária</h3>
    <p class="hint-text">O usuário deverá trocar essa senha no próximo login. Ela nunca é exibida novamente depois de definida.</p>
    <form id="tempPwForm">
      <label for="tempPwInput">Nova senha temporária</label>
      <div class="password-field">
        <input type="password" id="tempPwInput" autocomplete="new-password" required />
        <button type="button" class="icon-btn" id="tempPwToggle" aria-label="Mostrar senha">${Icon.eye}</button>
      </div>
      <ul class="password-requirements" id="tempPwReqs"></ul>
      <p class="error-box" id="tempPwError" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="tempPwCancel">Cancelar</button>
        <button type="submit" class="btn-primary" id="tempPwSubmit">Definir senha</button>
      </div>
    </form>`,
    "tempPwTitle"
  );
  const modalRoot = document.querySelector(".modal-overlay:last-of-type")!;
  const input = modalRoot.querySelector<HTMLInputElement>("#tempPwInput")!;
  const reqsEl = modalRoot.querySelector<HTMLElement>("#tempPwReqs")!;
  const errorEl = modalRoot.querySelector<HTMLElement>("#tempPwError")!;

  function renderReqs(): void {
    reqsEl.innerHTML = passwordRequirements(input.value)
      .map((r) => `<li class="${r.met ? "met" : ""}">${r.met ? Icon.checkCircle : Icon.xCircle}<span>${escapeHtml(r.label)}</span></li>`)
      .join("");
  }
  input.addEventListener("input", renderReqs);
  renderReqs();

  modalRoot.querySelector("#tempPwToggle")!.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
  });
  modalRoot.querySelector("#tempPwCancel")!.addEventListener("click", close);
  modalRoot.querySelector("#tempPwForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = modalRoot.querySelector<HTMLButtonElement>("#tempPwSubmit")!;
    submitBtn.disabled = true;
    try {
      await setTempPassword(userId, input.value);
      showToast("Senha temporária definida. O usuário deverá trocá-la no próximo login.", "success");
      close();
      onDone();
    } catch (err) {
      errorEl.textContent = describeError(err);
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Grupos de trabalho
// ---------------------------------------------------------------------------
async function renderGroupsTab(root: HTMLElement, content: HTMLElement): Promise<void> {
  content.innerHTML = `
    <div class="card">
      <div class="product-card-top">
        <h3 style="margin:0">${Icon.usersRound}Grupos de trabalho</h3>
        <button class="btn-primary" id="btnNewGroup">${Icon.plus}Novo grupo</button>
      </div>
      <div id="groupsWrap"><div class="skeleton skeleton-card"></div></div>
    </div>`;

  content.querySelector("#btnNewGroup")!.addEventListener("click", () => openGroupFormModal(root, content, null));
  await loadGroupsList(root, content);
}

async function loadGroupsList(root: HTMLElement, content: HTMLElement): Promise<void> {
  const wrap = content.querySelector<HTMLElement>("#groupsWrap")!;
  let groups: WorkGroup[];
  try {
    groups = await listGroups();
    cachedGroups = groups;
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao buscar grupos: " + describeError(err), () => void loadGroupsList(root, content));
    return;
  }

  if (groups.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.usersRound}<p>Nenhum grupo de trabalho cadastrado ainda.</p></div>`;
    return;
  }

  wrap.innerHTML = `<div class="product-card-list">${groups
    .map(
      (g) => `
    <div class="product-card" data-group-row="${g.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(g.name)}</p>
        ${g.active ? `<span class="status-badge success">${Icon.checkCircle}Ativo</span>` : `<span class="status-badge error">Inativo</span>`}
      </div>
      <div class="product-card-meta">
        <span>${escapeHtml(g.description || "Sem descrição")}</span>
        <span>${g.user_count} usuário${g.user_count === 1 ? "" : "s"}</span>
      </div>
      <div class="review-actions" style="margin:0">
        <button type="button" class="icon-btn" data-group-edit="${g.id}" aria-label="Editar grupo">${Icon.pencil}</button>
        ${g.active ? `<button type="button" class="icon-btn danger" data-group-deactivate="${g.id}" aria-label="Desativar grupo">${Icon.userX}</button>` : ""}
      </div>
    </div>`
    )
    .join("")}</div>`;

  wrap.querySelectorAll<HTMLButtonElement>("[data-group-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = groups.find((x) => x.id === btn.dataset.groupEdit);
      if (g) openGroupFormModal(root, content, g);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-group-deactivate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const g = groups.find((x) => x.id === btn.dataset.groupDeactivate);
      const confirmed = await confirmAction({
        title: "Desativar grupo?",
        message: `"${g?.name}" deixará de aparecer como opção pra novos usuários.`,
        confirmLabel: "Desativar",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await deactivateGroup(btn.dataset.groupDeactivate!);
        showToast("Grupo desativado.", "success");
        void loadGroupsList(root, content);
      } catch (err) {
        showToast(describeError(err), "error");
      }
    });
  });
}

function openGroupFormModal(root: HTMLElement, content: HTMLElement, existing: WorkGroup | null): void {
  const isEdit = !!existing;
  const { close } = openModal(
    `
    <h3 id="groupFormTitle">${isEdit ? "Editar grupo" : "Novo grupo de trabalho"}</h3>
    <form id="groupForm">
      <label for="gfName">Nome</label>
      <input type="text" id="gfName" required value="${escapeHtml(existing?.name || "")}" />
      <label for="gfDescription">Descrição</label>
      <textarea id="gfDescription" rows="3">${escapeHtml(existing?.description || "")}</textarea>
      <p class="error-box" id="gfError" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="gfCancel">Cancelar</button>
        <button type="submit" class="btn-primary" id="gfSubmit">${isEdit ? "Salvar" : "Criar grupo"}</button>
      </div>
    </form>`,
    "groupFormTitle"
  );
  const modalRoot = document.querySelector(".modal-overlay:last-of-type")!;
  modalRoot.querySelector("#gfCancel")!.addEventListener("click", close);
  modalRoot.querySelector("#groupForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = modalRoot.querySelector<HTMLElement>("#gfError")!;
    const submitBtn = modalRoot.querySelector<HTMLButtonElement>("#gfSubmit")!;
    const name = (modalRoot.querySelector<HTMLInputElement>("#gfName")!).value.trim();
    const description = (modalRoot.querySelector<HTMLTextAreaElement>("#gfDescription")!).value.trim();
    if (!name) {
      errorEl.textContent = "Nome do grupo é obrigatório.";
      errorEl.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    try {
      if (isEdit && existing) await updateGroup(existing.id, { name, description: description || null });
      else await createGroup(name, description || undefined);
      showToast(isEdit ? "Grupo atualizado." : "Grupo criado.", "success");
      close();
      cachedGroups = [];
      await loadGroupsList(root, content);
    } catch (err) {
      errorEl.textContent = describeError(err);
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Permissões — escolhe um usuário (vindo da lista, ou buscando aqui mesmo) e
// mostra o checklist agrupado por categoria.
// ---------------------------------------------------------------------------
async function renderPermissionsTab(root: HTMLElement, content: HTMLElement): Promise<void> {
  content.innerHTML = `
    <div class="card">
      <h3>${Icon.key}Permissões por usuário</h3>
      <p class="hint-text">Escolha um usuário na aba Usuários (ícone de chave) ou busque aqui pra ver/editar as permissões dele.</p>
      <div class="search-row">
        <input type="text" id="permsUserSearch" placeholder="Buscar usuário por nome ou e-mail…" />
      </div>
      <div id="permsUserResults"></div>
      <p class="hint-text" id="permsSelectedLabel">${permissionsSelectedUserId ? `Selecionado: <strong>${escapeHtml(permissionsSelectedUserLabel)}</strong>` : "Nenhum usuário selecionado."}</p>
    </div>
    <div id="permsChecklistWrap"></div>`;

  const searchInput = content.querySelector<HTMLInputElement>("#permsUserSearch")!;
  const resultsWrap = content.querySelector<HTMLElement>("#permsUserResults")!;
  const debouncedSearch = debounce(async (value: string) => {
    if (!value.trim()) {
      resultsWrap.innerHTML = "";
      return;
    }
    try {
      const result = await listUsers({ search: value, page: 0, pageSize: 8 });
      if (result.users.length === 0) {
        resultsWrap.innerHTML = `<p class="hint-text">Nenhum usuário encontrado.</p>`;
        return;
      }
      resultsWrap.innerHTML = result.users
        .map(
          (u) =>
            `<button type="button" class="sku-picker-item" data-perm-pick="${u.id}" data-label="${escapeHtml(`${u.full_name || u.email || "-"} (${ROLE_LABELS[u.role]})`)}">${escapeHtml(
              u.full_name || u.email || "-"
            )} <span class="sku-code">${escapeHtml(ROLE_LABELS[u.role])}</span></button>`
        )
        .join("");
      resultsWrap.querySelectorAll<HTMLButtonElement>("[data-perm-pick]").forEach((btn) => {
        btn.addEventListener("click", () => {
          permissionsSelectedUserId = btn.dataset.permPick!;
          permissionsSelectedUserLabel = btn.dataset.label!;
          void renderPermissionsTab(root, content);
        });
      });
    } catch {
      resultsWrap.innerHTML = `<p class="error-box">Erro ao buscar usuários.</p>`;
    }
  }, 350);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  if (permissionsSelectedUserId) {
    await loadPermissionsChecklist(content);
  }
}

async function loadPermissionsChecklist(content: HTMLElement): Promise<void> {
  const wrap = content.querySelector<HTMLElement>("#permsChecklistWrap")!;
  wrap.innerHTML = `<div class="card"><div class="skeleton skeleton-card"></div></div>`;
  let permissions: PermissionRow[];
  try {
    permissions = await getUserPermissions(permissionsSelectedUserId);
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao carregar permissões: " + describeError(err), () => void loadPermissionsChecklist(content));
    return;
  }

  const byCategory = new Map<string, PermissionRow[]>();
  for (const p of permissions) {
    const cat = p.category || "Outros";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(p);
  }

  wrap.innerHTML = `
    <div class="card">
      ${Array.from(byCategory.entries())
        .map(
          ([category, perms]) => `
        <div class="permission-category">
          <div class="product-card-top">
            <strong>${escapeHtml(category)}</strong>
            <button type="button" class="link-btn" data-select-all="${escapeHtml(category)}">Marcar todas</button>
          </div>
          ${perms
            .map(
              (p) => `
            <label class="hint-text" style="display:flex;align-items:center;gap:8px;margin:6px 0">
              <input type="checkbox" data-perm-key="${p.key}" data-perm-category="${escapeHtml(category)}" ${p.effective ? "checked" : ""} />
              <span>${escapeHtml(p.label)}${p.override !== null ? ` <span class="status-badge info">Personalizado</span>` : ""}</span>
            </label>`
            )
            .join("")}
        </div>`
        )
        .join("")}
      <div class="review-actions">
        <button type="button" class="btn-secondary" id="permsRestoreDefault">${Icon.refresh}Restaurar padrão do papel</button>
        <button type="button" class="btn-primary" id="permsSave">Salvar alterações</button>
      </div>
    </div>`;

  wrap.querySelectorAll<HTMLButtonElement>("[data-select-all]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const category = btn.dataset.selectAll!;
      wrap.querySelectorAll<HTMLInputElement>(`[data-perm-category="${CSS.escape(category)}"]`).forEach((cb) => (cb.checked = true));
    });
  });

  wrap.querySelector("#permsRestoreDefault")!.addEventListener("click", async () => {
    const overrides: Record<string, null> = {};
    for (const p of permissions) overrides[p.key] = null; // null remove o override -> volta ao padrão do papel
    try {
      await setUserPermissions(permissionsSelectedUserId, overrides);
      showToast("Permissões restauradas ao padrão do papel.", "success");
      await loadPermissionsChecklist(content);
    } catch (err) {
      showToast(describeError(err), "error");
    }
  });

  wrap.querySelector("#permsSave")!.addEventListener("click", async () => {
    const overrides: Record<string, boolean> = {};
    wrap.querySelectorAll<HTMLInputElement>("[data-perm-key]").forEach((cb) => {
      const key = cb.dataset.permKey!;
      const perm = permissions.find((p) => p.key === key)!;
      // Só grava override quando difere do padrão do papel — evita acumular
      // overrides redundantes que nunca mais "voltariam ao padrão" sozinhos.
      if (cb.checked !== perm.role_default) overrides[key] = cb.checked;
      else if (perm.override !== null) overrides[key] = null as unknown as boolean; // volta ao padrão explicitamente
    });
    const btn = wrap.querySelector<HTMLButtonElement>("#permsSave")!;
    btn.disabled = true;
    try {
      await setUserPermissions(permissionsSelectedUserId, overrides);
      showToast("Permissões salvas.", "success");
      await loadPermissionsChecklist(content);
    } catch (err) {
      showToast(describeError(err), "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Integrações — cadastro real das credenciais de API do ERP (Tiny/Olist) e
// dos marketplaces. Cada marketplace suporta até 4 lojas/conexões
// independentes (nome, credenciais, tokens, status e logs próprios — editar
// ou remover uma nunca afeta as outras). O Tiny NÃO faz parte deste recurso
// (pedido, seção 9: não é um marketplace, continua com exatamente 1 conexão,
// UX inalterada) — a única distinção por provedor em toda esta tela é
// `isTiny`, usada só pra decidir se mostra a lista de lojas + "Adicionar
// loja" ou o card único de sempre; todo o resto (criar/editar/testar/
// ativar/remover) é um único modelo genérico de conexão reutilizado por
// qualquer provedor. Todo o CRUD passa pela Edge Function admin-users
// (service_role) — nunca lê/escreve integration_credentials direto (essa
// tabela tem RLS habilitado e ZERO policies, então nem conseguiria). Nenhum
// segredo em texto puro chega aqui depois de salvo, só um resumo mascarado.
// ---------------------------------------------------------------------------
async function renderIntegrationsTab(content: HTMLElement): Promise<void> {
  content.innerHTML = `
    <div class="card">
      <h3>${Icon.link}Credenciais de integração</h3>
      <p class="hint-text">Cadastre aqui as chaves de API do ERP e as lojas de cada marketplace (até 4 lojas por marketplace). Elas ficam guardadas com segurança no backend — nunca aparecem novamente em texto completo, e nenhuma chamada externa é feita automaticamente só por estarem salvas aqui.</p>
    </div>
    <div id="integrationsListWrap"><div class="skeleton skeleton-card"></div></div>`;

  await loadIntegrationsList(content);
}

async function loadIntegrationsList(content: HTMLElement): Promise<void> {
  const wrap = content.querySelector<HTMLElement>("#integrationsListWrap")!;
  let providers: IntegrationProviderGroup[];
  try {
    providers = await listIntegrationConnections();
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao carregar integrações: " + describeError(err), () => void loadIntegrationsList(content));
    return;
  }

  providersCache = providers;
  const byProvider = new Map(providers.map((p) => [p.provider, p]));
  wrap.innerHTML = INTEGRATION_PROVIDER_META.map((meta) =>
    renderProviderGroup(meta, byProvider.get(meta.key) ?? { provider: meta.key, connections: [], count: 0, limit: 4 })
  ).join("");

  wireIntegrationsListEvents(content, wrap);
}

function wireIntegrationsListEvents(content: HTMLElement, wrap: HTMLElement): void {
  wrap.querySelectorAll<HTMLButtonElement>("[data-add-connection]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const provider = btn.dataset.addConnection as IntegrationProvider;
      const meta = INTEGRATION_PROVIDER_META.find((m) => m.key === provider)!;
      openConnectionMetaModal(content, meta, null);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-conn-rename]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { meta, connection } = findConnectionContext(providersCache, btn.dataset.connRename!);
      if (connection) openConnectionMetaModal(content, meta, connection);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-conn-credentials]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { meta, connection } = findConnectionContext(providersCache, btn.dataset.connCredentials!);
      if (connection) openIntegrationCredentialsModal(content, meta, connection);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-conn-test]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "Testando…";
      try {
        const result = await testTinyConnection();
        showToast(result.connected ? "Conexão com o Tiny confirmada." : "Não foi possível confirmar a conexão.", result.connected ? "success" : "error");
      } catch (err) {
        showToast("Falha ao testar conexão: " + describeError(err), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
        await loadIntegrationsList(content);
      }
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-conn-test-stub]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { meta } = findConnectionContext(providersCache, btn.dataset.connTestStub!);
      showToast(`Verificação automática de conexão ainda não implementada para ${meta.name} — disponível hoje apenas para o Tiny.`, "default");
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-conn-toggle-active]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const connectionId = btn.dataset.connToggleActive!;
      const nextActive = btn.dataset.connActive !== "true";
      try {
        await setIntegrationConnectionActive(connectionId, nextActive);
        showToast(nextActive ? "Loja ativada." : "Loja desativada.", "success");
        await loadIntegrationsList(content);
      } catch (err) {
        showToast(describeError(err), "error");
      }
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-conn-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { meta, connection } = findConnectionContext(providersCache, btn.dataset.connRemove!);
      if (!connection) return;
      const confirmed = await confirmAction({
        title: "Remover loja?",
        message: `A loja "${connection.display_name || meta.name}" e todas as credenciais salvas nela serão removidas. Esta ação não pode ser desfeita.`,
        confirmLabel: "Remover",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await removeIntegrationConnection(connection.id);
        showToast("Loja removida.", "success");
        await loadIntegrationsList(content);
      } catch (err) {
        showToast(describeError(err), "error");
      }
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-conn-clear-credentials]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { meta, connection } = findConnectionContext(providersCache, btn.dataset.connClearCredentials!);
      if (!connection) return;
      const confirmed = await confirmAction({
        title: "Remover credenciais?",
        message: `As credenciais salvas de "${meta.name}" serão apagadas e o status volta para "Não configurada". Esta ação não pode ser desfeita.`,
        confirmLabel: "Remover",
        danger: true,
      });
      if (!confirmed) return;
      try {
        await clearIntegrationConnectionCredentials(connection.id);
        showToast("Credenciais removidas.", "success");
        await loadIntegrationsList(content);
      } catch (err) {
        showToast(describeError(err), "error");
      }
    });
  });
}

/** Cache em memória da última listagem carregada — só pra resolver qual loja um botão da lista se refere sem re-buscar a rede a cada clique (a lista inteira já está na tela). Sempre reatribuído em loadIntegrationsList antes de renderizar. */
let providersCache: IntegrationProviderGroup[] = [];

function findConnectionContext(providers: IntegrationProviderGroup[], connectionId: string): { meta: ProviderInfo; connection: IntegrationConnection | null } {
  for (const group of providers) {
    const connection = group.connections.find((c) => c.id === connectionId);
    if (connection) return { meta: INTEGRATION_PROVIDER_META.find((m) => m.key === group.provider)!, connection };
  }
  return { meta: INTEGRATION_PROVIDER_META[0], connection: null };
}

function renderProviderGroup(meta: ProviderInfo, group: IntegrationProviderGroup): string {
  const isTiny = meta.key === "tiny";
  if (isTiny) {
    // Tiny sempre tem exatamente 1 conexão (garantida por migration 0052) — UX idêntica à de antes de existir múltiplas lojas.
    const connection = group.connections[0] ?? null;
    return `
      <div class="card" data-provider-group="${meta.key}">
        <div class="product-card-top">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="integration-provider-icon">${meta.icon}</span>
            <p class="product-card-name">${escapeHtml(meta.name)}</p>
          </div>
        </div>
        <p class="hint-text" style="margin:4px 0 10px">${escapeHtml(meta.description)}</p>
        ${connection ? renderConnectionCard(meta, connection, { multiStore: false }) : `<p class="hint-text">Configuração ainda não disponível.</p>`}
      </div>`;
  }

  const reached = group.count >= group.limit;
  return `
    <div class="card" data-provider-group="${meta.key}">
      <div class="product-card-top">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="integration-provider-icon">${meta.icon}</span>
          <p class="product-card-name">${escapeHtml(meta.name)}</p>
        </div>
        <span class="status-badge info">${group.count} de ${group.limit} lojas</span>
      </div>
      <p class="hint-text" style="margin:4px 0 10px">${escapeHtml(meta.description)}</p>
      <div class="product-card-list">
        ${group.connections.map((c) => renderConnectionCard(meta, c, { multiStore: true })).join("")}
      </div>
      ${group.connections.length === 0 ? `<p class="hint-text" style="margin-top:8px">Nenhuma loja cadastrada ainda para ${escapeHtml(meta.name)}.</p>` : ""}
      ${
        reached
          ? `<p class="hint-text" style="margin-top:10px">${Icon.alertTriangle}Limite de 4 lojas atingido para este marketplace.</p>`
          : `<button type="button" class="btn-secondary" style="margin-top:10px" data-add-connection="${meta.key}">${Icon.plus}Adicionar loja</button>`
      }
    </div>`;
}

function renderConnectionCard(meta: ProviderInfo, c: IntegrationConnection, opts: { multiStore: boolean }): string {
  const s = !c.is_active ? { text: "Desativada", badge: "offline", icon: Icon.pause } : INTEGRATION_STATUS_META[c.status];
  const cred = c.credential;
  const metaLine: string[] = [];
  if (c.brand) metaLine.push(`Marca: ${escapeHtml(c.brand)}`);
  if (c.branch) metaLine.push(`Unidade: ${escapeHtml(c.branch)}`);
  if (c.fulfillment_mode) metaLine.push(`Modalidade: ${escapeHtml(c.fulfillment_mode)}`);
  if (cred?.external_account_id) metaLine.push(`Conta/Loja: ${escapeHtml(cred.external_account_id)}`);
  if (c.last_sync_at) metaLine.push(`Última sinc.: ${formatDateTime(c.last_sync_at)}`);
  if (cred?.client_id) metaLine.push(`Client ID: ${escapeHtml(cred.client_id)}`);
  if (cred?.client_secret_masked) metaLine.push(`Client Secret: ${cred.client_secret_masked}`);
  if (cred?.access_token_masked) metaLine.push(`Token de acesso: ${cred.access_token_masked}`);
  if (cred?.refresh_token_masked) metaLine.push(`Token de atualização: ${cred.refresh_token_masked}`);
  if (cred?.scopes) metaLine.push(`Escopos: ${escapeHtml(cred.scopes)}`);
  if (c.last_error) metaLine.push(`Último erro: ${escapeHtml(c.last_error)}`);

  const credentialsLabel = cred ? (c.status === "auth_error" ? "Reconectar" : "Editar credenciais") : "Configurar";

  return `
    <div class="product-card" data-connection-row="${c.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(c.display_name || meta.name)}</p>
        <span class="status-badge ${s.badge}">${s.icon}${s.text}</span>
      </div>
      ${metaLine.length > 0 ? `<div class="product-card-meta">${metaLine.map((l) => `<span>${l}</span>`).join("")}</div>` : ""}
      <div class="review-actions" style="margin-top:8px">
        <button type="button" class="btn-secondary" data-conn-credentials="${c.id}">${Icon.key}${credentialsLabel}</button>
        ${opts.multiStore ? `<button type="button" class="btn-secondary" data-conn-rename="${c.id}">${Icon.pencil}Renomear</button>` : ""}
        ${
          cred
            ? meta.key === "tiny"
              ? `<button type="button" class="btn-secondary" data-conn-test="${c.id}">${Icon.refresh}Testar conexão</button>`
              : `<button type="button" class="btn-secondary" data-conn-test-stub="${c.id}">${Icon.refresh}Testar conexão</button>`
            : ""
        }
        ${
          opts.multiStore
            ? `<button type="button" class="btn-secondary" data-conn-toggle-active="${c.id}" data-conn-active="${c.is_active}">${c.is_active ? `${Icon.userX}Desativar` : `${Icon.checkCircle}Ativar`}</button>`
            : ""
        }
        ${
          opts.multiStore
            ? `<button type="button" class="btn-danger" data-conn-remove="${c.id}">${Icon.trash}Remover loja</button>`
            : cred
              ? `<button type="button" class="btn-danger" data-conn-clear-credentials="${c.id}">${Icon.trash}Remover</button>`
              : ""
        }
      </div>
    </div>`;
}

/** Criar loja (provider + null) ou editar nome/marca/unidade/modalidade de uma já existente (provider + existing) — mesmo modelo genérico de conexão, mesmo formulário. */
function openConnectionMetaModal(content: HTMLElement, meta: ProviderInfo, existing: IntegrationConnection | null): void {
  const isCreate = !existing;
  const { overlay, close } = openModal(
    `
    <h3 id="connMetaTitle">${isCreate ? `${Icon.plus}Adicionar loja — ${escapeHtml(meta.name)}` : `${Icon.pencil}Editar loja`}</h3>
    ${!isCreate ? `<p class="hint-text">Deixe um campo em branco pra manter o valor atual.</p>` : ""}
    <form id="connMetaForm" novalidate>
      <label for="cmName">Nome/apelido da loja</label>
      <input type="text" id="cmName" autocomplete="off" value="${escapeHtml(existing?.display_name || "")}" placeholder="Ex.: Az — ML Fulfillment" />

      <label for="cmBrand">Empresa/marca</label>
      <input type="text" id="cmBrand" autocomplete="off" value="${escapeHtml(existing?.brand || "")}" placeholder="Ex.: az, gocase" />

      <label for="cmBranch">Unidade/filial</label>
      <input type="text" id="cmBranch" autocomplete="off" value="${escapeHtml(existing?.branch || "")}" placeholder="Ex.: principal, filial 02" />

      <label for="cmFulfillment">Modalidade logística</label>
      <input type="text" id="cmFulfillment" autocomplete="off" value="${escapeHtml(existing?.fulfillment_mode || "")}" placeholder="Ex.: fba_classic, fulfillment" />

      <p class="error-box" id="cmError" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cmCancel">Cancelar</button>
        <button type="submit" class="btn-primary" id="cmSubmit">${isCreate ? "Adicionar loja" : "Salvar"}</button>
      </div>
    </form>`,
    "connMetaTitle"
  );
  overlay.querySelector("#cmCancel")!.addEventListener("click", close);
  overlay.querySelector("#connMetaForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = overlay.querySelector<HTMLElement>("#cmError")!;
    const submitBtn = overlay.querySelector<HTMLButtonElement>("#cmSubmit")!;
    errorEl.hidden = true;

    const display_name = overlay.querySelector<HTMLInputElement>("#cmName")!.value.trim();
    const brand = overlay.querySelector<HTMLInputElement>("#cmBrand")!.value.trim();
    const branch = overlay.querySelector<HTMLInputElement>("#cmBranch")!.value.trim();
    const fulfillment_mode = overlay.querySelector<HTMLInputElement>("#cmFulfillment")!.value.trim();
    if (isCreate && !display_name) {
      errorEl.textContent = "Informe um nome para a loja.";
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = isCreate ? "Adicionando…" : "Salvando…";
    try {
      if (isCreate) {
        await createIntegrationConnection({
          provider: meta.key,
          display_name,
          brand: brand || undefined,
          branch: branch || undefined,
          fulfillment_mode: fulfillment_mode || undefined,
        });
        showToast("Loja adicionada.", "success");
      } else {
        await updateIntegrationConnection({
          connectionId: existing!.id,
          display_name: display_name || undefined,
          brand: brand || undefined,
          branch: branch || undefined,
          fulfillment_mode: fulfillment_mode || undefined,
        });
        showToast("Loja atualizada.", "success");
      }
      close();
      await loadIntegrationsList(content);
    } catch (err) {
      errorEl.textContent = describeError(err);
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isCreate ? "Adicionar loja" : "Salvar";
    }
  });
}

function openIntegrationCredentialsModal(content: HTMLElement, meta: ProviderInfo, existing: IntegrationConnection): void {
  const cred = existing.credential;
  const { overlay, close } = openModal(
    `
    <h3 id="intCredTitle">${Icon.key}${escapeHtml(existing.display_name || meta.name)}</h3>
    <p class="hint-text">Os campos abaixo já preenchidos com "•" ficam salvos — deixe em branco pra manter o valor atual, ou digite um novo valor pra substituí-lo.</p>
    <form id="intCredForm">
      <label for="icClientId">Client ID</label>
      <input type="text" id="icClientId" autocomplete="off" value="${escapeHtml(cred?.client_id || "")}" />

      <label for="icClientSecret">Client Secret ${cred?.client_secret_masked ? `<span class="hint-text">(atual: ${cred.client_secret_masked})</span>` : ""}</label>
      <input type="password" id="icClientSecret" autocomplete="off" placeholder="${cred?.client_secret_masked ? "Deixe em branco pra manter" : ""}" />

      <label for="icAccessToken">Token de acesso ${cred?.access_token_masked ? `<span class="hint-text">(atual: ${cred.access_token_masked})</span>` : ""}</label>
      <input type="password" id="icAccessToken" autocomplete="off" placeholder="${cred?.access_token_masked ? "Deixe em branco pra manter" : ""}" />

      <label for="icRefreshToken">Token de atualização ${cred?.refresh_token_masked ? `<span class="hint-text">(atual: ${cred.refresh_token_masked})</span>` : ""}</label>
      <input type="password" id="icRefreshToken" autocomplete="off" placeholder="${cred?.refresh_token_masked ? "Deixe em branco pra manter" : ""}" />

      <label for="icAccountId">Conta/Loja (ID externo)</label>
      <input type="text" id="icAccountId" autocomplete="off" value="${escapeHtml(cred?.external_account_id || "")}" />

      <label for="icScopes">Escopos</label>
      <input type="text" id="icScopes" autocomplete="off" value="${escapeHtml(cred?.scopes || "")}" placeholder="Ex.: read write" />

      <p class="hint-text" style="margin-top:10px">A verificação automática de conexão com o provedor ainda não foi implementada nesta etapa — o status muda para "Conectada" só quando essa validação real existir. Até lá, salvar aqui deixa o status como "Configuração incompleta".</p>
      <p class="error-box" id="icError" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="icCancel">Cancelar</button>
        <button type="submit" class="btn-primary" id="icSubmit">Salvar credenciais</button>
      </div>
    </form>`,
    "intCredTitle"
  );
  overlay.querySelector("#icCancel")!.addEventListener("click", close);
  overlay.querySelector("#intCredForm")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = overlay.querySelector<HTMLElement>("#icError")!;
    const submitBtn = overlay.querySelector<HTMLButtonElement>("#icSubmit")!;
    errorEl.hidden = true;

    const fields = {
      client_id: overlay.querySelector<HTMLInputElement>("#icClientId")!.value.trim(),
      client_secret: overlay.querySelector<HTMLInputElement>("#icClientSecret")!.value.trim(),
      access_token: overlay.querySelector<HTMLInputElement>("#icAccessToken")!.value.trim(),
      refresh_token: overlay.querySelector<HTMLInputElement>("#icRefreshToken")!.value.trim(),
      external_account_id: overlay.querySelector<HTMLInputElement>("#icAccountId")!.value.trim(),
      scopes: overlay.querySelector<HTMLInputElement>("#icScopes")!.value.trim(),
    };
    if (!Object.values(fields).some((v) => v)) {
      errorEl.textContent = "Preencha pelo menos um campo.";
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Salvando…";
    try {
      await saveIntegrationConnectionCredentials({ connectionId: existing.id, ...fields });
      showToast("Credenciais salvas com segurança.", "success");
      close();
      await loadIntegrationsList(content);
    } catch (err) {
      errorEl.textContent = describeError(err);
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Salvar credenciais";
    }
  });
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------
async function renderAuditTab(content: HTMLElement): Promise<void> {
  content.innerHTML = `
    <div class="card">
      <h3>${Icon.history}Auditoria</h3>
      <div class="chip-row">
        <input type="text" id="auditActionFilter" placeholder="Filtrar por ação (ex.: user_created)…" value="${escapeHtml(auditActionFilter)}" />
        <label class="hint-text">De <input type="date" id="auditDateFrom" value="${escapeHtml(auditDateFrom)}" /></label>
        <label class="hint-text">Até <input type="date" id="auditDateTo" value="${escapeHtml(auditDateTo)}" /></label>
      </div>
      <div id="auditResultsWrap"><div class="skeleton skeleton-card"></div></div>
      <div class="pagination" id="auditPagination"></div>
    </div>`;

  const applyFilters = debounce(() => {
    auditPage = 0;
    void loadAuditPage(content);
  }, 350);
  content.querySelector("#auditActionFilter")!.addEventListener("input", (e) => {
    auditActionFilter = (e.target as HTMLInputElement).value;
    applyFilters();
  });
  content.querySelector("#auditDateFrom")!.addEventListener("change", (e) => {
    auditDateFrom = (e.target as HTMLInputElement).value;
    auditPage = 0;
    void loadAuditPage(content);
  });
  content.querySelector("#auditDateTo")!.addEventListener("change", (e) => {
    auditDateTo = (e.target as HTMLInputElement).value;
    auditPage = 0;
    void loadAuditPage(content);
  });

  await loadAuditPage(content);
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
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
};

async function loadAuditPage(content: HTMLElement): Promise<void> {
  const wrap = content.querySelector<HTMLElement>("#auditResultsWrap")!;
  let result;
  try {
    result = await listAuditLogs({
      actionFilter: auditActionFilter || undefined,
      dateFrom: auditDateFrom || undefined,
      dateTo: auditDateTo ? `${auditDateTo}T23:59:59` : undefined,
      page: auditPage,
      pageSize: AUDIT_PAGE_SIZE,
    });
  } catch (err) {
    renderErrorWithRetry(wrap, "Erro ao buscar auditoria: " + describeError(err), () => void loadAuditPage(content));
    return;
  }

  if (result.logs.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum registro de auditoria encontrado.</p></div>`;
  } else {
    wrap.innerHTML = `<ul class="recent-list">${result.logs.map(renderAuditRow).join("")}</ul>`;
    wrap.querySelectorAll<HTMLElement>("[data-audit-details]").forEach((el) => {
      el.addEventListener("click", () => {
        const details = el.nextElementSibling as HTMLElement | null;
        if (details) details.hidden = !details.hidden;
      });
    });
  }

  const totalPages = Math.max(1, Math.ceil(result.total / AUDIT_PAGE_SIZE));
  const pag = content.querySelector<HTMLElement>("#auditPagination")!;
  pag.innerHTML = `
    <button class="icon-btn" id="auditPrevPage" ${auditPage === 0 ? "disabled" : ""} aria-label="Página anterior">${Icon.chevronLeft}</button>
    <span class="hint-text">Página ${auditPage + 1} de ${totalPages} (${result.total} registro${result.total === 1 ? "" : "s"})</span>
    <button class="icon-btn" id="auditNextPage" ${auditPage + 1 >= totalPages ? "disabled" : ""} aria-label="Próxima página">${Icon.chevronRight}</button>`;
  pag.querySelector("#auditPrevPage")!.addEventListener("click", () => {
    if (auditPage > 0) {
      auditPage--;
      void loadAuditPage(content);
    }
  });
  pag.querySelector("#auditNextPage")!.addEventListener("click", () => {
    auditPage++;
    void loadAuditPage(content);
  });
}

function renderAuditRow(row: AuditLogRow): string {
  const label = AUDIT_ACTION_LABELS[row.action] || row.action;
  const isDenied = row.action === "admin_action_denied";
  return `
    <li data-audit-details="${row.id}" style="cursor:pointer;flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;justify-content:space-between;width:100%">
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span class="hint-text" style="margin:0">${escapeHtml(row.admin_name || row.admin_email || "-")}${row.target_name ? " → " + escapeHtml(row.target_name) : ""}</span>
        </div>
        <span class="status-badge ${isDenied ? "error" : "info"}" style="margin:0">${formatDateTime(row.created_at)}</span>
      </div>
      <div hidden style="width:100%;background:var(--bg-subtle);border-radius:8px;padding:8px;font-family:monospace;font-size:12px;overflow-x:auto">
        ${escapeHtml(JSON.stringify(row.metadata ?? {}, null, 2))}
      </div>
    </li>`;
}
