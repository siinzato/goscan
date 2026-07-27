-- 0023_nfe_receipts.sql
--
-- EXPANSÃO GOSCAN — Conferência por Nota Fiscal (NF-e), fluxo novo e
-- independente para Produtos Normais (ver 0022). Reaproveita o padrão de
-- RLS já usado em conferences/conference_items (0002_rls_policies.sql):
-- dono ou manager/admin enxerga; qualquer usuário ativo cria/opera a própria
-- NF; manager/admin sempre pode tudo. Não mexe em nenhuma tabela existente
-- do fluxo Outlet.

-- ---------------------------------------------------------------------------
-- invoice_receipts: 1 linha por NF-e importada.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_receipts (
  id uuid primary key default gen_random_uuid(),
  invoice_key text not null,
  invoice_number text,
  supplier_name text,
  supplier_cnpj text,
  issued_at timestamptz,
  xml text not null,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed', 'with_divergences')),
  created_by uuid not null references public.profiles (id),
  finished_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- chave de acesso da NF-e é o identificador real e único — previne reimportar
-- a mesma nota (ver regra "Esta Nota Fiscal já foi importada").
create unique index if not exists invoice_receipts_invoice_key_key on public.invoice_receipts (invoice_key);
create index if not exists invoice_receipts_created_by_idx on public.invoice_receipts (created_by);
create index if not exists invoice_receipts_status_idx on public.invoice_receipts (status);
create index if not exists invoice_receipts_created_at_idx on public.invoice_receipts (created_at desc);

comment on column public.invoice_receipts.xml is 'XML original da NF-e, nunca alterado — permite auditoria/reprocessamento/consulta futura.';

-- ---------------------------------------------------------------------------
-- invoice_receipt_items: 1 linha por item da NF-e.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.invoice_receipts (id) on delete cascade,
  product_variant_id uuid references public.product_variants (id),
  invoice_product_code text,
  description text,
  ean text,
  unit text,
  unit_value numeric(14, 4),
  total_value numeric(14, 4),
  expected_quantity numeric(14, 3) not null default 0,
  physical_quantity numeric(14, 3),
  status text not null default 'pending' check (status in ('pending', 'counted', 'ok', 'missing', 'surplus', 'unlinked')),
  link_source text check (link_source in ('sku', 'ean', 'alias', 'manual')),
  counted_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists invoice_receipt_items_receipt_id_idx on public.invoice_receipt_items (receipt_id);
create index if not exists invoice_receipt_items_product_variant_id_idx on public.invoice_receipt_items (product_variant_id);
create index if not exists invoice_receipt_items_status_idx on public.invoice_receipt_items (status);
create index if not exists invoice_receipt_items_ean_idx on public.invoice_receipt_items (ean) where ean is not null and ean <> '';

comment on column public.invoice_receipt_items.physical_quantity is 'Quantidade contada pelo operador. NUNCA exibir expected_quantity na UI enquanto o item não estiver finalizado (contagem cega).';
comment on column public.invoice_receipt_items.status is 'pending/counted = durante a contagem cega; ok/missing/surplus só são calculados ao finalizar a conferência; unlinked = item da NF sem produto correspondente no catálogo.';

-- ---------------------------------------------------------------------------
-- receipt_counts: histórico de contagens/recontagens — nunca sobrescrito.
-- ---------------------------------------------------------------------------
create table if not exists public.receipt_counts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.invoice_receipt_items (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  quantity numeric(14, 3) not null,
  count_number integer not null,
  created_at timestamptz not null default now()
);

create index if not exists receipt_counts_item_id_idx on public.receipt_counts (item_id);

-- ---------------------------------------------------------------------------
-- invoice_sku_aliases: associação NF→produto aprendida, só usada como
-- fallback quando SKU exato e EAN exato não batem (nunca fonte primária).
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_sku_aliases (
  id uuid primary key default gen_random_uuid(),
  invoice_product_code text,
  ean text,
  product_variant_id uuid not null references public.product_variants (id) on delete cascade,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint invoice_sku_aliases_needs_key check (invoice_product_code is not null or ean is not null)
);

create unique index if not exists invoice_sku_aliases_code_key on public.invoice_sku_aliases (invoice_product_code) where invoice_product_code is not null;
create unique index if not exists invoice_sku_aliases_ean_key on public.invoice_sku_aliases (ean) where ean is not null;

-- ---------------------------------------------------------------------------
-- updated_at automático (reaproveita a função de 0001_init_schema.sql)
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.invoice_receipts;
create trigger set_updated_at before update on public.invoice_receipts
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.invoice_receipt_items;
create trigger set_updated_at before update on public.invoice_receipt_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.invoice_receipts enable row level security;
alter table public.invoice_receipt_items enable row level security;
alter table public.receipt_counts enable row level security;
alter table public.invoice_sku_aliases enable row level security;

drop policy if exists invoice_receipts_select on public.invoice_receipts;
create policy invoice_receipts_select on public.invoice_receipts
  for select
  using (created_by = auth.uid() or public.is_manager_or_admin());

drop policy if exists invoice_receipts_insert on public.invoice_receipts;
create policy invoice_receipts_insert on public.invoice_receipts
  for insert
  with check (public.is_active_user() and created_by = auth.uid());

drop policy if exists invoice_receipts_update on public.invoice_receipts;
create policy invoice_receipts_update on public.invoice_receipts
  for update
  using (
    (created_by = auth.uid() and status in ('not_started', 'in_progress'))
    or public.is_manager_or_admin()
  )
  with check (
    created_by = auth.uid() or public.is_manager_or_admin()
  );

drop policy if exists invoice_receipt_items_select on public.invoice_receipt_items;
create policy invoice_receipt_items_select on public.invoice_receipt_items
  for select
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and (r.created_by = auth.uid() or public.is_manager_or_admin())
    )
  );

drop policy if exists invoice_receipt_items_insert on public.invoice_receipt_items;
create policy invoice_receipt_items_insert on public.invoice_receipt_items
  for insert
  with check (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and (
          (r.created_by = auth.uid() and r.status in ('not_started', 'in_progress'))
          or public.is_manager_or_admin()
        )
    )
  );

drop policy if exists invoice_receipt_items_update on public.invoice_receipt_items;
create policy invoice_receipt_items_update on public.invoice_receipt_items
  for update
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and (
          (r.created_by = auth.uid() and r.status in ('not_started', 'in_progress'))
          or public.is_manager_or_admin()
        )
    )
  );

drop policy if exists receipt_counts_select on public.receipt_counts;
create policy receipt_counts_select on public.receipt_counts
  for select
  using (
    exists (
      select 1 from public.invoice_receipt_items i
      join public.invoice_receipts r on r.id = i.receipt_id
      where i.id = receipt_counts.item_id
        and (r.created_by = auth.uid() or public.is_manager_or_admin())
    )
  );

drop policy if exists receipt_counts_insert on public.receipt_counts;
create policy receipt_counts_insert on public.receipt_counts
  for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.invoice_receipt_items i
      join public.invoice_receipts r on r.id = i.receipt_id
      where i.id = receipt_counts.item_id
        and (
          (r.created_by = auth.uid() and r.status in ('not_started', 'in_progress'))
          or public.is_manager_or_admin()
        )
    )
  );

drop policy if exists invoice_sku_aliases_select on public.invoice_sku_aliases;
create policy invoice_sku_aliases_select on public.invoice_sku_aliases
  for select using (public.is_active_user());

drop policy if exists invoice_sku_aliases_insert on public.invoice_sku_aliases;
create policy invoice_sku_aliases_insert on public.invoice_sku_aliases
  for insert
  with check (public.is_active_user() and created_by = auth.uid());

drop policy if exists invoice_sku_aliases_update on public.invoice_sku_aliases;
create policy invoice_sku_aliases_update on public.invoice_sku_aliases
  for update
  using (public.is_manager_or_admin())
  with check (public.is_manager_or_admin());

drop policy if exists invoice_sku_aliases_delete on public.invoice_sku_aliases;
create policy invoice_sku_aliases_delete on public.invoice_sku_aliases
  for delete
  using (public.is_manager_or_admin());
