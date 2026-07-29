-- 0043_collab_conference_rpcs.sql
--
-- EXPANSÃO GOSCAN — Conferência Colaborativa Segura (RPCs).
--
-- Reescreve record_invoice_count_event (0039) pra devolver um resultado RICO
-- (sucesso/total/restante/concluído/excesso/quem realizou — ver seção 9 do
-- pedido) e pra aplicar as duas regras novas de segurança de colaboração:
--   1) Reserva por produto (modo "product"): a 1ª bipagem de um item reserva
--      o item pra quem bipou; outra pessoa bipando o MESMO item enquanto a
--      reserva está ativa recebe um conflito estruturado, NUNCA uma
--      contagem física real dupla registrada silenciosamente.
--   2) Confirmação de excesso: se a bipagem levaria o total além da
--      quantidade esperada da NF, nada é gravado até confirmação explícita
--      (reenvio com p_confirm_excess=true) — e o servidor recalcula tudo de
--      novo nesse reenvio, porque outro operador pode ter bipado no meio-tempo.
--
-- O retorno muda de "linha da tabela" pra jsonb — precisa DROP (não só
-- CREATE OR REPLACE) porque o tipo de retorno muda de verdade.
drop function if exists public.record_invoice_count_event(uuid, numeric, text, uuid);

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

  -- Trava a linha do item (e da NF) até o fim da transação — igual 0039.
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

  -- ------------------------------------------------------------------
  -- Reserva por produto — só no modo "product". Volume/livre nunca bloqueiam
  -- aqui (ver seções 7.1/7.3 do pedido: volume nunca bloqueia o mesmo SKU em
  -- volumes diferentes; livre só alerta visualmente via presença, nunca com
  -- bloqueio automático no servidor).
  -- ------------------------------------------------------------------
  if v_receipt.work_mode = 'product' then
    select id, user_id, reserved_at, last_heartbeat_at, expires_at
      into v_res_id, v_res_user_id, v_res_since, v_res_heartbeat, v_res_expires
      from public.invoice_receipt_item_reservations
      where item_id = p_item_id and status = 'active'
      for update;

    if v_res_id is not null and v_res_expires <= v_now then
      -- Expiração preguiçosa: ninguém "varre" reservas vencidas em background,
      -- a própria próxima tentativa de bipar/reservar libera sozinha.
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

  -- ------------------------------------------------------------------
  -- Excesso — nunca registrado silenciosamente (seção 12 do pedido). Se
  -- ainda não confirmado, devolve os dados pra o operador decidir e NÃO
  -- grava nada (nem evento, nem quantidade) — o reenvio com
  -- p_confirm_excess=true refaz TODO o cálculo do zero (outro operador pode
  -- ter bipado nesse intervalo).
  -- ------------------------------------------------------------------
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

  -- Idempotência atômica: mesma técnica de 0039 (insert...on conflict do nothing).
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
    -- Item concluído libera a reserva sozinho — não há mais o que proteger.
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

revoke all on function public.record_invoice_count_event(uuid, numeric, text, uuid, text, text, uuid, boolean) from public;
grant execute on function public.record_invoice_count_event(uuid, numeric, text, uuid, text, text, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- reserve_invoice_receipt_item — reserva explícita (usada quando o operador
-- ABRE/toca um produto pra contar, antes mesmo de bipar — dá o aviso
-- "Produto em conferência" o quanto antes possível, não só no momento do bip).
-- ---------------------------------------------------------------------------
create or replace function public.reserve_invoice_receipt_item(
  p_item_id uuid,
  p_device_id text default null,
  p_volume_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.invoice_receipt_items%rowtype;
  v_receipt public.invoice_receipts%rowtype;
  v_now timestamptz := now();
  v_ttl interval := interval '90 seconds';
  v_res_id uuid;
  v_res_user_id uuid;
  v_res_user_name text;
  v_res_since timestamptz;
  v_res_heartbeat timestamptz;
  v_res_expires timestamptz;
  v_reservation_row public.invoice_receipt_item_reservations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;

  select * into v_item from public.invoice_receipt_items where id = p_item_id for update;
  if not found then
    raise exception 'Item de NF não encontrado.';
  end if;

  select * into v_receipt from public.invoice_receipts where id = v_item.receipt_id for update;
  if not found then
    raise exception 'Nota fiscal não encontrada.';
  end if;

  if v_receipt.company_id is distinct from public.current_company_id() then
    raise exception 'Acesso negado a esta nota fiscal.';
  end if;
  if v_receipt.status not in ('not_started', 'in_progress') then
    raise exception 'Esta conferência já foi finalizada.';
  end if;
  if v_receipt.work_mode is distinct from 'product' then
    raise exception 'Reserva de produto só se aplica no modo de conferência por produto.';
  end if;

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
      where id = v_res_id
      returning * into v_reservation_row;
  else
    insert into public.invoice_receipt_item_reservations
      (company_id, receipt_id, item_id, volume_id, user_id, device_id, status, reserved_at, last_heartbeat_at, expires_at)
    values
      (v_receipt.company_id, v_receipt.id, p_item_id, p_volume_id, auth.uid(), p_device_id, 'active', v_now, v_now, v_now + v_ttl)
    returning * into v_reservation_row;

    insert into public.invoice_receipt_presence_events (company_id, receipt_id, user_id, event_type, item_id, metadata)
    values (v_receipt.company_id, v_receipt.id, auth.uid(), 'assumed_item', p_item_id, jsonb_build_object('itemDescription', coalesce(v_item.description, v_item.invoice_product_code)));
  end if;

  return jsonb_build_object(
    'success', true,
    'code', 'OK',
    'reservation', jsonb_build_object(
      'id', v_reservation_row.id,
      'itemId', v_reservation_row.item_id,
      'userId', v_reservation_row.user_id,
      'expiresAt', v_reservation_row.expires_at
    )
  );
end;
$$;

revoke all on function public.reserve_invoice_receipt_item(uuid, text, uuid) from public;
grant execute on function public.reserve_invoice_receipt_item(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- heartbeat_invoice_receipt_item_reservation — renovação periódica enquanto o
-- operador continua na tela do produto (ver seção 8 do pedido).
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat_invoice_receipt_item_reservation(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated public.invoice_receipt_item_reservations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;

  update public.invoice_receipt_item_reservations
  set last_heartbeat_at = now(), expires_at = now() + interval '90 seconds'
  where id = p_reservation_id and user_id = auth.uid() and status = 'active'
  returning * into v_updated;

  if v_updated.id is null then
    return jsonb_build_object('success', false, 'code', 'RESERVATION_LOST');
  end if;

  return jsonb_build_object('success', true, 'code', 'OK', 'expiresAt', v_updated.expires_at);
end;
$$;

revoke all on function public.heartbeat_invoice_receipt_item_reservation(uuid) from public;
grant execute on function public.heartbeat_invoice_receipt_item_reservation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- release_invoice_receipt_item_reservation — liberação explícita (operador
-- mudou de produto/volume, ou saiu da conferência) ou "liberação por
-- supervisor" (manager/admin libera antes do TTL natural, ver seção 8).
-- ---------------------------------------------------------------------------
create or replace function public.release_invoice_receipt_item_reservation(
  p_item_id uuid,
  p_reason text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.invoice_receipt_item_reservations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;

  select * into v_reservation
    from public.invoice_receipt_item_reservations
    where item_id = p_item_id and status = 'active'
    for update;

  if not found then
    return jsonb_build_object('success', true, 'code', 'OK', 'note', 'Nenhuma reserva ativa para liberar.');
  end if;

  if v_reservation.company_id is distinct from public.current_company_id() then
    raise exception 'Acesso negado.';
  end if;

  if v_reservation.user_id is distinct from auth.uid() and not public.is_manager_or_admin() then
    raise exception 'Só o próprio operador ou um gerente/administrador pode liberar esta reserva.';
  end if;

  update public.invoice_receipt_item_reservations
    set status = 'released', released_reason = coalesce(p_reason, 'manual')
    where id = v_reservation.id;

  insert into public.invoice_receipt_presence_events (company_id, receipt_id, user_id, event_type, item_id, metadata)
  values (v_reservation.company_id, v_reservation.receipt_id, auth.uid(), 'released_item', p_item_id, jsonb_build_object('reason', coalesce(p_reason, 'manual'), 'wasHeldBy', v_reservation.user_id));

  return jsonb_build_object('success', true, 'code', 'OK');
end;
$$;

revoke all on function public.release_invoice_receipt_item_reservation(uuid, text) from public;
grant execute on function public.release_invoice_receipt_item_reservation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- undo_last_invoice_count_event — "Desfazer minha última bipagem" (seção 13).
-- NUNCA apaga o evento original: grava um evento compensatório (delta
-- invertido) referenciando-o via reverses_event_id. Operador só desfaz a
-- PRÓPRIA ação mais recente (ainda não desfeita) no item; manager/admin pode
-- desfazer qualquer evento (correção administrativa).
-- ---------------------------------------------------------------------------
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

  if v_receipt.status not in ('not_started', 'in_progress') then
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

revoke all on function public.undo_last_invoice_count_event(uuid, uuid, text) from public;
grant execute on function public.undo_last_invoice_count_event(uuid, uuid, text) to authenticated;
