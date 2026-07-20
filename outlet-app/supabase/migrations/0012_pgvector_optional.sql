-- 0012_pgvector_optional.sql
--
-- MODO SCAN — Parte 2: melhoria OPCIONAL de performance/escala via pgvector.
--
-- IMPORTANTE: esta migration só funciona se a extensão "vector" estiver
-- disponível no seu projeto Supabase. Não foi possível confirmar isso pela
-- API (pg_extension é uma tabela de sistema, não exposta via PostgREST).
--
-- SE A LINHA "create extension" ABAIXO FALHAR: pare aqui e me avise. Não é
-- um requisito — o app já funciona sem ela, comparando embeddings em
-- JavaScript sobre a coluna "embedding" (jsonb) criada na migration 0006/0011.
-- Esta migration só acelera a busca por similaridade quando o catálogo de
-- imagens crescer muito (comparação em JS deixa de escalar bem acima de
-- alguns milhares de vetores).
create extension if not exists vector;

alter table public.image_embeddings
  add column if not exists embedding_vector vector(512);

comment on column public.image_embeddings.embedding_vector is 'Mesmo vetor da coluna embedding (jsonb), em formato pgvector para busca indexada por distância. Preenchido por um passo de sincronização separado, só depois de confirmar que esta extensão está disponível.';

-- lists baixo de propósito: o catálogo de imagens ainda é pequeno (poucas
-- dezenas/centenas de linhas) — o valor certo de "lists" para ivfflat escala
-- com o número de linhas e deve ser revisto quando o volume crescer.
create index if not exists image_embeddings_vector_idx
  on public.image_embeddings using ivfflat (embedding_vector vector_cosine_ops) with (lists = 10);

-- Busca por similaridade via SQL — usada pelo backend (service_role) quando
-- embedding_vector estiver disponível; nunca recebe o vetor de um usuário
-- não autenticado (só chamada a partir de rotas administrativas do backend).
create or replace function public.match_image_embeddings(
  query_embedding vector(512),
  match_model text,
  match_model_version text,
  match_count int default 5
)
returns table (
  product_image_id uuid,
  distance float
)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select ie.product_image_id, ie.embedding_vector <-> query_embedding as distance
  from public.image_embeddings ie
  join public.product_images pi on pi.id = ie.product_image_id and pi.is_active and pi.archived_at is null
  join public.product_variants pv on pv.id = pi.product_variant_id and pv.active
  join public.products p on p.id = pv.product_id and p.active
  where ie.status = 'ready'
    and ie.model_name = match_model
    and ie.model_version = match_model_version
    and ie.embedding_vector is not null
  order by ie.embedding_vector <-> query_embedding
  limit match_count;
$$;

grant execute on function public.match_image_embeddings(vector, text, text, int) to authenticated;
