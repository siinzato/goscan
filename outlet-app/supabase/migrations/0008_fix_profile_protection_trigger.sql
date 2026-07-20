-- 0008_fix_profile_protection_trigger.sql
--
-- Corrige um bug real encontrado ao testar a promoção manual do primeiro
-- admin (ver README §6): a trigger protect_profile_fields (0002_rls_policies.sql)
-- clampava new.role/new.active de volta pro valor antigo sempre que
-- public.is_admin() era falso — e is_admin() também é falso quando
-- auth.uid() é NULL, que é exatamente o caso de uma query rodada direto no
-- SQL Editor do Supabase (superusuário, sem sessão de usuário autenticado).
-- Resultado: o UPDATE "rodava" (updated_at mudava, sem erro), mas o role
-- nunca era promovido de verdade.
--
-- Fix: só aplicar o clamp quando existe uma sessão autenticada (auth.uid()
-- não nulo) que não seja admin — ou seja, protege contra um operator/manager
-- autenticado tentando se autopromover pelo app, mas não interfere com ações
-- diretas no banco (SQL Editor, migrations, scripts com service_role), que já
-- são protegidas por exigirem credenciais de banco/administração muito mais
-- fortes que uma sessão de app.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.role := old.role;
    new.active := old.active;
  end if;
  return new;
end;
$$;

-- A trigger em si (criada em 0002) não muda, só a função que ela executa —
-- não precisa de drop/create trigger de novo.
