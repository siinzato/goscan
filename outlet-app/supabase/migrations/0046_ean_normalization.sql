-- CORREÇÃO — Reconhecimento automático e busca por EAN na Conferência por NF.
--
-- Diagnóstico (ver relatório): o EAN nunca era comparado de forma robusta a
-- espaços/pontos/traços em nenhuma das duas pontas que importam:
--   1. Vínculo automático na importação da NF-e (nfeApi.fetchNormalCandidates)
--      filtrava direto pela coluna CRUA `gtin` (.in("gtin", eans)) — sem
--      normalizar. Um produto cadastrado com o MESMO número de EAN, mas com
--      qualquer diferença de formatação em relação ao XML, nunca entrava nem
--      na lista de candidatos — a normalização que já existia (normalizeKey)
--      rodava tarde demais, depois do filtro do banco já ter descartado a linha.
--   2. Busca manual em "Resolver pendências" (catalogApi.searchCatalog) nunca
--      filtrava por `gtin` — só o selecionava para exibição.
--
-- Esta migration cria uma coluna normalizada (dígitos apenas), mantida por
-- TRIGGER — única fonte de verdade no banco, nunca duplicada em código de
-- aplicação — e os índices que tornam a comparação exata (e a busca textual
-- por nome/SKU) rápida. Aditiva: nunca apaga ou reescreve `gtin`/`ean`
-- originais, só popula a coluna nova.

alter table public.product_variants add column if not exists gtin_normalized text;
alter table public.invoice_sku_aliases add column if not exists ean_normalized text;

-- Função pura (mesma regra em todo lugar que precisar comparar EAN dentro do
-- banco) — equivalente exata de normalizeEan() no frontend (src/client/utils.ts).
create or replace function public.normalize_ean_digits(raw text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g'), '')
$$;

create or replace function public.set_product_variant_gtin_normalized()
returns trigger
language plpgsql
as $$
begin
  new.gtin_normalized := public.normalize_ean_digits(new.gtin);
  return new;
end;
$$;

drop trigger if exists trg_product_variant_gtin_normalized on public.product_variants;
create trigger trg_product_variant_gtin_normalized
  before insert or update of gtin on public.product_variants
  for each row execute function public.set_product_variant_gtin_normalized();

create or replace function public.set_invoice_sku_alias_ean_normalized()
returns trigger
language plpgsql
as $$
begin
  new.ean_normalized := public.normalize_ean_digits(new.ean);
  return new;
end;
$$;

drop trigger if exists trg_invoice_sku_alias_ean_normalized on public.invoice_sku_aliases;
create trigger trg_invoice_sku_alias_ean_normalized
  before insert or update of ean on public.invoice_sku_aliases
  for each row execute function public.set_invoice_sku_alias_ean_normalized();

-- Backfill retroativo — preserva os dados originais, só popula a coluna nova
-- pros produtos/aliases já cadastrados antes desta migration existir.
update public.product_variants set gtin_normalized = public.normalize_ean_digits(gtin) where gtin is not null;
update public.invoice_sku_aliases set ean_normalized = public.normalize_ean_digits(ean) where ean is not null;

create index if not exists product_variants_gtin_normalized_idx on public.product_variants (gtin_normalized) where gtin_normalized is not null;
create index if not exists invoice_sku_aliases_ean_normalized_idx on public.invoice_sku_aliases (ean_normalized) where ean_normalized is not null;

-- Aceleração da busca textual (ILIKE '%palavra%') — causa raiz confirmada da
-- lentidão relatada: sem pg_trgm, cada busca por nome/categoria/SKU força um
-- scan sequencial em products/product_variants (o índice B-tree existente em
-- normalized_name/sku_code só acelera igualdade/prefixo, nunca "contém").
create extension if not exists pg_trgm;

create index if not exists products_normalized_name_trgm_idx on public.products using gin (normalized_name gin_trgm_ops);
create index if not exists products_category_trgm_idx on public.products using gin (category gin_trgm_ops);
create index if not exists products_visual_family_key_trgm_idx on public.products using gin (visual_family_key gin_trgm_ops);
create index if not exists product_variants_sku_code_trgm_idx on public.product_variants using gin (sku_code gin_trgm_ops);
