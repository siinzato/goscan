---
codigo: "#021026"
titulo: "Busca instantânea por SKU/EAN e RLS do catálogo avaliada uma vez por consulta"
data: 2026-10-02
descricao: >
  Buscas de produto por SKU/EAN (pickers da Conferência, NF-e, Ordem de Carregamento, Devolução e Catálogo) passaram de
  5–10 segundos para milissegundos. Dois ajustes: (1) o termo que parece SKU ou EAN agora é resolvido primeiro por
  consulta exata nos índices, e a busca por texto só roda se não houver correspondência; (2) as policies de RLS de
  products e product_variants passaram a avaliar a checagem de permissão uma vez por consulta, em vez de uma vez por
  linha. Nasceu de uma queixa real: no Tiny digitar um SKU mostra o produto na hora, e no GoScan levava de 15 segundos a
  1 minuto, às vezes com erro. A medição no banco com RLS de operador mostrou a causa: ~1 ms de custo por linha varrida.
---

# Busca instantânea por SKU/EAN e RLS do catálogo avaliada uma vez por consulta

## Motivação

Digitar um SKU no Tiny mostra o produto praticamente na hora. No GoScan, a mesma busca (por exemplo `GFGCM13OUT-2` no picker da Ordem de Carregamento, que ficava preso em "Buscando…") levava de 15 segundos a 1 minuto, às vezes terminando em erro. O problema aparecia em todo fluxo que resolve SKU/EAN → produto: Catálogo, vínculo manual na NF-e, Ordem de Carregamento, Conferência Outlet e Devolução.

As otimizações anteriores reduziram o número de requests por busca, mas o tempo percebido não mudou. A medição no banco, desta vez com o papel de um operador (com RLS, como os usuários reais), mostrou o motivo: as policies de `products` e `product_variants` chamavam `is_active_user()` e `is_manager_or_admin()` linha a linha, a ~1 ms por linha. Uma busca por texto varria ~4,6 mil linhas, e cada digitação custava de 6 a 10 segundos de banco, segurando uma das ~10 conexões do pool. Medições anteriores com perfil administrador não passavam pela RLS e escondiam isso.

## O que foi implementado

- **Atalho exato por SKU/EAN.** Antes da busca por texto, o termo é classificado: se parece um EAN (só dígitos, com 8, 12, 13 ou 14 dígitos) tenta `gtin_normalized = X`; se parece um SKU (sem espaços e com pelo menos um dígito) tenta `sku_code = X`. Se achar, devolve na hora; se não, a busca por texto roda como sempre. Nome, modelo e cor continuam no caminho de antes, sem consulta extra.
- **RLS avaliada uma vez por consulta.** Migration `0065` envolve a chamada das funções de permissão em `(select ...)` nas quatro policies de `products` e `product_variants`. O Postgres passa a calcular a permissão uma vez por consulta, e não por linha. Nenhuma policy foi removida ou renomeada, a RLS continua habilitada e as permissões funcionais são as mesmas.
- O atalho está num ponto central do `catalogApi.ts` e atende o picker, o Catálogo e a leitura de EAN na Devolução, sem implementação paralela.

### Resultado medido (produção, RLS de operador)

| Cenário | Antes | Depois |
|---|---|---|
| Contagem de produtos | 5.349 ms | 1,7 ms |
| Contagem de variantes | 6.939 ms | 1,8 ms |
| SKU exato | 10,2 ms | 1,7 ms |
| EAN exato | 10,3 ms | 1,7 ms |
| Picker com SKU (busca por texto) | 9.478 ms | 20,9 ms |
| Picker com EAN (busca por texto) | 10.370 ms | 19,9 ms |
| Busca por texto | 10.744 ms | 20,6 ms |
| Carga em massa (Outlet) | 851 ms | 13,9 ms |

## Como usar

Nada muda para o operador: digite ou bipe o SKU ou o EAN em qualquer busca de produto (Catálogo, vínculo manual na NF-e, Conferência Outlet, Ordem de Carregamento, Devolução) e o produto aparece em seguida. Buscar por nome, modelo ou cor funciona como antes, e agora também responde em milissegundos.

## Arquivos principais

- `src/client/catalogApi.ts` — `classifyExactLookupTerm` (classificação pura do termo) e `findExactSkuOrEan` (consulta exata por índice), usados por `searchSkuForPicker` e `searchCatalog`.
- `supabase/migrations/0065_products_rls_initplan.sql` — `ALTER POLICY` nas quatro policies de `products` e `product_variants`.
- `supabase/rollbacks/0065_products_rls_initplan_rollback.sql` — volta às expressões originais, se necessário.
- `tests/catalogApi.test.mjs` — 5 testes novos da classificação do termo.

## Testes realizados

- `npm run typecheck` e `npm test` (407 de 407, incluindo 5 testes novos); `npm run lint` no mesmo patamar de antes (9 avisos pré-existentes, nenhum novo).
- Medição antes e depois no banco real, como operador, com tempo e plano de execução em 8 cenários (tabela acima). O plano depois da migration mostra a checagem de permissão como `InitPlan`, calculada uma vez.
- Matriz de autorização comparada antes e depois no banco real, com resultado idêntico: operador ativo vê 4.604 produtos e 4.608 variantes e não escreve; operador inativo e usuário inexistente não veem nada; super admin vê e escreve tudo; o hash dos ids visíveis é o mesmo.
- O atalho devolve a mesma variante que a busca anterior para um SKU real (`GFGCM13OUT-2`) e um EAN real (`7908918701572`).
- Deploy no Railway concluído com sucesso e o site responde normalmente.

## Escopo

- A mudança é restrita à resolução de SKU/EAN e à leitura das tabelas de produto. Matching da Ordem de Carregamento, NF-e, OCR e Scanner não foram alterados.
- A migration pode ser revertida com o arquivo de rollback.
- Quando o termo é um SKU completo, o Catálogo mostra a variante exata; para ver variações parecidas, basta buscar uma parte do código.
