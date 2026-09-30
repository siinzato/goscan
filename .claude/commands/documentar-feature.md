---
description: Documenta uma atualização/feature importante feita no GoScan num arquivo .md em outlet-app/docs/features/
argument-hint: [descrição da feature e o motivo que gerou a necessidade dela]
---

Documente a atualização/feature do GoScan descrita abaixo (ou, se nada for descrito, a mudança mais recente e significativa feita nesta conversa).

## O que fazer

1. **Reconstrua o contexto real** a partir desta conversa e do código: o que mudou de verdade (arquivos, comportamento), por que foi preciso (o problema/incidente/pedido original que motivou — nunca invente uma motivação genérica), e o que foi deliberadamente deixado de fora.
2. **Gere o código da feature**: formato `#DDMMAA` (dia-mês-ano de hoje, 2 dígitos cada — ex.: 30/09/2026 vira `#300926`). Antes de gerar, olhe `outlet-app/docs/features/INDEX.md` — se já existir uma feature com o código de hoje, acrescenta sufixo de letra maiúscula sequencial (`#300926-B`, `#300926-C`, ...; a primeira do dia fica sem sufixo).
3. **Crie um arquivo novo** em `outlet-app/docs/features/AAAA-MM-DD-slug-curto.md` (data de hoje, slug em kebab-case a partir do título) usando o modelo abaixo. Nunca sobrescreva um arquivo de feature já existente — cada atualização é um arquivo novo.
4. **Atualize o índice** `outlet-app/docs/features/INDEX.md` (crie se não existir) adicionando uma linha `- \`#DDMMAA\` [Título](AAAA-MM-DD-slug.md) — resumo de uma linha` no topo (mais recente primeiro).
5. Ao terminar, informe objetivamente ao usuário: o código gerado, o caminho do arquivo criado, e um resumo de 2-3 frases do conteúdo — nunca repita o arquivo inteiro no chat.

## Modelo do arquivo

A descrição (até 1000 caracteres) fica no **frontmatter**, separada do corpo do texto — nunca como uma seção "## Descrição" dentro do corpo.

```markdown
---
codigo: "#DDMMAA"
titulo: "<Título da feature>"
data: AAAA-MM-DD
descricao: >
  <Resumo de até 1000 caracteres: o que a feature faz + o motivo real que gerou a necessidade, numa única passagem
  corrida, sem seções.>
---

# <Título da feature>

## Motivação

<O problema/incidente/pedido REAL que gerou a necessidade — com contexto concreto (nome de fornecedor, número de nota, comportamento observado), nunca uma justificativa genérica tipo "melhorar a experiência".>

## O que foi implementado

<Lista objetiva do que mudou de verdade — comportamento novo, telas novas, tabelas novas. Sem inflar.>

## Como usar

<Passo a passo prático de como usar a feature nova, do ponto de vista de quem opera o GoScan no dia a dia.>

## Arquivos principais

<Lista dos arquivos/migrations mais relevantes criados ou alterados — não precisa ser exaustivo, só os que importam pra entender a mudança.>

## Testes realizados

<O que foi validado de verdade (typecheck/lint/test/build, testes automatizados novos, teste manual contra dado real) — nunca afirme um teste que não rodou.>

## Limitações conhecidas

<O que foi deliberadamente deixado de fora ou ainda não cobre, e por quê.>
```

## Regras

- `descricao` no frontmatter nunca passa de 1000 caracteres — resuma, não corte no meio de uma frase.
- Nunca invente motivação, arquivo alterado ou teste que não aconteceu de verdade nesta conversa/código.
- Se a conversa cobrir mais de uma feature/correção, documente SÓ a que o usuário pediu (ou a mais recente e significativa, se nada foi especificado) — não tente resumir a sessão inteira num arquivo só.
- Português, direto, sem enrolação.

## Pedido do usuário para esta chamada

$ARGUMENTS
