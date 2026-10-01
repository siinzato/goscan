-- 0064_loading_order_conference.sql
--
-- EXPANSÃO GOSCAN — Conferência por Ordem de Carregamento (Outlet). Mesmo
-- princípio da Conferência por NF-e (0023 em diante) — vínculo automático
-- quando possível, pendência manual quando não — só que a fonte é uma
-- planilha de carregamento (Produto/Descrição/Quantidade) em vez do XML da
-- NF-e, e o vínculo usa o motor de texto do Outlet (matching.ts) em vez do
-- motor por SKU/EAN da NF-e (nfeMatching.ts) — a maioria dos produtos de um
-- carregamento ainda não existe no catálogo.
--
-- Só ADITIVO — nenhuma tabela/coluna/RPC existente muda de sentido. Tudo que
-- já funciona hoje na Conferência por NF-e (bipagem atômica, finalização,
-- colaboração em tempo real) continua rodando exatamente igual pras NFs já
-- existentes, que sempre carregam source_type='nfe' (valor default).

alter table public.invoice_receipts
  add column if not exists source_type text not null default 'nfe' check (source_type in ('nfe', 'carregamento'));

comment on column public.invoice_receipts.source_type is '''nfe'' = XML de Nota Fiscal (fluxo original); ''carregamento'' = planilha de Ordem de Carregamento do Outlet (ver loadingOrderApi.ts). Mesma estrutura de contagem/finalização pros dois.';

-- Carregamento não tem XML nenhum — relaxa a constraint sem afetar as NFs já
-- importadas (todas continuam com xml preenchido).
alter table public.invoice_receipts
  alter column xml drop not null;

-- Vínculo automático de um item de Carregamento por texto (Produto/Descrição
-- contra o catálogo) é uma origem diferente das 4 já existentes da NF-e —
-- nunca reaproveita 'alias'/'sku'/'ean' pra não confundir auditoria futura.
alter table public.invoice_receipt_items
  drop constraint if exists invoice_receipt_items_link_source_check;
alter table public.invoice_receipt_items
  add constraint invoice_receipt_items_link_source_check
  check (link_source in ('sku', 'ean', 'alias', 'manual', 'text_match'));

comment on column public.invoice_receipt_items.link_source is 'sku/ean/alias = NF-e (ver nfeMatching.ts); manual = vínculo manual do operador (NF-e ou Carregamento); text_match = vínculo automático por nome/cor na Conferência por Carregamento (ver matching.ts).';
