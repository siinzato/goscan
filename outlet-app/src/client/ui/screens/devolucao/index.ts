// EXPANSÃO GOSCAN — Módulo Devolução: orquestração das 3 sub-telas
// (Registrar / Aguardando lançamento / Relatórios). Mesmo padrão de
// render/teardown de nfeConference.ts — montado uma única vez dentro de
// #devolucaoRoot (ver conference.ts), preservando estado entre trocas de
// sub-modo dentro do mesmo mount.
import { renderReturnsListView, renderReturnDetailView, resetReturnDetailState, type DevolucaoNavContext } from "./registerForm.ts";
import { renderLogisticsQueueView, renderBatchDetailView, type LogisticsNavContext } from "./logisticsQueue.ts";
import { renderReportsView } from "./reportsPanel.ts";

type Tab = "registrar" | "fila" | "relatorios";
type RegistrarView = { kind: "list" } | { kind: "detail"; returnId: string };
type FilaView = { kind: "list" } | { kind: "detail"; batchId: string };

let activeTab: Tab = "registrar";
let registrarView: RegistrarView = { kind: "list" };
let filaView: FilaView = { kind: "list" };

export async function renderDevolucao(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="chip-row" id="devolucaoTabs">
      <button type="button" class="chip ${activeTab === "registrar" ? "active" : ""}" data-tab="registrar">Registrar</button>
      <button type="button" class="chip ${activeTab === "fila" ? "active" : ""}" data-tab="fila">Aguardando lançamento</button>
      <button type="button" class="chip ${activeTab === "relatorios" ? "active" : ""}" data-tab="relatorios">Relatórios</button>
    </div>
    <div id="devolucaoContent"></div>`;

  root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab as Tab;
      void renderDevolucao(root);
    });
  });

  const content = root.querySelector<HTMLElement>("#devolucaoContent")!;
  await renderActiveContent(content);
}

async function renderActiveContent(content: HTMLElement): Promise<void> {
  if (activeTab === "registrar") {
    const ctx: DevolucaoNavContext = {
      goToDetail: (id: string) => {
        registrarView = { kind: "detail", returnId: id };
        void renderActiveContent(content);
      },
      goToList: () => {
        registrarView = { kind: "list" };
        void renderActiveContent(content);
      },
    };
    if (registrarView.kind === "list") await renderReturnsListView(content, ctx);
    else await renderReturnDetailView(content, ctx, registrarView.returnId);
  } else if (activeTab === "fila") {
    const ctx: LogisticsNavContext = {
      goToBatchDetail: (id: string) => {
        filaView = { kind: "detail", batchId: id };
        void renderActiveContent(content);
      },
      goToQueueList: () => {
        filaView = { kind: "list" };
        void renderActiveContent(content);
      },
    };
    if (filaView.kind === "list") await renderLogisticsQueueView(content, ctx);
    else await renderBatchDetailView(content, ctx, filaView.batchId);
  } else {
    await renderReportsView(content);
  }
}

/** Chamado por conference.ts ao sair da tela "Conferir" ou trocar de sub-modo — limpa só estado de sessão em memória (undo/último scan), nunca dados persistidos. */
export function teardownDevolucao(): void {
  resetReturnDetailState();
}
