-- 0009_fix_products_model_code_upsert.sql
--
-- Corrige um bug real encontrado ao testar a importação de verdade pela
-- primeira vez (Catálogo Visual, mas o mesmo upsert é usado pelo importador
-- de SKUs da Fase 1): o índice único de products.model_code era PARCIAL
-- (`where model_code is not null`), e o Postgres recusa `ON CONFLICT
-- (model_code)` contra um índice parcial — erro 42P10 "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification".
--
-- A condição parcial nunca foi necessária: um índice único comum no
-- Postgres já trata múltiplos valores NULL como não-conflitantes (NULL <>
-- NULL), então "unique apenas quando preenchido" já era o comportamento
-- padrão sem precisar do WHERE — e sem o WHERE o índice vira utilizável
-- como arbiter de ON CONFLICT.
drop index if exists public.products_model_code_key;
create unique index if not exists products_model_code_key on public.products (model_code);
