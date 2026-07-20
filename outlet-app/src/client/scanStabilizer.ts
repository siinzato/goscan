// Modo Scan — Parte 4: estabilização de leituras da câmera. Não abre uma
// sugestão por causa de um único frame instável — exige que a mesma
// família/produto apareça em N ciclos consecutivos antes de virar estado
// "product_found"/"multiple_capacities" na UI.
export interface StabilizableResult {
  status: "matched" | "ambiguous" | "no_result";
  requires_capacity_selection: boolean;
  visual_family: string | null;
  variant: string | null;
  candidates: { product_id: string }[];
}

/**
 * Chave que representa "o que foi reconhecido" para fins de comparação entre
 * ciclos: quando a família exige escolha de capacidade, a chave é a
 * família+variante (o produto específico ainda não foi decidido); caso
 * contrário, é o product_id do melhor candidato.
 */
export function stabilityKeyFor(result: StabilizableResult): string | null {
  if (result.status === "no_result") return null;
  if (result.requires_capacity_selection) return `family:${result.visual_family ?? ""}:${result.variant ?? ""}`;
  return result.candidates[0]?.product_id ?? null;
}

export class Stabilizer {
  private history: (string | null)[] = [];
  private requiredConsecutive: number;
  private windowSize: number;

  constructor(requiredConsecutive = 2, windowSize = 6) {
    this.requiredConsecutive = requiredConsecutive;
    this.windowSize = windowSize;
  }

  /** Registra uma leitura e diz se ela já estabilizou (mesma chave nas últimas `requiredConsecutive` leituras). */
  push(key: string | null): { stableKey: string | null; isStable: boolean } {
    this.history.push(key);
    if (this.history.length > this.windowSize) this.history.shift();
    if (!key) return { stableKey: null, isStable: false };

    const tail = this.history.slice(-this.requiredConsecutive);
    const isStable = tail.length === this.requiredConsecutive && tail.every((k) => k === key);
    return { stableKey: isStable ? key : null, isStable };
  }

  reset(): void {
    this.history = [];
  }
}
