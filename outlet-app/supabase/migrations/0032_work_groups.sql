-- 0032_work_groups.sql
--
-- EXPANSÃO GOSCAN — Painel de Administração (Fase B), parte 1: Grupos de
-- Trabalho reais. Até aqui `profiles.work_group` era texto livre (ver
-- 0028_profile_extended_fields.sql, comentário original: "só usado pra
-- exibição/filtro"). O pedido agora exige gerenciar grupos de verdade
-- (criar/editar/associar/desativar, contagem de usuários, nunca excluir
-- grupo com gente dentro) — isso exige uma tabela normalizada.
--
-- Decisão de escopo: NÃO removemos nem migramos a coluna de texto livre
-- `work_group` — ela continua exatamente como está, usada pela tela "Minha
-- Conta" (fora do escopo desta tarefa, que é só o painel de Administração).
-- A nova coluna `work_group_id` é aditiva e passa a ser a fonte de verdade
-- ESTRUTURADA que o painel administrativo usa pra listar/filtrar/associar —
-- populada por um backfill automático a partir dos valores de texto já
-- existentes, pra não perder nenhum dado.
create table if not exists public.work_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.work_groups is 'Grupos de trabalho reais (Painel de Administração). profiles.work_group (texto livre) continua existindo à parte, sem relação com esta tabela — ver comentário no topo da migration.';

-- Nome único apenas entre grupos ATIVOS (case-insensitive) — permite
-- recriar um nome depois de desativar um grupo homônimo, sem índice único
-- global travando isso.
create unique index if not exists work_groups_active_name_key on public.work_groups (lower(name)) where active;

drop trigger if exists set_updated_at on public.work_groups;
create trigger set_updated_at before update on public.work_groups
  for each row execute function public.set_updated_at();

alter table public.profiles add column if not exists work_group_id uuid references public.work_groups (id);
create index if not exists profiles_work_group_id_idx on public.profiles (work_group_id);

comment on column public.profiles.work_group_id is 'Grupo de trabalho estruturado (Painel de Administração) — distinto do texto livre profiles.work_group (tela Minha Conta), que permanece intocado.';

-- Backfill aditivo: cada valor distinto não vazio já presente em
-- profiles.work_group vira um grupo real, e os profiles correspondentes são
-- associados a ele — nenhum dado é perdido, nenhuma linha é duplicada
-- (roda apenas uma vez de fato, graças ao índice único acima + ON CONFLICT).
do $$
declare
  distinct_group record;
  new_group_id uuid;
begin
  for distinct_group in
    select distinct trim(work_group) as name
    from public.profiles
    where work_group is not null and trim(work_group) <> '' and work_group_id is null
  loop
    insert into public.work_groups (name)
    values (distinct_group.name)
    on conflict (lower(name)) where active do nothing
    returning id into new_group_id;

    if new_group_id is null then
      select id into new_group_id from public.work_groups where lower(name) = lower(distinct_group.name) and active limit 1;
    end if;

    update public.profiles
    set work_group_id = new_group_id
    where trim(work_group) = distinct_group.name and work_group_id is null;
  end loop;
end $$;

alter table public.work_groups enable row level security;

-- Leitura liberada pra qualquer usuário ativo (nomes de grupo não são dado
-- sensível — precisam aparecer em listas/formulários pra qualquer papel).
-- Escrita restrita a super_admin por padrão; a migration 0035 troca isso por
-- has_permission('groups.manage') assim que essa função existir, permitindo
-- delegação real via permissão granular sem reabrir esta migration.
drop policy if exists work_groups_select on public.work_groups;
create policy work_groups_select on public.work_groups
  for select using (public.is_active_user());

drop policy if exists work_groups_write on public.work_groups;
create policy work_groups_write on public.work_groups
  for all
  using (public.is_admin())
  with check (public.is_admin());
