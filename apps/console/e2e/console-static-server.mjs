// Servidor local do build de produção do console, para o benchmark de navegação.
//
// Faz o papel do Worker (apps/console/worker.ts): serve `dist/` com fallback de SPA e encaminha
// `/api/auth/*` ao site do Convex local, copiando só os cabeçalhos que o auth-proxy copia. O
// backend local aceita apenas a origem do seu SITE_URL (o Vite do worktree), então o encaminhamento
// troca `Origin` por ela, como o Worker faz com a origem publicada. Sem assinatura: o backend
// local não exige o proxy assinado. Os assets saem com gzip e `Cache-Control: no-store`, como o
// `_headers` do build pede; a CSP de produção fica de fora porque bloquearia o Convex local.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
};
const compressible = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".xml", ".txt"]);

/**
 * Sobe o servidor em 127.0.0.1. `dist` é a pasta do build; `convexSite` o site HTTP do Convex
 * local; `authOrigin` o SITE_URL do backend. `onAuth(path)` é chamado a cada pedido de auth.
 */
export async function startConsoleServer({ dist, convexSite, authOrigin, port = 0, onAuth }) {
  const cache = new Map();
  function file(path) {
    const hit = cache.get(path);
    if (hit) return hit;
    const body = readFileSync(path);
    const ext = extname(path);
    const entry = {
      body,
      gzip: compressible.has(ext) ? gzipSync(body, { level: 6 }) : null,
      type: types[ext] ?? "application/octet-stream",
    };
    cache.set(path, entry);
    return entry;
  }
  function resolveAsset(pathname) {
    const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    for (const candidate of [clean, `${clean}.html`, join(clean, "index.html")]) {
      const full = join(dist, candidate);
      if (full.startsWith(dist) && existsSync(full) && statSync(full).isFile()) return full;
    }
    return null;
  }
  async function auth(request, response, url) {
    onAuth?.(url.pathname);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = { Origin: authOrigin, "Content-Type": "application/json" };
    for (const name of ["better-auth-cookie", "authorization", "user-agent"])
      // Vazio também conta: o plugin cross-domain decide pela presença do cabeçalho.
      if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    try {
      const upstream = await fetch(convexSite + url.pathname + url.search, {
        method: request.method,
        headers,
        body: request.method === "POST" ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      });
      const out = { "Cache-Control": "no-store" };
      for (const name of ["content-type", "set-better-auth-cookie", "retry-after", "x-retry-after"])
        if (upstream.headers.has(name)) out[name] = upstream.headers.get(name);
      response.writeHead(upstream.status, out);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: "AUTH_UPSTREAM_UNAVAILABLE" }));
    }
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/auth/")) {
      if (!["GET", "POST"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      void auth(request, response, url);
      return;
    }
    // Fallback de SPA: o que não é arquivo recebe o index.html.
    const path = resolveAsset(url.pathname) ?? join(dist, "index.html");
    const entry = file(path);
    const gzip = entry.gzip && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
    response.writeHead(200, {
      "Content-Type": entry.type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(gzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
    });
    response.end(gzip ? entry.gzip : entry.body);
  });
  server.keepAliveTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
