-- 0005_catalog_visual_rls.sql
-- RLS das tabelas do Catálogo Visual + bucket/policies de Storage.
-- Reaproveita as funções SECURITY DEFINER já criadas em 0002_rls_policies.sql
-- (is_active_user, is_manager_or_admin) — sem duplicar lógica de permissão.

alter table public.product_images enable row level security;
alter table public.catalog_image_imports enable row level security;
alter table public.catalog_image_import_items enable row level security;

-- ---------------------------------------------------------------------------
-- product_images: leitura para qualquer usuário autenticado e ativo (operator
-- inclusive — ele só consulta/visualiza); escrita reservada a manager/admin.
-- ---------------------------------------------------------------------------
drop policy if exists product_images_select on public.product_images;
create policy product_images_select on public.product_images
  for select using (public.is_active_user());

drop policy if exists product_images_insert on public.product_images;
create policy product_images_insert on public.product_images
  for insert with check (public.is_manager_or_admin());

drop policy if exists product_images_update on public.product_images;
create policy product_images_update on public.product_images
  for update using (public.is_manager_or_admin()) with check (public.is_manager_or_admin());

drop policy if exists product_images_delete on public.product_images;
create policy product_images_delete on public.product_images
  for delete using (public.is_manager_or_admin());

-- ---------------------------------------------------------------------------
-- catalog_image_imports
-- ---------------------------------------------------------------------------
drop policy if exists catalog_image_imports_select on public.catalog_image_imports;
create policy catalog_image_imports_select on public.catalog_image_imports
  for select using (created_by = auth.uid() or public.is_manager_or_admin());

drop policy if exists catalog_image_imports_insert on public.catalog_image_imports;
create policy catalog_image_imports_insert on public.catalog_image_imports
  for insert with check (public.is_manager_or_admin() and created_by = auth.uid());

drop policy if exists catalog_image_imports_update on public.catalog_image_imports;
create policy catalog_image_imports_update on public.catalog_image_imports
  for update
  using (created_by = auth.uid() or public.is_manager_or_admin())
  with check (created_by = auth.uid() or public.is_manager_or_admin());

-- ---------------------------------------------------------------------------
-- catalog_image_import_items — visibilidade segue a importação-pai.
-- ---------------------------------------------------------------------------
drop policy if exists catalog_image_import_items_select on public.catalog_image_import_items;
create policy catalog_image_import_items_select on public.catalog_image_import_items
  for select using (
    exists (
      select 1 from public.catalog_image_imports i
      where i.id = catalog_image_import_items.import_id
        and (i.created_by = auth.uid() or public.is_manager_or_admin())
    )
  );

drop policy if exists catalog_image_import_items_insert on public.catalog_image_import_items;
create policy catalog_image_import_items_insert on public.catalog_image_import_items
  for insert with check (
    public.is_manager_or_admin()
    and exists (select 1 from public.catalog_image_imports i where i.id = catalog_image_import_items.import_id)
  );

drop policy if exists catalog_image_import_items_update on public.catalog_image_import_items;
create policy catalog_image_import_items_update on public.catalog_image_import_items
  for update using (public.is_manager_or_admin()) with check (public.is_manager_or_admin());

-- ---------------------------------------------------------------------------
-- Bucket privado + políticas de Storage.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', false)
on conflict (id) do nothing;

drop policy if exists product_images_storage_select on storage.objects;
create policy product_images_storage_select on storage.objects
  for select using (bucket_id = 'product-images' and public.is_active_user());

drop policy if exists product_images_storage_insert on storage.objects;
create policy product_images_storage_insert on storage.objects
  for insert with check (bucket_id = 'product-images' and public.is_manager_or_admin());

drop policy if exists product_images_storage_update on storage.objects;
create policy product_images_storage_update on storage.objects
  for update using (bucket_id = 'product-images' and public.is_manager_or_admin());

drop policy if exists product_images_storage_delete on storage.objects;
create policy product_images_storage_delete on storage.objects
  for delete using (bucket_id = 'product-images' and public.is_manager_or_admin());
