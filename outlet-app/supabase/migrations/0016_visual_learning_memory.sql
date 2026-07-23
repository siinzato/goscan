-- 0016_visual_learning_memory.sql
--
-- MODO SCAN — memória visual persistente: quando um operador confirma ou
-- corrige o resultado de um scan, a captura vira uma referência visual
-- validada que passa a participar de reconhecimentos futuros — sem depender
-- de estado local/sessão/cache, sobrevivendo a logout, F5 e novo deploy.
--
-- Toda escrita nesta tabela acontece pelo backend (service_role), nunca
-- diretamente pelo cliente — o backend é quem faz a checagem de qualidade,
-- deduplicação e cópia dos dados oficiais do produto (categoria/família/
-- capacidade/cor nunca são texto livre digitado por ninguém: são sempre
-- copiados de products/product_variants no momento do registro).

create table if not exists public.visual_learning_samples (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,

  -- Snapshot dos dados oficiais do produto NO MOMENTO do registro (nunca
  -- texto livre) — garante que um aprendizado nunca possa "ensinar" que uma
  -- garrafa é um copo: a categoria vem sempre do cadastro oficial do produto
  -- indicado pelo operador, nunca de uma suposição da IA. sku_code/
  -- product_name também são desnormalizados aqui (não via join em tempo de
  -- busca) de propósito: a tabela tem FK direta pra products (product_id) E
  -- indireta via product_variants (variant_id) — ambíguo pro PostgREST
  -- resolver sozinho, e o valor não muda depois do registro mesmo assim.
  category text,
  family text,
  capacity_ml integer,
  color text,
  lid_type text,
  sku_code text not null,
  product_name text not null,

  storage_path text not null,
  embedding jsonb,
  embedding_vector vector(512),
  model_name text not null,
  model_version text not null,
  dimension integer not null,

  source_type text not null check (source_type in ('official_catalog', 'confirmed_scan', 'corrected_scan', 'admin_upload')),

  -- O que a IA sugeriu antes da confirmação/correção, pra auditoria — nunca
  -- usado como verdade, só como contexto de quando esta referência nasceu.
  original_prediction_id uuid,
  original_confidence real,
  recognition_status text,

  corrected_by uuid references public.profiles (id),
  corrected_at timestamptz,

  -- Ciclo de vida do aprendizado. "validated" participa das buscas de
  -- reconhecimento; os outros três nunca participam.
  validation_status text not null default 'pending' check (validation_status in ('pending', 'validated', 'rejected', 'disabled')),
  quality_score real,
  confirmation_count integer not null default 1,
  rejection_count integer not null default 0,
  active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.visual_learning_samples is 'Memória visual operacional: capturas reais de câmera confirmadas/corrigidas por um operador, usadas como referências COMPLEMENTARES às fotos oficiais do catálogo no reconhecimento visual. Nunca escrita diretamente pelo cliente.';
comment on column public.visual_learning_samples.category is 'Copiado de products.category no momento do registro — nunca inventado, nunca alterável por um scan.';
comment on column public.visual_learning_samples.validation_status is 'pending/rejected/disabled nunca participam da busca de reconhecimento — só validated.';

create index if not exists visual_learning_samples_variant_idx on public.visual_learning_samples (variant_id);
create index if not exists visual_learning_samples_product_idx on public.visual_learning_samples (product_id);
create index if not exists visual_learning_samples_active_validated_idx
  on public.visual_learning_samples (validation_status, active)
  where validation_status = 'validated' and active = true;

create index if not exists visual_learning_samples_embedding_vector_idx
  on public.visual_learning_samples using ivfflat (embedding_vector vector_cosine_ops)
  with (lists = 50);

drop trigger if exists set_updated_at on public.visual_learning_samples;
create trigger set_updated_at before update on public.visual_learning_samples
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: leitura (para a tela administrativa de revisão) restrita a
-- manager/admin. NENHUMA policy de insert/update/delete pra usuários
-- autenticados — só o backend (service_role, que ignora RLS) pode escrever,
-- garantindo que qualidade/deduplicação/cópia de dados oficiais sempre
-- passem pelo backend antes de qualquer gravação.
-- ---------------------------------------------------------------------------
alter table public.visual_learning_samples enable row level security;

drop policy if exists visual_learning_samples_select on public.visual_learning_samples;
create policy visual_learning_samples_select on public.visual_learning_samples
  for select using (public.is_manager_or_admin());

-- Update permitido a manager/admin (tela de revisão: aprovar/rejeitar/
-- desativar/reassociar) — nunca insert/delete diretos pelo cliente, sempre
-- pelo backend, que faz a checagem de qualidade/deduplicação.
drop policy if exists visual_learning_samples_update on public.visual_learning_samples;
create policy visual_learning_samples_update on public.visual_learning_samples
  for update using (public.is_manager_or_admin()) with check (public.is_manager_or_admin());

-- ---------------------------------------------------------------------------
-- Bucket privado dedicado — separado de "product-images" (fotos oficiais)
-- pra nunca misturar ciclo de vida/curadoria dos dois conjuntos.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('scan-learning-samples', 'scan-learning-samples', false)
on conflict (id) do nothing;

drop policy if exists scan_learning_samples_storage_select on storage.objects;
create policy scan_learning_samples_storage_select on storage.objects
  for select using (bucket_id = 'scan-learning-samples' and public.is_manager_or_admin());

-- ---------------------------------------------------------------------------
-- Busca por similaridade nas referências aprendidas — mesmo padrão de
-- match_image_embeddings (0012/0014), já usando "<=>" (distância de cosseno)
-- desde o início.
-- ---------------------------------------------------------------------------
create or replace function public.match_visual_learning_samples(
  query_embedding vector(512),
  match_model text,
  match_model_version text,
  match_count int default 10
)
returns table (
  sample_id uuid,
  distance float
)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.embedding_vector <=> query_embedding as distance
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
