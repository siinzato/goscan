-- 0052_integration_multi_store.sql
--
-- EXPANSÃO GOSCAN — até aqui, integration_providers guardava NO MÁXIMO 1
-- linha por (company_id, provider) — suficiente enquanto cada marketplace só
-- tinha uma loja. A operação real da empresa tem várias lojas por
-- marketplace (ex.: Mercado Livre AZ + AZ Filial 02 + GoCase), então cada
-- linha desta tabela passa a representar uma CONEXÃO/LOJA individual —
-- várias linhas por (company_id, provider), até 4. A tabela já era
-- exatamente "1 registro independente vinculado ao marketplace" (nunca
-- colunas Loja1/Loja2/Loja3/Loja4) — só faltava permitir mais de uma por
-- provedor e nomear cada uma.
--
-- integration_credentials não muda de forma nenhuma: seu provider_id já
-- referencia uma linha de integration_providers (agora "uma conexão"), e o
-- unique(provider_id) da migration 0050 já garante "um conjunto de
-- credenciais por conexão" — exatamente o isolamento pedido, sem precisar
-- tocar nessa tabela.

-- ---------------------------------------------------------------------------
-- Novos campos de identificação da loja/conexão (pedido, seção 16 — nunca só
-- o nome completo como identificador: marca/unidade/modalidade separados).
-- ---------------------------------------------------------------------------
alter table public.integration_providers
  add column if not exists display_name text,
  add column if not exists brand text,
  add column if not exists branch text,
  add column if not exists fulfillment_mode text,
  add column if not exists is_active boolean not null default true;

comment on column public.integration_providers.display_name is 'Nome amigável editável da loja/conexão (ex.: "Az — FBA Classic"). Nunca o único identificador — brand/branch/fulfillment_mode ficam separados (pedido, seção 16).';
comment on column public.integration_providers.brand is 'Empresa/marca dona da loja (ex.: az, gocase) — texto livre, mesmo padrão de profiles.work_group. NÃO é o mesmo conceito de company_id (o tenant único do GoScan) — é um rótulo operacional dentro da mesma empresa.';
comment on column public.integration_providers.branch is 'Unidade/filial (ex.: principal, filial_02) — texto livre, opcional.';
comment on column public.integration_providers.fulfillment_mode is 'Modalidade logística (ex.: fba_classic, fba_onsite, fulfillment, shein_fulfillment, tiktok_local) — nunca decide sozinha qual é o marketplace (isso é sempre a coluna provider).';
comment on column public.integration_providers.is_active is 'Loja ativada/desativada pelo usuário — independente de "status" (que é a saúde da conexão real). Uma loja desativada continua contando pro limite de 4 (ver trigger abaixo) — só "Remover" libera a vaga.';

-- Backfill idempotente: linhas que já existiam antes desta migration (a
-- única loja de cada provedor, salva antes de existir o conceito de
-- múltiplas lojas) viram literalmente "a primeira loja daquele marketplace"
-- — sem perder nenhum dado, sem duplicar (roda de novo sem efeito porque só
-- afeta display_name ainda nulo).
update public.integration_providers
set display_name = case provider
  when 'tiny' then 'Tiny / Olist ERP'
  when 'marketplace_mercado_livre' then 'Mercado Livre'
  when 'marketplace_shopee' then 'Shopee'
  when 'marketplace_shein' then 'Shein'
  when 'marketplace_amazon' then 'Amazon'
  when 'marketplace_tiktok' then 'TikTok Shop'
  else provider
end
where display_name is null;

-- ---------------------------------------------------------------------------
-- unique(company_id, provider) da 0049 impedia exatamente o que agora
-- queremos permitir (mais de uma loja por marketplace) — substituída por um
-- índice comum (não-único) pras mesmas consultas de sempre (por
-- empresa+marketplace), e por uma trava real de limite via trigger abaixo.
-- ---------------------------------------------------------------------------
alter table public.integration_providers
  drop constraint if exists integration_providers_company_id_provider_key;

create index if not exists integration_providers_company_provider_idx on public.integration_providers (company_id, provider);
create index if not exists integration_providers_status_idx on public.integration_providers (status);
create index if not exists integration_credentials_external_account_idx on public.integration_credentials (external_account_id) where external_account_id is not null;

-- ---------------------------------------------------------------------------
-- Limite real de 4 lojas por marketplace por empresa — em banco, não só na
-- interface (pedido, seção 5/12: "impedir também a criação pelo backend, e
-- não apenas pela interface"). Conta TODAS as linhas já cadastradas
-- (ativas ou desativadas) — desativar uma loja não libera vaga pra outra
-- diferente; só "Remover" (delete) libera. Mesmo padrão de defesa em
-- profundidade já usado em protect_last_super_admin (0035): o Edge Function
-- já checa a contagem antes de tentar inserir (erro amigável), e este
-- trigger é a garantia incondicional por baixo, mesmo se o backend tiver um
-- bug ou for chamado de outro jeito.
-- ---------------------------------------------------------------------------
create or replace function public.protect_integration_connection_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.integration_providers
  where company_id = new.company_id and provider = new.provider;

  if v_count >= 4 then
    raise exception 'Limite de 4 lojas/conexões atingido para este marketplace.' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_integration_connection_limit on public.integration_providers;
create trigger protect_integration_connection_limit
  before insert on public.integration_providers
  for each row execute function public.protect_integration_connection_limit();

-- ---------------------------------------------------------------------------
-- Seed das lojas reais já operadas pela empresa (pedido, seção 15/18) — só
-- os registros de identificação (nome/marca/unidade/modalidade), SEM
-- nenhuma credencial e com status 'not_configured' (nunca marcado como
-- conectado sem validação real, ver 0049). Idempotente: só insere se ainda
-- não existir uma linha com o mesmo display_name pra aquele provedor+empresa
-- (roda de novo sem duplicar). "Az — Geral" fica de fora de propósito — o
-- pedido pede explicitamente para não associá-la a nenhum marketplace sem
-- antes confirmar sua finalidade real.
-- ---------------------------------------------------------------------------
do $$
declare
  v_company_id uuid;
  v_seed record;
begin
  select id into v_company_id from public.companies order by created_at asc limit 1;
  if v_company_id is null then
    return; -- sem empresa nenhuma ainda (banco novo) — nada a semear
  end if;

  for v_seed in
    select * from (values
      ('marketplace_amazon', 'Az — FBA Classic', 'az', 'principal', 'fba_classic'),
      ('marketplace_amazon', 'Az — FBA OnSite', 'az', 'principal', 'fba_onsite'),
      ('marketplace_mercado_livre', 'Az — ML Fulfillment', 'az', 'principal', 'fulfillment'),
      ('marketplace_mercado_livre', 'Az Filial 02 — ML Fulfillment', 'az', 'filial_02', 'fulfillment'),
      ('marketplace_mercado_livre', 'GoCase — ML Fulfillment', 'gocase', 'principal', 'fulfillment'),
      ('marketplace_shopee', 'Az — Shopee Fulfillment', 'az', 'principal', 'shopee_fulfillment'),
      ('marketplace_shopee', 'GoCase — Shopee Fulfillment', 'gocase', 'principal', 'shopee_fulfillment'),
      ('marketplace_shein', 'GoCase — Shein Fulfillment', 'gocase', 'principal', 'shein_fulfillment'),
      ('marketplace_tiktok', 'GoCase — TikTok Local', 'gocase', 'principal', 'tiktok_local')
    ) as t(provider, display_name, brand, branch, fulfillment_mode)
  loop
    if not exists (
      select 1 from public.integration_providers
      where company_id = v_company_id and provider = v_seed.provider and display_name = v_seed.display_name
    ) then
      insert into public.integration_providers (company_id, provider, display_name, brand, branch, fulfillment_mode, status, is_active)
      values (v_company_id, v_seed.provider, v_seed.display_name, v_seed.brand, v_seed.branch, v_seed.fulfillment_mode, 'not_configured', true);
    end if;
  end loop;

  -- Tiny NÃO faz parte do recurso de múltiplas lojas (pedido, seção 9) — mas
  -- o painel de Integrações sempre espera 1 linha existente pra guardar
  -- credenciais nela (o modelo novo cria a linha primeiro, credenciais
  -- depois — nunca mais via upsert-por-provider). Garante essa única linha
  -- aqui, do mesmo jeito que ela já existiria se alguém tivesse configurado
  -- o Tiny antes desta migration — sem credencial nenhuma, status inalterado.
  if not exists (select 1 from public.integration_providers where company_id = v_company_id and provider = 'tiny') then
    insert into public.integration_providers (company_id, provider, display_name, status, is_active)
    values (v_company_id, 'tiny', 'Tiny / Olist ERP', 'not_configured', true);
  end if;
end;
$$;
