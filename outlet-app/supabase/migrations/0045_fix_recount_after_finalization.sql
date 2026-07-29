-- 0045_fix_recount_after_finalization.sql
--
-- HOTFIX — BUG REAL pré-existente encontrado durante a implementação da
-- Conferência Colaborativa: record_invoice_count_event() (0039, reescrita em
-- 0043) e undo_last_invoice_count_event() (0043) bloqueiam INCONDICIONALMENTE
-- qualquer chamada quando a NF não está em ('not_started', 'in_progress').
-- Mas a tela de resultado ("Recontar", ver nfeConference.ts:wireRecountButtons)
-- SÓ aparece justamente quando a NF já está 'completed'/'with_divergences' —
-- ou seja, desde que submitCount() passou a rotear pela RPC atômica (0039,
-- tarefa da sessão anterior), TODA recontagem depois de finalizar uma NF
-- vinha lançando "Esta conferência já foi finalizada" e falhando, mesmo pra
-- manager/admin. As policies de RLS já prevêem esse caso
-- (invoice_receipt_items_update: "... or is_manager_or_admin()") — as RPCs
-- não acompanhavam essa mesma regra.
--
-- Fix: manager/admin pode registrar contagem/desfazer mesmo com a NF
-- fechada (correção administrativa — mesma regra de sempre nesta base).
-- Operador comum continua bloqueado (nunca conta ou desfaz numa NF fechada).
create or replace function public.record_invoice_count_event(
  p_item_id uuid,
  p_delta numeric,
  p_mode text,
  p_idempotency_key uuid,
  p_device_id text default null,
  p_origin text default 'manual',
  p_volume_id uuid default null,
  p_confirm_excess boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.invoice_receipt_items%rowtype;
  v_receipt public.invoice_receipts%rowtype;
  v_caller_company uuid;
  v_caller_name text;
  v_new_qty numeric(14, 3);
  v_event_id uuid;
  v_now timestamptz := now();
  v_ttl interval := interval '90 seconds';
  v_res_id uuid;
  v_res_user_id uuid;
  v_res_user_name text;
  v_res_since timestamptz;
  v_res_heartbeat timestamptz;
  v_res_expires timestamptz;
  v_was_complete boolean;
  v_is_complete boolean;
  v_first_completion boolean := false;
  v_excess_amount numeric(14, 3) := 0;
  v_completer_name text;
  v_completed_at timestamptz;
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
  if p_origin not in ('scanner', 'camera', 'manual', 'voice') then
    raise exception 'Origem de bipagem inválida.';
  end if;

  v_caller_company := public.current_company_id();
  select full_name into v_caller_name from public.profiles where id = auth.uid();

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

  -- FIX 0045: manager/admin pode recontar mesmo com a NF já finalizada
  -- (correção administrativa) — operador comum continua bloqueado.
  if v_receipt.status not in ('not_started', 'in_progress') and not public.is_manager_or_admin() then
    raise exception 'Esta conferência já foi finalizada — novas contagens não são permitidas.';
  end if;

  if v_receipt.work_mode = 'product' then
    select id, user_id, reserved_at, last_heartbeat_at, expires_at
      into v_res_id, v_res_user_id, v_res_since, v_res_heartbeat, v_res_expires
      from public.invoice_receipt_item_reservations
      where item_id = p_item_id and status = 'active'
      for update;

    if v_res_id is not null and v_res_expires <= v_now then
      update public.invoice_receipt_item_reservations
        set status = 'expired', released_reason = 'ttl_expired'
        where id = v_res_id;
      v_res_id := null;
    end if;

    if v_res_id is not null and v_res_user_id is distinct from auth.uid() then
      select full_name into v_res_user_name from public.profiles where id = v_res_user_id;
      return jsonb_build_object(
        'success', false,
        'code', 'RESERVATION_CONFLICT',
        'reservation', jsonb_build_object(
          'userId', v_res_user_id,
          'fullName', coalesce(v_res_user_name, 'Outro operador'),
          'since', v_res_since,
          'lastActivity', v_res_heartbeat
        )
      );
    end if;

    if v_res_id is not null then
      update public.invoice_receipt_item_reservations
        set last_heartbeat_at = v_now, expires_at = v_now + v_ttl, device_id = coalesce(p_device_id, device_id), volume_id = coalesce(p_volume_id, volume_id)
        where id = v_res_id;
    else
      insert into public.invoice_receipt_item_reservations
        (company_id, receipt_id, item_id, volume_id, user_id, device_id, status, reserved_at, last_heartbeat_at, expires_at)
      values
        (v_receipt.company_id, v_receipt.id, p_item_id, p_volume_id, auth.uid(), p_device_id, 'active', v_now, v_now, v_now + v_ttl);

      insert into public.invoice_receipt_presence_events (company_id, receipt_id, user_id, event_type, item_id, metadata)
      values (v_receipt.company_id, v_receipt.id, auth.uid(), 'assumed_item', p_item_id, jsonb_build_object('itemDescription', coalesce(v_item.description, v_item.invoice_product_code)));
    end if;
  end if;

  v_was_complete := v_item.expected_quantity > 0 and coalesce(v_item.physical_quantity, 0) >= v_item.expected_quantity;

  if p_mode = 'increment' then
    v_new_qty := greatest(0, coalesce(v_item.physical_quantity, 0) + p_delta);
  else
    v_new_qty := greatest(0, p_delta);
  end if;

  if v_item.expected_quantity > 0 and v_new_qty > v_item.expected_quantity and not p_confirm_excess then
    select p.full_name, e.created_at
      into v_completer_name, v_completed_at
      from public.invoice_item_scan_events e
      join public.profiles p on p.id = e.performed_by
      where e.item_id = p_item_id and e.resulting_quantity >= v_item.expected_quantity
      order by e.created_at asc
      limit 1;

    return jsonb_build_object(
      'success', false,
      'code', 'EXCESS_CONFIRMATION_REQUIRED',
      'currentTotal', coalesce(v_item.physical_quantity, 0),
      'attemptedTotal', v_new_qty,
      'expectedQuantity', v_item.expected_quantity,
      'completedBy', v_completer_name,
      'completedAt', v_completed_at
    );
  end if;

  insert into public.invoice_item_scan_events (
    company_id, receipt_id, item_id, product_variant_id, ean, sku_code,
    delta_quantity, resulting_quantity, action, performed_by, idempotency_key,
    device_id, origin, volume_id, excess
  )
  values (
    v_receipt.company_id, v_receipt.id, v_item.id, v_item.product_variant_id, v_item.ean, v_item.invoice_product_code,
    p_delta, v_new_qty, case when p_mode = 'increment' then 'scan_increment' else 'manual_set' end, auth.uid(), p_idempotency_key,
    p_device_id, p_origin, p_volume_id, (v_item.expected_quantity > 0 and v_new_qty > v_item.expected_quantity)
  )
  on conflict (idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select * into v_item from public.invoice_receipt_items where id = p_item_id;
    v_is_complete := v_item.expected_quantity > 0 and coalesce(v_item.physical_quantity, 0) >= v_item.expected_quantity;
    return jsonb_build_object(
      'success', true,
      'code', 'OK',
      'item', to_jsonb(v_item),
      'newTotal', v_item.physical_quantity,
      'expectedQuantity', v_item.expected_quantity,
      'remaining', greatest(0, v_item.expected_quantity - coalesce(v_item.physical_quantity, 0)),
      'itemCompleted', v_is_complete,
      'firstCompletion', false,
      'excess', greatest(0, coalesce(v_item.physical_quantity, 0) - v_item.expected_quantity),
      'performedBy', v_caller_name,
      'eventId', null
    );
  end if;

  update public.invoice_receipt_items
  set physical_quantity = v_new_qty, status = 'counted', counted_by = auth.uid()
  where id = p_item_id
  returning * into v_item;

  insert into public.receipt_counts (item_id, user_id, quantity, count_number)
  values (
    p_item_id,
    auth.uid(),
    v_new_qty,
    coalesce((select max(count_number) from public.receipt_counts where item_id = p_item_id), 0) + 1
  );

  v_is_complete := v_item.expected_quantity > 0 and v_new_qty >= v_item.expected_quantity;
  v_first_completion := v_is_complete and not v_was_complete;
  v_excess_amount := greatest(0, v_new_qty - v_item.expected_quantity);

  if v_first_completion and v_receipt.work_mode = 'product' then
    update public.invoice_receipt_item_reservations
      set status = 'released', released_reason = 'item_completed'
      where item_id = p_item_id and status = 'active';

    insert into public.invoice_receipt_presence_events (company_id, receipt_id, user_id, event_type, item_id, metadata)
    values (v_receipt.company_id, v_receipt.id, auth.uid(), 'completed_item', p_item_id, jsonb_build_object('itemDescription', coalesce(v_item.description, v_item.invoice_product_code)));
  end if;

  return jsonb_build_object(
    'success', true,
    'code', 'OK',
    'item', to_jsonb(v_item),
    'newTotal', v_item.physical_quantity,
    'expectedQuantity', v_item.expected_quantity,
    'remaining', greatest(0, v_item.expected_quantity - v_new_qty),
    'itemCompleted', v_is_complete,
    'firstCompletion', v_first_completion,
    'excess', v_excess_amount,
    'performedBy', v_caller_name,
    'eventId', v_event_id
  );
end;
$$;

-- Mesma correção em undo_last_invoice_count_event (manager/admin já podia
-- desfazer QUALQUER evento, mas ainda batia no bloqueio de status da NF).
create or replace function public.undo_last_invoice_count_event(
  p_event_id uuid,
  p_idempotency_key uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.invoice_item_scan_events%rowtype;
  v_item public.invoice_receipt_items%rowtype;
  v_receipt public.invoice_receipts%rowtype;
  v_is_manager boolean;
  v_already_reversed boolean;
  v_latest_event_id uuid;
  v_new_qty numeric(14, 3);
  v_new_event_id uuid;
  v_caller_name text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;

  v_is_manager := public.is_manager_or_admin();
  select full_name into v_caller_name from public.profiles where id = auth.uid();

  select * into v_event from public.invoice_item_scan_events where id = p_event_id;
  if not found then
    raise exception 'Evento de bipagem não encontrado.';
  end if;

  if v_event.company_id is distinct from public.current_company_id() then
    raise exception 'Acesso negado a este evento.';
  end if;

  if not v_is_manager and v_event.performed_by is distinct from auth.uid() then
    raise exception 'Você só pode desfazer suas próprias bipagens.';
  end if;

  if v_event.reverses_event_id is not null then
    raise exception 'Não é possível desfazer uma correção — desfaça diretamente o evento original, se ainda permitido.';
  end if;

  select exists(select 1 from public.invoice_item_scan_events where reverses_event_id = p_event_id) into v_already_reversed;
  if v_already_reversed then
    raise exception 'Esta bipagem já foi desfeita anteriormente.';
  end if;

  if not v_is_manager then
    select se.id into v_latest_event_id
      from public.invoice_item_scan_events se
      where se.item_id = v_event.item_id
        and se.performed_by = auth.uid()
        and se.reverses_event_id is null
        and not exists (select 1 from public.invoice_item_scan_events e2 where e2.reverses_event_id = se.id)
      order by se.created_at desc
      limit 1;
    if v_latest_event_id is distinct from p_event_id then
      raise exception 'Só é possível desfazer a sua bipagem mais recente neste item.';
    end if;
  end if;

  select * into v_item from public.invoice_receipt_items where id = v_event.item_id for update;
  if not found then
    raise exception 'Item de NF não encontrado.';
  end if;

  select * into v_receipt from public.invoice_receipts where id = v_item.receipt_id for update;
  if not found then
    raise exception 'Nota fiscal não encontrada.';
  end if;

  -- FIX 0045: manager/admin pode desfazer mesmo com a NF já finalizada.
  if v_receipt.status not in ('not_started', 'in_progress') and not v_is_manager then
    raise exception 'Esta conferência já foi finalizada — não é mais possível desfazer bipagens.';
  end if;

  v_new_qty := greatest(0, coalesce(v_item.physical_quantity, 0) - v_event.delta_quantity);

  insert into public.invoice_item_scan_events (
    company_id, receipt_id, item_id, product_variant_id, ean, sku_code,
    delta_quantity, resulting_quantity, action, performed_by, idempotency_key,
    device_id, origin, reverses_event_id
  )
  values (
    v_receipt.company_id, v_receipt.id, v_item.id, v_item.product_variant_id, v_item.ean, v_item.invoice_product_code,
    -v_event.delta_quantity, v_new_qty, v_event.action, auth.uid(), p_idempotency_key,
    v_event.device_id, 'manual', p_event_id
  )
  on conflict (idempotency_key) do nothing
  returning id into v_new_event_id;

  if v_new_event_id is null then
    select * into v_item from public.invoice_receipt_items where id = v_event.item_id;
    return jsonb_build_object('success', true, 'code', 'OK', 'item', to_jsonb(v_item), 'newTotal', v_item.physical_quantity, 'undoneEventId', p_event_id, 'eventId', null);
  end if;

  update public.invoice_receipt_items
  set physical_quantity = v_new_qty, status = 'counted'
  where id = v_item.id
  returning * into v_item;

  insert into public.receipt_counts (item_id, user_id, quantity, count_number)
  values (
    v_item.id, auth.uid(), v_new_qty,
    coalesce((select max(count_number) from public.receipt_counts where item_id = v_item.id), 0) + 1
  );

  return jsonb_build_object(
    'success', true,
    'code', 'OK',
    'item', to_jsonb(v_item),
    'newTotal', v_item.physical_quantity,
    'expectedQuantity', v_item.expected_quantity,
    'performedBy', v_caller_name,
    'undoneEventId', p_event_id,
    'eventId', v_new_event_id
  );
end;
$$;

-- finalize_invoice_receipt_atomic ganha um modo explícito de RECOMPUTO: sem
-- ele, o comportamento de "impedir dupla finalização" continua IDÊNTICO e
-- incondicional (qualquer um que chegar depois do 1º commit recebe
-- ALREADY_FINALIZED, não importa o papel — é assim que o cenário de
-- concorrência real testado nesta sessão continua protegido). Com
-- p_recompute=true E manager/admin, permite recalcular status/snapshot de
-- uma NF JÁ finalizada — exatamente o que "Recontar" (nfeConference.ts)
-- precisa depois de uma recontagem administrativa.
-- Assinatura muda (ganha p_recompute) — precisa DROP explícito, senão as duas
-- versões (1 e 2 argumentos) coexistiriam e criariam ambiguidade de overload
-- pro PostgREST resolver por nome+argumentos nomeados.
drop function if exists public.finalize_invoice_receipt_atomic(uuid);

create or replace function public.finalize_invoice_receipt_atomic(
  p_receipt_id uuid,
  p_recompute boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.invoice_receipts%rowtype;
  v_all_ok boolean;
  v_new_status text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;

  select * into v_receipt from public.invoice_receipts where id = p_receipt_id for update;
  if not found then
    raise exception 'Nota fiscal não encontrada.';
  end if;

  if v_receipt.company_id is distinct from public.current_company_id() then
    raise exception 'Acesso negado a esta nota fiscal.';
  end if;

  if v_receipt.status not in ('not_started', 'in_progress') then
    if not (p_recompute and public.is_manager_or_admin()) then
      return jsonb_build_object(
        'success', false,
        'code', 'ALREADY_FINALIZED',
        'finishedBy', v_receipt.finished_by,
        'finishedAt', v_receipt.finished_at,
        'status', v_receipt.status
      );
    end if;
    -- manager/admin com p_recompute=true: segue em frente pra recalcular
    -- (correção administrativa explícita, nunca o caminho de uma
    -- finalização concorrente comum — essa continua bloqueada acima).
  end if;

  update public.invoice_receipt_items it
  set
    linked_sku_code = coalesce(pv.sku_code, it.linked_sku_code),
    linked_product_name = coalesce(pr.name, it.linked_product_name),
    linked_ean = coalesce(pv.gtin, it.linked_ean),
    status = case
      when it.physical_quantity is null then 'pending'
      when it.physical_quantity = it.expected_quantity then 'ok'
      when it.physical_quantity < it.expected_quantity then 'missing'
      else 'surplus'
    end
  from public.product_variants pv
  left join public.products pr on pr.id = pv.product_id
  where it.receipt_id = p_receipt_id and it.product_variant_id = pv.id;

  update public.invoice_receipt_items
  set status = 'unlinked'
  where receipt_id = p_receipt_id and product_variant_id is null;

  select
    not exists (
      select 1 from public.invoice_receipt_items
      where receipt_id = p_receipt_id and status in ('missing', 'surplus', 'pending', 'unlinked')
    )
    into v_all_ok;

  v_new_status := case when v_all_ok then 'completed' else 'with_divergences' end;

  update public.invoice_receipts
  set status = v_new_status, finished_at = now(), finished_by = auth.uid()
  where id = p_receipt_id;

  update public.invoice_receipt_item_reservations
  set status = 'released', released_reason = 'receipt_finalized'
  where receipt_id = p_receipt_id and status = 'active';

  return jsonb_build_object('success', true, 'code', 'OK', 'status', v_new_status);
end;
$$;

revoke all on function public.finalize_invoice_receipt_atomic(uuid, boolean) from public;
grant execute on function public.finalize_invoice_receipt_atomic(uuid, boolean) to authenticated;
