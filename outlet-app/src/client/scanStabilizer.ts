// Modo Scan — Parte 4: estabilização de leituras da câmera. Não abre uma
// sugestão por causa de um único frame instável — exige que a mesma
// família/produto apareça em N ciclos consecutivos antes de virar estado
// "product_found"/"multiple_capacities" na UI.
export interface StabilizableResult {
  status: "matched" | "ambiguous" | "no_result";
  requires_capacity_selection: boolean;
  visual_family: string | null;
  variant: string | null;
  /** Categoria (garrafa/copo/...) votada pelo backend neste ciclo — ver src/server/scanRecognize.ts:detectCategory. */
  detected_category?: string | null;
  candidates: { product_id: string }[];
}

/**
 * Chave que representa "o que foi reconhecido" para fins de comparação entre
 * ciclos: quando a família exige escolha de capacidade, a chave é a
 * família+variante (o produto específico ainda não foi decidido); caso
 * contrário, é o product_id do melhor candidato.
 *
 * BUG REAL corrigido: em teste físico real, a categoria detectada pelo
 * backend oscilava de ciclo a ciclo pro MESMO objeto parado na câmera
 * (ruído de frame — ângulo/luz/foco variando levemente) — "garrafa" em
 * alguns ciclos, "copo" em outros. Como a chave antiga só olhava
 * família+variante, dois ciclos consecutivos que por acaso caíssem na
 * categoria errada já bastavam pra "estabilizar" e mostrar a sugestão
 * errada. Incluir detected_category na chave garante que uma mudança de
 * categoria entre ciclos SEMPRE reinicia a contagem de estabilidade, mesmo
 * quando família/variante coincidem.
 */
export function stabilityKeyFor(result: StabilizableResult): string | null {
  if (result.status === "no_result") return null;
  const categoryPart = `cat:${result.detected_category ?? ""}`;
  if (result.requires_capacity_selection) return `${categoryPart}:family:${result.visual_family ?? ""}:${result.variant ?? ""}`;
  const productId = result.candidates[0]?.product_id;
  return productId ? `${categoryPart}:${productId}` : null;
}

export class Stabilizer {
  private history: (string | null)[] = [];
  private requiredMatches: number;
  private windowSize: number;

  constructor(requiredMatches = 2, windowSize = 6) {
    this.requiredMatches = requiredMatches;
    this.windowSize = windowSize;
  }

  /**
   * Registra uma leitura e diz se ela já estabilizou.
   *
   * BUG REAL corrigido (30-40s presos em "Estabilizando..."): a versão
   * anterior exigia as últimas `requiredConsecutive` leituras IDÊNTICAS, sem
   * nenhuma tolerância — ruído real de câmera (autofocus, tremor leve da
   * mão, exposição ajustando, e a oscilação de categoria já documentada em
   * stabilityKeyFor) fazia UMA leitura diferente reiniciar a contagem
   * inteira do zero. Cada reinício custava outro ciclo completo de
   * reconhecimento — em produção isso multiplicava poucos "ruídos" isolados
   * em dezenas de segundos, mesmo com o produto parado e corretamente
   * identificado na maior parte das leituras.
   *
   * Agora conta quantas vezes a MESMA chave aparece dentro de uma janela
   * recente pequena (`requiredMatches + 1` leituras) — um único ciclo
   * discordante não zera o progresso, mas ruído PERSISTENTE (sem maioria
   * clara pra nenhuma chave) continua não estabilizando. O limiar de
   * concordância (`requiredMatches`) não muda — só a tolerância a UMA
   * interrupção isolada dentro da janela.
   */
  push(key: string | null): { stableKey: string | null; isStable: boolean } {
    this.history.push(key);
    if (this.history.length > this.windowSize) this.history.shift();
    if (!key) return { stableKey: null, isStable: false };

    const recentWindow = this.history.slice(-(this.requiredMatches + 1));
    const matches = recentWindow.filter((k) => k === key).length;
    const isStable = matches >= this.requiredMatches;
    return { stableKey: isStable ? key : null, isStable };
  }

  reset(): void {
    this.history = [];
  }

  /** Só leitura — usado pelo painel de diagnóstico (nunca inventa dados, mostra a janela real). */
  getHistory(): (string | null)[] {
    return [...this.history];
  }
}
