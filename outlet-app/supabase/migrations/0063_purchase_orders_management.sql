-- 0063_purchase_orders_management.sql
--
-- EVOLUÇÃO — a ordem de compra deixa de ser "sobe e some dentro da nota":
-- ganha campos próprios (título editável, nº do pedido, fornecedor, datas) e
-- RPCs de gestão (listar todas, editar, cancelar/reativar) pra sustentar uma
-- tela própria de administração, inspirada no painel de Ordens de Compra do
-- Tiny ERP (número/fornecedor/data/previsto/status em lista, com abas por
-- status) — sem copiar layout, só a ideia de "lugar pra gerenciar". Nenhum
-- fluxo existente (upload avulso, vínculo, checagem de conflito) muda de
-- comportamento; isto é só aditivo.

alter table public.invoice_purchase_orders
  add column if not exists title text,
  add column if not exists order_number text,
  add column if not exists supplier_name text,
  add column if not exists order_date date,
  add column if not exists expected_date date,
  add column if not exists cancelled boolean not null default false;

-- Backfill: toda OC já existente ganha um título a partir do nome do arquivo
-- (nunca fica sem título) — editável depois pelo usuário como qualquer outra.
update public.invoice_purchase_orders
set title = file_name
where title is null;

-- ---------------------------------------------------------------------------
-- Edição administrativa — mesma regra de sempre (manager/admin, mesma
-- empresa). Só mexe nos campos "de gestão"; nunca toca em receipt_id/itens
-- (isso continua sendo link_purchase_order_to_receipt, ação separada e
-- deliberada).
-- ---------------------------------------------------------------------------
create or replace function public.update_purchase_order(
  p_id uuid,
  p_title text,
  p_order_number text,
  p_supplier_name text,
  p_order_date date,
  p_expected_date date
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_company uuid;
begin
  if not public.is_manager_or_admin() then
    raise exception 'Apenas manager ou admin podem editar uma ordem de compra.';
  end if;

  select company_id into v_company from public.invoice_purchase_orders where id = p_id for update;
  if not found then
    raise exception 'Ordem de compra não encontrada.';
  end if;
  if v_company is distinct from public.current_company_id() then
    raise exception 'Acesso negado.';
  end if;

  update public.invoice_purchase_orders
  set title = nullif(trim(p_title), ''),
      order_number = nullif(trim(p_order_number), ''),
      supplier_name = nullif(trim(p_supplier_name), ''),
      order_date = p_order_date,
      expected_date = p_expected_date
  where id = p_id;
end;
$$;

-- Cancelar/reativar é reversível de propósito — nunca um delete físico, pra
-- nunca perder histórico de uma OC que já foi usada numa conferência.
create or replace function public.set_purchase_order_cancelled(p_id uuid, p_cancelled boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_company uuid;
begin
  if not public.is_manager_or_admin() then
    raise exception 'Apenas manager ou admin podem cancelar/reativar uma ordem de compra.';
  end if;

  select company_id into v_company from public.invoice_purchase_orders where id = p_id for update;
  if not found then
    raise exception 'Ordem de compra não encontrada.';
  end if;
  if v_company is distinct from public.current_company_id() then
    raise exception 'Acesso negado.';
  end if;

  update public.invoice_purchase_orders set cancelled = p_cancelled where id = p_id;
end;
$$;

-- Lista TODAS as OCs da empresa (vinculadas ou não) pra tela de gestão — o
-- status é computado aqui (nunca guardado em coluna própria, pra nunca
-- dessincronizar do estado real da nota vinculada):
--   avulsa     -> sem receipt_id
--   vinculada  -> com receipt_id, nota ainda não concluída
--   conferida  -> com receipt_id, nota já concluída (completed/with_divergences)
--   cancelada  -> cancelled = true (tem prioridade sobre os outros três)
create or replace function public.list_purchase_orders()
returns table (
  id uuid,
  title text,
  order_number text,
  supplier_name text,
  order_date date,
  expected_date date,
  file_name text,
  item_count bigint,
  created_at timestamptz,
  cancelled boolean,
  receipt_id uuid,
  receipt_invoice_number text,
  status text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    po.id,
    po.title,
    po.order_number,
    po.supplier_name,
    po.order_date,
    po.expected_date,
    po.file_name,
    count(poi.id),
    po.created_at,
    po.cancelled,
    po.receipt_id,
    r.invoice_number,
    case
      when po.cancelled then 'cancelada'
      when po.receipt_id is null then 'avulsa'
      when r.status in ('completed', 'with_divergences') then 'conferida'
      else 'vinculada'
    end
  from public.invoice_purchase_orders po
  left join public.invoice_purchase_order_items poi on poi.purchase_order_id = po.id
  left join public.invoice_receipts r on r.id = po.receipt_id
  where po.company_id = public.current_company_id()
    and public.is_active_user()
  group by po.id, po.title, po.order_number, po.supplier_name, po.order_date, po.expected_date,
           po.file_name, po.created_at, po.cancelled, po.receipt_id, r.invoice_number, r.status
  order by po.created_at desc
  limit 500;
$$;
