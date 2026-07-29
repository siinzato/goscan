-- 0035_admin_hierarchy_and_safety.sql
--
-- EXPANSÃO GOSCAN — Painel de Administração (Fase B), parte 4: função real
-- de permissão granular + trava incondicional contra ficar sem
-- super_admin + promoção seguro do super_admin atual.

-- ---------------------------------------------------------------------------
-- has_permission(key): fonte ÚNICA de verdade sobre "o usuário logado tem
-- esta permissão agora", usada tanto pelas policies de RLS quanto pela Edge
-- Function admin-users (via rpc) — nunca duas implementações divergentes.
-- Prioridade: super_admin sempre tem tudo > override individual (concede OU
-- revoga) > padrão do papel (role_default_permissions) > nega por padrão.
-- ---------------------------------------------------------------------------
create or replace function public.has_permission(perm_key text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  caller_role text;
  caller_active boolean;
  override_granted boolean;
begin
  select role, active into caller_role, caller_active
  from public.profiles
  where id = auth.uid();

  if caller_role is null or not caller_active then
    return false;
  end if;

  if caller_role = 'super_admin' then
    return true;
  end if;

  select granted into override_granted
  from public.user_permission_overrides
  where user_id = auth.uid() and permission_key = perm_key;

  if override_granted is not null then
    return override_granted;
  end if;

  return exists (
    select 1 from public.role_default_permissions
    where role = caller_role and permission_key = perm_key
  );
end;
$$;

comment on function public.has_permission(text) is 'Única fonte de verdade de permissão granular efetiva do usuário logado — usada por RLS e pela Edge Function admin-users via rpc(). super_admin sempre true; override individual tem prioridade sobre o padrão do papel.';

revoke all on function public.has_permission(text) from public;
grant execute on function public.has_permission(text) to authenticated;

-- work_groups_write (criada na 0032 só com is_admin()) agora também aceita
-- quem tiver a permissão granular 'groups.manage' — delegação real, sem
-- precisar reabrir aquela migration.
drop policy if exists work_groups_write on public.work_groups;
create policy work_groups_write on public.work_groups
  for all
  using (public.is_admin() or public.has_permission('groups.manage'))
  with check (public.is_admin() or public.has_permission('groups.manage'));

-- ---------------------------------------------------------------------------
-- protect_last_super_admin: trava REAL e incondicional no banco — dispara
-- mesmo para updates feitos via service_role (Edge Function), porque
-- triggers nunca são ignorados por service_role (só RLS é). É a garantia
-- final de "nunca permitir excluir/desativar/rebaixar o último super_admin
-- ativo", independente de qualquer bug futuro na Edge Function.
-- ---------------------------------------------------------------------------
create or replace function public.protect_last_super_admin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  remaining_active_super_admins integer;
begin
  if old.role = 'super_admin' and old.active = true
     and (new.role is distinct from 'super_admin' or new.active = false) then
    select count(*) into remaining_active_super_admins
    from public.profiles
    where role = 'super_admin' and active = true and id <> old.id;

    if remaining_active_super_admins = 0 then
      raise exception 'Não é possível remover, desativar ou rebaixar o último super administrador ativo do GoScan.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_last_super_admin on public.profiles;
create trigger protect_last_super_admin before update on public.profiles
  for each row execute function public.protect_last_super_admin();

-- ---------------------------------------------------------------------------
-- Promoção segura e condicional do super_admin atual (seção 2 do pedido).
-- NUNCA cria conta nova, NUNCA duplica perfil — só ATUALIZA o role da linha
-- já existente (localizada por e-mail em auth.users) se ainda não for
-- super_admin. Idempotente: rodar de novo não faz nada se já estiver certo.
-- Se o e-mail não existir ainda neste ambiente (ex.: banco de outro
-- ambiente), a migration não falha — só não faz nada (checagem condicional).
-- ---------------------------------------------------------------------------
do $$
declare
  target_user_id uuid;
begin
  select id into target_user_id from auth.users where email = 'victor@azbuy.com.br';

  if target_user_id is not null then
    update public.profiles
    set role = 'super_admin'
    where id = target_user_id and role <> 'super_admin';
  end if;
end $$;
