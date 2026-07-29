-- 0039_atomic_scan_events.sql
--
-- CORREÇÃO ESTRUTURAL — Concorrência segura (bipagem atômica + idempotência).
--
-- CAUSA RAIZ do risco de perda de bipagem: o fluxo de contagem por EAN em
-- nfeConference.ts calculava `nextQty = (match.physical_quantity ?? 0) + 1`
-- a partir do ESTADO LOCAL EM MEMÓRIA e então sobrescrevia
-- invoice_receipt_items.physical_quantity com esse valor absoluto — ler,
-- somar no frontend, sobrescrever. Se Victor e Davi bipam o mesmo produto
-- quase ao mesmo tempo, os dois podem ler o mesmo valor local (ex.: 5), cada
-- um calcular 6 e escrever 6 — uma das duas bipagens desaparece (deveria
-- ficar 7). A stepper de recontagem (+/-) no fluxo Outlet
-- (conferenceSession.ts updateItemQuantity) tem o mesmo padrão vulnerável.
--
-- Fix: uma função Postgres SECURITY DEFINER por fluxo, que faz o incremento
-- de forma atômica DENTRO do banco (select ... for update trava a linha;
-- ninguém mais lê/escreve a mesma linha até a transação terminar), grava um
-- evento de bipagem imutável (auditoria completa: quem, quando, o quê, quanto)
-- com idempotency_key único — uma mesma tentativa reenviada por falha de rede
-- (mesma chave) nunca é aplicada duas vezes.

-- ---------------------------------------------------------------------------
-- invoice_item_scan_events — NF-e
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_item_scan_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  receipt_id uuid not null references public.invoice_receipts (id) on delete cascade,
  item_id uuid not null references public.invoice_receipt_items (id) on delete cascade,
  product_variant_id uuid references public.product_variants (id),
  ean text,
  sku_code text,
  delta_quantity numeric(14, 3) not null,
  resulting_quantity numeric(14, 3) not null,
  action text not null check (action in ('scan_increment', 'manual_set')),
  performed_by uuid not null references public.profiles (id),
  idempotency_key uuid not null,
  created_at timestamptz not null default now()
);

create unique index if not exists invoice_item_scan_events_idempotency_key_key on public.invoice_item_scan_events (idempotency_key);
create index if not exists invoice_item_scan_events_item_id_idx on public.invoice_item_scan_events (item_id);
create index if not exists invoice_item_scan_events_receipt_id_idx on public.invoice_item_scan_events (receipt_id);

comment on table public.invoice_item_scan_events is 'Evento imutável de bipagem/contagem — 1 linha por tentativa aplicada (nunca sobrescrita). resulting_quantity é o valor de physical_quantity IMEDIATAMENTE após este evento, para reconstrução de histórico/auditoria.';

alter table public.invoice_item_scan_events enable row level security;

drop policy if exists invoice_item_scan_events_select on public.invoice_item_scan_events;
create policy invoice_item_scan_events_select on public.invoice_item_scan_events
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

-- Sem policy de insert/update/delete: o único caminho de escrita é a função
-- abaixo (SECURITY DEFINER, dono é o papel de migração que já tem bypassrls).

create or replace function public.record_invoice_count_event(
  p_item_id uuid,
  p_delta numeric,
  p_mode text,
  p_idempotency_key uuid
)
returns public.invoice_receipt_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.invoice_receipt_items%rowtype;
  v_receipt public.invoice_receipts%rowtype;
  v_caller_company uuid;
  v_new_qty numeric(14, 3);
  v_event_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;
  if p_mode not in ('increment', 'set') then
    raise exception 'Modo de contagem inválido.';
  end if;
  if p_delta is null or (p_mode = 'increment' and p_delta = 0) then
    raise exception 'Quantidade inválida.';
  end if;

  v_caller_company := public.current_company_id();

  -- Trava a linha do item (e da NF) até o fim da transação — concorrente que
  -- tentar bipar o MESMO item espera aqui, nunca lê um valor stale.
  select * into v_item from public.invoice_receipt_items where id = p_item_id for update;
  if not found then
    raise exception 'Item de NF não encontrado.';
  end if;

  select * into v_receipt from public.invoice_receipts where id = v_item.receipt_id for update;
  if not found then
    raise exception 'Nota fiscal não encontrada.';
  end if;

  if v_receipt.company_id is distinct from v_caller_company then
    raise exception 'Acesso negado a esta nota fiscal.';
  end if;

  if v_receipt.status not in ('not_started', 'in_progress') then
    raise exception 'Esta conferência já foi finalizada — novas contagens não são permitidas.';
  end if;

  if p_mode = 'increment' then
    v_new_qty := greatest(0, coalesce(v_item.physical_quantity, 0) + p_delta);
  else
    v_new_qty := greatest(0, p_delta);
  end if;

  -- Idempotência atômica: insert com ON CONFLICT DO NOTHING é uma única
  -- operação no banco — nenhuma janela de corrida entre "checar" e "gravar".
  -- Se a chave já existe (reenvio de rede da MESMA tentativa), não insere de
  -- novo e não reaplica a alteração — devolve o item já no estado atual.
  insert into public.invoice_item_scan_events (
    company_id, receipt_id, item_id, product_variant_id, ean, sku_code,
    delta_quantity, resulting_quantity, action, performed_by, idempotency_key
  )
  values (
    v_receipt.company_id, v_receipt.id, v_item.id, v_item.product_variant_id, v_item.ean, v_item.invoice_product_code,
    p_delta, v_new_qty, case when p_mode = 'increment' then 'scan_increment' else 'manual_set' end, auth.uid(), p_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select * into v_item from public.invoice_receipt_items where id = p_item_id;
    return v_item;
  end if;

  update public.invoice_receipt_items
  set physical_quantity = v_new_qty, status = 'counted', counted_by = auth.uid()
  where id = p_item_id
  returning * into v_item;

  -- Mantém receipt_counts alimentado (histórico já consumido por
  -- listItemCounts()/tela de recontagem) — count_number também calculado
  -- dentro desta mesma transação travada, nunca de uma leitura solta.
  insert into public.receipt_counts (item_id, user_id, quantity, count_number)
  values (
    p_item_id,
    auth.uid(),
    v_new_qty,
    coalesce((select max(count_number) from public.receipt_counts where item_id = p_item_id), 0) + 1
  );

  return v_item;
end;
$$;

revoke all on function public.record_invoice_count_event(uuid, numeric, text, uuid) from public;
grant execute on function public.record_invoice_count_event(uuid, numeric, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- conference_item_scan_events — fluxo Outlet (mesma técnica, mesma razão:
-- a stepper +/- de conferenceSession.ts:updateItemQuantity soma localmente e
-- sobrescreve — dois usuários ajustando o MESMO item concorrentemente podem
-- perder um incremento).
-- ---------------------------------------------------------------------------
create table if not exists public.conference_item_scan_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  conference_id uuid not null references public.conferences (id) on delete cascade,
  item_id uuid not null references public.conference_items (id) on delete cascade,
  product_variant_id uuid references public.product_variants (id),
  delta_quantity integer not null,
  resulting_quantity integer not null,
  performed_by uuid not null references public.profiles (id),
  idempotency_key uuid not null,
  created_at timestamptz not null default now()
);

create unique index if not exists conference_item_scan_events_idempotency_key_key on public.conference_item_scan_events (idempotency_key);
create index if not exists conference_item_scan_events_item_id_idx on public.conference_item_scan_events (item_id);

alter table public.conference_item_scan_events enable row level security;

drop policy if exists conference_item_scan_events_select on public.conference_item_scan_events;
create policy conference_item_scan_events_select on public.conference_item_scan_events
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

create or replace function public.record_conference_item_delta(
  p_item_id uuid,
  p_delta integer,
  p_idempotency_key uuid
)
returns public.conference_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.conference_items%rowtype;
  v_conference public.conferences%rowtype;
  v_caller_company uuid;
  v_new_qty integer;
  v_event_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'Quantidade inválida.';
  end if;

  v_caller_company := public.current_company_id();

  select * into v_item from public.conference_items where id = p_item_id for update;
  if not found then
    raise exception 'Item de conferência não encontrado.';
  end if;

  select * into v_conference from public.conferences where id = v_item.conference_id for update;
  if not found then
    raise exception 'Conferência não encontrada.';
  end if;

  if v_conference.company_id is distinct from v_caller_company then
    raise exception 'Acesso negado a esta conferência.';
  end if;

  if v_conference.status not in ('draft', 'in_progress') then
    raise exception 'Esta conferência já foi finalizada — novos ajustes não são permitidos.';
  end if;

  v_new_qty := greatest(1, coalesce(v_item.quantity, 0) + p_delta);

  insert into public.conference_item_scan_events (company_id, conference_id, item_id, product_variant_id, delta_quantity, resulting_quantity, performed_by, idempotency_key)
  values (v_conference.company_id, v_conference.id, v_item.id, v_item.product_variant_id, p_delta, v_new_qty, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select * into v_item from public.conference_items where id = p_item_id;
    return v_item;
  end if;

  update public.conference_items
  set quantity = v_new_qty
  where id = p_item_id
  returning * into v_item;

  return v_item;
end;
$$;

revoke all on function public.record_conference_item_delta(uuid, integer, uuid) from public;
grant execute on function public.record_conference_item_delta(uuid, integer, uuid) to authenticated;
