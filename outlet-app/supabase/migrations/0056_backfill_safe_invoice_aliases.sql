-- FASE 3 — aprendizado operacional por vínculos manuais: backfill de aliases
-- que já deveriam existir a partir de decisões manuais históricas.
--
-- Causa raiz confirmada com dados reais (Etapa 0/2): 291 dos 324 itens
-- resolvidos manualmente aconteceram ANTES do vínculo manual passar a
-- memorizar automaticamente (correção "sempre memoriza", 2026-09-12) — a
-- maioria já foi corrigida sozinha desde então (245 dos 272 códigos únicos
-- já têm o alias correto hoje). Este backfill cobre só o resíduo real:
-- 19 códigos com decisão manual histórica, 100% consistente (nunca duas
-- variantes diferentes pro mesmo código), sem alias hoje, cuja variante
-- continua active=true e product_type='normal'.
--
-- SEGURANÇA (todas as regras abaixo já foram verificadas nos dados antes de
-- gerar esta lista — nunca confie apenas nesta migration pra revalidar):
--   1. link_source = 'manual' na origem;
--   2. product_variant_id existe;
--   3/4. variante active=true e product_type='normal' no momento da checagem;
--   6. TODAS as decisões manuais históricas pra aquele código apontam pra
--      EXATAMENTE a mesma variante (7 códigos inconsistentes ficaram de
--      fora, nunca aprendidos automaticamente);
--   7. nenhuma colisão perigosa entre fornecedores diferentes foi
--      encontrada em todo o histórico (0 casos);
--   8. nenhum destes 19 códigos já tem alias hoje (os que já tinham —
--      corretos OU conflitantes — foram excluídos desta lista; nenhum é
--      sobrescrito).
--
-- IDEMPOTENTE — ON CONFLICT (invoice_product_code) DO NOTHING: nunca
-- sobrescreve um alias existente (nem o cria de novo se already rodou antes).
-- NUNCA toca invoice_receipts/invoice_receipt_items — notas históricas
-- continuam exatamente como estão; isto só ensina o sistema pro futuro.
insert into public.invoice_sku_aliases (invoice_product_code, ean, product_variant_id, created_by)
values
  ('0095096', null, '7e3ffc61-cf46-4587-9f17-62ccc0fecedb', null),
  ('8800328810273', null, '3391bce3-4144-4c0e-b70e-0296ad78ff0e', null),
  ('6902048307407', null, 'f626bb53-0f7f-4131-ac73-ccf8ec76be00', null),
  ('6902048295971', null, '8d311073-9e6b-4292-b9dc-1eef8e5e59dc', null),
  ('6902048303669', null, '1fb6272f-2cab-43d0-bef4-b04bf91d21e3', null),
  ('6902048286719', null, '653d11f7-4fde-4a06-a0ea-3a6b3852d2fb', null),
  ('7898979019399', null, '3e74ab4a-46ad-40d1-bc6b-71ec4ef494d3', null),
  ('7898979019849', null, '4fb96ddf-95a5-482b-87c1-682e1c04ca0c', null),
  ('7898979019597', null, '36adcb37-d5c9-42f2-a32c-33caba03f09f', null),
  ('7898979019924', null, 'db86c54d-9019-4ac8-bf03-9af5edc23c38', null),
  ('0103142000003', null, '9c0555e4-7d25-49da-ac63-ed36d0135929', null),
  ('0086766000010', null, '59f44aa8-2815-49b8-af40-81d2535de35b', null),
  ('0084471000011', null, 'b3e3e78c-f37f-4fbf-a66f-039b15660503', null),
  ('0103529000002', null, 'bb6fdec1-82a0-45ca-87d6-00307ddec885', null),
  ('6902048289970', null, '523dff62-ea5c-4653-85f5-66dc1117622a', null),
  ('0108830000002', null, 'db1783d7-d00b-4aaf-bc2d-42ba37b0b123', null),
  ('0101152000003', null, '72a044a6-c41d-47f9-a6f8-c67b9c58ef3c', null),
  ('0108830000004', null, '687ec64e-4bf0-442e-bf5c-a6ee1e341e49', null),
  ('0087619000002', null, 'b5f7bf47-3cc1-4eaa-be3d-530449044105', null)
on conflict (invoice_product_code) do nothing;
