// EXPANSÃO GOSCAN — Painel de Administração real.
//
// Toda operação administrativa (listar/criar/editar usuários, ativar/
// desativar, redefinir senha, gerenciar grupos e permissões, consultar
// auditoria) passa por AQUI — nunca direto do frontend pra profiles/
// auth.users. O SUPABASE_SERVICE_ROLE_KEY só existe neste arquivo (nunca no
// bundle do navegador), e só é usado DEPOIS de validar o JWT do chamador, o
// perfil dele, e a hierarquia entre ele e o usuário-alvo — nunca confia em
// role/permissão enviada pelo corpo da requisição.
//
// Contrato com o frontend (ver src/client/adminApi.ts — mantido em
// sincronia manual, runtimes diferentes/não podem compartilhar um módulo).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import {
  isValidRole,
  canManageRole,
  canCreateRole,
  isValidEmail,
  isValidBrPhone,
  passwordMeetsMinimum,
  sanitizePagination,
  isValidAction,
  sanitizeGroupName,
  sanitizeSearchTerm,
  wouldLeaveZeroSuperAdmins,
  isValidIntegrationProvider,
  sanitizeCredentialFields,
  hasAnyCredentialField,
  maskSecret,
  sanitizeConnectionMetaFields,
  hasReachedConnectionLimit,
  MAX_CONNECTIONS_PER_PROVIDER,
  INTEGRATION_PROVIDERS,
  type Role,
} from "./logic.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

interface CallerProfile {
  id: string;
  role: Role;
  active: boolean;
  full_name: string | null;
  company_id: string;
}

interface TargetProfile {
  id: string;
  role: Role;
  active: boolean;
  full_name: string | null;
  email: string | null;
}

/** Nunca expõe o corpo técnico do erro do Supabase Auth — só os casos realmente úteis pro operador. */
function describeAuthError(err: { message?: string }): string {
  const msg = err.message || "";
  if (/already.*registered|already exists|duplicate/i.test(msg)) return "Já existe uma conta com este e-mail.";
  if (/password/i.test(msg)) return "Senha inválida.";
  if (/email/i.test(msg)) return "E-mail inválido.";
  return "Não foi possível concluir a operação. Verifique os dados e tente novamente.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsPreflight();
  if (req.method !== "POST") {
    return jsonResponse({ success: false, code: "METHOD_NOT_ALLOWED", message: "Método não permitido." }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[admin-users] variáveis do Supabase ausentes no ambiente da função.");
    return jsonResponse({ success: false, code: "CONFIG_ERROR", message: "Painel administrativo não configurado. Procure um administrador." }, 500);
  }

  // 1) Autenticação — validada ANTES de qualquer outra coisa, com a chave
  // anônima + o JWT do chamador (respeita RLS; profiles_select já libera a
  // própria linha). Nunca eleva privilégio nesta etapa.
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ success: false, code: "UNAUTHENTICATED", message: "Sessão inválida. Faça login novamente." }, 401);
  }

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Cliente anônimo "limpo" (sem o JWT de ninguém) — usado só pra disparar o
  // e-mail nativo de recuperação de senha, que não deve carregar a sessão
  // do admin que está pedindo o envio.
  const plainAnonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ success: false, code: "UNAUTHENTICATED", message: "Sessão inválida ou expirada. Faça login novamente." }, 401);
  }

  const { data: callerRow, error: callerError } = await callerClient
    .from("profiles")
    .select("id, role, active, full_name, company_id")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (callerError || !callerRow) {
    return jsonResponse({ success: false, code: "FORBIDDEN", message: "Perfil não encontrado." }, 403);
  }
  if (!callerRow.active) {
    return jsonResponse({ success: false, code: "FORBIDDEN", message: "Usuário inativo." }, 403);
  }
  const caller = callerRow as CallerProfile;

  // 2) Portão real do painel — operador/visualizador nunca passam daqui,
  // mesmo acessando a URL direto ou com qualquer override concedido por
  // engano. Permissões granulares só refinam o que admin/super_admin pode
  // fazer DENTRO do painel — nunca abrem a porta pra quem não é nenhum dos
  // dois papéis.
  if (caller.role !== "super_admin" && caller.role !== "admin") {
    return jsonResponse({ success: false, code: "FORBIDDEN", message: "Acesso restrito aos administradores do GoScan." }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, code: "INVALID_BODY", message: "Corpo da requisição inválido." }, 400);
  }

  const action = body.action;
  if (!isValidAction(action)) {
    return jsonResponse({ success: false, code: "INVALID_ACTION", message: "Ação inválida." }, 400);
  }

  // 3) Daqui em diante, service_role — só depois do usuário validado e
  // autorizado acima, e só pras operações que realmente precisam.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /** Permissão granular EFETIVA do chamador — mesma função (has_permission) usada pelas policies de RLS, nunca uma segunda implementação divergente. */
  async function hasPermission(key: string): Promise<boolean> {
    if (caller.role === "super_admin") return true;
    const { data, error } = await callerClient.rpc("has_permission", { perm_key: key });
    if (error) {
      console.error("[admin-users] falha ao checar has_permission:", error.message);
      return false;
    }
    return data === true;
  }

  async function writeAudit(auditAction: string, targetId: string | null, metadata: Record<string, unknown>, entityType = "profile"): Promise<void> {
    const { error } = await admin.from("audit_logs").insert({
      user_id: caller.id,
      action: auditAction,
      entity_type: entityType,
      entity_id: targetId,
      metadata,
    });
    if (error) console.error("[admin-users] falha ao gravar audit_logs:", error.message);
  }

  async function denyAndAudit(reason: string, targetUserId: string | null, message: string, status = 403): Promise<Response> {
    await writeAudit("admin_action_denied", targetUserId, { attempted_action: action, reason });
    return jsonResponse({ success: false, code: "FORBIDDEN", message }, status);
  }

  async function loadTarget(userId: unknown): Promise<TargetProfile | null> {
    if (typeof userId !== "string" || !userId) return null;
    const { data, error } = await admin.from("profiles").select("id, role, active, full_name, email").eq("id", userId).maybeSingle();
    if (error || !data) return null;
    return data as TargetProfile;
  }

  interface IntegrationConnectionRow {
    id: string;
    provider: string;
    company_id: string;
    display_name: string | null;
  }

  /** Carrega uma loja/conexão e confirma que pertence à empresa do chamador — nunca revela nem que uma conexão de outra empresa existe (mesmo NOT_FOUND pros dois casos, ver pedido seção 6). */
  async function loadConnection(connectionId: unknown): Promise<IntegrationConnectionRow | null> {
    if (typeof connectionId !== "string" || !connectionId) return null;
    const { data, error } = await admin.from("integration_providers").select("id, provider, company_id, display_name").eq("id", connectionId).maybeSingle();
    if (error || !data) return null;
    if (data.company_id !== caller.company_id) return null;
    return data as IntegrationConnectionRow;
  }

  /**
   * Contagem SEMPRE consultada ao vivo contra o banco (nunca cache) — a
   * decisão em si (dada a contagem) é a função pura wouldLeaveZeroSuperAdmins
   * (logic.ts, testada exaustivamente). O trigger protect_last_super_admin
   * no banco garante a mesma regra de forma incondicional, como defesa em
   * profundidade independente desta checagem.
   */
  async function wouldViolateLastSuperAdmin(target: TargetProfile, patch: { role?: Role; active?: boolean }): Promise<boolean> {
    if (target.role !== "super_admin" || !target.active) return false;
    const { count } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "super_admin")
      .eq("active", true)
      .neq("id", target.id);
    return wouldLeaveZeroSuperAdmins(target, patch, count ?? 0);
  }

  async function applyPermissionOverrides(userId: string, overrides: Record<string, unknown>): Promise<void> {
    const rows = Object.entries(overrides)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
      .map(([key, granted]) => ({ user_id: userId, permission_key: key, granted, granted_by: caller.id }));
    if (rows.length === 0) return;
    const { error } = await admin.from("user_permission_overrides").upsert(rows, { onConflict: "user_id,permission_key" });
    if (error) console.error("[admin-users] falha ao aplicar permission overrides:", error.message);
  }

  try {
    switch (action) {
      // -----------------------------------------------------------------
      case "overview": {
        const [total, active, superAdmins, admins, operators, viewers, groups, recent] = await Promise.all([
          admin.from("profiles").select("id", { count: "exact", head: true }),
          admin.from("profiles").select("id", { count: "exact", head: true }).eq("active", true),
          admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "super_admin"),
          admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin"),
          admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "operator"),
          admin.from("profiles").select("id", { count: "exact", head: true }).eq("role", "viewer"),
          admin.from("work_groups").select("id", { count: "exact", head: true }).eq("active", true),
          admin.from("profiles").select("id, full_name, role, last_login_at").not("last_login_at", "is", null).order("last_login_at", { ascending: false }).limit(5),
        ]);
        const totalCount = total.count ?? 0;
        const activeCount = active.count ?? 0;
        return jsonResponse({
          success: true,
          overview: {
            total_users: totalCount,
            active_users: activeCount,
            inactive_users: totalCount - activeCount,
            super_admins: superAdmins.count ?? 0,
            admins: admins.count ?? 0,
            operators: operators.count ?? 0,
            viewers: viewers.count ?? 0,
            work_groups: groups.count ?? 0,
            recent_logins: recent.data ?? [],
          },
        });
      }

      // -----------------------------------------------------------------
      case "list_users": {
        const { page, pageSize } = sanitizePagination(body);
        const from = page * pageSize;
        const to = from + pageSize - 1;
        let q = admin
          .from("profiles")
          .select("id, full_name, email, phone, job_title, role, active, work_group_id, work_groups(name), last_login_at, created_at, must_change_password", {
            count: "exact",
          });

        const search = typeof body.search === "string" ? sanitizeSearchTerm(body.search) : "";
        if (search) q = q.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
        if (isValidRole(body.role)) q = q.eq("role", body.role);
        if (body.status === "active") q = q.eq("active", true);
        else if (body.status === "inactive") q = q.eq("active", false);
        if (typeof body.workGroupId === "string" && body.workGroupId) q = q.eq("work_group_id", body.workGroupId);

        const sortableFields = ["full_name", "email", "role", "active", "last_login_at", "created_at"];
        const sortField = typeof body.sortField === "string" && sortableFields.includes(body.sortField) ? body.sortField : "full_name";
        const sortDir = body.sortDir !== "desc";
        q = q.order(sortField, { ascending: sortDir }).range(from, to);

        const { data, error, count } = await q;
        if (error) throw error;
        return jsonResponse({ success: true, users: data ?? [], total: count ?? 0, page, pageSize });
      }

      // -----------------------------------------------------------------
      case "create_user": {
        if (!(await hasPermission("users.manage"))) {
          return await denyAndAudit("missing_users_manage", null, "Você não tem permissão para gerenciar usuários.");
        }

        const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const phone = typeof body.phone === "string" ? body.phone.trim() : "";
        const jobTitle = typeof body.jobTitle === "string" ? body.jobTitle.trim() : "";
        const workGroupId = typeof body.workGroupId === "string" && body.workGroupId ? body.workGroupId : null;
        const role = body.role;
        const active = body.active !== false;
        const mustChangePassword = body.mustChangePassword === true;
        const sendInvite = body.sendInvite === true;
        const tempPassword = typeof body.tempPassword === "string" ? body.tempPassword : "";
        const permissionOverrides =
          body.permissionOverrides && typeof body.permissionOverrides === "object" ? (body.permissionOverrides as Record<string, unknown>) : null;

        if (!fullName) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Nome completo é obrigatório." }, 400);
        if (!isValidEmail(email)) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "E-mail inválido." }, 400);
        if (phone && !isValidBrPhone(phone)) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Telefone inválido." }, 400);
        if (!isValidRole(role)) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Papel inválido." }, 400);
        if (!sendInvite && !passwordMeetsMinimum(tempPassword)) {
          return jsonResponse(
            { success: false, code: "VALIDATION_ERROR", message: "Senha temporária deve ter 8+ caracteres, com maiúscula, minúscula e número." },
            400
          );
        }

        const canCreateAdminPerm = await hasPermission("users.create_admin");
        if (!canCreateRole(caller.role, role, canCreateAdminPerm)) {
          return await denyAndAudit("hierarchy_create", null, "Você não pode criar um usuário com este papel.");
        }

        if (workGroupId) {
          const { data: groupRow } = await admin.from("work_groups").select("id").eq("id", workGroupId).eq("active", true).maybeSingle();
          if (!groupRow) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Grupo de trabalho inválido." }, 400);
        }

        let newUserId: string;
        if (sendInvite) {
          const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName } });
          if (inviteError || !invited?.user) return jsonResponse({ success: false, code: "CREATE_FAILED", message: describeAuthError(inviteError ?? {}) }, 400);
          newUserId = invited.user.id;
        } else {
          const { data: created, error: createError } = await admin.auth.admin.createUser({
            email,
            password: tempPassword,
            email_confirm: true,
            user_metadata: { full_name: fullName },
          });
          if (createError || !created?.user) return jsonResponse({ success: false, code: "CREATE_FAILED", message: describeAuthError(createError ?? {}) }, 400);
          newUserId = created.user.id;
        }

        // handle_new_user (trigger, mesma transação do insert em auth.users)
        // já garantiu que existe uma linha em profiles (operator/ativo) —
        // nunca existe uma janela com usuário Auth "órfão" sem perfil.
        // Agora ajustamos pros valores reais escolhidos no formulário.
        //
        // company_id: SEMPRE a empresa de quem está criando (caller.company_id,
        // carregado do banco, nunca do corpo da requisição) — um admin só cria
        // usuários dentro da própria empresa, nunca em outra (CORREÇÃO
        // ESTRUTURAL — ver 0037_companies.sql).
        const { error: updateError } = await admin
          .from("profiles")
          .update({
            full_name: fullName,
            job_title: jobTitle || null,
            phone: phone || null,
            work_group_id: workGroupId,
            role,
            active,
            must_change_password: sendInvite ? false : mustChangePassword,
            company_id: caller.company_id,
          })
          .eq("id", newUserId);

        if (updateError) {
          // Nunca fica "quebrado" (usuário Auth + perfil padrão já existem,
          // operator/ativo) — só não recebeu a configuração completa.
          // Reporta isso explicitamente em vez de fingir sucesso total.
          await writeAudit("user_create_partial_failure", newUserId, { error: updateError.message });
          return jsonResponse(
            {
              success: true,
              partial: true,
              userId: newUserId,
              message: "Usuário criado, mas não foi possível aplicar todas as configurações (papel/grupo/senha). Edite o usuário pra corrigir.",
            },
            207
          );
        }

        if (permissionOverrides) await applyPermissionOverrides(newUserId, permissionOverrides);

        await writeAudit("user_created", newUserId, { role, work_group_id: workGroupId, invite: sendInvite, must_change_password: mustChangePassword });
        return jsonResponse({ success: true, userId: newUserId });
      }

      // -----------------------------------------------------------------
      case "update_user": {
        const target = await loadTarget(body.userId);
        if (!target) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Usuário não encontrado." }, 404);
        if (!(await hasPermission("users.manage"))) return await denyAndAudit("missing_users_manage", target.id, "Você não tem permissão para gerenciar usuários.");
        if (!canManageRole(caller.role, target.role)) return await denyAndAudit("hierarchy_manage", target.id, "Você não pode editar este usuário.");

        const patch: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};

        if (typeof body.fullName === "string" && body.fullName.trim()) {
          patch.full_name = body.fullName.trim();
          before.full_name = target.full_name;
          after.full_name = patch.full_name;
        }
        if (typeof body.jobTitle === "string") patch.job_title = body.jobTitle.trim() || null;
        if (typeof body.phone === "string") {
          const phone = body.phone.trim();
          if (phone && !isValidBrPhone(phone)) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Telefone inválido." }, 400);
          patch.phone = phone || null;
        }
        if ("workGroupId" in body) {
          const wg = typeof body.workGroupId === "string" && body.workGroupId ? body.workGroupId : null;
          if (wg) {
            const { data: groupRow } = await admin.from("work_groups").select("id").eq("id", wg).eq("active", true).maybeSingle();
            if (!groupRow) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Grupo de trabalho inválido." }, 400);
          }
          patch.work_group_id = wg;
        }

        let roleChanged = false;
        if (typeof body.role === "string" && body.role !== target.role) {
          if (!isValidRole(body.role)) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Papel inválido." }, 400);
          const canCreateAdminPerm = await hasPermission("users.create_admin");
          if (!canCreateRole(caller.role, body.role, canCreateAdminPerm) || !canManageRole(caller.role, body.role)) {
            return await denyAndAudit("hierarchy_role_change", target.id, "Você não pode atribuir este papel.");
          }
          if (await wouldViolateLastSuperAdmin(target, { role: body.role })) {
            return jsonResponse({ success: false, code: "LAST_SUPER_ADMIN", message: "Não é possível rebaixar o último super administrador ativo." }, 400);
          }
          patch.role = body.role;
          before.role = target.role;
          after.role = body.role;
          roleChanged = true;
        }

        let emailChanged = false;
        if (typeof body.email === "string" && body.email.trim().toLowerCase() !== (target.email ?? "").toLowerCase()) {
          const newEmail = body.email.trim().toLowerCase();
          if (!isValidEmail(newEmail)) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "E-mail inválido." }, 400);
          const { error: emailError } = await admin.auth.admin.updateUserById(target.id, { email: newEmail, email_confirm: true });
          if (emailError) return jsonResponse({ success: false, code: "UPDATE_FAILED", message: describeAuthError(emailError) }, 400);
          emailChanged = true; // profiles.email sincroniza sozinho via trigger sync_profile_email
        }

        if (Object.keys(patch).length > 0) {
          const { error: updateError } = await admin.from("profiles").update(patch).eq("id", target.id);
          if (updateError) throw updateError;
        }

        await writeAudit("user_updated", target.id, { fields_changed: Object.keys(patch), role_changed: roleChanged, email_changed: emailChanged, before, after });
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "activate_user":
      case "deactivate_user": {
        const target = await loadTarget(body.userId);
        if (!target) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Usuário não encontrado." }, 404);
        if (!(await hasPermission("users.manage"))) return await denyAndAudit("missing_users_manage", target.id, "Você não tem permissão para gerenciar usuários.");
        if (!canManageRole(caller.role, target.role)) return await denyAndAudit("hierarchy_manage", target.id, "Você não pode alterar este usuário.");

        const nextActive = action === "activate_user";
        if (!nextActive && (await wouldViolateLastSuperAdmin(target, { active: false }))) {
          return jsonResponse({ success: false, code: "LAST_SUPER_ADMIN", message: "Não é possível desativar o último super administrador ativo." }, 400);
        }
        const { error } = await admin.from("profiles").update({ active: nextActive }).eq("id", target.id);
        if (error) throw error;
        await writeAudit(nextActive ? "user_activated" : "user_deactivated", target.id, {});
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "send_password_reset": {
        const target = await loadTarget(body.userId);
        if (!target || !target.email) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Usuário não encontrado." }, 404);
        if (!(await hasPermission("users.manage"))) return await denyAndAudit("missing_users_manage", target.id, "Você não tem permissão para gerenciar usuários.");
        if (!canManageRole(caller.role, target.role)) return await denyAndAudit("hierarchy_manage", target.id, "Você não pode gerenciar este usuário.");

        const { error } = await plainAnonClient.auth.resetPasswordForEmail(target.email);
        if (error) {
          // Serviço de e-mail nativo do Supabase tem um limite de envios por
          // hora (configuração do projeto, fora do controle desta função) —
          // distingue esse caso real do resto pra não confundir "sem SMTP
          // configurado" com "muitos envios recentes".
          const isRateLimited = /rate limit/i.test(error.message);
          return jsonResponse(
            {
              success: false,
              code: isRateLimited ? "EMAIL_RATE_LIMITED" : "RESET_FAILED",
              message: isRateLimited
                ? "Muitos e-mails enviados recentemente. Aguarde alguns minutos e tente novamente."
                : "Não foi possível enviar o link de recuperação.",
            },
            isRateLimited ? 429 : 502
          );
        }
        await writeAudit("password_reset_sent", target.id, {});
        return jsonResponse({ success: true, message: `Link de recuperação enviado para ${target.email}.` });
      }

      // -----------------------------------------------------------------
      case "set_temp_password": {
        const target = await loadTarget(body.userId);
        if (!target) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Usuário não encontrado." }, 404);
        if (!(await hasPermission("users.manage"))) return await denyAndAudit("missing_users_manage", target.id, "Você não tem permissão para gerenciar usuários.");
        if (!canManageRole(caller.role, target.role)) return await denyAndAudit("hierarchy_manage", target.id, "Você não pode gerenciar este usuário.");

        const tempPassword = typeof body.tempPassword === "string" ? body.tempPassword : "";
        if (!passwordMeetsMinimum(tempPassword)) {
          return jsonResponse(
            { success: false, code: "VALIDATION_ERROR", message: "Senha temporária deve ter 8+ caracteres, com maiúscula, minúscula e número." },
            400
          );
        }
        const { error: pwError } = await admin.auth.admin.updateUserById(target.id, { password: tempPassword });
        if (pwError) return jsonResponse({ success: false, code: "UPDATE_FAILED", message: "Não foi possível definir a senha temporária." }, 502);

        const { error: profileError } = await admin.from("profiles").update({ must_change_password: true }).eq("id", target.id);
        if (profileError) throw profileError;

        await writeAudit("temp_password_set", target.id, {}); // nunca grava a senha em si, só o fato de ter sido definida
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "list_groups": {
        const { data, error } = await admin.from("work_groups").select("id, name, description, active, created_at").order("name", { ascending: true });
        if (error) throw error;

        const { data: counts } = await admin.from("profiles").select("work_group_id").not("work_group_id", "is", null);
        const countByGroup = new Map<string, number>();
        for (const row of (counts ?? []) as { work_group_id: string }[]) {
          countByGroup.set(row.work_group_id, (countByGroup.get(row.work_group_id) ?? 0) + 1);
        }
        const groups = (data ?? []).map((g) => ({ ...g, user_count: countByGroup.get(g.id) ?? 0 }));
        return jsonResponse({ success: true, groups });
      }

      // -----------------------------------------------------------------
      case "create_group": {
        if (!(await hasPermission("groups.manage"))) return await denyAndAudit("missing_groups_manage", null, "Você não tem permissão para gerenciar grupos.");
        const name = sanitizeGroupName(body.name);
        if (!name) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Nome do grupo é obrigatório." }, 400);
        const description = typeof body.description === "string" ? body.description.trim() || null : null;

        const { data, error } = await admin.from("work_groups").insert({ name, description }).select().single();
        if (error) {
          if (error.code === "23505") return jsonResponse({ success: false, code: "DUPLICATE", message: "Já existe um grupo ativo com este nome." }, 409);
          throw error;
        }
        await writeAudit("group_created", null, { group_id: data.id, name });
        return jsonResponse({ success: true, group: data });
      }

      // -----------------------------------------------------------------
      case "update_group": {
        if (!(await hasPermission("groups.manage"))) return await denyAndAudit("missing_groups_manage", null, "Você não tem permissão para gerenciar grupos.");
        const groupId = typeof body.groupId === "string" ? body.groupId : "";
        if (!groupId) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Grupo inválido." }, 400);

        const patch: Record<string, unknown> = {};
        if (typeof body.name === "string") {
          const name = sanitizeGroupName(body.name);
          if (!name) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Nome do grupo é obrigatório." }, 400);
          patch.name = name;
        }
        if ("description" in body) patch.description = typeof body.description === "string" ? body.description.trim() || null : null;

        const { error } = await admin.from("work_groups").update(patch).eq("id", groupId);
        if (error) {
          if (error.code === "23505") return jsonResponse({ success: false, code: "DUPLICATE", message: "Já existe um grupo ativo com este nome." }, 409);
          throw error;
        }
        await writeAudit("group_updated", null, { group_id: groupId, fields_changed: Object.keys(patch) });
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "deactivate_group": {
        if (!(await hasPermission("groups.manage"))) return await denyAndAudit("missing_groups_manage", null, "Você não tem permissão para gerenciar grupos.");
        const groupId = typeof body.groupId === "string" ? body.groupId : "";
        if (!groupId) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Grupo inválido." }, 400);

        const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("work_group_id", groupId);
        if ((count ?? 0) > 0) {
          return jsonResponse(
            { success: false, code: "GROUP_NOT_EMPTY", message: "Não é possível desativar um grupo com usuários associados. Reatribua os usuários primeiro." },
            400
          );
        }
        const { error } = await admin.from("work_groups").update({ active: false }).eq("id", groupId);
        if (error) throw error;
        await writeAudit("group_deactivated", null, { group_id: groupId });
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "get_user_permissions": {
        const target = await loadTarget(body.userId);
        if (!target) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Usuário não encontrado." }, 404);
        if (!(await hasPermission("permissions.manage")))
          return await denyAndAudit("missing_permissions_manage", target.id, "Você não tem permissão para gerenciar permissões.");
        if (!canManageRole(caller.role, target.role)) return await denyAndAudit("hierarchy_manage", target.id, "Você não pode ver as permissões deste usuário.");

        const [{ data: catalog }, { data: defaults }, { data: overrides }] = await Promise.all([
          admin.from("permission_catalog").select("key, label, description, category").order("category").order("label"),
          admin.from("role_default_permissions").select("permission_key").eq("role", target.role),
          admin.from("user_permission_overrides").select("permission_key, granted").eq("user_id", target.id),
        ]);

        const defaultSet = new Set((defaults ?? []).map((d) => d.permission_key));
        const overrideMap = new Map((overrides ?? []).map((o) => [o.permission_key, o.granted]));
        const isSuperAdmin = target.role === "super_admin";

        const permissions = (catalog ?? []).map((p) => {
          const roleDefault = isSuperAdmin || defaultSet.has(p.key);
          const override = overrideMap.has(p.key) ? (overrideMap.get(p.key) as boolean) : null;
          return {
            key: p.key,
            label: p.label,
            description: p.description,
            category: p.category,
            role_default: roleDefault,
            override,
            effective: isSuperAdmin ? true : override ?? roleDefault,
          };
        });

        return jsonResponse({ success: true, permissions });
      }

      // -----------------------------------------------------------------
      case "set_user_permissions": {
        const target = await loadTarget(body.userId);
        if (!target) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Usuário não encontrado." }, 404);
        if (!(await hasPermission("permissions.manage")))
          return await denyAndAudit("missing_permissions_manage", target.id, "Você não tem permissão para gerenciar permissões.");
        if (!canManageRole(caller.role, target.role)) return await denyAndAudit("hierarchy_manage", target.id, "Você não pode gerenciar as permissões deste usuário.");
        if (target.role === "super_admin") {
          return jsonResponse(
            { success: false, code: "VALIDATION_ERROR", message: "Super administradores já têm acesso total — não é possível restringir permissões deles." },
            400
          );
        }

        const overrides = body.overrides;
        if (!overrides || typeof overrides !== "object") return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Permissões inválidas." }, 400);

        const entries = Object.entries(overrides as Record<string, unknown>).filter(([, v]) => typeof v === "boolean" || v === null);
        for (const [key, value] of entries) {
          if (key === "users.create_admin" && value === true && caller.role !== "super_admin") {
            return await denyAndAudit("hierarchy_grant_create_admin", target.id, "Só o super administrador pode conceder permissão para criar outros administradores.");
          }
        }

        const toUpsert = entries
          .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
          .map(([key, granted]) => ({ user_id: target.id, permission_key: key, granted, granted_by: caller.id }));
        const toRemove = entries.filter(([, v]) => v === null).map(([key]) => key);

        if (toUpsert.length > 0) {
          const { error } = await admin.from("user_permission_overrides").upsert(toUpsert, { onConflict: "user_id,permission_key" });
          if (error) throw error;
        }
        if (toRemove.length > 0) {
          const { error } = await admin.from("user_permission_overrides").delete().eq("user_id", target.id).in("permission_key", toRemove);
          if (error) throw error;
        }

        await writeAudit("permissions_updated", target.id, { changed_keys: entries.map(([k]) => k) });
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "list_audit_logs": {
        if (!(await hasPermission("audit.view"))) return await denyAndAudit("missing_audit_view", null, "Você não tem permissão para consultar a auditoria.");
        const { page, pageSize } = sanitizePagination(body);
        const from = page * pageSize;
        const to = from + pageSize - 1;

        let q = admin.from("audit_logs").select("id, user_id, action, entity_type, entity_id, metadata, created_at", { count: "exact" });
        if (typeof body.adminUserId === "string" && body.adminUserId) q = q.eq("user_id", body.adminUserId);
        if (typeof body.actionFilter === "string" && body.actionFilter) q = q.eq("action", body.actionFilter);
        if (typeof body.dateFrom === "string" && body.dateFrom) q = q.gte("created_at", body.dateFrom);
        if (typeof body.dateTo === "string" && body.dateTo) q = q.lte("created_at", body.dateTo);
        q = q.order("created_at", { ascending: false }).range(from, to);

        const { data, error, count } = await q;
        if (error) throw error;

        const ids = new Set<string>();
        for (const row of data ?? []) {
          if (row.user_id) ids.add(row.user_id);
          if (row.entity_type === "profile" && row.entity_id) ids.add(row.entity_id);
        }
        const { data: names } =
          ids.size > 0 ? await admin.from("profiles").select("id, full_name, email").in("id", Array.from(ids)) : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
        const nameById = new Map((names ?? []).map((n) => [n.id, n]));

        const logs = (data ?? []).map((row) => ({
          ...row,
          admin_name: row.user_id ? nameById.get(row.user_id)?.full_name ?? null : null,
          admin_email: row.user_id ? nameById.get(row.user_id)?.email ?? null : null,
          target_name: row.entity_type === "profile" && row.entity_id ? nameById.get(row.entity_id)?.full_name ?? null : null,
        }));

        return jsonResponse({ success: true, logs, total: count ?? 0, page, pageSize });
      }

      // -----------------------------------------------------------------
      // Integrações (ERP/marketplace) — até 4 lojas/conexões independentes
      // por marketplace (pedido: cada uma com nome, credenciais, tokens,
      // status e logs próprios — editar/desativar/remover uma nunca afeta
      // as outras). Nunca devolve segredo em texto puro depois de salvo (só
      // um resumo mascarado, ver maskSecret em logic.ts) — e nunca chama
      // nenhuma API externa de verdade por conta própria (isso continua
      // fora de escopo até existir documentação/credenciais reais por
      // provedor, ver migration 0049).
      case "list_integration_connections": {
        if (!(await hasPermission("integrations.manage")))
          return await denyAndAudit("missing_integrations_manage", null, "Você não tem permissão para gerenciar credenciais de integrações.");

        const { data: connectionRows, error: connectionsError } = await admin
          .from("integration_providers")
          .select("id, provider, display_name, brand, branch, fulfillment_mode, status, is_active, last_sync_at, next_retry_at, last_error, created_at, updated_at")
          .eq("company_id", caller.company_id)
          .order("created_at", { ascending: true });
        if (connectionsError) throw connectionsError;

        const connectionIds = (connectionRows ?? []).map((c) => c.id);
        const { data: credentialRows, error: credentialsError } =
          connectionIds.length > 0
            ? await admin
                .from("integration_credentials")
                .select("provider_id, client_id, client_secret, access_token, refresh_token, external_account_id, scopes, expires_at, updated_at")
                .in("provider_id", connectionIds)
            : { data: [] as Record<string, unknown>[], error: null };
        if (credentialsError) throw credentialsError;

        const credentialByConnectionId = new Map((credentialRows ?? []).map((c) => [c.provider_id as string, c]));
        const connectionsByProvider = new Map<string, Record<string, unknown>[]>();
        for (const row of connectionRows ?? []) {
          const cred = credentialByConnectionId.get(row.id as string);
          const list = connectionsByProvider.get(row.provider as string) ?? [];
          list.push({
            id: row.id,
            provider: row.provider,
            display_name: row.display_name,
            brand: row.brand,
            branch: row.branch,
            fulfillment_mode: row.fulfillment_mode,
            status: row.status,
            is_active: row.is_active,
            last_sync_at: row.last_sync_at,
            next_retry_at: row.next_retry_at,
            last_error: row.last_error,
            created_at: row.created_at,
            updated_at: row.updated_at,
            credential: cred
              ? {
                  client_id: (cred.client_id as string | null) ?? null,
                  external_account_id: (cred.external_account_id as string | null) ?? null,
                  scopes: (cred.scopes as string | null) ?? null,
                  expires_at: (cred.expires_at as string | null) ?? null,
                  client_secret_masked: maskSecret(cred.client_secret as string | null),
                  access_token_masked: maskSecret(cred.access_token as string | null),
                  refresh_token_masked: maskSecret(cred.refresh_token as string | null),
                  updated_at: cred.updated_at,
                }
              : null,
          });
          connectionsByProvider.set(row.provider as string, list);
        }

        const providers = INTEGRATION_PROVIDERS.map((provider) => {
          const connections = connectionsByProvider.get(provider) ?? [];
          return { provider, connections, count: connections.length, limit: MAX_CONNECTIONS_PER_PROVIDER };
        });

        return jsonResponse({ success: true, providers });
      }

      // -----------------------------------------------------------------
      case "create_integration_connection": {
        if (!(await hasPermission("integrations.manage")))
          return await denyAndAudit("missing_integrations_manage", null, "Você não tem permissão para gerenciar credenciais de integrações.");

        const provider = body.provider;
        if (!isValidIntegrationProvider(provider)) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Provedor inválido." }, 400);

        const fields = sanitizeConnectionMetaFields(body);
        if (!fields.display_name) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Informe um nome para a loja." }, 400);

        // Checagem "amigável" ANTES do insert — o trigger protect_integration_connection_limit
        // no banco (migration 0052) é quem garante isto de forma incondicional
        // (inclusive contra uma corrida real de duas requisições simultâneas).
        const { count, error: countError } = await admin
          .from("integration_providers")
          .select("id", { count: "exact", head: true })
          .eq("company_id", caller.company_id)
          .eq("provider", provider);
        if (countError) throw countError;
        if (hasReachedConnectionLimit(count ?? 0)) {
          return jsonResponse({ success: false, code: "CONNECTION_LIMIT_REACHED", message: "Limite de 4 lojas atingido para este marketplace." }, 400);
        }

        const { data: created, error: createError } = await admin
          .from("integration_providers")
          .insert({ company_id: caller.company_id, provider, status: "not_configured", is_active: true, ...fields })
          .select("id")
          .single();
        if (createError) {
          if (/Limite de 4/.test(createError.message ?? "")) {
            return jsonResponse({ success: false, code: "CONNECTION_LIMIT_REACHED", message: "Limite de 4 lojas atingido para este marketplace." }, 400);
          }
          throw createError;
        }

        await writeAudit("integration_connection_created", created.id, { provider, display_name: fields.display_name }, "integration_connection");
        return jsonResponse({ success: true, connectionId: created.id });
      }

      // -----------------------------------------------------------------
      case "update_integration_connection": {
        if (!(await hasPermission("integrations.manage")))
          return await denyAndAudit("missing_integrations_manage", null, "Você não tem permissão para gerenciar credenciais de integrações.");

        const connection = await loadConnection(body.connectionId);
        if (!connection) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Loja/conexão não encontrada." }, 404);

        const fields = sanitizeConnectionMetaFields(body);
        if (Object.keys(fields).length === 0) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Informe pelo menos um campo para atualizar." }, 400);

        const { error: updateError } = await admin.from("integration_providers").update(fields).eq("id", connection.id);
        if (updateError) throw updateError;

        await writeAudit("integration_connection_updated", connection.id, { provider: connection.provider, fields_changed: Object.keys(fields) }, "integration_connection");
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "set_integration_connection_active": {
        if (!(await hasPermission("integrations.manage")))
          return await denyAndAudit("missing_integrations_manage", null, "Você não tem permissão para gerenciar credenciais de integrações.");

        const connection = await loadConnection(body.connectionId);
        if (!connection) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Loja/conexão não encontrada." }, 404);

        const active = body.active;
        if (typeof active !== "boolean") return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Informe o novo estado (ativo/inativo)." }, 400);

        const { error: updateError } = await admin.from("integration_providers").update({ is_active: active }).eq("id", connection.id);
        if (updateError) throw updateError;

        await writeAudit(active ? "integration_connection_activated" : "integration_connection_deactivated", connection.id, { provider: connection.provider }, "integration_connection");
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "remove_integration_connection": {
        if (!(await hasPermission("integrations.manage")))
          return await denyAndAudit("missing_integrations_manage", null, "Você não tem permissão para gerenciar credenciais de integrações.");

        const connection = await loadConnection(body.connectionId);
        if (!connection) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Loja/conexão não encontrada." }, 404);

        // integration_credentials.provider_id tem "on delete cascade"
        // (migration 0049) — a credencial desta conexão some junto, nunca
        // fica órfã.
        const { error: deleteError } = await admin.from("integration_providers").delete().eq("id", connection.id);
        if (deleteError) throw deleteError;

        await writeAudit("integration_connection_removed", connection.id, { provider: connection.provider, display_name: connection.display_name }, "integration_connection");
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "save_integration_connection_credentials": {
        if (!(await hasPermission("integrations.manage")))
          return await denyAndAudit("missing_integrations_manage", null, "Você não tem permissão para gerenciar credenciais de integrações.");

        const connection = await loadConnection(body.connectionId);
        if (!connection) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Loja/conexão não encontrada." }, 404);

        const fields = sanitizeCredentialFields(body);
        if (!hasAnyCredentialField(fields)) {
          return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Informe pelo menos um campo de credencial." }, 400);
        }

        // Sempre que um access_token novo é salvo, assume que acabou de ser
        // obtido agora (o admin geralmente cola o token logo depois do fluxo
        // OAuth) e carimba a validade real do Tiny (4h) — sem isso,
        // tiny-integration nunca saberia quando renovar via refresh_token.
        const credentialPatch: Record<string, unknown> = { provider_id: connection.id, ...fields };
        if (fields.access_token) credentialPatch.expires_at = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

        const { error: credentialError } = await admin.from("integration_credentials").upsert(credentialPatch, { onConflict: "provider_id" });
        if (credentialError) throw credentialError;

        // Nunca "connected" só por ter salvo — o status só vira "connected"
        // depois de uma validação real (Testar conexão, quando existir pra
        // este provedor) — mesma regra de sempre (ver 0049).
        await admin.from("integration_providers").update({ status: "configuration_incomplete" }).eq("id", connection.id);

        // Nunca grava o valor dos campos em si na auditoria — só QUAIS campos
        // foram alterados (o segredo em si não pertence nem ao log).
        await writeAudit("integration_credentials_saved", connection.id, { provider: connection.provider, fields_changed: Object.keys(fields) }, "integration_connection");
        return jsonResponse({ success: true });
      }

      // -----------------------------------------------------------------
      case "clear_integration_connection_credentials": {
        if (!(await hasPermission("integrations.manage")))
          return await denyAndAudit("missing_integrations_manage", null, "Você não tem permissão para gerenciar credenciais de integrações.");

        const connection = await loadConnection(body.connectionId);
        if (!connection) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Loja/conexão não encontrada." }, 404);

        const { error: deleteError } = await admin.from("integration_credentials").delete().eq("provider_id", connection.id);
        if (deleteError) throw deleteError;

        const { error: resetError } = await admin
          .from("integration_providers")
          .update({ status: "not_configured", last_error: null, last_sync_at: null, next_retry_at: null })
          .eq("id", connection.id);
        if (resetError) throw resetError;

        await writeAudit("integration_credentials_cleared", connection.id, { provider: connection.provider }, "integration_connection");
        return jsonResponse({ success: true });
      }

      default: {
        // Checagem de exaustividade em tempo de compilação — se uma ação nova
        // for adicionada a ADMIN_ACTIONS (logic.ts) sem um case aqui, o
        // build quebra em vez de cair silenciosamente aqui em runtime.
        const _exhaustive: never = action;
        return jsonResponse({ success: false, code: "INVALID_ACTION", message: "Ação inválida.", _exhaustive }, 400);
      }
    }
  } catch (err) {
    console.error("[admin-users] erro inesperado:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ success: false, code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação. Tente novamente." }, 500);
  }
});
