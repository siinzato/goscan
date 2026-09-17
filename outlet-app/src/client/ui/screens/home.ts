import { getAuthState } from "../../auth.ts";
import {
  getMyActiveConference,
  listRecentConferences,
  getHomeOperationalSummary,
  type Conference,
  type ConferenceWithOperator,
  type HomeOperationalSummary,
} from "../../conferencesApi.ts";
import {
  listReceiptHistory,
  getMostRecentInProgressReceipt,
  getReceiptAttentionCounts,
  type ReceiptWithCounts,
  type InProgressReceiptSummary,
  type ReceiptAttentionCounts,
} from "../../nfeApi.ts";
import { RECEIPT_STATUS_LABEL } from "../../nfeReportFormat.ts";
import { escapeHtml, formatDateTime, initials, todayLocalRangeIso, renderErrorWithRetry } from "../../utils.ts";
import { getNetworkStatus, subscribeNetwork, type NetworkStatus } from "../../offline.ts";
import { unlockScanSound } from "./scan.ts";
import { Icon } from "../icons.ts";

function statusLabel(status: Conference["status"]): string {
  return { draft: "Rascunho", in_progress: "Em andamento", completed: "Concluída", cancelled: "Cancelada" }[status];
}

function statusBadge(status: Conference["status"]): string {
  if (status === "completed") return `<span class="status-badge success">${Icon.checkCircle}${statusLabel(status)}</span>`;
  if (status === "cancelled") return `<span class="status-badge error">${Icon.xCircle}${statusLabel(status)}</span>`;
  return `<span class="status-badge warning">${Icon.info}${statusLabel(status)}</span>`;
}

const CONNECTION_META: Record<NetworkStatus, { label: string; cls: string; icon: string }> = {
  online: { label: "Conectado", cls: "online", icon: Icon.checkCircle },
  synced: { label: "Conectado", cls: "online", icon: Icon.checkCircle },
  offline: { label: "Offline", cls: "offline", icon: Icon.wifiOff },
  reconnecting: { label: "Sincronizando…", cls: "syncing", icon: Icon.loader },
  sync_error: { label: "Erro ao sincronizar", cls: "offline", icon: Icon.alertTriangle },
};

function connectionPill(): string {
  const meta = CONNECTION_META[getNetworkStatus()];
  return `<span class="connection-pill ${meta.cls}" id="home-connection-pill">${meta.icon}${meta.label}</span>`;
}

function receiptBadgeClass(status: ReceiptWithCounts["status"]): string {
  if (status === "completed") return "success";
  if (status === "with_divergences") return "warning";
  return "info";
}

function receiptBadge(status: ReceiptWithCounts["status"]): string {
  return `<span class="status-badge ${receiptBadgeClass(status)}">${escapeHtml(RECEIPT_STATUS_LABEL[status])}</span>`;
}

/**
 * "OPERAÇÃO DE HOJE" — reaproveita o grid 2x2/4x1 já existente no painel de
 * Administração (admin-stat-grid/admin-stat-tile), sem inventar layout novo.
 * Os 4 números vêm 100% da RPC get_home_operational_summary (migration
 * 0057) — nunca de aproximação local. Se a RPC falhar, mostra um aviso em vez
 * de zeros (zero aqui pareceria "nenhuma operação hoje", o que seria um dado
 * inventado — nunca exibir número que não veio do banco).
 */
function todayOperationCard(summary: HomeOperationalSummary | null, failed: boolean): string {
  if (failed) {
    return `
      <h2>Operação de hoje</h2>
      <div class="warning-box">${Icon.alertTriangle} Não foi possível carregar os indicadores de hoje.</div>`;
  }
  const s = summary;
  const skuCount = new Set([...(s?.outletSkuIds ?? []), ...(s?.nfeSkuIds ?? [])]).size;
  const totalUnits = (s?.outletUnits ?? 0) + (s?.nfeUnits ?? 0);
  const tiles: { icon: string; value: number; label: string }[] = [
    { icon: Icon.camera, value: s?.outletConferences ?? 0, label: "Conferências" },
    { icon: Icon.receipt, value: s?.nfeReceipts ?? 0, label: "NF-e" },
    { icon: Icon.barcode, value: skuCount, label: "SKUs" },
    { icon: Icon.box, value: totalUnits, label: "Unidades" },
  ];
  return `
    <h2>Operação de hoje</h2>
    <div class="admin-stat-grid">
      ${tiles
        .map(
          (t) => `
        <div class="admin-stat-tile">
          ${t.icon}
          <strong>${t.value}</strong>
          <span>${t.label}</span>
        </div>`
        )
        .join("")}
    </div>`;
}

/** "EM ANDAMENTO" — card Outlet preserva o visual/conceito de sempre; card de NF usa o MESMO deep link já existente (#/conferir/nfe/<id>), nunca reimplementando a abertura. */
function inProgressCards(active: Conference | null, activeReceipt: InProgressReceiptSummary | null): string {
  if (!active && !activeReceipt) return "";
  const outletCard = active
    ? `<div class="active-conference-card">
         <p class="hint-text">Conferência Outlet em andamento</p>
         <strong style="font-size:16px">${escapeHtml(active.name || formatDateTime(active.created_at))}</strong>
         <div class="active-conference-stats">
           <span class="active-conference-stat">${active.total_skus || 0}<span>SKUs</span></span>
           <span class="active-conference-stat">${active.total_units || 0}<span>Unidades</span></span>
         </div>
         <button class="btn-primary btn-block" id="btn-continue">Continuar conferência</button>
       </div>`
    : "";
  const nfeCard = activeReceipt
    ? `<div class="active-conference-card">
         <p class="hint-text">Nota Fiscal em andamento</p>
         <strong style="font-size:16px">NF ${escapeHtml(activeReceipt.receipt.invoice_number || "-")}${
           activeReceipt.receipt.supplier_name ? ` — ${escapeHtml(activeReceipt.receipt.supplier_name)}` : ""
         }</strong>
         <p class="hint-text" style="margin:6px 0 0">${activeReceipt.countedItems} / ${activeReceipt.totalItems} itens contados</p>
         <a class="btn-primary btn-block" style="margin-top:12px" href="#/conferir/nfe/${activeReceipt.receipt.id}">Continuar NF</a>
       </div>`
    : "";
  return `
    <h2>Em andamento</h2>
    <div class="in-progress-grid">${outletCard}${nfeCard}</div>`;
}

/** "ATENÇÃO" — só reaproveita status já existentes de invoice_receipts; nunca aparece se não houver pendência real. */
function attentionCard(attention: ReceiptAttentionCounts | null): string {
  if (!attention || (attention.awaitingFinalization === 0 && attention.withDivergences === 0)) return "";
  const lines: string[] = [];
  if (attention.awaitingFinalization > 0) {
    lines.push(`${Icon.alertTriangle}${attention.awaitingFinalization} nota${attention.awaitingFinalization > 1 ? "s" : ""} aguardando finalização`);
  }
  if (attention.withDivergences > 0) {
    lines.push(`${Icon.alertTriangle}${attention.withDivergences} nota${attention.withDivergences > 1 ? "s" : ""} finalizada${attention.withDivergences > 1 ? "s" : ""} com divergências`);
  }
  return `
    <h2>Atenção</h2>
    <a class="warning-box" href="#/historico/pendencias" style="display:block;text-decoration:none">
      ${lines.map((l) => `<div style="display:flex;align-items:center;gap:6px;margin:4px 0">${l}</div>`).join("")}
      <div style="display:flex;align-items:center;gap:6px;margin:8px 0 0;font-weight:600">Ver pendências ${Icon.chevronRight}</div>
    </a>`;
}

/** "ACESSO RÁPIDO" — reaproveita rotas de hash já existentes; Escanear NUNCA vira <a> aqui (ver unlockScanSound em scan.ts/shell.ts — precisa do gesto síncrono de clique). */
function quickAccessCard(): string {
  return `
    <h2>Acesso rápido</h2>
    <div class="quick-access-grid">
      <a class="quick-access-btn" href="#/conferir">${Icon.camera}Conferir Outlet</a>
      <a class="quick-access-btn" href="#/conferir/nfe">${Icon.receipt}Nota Fiscal</a>
      <button class="quick-access-btn" id="btn-quick-scan" type="button">${Icon.scan}Escanear</button>
      <a class="quick-access-btn" href="#/conferir">${Icon.undo2}Devoluções</a>
    </div>`;
}

type RecentActivity =
  | { kind: "outlet"; created_at: string; data: ConferenceWithOperator }
  | { kind: "nfe"; created_at: string; data: ReceiptWithCounts };

/** "ATIVIDADES RECENTES" — feed unificado Outlet + NF-e, ordenado por data (nunca duplica o Histórico completo, só as últimas 8). */
function recentActivityCard(activity: RecentActivity[]): string {
  if (activity.length === 0) {
    return `
      <h2>Atividades recentes</h2>
      <div class="empty-state">${Icon.history}<p>Nenhuma atividade ainda. Suas conferências e Notas Fiscais recentes vão aparecer aqui.</p></div>`;
  }
  return `
    <h2>Atividades recentes</h2>
    <ul class="recent-list">
      ${activity
        .map((a) => {
          if (a.kind === "outlet") {
            const c = a.data;
            return `
              <li>
                <div>
                  <span class="hint-text" style="margin:0">Outlet</span>
                  <strong>${escapeHtml(c.name || formatDateTime(c.created_at))}</strong>
                  <span class="hint-text" style="margin:0">${formatDateTime(c.created_at)}</span>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                  ${statusBadge(c.status)}
                  <span class="hint-text" style="margin:0">${c.total_skus} SKU · ${c.total_units} un.</span>
                </div>
              </li>`;
          }
          const r = a.data;
          return `
            <li>
              <div>
                <span class="hint-text" style="margin:0">Nota Fiscal</span>
                <strong>NF ${escapeHtml(r.invoice_number || "-")}${r.supplier_name ? ` — ${escapeHtml(r.supplier_name)}` : ""}</strong>
                <span class="hint-text" style="margin:0">${formatDateTime(r.created_at)}</span>
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                ${receiptBadge(r.status)}
                <span class="hint-text" style="margin:0">${r.item_count} item(ns)</span>
              </div>
            </li>`;
        })
        .join("")}
    </ul>`;
}

export async function renderHome(root: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  root.innerHTML = `
    <section class="home-screen">
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card" style="height:120px"></div>
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-card"></div>
    </section>`;

  const { start: periodStart, end: periodEnd } = todayLocalRangeIso();

  let active: Conference | null = null;
  let recentOutlet: ConferenceWithOperator[] = [];

  let activeReceipt: InProgressReceiptSummary | null = null;
  let recentReceipts: ReceiptWithCounts[] = [];
  let attention: ReceiptAttentionCounts | null = null;

  let summary: HomeOperationalSummary | null = null;
  let summaryFailed = false;

  // Ponto 9 do pedido: uma metade (Outlet ou NF-e) falhando não pode derrubar
  // a Home inteira — cada grupo (Outlet, NF-e, resumo agregado do dia) é
  // resolvido de forma independente.
  const [outletResult, nfeResult, summaryResult] = await Promise.allSettled([
    Promise.all([getMyActiveConference(), listRecentConferences(8)]),
    Promise.all([getMostRecentInProgressReceipt(), listReceiptHistory(8), getReceiptAttentionCounts()]),
    getHomeOperationalSummary(periodStart, periodEnd),
  ]);

  if (outletResult.status === "fulfilled") {
    [active, recentOutlet] = outletResult.value;
  }
  if (nfeResult.status === "fulfilled") {
    [activeReceipt, recentReceipts, attention] = nfeResult.value;
  }
  if (summaryResult.status === "fulfilled") {
    summary = summaryResult.value;
  } else {
    summaryFailed = true;
  }

  if (outletResult.status === "rejected" && nfeResult.status === "rejected") {
    const err = outletResult.reason;
    renderErrorWithRetry(root, "Erro ao carregar: " + (err instanceof Error ? err.message : String(err)), () => void renderHome(root));
    return;
  }

  const activity: RecentActivity[] = [
    ...recentOutlet.map((c): RecentActivity => ({ kind: "outlet", created_at: c.created_at, data: c })),
    ...recentReceipts.map((r): RecentActivity => ({ kind: "nfe", created_at: r.created_at, data: r })),
  ]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 8);

  root.innerHTML = `
    <section class="home-screen">
      <div class="operator-card">
        <span class="avatar-initials" aria-hidden="true">${escapeHtml(initials(profile?.full_name))}</span>
        <div>
          <strong>${escapeHtml(profile?.full_name || "Operador")}</strong>
          <span class="role-tag">${escapeHtml(profile?.role || "")}</span>
        </div>
        <div style="margin-left:auto">${connectionPill()}</div>
      </div>

      ${todayOperationCard(summary, summaryFailed)}

      ${inProgressCards(active, activeReceipt)}
      ${!active && !activeReceipt ? `<button class="btn-primary btn-block btn-large" id="btn-new">${Icon.camera}Iniciar nova conferência</button>` : ""}

      ${attentionCard(attention)}

      ${quickAccessCard()}

      ${recentActivityCard(activity)}
    </section>`;

  document.getElementById("btn-continue")?.addEventListener("click", () => {
    window.location.hash = "/conferir";
  });
  document.getElementById("btn-new")?.addEventListener("click", () => {
    window.location.hash = "/conferir";
  });
  // "Escanear" precisa continuar um <button> (nunca <a>) — mesmo motivo do
  // bottom-nav em shell.ts: unlockScanSound() só destrava o áudio do beep se
  // rodar SÍNCRONO dentro do próprio gesto de clique, antes de qualquer coisa
  // assíncrona (a troca de hash dispara render assíncrono da tela de Escanear).
  document.getElementById("btn-quick-scan")?.addEventListener("click", () => {
    unlockScanSound();
    window.location.hash = "/escanear";
  });

  const unsubscribe = subscribeNetwork(() => {
    const pill = document.getElementById("home-connection-pill");
    if (!pill || !document.body.contains(pill)) {
      unsubscribe();
      return;
    }
    const meta = CONNECTION_META[getNetworkStatus()];
    pill.className = `connection-pill ${meta.cls}`;
    pill.innerHTML = `${meta.icon}${meta.label}`;
  });
}
