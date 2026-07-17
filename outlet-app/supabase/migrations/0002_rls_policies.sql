-- 0002_rls_policies.sql
-- Ativa RLS em todas as tabelas operacionais e define as políticas de acesso.
--
-- Funções SECURITY DEFINER abaixo existem só para permitir que as policies
-- consultem public.profiles sem provocar recursão de RLS (uma policy em
-- profiles que consulta profiles via uma subquery normal reativaria a própria
-- policy). Rodando como SECURITY DEFINER com search_path fixo, a consulta
-- interna ignora RLS e não há recursão nem risco de search_path hijacking.

create or replace function public.current_profile_role()
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_profile_active()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.current_profile_role() = 'admin' and public.current_profile_active();
$$;

create or replace function public.is_manager_or_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.current_profile_role() in ('admin', 'manager') and public.current_profile_active();
$$;

create or replace function public.is_active_user()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and public.current_profile_active();
$$;

-- ---------------------------------------------------------------------------
-- Ativa RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_aliases enable row level security;
alter table public.conferences enable row level security;
alter table public.conference_items enable row level security;
alter table public.catalog_imports enable row level security;
alter table public.audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select
  using (id = auth.uid() or public.is_manager_or_admin());

-- Update é permitido para o próprio usuário (ex.: full_name) e para admin.
-- Role/active são protegidos por trigger (protect_profile_fields), não só por RLS,
-- porque RLS não compara valores antigo/novo dentro da mesma linha com segurança total.
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Sem policy de insert/delete: profiles só é criado pela trigger handle_new_user
-- (SECURITY DEFINER) e nunca é apagado via API.

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    new.role := old.role;
    new.active := old.active;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ---------------------------------------------------------------------------
-- products / product_variants / product_aliases (catálogo)
-- Leitura: qualquer usuário autenticado e ativo.
-- Escrita: apenas manager/admin (importação e cadastro manual).
-- ---------------------------------------------------------------------------
drop policy if exists products_select on public.products;
create policy products_select on public.products
  for select using (public.is_active_user());

drop policy if exists products_write on public.products;
create policy products_write on public.products
  for all
  using (public.is_manager_or_admin())
  with check (public.is_manager_or_admin());

drop policy if exists product_variants_select on public.product_variants;
create policy product_variants_select on public.product_variants
  for select using (public.is_active_user());

drop policy if exists product_variants_write on public.product_variants;
create policy product_variants_write on public.product_variants
  for all
  using (public.is_manager_or_admin())
  with check (public.is_manager_or_admin());

drop policy if exists product_aliases_select on public.product_aliases;
create policy product_aliases_select on public.product_aliases
  for select using (public.is_active_user());

-- manager/admin podem inserir qualquer alias_type.
drop policy if exists product_aliases_insert_manager on public.product_aliases;
create policy product_aliases_insert_manager on public.product_aliases
  for insert
  with check (public.is_manager_or_admin());

-- operator só pode inserir SUGESTÕES (alias_type='operator', não ativa, atribuída a si mesmo,
-- e sempre associada a um produto existente) — nunca grava um alias global/ativo direto.
drop policy if exists product_aliases_insert_operator on public.product_aliases;
create policy product_aliases_insert_operator on public.product_aliases
  for insert
  with check (
    public.is_active_user()
    and alias_type = 'operator'
    and active = false
    and created_by = auth.uid()
    and product_id is not null
  );

-- só manager/admin promovem/editam aliases (ex.: aceitar sugestão de operator).
drop policy if exists product_aliases_update on public.product_aliases;
create policy product_aliases_update on public.product_aliases
  for update
  using (public.is_manager_or_admin())
  with check (public.is_manager_or_admin());

drop policy if exists product_aliases_delete on public.product_aliases;
create policy product_aliases_delete on public.product_aliases
  for delete
  using (public.is_manager_or_admin());

-- ---------------------------------------------------------------------------
-- conferences
-- ---------------------------------------------------------------------------
drop policy if exists conferences_select on public.conferences;
create policy conferences_select on public.conferences
  for select
  using (operator_id = auth.uid() or public.is_manager_or_admin());

drop policy if exists conferences_insert on public.conferences;
create policy conferences_insert on public.conferences
  for insert
  with check (public.is_active_user() and operator_id = auth.uid());

-- Operator só edita enquanto draft/in_progress; manager/admin edita sempre
-- (inclusive para corrigir uma conferência já completed).
drop policy if exists conferences_update on public.conferences;
create policy conferences_update on public.conferences
  for update
  using (
    (operator_id = auth.uid() and status in ('draft', 'in_progress'))
    or public.is_manager_or_admin()
  )
  with check (
    operator_id = auth.uid() or public.is_manager_or_admin()
  );

-- ---------------------------------------------------------------------------
-- conference_items (visibilidade e edição seguem a conferência-pai)
-- ---------------------------------------------------------------------------
drop policy if exists conference_items_select on public.conference_items;
create policy conference_items_select on public.conference_items
  for select
  using (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and (c.operator_id = auth.uid() or public.is_manager_or_admin())
    )
  );

drop policy if exists conference_items_insert on public.conference_items;
create policy conference_items_insert on public.conference_items
  for insert
  with check (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and (
          (c.operator_id = auth.uid() and c.status in ('draft', 'in_progress'))
          or public.is_manager_or_admin()
        )
    )
  );

drop policy if exists conference_items_update on public.conference_items;
create policy conference_items_update on public.conference_items
  for update
  using (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and (
          (c.operator_id = auth.uid() and c.status in ('draft', 'in_progress'))
          or public.is_manager_or_admin()
        )
    )
  );

drop policy if exists conference_items_delete on public.conference_items;
create policy conference_items_delete on public.conference_items
  for delete
  using (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and (
          (c.operator_id = auth.uid() and c.status in ('draft', 'in_progress'))
          or public.is_manager_or_admin()
        )
    )
  );

-- ---------------------------------------------------------------------------
-- catalog_imports
-- ---------------------------------------------------------------------------
drop policy if exists catalog_imports_select on public.catalog_imports;
create policy catalog_imports_select on public.catalog_imports
  for select
  using (imported_by = auth.uid() or public.is_manager_or_admin());

drop policy if exists catalog_imports_insert on public.catalog_imports;
create policy catalog_imports_insert on public.catalog_imports
  for insert
  with check (public.is_manager_or_admin() and imported_by = auth.uid());

drop policy if exists catalog_imports_update on public.catalog_imports;
create policy catalog_imports_update on public.catalog_imports
  for update
  using (imported_by = auth.uid() or public.is_manager_or_admin())
  with check (imported_by = auth.uid() or public.is_manager_or_admin());

-- ---------------------------------------------------------------------------
-- audit_logs — imutável: sem policy de update/delete para ninguém.
-- ---------------------------------------------------------------------------
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select
  using (public.is_admin());

drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs
  for insert
  with check (user_id = auth.uid());
