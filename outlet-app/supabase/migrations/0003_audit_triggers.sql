-- 0003_audit_triggers.sql
-- Registro automático de eventos sensíveis em audit_logs.
-- Roda SECURITY DEFINER para poder inserir mesmo com a policy de audit_logs
-- restrita (user_id = auth.uid()); aqui gravamos com o ator real via auth.uid().

create or replace function public.audit_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      'profile_role_or_active_changed',
      'profiles',
      new.id,
      jsonb_build_object(
        'old_role', old.role, 'new_role', new.role,
        'old_active', old.active, 'new_active', new.active
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_profile_role_change on public.profiles;
create trigger audit_profile_role_change
  after update on public.profiles
  for each row execute function public.audit_profile_role_change();

create or replace function public.audit_conference_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      'conference_status_changed',
      'conferences',
      new.id,
      jsonb_build_object('old_status', old.status, 'new_status', new.status)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_conference_status_change on public.conferences;
create trigger audit_conference_status_change
  after update on public.conferences
  for each row execute function public.audit_conference_status_change();
