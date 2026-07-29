-- 0042_collab_conference_schema.sql
--
-- EXPANSÃO GOSCAN — Conferência Colaborativa Segura (base de dados).
--
-- Contexto: hoje dois ou mais usuários da mesma empresa já enxergam a MESMA
-- NF e já bipam de forma atomicamente segura (ver 0037-0040), mas o app não
-- tem: (1) forma de dividir o trabalho fisicamente (volume/produto/livre),
-- (2) reserva temporária de produto pra evitar dupla contagem física
-- silenciosa, (3) trilha de auditoria de presença (quem entrou/saiu/assumiu
-- o quê), (4) metadados de origem/dispositivo/correção no evento de bipagem.
-- Esta migration só adiciona estrutura — nenhuma tabela existente é
-- recriada, nenhuma coluna existente muda de sentido.

-- ---------------------------------------------------------------------------
-- 1) invoice_receipts.work_mode — modo de divisão do trabalho, escolhido ao
--    iniciar a contagem (ver nfeConference.ts). Nunca muda sozinho depois de
--    escolhido; só um admin/manager corrigindo manualmente mudaria.
-- ---------------------------------------------------------------------------
alter table public.invoice_receipts
  add column if not exists work_mode text not null default 'free' check (work_mode in ('volume', 'product', 'free'));

comment on column public.invoice_receipts.work_mode is 'Modo de divisão do trabalho da conferência colaborativa: volume (por caixa/pallet/área física), product (reserva temporária por produto), free (livre compartilhado, sem bloqueio automático). Ver record_invoice_count_event() para o efeito de cada modo.';

-- ---------------------------------------------------------------------------
-- 2) invoice_receipt_volumes — identificação simples de um volume físico
--    (Caixa 01, Pallet 02, Área A...). Texto livre de propósito — não é um
--    módulo de WMS, só organiza quem está conferindo o quê fisicamente.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_receipt_volumes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  receipt_id uuid not null references public.invoice_receipts (id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists invoice_receipt_volumes_receipt_id_idx on public.invoice_receipt_volumes (receipt_id);
-- Nunca dois volumes com o mesmo rótulo (case-insensitive) na mesma NF — evita "Caixa 01" e "caixa 01" como volumes distintos por acidente de digitação.
create unique index if not exists invoice_receipt_volumes_receipt_label_key on public.invoice_receipt_volumes (receipt_id, lower(label));

-- company_id sempre derivado do receipt_id no servidor (nunca aceito do
-- cliente) — mesmo padrão de defesa em profundidade de set_invoice_receipt_company_id.
create or replace function public.set_invoice_receipt_volume_company_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.company_id := (select company_id from public.invoice_receipts where id = new.receipt_id);
  return new;
end;
$$;

drop trigger if exists set_invoice_receipt_volume_company_id on public.invoice_receipt_volumes;
create trigger set_invoice_receipt_volume_company_id before insert on public.invoice_receipt_volumes
  for each row execute function public.set_invoice_receipt_volume_company_id();

alter table public.invoice_receipt_volumes enable row level security;

drop policy if exists invoice_receipt_volumes_select on public.invoice_receipt_volumes;
create policy invoice_receipt_volumes_select on public.invoice_receipt_volumes
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

drop policy if exists invoice_receipt_volumes_insert on public.invoice_receipt_volumes;
create policy invoice_receipt_volumes_insert on public.invoice_receipt_volumes
  for insert
  with check (
    company_id = public.current_company_id()
    and created_by = auth.uid()
    and exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_volumes.receipt_id
        and r.company_id = public.current_company_id()
        and r.status in ('not_started', 'in_progress')
    )
  );

-- ---------------------------------------------------------------------------
-- 3) invoice_receipt_item_reservations — reserva TEMPORÁRIA de um item pra
--    um usuário (modo "product"), com expiração automática por heartbeat.
--    Nunca é permanente: um dispositivo fechado sem liberar expira sozinho
--    (ver TTL em record_invoice_count_event/reserve_invoice_receipt_item).
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_receipt_item_reservations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  receipt_id uuid not null references public.invoice_receipts (id) on delete cascade,
  item_id uuid not null references public.invoice_receipt_items (id) on delete cascade,
  volume_id uuid references public.invoice_receipt_volumes (id) on delete set null,
  user_id uuid not null references public.profiles (id),
  device_id text,
  status text not null default 'active' check (status in ('active', 'released', 'expired', 'transferred')),
  reserved_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_reason text
);

-- Nunca duas reservas ATIVAS pro mesmo item ao mesmo tempo — é a garantia
-- estrutural (não só de UI) de "ninguém mais reserva o mesmo produto".
create unique index if not exists invoice_receipt_item_reservations_active_item_key
  on public.invoice_receipt_item_reservations (item_id) where status = 'active';
create index if not exists invoice_receipt_item_reservations_receipt_id_idx on public.invoice_receipt_item_reservations (receipt_id);
create index if not exists invoice_receipt_item_reservations_user_id_idx on public.invoice_receipt_item_reservations (user_id) where status = 'active';

comment on table public.invoice_receipt_item_reservations is 'Reserva temporária de item por usuário no modo "product" — nunca é histórico permanente por si só (ver invoice_receipt_presence_events para a trilha de auditoria real). Escrita só via RPC (reserve_/release_invoice_receipt_item_reservation).';

alter table public.invoice_receipt_item_reservations enable row level security;

drop policy if exists invoice_receipt_item_reservations_select on public.invoice_receipt_item_reservations;
create policy invoice_receipt_item_reservations_select on public.invoice_receipt_item_reservations
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

-- Sem policy de insert/update/delete: só as RPCs (SECURITY DEFINER) escrevem
-- aqui — mesma razão de invoice_item_scan_events (0039): a regra de negócio
-- (expirar, só um dono ativo por vez, transferência) precisa ser aplicada
-- atomicamente dentro de uma transação travada, nunca confiada ao cliente.

-- ---------------------------------------------------------------------------
-- 4) invoice_receipt_presence_events — auditoria PERMANENTE de eventos
--    discretos de colaboração ("Davi entrou", "Victor assumiu X", "Davi
--    saiu"). A presença em si (quem está online AGORA) é temporária, via
--    Supabase Realtime Presence (nunca gravada aqui) — só as TRANSIÇÕES
--    viram um registro auditável e permanente, conforme pedido explícito.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_receipt_presence_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  receipt_id uuid not null references public.invoice_receipts (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  event_type text not null check (event_type in ('joined', 'left', 'assumed_item', 'released_item', 'completed_item', 'disconnected', 'reconnected')),
  item_id uuid references public.invoice_receipt_items (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists invoice_receipt_presence_events_receipt_id_idx on public.invoice_receipt_presence_events (receipt_id, created_at desc);

alter table public.invoice_receipt_presence_events enable row level security;

drop policy if exists invoice_receipt_presence_events_select on public.invoice_receipt_presence_events;
create policy invoice_receipt_presence_events_select on public.invoice_receipt_presence_events
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

-- joined/left/disconnected/reconnected só o próprio dispositivo sabe quando
-- acontecem (ciclo de vida da aba/conexão) — inserção direta do cliente é
-- segura aqui porque é só um registro informativo (nunca afeta quantidade/
-- resultado da conferência) e o CHECK abaixo impede spoofing de empresa/
-- usuário/NF. assumed_item/released_item/completed_item são sempre
-- inseridos PELAS PRÓPRIAS RPCs (nunca pelo cliente direto), porque
-- correspondem a uma ação que já foi validada lá.
create or replace function public.set_invoice_receipt_presence_event_company_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.company_id := (select company_id from public.invoice_receipts where id = new.receipt_id);
  return new;
end;
$$;

drop trigger if exists set_invoice_receipt_presence_event_company_id on public.invoice_receipt_presence_events;
create trigger set_invoice_receipt_presence_event_company_id before insert on public.invoice_receipt_presence_events
  for each row execute function public.set_invoice_receipt_presence_event_company_id();

drop policy if exists invoice_receipt_presence_events_insert on public.invoice_receipt_presence_events;
create policy invoice_receipt_presence_events_insert on public.invoice_receipt_presence_events
  for insert
  with check (
    user_id = auth.uid()
    and event_type in ('joined', 'left', 'disconnected', 'reconnected')
    and exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_presence_events.receipt_id
        and r.company_id = public.current_company_id()
    )
  );

-- ---------------------------------------------------------------------------
-- 5) invoice_item_scan_events — metadados novos (dispositivo/origem/volume/
--    correção/excesso). Todas as colunas são opcionais/com default — eventos
--    já gravados continuam válidos, nenhuma auditoria antiga é reinterpretada.
-- ---------------------------------------------------------------------------
alter table public.invoice_item_scan_events
  add column if not exists device_id text,
  add column if not exists origin text not null default 'manual' check (origin in ('scanner', 'camera', 'manual', 'voice')),
  add column if not exists volume_id uuid references public.invoice_receipt_volumes (id) on delete set null,
  add column if not exists reverses_event_id uuid references public.invoice_item_scan_events (id),
  add column if not exists excess boolean not null default false;

comment on column public.invoice_item_scan_events.reverses_event_id is 'Quando não nulo, este evento é o "desfazer" do evento referenciado (delta_quantity é o inverso) — o evento original NUNCA é apagado/alterado, ver undo_last_invoice_count_event().';
comment on column public.invoice_item_scan_events.excess is 'true quando este evento foi registrado DEPOIS da quantidade esperada da NF já ter sido atingida, com confirmação explícita do operador (ver EXCESS_CONFIRMATION_REQUIRED em record_invoice_count_event).';

create index if not exists invoice_item_scan_events_reverses_event_id_idx on public.invoice_item_scan_events (reverses_event_id) where reverses_event_id is not null;
create index if not exists invoice_item_scan_events_receipt_created_idx on public.invoice_item_scan_events (receipt_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 6) Preferências de som/voz/vibração — por usuário (device-local override)
--    com um padrão opcional definido pela empresa. jsonb simples: schema de
--    preferências pode evoluir sem nova migration a cada campo novo (não é
--    dado consultado por RLS/lógica de negócio, só lido/gravado pelo próprio
--    dono ou pela empresa).
-- ---------------------------------------------------------------------------
alter table public.companies
  add column if not exists default_conference_preferences jsonb not null default '{}'::jsonb;

alter table public.profiles
  add column if not exists conference_preferences jsonb;

comment on column public.profiles.conference_preferences is 'Preferências de som/voz/vibração/comandos de voz deste usuário NESTE dispositivo/conta — nulo = usa o padrão da empresa (companies.default_conference_preferences). Nunca é dado sensível, só UX.';
