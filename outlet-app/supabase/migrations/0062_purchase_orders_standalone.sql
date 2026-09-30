-- 0062_purchase_orders_standalone.sql
--
-- EVOLUÇÃO — a ordem de compra quase sempre existe ANTES da carga (e da NF-e)
-- chegar, então exigir uma NF já importada pra poder anexá-la (0061) inverte
-- a ordem real do processo. Agora a ordem de compra pode ser enviada
-- avulsa (receipt_id nulo) a qualquer momento, e só depois VINCULADA a uma
-- NF-e específica (por quem está conferindo, nunca automático/adivinhado).
-- company_id passa a viver DIRETO na tabela (preenchido no upload) —
-- necessário pra RLS funcionar sem depender de um receipt_id que pode não
-- existir ainda.

alter table public.invoice_purchase_orders
  add column if not exists company_id uuid references public.companies(id);

update public.invoice_purchase_orders po
set company_id = r.company_id
from public.invoice_receipts r
where po.receipt_id = r.id
  and po.company_id is null;

alter table public.invoice_purchase_orders
  alter column receipt_id drop not null;

create index if not exists invoice_purchase_orders_company_id_idx on public.invoice_purchase_orders(company_id);
-- Ordens ainda não vinculadas a nenhuma NF-e ("avulsas") — consultadas na
-- tela de vínculo; índice parcial mantém a lista sempre pequena e rápida.
create index if not exists invoice_purchase_orders_unlinked_idx on public.invoice_purchase_orders(company_id, created_at desc) where receipt_id is null;

-- ---------------------------------------------------------------------------
-- RLS — troca a checagem "via receipt" por company_id direto (agora sempre
-- presente, preenchido no upload), pra continuar funcionando com
-- receipt_id nulo. Mesma regra de sempre: leitura pra ativo, escrita pra
-- manager/admin.
-- ---------------------------------------------------------------------------
drop policy if exists invoice_purchase_orders_select on public.invoice_purchase_orders;
create policy invoice_purchase_orders_select on public.invoice_purchase_orders
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

drop policy if exists invoice_purchase_orders_insert on public.invoice_purchase_orders;
create policy invoice_purchase_orders_insert on public.invoice_purchase_orders
  for insert
  with check (company_id = public.current_company_id() and public.is_manager_or_admin());

drop policy if exists invoice_purchase_orders_update on public.invoice_purchase_orders;
create policy invoice_purchase_orders_update on public.invoice_purchase_orders
  for update
  using (company_id = public.current_company_id() and public.is_manager_or_admin())
  with check (company_id = public.current_company_id() and public.is_manager_or_admin());

drop policy if exists invoice_purchase_orders_delete on public.invoice_purchase_orders;
create policy invoice_purchase_orders_delete on public.invoice_purchase_orders
  for delete
  using (company_id = public.current_company_id() and public.is_manager_or_admin());

drop policy if exists invoice_purchase_order_items_select on public.invoice_purchase_order_items;
create policy invoice_purchase_order_items_select on public.invoice_purchase_order_items
  for select
  using (
    exists (
      select 1 from public.invoice_purchase_orders po
      where po.id = invoice_purchase_order_items.purchase_order_id
        and po.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

drop policy if exists invoice_purchase_order_items_insert on public.invoice_purchase_order_items;
create policy invoice_purchase_order_items_insert on public.invoice_purchase_order_items
  for insert
  with check (
    exists (
      select 1 from public.invoice_purchase_orders po
      where po.id = invoice_purchase_order_items.purchase_order_id
        and po.company_id = public.current_company_id()
    )
    and public.is_manager_or_admin()
  );

drop policy if exists invoice_purchase_order_items_delete on public.invoice_purchase_order_items;
create policy invoice_purchase_order_items_delete on public.invoice_purchase_order_items
  for delete
  using (
    exists (
      select 1 from public.invoice_purchase_orders po
      where po.id = invoice_purchase_order_items.purchase_order_id
        and po.company_id = public.current_company_id()
    )
    and public.is_manager_or_admin()
  );

-- ---------------------------------------------------------------------------
-- Vínculo manual — sempre uma decisão explícita de quem está conferindo,
-- nunca automático/adivinhado. Só permite vincular uma ordem de compra que
-- ainda está avulsa (receipt_id nulo) OU já vinculada à MESMA nota (idempotente).
-- ---------------------------------------------------------------------------
create or replace function public.link_purchase_order_to_receipt(p_purchase_order_id uuid, p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_po_company uuid;
  v_receipt_company uuid;
  v_current_receipt uuid;
begin
  if not public.is_manager_or_admin() then
    raise exception 'Apenas manager ou admin podem vincular uma ordem de compra.';
  end if;

  select company_id, receipt_id into v_po_company, v_current_receipt
    from public.invoice_purchase_orders where id = p_purchase_order_id for update;
  if not found then
    raise exception 'Ordem de compra não encontrada.';
  end if;

  select company_id into v_receipt_company from public.invoice_receipts where id = p_receipt_id;
  if not found then
    raise exception 'Nota fiscal não encontrada.';
  end if;

  if v_po_company is distinct from v_receipt_company or v_po_company is distinct from public.current_company_id() then
    raise exception 'Acesso negado.';
  end if;

  if v_current_receipt is not null and v_current_receipt is distinct from p_receipt_id then
    raise exception 'Esta ordem de compra já está vinculada a outra nota fiscal.';
  end if;

  update public.invoice_purchase_orders set receipt_id = p_receipt_id where id = p_purchase_order_id;
end;
$$;

-- Ordens de compra avulsas (ainda sem NF-e vinculada) da empresa do usuário —
-- listadas na tela de vínculo pra escolher qual pertence à nota em mãos.
create or replace function public.list_unlinked_purchase_orders()
returns table (id uuid, file_name text, item_count bigint, created_at timestamptz)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select po.id, po.file_name, count(poi.id), po.created_at
  from public.invoice_purchase_orders po
  left join public.invoice_purchase_order_items poi on poi.purchase_order_id = po.id
  where po.receipt_id is null
    and po.company_id = public.current_company_id()
    and public.is_active_user()
  group by po.id, po.file_name, po.created_at
  order by po.created_at desc
  limit 50;
$$;
