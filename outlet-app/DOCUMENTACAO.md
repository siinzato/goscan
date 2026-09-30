# Documentação Técnica — GoScan

## 1. Nome do Projeto
**GoScan** — Conferência Inteligente de Produtos GoCase (ferramenta interna GoGroup).

## 2. O que faz
App mobile-first para conferência de estoque/outlet a partir de prints de WhatsApp (lidos por IA ou OCR local), texto colado, planilha ou câmera (reconhecimento visual de produto). Resolve o problema de bater a contagem física contra o catálogo de SKUs manualmente — usado por operadores de estoque (conferência), managers/admins (catálogo, importação, NF-e, devoluções) da GoCase. Resultado: conferências registradas, divergências identificadas, exportação para planilha e histórico auditável.

## 3. Execução
Não é uma automação agendada — é um **app web (SPA) acionado por uso humano direto**, mobile-first, instalável como PWA. Login por e-mail/senha (Supabase Auth), sem cadastro público (usuários criados manualmente no painel Supabase). Acessado hoje via Railway (`goscan-production-2f44.up.railway.app`), com deploy manual via `railway up` (auto-deploy por push no GitHub ainda não está funcional — webhook não instalado).

## 4. Dependências
- **Supabase** (Postgres + Auth + Storage + RLS) — banco principal, autenticação, arquivos de imagem. Chaves: `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (públicas, frontend) e `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (privadas, só backend).
- **Anthropic (Claude Vision)** — leitura de prints de WhatsApp por IA (`ANTHROPIC_API_KEY`, opcional; sem ela cai para OCR local via Tesseract.js).
- **`sharp`** (processamento/normalização de imagem, nativo) e **`@xenova/transformers`** (geração de embeddings visuais para o Modo Scan) — rodam só no backend Node, exigem ambiente com Node completo (não rodam em runtimes tipo Cloudflare Workers).
- **Railway** — hospedagem atual (Node + Docker).

## 5. Fluxo
1. Operador faz login → app carrega perfil/role (`operator`/`manager`/`admin`/`super_admin`) via RLS.
2. Inicia uma **conferência**: escolhe conferência Outlet/Normal ou por NF-e.
3. Alimenta itens por: (a) print de WhatsApp → IA/OCR extrai modelo+cor+quantidade; (b) texto colado (rascunho salvo localmente até confirmar); (c) planilha; (d) Modo Scan (câmera fotografa produto → backend gera embedding → compara com base visual → sugere SKU).
4. Sistema faz **matching** contra o catálogo (por apelido de modelo/cor, SKU ou EAN) — SE não encontra, operador resolve manualmente ("Resolver pendências") ou marca como pendente.
5. Ao confirmar o lote (`Adicionar tudo à conferência`): itens viram registros persistidos; SE a origem foi "Gerar itens do texto", limpa o rascunho local; senão mantém.
6. Encerramento da conferência → cálculo de divergências (contado vs. catálogo) → exportação para Excel e registro em histórico auditável.
7. Fluxos paralelos independentes: **Catálogo** (CRUD de produtos/SKUs, importação em massa, Catálogo Visual com fotos), **NF-e** (conferência por nota fiscal, com botão de voltar/trocar de nota), **Devoluções**.

## 6. Configurar antes de usar
- Node 22+ (testado em 24).
- Projeto Supabase criado, migrations de `supabase/migrations/` rodadas nessa ordem, seed opcional.
- `.env` preenchido (ver README, seção 11) — nunca versionar chaves privadas.
- Primeiro usuário admin promovido manualmente via SQL (`update profiles set role='admin' ...`), pois não há cadastro público.
- Para produção: variáveis de ambiente configuradas no host (hoje Railway), incluindo os *build args* `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` (precisam existir **antes** do primeiro build, senão o bundle sobe sem config).

## 7. Atenção
- **Deploy automático via GitHub quebrado**: push no `main` não redeploya sozinho hoje — precisa `railway up` manual. Causa: instalação do GitHub App/webhook exige fluxo OAuth interativo que só o dono da conta pode concluir pelo navegador.
- **Backend não é portátil para qualquer hosting**: `sharp`/`@xenova/transformers` exigem ambiente Node completo — não migra para runtimes serverless tipo Cloudflare Workers sem reescrever essa parte.
- **Sem cadastro público** (por design) — depende de alguém com acesso ao painel Supabase para criar usuários.
- **Sem testes automatizados de RLS** em CI — permissões validadas manualmente.
- Cache client-side de busca do catálogo (`searchCache`) é por aba/sessão do navegador — uma alteração feita em uma aba não invalida instantaneamente outra aba já aberta com busca antiga (mitigado: nunca cacheia resultado vazio).
- App é PWA com service worker — em alguns cenários de deploy muito espaçado no tempo, cache antigo pode exigir recarregamento forçado (`Ctrl+Shift+R`) para pegar a versão nova.
- Import de planilha só baixa imagem por URL no **backend** (nunca no navegador), com proteção SSRF (bloqueia IP privado/localhost/metadata de nuvem) — ponto sensível de segurança, não simplificar sem entender por quê.
