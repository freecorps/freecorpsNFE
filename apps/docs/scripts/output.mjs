// Pure steps of the docs build (scripts/build.mjs), kept apart so
// tests/docsOutput.test.ts can exercise them without a React Router build.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const hash = (text, algorithm = "sha256") =>
  createHash(algorithm).update(text).digest("hex").slice(0, 16);

export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// docs/<page>/index.html becomes docs/<page>.html. Deepest pages go first and a
// folder is removed only once it is empty, so a section index (api/index.html)
// never takes the pages nested under it along.
export function flattenPages(root) {
  const pages = walk(root)
    .filter((file) => file.endsWith(`${sep}index.html`) && dirname(file) !== root)
    .sort((a, b) => b.split(sep).length - a.split(sep).length);
  for (const file of pages) {
    const folder = dirname(file);
    renameSync(file, `${folder}.html`);
    if (!readdirSync(folder).length) rmdirSync(folder);
  }
  return pages.map((file) => relative(root, `${dirname(file)}.html`).replaceAll(sep, "/"));
}

// docs/markdown.json ({ "<page>.md": "..." }, app/routes/markdown.ts) becomes
// one docs/<page>.md per guide, and the map and its loader data leave the
// output. Only names of guides are accepted, so the map never writes outside
// the folder or over an HTML page.
export function splitMarkdown(root) {
  const map = join(root, "markdown.json");
  const files = JSON.parse(readFileSync(map, "utf8"));
  for (const [name, text] of Object.entries(files)) {
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.md$/.test(name) || typeof text !== "string")
      throw new Error(`Markdown inválido na documentação: ${name}`);
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  rmSync(map);
  rmSync(`${map}.data`, { force: true });
  return Object.keys(files).sort();
}

const unescapeAttribute = (value) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

// Moves inline scripts to files (writeScript(name, body)) and style attributes
// to data-fd-style rules collected in `rules`. Returns the rewritten page and
// the bodies of any remaining <style> blocks, which must be hashed in the CSP.
export function rewriteHtml(source, rules, writeScript) {
  let html = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (whole, attributes, body) => {
    if (/\bsrc=/.test(attributes)) return whole;
    if (!body.trim()) return "";
    const name = `${hash(body)}.js`;
    writeScript(name, body);
    return /type="module"/.test(attributes)
      ? `<script type="module" src="/docs/assets/inline/${name}"></script>`
      : `<script src="/docs/assets/inline/${name}"></script>`;
  });
  html = html.replace(/ style="([^"]*)"/g, (_, value) => {
    const declarations = unescapeAttribute(value);
    const id = hash(declarations).slice(0, 10);
    rules.set(id, declarations);
    return ` data-fd-style="${id}"`;
  });
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(([, b]) => b);
  return { html, styleBlocks };
}

// Reasons a finished page cannot ship under the CSP or without JavaScript.
export function pageProblems(source) {
  const problems = [];
  if (/<script\b(?![^>]*\bsrc=)[^>]*>/.test(source)) problems.push("Script inline");
  if (/\sstyle="/.test(source)) problems.push("Atributo style");
  if (/\son[a-z]+="/i.test(source)) problems.push("Handler inline");
  // A Suspense fragment streamed out of place shows only with JavaScript.
  if (/<template id="B:|hidden id="S:/.test(source)) problems.push("Fragmento adiado");
  return problems;
}

// Where an authored source breaks the editorial rule of DESIGN.md: no en or
// em dash. Positions are 1-based, as editors show them.
export function dashPositions(source) {
  return source.split("\n").flatMap((text, index) =>
    [...text.matchAll(/[\u2013\u2014]/g)].map((match) => ({
      line: index + 1,
      column: match.index + 1,
    })),
  );
}

// The not-found page (docs/404.html) is what the Worker answers for any
// missing address under /docs. Hydrated at an address other than /docs/404,
// React Router would match the guide route and fail to load its data, so the
// page ships without scripts: plain HTML with links, readable like the others.
// Without scripts, the layout's buttons (search, mobile menu) would do
// nothing, so they leave too; the links stay.
export function staticPage(source) {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, "")
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, "");
}

// /docs/assets/* is served as immutable (apps/console/public/_headers), so
// every name there must carry the hash of its content: Vite adds
// `-<8 characters>`, and this build names inline scripts and the style sheet
// by 16 hex digits. Returns the paths, relative to assets/, that fit neither.
export function unhashedAssets(names) {
  return names.filter(
    (name) =>
      !/^[^/]+-[\w-]{8}\.[a-z0-9]+$/.test(name) &&
      !/^inline\/[0-9a-f]{16}\.js$/.test(name) &&
      !/^inline-[0-9a-f]{16}\.css$/.test(name),
  );
}
