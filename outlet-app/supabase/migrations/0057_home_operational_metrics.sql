-- 0057_home_operational_metrics.sql
--
-- HOME OPERACIONAL 2.0 — métricas diárias 100% reais.
--
-- CAUSA RAIZ da aproximação anterior: a Home calculava "unidades hoje" a
-- partir de invoice_receipt_items.physical_quantity/updated_at — um TOTAL
-- CORRENTE por item, não um delta do período. Isso superestimava (contava de
-- novo um item já contado em dias anteriores só porque foi tocado hoje por
-- outro motivo) e não tinha como refletir corretamente uma correção pra baixo
-- ou um desfazer.
--
-- Esta migration cria só uma função (nenhuma tabela nova, nenhuma métrica
-- duplicada persistida) que agrega os eventos IMUTÁVEIS já gravados —
-- conference_item_scan_events (0039) e invoice_item_scan_events (0039/0042) —
-- e devolve só os totais já prontos.
--
-- Insight central (por que dá pra tratar 'scan_increment'/'manual_set'/undo
-- de forma UNIFORME, sem "if action = ..." espalhado): resulting_quantity é,
-- por definição de coluna (ver comentário em 0039), o valor de
-- physical_quantity/quantity IMEDIATAMENTE APÓS aquele evento — não importa
-- se o evento foi um incremento, uma definição absoluta (manual_set) ou o
-- desfazer de um dos dois (que grava um NOVO evento reversor, nunca reescreve
-- o original). Como consequência, a soma telescópica
-- (resulting_quantity do último evento DENTRO do período) menos
-- (resulting_quantity do último evento ANTES do período, ou a quantidade de
-- criação do item se não houver nenhum) já é, por si só, a contribuição real
-- e exata do período pro item — inclusive quando uma correção pra baixo ou um
-- undo cancelam parte do que foi feito antes. Conferir com o exemplo do
-- pedido: estado anterior=5, manual_set=10 (evento 1, resulting=10),
-- manual_set=8 (evento 2, resulting=8) → telescópico = 8 - 5 = 3 = (10-5)+(8-10).
--
-- Outlet tem uma particularidade que a NF-e não tem: a quantidade INICIAL de
-- um item (addItem em conferencesApi.ts) é gravada direto em
-- conference_items.quantity, SEM passar por conference_item_scan_events (só a
-- stepper +/- do fluxo de ajuste passa por lá, via record_conference_item_delta
-- — ver 0039). Por isso a reconstrução do Outlet abaixo trata a criação do
-- item como um "evento implícito" (reconstruído do primeiro evento real:
-- resulting_quantity - delta_quantity = estado logo após a criação; sem
-- nenhum evento, a quantidade atual do item JÁ É a quantidade de criação,
-- porque nada mais muda quantity fora desse caminho). NF-e não precisa dessa
-- reconstrução: invoice_receipt_items nasce sem contagem física
-- (physical_quantity nulo), então o telescoping puro já é exato sozinho.

create or replace function public.get_home_operational_summary(
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid;
  v_outlet_conferences int := 0;
  v_outlet_units numeric := 0;
  v_outlet_sku_ids uuid[] := '{}';
  v_nfe_receipts int := 0;
  v_nfe_units numeric := 0;
  v_nfe_sku_ids uuid[] := '{}';
  r record;
  v_creation_qty numeric;
  v_baseline numeric;
  v_last_in_period numeric;
  v_contribution numeric;
begin
  -- Somente leitura, exige sessão válida e usuário ativo — mesma barreira das
  -- demais RPCs deste projeto (ver 0039/0043). Nunca usa service_role; roda
  -- com os privilégios do próprio usuário autenticado do frontend, apenas
  -- elevados via SECURITY DEFINER pra poder ler as tabelas de evento (cuja
  -- policy de SELECT já é company-scoped, mas aqui agregamos entre tabelas
  -- sem expor linha alguma, só totais).
  if auth.uid() is null then
    raise exception 'Sessão inválida.';
  end if;
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'Período inválido.';
  end if;

  v_company := public.current_company_id();
  if v_company is null then
    raise exception 'Usuário sem empresa associada.';
  end if;

  -- =========================================================================
  -- OUTLET — um item por vez (conjunto pequeno: só os itens com atividade
  -- real no período — nunca a tabela toda), porque a reconstrução da
  -- quantidade de criação depende do histórico individual do item.
  -- =========================================================================
  for r in
    select ci.id, ci.conference_id, ci.product_variant_id, ci.quantity, ci.created_at
    from public.conference_items ci
    join public.conferences c on c.id = ci.conference_id
    where c.company_id = v_company
      and (
        (ci.created_at >= p_period_start and ci.created_at < p_period_end)
        or exists (
          select 1 from public.conference_item_scan_events e
          where e.item_id = ci.id and e.created_at >= p_period_start and e.created_at < p_period_end
        )
      )
  loop
    -- Quantidade "de criação" (estado do item logo depois de ser adicionado,
    -- antes de qualquer ajuste): reconstruída do PRIMEIRO evento real já
    -- gravado pra este item. Sem nenhum evento, a quantidade atual já é essa
    -- (nada mais muda conference_items.quantity fora do caminho de eventos).
    select e.resulting_quantity - e.delta_quantity into v_creation_qty
      from public.conference_item_scan_events e
      where e.item_id = r.id
      order by e.created_at asc
      limit 1;
    if v_creation_qty is null then
      v_creation_qty := r.quantity;
    end if;

    -- Estado do item imediatamente ANTES do período (baseline da comparação
    -- telescópica). Item criado dentro do período nunca teve estado antes
    -- dele — baseline é 0 (a contribuição inteira, criação + ajustes do
    -- mesmo dia, entra como "processada no período").
    if r.created_at >= p_period_start then
      v_baseline := 0;
    else
      select e.resulting_quantity into v_baseline
        from public.conference_item_scan_events e
        where e.item_id = r.id and e.created_at < p_period_start
        order by e.created_at desc
        limit 1;
      if v_baseline is null then
        v_baseline := v_creation_qty;
      end if;
    end if;

    select e.resulting_quantity into v_last_in_period
      from public.conference_item_scan_events e
      where e.item_id = r.id and e.created_at >= p_period_start and e.created_at < p_period_end
      order by e.created_at desc
      limit 1;

    if v_last_in_period is null then
      -- Nenhum evento de ajuste dentro do período: só entra se o item foi
      -- CRIADO no período (contribuição = a própria quantidade de criação).
      if r.created_at >= p_period_start then
        v_contribution := v_creation_qty;
      else
        v_contribution := 0;
      end if;
    else
      v_contribution := v_last_in_period - v_baseline;
    end if;

    v_outlet_units := v_outlet_units + v_contribution;
    if r.product_variant_id is not null and not (r.product_variant_id = any(v_outlet_sku_ids)) then
      v_outlet_sku_ids := array_append(v_outlet_sku_ids, r.product_variant_id);
    end if;
  end loop;

  select count(distinct ci.conference_id) into v_outlet_conferences
    from public.conference_items ci
    join public.conferences c on c.id = ci.conference_id
    where c.company_id = v_company
      and (
        (ci.created_at >= p_period_start and ci.created_at < p_period_end)
        or exists (
          select 1 from public.conference_item_scan_events e
          where e.item_id = ci.id and e.created_at >= p_period_start and e.created_at < p_period_end
        )
      );

  -- =========================================================================
  -- NF-e — sem quantidade "de criação" pra reconstruir (invoice_receipt_items
  -- nasce com physical_quantity nulo/0, só muda via evento), então dá pra
  -- resolver inteiro em SQL de conjunto (sem loop por item).
  -- =========================================================================
  select
    coalesce(count(distinct e.receipt_id), 0),
    coalesce(array_agg(distinct e.product_variant_id) filter (where e.product_variant_id is not null), '{}')
    into v_nfe_receipts, v_nfe_sku_ids
    from public.invoice_item_scan_events e
    where e.company_id = v_company
      and e.created_at >= p_period_start and e.created_at < p_period_end;

  select coalesce(sum(x.contribution), 0) into v_nfe_units
  from (
    select
      last_in_period.resulting_quantity - coalesce(before.resulting_quantity, 0) as contribution
    from (
      select distinct item_id
      from public.invoice_item_scan_events
      where company_id = v_company and created_at >= p_period_start and created_at < p_period_end
    ) items
    cross join lateral (
      select e2.resulting_quantity
      from public.invoice_item_scan_events e2
      where e2.item_id = items.item_id and e2.created_at >= p_period_start and e2.created_at < p_period_end
      order by e2.created_at desc
      limit 1
    ) last_in_period
    left join lateral (
      select e3.resulting_quantity
      from public.invoice_item_scan_events e3
      where e3.item_id = items.item_id and e3.created_at < p_period_start
      order by e3.created_at desc
      limit 1
    ) before on true
  ) x;

  return jsonb_build_object(
    'outletConferences', v_outlet_conferences,
    'outletUnits', greatest(0, round(v_outlet_units)),
    'outletSkuIds', to_jsonb(coalesce(v_outlet_sku_ids, '{}'::uuid[])),
    'nfeReceipts', v_nfe_receipts,
    'nfeUnits', greatest(0, round(v_nfe_units)),
    'nfeSkuIds', to_jsonb(coalesce(v_nfe_sku_ids, '{}'::uuid[]))
  );
end;
$$;

comment on function public.get_home_operational_summary(timestamptz, timestamptz) is
  'HOME OPERACIONAL 2.0 — resumo agregado (Outlet + NF-e) de um período [p_period_start, p_period_end) derivado 100% dos eventos reais de contagem (conference_item_scan_events / invoice_item_scan_events), nunca de aproximação por updated_at. Somente leitura; company-scoped via current_company_id(); nunca modifica conferência, evento ou quantidade nenhuma.';

revoke all on function public.get_home_operational_summary(timestamptz, timestamptz) from public;
grant execute on function public.get_home_operational_summary(timestamptz, timestamptz) to authenticated;
