-- 0007_catalog_visual_audit_triggers.sql
-- "Toda alteração deve registrar o usuário responsável" — trigger automática
-- em vez de depender do frontend/backend lembrarem de inserir o log toda
-- vez (mesmo padrão de 0003_audit_triggers.sql, reaproveitando audit_logs).
--
-- auth.uid() é nulo quando quem grava é o backend com service_role (as
-- importações em lote) — nesse caso usamos uploaded_by (setado pelo backend
-- como o created_by da importação) como responsável.

create or replace function public.audit_product_image_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  acting_user uuid;
  action_name text;
  variant_id uuid;
begin
  if tg_op = 'INSERT' then
    acting_user := coalesce(auth.uid(), new.uploaded_by);
    action_name := 'image_created';
    variant_id := new.product_variant_id;
  elsif tg_op = 'UPDATE' then
    acting_user := coalesce(auth.uid(), new.uploaded_by, old.uploaded_by);
    action_name := 'image_updated';
    variant_id := new.product_variant_id;
  else
    acting_user := coalesce(auth.uid(), old.uploaded_by);
    action_name := 'image_deleted';
    variant_id := old.product_variant_id;
  end if;

  insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
  values (
    acting_user,
    action_name,
    'product_images',
    coalesce(new.id, old.id),
    jsonb_build_object(
      'product_variant_id', variant_id,
      'previous_data', case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      'new_data', case when tg_op = 'DELETE' then null else to_jsonb(new) end
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_product_image_change on public.product_images;
create trigger audit_product_image_change
  after insert or update or delete on public.product_images
  for each row execute function public.audit_product_image_change();
