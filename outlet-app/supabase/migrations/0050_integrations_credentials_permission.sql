-- 0050_integrations_credentials_permission.sql
--
-- EXPANSÃO GOSCAN — usuário pediu um jeito real de cadastrar as chaves de
-- API do ERP (Tiny/Olist) e dos marketplaces (seção 20 do pedido original,
-- agora avançando de "estrutura preparada" para "estrutura pronta para
-- receber as chaves"). Esta migration só adiciona a permissão granular que
-- protege essa ação — o CRUD de credenciais em si continua vivendo
-- exclusivamente na Edge Function admin-users (service_role), nunca direto
-- do frontend (integration_credentials permanece com RLS habilitado e ZERO
-- policies, ver 0049_returns_integration_scaffolding.sql).
--
-- 'integrations.manage' NUNCA entra em role_default_permissions pra 'admin'
-- por padrão (mesmo padrão de 'groups.manage'/'audit.view'/
-- 'users.create_admin' — reservado a super_admin, delegável por override
-- individual em user_permission_overrides) porque credenciais de API são o
-- dado mais sensível do sistema (mesmo mascaradas em trânsito/exibição).
insert into public.permission_catalog (key, label, description, category) values
  ('integrations.manage', 'Gerenciar credenciais de integrações', 'Cadastrar, atualizar e remover credenciais de API do ERP e dos marketplaces.', 'Administração')
on conflict (key) do nothing;

-- super_admin já tem tudo incondicionalmente via has_permission() — nenhuma
-- linha necessária aqui pra ele. 'admin' não recebe por padrão (ver acima).

-- ---------------------------------------------------------------------------
-- integration_credentials.provider_id ganha unicidade real: "um conjunto de
-- credenciais por provedor conectado" é a modelagem pretendida desde a 0049
-- (por isso o CRUD faz upsert por provider_id), mas a constraint física
-- ficou faltando naquela migration. Sem ela, salvar credenciais duas vezes
-- pro mesmo provedor criaria linhas duplicadas em vez de atualizar a
-- existente.
alter table public.integration_credentials
  add constraint integration_credentials_provider_id_key unique (provider_id);
