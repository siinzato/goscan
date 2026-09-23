// EXPANSÃO GOSCAN — Conferência por Nota Fiscal (NF-e). Montado dentro de
// #nfeConferenceRoot por conference.ts (3º botão "Nota Fiscal"), como um
// fluxo totalmente separado do reconhecimento visual/matching Outlet — não
// reaproveita conferences/conference_items, tem suas próprias tabelas
// (invoice_receipts/invoice_receipt_items/receipt_counts).
import { escapeHtml, debounce, formatDateTime, formatOperationDuration, formatSignedNumber, describeError, initials, normalizeEan, isValidEanFormat, renderErrorWithRetry } from "../../utils.ts";
import { parseNfeXml, diagnoseNfeXml, type NfeXmlDiagnostics } from "../../nfeParser.ts";
import { normalizeKey, suggestBestMatch, summarizeReceipt } from "../../nfeMatching.ts";
import { getAuthState, isAdmin, isManagerOrAdmin } from "../../auth.ts";
import {
  findReceiptByInvoiceKey,
  createReceiptFromParsed,
  resolveItemManually,
  startCounting,
  submitCount,
  submitCountDelta,
  undoLastCount,
  reserveItem,
  heartbeatReservation,
  releaseReservation,
  listVolumes,
  createVolume,
  setWorkMode,
  getReceipt,
  finalizeReceipt,
  listReceiptHistory,
  deleteReceipt,
  fetchAllNormalProducts,
  fetchNormalCandidates,
  confirmInvoiceReceiptTinyLaunch,
  type InvoiceReceipt,
  type InvoiceReceiptWithCreator,
  type InvoiceReceiptWithNames,
  type InvoiceReceiptItem,
  type ReceiptWithCounts,
  type WorkMode,
  type CountEventResult,
  type CountEventOptions,
  type ReceiptVolume,
  type ReservationConflictInfo,
  type AliasMemorizeOutcome,
} from "../../nfeApi.ts";
import { searchSkuForPicker, type CatalogRow } from "../../catalogApi.ts";
import { exportNfeReportToXlsx } from "../../exporter.ts";
import { RECEIPT_STATUS_LABEL, itemStamp, reportStatusStamp, itemTitle, itemCodeLabel, itemEanLabel } from "../../nfeReportFormat.ts";
import { startNfeKeyLookup, isNfeKeyLookupInFlight, type LookupHandle, type LookupProgress } from "../../nfeKeyLookup.ts";
import { joinCollabSession, stopCollabSession, updateMyPresenceState, sendBroadcast, type PresenceUser, type PresenceStatus } from "../../realtimeCollab.ts";
import { loadConferencePreferences, getConferencePreferences } from "../../conferencePreferences.ts";
import { playSound, unlockConferenceSounds } from "../../soundManager.ts";
import { speak, stopVoiceQueue } from "../../voiceFeedback.ts";
import { vibrate } from "../../vibrationFeedback.ts";
import { isVoiceCommandSupported, startPushToTalk, stopPushToTalk, isListening as isVoiceListening, type VoiceCommand } from "../../voiceCommands.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { confirmAction, chooseAction, promptText } from "../confirmModal.ts";
import { getTinyWarehouses, launchInvoiceReceiptToTiny, TinyIntegrationError, type TinyWarehouse, type TinyLaunchOutcome } from "../../tinyIntegrationApi.ts";

type NfeView = "upload" | "prep" | "mode" | "counting" | "result" | "history";

/**
 * FASE 3 — vínculo e memorização são operações distintas (ver
 * resolveItemManually em nfeApi.ts): o vínculo já foi salvo com sucesso
 * sempre que chegamos aqui, então NUNCA mostra "Erro ao vincular" por causa
 * da memorização — só avisa quando ela não pôde ser salva/gerou conflito,
 * sem nunca esconder isso do operador.
 */
function toastLinkResult(produto: string, aliasOutcome: AliasMemorizeOutcome | undefined): void {
  if (aliasOutcome === "conflict") {
    showToast(`Vinculado a "${produto}". Já existe uma associação memorizada diferente para este código — mantida como estava.`, "default");
  } else if (aliasOutcome === "error") {
    showToast(`Vinculado a "${produto}", mas não foi possível memorizar para próximas notas.`, "default");
  } else {
    showToast(`Vinculado a "${produto}".`, "success");
  }
}

let view: NfeView = "upload";
let currentReceipt: InvoiceReceiptWithNames | null = null;
let currentItems: InvoiceReceiptItem[] = [];
let countingFilter: "all" | "pending" | "counted" = "all";
let countingQuery = "";

// CORREÇÃO ESTRUTURAL — Conferência colaborativa em tempo real (ver
// realtimeCollab.ts). participants reflete quem mais está com ESTA MESMA NF
// aberta agora (presence); collabConnected alimenta o indicador discreto de
// sincronização — nunca bloqueia a tela, só informa.
let participants: PresenceUser[] = [];
let collabConnected = true;
let participantsExpanded = false;
// Nome de todo mundo que já apareceu na presença desta sessão — usado pra
// resolver "quem completou o item"/"quem confirmou excesso" em eventos que só
// trazem o uuid (counted_by), sem precisar de outra consulta ao banco.
const knownNames = new Map<string, string>();

// EXPANSÃO GOSCAN — Conferência Colaborativa Segura (identidade estável do
// DISPOSITIVO físico, não do usuário — persistida no navegador pra
// sobreviver a um F5 no meio de uma reserva/heartbeat).
function getDeviceId(): string {
  const KEY = "goscan:device-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
const myDeviceId = getDeviceId();

// Reserva por produto (modo "product"): conflitos conhecidos (item → quem
// reservou), minha própria reserva ativa (pra heartbeat/liberação) e o
// heartbeat periódico enquanto a tela de contagem estiver aberta.
const itemReservations = new Map<string, ReservationConflictInfo>();
let myReservation: { id: string; itemId: string } | null = null;
let reservationHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 30_000;

// Volumes (modo "volume"): lista carregada da NF atual + volume ativo
// escolhido pelo operador NESTA tela (não persiste entre sessões — é normal
// escolher de novo ao reabrir, já que outro volume pode fazer mais sentido).
let volumes: ReceiptVolume[] = [];
let activeVolumeId: string | null = null;

// "Desfazer minha última bipagem": só oferece desfazer uma ação feita NESTA
// sessão (evita ambiguidade sobre o que é "a última" depois de F5/troca de
// dispositivo) — ver seção 13 do pedido.
const lastEventIdByItem = new Map<string, string>();
// Último item cujo campo de quantidade recebeu foco — usado como "produto
// atual" pelos comandos de voz que agem sobre um item específico.
let lastFocusedItemId: string | null = null;

// Evita repetir som/voz de "produto finalizado" pro MESMO item mais de uma
// vez nesta sessão, mesmo que o Realtime entregue eventos duplicados/fora de ordem.
const announcedCompletedItemIds = new Set<string>();

let voicePushToTalkActive = false;

/**
 * Entra na sessão de colaboração desta NF (idempotente — reentrar com o
 * mesmo receiptId não recria a subscription). Chamado sempre que uma NF é
 * aberta para prep/contagem/relatório; encerrado em goTo("upload"/"history")
 * e no teardown da rota (ver conference.ts:teardownConference, chamado por
 * shell.ts).
 */
function enterReceiptCollab(root: HTMLElement, receiptId: string): void {
  participants = [];
  collabConnected = true;
  void loadConferencePreferences();
  void listVolumes(receiptId).then((v) => {
    volumes = v;
    if (view === "counting" && root.isConnected) renderVolumeSelector(root);
  });
  startReservationHeartbeat();

  joinCollabSession(
    `nfe-receipt:${receiptId}`,
    [
      {
        table: "invoice_receipt_items",
        filter: `receipt_id=eq.${receiptId}`,
        onChange: (row: InvoiceReceiptItem) => {
          if (!currentReceipt || currentReceipt.id !== receiptId || !root.isConnected) return;
          const idx = currentItems.findIndex((i) => i.id === row.id);
          const previous = idx !== -1 ? currentItems[idx] : null;
          // sku_code/produto só existem via join local (getReceipt) — o
          // payload do Realtime traz só as colunas reais da tabela.
          if (idx === -1) {
            currentItems = [...currentItems, { ...row, sku_code: null, produto: null }];
          } else {
            currentItems = currentItems.map((i) => (i.id === row.id ? { ...row, sku_code: i.sku_code, produto: i.produto } : i));
          }
          // Item completado por OUTRO usuário: a mesma detecção de "primeira
          // conclusão" que o servidor calcula pra quem bipou, só que aqui é
          // derivada localmente comparando o estado antes/depois — o dado já
          // estava no objeto local (getReceipt busca a linha inteira), a
          // contagem cega só decide NÃO exibir isso durante a digitação normal.
          const wasComplete = previous ? previous.expected_quantity > 0 && (previous.physical_quantity ?? 0) >= previous.expected_quantity : false;
          const isComplete = row.expected_quantity > 0 && (row.physical_quantity ?? 0) >= row.expected_quantity;
          if (isComplete && !wasComplete && row.counted_by) {
            const { session } = getAuthState();
            const isMe = session?.user.id === row.counted_by;
            const whoLabel = isMe ? "Você" : knownNames.get(row.counted_by) || "Um operador";
            announceItemCompleted(row.id, whoLabel, previous?.produto || previous?.description || row.description || "produto");
          }
          // OTIMIZAÇÃO — nunca recarrega a NF inteira por causa de UM item alterado.
          if (view === "counting" && !updateSingleCountingCard(root, row.id)) renderCountingList(root);
        },
      },
      {
        table: "invoice_receipts",
        filter: `id=eq.${receiptId}`,
        onChange: (row: InvoiceReceipt) => {
          if (!currentReceipt || currentReceipt.id !== receiptId || !root.isConnected) return;
          const wasOpen = currentReceipt.status === "not_started" || currentReceipt.status === "in_progress";
          const nowClosed = row.status === "completed" || row.status === "with_divergences";
          if (wasOpen && nowClosed && view === "counting") {
            showToast("Outro usuário finalizou esta conferência.", "default");
            playSound("receipt_finalized");
            speak("Conferência finalizada.", { priority: "high", dedupeKey: "receipt-finalized" });
            void getReceipt(receiptId).then(({ receipt, items }) => {
              currentReceipt = receipt;
              currentItems = items;
              goTo(root, "result");
            });
            return;
          }
          currentReceipt = { ...currentReceipt, status: row.status, work_mode: row.work_mode, finished_at: row.finished_at, finished_by: row.finished_by };
        },
      },
      {
        table: "invoice_receipt_item_reservations",
        filter: `receipt_id=eq.${receiptId}`,
        onChange: (row: { item_id: string; user_id: string; status: string; reserved_at: string; last_heartbeat_at: string }) => {
          if (!root.isConnected) return;
          if (row.status === "active" && row.user_id !== getAuthState().session?.user.id) {
            itemReservations.set(row.item_id, {
              userId: row.user_id,
              fullName: knownNames.get(row.user_id) || "Outro operador",
              since: row.reserved_at,
              lastActivity: row.last_heartbeat_at,
            });
          } else {
            itemReservations.delete(row.item_id);
          }
          if (view === "counting" && !updateSingleCountingCard(root, row.item_id)) renderCountingList(root);
        },
      },
      {
        table: "invoice_receipt_volumes",
        filter: `receipt_id=eq.${receiptId}`,
        onChange: (row: ReceiptVolume) => {
          if (!root.isConnected || volumes.some((v) => v.id === row.id)) return;
          volumes = [...volumes, row].sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
          if (view === "counting") renderVolumeSelector(root);
        },
      },
    ],
    {
      onPresenceChange: (users) => {
        participants = users;
        users.forEach((u) => knownNames.set(u.userId, u.fullName));
        if (view === "counting" && root.isConnected) renderParticipantsBanner(root);
      },
      onReconnect: () => {
        collabConnected = true;
        if (view === "counting" && root.isConnected) renderParticipantsBanner(root);
        showToast("Conectado novamente — sincronizando…", "success");
        playSound("connection_restored");
        // Nunca confia só no que o Realtime entregou enquanto esteve offline
        // (pode ter perdido eventos) — rebusca o estado oficial ao reconectar.
        void getReceipt(receiptId).then(({ receipt, items }) => {
          if (!root.isConnected || currentReceipt?.id !== receiptId) return;
          currentReceipt = receipt;
          currentItems = items;
          if (view === "counting") renderCountingList(root);
        });
      },
      onDisconnected: () => {
        collabConnected = false;
        if (view === "counting" && root.isConnected) renderParticipantsBanner(root);
        playSound("connection_lost");
      },
      onBroadcast: (type, data) => {
        if (type === "collab-request" && root.isConnected && view === "counting") {
          const fromName = typeof data.fromName === "string" ? data.fromName : "Alguém";
          const itemLabel = typeof data.itemLabel === "string" ? data.itemLabel : "um produto";
          showToast(`${fromName} pediu colaboração em: ${itemLabel}`, "default");
        }
      },
    }
  );
}

const PRESENCE_STATUS_LABEL: Record<PresenceStatus, string> = { online: "Online", counting: "Conferindo", paused: "Pausado" };

function renderParticipantsBanner(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>("#nfeParticipantsBanner");
  if (!el) return;
  const { session: authSession } = getAuthState();
  const myId = authSession?.user.id;
  const syncNote = collabConnected ? "" : " · sincronizando…";
  const sorted = [...participants].sort((a, b) => (a.userId === myId ? -1 : b.userId === myId ? 1 : 0));
  const visible = sorted.slice(0, 4);
  const extra = participants.length - visible.length;

  el.innerHTML = `
    <button type="button" class="collab-participants-toggle" id="nfeParticipantsToggle" aria-expanded="${participantsExpanded}">
      <span class="avatar-stack">
        ${visible.map((p) => `<span class="avatar-chip" title="${escapeHtml(p.fullName)}">${escapeHtml(initials(p.fullName))}</span>`).join("")}
        ${extra > 0 ? `<span class="avatar-chip avatar-chip-more">+${extra}</span>` : ""}
      </span>
      <span class="sync-indicator">${participants.length <= 1 ? "Conferência compartilhada" : "Conferindo agora"}${syncNote}</span>
      ${Icon.chevronDown}
    </button>
    <div class="collab-participants-detail" id="nfeParticipantsDetail" ${participantsExpanded ? "" : "hidden"}>
      ${sorted
        .map(
          (p) => `
        <div class="collab-participant-row">
          <span class="avatar-chip">${escapeHtml(initials(p.fullName))}</span>
          <span class="collab-participant-info">
            <strong>${escapeHtml(p.fullName)}${p.userId === myId ? " (você)" : ""}</strong>
            <span class="hint-text">${PRESENCE_STATUS_LABEL[p.status] || "Online"}${p.currentItemLabel ? " · " + escapeHtml(p.currentItemLabel) : ""}</span>
          </span>
        </div>`
        )
        .join("")}
      ${participants.length === 0 ? `<p class="hint-text">Nenhum participante ativo.</p>` : ""}
    </div>`;

  el.querySelector("#nfeParticipantsToggle")!.addEventListener("click", () => {
    participantsExpanded = !participantsExpanded;
    renderParticipantsBanner(root);
  });
}

/** "Produto finalizado" — som/voz/vibração + toast, no máximo UMA vez por item por sessão (evita repetir por eventos Realtime duplicados/fora de ordem). */
function announceItemCompleted(itemId: string, whoLabel: string, itemLabel: string): void {
  if (announcedCompletedItemIds.has(itemId)) return;
  announcedCompletedItemIds.add(itemId);
  if (!getConferencePreferences().notifyItemCompleted) return;
  playSound("product_completed");
  vibrate("completed");
  const phrase = getConferencePreferences().speakProductName ? `Produto finalizado: ${itemLabel}.` : "Produto finalizado.";
  speak(phrase, { priority: "high", dedupeKey: `completed:${itemId}` });
  showToast(`${whoLabel} completou "${itemLabel}".`, "success");
}

function itemLabelFor(itemId: string): string {
  const it = currentItems.find((i) => i.id === itemId);
  return it ? itemTitle(it) : "produto";
}

// ---------------------------------------------------------------------------
// Reserva de produto (modo "product") — heartbeat periódico + liberação ao sair.
// ---------------------------------------------------------------------------
function startReservationHeartbeat(): void {
  stopReservationHeartbeat();
  reservationHeartbeatTimer = setInterval(() => {
    if (myReservation) void heartbeatReservationSilently();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopReservationHeartbeat(): void {
  if (reservationHeartbeatTimer) {
    clearInterval(reservationHeartbeatTimer);
    reservationHeartbeatTimer = null;
  }
}

async function heartbeatReservationSilently(): Promise<void> {
  if (!myReservation) return;
  try {
    const result = await heartbeatReservation(myReservation.id);
    // Reserva perdida (expirou antes do heartbeat chegar) — a próxima
    // bipagem/foco no item reserva de novo naturalmente, sem travar nada.
    if (!result.success) myReservation = null;
  } catch {
    /* falha de rede pontual no heartbeat não é crítica — tenta de novo no próximo ciclo */
  }
}

function releaseMyReservationSilently(): void {
  if (!myReservation) return;
  const itemId = myReservation.itemId;
  myReservation = null;
  updateMyPresenceState({ status: "online", currentItemLabel: null });
  void releaseReservation(itemId, "left_screen").catch(() => {
    /* melhor esforço — se falhar, a reserva expira sozinha pelo TTL de qualquer forma */
  });
}

/** Chamado ao focar o campo de quantidade de um item — no modo "product", isso É "começar a contar" (ver seção 7.2 do pedido). */
async function handleItemFocusReserve(root: HTMLElement, itemId: string): Promise<void> {
  if (!currentReceipt || currentReceipt.work_mode !== "product") return;
  if (myReservation?.itemId === itemId) return;

  try {
    const result = await reserveItem(itemId, myDeviceId, activeVolumeId);
    if (!result.success) {
      itemReservations.set(itemId, result.reservation);
      // Recria o card pra mostrar o banner de bloqueio (e desabilitar o
      // campo) — perder o foco aqui é o comportamento CORRETO: o operador
      // não pode mesmo digitar neste item enquanto estiver reservado.
      if (!updateSingleCountingCard(root, itemId)) renderCountingList(root);
      playSound("product_with_other_operator");
      vibrate("error");
      if (getConferencePreferences().notifyConflict) {
        speak(
          getConferencePreferences().speakProductName ? `${result.reservation.fullName} está conferindo este produto: ${itemLabelFor(itemId)}.` : `${result.reservation.fullName} está conferindo este produto.`,
          { priority: "high", dedupeKey: `conflict:${itemId}` }
        );
      }
      return;
    }
    if (myReservation && myReservation.itemId !== itemId) {
      void releaseReservation(myReservation.itemId, "switched_item").catch(() => {});
    }
    myReservation = { id: result.reservation.id, itemId };
    itemReservations.delete(itemId);
    updateMyPresenceState({ status: "counting", currentItemLabel: itemLabelFor(itemId) });
    // Nada no card muda visualmente numa reserva própria bem-sucedida (o
    // banner de bloqueio só aparece pra reserva de OUTRO usuário) — não
    // re-renderiza, então o campo que acabou de ganhar foco nunca o perde.
  } catch (err) {
    // Falha ao reservar não deve travar a digitação manual — o servidor
    // ainda protege via a checagem embutida no próprio scan/confirmação.
    console.error("Falha ao reservar item:", describeError(err));
  }
}
// Filtro do relatório final: os 5 estados pedidos + o atalho "divergências"
// (falta OU sobra OU não conferido — nunca inclui OK nem "não localizado").
type ResultFilter = "all" | "ok" | "missing" | "surplus" | "pending" | "divergent";
let resultFilter: ResultFilter = "all";
let resultQuery = "";
const recountingIds = new Set<string>();
let historyList: ReceiptWithCounts[] = [];

/** Decide de onde retomar uma nota já existente — nunca força voltar pra preparação se já não há pendências. */
function decideViewForReceipt(receipt: InvoiceReceipt, items: InvoiceReceiptItem[]): NfeView {
  if (receipt.status === "completed" || receipt.status === "with_divergences") return "result";
  // CORREÇÃO ESTRUTURAL — Conferência Colaborativa Segura: "not_started"
  // SEMPRE volta pra preparação, mesmo que todos os itens já estejam
  // vinculados (ex.: um import cujo XML casou tudo por SKU/EAN sozinho, mas
  // o operador saiu antes de clicar "Iniciar Conferência"). Sem isto, reabrir
  // essa NF pelo Histórico pulava direto pra contagem sem NUNCA passar pela
  // escolha de modo de trabalho (work_mode) nem chamar startCounting() — a
  // NF ficava "em contagem" na tela mas com status ainda not_started/work_mode
  // no valor padrão, nunca escolhido de propósito.
  if (receipt.status === "not_started") return "prep";
  if (items.some((i) => i.product_variant_id === null)) return "prep";
  return "counting";
}

export async function renderNfeConference(root: HTMLElement): Promise<void> {
  switch (view) {
    case "upload":
      renderUploadView(root);
      break;
    case "prep":
      await renderPrepView(root);
      break;
    case "mode":
      renderModeView(root);
      break;
    case "counting":
      renderCountingView(root);
      break;
    case "result":
      renderResultView(root);
      break;
    case "history":
      await renderHistoryView(root);
      break;
  }
}

/**
 * Chamado por conference.ts (teardownConference, por sua vez chamado por
 * shell.ts ao sair da rota "conferir" inteira — não só ao trocar de sub-tela
 * dentro do fluxo de NF-e, que já é coberto por goTo()). Sem isto, sair do
 * app pra outra aba (Catálogo, Histórico...) enquanto uma reserva/heartbeat
 * estivesse ativo deixaria o timer rodando pra sempre e o produto reservado
 * "preso" até expirar sozinho pelo TTL — nunca liberado de propósito.
 */
export function teardownNfeConference(): void {
  releaseMyReservationSilently();
  stopReservationHeartbeat();
  stopPushToTalk();
  stopVoiceQueue();
  stopCollabSession();
}

/**
 * FASE 4 — mantém a URL sincronizada com a NF atual (deep link/F5/copiar
 * endereço/nova aba), sem router novo: `#/conferir/nfe` fica como URL
 * neutra (sem NF aberta), `#/conferir/nfe/<id>` quando há uma NF atual.
 * `history.replaceState` NUNCA dispara `hashchange` — por isso nunca causa
 * o remonte completo de conference.ts que um `location.hash = ...` causaria
 * (shell.ts re-renderiza a rota inteira em QUALQUER hashchange, mesmo
 * trocando só o sub-segmento). Vira no-op se a URL já é a esperada (evita
 * uma entrada nova no histórico do navegador a cada re-render da mesma NF).
 */
function syncNfeUrl(): void {
  const target = currentReceipt ? `#/conferir/nfe/${currentReceipt.id}` : "#/conferir/nfe";
  if (window.location.hash !== target) {
    history.replaceState(null, "", target);
  }
}

function goTo(root: HTMLElement, next: NfeView): void {
  // Saindo da tela de contagem: libera minha reserva ativa (se houver),
  // para o heartbeat e encerra qualquer captura de voz em andamento — nunca
  // deixa um produto bloqueado ou um microfone ouvindo numa tela que já saiu.
  if (view === "counting" && next !== "counting") {
    releaseMyReservationSilently();
    stopReservationHeartbeat();
    stopPushToTalk();
  }
  view = next;
  syncNfeUrl();
  // Entra/mantém a colaboração em tempo real desta NF em prep/modo/contagem/
  // relatório; qualquer outra tela (upload/histórico) encerra a subscription
  // — nunca fica ouvindo mudanças de uma NF que o usuário já não está vendo.
  if ((next === "prep" || next === "mode" || next === "counting" || next === "result") && currentReceipt) {
    enterReceiptCollab(root, currentReceipt.id);
  } else {
    stopCollabSession();
    stopVoiceQueue();
  }
  void renderNfeConference(root);
}

/**
 * FASE 4 — deep link: abre uma NF específica por `receiptId` (vindo da URL
 * `#/conferir/nfe/<id>`, do histórico interno como link real, ou de
 * qualquer chamador futuro). Reaproveita EXATAMENTE o mesmo caminho já usado
 * ao abrir uma NF pelo histórico interno (getReceipt + decideViewForReceipt
 * + goTo) — nenhuma regra de status/contagem cega duplicada aqui. `goTo` já
 * sincroniza a URL e entra na colaboração em tempo real quando aplicável.
 * Nunca deixa a tela em branco: receipt inexistente/sem permissão/ID
 * inválido caem no mesmo padrão de erro-com-ação já usado no resto do app,
 * com uma saída seguravel de volta pro módulo (nunca expõe stack trace).
 */
export async function openReceiptFromRoute(root: HTMLElement, receiptId: string): Promise<void> {
  const id = receiptId?.trim();
  if (!id) {
    // receiptId ausente/vazio nunca tenta carregar nada — só entra no
    // módulo NF normalmente (mesmo estado de "#/conferir/nfe" sem NF).
    goTo(root, "upload");
    return;
  }
  try {
    const { receipt, items } = await getReceipt(id);
    currentReceipt = receipt;
    currentItems = items;
    goTo(root, decideViewForReceipt(receipt, items));
  } catch (err) {
    currentReceipt = null;
    currentItems = [];
    renderErrorWithRetry(
      root,
      "Não foi possível abrir esta Nota Fiscal (ela pode não existir mais, ou você não tem permissão para vê-la): " + describeError(err),
      () => {
        history.replaceState(null, "", "#/conferir/nfe");
        goTo(root, "upload");
      }
    );
  }
}

// ---------------------------------------------------------------------------
// 1. Upload
// ---------------------------------------------------------------------------
function renderUploadView(root: HTMLElement): void {
  root.innerHTML = `
    <div class="card">
      <h2>Importar nova Nota Fiscal</h2>
      <p class="hint-text">Envie o arquivo XML da NF-e ou cole o conteúdo completo — os produtos são interpretados automaticamente para preparar a conferência.</p>

      <label class="dropzone small">
        <input type="file" id="nfeFileInput" accept=".xml,text/xml" hidden />
        <span class="dz-icon">${Icon.fileUp}</span>
        <span>Selecionar arquivo XML</span>
      </label>

      <p class="hint-text" style="text-align:center;margin:12px 0">ou</p>

      <label for="nfeXmlPaste" class="sr-only">Colar conteúdo XML da NF-e</label>
      <textarea id="nfeXmlPaste" rows="6" placeholder="Cole aqui o conteúdo XML completo da NF-e (começando com <?xml ... ou <nfeProc...)…"></textarea>
      <button class="btn-primary btn-block" id="btnProcessXml">Processar XML</button>

      <div id="nfeUploadStatus" role="status" aria-live="polite"></div>
    </div>

    <div class="card">
      <h2>Buscar NF-e pela chave de acesso</h2>
      <p class="hint-text">Informe os 44 dígitos da chave de acesso. O GoScan verifica primeiro se esta nota já foi importada e, se ainda não, consulta e baixa o XML automaticamente.</p>
      <label for="nfeKeySearch" class="sr-only">Chave de acesso da NF-e (44 dígitos)</label>
      <div class="search-row">
        <input type="text" id="nfeKeySearch" inputmode="numeric" autocomplete="off" placeholder="Chave de acesso (44 dígitos)…" />
      </div>
      <p class="hint-text" id="nfeKeyCounter" style="text-align:right;margin:4px 0 0">0/44</p>
      <button class="btn-primary btn-block" id="btnSearchKey" disabled>${Icon.barcode}Buscar NF-e</button>
      <button class="btn-secondary btn-block" id="btnCancelKeySearch" hidden>Cancelar consulta</button>
      <div id="nfeKeySearchStatus" role="status" aria-live="polite"></div>
    </div>

    <div class="card">
      <button class="btn-secondary btn-block" id="btnOpenHistory">${Icon.history}Histórico de Notas</button>
    </div>`;

  const statusEl = root.querySelector<HTMLElement>("#nfeUploadStatus")!;
  const fileInput = root.querySelector<HTMLInputElement>("#nfeFileInput")!;
  const dropzone = root.querySelector<HTMLLabelElement>(".dropzone")!;
  const pasteArea = root.querySelector<HTMLTextAreaElement>("#nfeXmlPaste")!;

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const xml = await file.text();
    await processXmlText(xml, statusEl, root);
    fileInput.value = "";
  });

  root.querySelector("#btnProcessXml")!.addEventListener("click", async () => {
    const xml = pasteArea.value.trim();
    if (!xml) {
      showToast("Cole o conteúdo do XML antes de processar.", "error");
      return;
    }
    await processXmlText(xml, statusEl, root);
  });

  wireKeySearchCard(root);

  root.querySelector("#btnOpenHistory")!.addEventListener("click", () => goTo(root, "history"));
}

/** Mesma apresentação para os dois caminhos que podem encontrar uma NF já existente a partir da chave (checagem local e sinal ALREADY_IMPORTED da Edge Function). */
function renderAlreadyImported(root: HTMLElement, statusEl: HTMLElement, existing: InvoiceReceiptWithCreator): void {
  // Uma NF só existe uma vez (invoice_key único) — encontrá-la aqui significa
  // entrar na MESMA sessão compartilhada pela empresa, nunca criar uma
  // segunda independente (ver receiptActionLabel).
  const isDone = existing.status === "completed" || existing.status === "with_divergences";
  const actionLabel = isDone ? "Visualizar relatório" : "Continuar conferência";
  statusEl.innerHTML = `
    <div class="warning-box">${Icon.info} Esta Nota Fiscal já foi importada.</div>
    <div class="product-card-meta">
      <span>NF-e: ${escapeHtml(existing.invoice_number || "-")}</span>
      <span>Fornecedor: ${escapeHtml(existing.supplier_name || "-")}</span>
      <span>Status: ${escapeHtml(RECEIPT_STATUS_LABEL[existing.status])}</span>
    </div>
    <button class="btn-primary btn-block" id="btnOpenByKey">${escapeHtml(actionLabel)}</button>`;
  statusEl.querySelector("#btnOpenByKey")!.addEventListener("click", async () => {
    const { receipt, items } = await getReceipt(existing.id);
    currentReceipt = receipt;
    currentItems = items;
    goTo(root, decideViewForReceipt(receipt, items));
  });
}

/**
 * Busca pela chave de acesso (44 dígitos): primeiro localmente (nunca chama
 * a API externa se a NF já estiver no GoScan), e só então consulta o Meu
 * Danfe via Edge Function — com polling seguro enquanto WAITING/SEARCHING.
 * Ao obter o XML, entrega para processXmlText (MESMO caminho do upload
 * manual/colagem — nenhuma lógica de criação de conferência duplicada aqui).
 */
function wireKeySearchCard(root: HTMLElement): void {
  const keyInput = root.querySelector<HTMLInputElement>("#nfeKeySearch")!;
  const counterEl = root.querySelector<HTMLElement>("#nfeKeyCounter")!;
  const searchBtn = root.querySelector<HTMLButtonElement>("#btnSearchKey")!;
  const cancelBtn = root.querySelector<HTMLButtonElement>("#btnCancelKeySearch")!;
  const statusEl = root.querySelector<HTMLElement>("#nfeKeySearchStatus")!;

  let activeHandle: LookupHandle | null = null;

  function refreshButtonState(): void {
    searchBtn.disabled = keyInput.value.length !== 44 || isNfeKeyLookupInFlight();
  }

  keyInput.addEventListener("input", () => {
    // Só dígitos, sempre — aceita colagem com espaços/pontos/traços, corta em 44.
    const digits = keyInput.value.replace(/\D/g, "").slice(0, 44);
    if (digits !== keyInput.value) keyInput.value = digits;
    counterEl.textContent = `${digits.length}/44`;
    refreshButtonState();
  });

  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !searchBtn.disabled) void runKeySearch();
  });

  searchBtn.addEventListener("click", () => void runKeySearch());

  cancelBtn.addEventListener("click", () => {
    activeHandle?.cancel();
    activeHandle = null;
  });

  async function renderLookupProgress(progress: LookupProgress): Promise<void> {
    if (!root.isConnected) return; // tela trocada enquanto a consulta rodava — nunca atualiza DOM morto.
    switch (progress.phase) {
      case "validating":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Validando chave de acesso…</p>`;
        return;
      case "requesting":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Solicitando NF-e…</p>`;
        return;
      case "waiting":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Consultando NF-e — tentativa ${progress.attempt} de ${progress.maxAttempts}…</p>`;
        return;
      case "still_processing":
        statusEl.innerHTML = `<p class="warning-box">${Icon.info}${escapeHtml(progress.message || "")}</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "not_found":
        statusEl.innerHTML = `<p class="error-box">${escapeHtml(progress.message || "NF-e não encontrada.")}</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "error":
        statusEl.innerHTML = `<p class="error-box">${escapeHtml(progress.message || "Não foi possível consultar esta NF-e.")}</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "cancelled":
        statusEl.innerHTML = `<p class="hint-text">Consulta cancelada.</p>`;
        cancelBtn.hidden = true;
        refreshButtonState();
        return;
      case "already_imported": {
        cancelBtn.hidden = true;
        // Confirmado pela Edge Function, mas a visão final continua vindo do
        // caminho local de sempre (mesma RLS do resto do app) — pode ter
        // sido importada por OUTRO operador enquanto esta consulta rodava.
        let justImported: InvoiceReceiptWithCreator | null = null;
        try {
          justImported = await findReceiptByInvoiceKey(progress.accessKey!);
        } catch (err) {
          statusEl.innerHTML = `<p class="error-box">Erro ao buscar: ${escapeHtml(describeError(err))}</p>`;
          refreshButtonState();
          return;
        }
        if (justImported) {
          renderAlreadyImported(root, statusEl, justImported);
        } else {
          statusEl.innerHTML = `<p class="warning-box">${Icon.info} Esta NF-e já foi importada por outro operador. Peça a um gerente/administrador para localizá-la no Histórico.</p>`;
        }
        refreshButtonState();
        return;
      }
      case "done":
        statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Baixando XML…</p>`;
        await processXmlText(progress.xml!, statusEl, root);
        refreshButtonState();
        return;
    }
  }

  async function runKeySearch(): Promise<void> {
    if (isNfeKeyLookupInFlight()) return; // trava contra clique duplo / operação concorrente
    const key = keyInput.value;
    if (key.length !== 44) return;

    searchBtn.disabled = true;
    cancelBtn.hidden = true;
    statusEl.innerHTML = `<p class="hint-text">${Icon.loader}Validando chave de acesso…</p>`;

    // 1) Checagem local primeiro — sem custo, sem chamar o Meu Danfe.
    let existing: InvoiceReceiptWithCreator | null;
    try {
      existing = await findReceiptByInvoiceKey(key);
    } catch (err) {
      statusEl.innerHTML = `<p class="error-box">Erro ao buscar: ${escapeHtml(describeError(err))}</p>`;
      refreshButtonState();
      return;
    }
    if (existing) {
      renderAlreadyImported(root, statusEl, existing);
      refreshButtonState();
      return;
    }

    // 2) Não está localmente — consulta o Meu Danfe via Edge Function.
    cancelBtn.hidden = false;
    activeHandle = startNfeKeyLookup(key, (progress) => void renderLookupProgress(progress));
  }

  refreshButtonState();
}

/** Painel de debug técnico — só pra admin, nunca escondido atrás de um "NF não encontrada" genérico. */
function renderXmlDebugPanel(diag: NfeXmlDiagnostics): string {
  return `
    <details class="scan-diag-panel" style="margin-top:10px">
      <summary>Debug técnico (admin)</summary>
      <dl>
        <dt>Arquivo lido</dt><dd>${diag.arquivoLido ? "SIM" : "NÃO"}</dd>
        <dt>XML válido</dt><dd>${diag.xmlValido ? "SIM" : "NÃO"}</dd>
        <dt>Root</dt><dd>${escapeHtml(diag.root ?? "-")}</dd>
        <dt>NFe encontrada</dt><dd>${diag.nfeEncontrada ? "SIM" : "NÃO"}</dd>
        <dt>infNFe encontrada</dt><dd>${diag.infNFeEncontrada ? "SIM" : "NÃO"}</dd>
        <dt>Chave</dt><dd>${escapeHtml(diag.chave ?? "-")}</dd>
        <dt>Número</dt><dd>${escapeHtml(diag.numero ?? "-")}</dd>
        <dt>Itens &lt;det&gt; encontrados</dt><dd>${diag.itensDet}</dd>
        <dt>Etapa</dt><dd>${escapeHtml(diag.etapa ?? "-")}</dd>
        <dt>Erro técnico</dt><dd>${escapeHtml(diag.erro ?? "nenhum")}</dd>
      </dl>
    </details>`;
}

async function processXmlText(xml: string, statusEl: HTMLElement, root: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  const debugHtml = isAdmin(profile) ? renderXmlDebugPanel(diagnoseNfeXml(xml)) : "";

  statusEl.innerHTML = `<p class="hint-text">Lendo XML…</p>${debugHtml}`;

  let parsed;
  try {
    parsed = parseNfeXml(xml);
  } catch (err) {
    statusEl.innerHTML = `<p class="error-box">${escapeHtml(describeError(err))}</p>${debugHtml}`;
    return;
  }

  statusEl.innerHTML = `<p class="hint-text">Verificando se esta nota já foi importada…</p>${debugHtml}`;
  let existing;
  try {
    existing = await findReceiptByInvoiceKey(parsed.invoice_key);
  } catch (err) {
    statusEl.innerHTML = `<p class="error-box">Erro ao verificar NF: ${escapeHtml(describeError(err))}</p>${debugHtml}`;
    return;
  }

  if (existing) {
    const isDone = existing.status === "completed" || existing.status === "with_divergences";
    const actionLabel = isDone ? "Visualizar relatório" : "Continuar conferência";
    statusEl.innerHTML = `
      <div class="warning-box">${Icon.info} Esta Nota Fiscal já foi importada.</div>
      <div class="product-card-meta">
        <span>Status: ${escapeHtml(RECEIPT_STATUS_LABEL[existing.status])}</span>
        <span>Importada em: ${formatDateTime(existing.created_at)}</span>
        <span>Responsável: ${escapeHtml(existing.created_by_name || "-")}</span>
      </div>
      <button class="btn-primary btn-block" id="btnOpenExisting">${escapeHtml(actionLabel)}</button>
      ${debugHtml}`;
    statusEl.querySelector("#btnOpenExisting")!.addEventListener("click", async () => {
      const { receipt, items } = await getReceipt(existing!.id);
      currentReceipt = receipt;
      currentItems = items;
      goTo(root, decideViewForReceipt(receipt, items));
    });
    return;
  }

  statusEl.innerHTML = `<p class="hint-text">NF-e reconhecida — ${parsed.items.length} item(ns) encontrados. Processando produtos…</p>${debugHtml}`;
  try {
    const { receipt, items } = await createReceiptFromParsed(parsed, xml);
    // Recibo recém-criado: ninguém finalizou ainda, então os nomes ficam
    // nulos até a próxima leitura via getReceipt (que já faz o join).
    currentReceipt = { ...receipt, created_by_name: null, finished_by_name: null };
    currentItems = items;
    goTo(root, "prep");
    showToast("NF-e importada. Resolva as pendências antes de iniciar a conferência.", "success");
  } catch (err) {
    statusEl.innerHTML = `<p class="error-box">Erro ao criar conferência: ${escapeHtml(describeError(err))}</p>${debugHtml}`;
  }
}

// ---------------------------------------------------------------------------
// 2. Preparação — resolver pendências antes de iniciar a contagem
// ---------------------------------------------------------------------------

// Sugestões dispensadas pelo operador ("Não" na pergunta "Esse produto é X?")
// não devem reaparecer a cada re-render da mesma tela de preparação.
const dismissedSuggestions = new Set<string>();

async function renderPrepView(root: HTMLElement): Promise<void> {
  const receipt = currentReceipt!;
  const pending = currentItems.filter((i) => i.product_variant_id === null);
  const linked = currentItems.length - pending.length;

  root.innerHTML = `
    <div class="card">
      <button class="btn-secondary" id="btnBackToUpload">${Icon.chevronLeft}Outra nota</button>
      <h2>Preparação da Conferência</h2>
      <div class="product-card-meta">
        <span>NF-e: ${escapeHtml(receipt.invoice_number || "-")}</span>
        <span>Fornecedor: ${escapeHtml(receipt.supplier_name || "-")}</span>
        <span>Emissão: ${formatDateTime(receipt.issued_at)}</span>
      </div>
      <div class="active-conference-stats">
        <span class="active-conference-stat">${currentItems.length}<span>Itens encontrados</span></span>
        <span class="active-conference-stat">${linked}<span>Vinculados</span></span>
        <span class="active-conference-stat">${pending.length}<span>Pendentes</span></span>
      </div>
    </div>

    ${
      pending.length > 0
        ? `<div class="card">
            <h2>Resolver pendências</h2>
            <p class="hint-text">Estes itens da NF não têm um produto normal correspondente exato por SKU ou EAN. Confirme a sugestão (quando houver) ou busque manualmente.</p>
            <div class="product-card-list" id="pendingList">
              ${pending.map(renderPendingItemCard).join("")}
            </div>
          </div>`
        : ""
    }

    <div class="card">
      <button class="btn-accent btn-block" id="btnStartCounting" ${pending.length > 0 ? "disabled" : ""}>Iniciar Conferência</button>
      ${pending.length > 0 ? `<p class="hint-text">Vincule todas as pendências acima para liberar o início da conferência.</p>` : ""}
    </div>`;

  root.querySelector("#btnBackToUpload")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    goTo(root, "upload");
  });

  wirePendingItemPickers(root);

  if (pending.length > 0) {
    void renderPendingSuggestions(root, pending);
    void renderPendingEanDiagnostics(root, pending);
  }

  root.querySelector("#btnStartCounting")!.addEventListener("click", () => {
    goTo(root, "mode");
  });
}

// ---------------------------------------------------------------------------
// 2.5 Escolha do modo de trabalho — só acontece UMA vez, na 1ª transição
// not_started → in_progress (ver seção 7 do pedido). Depois de escolhido, o
// modo fica salvo em invoice_receipts.work_mode até o fim da conferência.
// ---------------------------------------------------------------------------
const WORK_MODE_INFO: Record<WorkMode, { title: string; description: string }> = {
  volume: {
    title: "Por volume",
    description: "Cada operador assume uma caixa, pallet ou área física. O mesmo produto pode ser contado por pessoas diferentes em volumes diferentes — os totais são somados no resultado geral.",
  },
  product: {
    title: "Por produto",
    description: "Cada produto é reservado temporariamente para quem começar a contá-lo — evita que dois operadores contem fisicamente o mesmo produto sem perceber.",
  },
  free: {
    title: "Livre compartilhada",
    description: "Todos podem conferir qualquer produto. Combinem entre vocês como separar fisicamente os volumes para evitar dupla contagem — o sistema alerta, mas não bloqueia.",
  },
};

function renderModeView(root: HTMLElement): void {
  const receipt = currentReceipt!;
  root.innerHTML = `
    <div class="card">
      <h2>Como vocês vão conferir esta nota?</h2>
      <p class="hint-text">Escolham juntos o modo de divisão do trabalho — combine com quem mais for participar antes de continuar. O modo escolhido vale até o fim desta conferência.</p>
      <div class="work-mode-options">
        ${(Object.keys(WORK_MODE_INFO) as WorkMode[])
          .map(
            (m) => `
          <button type="button" class="work-mode-card" data-mode="${m}">
            <strong>${escapeHtml(WORK_MODE_INFO[m].title)}</strong>
            <span class="hint-text">${escapeHtml(WORK_MODE_INFO[m].description)}</span>
          </button>`
          )
          .join("")}
      </div>
    </div>`;

  root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.mode as WorkMode;
      if (mode === "free") {
        const confirmed = await confirmAction({
          title: "Modo livre compartilhado",
          message: "Todos podem conferir qualquer produto. Para evitar dupla contagem física, combinem entre vocês como separar os volumes antes de começar.",
          confirmLabel: "Entendi, continuar",
        });
        if (!confirmed) return;
      }
      root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => (b.disabled = true));
      try {
        await setWorkMode(receipt.id, mode);
        await startCounting(receipt.id);
        currentReceipt = { ...receipt, status: "in_progress", work_mode: mode };
        goTo(root, "counting");
      } catch (err) {
        showToast("Erro ao iniciar conferência: " + describeError(err), "error");
        root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => (b.disabled = false));
      }
    });
  });
}

/**
 * Sugestão automática por semelhança de nome ("Esse produto é X?") — nunca
 * vincula sozinha, só pergunta. Busca o catálogo de produtos normais UMA vez
 * pra todos os itens pendentes desta tela (não uma query por item).
 */
async function renderPendingSuggestions(root: HTMLElement, pending: InvoiceReceiptItem[]): Promise<void> {
  let candidates;
  try {
    candidates = await fetchAllNormalProducts();
  } catch {
    return; // sugestão é só um atalho — se falhar, a busca manual continua disponível normalmente.
  }

  for (const item of pending) {
    if (dismissedSuggestions.has(item.id) || !item.description) continue;
    const suggestion = suggestBestMatch(item.description, candidates);
    if (!suggestion) continue;

    const container = root.querySelector<HTMLElement>(`#pendingSuggestion-${item.id}`);
    if (!container) continue;
    container.innerHTML = `
      <div class="warning-box">
        Esse produto é <strong>${escapeHtml(suggestion.candidate.produto)}</strong>
        <span class="sku-code">${escapeHtml(suggestion.candidate.sku_code)}</span>?
      </div>
      <div class="review-actions" style="margin-top:0">
        <button type="button" class="btn-primary" data-suggestion-yes="${item.id}">Sim, vincular</button>
        <button type="button" class="btn-secondary" data-suggestion-no="${item.id}">Não, buscar manualmente</button>
      </div>`;

    container.querySelector(`[data-suggestion-yes="${item.id}"]`)!.addEventListener("click", async () => {
      // CORREÇÃO — memorizar deixou de ser opt-in (checkbox quase nunca
      // marcada na prática, medido contra o histórico real: dezenas de
      // códigos de fornecedor resolvidos manualmente sem gerar alias,
      // forçando o operador a resolver o MESMO item de novo em toda NF
      // seguinte). Toda vinculação manual/confirmação de sugestão passa a
      // sempre memorizar — nunca sobrescreve uma associação conflitante (ver
      // memorizeAlias em nfeApi.ts) e nunca reporta "erro ao vincular" só
      // porque a memorização falhou (ver toastLinkResult acima).
      try {
        const updated = await resolveItemManually(item.id, suggestion.candidate.variant_id, {
          memorize: true,
          invoiceProductCode: item.invoice_product_code,
          ean: item.ean,
        });
        currentItems = currentItems.map((i) =>
          i.id === item.id ? { ...i, ...updated, sku_code: suggestion.candidate.sku_code, produto: suggestion.candidate.produto, catalog_ean: suggestion.candidate.gtin } : i
        );
        toastLinkResult(suggestion.candidate.produto, updated.aliasOutcome);
        void renderNfeConference(root);
      } catch (err) {
        showToast("Erro ao vincular: " + (describeError(err)), "error");
      }
    });
    container.querySelector(`[data-suggestion-no="${item.id}"]`)!.addEventListener("click", () => {
      dismissedSuggestions.add(item.id);
      container.innerHTML = "";
    });
  }
}

/**
 * CORREÇÃO — diferencia, para itens PENDENTES que já têm um EAN válido (a
 * ausência/invalidez de EAN já é tratada de forma síncrona em
 * renderPendingItemCard), dois casos que antes recebiam a mesma tela sem
 * explicação nenhuma: "EAN válido mas não cadastrado em nenhum produto" e
 * "EAN válido cadastrado em mais de um produto" (o que agora nunca vincula
 * sozinho — ver resolveInvoiceItem em nfeMatching.ts). Reconsulta o
 * catálogo AGORA (não reaproveita o resultado da importação) porque o
 * catálogo pode ter mudado desde então; uma única busca em lote reaproveita
 * fetchNormalCandidates (mesma função/normalização usada na importação),
 * nunca uma consulta por item.
 */
async function renderPendingEanDiagnostics(root: HTMLElement, pending: InvoiceReceiptItem[]): Promise<void> {
  const withEan = pending.filter((it) => it.ean && isValidEanFormat(normalizeEan(it.ean)));
  if (withEan.length === 0) return;

  let candidates;
  try {
    candidates = await fetchNormalCandidates([], withEan.map((it) => it.ean!));
  } catch {
    return; // diagnóstico é só informativo — nunca trava a tela de pendências se a consulta falhar
  }
  if (!root.isConnected) return;

  const countByEan = new Map<string, number>();
  for (const c of candidates) {
    if (!c.gtin_normalized) continue;
    countByEan.set(c.gtin_normalized, (countByEan.get(c.gtin_normalized) ?? 0) + 1);
  }

  for (const it of withEan) {
    const container = root.querySelector<HTMLElement>(`#pendingEanNote-${it.id}`);
    if (!container) continue;
    const count = countByEan.get(normalizeEan(it.ean)) ?? 0;
    if (count === 0) {
      container.innerHTML = `<p class="hint-text">O EAN ${escapeHtml(it.ean!)} é válido, mas não foi encontrado na base de produtos.</p>`;
    } else if (count > 1) {
      container.innerHTML = `<p class="hint-text">O EAN ${escapeHtml(it.ean!)} está associado a mais de um produto e precisa de confirmação manual.</p>`;
    }
    // count === 1 e ainda pendente seria inesperado (teria sido vinculado na importação) — não mostra nada de errado, só deixa a busca manual disponível normalmente.
  }
}

function renderPendingItemCard(it: InvoiceReceiptItem): string {
  return `
    <div class="pending-item-card" data-pending-item="${it.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(it.description || "(sem descrição)")}</p>
      </div>
      <div class="product-card-meta">
        <span class="sku-code">Código NF: ${escapeHtml(it.invoice_product_code || "-")}</span>
        ${it.ean ? `<span>EAN ${escapeHtml(it.ean)}</span>` : ""}
      </div>
      ${
        !it.ean
          ? `<p class="hint-text">Este item da NF não possui EAN válido. Pesquise pelo nome, SKU ou código do fornecedor para vinculá-lo.</p>`
          : `<div id="pendingEanNote-${it.id}"></div>`
      }
      <div id="pendingSuggestion-${it.id}"></div>
      <div class="sku-picker" data-pending-idx="${it.id}">
        <input type="text" class="sku-picker-input" aria-label="Buscar produto normal" placeholder="Buscar por palavra-chave do nome, SKU ou EAN…" data-pending-input="${it.id}" />
        <div class="sku-picker-results" hidden></div>
      </div>
      <p class="hint-text" style="margin-top:6px">Ao vincular, esta associação é memorizada automaticamente pra próximas notas deste fornecedor.</p>
    </div>`;
}

/**
 * CORREÇÃO — Reconhecimento automático e busca por EAN: antes, buscar por
 * EAN aqui nunca encontrava nada (searchCatalog não filtrava por gtin — ver
 * catalogApi.ts) e não havia cancelamento de buscas antigas nem estado de
 * carregamento/erro. Agora cada campo mantém seu próprio AbortController
 * (cancela a busca anterior a cada nova tecla — nunca deixa uma resposta
 * velha sobrescrever a mais recente) e mostra "Buscando…"/erro com retry.
 */
function wirePendingItemPickers(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>("[data-pending-input]").forEach((input) => {
    const itemId = input.dataset.pendingInput!;
    const resultsBox = input.parentElement!.querySelector<HTMLDivElement>(".sku-picker-results")!;
    let activeController: AbortController | null = null;

    const runSearch = async (q: string): Promise<void> => {
      activeController?.abort();
      if (!q.trim()) {
        resultsBox.hidden = true;
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      resultsBox.hidden = false;
      resultsBox.innerHTML = `<div class="sku-picker-empty">Buscando…</div>`;
      let rows: CatalogRow[];
      try {
        rows = await searchSkuForPicker(q, 15, "normal", controller.signal, false);
      } catch {
        if (controller.signal.aborted) return;
        renderError(q);
        return;
      }
      if (controller.signal.aborted) return;
      renderResults(rows);
    };
    const search = debounce(runSearch, 300);
    input.addEventListener("input", () => void search(input.value));

    function renderError(q: string): void {
      resultsBox.innerHTML = `<div class="sku-picker-empty">Erro ao consultar a base. <button type="button" class="link-btn" data-picker-retry>Tentar novamente</button></div>`;
      resultsBox.hidden = false;
      resultsBox.querySelector("[data-picker-retry]")?.addEventListener("click", () => void runSearch(q));
    }

    function renderResults(rows: CatalogRow[]): void {
      if (rows.length === 0) {
        resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum produto normal encontrado.</div>`;
        resultsBox.hidden = false;
        return;
      }
      resultsBox.innerHTML = rows
        .map((r) => {
          const badge =
            r.match_type === "exact_ean"
              ? `<span class="status-badge success">EAN exato</span>`
              : r.match_type === "exact_sku"
                ? `<span class="status-badge success">SKU exato</span>`
                : "";
          return `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-produto="${escapeHtml(r.produto)}" data-sku="${escapeHtml(r.sku_code)}" data-ean="${escapeHtml(r.gtin || "")}">
              <span class="sku-picker-item-info">
                <span class="product-card-name">${escapeHtml(r.produto)}</span>
                <span class="sku-code">${escapeHtml(r.sku_code)}${r.gtin ? ` · EAN ${escapeHtml(r.gtin)}` : ""}</span>
              </span>
              ${badge}
            </button>`;
        })
        .join("");
      resultsBox.hidden = false;
      resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const item = currentItems.find((i) => i.id === itemId)!;
          try {
            const updated = await resolveItemManually(itemId, btn.dataset.variant!, {
              memorize: true,
              invoiceProductCode: item.invoice_product_code,
              ean: item.ean,
            });
            // BUG REAL corrigido: usava item.sku_code (o item PENDENTE ainda
            // não tem SKU nenhum — ficava null/stale) em vez do SKU do
            // produto de verdade escolhido no picker.
            currentItems = currentItems.map((i) =>
              i.id === itemId ? { ...i, ...updated, sku_code: btn.dataset.sku!, produto: btn.dataset.produto!, catalog_ean: btn.dataset.ean || null } : i
            );
            toastLinkResult(btn.dataset.produto!, updated.aliasOutcome);
            void renderNfeConference(root);
          } catch (err) {
            showToast("Erro ao vincular: " + (describeError(err)), "error");
          }
        });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Contagem cega — NUNCA mostra expected_quantity/NF aqui.
// ---------------------------------------------------------------------------
function renderCountingView(root: HTMLElement): void {
  const receipt = currentReceipt!;
  const voiceReady = isVoiceCommandSupported() && getConferencePreferences().voiceCommandsEnabled;

  root.innerHTML = `
    <div class="card">
      <button class="btn-secondary" id="btnBackToUploadCounting">${Icon.chevronLeft}Outra nota</button>
      <h2>Contagem Física</h2>
      <div class="product-card-meta">
        <span>NF-e: ${escapeHtml(receipt.invoice_number || "-")}</span>
        <span>Fornecedor: ${escapeHtml(receipt.supplier_name || "-")}</span>
      </div>
      <p class="hint-text">Conte o que realmente foi recebido — a quantidade da nota só aparece depois de finalizar.</p>
      <div id="nfeParticipantsBanner"></div>
      <div id="nfeVolumeSelector"></div>

      <label for="nfeEanInput" class="sr-only">Digitar ou ler EAN</label>
      <div class="search-row search-row-icon">
        ${Icon.barcode}
        <input type="text" id="nfeEanInput" placeholder="Digitar ou ler EAN (bipagem +1)…" />
      </div>

      <label for="nfeCountingSearch" class="sr-only">Buscar por nome, SKU ou EAN</label>
      <input type="text" id="nfeCountingSearch" placeholder="Buscar por nome, SKU ou EAN…" value="${escapeHtml(countingQuery)}" style="margin-top:8px" />

      <div class="input-mode-switch" style="margin-top:8px">
        <button class="mode-btn ${countingFilter === "all" ? "active" : ""}" data-count-filter="all">Todos</button>
        <button class="mode-btn ${countingFilter === "pending" ? "active" : ""}" data-count-filter="pending">Pendentes</button>
        <button class="mode-btn ${countingFilter === "counted" ? "active" : ""}" data-count-filter="counted">Conferidos</button>
      </div>

      ${
        voiceReady
          ? `<button type="button" class="voice-ptt-btn" id="nfeVoicePtt" aria-label="Segure para falar um comando">${Icon.mic}<span>Segure para falar</span></button>`
          : ""
      }
    </div>

    <div class="card">
      <div id="nfeCountingList"></div>
    </div>

    <div class="card">
      <button class="btn-accent btn-block" id="btnFinalizeReceipt">Finalizar Conferência</button>
    </div>`;

  root.addEventListener("click", unlockConferenceSounds, { once: true });

  // Sair pra escolher outra NF nunca perde nada: a contagem já está salva no
  // servidor a cada bipagem (mesmo padrão de "Outra nota" já usado em
  // renderPrepView/renderResultView) — só troca a tela, não apaga/finaliza.
  root.querySelector("#btnBackToUploadCounting")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    goTo(root, "upload");
  });

  renderCountingList(root);
  renderParticipantsBanner(root);
  renderVolumeSelector(root);

  const eanInput = root.querySelector<HTMLInputElement>("#nfeEanInput")!;
  eanInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    // CORREÇÃO — EAN nunca usa normalizeKey (só maiúsculiza/trima): usa
    // normalizeEan (dígitos apenas) pra tolerar espaço/pontuação/traço vindos
    // de leitor USB/colagem, mesma regra usada em todo o resto do app.
    const code = normalizeEan(eanInput.value);
    eanInput.value = "";
    if (!code) return;
    const match = currentItems.find((i) => i.ean && normalizeEan(i.ean) === code);
    if (!match) {
      playSound("product_out_of_invoice");
      vibrate("error");
      speak("Produto não pertence a esta nota.", { priority: "high", dedupeKey: "not-in-invoice", dedupeWindowMs: 1500 });
      showToast("EAN não encontrado nesta nota.", "error");
      return;
    }
    await confirmCountDelta(root, match.id, 1, "scanner");
  });

  const searchInput = root.querySelector<HTMLInputElement>("#nfeCountingSearch")!;
  const debouncedSearch = debounce((value: string) => {
    countingQuery = value;
    renderCountingList(root);
  }, 250);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  root.querySelectorAll<HTMLButtonElement>("[data-count-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      countingFilter = btn.dataset.countFilter as "all" | "pending" | "counted";
      renderCountingList(root);
      root.querySelectorAll("[data-count-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  wirePushToTalkButton(root);

  root.querySelector("#btnFinalizeReceipt")!.addEventListener("click", async () => {
    // Breakdown real (nunca "finalizar silenciosamente" com pendências escondidas).
    const totalItens = currentItems.length;
    const conferidos = currentItems.filter((i) => i.physical_quantity !== null).length;
    const pendentes = totalItens - conferidos;
    const { session } = getAuthState();
    const others = participants.filter((p) => p.userId !== session?.user.id);
    const breakdown = `NF: ${receipt.invoice_number || "-"} · Itens da NF: ${totalItens} · Itens conferidos: ${conferidos} · Pendentes: ${pendentes}`;
    const participantsNote = others.length > 0 ? ` Existem outros operadores nesta conferência: ${others.map((p) => p.fullName).join(", ")} — confirme que todos terminaram.` : "";
    const reservationsNote = itemReservations.size > 0 ? ` Há ${itemReservations.size} produto(s) ainda reservado(s) por outro operador.` : "";
    const message =
      (pendentes > 0
        ? `Existem produtos ainda não conferidos. ${breakdown}.`
        : `${breakdown}.`) +
      participantsNote +
      reservationsNote +
      ` A quantidade da NF será revelada e comparada com a contagem física${pendentes > 0 ? ' — itens não contados aparecem como "Não conferido" no relatório' : ""}.`;

    const confirmed = await confirmAction({
      title: "Finalizar Conferência?",
      message,
      confirmLabel: "Finalizar Conferência",
    });
    if (!confirmed) return;

    const btn = root.querySelector("#btnFinalizeReceipt") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Finalizando…";
    try {
      const outcome = await finalizeReceipt(receipt.id);
      if (!outcome.ok) {
        // CORREÇÃO ESTRUTURAL — dupla finalização real: outro operador
        // finalizou entre o momento em que esta tela abriu e este clique
        // (ver finalize_invoice_receipt_atomic). Nunca reprocessa por cima —
        // só leva ao relatório já oficial.
        showToast(`Esta conferência já foi finalizada${outcome.finishedByName ? " por " + outcome.finishedByName : ""}.`, "default");
        const { receipt: refreshed, items } = await getReceipt(receipt.id);
        currentReceipt = refreshed;
        currentItems = items;
        goTo(root, "result");
        return;
      }
      currentReceipt = outcome.receipt;
      currentItems = outcome.items;
      playSound("receipt_finalized");
      vibrate("completed");
      speak("Conferência finalizada.", { priority: "high", dedupeKey: "receipt-finalized" });
      goTo(root, "result");
    } catch (err) {
      showToast("Erro ao finalizar: " + (describeError(err)), "error");
      btn.disabled = false;
      btn.textContent = "Finalizar Conferência";
    }
  });
}

function renderVolumeSelector(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>("#nfeVolumeSelector");
  if (!el) return;
  if (!currentReceipt || currentReceipt.work_mode !== "volume") {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = `
    <div class="volume-selector">
      ${Icon.box}
      <label for="nfeVolumeSelect" class="sr-only">Volume atual</label>
      <select id="nfeVolumeSelect">
        <option value="">Sem volume definido</option>
        ${volumes.map((v) => `<option value="${v.id}" ${v.id === activeVolumeId ? "selected" : ""}>${escapeHtml(v.label)}</option>`).join("")}
      </select>
      <button type="button" class="btn-secondary" id="btnNewVolume">${Icon.plus}Novo volume</button>
    </div>`;

  el.querySelector<HTMLSelectElement>("#nfeVolumeSelect")!.addEventListener("change", (e) => {
    activeVolumeId = (e.target as HTMLSelectElement).value || null;
  });

  el.querySelector("#btnNewVolume")!.addEventListener("click", async () => {
    const label = await promptText({ title: "Novo volume", placeholder: "Ex.: Caixa 01, Pallet 02, Área A…", confirmLabel: "Criar" });
    if (!label) return;
    try {
      const created = await createVolume(currentReceipt!.id, label);
      if (!volumes.some((v) => v.id === created.id)) volumes = [...volumes, created];
      activeVolumeId = created.id;
      renderVolumeSelector(root);
      showToast(`Volume "${created.label}" criado.`, "success");
    } catch (err) {
      showToast("Erro ao criar volume: " + describeError(err), "error");
    }
  });
}

function wirePushToTalkButton(root: HTMLElement): void {
  const pttBtn = root.querySelector<HTMLButtonElement>("#nfeVoicePtt");
  if (!pttBtn) return;

  const begin = (e: Event) => {
    e.preventDefault();
    if (voicePushToTalkActive) return;
    voicePushToTalkActive = true;
    pttBtn.classList.add("active");
    const started = startPushToTalk({
      onResult: (cmd) => void handleVoiceCommand(root, cmd),
      onLowConfidence: () => showToast("Não entendi o comando. Tente novamente.", "error"),
      onError: (msg) => showToast(msg, "error"),
      onEnd: () => {
        voicePushToTalkActive = false;
        pttBtn.classList.remove("active");
      },
    });
    if (!started) {
      voicePushToTalkActive = false;
      pttBtn.classList.remove("active");
    }
  };
  const end = () => {
    if (isVoiceListening()) stopPushToTalk();
  };
  pttBtn.addEventListener("pointerdown", begin);
  pttBtn.addEventListener("pointerup", end);
  pttBtn.addEventListener("pointerleave", end);
}

/** Confirmação elegível por voz (segunda captura push-to-talk) OU toque — nunca aplica um comando de voz sem essa confirmação explícita (ver seção 18 do pedido). */
async function confirmVoiceEligibleAction(title: string, message: string): Promise<boolean> {
  const voiceReady = isVoiceCommandSupported() && getConferencePreferences().voiceCommandsEnabled;
  const options = [{ label: "Confirmar", value: "confirm" }];
  if (voiceReady) options.push({ label: "Confirmar por voz", value: "voice" });
  const choice = await chooseAction({ title, message, options, dismissLabel: "Cancelar" });
  if (choice === "confirm") return true;
  if (choice === "voice") {
    return new Promise((resolve) => {
      const started = startPushToTalk({
        onResult: (cmd) => resolve(cmd.kind === "confirm"),
        onLowConfidence: () => {
          showToast("Não entendi o comando. Tente novamente.", "error");
          resolve(false);
        },
        onError: (msg) => {
          showToast(msg, "error");
          resolve(false);
        },
        onEnd: () => {},
      });
      if (!started) resolve(false);
    });
  }
  return false;
}

function focusNextPendingItem(root: HTMLElement): void {
  const pendingList = filteredCountingItems().filter((i) => i.status === "pending" || i.status === "unlinked");
  if (pendingList.length === 0) {
    showToast("Não há mais produtos pendentes.", "default");
    return;
  }
  const currentIdx = lastFocusedItemId ? pendingList.findIndex((i) => i.id === lastFocusedItemId) : -1;
  const next = pendingList[(currentIdx + 1) % pendingList.length];
  const input = root.querySelector<HTMLInputElement>(`[data-qty-input="${next.id}"]`);
  input?.scrollIntoView({ behavior: "smooth", block: "center" });
  input?.focus();
}

async function handleUndoClick(root: HTMLElement, itemId: string): Promise<void> {
  const eventId = lastEventIdByItem.get(itemId);
  if (!eventId) return;
  const confirmed = await confirmAction({
    title: "Desfazer última bipagem?",
    message: `Isso reverte a sua última contagem em "${itemLabelFor(itemId)}". O histórico não é apagado — fica registrado como uma correção.`,
    confirmLabel: "Desfazer",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await undoLastCount(eventId);
    currentItems = currentItems.map((i) => (i.id === itemId ? { ...i, ...result.item } : i));
    lastEventIdByItem.delete(itemId);
    if (!updateSingleCountingCard(root, itemId)) renderCountingList(root);
    showToast(`Desfeito — total ${result.newTotal}.`, "success");
  } catch (err) {
    showToast("Erro ao desfazer: " + describeError(err), "error");
  }
}

async function handleVoiceCommand(root: HTMLElement, cmd: VoiceCommand): Promise<void> {
  switch (cmd.kind) {
    case "add_quantity":
    case "remove_quantity": {
      const targetId = myReservation?.itemId || lastFocusedItemId;
      if (!targetId) {
        showToast("Nenhum produto selecionado — toque em um produto antes de usar comandos de voz.", "error");
        return;
      }
      const amount = cmd.kind === "add_quantity" ? cmd.amount : -cmd.amount;
      const verb = cmd.kind === "add_quantity" ? "adicionar" : "remover";
      const confirmed = await confirmVoiceEligibleAction(`${verb === "adicionar" ? "Adicionar" : "Remover"} ${cmd.amount} unidade(s)?`, `${itemLabelFor(targetId)} — confirma ${verb} ${cmd.amount} unidade(s)?`);
      if (!confirmed) return;
      await attemptCountEvent(root, targetId, amount, "increment", { origin: "voice", deviceId: myDeviceId, volumeId: activeVolumeId });
      return;
    }
    case "finish_product": {
      const targetId = myReservation?.itemId || lastFocusedItemId;
      if (!targetId) {
        showToast("Nenhum produto selecionado.", "error");
        return;
      }
      const it = currentItems.find((i) => i.id === targetId);
      if (!it) return;
      const confirmed = await confirmVoiceEligibleAction("Finalizar produto?", `Confirmar ${it.physical_quantity ?? 0} unidade(s) para ${itemLabelFor(targetId)}?`);
      if (!confirmed) return;
      await attemptCountEvent(root, targetId, it.physical_quantity ?? 0, "set", { origin: "voice", deviceId: myDeviceId, volumeId: activeVolumeId });
      return;
    }
    case "next_product":
      focusNextPendingItem(root);
      return;
    case "show_pending":
      countingFilter = "pending";
      renderCountingList(root);
      root.querySelectorAll<HTMLButtonElement>("[data-count-filter]").forEach((b) => b.classList.toggle("active", b.dataset.countFilter === "pending"));
      return;
    case "undo_last": {
      const targetId = lastFocusedItemId && lastEventIdByItem.has(lastFocusedItemId) ? lastFocusedItemId : [...lastEventIdByItem.keys()].pop();
      if (!targetId) {
        showToast("Nenhuma bipagem recente para desfazer.", "error");
        return;
      }
      await handleUndoClick(root, targetId);
      return;
    }
    case "pause_conference":
      updateMyPresenceState({ status: "paused" });
      showToast("Você marcou sua presença como pausada.", "default");
      return;
    case "confirm":
    case "cancel":
      return;
    case "unrecognized":
      showToast("Não entendi o comando. Tente novamente.", "error");
  }
}

function filteredCountingItems(): InvoiceReceiptItem[] {
  const q = normalizeKey(countingQuery);
  // CORREÇÃO — busca por EAN tolerante a espaço/pontuação (ver normalizeEan):
  // testada à parte do haystack textual porque normalizeKey não remove
  // espaço interno nem pontuação, só maiúscula/trima.
  const qEan = normalizeEan(countingQuery);
  return currentItems.filter((it) => {
    if (countingFilter === "pending" && it.status !== "pending" && it.status !== "unlinked") return false;
    if (countingFilter === "counted" && it.status !== "counted") return false;
    if (!q) return true;
    if (qEan && it.ean && normalizeEan(it.ean) === qEan) return true;
    const haystack = normalizeKey(`${it.produto || ""} ${it.description || ""} ${it.sku_code || ""} ${it.invoice_product_code || ""} ${it.ean || ""}`);
    return haystack.includes(q);
  });
}

/** Liga os controles (±/confirmar/foco/desfazer) de UM OU MAIS cards dentro de `scope` — reutilizado tanto pelo render completo quanto pela atualização cirúrgica de um único card. */
function wireCountingCards(root: HTMLElement, scope: ParentNode): void {
  scope.querySelectorAll<HTMLButtonElement>("[data-qty-dec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = scope.querySelector<HTMLInputElement>(`[data-qty-input="${btn.dataset.qtyDec}"]`)!;
      input.value = String(Math.max(0, Number(input.value || 0) - 1));
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-qty-inc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = scope.querySelector<HTMLInputElement>(`[data-qty-input="${btn.dataset.qtyInc}"]`)!;
      input.value = String(Number(input.value || 0) + 1);
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-qty-bump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = scope.querySelector<HTMLInputElement>(`[data-qty-input="${btn.dataset.qtyBump}"]`)!;
      const delta = Number(btn.dataset.qtyBumpValue);
      input.value = String(Number(input.value || 0) + delta);
    });
  });
  // EXPANSÃO GOSCAN — copiar EAN do card (nunca bloqueia a bipagem: falha de
  // clipboard só mostra um toast de erro, não interrompe a contagem).
  scope.querySelectorAll<HTMLButtonElement>("[data-copy-ean]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ean = btn.dataset.copyEan!;
      try {
        await navigator.clipboard.writeText(ean);
        showToast("EAN copiado.", "success");
      } catch {
        showToast("Não foi possível copiar o EAN.", "error");
      }
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-confirm-count]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.confirmCount!;
      const input = scope.querySelector<HTMLInputElement>(`[data-qty-input="${itemId}"]`)!;
      await confirmCount(root, itemId, Math.max(0, Number(input.value) || 0));
    });
  });
  scope.querySelectorAll<HTMLInputElement>("[data-qty-input]").forEach((input) => {
    input.addEventListener("focus", () => {
      lastFocusedItemId = input.dataset.qtyInput!;
      void handleItemFocusReserve(root, input.dataset.qtyInput!);
    });
  });
  scope.querySelectorAll<HTMLButtonElement>("[data-undo-item]").forEach((btn) => {
    btn.addEventListener("click", () => void handleUndoClick(root, btn.dataset.undoItem!));
  });
  wireCountingItemEdit(root, scope);
}

/**
 * "Editar" na contagem cega — mesmo buscador/endpoint de vínculo manual da
 * tela de pendências (searchSkuForPicker + resolveItemManually), só que
 * escondido por padrão dentro do card e revelado ao clicar no lápis.
 */
function wireCountingItemEdit(root: HTMLElement, scope: ParentNode): void {
  scope.querySelectorAll<HTMLButtonElement>("[data-edit-link]").forEach((btn) => {
    const itemId = btn.dataset.editLink!;
    btn.addEventListener("click", () => {
      const picker = scope.querySelector<HTMLElement>(`[data-edit-picker="${itemId}"]`);
      if (!picker) return;
      picker.hidden = !picker.hidden;
      if (!picker.hidden) picker.querySelector<HTMLInputElement>("[data-edit-input]")?.focus();
    });
  });

  scope.querySelectorAll<HTMLInputElement>("[data-edit-input]").forEach((input) => {
    const itemId = input.dataset.editInput!;
    const resultsBox = input.parentElement!.querySelector<HTMLDivElement>(".sku-picker-results")!;
    let activeController: AbortController | null = null;

    const runSearch = async (q: string): Promise<void> => {
      activeController?.abort();
      if (!q.trim()) {
        resultsBox.hidden = true;
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      resultsBox.hidden = false;
      resultsBox.innerHTML = `<div class="sku-picker-empty">Buscando…</div>`;
      let rows: CatalogRow[];
      try {
        rows = await searchSkuForPicker(q, 15, "normal", controller.signal, false);
      } catch {
        if (controller.signal.aborted) return;
        renderError(q);
        return;
      }
      if (controller.signal.aborted) return;
      renderResults(rows);
    };
    const search = debounce(runSearch, 300);
    input.addEventListener("input", () => void search(input.value));

    function renderError(q: string): void {
      resultsBox.innerHTML = `<div class="sku-picker-empty">Erro ao consultar a base. <button type="button" class="link-btn" data-picker-retry>Tentar novamente</button></div>`;
      resultsBox.hidden = false;
      resultsBox.querySelector("[data-picker-retry]")?.addEventListener("click", () => void runSearch(q));
    }

    function renderResults(rows: CatalogRow[]): void {
      if (rows.length === 0) {
        resultsBox.innerHTML = `<div class="sku-picker-empty">Nenhum produto normal encontrado.</div>`;
        resultsBox.hidden = false;
        return;
      }
      resultsBox.innerHTML = rows
        .map((r) => {
          const badge =
            r.match_type === "exact_ean"
              ? `<span class="status-badge success">EAN exato</span>`
              : r.match_type === "exact_sku"
                ? `<span class="status-badge success">SKU exato</span>`
                : "";
          return `<button type="button" class="sku-picker-item" data-variant="${r.variant_id}" data-produto="${escapeHtml(r.produto)}" data-sku="${escapeHtml(r.sku_code)}" data-ean="${escapeHtml(r.gtin || "")}">
              <span class="sku-picker-item-info">
                <span class="product-card-name">${escapeHtml(r.produto)}</span>
                <span class="sku-code">${escapeHtml(r.sku_code)}${r.gtin ? ` · EAN ${escapeHtml(r.gtin)}` : ""}</span>
              </span>
              ${badge}
            </button>`;
        })
        .join("");
      resultsBox.hidden = false;
      resultsBox.querySelectorAll<HTMLButtonElement>(".sku-picker-item").forEach((resultBtn) => {
        resultBtn.addEventListener("click", async () => {
          const item = currentItems.find((i) => i.id === itemId);
          if (!item) return;
          try {
            const updated = await resolveItemManually(itemId, resultBtn.dataset.variant!, {
              memorize: true,
              invoiceProductCode: item.invoice_product_code,
              ean: item.ean,
            });
            currentItems = currentItems.map((i) =>
              i.id === itemId
                ? { ...i, ...updated, sku_code: resultBtn.dataset.sku!, produto: resultBtn.dataset.produto!, catalog_ean: resultBtn.dataset.ean || null }
                : i
            );
            toastLinkResult(resultBtn.dataset.produto!, updated.aliasOutcome);
            if (!updateSingleCountingCard(root, itemId)) renderCountingList(root);
          } catch (err) {
            showToast("Erro ao vincular: " + describeError(err), "error");
          }
        });
      });
    }
  });
}

function renderCountingList(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>("#nfeCountingList")!;
  const rows = filteredCountingItems();
  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.searchX}<p>Nenhum item encontrado.</p></div>`;
    return;
  }

  wrap.innerHTML = `<div class="product-card-list">${rows.map(renderCountingCard).join("")}</div>`;
  wireCountingCards(root, wrap);
}

/**
 * OTIMIZAÇÃO — nunca recarrega a lista inteira quando só UM item mudou (via
 * Realtime ou pela própria bipagem local): troca só o card daquele item no
 * DOM. Cai pro render completo (retorna false) só quando o card não está
 * na tela (item novo) ou quando o item deixou de bater com o filtro/busca
 * atual (posição na lista pode mudar).
 */
function updateSingleCountingCard(root: HTMLElement, itemId: string): boolean {
  const el = root.querySelector<HTMLElement>(`[data-item-row="${itemId}"]`);
  const it = currentItems.find((i) => i.id === itemId);
  if (!el || !it || !filteredCountingItems().some((r) => r.id === itemId)) return false;
  el.outerHTML = renderCountingCard(it);
  const fresh = root.querySelector<HTMLElement>(`[data-item-row="${itemId}"]`);
  if (fresh) wireCountingCards(root, fresh);
  return true;
}

async function confirmCount(root: HTMLElement, itemId: string, quantity: number): Promise<void> {
  await attemptCountEvent(root, itemId, quantity, "set", { origin: "manual", deviceId: myDeviceId, volumeId: activeVolumeId });
}

/**
 * Bipagem por EAN/scanner (+1 atômico). idempotencyKey é gerada UMA VEZ por
 * tentativa e reenviada em cada retry — se a 1ª chamada já tiver sido
 * processada no servidor mas a resposta se perder por falha de rede, o
 * retry com a MESMA chave não soma de novo (ver record_invoice_count_event).
 */
async function confirmCountDelta(root: HTMLElement, itemId: string, delta: number, origin: NonNullable<CountEventOptions["origin"]> = "scanner"): Promise<void> {
  await attemptCountEvent(root, itemId, delta, "increment", { origin, deviceId: myDeviceId, volumeId: activeVolumeId });
}

/**
 * CORREÇÃO ESTRUTURAL — ponto único de entrada de qualquer contagem (manual/
 * scanner/voz), cobrindo os 3 desfechos possíveis da RPC (ver
 * record_invoice_count_event em 0043_collab_conference_rpcs.sql): sucesso
 * normal, RESERVATION_CONFLICT (modo "product") e EXCESS_CONFIRMATION_REQUIRED.
 * Reaproveita a MESMA idempotencyKey em qualquer reenvio (excesso confirmado
 * ou reserva assumida) — a 1ª tentativa nunca grava nada nesses dois casos,
 * então reenviar com a chave igual é sempre seguro.
 */
async function attemptCountEvent(root: HTMLElement, itemId: string, value: number, mode: "set" | "increment", baseOpts: CountEventOptions): Promise<void> {
  const opts: CountEventOptions = { ...baseOpts, idempotencyKey: baseOpts.idempotencyKey ?? crypto.randomUUID() };
  let result: CountEventResult;
  try {
    result = mode === "increment" ? await submitCountDelta(itemId, value, opts) : await submitCount(itemId, value, opts);
  } catch (err) {
    showToast("Erro ao registrar contagem: " + describeError(err), "error");
    return;
  }

  if (result.success) {
    if (result.eventId) lastEventIdByItem.set(itemId, result.eventId);
    currentItems = currentItems.map((i) => (i.id === itemId ? { ...i, ...result.item } : i));
    if (!updateSingleCountingCard(root, itemId)) renderCountingList(root);
    if (result.firstCompletion) {
      announceItemCompleted(itemId, "Você", itemLabelFor(itemId));
    } else if (result.excess > 0) {
      playSound("excess");
      vibrate("excess");
      showToast(`Registrado com excesso: total ${result.newTotal} (${result.excess} acima da NF).`, "default");
    } else {
      playSound(opts.origin === "scanner" || opts.origin === "camera" ? "product_correct" : "quantity_added");
      vibrate("success");
      showToast(`Bipado — total ${result.newTotal}.`, "success");
    }
    return;
  }

  if (result.code === "RESERVATION_CONFLICT") {
    itemReservations.set(itemId, result.reservation);
    if (!updateSingleCountingCard(root, itemId)) renderCountingList(root);
    playSound("product_with_other_operator");
    vibrate("error");
    if (getConferencePreferences().notifyConflict) {
      speak(`${result.reservation.fullName} está conferindo este produto.`, { priority: "high", dedupeKey: `conflict:${itemId}` });
    }

    const choice = await chooseAction({
      title: "Produto em conferência",
      message: `${result.reservation.fullName} já está contando este produto (desde ${formatDateTime(result.reservation.since)}). Para evitar dupla contagem, escolha uma opção.`,
      options: [
        { label: "Solicitar colaboração", value: "collab" },
        { label: "Ir para outro produto", value: "skip" },
        { label: "Tentar assumir (se estiver inativo)", value: "assume" },
      ],
      dismissLabel: "Cancelar",
    });

    if (choice === "collab") {
      sendBroadcast("collab-request", { fromName: getAuthState().profile?.full_name || "Alguém", itemLabel: itemLabelFor(itemId) });
      showToast("Pedido de colaboração enviado.", "success");
      return;
    }
    if (choice === "assume") {
      // Mesma idempotencyKey — se a reserva ainda não expirou, conflita de
      // novo (nada duplicado); se expirou, assume e conta nesta mesma chamada.
      await attemptCountEvent(root, itemId, value, mode, opts);
    }
    return;
  }

  // EXCESS_CONFIRMATION_REQUIRED
  playSound("excess");
  vibrate("excess");
  if (getConferencePreferences().notifyExcess) {
    speak("Quantidade excedida.", { priority: "high", dedupeKey: `excess-confirm:${itemId}` });
  }

  const completedNote = result.completedBy ? ` ${result.completedBy} finalizou o produto ${formatDateTime(result.completedAt)}.` : "";
  const choice = await chooseAction({
    title: "Quantidade da NF já atingida",
    message: `Este produto já tem ${result.currentTotal} de ${result.expectedQuantity} unidades esperadas.${completedNote} Deseja confirmar esta contagem mesmo assim (${result.attemptedTotal} no total)?`,
    options: [{ label: "Confirmar excesso", value: "confirm" }],
    dismissLabel: "Cancelar",
  });

  if (choice === "confirm") {
    await attemptCountEvent(root, itemId, value, mode, { ...opts, confirmExcess: true });
  }
}

/**
 * EXPANSÃO GOSCAN — EAN clicável (copiar) no card de conferência. Prioriza
 * o EAN que veio na própria NF (it.ean); cai pro EAN cadastrado no produto
 * vinculado (it.catalog_ean — mesmo join de getReceipt, NUNCA uma consulta
 * extra por card) só quando a NF não trouxe um. Sem nenhum dos dois, mostra
 * "EAN não informado" discreto. `.product-card-meta` é um flex-wrap que já
 * aceita mais spans — campos futuros (localização, fabricante, marca, peso,
 * unidade, observações) entram do mesmo jeito, sem refazer o card.
 */
function renderEanChip(it: InvoiceReceiptItem): string {
  const ean = it.ean || it.catalog_ean || null;
  if (!ean) return `<span class="hint-text">EAN não informado</span>`;
  return `<button type="button" class="ean-copy-chip" data-copy-ean="${escapeHtml(ean)}" aria-label="Copiar EAN ${escapeHtml(ean)}">EAN: ${escapeHtml(ean)}</button>`;
}

// EXPANSÃO GOSCAN — atalhos de incremento rápido ao lado do stepper -/+ da
// contagem cega. Chamam a MESMA operação local já usada pelo "+" (soma no
// input, ver wireCountingCards) com um delta maior — nada é enviado ao
// servidor aqui, exatamente como o "+" atual: só "Confirmar item" envia.
const QTY_BUMP_VALUES = [5, 10, 15, 20];

function renderQtyBumpRow(itemId: string, disabled: boolean): string {
  return `
        <div class="qty-bump-row">
          ${QTY_BUMP_VALUES.map(
            (v) =>
              `<button type="button" data-qty-bump="${itemId}" data-qty-bump-value="${v}" aria-label="Adicionar ${v} unidades" ${
                disabled ? "disabled" : ""
              }>+${v}</button>`
          ).join("")}
        </div>`;
}

// EXPANSÃO GOSCAN — correção do produto vinculado direto na contagem cega.
// O vínculo automático/manual pode ter acertado o produto errado (nome
// parecido, EAN de outro item etc.) e isso só costuma ser percebido quando o
// operador tem o item físico na mão. "Editar" reaproveita EXATAMENTE o mesmo
// buscador/endpoint do vínculo manual da tela de pendências
// (wirePendingItemPickers/resolveItemManually) — nenhuma lógica nova de
// vínculo, só um outro lugar de acioná-la. resolveItemManually já marca
// status:'pending' (nunca mantém "Contado" pro produto errado) sem tocar em
// expected_quantity (a quantidade da NF pra aquela linha não muda).
function renderCountingCard(it: InvoiceReceiptItem): string {
  const { session } = getAuthState();
  const myId = session?.user.id;
  const reservation = itemReservations.get(it.id);
  const isLockedByOther = !!reservation && reservation.userId !== myId;
  const canUndo = lastEventIdByItem.has(it.id);
  return `
    <div class="product-card ${isLockedByOther ? "product-card-locked" : ""}" data-item-row="${it.id}">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(itemTitle(it))}</p>
        <div class="product-card-top-actions">
          ${itemStamp(it.status)}
          <button type="button" class="icon-btn" data-edit-link="${it.id}" aria-label="Editar produto vinculado" ${isLockedByOther ? "disabled" : ""}>${Icon.pencil}</button>
        </div>
      </div>
      <div class="product-card-meta">
        <span class="sku-code">${escapeHtml(itemCodeLabel(it))}</span>
        ${renderEanChip(it)}
      </div>
      ${isLockedByOther ? `<div class="warning-box reservation-banner">${Icon.lock}Em conferência por ${escapeHtml(reservation!.fullName)}</div>` : ""}
      <div class="sku-picker" data-edit-picker="${it.id}" hidden>
        <p class="hint-text">Produto errado? Busque e escolha o produto correto pra este item da NF.</p>
        <input type="text" class="sku-picker-input" aria-label="Buscar produto correto" placeholder="Buscar por nome, SKU ou EAN…" data-edit-input="${it.id}" />
        <div class="sku-picker-results" hidden></div>
        <p class="hint-text" style="margin-top:6px">Ao vincular, esta associação é memorizada automaticamente pra próximas notas deste fornecedor.</p>
      </div>
      <div class="product-card-bottom">
        <div class="qty-stepper">
          <button type="button" data-qty-dec="${it.id}" aria-label="Diminuir quantidade" ${isLockedByOther ? "disabled" : ""}>${Icon.minus}</button>
          <input type="number" min="0" inputmode="numeric" value="${it.physical_quantity ?? 0}" data-qty-input="${it.id}" aria-label="Quantidade física" ${isLockedByOther ? "disabled" : ""} />
          <button type="button" data-qty-inc="${it.id}" aria-label="Aumentar quantidade" ${isLockedByOther ? "disabled" : ""}>${Icon.plus}</button>
        </div>
        ${renderQtyBumpRow(it.id, isLockedByOther)}
        <button class="btn-primary" data-confirm-count="${it.id}" ${isLockedByOther ? "disabled" : ""}>Confirmar item</button>
      </div>
      ${canUndo ? `<button type="button" class="btn-secondary btn-block" data-undo-item="${it.id}" style="margin-top:8px">${Icon.undo2}Desfazer minha última bipagem</button>` : ""}
    </div>`;
}

// ---------------------------------------------------------------------------
// 4. Resultado / Relatório de Conferência — só aqui a quantidade da NF é
// revelada. Encerramento definitivo: fora de "Recontar" (ação explícita,
// preserva histórico em receipt_counts), nada aqui volta pra contagem cega.
// ---------------------------------------------------------------------------
const RESULT_FILTER_LABEL: Record<ResultFilter, string> = {
  all: "Todos",
  ok: "OK",
  missing: "Faltas",
  surplus: "Sobras",
  pending: "Não conferidos",
  divergent: "Divergências",
};

/** Formata like "91,04" (vírgula, 2 casas) — nunca inventa, sempre a partir da razão real ok/conferidos. */
function formatConformity(rate: number): string {
  return (Math.round(rate * 10000) / 100).toFixed(2).replace(".", ",");
}

function formatCnpj(cnpj: string | null): string {
  if (!cnpj) return "-";
  const digits = cnpj.replace(/\D/g, "");
  if (digits.length !== 14) return cnpj;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
}

function filteredResultItems(): InvoiceReceiptItem[] {
  const q = normalizeKey(resultQuery);
  return currentItems.filter((it) => {
    if (resultFilter === "ok" && it.status !== "ok") return false;
    if (resultFilter === "missing" && it.status !== "missing") return false;
    if (resultFilter === "surplus" && it.status !== "surplus") return false;
    if (resultFilter === "pending" && it.status !== "pending" && it.status !== "unlinked") return false;
    if (resultFilter === "divergent" && it.status === "ok") return false;
    if (!q) return true;
    const haystack = normalizeKey(`${itemTitle(it)} ${itemCodeLabel(it)} ${itemEanLabel(it)}`);
    return haystack.includes(q);
  });
}

function renderResultView(root: HTMLElement): void {
  const receipt = currentReceipt!;

  // FASE 4 — reaproveita summarizeReceipt (nfeMatching.ts) em vez de recalcular
  // ok/missing/surplus/conformidade aqui: mesma fórmula usada em qualquer outro
  // lugar do app que resume uma NF, nunca duas regras divergentes pro mesmo
  // conceito. pending já cobre 'unlinked' (physical_quantity sempre nulo nesses
  // itens, mesmo resultado da checagem antiga por status).
  const summary = summarizeReceipt(currentItems);
  const { ok, missing, surplus, pending: notCounted, totalExpectedQuantity: totalExpected, totalPhysicalQuantity: totalPhysical, netDifference, conformityRate } = summary;
  const counted = ok + missing + surplus;
  const filtered = filteredResultItems();

  root.innerHTML = `
    <div class="card">
      <button class="btn-secondary" id="btnBackToUpload2">${Icon.chevronLeft}Outra nota</button>
      <h2>${receipt.status === "completed" ? "Conferência Finalizada" : "Conferência Finalizada — Com Divergências"}</h2>
      <p class="hint-text">NF ${escapeHtml(receipt.invoice_number || "-")} · ${currentItems.length} SKUs da NF · ${counted} conferido(s)</p>
      <div class="active-conference-stats" style="flex-wrap:wrap">
        <span class="active-conference-stat">${ok}<span>✓ OK</span></span>
        <span class="active-conference-stat">${missing}<span>⚠ Com falta</span></span>
        <span class="active-conference-stat">${surplus}<span>⚠ Com sobra</span></span>
      </div>
      <p class="hint-text">Conformidade dos itens conferidos: <strong>${formatConformity(conformityRate)}%</strong></p>
      <div class="review-actions">
        <button class="btn-secondary" id="btnScrollReport">Ver relatório completo</button>
        <button class="btn-secondary" id="btnScrollDivergences">Ver divergências</button>
        <button class="btn-secondary" id="btnExportPdf">${Icon.fileText}Exportar PDF</button>
        <button class="btn-secondary" id="btnExportExcel">${Icon.fileSpreadsheet}Exportar Excel</button>
        <button class="btn-secondary" id="btnBackToHistory">${Icon.history}Voltar ao histórico</button>
      </div>
    </div>

    <div class="card" id="nfeReportHeader">
      <h2>Relatório de Conferência</h2>
      <div class="product-card-meta">
        <span>NF-e: ${escapeHtml(receipt.invoice_number || "-")}</span>
        <span>Série: ${escapeHtml(receipt.series || "-")}</span>
        <span class="sku-code">Chave: ${escapeHtml(receipt.invoice_key)}</span>
        <span>Fornecedor: ${escapeHtml(receipt.supplier_name || "-")}</span>
        <span>CNPJ: ${escapeHtml(formatCnpj(receipt.supplier_cnpj))}</span>
        <span>Emissão: ${formatDateTime(receipt.issued_at)}</span>
        <span>Importada/criada por: ${escapeHtml(receipt.created_by_name || "-")}</span>
        <span>Início da conferência: ${formatDateTime(receipt.started_at)}</span>
        <span>Finalização: ${formatDateTime(receipt.finished_at)}</span>
        <span>Finalizada por: ${escapeHtml(receipt.finished_by_name || "-")}</span>
        <span>Duração: ${formatOperationDuration(receipt.started_at, receipt.finished_at)}</span>
      </div>
      <div class="active-conference-stats" style="flex-wrap:wrap">
        <span class="active-conference-stat">${currentItems.length}<span>SKUs da NF</span></span>
        <span class="active-conference-stat">${counted}<span>SKUs conferidos</span></span>
        <span class="active-conference-stat">${ok}<span>OK</span></span>
        <span class="active-conference-stat">${missing}<span>Com falta</span></span>
        <span class="active-conference-stat">${surplus}<span>Com sobra</span></span>
        <span class="active-conference-stat">${notCounted}<span>Não conferidos</span></span>
      </div>
      <p class="hint-text">Quantidade total NF: ${totalExpected} · Quantidade física: ${totalPhysical} · Diferença total: <strong>${formatSignedNumber(netDifference)}</strong></p>
    </div>

    ${renderTinyLaunchCard(receipt, currentItems)}

    <div class="card" id="nfeReportTable">
      <div class="input-mode-switch" style="flex-wrap:wrap">
        ${(Object.keys(RESULT_FILTER_LABEL) as ResultFilter[])
          .filter((f) => f !== "divergent")
          .map((f) => `<button class="mode-btn ${resultFilter === f ? "active" : ""}" data-result-filter="${f}">${RESULT_FILTER_LABEL[f]}</button>`)
          .join("")}
      </div>
      <label for="nfeReportSearch" class="sr-only">Buscar por nome, SKU ou EAN</label>
      <input type="text" id="nfeReportSearch" placeholder="Buscar por nome, SKU ou EAN…" value="${escapeHtml(resultQuery)}" style="margin-bottom:12px" />
      <div class="product-card-list mobile-only">${filtered.map(renderResultCard).join("")}</div>
      <div class="table-wrap desktop-only">
        <table>
          <thead><tr><th>Nome</th><th>SKU</th><th>EAN</th><th>NF</th><th>Físico</th><th>Diferença</th><th>Status</th><th></th></tr></thead>
          <tbody>${filtered.map(renderResultRow).join("")}</tbody>
        </table>
      </div>
      ${filtered.length === 0 ? `<div class="empty-state">${Icon.searchX}<p>Nenhum item encontrado com esse filtro/busca.</p></div>` : ""}
    </div>`;

  root.querySelector("#btnBackToUpload2")!.addEventListener("click", () => {
    currentReceipt = null;
    currentItems = [];
    goTo(root, "upload");
  });
  root.querySelector("#btnBackToHistory")!.addEventListener("click", () => goTo(root, "history"));
  root.querySelector("#btnScrollReport")!.addEventListener("click", () => {
    root.querySelector("#nfeReportHeader")?.scrollIntoView({ behavior: "smooth" });
  });
  root.querySelector("#btnScrollDivergences")!.addEventListener("click", () => {
    resultFilter = "divergent";
    renderResultView(root);
    root.querySelector("#nfeReportTable")?.scrollIntoView({ behavior: "smooth" });
  });
  root.querySelector("#btnExportPdf")!.addEventListener("click", () => exportReportToPdf());
  root.querySelector("#btnExportExcel")!.addEventListener("click", () => exportReportToExcel(receipt, currentItems));

  root.querySelectorAll<HTMLButtonElement>("[data-result-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      resultFilter = btn.dataset.resultFilter as ResultFilter;
      renderResultView(root);
    });
  });

  const searchInput = root.querySelector<HTMLInputElement>("#nfeReportSearch")!;
  const debouncedSearch = debounce((value: string) => {
    resultQuery = value;
    renderResultView(root);
  }, 250);
  searchInput.addEventListener("input", (e) => debouncedSearch((e.target as HTMLInputElement).value));

  wireRecountButtons(root);
  wireTinyLaunchCard(root, receipt, currentItems);
}

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Lançamento de estoque no Tiny ao finalizar a conferência
// por NF (ver migration 0051 e supabase/functions/tiny-integration/). Só
// itens fisicamente confirmados (ok/sobra) com produto vinculado entram —
// nunca o que faltou ou ficou sem vínculo, mesmo estando na NF original.
// Mesmo padrão de logisticsQueue.ts: busca depósitos sob demanda (nunca ao
// carregar a tela) + fallback manual sempre disponível.
// ---------------------------------------------------------------------------
let cachedTinyWarehousesNfe: TinyWarehouse[] | null = null;

function eligibleForTinyLaunch(items: InvoiceReceiptItem[]): InvoiceReceiptItem[] {
  return items.filter((i) => (i.status === "ok" || i.status === "surplus") && i.product_variant_id && (i.physical_quantity ?? 0) > 0);
}

function describeNfeLaunchOutcome(outcome: TinyLaunchOutcome): string {
  const { summary } = outcome;
  const parts = [`${summary.succeeded} lançado(s)`];
  if (summary.alreadyDone > 0) parts.push(`${summary.alreadyDone} já lançado(s) antes`);
  if (summary.failed > 0) parts.push(`${summary.failed} com falha`);
  return parts.join(", ") + ".";
}

function renderTinyLaunchCard(receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): string {
  if (receipt.status !== "completed" && receipt.status !== "with_divergences") return "";

  if (receipt.tiny_launch_status === "lancado") {
    return `
      <div class="card">
        <h2>${Icon.link}Lançamento no Tiny</h2>
        <p class="hint-text">${Icon.checkCircle} Lançada em ${formatDateTime(receipt.tiny_launched_at)} — depósito "${escapeHtml(receipt.tiny_launch_warehouse || "-")}".</p>
      </div>`;
  }

  const eligible = eligibleForTinyLaunch(items);
  if (eligible.length === 0) {
    return `
      <div class="card">
        <h2>${Icon.link}Lançamento no Tiny</h2>
        <p class="hint-text">Nenhum item fisicamente confirmado (OK/sobra) com produto vinculado pra lançar ainda.</p>
      </div>`;
  }

  const eligibleUnits = eligible.reduce((acc, i) => acc + (i.physical_quantity ?? 0), 0);
  return `
    <div class="card">
      <h2>${Icon.link}Lançar no Tiny</h2>
      <p class="hint-text">${eligible.length} SKU(s) confirmados fisicamente (${eligibleUnits} unidade(s)) prontos pra lançar como entrada de estoque.</p>
      <div id="nfeTinyAutoWrap">
        <button type="button" class="btn-secondary btn-block" id="btnNfeLoadWarehouses">${Icon.refresh}Buscar depósitos do Tiny</button>
      </div>
    </div>
    <div class="card">
      <h3>Ou registre manualmente</h3>
      <div class="warning-box">${Icon.info} Esta confirmação informa que as quantidades foram lançadas manualmente no Tiny (por fora do GoScan). Ela não atualiza o estoque automaticamente.</div>
      <label for="nfeManualWarehouse">Depósito utilizado</label>
      <input type="text" id="nfeManualWarehouse" placeholder="Ex.: Depósito Central" />
      <label for="nfeManualLaunchedAt">Data do lançamento</label>
      <input type="datetime-local" id="nfeManualLaunchedAt" value="${new Date().toISOString().slice(0, 16)}" />
      <label for="nfeManualNote">Observação (opcional)</label>
      <textarea id="nfeManualNote" rows="2"></textarea>
      <button class="btn-accent btn-block" id="btnNfeManualConfirm">Confirmar lançamento no Tiny</button>
    </div>`;
}

function wireTinyLaunchCard(root: HTMLElement, receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): void {
  const loadBtn = root.querySelector<HTMLButtonElement>("#btnNfeLoadWarehouses");
  if (loadBtn) {
    loadBtn.addEventListener("click", async () => {
      loadBtn.disabled = true;
      loadBtn.textContent = "Buscando…";
      try {
        if (!cachedTinyWarehousesNfe) cachedTinyWarehousesNfe = await getTinyWarehouses();
        renderNfeAutoLaunchForm(root, receipt, items);
      } catch (err) {
        if (err instanceof TinyIntegrationError && err.code === "NOT_CONFIGURED") {
          showToast("Integração com o Tiny ainda não configurada — use a confirmação manual abaixo.", "error");
        } else {
          showToast("Erro ao buscar depósitos: " + describeError(err), "error");
        }
        loadBtn.disabled = false;
        loadBtn.textContent = "Buscar depósitos do Tiny";
      }
    });
  }

  const manualBtn = root.querySelector<HTMLButtonElement>("#btnNfeManualConfirm");
  if (manualBtn) {
    manualBtn.addEventListener("click", async () => {
      const warehouse = (root.querySelector("#nfeManualWarehouse") as HTMLInputElement).value;
      const launchedAtRaw = (root.querySelector("#nfeManualLaunchedAt") as HTMLInputElement).value;
      const note = (root.querySelector("#nfeManualNote") as HTMLTextAreaElement).value;
      if (!warehouse.trim()) {
        showToast("Informe o depósito utilizado.", "error");
        return;
      }
      if (!launchedAtRaw) {
        showToast("Informe a data do lançamento.", "error");
        return;
      }
      const confirmed = await confirmAction({
        title: "Confirmar lançamento?",
        message: `Confirma que os itens conferidos foram lançados manualmente no depósito "${warehouse}"? Esta ação não pode ser desfeita.`,
        confirmLabel: "Confirmar lançamento",
      });
      if (!confirmed) return;

      manualBtn.disabled = true;
      manualBtn.textContent = "Confirmando…";
      try {
        await confirmInvoiceReceiptTinyLaunch({ receiptId: receipt.id, warehouse, launchedAt: new Date(launchedAtRaw).toISOString(), note });
        showToast("Lançamento confirmado.", "success");
        await refreshReceiptAfterTinyLaunch(root, receipt.id);
      } catch (err) {
        showToast("Erro ao confirmar lançamento: " + describeError(err), "error");
        manualBtn.disabled = false;
        manualBtn.textContent = "Confirmar lançamento no Tiny";
      }
    });
  }
}

function renderNfeAutoLaunchForm(root: HTMLElement, receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): void {
  const wrap = root.querySelector<HTMLElement>("#nfeTinyAutoWrap")!;
  const warehouses = cachedTinyWarehousesNfe ?? [];
  if (warehouses.length === 0) {
    wrap.innerHTML = `<p class="hint-text">Nenhum depósito encontrado no Tiny.</p>`;
    return;
  }
  const eligible = eligibleForTinyLaunch(items);
  const eligibleUnits = eligible.reduce((acc, i) => acc + (i.physical_quantity ?? 0), 0);

  wrap.innerHTML = `
    <label for="nfeWarehouseSelect">Depósito (Tiny)</label>
    <select id="nfeWarehouseSelect">${warehouses.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("")}</select>
    <label for="nfeUnitPrice">Valor unitário — sobrescreve o valor da NF (opcional)</label>
    <input type="number" id="nfeUnitPrice" min="0" step="0.01" placeholder="Usar valor da NF por item" />
    <label for="nfeAutoNote">Observação (opcional)</label>
    <textarea id="nfeAutoNote" rows="2"></textarea>
    <button type="button" class="btn-accent btn-block" id="btnNfeLaunchViaApi">${Icon.link}Lançar ${eligible.length} SKU(s) / ${eligibleUnits} unidade(s) via Tiny</button>
    <p class="hint-text" id="nfeTinyLaunchResult"></p>`;

  wrap.querySelector("#btnNfeLaunchViaApi")!.addEventListener("click", async () => {
    const select = wrap.querySelector<HTMLSelectElement>("#nfeWarehouseSelect")!;
    const warehouseId = select.value;
    const warehouseName = select.options[select.selectedIndex]?.text || "";
    const unitPriceRaw = (wrap.querySelector<HTMLInputElement>("#nfeUnitPrice")!).value;
    const note = (wrap.querySelector<HTMLTextAreaElement>("#nfeAutoNote")!).value;

    const confirmed = await confirmAction({
      title: "Lançar via API do Tiny?",
      message: `O GoScan vai chamar a API do Tiny agora e criar a entrada de estoque real pra cada SKU confirmado desta NF no depósito "${warehouseName}". Isso não pode ser desfeito automaticamente.`,
      confirmLabel: "Lançar agora",
    });
    if (!confirmed) return;

    const btn = wrap.querySelector<HTMLButtonElement>("#btnNfeLaunchViaApi")!;
    const resultEl = wrap.querySelector<HTMLElement>("#nfeTinyLaunchResult")!;
    btn.disabled = true;
    btn.textContent = "Lançando…";
    try {
      const outcome = await launchInvoiceReceiptToTiny(receipt.id, {
        warehouseId,
        warehouseName,
        unitPrice: unitPriceRaw ? Number(unitPriceRaw) : undefined,
        note: note || undefined,
      });
      showToast(describeNfeLaunchOutcome(outcome), outcome.summary.allSucceeded ? "success" : "error");
      if (!outcome.summary.allSucceeded) {
        const failedList = outcome.results
          .filter((r) => r.status === "failed")
          .map((r) => r.error)
          .join(" | ");
        resultEl.textContent = `Itens com falha: ${failedList}`;
      }
      await refreshReceiptAfterTinyLaunch(root, receipt.id);
    } catch (err) {
      showToast("Erro ao lançar via Tiny: " + describeError(err), "error");
      btn.disabled = false;
      btn.textContent = `Lançar ${eligible.length} SKU(s) / ${eligibleUnits} unidade(s) via Tiny`;
    }
  });
}

async function refreshReceiptAfterTinyLaunch(root: HTMLElement, receiptId: string): Promise<void> {
  const { receipt, items } = await getReceipt(receiptId);
  currentReceipt = receipt;
  currentItems = items;
  renderResultView(root);
}

function diffLabel(it: InvoiceReceiptItem): string {
  if (it.physical_quantity === null) return "-";
  const diff = it.physical_quantity - it.expected_quantity;
  return diff > 0 ? `+${diff}` : String(diff);
}

function renderResultCard(it: InvoiceReceiptItem): string {
  const isRecounting = recountingIds.has(it.id);
  return `
    <div class="product-card">
      <div class="product-card-top">
        <p class="product-card-name">${escapeHtml(itemTitle(it))}</p>
        ${reportStatusStamp(it.status)}
      </div>
      <div class="product-card-meta">
        <span class="sku-code">${escapeHtml(itemCodeLabel(it))}</span>
        <span>EAN: ${escapeHtml(itemEanLabel(it))}</span>
        <span>NF: ${it.expected_quantity}</span>
        <span>Físico: ${it.physical_quantity ?? "—"}</span>
        <span>Diferença: ${diffLabel(it)}</span>
      </div>
      ${
        isRecounting
          ? `<div class="qty-stepper">
              <input type="number" min="0" inputmode="numeric" value="${it.physical_quantity ?? 0}" data-recount-input="${it.id}" aria-label="Nova contagem" />
              <button class="btn-primary" data-recount-confirm="${it.id}">Salvar</button>
            </div>`
          : `<button class="btn-secondary" data-recount-start="${it.id}">${Icon.refresh}Recontar</button>`
      }
    </div>`;
}

function renderResultRow(it: InvoiceReceiptItem): string {
  const isRecounting = recountingIds.has(it.id);
  return `
    <tr>
      <td>${escapeHtml(itemTitle(it))}</td>
      <td class="sku-code">${escapeHtml(itemCodeLabel(it))}</td>
      <td>${escapeHtml(itemEanLabel(it))}</td>
      <td>${it.expected_quantity}</td>
      <td>${it.physical_quantity ?? "—"}</td>
      <td>${diffLabel(it)}</td>
      <td>${reportStatusStamp(it.status)}</td>
      <td>
        ${
          isRecounting
            ? `<input type="number" min="0" inputmode="numeric" value="${it.physical_quantity ?? 0}" data-recount-input="${it.id}" style="width:70px" aria-label="Nova contagem" />
               <button class="btn-primary" data-recount-confirm="${it.id}">Salvar</button>`
            : `<button class="row-remove" data-recount-start="${it.id}" title="Recontar" aria-label="Recontar">${Icon.refresh}</button>`
        }
      </td>
    </tr>`;
}

function wireRecountButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-recount-start]").forEach((btn) => {
    btn.addEventListener("click", () => {
      recountingIds.add(btn.dataset.recountStart!);
      renderResultView(root);
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-recount-confirm]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.dataset.recountConfirm!;
      const input = root.querySelector<HTMLInputElement>(`[data-recount-input="${itemId}"]`)!;
      const quantity = Math.max(0, Number(input.value) || 0);
      try {
        const result = await submitCount(itemId, quantity, { origin: "manual", deviceId: myDeviceId });
        if (!result.success) {
          // Recontagem de manager/admin também passa pela checagem de
          // excesso — reenvia já confirmando (é uma correção deliberada, não
          // uma bipagem espontânea que precisa de diálogo extra).
          if (result.code !== "EXCESS_CONFIRMATION_REQUIRED") throw new Error("Não foi possível registrar a recontagem.");
          const retry = await submitCount(itemId, quantity, { origin: "manual", deviceId: myDeviceId, confirmExcess: true });
          if (!retry.success) throw new Error("Não foi possível registrar a recontagem.");
        }
        // Recontagem pode mudar o resultado geral (ok/falta/sobra) — refinaliza
        // com recompute:true (permitido pra manager/admin numa NF já
        // fechada) pra recalcular status de TODOS os itens, não só o recontado.
        const outcome = await finalizeReceipt(currentReceipt!.id, { recompute: true });
        if (!outcome.ok) throw new Error("Não foi possível recalcular o resultado da conferência.");
        currentReceipt = outcome.receipt;
        currentItems = outcome.items;
        recountingIds.delete(itemId);
        renderResultView(root);
        showToast("Recontagem registrada — histórico anterior preservado.", "success");
      } catch (err) {
        showToast("Erro na recontagem: " + (describeError(err)), "error");
      }
    });
  });
}

/**
 * "Exportar PDF" via impressão do navegador (Salvar como PDF) — gera um PDF
 * real sem precisar de nenhuma biblioteca nova. O CSS de impressão (ver
 * style.css) esconde os controles (botões/filtro/busca/navegação) e força a
 * versão em tabela mesmo no celular, sem cortar colunas.
 */
function exportReportToPdf(): void {
  window.print();
}

function exportReportToExcel(receipt: InvoiceReceiptWithNames, items: InvoiceReceiptItem[]): void {
  try {
    exportNfeReportToXlsx(receipt, items);
    showToast("Planilha exportada.", "success");
  } catch (err) {
    showToast("Erro ao exportar Excel: " + describeError(err), "error");
  }
}

// ---------------------------------------------------------------------------
// 5. Histórico de Notas
// ---------------------------------------------------------------------------
async function renderHistoryView(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <div class="card">
      <button class="btn-secondary" id="btnBackToUpload3">${Icon.chevronLeft}Voltar</button>
      <h2>Histórico de Notas</h2>
      <div id="nfeHistoryWrap"><p class="hint-text">Carregando…</p></div>
    </div>`;

  root.querySelector("#btnBackToUpload3")!.addEventListener("click", () => goTo(root, "upload"));

  const wrap = root.querySelector<HTMLElement>("#nfeHistoryWrap")!;
  try {
    historyList = await listReceiptHistory(30);
  } catch (err) {
    wrap.innerHTML = `<p class="error-box">Erro ao carregar histórico: ${escapeHtml(describeError(err))}</p>`;
    return;
  }

  if (historyList.length === 0) {
    wrap.innerHTML = `<div class="empty-state">${Icon.receipt}<p>Nenhuma nota importada ainda.</p></div>`;
    return;
  }

  const { profile } = getAuthState();
  const canManage = isManagerOrAdmin(profile);

  wrap.innerHTML = `
    <ul class="recent-list">
      ${historyList
        .map((r) => {
          // CORREÇÃO ESTRUTURAL — excluir NF passou a ser exclusivo de
          // manager/admin, mesmo para quem importou (pedido explícito: "o
          // operador não pode excluir uma NF"). Corresponde exatamente à
          // policy de DELETE no banco (ver 0038_company_scoped_rls.sql) —
          // esconder o botão quando ele com certeza falharia evita um erro
          // confuso pro operador.
          const canDelete = canManage;
          return `
        <li>
          <a class="recent-list-link" href="#/conferir/nfe/${r.id}" data-open-receipt="${r.id}">
            <div>
              <strong>NF ${escapeHtml(r.invoice_number || "-")} — ${escapeHtml(r.supplier_name || "-")}</strong>
              <span class="hint-text" style="margin:0">${formatDateTime(r.created_at)} · ${escapeHtml(r.operator_name || "-")}</span>
            </div>
          </a>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
              <span class="status-badge ${r.status === "completed" ? "success" : r.status === "with_divergences" ? "warning" : "info"}">${escapeHtml(RECEIPT_STATUS_LABEL[r.status])}</span>
              <span class="hint-text" style="margin:0">${r.item_count} item(ns)</span>
            </div>
            ${canDelete ? `<button type="button" class="icon-btn danger" data-delete-receipt="${r.id}" aria-label="Excluir NF">${Icon.trash}</button>` : ""}
          </div>
        </li>`;
        })
        .join("")}
    </ul>`;

  // FASE 4 — link real (Ctrl/Cmd+click, botão do meio, menu de contexto e
  // copiar endereço funcionam nativamente): só intercepta o clique NORMAL,
  // sem modificador, pra reaproveitar openReceiptFromRoute sem descartar o
  // estado da aba atual com uma navegação de página inteira.
  wrap.querySelectorAll<HTMLAnchorElement>("[data-open-receipt]").forEach((a) => {
    a.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      void openReceiptFromRoute(root, a.dataset.openReceipt!);
    });
  });

  wrap.querySelectorAll<HTMLButtonElement>("[data-delete-receipt]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteReceipt!;
      const r = historyList.find((x) => x.id === id);
      const confirmed = await confirmAction({
        title: "Excluir Nota Fiscal?",
        message: `NF ${r?.invoice_number || "-"} — ${r?.supplier_name || "-"}. Esta ação não pode ser desfeita: a nota, seus itens e as contagens registradas serão removidos definitivamente.`,
        confirmLabel: "Excluir",
        danger: true,
      });
      if (!confirmed) return;

      try {
        await deleteReceipt(id);
        showToast("Nota Fiscal excluída.", "success");
        await renderHistoryView(root);
      } catch (err) {
        showToast("Erro ao excluir NF: " + describeError(err), "error");
      }
    });
  });
}
