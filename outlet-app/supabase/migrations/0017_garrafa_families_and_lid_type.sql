-- 0017_garrafa_families_and_lid_type.sql
--
-- MODO SCAN — refatoração hierárquica (categoria → FAMÍLIA → SKU/cor).
-- Auditoria real encontrou 5 famílias de garrafa que existem no catálogo mas
-- nunca foram classificadas (visual_family_key/category NULL): Flip Pro,
-- Urban, Mini (com e sem canudo), Magsafe, Fun. Sem categoria/família, o
-- gate de categoria não tem como proteger essas famílias — ficam sempre
-- "unknown", nunca bloqueadas nem beneficiadas pelo estágio de família novo.
--
-- Mesmo padrão de evidência da 0010/0015: prefixo real de model_code +
-- capacidade que já está no nome do produto. Nenhuma família/capacidade
-- inventada. Cuidado real verificado: BTGCM84 ("Bolsa Térmica Lancheira
-- Urban") e BTGCM68 ("Bolsa Térmica Fun") compartilham o nome de marketing
-- ("Urban"/"Fun") mas são bolsas/lancheiras, não garrafas — por isso o
-- filtro usa o PREFIXO EXATO do model_code da garrafa (GFGCM21%/GFGCM91%),
-- nunca busca por nome, evitando classificar essas bolsas como garrafa.

alter table public.products add column if not exists lid_type text;
comment on column public.products.lid_type is 'Variante estrutural real da tampa quando existe mais de uma versão física do mesmo modelo/capacidade (ex.: Mini 350ml com canudo vs sem canudo) — preenchido a partir de evidência real do nome do produto, nunca inventado.';

-- Garrafa Flip Pro 750ml
update public.products
set visual_family_key = 'garrafa-flip-pro', capacity_ml = 750, recognition_group = 'garrafa-flip-pro', category = 'garrafa'
where model_code like 'GFGCM73%' and visual_family_key is null;

-- Garrafa Urban 500ml (GFGCM21 é a garrafa; BTGCM84 é bolsa/lancheira — nunca tocada aqui)
update public.products
set visual_family_key = 'garrafa-urban', capacity_ml = 500, recognition_group = 'garrafa-urban', category = 'garrafa'
where model_code like 'GFGCM21%' and visual_family_key is null;

-- Garrafa Mini 350ml — duas variantes estruturais reais: GFGCM24 (com canudo,
-- padrão) e GFGCM85 (nome do produto diz explicitamente "Sem Canudo").
update public.products
set visual_family_key = 'garrafa-mini', capacity_ml = 350, recognition_group = 'garrafa-mini', category = 'garrafa', lid_type = 'com_canudo'
where model_code like 'GFGCM24%' and visual_family_key is null;

update public.products
set visual_family_key = 'garrafa-mini', capacity_ml = 350, recognition_group = 'garrafa-mini', category = 'garrafa', lid_type = 'sem_canudo'
where model_code like 'GFGCM85%' and visual_family_key is null;

-- Garrafa Magsafe 750ml
update public.products
set visual_family_key = 'garrafa-magsafe', capacity_ml = 750, recognition_group = 'garrafa-magsafe', category = 'garrafa'
where model_code like 'GFGCM87%' and visual_family_key is null;

-- Garrafa Fun 460ml (GFGCM91 é a garrafa; BTGCM68 é bolsa/lancheira — nunca tocada aqui)
update public.products
set visual_family_key = 'garrafa-fun', capacity_ml = 460, recognition_group = 'garrafa-fun', category = 'garrafa'
where model_code like 'GFGCM91%' and visual_family_key is null;

-- variant_key: mesmo critério das migrations anteriores (cor real quando
-- existe; senão deriva do sufixo do model_code).
update public.product_variants pv
set variant_key = case
  when pv.normalized_color is not null and pv.normalized_color <> ''
    then replace(pv.normalized_color, ' ', '-')
  else nullif(lower(split_part(p.model_code, '-', 2)), '')
end
from public.products p
where pv.product_id = p.id
  and p.visual_family_key in ('garrafa-flip-pro', 'garrafa-urban', 'garrafa-mini', 'garrafa-magsafe', 'garrafa-fun')
  and pv.variant_key is null;
