-- 0028_profile_extended_fields.sql
--
-- EXPANSÃO GOSCAN — Central de Perfil: campos novos em profiles pra
-- Configurações/Minha Conta/Segurança. Todos nullable ou com default —
-- nenhum impacto em linha existente.
alter table public.profiles
  add column if not exists job_title text,
  add column if not exists work_group text,
  add column if not exists phone text,
  add column if not exists recovery_email text,
  add column if not exists recovery_email_verified boolean not null default false,
  add column if not exists theme text not null default 'light' check (theme in ('light', 'dark')),
  add column if not exists must_change_password boolean not null default false,
  add column if not exists last_login_at timestamptz;

comment on column public.profiles.work_group is 'Texto livre (não é uma tabela normalizada) — só usado pra exibição/filtro no painel administrativo.';
comment on column public.profiles.recovery_email is 'E-mail alternativo de recuperação — NUNCA usado pra nada sensível enquanto recovery_email_verified=false. Distinto do e-mail de login (auth.users.email), que já tem confirmação nativa do Supabase Auth.';
comment on column public.profiles.recovery_email_verified is 'Só true depois de uma verificação real de posse de caixa de entrada (OTP) — nunca setado manualmente/direto.';
comment on column public.profiles.theme is 'Preferência de tema por usuário — fonte de verdade depois do login; localStorage é só cache/fallback pra evitar flash antes do boot.';
comment on column public.profiles.must_change_password is 'Quando true, o app força a troca de senha antes de liberar qualquer tela normal — setado por um admin ao criar/resetar credenciais de outro usuário.';
comment on column public.profiles.last_login_at is 'Atualizado pelo próprio cliente logo após a sessão ser validada (update permitido pela policy profiles_update já existente, id = auth.uid()) — não é um horário de auditoria de segurança, só exibição no painel administrativo.';

-- profiles_update já permite id = auth.uid() (ver 0002_rls_policies.sql) —
-- os campos novos acima ficam automaticamente editáveis pelo próprio
-- usuário sem precisar de nenhuma policy nova, EXCETO must_change_password:
-- um usuário comum não pode se auto-isentar de uma troca de senha exigida
-- por um admin, então esse campo recebe a MESMA proteção de role/active
-- (só quem passa is_admin() — super_admin — pode alterá-lo via este caminho;
-- o painel administrativo da Fase B usa o cliente service-role, que já
-- ignora este trigger, ver comentário em protect_profile_fields abaixo).
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
    new.must_change_password := old.must_change_password;
  end if;
  return new;
end;
$$;

-- Único jeito de um usuário comum sair do estado must_change_password=true:
-- uma função dedicada (nunca um update de tabela livre) que só mexe na
-- PRÓPRIA linha do chamador (auth.uid() embutido, não recebe id como
-- parâmetro) — chamada pelo cliente IMEDIATAMENTE depois de uma troca de
-- senha real via Supabase Auth (updateUser({password})), nunca como toggle
-- solto na UI.
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
  update public.profiles set must_change_password = false where id = auth.uid();
end;
$$;

revoke all on function public.clear_own_must_change_password() from public;
grant execute on function public.clear_own_must_change_password() to authenticated;
