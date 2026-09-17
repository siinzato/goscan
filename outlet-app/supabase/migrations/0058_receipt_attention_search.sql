-- 0058_receipt_attention_search.sql
--
-- FASE 3 — Central de Pendências Operacionais de NF-e.
--
-- Por que uma RPC (e não só PostgREST direto, como o resto do Histórico da
-- Fase 2): a Central precisa de UMA lista paginada/filtrada/pesquisável que
-- combina duas coisas de tabelas diferentes — (a) o status da própria NF
-- (not_started/in_progress/with_divergences) e (b) se ela tem algum item
-- com status='unlinked' (invoice_receipt_items, contado por NF, sem N+1).
-- Expressar "status X OU (tem item sem vínculo)" com paginação+contagem
-- total+pesquisa OR, tudo em cima de um agrupamento por NF, não é algo que os
-- filtros simples do PostgREST (usados no resto do Histórico) resolvem numa
-- única ida ao banco — daí a RPC. Só leitura, aditiva, nenhuma tabela/coluna/
-- status novo, nenhum dado reescrito.
--
-- `security invoker` (padrão — não declarado, mesmo estilo de
-- 0054_search_sku_picker_rpc.sql): roda com o papel de quem chama, então as
-- RLS de invoice_receipts/invoice_receipt_items/profiles de sempre continuam
-- valendo sem reescrever nenhuma regra de acesso aqui (inclusive a limitação
-- já existente de um operador comum não enxergar full_name de outro operador
-- via profiles — mesmo comportamento de getReceipt/listReceiptHistory).
--
-- Regra de inclusão: uma NF é "pendência operacional" quando NÃO está
-- completed (as únicas 4 status reais são not_started/in_progress/completed/
-- with_divergences — completed sem divergência nunca é pendência, por
-- definição do pedido). "Tem item sem vínculo" nunca inclui uma NF completed
-- sozinho — é só um MOTIVO/atributo exibido e um filtro adicional (p_category
-- = 'unlinked') dentro do conjunto já não-completed.
create or replace function public.search_receipt_attention(
  p_category text,
  p_search_ilike text,
  p_search_operator_ids uuid[],
  p_cnpj_ilike text,
  p_operator_id uuid,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  invoice_number text,
  supplier_name text,
  supplier_cnpj text,
  status text,
  created_by uuid,
  operator_name text,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  unlinked_count integer,
  total_count bigint
)
language sql
stable
as $$
  with unlinked_counts as (
    select receipt_id, count(*)::integer as unlinked_count
    from public.invoice_receipt_items
    where status = 'unlinked'
    group by receipt_id
  ),
  base as (
    -- Ordem das colunas aqui precisa bater EXATAMENTE com o RETURNS TABLE
    -- acima (função SQL simples casa por posição, não por nome).
    select
      r.id,
      r.invoice_number,
      r.supplier_name,
      r.supplier_cnpj,
      r.status,
      r.created_by,
      p.full_name as operator_name,
      r.created_at,
      r.started_at,
      r.finished_at,
      coalesce(uc.unlinked_count, 0) as unlinked_count
    from public.invoice_receipts r
    left join unlinked_counts uc on uc.receipt_id = r.id
    left join public.profiles p on p.id = r.created_by
    where r.status <> 'completed'
      and (
        p_category is null or p_category = 'all'
        or (p_category = 'unlinked' and coalesce(uc.unlinked_count, 0) > 0)
        or r.status = p_category
      )
      and (p_operator_id is null or r.created_by = p_operator_id)
      and (p_date_from is null or r.created_at >= p_date_from)
      and (p_date_to is null or r.created_at < p_date_to)
      and (
        p_search_ilike is null
        or r.invoice_number ilike p_search_ilike
        or r.supplier_name ilike p_search_ilike
        or (p_cnpj_ilike is not null and r.supplier_cnpj ilike p_cnpj_ilike)
        or (p_search_operator_ids is not null and r.created_by = any(p_search_operator_ids))
      )
  )
  select
    base.*,
    count(*) over() as total_count
  from base
  -- Ordenação operacional determinística (item 7 do pedido) — nunca um score
  -- inventado: em andamento primeiro (é o que mais precisa de atenção agora),
  -- depois não iniciada, depois com divergências (já finalizada, urgência
  -- menor); dentro de cada grupo, a mais recentemente tocada primeiro.
  order by
    case base.status
      when 'in_progress' then 0
      when 'not_started' then 1
      when 'with_divergences' then 2
      else 3
    end,
    coalesce(base.started_at, base.finished_at, base.created_at) desc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
$$;

grant execute on function public.search_receipt_attention(text, text, uuid[], text, uuid, timestamptz, timestamptz, integer, integer) to authenticated;
