-- CORREÇÃO — validação real contra produção encontrou divergência de
-- semântica entre search_sku_picker (0054) e o searchCatalog antigo:
-- buscar "preto" com product_type=outlet trazia 3 resultados na RPC contra
-- só 1 no caminho antigo. Causa raiz confirmada com dados reais (não
-- suposição): existem 1542 produtos com "PRETO" no normalized_name — o
-- client antigo busca esse critério com `.limit(200)` (sem order()
-- explícito, ver catalogApi.ts), então descarta a maioria desses 1542 de
-- forma efetivamente arbitrária ANTES de unir com os outros critérios; a
-- RPC 0054 não tinha limite equivalente no CTE matched_products, então
-- encontrava produtos (como GFGCM14OUT-1/TCGCM25OUT-1) que o caminho antigo
-- descartava por puro acaso da ordem de retorno do Postgres.
--
-- Esta fase é SÓ otimização de performance — a RPC precisa reproduzir a
-- MESMA semântica do client antigo, não uma busca "melhor". Corrige
-- separando os 4 critérios auxiliares em CTEs independentes, cada um com
-- LIMIT 200 (idêntico ao `.limit(200)` de cada builder em searchCatalog),
-- unidos depois — exatamente a mesma orquestração que o client fazia em
-- 2 idas-e-voltas, só que agora dentro de uma única chamada. Nunca altera
-- prioridade de match (EAN exato > SKU exato > texto), nunca volta a fazer
-- round-trips extras no frontend.
create or replace function public.search_sku_picker(
  p_name_words text[],
  p_category_ilike text,
  p_family_ilike text,
  p_capacity_ml integer,
  p_sku_ilike text,
  p_gtin_exact text,
  p_gtin_prefix_ilike text,
  p_product_type text,
  p_upper_sku text,
  p_limit integer default 15
)
returns table (
  variant_id uuid,
  product_id uuid,
  sku_code text,
  color text,
  gtin text,
  gtin_normalized text,
  produto text,
  category text,
  visual_family_key text,
  capacity_ml integer,
  product_type text,
  match_type text
)
language sql
stable
as $$
  with by_name as (
    select p.id
    from public.products p
    where
      cardinality(coalesce(p_name_words, '{}'::text[])) > 0
      and (select bool_and(p.normalized_name ilike '%' || w || '%') from unnest(p_name_words) as w)
    limit 200
  ),
  by_category as (
    select p.id
    from public.products p
    where p_category_ilike is not null and p.category ilike p_category_ilike
    limit 200
  ),
  by_family as (
    select p.id
    from public.products p
    where p_family_ilike is not null and p.visual_family_key ilike p_family_ilike
    limit 200
  ),
  by_capacity as (
    select p.id
    from public.products p
    where p_capacity_ml is not null and p.capacity_ml = p_capacity_ml
    limit 200
  ),
  matched_products as (
    select id from by_name
    union
    select id from by_category
    union
    select id from by_family
    union
    select id from by_capacity
  )
  select
    v.id as variant_id,
    v.product_id,
    v.sku_code,
    v.color,
    v.gtin,
    v.gtin_normalized,
    p.name as produto,
    p.category,
    p.visual_family_key,
    p.capacity_ml,
    p.product_type,
    case
      when p_gtin_exact is not null and v.gtin_normalized = p_gtin_exact then 'exact_ean'
      when p_upper_sku is not null and upper(v.sku_code) = p_upper_sku then 'exact_sku'
      else 'text'
    end as match_type
  from public.product_variants v
  join public.products p on p.id = v.product_id
  where v.active = true
    and (p_product_type is null or p.product_type = p_product_type)
    and (
      v.sku_code ilike p_sku_ilike
      or v.product_id in (select id from matched_products)
      or (p_gtin_exact is not null and v.gtin_normalized = p_gtin_exact)
      or (p_gtin_prefix_ilike is not null and v.gtin_normalized ilike p_gtin_prefix_ilike)
    )
  order by
    case
      when p_gtin_exact is not null and v.gtin_normalized = p_gtin_exact then 0
      when p_upper_sku is not null and upper(v.sku_code) = p_upper_sku then 1
      else 2
    end,
    v.sku_code asc
  limit p_limit;
$$;

grant execute on function public.search_sku_picker(text[], text, text, integer, text, text, text, text, text, integer) to authenticated;
