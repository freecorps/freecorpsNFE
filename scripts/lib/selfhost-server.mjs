import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { acceptsHtml, isDocsPath, isPagePath } from "../../apps/console/page-request.mjs";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8",
};

// Local installation only. TLS and a trusted, signed edge proxy remain separate hosted concerns.
export function serve(instance) {
  const origin = new URL(instance.frontend);
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    try {
      if (request.headers.host !== origin.host) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith("/api/auth/")) {
        if (!["GET", "POST"].includes(request.method)) {
          response.writeHead(405).end();
          return;
        }
        if (
          (request.headers.origin && request.headers.origin !== origin.origin) ||
          (request.method === "POST" && request.headers.origin !== origin.origin) ||
          request.headers["sec-fetch-site"] === "cross-site"
        ) {
          response.writeHead(403).end();
          return;
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 32768) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const headers = new Headers({ Origin: origin.origin, "Content-Type": "application/json" });
        for (const name of ["better-auth-cookie", "authorization", "user-agent"]) {
          if (typeof request.headers[name] === "string") headers.set(name, request.headers[name]);
        }
        const upstream = await fetch(instance.site + url.pathname + url.search, {
          method: request.method,
          headers,
          ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        if (upstream.status >= 300 && upstream.status < 400) {
          response.writeHead(502).end();
          return;
        }
        for (const name of [
          "content-type",
          "set-better-auth-cookie",
          "retry-after",
          "x-retry-after",
        ]) {
          if (upstream.headers.has(name)) response.setHeader(name, upstream.headers.get(name));
        }
        response.writeHead(upstream.status).end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const path = resolve(instance.dist, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(resolve(instance.dist) + sep) && path !== resolve(instance.dist)) {
        response.writeHead(403).end();
        return;
      }
      let content,
        extension = extname(path);
      if (url.pathname === "/docs") {
        response.writeHead(302, { Location: "/docs/" }).end();
        return;
      }
      const guideWithoutExtension =
        url.pathname.startsWith("/docs/") && !extension && !url.pathname.endsWith("/");
      if (guideWithoutExtension) extension = ".html";
      try {
        // Static guides use directory indexes alongside the authenticated SPA.
        content = await readFile(
          url.pathname.endsWith("/")
            ? join(path, "index.html")
            : guideWithoutExtension
              ? `${path}.html`
              : path,
        );
        if (url.pathname.endsWith("/")) extension = ".html";
      } catch {
        // A missing docs page gets the docs' not-found page, by the Worker's rule
        // (page-request.mjs); without that page, the short 404 below.
        if (
          isDocsPath(url.pathname) &&
          isPagePath(url.pathname) &&
          acceptsHtml(request.headers.accept)
        ) {
          const notFound = await readFile(join(instance.dist, "docs/404.html")).catch(() => null);
          if (notFound) {
            response.setHeader("Content-Type", mime[".html"]);
            response.writeHead(404).end(request.method === "HEAD" ? undefined : notFound);
            return;
          }
          response.writeHead(404).end();
          return;
        }
        if (extension) {
          response.writeHead(404).end();
          return;
        }
        content = await readFile(join(instance.dist, "index.html"));
        extension = ".html";
      }
      response.setHeader("Content-Type", mime[extension] ?? "application/octet-stream");
      response.writeHead(200).end(request.method === "HEAD" ? undefined : content);
    } catch {
      response.writeHead(502).end("Serviço indisponível");
    }
  });
  server.listen(Number(origin.port), "127.0.0.1", () => console.log(`Console: ${origin.origin}`));
  return server;
}
