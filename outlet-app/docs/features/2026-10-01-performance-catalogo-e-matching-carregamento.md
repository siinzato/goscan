---
titulo: "Performance da busca do Catálogo + correção do vínculo automático da Ordem de Carregamento"
data: 2026-10-01
descricao: >
  Busca do Catálogo consolidada de até 5 requests para 2 por busca, medido e validado com dados reais e
  pelo navegador autenticado. Vínculo automático da Ordem de Carregamento corrigido: a cor agora é
  reconhecida em qualquer posição do texto da descrição, e litragem (ml/L/litro) é normalizada antes da
  busca — fazendo muito mais itens vincularem automaticamente sem ação manual.
---

# Performance da busca do Catálogo + correção do vínculo automático da Ordem de Carregamento

## Novidades e correções

### Busca do Catálogo muito mais rápida

- A tela de Catálogo agora fica **interativa na hora** — abas, busca, filtros e paginação respondem imediatamente ao abrir a tela, sem esperar a primeira busca terminar.
- A busca por nome/categoria/família/capacidade foi **consolidada numa única request** ao banco (antes eram 4 requests separadas rodando ao mesmo tempo) — reduz de até 5 para **2 requests por busca**, mantendo exatamente os mesmos critérios e resultados de sempre (nome, SKU, EAN, categoria, família, capacidade, filtros, paginação, ordenação — tudo preservado).
- Removida uma consulta de miniatura que a lista de produtos nunca chegava a exibir.
- Eliminada uma duplicação que fazia a "Visão geral" do Catálogo consultar as contagens 2x ao abrir a tela.
- **Novo indicador visual de carregamento**: campos de busca (Catálogo, vínculo manual na Ordem de Carregamento, conferência Outlet) agora mostram um ícone de "buscando…" enquanto a busca roda, e uma mensagem com botão "Tentar novamente" se algo falhar — nunca mais fica parecendo travado sem explicação.

### Vínculo automático da Ordem de Carregamento muito mais preciso

- O reconhecimento de cor na descrição da planilha agora funciona em **qualquer posição do texto**, não só quando a cor é a última palavra — isso fazia a maioria dos itens reais (com descrições como "BOLSA TOTE MARROM COM TECNOLOGIA GOCASE CONNECT...") não vincular, mesmo tendo toda a informação necessária.
- **Litragem agora é normalizada automaticamente**: "500ml", "500 ML", "0,5L", "0.5L", "1L" e "1 litro" são todos reconhecidos como o mesmo valor, batendo certo com o jeito que o catálogo Outlet já nomeia os produtos.
- Diagnóstico de cada item melhorado: agora é possível ver exatamente qual modelo e cor foram identificados na planilha e por qual caminho o vínculo aconteceu (SKU exato, descrição, texto do produto, ou por que ficou pendente).
- Validado direto contra uma planilha real de produção — itens que antes ficavam sem vínculo nenhum passaram a vincular automaticamente ou, no mínimo, a mostrar as opções certas de candidato para o operador escolher.

## Como usar

Nenhuma mudança de fluxo — tudo continua exatamente onde está, só funcionando melhor:

- **Catálogo**: busca por nome, SKU, EAN, categoria, família ou capacidade funciona igual, só mais rápida e com feedback visual.
- **Ordem de Carregamento**: subir a planilha como sempre — mais itens vinculam sozinhos, e os que precisarem de resolução manual aparecem na mesma tela de pendências de sempre.

## Arquivos principais

- `src/client/ui/screens/catalog.ts` — tela interativa imediatamente, spinner de busca, miniatura só no formulário de edição.
- `src/client/catalogApi.ts` — busca consolidada numa request só, contagens sem duplicação, busca de miniatura avulsa.
- `src/client/loadingOrderApi.ts` — reconhecimento de cor em qualquer posição do texto, normalização de litragem, diagnóstico por item.
- `src/client/matching.ts` — carregamento do catálogo Outlet mais enxuto (variantes filtradas por tipo no próprio banco).
- `src/client/utils.ts` — indicador de carregamento/erro reutilizável para buscas.
- `src/client/ui/screens/conference.ts`, `src/client/ui/screens/loadingOrderConference.ts` — pickers de busca com o novo indicador visual.
- `style.css` — animação do indicador de carregamento.

## Testes realizados

- `npm run typecheck`, `npm run lint`, `npm test` (**402/402**, 25 testes novos) e `npm run build` — tudo passando.
- Consolidação da busca validada com dados reais do catálogo: mesmo resultado de antes, sem perder nenhum item.
- Validação completa pelo navegador, autenticado em produção: busca por texto, por SKU, por EAN, digitação rápida, paginação e troca de filtro — todos os cenários funcionando corretamente.
- Vínculo da Ordem de Carregamento validado contra planilha real de produção, confirmando o ganho real de itens vinculados automaticamente.
