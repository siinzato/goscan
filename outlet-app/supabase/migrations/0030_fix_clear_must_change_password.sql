-- 0030_fix_clear_must_change_password.sql
--
-- BUG REAL corrigido (encontrado na verificação real desta expansão):
-- clear_own_must_change_password() é SECURITY DEFINER, mas isso só isenta
-- checagens de RLS/grants — o trigger protect_profile_fields (BEFORE UPDATE)
-- continua disparando pra QUALQUER update na tabela, não importa por qual
-- caminho ele chegou. Como o trigger clampava must_change_password de volta
-- pro valor antigo sempre que auth.uid() não é super_admin, ele desfazia
-- silenciosamente o próprio update que a função deveria realizar — o
-- operador nunca conseguia sair do estado "troca de senha obrigatória".
--
-- Fix: um flag de sessão local à transação (set_config(..., true) = "is
-- local", nunca vaza pra fora desta transação/requisição) que a função seta
-- ANTES do update — o trigger só ignora o clamp de must_change_password
-- quando esse flag está presente. role/active continuam protegidos
-- incondicionalmente (a função nunca tenta alterá-los de qualquer forma).
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
    if coalesce(current_setting('goscan.allow_clear_must_change_password', true), '') <> 'true' then
      new.must_change_password := old.must_change_password;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.clear_own_must_change_password()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  perform set_config('goscan.allow_clear_must_change_password', 'true', true);
  update public.profiles set must_change_password = false where id = auth.uid();
end;
$$;
