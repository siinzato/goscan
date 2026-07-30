-- 0047_returns_schema.sql
--
-- EXPANSÃO GOSCAN — Novo módulo "Devolução" (recebimento e tratamento diário
-- de devoluções dos marketplaces Mercado Livre/Shopee/Shein/Amazon/TikTok).
--
-- Fluxo: responsável registra a devolução (marketplace + pacote/pedido + NF)
-- → bipa os produtos (reaproveita o catálogo já existente, EAN normalizado
-- igual ao resto do app — ver gtin_normalized/0046) → avalia cada item
-- (vendável/avariado/divergente/pacote vazio/aguardando análise) → envia o
-- lote consolidado por SKU para a Logística → Logística confirma o
-- lançamento manual no Tiny (nunca automático nesta etapa — ver 0049 pra
-- estrutura preparada e desativada de integrações futuras).
--
-- Convenções seguidas (nunca reinventadas aqui): RLS por empresa via
-- current_company_id() (0037/0038), company_id sempre derivado no servidor
-- por trigger BEFORE INSERT (nunca aceito do cliente), tabelas-filha usam
-- join com exists() em vez de duplicar company_id (mesmo padrão de
-- invoice_receipt_items), auditoria via public.audit_logs reaproveitada
-- (nunca uma segunda tabela de auditoria), bucket de Storage privado com
-- policies por bucket_id (mesmo padrão de product-images/scan-learning-samples).

-- ---------------------------------------------------------------------------
-- return_batches — lote consolidado enviado à Logística.
-- ---------------------------------------------------------------------------
create table if not exists public.return_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  status text not null default 'aguardando_lancamento' check (status in ('aguardando_lancamento', 'lancada_tiny', 'concluida')),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists return_batches_company_id_idx on public.return_batches (company_id);
create index if not exists return_batches_status_idx on public.return_batches (status);

drop trigger if exists set_updated_at on public.return_batches;
create trigger set_updated_at before update on public.return_batches
  for each row execute function public.set_updated_at();

create or replace function public.set_return_batch_company_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.company_id := (select company_id from public.profiles where id = new.created_by);
  return new;
end;
$$;

drop trigger if exists set_return_batch_company_id on public.return_batches;
create trigger set_return_batch_company_id before insert on public.return_batches
  for each row execute function public.set_return_batch_company_id();

-- ---------------------------------------------------------------------------
-- returns — cabeçalho de 1 devolução recebida.
-- ---------------------------------------------------------------------------
create table if not exists public.returns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  marketplace text not null check (marketplace in ('mercado_livre', 'shopee', 'shein', 'amazon', 'tiktok', 'outro')),
  -- Texto puro sempre — nunca convertido pra número (preserva zeros à esquerda
  -- e caracteres do código de pacote/pedido/rastreio, mesma regra já aplicada
  -- ao EAN em toda a correção anterior — ver utils.ts normalizeEan).
  package_code text not null,
  invoice_situation text not null default 'nao_se_aplica' check (invoice_situation in ('pendente_cancelamento', 'cancelada', 'nao_se_aplica')),
  invoice_number text,
  -- Preparado pra aceitar a chave de 44 dígitos no futuro — sem nenhuma
  -- consulta/download automático nesta etapa (ver pedido, seção 4).
  invoice_access_key text,
  invoice_cancelled_at timestamptz,
  invoice_cancelled_by uuid references public.profiles (id),
  notes text,
  status text not null default 'em_registro' check (
    status in ('em_registro', 'aguardando_avaliacao', 'pendente_cancelamento_nota', 'pronta_logistica', 'enviada_logistica', 'lancada_tiny', 'concluida', 'com_pendencias', 'cancelada')
  ),
  created_by uuid not null references public.profiles (id),
  batch_id uuid references public.return_batches (id),
  sent_to_logistics_at timestamptz,
  sent_to_logistics_by uuid references public.profiles (id),
  -- Seção 20 do pedido — preparação pra futura API de marketplace. Nunca
  -- preenchido automaticamente nesta etapa (fluxo 100% manual); 'manual' é o
  -- único valor real hoje.
  source text not null default 'manual' check (source in ('manual', 'marketplace_api')),
  external_order_id text,
  external_package_id text,
  external_return_id text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint returns_invoice_number_required_check check (
    invoice_situation <> 'cancelada' or (invoice_number is not null and length(trim(invoice_number)) > 0)
  ),
  constraint returns_invoice_access_key_length_check check (invoice_access_key is null or length(invoice_access_key) = 44)
);

create index if not exists returns_company_id_idx on public.returns (company_id);
create index if not exists returns_status_idx on public.returns (status);
create index if not exists returns_marketplace_idx on public.returns (marketplace);
create index if not exists returns_package_code_idx on public.returns (package_code);
create index if not exists returns_invoice_number_idx on public.returns (invoice_number) where invoice_number is not null;
create index if not exists returns_batch_id_idx on public.returns (batch_id) where batch_id is not null;
create index if not exists returns_created_at_idx on public.returns (created_at desc);
create index if not exists returns_created_by_idx on public.returns (created_by);

comment on column public.returns.package_code is 'Código do pacote/pedido/rastreio — sempre texto, nunca number (preserva zeros à esquerda). Não é unique: reenvio do mesmo pacote em datas diferentes é um caso real (ver pedido); a UI apenas ALERTA sobre duplicidade, nunca bloqueia.';

drop trigger if exists set_updated_at on public.returns;
create trigger set_updated_at before update on public.returns
  for each row execute function public.set_updated_at();

create or replace function public.set_return_company_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.company_id := (select company_id from public.profiles where id = new.created_by);
  return new;
end;
$$;

drop trigger if exists set_return_company_id on public.returns;
create trigger set_return_company_id before insert on public.returns
  for each row execute function public.set_return_company_id();

-- Preenche data/usuário do cancelamento da nota automaticamente — nunca
-- aceito do cliente, sempre o momento real da transição (ver pedido, seção
-- 4: "a confirmação é um registro operacional manual", nunca uma consulta
-- automática à SEFAZ/Tiny).
create or replace function public.set_return_invoice_cancelled_meta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.invoice_situation = 'cancelada' and (old.invoice_situation is distinct from 'cancelada') then
    new.invoice_cancelled_at := now();
    new.invoice_cancelled_by := auth.uid();
  elsif new.invoice_situation <> 'cancelada' then
    new.invoice_cancelled_at := null;
    new.invoice_cancelled_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists set_return_invoice_cancelled_meta on public.returns;
create trigger set_return_invoice_cancelled_meta before update on public.returns
  for each row execute function public.set_return_invoice_cancelled_meta();

-- ---------------------------------------------------------------------------
-- return_items — 1 linha por produto bipado/adicionado dentro de uma devolução.
-- ---------------------------------------------------------------------------
create table if not exists public.return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.returns (id) on delete cascade,
  product_variant_id uuid references public.product_variants (id),
  scanned_ean_raw text,
  -- Mesma normalização usada no resto do app (normalizeEan — dígitos apenas,
  -- nunca uma segunda regra divergente). Comparação sempre contra
  -- product_variants.gtin_normalized (0046), nunca substring/ILIKE.
  ean_normalized text,
  -- Snapshot no momento da bipagem/vínculo — nunca um join ao vivo, pra o
  -- relatório continuar coerente mesmo se o cadastro mudar depois.
  resolved_sku_code text,
  resolved_product_name text,
  quantity integer not null default 1 check (quantity > 0),
  classification text not null default 'aguardando_analise' check (
    classification in ('vendavel', 'avariado', 'divergente', 'pacote_vazio', 'aguardando_analise')
  ),
  condition_notes text,
  photo_path text,
  link_source text check (link_source in ('ean', 'sku', 'manual')),
  -- true quando o EAN bipado não teve correspondência exata no catálogo e o
  -- item não foi resolvido nem por busca manual — nunca some da devolução,
  -- vira pendência explícita (ver pedido, seção 5: "não travar toda a
  -- devolução... salvar como pendência").
  is_pending boolean not null default false,
  -- Preenchido quando "Produto divergente": o que a operadora esperava vs. o
  -- que realmente veio no pacote.
  expected_description text,
  -- Motivo de uma correção feita DEPOIS que a devolução saiu do fluxo de
  -- registro (ver correct_return_record na 0048) — nunca usado fora desse
  -- caminho auditado.
  last_change_reason text,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists return_items_return_id_idx on public.return_items (return_id);
create index if not exists return_items_product_variant_id_idx on public.return_items (product_variant_id) where product_variant_id is not null;
create index if not exists return_items_ean_normalized_idx on public.return_items (ean_normalized) where ean_normalized is not null and ean_normalized <> '';
create index if not exists return_items_classification_idx on public.return_items (classification);
create index if not exists return_items_is_pending_idx on public.return_items (is_pending) where is_pending;

comment on column public.return_items.is_pending is 'EAN não encontrado E não resolvido por busca manual — aparece na aba "Pendências e Ocorrências" do relatório e NUNCA entra na consolidação de estoque enviada à Logística.';

drop trigger if exists set_updated_at on public.return_items;
create trigger set_updated_at before update on public.return_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- return_batch_items — resumo consolidado por SKU dentro de 1 lote (gravado
-- atomicamente pela RPC send_return_batch_to_logistics — ver 0048; nenhuma
-- policy de insert/update pra authenticated, só leitura direta).
-- ---------------------------------------------------------------------------
create table if not exists public.return_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.return_batches (id) on delete cascade,
  product_variant_id uuid not null references public.product_variants (id),
  total_quantity integer not null default 0 check (total_quantity >= 0),
  warehouse text,
  created_at timestamptz not null default now(),
  unique (batch_id, product_variant_id)
);

create index if not exists return_batch_items_batch_id_idx on public.return_batch_items (batch_id);

-- ---------------------------------------------------------------------------
-- return_batch_sources — rastreabilidade: qual return_item contribuiu com
-- quanto pra cada linha consolidada (nunca só o total, sempre o detalhe de
-- origem — ver pedido, seção 8: "detalhamento das devoluções de origem").
-- ---------------------------------------------------------------------------
create table if not exists public.return_batch_sources (
  id uuid primary key default gen_random_uuid(),
  batch_item_id uuid not null references public.return_batch_items (id) on delete cascade,
  return_item_id uuid not null references public.return_items (id),
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

create index if not exists return_batch_sources_batch_item_id_idx on public.return_batch_sources (batch_item_id);
create index if not exists return_batch_sources_return_item_id_idx on public.return_batch_sources (return_item_id);

-- ---------------------------------------------------------------------------
-- return_launch_confirmations — confirmação MANUAL do lançamento no Tiny (o
-- GoScan nunca lança automaticamente — ver pedido, seção 9).
-- ---------------------------------------------------------------------------
create table if not exists public.return_launch_confirmations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.return_batches (id),
  warehouse text not null,
  launched_at timestamptz not null,
  note text,
  confirmed_by uuid not null references public.profiles (id),
  confirmed_quantities jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists return_launch_confirmations_batch_id_idx on public.return_launch_confirmations (batch_id);

comment on table public.return_launch_confirmations is 'Registro operacional de que as quantidades foram lançadas manualmente no Tiny — nunca atualiza estoque automaticamente. 1 confirmação por lote (a RPC confirm_return_batch_tiny_launch impede duplicidade).';

-- ---------------------------------------------------------------------------
-- return_corrections — nunca apaga o registro original: guarda antes/depois/
-- motivo/usuário/data de qualquer alteração feita depois que o registro saiu
-- do fluxo normal de edição (ver pedido, seção 9: "não apagar o registro
-- original. Criar registro de correção").
-- ---------------------------------------------------------------------------
create table if not exists public.return_corrections (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('return', 'return_item', 'return_batch')),
  entity_id uuid not null,
  field_name text not null,
  previous_value text,
  new_value text,
  reason text not null,
  corrected_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists return_corrections_entity_idx on public.return_corrections (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.return_batches enable row level security;
alter table public.returns enable row level security;
alter table public.return_items enable row level security;
alter table public.return_batch_items enable row level security;
alter table public.return_batch_sources enable row level security;
alter table public.return_launch_confirmations enable row level security;
alter table public.return_corrections enable row level security;

-- return_batches: leitura pra qualquer usuário ativo da empresa. Sem policy
-- de insert/update pra authenticated — só a RPC (SECURITY DEFINER) grava.
drop policy if exists return_batches_select on public.return_batches;
create policy return_batches_select on public.return_batches
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

-- returns
drop policy if exists returns_select on public.returns;
create policy returns_select on public.returns
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

drop policy if exists returns_insert on public.returns;
create policy returns_insert on public.returns
  for insert
  with check (public.is_active_user() and created_by = auth.uid() and company_id = public.current_company_id());

-- Edição direta só enquanto a devolução ainda não foi enviada à Logística —
-- depois disso, qualquer alteração exige o caminho auditado
-- (correct_return_record, 0048), mesmo para manager/admin (ver pedido,
-- seção 9: "qualquer alteração deve exigir confirmação e permanecer
-- registrada na auditoria").
drop policy if exists returns_update on public.returns;
create policy returns_update on public.returns
  for update
  using (
    company_id = public.current_company_id()
    and status in ('em_registro', 'aguardando_avaliacao', 'pendente_cancelamento_nota', 'pronta_logistica', 'com_pendencias')
  )
  with check (company_id = public.current_company_id());

drop policy if exists returns_delete on public.returns;
create policy returns_delete on public.returns
  for delete
  using (
    company_id = public.current_company_id()
    and public.is_manager_or_admin()
    and status in ('em_registro', 'aguardando_avaliacao', 'pendente_cancelamento_nota', 'pronta_logistica', 'com_pendencias')
  );

-- return_items — segue o status da devolução-pai (mesma regra: sem edição
-- direta depois do envio à Logística).
drop policy if exists return_items_select on public.return_items;
create policy return_items_select on public.return_items
  for select
  using (
    exists (
      select 1 from public.returns r
      where r.id = return_items.return_id
        and r.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

drop policy if exists return_items_insert on public.return_items;
create policy return_items_insert on public.return_items
  for insert
  with check (
    public.is_active_user()
    and created_by = auth.uid()
    and exists (
      select 1 from public.returns r
      where r.id = return_items.return_id
        and r.company_id = public.current_company_id()
        and r.status in ('em_registro', 'aguardando_avaliacao', 'pendente_cancelamento_nota', 'pronta_logistica', 'com_pendencias')
    )
  );

drop policy if exists return_items_update on public.return_items;
create policy return_items_update on public.return_items
  for update
  using (
    exists (
      select 1 from public.returns r
      where r.id = return_items.return_id
        and r.company_id = public.current_company_id()
        and r.status in ('em_registro', 'aguardando_avaliacao', 'pendente_cancelamento_nota', 'pronta_logistica', 'com_pendencias')
    )
  );

drop policy if exists return_items_delete on public.return_items;
create policy return_items_delete on public.return_items
  for delete
  using (
    exists (
      select 1 from public.returns r
      where r.id = return_items.return_id
        and r.company_id = public.current_company_id()
        and r.status in ('em_registro', 'aguardando_avaliacao', 'pendente_cancelamento_nota', 'pronta_logistica', 'com_pendencias')
    )
  );

-- return_batch_items / return_batch_sources — só leitura direta; escrita
-- exclusiva da RPC send_return_batch_to_logistics (0048).
drop policy if exists return_batch_items_select on public.return_batch_items;
create policy return_batch_items_select on public.return_batch_items
  for select
  using (
    exists (
      select 1 from public.return_batches b
      where b.id = return_batch_items.batch_id
        and b.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

drop policy if exists return_batch_sources_select on public.return_batch_sources;
create policy return_batch_sources_select on public.return_batch_sources
  for select
  using (
    exists (
      select 1 from public.return_batch_items bi
      join public.return_batches b on b.id = bi.batch_id
      where bi.id = return_batch_sources.batch_item_id
        and b.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

-- return_launch_confirmations — só leitura direta; escrita exclusiva da RPC
-- confirm_return_batch_tiny_launch (0048).
drop policy if exists return_launch_confirmations_select on public.return_launch_confirmations;
create policy return_launch_confirmations_select on public.return_launch_confirmations
  for select
  using (
    exists (
      select 1 from public.return_batches b
      where b.id = return_launch_confirmations.batch_id
        and b.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

-- return_corrections — mesmo padrão de audit_logs: só admin/super_admin lê;
-- escrita exclusiva das RPCs (correct_return_record/reopen_return_batch).
drop policy if exists return_corrections_select on public.return_corrections;
create policy return_corrections_select on public.return_corrections
  for select
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Auditoria — reaproveita public.audit_logs (nunca uma segunda tabela
-- paralela, ver 0001_init_schema.sql / 0003_audit_triggers.sql).
-- ---------------------------------------------------------------------------
create or replace function public.audit_return_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
    values (coalesce(auth.uid(), new.created_by), 'return_status_changed', 'return', new.id, jsonb_build_object('previous_status', old.status, 'new_status', new.status));
  end if;
  if new.invoice_situation is distinct from old.invoice_situation then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
    values (
      coalesce(auth.uid(), new.created_by),
      'return_invoice_situation_changed',
      'return',
      new.id,
      jsonb_build_object('previous_situation', old.invoice_situation, 'new_situation', new.invoice_situation, 'invoice_number', new.invoice_number)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_return_change on public.returns;
create trigger audit_return_change
  after update on public.returns
  for each row execute function public.audit_return_change();

create or replace function public.audit_return_item_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  acting_user uuid;
  action_name text;
begin
  if tg_op = 'INSERT' then
    acting_user := coalesce(auth.uid(), new.created_by);
    action_name := 'return_item_created';
  elsif tg_op = 'UPDATE' then
    acting_user := coalesce(auth.uid(), new.created_by, old.created_by);
    action_name := 'return_item_updated';
  else
    acting_user := coalesce(auth.uid(), old.created_by);
    action_name := 'return_item_deleted';
  end if;

  insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
  values (
    acting_user,
    action_name,
    'return_item',
    coalesce(new.id, old.id),
    jsonb_build_object(
      'return_id', coalesce(new.return_id, old.return_id),
      'previous_data', case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      'new_data', case when tg_op = 'DELETE' then null else to_jsonb(new) end
    )
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_return_item_change on public.return_items;
create trigger audit_return_item_change
  after insert or update or delete on public.return_items
  for each row execute function public.audit_return_item_change();

create or replace function public.audit_return_batch_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
    values (coalesce(auth.uid(), new.created_by), 'return_batch_status_changed', 'return_batch', new.id, jsonb_build_object('previous_status', old.status, 'new_status', new.status));
  end if;
  return new;
end;
$$;

drop trigger if exists audit_return_batch_change on public.return_batches;
create trigger audit_return_batch_change
  after update on public.return_batches
  for each row execute function public.audit_return_batch_change();

-- ---------------------------------------------------------------------------
-- Storage: fotos de avaria/divergência (opcional — nunca obrigatório pra
-- item vendável, ver pedido seção 6). Qualquer usuário ativo pode enviar a
-- própria foto; só manager/admin exclui.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('return-photos', 'return-photos', false)
on conflict (id) do nothing;

drop policy if exists return_photos_storage_select on storage.objects;
create policy return_photos_storage_select on storage.objects
  for select using (bucket_id = 'return-photos' and public.is_active_user());

drop policy if exists return_photos_storage_insert on storage.objects;
create policy return_photos_storage_insert on storage.objects
  for insert with check (bucket_id = 'return-photos' and public.is_active_user());

drop policy if exists return_photos_storage_delete on storage.objects;
create policy return_photos_storage_delete on storage.objects
  for delete using (bucket_id = 'return-photos' and public.is_manager_or_admin());
