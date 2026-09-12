-- PERFORMANCE — busca do picker de SKU (vínculo manual na conferência/NF-e/
-- devolução/treino visual) fazia 2 idas-e-voltas de rede em SEQUÊNCIA por
-- busca: 1) achar product_id por nome/categoria/família/capacidade, 2) só
-- então buscar as variantes. Numa conexão de depósito com latência maior,
-- isso pesa muito mais do que na rede rápida de desenvolvimento.
--
-- Esta função faz TUDO em uma única ida-e-volta. Ela NÃO reimplementa a
-- normalização de texto (normalize()/normalizeEan() já existem e são
-- testadas no client, em utils.ts) — recebe os valores JÁ NORMALIZADOS
-- (palavras do nome, padrões ilike, EAN normalizado) como parâmetros
-- prontos, calculados exatamente como antes; só a ORQUESTRAÇÃO das duas
-- consultas colapsa em uma. Mesma semântica de match de searchCatalog em
-- catalogApi.ts, mesmas colunas, mesma prioridade EAN exato > SKU exato >
-- texto. `security invoker` (padrão) — roda com o mesmo papel de quem
-- chama, respeita as RLS de products/product_variants como hoje.
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
  with matched_products as (
    select p.id
    from public.products p
    where
      (
        cardinality(coalesce(p_name_words, '{}'::text[])) > 0
        and (select bool_and(p.normalized_name ilike '%' || w || '%') from unnest(p_name_words) as w)
      )
      or (p_category_ilike is not null and p.category ilike p_category_ilike)
      or (p_family_ilike is not null and p.visual_family_key ilike p_family_ilike)
      or (p_capacity_ml is not null and p.capacity_ml = p_capacity_ml)
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
