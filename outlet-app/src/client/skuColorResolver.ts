// EXPANSÃO GOSCAN — Produtos Normais: mesma lógica de resolução de cor pelo
// código de sufixo do SKU já usada no Modo Scan Outlet (ver
// src/server/scanRecognize.ts — extractSkuColorCode/getColorCodeMap/
// resolveSkuColor). Espelhada aqui (não importada direto) porque server e
// client não compartilham módulos nesta base — mas é a MESMA regra real:
// segmento após o ÚLTIMO hífen do SKU, mapa construído a partir de cores já
// cadastradas de verdade, nunca hardcoded/inventado. Funções puras — quem
// chama decide de onde vêm as linhas (Node aqui não tem cliente Supabase
// próprio do navegador).
export function extractSkuColorCode(skuCode: string): string | null {
  const m = skuCode.trim().match(/-(\d+)$/);
  return m ? m[1] : null;
}

export interface ColorCodeMapRow {
  sku_code: string;
  color: string | null;
  capacity_ml: number | null;
}

/**
 * Constrói o mapa código→cor a partir de QUALQUER variante já com cor
 * registrada (Outlet hoje é a fonte real) — nunca hardcoded. Exclui casos
 * onde o sufixo na verdade é a capacidade do produto vazando (ex.: SKUs de
 * garrafa terminando em "-650"), igual à proteção já existente no Modo Scan.
 */
export function buildColorCodeMap(rows: ColorCodeMapRow[]): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const code = extractSkuColorCode(row.sku_code);
    const color = (row.color || "").trim();
    if (!code || !color) continue;
    if (row.capacity_ml != null && String(row.capacity_ml) === code) continue;
    if (!tally.has(code)) tally.set(code, new Map());
    const counts = tally.get(code)!;
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }

  const map = new Map<string, string>();
  for (const [code, counts] of tally) {
    const [bestColor] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    map.set(code, bestColor);
  }
  return map;
}

/** Retorna a cor mapeada pro sufixo do SKU, ou null quando o sufixo não existe ou não está no mapa — nunca inventa. */
export function resolveColorFromSuffix(skuCode: string, codeMap: Map<string, string>): string | null {
  const code = extractSkuColorCode(skuCode);
  return code ? (codeMap.get(code) ?? null) : null;
}
