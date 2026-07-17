-- 0001_init_schema.sql
-- Outlet App — Fase 1: schema principal (Supabase/Postgres).
-- Substitui o SQLite local (data.db) como banco de dados principal.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- profiles: 1 linha por usuário do Supabase Auth.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'operator' check (role in ('admin', 'manager', 'operator')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Perfil de aplicação por usuário autenticado. Role e active só podem ser alterados por admin (ver 0002_rls.sql e trigger protect_profile_fields).';

-- ---------------------------------------------------------------------------
-- products: modelo principal do produto (equivalente ao "model_code" do SQLite).
-- ---------------------------------------------------------------------------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  model_code text,
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- unique apenas quando preenchido (NULL nunca colide em índice único do Postgres)
create unique index if not exists products_model_code_key on public.products (model_code) where model_code is not null;
create index if not exists products_normalized_name_idx on public.products (normalized_name);
create index if not exists products_active_idx on public.products (active);

-- ---------------------------------------------------------------------------
-- product_variants: cada SKU/variação de cor de um produto.
-- ---------------------------------------------------------------------------
create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  sku_code text not null,
  gtin text,
  color text,
  normalized_color text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists product_variants_sku_code_key on public.product_variants (sku_code);
create index if not exists product_variants_product_id_idx on public.product_variants (product_id);
create index if not exists product_variants_normalized_color_idx on public.product_variants (normalized_color);
-- GTIN pode ser vazio; indexado apenas quando preenchido.
create index if not exists product_variants_gtin_idx on public.product_variants (gtin) where gtin is not null and gtin <> '';

-- ---------------------------------------------------------------------------
-- product_aliases: apelidos de modelo/cor usados para reconhecer prints/texto.
--
-- Decisão de design (desvio pontual e documentado do enunciado): product_id é
-- opcional. Aliases de modelo ('model') SEMPRE precisam de um produto (regra
-- "evite aliases globais perigosos"). Já aliases de cor ('color') são, por
-- natureza, um vocabulário global (ex.: "preta" -> "Preto" vale para qualquer
-- produto) — exigir um product_id ali reintroduziria duplicação sem ganho de
-- segurança. alias_type='operator' representa uma SUGESTÃO de operador
-- (fica com active=false até um manager/admin promover) e 'import' identifica
-- aliases criados automaticamente pela importação de planilha.
-- ---------------------------------------------------------------------------
create table if not exists public.product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products (id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  alias_type text not null check (alias_type in ('model', 'color', 'operator', 'import')),
  -- Campo extra (não previsto no enunciado original, adicionado por necessidade):
  -- para alias_type='model' o alvo canônico já é product_id; para alias_type='color'
  -- não há uma tabela de cores separada, então o nome canônico de exibição (ex.:
  -- "preta" -> "Preto") precisa ser guardado em algum lugar. NULL para os demais tipos.
  canonical_value text,
  created_by uuid references public.profiles (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint product_aliases_model_requires_product
    check (alias_type <> 'model' or product_id is not null)
);

create index if not exists product_aliases_normalized_alias_idx on public.product_aliases (normalized_alias);
create index if not exists product_aliases_product_id_idx on public.product_aliases (product_id);
-- unicidade: apelidos globais (product_id nulo, tipicamente 'color') não podem repetir;
-- apelidos por produto não podem repetir dentro do mesmo produto+tipo.
create unique index if not exists product_aliases_global_unique
  on public.product_aliases (normalized_alias, alias_type) where product_id is null;
create unique index if not exists product_aliases_scoped_unique
  on public.product_aliases (product_id, normalized_alias, alias_type) where product_id is not null;

-- ---------------------------------------------------------------------------
-- conferences
-- ---------------------------------------------------------------------------
create table if not exists public.conferences (
  id uuid primary key default gen_random_uuid(),
  name text,
  status text not null default 'draft' check (status in ('draft', 'in_progress', 'completed', 'cancelled')),
  operator_id uuid not null references public.profiles (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  notes text,
  total_units integer not null default 0,
  total_skus integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conferences_operator_id_idx on public.conferences (operator_id);
create index if not exists conferences_status_idx on public.conferences (status);
create index if not exists conferences_created_at_idx on public.conferences (created_at desc);

-- ---------------------------------------------------------------------------
-- conference_items
-- ---------------------------------------------------------------------------
create table if not exists public.conference_items (
  id uuid primary key default gen_random_uuid(),
  conference_id uuid not null references public.conferences (id) on delete cascade,
  product_variant_id uuid references public.product_variants (id),
  raw_model text,
  raw_color text,
  quantity integer not null default 1 check (quantity > 0),
  match_status text not null default 'unresolved' check (match_status in ('matched', 'partial', 'manual', 'unresolved')),
  match_confidence numeric(4, 3),
  source text not null default 'manual' check (source in ('manual', 'text', 'screenshot', 'import')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conference_items_conference_id_idx on public.conference_items (conference_id);
create index if not exists conference_items_product_variant_id_idx on public.conference_items (product_variant_id);
create index if not exists conference_items_match_status_idx on public.conference_items (match_status);

-- ---------------------------------------------------------------------------
-- catalog_imports
-- ---------------------------------------------------------------------------
create table if not exists public.catalog_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  imported_by uuid references public.profiles (id),
  total_rows integer not null default 0,
  inserted_rows integer not null default 0,
  updated_rows integer not null default 0,
  rejected_rows integer not null default 0,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  error_summary jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists catalog_imports_imported_by_idx on public.catalog_imports (imported_by);
create index if not exists catalog_imports_created_at_idx on public.catalog_imports (created_at desc);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_user_id_idx on public.audit_logs (user_id);
create index if not exists audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.products;
create trigger set_updated_at before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.product_variants;
create trigger set_updated_at before update on public.product_variants
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.conferences;
create trigger set_updated_at before update on public.conferences
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.conference_items;
create trigger set_updated_at before update on public.conference_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Criação automática de profile ao cadastrar um usuário no Supabase Auth.
-- Role inicial é SEMPRE 'operator' — cadastro público jamais cria admin.
-- SECURITY DEFINER: roda com privilégio do owner da função (bypassa RLS),
-- é o único caminho permitido para inserir em public.profiles.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, full_name, role, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'operator',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Promoção manual do primeiro administrador (procedimento documentado).
--
-- Isto NÃO é executado automaticamente. Depois de criar sua própria conta
-- pelo app (o que gera um profile com role='operator'), rode manualmente no
-- SQL Editor do Supabase, substituindo o e-mail:
--
--   update public.profiles
--   set role = 'admin'
--   where id = (select id from auth.users where email = 'seu-email@exemplo.com');
--
-- Veja o README para o passo a passo completo.
-- ---------------------------------------------------------------------------
