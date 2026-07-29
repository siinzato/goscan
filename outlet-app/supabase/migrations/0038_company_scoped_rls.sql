-- 0038_company_scoped_rls.sql
--
-- CORREÇÃO ESTRUTURAL — reescreve as policies de conferences/conference_items/
-- invoice_receipts/invoice_receipt_items/receipt_counts para usar
-- company_id = current_company_id() em vez de operator_id/created_by =
-- auth.uid(). Esta é a mudança que resolve de fato "Davi não enxerga as NFs
-- da Victor": antes, a visibilidade era por DONO; agora é por EMPRESA.
--
-- created_by/operator_id/counted_by/finished_by continuam existindo e sendo
-- gravados (auditoria/rastreabilidade — "quem fez o quê"), só deixam de ser
-- usados como regra de VISIBILIDADE.
--
-- Regra de hierarquia preservada: operador comum só edita enquanto
-- draft/in_progress (ou not_started/in_progress para NF-e); manager/admin
-- (da MESMA empresa) sempre pode. Nenhuma empresa acessa registro de outra
-- (toda policy abaixo tem company_id = current_company_id() como condição
-- obrigatória, nunca um "or" que a contorne).

-- ---------------------------------------------------------------------------
-- conferences — qualquer usuário ativo da empresa vê/participa (antes: só o
-- dono ou manager/admin viam).
-- ---------------------------------------------------------------------------
drop policy if exists conferences_select on public.conferences;
create policy conferences_select on public.conferences
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

drop policy if exists conferences_insert on public.conferences;
create policy conferences_insert on public.conferences
  for insert
  with check (public.is_active_user() and operator_id = auth.uid() and company_id = public.current_company_id());

-- Qualquer usuário ativo da empresa edita enquanto draft/in_progress
-- (conferência colaborativa — antes só o operator_id dono editava);
-- manager/admin sempre, mesmo depois de completed (correção administrativa).
drop policy if exists conferences_update on public.conferences;
create policy conferences_update on public.conferences
  for update
  using (
    company_id = public.current_company_id()
    and (status in ('draft', 'in_progress') or public.is_manager_or_admin())
  )
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- conference_items — segue a mesma regra da conferência-pai, agora por
-- empresa em vez de por dono.
-- ---------------------------------------------------------------------------
drop policy if exists conference_items_select on public.conference_items;
create policy conference_items_select on public.conference_items
  for select
  using (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and c.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

drop policy if exists conference_items_insert on public.conference_items;
create policy conference_items_insert on public.conference_items
  for insert
  with check (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and c.company_id = public.current_company_id()
        and (c.status in ('draft', 'in_progress') or public.is_manager_or_admin())
    )
  );

drop policy if exists conference_items_update on public.conference_items;
create policy conference_items_update on public.conference_items
  for update
  using (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and c.company_id = public.current_company_id()
        and (c.status in ('draft', 'in_progress') or public.is_manager_or_admin())
    )
  );

drop policy if exists conference_items_delete on public.conference_items;
create policy conference_items_delete on public.conference_items
  for delete
  using (
    exists (
      select 1 from public.conferences c
      where c.id = conference_items.conference_id
        and c.company_id = public.current_company_id()
        and (c.status in ('draft', 'in_progress') or public.is_manager_or_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- invoice_receipts
-- ---------------------------------------------------------------------------
drop policy if exists invoice_receipts_select on public.invoice_receipts;
create policy invoice_receipts_select on public.invoice_receipts
  for select
  using (company_id = public.current_company_id() and public.is_active_user());

drop policy if exists invoice_receipts_insert on public.invoice_receipts;
create policy invoice_receipts_insert on public.invoice_receipts
  for insert
  with check (public.is_active_user() and created_by = auth.uid() and company_id = public.current_company_id());

drop policy if exists invoice_receipts_update on public.invoice_receipts;
create policy invoice_receipts_update on public.invoice_receipts
  for update
  using (
    company_id = public.current_company_id()
    and (status in ('not_started', 'in_progress') or public.is_manager_or_admin())
  )
  with check (company_id = public.current_company_id());

-- Exclusão de NF: o pedido desta correção é explícito — "o operador não pode
-- excluir uma NF" (nem a que ele mesmo importou). A 0026 permitia o próprio
-- criador excluir enquanto not_started/in_progress; isso é revogado aqui de
-- propósito — passa a ser SEMPRE manager/admin, mudança deliberada de regra
-- de negócio pedida explicitamente, não uma regressão.
drop policy if exists invoice_receipts_delete on public.invoice_receipts;
create policy invoice_receipts_delete on public.invoice_receipts
  for delete
  using (company_id = public.current_company_id() and public.is_manager_or_admin());

-- Dados fiscais originais são imutáveis depois de criados — nem operador nem
-- manager/admin edita número/série/fornecedor/chave/XML pelo cliente (não há
-- fluxo legítimo que precise disso; "esconder o campo" não bastaria como
-- proteção real, ver pedido "4 níveis: interface, rotas, operações,
-- banco/Edge Functions"). status/finished_at/finished_by/started_at
-- continuam livres (é o que o fluxo de contagem/finalização precisa mudar).
create or replace function public.protect_invoice_receipt_fiscal_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.invoice_key := old.invoice_key;
  new.invoice_number := old.invoice_number;
  new.series := old.series;
  new.supplier_name := old.supplier_name;
  new.supplier_cnpj := old.supplier_cnpj;
  new.issued_at := old.issued_at;
  new.xml := old.xml;
  new.created_by := old.created_by;
  new.company_id := old.company_id;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists protect_invoice_receipt_fiscal_fields on public.invoice_receipts;
create trigger protect_invoice_receipt_fiscal_fields before update on public.invoice_receipts
  for each row execute function public.protect_invoice_receipt_fiscal_fields();

-- ---------------------------------------------------------------------------
-- invoice_receipt_items
-- ---------------------------------------------------------------------------
drop policy if exists invoice_receipt_items_select on public.invoice_receipt_items;
create policy invoice_receipt_items_select on public.invoice_receipt_items
  for select
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and r.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

drop policy if exists invoice_receipt_items_insert on public.invoice_receipt_items;
create policy invoice_receipt_items_insert on public.invoice_receipt_items
  for insert
  with check (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and r.company_id = public.current_company_id()
        and (r.status in ('not_started', 'in_progress') or public.is_manager_or_admin())
    )
  );

-- Update pelo cliente continua permitido (vínculo manual de SKU, contagem via
-- RPC atômica — ver 0039) para qualquer usuário ativo da empresa enquanto a
-- NF não foi finalizada; manager/admin sempre. Os campos fiscais originais
-- ficam bloqueados por trigger (abaixo) independente desta policy de linha.
drop policy if exists invoice_receipt_items_update on public.invoice_receipt_items;
create policy invoice_receipt_items_update on public.invoice_receipt_items
  for update
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and r.company_id = public.current_company_id()
        and (r.status in ('not_started', 'in_progress') or public.is_manager_or_admin())
    )
  );

create or replace function public.protect_invoice_receipt_item_fiscal_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.receipt_id := old.receipt_id;
  new.invoice_product_code := old.invoice_product_code;
  new.description := old.description;
  new.ean := old.ean;
  new.unit := old.unit;
  new.unit_value := old.unit_value;
  new.total_value := old.total_value;
  new.expected_quantity := old.expected_quantity;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists protect_invoice_receipt_item_fiscal_fields on public.invoice_receipt_items;
create trigger protect_invoice_receipt_item_fiscal_fields before update on public.invoice_receipt_items
  for each row execute function public.protect_invoice_receipt_item_fiscal_fields();

-- ---------------------------------------------------------------------------
-- receipt_counts (histórico de contagens — nunca editado/apagado por regra
-- de negócio, só select/insert já existiam)
-- ---------------------------------------------------------------------------
drop policy if exists receipt_counts_select on public.receipt_counts;
create policy receipt_counts_select on public.receipt_counts
  for select
  using (
    exists (
      select 1 from public.invoice_receipt_items i
      join public.invoice_receipts r on r.id = i.receipt_id
      where i.id = receipt_counts.item_id
        and r.company_id = public.current_company_id()
    )
    and public.is_active_user()
  );

-- insert continua só via a RPC record_invoice_count_event (0039), que roda
-- SECURITY DEFINER — mas mantemos a policy de insert coerente (defesa em
-- profundidade caso algo chame a tabela direto no futuro).
drop policy if exists receipt_counts_insert on public.receipt_counts;
create policy receipt_counts_insert on public.receipt_counts
  for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.invoice_receipt_items i
      join public.invoice_receipts r on r.id = i.receipt_id
      where i.id = receipt_counts.item_id
        and r.company_id = public.current_company_id()
        and (r.status in ('not_started', 'in_progress') or public.is_manager_or_admin())
    )
  );

-- ---------------------------------------------------------------------------
-- Policies de DELETE de invoice_receipt_items/receipt_counts (0026): eram
-- "redundância defensiva" que seguia o dono (created_by=auth.uid()) — como
-- excluir NF passou a ser manager/admin-only (ver invoice_receipts_delete
-- acima), estas também deixam de aceitar o criador comum, por coerência.
-- Na prática o caminho real é o "on delete cascade" a partir de
-- invoice_receipts; estas policies só cobrem uma exclusão direta do item.
-- ---------------------------------------------------------------------------
drop policy if exists invoice_receipt_items_delete on public.invoice_receipt_items;
create policy invoice_receipt_items_delete on public.invoice_receipt_items
  for delete
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and r.company_id = public.current_company_id()
        and public.is_manager_or_admin()
    )
  );

drop policy if exists receipt_counts_delete on public.receipt_counts;
create policy receipt_counts_delete on public.receipt_counts
  for delete
  using (
    exists (
      select 1 from public.invoice_receipt_items i
      join public.invoice_receipts r on r.id = i.receipt_id
      where i.id = receipt_counts.item_id
        and r.company_id = public.current_company_id()
        and public.is_manager_or_admin()
    )
  );
