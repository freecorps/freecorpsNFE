import { copyFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { firstPartyScope } from "./lib/first-party-licenses.mjs";

// The workspace keeps exporting the sources; the published package is the
// compiled copy in packages/contracts/dist, with its own manifest, as the SDK.
// Requires the fiscal-core dist from packages:build.
const directory = resolve("packages/contracts");
if (realpathSync(directory) !== directory) throw new Error("Diretório contracts deve ser local.");
const output = resolve(directory, "dist");
rmSync(output, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [resolve("node_modules/typescript/bin/tsc"), "-p", "packages/contracts/tsconfig.json"],
  { stdio: "inherit" },
);
// tsc keeps the SPDX header in the JS but drops it from declarations; the
// package mixes two licenses, so each MIT file carries it in both.
for (const source of firstPartyScope().mit.files.filter((path) =>
  path.startsWith("packages/contracts/src/"),
)) {
  const header = readFileSync(source, "utf8").match(/^(?:\/\/[^\n]*\n)+/)?.[0];
  if (!header?.includes("SPDX-License-Identifier: MIT"))
    throw new Error(`Sem cabeçalho MIT: ${source}`);
  const stem = resolve(output, "dist", source.slice("packages/contracts/src/".length, -3));
  if (!readFileSync(`${stem}.js`, "utf8").startsWith(header))
    throw new Error(`Cabeçalho MIT ausente no JS: ${source}`);
  writeFileSync(`${stem}.d.ts`, header + readFileSync(`${stem}.d.ts`, "utf8"));
}
const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
const core = JSON.parse(readFileSync("packages/fiscal-core/package.json", "utf8"));
const entry = (path) => {
  const stem = path.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
  return { types: `${stem}.d.ts`, default: `${stem}.js` };
};
writeFileSync(
  resolve(output, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      private: true,
      license: manifest.license,
      type: "module",
      engines: { node: ">=22" },
      exports: Object.fromEntries(
        Object.entries(manifest.exports).map(([subpath, path]) => [subpath, entry(path)]),
      ),
      files: [
        "dist",
        "README.md",
        "LICENSE",
        "LICENSE-MIT",
        "NOTICE",
        "LICENSING.md",
        "THIRD_PARTY_NOTICES.txt",
      ],
      dependencies: { "@freecorps/fiscal-core": core.version, zod: manifest.dependencies.zod },
    },
    null,
    2,
  ) + "\n",
);
for (const file of [
  "README.md",
  "LICENSE",
  "LICENSE-MIT",
  "NOTICE",
  "LICENSING.md",
  "THIRD_PARTY_NOTICES.txt",
])
  copyFileSync(resolve(directory, file), resolve(output, file));
console.log(`Pacote contracts preparado em ${output}`);
