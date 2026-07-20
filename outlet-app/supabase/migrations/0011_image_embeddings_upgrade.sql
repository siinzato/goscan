-- 0011_image_embeddings_upgrade.sql
--
-- MODO SCAN — Parte 2: completa a tabela image_embeddings (criada vazia e
-- desabilitada na migration 0006, Catálogo Visual) com os campos que faltam
-- para gerar embeddings reais: versão do modelo, dimensão do vetor, data de
-- processamento e hash da imagem processada (para dedup/reprocessamento).
--
-- Não altera dados: a tabela está vazia desde a 0006 (nenhuma linha jamais
-- inserida) — confirmado antes de rodar esta migration. O guard abaixo trava
-- a migration com erro (em vez de seguir silenciosamente) se isso mudou.
do $$
begin
  if exists (select 1 from public.image_embeddings limit 1) then
    raise exception 'image_embeddings já tem dados — esta migration assume tabela vazia e precisa ser revisada manualmente antes de rodar.';
  end if;
end $$;

alter table public.image_embeddings
  add column if not exists model_version text not null default 'v1',
  add column if not exists dimension integer,
  add column if not exists processed_at timestamptz,
  add column if not exists image_hash text;

comment on column public.image_embeddings.model_version is 'Versão do modelo usado para gerar este embedding — permite trocar de modelo sem apagar/confundir embeddings antigos (reprocessamento explícito, nunca silencioso).';
comment on column public.image_embeddings.dimension is 'Tamanho do vetor gerado (ex.: 512 para CLIP ViT-B/32) — guardado explicitamente para detectar incompatibilidade se o modelo mudar de dimensão.';
comment on column public.image_embeddings.image_hash is 'Cópia do hash da imagem no momento em que o embedding foi gerado (ver product_images.image_hash) — usado para pular reprocessamento quando nada mudou.';

-- Un embedding por (imagem, modelo, versão) — versões diferentes do mesmo
-- modelo coexistem em vez de se sobrescreverem.
drop index if exists public.image_embeddings_image_model_unique;
create unique index if not exists image_embeddings_image_model_version_unique
  on public.image_embeddings (product_image_id, model_name, model_version);

create index if not exists image_embeddings_image_hash_idx on public.image_embeddings (image_hash) where image_hash is not null;
