-- 0019_unclassified_product_reports.sql
--
-- MODO SCAN — "Nenhuma dessas opções": quando o operador escaneia um produto,
-- a IA erra a sugestão E o produto correto não existe no catálogo (não é um
-- caso de vincular a um SKU já cadastrado), o app precisa de um jeito de
-- registrar a pendência em vez de travar o operador. Esta tabela guarda essas
-- capturas até um manager/admin cadastrar o produto de verdade e resolver a
-- pendência (nunca é resolvida sozinha, nunca vira SKU automaticamente).
--
-- Toda escrita acontece pelo backend (service_role) — o operador nunca grava
-- direto na tabela, mesmo princípio de visual_learning_samples (0016).

create table if not exists public.unclassified_product_reports (
  id uuid primary key default gen_random_uuid(),
  reported_by uuid references public.profiles (id),
  storage_path text not null,
  observation text,

  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  resolved_variant_id uuid references public.product_variants (id),
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,

  created_at timestamptz not null default now()
);

comment on table public.unclassified_product_reports is 'Pendências de "produto ainda não cadastrado" abertas pelo operador durante o Modo Scan — revisadas manualmente por manager/admin, nunca criam SKU sozinhas.';

create index if not exists unclassified_product_reports_status_idx on public.unclassified_product_reports (status, created_at desc);

alter table public.unclassified_product_reports enable row level security;

-- Leitura: manager/admin (fila de revisão) ou o próprio operador que abriu a pendência.
drop policy if exists unclassified_product_reports_select on public.unclassified_product_reports;
create policy unclassified_product_reports_select on public.unclassified_product_reports
  for select using (reported_by = auth.uid() or public.is_manager_or_admin());

-- Update (resolver/descartar) restrito a manager/admin — nunca insert/delete diretos
-- pelo cliente, sempre pelo backend.
drop policy if exists unclassified_product_reports_update on public.unclassified_product_reports;
create policy unclassified_product_reports_update on public.unclassified_product_reports
  for update using (public.is_manager_or_admin()) with check (public.is_manager_or_admin());

-- Reaproveita o bucket privado "scan-learning-samples" (0016) sob o prefixo
-- "unclassified/" — nenhum bucket novo. A policy de select de 0016
-- (scan_learning_samples_storage_select, bucket inteiro + manager/admin) já
-- cobre esse prefixo, então nenhuma policy de storage nova é necessária aqui.
