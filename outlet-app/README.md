# GoScan

**Conferência Inteligente de Produtos de Outlet** — uma ferramenta GoGroup.

App mobile-first para conferência de estoque a partir de prints (OCR local), texto colado ou planilha, com catálogo de SKUs, matching por apelidos de modelo/cor, exportação para Excel, histórico, autenticação, banco Supabase e PWA instalável.

Este README cobre a **Fase 1** (migração para Supabase, autenticação, mobile-first, PWA, conferências persistentes) e a identidade visual GoScan/GoGroup. Assume Windows + PowerShell.

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
- [15. Catálogo Visual — base de imagens para o Modo Scan](#15-catálogo-visual--base-de-imagens-para-o-modo-scan)

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
2. Rode, um de cada vez e **nessa ordem exata**, os arquivos de `supabase/migrations/`:
   - `0001_init_schema.sql` — schema principal (profiles, products, product_variants, conferences...).
   - `0002_rls_policies.sql` — RLS de tudo da Fase 1.
   - `0003_audit_triggers.sql` — auditoria de troca de role/status de conferência.
   - `0004_catalog_visual_schema.sql` — tabelas do Catálogo Visual (`product_images`, `catalog_image_imports`, `catalog_image_import_items`).
   - `0005_catalog_visual_rls.sql` — RLS + bucket/policies de Storage do Catálogo Visual.
   - `0006_image_embeddings_future.sql` — tabela desativada/documentada pro futuro Modo Scan (não usada ainda).
   - `0007_catalog_visual_audit_triggers.sql` — auditoria automática de mudanças em imagem.
   - `0008_fix_profile_protection_trigger.sql` — **correção**: a trigger de proteção de perfil da Fase 1 impedia promover admin direto pelo SQL Editor.
   - `0009_fix_products_model_code_upsert.sql` — **correção**: o índice de `products.model_code` era parcial e quebrava o `ON CONFLICT` do upsert (achado testando a importação real).
3. Por fim, abra `supabase/seed.sql`, copie e rode também — isso importa o catálogo de ~180 produtos / ~420 SKUs e os apelidos de modelo/cor que já existiam no protótipo, sem perder nada.

Se algum passo der erro de "already exists", pode rodar de novo sem problema — as migrations usam `if not exists`/`or replace` e são seguras para repetir.

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
| `SUPABASE_URL` | só backend (`run-local.mjs`) — Catálogo Visual | Sim, é a mesma URL pública, sem problema |
| `SUPABASE_SERVICE_ROLE_KEY` | só backend — download de imagem do Catálogo Visual | **Nunca**. Não prefixe com `VITE_` nunca. Sem essa chave, a importação de planilha ainda funciona, só não baixa imagens. |

`.env` está no `.gitignore` — nunca commite valores reais.

## 12. Testes, lint e build

```powershell
npm run typecheck   # TypeScript --noEmit
npm run lint        # ESLint
npm test            # testes unitários (node --test) — normalize(), escapeHtml(), importação de planilha
npm run build       # typecheck + vite build (também gera o service worker)
```

Todos os quatro comandos acima **foram executados nesta entrega** e passaram. Diferente da entrega inicial da Fase 1, esta versão já foi testada de ponta a ponta contra um projeto Supabase real (login, RLS, persistência de conferências e o Catálogo Visual completo — ver seção 15).

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

**Ícones do PWA**
São gerados por `scripts/generate-app-icons.mjs` a partir do símbolo "g" oficial em `public/brand/goscan-symbol-source.png` (recolorido mecanicamente, sem redesenho — ver comentários no script). Se a logo oficial mudar, rode `node scripts/generate-app-icons.mjs` de novo dentro de `outlet-app/`.

## 14. Limitações conhecidas desta fase

- Login, RLS, persistência de conferências e o Catálogo Visual completo (import → download → Storage → aprovação) já foram testados contra um projeto Supabase real (ver seção 15) — não são mais hipotéticos.
- O arquivo de símbolo oficial (`goscan-symbol-source.png`) veio sem transparência real (fundo magenta sólido) e com azul sobre magenta em vez de branco sobre azul institucional — os ícones do PWA foram gerados recolorindo mecanicamente esse arquivo (troca de paleta 1:1, preservando o desenho exato); não é uma arte oficial entregue já pronta para ícone.
- `data.db` (SQLite local) não é mais usado pelo app — pode ser apagado manualmente; foi deixado no repositório só por precaução.
- Sem testes automatizados de RLS (exigiriam um projeto Supabase real ou `supabase start` local com Docker) — a permissão foi validada manualmente (ver seção 15), não há suíte automatizada rodando em CI.
- Não há tela de cadastro público (por design — cadastro é feito pelo painel do Supabase, ver passo 6).
- O limite de tamanho de download (15MB) e o timeout (20s) do Catálogo Visual foram revisados no código, mas não testados em runtime com um arquivo real acima do limite (não havia uma URL de teste tão grande à mão).
- O Modo Scan (reconhecimento por câmera) **não existe ainda** — o Catálogo Visual só prepara a base de imagens (ver seção 15).

## 15. Catálogo Visual — base de imagens para o Modo Scan

### O que é

Uma seção dentro da aba **Catálogo** (alternar "SKUs" / "Catálogo Visual") para cadastrar imagens de referência por **SKU Outlet** — a base que uma fase futura vai usar para reconhecer produtos pela câmera do celular ("Modo Scan"). **Esta fase não implementa a câmera nem gera embeddings** — só o catálogo de imagens, o Storage e toda a estrutura de dados.

### Mapeamento de tabelas (decisão importante)

O enunciado desta fase fala em "Produtos Outlet" (SKU Outlet, nome, GTIN/EAN, ativo). Isso **já existia** desde a Fase 1: é exatamente `product_variants` (`sku_code` = SKU Outlet, `gtin` = GTIN/EAN, `active` = ativo), com o nome em `products.name`. **Não foi criada uma tabela de produtos nova** — `product_images` referencia `product_variants.id` diretamente. O histórico de alterações também reaproveita `audit_logs` (já existente), em vez de uma tabela `image_change_history` separada.

### Tabelas novas

- **`product_images`** — uma linha por imagem (várias por produto). Campos-chave: `storage_path`, `source_url`, `image_hash` (dedup), `mime_type`/`width`/`height`, `is_primary`, `is_active`, `image_type` (catalogo/frontal/lateral/traseira/detalhe/embalagem), `view_angle`, `recognition_enabled`, `quality_status` (pendente/aprovada/rejeitada), `processing_status` (pendente/processando/pronta/erro).
- **`catalog_image_imports`** — cabeçalho de cada importação (arquivo, status, contadores).
- **`catalog_image_import_items`** — uma linha por linha da planilha, com o resultado individual (nunca uma falha derruba a importação inteira).
- **`image_embeddings`** — **desativada, vazia, documentada**: só a estrutura que a futura fase do Modo Scan vai preencher. Não gera dados simulados.

### Bucket e políticas de Storage

Bucket privado **`product-images`**, organizado como `{product_variant_id}/{image_id}.webp` (toda imagem é normalizada pro formato WEBP, redimensionada se passar de 2048px). Políticas em `storage.objects`: leitura para qualquer usuário autenticado e ativo (via URL assinada, 10 min de validade), escrita (insert/update/delete) só para manager/admin.

### RLS

Mesma regra do resto do app: leitura liberada para autenticado+ativo, escrita (importar, cadastrar, arquivar, aprovar) restrita a manager/admin — testado na prática (ver "O que foi testado" abaixo).

### Arquitetura de download (SSRF)

O upload manual (computador/celular) vai **direto do navegador pro Storage**, usando a sessão do próprio manager/admin — não há URL externa envolvida, então não há risco de SSRF nesse caminho.

Já o **import por planilha** baixa URLs de terceiros, e isso só pode acontecer no **backend** (`run-local.mjs` / `src/server/`), nunca no navegador:
- só `http`/`https`;
- bloqueia `localhost`, IPs privados (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x, inclusive o endpoint de metadata de nuvem);
- resolve o DNS uma vez e **pina a conexão nesse IP validado** (evita DNS rebinding);
- revalida do zero cada redirecionamento (até 5), nunca segue cegamente;
- limite de 15MB e timeout de 20s;
- depois do download: confere os magic bytes (não confia no `Content-Type`), decodifica de verdade com `sharp` (rejeita corrompida/formato não suportado), calcula hash sha256 do conteúdo original.

O backend usa a `SUPABASE_SERVICE_ROLE_KEY` (nunca o navegador) — mas só age depois de validar, a cada chamada, que quem está pedindo (`Authorization: Bearer <token da sessão>`) é mesmo manager/admin ativo (`src/server/supabaseAdmin.ts`).

### Processamento em lote

A importação cria os registros de todos os produtos/linhas de uma vez (upsert por SKU Outlet, nunca apaga o que já existe), mas as **imagens** são baixadas em lotes pequenos (`/api/catalog-images/process-batch`, alguns itens por chamada) — o navegador chama repetidamente até zerar o restante, mostrando progresso real. Se a aba fechar no meio, a importação fica com status `processing` e itens `pending`; abrir de novo e clicar **Continuar** retoma exatamente de onde parou (o estado vive no banco, não em memória). Itens com erro ficam isolados (`status='error'` só naquele item) e podem ser reprocessados sozinhos em **Reprocessar erros**.

### Variáveis de ambiente novas

```
SUPABASE_URL=https://<mesmo-projeto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # Project Settings > API > service_role. NUNCA prefixar com VITE_.
```

Sem essas duas, a importação de planilha ainda cria os produtos normalmente, só não baixa imagens (fica tudo "sem imagem" até configurar e reprocessar).

### Como testar a importação

1. Vá em **Catálogo → Catálogo Visual → Importações** (logado como manager/admin).
2. Toque em "Toque para subir XLSX/XLS/CSV" e escolha a planilha (colunas aceitas, em qualquer ordem: **SKU Outlet**, **Nome do produto**, **GTIN/EAN** opcional, **URL da imagem** opcional — a planilha-modelo tem uma linha de título e uma de resumo antes do cabeçalho de verdade; o importador acha o cabeçalho pelo conteúdo, não pela posição).
3. Confira a prévia (válidas, produtos novos vs. já existentes, sem imagem, SKUs duplicados, URLs inválidas) e toque em **Confirmar importação**.
4. Acompanhe o progresso real na tela; ao terminar, toque em **Ver relatório** pra ver o resultado linha a linha.

### Como adicionar imagens pelo celular

Abra o produto em **Catálogo Visual → (buscar/abrir o produto)** e toque em **"Toque para escolher uma foto"** em "Adicionar imagem" — no celular isso abre a câmera diretamente (usa `capture="environment"`). Escolha o tipo (catálogo/frontal/lateral/traseira/detalhe/embalagem) e, opcionalmente, o ângulo, antes ou depois de enviar. A imagem antiga não é apagada quando uma nova é adicionada — use **Arquivar** na imagem antiga se ela não deve mais aparecer (fica preservada no histórico).

### O que foi testado de verdade nesta entrega

Com a planilha anexada (427 produtos Outlet reais) e um projeto Supabase real conectado:

- ✅ Importação completa da planilha real (427 linhas, cabeçalho fora da posição padrão).
- ✅ Criação de produtos novos (6) e atualização dos já existentes (421), sem apagar nada.
- ✅ 426 linhas sem URL → importadas e marcadas "sem imagem" corretamente.
- ✅ 1 linha com URL real (Amazon) → baixada, validada (magic bytes + decodificação real), normalizada pra WEBP, enviada pro Storage, e associada ao SKU certo — **verificado com a imagem renderizando de verdade na tela via URL assinada**.
- ✅ Bug real encontrado e corrigido: `ON CONFLICT` falhava contra o índice parcial de `products.model_code` (migration 0009).
- ✅ Bug real encontrado e corrigido: a função `lookup` do SSRF não respeitava `options.all`, quebrando downloads reais com "Invalid IP address: undefined".
- ✅ Bug real encontrado e corrigido: a trigger `protect_profile_fields` da Fase 1 impedia promover admin via SQL Editor (migration 0008).
- ✅ SSRF: bloqueio de `ftp://`, `localhost`, IP privado (`192.168.x`) e endpoint de metadata de nuvem (`169.254.169.254`) — todos testados de verdade.
- ✅ Imagem corrompida rejeitada (magic bytes não reconhecidos).
- ✅ URL retornando erro HTTP tratada sem derrubar a importação.
- ✅ Dedup por hash: mesma URL pro mesmo produto não duplica (`deduped: true` confirmado).
- ✅ SKU duplicado e URL malformada detectados na prévia.
- ✅ Falha parcial isolada (1 erro em 427, resto seguiu) + reprocessamento do erro isolado funcionando.
- ✅ Permissão por perfil: chamada ao backend como `operator` retornou `403` de verdade; como `admin`, funcionou.
- ✅ Imagem principal automática (primeira imagem de cada produto vira principal).
- ✅ Múltiplas imagens no mesmo produto.
- ✅ Arquivamento de imagem + registro automático no histórico de auditoria.
- ✅ Persistência confirmada após reload completo da página (F5).
- ✅ Testado em viewport mobile (390px) durante todo o processo.
- ⚠️ **Não testado em runtime**: arquivo de imagem realmente acima de 15MB (só revisão de código).
