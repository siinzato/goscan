-- 0010_visual_family_classification.sql
--
-- MODO SCAN — Parte 2: classificação visual (família / variante / capacidade).
-- Aditiva e segura: só adiciona colunas e faz UPDATE de classificação nos
-- produtos reais já existentes que batem com os prefixos de SKU conhecidos
-- (Copo Life e Garrafa Fresh). Nenhuma linha é criada, nenhum produto ou
-- imagem é apagado. Produtos fora dessas duas famílias ficam com estes
-- campos NULL (não classificados) — a tela administrativa da Parte 2 permite
-- revisar/completar isso manualmente, sem inventar famílias aqui.

alter table public.products
  add column if not exists visual_family_key text,
  add column if not exists capacity_ml integer,
  add column if not exists recognition_group text;

comment on column public.products.visual_family_key is 'Agrupamento visual (ex.: "copo-life", "garrafa-fresh") — produtos com o mesmo design visual, variando principalmente a capacidade.';
comment on column public.products.capacity_ml is 'Capacidade em mililitros, quando aplicável (deriva do modelo real do produto, nunca inventada).';
comment on column public.products.recognition_group is 'Grupo que o Modo Scan deve considerar "visualmente confundível" ao decidir entre candidatos (hoje igual a visual_family_key; existe separado para permitir subdivisões futuras sem migração de schema).';

alter table public.product_variants
  add column if not exists variant_key text;

comment on column public.product_variants.variant_key is 'Chave normalizada de cor/estampa que deve ser igual entre capacidades da mesma família (ex.: "pink" em OUT-TCGCM40-38 e OUT-TCGCM42-38).';

create index if not exists products_visual_family_key_idx on public.products (visual_family_key) where visual_family_key is not null;
create index if not exists products_recognition_group_idx on public.products (recognition_group) where recognition_group is not null;
create index if not exists product_variants_variant_key_idx on public.product_variants (variant_key) where variant_key is not null;

-- ---------------------------------------------------------------------------
-- Classificação real, a partir do model_code existente (nunca texto inventado)
-- ---------------------------------------------------------------------------

-- Família "copo-life": prefixo TCGCM40 = 1180ml, TCGCM42 = 880ml.
-- O padrão 'TCGCM40%'/'TCGCM42%' cobre o produto base (cor real, ex. "TCGCM40")
-- e as variações de estampa/time (ex. "TCGCM40-FLAMENGO", "TCGCM40-NOME"),
-- verificado contra o catálogo real antes desta migration.
update public.products
set visual_family_key = 'copo-life', capacity_ml = 1180, recognition_group = 'copo-life'
where model_code like 'TCGCM40%';

update public.products
set visual_family_key = 'copo-life', capacity_ml = 880, recognition_group = 'copo-life'
where model_code like 'TCGCM42%';

-- Família "garrafa-fresh": prefixo GFGCM13(OUT) = 650ml, GFGCM14(OUT) = 950ml.
update public.products
set visual_family_key = 'garrafa-fresh', capacity_ml = 650, recognition_group = 'garrafa-fresh'
where model_code like 'GFGCM13%';

update public.products
set visual_family_key = 'garrafa-fresh', capacity_ml = 950, recognition_group = 'garrafa-fresh'
where model_code like 'GFGCM14%';

-- variant_key: quando a variante tem cor real (normalized_color preenchido),
-- usa a própria cor; quando não tem (produtos de time/estampa com uma única
-- variante e color nulo, ex. "TCGCM40-FLAMENGO"), deriva do sufixo do
-- model_code do produto (ex. "flamengo") — sempre a partir de dado que já
-- existe no catálogo, nunca um valor novo inventado.
update public.product_variants pv
set variant_key = case
  when pv.normalized_color is not null and pv.normalized_color <> ''
    then replace(pv.normalized_color, ' ', '-')
  else nullif(lower(split_part(p.model_code, '-', 2)), '')
end
from public.products p
where pv.product_id = p.id
  and p.visual_family_key is not null
  and pv.variant_key is null;
