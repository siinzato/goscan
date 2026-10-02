-- PERFORMANCE — RLS de products / product_variants avaliada UMA vez por consulta.
--
-- Causa raiz medida (EXPLAIN ANALYZE como `authenticated`, JWT de operador):
-- as policies chamavam is_active_user() / is_manager_or_admin() diretamente.
-- Como são funções SECURITY DEFINER (não inlinam) e cada uma consulta
-- `profiles`, o Postgres as reavaliava LINHA A LINHA (~1 ms por linha varrida):
--   count(*) em products ........... ~5,3 s (contra 20 ms sem RLS)
--   count(*) em product_variants ... ~6,9 s (contra 6 ms sem RLS)
--   picker (SKU / EAN / texto) ..... ~9-11 s (contra ~170 ms sem RLS)
--
-- Em SELECT, TAMBÉM a policy `*_write` (FOR ALL) é avaliada e combinada por OR
-- com a `*_select` — por isso is_manager_or_admin() entrava no filtro por linha
-- mesmo numa consulta de leitura. As quatro policies precisam do mesmo ajuste.
--
-- Correção: envolver a chamada em `(select ...)`. O Postgres trata isso como
-- InitPlan: avalia a função UMA vez por statement e reutiliza o resultado.
-- auth.uid() e a linha de `profiles` não mudam dentro de um statement, então a
-- semântica é IDÊNTICA — só deixa de repetir a mesma checagem para cada linha.
--
-- Segurança:
--   * ALTER POLICY (não DROP/CREATE): nunca existe instante sem policy.
--   * Nenhuma policy é removida, renomeada, nem tem role/comando alterado.
--   * RLS continua habilitada; nenhuma permissão funcional muda.
--   * A expressão lógica é a mesma (is_active_user() / is_manager_or_admin()).
--
-- Rollback: ver 0065_products_rls_initplan_rollback.sql.

alter policy products_select on public.products
  using ((select public.is_active_user()));

alter policy products_write on public.products
  using ((select public.is_manager_or_admin()))
  with check ((select public.is_manager_or_admin()));

alter policy product_variants_select on public.product_variants
  using ((select public.is_active_user()));

alter policy product_variants_write on public.product_variants
  using ((select public.is_manager_or_admin()))
  with check ((select public.is_manager_or_admin()));
