-- 0037_companies.sql
--
-- CORREÇÃO ESTRUTURAL — Compartilhamento por empresa.
--
-- CAUSA RAIZ do bug relatado: nada no schema hoje representa "empresa". Toda
-- visibilidade de conferences/invoice_receipts é decidida por
-- operator_id/created_by = auth.uid() (dono) OU is_manager_or_admin() (ver
-- 0002_rls_policies.sql, 0023_nfe_receipts.sql) — um operador comum só
-- enxerga o que ELE MESMO criou. Um operador novo (Davi) nunca vê nada
-- importado por outro operador (Victor), mesmo os dois trabalhando na mesma
-- empresa. Esta migration introduz o conceito real de empresa; a 0038
-- reescreve as policies para usar company_id em vez de dono.
--
-- Arquitetura: 1 linha por empresa em public.companies; cada profile pertence
-- a exatamente uma empresa (profiles.company_id, igual ao pseudo-código do
-- pedido: ".eq('company_id', activeCompanyId)"). Hoje o GoScan tem uma única
-- empresa real em produção — todo profile existente é migrado pra ela sem
-- perder nenhum dado, e o app já fica pronto para múltiplas empresas no
-- futuro sem precisar de outra migration estrutural.

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.companies;
create trigger set_updated_at before update on public.companies
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Empresa única de hoje (produção real) + vínculo em profiles.
-- ---------------------------------------------------------------------------
insert into public.companies (name)
select 'GoCase'
where not exists (select 1 from public.companies);

alter table public.profiles
  add column if not exists company_id uuid references public.companies (id);

-- Backfill: TODO profile existente (inclusive o super_admin real e o Davi já
-- criado) entra na única empresa que existe hoje — nenhum profile fica órfão,
-- ninguém é duplicado/recriado.
update public.profiles
set company_id = (select id from public.companies order by created_at asc limit 1)
where company_id is null;

do $$
declare
  v_orphans integer;
begin
  select count(*) into v_orphans from public.profiles where company_id is null;
  if v_orphans > 0 then
    raise exception 'Aborting: % profile(s) sem company_id após o backfill.', v_orphans;
  end if;
end $$;

alter table public.profiles
  alter column company_id set not null;

create index if not exists profiles_company_id_idx on public.profiles (company_id);

comment on column public.profiles.company_id is 'Empresa à qual este usuário pertence — fonte real de compartilhamento de NFs/conferências (ver 0038_company_scoped_rls.sql). Nunca nulo.';

-- ---------------------------------------------------------------------------
-- current_company_id(): mesma convenção SECURITY DEFINER de current_profile_role()
-- (0002_rls_policies.sql) — evita recursão de RLS, search_path fixo.
-- ---------------------------------------------------------------------------
create or replace function public.current_company_id()
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select company_id from public.profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- conferences.company_id — SEMPRE derivado do operator_id no servidor (nunca
-- aceito do cliente): "o usuário não consiga falsificar um company_id no
-- frontend" é garantido aqui por trigger, não por confiar no valor enviado.
-- ---------------------------------------------------------------------------
alter table public.conferences
  add column if not exists company_id uuid references public.companies (id);

update public.conferences c
set company_id = p.company_id
from public.profiles p
where c.operator_id = p.id and c.company_id is null;

-- Conferência órfã (operador removido sem cascade — não deveria existir, mas
-- não impede a migration): cai na empresa única de hoje em vez de travar.
update public.conferences
set company_id = (select id from public.companies order by created_at asc limit 1)
where company_id is null;

alter table public.conferences
  alter column company_id set not null;

create index if not exists conferences_company_id_idx on public.conferences (company_id);

create or replace function public.set_conference_company_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.company_id := (select company_id from public.profiles where id = new.operator_id);
  return new;
end;
$$;

drop trigger if exists set_conference_company_id on public.conferences;
create trigger set_conference_company_id before insert on public.conferences
  for each row execute function public.set_conference_company_id();

-- ---------------------------------------------------------------------------
-- invoice_receipts.company_id — mesma regra (derivado de created_by, sempre
-- no servidor).
-- ---------------------------------------------------------------------------
alter table public.invoice_receipts
  add column if not exists company_id uuid references public.companies (id);

update public.invoice_receipts r
set company_id = p.company_id
from public.profiles p
where r.created_by = p.id and r.company_id is null;

update public.invoice_receipts
set company_id = (select id from public.companies order by created_at asc limit 1)
where company_id is null;

alter table public.invoice_receipts
  alter column company_id set not null;

create index if not exists invoice_receipts_company_id_idx on public.invoice_receipts (company_id);

create or replace function public.set_invoice_receipt_company_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.company_id := (select company_id from public.profiles where id = new.created_by);
  return new;
end;
$$;

drop trigger if exists set_invoice_receipt_company_id on public.invoice_receipts;
create trigger set_invoice_receipt_company_id before insert on public.invoice_receipts
  for each row execute function public.set_invoice_receipt_company_id();

-- ---------------------------------------------------------------------------
-- RLS de companies — só leitura da própria empresa; gestão de empresas
-- (criar/editar/desativar) fica fora do escopo desta correção (hoje só existe
-- uma empresa real) e não tem UI própria — nunca é o caminho usado pelo app.
-- ---------------------------------------------------------------------------
alter table public.companies enable row level security;

drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select
  using (id = public.current_company_id());
