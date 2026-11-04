import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertMitSources, assertSdkDeclarations } from "../lib/first-party-licenses.mjs";

if (!process.versions.bun) throw new Error("Execute com bun run sdk:build usando a versão fixada.");
// Only remove generated output inside this checkout; reject a linked package directory.
const sdkDirectory = resolve("packages/sdk");
if (realpathSync(sdkDirectory) !== sdkDirectory) throw new Error("Diretório SDK deve ser local.");
rmSync(resolve(sdkDirectory, "dist"), { recursive: true, force: true });
mkdirSync("packages/sdk/dist", { recursive: true });
mkdirSync(".ci-results/74", { recursive: true });
execFileSync(
  process.execPath,
  [
    "build",
    "packages/sdk/src/index.ts",
    "packages/sdk/src/webhooks.ts",
    "--target",
    "browser",
    "--external",
    "zod",
    "--outdir",
    "packages/sdk/dist",
    "--metafile=" + resolve(".ci-results/74/sdk-metafile.json"),
    "--reject-unresolved",
  ],
  { stdio: "inherit" },
);
assertMitSources(
  Object.keys(JSON.parse(readFileSync(".ci-results/74/sdk-metafile.json", "utf8")).inputs),
);
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "packages/sdk/tsconfig.json"],
  { stdio: "inherit" },
);
assertSdkDeclarations(
  readdirSync("packages/sdk/dist/types", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map(
      (entry) =>
        "types/" +
        resolve(entry.parentPath, entry.name)
          .slice(resolve("packages/sdk/dist/types").length + 1)
          .replaceAll("\\", "/"),
    ),
);
const manifest = JSON.parse(readFileSync("packages/sdk/package.json", "utf8"));
writeFileSync(
  "packages/sdk/dist/package.json",
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      publishConfig: { access: "public" },
      type: "module",
      engines: { node: ">=22" },
      exports: {
        ".": { types: "./types/sdk/src/index.d.ts", import: "./index.js" },
        "./webhooks": { types: "./types/sdk/src/webhooks.d.ts", import: "./webhooks.js" },
      },
      files: [
        "*.js",
        "types",
        "README.md",
        "LICENSE",
        "NOTICE",
        "LICENSING.md",
        "THIRD_PARTY_NOTICES.txt",
      ],
      dependencies: { zod: manifest.dependencies.zod },
    },
    null,
    2,
  ) + "\n",
);
copyFileSync("packages/sdk/README.md", "packages/sdk/dist/README.md");
for (const file of ["LICENSE", "NOTICE", "LICENSING.md", "THIRD_PARTY_NOTICES.txt"])
  copyFileSync(`packages/sdk/${file}`, `packages/sdk/dist/${file}`);
mkdirSync(".ci-results/74", { recursive: true });
execFileSync(process.execPath, ["pm", "pack", "--destination", resolve(".ci-results/74")], {
  cwd: "packages/sdk/dist",
  stdio: "inherit",
});
