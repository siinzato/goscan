export function normalize(s: string | null | undefined): string {
  return (s || "")
    .toString()
    // "1.180" -> "1180" antes da limpeza geral, senão o "." vira espaço e a
    // separação de milhar sobra como "1 180" (não bate com "1180ml" digitado sem separador).
    .replace(/(\d)[.,](\d{3})(?!\d)/g, "$1$2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // "880 ml" e "880ml" devem comparar iguais — mesmo ajuste para outras unidades comuns.
    .replace(/(\d+)\s+(ml|l|kg|g|cm|mm)\b/g, "$1$2");
}

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

export class ValidationError extends Error {}

/**
 * Extrai uma mensagem legível de QUALQUER erro capturado — não só
 * instâncias de Error. Erros do Supabase/PostgREST (PostgrestError) são
 * objetos simples ({message, code, details, hint}), não instâncias de
 * Error: `err instanceof Error` dá false pra eles, e o fallback antigo
 * `String(err)` virava literalmente o texto "[object Object]", escondendo
 * a causa real (BUG REAL corrigido: mensagem de erro inútil ao vincular
 * produto na Conferência por NF).
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) {
      const code = typeof obj.code === "string" ? ` (${obj.code})` : "";
      return obj.message + code;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Iniciais para o avatar do operador (ex.: "Ana Souza" -> "AS"). */
export function initials(name: string | null | undefined): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Gera um id local temporário para itens ainda não persistidos no servidor. */
export function localId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — Central de Perfil: validações reais (Minha Conta/Segurança).
// ---------------------------------------------------------------------------

/** RFC-simplificado, suficiente pra pegar erro de digitação sem rejeitar e-mails válidos incomuns. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Telefone BR: aceita com/sem DDI (+55), com/sem DDD, fixo (10 dígitos) ou celular (11) — só valida a contagem de dígitos, não formata. */
export function isValidBrPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "").replace(/^55/, "");
  return digits.length === 10 || digits.length === 11;
}

export interface PasswordRequirement {
  key: string;
  label: string;
  met: boolean;
}

/** Mesmo mínimo pedido: 8+ caracteres, maiúscula, minúscula, número. */
export function passwordRequirements(password: string): PasswordRequirement[] {
  return [
    { key: "length", label: "Pelo menos 8 caracteres", met: password.length >= 8 },
    { key: "upper", label: "Uma letra maiúscula", met: /[A-Z]/.test(password) },
    { key: "lower", label: "Uma letra minúscula", met: /[a-z]/.test(password) },
    { key: "number", label: "Um número", met: /[0-9]/.test(password) },
  ];
}

export function passwordMeetsRequirements(password: string): boolean {
  return passwordRequirements(password).every((r) => r.met);
}

// ---------------------------------------------------------------------------
// CORREÇÃO — Reconhecimento automático e busca por EAN na Conferência por NF.
// Função ÚNICA de normalização de código de barras — usada em TODO o app
// (parser da NF-e, matching, busca do catálogo, importador, CRUD manual,
// associações memorizadas). Nunca duplicar esta regra em outro lugar.
//
// EAN/GTIN nunca é convertido para número em nenhuma etapa (perderia zero à
// esquerda) — sempre string, do XML até o banco.
// ---------------------------------------------------------------------------

/** Remove tudo que não for dígito (espaços, pontos, traços, tabs, caracteres invisíveis). Nunca usado pra regravar o valor original — só para comparação/busca. */
export function normalizeEan(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[^\d]/g, "");
}

/** Um EAN/GTIN real tem 8 (EAN-8), 12 (UPC-A), 13 (EAN-13) ou 14 (ITF-14/GTIN-14) dígitos — qualquer outro comprimento (incluindo "0", "SEMGTIN" sem espaço, "N/A") não é um código de barras válido. */
export function isValidEanFormat(normalized: string): boolean {
  return normalized.length === 8 || normalized.length === 12 || normalized.length === 13 || normalized.length === 14;
}

// ---------------------------------------------------------------------------
// FASE 4 — navegação desktop/tablet: rota canônica da NF-e dentro do módulo
// "Conferir" (hash routing existente, sem router novo). shell.ts já só olha
// o PRIMEIRO segmento do hash pra escolher a aba (currentRoute()) — esta
// função lê os segmentos SEGUINTES (`conferir/nfe` ou `conferir/nfe/<id>`)
// pra decidir o sub-modo e o deep link, do mesmo jeito que profile.ts já faz
// pras próprias sub-rotas. Função pura (recebe a string, não lê
// window.location) — só pra ser testável sem DOM.
// ---------------------------------------------------------------------------
export interface ConferirHashInfo {
  mode: "imagens" | "nfe";
  nfeReceiptId: string | null;
}

/** Nunca lança exceção — hash ausente/malformado sempre cai no modo padrão ("imagens"), igual ao comportamento atual sem nenhum segmento extra. */
export function parseConferirHash(hash: string): ConferirHashInfo {
  const raw = (hash || "").replace(/^#\/?/, "");
  const segments = raw.split("/").filter(Boolean);
  if (segments[1] === "nfe") {
    const id = segments[2]?.trim();
    return { mode: "nfe", nfeReceiptId: id ? id : null };
  }
  return { mode: "imagens", nfeReceiptId: null };
}

/**
 * FASE 3 — Central de Pendências: rota `#/historico/pendencias` dentro do
 * módulo "Histórico" (mesmo princípio de parseConferirHash acima — shell.ts
 * só olha o primeiro segmento pra escolher a aba do bottom nav; history.ts
 * lê o segundo pra decidir a sub-aba). Só sinaliza "pendencias" quando o hash
 * diz isso explicitamente; qualquer outra coisa (incluindo `#/historico` puro)
 * devolve null — history.ts então preserva a aba que já estava selecionada
 * na sessão, em vez de forçar de volta pra "outlet".
 */
export function parseHistoricoHash(hash: string): "pendencias" | "indicadores" | null {
  const raw = (hash || "").replace(/^#\/?/, "");
  const segments = raw.split("/").filter(Boolean);
  if (segments[0] !== "historico") return null;
  if (segments[1] === "pendencias") return "pendencias";
  if (segments[1] === "indicadores") return "indicadores";
  return null;
}

/**
 * Intervalo [início, fim) do dia local do operador, em ISO — o servidor nunca
 * decide sozinho o que é "hoje" (evita depender do fuso da instância do
 * Postgres); usado pela RPC get_home_operational_summary (ver migration
 * 0057), que exige explicitamente os dois limites do período.
 */
export function todayLocalRangeIso(): { start: string; end: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * INDICADORES OPERACIONAIS — FASE 5. Intervalo [início, fim) cobrindo "hoje +
 * (days - 1) dias anteriores" no fuso local do operador, mesmo princípio de
 * todayLocalRangeIso (nunca decide o dia a partir do fuso do servidor). Usado
 * pelos atalhos "7 dias"/"30 dias" (days=7/30); "Hoje" reaproveita
 * todayLocalRangeIso diretamente.
 */
export function lastNDaysLocalRangeIso(days: number): { start: string; end: string } {
  const { end } = todayLocalRangeIso();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start: start.toISOString(), end };
}

/**
 * INDICADORES OPERACIONAIS — FASE 5. Fuso IANA do dispositivo, usado pela RPC
 * get_operational_indicators (ver migration 0059) para bucketizar a série
 * diária no dia local correto perto da meia-noite. Nunca hardcoded
 * ("America/Sao_Paulo" seria incorreto para operações fora do Brasil) — só
 * cai no fallback documentado 'UTC' se o ambiente não expuser Intl
 * corretamente (nunca lança erro pro chamador).
 */
export function getLocalTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * HISTÓRICO — FASE 2 (filtro por período). Converte os valores de
 * `<input type="date">` (sempre "YYYY-MM-DD", sem hora/fuso) em [início, fim)
 * local do operador, em ISO — mesmo princípio de todayLocalRangeIso.
 * `new Date("YYYY-MM-DD")` cairia em meia-noite UTC (erra o dia em qualquer
 * fuso negativo, como o do Brasil); por isso os componentes são montados
 * manualmente como data LOCAL. `dateTo` vira o INÍCIO do dia seguinte
 * (exclusivo) — "até o final daquele dia" inclui o dia inteiro. Extremo
 * ausente/vazio fica `null` (filtro aberto daquele lado).
 */
export function parseLocalDateRangeIso(dateFrom: string | null | undefined, dateTo: string | null | undefined): { start: string | null; end: string | null } {
  function localMidnight(value: string): Date {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
  }
  const start = dateFrom ? localMidnight(dateFrom).toISOString() : null;
  let end: string | null = null;
  if (dateTo) {
    const endDate = localMidnight(dateTo);
    endDate.setDate(endDate.getDate() + 1);
    end = endDate.toISOString();
  }
  return { start, end };
}

/**
 * HISTÓRICO — FASE 2. Escapa um valor pra uso dentro do combinador `or()` do
 * PostgREST (usado pra montar "pesquisar por nome OU protocolo OU operador"
 * numa única consulta) — sem isso, um termo de busca com vírgula/parênteses
 * quebraria o parser de filtros do PostgREST (que usa esses caracteres como
 * delimitadores da própria sintaxe). Aspas duplas sempre funcionam (mesmo sem
 * caractere especial no valor), então aplicadas incondicionalmente.
 */
export function escapeOrFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** HISTÓRICO — FASE 2. Formato comum dos filtros de Outlet e NF-e (cada aba usa seu próprio status, mas a mesma forma) — usado só pra decidir se "Limpar filtros" deve ficar habilitado e se um resultado vazio é "sem dados" ou "sem correspondência". */
export interface HistoryFilterState {
  search: string;
  status: string;
  operatorId: string;
  dateFrom: string;
  dateTo: string;
}

export function hasActiveHistoryFilters(f: HistoryFilterState): boolean {
  return f.search.trim() !== "" || f.status !== "all" || f.operatorId !== "all" || f.dateFrom !== "" || f.dateTo !== "";
}

/**
 * HISTÓRICO — FASE 2 (pesquisa por operador dentro da caixa de texto livre).
 * Resolve o termo digitado contra os NOMES de uma lista pequena já carregada
 * (accent/case-insensitive via normalize(), mesma normalização usada em todo
 * o app pra busca de produto) — nunca dispara uma consulta nova ao banco só
 * pra isso.
 */
export function matchOperatorIdsByName<T extends { id: string; full_name: string | null }>(term: string, operators: T[]): string[] {
  const q = normalize(term);
  if (!q) return [];
  return operators.filter((o) => o.full_name && normalize(o.full_name).includes(q)).map((o) => o.id);
}

/**
 * FASE 4 — Resumo Final Padronizado. Duração de uma operação (Outlet ou
 * NF-e) a partir dos timestamps OFICIAIS do servidor — nunca do relógio
 * local nem de um cronômetro em memória. Sem segundos na UI normal (18 min,
 * 1h 12min, 2h 04min). Qualquer timestamp ausente, inválido, ou
 * finished_at < started_at nunca vira um número inventado — sempre "Não
 * registrada".
 */
export function formatOperationDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined): string {
  if (!startedAt || !finishedAt) return "Não registrada";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Não registrada";

  const totalMinutes = Math.round((end - start) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours}h ${String(minutes).padStart(2, "0")}min`;
}

/** FASE 4 — diferença de unidades com sinal explícito ("+10"/"-3"/"0") — nunca confundir com quantidade de SKUs divergentes (são contagens diferentes). */
export function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

let retryHandlerSeq = 0;

/**
 * Estado de erro padrão pra carregamento de página inteira: mensagem +
 * "Tentar novamente" — nunca deixa o usuário preso numa mensagem estática
 * sem nenhuma ação de recuperação. `onRetry` é registrado automaticamente
 * (não precisa buscar o botão manualmente no elemento chamador).
 */
export function renderErrorWithRetry(container: Element, message: string, onRetry: () => void): void {
  const id = `retry-btn-${++retryHandlerSeq}`;
  container.innerHTML = `
    <div class="error-box-retry">
      <p class="error-box">${escapeHtml(message)}</p>
      <button type="button" class="btn-secondary" id="${id}">Tentar novamente</button>
    </div>`;
  document.getElementById(id)?.addEventListener("click", onRetry);
}
