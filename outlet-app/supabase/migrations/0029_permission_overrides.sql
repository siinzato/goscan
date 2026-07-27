-- 0029_permission_overrides.sql
--
-- EXPANSÃO GOSCAN — scaffold da Fase B (permissões granulares por usuário,
-- além do que o papel já garante). Criado agora (aditivo, sem uso ainda na
-- Fase A) pra não exigir outra rodada de migration quando o painel
-- administrativo for implementado.
create table if not exists public.permission_catalog (
  key text primary key,
  label text not null,
  description text
);

comment on table public.permission_catalog is 'Catálogo fixo das ações granulares que podem ser concedidas/revogadas por usuário além do papel — só leitura pelo app, gerenciado por migration.';

insert into public.permission_catalog (key, label, description) values
  ('manage_users', 'Gerenciar usuários', 'Criar, editar e (des)ativar contas de usuário.'),
  ('manage_permissions', 'Gerenciar permissões', 'Conceder ou revogar permissões granulares de outros usuários.'),
  ('view_audit_log', 'Consultar auditoria', 'Ver o registro de ações administrativas.'),
  ('export_reports', 'Exportar relatórios', 'Exportar relatórios de conferência em PDF/Excel.'),
  ('edit_products', 'Editar produtos', 'Cadastrar ou editar produtos do catálogo (Outlet e Normais).'),
  ('create_recognition', 'Criar reconhecimento', 'Cadastrar imagens de referência pra memória visual.'),
  ('validate_recognition', 'Validar/ensinar reconhecimento', 'Confirmar ou corrigir sugestões de reconhecimento.'),
  ('resolve_pending', 'Resolver pendências', 'Vincular manualmente itens não reconhecidos/não localizados.')
on conflict (key) do nothing;

create table if not exists public.user_permission_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  permission_key text not null references public.permission_catalog (key) on delete cascade,
  granted boolean not null,
  granted_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (user_id, permission_key)
);

comment on table public.user_permission_overrides is 'Permissão pontual por usuário, além do que o papel já concede — camada aditiva usada pelo painel administrativo (Fase B).';

create index if not exists user_permission_overrides_user_id_idx on public.user_permission_overrides (user_id);

alter table public.permission_catalog enable row level security;
alter table public.user_permission_overrides enable row level security;

drop policy if exists permission_catalog_select on public.permission_catalog;
create policy permission_catalog_select on public.permission_catalog
  for select using (public.is_active_user());

drop policy if exists user_permission_overrides_select on public.user_permission_overrides;
create policy user_permission_overrides_select on public.user_permission_overrides
  for select
  using (user_id = auth.uid() or public.is_manager_or_admin());

-- Só super_admin concede/revoga diretamente via RLS na Fase A — o painel da
-- Fase B decide se delega esse poder a admins específicos (via a própria
-- tabela: conceder a chave 'manage_permissions' a um admin) antes de
-- flexibilizar esta policy.
drop policy if exists user_permission_overrides_write on public.user_permission_overrides;
create policy user_permission_overrides_write on public.user_permission_overrides
  for all
  using (public.is_admin())
  with check (public.is_admin());
