import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

// Count lazy chunks too: this bounds entry JS/CSS without guessing the route graph.
// Compression here is a reproducible artifact measurement, not HTTP transfer size.
const dist = resolve(process.argv[2] ?? "apps/console/dist");
const assets = readdirSync(join(dist, "assets")).sort();
const bundles = assets.filter((file) => /\.(js|css)$/.test(file));
assert.ok(
  bundles.some((file) => file.endsWith(".js")),
  "Build the console first",
);
assert.ok(
  bundles.some((file) => file.endsWith(".css")),
  "Missing console CSS",
);
function measure(path) {
  const bytes = readFileSync(join(dist, path));
  return {
    path,
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const files = [...bundles.map((file) => `assets/${file}`), "landing.css"].map(measure);
const allChunksGzipBytes = files.reduce((total, file) => total + file.gzipBytes, 0);
console.log(
  JSON.stringify(
    {
      kind: "local-build-artifact",
      node: process.version,
      compression: "gzip level 9, each file separately",
      entryJsCssBudgetBytes: 250 * 1024,
      allChunksGzipBytes,
      entryBudgetAssessment:
        allChunksGzipBytes <= 250 * 1024
          ? "within-budget-even-including-lazy-chunks"
          : "measure-entry-graph-before-concluding",
      excludedFromJsCssBudget: "HTML, fonts, examples and other downloads; no field metrics",
      fonts: assets.filter((file) => /\.woff2?$/.test(file)).map(measureFont),
      files,
    },
    null,
    2,
  ),
);

function measureFont(file) {
  const bytes = readFileSync(join(dist, "assets", file));
  return { path: `assets/${file}`, bytes: bytes.length };
}
