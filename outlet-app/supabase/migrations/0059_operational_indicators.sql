-- 0059_operational_indicators.sql
--
-- FASE 5 — Indicadores Operacionais do GoScan (Histórico > aba Indicadores).
-- Visão gerencial consolidada de OPERAÇÕES FINALIZADAS num período — não
-- confundir com a Home 2.0 (que mede ATIVIDADE DO DIA via eventos de
-- contagem, ver 0057). Aqui a referência temporal é sempre finished_at:
-- Outlet = conferences.finished_at, NF-e = invoice_receipts.finished_at.
--
-- SEGURANÇA: mesma justificativa já usada em get_home_operational_summary
-- (0057) — SECURITY DEFINER apenas para poder agregar com segurança entre
-- conferences/conference_items e invoice_receipts/invoice_receipt_items sem
-- expor nenhuma linha (só totais), sempre validando sessão ativa e
-- filtrando explicitamente por current_company_id() aqui dentro. Não usa
-- service_role; não é possível ler dado de outra empresa através dela.
--
-- ÍNDICES: conferences/invoice_receipts já tinham índice em (status) e
-- (company_id) isolados, mas nenhum cobria finished_at (dimensão nova desta
-- fase) — os dois índices compostos abaixo casam exatamente com o filtro
-- desta RPC (company_id + status + intervalo de finished_at).

create index if not exists conferences_company_status_finished_idx
  on public.conferences (company_id, status, finished_at);

create index if not exists invoice_receipts_company_status_finished_idx
  on public.invoice_receipts (company_id, status, finished_at);

create or replace function public.get_operational_indicators(
  p_start timestamptz,
  p_end timestamptz,
  p_timezone text default 'UTC',
  p_responsible_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_tz text;
  v_outlet_conferences int := 0;
  v_outlet_skus numeric := 0;
  v_outlet_units numeric := 0;
  v_nfe_receipts int := 0;
  v_nfe_divergence_receipts int := 0;
  v_nfe_counted_skus numeric := 0;
  v_nfe_physical_units numeric := 0;
  v_nfe_ok numeric := 0;
  v_nfe_missing numeric := 0;
  v_nfe_surplus numeric := 0;
  v_daily jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'Período inválido.';
  end if;

  v_company := public.current_company_id();
  if v_company is null then
    raise exception 'Usuário sem empresa associada.';
  end if;

  -- Fuso informado pelo cliente (Intl.DateTimeFormat().resolvedOptions().timeZone
  -- no frontend) — nunca hardcoded. Um nome inválido/desconhecido nunca derruba
  -- a função inteira: cai no fallback documentado 'UTC'.
  begin
    perform now() at time zone coalesce(p_timezone, 'UTC');
    v_tz := coalesce(p_timezone, 'UTC');
  exception when others then
    v_tz := 'UTC';
  end;

  -- ---------------------------------------------------------------------
  -- OUTLET — usa os totais OFICIAIS já consolidados na finalização
  -- (conferences.total_skus/total_units); nunca reconstrói a partir de
  -- conference_items (o fechamento já é a fonte de verdade).
  -- ---------------------------------------------------------------------
  select count(*), coalesce(sum(total_skus), 0), coalesce(sum(total_units), 0)
    into v_outlet_conferences, v_outlet_skus, v_outlet_units
    from public.conferences c
    where c.company_id = v_company
      and c.status = 'completed'
      and c.finished_at is not null
      and c.finished_at >= p_start and c.finished_at < p_end
      and (p_responsible_id is null or c.operator_id = p_responsible_id);

  -- ---------------------------------------------------------------------
  -- NF-e — mesma semântica de "item efetivamente conferido" da Fase 4
  -- (summarizeReceipt/computeItemStatus): physical_quantity IS NOT NULL já
  -- basta (itens 'unlinked' nunca têm físico contado — contagem cega não
  -- permite contar item sem produto vinculado). ok/missing/surplus vêm da
  -- mesma comparação expected x physical usada no relatório final.
  -- ---------------------------------------------------------------------
  select
    count(distinct r.id),
    count(distinct r.id) filter (where r.status = 'with_divergences'),
    count(i.id) filter (where i.physical_quantity is not null),
    coalesce(sum(i.physical_quantity) filter (where i.physical_quantity is not null), 0),
    count(i.id) filter (where i.physical_quantity is not null and i.physical_quantity = i.expected_quantity),
    count(i.id) filter (where i.physical_quantity is not null and i.physical_quantity < i.expected_quantity),
    count(i.id) filter (where i.physical_quantity is not null and i.physical_quantity > i.expected_quantity)
    into v_nfe_receipts, v_nfe_divergence_receipts, v_nfe_counted_skus, v_nfe_physical_units, v_nfe_ok, v_nfe_missing, v_nfe_surplus
    from public.invoice_receipts r
    left join public.invoice_receipt_items i on i.receipt_id = r.id
    where r.company_id = v_company
      and r.status in ('completed', 'with_divergences')
      and r.finished_at is not null
      and r.finished_at >= p_start and r.finished_at < p_end
      and (p_responsible_id is null or r.created_by = p_responsible_id);

  -- ---------------------------------------------------------------------
  -- VOLUME POR DIA — série completa no dia LOCAL (v_tz), incluindo dias sem
  -- nenhuma operação (generate_series cobre todo o período, nunca só os dias
  -- com registro). Cada dia local vira um intervalo [ini, fim) em
  -- timestamptz via "AT TIME ZONE v_tz" (naive -> instante absoluto).
  -- ---------------------------------------------------------------------
  select coalesce(jsonb_agg(to_jsonb(t) order by t.date), '[]'::jsonb)
    into v_daily
    from (
      select
        to_char(gs, 'YYYY-MM-DD') as date,
        coalesce(oc.cnt, 0)::int as "outletConferences",
        coalesce(nr.cnt, 0)::int as "nfeReceipts",
        (coalesce(oc.skus, 0) + coalesce(nr.skus, 0))::numeric as skus,
        (coalesce(oc.units, 0) + coalesce(nr.units, 0))::numeric as units,
        coalesce(nr.divergences, 0)::int as "divergenceReceipts"
      from generate_series(
        date_trunc('day', p_start at time zone v_tz),
        date_trunc('day', (p_end - interval '1 microsecond') at time zone v_tz),
        interval '1 day'
      ) as gs
      left join lateral (
        select count(*) as cnt, coalesce(sum(total_skus), 0) as skus, coalesce(sum(total_units), 0) as units
        from public.conferences c
        where c.company_id = v_company
          and c.status = 'completed'
          and c.finished_at is not null
          and c.finished_at >= (gs at time zone v_tz)
          and c.finished_at < ((gs + interval '1 day') at time zone v_tz)
          and (p_responsible_id is null or c.operator_id = p_responsible_id)
      ) oc on true
      left join lateral (
        select
          count(distinct r.id) as cnt,
          count(distinct r.id) filter (where r.status = 'with_divergences') as divergences,
          count(i.id) filter (where i.physical_quantity is not null) as skus,
          coalesce(sum(i.physical_quantity) filter (where i.physical_quantity is not null), 0) as units
        from public.invoice_receipts r
        left join public.invoice_receipt_items i on i.receipt_id = r.id
        where r.company_id = v_company
          and r.status in ('completed', 'with_divergences')
          and r.finished_at is not null
          and r.finished_at >= (gs at time zone v_tz)
          and r.finished_at < ((gs + interval '1 day') at time zone v_tz)
          and (p_responsible_id is null or r.created_by = p_responsible_id)
      ) nr on true
    ) t;

  return jsonb_build_object(
    'summary', jsonb_build_object(
      'completedOperations', v_outlet_conferences + v_nfe_receipts,
      'outletConferences', v_outlet_conferences,
      'nfeReceipts', v_nfe_receipts,
      'nfeWithDivergences', v_nfe_divergence_receipts
    ),
    'outlet', jsonb_build_object(
      'conferences', v_outlet_conferences,
      'skus', v_outlet_skus,
      'units', v_outlet_units,
      'avgSkus', case when v_outlet_conferences > 0 then round(v_outlet_skus::numeric / v_outlet_conferences, 1) else 0 end,
      'avgUnits', case when v_outlet_conferences > 0 then round(v_outlet_units::numeric / v_outlet_conferences, 1) else 0 end
    ),
    'nfe', jsonb_build_object(
      'receipts', v_nfe_receipts,
      'countedSkus', v_nfe_counted_skus,
      'physicalUnits', v_nfe_physical_units,
      'okItems', v_nfe_ok,
      'missingItems', v_nfe_missing,
      'surplusItems', v_nfe_surplus,
      'divergenceReceipts', v_nfe_divergence_receipts,
      'conformityRate', case when (v_nfe_ok + v_nfe_missing + v_nfe_surplus) > 0
        then round(v_nfe_ok::numeric / (v_nfe_ok + v_nfe_missing + v_nfe_surplus), 4)
        else null end
    ),
    'daily', v_daily
  );
end;
$$;

comment on function public.get_operational_indicators(timestamptz, timestamptz, text, uuid) is
  'FASE 5 — Indicadores Operacionais: agregado somente leitura de operações FINALIZADAS (Outlet: conferences.finished_at/status=completed; NF-e: invoice_receipts.finished_at/status IN (completed,with_divergences)) num período [p_start,p_end), com série diária no fuso local informado. Nunca produtividade individual — p_responsible_id filtra por responsabilidade/origem da operação (operator_id / created_by), não por quem bipou. Company-scoped via current_company_id(); nunca modifica dado nenhum.';

revoke all on function public.get_operational_indicators(timestamptz, timestamptz, text, uuid) from public;
grant execute on function public.get_operational_indicators(timestamptz, timestamptz, text, uuid) to authenticated;
