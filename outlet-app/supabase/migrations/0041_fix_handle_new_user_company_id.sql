-- 0041_fix_handle_new_user_company_id.sql
--
-- HOTFIX — BUG REAL introduzido pela própria 0037_companies.sql e encontrado
-- na verificação real desta correção (não em produção antes disso, mas teria
-- quebrado a próxima criação de usuário real): profiles.company_id passou a
-- ser NOT NULL, mas handle_new_user() (trigger AFTER INSERT em auth.users,
-- ver 0001_init_schema.sql) nunca foi atualizada pra preencher esse campo —
-- QUALQUER criação de usuário novo (inclusive via admin.auth.admin.createUser
-- chamado pela Edge Function admin-users) passou a falhar com "null value in
-- column company_id violates not-null constraint", reportado pelo Supabase
-- Auth como um erro genérico 500/AuthRetryableFetchError sem detalhe nenhum.
--
-- Fix: handle_new_user() agora preenche company_id com a empresa mais antiga
-- cadastrada (hoje só existe uma, "GoCase") — mesmo critério de fallback já
-- usado nos backfills da própria 0037. A Edge Function admin-users
-- (create_user) já sobrescreve este valor logo em seguida com
-- caller.company_id de qualquer forma (ver supabase/functions/admin-users/
-- index.ts) — este é só o valor inicial que evita a violação da constraint
-- no INSERT que a própria trigger faz.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, full_name, role, active, company_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'operator',
    true,
    (select id from public.companies order by created_at asc limit 1)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
