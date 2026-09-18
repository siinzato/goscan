import { escapeHtml, debounce, renderErrorWithRetry, describeError, formatDateTime, formatOperationDuration, parseConferirHash, type ConferirHashInfo } from "../../utils.ts";
import { matchItems, matchItem, type MatchResult } from "../../matching.ts";
import { parseImagesLocally } from "../../ocr.ts";
import { searchSkuForPicker, type CatalogRow } from "../../catalogApi.ts";
import {
  startOrResumeConference,
  addItem,
  removeItem,
  updateItemQuantity,
  updateItemMatch,
  finalize,
  subscribeSession,
  type Session,
  type SessionItem,
} from "../../conferenceSession.ts";
import { getConferenceFinalSummary, type ConferenceFinalSummary } from "../../conferencesApi.ts";
import { exportItemsToXlsx } from "../../exporter.ts";
import { stopCollabSession } from "../../realtimeCollab.ts";
import { getAuthState } from "../../auth.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction } from "../confirmModal.ts";

// ---------------------------------------------------------------------------
// CORREÇÃO URGENTE — autosave local do rascunho de "Colar texto". Protege
// contra perda de texto em F5/fechamento inesperado (sem depender de
// beforeunload/timer/chamada assíncrona — o próprio evento `input` já
// persiste). Só localStorage, nunca Supabase; separado por usuário+conferência
// pra nunca vazar rascunho entre contas/operações. NUNCA deve derrubar a tela
// de Conferir se localStorage estiver indisponível (Safari privado, quota
// cheia, etc.) — por isso os três helpers abaixo nunca lançam.
// ---------------------------------------------------------------------------
function textDraftKey(userId: string, conferenceId: string): string {
  return `goscan:outlet:text-draft:${userId}:${conferenceId}`;
}

function loadTextDraft(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveTextDraft(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage indisponível (ex.: modo privado sem suporte) — a
    // conferência continua funcionando normalmente, só sem autosave.
  }
}

function clearTextDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // idem — nunca quebra o fluxo por causa disso.
  }
}

let pendingImages: { data: string; media_type: string; name: string }[] = [];
let candidates: MatchResult[] = [];
// Identifica se o lote ATUAL de candidates veio de "Gerar itens do texto" —
// só nesse caso o #btnConfirmAll pode apagar o rascunho de #textInput. Gerar
// via imagem sobrescreve candidates e derruba essa flag; linha manual não
// mexe nela (não é uma nova origem, só um ajuste no lote já existente).
let candidatesFromText = false;
// idx dos candidatos com SKU de origem "manual" (digitado/escolhido pelo operador) —
// esses nunca são sobrescritos automaticamente quando Produto/Cor mudam (ver
// wireCandidateModeloEditing). Reconstruído a cada render a partir de MatchResult
// não é suficiente porque "manual" não é um MatchStatus — por isso o Set separado.
const manualOverrides = new Set<number>();
let unsubscribeSession: (() => void) | null = null;

const MATCH_BADGE: Record<string, { cls: string; icon: string; label: string }> = {
  matched: { cls: "success", icon: Icon.checkCircle, label: "OK" },
  matched_parcial: { cls: "warning", icon: Icon.alertTriangle, label: "Parcial" },
  modelo_nao_encontrado: { cls: "error", icon: Icon.xCircle, label: "Modelo?" },
  cor_nao_encontrada: { cls: "warning", icon: Icon.alertTriangle, label: "Cor?" },
  sku_nao_cadastrado: { cls: "error", icon: Icon.xCircle, label: "Sem SKU" },
  ambiguous: { cls: "warning", icon: Icon.alertTriangle, label: "Escolher produto" },
  manual: { cls: "info", icon: Icon.pencil, label: "Manual" },
};

/** Mensagem por status, conforme o comportamento esperado pelo operador (ver spec). */
function statusMessage(c: MatchResult, isManual: boolean): string {
  if (isManual) return "SKU informado manualmente";
  switch (c.status) {
    case "matched":
    case "matched_parcial":
      return "SKU reconhecido automaticamente";
    case "ambiguous":
      return "Mais de um produto corresponde — escolha uma opção abaixo.";
    default:
      return "Produto não reconhecido — informe o SKU manualmente ou selecione um produto.";
  }
}

const SYNC_BADGE: Record<string, { cls: string; icon: string; label: string }> = {
  saving: { cls: "info", icon: Icon.loader, label: "Salvando…" },
  saved: { cls: "success", icon: Icon.checkCircle, label: "Salvo" },
  error: { cls: "error", icon: Icon.alertTriangle, label: "Erro ao salvar" },
  pending_offline: { cls: "warning", icon: Icon.wifiOff, label: "Pendente (offline)" },
};

const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  text: "Texto",
  screenshot: "Print",
  import: "Importação",
  camera_scan: "Câmera",
};

function statusStamp(status: string): string {
  const m = MATCH_BADGE[status] || { cls: "warning", icon: Icon.alertTriangle, label: "Revisar" };
  return `<span class="status-badge ${m.cls}">${m.icon}${m.label}</span>`;
}

function syncStamp(state: string): string {
  const m = SYNC_BADGE[state];
  if (!m) return "";
  return `<span class="status-badge ${m.cls}">${m.icon}${m.label}</span>`;
}

export async function renderConference(root: HTMLElement): Promise<void> {
  unsubscribeSession?.();
  // root.innerHTML é reconstruído do zero aqui — qualquer nó montado na vez
  // anterior (ex.: #nfeConferenceRoot) deixou de existir, então o guard de
  // "já montado" tem que valer só pra ESTA instância do DOM.
  nfeConferenceMounted = false;
  devolucaoMounted = false;
  root.innerHTML = `<div class="screen-loading">Carregando conferência…</div>`;

  let session: Session;
  try {
    session = await startOrResumeConference();
  } catch (err) {
    renderErrorWithRetry(root, "Erro ao iniciar conferência: " + (err instanceof Error ? err.message : String(err)), () => void renderConference(root));
    return;
  }

  root.innerHTML = `
    <section class="conference-screen">
      <div class="card">
        <h2>1. Como você quer conferir?</h2>
        <div class="input-mode-switch">
          <button class="mode-btn active" data-mode="imagens">${Icon.camera}Prints (imagens)</button>
          <button class="mode-btn" data-mode="texto">${Icon.type}Colar texto</button>
          <a class="mode-btn" data-mode="nfe" href="#/conferir/nfe">${Icon.receipt}Nota Fiscal</a>
          <button class="mode-btn" data-mode="devolucao">${Icon.undo2}Devolução</button>
        </div>

        <div class="mode-panel active" id="mode-imagens">
          <label class="dropzone" id="dropzone">
            <input type="file" id="fileInput" accept="image/*" multiple hidden />
            <span class="dz-icon">${Icon.imagePlus}</span>
            <span>Toque para escolher os prints</span>
            <span class="dz-hint">Vários arquivos de uma vez são aceitos</span>
          </label>
          <div id="imagePreviewList" class="image-preview-list"></div>
          <div class="warning-box">${Icon.info} Leitura via OCR local no navegador (gratuita). Revise os itens antes de confirmar.</div>
          <button class="btn-primary btn-block" id="btnParseImages">Ler prints e gerar itens</button>
        </div>

        <div class="mode-panel" id="mode-texto">
          <p class="hint-text">Um item por linha: <code>Modelo - Cor - Quantidade</code> (quantidade opcional).</p>
          <label for="textInput" class="sr-only">Itens (um por linha)</label>
          <textarea id="textInput" rows="6" placeholder="Tote Mini - Preto - 3&#10;Joy Pro - Marrom - 1"></textarea>
          <button class="btn-primary btn-block" id="btnParseText">Gerar itens do texto</button>
        </div>

        <div class="mode-panel" id="mode-nfe">
          <div id="nfeConferenceRoot"></div>
        </div>

        <div class="mode-panel" id="mode-devolucao">
          <div id="devolucaoRoot"></div>
        </div>
      </div>

      <div id="outletExtraCards">
        <div class="card">
          <h2>2. Revise antes de adicionar</h2>
          <div id="candidatesWrap"><p class="hint-text">Nenhum item gerado ainda.</p></div>
          <div class="review-actions">
            <button class="btn-secondary" id="btnAddManualRow">+ Linha manual</button>
            <button class="btn-primary" id="btnConfirmAll" disabled>Adicionar tudo à conferência</button>
          </div>
        </div>

        <div class="card">
          <div class="product-card-top">
            <h2 style="margin:0">3. Itens da conferência</h2>
            <span id="syncSummary"></span>
          </div>
          <div id="sessionWrap"></div>
          <div class="review-actions">
            <button class="btn-secondary" id="btnReprocessEmpty">${Icon.refresh}Reprocessar SKUs vazios</button>
            <button class="btn-secondary" id="btnExport">${Icon.fileSpreadsheet}Exportar Excel</button>
            <button class="btn-accent" id="btnFinalize">Finalizar conferência</button>
          </div>
        </div>
      </div>
    </section>`;

  wireInputModeSwitch(root, parseConferirHash(window.location.hash));
  wireImageInput(root);
  wireTextInput(root, session);
  wireCandidateActions(root, session);

  document.getElementById("btnReprocessEmpty")!.addEventListener("click", async () => {
    const current = sessionSnapshot();
    if (!current) return;
    const pending = current.items.filter((it) => !it.product_variant_id);
    if (pending.length === 0) {
      showToast("Nenhum item sem SKU para reprocessar.", "success");
      return;
    }
    const btn = document.getElementById("btnReprocessEmpty") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Reprocessando…";
    let filled = 0;
    let stillPending = 0;
    for (const it of pending) {
      const result = await matchItem(it.raw_model, it.raw_color, it.quantity);
      if (result.variant_id && (result.status === "matched" || result.status === "matched_parcial")) {
        await updateItemMatch(it.uiId, {
          product_variant_id: result.variant_id,
          sku_code: result.sku_code,
          produto: result.product_name,
          match_status: "matched",
        });
        filled++;
      } else {
        stillPending++;
      }
    }
    btn.disabled = false;
    btn.innerHTML = `${Icon.refresh}Reprocessar SKUs vazios`;
    showToast(
      `${filled} SKU(s) preenchido(s) automaticamente. ${stillPending} continuam sem correspondência segura (ambíguos ou não reconhecidos) — use "Alterar produto" no item.`,
      filled > 0 ? "success" : "error"
    );
  });

  document.getElementById("btnExport")!.addEventListener("click", () => {
    const current = sessionSnapshot();
    if (!current || current.items.length === 0) {
      showToast("Não há itens para exportar.", "error");
      return;
    }
    exportItemsToXlsx(current.items);
    showToast("Planilha exportada.", "success");
  });

  document.getElementById("btnFinalize")!.addEventListener("click", async () => {
    const current = sessionSnapshot();
    if (!current || current.items.length === 0) {
      showToast("Adicione ao menos um item antes de finalizar.", "error");
      return;
    }
    const confirmed = await confirmAction({
      title: "Finalizar conferência?",
      message: `${current.items.length} item(ns) serão consolidados. Depois de finalizada, um operador não pode mais editar esta conferência.`,
      confirmLabel: "Finalizar",
    });
    if (!confirmed) return;

    const btn = document.getElementById("btnFinalize") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Finalizando…";
    const outcome = await finalize();
    btn.disabled = false;
    btn.textContent = "Finalizar conferência";
    if (!outcome.ok) {
      showToast(outcome.reason || "Não foi possível finalizar.", "error");
      return;
    }
    // FASE 4 — Resumo Final Padronizado: não redireciona mais direto pro
    // Histórico — busca o registro OFICIAL (recém-consolidado no servidor,
    // nunca o estado local/otimista) e mostra o resumo dentro da própria tela.
    showToast("Conferência finalizada.", "success");
    await showOutletFinalSummary(root, current.conference.id);
  });

  let currentSession: Session | null = session;
  unsubscribeSession = subscribeSession((s) => {
    currentSession = s;
    if (s) renderSessionItems(root, s);
  });

  function sessionSnapshot(): Session | null {
    return currentSession;
  }
}

/**
 * FASE 4 — Resumo Final Padronizado (Outlet). Busca o registro OFICIAL
 * (getConferenceFinalSummary — inclui operator_name via join, ver
 * conferencesApi.ts) em vez de confiar no estado local pós-finalize: os
 * totais mostrados são sempre os consolidados no servidor. Se essa busca
 * falhar, a finalização JÁ aconteceu — nunca dá a entender que falhou, só
 * oferece tentar carregar o resumo de novo ou ir direto pro Histórico.
 */
async function showOutletFinalSummary(root: HTMLElement, conferenceId: string): Promise<void> {
  const extraCards = root.querySelector<HTMLElement>("#outletExtraCards")!;
  let summaryEl = root.querySelector<HTMLElement>("#outletFinalSummary");
  if (!summaryEl) {
    summaryEl = document.createElement("div");
    summaryEl.id = "outletFinalSummary";
    extraCards.insertAdjacentElement("beforebegin", summaryEl);
  }
  extraCards.hidden = true;
  summaryEl.innerHTML = `<div class="skeleton skeleton-card"></div>`;

  try {
    const summary = await getConferenceFinalSummary(conferenceId);
    renderOutletFinalSummary(root, summaryEl, summary);
  } catch (err) {
    summaryEl.innerHTML = `
      <div class="card">
        <h2>Conferência finalizada</h2>
        <div class="warning-box">${Icon.info} Conferência finalizada, mas não foi possível carregar o resumo. (${escapeHtml(describeError(err))})</div>
        <div class="review-actions">
          <button class="btn-secondary" id="btnSummaryRetry">Tentar carregar resumo novamente</button>
          <button class="btn-primary" id="btnSummaryHistory">${Icon.history}Ir para Histórico</button>
        </div>
      </div>`;
    summaryEl.querySelector("#btnSummaryRetry")!.addEventListener("click", () => void showOutletFinalSummary(root, conferenceId));
    summaryEl.querySelector("#btnSummaryHistory")!.addEventListener("click", () => {
      window.location.hash = "/historico";
    });
  }
}

function renderOutletFinalSummary(root: HTMLElement, summaryEl: HTMLElement, summary: ConferenceFinalSummary): void {
  const { conference, unresolvedCount } = summary;
  const protocol = conference.id.slice(0, 8).toUpperCase();

  summaryEl.innerHTML = `
    <div class="card">
      <h2>Conferência Finalizada</h2>
      <p class="hint-text"><span class="sku-code">#${protocol}</span> <span class="status-badge success">${Icon.checkCircle}Concluída</span></p>
      <div class="product-card-meta">
        <span>Operador: ${escapeHtml(conference.operator_name || "-")}</span>
        <span>Início: ${formatDateTime(conference.started_at)}</span>
        <span>Finalização: ${formatDateTime(conference.finished_at)}</span>
        <span>Duração: ${formatOperationDuration(conference.started_at, conference.finished_at)}</span>
      </div>
      <div class="active-conference-stats" style="flex-wrap:wrap">
        <span class="active-conference-stat">${conference.total_skus}<span>SKUs</span></span>
        <span class="active-conference-stat">${conference.total_units}<span>Unidades</span></span>
        <span class="active-conference-stat">${unresolvedCount}<span>${unresolvedCount === 1 ? "item p/ revisão" : "sem SKU"}</span></span>
      </div>
      <p class="hint-text">Resultado: Conferência concluída${unresolvedCount > 0 ? ` — ${unresolvedCount} ${unresolvedCount === 1 ? "item" : "itens"} sem SKU para revisão` : ""}.</p>
      <div class="review-actions">
        <button class="btn-secondary" id="btnSummaryViewItems">Ver itens</button>
        <button class="btn-secondary" id="btnSummaryExport">${Icon.fileSpreadsheet}Exportar Excel</button>
        <button class="btn-primary" id="btnSummaryHistory">${Icon.history}Ir para Histórico</button>
      </div>
    </div>`;

  summaryEl.querySelector("#btnSummaryViewItems")!.addEventListener("click", () => {
    const extraCards = root.querySelector<HTMLElement>("#outletExtraCards")!;
    extraCards.hidden = false;
    extraCards.scrollIntoView({ behavior: "smooth" });
  });
  summaryEl.querySelector("#btnSummaryExport")!.addEventListener("click", () => {
    exportItemsToXlsx(summary.items);
    showToast("Planilha exportada.", "success");
  });
  summaryEl.querySelector("#btnSummaryHistory")!.addEventListener("click", () => {
    window.location.hash = "/historico";
  });
}

// EXPANSÃO GOSCAN — módulo da Conferência por Nota Fiscal, montado uma única
// vez dentro de #nfeConferenceRoot (mesmo container reaproveitado toda vez
// que o operador volta pro modo "Nota Fiscal" — preserva o estado em
// andamento, igual já acontece hoje entre os modos imagens/texto).
let nfeConferenceModule: typeof import("./nfeConference.ts") | null = null;
let nfeConferenceMounted = false;

// EXPANSÃO GOSCAN — módulo de Devolução, mesmo padrão de singleton lazy-mount
// do bloco acima (nunca recarrega o módulo nem perde o estado em memória ao
// trocar de sub-modo dentro da mesma visita à tela "Conferir").
let devolucaoModule: typeof import("./devolucao/index.ts") | null = null;
let devolucaoMounted = false;

/**
 * Chamado por shell.ts ao sair da rota "conferir" — encerra a sessão de
 * colaboração em tempo real ativa (ver realtimeCollab.ts), seja ela do modo
 * Outlet (conferenceSession.ts) ou da Conferência por NF (nfeConference.ts):
 * o módulo é um singleton global, então um único stopCollabSession() cobre
 * os dois casos, não importa qual sub-modo estava aberto. Nunca deixa uma
 * subscription viva ouvindo mudanças de uma tela que já fechou.
 *
 * CORREÇÃO ESTRUTURAL — Conferência Colaborativa Segura: se o módulo de NF-e
 * já foi carregado, também libera a reserva ativa e para o heartbeat/fila de
 * voz dele — sem isso, sair pra OUTRA aba do app (não só trocar de sub-tela
 * dentro do fluxo de NF-e) deixaria um timer de heartbeat rodando pra sempre
 * e um produto reservado preso até expirar sozinho.
 */
export function teardownConference(): void {
  stopCollabSession();
  nfeConferenceModule?.teardownNfeConference();
  devolucaoModule?.teardownDevolucao();
}

/**
 * FASE 4 — navegação desktop: extraído do listener de clique pra poder ser
 * chamado tanto por um clique real (mouse/touch) quanto programaticamente
 * no mount inicial, quando o hash já pede `#/conferir/nfe` (deep
 * link/F5/nova aba) — nunca duplica a lógica de montagem dos módulos NF-e/
 * Devolução, só reusa exatamente o mesmo caminho de sempre.
 * `hashInfo` reflete o hash no momento em que esta tela montou; o receiptId
 * só é consumido na PRIMEIRA vez que o modo NF é montado nesta instância da
 * tela (troca de sub-modo depois disso nunca reabre um receiptId antigo à
 * toa).
 */
function wireInputModeSwitch(root: HTMLElement, hashInfo: ConferirHashInfo): void {
  const extraCards = root.querySelector<HTMLElement>("#outletExtraCards")!;
  let pendingNfeReceiptId = hashInfo.nfeReceiptId;

  function selectMode(mode: string, btn: HTMLElement): void {
    root.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    root.querySelectorAll(".mode-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    root.querySelector(`#mode-${mode}`)?.classList.add("active");

    const isNfe = mode === "nfe";
    const isDevolucao = mode === "devolucao";
    // Cards "2. Revise antes de adicionar" e "3. Itens da conferência" são
    // específicos do fluxo de correspondência por texto/print (Outlet) —
    // não fazem sentido na Conferência por Nota Fiscal nem na Devolução,
    // que têm seu próprio fluxo dentro do respectivo módulo.
    extraCards.hidden = isNfe || isDevolucao;

    if (isNfe) {
      const container = root.querySelector<HTMLElement>("#nfeConferenceRoot")!;
      if (!nfeConferenceMounted) {
        nfeConferenceMounted = true;
        // CORREÇÃO — falha no import/render (ex.: erro de rede baixando o
        // chunk, ou uma exceção dentro do módulo) deixava a tela em branco
        // PRA SEMPRE: a flag nfeConferenceMounted já tinha virado true, e
        // nada tratava o reject, então nunca mais tentava de novo nem
        // avisava o operador — só um refresh completo da página resolvia.
        // Agora mostra erro com "Tentar novamente" e libera a flag pra
        // permitir nova tentativa.
        void (nfeConferenceModule ? Promise.resolve(nfeConferenceModule) : import("./nfeConference.ts"))
          .then((m) => {
            nfeConferenceModule = m;
            return m.renderNfeConference(container).then(() => {
              // FASE 4 — deep link: só depois do módulo NF já estar montado e
              // renderizado é que dá pra abrir um receiptId específico
              // (reaproveita getReceipt/decideViewForReceipt/goTo de dentro
              // de nfeConference.ts, nunca duplica essa lógica aqui).
              if (pendingNfeReceiptId) {
                const id = pendingNfeReceiptId;
                pendingNfeReceiptId = null;
                return m.openReceiptFromRoute(container, id);
              }
            });
          })
          .catch((err) => {
            nfeConferenceMounted = false;
            renderErrorWithRetry(container, "Erro ao carregar a Conferência por Nota Fiscal: " + describeError(err), () => selectMode("nfe", btn));
          });
      }
    }

    if (isDevolucao) {
      const container = root.querySelector<HTMLElement>("#devolucaoRoot")!;
      if (!devolucaoMounted) {
        devolucaoMounted = true;
        void (devolucaoModule ? Promise.resolve(devolucaoModule) : import("./devolucao/index.ts")).then((m) => {
          devolucaoModule = m;
          void m.renderDevolucao(container);
        });
      }
    }
  }

  root.querySelectorAll<HTMLElement>(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // FASE 4 — "Nota Fiscal" virou <a href="#/conferir/nfe"> pra permitir
      // Ctrl/Cmd+click, botão do meio e "abrir em nova aba" nativos. Só
      // intercepta (preventDefault) o clique NORMAL, sem modificador, pra
      // preservar o comportamento atual (trocar de modo na mesma aba sem
      // navegação de página inteira) — clique modificado nunca é
      // interceptado, o navegador abre a URL nativamente numa aba nova.
      if (btn.tagName === "A") {
        const me = e as MouseEvent;
        if (me.ctrlKey || me.metaKey || me.shiftKey || me.altKey || me.button !== 0) return;
        e.preventDefault();
      }
      selectMode(btn.dataset.mode!, btn);
    });
  });

  // FASE 4 — deep link/F5/nova aba: se o hash já pedia o módulo NF no
  // momento em que esta tela montou, seleciona o modo automaticamente —
  // sem isso, abrir #/conferir/nfe(/<id>) direto sempre caía no modo padrão
  // "imagens" e escondia a NF pedida atrás de um clique manual.
  if (hashInfo.mode === "nfe") {
    const nfeBtn = root.querySelector<HTMLElement>('[data-mode="nfe"]');
    if (nfeBtn) selectMode("nfe", nfeBtn);
  }
}

function wireImageInput(root: HTMLElement): void {
  const dropzone = root.querySelector<HTMLLabelElement>("#dropzone")!;
  const fileInput = root.querySelector<HTMLInputElement>("#fileInput")!;
  const previewList = root.querySelector<HTMLDivElement>("#imagePreviewList")!;

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => handleFiles((e.target as HTMLInputElement).files));
  dropzone.addEventListener("dragover", (e) => e.preventDefault());
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer?.files ?? null);
  });

  function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    Array.from(fileList).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(",")[1];
        pendingImages.push({ data: base64, media_type: file.type, name: file.name });
        const img = document.createElement("img");
        img.src = String(reader.result);
        img.alt = file.name;
        previewList.appendChild(img);
      };
      reader.readAsDataURL(file);
    });
  }

  root.querySelector("#btnParseImages")!.addEventListener("click", async () => {
    if (pendingImages.length === 0) {
      showToast("Selecione ao menos um print.", "error");
      return;
    }
    const btn = root.querySelector("#btnParseImages") as HTMLButtonElement;
    btn.disabled = true;
    try {
      const items = await parseImagesLocally(pendingImages, (i, total) => {
        btn.textContent = `Lendo print ${i + 1}/${total}…`;
      });
      if (items.length === 0) {
        showToast('Não consegui identificar itens nos prints. Tente a opção "Colar texto".', "error");
        return;
      }
      candidates = await matchItems(items);
      candidatesFromText = false;
      renderCandidates(root);
    } catch (err) {
      showToast("Erro ao ler prints: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      btn.textContent = "Ler prints e gerar itens";
      btn.disabled = false;
    }
  });
}

function wireTextInput(root: HTMLElement, session: Session): void {
  const textarea = root.querySelector("#textInput") as HTMLTextAreaElement;
  const userId = getAuthState().session?.user.id;
  if (userId) {
    const draftKey = textDraftKey(userId, session.conference.id);
    const draft = loadTextDraft(draftKey);
    if (draft) textarea.value = draft;
    // Sem debounce: o próprio evento `input` já é a persistência — o texto
    // digitado imediatamente antes de um fechamento inesperado precisa estar
    // salvo, e um timer/beforeunload não é confiável pra isso.
    textarea.addEventListener("input", () => {
      saveTextDraft(draftKey, textarea.value);
    });
  }

  root.querySelector("#btnParseText")!.addEventListener("click", async () => {
    const raw = (root.querySelector("#textInput") as HTMLTextAreaElement).value;
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const items = lines.map((line) => {
      const parts = line.split(" - ").map((p) => p.trim());
      let modelo = "";
      let cor = "";
      let quantidade = 1;
      if (parts.length >= 3) {
        modelo = parts[0];
        cor = parts[1];
        quantidade = parseInt(parts[2], 10) || 1;
      } else if (parts.length === 2) {
        modelo = parts[0];
        const m = parts[1].match(/^(.*?)(\d+)?$/);
        cor = m && m[1] ? m[1].trim() : parts[1];
        quantidade = m && m[2] ? parseInt(m[2], 10) : 1;
      } else {
        modelo = line;
      }
      return { modelo, cor, quantidade };
    });
    candidates = await matchItems(items);
    candidatesFromText = true;
    renderCandidates(root);
  });
}

function renderCandidates(root: HTMLElement): void {
  const wrap = root.querySelector("#candidatesWrap")!;
  const confirmBtn = root.querySelector("#btnConfirmAll") as HTMLButtonElement;
  confirmBtn.disabled = candidates.length === 0;

  if (candidates.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum item gerado ainda.</p>`;
    return;
  }

  wrap.innerHTML = `
    <div class="product-card-list">
      ${candidates
        .map((c, idx) => {
          const isManual = manualOverrides.has(idx);
          return `
        <div class="product-card">
          <div class="product-card-top">
            <input type="text" aria-label="Modelo" value="${escapeHtml(c.modelo_bruto)}" data-field="modelo" data-idx="${idx}" style="margin-bottom:0;font-weight:600" />
            <button class="icon-btn danger" data-remove-idx="${idx}" aria-label="Remover linha">${Icon.trash}</button>
          </div>
          <input type="text" aria-label="Cor" value="${escapeHtml(c.cor_bruta)}" data-field="cor" data-idx="${idx}" placeholder="Cor" />
          <div class="sku-picker" data-idx="${idx}">
            <input type="text" class="sku-picker-input" aria-label="SKU (buscar por SKU ou nome)" placeholder="Buscar/digitar SKU…" value="${escapeHtml(c.sku_code || "")}" data-idx="${idx}" />
            <div class="sku-picker-results" hidden></div>
          </div>
          <p class="hint-text" data-match-message="${idx}">${escapeHtml(statusMessage(c, isManual))}</p>
          ${
            c.product_name
              ? `<p class="hint-text"><strong>${escapeHtml(c.product_name)}</strong>${c.color_matched ? " — " + escapeHtml(c.color_matched) : ""}</p>`
              : ""
          }
          ${
            c.status === "ambiguous" && c.candidates
              ? `<div class="ambiguous-suggestions" data-idx="${idx}">
                  ${c.candidates
                    .map(
                      (cand) =>
                        `<button type="button" class="btn-secondary" data-suggestion-idx="${idx}" data-variant="${cand.variant_id}" data-sku="${escapeHtml(
                          cand.sku_code
                        )}" data-produto="${escapeHtml(cand.product_name)}">${escapeHtml(cand.product_name)} — ${escapeHtml(
                          cand.color || ""
                        )} <span class="sku-code">${escapeHtml(cand.sku_code)}</span></button>`
                    )
                    .join("")}
                </div>`
              : ""
          }
          ${isManual ? `<button type="button" class="btn-secondary" data-recalc-idx="${idx}">${Icon.refresh}Recalcular associação</button>` : ""}
          <div class="product-card-bottom">
            <div class="qty-stepper">
              <button type="button" data-qty-dec="${idx}" aria-label="Diminuir quantidade">${Icon.minus}</button>
              <input type="number" min="1" aria-label="Quantidade" value="${c.qtd}" data-field="qtd" data-idx="${idx}" />
              <button type="button" data-qty-inc="${idx}" aria-label="Aumentar quantidade">${Icon.plus}</button>
            </div>
            ${statusStamp(isManual ? "manual" : c.status)}
          </div>
        </div>`;
        })
        .join("")}
    </div>`;

  wrap.querySelectorAll<HTMLInputElement>('input[data-field="modelo"], input[data-field="cor"]').forEach((el) => {
    el.addEventListener("change", async (e) => {
      const idx = Number((e.target as HTMLElement).dataset.idx);
      const field = (e.target as HTMLElement).dataset.field as "modelo" | "cor";
      const value = (e.target as HTMLInputElement).value;
      const c = candidates[idx];
      const modelo = field === "modelo" ? value : c.modelo_bruto;
      const cor = field === "cor" ? value : c.cor_bruta;

      if (manualOverrides.has(idx)) {
        // Nunca sobrescreve um SKU manual automaticamente — só atualiza o
        // texto bruto e deixa o botão "Recalcular associação" visível.
        candidates[idx] = { ...c, modelo_bruto: modelo, cor_bruta: cor };
        renderCandidates(root);
        return;
      }
      candidates[idx] = (await matchItems([{ modelo, cor, quantidade: c.qtd }]))[0];
      renderCandidates(root);
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-recalc-idx]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.recalcIdx);
      const c = candidates[idx];
      manualOverrides.delete(idx);
      candidates[idx] = await matchItem(c.modelo_bruto, c.cor_bruta, c.qtd);
      renderCandidates(root);
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-suggestion-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.suggestionIdx);
      candidates[idx] = {
        ...candidates[idx],
        variant_id: btn.dataset.variant!,
        sku_code: btn.dataset.sku!,
        product_name: btn.dataset.produto!,
        status: "matched",
        candidates: undefined,
      };
      manualOverrides.add(idx);
      renderCandidates(root);
    });
  });

  wrap.querySelectorAll<HTMLInputElement>('input[data-field="qtd"]').forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number((e.target as HTMLElement).dataset.idx);
      candidates[idx].qtd = Math.max(1, Number((e.target as HTMLInputElement).value) || 1);
      renderCandidates(root);
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-dec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.qtyDec);
      candidates[idx].qtd = Math.max(1, candidates[idx].qtd - 1);
      renderCandidates(root);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-inc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.qtyInc);
      candidates[idx].qtd = candidates[idx].qtd + 1;
      renderCandidates(root);
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-remove-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const removedIdx = Number(btn.dataset.removeIdx);
      candidates.splice(removedIdx, 1);
      reindexManualOverrides(removedIdx);
      renderCandidates(root);
    });
  });

  wireSkuPickers(wrap);
}

/** Ajusta os índices de manualOverrides após remover a linha `removedIdx` de `candidates`. */
function reindexManualOverrides(removedIdx: number): void {
  const next = new Set<number>();
  manualOverrides.forEach((i) => {
    if (i < removedIdx) next.add(i);
    else if (i > removedIdx) next.add(i - 1);
  });
  manualOverrides.clear();
  next.forEach((i) => manualOverrides.add(i));
}

function wireSkuPickers(wrap: Element): void {
  wrap.querySelectorAll<HTMLInputElement>(".sku-picker-input").forEach((input) => {
    const idx = Number(input.dataset.idx);
    const resultsBox = input.parentElement!.querySelector<HTMLDivElement>(".sku-picker-results")!;
    // PERFORMANCE — faltava cancelar a busca anterior: sem abortSignal, cada
    // tecla empilhava uma busca nova sem cancelar as anteriores ainda em
    // voo, e uma resposta antiga podia chegar DEPOIS da mais recente e
    // sobrescrevê-la (mesmo padrão já usado em nfeConference.ts).
    let activeController: AbortController | null = null;

    const search = debounce(async (query: string) => {
      activeController?.abort();
      if (!query.trim()) {
        resultsBox.hidden = true;
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      const rows = await searchSkuForPicker(query, 15, "outlet", controller.signal, false);
      if (controller.signal.aborted) return;
      renderResults(rows);
    }, 300);

    input.addEventListener("input", () => search(input.value));
    input.addEventListener("focus", () => {
      if (input.value.trim()) search(input.value);
    });

    function renderResults(rows: CatalogRow[]) {
      if (rows.length === 0) {
        resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum SKU encontrado.</div>`;
        resultsBox.hidden = false;
        return;
      }
      resultsBox.innerHTML = rows
        .map(
          (r) =>
            `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-product="${r.product_id}" data-sku="${escapeHtml(
              r.sku_code
            )}" data-produto="${escapeHtml(r.produto)}">${escapeHtml(r.produto)} — ${escapeHtml(r.cor || "")} <span class="sku-code">${escapeHtml(
              r.sku_code
            )}</span></button>`
        )
        .join("");
      resultsBox.hidden = false;
      resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((item) => {
        item.addEventListener("click", () => {
          candidates[idx] = {
            ...candidates[idx],
            product_id: item.dataset.product!,
            variant_id: item.dataset.variant!,
            sku_code: item.dataset.sku!,
            product_name: item.dataset.produto!,
            status: "matched",
            candidates: undefined,
          };
          // Escolha manual do operador tem prioridade máxima — nunca é
          // sobrescrita silenciosamente por um recálculo automático depois.
          manualOverrides.add(idx);
          const wrapEl = resultsBox.closest("#candidatesWrap")!;
          renderCandidates(wrapEl.parentElement as HTMLElement);
        });
      });
    }
  });
}

function wireCandidateActions(root: HTMLElement, session: Session): void {
  root.querySelector("#btnAddManualRow")!.addEventListener("click", () => {
    candidates.push({
      modelo_bruto: "",
      cor_bruta: "",
      qtd: 1,
      product_id: null,
      product_name: null,
      color_matched: null,
      variant_id: null,
      sku_code: null,
      status: "modelo_nao_encontrado",
    });
    renderCandidates(root);
  });

  root.querySelector("#btnConfirmAll")!.addEventListener("click", async () => {
    const toAdd = candidates.map((c, idx) => ({ c, isManual: manualOverrides.has(idx) }));
    const wasFromText = candidatesFromText;
    candidates = [];
    candidatesFromText = false;
    manualOverrides.clear();
    renderCandidates(root);
    const previewList = root.querySelector("#imagePreviewList")!;
    previewList.innerHTML = "";
    pendingImages = [];

    try {
      for (const { c, isManual } of toAdd) {
        const matchStatus = isManual
          ? "manual"
          : c.status === "matched"
            ? "matched"
            : c.status === "matched_parcial"
              ? "partial"
              : "unresolved";
        await addItem({
          product_variant_id: c.variant_id,
          raw_model: c.modelo_bruto,
          raw_color: c.cor_bruta,
          quantity: c.qtd,
          match_status: matchStatus,
          source: "text",
          sku_code: c.sku_code,
          produto: c.product_name,
        });
      }
      showToast(`${toAdd.length} item(ns) adicionado(s) à conferência.`, "success");
      // Só agora, com TODOS os candidatos entregues ao fluxo de addItem sem
      // exceção, o rascunho de texto deixa de ter valor de recuperação — ver
      // regra explícita: nunca no finally, só no caminho de sucesso. E só
      // quando o lote confirmado realmente veio de "Gerar itens do texto"
      // (wasFromText) — confirmar um lote de imagem/linha manual NUNCA pode
      // apagar um rascunho de texto que o operador ainda não processou.
      if (wasFromText) {
        const userId = getAuthState().session?.user.id;
        if (userId) clearTextDraft(textDraftKey(userId, session.conference.id));
        const textarea = root.querySelector("#textInput") as HTMLTextAreaElement | null;
        if (textarea && textarea.value) textarea.value = "";
      }
    } catch (err) {
      showToast("Erro ao adicionar itens: " + describeError(err), "error");
    }
  });
}

// EXPANSÃO GOSCAN — atalhos de incremento rápido ao lado do stepper -/+.
// Chamam a MESMA updateItemQuantity(uiId, delta) já usada pelo "+" (ver
// wiring em renderSessionItems), só com um delta maior — nenhuma lógica de
// confirmação/saldo é tocada.
const QTY_BUMP_VALUES = [5, 10, 15, 20];

function renderQtyBumpRow(uiId: string): string {
  return `
        <div class="qty-bump-row">
          ${QTY_BUMP_VALUES.map(
            (v) => `<button type="button" data-qty-bump="${uiId}" data-qty-bump-value="${v}" aria-label="Adicionar ${v} unidades">+${v}</button>`
          ).join("")}
        </div>`;
}

function renderSessionItemCard(it: SessionItem): string {
  return `
    <div class="product-card">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(it.raw_model || "(sem modelo)")}</p>
        ${syncStamp(it.syncState)}
      </div>
      <div class="product-card-meta">
        <span>${escapeHtml(it.raw_color || "-")}</span>
        <span class="sku-code">${escapeHtml(it.sku_code || "-")}</span>
        <span>${escapeHtml(SOURCE_LABEL[it.source] || it.source)}</span>
      </div>
      <div class="item-sku-fix" data-item-fix="${it.uiId}">
        <input type="text" class="sku-picker-input" aria-label="Alterar produto/SKU" placeholder="Buscar SKU ou nome…" data-item-fix-input="${it.uiId}" />
        <div class="sku-picker-results" hidden></div>
      </div>
      <div class="product-card-bottom">
        <div class="qty-stepper">
          <button type="button" data-qty-dec="${it.uiId}" aria-label="Diminuir quantidade">${Icon.minus}</button>
          <input type="text" inputmode="numeric" aria-label="Quantidade" value="${it.quantity}" readonly />
          <button type="button" data-qty-inc="${it.uiId}" aria-label="Aumentar quantidade">${Icon.plus}</button>
        </div>
        ${renderQtyBumpRow(it.uiId)}
        <div class="product-card-actions">
          <button class="icon-btn danger" data-remove-id="${it.uiId}" aria-label="Remover item">${Icon.trash}</button>
        </div>
      </div>
    </div>`;
}

function renderSessionItemRow(it: SessionItem): string {
  return `
    <tr>
      <td>${escapeHtml(it.raw_model)}</td>
      <td>${escapeHtml(it.raw_color)}</td>
      <td>
        <div class="qty-stepper">
          <button type="button" data-qty-dec="${it.uiId}" aria-label="Diminuir quantidade">${Icon.minus}</button>
          <input type="text" inputmode="numeric" aria-label="Quantidade" value="${it.quantity}" readonly />
          <button type="button" data-qty-inc="${it.uiId}" aria-label="Aumentar quantidade">${Icon.plus}</button>
        </div>
        ${renderQtyBumpRow(it.uiId)}
      </td>
      <td class="sku-code">
        ${escapeHtml(it.sku_code || "-")}
        <div class="item-sku-fix" data-item-fix="${it.uiId}">
          <input type="text" class="sku-picker-input" aria-label="Alterar produto/SKU" placeholder="Alterar produto…" data-item-fix-input="${it.uiId}" />
          <div class="sku-picker-results" hidden></div>
        </div>
      </td>
      <td>${syncStamp(it.syncState)}</td>
      <td><button class="row-remove" data-remove-id="${it.uiId}" title="Remover" aria-label="Remover item">${Icon.trash}</button></td>
    </tr>`;
}

function wireItemSkuFix(wrap: Element): void {
  wrap.querySelectorAll<HTMLInputElement>("[data-item-fix-input]").forEach((input) => {
    const uiId = input.dataset.itemFixInput!;
    const resultsBox = input.parentElement!.querySelector<HTMLDivElement>(".sku-picker-results")!;
    // PERFORMANCE — mesma correção de wireSkuPickers: cancela a busca
    // anterior a cada nova tecla, nunca deixa uma resposta velha sobrescrever
    // a mais recente.
    let activeController: AbortController | null = null;

    const search = debounce(async (query: string) => {
      activeController?.abort();
      if (!query.trim()) {
        resultsBox.hidden = true;
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      const rows = await searchSkuForPicker(query, 15, "outlet", controller.signal, false);
      if (controller.signal.aborted) return;
      renderResults(rows);
    }, 300);

    input.addEventListener("input", () => search(input.value));

    function renderResults(rows: CatalogRow[]) {
      if (rows.length === 0) {
        resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum SKU encontrado.</div>`;
        resultsBox.hidden = false;
        return;
      }
      resultsBox.innerHTML = rows
        .map(
          (r) =>
            `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-sku="${escapeHtml(
              r.sku_code
            )}" data-produto="${escapeHtml(r.produto)}">${escapeHtml(r.produto)} — ${escapeHtml(r.cor || "")} <span class="sku-code">${escapeHtml(
              r.sku_code
            )}</span></button>`
        )
        .join("");
      resultsBox.hidden = false;
      resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((item) => {
        item.addEventListener("click", async () => {
          await updateItemMatch(uiId, {
            product_variant_id: item.dataset.variant!,
            sku_code: item.dataset.sku!,
            produto: item.dataset.produto!,
            match_status: "manual",
          });
          resultsBox.hidden = true;
          input.value = "";
          showToast("Produto/SKU atualizado.", "success");
        });
      });
    }
  });
}

function renderSessionItems(root: HTMLElement, session: Session): void {
  const wrap = root.querySelector("#sessionWrap");
  const summary = root.querySelector("#syncSummary");
  if (!wrap) return;

  const pending = session.items.filter((it) => it.syncState !== "saved").length;
  if (summary) {
    summary.innerHTML = pending > 0 ? `<span class="status-badge warning">${Icon.loader}${pending} pendente(s)</span>` : "";
  }

  if (session.items.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.package}<p>Nenhum item adicionado ainda.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="product-card-list mobile-only">
      ${session.items.map(renderSessionItemCard).join("")}
    </div>
    <div class="table-wrap desktop-only">
      <table>
        <thead><tr><th>Modelo</th><th>Cor</th><th>Qtd</th><th>SKU</th><th>Status</th><th></th></tr></thead>
        <tbody>${session.items.map(renderSessionItemRow).join("")}</tbody>
      </table>
    </div>`;

  wrap.querySelectorAll<HTMLButtonElement>("[data-remove-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const confirmed = await confirmAction({
        title: "Remover item?",
        message: "Este item será removido da conferência.",
        confirmLabel: "Remover",
        danger: true,
      });
      if (confirmed) void removeItem(btn.dataset.removeId!);
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-dec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const it = session.items.find((i) => i.uiId === btn.dataset.qtyDec);
      // updateItemQuantity recebe um DELTA (não mais o valor absoluto
      // calculado aqui) — o ajuste final é sempre resolvido atomicamente no
      // banco (ver conferenceSession.ts).
      if (it) void updateItemQuantity(it.uiId, -1);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-inc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const it = session.items.find((i) => i.uiId === btn.dataset.qtyInc);
      if (it) void updateItemQuantity(it.uiId, 1);
    });
  });
  wrap.querySelectorAll<HTMLButtonElement>("[data-qty-bump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const it = session.items.find((i) => i.uiId === btn.dataset.qtyBump);
      const delta = Number(btn.dataset.qtyBumpValue);
      if (it) void updateItemQuantity(it.uiId, delta);
    });
  });

  wireItemSkuFix(wrap);
}
