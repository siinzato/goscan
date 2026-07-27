// EXPANSÃO GOSCAN — "Sobre o GoScan": conteúdo institucional estático,
// integrado à identidade visual do app (cards/tokens já existentes).
import { Icon } from "../icons.ts";

const DELIVERABLES: { icon: string; title: string; text: string }[] = [
  { icon: Icon.checkCircle, title: "Conferência inteligente", text: "Centraliza e organiza o processo de identificação e contagem." },
  { icon: Icon.lock, title: "Conferência cega", text: "Reduz a influência das quantidades esperadas e aumenta a confiabilidade." },
  { icon: Icon.scan, title: "Reconhecimento visual", text: "Compara características do produto com o catálogo e a memória cadastrada." },
  { icon: Icon.layers, title: "Aprendizado contínuo", text: "Evolui com associações e validações realizadas durante a operação." },
  { icon: Icon.receipt, title: "Conferência por NF", text: "Relaciona os produtos físicos com os itens presentes na Nota Fiscal." },
  { icon: Icon.barcode, title: "Bipagem por SKU e EAN", text: "Agiliza a contagem de produtos normais utilizando leitores e tablets." },
  { icon: Icon.fileSpreadsheet, title: "Relatórios e divergências", text: "Compara quantidades esperadas e físicas, apontando faltas e sobras." },
  { icon: Icon.history, title: "Histórico e rastreabilidade", text: "Registra conferências, operadores, resultados e decisões." },
  { icon: Icon.gauge, title: "Escalabilidade operacional", text: "Cria uma base confiável para o crescimento e gerenciamento do estoque." },
];

const TIMELINE: string[] = [
  "Desafio operacional do outlet",
  "Organização e categorização dos produtos",
  "Reconhecimento por imagens e câmera",
  "Memória baseada em validações reais",
  "Conferência automatizada por NF",
  "Conferência cega e bipagem",
  "Relatórios, gestão e escalabilidade",
];

export function renderProfileAbout(root: HTMLElement): void {
  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        <button class="btn-secondary" id="btnBackToProfile">${Icon.chevronLeft}Voltar</button>
        <h2>Sobre o GoScan</h2>
      </div>

      <div class="card about-story">
        <p>O GoScan nasceu de uma necessidade real da operação GoCase: tornar mais confiável, organizada e escalável a conferência dos produtos de outlet.</p>
        <p>Antes do GoScan, a identificação, separação, categorização e contagem desses produtos exigiam um processo predominantemente manual. Muitas vezes, as informações disponíveis não apresentavam de forma clara as diferenças de modelo, volume, cor ou estampa, tornando a conferência mais demorada e sujeita a divergências.</p>
        <p>A iniciativa começou com o objetivo de apoiar a conferência dos produtos de outlet por meio de uma experiência mais simples e inteligente. Com a evolução do projeto, o GoScan deixou de ser apenas uma ferramenta de identificação e passou a se tornar um sistema completo de recebimento e conferência automatizada de produtos GoCase.</p>
        <p>Hoje, o aplicativo combina conferência física, reconhecimento visual, catálogo, validação humana, leitura de SKU e EAN, processamento de informações de Nota Fiscal, histórico e relatórios de divergência.</p>
        <p>Um dos principais diferenciais do GoScan é sua capacidade de evoluir com a própria operação. As correspondências confirmadas pelos operadores enriquecem sua memória de reconhecimento, permitindo que o sistema aprenda com exemplos reais e se torne progressivamente mais preparado para futuras conferências.</p>
        <p>O GoScan também utiliza o conceito de conferência cega. Durante a contagem física, a quantidade esperada permanece oculta para que o operador registre somente o que realmente está presente. A comparação com a Nota Fiscal acontece ao final, reduzindo a influência da expectativa e aumentando a confiabilidade do resultado.</p>
        <p>Mais do que identificar produtos, o GoScan foi criado para gerar rastreabilidade, assertividade e inteligência operacional. Cada conferência pode produzir um histórico detalhado com operador, itens, SKUs, EANs, quantidades esperadas, quantidades físicas e divergências encontradas.</p>
        <p>Com isso, o GoScan apoia o recebimento, a conferência de entrada e saída, o controle dos produtos de outlet e o gerenciamento do estoque, oferecendo uma base preparada para acompanhar o crescimento da operação.</p>
      </div>

      <div class="card about-mission">
        <h3>Nossa missão</h3>
        <p>"Transformar a conferência de produtos em um processo inteligente, rastreável e confiável, conectando tecnologia e conhecimento operacional para reduzir erros e apoiar o crescimento da GoCase."</p>
      </div>

      <div class="card">
        <h3>O que o GoScan entrega</h3>
        <div class="about-deliverables">
          ${DELIVERABLES.map(
            (d) => `
            <div class="about-deliverable-card">
              <span class="about-deliverable-icon">${d.icon}</span>
              <strong>${d.title}</strong>
              <span>${d.text}</span>
            </div>`
          ).join("")}
        </div>
      </div>

      <div class="card">
        <h3>Linha de evolução</h3>
        <ol class="about-timeline">
          ${TIMELINE.map((step, i) => `<li><span class="about-timeline-index">${i + 1}</span><span>${step}</span></li>`).join("")}
        </ol>
      </div>

      <div class="about-closing">
        <strong>GoScan — Conferência Inteligente de Produtos GoCase.</strong>
        <span>Uma ferramenta GoGroup.</span>
      </div>
    </section>`;

  root.querySelector("#btnBackToProfile")!.addEventListener("click", () => {
    window.location.hash = "/perfil";
  });
}
