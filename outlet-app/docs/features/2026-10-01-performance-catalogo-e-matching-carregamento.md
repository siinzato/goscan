---
titulo: "Performance da busca do Catálogo + correção do vínculo automático da Ordem de Carregamento"
data: 2026-10-01
descricao: >
  Duas frentes medidas e corrigidas com evidência real (SQL direto no banco, EXPLAIN ANALYZE, e validação
  autenticada pelo navegador): (1) a busca do Catálogo estava lenta porque uma única busca disparava até
  5 requests ao Supabase (pico de 4 conexões simultâneas) contra um projeto cujo PostgREST só tem um pool
  de 10 conexões — consolidado para 2 requests por busca, sem mudar nenhum critério de busca existente.
  (2) A Ordem de Carregamento estava vinculando automaticamente só ~20% dos itens (41 de 208 numa planilha
  real) porque o algoritmo só reconhecia a cor quando ela estava no final do texto — mas a descrição real
  do remetente sempre tem texto adicional depois da cor, poluindo a busca por nome.
---

# Performance da busca do Catálogo + correção do vínculo automático da Ordem de Carregamento

## Motivação

Dois problemas reais reportados em produção no mesmo período:

1. **"A busca do GoScan continua muito lenta"** — Catálogo, busca por SKU/EAN e os pickers de vínculo manual (Ordem de Carregamento, conferência Outlet) todos pareciam travar, às vezes exigindo F5.
2. **"O vínculo automático da Ordem de Carregamento continua incorreto"** — numa planilha real de 208 itens, apenas 41 vinculavam automaticamente, mesmo quando a planilha trazia informação (modelo + cor) suficiente para identificar o produto no catálogo Outlet.

Nenhuma correção anterior dessas duas frentes tinha sido validada com medição real — este documento resume o que foi efetivamente medido (não suposto) e o que foi corrigido em cima disso.

## O que foi implementado

### 1. Performance do Catálogo

**Causas reais encontradas** (lidas no código, confirmadas com `EXPLAIN ANALYZE` direto no Postgres e com requests reais via navegador autenticado):

- `renderProductsTab()` desenhava a tela na hora, mas só conectava os listeners (abas, busca, paginação, filtros) **depois** de esperar a primeira busca terminar — uma busca lenta deixava a tela inteira "morta" até a resposta chegar.
- `getCatalogOverviewStats()` podia ser chamada 2x em paralelo (visão geral + contagem das abas) com o cache frio, duplicando as 4 consultas de contagem.
- A lista administrativa do Catálogo pedia miniatura (`product_images`) de toda página, mesmo nunca exibindo nenhuma.
- `searchCatalog()` disparava **4 requests paralelas independentes** (nome, categoria, família, capacidade) só para resolver quais `product_id` batem com o termo digitado, e só depois fazia a request principal de variantes — até **5 requests, pico de 4 conexões simultâneas, por UMA busca**.
- **Causa raiz de infraestrutura, confirmada nos logs do projeto Supabase real (`pwwhmegalihwjcgjkdkm`, região sa-east-1)**: o PostgREST desse projeto só tem um **pool de 10 conexões**. Uma query que roda em 2-90ms via conexão direta ao Postgres chega a **3,1-3,3 segundos** (e por vezes erro `57014 canceling statement due to statement timeout`) pelo caminho real que o navegador usa, porque o pool é compartilhado entre todas as abas/operadores e buscas simultâneas disputam as mesmas 10 conexões.

**Correções aplicadas:**

- Listeners da tela de produtos agora são conectados **imediatamente** após o HTML, independente da resposta do backend — a carga de produtos roda em paralelo (`void`), nunca bloqueia a interface.
- `getCatalogOverviewStats()` agora compartilha uma Promise em voo — a 2ª chamada concorrente espera a 1ª em vez de duplicar as 4 consultas.
- Miniatura removida da busca da lista administrativa; o formulário de edição (que precisa da imagem) busca avulsa, só da variante sendo editada (`getPrimaryThumbnailPath`).
- **`searchCatalog()` consolida as 4 requests de resolução de id numa única request**, usando `.or()` com `and(...)` aninhado (mesmo mecanismo que a função já usava para SKU/EAN) — reduz para **2 requests por busca** (pico de 1 conexão). Equivalência de resultado validada com dados reais: união idêntica à das 4 queries antigas, nenhum resultado perdido (e um caso real em que a consolidada até corrigiu uma truncagem silenciosa que as 4 separadas já tinham, cada uma limitada a 200 linhas).
- Indicador visual de carregamento (`⟳`/ícone com animação, threshold de 200ms para nunca piscar em respostas rápidas) adicionado nos pickers de SKU que não davam nenhum feedback (Ordem de Carregamento, conferência Outlet) e na busca do Catálogo — erro real de rede agora mostra "Tentar novamente" em vez de ficar travado.

### 2. Vínculo automático da Ordem de Carregamento

**Causa raiz real** (confirmada rodando o algoritmo contra dados reais de uma planilha de produção, não hipótese): `splitModeloECor()` só reconhecia a cor quando ela era a **última palavra** do texto. Mas a `descricao` real do remetente segue o padrão `"[MODELO] [COR] [texto adicional do remetente]"` — por exemplo `"BOLSA TOTE MARROM COM TECNOLOGIA GOCASE CONNECT(QR CODE) E MANUAL"`. Como a cor nunca estava no final, a função nunca a reconhecia e devolvia o **texto inteiro** (incluindo palavras como "tecnologia"/"connect"/"manual", que não existem em nenhum nome de produto do catálogo) como critério de busca — zerando os candidatos quase sempre.

**Correções aplicadas:**

- `splitModeloECor()` agora procura a cor em **qualquer posição** do texto (com fronteira de palavra garantida, nunca casando substring solta dentro de outra palavra) — ao achar, usa só o texto **antes** da cor como modelo de busca, descartando o texto adicional do remetente depois dela.
- `canonicalizeCapacity()` (nova): normaliza litragem para uma unidade comparável antes da busca — `"500 ML"`, `"0,5L"`, `"0.5L"`, `"1L"` e `"1 litro"` todos convertem para o mesmo formato `"NNNml"` que o catálogo Outlet já usa nos nomes de produto (ex.: "Copo Térmico Life 880ml").
- Prioridade determinística mantida (de correção anterior, revalidada): SKU interno Outlet exato → descrição → produto como texto livre → conflito entre fontes nunca escolhe sozinho (`ambiguous`). Tudo restrito ao catálogo Outlet (`fetchBulkCatalogData("outlet")`, nunca Normal).
- Diagnóstico por item agora guarda **quais atributos foram extraídos** (modelo/cor) junto com a origem do vínculo (`sku_exact`/`description_match`/`produto_text_match`/`ambiguous`/`unlinked`) — permite responder "por que esse item não vinculou?" sem adivinhar.

## Como usar

Nenhuma mudança de fluxo para o operador — tudo é transparente:

- **Catálogo**: buscar normalmente por nome, SKU, EAN, categoria, família ou capacidade continua funcionando igual, só mais rápido (menos requests) e com feedback visual durante a busca.
- **Ordem de Carregamento**: subir a planilha como sempre — mais itens devem vincular automaticamente sem ação manual; os que continuarem pendentes mostram a mesma tela de resolução manual de sempre.

## Arquivos principais

- `src/client/ui/screens/catalog.ts` — listeners desacoplados da 1ª busca, spinner com threshold na busca, miniatura só no formulário de edição.
- `src/client/catalogApi.ts` — `buildCatalogIdFilter()` (consolidação das 4 requests em 1), dedup de `getCatalogOverviewStats()`, `getPrimaryThumbnailPath()`.
- `src/client/loadingOrderApi.ts` — `splitModeloECor()` reescrita (cor em qualquer posição), `canonicalizeCapacity()` (nova), diagnóstico de atributos extraídos por item.
- `src/client/matching.ts` — `fetchBulkCatalogData()` agora filtra variantes por `product_type` no próprio banco (não só produtos); `matchItem()` aceita lista de aliases já carregada (evita I/O em testes/lote).
- `src/client/utils.ts` — `runPickerSearch()` (novo): padrão único de loading/erro-com-retry para pickers de SKU.
- `src/client/ui/screens/conference.ts`, `src/client/ui/screens/loadingOrderConference.ts` — pickers de SKU usando `runPickerSearch()`.
- `style.css` — classe `.icon-spin` (indicador de carregamento animado).

## Testes realizados

- `npm run typecheck`, `npm run lint` (9 avisos pré-existentes, nenhum novo), `npm test` (**402/402**, 25 testes novos: consolidação do filtro de busca, extração de cor em qualquer posição do texto, normalização de capacidade, cenários de vínculo da Ordem de Carregamento) e `npm run build` — todos passando.
- Equivalência da consolidação de busca validada com `EXPLAIN ANALYZE` e dados reais do catálogo (união idêntica às 4 queries antigas).
- **Validação real pelo navegador**, autenticado em produção (não simulada): busca por texto, 2 palavras, SKU, EAN, digitação rápida (6 teclas → só 2 requests, nunca 12, confirmando debounce/`AbortController`), busca sem resultado, paginação e troca de filtro combinada com busca — todos completaram com sucesso (nenhum `500`/`57014`), sem regressão funcional, sem precisar de F5.
- Vínculo da Ordem de Carregamento validado contra dados reais de uma planilha de produção (receipt "carregamento novo", 208 itens) — amostra de itens que antes ficavam `unlinked` (ex.: "Mala Joy Sarja Bege") passou a vincular automaticamente, e vários outros passaram de "0 candidatos" para `ambiguous` com candidatos reais corretos (comportamento seguro quando a planilha não especifica o submodelo exato).

## Limitações conhecidas

- **O teto de performance é de infraestrutura, não de código**: o pool de 10 conexões do PostgREST do projeto Supabase continua sendo o limite real — cada busca individual ainda leva de 1,3 a 3,7 segundos mesmo após a redução de requests, porque a contenção do pool afeta qualquer request que chegue nele. Resolver isso de vez exige aumentar o compute/pool do projeto (decisão de infraestrutura, fora do escopo de código).
- Um erro `400` pré-existente (não introduzido agora) acontece quando o termo de busca é um EAN de 13 dígitos: ele é interpretado como possível capacidade e estoura o `integer` do Postgres — o código já ignora esse erro silenciosamente (só lê `.data`) e o resultado final sai correto mesmo assim (a busca por EAN usa outro caminho), mas o erro aparece no console.
- Vínculo da Ordem de Carregamento: descrições compostas com "/" (ex.: duas opções de produto na mesma célula) não são tratadas especificamente — continuam como pendência manual.
- Vocabulário diferente entre remetente e catálogo (ex.: "Tote **Bag**" vs. "**Bolsa** Tote") não tem correspondência automática — exigiria curadoria de sinônimo na tabela de aliases já existente, não uma mudança de algoritmo.
- Produtos "Coleira" têm uma inconsistência de dados no catálogo (tamanho armazenado no campo de cor da variante, com a cor real embutida no nome do produto) que nenhum algoritmo genérico resolve sem virar regra específica — ficam como pendência manual.
