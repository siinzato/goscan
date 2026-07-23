-- 0018_admin_reference_training.sql
--
-- MODO SCAN — "Criar Reconhecimento": treinamento guiado multi-ângulo pra
-- ensinar produtos ao GoScan antes mesmo de aparecerem na operação real.
-- Reaproveita integralmente visual_learning_samples (migration 0016) — a
-- tabela já tinha source_type='admin_upload' previsto desde o início, só
-- nunca tinha uma tela que gravasse com esse valor. Nenhuma biblioteca
-- paralela: a mesma tabela que já alimenta a busca de reconhecimento passa
-- a também receber essas referências.

alter table public.visual_learning_samples add column if not exists view_angle text;
alter table public.visual_learning_samples add column if not exists confidence_weight real not null default 1.0;

comment on column public.visual_learning_samples.view_angle is 'Ângulo da captura guiada (frente/traseira/esquerda/direita/superior/base) — null quando a referência não veio do treinamento guiado (scan confirmado/corrigido em operação).';
comment on column public.visual_learning_samples.confidence_weight is 'Peso de confiança da referência (1.0 = referência oficial/treinamento admin; scans confirmados/corrigidos em operação usam peso menor). Armazenado para uso futuro em reordenação ponderada — o ranking de reconhecimento hoje continua puramente por distância.';

-- Referências de admin_upload nascem já validated (curadoria intencional do
-- administrador, não uma correção de operador em campo que precisa revisão).
update public.visual_learning_samples set confidence_weight = 0.6 where source_type = 'confirmed_scan' and confidence_weight = 1.0;
update public.visual_learning_samples set confidence_weight = 0.8 where source_type = 'corrected_scan' and confidence_weight = 1.0;
