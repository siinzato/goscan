# Conferência de Estoque · Outlet

App mobile-first para conferência de estoque do Outlet a partir de prints (OCR local), texto colado ou planilha, com catálogo de SKUs, matching por apelidos de modelo/cor, exportação para Excel, histórico e agora **autenticação + banco Supabase + PWA instalável**.

Este README cobre a **Fase 1** (migração para Supabase, autenticação, mobile-first, PWA, conferências persistentes). Assume Windows + PowerShell.

## Sumário

- [1. Pré-requisitos](#1-pré-requisitos)
- [2. Instalar dependências](#2-instalar-dependências)
- [3. Criar o projeto no Supabase](#3-criar-o-projeto-no-supabase)
- [4. Rodar as migrations](#4-rodar-as-migrations)
- [5. Criar o `.env`](#5-criar-o-env)
- [6. Criar seu usuário e promover o primeiro admin](#6-criar-seu-usuário-e-promover-o-primeiro-admin)
- [7. Rodar localmente](#7-rodar-localmente)
- [8. Build de produção](#8-build-de-produção)
- [9. Testar como PWA](#9-testar-como-pwa)
- [10. Importar o catálogo atual](#10-importar-o-catálogo-atual)
- [11. Variáveis de ambiente — o que é público e o que é privado](#11-variáveis-de-ambiente--o-que-é-público-e-o-que-é-privado)
- [12. Testes, lint e build](#12-testes-lint-e-build)
- [13. Solução de problemas comuns](#13-solução-de-problemas-comuns)
- [14. Limitações conhecidas desta fase](#14-limitações-conhecidas-desta-fase)

## 1. Pré-requisitos

- **Node.js 22 ou mais recente** (usado e testado com o **Node 24**). Baixe em https://nodejs.org — a versão LTS mais recente serve.
- Uma conta gratuita em https://supabase.com.
- (Opcional) Uma chave de API da Anthropic em https://console.anthropic.com, só se quiser habilitar a leitura de prints por IA — sem ela o app usa OCR local gratuito no navegador.

Verifique a versão do Node no PowerShell:

```powershell
node --version
```

## 2. Instalar dependências

```powershell
cd outlet-app
npm install
```

## 3. Criar o projeto no Supabase

Você **não precisa saber usar a Supabase CLI** — tudo aqui é feito pelo painel web (dashboard).

1. Acesse https://supabase.com/dashboard e crie uma conta (ou entre com uma existente).
2. Clique em **New project**.
3. Escolha uma organização, dê um nome ao projeto (ex.: `outlet-app`), defina uma senha de banco (guarde-a, mas não precisa dela para nada neste guia) e escolha uma região próxima (ex.: `South America (São Paulo)`).
4. Aguarde alguns minutos até o projeto ficar pronto (status "Active").
5. No menu lateral, vá em **Project Settings → API**. Anote dois valores — vamos usá-los no passo 5:
   - **Project URL** (algo como `https://xxxxxxxx.supabase.co`)
   - **anon public** key (uma chave longa começando com `eyJ...`)

## 4. Rodar as migrations

As migrations ficam em `supabase/migrations/` (schema + segurança) e o catálogo atual em `supabase/seed.sql` (gerado a partir do catálogo antigo — já está pronto no repositório, não precisa gerar de novo a menos que edite `src/server/seed-data.ts`).

Como você não precisa da Supabase CLI, rode tudo pelo **SQL Editor** do painel:

1. No painel do projeto, abra **SQL Editor** (menu lateral) → **New query**.
2. Abra o arquivo `supabase/migrations/0001_init_schema.sql` deste repositório, copie todo o conteúdo, cole no SQL Editor e clique em **Run**.
3. Repita o mesmo para `supabase/migrations/0002_rls_policies.sql`.
4. Repita para `supabase/migrations/0003_audit_triggers.sql`.
5. Por fim, abra `supabase/seed.sql`, copie e rode também — isso importa o catálogo de ~180 produtos / ~420 SKUs e os apelidos de modelo/cor que já existiam no protótipo, sem perder nada.

Rode os arquivos **nessa ordem** (0001 → 0002 → 0003 → seed). Se algum passo der erro de "already exists", pode rodar de novo sem problema — as migrations usam `if not exists`/`or replace` e são seguras para repetir.

Se um dia precisar regenerar o `supabase/seed.sql` (por exemplo, se editar `src/server/seed-data.ts` ou `aliases-seed.ts`):

```powershell
npm run generate-seed-sql
```

## 5. Criar o `.env`

Copie o arquivo de exemplo:

```powershell
copy .env.example .env
```

Edite `.env` e preencha:

```
VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
ANTHROPIC_API_KEY=sk-ant-...   (opcional — sem ela, só o OCR local funciona)
```

Use o **Project URL** e a **anon public key** que você anotou no passo 3. **Nunca** coloque a `service_role` key aqui — o app não precisa dela para nada, e ela nunca deve chegar ao navegador.

## 6. Criar seu usuário e promover o primeiro admin

O cadastro público sempre cria usuários com role `operator` (por segurança — ninguém vira admin sozinho). Para ter um admin:

1. Rode o app localmente (próximo passo) e crie uma conta pela tela de login... **espera**: a tela atual só tem login, não cadastro público pelo app — é assim de propósito (evita cadastro aberto num app interno). Para criar o primeiro usuário, use o próprio painel do Supabase:
   - No painel, vá em **Authentication → Users → Add user → Create new user**.
   - Preencha e-mail e senha (marque "Auto Confirm User" para não precisar confirmar por e-mail).
2. Depois de criado, um `profile` com `role='operator'` é gerado automaticamente (trigger `handle_new_user`).
3. Para promover esse usuário a admin, vá em **SQL Editor** e rode (trocando o e-mail):

   ```sql
   update public.profiles
   set role = 'admin'
   where id = (select id from auth.users where email = 'seu-email@exemplo.com');
   ```

4. Pronto — faça login no app com esse e-mail/senha e você terá acesso de admin (pode importar catálogo, ver todas as conferências etc.).

Para criar operadores/managers depois, repita o passo 1 (Authentication → Users → Add user) e, se precisar de manager, rode o mesmo UPDATE trocando `'admin'` por `'manager'`.

## 7. Rodar localmente

Precisa de **dois processos** rodando ao mesmo tempo em desenvolvimento: o servidor Vite (frontend, com hot-reload) e o servidor de API (só serve `/api/parse-images`, mantendo a chave da Anthropic no servidor).

Opção simples — um comando só (já orquestra os dois):

```powershell
npm run dev
```

Isso abre o app em **http://localhost:5173**. O servidor de API sobe junto na porta 8788 (o Vite faz proxy de `/api/*` pra lá automaticamente).

Se preferir rodar cada um em uma janela do PowerShell separada:

```powershell
# janela 1
npm run dev:api

# janela 2
npm run dev:web
```

## 8. Build de produção

```powershell
npm run build
```

Isso roda o typecheck e gera a pasta `dist/`. Para servir o build (frontend + API num único processo/porta, útil para testar produção localmente ou hospedar em um servidor simples):

```powershell
npm run preview
```

Abre em **http://localhost:8788** (ou na porta definida em `PORT`/`API_PORT` no `.env`).

## 9. Testar como PWA

1. Rode `npm run build` seguido de `npm run preview` (o service worker só é gerado no build de produção).
2. Abra `http://localhost:8788` no Chrome/Edge.
3. No desktop: ícone de instalação na barra de endereço, ou menu → "Instalar app".
4. No Android (Chrome): menu → "Adicionar à tela inicial" / prompt automático de instalação.
5. No iPhone (Safari): compartilhar → "Adicionar à Tela de Início". iOS não mostra prompt automático — é sempre manual, isso é uma limitação do Safari, não do app.
6. Para testar o comportamento offline: instale o app, feche a conexão de rede (modo avião) e reabra — o app shell (HTML/CSS/JS) deve carregar do cache; chamadas ao Supabase vão falhar (esperado, mostradas com o aviso de "sem conexão") até a rede voltar.

Os ícones em `public/icons/` são **placeholders gerados por código** (retângulo com a marca "OUT") — troque pelos arquivos definitivos (mesmos nomes: `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`) quando tiver uma arte final.

## 10. Importar o catálogo atual

O catálogo original (seed-data.ts/aliases-seed.ts) já foi migrado pelo `supabase/seed.sql` (passo 4) — não precisa reimportar isso.

Para atualizar o catálogo depois (planilha nova do sistema, correções etc.), faça login como **manager** ou **admin**, vá na aba **Catálogo** e suba um `.xlsx`/`.csv` com colunas reconhecidas automaticamente:

- `Produto` (obrigatório)
- `SKU` / `Código (SKU)` / `Código` (obrigatório)
- `GTIN/EAN` / `GTIN` / `EAN` (opcional)
- `Cor` (opcional — se ausente, tenta extrair do final do nome do produto, ex. `"... - Preto"`)
- `Modelo` / `model_code` (opcional — se ausente, é inferido do SKU)

A importação **nunca apaga** produtos ausentes da planilha nova — é sempre upsert por `sku_code`. No final mostra quantos foram inseridos, atualizados e rejeitados, e fica registrada em `catalog_imports` (visível a managers/admins).

## 11. Variáveis de ambiente — o que é público e o que é privado

| Variável | Onde é usada | Pode aparecer no navegador? |
|---|---|---|
| `VITE_SUPABASE_URL` | frontend | Sim — é pública por design (endpoint da API do Supabase) |
| `VITE_SUPABASE_ANON_KEY` | frontend | Sim — é pública por design; a segurança real vem do RLS no banco |
| `ANTHROPIC_API_KEY` | só `run-local.mjs` / `src/server/server.ts` | **Nunca**. Não prefixe com `VITE_` nunca. |
| `service_role` do Supabase | não é usada em lugar nenhum deste app | **Nunca precise dela aqui** — se algum dia pedirem, é sinal de que algo está sendo feito errado |

`.env` está no `.gitignore` — nunca commite valores reais.

## 12. Testes, lint e build

```powershell
npm run typecheck   # TypeScript --noEmit
npm run lint        # ESLint
npm test            # testes unitários (node --test) — normalize(), escapeHtml(), importação de planilha
npm run build       # typecheck + vite build (também gera o service worker)
```

Todos os quatro comandos acima **foram executados nesta entrega** e passaram (ver relatório final da conversa). O que **não** foi testado de ponta a ponta por não haver um projeto Supabase real conectado nesta sessão: login com credenciais reais, RLS em produção, persistência de conferências, e os fluxos que dependem disso. A tela de login e o tratamento de erro de rede foram verificados visualmente com credenciais Supabase fictícias (para confirmar que a UI renderiza e reage a falhas corretamente) — não é o mesmo que testar contra um projeto real.

## 13. Solução de problemas comuns

**Tela "Configuração incompleta" ao abrir o app**
`.env` não tem `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, ou o servidor de dev não foi reiniciado depois de criar/editar o `.env`. Pare (`Ctrl+C`) e rode `npm run dev` de novo — o Vite só lê `.env` na inicialização.

**Login diz "Failed to fetch"**
`VITE_SUPABASE_URL` está errada/incompleta, ou não há internet. Confira se a URL é exatamente a "Project URL" do painel (com `https://` e sem barra no final).

**Login funciona mas nada aparece / erro 403 em toda consulta**
As migrations de RLS (`0002_rls_policies.sql`) podem não ter rodado, ou o usuário está com `active=false`. Confira em **Table Editor → profiles** no painel do Supabase.

**"new row violates row-level security policy"**
Geralmente é um operator tentando fazer algo reservado a manager/admin (ex.: importar catálogo, editar conferência de outra pessoa, ou alterar `role`/`active` do próprio perfil). Isso é esperado — é a RLS funcionando.

**Prints não são lidos automaticamente**
Sem `ANTHROPIC_API_KEY` configurada (ou sem créditos na conta Anthropic), o app usa OCR local no navegador (Tesseract.js) — mais lento e menos preciso, mas gratuito. Revise sempre os itens antes de exportar.

**Erro ao rodar `npm run generate-seed-sql`**
Precisa ser rodado de dentro da pasta `outlet-app/` (onde está o `package.json`), com Node 22+.

**Ícones do PWA parecem "genéricos"**
São placeholders gerados por `scripts/generate-pwa-icons.mjs` — substitua os arquivos em `public/icons/` por uma arte definitiva quando tiver.

## 14. Limitações conhecidas desta fase

- Sem projeto Supabase real conectado durante o desenvolvimento, os fluxos de login, RLS e persistência de conferências foram implementados e revisados com cuidado, mas **não têm teste de execução real** — siga os passos 3–6 acima e teste na prática antes de considerar Fase 1 encerrada.
- Ícones do PWA são placeholders simples (gerados por código), não uma arte definitiva.
- `data.db` (SQLite local) não é mais usado pelo app — pode ser apagado manualmente; foi deixado no repositório só por precaução.
- Sem testes automatizados de RLS (exigiriam um projeto Supabase real ou `supabase start` local com Docker, fora do escopo desta sessão).
- Não há tela de cadastro público (por design — cadastro é feito pelo painel do Supabase, ver passo 6).
