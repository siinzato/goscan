// Servidor Node mínimo. Duas funções:
//  1) Em dev, roda ao lado do Vite (`npm run dev`) só para responder /api/* —
//     o Vite serve o frontend em outra porta e faz proxy de /api para cá.
//  2) Em produção (`npm run preview` / `npm start`, após `npm run build`),
//     serve os arquivos estáticos de dist/ além de /api/*.
// Não usa banco local nenhum — catálogo/conferências são Supabase, o servidor
// só existe para manter a ANTHROPIC_API_KEY fora do navegador.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}
const PORT = process.env.PORT ? Number(process.env.PORT) : process.env.API_PORT ? Number(process.env.API_PORT) : 8788;
const DIST_DIR = path.join(__dirname, "dist");

const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

const worker = (await import("./src/server/server.ts")).default;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!url.pathname.startsWith("/api/") && existsSync(DIST_DIR)) {
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const abs = path.join(DIST_DIR, filePath);
    if (existsSync(abs) && abs.startsWith(DIST_DIR) && (await readFile(abs).catch(() => null))) {
      const ext = path.extname(abs);
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      res.end(await readFile(abs));
      return;
    }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });

  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(PORT, () => {
  console.log(`API/servidor rodando em http://localhost:${PORT}${existsSync(DIST_DIR) ? " (servindo dist/ também)" : ""}`);
  if (!env.ANTHROPIC_API_KEY) {
    console.log("Aviso: ANTHROPIC_API_KEY não definida — a leitura de prints por IA ficará desabilitada. Use a aba 'Colar texto' ou defina a variável de ambiente ANTHROPIC_API_KEY.");
  }
});
