-- 0044_collab_conference_realtime_and_finalize.sql
--
-- EXPANSÃO GOSCAN — Conferência Colaborativa Segura (realtime + finalização atômica).
--
-- 1) Publica as 3 tabelas novas (0042) no supabase_realtime — mesma técnica
--    idempotente de 0040_realtime_publication.sql — pra que reservas/
--    volumes/eventos de presença atualizem ao vivo pros outros participantes.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array['invoice_receipt_volumes', 'invoice_receipt_item_reservations', 'invoice_receipt_presence_events']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2) finalize_invoice_receipt_atomic — CORREÇÃO ESTRUTURAL: finalizeReceipt()
--    (nfeApi.ts) hoje faz recalcular+gravar em VÁRIAS chamadas separadas do
--    cliente (buscar itens, buscar variantes, upsert itens, update da NF),
--    sem nenhum lock — dois usuários clicando "Finalizar" quase ao mesmo
--    tempo podem os dois recalcular a partir de um snapshot parecido e os
--    dois escreverem em invoice_receipts, um sobrescrevendo o finished_by/
--    finished_at do outro silenciosamente ("dupla finalização" na prática,
--    mesmo que o status final costume ser o mesmo). Esta função faz TUDO
--    dentro de uma única transação com a NF travada (for update) — quem
--    chegar depois já encontra o status fechado e recebe ALREADY_FINALIZED
--    de volta, nunca reprocessa nem sobrescreve.
--
--    O cálculo de item.status/snapshot é o MESMO de computeItemStatus()
--    (nfeMatching.ts) — ok quando físico=esperado, missing quando físico<
--    esperado, surplus quando físico>esperado, pending quando não contado,
--    unlinked quando sem produto vinculado.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_invoice_receipt_atomic(
  p_receipt_id uuid
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

  -- Dupla finalização: o segundo a chegar (depois do primeiro já ter
  -- commitado) encontra o status fechado e recebe um resultado claro, nunca
  -- reprocessa nem sobrescreve finished_by/finished_at.
  if v_receipt.status not in ('not_started', 'in_progress') then
    return jsonb_build_object(
      'success', false,
      'code', 'ALREADY_FINALIZED',
      'finishedBy', v_receipt.finished_by,
      'finishedAt', v_receipt.finished_at,
      'status', v_receipt.status
    );
  end if;

  -- Snapshot imutável (nome/SKU/EAN) + status final dos itens VINCULADOS —
  -- seguro fazer aqui porque a NF está travada (for update) e qualquer
  -- bipagem concorrente em andamento (record_invoice_count_event também
  -- trava a mesma linha da NF) já terminou ou espera até este commit.
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

  -- Reservas ativas remanescentes perdem sentido — a NF virou somente
  -- leitura pra operadores (RLS já garante isso), então nenhuma bipagem nova
  -- vai disputar o item de qualquer forma.
  update public.invoice_receipt_item_reservations
  set status = 'released', released_reason = 'receipt_finalized'
  where receipt_id = p_receipt_id and status = 'active';

  return jsonb_build_object('success', true, 'code', 'OK', 'status', v_new_status);
end;
$$;

revoke all on function public.finalize_invoice_receipt_atomic(uuid) from public;
grant execute on function public.finalize_invoice_receipt_atomic(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Índices de performance pra consultas novas (contribuição por operador/
--    volume no relatório final, histórico de eventos de uma NF).
-- ---------------------------------------------------------------------------
create index if not exists invoice_item_scan_events_performed_by_idx on public.invoice_item_scan_events (performed_by);
create index if not exists invoice_receipt_presence_events_user_id_idx on public.invoice_receipt_presence_events (user_id);
