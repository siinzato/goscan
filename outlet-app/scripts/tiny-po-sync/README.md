# tiny-po-sync

Robô que loga no Tiny (como um humano — sem usar API nenhuma do Tiny, por
decisão explícita), baixa o PDF de cada Ordem de Compra "em aberto" e sobe
pro GoScan como uma ordem de compra avulsa (pra vincular à NF-e depois, na
tela normal de **Conferir → Ordens de Compra**). Pensado pra rodar sozinho,
1x por semana (sexta-feira), no seu PC, via Task Scheduler do Windows.

## 1. Instalar dependências

Na pasta `outlet-app`:

```bash
npm install
npx playwright install chromium
```

## 2. Configurar credenciais

```bash
cd scripts/tiny-po-sync
copy .env.example .env
```

Abra `.env` e preencha:

- `TINY_EMAIL` / `TINY_PASSWORD` — seu login do Tiny.
- `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` — em
  [supabase.com/dashboard](https://supabase.com/dashboard) → seu projeto →
  **Project Settings → API**. A service role key dá acesso total ao banco —
  nunca compartilhe, nunca commite.
- `GOSCAN_COMPANY_ID` — o UUID da sua empresa. Descubra rodando (com o
  Supabase CLI já configurado neste projeto):
  ```bash
  npx supabase db query "select id, name from public.companies;" --linked
  ```

O arquivo `.env` já está no `.gitignore` — não é enviado ao GitHub.

## 3. Ajustar os seletores do Tiny (só na primeira vez)

Eu nunca tive acesso a uma sessão logada do Tiny pra confirmar os nomes
exatos dos botões/links da tela real. `sync.mjs` tem uns 4 pontos marcados
com `AJUSTAR AQUI` que capturam a intenção certa (texto do botão/link), mas
podem precisar de ajuste fino:

1. Rode com o navegador visível pra acompanhar:
   ```bash
   set TINY_HEADLESS=false
   node scripts/tiny-po-sync/sync.mjs
   ```
2. Veja onde ele trava ou clica errado.
3. Me mande a mensagem de erro (e, se puder, um print da tela naquele ponto)
   que eu ajusto o seletor.

Depois de validado, volte `TINY_HEADLESS=true` (ou remova a variável — esse
já é o padrão) pra rodar sozinho, sem abrir janela nenhuma.

## 4. Testar manualmente

```bash
node scripts/tiny-po-sync/sync.mjs
```

O resultado de cada execução fica registrado em `scripts/tiny-po-sync/logs/`
(um arquivo por dia) — inclusive quando dá erro, com um screenshot da tela no
momento da falha.

## 5. Agendar no Windows (Task Scheduler)

1. Abra **Agendador de Tarefas** (`taskschd.msc`).
2. **Criar Tarefa Básica** → nome "GoScan — Sincronizar Ordens de Compra do
   Tiny".
3. Disparador: **Semanalmente**, marque só **Sexta-feira**, escolha o
   horário.
4. Ação: **Iniciar um programa**.
   - Programa/script: `node`
   - Argumentos: `scripts\tiny-po-sync\sync.mjs`
   - Iniciar em: o caminho completo da pasta `outlet-app` (ex.:
     `C:\Users\victo\Downloads\outlet-app\outlet-app`)
5. Nas propriedades da tarefa, marque **"Executar mesmo que o usuário não
   esteja conectado"** — assim ela roda mesmo se você não estiver logado na
   sexta-feira. (Isso pede sua senha do Windows na hora de salvar a tarefa.)

## Como funciona a checagem de duplicidade

Antes de baixar o PDF de cada OC "em aberto", o robô confere no GoScan se já
existe uma ordem de compra com aquele mesmo **número do pedido** pra sua
empresa — se já existir, pula, sem duplicar. Isso funciona mesmo trocando de
PC ou reinstalando do zero (a checagem é no banco, não num arquivo local).

## Limitações conhecidas

- Se o Tiny pedir 2FA/captcha no login, o robô trava (não existe como burlar
  isso de forma automática, nem seria correto tentar) — rode manualmente
  nesse dia.
- Se o Tiny mudar o layout da tela de Ordens de Compra, os seletores em
  `sync.mjs` podem precisar de ajuste (ver passo 3 acima).
- A extração dos dados do PDF (`parsePdf.mjs`) é uma cópia da mesma lógica de
  `src/server/purchaseOrderPdf.ts` — se aquele arquivo for ajustado por causa
  de um novo layout de PDF, replique o ajuste aqui também.
