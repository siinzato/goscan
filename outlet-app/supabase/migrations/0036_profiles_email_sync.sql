-- 0036_profiles_email_sync.sql
--
-- EXPANSÃO GOSCAN — Painel de Administração (Fase B), parte 5: e-mail
-- espelhado em profiles. O e-mail de login mora em auth.users (fonte de
-- verdade), mas o painel precisa buscar/filtrar/ordenar usuários por nome
-- OU e-mail numa única consulta paginada real — não dá pra fazer isso
-- eficientemente via PostgREST cruzando profiles e auth.users (schemas
-- diferentes, sem join nativo no cliente). Solução padrão: uma cópia
-- somente-leitura do e-mail em profiles, mantida em sincronia por trigger —
-- nunca editável diretamente (sempre reflete auth.users.email).
alter table public.profiles add column if not exists email text;

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is distinct from u.email;

comment on column public.profiles.email is 'Cópia somente-leitura de auth.users.email, mantida por trigger (sync_profile_email) — existe só pra permitir busca/ordenação real de usuários numa única consulta. Nunca é a fonte de verdade nem editável direto.';

-- handle_new_user (0001) passa a gravar o e-mail já na criação.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, full_name, role, active, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'operator',
    true,
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Mantém profiles.email em sincronia se o e-mail de login mudar depois
-- (troca pelo próprio usuário via Minha Conta, ou pelo painel administrativo).
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.sync_profile_email();

create index if not exists profiles_email_idx on public.profiles (email);
