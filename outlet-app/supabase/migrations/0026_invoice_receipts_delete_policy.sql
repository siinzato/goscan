-- 0026_invoice_receipts_delete_policy.sql
--
-- EXPANSÃO GOSCAN — Histórico de Notas gerenciável: permite excluir uma NF
-- importada por engano. A 0023 nunca criou política de DELETE pra
-- invoice_receipts/invoice_receipt_items/receipt_counts — com RLS ligado e
-- sem policy, a operação é negada em silêncio (delete afeta 0 linhas), então
-- sem isto o botão de excluir nunca funcionaria de verdade.
--
-- Mesma regra de invoice_receipts_update: o próprio operador só pode excluir
-- enquanto a NF ainda não foi finalizada (not_started/in_progress — nenhum
-- relatório auditável em jogo ainda). Uma NF já finalizada (completed/
-- with_divergences) é um documento histórico definitivo — só manager/admin
-- pode excluí-la, e mesmo assim como correção explícita e deliberada.
--
-- invoice_receipt_items e receipt_counts têm "on delete cascade" a partir de
-- invoice_receipts/invoice_receipt_items, então excluir a NF já remove os
-- itens e contagens junto. As policies abaixo nessas duas tabelas são
-- redundância defensiva (mesmo critério), não o caminho principal de uso.
drop policy if exists invoice_receipts_delete on public.invoice_receipts;
create policy invoice_receipts_delete on public.invoice_receipts
  for delete
  using (
    (created_by = auth.uid() and status in ('not_started', 'in_progress'))
    or public.is_manager_or_admin()
  );

drop policy if exists invoice_receipt_items_delete on public.invoice_receipt_items;
create policy invoice_receipt_items_delete on public.invoice_receipt_items
  for delete
  using (
    exists (
      select 1 from public.invoice_receipts r
      where r.id = invoice_receipt_items.receipt_id
        and (
          (r.created_by = auth.uid() and r.status in ('not_started', 'in_progress'))
          or public.is_manager_or_admin()
        )
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
        and (
          (r.created_by = auth.uid() and r.status in ('not_started', 'in_progress'))
          or public.is_manager_or_admin()
        )
    )
  );
