-- 0020_scan_perf_and_recognition_log.sql
--
-- MODO SCAN — otimização de velocidade sem alterar a lógica de decisão do
-- reconhecimento, + histórico real de reconhecimentos para medir tempo médio
-- e (futuramente) taxa de acerto por produto.
--
-- PARTE 1 — consolida as duas buscas vetoriais (fotos oficiais + memória
-- visual) para trazer TODAS as colunas necessárias numa única chamada, em vez
-- de exigir uma segunda consulta em JS só para buscar storage_path/sku/nome
-- etc. As condições de filtro são EXATAMENTE as mesmas já aplicadas hoje (em
-- SQL na função + em JS na segunda consulta) — nenhum filtro foi removido ou
-- afrouxado, só deixou de ser feito em dois passos.
--
-- Postgres não permite trocar o tipo de retorno de uma função existente com
-- CREATE OR REPLACE (erro 42P13) — precisa derrubar a função antiga primeiro.
drop function if exists public.match_image_embeddings(vector, text, text, int);
drop function if exists public.match_visual_learning_samples(vector, text, text, int);

create or replace function public.match_image_embeddings(
  query_embedding vector(512),
  match_model text,
  match_model_version text,
  match_count int default 5
)
returns table (
  product_image_id uuid,
  distance float,
  product_id uuid,
  variant_id uuid,
  storage_path text,
  sku_code text,
  product_name text,
  category text,
  visual_family_key text,
  variant_key text,
  capacity_ml integer
)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select
    ie.product_image_id,
    ie.embedding_vector <=> query_embedding as distance,
    p.id as product_id,
    pv.id as variant_id,
    pi.storage_path,
    pv.sku_code,
    p.name as product_name,
    p.category,
    p.visual_family_key,
    pv.variant_key,
    p.capacity_ml
  from public.image_embeddings ie
  join public.product_images pi on pi.id = ie.product_image_id
    and pi.is_active
    and pi.archived_at is null
    -- Estas duas condições existiam ANTES só na segunda consulta em
    -- visualEmbeddings.ts (findSimilarImages) — trazidas pra cá com o MESMO
    -- efeito: uma imagem pendente/rejeitada ou com reconhecimento desligado
    -- nunca deve aparecer, exatamente como já era garantido antes.
    and pi.quality_status = 'aprovada'
    and pi.recognition_enabled = true
  join public.product_variants pv on pv.id = pi.product_variant_id and pv.active
  join public.products p on p.id = pv.product_id and p.active
  where ie.status = 'ready'
    and ie.model_name = match_model
    and ie.model_version = match_model_version
    and ie.embedding_vector is not null
  order by ie.embedding_vector <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_image_embeddings(vector, text, text, int) to authenticated;

-- Mesma consolidação para a memória visual — os filtros (validation_status,
-- active) já eram idênticos nos dois passos; só deixa de precisar da segunda
-- consulta.
create or replace function public.match_visual_learning_samples(
  query_embedding vector(512),
  match_model text,
  match_model_version text,
  match_count int default 10
)
returns table (
  sample_id uuid,
  distance float,
  product_id uuid,
  variant_id uuid,
  storage_path text,
  sku_code text,
  product_name text,
  category text,
  family text,
  capacity_ml integer,
  color text
)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.id as sample_id,
    s.embedding_vector <=> query_embedding as distance,
    s.product_id,
    s.variant_id,
    s.storage_path,
    s.sku_code,
    s.product_name,
    s.category,
    s.family,
    s.capacity_ml,
    s.color
  from public.visual_learning_samples s
  where s.validation_status = 'validated'
    and s.active = true
    and s.model_name = match_model
    and s.model_version = match_model_version
    and s.embedding_vector is not null
  order by s.embedding_vector <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_visual_learning_samples(vector, text, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- PARTE 2 — histórico real de reconhecimentos: cada chamada a recognizeFrame
-- grava uma linha (fire-and-forget, nunca bloqueia/derruba a resposta ao
-- operador). Serve pra dois propósitos:
--  1) medir tempo real por etapa (embedding/busca vetorial/total) ao longo do
--     tempo, não só num teste isolado;
--  2) base para a "Qualidade de Reconhecimento" por produto (tempo médio real
--     e, cruzando com visual_learning_samples via recognition_id, taxa de
--     acerto real quando o operador confirma/corrige).
create table if not exists public.scan_recognition_log (
  id uuid primary key default gen_random_uuid(),
  recognition_id uuid not null,
  variant_id uuid references public.product_variants (id),
  status text not null,
  confidence_level text not null,
  top_score real,
  used_pgvector boolean not null,
  embedding_ms integer not null,
  vector_search_ms integer not null,
  post_process_ms integer not null,
  sibling_expand_ms integer not null,
  total_ms integer not null,
  created_at timestamptz not null default now()
);

comment on table public.scan_recognition_log is 'Uma linha por chamada real a recognizeFrame — tempo por etapa + candidato vencedor. Nunca guarda a imagem/vetor. Usado para medir performance ao longo do tempo e alimentar a Qualidade de Reconhecimento (tempo médio, e taxa de acerto ao cruzar com visual_learning_samples.original_prediction_id).';

create index if not exists scan_recognition_log_variant_idx on public.scan_recognition_log (variant_id, created_at desc);
create index if not exists scan_recognition_log_recognition_id_idx on public.scan_recognition_log (recognition_id);
create index if not exists scan_recognition_log_created_at_idx on public.scan_recognition_log (created_at desc);

alter table public.scan_recognition_log enable row level security;

-- Só leitura para manager/admin (painel de qualidade) — só o backend
-- (service_role) grava.
drop policy if exists scan_recognition_log_select on public.scan_recognition_log;
create policy scan_recognition_log_select on public.scan_recognition_log
  for select using (public.is_manager_or_admin());
