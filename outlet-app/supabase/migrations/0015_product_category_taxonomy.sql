-- 0015_product_category_taxonomy.sql
--
-- MODO SCAN — correção do falso positivo garrafa→copo (Garrafa Fresh 650ml
-- sendo sugerida como Copo Vibe 470ml). Causa raiz comprovada com dados reais:
-- o pipeline de reconhecimento nunca teve um conceito de CATEGORIA (garrafa
-- vs copo vs mochila etc.) — só existia visual_family_key, uma família
-- específica por design. Sem categoria, nada impedia um candidato de
-- categoria totalmente diferente (mas visualmente parecido em cor/fundo) de
-- vencer o ranking. Esta migration só POPULA a coluna `category`, que já
-- existe desde 0001_init_schema.sql mas nunca foi usada por nenhum código.
--
-- Toda classificação aqui usa evidência real já presente no catálogo
-- (mesmo padrão da 0010: prefixo de model_code + capacidade que já está no
-- nome do produto) — nenhuma família/categoria é inventada.

comment on column public.products.category is 'Categoria funcional do produto (ex.: "garrafa", "copo", "mochila") — usada pelo Modo Scan para bloquear sugestões de categoria incompatível (uma garrafa nunca pode ser sugerida como copo). Complementar a visual_family_key: categoria é o nível acima (grosseiro), family é o design específico dentro da categoria.';

-- ---------------------------------------------------------------------------
-- Categorias das famílias já classificadas na 0010 (garrafa-fresh, copo-life)
-- ---------------------------------------------------------------------------
update public.products set category = 'garrafa' where visual_family_key = 'garrafa-fresh' and category is null;
update public.products set category = 'copo' where visual_family_key = 'copo-life' and category is null;

-- ---------------------------------------------------------------------------
-- Família "copo-vibe" (Copo Térmico Vibe 470ml): a 0010 nunca classificou essa
-- família (só veio a existir depois, via edição manual da tela de Catálogo
-- Visual em um produto isolado — "B-TCGCM25OUT"). Auditoria real encontrou
-- MUITAS variantes de estampa/time com o mesmo model_code base (TCGCM25%)
-- sem nenhuma classificação — mesmo padrão de "produto base + estampas" já
-- usado pela garrafa-fresh/copo-life na 0010. Cobre tanto o prefixo com "B-"
-- quanto sem, pois ambos representam o mesmo modelo físico (470ml, mesmo
-- corpo/tampa), confirmado pelo nome existente de cada produto.
update public.products
set visual_family_key = 'copo-vibe', capacity_ml = 470, recognition_group = 'copo-vibe', category = 'copo'
where (model_code like 'TCGCM25%' or model_code like 'B-TCGCM25%')
  and visual_family_key is null;

update public.products set category = 'copo' where visual_family_key = 'copo-vibe' and category is null;

-- ---------------------------------------------------------------------------
-- Família "copo-daily" (Copo Térmico Daily 600ml, model_code TCGCM70%): nunca
-- classificada. Capacidade (600ml) já está no nome real de cada produto, não
-- inventada.
-- ---------------------------------------------------------------------------
update public.products
set visual_family_key = 'copo-daily', capacity_ml = 600, recognition_group = 'copo-daily', category = 'copo'
where model_code like 'TCGCM70%' and visual_family_key is null;

-- variant_key para copo-vibe/copo-daily: mesmo critério da 0010 (cor real
-- quando existe; senão deriva do sufixo do model_code do produto).
update public.product_variants pv
set variant_key = case
  when pv.normalized_color is not null and pv.normalized_color <> ''
    then replace(pv.normalized_color, ' ', '-')
  else nullif(lower(split_part(p.model_code, '-', 2)), '')
end
from public.products p
where pv.product_id = p.id
  and p.visual_family_key in ('copo-vibe', 'copo-daily')
  and pv.variant_key is null;

create index if not exists products_category_idx on public.products (category) where category is not null;
