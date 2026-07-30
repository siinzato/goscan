-- 0048_returns_rpcs.sql
--
-- RPCs atômicas do módulo Devolução — mesmo padrão SECURITY DEFINER +
-- `for update` (trava a(s) linha(s) até o fim da transação) já usado em
-- record_invoice_count_event/record_conference_item_delta (0039): nenhuma
-- regra de negócio de estado/consolidação fica duplicada no cliente.

-- ---------------------------------------------------------------------------
-- send_return_batch_to_logistics — consolida N devoluções num lote único por
-- SKU. Só entra na consolidação (libera pra estoque) item classificado
-- "vendável" cuja nota NÃO esteja "pendente_cancelamento" (ver pedido, seção
-- 7: "Itens com nota pendente ou aguardando análise não podem entrar nas
-- quantidades liberadas para estoque").
-- ---------------------------------------------------------------------------
create or replace function public.send_return_batch_to_logistics(p_return_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_company uuid;
  v_batch_id uuid;
  v_found_count integer;
  v_item_count integer;
  v_total_returns integer;
  v_total_skus integer;
  v_total_units integer;
  rec record;
  v_batch_item_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;
  if p_return_ids is null or array_length(p_return_ids, 1) is null then
    raise exception 'Selecione ao menos uma devolução para enviar.';
  end if;

  v_caller_company := public.current_company_id();

  -- Trava todas as devoluções selecionadas até o fim da transação — duas
  -- pessoas não conseguem enviar o mesmo conjunto (parcialmente sobreposto)
  -- pra dois lotes diferentes ao mesmo tempo.
  perform 1 from public.returns where id = any(p_return_ids) for update;

  select count(*) into v_found_count from public.returns where id = any(p_return_ids);
  if v_found_count <> array_length(p_return_ids, 1) then
    raise exception 'Uma ou mais devoluções selecionadas não foram encontradas.';
  end if;

  if exists (select 1 from public.returns where id = any(p_return_ids) and company_id is distinct from v_caller_company) then
    raise exception 'Acesso negado a uma ou mais devoluções selecionadas.';
  end if;

  if exists (
    select 1 from public.returns
    where id = any(p_return_ids)
      and status not in ('em_registro', 'aguardando_avaliacao', 'pendente_cancelamento_nota', 'pronta_logistica', 'com_pendencias')
  ) then
    raise exception 'Uma ou mais devoluções já foram enviadas, concluídas ou canceladas.';
  end if;

  select count(*) into v_item_count from public.return_items where return_id = any(p_return_ids);
  if v_item_count = 0 then
    raise exception 'Nenhum produto registrado nas devoluções selecionadas.';
  end if;

  insert into public.return_batches (created_by) values (auth.uid()) returning id into v_batch_id;

  update public.returns
  set status = 'enviada_logistica', batch_id = v_batch_id, sent_to_logistics_at = now(), sent_to_logistics_by = auth.uid()
  where id = any(p_return_ids);

  -- Consolida por product_variant_id: 1 linha em return_batch_items por SKU,
  -- com o detalhamento de origem em return_batch_sources (nunca só o total).
  for rec in (
    select ri.product_variant_id as pvid, sum(ri.quantity)::integer as qty
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    where r.id = any(p_return_ids)
      and ri.classification = 'vendavel'
      and r.invoice_situation <> 'pendente_cancelamento'
      and ri.product_variant_id is not null
    group by ri.product_variant_id
  ) loop
    insert into public.return_batch_items (batch_id, product_variant_id, total_quantity)
    values (v_batch_id, rec.pvid, rec.qty)
    returning id into v_batch_item_id;

    insert into public.return_batch_sources (batch_item_id, return_item_id, quantity)
    select v_batch_item_id, ri.id, ri.quantity
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    where r.id = any(p_return_ids)
      and ri.product_variant_id = rec.pvid
      and ri.classification = 'vendavel'
      and r.invoice_situation <> 'pendente_cancelamento';
  end loop;

  select count(*) into v_total_skus from public.return_batch_items where batch_id = v_batch_id;
  select coalesce(sum(total_quantity), 0) into v_total_units from public.return_batch_items where batch_id = v_batch_id;
  select count(distinct id) into v_total_returns from public.returns where id = any(p_return_ids);

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'total_returns', v_total_returns,
    'total_skus', v_total_skus,
    'total_units', v_total_units
  );
end;
$$;

revoke all on function public.send_return_batch_to_logistics(uuid[]) from public;
grant execute on function public.send_return_batch_to_logistics(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- confirm_return_batch_tiny_launch — confirmação MANUAL (nunca lança
-- estoque de verdade). Idempotente: um lote já lançado nunca é lançado de
-- novo (ver pedido, seção 9: "impedir que o mesmo lote seja lançado
-- novamente").
-- ---------------------------------------------------------------------------
create or replace function public.confirm_return_batch_tiny_launch(
  p_batch_id uuid,
  p_warehouse text,
  p_launched_at timestamptz,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch public.return_batches%rowtype;
  v_caller_company uuid;
  v_quantities jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;
  if p_warehouse is null or length(trim(p_warehouse)) = 0 then
    raise exception 'Informe o depósito utilizado.';
  end if;
  if p_launched_at is null then
    raise exception 'Informe a data do lançamento.';
  end if;

  v_caller_company := public.current_company_id();

  select * into v_batch from public.return_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Lote não encontrado.';
  end if;
  if v_batch.company_id is distinct from v_caller_company then
    raise exception 'Acesso negado a este lote.';
  end if;
  if v_batch.status <> 'aguardando_lancamento' then
    raise exception 'Este lote já foi lançado — não é possível confirmar novamente.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_variant_id', bi.product_variant_id,
    'sku_code', pv.sku_code,
    'gtin', pv.gtin,
    'produto', p.name,
    'quantity', bi.total_quantity
  )), '[]'::jsonb)
  into v_quantities
  from public.return_batch_items bi
  join public.product_variants pv on pv.id = bi.product_variant_id
  join public.products p on p.id = pv.product_id
  where bi.batch_id = p_batch_id;

  insert into public.return_launch_confirmations (batch_id, warehouse, launched_at, note, confirmed_by, confirmed_quantities)
  values (p_batch_id, trim(p_warehouse), p_launched_at, nullif(trim(coalesce(p_note, '')), ''), auth.uid(), v_quantities);

  update public.return_batches set status = 'concluida' where id = p_batch_id;
  update public.returns set status = 'concluida' where batch_id = p_batch_id and status = 'enviada_logistica';

  return jsonb_build_object('batch_id', p_batch_id, 'confirmed_quantities', v_quantities);
end;
$$;

revoke all on function public.confirm_return_batch_tiny_launch(uuid, text, timestamptz, text) from public;
grant execute on function public.confirm_return_batch_tiny_launch(uuid, text, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- reopen_return_batch — só admin/super_admin (ver pedido, seção 9: "Somente
-- administradores ou usuários autorizados podem reabrir um lote já
-- concluído"). Nunca apaga nada — o registro de conclusão original
-- (return_launch_confirmations) permanece intacto; a reabertura fica gravada
-- em return_corrections com o motivo.
-- ---------------------------------------------------------------------------
create or replace function public.reopen_return_batch(p_batch_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch public.return_batches%rowtype;
  v_caller_company uuid;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_manager_or_admin() then
    raise exception 'Apenas administradores podem reabrir um lote concluído.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Informe o motivo da reabertura.';
  end if;

  v_caller_company := public.current_company_id();

  select * into v_batch from public.return_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Lote não encontrado.';
  end if;
  if v_batch.company_id is distinct from v_caller_company then
    raise exception 'Acesso negado a este lote.';
  end if;
  if v_batch.status <> 'concluida' then
    raise exception 'Somente um lote concluído pode ser reaberto.';
  end if;

  update public.return_batches set status = 'aguardando_lancamento' where id = p_batch_id;
  update public.returns set status = 'enviada_logistica' where batch_id = p_batch_id and status = 'concluida';

  insert into public.return_corrections (entity_type, entity_id, field_name, previous_value, new_value, reason, corrected_by)
  values ('return_batch', p_batch_id, 'status', 'concluida', 'aguardando_lancamento', p_reason, auth.uid());
end;
$$;

revoke all on function public.reopen_return_batch(uuid, text) from public;
grant execute on function public.reopen_return_batch(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- correct_return_record — único caminho pra alterar um campo de `returns`/
-- `return_items` depois que o registro deixou os status de edição livre
-- (ver RLS de returns_update/return_items_update em 0047). Sempre exige
-- motivo e sempre grava em return_corrections (antes/depois/motivo/usuário/
-- data) — nunca sobrescreve silenciosamente.
-- ---------------------------------------------------------------------------
create or replace function public.correct_return_record(
  p_entity_type text,
  p_entity_id uuid,
  p_field text,
  p_new_value text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_company uuid;
  v_previous_value text;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_manager_or_admin() then
    raise exception 'Apenas administradores podem corrigir um registro já enviado.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Informe o motivo da correção.';
  end if;

  v_caller_company := public.current_company_id();

  if p_entity_type = 'return' then
    if not exists (select 1 from public.returns where id = p_entity_id and company_id = v_caller_company) then
      raise exception 'Devolução não encontrada ou acesso negado.';
    end if;

    if p_field = 'invoice_number' then
      select invoice_number into v_previous_value from public.returns where id = p_entity_id;
      update public.returns set invoice_number = nullif(trim(p_new_value), '') where id = p_entity_id;
    elsif p_field = 'invoice_situation' then
      if p_new_value not in ('pendente_cancelamento', 'cancelada', 'nao_se_aplica') then
        raise exception 'Situação da nota inválida.';
      end if;
      select invoice_situation into v_previous_value from public.returns where id = p_entity_id;
      update public.returns set invoice_situation = p_new_value where id = p_entity_id;
    elsif p_field = 'notes' then
      select notes into v_previous_value from public.returns where id = p_entity_id;
      update public.returns set notes = p_new_value where id = p_entity_id;
    elsif p_field = 'package_code' then
      if p_new_value is null or length(trim(p_new_value)) = 0 then
        raise exception 'Código do pacote não pode ficar em branco.';
      end if;
      select package_code into v_previous_value from public.returns where id = p_entity_id;
      update public.returns set package_code = trim(p_new_value) where id = p_entity_id;
    else
      raise exception 'Campo não permitido para correção: %', p_field;
    end if;

  elsif p_entity_type = 'return_item' then
    if not exists (
      select 1 from public.return_items ri
      join public.returns r on r.id = ri.return_id
      where ri.id = p_entity_id and r.company_id = v_caller_company
    ) then
      raise exception 'Item de devolução não encontrado ou acesso negado.';
    end if;

    if p_field = 'classification' then
      if p_new_value not in ('vendavel', 'avariado', 'divergente', 'pacote_vazio', 'aguardando_analise') then
        raise exception 'Classificação inválida.';
      end if;
      select classification into v_previous_value from public.return_items where id = p_entity_id;
      update public.return_items set classification = p_new_value, last_change_reason = p_reason where id = p_entity_id;
    elsif p_field = 'quantity' then
      if p_new_value !~ '^[0-9]+$' or p_new_value::integer <= 0 then
        raise exception 'Quantidade inválida.';
      end if;
      select quantity::text into v_previous_value from public.return_items where id = p_entity_id;
      update public.return_items set quantity = p_new_value::integer, last_change_reason = p_reason where id = p_entity_id;
    elsif p_field = 'condition_notes' then
      select condition_notes into v_previous_value from public.return_items where id = p_entity_id;
      update public.return_items set condition_notes = p_new_value, last_change_reason = p_reason where id = p_entity_id;
    elsif p_field = 'expected_description' then
      select expected_description into v_previous_value from public.return_items where id = p_entity_id;
      update public.return_items set expected_description = p_new_value, last_change_reason = p_reason where id = p_entity_id;
    else
      raise exception 'Campo não permitido para correção: %', p_field;
    end if;
  else
    raise exception 'Tipo de entidade inválido.';
  end if;

  insert into public.return_corrections (entity_type, entity_id, field_name, previous_value, new_value, reason, corrected_by)
  values (p_entity_type, p_entity_id, p_field, v_previous_value, p_new_value, p_reason, auth.uid());
end;
$$;

revoke all on function public.correct_return_record(text, uuid, text, text, text) from public;
grant execute on function public.correct_return_record(text, uuid, text, text, text) to authenticated;
