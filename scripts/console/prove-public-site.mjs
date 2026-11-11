import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { repoRoot } from "../lib/repo-root.mjs";

// Reads the built console (landing and docs) without running JavaScript: every
// page has one h1 and readable main text, nothing inline that the CSP in
// public/_headers would refuse, and every local reference exists.
const dist = resolve(process.argv[2] ?? "apps/console/dist");
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const files = [
  "index.html",
  ...walk(join(dist, "docs"))
    .filter((file) => file.endsWith(".html"))
    .map((file) => relative(dist, file).replaceAll("\\", "/")),
];
assert.ok(files.includes("docs/index.html"), "Documentação ausente em dist/docs");
assert.ok(existsSync(join(dist, "docs/search.json")), "Índice de busca ausente");
// No en or em dash in the text under /docs: pages, loader data read on client
// navigation and the search index. Scripts are dependency code, and the docs
// build checks the authored sources (apps/docs/scripts/build.mjs).
for (const file of [...walk(join(dist, "docs")), join(dist, "docs.data")].filter(
  (file) => !file.endsWith(".js"),
))
  assert.doesNotMatch(readFileSync(file, "utf8"), /[\u2013\u2014]/, `${file}: travessão`);
// Console screens the SPA serves, including the public legal texts (#428).
const appRoutes = new Set([
  "/login",
  "/signup",
  "/forgot-password",
  "/console",
  "/termos",
  "/privacidade",
]);
// The only console link with a query the public pages may carry: the task entry
// (`taskEntryHref` in apps/console/src/console-task.ts, #510). Any other query on
// a console screen, a redirect included, is refused.
const taskEntry = /^\?redirect=%2Fconsole%3Ftarefa%3D(importar|emitir|capturar|integrar)$/;
const consoleLink = (url) =>
  appRoutes.has(url.pathname) &&
  (url.search === "" || (url.pathname === "/signup" && taskEntry.test(url.search)));
let links = 0;
for (const file of files) {
  const html = readFileSync(join(dist, file), "utf8");
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll("h1").length, 1, file);
  // The docs' not-found page is short on purpose; it must lead back to /docs.
  if (file === "docs/404.html") {
    assert.ok(doc.querySelector('main a[href="/docs/"]'), `${file}: link para /docs/`);
    assert.equal(doc.querySelector("script, button"), null, `${file}: script ou botão`);
  } else assert.ok(doc.querySelector("main")?.textContent.length > 500, file);
  assert.equal(doc.querySelector("[style]"), null, `${file}: atributo style`);
  // Content React streamed out of place stays hidden without JavaScript.
  assert.equal(doc.querySelector('template[id^="B:"], [hidden][id^="S:"]'), null, file);
  for (const script of doc.querySelectorAll("script"))
    assert.ok(script.getAttribute("src")?.startsWith("/"), `${file}: script inline`);
  assert.doesNotMatch(html, /[\u2013\u2014]/, `${file}: travessão`);
  for (const element of doc.querySelectorAll("[href], [src]")) {
    const href = element.getAttribute("href") ?? element.getAttribute("src");
    if (!href?.startsWith("/") || href.startsWith("//")) continue;
    const url = new URL(href, "https://example.test");
    if (consoleLink(url)) continue;
    const asset = url.pathname.endsWith("/")
      ? `${url.pathname.slice(1)}index.html`
      : url.pathname.slice(1);
    assert.ok(
      existsSync(join(dist, asset)) || existsSync(join(dist, `${asset}.html`)),
      `${file}: ${href}`,
    );
    links++;
  }
}
// The development screens (apps/console/src/dev/) load only under import.meta.env.DEV; their
// chunks are named after the file, so none may reach the published build.
const devScreens = readdirSync(join(repoRoot, "apps/console/src/dev"))
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => `${file.replace(/\.tsx?$/, "")}-`);
assert.ok(devScreens.length > 0, "No development screen in apps/console/src/dev");
const devChunks = readdirSync(join(dist, "assets")).filter((file) =>
  devScreens.some((prefix) => file.startsWith(prefix)),
);
assert.deepEqual(devChunks, [], "Development screen chunk in production build");
console.log(JSON.stringify({ pages: files.length, links, withoutJavaScript: true, devChunks: 0 }));
