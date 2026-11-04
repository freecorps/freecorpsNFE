import { build } from "vite-plus";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoUrl } from "./lib/repo-root.mjs";

const root = fileURLToPath(new URL("apps/console", repoUrl));
const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/measure-console-entry.mjs <report.json>");
if (Object.keys(process.env).some((key) => key.startsWith("VITE_")))
  throw new Error("Run without VITE_* variables for a deployment-independent comparison");
let report;
await build({
  root,
  envDir: false,
  configFile: resolve(root, "vite.config.ts"),
  plugins: [
    {
      name: "measure-console-bundle",
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
        const closure = (roots) => {
          const seen = new Set();
          const visit = (name) => {
            if (seen.has(name)) return;
            seen.add(name);
            const chunk = bundle[name];
            if (chunk?.type !== "chunk") throw new Error(`Missing chunk: ${name}`);
            chunk.imports.forEach(visit);
          };
          roots.forEach(visit);
          const selected = chunks.filter((chunk) => seen.has(chunk.fileName));
          return {
            files: selected.map((chunk) => chunk.fileName),
            bytes: selected.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0),
            gzipBytes: selected.reduce((sum, chunk) => sum + gzipSync(chunk.code).length, 0),
            validators: [...new Set(selected.flatMap((chunk) => Object.keys(chunk.modules)))]
              .filter((id) =>
                /node_modules[\\/]zod[\\/]|contracts[\\/]src[\\/]documents\.ts/.test(id),
              )
              .map((id) =>
                id.replaceAll("\\", "/").split("/node_modules/").pop().split("/packages/").pop(),
              ),
          };
        };
        const entry = chunks.find((chunk) => chunk.isEntry);
        const main = chunks.find((chunk) =>
          chunk.facadeModuleId?.replaceAll("\\", "/").endsWith("/src/main.tsx"),
        );
        if (!entry || !main) throw new Error("Console entries not found");
        report = {
          publicHome: closure([entry.fileName]),
          console: closure([entry.fileName, main.fileName]),
          all: closure(chunks.map((chunk) => chunk.fileName)),
        };
      },
    },
  ],
});
// Vite may rewrite preload lists after generateBundle. Measure the emitted files.
for (const group of Object.values(report)) {
  const files = group.files.map((file) => readFileSync(resolve(root, "dist", file)));
  group.bytes = files.reduce((sum, file) => sum + file.length, 0);
  group.gzipBytes = files.reduce((sum, file) => sum + gzipSync(file).length, 0);
}
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
