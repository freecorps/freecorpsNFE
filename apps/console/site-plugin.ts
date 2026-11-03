import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import { acceptsHtml, isDocsPath, isPagePath } from "./page-request.mjs";
import { landing } from "./src/site/render.tsx";

export function publication(origin: string | undefined) {
  if (!origin) return null;
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
    throw new Error("PUBLIC_SITE_ORIGIN exige uma origem HTTPS exata, sem caminho ou credenciais");
  return url.origin;
}

function pageMetadata(html: string, origin: string | null, path: string) {
  if (!origin) return html;
  return html
    .replace('content="noindex, nofollow, noarchive"', 'content="index, follow"')
    .replace("</head>", `<link rel="canonical" href="${origin}${path}"></head>`);
}

const pagePath = (file: string) =>
  file === "docs/index.html" ? "/docs/" : `/${file.replace(/\.html$/, "")}`;

// The landing's stylesheet: the shared rules, then one file per section
// (src/site/landing/sections/*.css) and per figure (src/site/landing/figures/*.css),
// served as a single static /landing.css.
export function landingStyles() {
  const dir = new URL("./src/site/landing/", import.meta.url);
  const folder = (name: string) => {
    const url = new URL(`./${name}/`, dir);
    return readdirSync(url)
      .filter((file) => file.endsWith(".css"))
      .sort()
      .map((file) => `/* ${name}/${file} */\n${readFileSync(new URL(file, url), "utf8")}`);
  };
  return [
    readFileSync(new URL("landing.css", dir), "utf8"),
    ...folder("sections"),
    ...folder("figures"),
  ].join("\n");
}

// The guides are a separate app (apps/docs, Fumadocs on React Router) built
// to static files shaped like the site root: docs/** plus docs.data. The
// `ci:docs` task of the root vite.config.ts builds them before the console;
// this plugin only composes that artifact.
export const docsOutput = fileURLToPath(new URL("../docs/dist/", import.meta.url));

// Only the files the docs build listed in files.json: a cached build restores
// its files without removing leftovers of another one.
export function docsFiles(dir = docsOutput) {
  const manifest = join(dir, "files.json");
  if (!existsSync(manifest))
    throw new Error(`Documentação não compilada em ${dir}; rode \`vp run docs:build\``);
  const listed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  // Relative paths below `dir` only: no absolute path, drive, backslash or `..`.
  const inside = (file: unknown) =>
    typeof file === "string" &&
    /^[^/\\:]+(\/[^/\\:]+)*$/.test(file) &&
    file.split("/").every((part) => part !== "." && part !== "..");
  if (!Array.isArray(listed) || !listed.every(inside))
    throw new Error(`Lista de arquivos inválida em ${manifest}`);
  const files = new Map<string, Buffer>();
  for (const file of listed)
    if (file !== "files.json") files.set(file, readFileSync(join(dir, file)));
  if (!files.has("docs/index.html")) throw new Error(`Documentação sem docs/index.html em ${dir}`);
  return files;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".data": "text/x-script",
  ".svg": "image/svg+xml",
};

// Every console build, including self-hosted ones, ships the docs under /docs
// with the landing; the build stops at its start when the docs were not built.
// Dev serves the last docs build, if any; `vp run docs:dev` is the authoring
// server.
type Emitter = {
  emitFile(file: { type: "asset"; fileName: string; source: string | Uint8Array }): unknown;
};

export function publicSitePlugin(origin = process.env.PUBLIC_SITE_ORIGIN, docs = docsOutput) {
  const publishedOrigin = publication(origin);
  let building = false;
  return {
    name: "freecorps-public-site",
    configResolved(config: { command: string }) {
      building = config.command === "build";
    },
    buildStart() {
      if (building) docsFiles(docs);
    },
    transformIndexHtml(html: string) {
      return pageMetadata(html.replace("<!-- public-site -->", landing()), publishedOrigin, "/");
    },
    generateBundle(this: Emitter) {
      const files = docsFiles(docs);
      // The not-found page answers missing /docs addresses (asset-fallback.ts):
      // it keeps noindex and stays out of the sitemap.
      const pages = [...files.keys()]
        .filter((file) => file.endsWith(".html") && file !== "docs/404.html")
        .sort();
      for (const [fileName, bytes] of files)
        this.emitFile({
          type: "asset",
          fileName,
          source: pages.includes(fileName)
            ? pageMetadata(new TextDecoder().decode(bytes), publishedOrigin, pagePath(fileName))
            : bytes,
        });
      this.emitFile({ type: "asset", fileName: "landing.css", source: landingStyles() });
      if (!publishedOrigin) return;
      const paths = ["/", ...pages.map(pagePath)];
      const headers = readFileSync(new URL("./public/_headers", import.meta.url), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source:
          headers +
          paths
            .flatMap((path) => [path, ...(path.endsWith("/") ? [] : [`${path}.html`])])
            .map((path) => `\n${path}\n  ! X-Robots-Tag\n`)
            .join(""),
      });
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: `User-agent: *\nDisallow: /\nAllow: /$\nAllow: /docs/\nAllow: /landing.css\nAllow: /landing/\nAllow: /fonts/\nSitemap: ${publishedOrigin}/sitemap.xml\n`,
      });
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${publishedOrigin}${path}</loc></url>`).join("")}</urlset>`,
      });
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path === "/landing.css") {
          res.setHeader("Content-Type", "text/css; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(landingStyles());
          return;
        }
        if (path !== "/docs.data" && path !== "/docs" && !path.startsWith("/docs/")) return next();
        if (path === "/docs") {
          res.writeHead(302, { Location: "/docs/" }).end();
          return;
        }
        const file = [path.endsWith("/") ? `${path}index.html` : path, `${path}.html`]
          .map((candidate) => join(docs, candidate))
          .find(
            (candidate) =>
              candidate.startsWith(docs) && existsSync(candidate) && statSync(candidate).isFile(),
          );
        // The Worker's rule (page-request.mjs) for which misses get the docs' 404 page.
        if (
          !file &&
          existsSync(join(docs, "docs/404.html")) &&
          isDocsPath(path) &&
          isPagePath(path) &&
          acceptsHtml(req.headers.accept)
        ) {
          res.statusCode = 404;
          res.setHeader("Content-Type", contentTypes[".html"]);
          res.setHeader("Cache-Control", "no-store");
          res.end(readFileSync(join(docs, "docs/404.html")));
          return;
        }
        if (!file) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(
            existsSync(docs)
              ? "Página inexistente na documentação."
              : "Documentação não compilada. Use `vp run docs:dev` para editar ou `vp run docs:build` para servir aqui.",
          );
          return;
        }
        res.setHeader("Content-Type", contentTypes[extname(file)] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        res.end(readFileSync(file));
      });
    },
  } satisfies Plugin;
}
