-- 0021_recognition_quality.sql
--
-- MODO SCAN — "Qualidade de Reconhecimento": um cache por variante (não uma
-- view calculada a cada carregamento da lista) com o percentual e o
-- detalhamento de o quanto aquele produto está preparado para ser
-- reconhecido rápido e com segurança. Recalculado nos eventos reais que
-- mudam a base (nova referência, correção, confirmação, desativação —
-- backend/recognitionQuality.ts), nunca por um cron/poll — a tela sempre lê
-- o valor já pronto, sem recalcular na hora.
create table if not exists public.product_recognition_quality (
  variant_id uuid primary key references public.product_variants (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,

  score_percent integer not null,
  band text not null check (band in ('excelente', 'bom', 'regular', 'fraco', 'critico')),
  -- true enquanto não houver histórico operacional real (scan_recognition_log)
  -- suficiente — nesse caso score_percent reflete só as referências
  -- cadastradas, nunca inventa uso real que não aconteceu.
  estimated_only boolean not null default true,

  reference_count integer not null default 0,
  official_count integer not null default 0,
  learned_count integer not null default 0,
  distinct_source_types integer not null default 0,

  quality_technical_percent integer not null default 0,
  angle_coverage_percent integer not null default 0,
  angles_present text[] not null default '{}',
  embedding_consistency_percent integer,

  -- Só preenchido quando houver histórico operacional real suficiente (ver
  -- MIN_OPERATIONAL_SAMPLES em recognitionQuality.ts).
  historical_accuracy_percent integer,
  historical_sample_count integer not null default 0,
  avg_recognition_ms integer,

  top_confusion_variant_id uuid references public.product_variants (id),
  top_confusion_sku text,
  top_confusion_count integer,

  recommendations text[] not null default '{}',

  computed_at timestamptz not null default now()
);

comment on table public.product_recognition_quality is 'Cache por variante da Qualidade de Reconhecimento — recalculado nos eventos reais (nova referência/correção/confirmação/desativação), nunca calculado por polling. Nunca escrito diretamente pelo cliente.';

create index if not exists product_recognition_quality_band_idx on public.product_recognition_quality (band);
create index if not exists product_recognition_quality_score_idx on public.product_recognition_quality (score_percent);

alter table public.product_recognition_quality enable row level security;

drop policy if exists product_recognition_quality_select on public.product_recognition_quality;
create policy product_recognition_quality_select on public.product_recognition_quality
  for select using (public.is_active_user());
