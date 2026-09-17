// FASE 5 — Indicadores Operacionais. Camada tipada isolada em cima da RPC
// get_operational_indicators (ver migration 0059) — history.ts/
// operationalIndicators.ts nunca fazem parsing de JSON bruto do Supabase.
import { getSupabase } from "./supabaseClient.ts";

export interface OperationalIndicatorsSummary {
  completedOperations: number;
  outletConferences: number;
  nfeReceipts: number;
  nfeWithDivergences: number;
}

export interface OperationalIndicatorsOutlet {
  conferences: number;
  skus: number;
  units: number;
  avgSkus: number;
  avgUnits: number;
}

export interface OperationalIndicatorsNfe {
  receipts: number;
  countedSkus: number;
  physicalUnits: number;
  okItems: number;
  missingItems: number;
  surplusItems: number;
  divergenceReceipts: number;
  /** null quando nenhum item foi efetivamente conferido no período — nunca NaN. */
  conformityRate: number | null;
}

export interface OperationalIndicatorsDailyPoint {
  date: string; // "YYYY-MM-DD", dia local
  outletConferences: number;
  nfeReceipts: number;
  skus: number;
  units: number;
  divergenceReceipts: number;
}

export interface OperationalIndicators {
  summary: OperationalIndicatorsSummary;
  outlet: OperationalIndicatorsOutlet;
  nfe: OperationalIndicatorsNfe;
  daily: OperationalIndicatorsDailyPoint[];
}

/** Garante number (nunca string concatenada por engano) — o Supabase pode devolver numeric como string. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getOperationalIndicators(params: {
  start: string;
  end: string;
  timezone: string;
  responsibleId?: string | null;
}): Promise<OperationalIndicators> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("get_operational_indicators", {
    p_start: params.start,
    p_end: params.end,
    p_timezone: params.timezone,
    p_responsible_id: params.responsibleId || null,
  });
  if (error) throw error;

  const raw = (data || {}) as Record<string, unknown>;
  const summaryRaw = (raw.summary || {}) as Record<string, unknown>;
  const outletRaw = (raw.outlet || {}) as Record<string, unknown>;
  const nfeRaw = (raw.nfe || {}) as Record<string, unknown>;
  const dailyRaw = Array.isArray(raw.daily) ? (raw.daily as Record<string, unknown>[]) : [];

  return {
    summary: {
      completedOperations: num(summaryRaw.completedOperations),
      outletConferences: num(summaryRaw.outletConferences),
      nfeReceipts: num(summaryRaw.nfeReceipts),
      nfeWithDivergences: num(summaryRaw.nfeWithDivergences),
    },
    outlet: {
      conferences: num(outletRaw.conferences),
      skus: num(outletRaw.skus),
      units: num(outletRaw.units),
      avgSkus: num(outletRaw.avgSkus),
      avgUnits: num(outletRaw.avgUnits),
    },
    nfe: {
      receipts: num(nfeRaw.receipts),
      countedSkus: num(nfeRaw.countedSkus),
      physicalUnits: num(nfeRaw.physicalUnits),
      okItems: num(nfeRaw.okItems),
      missingItems: num(nfeRaw.missingItems),
      surplusItems: num(nfeRaw.surplusItems),
      divergenceReceipts: num(nfeRaw.divergenceReceipts),
      conformityRate: numOrNull(nfeRaw.conformityRate),
    },
    daily: dailyRaw.map((d) => ({
      date: String(d.date || ""),
      outletConferences: num(d.outletConferences),
      nfeReceipts: num(d.nfeReceipts),
      skus: num(d.skus),
      units: num(d.units),
      divergenceReceipts: num(d.divergenceReceipts),
    })),
  };
}
