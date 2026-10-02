-- Rollback manual de 0065_products_rls_initplan.sql (NÃO é aplicado automaticamente).
-- Restaura exatamente as expressões originais das quatro policies.

alter policy products_select on public.products
  using (public.is_active_user());

alter policy products_write on public.products
  using (public.is_manager_or_admin())
  with check (public.is_manager_or_admin());

alter policy product_variants_select on public.product_variants
  using (public.is_active_user());

alter policy product_variants_write on public.product_variants
  using (public.is_manager_or_admin())
  with check (public.is_manager_or_admin());
