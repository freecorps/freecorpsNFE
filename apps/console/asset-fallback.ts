// What the Worker answers for an address with no static file. The assets run
// with `not_found_handling: "none"`, so a miss reaches the Worker instead of
// the asset layer's own fallback, which used to answer every miss with the
// landing's HTML, even /favicon.ico or a missing chunk under /assets/ with a
// year-long immutable cache (#453).
//
// - A page navigation (GET or HEAD, accepts HTML, last segment without a file
//   extension other than .html) under /docs gets the docs' not-found page
//   (/docs/404, a static page of apps/docs) with status 404.
// - Any other page navigation gets /index.html, where the console's router
//   takes over: deep links and reloads of the panel keep working.
// - Everything else, missing scripts, images and data files, gets a short
//   404 that no cache keeps.
//
// The asset layer applies `_headers` only to the address it was asked for, so
// the fallback HTML carries the rules of `/` or `/docs/404`. `/docs/404`
// stays out of the published site's indexable list; `/` is in it, so the
// panel's fallback sets `X-Robots-Tag` itself, as the `/*` rule did before.

import { acceptsHtml, isDocsPath, isPagePath } from "./page-request.mjs";

const noindex = "noindex, nofollow, noarchive";

// The ASSETS binding, as far as this module uses it; kept structural so that
// tests and the Node typecheck do not pull in the Workers types.
type Assets = { fetch(request: Request): Promise<Response> };

export function isPageRequest(request: Request, url = new URL(request.url)) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return acceptsHtml(request.headers.get("Accept")) && isPagePath(url.pathname);
}

function notFound(request: Request) {
  return new Response(request.method === "HEAD" ? null : "Arquivo não encontrado.\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": noindex,
    },
  });
}

async function page(
  request: Request,
  assets: Assets,
  path: string,
  status: number,
  robots?: string,
) {
  // Only the method goes along: a conditional request could turn the page
  // into a 304 without body, which a 404 cannot carry.
  const file = await assets.fetch(
    new Request(new URL(path, request.url), { method: request.method }),
  );
  if (file.status !== 200) return notFound(request);
  const headers = new Headers(file.headers);
  if (robots) headers.set("X-Robots-Tag", robots);
  return new Response(file.body, { status, headers });
}

// The docs' not-found page is a file, so its own address would answer 200.
// `run_worker_first` lists it, and the Worker answers it with 404 like any miss.
export const docsNotFound = "/docs/404";

export async function serveAsset(request: Request, assets: Assets) {
  const url = new URL(request.url);
  if (url.pathname !== docsNotFound) {
    const response = await assets.fetch(request);
    if (response.status !== 404) return response;
  }
  if (!isPageRequest(request, url)) return notFound(request);
  if (isDocsPath(url.pathname)) return page(request, assets, docsNotFound, 404);
  return page(request, assets, "/", 200, noindex);
}
