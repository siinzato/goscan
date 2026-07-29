-- 0034_role_default_permissions.sql
--
-- EXPANSÃO GOSCAN — Painel de Administração (Fase B), parte 3: padrão de
-- permissões por papel. Fonte de dados real pra "aplicar permissões padrão
-- conforme o papel" / "restaurar padrão do papel" no painel, e pra
-- has_permission() (migration 0035) decidir o que um papel tem por padrão
-- antes de aplicar qualquer override individual.
--
-- super_admin nunca tem linha aqui de propósito: has_permission() trata
-- super_admin como "tem tudo" incondicionalmente, sem depender de dado
-- nenhum nesta tabela (nunca pode ficar sem acesso por uma linha faltando).
create table if not exists public.role_default_permissions (
  role text not null check (role in ('super_admin', 'admin', 'operator', 'viewer')),
  permission_key text not null references public.permission_catalog (key) on delete cascade,
  primary key (role, permission_key)
);

comment on table public.role_default_permissions is 'Permissões que cada papel recebe por padrão (antes de qualquer override individual em user_permission_overrides). Editável só por super_admin — mudar isto afeta todo mundo daquele papel.';

delete from public.role_default_permissions;

-- Visualizador: só leitura, nos módulos explicitamente permitidos pelo pedido.
insert into public.role_default_permissions (role, permission_key) values
  ('viewer', 'home.view'),
  ('viewer', 'catalog.view'),
  ('viewer', 'history.view'),
  ('viewer', 'reports.view');

-- Operador: opera o dia a dia (conferências, scanner, catálogo de leitura,
-- pendências, histórico/relatórios) — nunca administração.
insert into public.role_default_permissions (role, permission_key) values
  ('operator', 'home.view'),
  ('operator', 'conference.start'),
  ('operator', 'conference.continue'),
  ('operator', 'conference.finish'),
  ('operator', 'conference.nfe'),
  ('operator', 'scanner.use'),
  ('operator', 'recognition.create'),
  ('operator', 'recognition.validate'),
  ('operator', 'catalog.view'),
  ('operator', 'pending.view'),
  ('operator', 'pending.resolve'),
  ('operator', 'history.view'),
  ('operator', 'reports.view');

-- Administrador: tudo do operador + curadoria de catálogo + exportação +
-- gerenciar usuários/permissões (respeitando hierarquia na Edge Function).
-- NÃO inclui users.create_admin/groups.manage/audit.view por padrão —
-- reservados a super_admin, concedíveis via override individual.
insert into public.role_default_permissions (role, permission_key) values
  ('admin', 'home.view'),
  ('admin', 'conference.start'),
  ('admin', 'conference.continue'),
  ('admin', 'conference.finish'),
  ('admin', 'conference.nfe'),
  ('admin', 'scanner.use'),
  ('admin', 'recognition.create'),
  ('admin', 'recognition.validate'),
  ('admin', 'catalog.view'),
  ('admin', 'catalog.create'),
  ('admin', 'catalog.edit'),
  ('admin', 'pending.view'),
  ('admin', 'pending.resolve'),
  ('admin', 'history.view'),
  ('admin', 'reports.view'),
  ('admin', 'reports.export'),
  ('admin', 'users.manage'),
  ('admin', 'permissions.manage');

alter table public.role_default_permissions enable row level security;

drop policy if exists role_default_permissions_select on public.role_default_permissions;
create policy role_default_permissions_select on public.role_default_permissions
  for select using (public.is_active_user());

drop policy if exists role_default_permissions_write on public.role_default_permissions;
create policy role_default_permissions_write on public.role_default_permissions
  for all
  using (public.is_admin())
  with check (public.is_admin());
