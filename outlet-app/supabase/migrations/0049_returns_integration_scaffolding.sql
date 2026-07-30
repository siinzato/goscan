-- 0049_returns_integration_scaffolding.sql
--
-- EXPANSÃO GOSCAN — Seção 20 do pedido do módulo Devolução: estrutura
-- preparada (e DESATIVADA por padrão) para futuras integrações com
-- Tiny/Olist e os marketplaces. Nada aqui é consultado/processado nesta
-- etapa — o fluxo manual continua sendo o único caminho real. Ver
-- src/client/integrations/ pro contrato TypeScript correspondente.
--
-- Segurança de credenciais (pedido, seção 20.4): nenhum token/segredo fica
-- acessível ao cliente. integration_credentials tem RLS habilitado e
-- PROPOSITALMENTE nenhuma policy — isso nega acesso por padrão pra
-- authenticated/anon (só service_role, que ignora RLS, consegue ler/escrever
-- essa tabela). Nunca criar uma policy de select/insert/update nela.

-- ---------------------------------------------------------------------------
-- Vínculos externos opcionais em return_items (nunca obrigatórios — o fluxo
-- manual não depende de nenhum deles).
-- ---------------------------------------------------------------------------
alter table public.return_items
  add column if not exists external_product_id text,
  add column if not exists external_return_item_id text;

-- ---------------------------------------------------------------------------
-- integration_feature_flags — tudo desligado por padrão (pedido, seção
-- 20.3). A interface nunca deve mostrar um botão funcional de integração
-- enquanto a flag correspondente estiver false.
-- ---------------------------------------------------------------------------
create table if not exists public.integration_feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text,
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.integration_feature_flags;
create trigger set_updated_at before update on public.integration_feature_flags
  for each row execute function public.set_updated_at();

insert into public.integration_feature_flags (key, description) values
  ('tiny_integration_enabled', 'Integração com Tiny/Olist ERP habilitada'),
  ('marketplace_mercado_livre_enabled', 'Integração com Mercado Livre habilitada'),
  ('marketplace_shopee_enabled', 'Integração com Shopee habilitada'),
  ('marketplace_shein_enabled', 'Integração com Shein habilitada'),
  ('marketplace_amazon_enabled', 'Integração com Amazon habilitada'),
  ('marketplace_tiktok_enabled', 'Integração com TikTok Shop habilitada'),
  ('auto_query_order_enabled', 'Consulta automática de pedido/pacote habilitada'),
  ('auto_query_invoice_enabled', 'Consulta automática de nota fiscal habilitada'),
  ('auto_verify_cancellation_enabled', 'Verificação automática de cancelamento de nota habilitada'),
  ('auto_verify_chargeback_enabled', 'Verificação automática de estorno de estoque habilitada'),
  ('auto_stock_launch_enabled', 'Lançamento automático de estoque habilitado'),
  ('webhook_receiving_enabled', 'Recebimento de webhooks de marketplace/Tiny habilitado')
on conflict (key) do nothing;

alter table public.integration_feature_flags enable row level security;

drop policy if exists integration_feature_flags_select on public.integration_feature_flags;
create policy integration_feature_flags_select on public.integration_feature_flags
  for select using (public.is_active_user());

drop policy if exists integration_feature_flags_write on public.integration_feature_flags;
create policy integration_feature_flags_write on public.integration_feature_flags
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- integration_providers — status de conexão por empresa/provedor. NUNCA
-- guarda segredo (isso é integration_credentials, abaixo) — só metadados de
-- status, visíveis a manager/admin da própria empresa.
-- ---------------------------------------------------------------------------
create table if not exists public.integration_providers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  provider text not null check (provider in ('tiny', 'marketplace_mercado_livre', 'marketplace_shopee', 'marketplace_shein', 'marketplace_amazon', 'marketplace_tiktok')),
  status text not null default 'not_configured' check (status in ('not_configured', 'configuration_incomplete', 'connected', 'auth_error', 'sync_paused')),
  config jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  next_retry_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, provider)
);

comment on column public.integration_providers.config is 'Configuração NÃO sensível apenas (ex.: nome do depósito padrão). Nunca token/client_secret — isso vive em integration_credentials, sem acesso via API pública.';
comment on column public.integration_providers.status is 'not_configured/configuration_incomplete/connected/auth_error/sync_paused — nunca "connected" sem validação real do provedor (ver pedido, seção 20.3).';

drop trigger if exists set_updated_at on public.integration_providers;
create trigger set_updated_at before update on public.integration_providers
  for each row execute function public.set_updated_at();

alter table public.integration_providers enable row level security;

drop policy if exists integration_providers_select on public.integration_providers;
create policy integration_providers_select on public.integration_providers
  for select
  using (company_id = public.current_company_id() and public.is_manager_or_admin());

-- Sem policy de insert/update/delete: nesta etapa não há UI nem fluxo real
-- que grave nesta tabela — fica reservada para quando uma integração de
-- verdade for configurada (por uma Edge Function com service_role).

-- ---------------------------------------------------------------------------
-- integration_credentials — NUNCA exposta ao cliente (frontend/anon/
-- authenticated). RLS habilitado, ZERO policies: só service_role (que
-- ignora RLS) consegue ler ou escrever.
-- ---------------------------------------------------------------------------
create table if not exists public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.integration_providers (id) on delete cascade,
  access_token text,
  refresh_token text,
  client_id text,
  client_secret text,
  expires_at timestamptz,
  scopes text,
  external_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.integration_credentials;
create trigger set_updated_at before update on public.integration_credentials
  for each row execute function public.set_updated_at();

alter table public.integration_credentials enable row level security;
-- Propositalmente sem nenhuma create policy abaixo desta linha.

-- ---------------------------------------------------------------------------
-- sync_outbox — fila/outbox preparada para operações externas futuras.
-- NUNCA processada nesta etapa (sem cron/poller/worker) — só o schema existe
-- (ver pedido, seção 20.6: "a fila não deve ser processada nesta etapa").
-- ---------------------------------------------------------------------------
create table if not exists public.sync_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  operation_type text not null check (
    operation_type in ('query_order', 'query_return', 'query_invoice', 'verify_cancellation', 'verify_chargeback', 'stock_movement', 'confirm_stock_movement', 'process_webhook')
  ),
  provider text not null check (provider in ('tiny', 'marketplace_mercado_livre', 'marketplace_shopee', 'marketplace_shein', 'marketplace_amazon', 'marketplace_tiktok')),
  related_table text,
  related_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'completed', 'failed', 'waiting_retry', 'cancelled', 'manual_intervention_required')
  ),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists sync_outbox_company_id_idx on public.sync_outbox (company_id);
create index if not exists sync_outbox_status_idx on public.sync_outbox (status);
create index if not exists sync_outbox_related_idx on public.sync_outbox (related_table, related_id) where related_id is not null;

comment on table public.sync_outbox is 'Preparação de fila/outbox para integrações futuras — schema apenas, sem worker/poller nesta etapa. Chave de idempotência das operações reais fica no payload (ver src/client/integrations/idempotency.ts).';

alter table public.sync_outbox enable row level security;

drop policy if exists sync_outbox_select on public.sync_outbox;
create policy sync_outbox_select on public.sync_outbox
  for select
  using (company_id = public.current_company_id() and public.is_manager_or_admin());

-- Sem policy de insert/update/delete: nenhum produtor real existe nesta
-- etapa (fluxo 100% manual) — reservado para quando um provedor real puder
-- enfileirar/consumir operações via service_role.
