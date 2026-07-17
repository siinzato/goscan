import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const db = new DatabaseSync(path.join(__dirname, "data.db"));

const DB = {
  async query(sql, params = []) {
    const rows = db.prepare(sql).all(...params);
    return { rows, columns: rows.length ? Object.keys(rows[0]) : [], rowsRead: rows.length };
  },
  async exec(sql, params = []) {
    const info = db.prepare(sql).run(...params);
    return { rowsWritten: info.changes };
  },
};

const env = { DB, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

const worker = (await import("./src/server.ts")).default;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!url.pathname.startsWith("/api/")) {
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const abs = path.join(__dirname, filePath);
    if (existsSync(abs) && abs.startsWith(__dirname)) {
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
  console.log(`Outlet app rodando em http://localhost:${PORT}`);
  if (!env.ANTHROPIC_API_KEY) {
    console.log("Aviso: ANTHROPIC_API_KEY não definida — a leitura de prints por IA ficará desabilitada. Use a aba 'Colar texto' ou defina a variável de ambiente ANTHROPIC_API_KEY.");
  }
});
