-- 0060_central_operational_audit.sql
--
-- FASE 6 — Central de Auditoria (Administração > Auditoria). Unifica, SOMENTE
-- PARA CONSULTA, três fontes já existentes e imutáveis:
--   A) public.audit_logs                  (ações administrativas)
--   B) public.invoice_item_scan_events    (contagem/ajuste NF-e)
--   C) public.conference_item_scan_events (ajuste atômico Outlet)
-- Nenhuma tabela nova é criada; nenhum evento é copiado/duplicado — a união
-- acontece só na CONSULTA (RPC search_central_audit abaixo). Devoluções nunca
-- são tocadas/consultadas aqui.

-- ---------------------------------------------------------------------------
-- 1) Trigger de auditoria pro status da NF-e — mesmo padrão já usado para
--    Outlet (audit_conference_status_change, ver 0003_audit_triggers.sql).
--    Só passa a existir daqui pra frente; nenhum backfill de histórico
--    (nunca inventa ator/horário pra uma transição já ocorrida no passado).
-- ---------------------------------------------------------------------------
create or replace function public.audit_invoice_receipt_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_logs (user_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      'invoice_receipt_status_changed',
      'invoice_receipts',
      new.id,
      jsonb_build_object('old_status', old.status, 'new_status', new.status)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_invoice_receipt_status_change on public.invoice_receipts;
create trigger audit_invoice_receipt_status_change
  after update on public.invoice_receipts
  for each row execute function public.audit_invoice_receipt_status_change();

-- ---------------------------------------------------------------------------
-- 2) Índices — nenhuma das duas tabelas de evento tinha índice cobrindo
--    company_id (só item_id/receipt_id/performed_by), mas a Central filtra
--    exatamente por (company_id, período) em toda consulta.
-- ---------------------------------------------------------------------------
create index if not exists invoice_item_scan_events_company_created_idx
  on public.invoice_item_scan_events (company_id, created_at desc);

create index if not exists conference_item_scan_events_company_created_idx
  on public.conference_item_scan_events (company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) RPC search_central_audit — SECURITY DEFINER (necessário: audit_logs só
--    libera SELECT via RLS para is_admin(), ou seja, só super_admin — mas
--    esta Central deve valer para admin E super_admin, mesmo padrão de
--    is_manager_or_admin() já usado no resto do app). Verificações
--    obrigatórias replicadas aqui dentro (nunca confia só na UI escondida):
--    sessão válida, usuário ativo, papel admin/super_admin, empresa válida,
--    e cada fonte é escopada explicitamente por empresa.
--
--    audit_logs não tem company_id — a empresa é resolvida com segurança por
--    ator (profiles.company_id) quando user_id existe; só cai pra associação
--    via entidade (conferences/invoice_receipts) quando user_id é nulo. Nunca
--    inclui uma linha que não conseguiu provar a empresa (nunca "por
--    conveniência").
-- ---------------------------------------------------------------------------
create or replace function public.search_central_audit(
  p_search text default null,
  p_module text default null,
  p_action text default null,
  p_actor_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_limit integer;
  v_offset integer;
  v_search text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_manager_or_admin() then
    raise exception 'Acesso restrito a administradores.';
  end if;

  v_company := public.current_company_id();
  if v_company is null then
    raise exception 'Usuário sem empresa associada.';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_search := lower(nullif(trim(coalesce(p_search, '')), ''));

  with admin_events as (
    select
      'admin'::text as source,
      case
        when al.entity_type = 'conferences' and al.action = 'conference_status_changed' then 'outlet'
        when al.entity_type = 'invoice_receipts' and al.action = 'invoice_receipt_status_changed' then 'nfe'
        else 'administration'
      end as module,
      al.id::text as id,
      al.action,
      al.user_id as actor_id,
      actor.full_name as actor_name,
      actor.email as actor_email,
      al.created_at as occurred_at,
      al.entity_type,
      al.entity_id,
      coalesce(oc.id, nr.id) as operation_id,
      case
        when al.entity_type = 'conferences' and oc.id is not null then '#' || upper(left(oc.id::text, 8))
        when al.entity_type = 'invoice_receipts' and nr.id is not null then 'NF ' || coalesce(nr.invoice_number, left(nr.invoice_key, 10))
        else null
      end as operation_label,
      null::uuid as item_id,
      null::text as sku,
      null::text as ean,
      null::numeric as delta_quantity,
      null::numeric as resulting_quantity,
      null::text as origin,
      null::text as device_id,
      null::uuid as volume_id,
      null::uuid as reverses_event_id,
      null::boolean as excess,
      al.metadata as metadata,
      lower(
        coalesce(actor.full_name, '') || ' ' || coalesce(actor.email, '') || ' ' ||
        coalesce(oc.name, '') || ' ' || (case when oc.id is not null then upper(left(oc.id::text, 8)) else '' end) || ' ' ||
        coalesce(nr.invoice_number, '') || ' ' || coalesce(nr.invoice_key, '') || ' ' || coalesce(nr.supplier_name, '') || ' ' ||
        al.action
      ) as search_text
    from public.audit_logs al
    left join public.profiles actor on actor.id = al.user_id and actor.company_id = v_company
    left join public.conferences oc on al.entity_type = 'conferences' and oc.id = al.entity_id and oc.company_id = v_company
    left join public.invoice_receipts nr on al.entity_type = 'invoice_receipts' and nr.id = al.entity_id and nr.company_id = v_company
    where case
      when al.user_id is not null then actor.id is not null
      when al.entity_type = 'conferences' then oc.id is not null
      when al.entity_type = 'invoice_receipts' then nr.id is not null
      else false
    end
  ),
  nfe_events as (
    select
      'nfe'::text as source,
      'nfe'::text as module,
      e.id::text as id,
      e.action,
      e.performed_by as actor_id,
      actor.full_name as actor_name,
      actor.email as actor_email,
      e.created_at as occurred_at,
      'invoice_receipts'::text as entity_type,
      e.receipt_id as entity_id,
      e.receipt_id as operation_id,
      'NF ' || coalesce(r.invoice_number, left(r.invoice_key, 10)) as operation_label,
      e.item_id,
      e.sku_code as sku,
      e.ean,
      e.delta_quantity::numeric as delta_quantity,
      e.resulting_quantity::numeric as resulting_quantity,
      e.origin,
      e.device_id,
      e.volume_id,
      e.reverses_event_id,
      e.excess,
      null::jsonb as metadata,
      lower(
        coalesce(actor.full_name, '') || ' ' || coalesce(actor.email, '') || ' ' ||
        coalesce(r.invoice_number, '') || ' ' || coalesce(r.invoice_key, '') || ' ' || coalesce(r.supplier_name, '') || ' ' ||
        coalesce(e.sku_code, '') || ' ' || coalesce(e.ean, '') || ' ' || e.action
      ) as search_text
    from public.invoice_item_scan_events e
    join public.invoice_receipts r on r.id = e.receipt_id
    left join public.profiles actor on actor.id = e.performed_by
    where e.company_id = v_company
  ),
  outlet_events as (
    select
      'outlet'::text as source,
      'outlet'::text as module,
      e.id::text as id,
      'conference_item_delta'::text as action,
      e.performed_by as actor_id,
      actor.full_name as actor_name,
      actor.email as actor_email,
      e.created_at as occurred_at,
      'conferences'::text as entity_type,
      e.conference_id as entity_id,
      e.conference_id as operation_id,
      '#' || upper(left(c.id::text, 8)) as operation_label,
      e.item_id,
      null::text as sku,
      null::text as ean,
      e.delta_quantity::numeric as delta_quantity,
      e.resulting_quantity::numeric as resulting_quantity,
      null::text as origin,
      null::text as device_id,
      null::uuid as volume_id,
      null::uuid as reverses_event_id,
      null::boolean as excess,
      null::jsonb as metadata,
      lower(
        coalesce(actor.full_name, '') || ' ' || coalesce(actor.email, '') || ' ' ||
        coalesce(c.name, '') || ' ' || upper(left(c.id::text, 8))
      ) as search_text
    from public.conference_item_scan_events e
    join public.conferences c on c.id = e.conference_id
    left join public.profiles actor on actor.id = e.performed_by
    where e.company_id = v_company
  ),
  combined as (
    select * from admin_events
    union all
    select * from nfe_events
    union all
    select * from outlet_events
  ),
  filtered as (
    select combined.*, count(*) over() as total_count
    from combined
    where (p_module is null or p_module = 'all' or combined.module = p_module)
      and (p_action is null or p_action = '' or combined.action = p_action)
      and (p_actor_id is null or combined.actor_id = p_actor_id)
      and (p_date_from is null or combined.occurred_at >= p_date_from)
      and (p_date_to is null or combined.occurred_at < p_date_to)
      and (v_search is null or combined.search_text like '%' || v_search || '%')
    order by combined.occurred_at desc, combined.id desc
    limit v_limit
    offset v_offset
  )
  select jsonb_build_object(
    'events', coalesce(jsonb_agg((to_jsonb(filtered) - 'search_text' - 'total_count') order by filtered.occurred_at desc, filtered.id desc), '[]'::jsonb),
    'total', coalesce((select total_count from filtered limit 1), 0)
  ) into v_result
  from filtered;

  return v_result;
end;
$$;

comment on function public.search_central_audit(text, text, text, uuid, timestamptz, timestamptz, integer, integer) is
  'FASE 6 — Central de Auditoria: consulta unificada somente-leitura de audit_logs + invoice_item_scan_events + conference_item_scan_events, admin/super_admin apenas (is_manager_or_admin()), sempre escopada à empresa atual. Nunca copia/duplica evento nenhum; nenhuma tabela nova.';

revoke all on function public.search_central_audit(text, text, text, uuid, timestamptz, timestamptz, integer, integer) from public;
grant execute on function public.search_central_audit(text, text, text, uuid, timestamptz, timestamptz, integer, integer) to authenticated;
