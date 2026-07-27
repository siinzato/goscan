-- 0031_nfe_lookup_requests.sql
--
-- EXPANSÃO GOSCAN — Consulta automática de NF-e pela chave de acesso (API
-- Meu Danfe v2, via Edge Function consultar-nfe-meudanfe). Esta tabela NÃO
-- armazena a NF-e em si (isso continua sendo invoice_receipts, criada pelo
-- fluxo já existente depois que o XML é processado) — é só o controle
-- mínimo de UMA consulta externa em andamento por chave, pedido
-- explicitamente para:
--   1) nunca disparar duas consultas concorrentes da MESMA chave (a própria
--      documentação do Meu Danfe alerta que isso pode bloquear conta/IP);
--   2) aplicar um intervalo mínimo real entre tentativas (1s) do lado do
--      servidor — não só como uma convenção do polling no cliente;
--   3) saber quantas tentativas já foram feitas e o último erro sanitizado,
--      sem precisar guardar nada sensível.
--
-- Nunca guarda a API key, o XML, nem qualquer header de autenticação.
create table if not exists public.nfe_lookup_requests (
  id uuid primary key default gen_random_uuid(),
  access_key text not null check (access_key ~ '^[0-9]{44}$'),
  requested_by uuid not null references public.profiles (id),
  status text not null default 'waiting' check (status in ('waiting', 'searching', 'ok', 'not_found', 'error')),
  attempt_count integer not null default 0,
  last_polled_at timestamptz,
  sanitized_error text,
  -- Preenchido só depois que o operador efetivamente cria a conferência a
  -- partir do XML retornado (mesmo caminho do upload manual) — não é
  -- gravado pela Edge Function, é informativo para auditoria futura.
  receipt_id uuid references public.invoice_receipts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Uma linha por NF-e (chave de acesso é o identificador natural — sem
-- conceito de empresa/company_id neste projeto, confirmado na análise).
-- Reaproveitada (upsert) entre tentativas e entre operadores diferentes que
-- busquem a mesma chave, de propósito: é o que garante a dedupe do ponto 1
-- acima mesmo com dois operadores diferentes buscando ao mesmo tempo.
create unique index if not exists nfe_lookup_requests_access_key_key on public.nfe_lookup_requests (access_key);
create index if not exists nfe_lookup_requests_requested_by_idx on public.nfe_lookup_requests (requested_by);

drop trigger if exists set_updated_at on public.nfe_lookup_requests;
create trigger set_updated_at before update on public.nfe_lookup_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — de propósito SEM NENHUMA policy para authenticated/anon (nem
-- select, nem insert, nem update). O frontend nunca lê/escreve esta tabela
-- diretamente: todo o ciclo de vida (criar, atualizar status/tentativa,
-- consultar pra decidir se deve chamar o Meu Danfe de novo) acontece DENTRO
-- da Edge Function consultar-nfe-meudanfe, que só usa o client service_role
-- depois de validar o JWT/perfil do usuário (ver seção 6 do pedido). Isso é
-- estritamente mais seguro que uma policy "própria linha ou manager/admin"
-- aqui, já que não há nenhum caso de uso legítimo de leitura direta desta
-- tabela pelo cliente — o status já volta no corpo da resposta da própria
-- Edge Function a cada chamada.
alter table public.nfe_lookup_requests enable row level security;

comment on table public.nfe_lookup_requests is 'Controle/dedup de consultas em andamento à API Meu Danfe por chave de acesso. Nunca guarda API key, XML ou headers. RLS ligado e sem policies: acesso exclusivo via service_role dentro da Edge Function consultar-nfe-meudanfe, sempre depois de validar o usuário chamador.';
