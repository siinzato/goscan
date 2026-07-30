import test from "node:test";
import assert from "node:assert/strict";
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
} from "../supabase/functions/admin-users/logic.ts";

test("isValidRole aceita só os 4 papéis reais", () => {
  assert.equal(isValidRole("super_admin"), true);
  assert.equal(isValidRole("admin"), true);
  assert.equal(isValidRole("operator"), true);
  assert.equal(isValidRole("viewer"), true);
  assert.equal(isValidRole("manager"), false); // papel antigo, não existe mais
  assert.equal(isValidRole(""), false);
  assert.equal(isValidRole(undefined), false);
});

// ---------------------------------------------------------------------------
// canManageRole — hierarquia de gerenciamento (editar/ativar/desativar).
// ---------------------------------------------------------------------------
test("canManageRole: super_admin gerencia qualquer papel, inclusive outro super_admin", () => {
  for (const target of ["super_admin", "admin", "operator", "viewer"]) {
    assert.equal(canManageRole("super_admin", target), true, `super_admin deveria gerenciar ${target}`);
  }
});

test("canManageRole: admin gerencia só operator e viewer", () => {
  assert.equal(canManageRole("admin", "operator"), true);
  assert.equal(canManageRole("admin", "viewer"), true);
  assert.equal(canManageRole("admin", "admin"), false);
  assert.equal(canManageRole("admin", "super_admin"), false);
});

test("canManageRole: operator e viewer nunca gerenciam ninguém", () => {
  for (const caller of ["operator", "viewer"]) {
    for (const target of ["super_admin", "admin", "operator", "viewer"]) {
      assert.equal(canManageRole(caller, target), false, `${caller} não deveria gerenciar ${target}`);
    }
  }
});

// ---------------------------------------------------------------------------
// canCreateRole — hierarquia de criação de usuários.
// ---------------------------------------------------------------------------
test("canCreateRole: super_admin cria qualquer papel", () => {
  for (const target of ["super_admin", "admin", "operator", "viewer"]) {
    assert.equal(canCreateRole("super_admin", target, false), true);
  }
});

test("canCreateRole: admin cria operator/viewer sempre, admin só com permissão extra, super_admin nunca", () => {
  assert.equal(canCreateRole("admin", "operator", false), true);
  assert.equal(canCreateRole("admin", "viewer", false), true);
  assert.equal(canCreateRole("admin", "admin", false), false);
  assert.equal(canCreateRole("admin", "admin", true), true);
  assert.equal(canCreateRole("admin", "super_admin", false), false);
  assert.equal(canCreateRole("admin", "super_admin", true), false); // permissão extra nunca libera super_admin
});

test("canCreateRole: operator/viewer nunca criam ninguém", () => {
  for (const caller of ["operator", "viewer"]) {
    for (const target of ["super_admin", "admin", "operator", "viewer"]) {
      assert.equal(canCreateRole(caller, target, true), false, `${caller} não deveria criar ${target} mesmo com permissão`);
    }
  }
});

// ---------------------------------------------------------------------------
// Validações de campo.
// ---------------------------------------------------------------------------
test("isValidEmail rejeita e aceita corretamente", () => {
  assert.equal(isValidEmail("a@b.com"), true);
  assert.equal(isValidEmail("invalido"), false);
  assert.equal(isValidEmail("a@b"), false);
  assert.equal(isValidEmail(""), false);
});

test("isValidBrPhone aceita 10/11 dígitos com ou sem DDI 55", () => {
  assert.equal(isValidBrPhone("11957073408"), true); // 11 dígitos
  assert.equal(isValidBrPhone("1133334444"), true); // 10 dígitos
  assert.equal(isValidBrPhone("5511957073408"), true); // com DDI
  assert.equal(isValidBrPhone("123"), false);
});

test("passwordMeetsMinimum exige 8+ caracteres, maiúscula, minúscula e número", () => {
  assert.equal(passwordMeetsMinimum("Abcdefg1"), true);
  assert.equal(passwordMeetsMinimum("abcdefg1"), false); // sem maiúscula
  assert.equal(passwordMeetsMinimum("ABCDEFG1"), false); // sem minúscula
  assert.equal(passwordMeetsMinimum("Abcdefgh"), false); // sem número
  assert.equal(passwordMeetsMinimum("Ab1"), false); // curta
});

test("sanitizePagination usa defaults sensatos e nunca ultrapassa o teto", () => {
  assert.deepEqual(sanitizePagination({}), { page: 0, pageSize: 20 });
  assert.deepEqual(sanitizePagination({ page: 3, pageSize: 50 }), { page: 3, pageSize: 50 });
  assert.deepEqual(sanitizePagination({ page: -5, pageSize: 9999 }), { page: 0, pageSize: 100 });
  assert.deepEqual(sanitizePagination({ page: "abc", pageSize: null }), { page: 0, pageSize: 20 });
});

test("isValidAction aceita só as ações reais do dispatcher", () => {
  assert.equal(isValidAction("list_users"), true);
  assert.equal(isValidAction("create_user"), true);
  assert.equal(isValidAction("delete_everything"), false);
  assert.equal(isValidAction(123), false);
});

test("sanitizeGroupName rejeita vazio/só espaços e apara as bordas", () => {
  assert.equal(sanitizeGroupName("  Estoque  "), "Estoque");
  assert.equal(sanitizeGroupName("   "), null);
  assert.equal(sanitizeGroupName(""), null);
  assert.equal(sanitizeGroupName(123), null);
});

test("sanitizeSearchTerm remove vírgulas e parênteses (quebrariam o filtro .or() do PostgREST)", () => {
  assert.equal(sanitizeSearchTerm("joão, silva"), "joão  silva");
  assert.equal(sanitizeSearchTerm("teste(1)"), "teste 1");
  assert.equal(sanitizeSearchTerm("  ana  "), "ana");
  assert.equal(sanitizeSearchTerm("50% off_teste"), "50% off_teste");
});

// ---------------------------------------------------------------------------
// wouldLeaveZeroSuperAdmins — trava real "nunca zero super_admin ativo".
// Testada exaustivamente aqui (função pura) porque testar isto contra o
// banco de produção exigiria zerar temporariamente os super_admins reais
// existentes, o que nunca deve acontecer nem por um instante.
// ---------------------------------------------------------------------------
test("wouldLeaveZeroSuperAdmins nunca bloqueia quem não é super_admin ativo hoje", () => {
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "admin", active: true }, { active: false }, 0), false);
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: false }, { active: false }, 0), false);
});

test("wouldLeaveZeroSuperAdmins libera quando NÃO muda de fato (continua super_admin e ativo)", () => {
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: true }, {}, 0), false);
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: true }, { role: "super_admin", active: true }, 0), false);
});

test("wouldLeaveZeroSuperAdmins BLOQUEIA rebaixar/desativar o super_admin quando não sobra nenhum outro ativo", () => {
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: true }, { active: false }, 0), true);
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: true }, { role: "admin" }, 0), true);
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: true }, { role: "operator", active: false }, 0), true);
});

test("wouldLeaveZeroSuperAdmins LIBERA rebaixar/desativar quando existe pelo menos outro super_admin ativo", () => {
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: true }, { active: false }, 1), false);
  assert.equal(wouldLeaveZeroSuperAdmins({ role: "super_admin", active: true }, { role: "admin" }, 5), false);
});

// ---------------------------------------------------------------------------
// Integrações — validação/sanitização/mascaramento de credenciais reais de
// API (nunca deixam o segredo voltar ao navegador).
// ---------------------------------------------------------------------------
test("isValidIntegrationProvider aceita só os 6 provedores reais da migration 0049", () => {
  for (const p of ["tiny", "marketplace_mercado_livre", "marketplace_shopee", "marketplace_shein", "marketplace_amazon", "marketplace_tiktok"]) {
    assert.equal(isValidIntegrationProvider(p), true, `deveria aceitar ${p}`);
  }
  assert.equal(isValidIntegrationProvider("mercado_livre"), false); // nome de marketplace puro (usado em returns), não de provedor de integração
  assert.equal(isValidIntegrationProvider("tiny_erp"), false);
  assert.equal(isValidIntegrationProvider(""), false);
  assert.equal(isValidIntegrationProvider(undefined), false);
});

test("sanitizeCredentialFields aceita só os 6 campos reconhecidos, aparados, ignorando vazios e campos desconhecidos", () => {
  const out = sanitizeCredentialFields({
    client_id: "  abc123  ",
    client_secret: "s3gr3d0",
    access_token: "",
    refresh_token: "   ",
    external_account_id: "loja-1",
    scopes: "read write",
    role: "super_admin", // campo não reconhecido — nunca deve vazar pro insert
    company_id: "outra-empresa",
  });
  assert.deepEqual(out, {
    client_id: "abc123",
    client_secret: "s3gr3d0",
    external_account_id: "loja-1",
    scopes: "read write",
  });
  assert.equal("access_token" in out, false);
  assert.equal("refresh_token" in out, false);
  assert.equal("role" in out, false);
  assert.equal("company_id" in out, false);
});

test("sanitizeCredentialFields devolve objeto vazio quando não há nenhum campo válido", () => {
  assert.deepEqual(sanitizeCredentialFields({}), {});
  assert.deepEqual(sanitizeCredentialFields({ client_id: 123, foo: "bar" }), {});
});

test("hasAnyCredentialField distingue 'nada preenchido' de 'pelo menos um campo'", () => {
  assert.equal(hasAnyCredentialField({}), false);
  assert.equal(hasAnyCredentialField({ client_id: "x" }), true);
  assert.equal(hasAnyCredentialField({ scopes: "read" }), true);
});

test("maskSecret nunca reconstitui o segredo — só confirma os últimos 4 caracteres", () => {
  assert.equal(maskSecret("abcdefgh12345678"), "••••5678");
  assert.equal(maskSecret("ab"), "••••"); // curto demais pra revelar qualquer parte com segurança
  assert.equal(maskSecret(""), null);
  assert.equal(maskSecret(null), null);
  assert.equal(maskSecret(undefined), null);
});

test("maskSecret nunca inclui o valor original na saída (nem parcialmente além dos últimos 4)", () => {
  const secret = "sk_live_TOPSECRETVALUE9999";
  const masked = maskSecret(secret);
  assert.equal(masked.includes(secret.slice(0, -4)), false);
});

// ---------------------------------------------------------------------------
// Múltiplas lojas por marketplace (até 4) — identificação de cada conexão.
// ---------------------------------------------------------------------------
test("sanitizeConnectionMetaFields aceita só os 4 campos reconhecidos, aparados, ignorando vazios e campos desconhecidos", () => {
  const out = sanitizeConnectionMetaFields({
    display_name: "  Az — FBA Classic  ",
    brand: "az",
    branch: "",
    fulfillment_mode: "fba_classic",
    provider: "marketplace_amazon", // reconhecido em outro contexto, mas não é campo de metadado de conexão
    client_secret: "nunca-deveria-vazar-aqui",
  });
  assert.deepEqual(out, {
    display_name: "Az — FBA Classic",
    brand: "az",
    fulfillment_mode: "fba_classic",
  });
  assert.equal("branch" in out, false);
  assert.equal("provider" in out, false);
  assert.equal("client_secret" in out, false);
});

test("sanitizeConnectionMetaFields devolve objeto vazio quando não há nenhum campo válido", () => {
  assert.deepEqual(sanitizeConnectionMetaFields({}), {});
  assert.deepEqual(sanitizeConnectionMetaFields({ display_name: 123, foo: "bar" }), {});
});

test("hasReachedConnectionLimit bloqueia a 5a loja, nunca a 4a", () => {
  assert.equal(MAX_CONNECTIONS_PER_PROVIDER, 4);
  assert.equal(hasReachedConnectionLimit(0), false);
  assert.equal(hasReachedConnectionLimit(3), false);
  assert.equal(hasReachedConnectionLimit(4), true);
  assert.equal(hasReachedConnectionLimit(5), true);
});
