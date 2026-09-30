-- 0061_invoice_purchase_orders.sql
--
-- ORDEM DE COMPRA POR NF-e — permite anexar a ordem de compra (planilha com
-- GTIN/SKU/descrição/quantidade) a uma conferência de NF-e específica, para
-- detectar automaticamente vínculos errados entre código do fornecedor e SKU
-- do catálogo (ex.: dois produtos Ringke diferentes vinculados ao mesmo SKU
-- por engano em "Resolver pendências" de uma nota anterior — achado real na
-- NF 641425). Não substitui nada do matching existente (nfeMatching.ts) nem
-- do vínculo manual — é só uma fonte de verdade adicional pra CONFERIR e
-- SUGERIR, nunca aplica mudança sozinha.

-- ---------------------------------------------------------------------------
-- 1) Cabeçalho de cada ordem de compra anexada — várias podem ser anexadas
--    à mesma NF-e (ex.: pedido dividido em mais de uma OC), nunca substitui
--    uma anterior automaticamente.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.invoice_receipts(id) on delete cascade,
  file_name text not null,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists invoice_purchase_orders_receipt_id_idx on public.invoice_purchase_orders(receipt_id);

-- ---------------------------------------------------------------------------
-- 2) Uma linha por item da ordem de compra. gtin_normalized usa a MESMA
--    normalização (dígitos apenas) já usada em product_variants.gtin_normalized
--    e em todo o resto do app — nunca uma segunda regra de normalização.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.invoice_purchase_orders(id) on delete cascade,
  gtin_normalized text not null,
  sku_code text not null,
  description text,
  quantity numeric(14, 3),
  created_at timestamptz not null default now()
);

create index if not exists invoice_purchase_order_items_po_id_idx on public.invoice_purchase_order_items(purchase_order_id);
create index if not exists invoice_purchase_order_items_gtin_idx on public.invoice_purchase_order_items(gtin_normalized);

-- ---------------------------------------------------------------------------
-- 3) RLS — mesmo padrão de invoice_receipt_items (ver 0043/0045): leitura
--    para qualquer usuário ativo da MESMA empresa da nota; escrita (anexar)
--    restrita a manager/admin, sempre através de invoice_receipts.company_id
--    (nunca uma company_id própria nessas tabelas — evita dessincronia).
-- ---------------------------------------------------------------------------
alter table public.invoice_purchase_orders enable row level security;
alter table public.invoice_purchase_order_items enable row level security;

drop policy if exists invoice_purchase_orders_select on public.invoice_purchase_orders;
create policy invoice_purchase_orders_select on public.invoice_purchase_orders
  for select
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_purchase_orders.receipt_id
        and r.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

drop policy if exists invoice_purchase_orders_insert on public.invoice_purchase_orders;
create policy invoice_purchase_orders_insert on public.invoice_purchase_orders
  for insert
  with check (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_purchase_orders.receipt_id
        and r.company_id = public.current_company_id()
    )
    and public.is_manager_or_admin()
  );

drop policy if exists invoice_purchase_orders_delete on public.invoice_purchase_orders;
create policy invoice_purchase_orders_delete on public.invoice_purchase_orders
  for delete
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_purchase_orders.receipt_id
        and r.company_id = public.current_company_id()
    )
    and public.is_manager_or_admin()
  );

drop policy if exists invoice_purchase_order_items_select on public.invoice_purchase_order_items;
create policy invoice_purchase_order_items_select on public.invoice_purchase_order_items
  for select
  using (
    exists (
      select 1 from public.invoice_purchase_orders po
      join public.invoice_receipts r on r.id = po.receipt_id
      where po.id = invoice_purchase_order_items.purchase_order_id
        and r.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

drop policy if exists invoice_purchase_order_items_insert on public.invoice_purchase_order_items;
create policy invoice_purchase_order_items_insert on public.invoice_purchase_order_items
  for insert
  with check (
    exists (
      select 1 from public.invoice_purchase_orders po
      join public.invoice_receipts r on r.id = po.receipt_id
      where po.id = invoice_purchase_order_items.purchase_order_id
        and r.company_id = public.current_company_id()
    )
    and public.is_manager_or_admin()
  );

drop policy if exists invoice_purchase_order_items_delete on public.invoice_purchase_order_items;
create policy invoice_purchase_order_items_delete on public.invoice_purchase_order_items
  for delete
  using (
    exists (
      select 1 from public.invoice_purchase_orders po
      join public.invoice_receipts r on r.id = po.receipt_id
      where po.id = invoice_purchase_order_items.purchase_order_id
        and r.company_id = public.current_company_id()
    )
    and public.is_manager_or_admin()
  );

-- ---------------------------------------------------------------------------
-- 4) RPC de conferência — cruza a ordem de compra anexada contra os itens JÁ
--    vinculados da NF-e (por GTIN), devolvendo só os que DIVERGEM (SKU
--    vinculado ≠ SKU que a ordem de compra diz pra aquele GTIN) e os que
--    ainda estão SEM vínculo mas a ordem de compra já indica um SKU exato no
--    catálogo — nunca aplica nada sozinha, só relata pro operador decidir.
-- ---------------------------------------------------------------------------
create or replace function public.check_purchase_order_conflicts(p_receipt_id uuid)
returns table (
  item_id uuid,
  invoice_product_code text,
  description text,
  gtin_normalized text,
  po_sku_code text,
  po_description text,
  po_quantity numeric,
  linked_sku_code text,
  suggested_variant_id uuid,
  kind text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.is_active_user() then
    raise exception 'Usuário inativo — fale com um administrador.';
  end if;

  return query
  with matched as (
    select
      ir.id as item_id,
      ir.invoice_product_code,
      ir.description,
      poi.gtin_normalized,
      poi.sku_code as po_sku_code,
      poi.description as po_description,
      poi.quantity as po_quantity,
      linked_pv.sku_code as linked_sku_code,
      suggested_pv.id as suggested_variant_id,
      case
        when ir.product_variant_id is not null and linked_pv.sku_code is distinct from poi.sku_code then 'conflict'
        when ir.product_variant_id is null and suggested_pv.id is not null then 'suggestion'
        else null
      end as kind
    from public.invoice_receipt_items ir
    join public.invoice_purchase_orders po on po.receipt_id = ir.receipt_id
    join public.invoice_purchase_order_items poi
      on poi.purchase_order_id = po.id
     and poi.gtin_normalized = coalesce(
           (select v.gtin_normalized from public.product_variants v where v.id = ir.product_variant_id),
           -- item ainda sem vínculo: casa pelo EAN que a própria NF trouxe, se houver
           regexp_replace(coalesce(ir.ean, ''), '[^0-9]', '', 'g')
         )
    left join public.product_variants linked_pv on linked_pv.id = ir.product_variant_id
    left join public.product_variants suggested_pv on suggested_pv.gtin_normalized = poi.gtin_normalized and suggested_pv.active = true
    where ir.receipt_id = p_receipt_id
  )
  select item_id, invoice_product_code, description, gtin_normalized, po_sku_code, po_description, po_quantity, linked_sku_code, suggested_variant_id, kind
  from matched
  where kind is not null;
end;
$$;
