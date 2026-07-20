-- 0006_image_embeddings_future.sql
--
-- ESTRUTURA FUTURA, DESATIVADA — parte do Modo Scan (câmera), NÃO desta fase.
--
-- Esta migration só cria a tabela que vai guardar o vetor de similaridade
-- visual por imagem, para que a próxima fase (reconhecimento por câmera)
-- tenha onde gravar sem precisar de outra migration de schema. Nenhuma
-- linha é inserida aqui, nenhum embedding é gerado, nenhum job roda.
--
-- Decisões deliberadamente adiadas para a fase do Modo Scan (não aqui):
--   - Qual modelo/dimensão de embedding usar (a coluna genérica jsonb abaixo
--     evita travar nisso agora; trocar para `vector(N)` do pgvector é uma
--     migration futura, pequena, quando o modelo for escolhido).
--   - Se `pgvector` está disponível/habilitado neste projeto Supabase —
--     não assumimos isso aqui para não quebrar esta migration em projetos
--     sem a extensão habilitada.
--   - Pipeline de geração (Edge Function, job externo, etc.).
--
-- image_processing_status controla o que product_images.recognition_enabled
-- já prepara: só imagem aprovada (quality_status='aprovada') e habilitada
-- para reconhecimento (recognition_enabled=true) deve, no futuro, virar
-- candidata a ter uma linha aqui.

create table if not exists public.image_embeddings (
  id uuid primary key default gen_random_uuid(),
  product_image_id uuid not null references public.product_images (id) on delete cascade,
  model_name text not null,
  embedding jsonb,
  status text not null default 'not_generated'
    check (status in ('not_generated', 'pending', 'processing', 'ready', 'error')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.image_embeddings is 'FUTURO (Modo Scan) — não usado nesta fase. Nenhuma linha é criada por esta migration.';
comment on column public.image_embeddings.embedding is 'Placeholder genérico (jsonb) até a fase do Modo Scan escolher modelo/dimensão; considerar migrar para pgvector (vector(N)) nessa hora.';

create unique index if not exists image_embeddings_image_model_unique
  on public.image_embeddings (product_image_id, model_name);
create index if not exists image_embeddings_status_idx on public.image_embeddings (status);

drop trigger if exists set_updated_at on public.image_embeddings;
create trigger set_updated_at before update on public.image_embeddings
  for each row execute function public.set_updated_at();

alter table public.image_embeddings enable row level security;

-- Mesma regra de leitura do restante do catálogo visual; escrita só via
-- backend privilegiado (service_role) na futura fase — por isso não há
-- policy de insert/update para usuários comuns aqui ainda.
drop policy if exists image_embeddings_select on public.image_embeddings;
create policy image_embeddings_select on public.image_embeddings
  for select using (public.is_active_user());
