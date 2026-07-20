// Limitador de frequência simples, em memória, por usuário — suficiente
// para o backend local de um único processo (run-local.mjs). Numa
// implantação com múltiplas instâncias, isso precisaria virar um contador
// compartilhado (ex.: Redis) — documentado como limitação real, não
// escondido.
import { SCAN_CONFIG } from "./scanConfig.ts";

const hits = new Map<string, number[]>();

export function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const windowStart = now - SCAN_CONFIG.rateLimit.windowMs;
  const timestamps = (hits.get(userId) || []).filter((t) => t > windowStart);

  if (timestamps.length >= SCAN_CONFIG.rateLimit.maxRequestsPerWindow) {
    hits.set(userId, timestamps);
    return true;
  }

  timestamps.push(now);
  hits.set(userId, timestamps);
  return false;
}
