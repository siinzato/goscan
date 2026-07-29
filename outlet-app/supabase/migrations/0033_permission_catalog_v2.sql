-- 0033_permission_catalog_v2.sql
--
-- EXPANSÃO GOSCAN — Painel de Administração (Fase B), parte 2: catálogo de
-- permissões granulares real. permission_catalog já existia (ver
-- 0029_permission_overrides.sql) como scaffold da Fase B com 8 chaves
-- provisórias — CONFIRMADO que nenhuma delas foi usada em nenhuma tela,
-- rota ou policy até agora (a Fase B nunca chegou a ser implementada), e
-- user_permission_overrides está vazia (nenhuma linha as referencia). Por
-- isso são substituídas em vez de deixadas ao lado: manter as duas
-- convenções de nomes (ex.: "manage_users" E "users.manage") lado a lado
-- seria exatamente o "dois sistemas de permissões concorrentes" que o
-- pedido proíbe.
alter table public.permission_catalog add column if not exists category text;

delete from public.user_permission_overrides; -- vazia hoje (scaffold nunca usado) — nunca destrutivo pra dado real.
delete from public.permission_catalog;

insert into public.permission_catalog (key, label, description, category) values
  ('home.view', 'Acessar o início', 'Ver a tela inicial do GoScan.', 'Início'),

  ('conference.start', 'Iniciar conferência', 'Começar uma nova conferência (prints, texto ou câmera).', 'Conferências'),
  ('conference.continue', 'Continuar conferência', 'Retomar uma conferência em andamento.', 'Conferências'),
  ('conference.finish', 'Finalizar conferência', 'Encerrar e consolidar uma conferência.', 'Conferências'),
  ('conference.nfe', 'Conferência por Nota Fiscal', 'Importar XML, buscar por chave e conferir uma NF-e.', 'Conferências'),

  ('scanner.use', 'Usar o scanner (câmera)', 'Reconhecimento de produtos por câmera durante a conferência.', 'Scanner e reconhecimento'),
  ('recognition.create', 'Criar reconhecimento', 'Cadastrar imagens de referência pra memória visual.', 'Scanner e reconhecimento'),
  ('recognition.validate', 'Validar/ensinar reconhecimento', 'Confirmar ou corrigir sugestões de reconhecimento.', 'Scanner e reconhecimento'),

  ('catalog.view', 'Ver catálogo', 'Consultar produtos, SKUs e EANs cadastrados.', 'Catálogo'),
  ('catalog.create', 'Cadastrar produtos', 'Importar planilhas e criar novos produtos/SKUs.', 'Catálogo'),
  ('catalog.edit', 'Editar produtos', 'Alterar dados de produtos/SKUs já cadastrados.', 'Catálogo'),

  ('pending.view', 'Ver pendências', 'Consultar itens não reconhecidos/não localizados.', 'Pendências'),
  ('pending.resolve', 'Resolver pendências', 'Vincular manualmente itens não reconhecidos/não localizados.', 'Pendências'),

  ('history.view', 'Ver histórico', 'Consultar o histórico de conferências já realizadas.', 'Histórico e relatórios'),
  ('reports.view', 'Ver relatórios', 'Consultar relatórios de conferência.', 'Histórico e relatórios'),
  ('reports.export', 'Exportar relatórios', 'Exportar relatórios de conferência em PDF/Excel.', 'Histórico e relatórios'),

  ('users.manage', 'Gerenciar usuários', 'Criar, editar, ativar e desativar contas de usuário (respeitando a hierarquia).', 'Administração'),
  ('users.create_admin', 'Criar administradores', 'Criar contas com papel Administrador — além de operador/visualizador.', 'Administração'),
  ('permissions.manage', 'Gerenciar permissões', 'Conceder ou revogar permissões granulares de outros usuários.', 'Administração'),
  ('groups.manage', 'Gerenciar grupos de trabalho', 'Criar, editar e desativar grupos de trabalho.', 'Administração'),
  ('audit.view', 'Consultar auditoria', 'Ver o registro de ações administrativas.', 'Administração');

comment on column public.permission_catalog.category is 'Agrupamento pra exibição no painel (Início/Conferências/Scanner e reconhecimento/Catálogo/Pendências/Histórico e relatórios/Administração).';
