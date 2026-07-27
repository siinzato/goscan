-- 0027_profile_role_expansion.sql
--
-- EXPANSÃO GOSCAN — Central de Perfil: hierarquia real de 4 papéis
-- (super_admin/admin/operator/viewer), substituindo os 3 atuais
-- (admin/manager/operator).
--
-- ESTRATÉGIA DE REMAPEAMENTO SEM REGRESSÃO (ver plano): os nomes das funções
-- is_admin()/is_manager_or_admin() são mantidos — só o que elas verificam por
-- baixo muda. Como TODA policy RLS do banco (27 migrations, ~25 policies)
-- resolve por essas duas funções (nenhuma reimplementa o check inline), e o
-- remapeamento de dados abaixo preserva o MESMO conjunto de usuários reais
-- passando em cada uma, nenhuma policy existente precisa ser tocada:
--   'admin'   (hoje) -> 'super_admin' (novo topo — quem já era admin continua admin de tudo)
--   'manager' (hoje) -> 'admin'       (novo "Administrador" — mesmos poderes de escrita que já tinha)
--   'operator' -> continua 'operator'
--   'viewer'   -> papel novo, ninguém migra pra ele automaticamente
--
-- ATENÇÃO: duas exceções reais existem FORA do banco e são corrigidas no
-- mesmo commit desta migration — src/server/server.ts e
-- src/server/supabaseAdmin.ts comparam `role === "admin" || role === "manager"`
-- inline (sem usar is_manager_or_admin()). Se não forem atualizadas junto,
-- quem era 'admin' (agora 'super_admin') perde acesso privilegiado no
-- backend enquanto quem era 'manager' (agora 'admin') o mantém — uma
-- regressão invertida e silenciosa.

-- 1) Remove o check constraint antigo (nome padrão gerado pelo Postgres pra
--    um `check` inline de coluna: <tabela>_<coluna>_check).
alter table public.profiles drop constraint if exists profiles_role_check;

-- 2) Remapeia os dados EXISTENTES antes de restringir o novo domínio — nunca
--    apaga nem perde nenhuma linha, só troca o rótulo do papel.
update public.profiles
set role = case role
  when 'admin' then 'super_admin'
  when 'manager' then 'admin'
  else role
end
where role in ('admin', 'manager');

-- 3) Novo domínio de papéis.
alter table public.profiles
  add constraint profiles_role_check check (role in ('super_admin', 'admin', 'operator', 'viewer'));

-- 4) Proteção explícita pedida: a migration nunca pode terminar sem deixar
--    pelo menos 1 super_admin ativo no sistema.
do $$
begin
  if not exists (select 1 from public.profiles where role = 'super_admin' and active) then
    raise exception 'Migration 0027 abortada: nenhum super_admin ativo restaria após o remapeamento.';
  end if;
end;
$$;

-- 5) Redefine os bodies das funções já existentes (MESMOS nomes — ver
--    estratégia acima). is_admin() agora é "topo da hierarquia" (super_admin);
--    is_manager_or_admin() agora é "camada administrativa" (super_admin OU
--    admin) — exatamente o que as duas já significavam pros usuários reais
--    antes desta migration.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.current_profile_role() = 'super_admin' and public.current_profile_active();
$$;

create or replace function public.is_manager_or_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.current_profile_role() in ('super_admin', 'admin') and public.current_profile_active();
$$;

comment on function public.is_admin() is 'Topo da hierarquia (super_admin) — nome mantido por compatibilidade com todas as policies/triggers existentes que já o chamavam.';
comment on function public.is_manager_or_admin() is 'Camada administrativa (super_admin OU admin) — nome mantido por compatibilidade; cobre os mesmos usuários reais que antes eram admin/manager.';
