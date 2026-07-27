-- 0024_fix_invoice_sku_aliases_upsert.sql
--
-- Corrige um bug real encontrado ao testar de verdade a "Memorizar
-- associação" da Conferência por NF: os índices únicos de
-- invoice_sku_aliases eram PARCIAIS (`where ... is not null`), e o Postgres
-- recusa `ON CONFLICT (invoice_product_code)` / `ON CONFLICT (ean)` contra um
-- índice parcial — erro 42P10 "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification". Isso fazia o upsert de
-- memorizeAlias() sempre falhar, e como ele roda DEPOIS de já ter vinculado
-- o produto (invoice_receipt_items.product_variant_id), o vínculo em si
-- funcionava mas o operador via "Erro ao vincular" mesmo assim.
--
-- Este é exatamente o mesmo bug (e a mesma correção) já feita uma vez nesta
-- base em 0009_fix_products_model_code_upsert.sql: um índice único comum já
-- trata múltiplos NULLs como não-conflitantes, então "único só quando
-- preenchido" nunca precisou do WHERE — e sem o WHERE o índice serve como
-- arbiter de ON CONFLICT.
drop index if exists public.invoice_sku_aliases_code_key;
create unique index if not exists invoice_sku_aliases_code_key on public.invoice_sku_aliases (invoice_product_code);

drop index if exists public.invoice_sku_aliases_ean_key;
create unique index if not exists invoice_sku_aliases_ean_key on public.invoice_sku_aliases (ean);
