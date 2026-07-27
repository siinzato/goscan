// EXPANSÃO GOSCAN — Central de Ajuda: busca + accordion (<details>/<summary>
// nativos — expandir/recolher e navegação por teclado de graça) + FAQ.
// Conteúdo estático (escrito por nós, não dado de usuário) — não precisa de
// escapeHtml linha a linha, só na busca (query digitada pelo operador).
import { escapeHtml, normalize } from "../../utils.ts";
import { Icon } from "../icons.ts";

interface HelpTopic {
  id: string;
  icon: string;
  title: string;
  html: string;
}

const TOPICS: HelpTopic[] = [
  {
    id: "primeiros-passos",
    icon: Icon.home,
    title: "Primeiros passos no GoScan",
    html: `
      <p>Acesse o GoScan com o e-mail e a senha cadastrados por um administrador. Depois de entrar, use a <strong>navegação inferior</strong> pra circular entre as 6 áreas do app:</p>
      <ul>
        <li><strong>Início</strong> — resumo rápido e atalho pra continuar uma conferência em andamento.</li>
        <li><strong>Conferir</strong> — inicia uma conferência de Outlet (prints, texto ou câmera) ou de produtos normais (Nota Fiscal).</li>
        <li><strong>Escanear</strong> — abre a câmera pra reconhecimento visual de produtos de Outlet.</li>
        <li><strong>Catálogo</strong> — consulta os produtos cadastrados (Outlet e Normais).</li>
        <li><strong>Histórico</strong> — conferências já realizadas, separadas por Outlet e Nota Fiscal.</li>
        <li><strong>Perfil</strong> — seus dados, Configurações, Ajuda e Sobre.</li>
      </ul>
      <p>Seu cargo e nível de acesso aparecem no cabeçalho do Perfil (um selo como "Administrador" ou "Operador") — eles definem quais ações você pode realizar. Pra trocar entre tema claro e escuro, vá em <strong>Perfil → Configurações → Aparência</strong>. Pra sair com segurança, use o botão <strong>Sair</strong> no topo do Perfil — nunca feche a aba sem sair se estiver num computador compartilhado.</p>`,
  },
  {
    id: "conferencia-outlet",
    icon: Icon.camera,
    title: "Como realizar uma conferência de Outlet",
    html: `
      <ol>
        <li>Acesse <strong>Conferir</strong>.</li>
        <li>Escolha a forma de entrada disponível: prints (imagens), texto colado ou câmera.</li>
        <li>Informe ou capture os produtos.</li>
        <li>Revise as sugestões que o sistema encontrou.</li>
        <li>Confirme as correspondências corretas.</li>
        <li>Encaminhe qualquer dúvida real pra <strong>Resolver pendências</strong> — nunca confirme só pra avançar.</li>
        <li>Revise quantidades, cores, nomes e SKUs antes de fechar.</li>
        <li>Finalize a conferência.</li>
        <li>Consulte o relatório gerado e o Histórico sempre que precisar.</li>
      </ol>
      <p>Produtos de Outlet têm um fluxo próprio (reconhecimento visual, memória de treinamento) e ficam sempre separados dos produtos normais — os dois nunca se misturam no catálogo nem na conferência.</p>`,
  },
  {
    id: "reconhecimento-camera",
    icon: Icon.scan,
    title: "Reconhecimento por câmera",
    html: `
      <p>O GoScan analisa as características visuais do produto (formato, cor, tampa, alça, volume) e compara com o catálogo e a memória de reconhecimento já treinada.</p>
      <p><strong>Dicas de escaneamento:</strong></p>
      <ul>
        <li>Limpe a lente da câmera.</li>
        <li>Use um ambiente bem iluminado e evite reflexos fortes.</li>
        <li>Posicione apenas um produto por vez, sobre um fundo visualmente limpo.</li>
        <li>Mantenha o produto inteiro dentro do enquadramento — sem aproximar demais a câmera.</li>
        <li>Capture frente, lateral e detalhes quando o sistema pedir.</li>
        <li>Segure o celular com firmeza e aguarde a estabilização da imagem.</li>
        <li>Confira volume, formato, tampa, alça, cor e demais detalhes antes de confirmar.</li>
        <li>Nunca confirme uma sugestão que pareça errada só pra avançar mais rápido.</li>
      </ul>`,
  },
  {
    id: "interpretar-sugestao",
    icon: Icon.checkCircle,
    title: "Como interpretar uma sugestão",
    html: `
      <p>Uma sugestão do GoScan é sempre uma <strong>correspondência provável</strong>, nunca uma certeza automática — o operador precisa validar o resultado antes de seguir.</p>
      <ul>
        <li>Se a sugestão estiver correta, confirme.</li>
        <li>Se estiver incorreta, pesquise e selecione o produto certo manualmente.</li>
        <li>Se não houver correspondência segura, envie o item pra <strong>pendência</strong> em vez de forçar uma resposta.</li>
      </ul>
      <p>Essa validação humana é o que melhora a memória de reconhecimento ao longo do tempo — por isso vale mais confirmar com calma do que confirmar rápido.</p>`,
  },
  {
    id: "como-aprende",
    icon: Icon.layers,
    title: "Como o GoScan aprende",
    html: `
      <p>O GoScan evolui a partir das validações realizadas durante as conferências. Quando um produto não é reconhecido e o operador informa a correspondência correta, essa associação passa a enriquecer a base de reconhecimento. Quanto mais exemplos confiáveis forem cadastrados e validados, maior tende a ser a assertividade em futuros escaneamentos.</p>
      <div class="warning-box">${Icon.alertTriangle} Associações incorretas prejudicam o reconhecimento de todo mundo — por isso a validação precisa ser cuidadosa, nunca apressada.</div>`,
  },
  {
    id: "criar-reconhecimento",
    icon: Icon.imagePlus,
    title: "Criar reconhecimento",
    html: `
      <ul>
        <li>Localize o SKU correto do produto antes de começar a captura.</li>
        <li>Capture boas imagens: iluminação uniforme, fundo limpo, foco nítido.</li>
        <li>Use vários ângulos (frente, lateral, detalhes) — isso é o que mais melhora a precisão.</li>
        <li>Revise a cor e o modelo indicados antes de salvar.</li>
        <li>Avalie o indicador de qualidade mostrado na tela — ele aponta se a imagem está boa o bastante.</li>
        <li>Nunca reaproveite fotos duplicadas, borradas ou de outro produto só pra completar a etapa.</li>
      </ul>`,
  },
  {
    id: "resolver-pendencias",
    icon: Icon.searchX,
    title: "Resolver pendências",
    html: `
      <p>Uma pendência aparece quando o sistema não encontra uma correspondência segura pra um item.</p>
      <ul>
        <li>Pesquise por nome, SKU ou característica do produto.</li>
        <li>Compare as sugestões disponíveis com calma.</li>
        <li>Confirme o produto correto quando tiver certeza.</li>
        <li>Corrija uma associação já feita, se necessário.</li>
        <li>Devolva o item pra análise (deixe pendente) quando ainda houver dúvida real — melhor pendente do que errado.</li>
      </ul>`,
  },
  {
    id: "conferencia-nf",
    icon: Icon.receipt,
    title: "Conferência por Nota Fiscal",
    html: `
      <p>Fluxo usado pra produtos normais (sem reconhecimento visual):</p>
      <ol>
        <li>Importe o XML da NF-e ou use a entrada disponível no sistema.</li>
        <li>Valide os itens identificados na nota.</li>
        <li>Inicie a conferência física.</li>
        <li>Bipe EAN/SKU quando aplicável.</li>
        <li>A quantidade esperada da NF fica <strong>oculta</strong> durante toda a contagem física (conferência cega).</li>
        <li>Finalize a contagem física.</li>
        <li>O sistema compara a quantidade da NF com a quantidade física.</li>
        <li>Analise faltas, sobras e itens não previstos.</li>
        <li>Gere o relatório final.</li>
      </ol>
      <p>O relatório final apresenta: Nome, SKU, EAN, Quantidade da NF, Quantidade física, Diferença e Status da conferência (OK, Falta, Sobra ou Não conferido).</p>`,
  },
  {
    id: "conferencia-cega",
    icon: Icon.lock,
    title: "Conferência cega",
    html: `
      <div class="notice-box">${Icon.info} A conferência cega evita que o operador seja influenciado pela quantidade informada na Nota Fiscal. Durante a contagem, o foco permanece exclusivamente no que está fisicamente presente. A comparação é revelada somente após a finalização, aumentando a confiabilidade do resultado e reduzindo confirmações automáticas ou erros por expectativa.</div>`,
  },
  {
    id: "leitor-usb",
    icon: Icon.barcode,
    title: "Uso de leitor USB ou tablet",
    html: `
      <ul>
        <li>Conecte o leitor antes de iniciar a contagem.</li>
        <li>Mantenha o campo de bipagem sempre em foco/ativo.</li>
        <li>Bipe um produto por vez.</li>
        <li>Aguarde a confirmação sonora ou visual de cada leitura.</li>
        <li>Confira se a quantidade foi realmente incrementada.</li>
        <li>Se o EAN não for localizado, pesquise manualmente por SKU ou nome antes de pular o item.</li>
        <li>Uma bipagem indevida pode ser corrigida ajustando a quantidade do item antes de finalizar.</li>
        <li>Nunca finalize sem revisar os totais primeiro.</li>
      </ul>`,
  },
  {
    id: "catalogo",
    icon: Icon.package,
    title: "Catálogo",
    html: `
      <ul>
        <li>O catálogo separa claramente <strong>produtos Outlet</strong> (com reconhecimento visual) de <strong>produtos normais</strong> (sem reconhecimento, fluxo por NF) — os dois nunca se misturam.</li>
        <li>Pesquise por nome ou SKU na busca do Catálogo.</li>
        <li>Consulte imagens e informações já cadastradas de cada produto.</li>
        <li>Cadastre ou melhore referências visuais quando tiver permissão pra isso.</li>
      </ul>`,
  },
  {
    id: "historico-relatorios",
    icon: Icon.history,
    title: "Histórico e relatórios",
    html: `
      <ul>
        <li>O Histórico está dividido em <strong>Outlet</strong> e <strong>Nota Fiscal</strong> — cada fluxo com sua própria lista.</li>
        <li>Cada conferência mostra data, operador e status.</li>
        <li>Abra uma conferência pra consultar as divergências encontradas (faltas e sobras).</li>
        <li>Relatórios finalizados podem ser visualizados na tela e exportados.</li>
        <li>Rastreabilidade é o ponto central: cada item leva a um SKU, uma quantidade esperada, uma quantidade física e um responsável.</li>
      </ul>`,
  },
];

const FAQ: { q: string; a: string }[] = [
  { q: "A câmera não abre", a: "Verifique a permissão de câmera do navegador, use uma conexão HTTPS, feche qualquer outro aplicativo que esteja usando a câmera e tente conceder a permissão novamente." },
  { q: "O produto foi reconhecido incorretamente", a: "Não confirme a sugestão errada. Faça uma nova captura com melhor iluminação, tente outro ângulo, pesquise manualmente ou envie o item pra pendência se ainda não tiver certeza." },
  { q: "O EAN não foi encontrado", a: "Confira se o código foi lido por completo, verifique se o produto é normal ou de Outlet, pesquise por SKU ou nome, e encaminhe pra cadastro/correção se realmente não existir." },
  { q: "Meus dados não foram atualizados", a: "Verifique sua conexão, aguarde a confirmação de salvamento na tela e evite fechar a tela no meio de uma operação. Se persistir, tente novamente — o app avisa quando um salvamento falha." },
  { q: "Não consigo acessar um módulo", a: "O acesso pode depender das permissões definidas por um administrador pro seu papel. Consulte o responsável pelo GoScan na sua empresa." },
  { q: "O leitor bipou duas vezes", a: "Revise a quantidade do item antes de finalizar e use a ação de correção/remoção pra ajustar. Sempre confirme o total antes de encerrar a contagem." },
];

let query = "";

export function renderProfileHelp(root: HTMLElement): void {
  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        <button class="btn-secondary" id="btnBackToProfile">${Icon.chevronLeft}Voltar</button>
        <h2>Central de Ajuda</h2>
        <p class="hint-text">Encontre orientações para utilizar os recursos do GoScan com segurança e assertividade.</p>
        <div class="search-row-icon">
          ${Icon.search}
          <input type="search" id="helpSearch" placeholder="Buscar na Ajuda…" value="${escapeHtml(query)}" aria-label="Buscar na Ajuda" />
        </div>
        <div class="help-quicknav" id="helpQuickNav"></div>
      </div>
      <div id="helpTopics"></div>
      <div class="card">
        <h3>${Icon.helpCircle}Perguntas frequentes</h3>
        <div id="helpFaq"></div>
      </div>
    </section>`;

  root.querySelector("#btnBackToProfile")!.addEventListener("click", () => {
    window.location.hash = "/perfil";
  });

  const searchInput = root.querySelector<HTMLInputElement>("#helpSearch")!;
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    renderTopics(root);
    renderFaq(root);
  });

  renderQuickNav(root);
  renderTopics(root);
  renderFaq(root);
}

function renderQuickNav(root: HTMLElement): void {
  const nav = root.querySelector<HTMLElement>("#helpQuickNav")!;
  nav.innerHTML = TOPICS.map((t) => `<button type="button" class="chip" data-jump="${t.id}">${escapeHtml(t.title)}</button>`).join("");
  nav.querySelectorAll<HTMLButtonElement>("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const details = root.querySelector<HTMLDetailsElement>(`#help-${btn.dataset.jump}`);
      if (!details) return;
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function matches(topic: HelpTopic, q: string): boolean {
  if (!q.trim()) return true;
  const haystack = normalize(topic.title + " " + topic.html.replace(/<[^>]+>/g, " "));
  return haystack.includes(normalize(q));
}

function renderTopics(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>("#helpTopics")!;
  const filtered = TOPICS.filter((t) => matches(t, query));

  if (filtered.length === 0) {
    wrap.innerHTML = `<div class="card"><div class="empty-state">${Icon.searchX}<p>Nenhum tópico encontrado pra "${escapeHtml(query)}".</p></div></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="card help-accordion">
      ${filtered
        .map(
          (t) => `
        <details class="help-topic" id="help-${t.id}">
          <summary>
            <span class="help-topic-icon">${t.icon}</span>
            <span class="help-topic-title">${escapeHtml(t.title)}</span>
            <span class="help-topic-chevron">${Icon.chevronDown}</span>
          </summary>
          <div class="help-topic-body">${t.html}</div>
        </details>`
        )
        .join("")}
    </div>`;
}

function renderFaq(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>("#helpFaq")!;
  const filtered = FAQ.filter((f) => !query.trim() || normalize(f.q + " " + f.a).includes(normalize(query)));

  if (filtered.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhuma pergunta frequente bate com essa busca.</p>`;
    return;
  }

  wrap.innerHTML = filtered
    .map(
      (f) => `
    <details class="help-topic">
      <summary>
        <span class="help-topic-title">${escapeHtml(f.q)}</span>
        <span class="help-topic-chevron">${Icon.chevronDown}</span>
      </summary>
      <div class="help-topic-body"><p>${escapeHtml(f.a)}</p></div>
    </details>`
    )
    .join("");
}
