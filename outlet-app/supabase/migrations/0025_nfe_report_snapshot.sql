-- 0025_nfe_report_snapshot.sql
--
-- EXPANSÃO GOSCAN — Encerramento da Conferência por NF: relatório final
-- permanente e auditável.
--
-- 1) invoice_receipts.series/started_at: campos reais da NF-e/da operação
--    que ainda não eram guardados (série já vem no XML; started_at marca o
--    momento real em que a contagem física começou, não só quando a NF foi
--    importada).
--
-- 2) invoice_receipt_items ganha um SNAPSHOT imutável do produto vinculado
--    (nome/SKU/EAN), gravado SÓ no momento da finalização. Sem isso, o
--    relatório de uma conferência de mês passado mudaria sozinho se alguém
--    editasse o cadastro do produto hoje — o relatório precisa continuar
--    sendo um documento histórico fiel ao que existia quando a conferência
--    foi encerrada, mesmo que o cadastro mude depois.
alter table public.invoice_receipts
  add column if not exists series text,
  add column if not exists started_at timestamptz;

comment on column public.invoice_receipts.started_at is 'Momento em que a contagem física começou de fato (1ª transição not_started -> in_progress) — usado no cabeçalho do relatório final.';

alter table public.invoice_receipt_items
  add column if not exists linked_sku_code text,
  add column if not exists linked_product_name text,
  add column if not exists linked_ean text;

comment on column public.invoice_receipt_items.linked_sku_code is 'Snapshot do SKU do produto vinculado NO MOMENTO da finalização — nunca recalculado depois, mesmo que o cadastro mude. Nulo enquanto a conferência não foi finalizada.';
comment on column public.invoice_receipt_items.linked_product_name is 'Snapshot do nome do produto vinculado no momento da finalização — mesma regra de imutabilidade do linked_sku_code.';
comment on column public.invoice_receipt_items.linked_ean is 'Snapshot do EAN (gtin) do produto vinculado no momento da finalização — mesma regra de imutabilidade.';
