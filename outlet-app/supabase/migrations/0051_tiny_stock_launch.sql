-- 0051_tiny_stock_launch.sql
--
-- EXPANSÃO GOSCAN — usuário pediu a chamada REAL à API do Tiny (v3, OAuth2)
-- pra lançar estoque em dois pontos: ao confirmar um lote de Devolução
-- (upgrade do fluxo manual já existente) e ao finalizar uma conferência por
-- Nota Fiscal (fluxo novo). A chamada HTTP em si mora só na Edge Function
-- tiny-integration (service_role) — esta migration só prepara o que o banco
-- precisa guardar: um razão/ledger de idempotência (nenhuma das duas
-- gerações da API do Tiny garante isso sozinha) e o estado de lançamento da
-- NF-e (o lado de Devolução já tem return_batches.status/
-- return_launch_confirmations desde 0047/0048 — reaproveitados sem
-- alteração).

-- ---------------------------------------------------------------------------
-- tiny_stock_launches — 1 linha por tentativa de lançamento de estoque real
-- no Tiny, por item. idempotency_key é a proteção real contra lançar o
-- mesmo item duas vezes (retry de rede, clique duplo, nova tentativa depois
-- de falha parcial) — nem a API v2 nem a v3 do Tiny garantem isso sozinhas
-- (confirmado via documentação oficial: nenhuma das duas expõe chave de
-- idempotência ou deduplicação).
-- ---------------------------------------------------------------------------
create table if not exists public.tiny_stock_launches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  idempotency_key text not null,
  source_type text not null check (source_type in ('return_batch_item', 'invoice_receipt_item')),
  source_id uuid not null,
  product_variant_id uuid references public.product_variants (id),
  tiny_product_id text,
  tiny_deposito_id text,
  quantity numeric(14, 3) not null,
  unit_price numeric(14, 4),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  external_movement_id text,
  error_message text,
  requested_by uuid not null references public.profiles (id),
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists tiny_stock_launches_idempotency_key_key on public.tiny_stock_launches (idempotency_key);
create index if not exists tiny_stock_launches_company_id_idx on public.tiny_stock_launches (company_id);
create index if not exists tiny_stock_launches_source_idx on public.tiny_stock_launches (source_type, source_id);

comment on table public.tiny_stock_launches is 'Ledger de idempotência + auditoria de cada tentativa real de lançamento de estoque no Tiny (Devolução e NF-e). Escrita exclusiva da Edge Function tiny-integration (service_role) — nunca inserido/atualizado direto pelo cliente.';
comment on column public.tiny_stock_launches.idempotency_key is 'Formato: TINY_ESTOQUE:{source_type}:{source_id}:DEPOSITO:{tiny_deposito_id} — mesmo item + mesmo depósito nunca lança duas vezes; depósito diferente é uma tentativa nova (ver seção 20.7 do pedido original).';

alter table public.tiny_stock_launches enable row level security;

-- Só leitura direta — mesma regra de return_launch_confirmations (qualquer
-- usuário ativo da empresa acompanha o que já foi lançado). Escrita só via
-- Edge Function (service_role, ignora RLS).
drop policy if exists tiny_stock_launches_select on public.tiny_stock_launches;
create policy tiny_stock_launches_select on public.tiny_stock_launches
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

-- ---------------------------------------------------------------------------
-- invoice_receipts — estado de lançamento no Tiny (mesmo conceito de
-- return_batches.status/lancada_tiny/concluida, adaptado pra uma NF
-- individual em vez de um lote consolidado).
-- ---------------------------------------------------------------------------
alter table public.invoice_receipts
  add column if not exists tiny_launch_status text not null default 'nao_lancado' check (tiny_launch_status in ('nao_lancado', 'parcial', 'lancado')),
  add column if not exists tiny_launched_at timestamptz,
  add column if not exists tiny_launched_by uuid references public.profiles (id),
  add column if not exists tiny_launch_warehouse text,
  add column if not exists tiny_launch_note text;

comment on column public.invoice_receipts.tiny_launch_status is 'nao_lancado = nada tentado ainda; parcial = alguns itens lançados no Tiny (ver tiny_stock_launches), outros pendentes/falharam; lancado = todos os itens elegíveis (status ok/surplus, com produto vinculado) confirmados.';

-- ---------------------------------------------------------------------------
-- confirm_invoice_receipt_tiny_launch — confirmação MANUAL (mesmo padrão de
-- confirm_return_batch_tiny_launch, 0048): nunca lança estoque de verdade
-- sozinha, só registra que foi feito (por fora, ou como passo final depois
-- de uma tentativa real bem-sucedida via Edge Function). Idempotente: uma NF
-- já lançada nunca é lançada de novo.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_invoice_receipt_tiny_launch(
  p_receipt_id uuid,
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
  v_receipt public.invoice_receipts%rowtype;
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

  select * into v_receipt from public.invoice_receipts where id = p_receipt_id for update;
  if not found then
    raise exception 'Nota fiscal não encontrada.';
  end if;
  if v_receipt.company_id is distinct from v_caller_company then
    raise exception 'Acesso negado a esta nota fiscal.';
  end if;
  if v_receipt.status not in ('completed', 'with_divergences') then
    raise exception 'A conferência precisa estar finalizada antes de confirmar o lançamento no Tiny.';
  end if;
  if v_receipt.tiny_launch_status = 'lancado' then
    raise exception 'Esta nota já foi lançada no Tiny — não é possível confirmar novamente.';
  end if;

  -- Só itens fisicamente confirmados (ok/surplus) com produto vinculado
  -- entram na quantidade lançada — nunca o que faltou (missing) ou o que não
  -- tinha vínculo de catálogo (unlinked), mesmo estando na NF original (ver
  -- mesma regra do módulo Devolução: evidência física é sempre a fonte).
  select coalesce(jsonb_agg(jsonb_build_object(
    'item_id', ri.id,
    'product_variant_id', ri.product_variant_id,
    'sku_code', coalesce(ri.linked_sku_code, pv.sku_code),
    'produto', coalesce(ri.linked_product_name, p.name),
    'quantity', ri.physical_quantity
  )), '[]'::jsonb)
  into v_quantities
  from public.invoice_receipt_items ri
  left join public.product_variants pv on pv.id = ri.product_variant_id
  left join public.products p on p.id = pv.product_id
  where ri.receipt_id = p_receipt_id
    and ri.status in ('ok', 'surplus')
    and ri.product_variant_id is not null
    and ri.physical_quantity is not null
    and ri.physical_quantity > 0;

  update public.invoice_receipts
  set tiny_launch_status = 'lancado',
      tiny_launched_at = p_launched_at,
      tiny_launched_by = auth.uid(),
      tiny_launch_warehouse = trim(p_warehouse),
      tiny_launch_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_receipt_id;

  return jsonb_build_object('receipt_id', p_receipt_id, 'warehouse', trim(p_warehouse), 'confirmed_quantities', v_quantities);
end;
$$;

revoke all on function public.confirm_invoice_receipt_tiny_launch(uuid, text, timestamptz, text) from public;
grant execute on function public.confirm_invoice_receipt_tiny_launch(uuid, text, timestamptz, text) to authenticated;
