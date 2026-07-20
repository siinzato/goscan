-- 0013_conference_items_camera_scan.sql
--
-- MODO SCAN — Parte 4: permite que um item de conferência venha da câmera
-- (source='camera_scan'), reaproveitando conference_items — nenhuma tabela
-- paralela de "itens do Scan". match_confidence já existia desde a 0001
-- (nunca usada até agora); recognition_id é novo, só para correlacionar um
-- item salvo com a linha de log do /api/scan/recognize que o gerou (o log
-- nunca grava o quadro/vetor, só o recognition_id + metadados).
alter table public.conference_items
  drop constraint if exists conference_items_source_check;

alter table public.conference_items
  add constraint conference_items_source_check
  check (source in ('manual', 'text', 'screenshot', 'import', 'camera_scan'));

alter table public.conference_items
  add column if not exists recognition_id uuid;

comment on column public.conference_items.recognition_id is 'ID do reconhecimento visual (Modo Scan) que originou este item, quando source=camera_scan — correlaciona com o log do backend, nunca com dado sensível.';
comment on column public.conference_items.match_confidence is 'Score de similaridade visual (0 a 1) quando o item veio do Modo Scan; nulo para os outros source.';
