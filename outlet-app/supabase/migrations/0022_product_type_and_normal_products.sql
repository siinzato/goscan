-- 0022_product_type_and_normal_products.sql
--
-- EXPANSÃO GOSCAN — Produtos Normais: até aqui todo produto era implicitamente
-- Outlet. Adiciona um discriminador EXPLÍCITO (product_type) em vez de
-- depender para sempre de convenção de texto no SKU (ex.: prefixo "OUT-").
-- Default 'outlet' preserva 100% dos dados/linhas existentes sem migração de
-- dados nenhuma. Não cria tabelas paralelas: um "Produto Normal" continua
-- sendo 1 linha em products + 1 em product_variants (sku_code + gtin=EAN),
-- exatamente como um produto Outlet — só muda o valor deste campo.
alter table public.products
  add column if not exists product_type text not null default 'outlet'
  check (product_type in ('outlet', 'normal'));

create index if not exists products_product_type_idx on public.products (product_type);

comment on column public.products.product_type is 'outlet = produto com reconhecimento visual/imagens/treinamento; normal = produto comercial GoCase conferido só por Nota Fiscal (Nome/SKU/EAN). Fonte de verdade explícita — nunca inferir pelo texto do SKU.';

-- Bug real evitado ANTES de acontecer: deriveModelCode (src/client/importer.ts)
-- deriva o mesmo model_code a partir de "TCGCM42-1" (Normal) e "OUT-TCGCM42-1"
-- (Outlet) — ambos viram "TCGCM42" (remove prefixo OUT- e o sufixo -N). Com
-- o índice único antigo (só model_code, ver 0009_fix_products_model_code_upsert.sql),
-- importar produtos normais faria upsert (ON CONFLICT) EM CIMA da linha
-- outlet já existente e sobrescreveria seu product_type — exatamente a
-- fusão que o pedido original proíbe explicitamente (seção 5: "Não fundir
-- os dois registros"). A unicidade agora é por (model_code, product_type):
-- mesma família comercial pode existir uma vez para outlet e uma vez para
-- normal, nunca a mesma linha.
drop index if exists public.products_model_code_key;
create unique index if not exists products_model_code_type_key on public.products (model_code, product_type);

-- catalog_imports reaproveitada também para o import de Produtos Normais
-- (Nome/SKU/EAN) em vez de criar uma tabela de import paralela — só precisa
-- saber a que tipo de produto aquele import se refere.
alter table public.catalog_imports
  add column if not exists product_type text not null default 'outlet'
  check (product_type in ('outlet', 'normal'));

comment on column public.catalog_imports.product_type is 'Tipo de produto importado nesta planilha — outlet (SKU/Cor/GTIN) ou normal (Nome/SKU/EAN).';
