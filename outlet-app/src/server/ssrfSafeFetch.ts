// Download de URL externa com proteção contra SSRF. Usado só pelo backend
// (nunca pelo navegador) para buscar as imagens da planilha do Catálogo
// Visual. Regras: só http/https, bloqueia localhost/IPs privados/internos
// (inclusive o endpoint de metadata de nuvem 169.254.169.254, coberto pelo
// bloqueio de link-local), revalida CADA redirecionamento, limita
// redirecionamentos/tamanho/tempo, e pina a conexão no IP validado (evita
// DNS rebinding entre a validação e a conexão real).
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns, { type LookupAddress } from "node:dns";

export class SsrfBlockedError extends Error {}
export class DownloadTooLargeError extends Error {}
export class DownloadFailedError extends Error {}

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;
const USER_AGENT = "GoScan-CatalogImageBot/1.0 (+catalogo-visual)";

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local (inclui metadata de nuvem)
    if (a === 0) return true;
    if (a >= 224) return true; // multicast/reservado
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.split(":").pop();
      if (mapped && net.isIPv4(mapped)) return isBlockedIp(mapped);
    }
    return false;
  }
  return true; // formato desconhecido: bloqueia por segurança
}

/**
 * lookup() customizado passado ao http(s).request: resolve o hostname,
 * rejeita se todo endereço encontrado for privado/interno, e devolve o
 * endereço já validado para a conexão real (mesmo endereço que validamos,
 * sem uma segunda resolução — isso é o que evita DNS rebinding).
 */
function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  // Node chama essa função tanto pedindo um endereço só (callback(err, address,
  // family)) quanto pedindo todos (options.all=true -> callback(err, [{address,
  // family}, ...])) — respeitar isso é obrigatório, senão o Node interpreta mal
  // os argumentos e quebra com erros como "Invalid IP address: undefined".
  const wantsAll = typeof options === "object" && options !== null && options.all === true;

  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, wantsAll ? [] : "");
    const list = addresses as unknown as LookupAddress[];
    const valid = list.find((a) => !isBlockedIp(a.address));
    if (!valid) {
      const blockedErr = new SsrfBlockedError(`Endereço bloqueado para "${hostname}" (privado/interno).`);
      return callback(blockedErr, wantsAll ? [] : "");
    }
    if (wantsAll) {
      callback(null, [valid]);
    } else {
      callback(null, valid.address, valid.family);
    }
  });
}

function assertAllowedUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SsrfBlockedError(`URL inválida: ${urlString}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`Protocolo não permitido: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".localhost") || host === "[::1]") {
    throw new SsrfBlockedError(`Host bloqueado: ${host}`);
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new SsrfBlockedError(`Endereço IP bloqueado: ${host}`);
  }
  return parsed;
}

export interface DownloadResult {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

export async function downloadUrlSafely(urlString: string, redirectsLeft = MAX_REDIRECTS): Promise<DownloadResult> {
  const parsed = assertAllowedUrl(urlString);
  const client = parsed.protocol === "https:" ? https : http;

  return new Promise<DownloadResult>((resolve, reject) => {
    const req = client.get(
      parsed,
      {
        lookup: safeLookup as unknown as typeof dns.lookup,
        timeout: TIMEOUT_MS,
        headers: { "user-agent": USER_AGENT, accept: "image/*" },
      },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new DownloadFailedError("Excesso de redirecionamentos."));
            return;
          }
          const location = res.headers.location;
          if (!location) {
            reject(new DownloadFailedError("Redirecionamento sem cabeçalho Location."));
            return;
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(location, parsed).toString();
          } catch {
            reject(new DownloadFailedError("Location de redirecionamento inválida."));
            return;
          }
          // Revalida o destino do zero (protocolo/host/IP) — não segue cegamente.
          downloadUrlSafely(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new DownloadFailedError(`HTTP ${status} ao baixar a imagem.`));
          return;
        }

        const contentLength = Number(res.headers["content-length"] || 0);
        if (contentLength && contentLength > MAX_BYTES) {
          res.destroy();
          reject(new DownloadTooLargeError("Imagem excede o tamanho máximo permitido (Content-Length)."));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;

        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            settled = true;
            res.destroy();
            reject(new DownloadTooLargeError("Imagem excede o tamanho máximo permitido (durante o download)."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] || "", finalUrl: parsed.toString() });
        });
        res.on("error", (err) => {
          if (settled) return;
          reject(new DownloadFailedError(err.message));
        });
      }
    );

    req.on("timeout", () => req.destroy(new DownloadFailedError("Tempo esgotado ao baixar a imagem.")));
    req.on("error", (err) => reject(err instanceof Error ? err : new DownloadFailedError(String(err))));
  });
}
