-- CORREÇÃO — 29 produtos com nome literal "Outlet ..." (ex.: "Outlet Garrafa
-- Térmica Gocase Leves Defeitos Fresh 950ml - Off White", sku_code
-- GFGCM14OUT-1) estão cadastrados com product_type='normal' em vez de
-- 'outlet'. Isso os exclui do picker de busca da conferência Outlet (que
-- filtra estritamente por products.product_type='outlet' — ver
-- src/client/catalogApi.ts), mesmo já existindo no catálogo, causando "SKU
-- não encontrado" pro operador tentando vincular um produto que já existe.
--
-- Escopo: só produtos cujo NOME começa literalmente com "Outlet " (case
-- insensitive) — nunca reclassifica por suposição de SKU sozinho, só onde o
-- próprio nome já declara inequivocamente que é outlet. Medido contra o
-- catálogo real antes de aplicar: 29 produtos batiam nesse filtro.
--
-- APLICADO EM PRODUÇÃO (fora desta migration, direto via service role, em
-- 2026-09-01) pra 26 desses 29 — 3 NÃO foram reclassificados aqui porque
-- colidem com `products_model_code_type_key` (já existe um produto outlet
-- com o MESMO model_code — são duplicatas reais de cadastro, não um erro de
-- classificação simples, e exigem decisão do usuário sobre qual registro
-- manter/mesclar antes de tocar):
--   - model_code 'GFGCMOUT'     (id 9f1680d9-8f2c-417f-9d9b-2cfa22a04fbe)
--   - model_code 'GFGCMOUTL5'   (id b77a4cf8-b567-47c2-a5cf-109aff03e257)
--   - model_code 'TBGCM55-OUT'  (id 4ffa1c20-7eb9-41a4-897c-8f960c3262a7)
-- Esta migration fica idempotente e seguirá excluindo essas 3 duplicatas
-- (WHERE ... NOT IN) até que sejam resolvidas manualmente e sua reclassificação
-- decidida à parte.
update products
set product_type = 'outlet'
where product_type = 'normal'
  and name ilike 'outlet %'
  and id not in (
    '9f1680d9-8f2c-417f-9d9b-2cfa22a04fbe',
    'b77a4cf8-b567-47c2-a5cf-109aff03e257',
    '4ffa1c20-7eb9-41a4-897c-8f960c3262a7'
  );
