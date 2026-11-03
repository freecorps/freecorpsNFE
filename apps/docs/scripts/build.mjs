// Builds the docs as static files for /docs, ready to be copied into the
// console's dist (apps/console/site-plugin.ts does that on every console
// build). Usage: `vp run docs:build`, the `ci:docs` task of the root
// vite.config.ts, which the console build depends on.
//
// React Router prerenders every page; this script then makes the output fit
// the console's hosting and its CSP (script-src 'self'; style-src 'self'):
// - docs/<page>/index.html becomes docs/<page>.html, the layout the Worker
//   and the self-hosted server already serve for /docs/<page>;
// - inline <script> blocks move to files under /docs/assets/inline/, named by
//   content hash, loaded with src in the same order;
// - style="" attributes become data-fd-style="<hash>" and one stylesheet with
//   the same declarations, unlayered so it outranks Tailwind like inline
//   styles would;
// - the only inline <style> (Radix scroll area) stays, and its sha256 must be
//   listed in apps/console/public/_headers.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dashPositions,
  flattenPages,
  hash,
  pageProblems,
  rewriteHtml,
  splitMarkdown,
  staticPage,
  unhashedAssets,
  walk,
} from "./output.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const client = join(app, "build/client");
const out = join(app, "dist");
const headers = readFileSync(join(app, "../console/public/_headers"), "utf8");

// No en or em dash in what we write (DESIGN.md): the guides, the interface
// strings and the contract the API reference is generated from. Checked in the
// sources, where the position is useful; dependency code is left alone.
const repo = join(app, "../..");
for (const file of [
  ...walk(join(app, "content")),
  ...walk(join(app, "app")),
  join(repo, "docs/v1.0/openapi.json"),
]) {
  const [first] = dashPositions(readFileSync(file, "utf8"));
  if (first)
    throw new Error(
      `Travessão em ${relative(repo, file).replaceAll("\\", "/")}:${first.line}:${first.column}`,
    );
}

if (!process.argv.includes("--skip-build")) {
  const manifest = createRequire(join(app, "package.json")).resolve(
    "@react-router/dev/package.json",
  );
  const cli = join(dirname(manifest), "bin.cjs");
  rmSync(join(app, "build"), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [cli, "build"], { cwd: app, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(client, "docs"), join(out, "docs"), { recursive: true });
// Client navigation to /docs reads /docs.data, beside the folder.
cpSync(join(client, "docs.data"), join(out, "docs.data"));

flattenPages(join(out, "docs"));
splitMarkdown(join(out, "docs"));

const inline = join(out, "docs/assets/inline");
mkdirSync(inline, { recursive: true });
const rules = new Map();
const styleBlocks = new Set();
const html = walk(join(out, "docs")).filter((file) => file.endsWith(".html"));
for (const file of html) {
  const result = rewriteHtml(readFileSync(file, "utf8"), rules, (name, body) =>
    writeFileSync(join(inline, name), body),
  );
  for (const body of result.styleBlocks) styleBlocks.add(body);
  writeFileSync(file, result.html);
}

const css = [...rules]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, declarations]) => `[data-fd-style="${id}"]{${declarations}}`)
  .join("\n");
const sheet = `inline-${hash(css)}.css`;
writeFileSync(join(out, "docs/assets", sheet), `${css}\n`);
for (const file of html) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("</head>")) throw new Error(`Página sem <head>: ${file}`);
  writeFileSync(
    file,
    source.replace("</head>", `<link rel="stylesheet" href="/docs/assets/${sheet}"/></head>`),
  );
}

const notFound = join(out, "docs/404.html");
if (!existsSync(notFound)) throw new Error("Saída incompleta da documentação: docs/404.html");
writeFileSync(notFound, staticPage(readFileSync(notFound, "utf8")));

for (const body of styleBlocks) {
  const digest = createHash("sha256").update(body).digest("base64");
  if (!headers.includes(`'sha256-${digest}'`))
    throw new Error(
      `Estilo inline sem hash na CSP de apps/console/public/_headers: 'sha256-${digest}'\n${body}`,
    );
}

for (const file of html) {
  const [problem] = pageProblems(readFileSync(file, "utf8"));
  if (problem) throw new Error(`${problem}: ${file}`);
}

// What the build adds around the sources (pages, loader data, search index)
// must not bring a dash either. Scripts and the third-party notices are left
// out: library code and license texts carry dashes as data, such as Shiki's
// HTML entity table.
for (const file of walk(out)) {
  if (file.endsWith(".js") || file.endsWith("third-party-notices.txt")) continue;
  if (/[\u2013\u2014]/.test(readFileSync(file, "utf8")))
    throw new Error(`Travessão em ${relative(out, file)}`);
}

for (const file of [
  "index.html",
  "search.json",
  "llms.txt",
  "llms-full.txt",
  "index.md",
  "third-party-notices.txt",
])
  if (!existsSync(join(out, "docs", file)))
    throw new Error(`Saída incompleta da documentação: docs/${file}`);
const assets = join(out, "docs/assets");
const unhashed = unhashedAssets(
  walk(assets).map((file) => relative(assets, file).replaceAll("\\", "/")),
);
if (unhashed.length)
  throw new Error(
    `Arquivos sem hash em docs/assets, servidos como imutáveis: ${unhashed.sort().join(", ")}`,
  );
// The console copies only what this build listed. A cached run of `ci:docs`
// restores its files over apps/docs/dist without removing what a later build
// left there, such as a page deleted since.
writeFileSync(
  join(out, "files.json"),
  `${JSON.stringify(
    walk(out)
      .map((file) => relative(out, file).replaceAll("\\", "/"))
      .sort(),
  )}
`,
);
console.log(
  JSON.stringify({
    pages: html.length,
    inlineScripts: readdirSync(inline).length,
    styleRules: rules.size,
    styleBlocks: styleBlocks.size,
  }),
);
