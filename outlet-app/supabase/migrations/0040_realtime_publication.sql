-- 0040_realtime_publication.sql
--
-- CORREÇÃO ESTRUTURAL — Atualização em tempo real (Supabase Realtime).
--
-- Postgres Changes só transmite eventos de tabelas incluídas na publication
-- supabase_realtime — sem isto, joinCollabSession() (realtimeCollab.ts)
-- assina o canal normalmente mas NUNCA recebe nenhum evento (falha
-- silenciosa, sem erro nenhum). O Realtime já respeita RLS nas mesmas
-- policies desta correção (company_id = current_company_id()) — um usuário
-- de outra empresa não recebe eventos desta tabela mesmo estando "no ar".
--
-- Idempotente: "add table" falha com erro se a tabela já for membro da
-- publication (ex.: se esta migration for aplicada mais de uma vez, ou se o
-- projeto já tiver sido configurado com FOR ALL TABLES) — por isso confere
-- antes via pg_publication_tables em vez de um ADD direto.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['invoice_receipts', 'invoice_receipt_items', 'conferences', 'conference_items']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
