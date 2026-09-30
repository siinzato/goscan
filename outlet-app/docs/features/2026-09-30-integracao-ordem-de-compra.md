---
codigo: "#300926"
titulo: "Integração com Ordem de Compra na Conferência por NF-e"
data: 2026-09-30
descricao: >
  Permite anexar a ordem de compra (PDF lido por extração determinística de texto, ou planilha XLSX/CSV) a uma conferência
  de NF-e — avulsa, antes da nota chegar, ou direto numa nota já importada. Ao vincular, o sistema compara automaticamente
  cada GTIN já vinculado na nota contra o SKU que a ordem de compra indica para aquele GTIN, e avisa qualquer divergência
  (nunca corrige sozinho). Nasceu de um caso real: a NF 641425 do fornecedor Rearth veio sem EAN em vários itens (usando
  código de fornecedor em vez disso), e a investigação manual revelou dois SKUs do catálogo com vínculo errado herdado de
  uma conferência anterior. Junto, corrigiu dois bugs reais da bipagem: EAN cadastrado no produto não era usado como
  alternativa quando a NF não trazia EAN, e a sincronização em tempo real apagava esse EAN da tela logo após a primeira
  bipagem, quebrando a segunda tentativa no mesmo item.
---

# Integração com Ordem de Compra na Conferência por NF-e

## Motivação

Na conferência da NF-e 641425 (fornecedor Rearth), diversos itens não traziam o campo EAN preenchido no XML — a Rearth passou a identificar os produtos pelo código de fornecedor (ex.: `MPN:RGM950E245`) em vez do EAN, quebrando a bipagem manual desses itens mesmo o produto tendo EAN cadastrado no catálogo.

Além disso, ao investigar essa mesma nota, descobrimos que dois SKUs do catálogo (`CCRKM1IP18PM-8` e `CCRKM2IP18PM-1`) tinham recebido, numa conferência anterior, o vínculo manual de um código de fornecedor que na verdade pertencia a outro produto Ringke (`MPN:RGM950E245` deveria ser `CCRKM33IP16PM-9`, não `CCRKM1IP18PM-8`) — um erro de vínculo silencioso, sem nenhuma forma automática de detectar.

A correção pontual desses dois casos só foi possível cruzando manualmente a NF-e com a ordem de compra oficial (PDF) do fornecedor, o que levou à ideia de trazer essa mesma conferência para dentro do GoScan.

## O que foi implementado

- **Upload de Ordem de Compra**, em dois formatos: PDF (extração de texto determinística, nunca IA/OCR probabilístico) ou planilha XLSX/CSV.
- A ordem de compra pode ser enviada **avulsa**, antes mesmo da NF-e chegar (tela inicial da Conferência por NF-e → "Ordens de Compra avulsas"), e depois **vinculada** à nota certa quando ela for importada (na Preparação ou já na Contagem Física).
- Ao vincular, o sistema **compara automaticamente** cada GTIN já vinculado na nota contra o SKU que a ordem de compra diz pra aquele GTIN, e mostra um aviso pra qualquer divergência — nunca corrige nada sozinho, só relata.
- Correção, junto com isso, de dois bugs reais na bipagem/busca por EAN da Contagem Física:
  - A bipagem e a busca por texto não consideravam o EAN **cadastrado no produto** como alternativa quando a NF não trazia EAN — só olhavam o campo da própria nota.
  - A sincronização em tempo real (eco da própria bipagem do operador) apagava o EAN cadastrado do item na tela logo após a primeira bipagem, fazendo a segunda bipagem do mesmo produto falhar.

## Como usar

1. Assim que a ordem de compra sair (antes da carga chegar), suba o PDF ou a planilha em **Conferência por NF-e → tela inicial → "Ordens de Compra avulsas"**.
2. Quando a NF-e chegar e for importada, na tela de Preparação (ou na própria Contagem Física) abra a seção **"Ordem de Compra"** e clique em **Vincular**, escolhendo a ordem já enviada.
3. Se alguma divergência for encontrada (vínculo da nota diferente do que a ordem de compra diz para aquele GTIN), ela aparece listada ali — corrija manualmente o vínculo do item afetado.
4. Também é possível anexar a ordem de compra direto numa nota específica, sem passar pela etapa avulsa, se ela já estiver em mãos.

## Arquivos principais

- `supabase/migrations/0061_invoice_purchase_orders.sql` — tabelas `invoice_purchase_orders`/`invoice_purchase_order_items`, RLS, RPC `check_purchase_order_conflicts`.
- `supabase/migrations/0062_purchase_orders_standalone.sql` — permite ordem de compra avulsa (sem NF-e ainda), RPCs `link_purchase_order_to_receipt`/`list_unlinked_purchase_orders`.
- `src/client/purchaseOrderApi.ts` — upload, validação de linhas, parsing de PDF via backend, conflitos.
- `src/server/purchaseOrderPdf.ts` — extração determinística de texto do PDF (`pdf-parse`), sem IA.
- `src/server/server.ts` — rota `/api/parse-purchase-order-pdf`.
- `src/client/ui/screens/nfeConference.ts` — telas de upload/vínculo/relatório de conflitos; correção do EAN cadastrado na bipagem/busca e na sincronização em tempo real (`enterReceiptCollab`).

## Testes realizados

- `npm run typecheck`, `npm run lint` (9 avisos pré-existentes, nenhum novo), `npm test` (364/364, incluindo 7 testes novos do parser de PDF) e `npm run build` — todos passando.
- Extração de PDF validada contra a ordem de compra real do fornecedor Rearth (`ordem_compra_1041302501.pdf`): 44 de 44 itens extraídos corretamente (GTIN, SKU, descrição, quantidade), sem nenhum item com descrição contaminada por cabeçalho de tabela.
- Os dois vínculos errados encontrados na NF 641425 foram corrigidos diretamente no banco (não só documentados): `RGM950E245` recolocado no SKU correto, `FMG891E52` desvinculado (sem correspondência certa na ordem de compra) para resolução manual.

## Limitações conhecidas

- A extração de PDF foi calibrada para o layout específico gerado pelo sistema de compras da própria empresa (Azbuy) — um PDF de outro fornecedor/sistema com layout diferente provavelmente não vai casar com o parser atual e vai precisar de planilha XLSX/CSV até o parser ser estendido.
- O relatório de conflitos só compara pelo GTIN — não sugere vínculo pra itens que não têm EAN nem na NF nem na ordem de compra.
- Vincular uma ordem de compra errada a uma nota é uma ação manual e reversível (é só desvincular e escolher outra), mas não existe ainda uma tela de "detalhe" da ordem de compra em si (só a lista de avulsas e o relatório de conflitos).
