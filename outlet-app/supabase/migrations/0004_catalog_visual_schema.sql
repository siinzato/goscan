-- 0004_catalog_visual_schema.sql
-- Fase "Catálogo Visual — Base de Imagens para Reconhecimento por Câmera".
--
-- DECISÃO DE MAPEAMENTO (evita tabelas duplicadas, conforme pedido):
-- O enunciado desta fase fala em "Produtos Outlet" identificados pelo
-- "SKU Outlet" (id, sku_outlet, nome, gtin_ean, ativo, created_at, updated_at).
-- Isso já existe no projeto: é exatamente public.product_variants
-- (sku_code = sku_outlet, gtin = gtin_ean, active = ativo), com o nome do
-- produto em public.products.name (join por product_id). Não criamos uma
-- tabela nova de "produtos outlet" — as tabelas abaixo referenciam
-- product_variants.id diretamente.
--
-- Histórico de alterações de imagem: reaproveita public.audit_logs (já
-- existe desde a Fase 1), em vez de uma tabela image_change_history nova.
-- entity_type='product_images', entity_id=<id da imagem>,
-- metadata={previous_data, new_data, product_variant_id, action}.

-- ---------------------------------------------------------------------------
-- product_images
-- ---------------------------------------------------------------------------
create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_variant_id uuid not null references public.product_variants (id) on delete cascade,

  storage_path text,
  source_url text,
  image_hash text,
  mime_type text,
  file_size integer,
  width integer,
  height integer,

  is_primary boolean not null default false,
  is_active boolean not null default true,

  image_type text not null default 'catalogo'
    check (image_type in ('catalogo', 'frontal', 'lateral', 'traseira', 'detalhe', 'embalagem')),
  view_angle text not null default 'nao_informado',
  recognition_enabled boolean not null default false,
  quality_status text not null default 'pendente'
    check (quality_status in ('pendente', 'aprovada', 'rejeitada')),
  processing_status text not null default 'pendente'
    check (processing_status in ('pendente', 'processando', 'pronta', 'erro')),
  processing_error text,

  uploaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

comment on table public.product_images is 'Base visual de referência por SKU Outlet (product_variants). Múltiplas imagens por produto; recognition_enabled/quality_status controlam o que entra na futura busca por similaridade do Modo Scan.';
comment on column public.product_images.recognition_enabled is 'Só imagens aprovadas (quality_status=aprovada) e com isto true entram no futuro índice de reconhecimento.';

create index if not exists product_images_variant_idx on public.product_images (product_variant_id);
create index if not exists product_images_processing_status_idx on public.product_images (processing_status);
create index if not exists product_images_quality_status_idx on public.product_images (quality_status);
create index if not exists product_images_recognition_idx on public.product_images (recognition_enabled) where is_active;
create index if not exists product_images_hash_idx on public.product_images (image_hash) where image_hash is not null;

-- No máximo uma imagem principal ativa por produto.
create unique index if not exists product_images_one_primary
  on public.product_images (product_variant_id) where is_primary and is_active;

-- Dedup por conteúdo: mesmo produto + mesmo hash de arquivo não duplica
-- (cobre "URL já cadastrada" e "imagem duplicada com URLs diferentes").
create unique index if not exists product_images_variant_hash_unique
  on public.product_images (product_variant_id, image_hash) where is_active and image_hash is not null;

drop trigger if exists set_updated_at on public.product_images;
create trigger set_updated_at before update on public.product_images
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- catalog_image_imports
-- ---------------------------------------------------------------------------
create table if not exists public.catalog_image_imports (
  id uuid primary key default gen_random_uuid(),
  filename text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'completed_with_errors', 'failed')),
  total_rows integer not null default 0,
  processed_rows integer not null default 0,
  success_rows integer not null default 0,
  error_rows integer not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists catalog_image_imports_created_by_idx on public.catalog_image_imports (created_by);
create index if not exists catalog_image_imports_created_at_idx on public.catalog_image_imports (created_at desc);
create index if not exists catalog_image_imports_status_idx on public.catalog_image_imports (status);

-- ---------------------------------------------------------------------------
-- catalog_image_import_items
-- ---------------------------------------------------------------------------
create table if not exists public.catalog_image_import_items (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.catalog_image_imports (id) on delete cascade,
  row_number integer not null,
  sku_outlet text not null,
  product_name text,
  gtin_ean text,
  source_url text,
  product_variant_id uuid references public.product_variants (id),
  product_image_id uuid references public.product_images (id),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'success', 'success_no_image', 'error', 'skipped')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_image_import_items_import_idx on public.catalog_image_import_items (import_id);
create index if not exists catalog_image_import_items_status_idx on public.catalog_image_import_items (status);
create index if not exists catalog_image_import_items_sku_idx on public.catalog_image_import_items (sku_outlet);

drop trigger if exists set_updated_at on public.catalog_image_import_items;
create trigger set_updated_at before update on public.catalog_image_import_items
  for each row execute function public.set_updated_at();
