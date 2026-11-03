import { spawnSync } from "node:child_process";
import type { PathLike } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vite-plus/test";
import { typeScriptSource } from "./ts-source-imports.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const parent = "file:///repo/packages/contracts/src/documents.ts";
const files =
  (...paths: string[]) =>
  (path: PathLike) =>
    paths.includes(path instanceof URL ? path.href : String(path));

it("troca o .js inexistente pelo .ts ao lado, só quando quem importa é .ts", () => {
  const exists = files("file:///repo/packages/contracts/src/external.ts");
  expect(typeScriptSource("./external.js", parent, exists)).toBe(
    "file:///repo/packages/contracts/src/external.ts",
  );
  expect(typeScriptSource("../src/external.js", parent, exists)).toBe(
    "file:///repo/packages/contracts/src/external.ts",
  );
  expect(typeScriptSource("./external.js", "file:///repo/a.mjs", exists)).toBeNull();
  expect(typeScriptSource("./external.js", undefined, exists)).toBeNull();
});

it("não mexe em .js que existe, em pacote, em outra extensão nem sem .ts ao lado", () => {
  const both = files(
    "file:///repo/packages/contracts/src/external.js",
    "file:///repo/packages/contracts/src/external.ts",
  );
  expect(typeScriptSource("./external.js", parent, both)).toBeNull();
  const ts = files("file:///repo/packages/contracts/src/external.ts");
  expect(typeScriptSource("zod", parent, ts)).toBeNull();
  expect(typeScriptSource("./external.ts", parent, ts)).toBeNull();
  expect(typeScriptSource("./external.json", parent, ts)).toBeNull();
  expect(typeScriptSource("./missing.js", parent, ts)).toBeNull();
});

// O contrato importa ./webhooks.js de dentro de external.ts: sem o resolve, o
// Node para com ERR_MODULE_NOT_FOUND; com ele, carrega o código-fonte.
const loadContract = (register: boolean) => {
  const hook = pathToFileURL(fileURLToPath(new URL("./ts-source-imports.mjs", import.meta.url)));
  const contract = pathToFileURL(`${root}/packages/contracts/src/external.ts`);
  const script = [
    register ? `(await import(${JSON.stringify(hook.href)})).allowTypeScriptSourceImports();` : "",
    `const { routes } = await import(${JSON.stringify(contract.href)});`,
    "console.log(String(Object.keys(routes).length));",
  ].join("\n");
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  );
};

it("sob Node, o código-fonte do contrato só carrega com o resolve", () => {
  const without = loadContract(false);
  expect(without.status).not.toBe(0);
  expect(without.stderr).toContain("ERR_MODULE_NOT_FOUND");
  const loaded = loadContract(true);
  expect(loaded.stderr).toBe("");
  expect(loaded.status).toBe(0);
  expect(Number(loaded.stdout.trim())).toBeGreaterThan(0);
});
