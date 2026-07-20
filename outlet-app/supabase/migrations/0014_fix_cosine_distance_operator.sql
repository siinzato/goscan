-- 0014_fix_cosine_distance_operator.sql
--
-- BUG REAL CRÍTICO encontrado ao investigar "reconhecimento não funciona
-- mesmo com fotos cadastradas": a migration 0012 criou o índice ivfflat com
-- `vector_cosine_ops` (pensado para o operador de distância de cosseno,
-- `<=>`), mas a função match_image_embeddings usava `<->`, que no pgvector é
-- SEMPRE distância Euclidiana (L2), independente do opclass do índice.
--
-- Confirmado com dados reais: para o mesmo par de imagens, a distância de
-- cosseno calculada em JavaScript era 0.08 (alta confiança), enquanto a
-- função retornava 4.38 via `<->` — escalas completamente diferentes. Todos
-- os limiares de confiança (scanConfig.ts) foram calibrados em distância de
-- cosseno (0 a 2) — comparando-os contra L2 (sem limite superior fixo),
-- qualquer variação real de foto (ângulo, luz, fundo) produzia uma distância
-- muito acima de qualquer limiar, mesmo quando o produto certo estava entre
-- os candidatos. Isso derrubava o reconhecimento para toda foto que não
-- fosse byte-a-byte idêntica à referência.
create or replace function public.match_image_embeddings(
  query_embedding vector(512),
  match_model text,
  match_model_version text,
  match_count int default 5
)
returns table (
  product_image_id uuid,
  distance float
)
language sql stable
security definer
set search_path = public, pg_temp
as $$
  select ie.product_image_id, ie.embedding_vector <=> query_embedding as distance
  from public.image_embeddings ie
  join public.product_images pi on pi.id = ie.product_image_id and pi.is_active and pi.archived_at is null
  join public.product_variants pv on pv.id = pi.product_variant_id and pv.active
  join public.products p on p.id = pv.product_id and p.active
  where ie.status = 'ready'
    and ie.model_name = match_model
    and ie.model_version = match_model_version
    and ie.embedding_vector is not null
  order by ie.embedding_vector <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_image_embeddings(vector, text, text, int) to authenticated;
