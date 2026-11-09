import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { checkPackageBoundaries } from "../lib/package-boundaries.mjs";

const roots: string[] = [];
function put(root: string, path: string, value: unknown) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fnfe-boundaries-"));
  roots.push(root);
  put(root, "package.json", { workspaces: ["packages/*", "platform"] });
  const rules: Record<
    string,
    {
      kind: string;
      workspaces?: string[];
      external?: string[];
      entryPoints?: Record<string, { kind: string; workspaces: string[]; external: string[] }>;
    }
  > = {
    "packages/fiscal": { kind: "pure", workspaces: ["@test/helper"], external: ["parser"] },
    "packages/helper": { kind: "pure", workspaces: [], external: [] },
    platform: { kind: "platform" },
  };
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  put(root, "packages/fiscal/package.json", { name: "@test/fiscal" });
  put(root, "packages/helper/package.json", { name: "@test/helper" });
  put(root, "platform/package.json", { name: "@test/platform" });
  put(root, "packages/fiscal/src/index.ts", "export const value = 1;");
  put(root, "packages/helper/src/index.ts", "export const helper = 1;");
  put(root, "platform/index.ts", "export const database = 1;");
  put(root, "tsconfig.json", {
    compilerOptions: {
      moduleResolution: "bundler",
      paths: { "@platform/*": ["./platform/*"], "@helper/*": ["./packages/helper/src/*"] },
    },
  });
  return { root, rules };
}
afterEach(() => {
  // Only remove the exact directories created by this test process.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  "export const secret = process.env.SAAS_SECRET;",
  'export const secret = process["env"]["SAAS_SECRET"];',
  "const { env } = process; export const secret = env.SAAS_SECRET;",
  "export const secret = Bun.env.SAAS_SECRET;",
  'export const secret = Bun["env"].SAAS_SECRET;',
  "export const secret = import.meta.env.SAAS_SECRET;",
  'const load = require; load("convex");',
  'const load = module.require; load("convex");',
  'const client = module.require("miniflare");',
  'const load = module["require"]; load("convex");',
  'export const secret = globalThis["Bun"].env.SAAS_SECRET;',
  'export const secret = globalThis["Deno"].env.get("SAAS_SECRET");',
  'globalThis["eval"]("anything");',
  'globalThis["Function"]("return 1")();',
  'globalThis[`require`]("convex");',
  'globalThis["Bu" + "n"].env.SAAS_SECRET;',
  'const runtime = globalThis; runtime["Bun"].env.SAAS_SECRET;',
  'const loaderName = "require"; module[loaderName]("convex");',
  'const resolveModule = require.resolve; resolveModule("convex");',
])("keeps Node packages independent from ambient configuration: %s", (source) => {
  const { root, rules } = fixture();
  rules["packages/fiscal"]!.kind = "node";
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  put(root, "packages/fiscal/src/index.ts", source);
  expect(() => checkPackageBoundaries(root)).toThrow(/ambient runtime|alternate runtime/);
});

it("checks the real workspaces and connects the blocking command before CI approval", () => {
  // entryPoints: the `./pure` subset of packages/fiscal-nfse.
  expect(checkPackageBoundaries(resolve("."))).toEqual({
    workspaces: 9,
    independent: 5,
    entryPoints: 1,
  });
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
    jobs: Record<string, { steps?: Array<{ run?: string; if?: string }> }>;
  };
  // The boundary check is a step of the job that approves the revision,
  // before the approval and under the same condition: the approval never runs
  // without it (a documentation-only change skips both, and issues no SHA).
  const steps = workflow.jobs.validate!.steps!;
  const step = (run: string) => steps.findIndex((s) => s.run?.trim() === run);
  const command = step("vp run ci:boundaries");
  const approve = step("node scripts/ci/ci.mjs approve");
  expect(command).toBeGreaterThanOrEqual(0);
  expect(command).toBeLessThan(approve);
  expect(steps[command]!.if).toBe(steps[approve]!.if);
  expect(steps[command]).not.toHaveProperty("continue-on-error");
});

it.each([
  'import { query } from "convex/server";',
  'export * from "react";',
  'export type { User } from "better-auth";',
  'type User = import("@clerk/backend").User;',
  'const client = import("cloudflare:workers");',
  'const client = require("wrangler");',
  'import client = require("convex/server");',
  'const client = require.resolve("react-dom");',
])("rejects a direct dependency and passes again after removing it: %s", (source) => {
  const { root } = fixture();
  put(root, "packages/fiscal/src/index.ts", source);
  expect(() => checkPackageBoundaries(root)).toThrow(
    /packages\/fiscal.*(convex|react|auth|clerk|cloudflare|wrangler|miniflare)/,
  );
  put(root, "packages/fiscal/src/index.ts", "export const value = 1;");
  expect(checkPackageBoundaries(root).independent).toBe(2);
});

it.each([
  'export * from "@platform/index";',
  'export type { database } from "../../../platform/index";',
])("resolves aliases and relative paths to platform code: %s", (source) => {
  const { root } = fixture();
  put(root, "packages/fiscal/src/index.ts", source);
  expect(() => checkPackageBoundaries(root)).toThrow(/packages\/fiscal.*platform/);
});

it("follows a type reexport through another allowed workspace and reports the whole chain", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/src/index.ts", 'export type { helper } from "@helper/index";');
  put(root, "packages/helper/src/index.ts", 'export * from "@platform/index";');
  expect(() => checkPackageBoundaries(root)).toThrow(
    /packages\/fiscal.*packages\/helper.*platform/,
  );
  put(root, "packages/helper/src/index.ts", "export type helper = string;");
  expect(checkPackageBoundaries(root).independent).toBe(2);
});

it.each(["dependencies", "peerDependencies", "optionalDependencies"])(
  "checks %s even without an import",
  (field) => {
    const { root } = fixture();
    put(root, "packages/fiscal/package.json", { name: "@test/fiscal", [field]: { convex: "1" } });
    expect(() => checkPackageBoundaries(root)).toThrow(/package.json.*convex/);
  },
);

it("follows transitive workspace manifests and tolerates cycles within allowed boundaries", () => {
  const { root, rules } = fixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    dependencies: { "@test/helper": "workspace:*" },
  });
  put(root, "packages/helper/package.json", {
    name: "@test/helper",
    dependencies: { convex: "1" },
  });
  expect(() => checkPackageBoundaries(root)).toThrow(/fiscal.*helper.*convex/);
  rules["packages/helper"].workspaces = ["@test/fiscal"];
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  put(root, "packages/helper/package.json", {
    name: "@test/helper",
    dependencies: { "@test/fiscal": "workspace:*" },
  });
  expect(checkPackageBoundaries(root).independent).toBe(2);
});

it("checks installed transitive dependencies and npm aliases by the actual package name", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    dependencies: { parser: "1" },
  });
  put(root, "node_modules/parser/package.json", { name: "parser", dependencies: { convex: "1" } });
  expect(() => checkPackageBoundaries(root)).toThrow(/fiscal.*parser.*convex/);
  put(root, "node_modules/parser/package.json", { name: "better-auth" });
  expect(() => checkPackageBoundaries(root)).toThrow(/parser.*better-auth/);
  put(root, "node_modules/parser/package.json", { name: "parser" });
  expect(checkPackageBoundaries(root).independent).toBe(2);
});

it("ignores development tools but refuses their use from runtime code", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    devDependencies: { react: "1", typescript: "6" },
  });
  put(root, "packages/fiscal/index.test.ts", 'import React from "react";');
  put(root, "packages/fiscal/vite.config.ts", 'import React from "react";');
  expect(checkPackageBoundaries(root).independent).toBe(2);
  put(root, "packages/fiscal/src/index.ts", 'import "../index.test";');
  expect(() => checkPackageBoundaries(root)).toThrow(/index.test.ts.*react/);
});

it("rejects a paths alias that redirects an allowed external name to a forbidden package", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    dependencies: { parser: "1" },
  });
  put(root, "node_modules/parser/package.json", { name: "parser" });
  put(root, "node_modules/convex/package.json", { name: "convex" });
  put(root, "node_modules/convex/index.d.ts", "export declare const query: unknown;");
  put(root, "tsconfig.json", {
    compilerOptions: { paths: { parser: ["./node_modules/convex/index.d.ts"] } },
  });
  put(root, "packages/fiscal/src/index.ts", 'export * from "parser";');
  expect(() => checkPackageBoundaries(root)).toThrow(/fiscal.*parser.*convex/);
});

it("accepts DefinitelyTyped declarations only for a declared runtime dependency", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/src/index.ts", 'import QR from "parser"; export const qr = QR;');
  put(root, "node_modules/@types/parser/package.json", { name: "@types/parser" });
  put(
    root,
    "node_modules/@types/parser/index.d.ts",
    "declare const QR: unknown; export default QR;",
  );
  // Types alone do not make the runtime package a dependency.
  expect(() => checkPackageBoundaries(root)).toThrow(/parser/);
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    dependencies: { parser: "1" },
  });
  put(root, "node_modules/parser/package.json", { name: "parser" });
  put(root, "node_modules/parser/index.js", "module.exports = {};");
  expect(checkPackageBoundaries(root).independent).toBe(2);
  // The runtime package is still checked, whatever its types say.
  put(root, "node_modules/parser/package.json", { name: "parser", dependencies: { convex: "1" } });
  expect(() => checkPackageBoundaries(root)).toThrow(/parser.*convex/);
  // Other @types packages are still an alias to a different package.
  put(root, "tsconfig.json", {
    compilerOptions: { paths: { parser: ["./node_modules/@types/other/index.d.ts"] } },
  });
  put(root, "node_modules/parser/package.json", { name: "parser" });
  put(root, "node_modules/@types/other/package.json", { name: "@types/other" });
  put(
    root,
    "node_modules/@types/other/index.d.ts",
    "declare const QR: unknown; export default QR;",
  );
  expect(() => checkPackageBoundaries(root)).toThrow(
    /alias aponta para outro pacote: @types\/other/,
  );
});

it("checks exported entrypoints even when they are in a development folder", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    exports: { ".": "./fixtures/public.ts" },
  });
  put(root, "packages/fiscal/fixtures/public.ts", 'export * from "convex/server";');
  expect(() => checkPackageBoundaries(root)).toThrow(/fixtures\/public.ts.*convex/);
});

it("checks wildcard exports and optional npm aliases on other operating systems", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    exports: { "./*": "./fixtures/*.ts" },
    dependencies: { parser: "1" },
  });
  put(root, "node_modules/parser/package.json", { name: "parser" });
  put(root, "packages/fiscal/fixtures/hidden.ts", 'export * from "react";');
  expect(() => checkPackageBoundaries(root)).toThrow(/fixtures\/hidden.ts.*react/);
  put(root, "packages/fiscal/fixtures/hidden.ts", "export const value = 1;");
  put(root, "node_modules/parser/package.json", {
    name: "parser",
    optionalDependencies: { hidden: "npm:@clerk/backend@1" },
  });
  expect(() => checkPackageBoundaries(root)).toThrow(/parser.*hidden.*clerk/);
});

it("checks emitted JavaScript even when resolution prefers a clean declaration", () => {
  const { root } = fixture();
  put(root, "packages/fiscal/package.json", { name: "@test/fiscal", exports: "./dist/index.js" });
  put(root, "packages/fiscal/dist/index.js", 'export * from "./helper.js";');
  put(root, "packages/fiscal/dist/helper.d.ts", "export declare const value: number;");
  put(root, "packages/fiscal/dist/helper.js", 'export * from "convex/server";');
  expect(() => checkPackageBoundaries(root)).toThrow(/dist\/helper.js.*convex/);
});

it.each(["./helper", "./helper/index"])(
  "checks extensionless emitted implementations: %s",
  (specifier) => {
    const { root } = fixture();
    put(root, "packages/fiscal/package.json", { name: "@test/fiscal", exports: "./dist/index.js" });
    put(root, "packages/fiscal/dist/index.js", `export * from "${specifier}";`);
    const name = specifier.slice(2);
    put(root, `packages/fiscal/dist/${name}.d.ts`, "export declare const value: number;");
    put(root, `packages/fiscal/dist/${name}.js`, 'export * from "convex/server";');
    expect(() => checkPackageBoundaries(root)).toThrow(/helper.*convex/);
  },
);

it.each([
  'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("convex");',
  'import { createRequire as factory } from "module"; const load = factory(import.meta.url); load.resolve("convex");',
  'import * as loaders from "node:module"; const { createRequire: factory } = loaders; const load = factory(import.meta.url); load("convex");',
  'const { createRequire: factory } = require("node:module"); const load = factory(__filename); load("convex");',
])("rejects unsupported CommonJS loader factories: %s", (source) => {
  const { root, rules } = fixture();
  rules["packages/fiscal"].kind = "node";
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  put(root, "packages/fiscal/src/index.ts", source);
  expect(() => checkPackageBoundaries(root)).toThrow(/carregadores.*module/);
});

it("assigns nested files to the deepest workspace without treating containment as an import", () => {
  const { root, rules } = fixture();
  put(root, "package.json", { workspaces: ["packages/**", "platform"] });
  rules["packages/helper/nested"] = { kind: "node", workspaces: [], external: [] };
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  put(root, "packages/helper/nested/package.json", { name: "@test/nested" });
  put(root, "packages/helper/nested/src/index.ts", 'import { readFile } from "node:fs";');
  expect(checkPackageBoundaries(root)).toEqual({ workspaces: 4, independent: 3, entryPoints: 0 });
  put(root, "packages/helper/src/index.ts", 'export * from "../nested/src/index";');
  expect(() => checkPackageBoundaries(root)).toThrow(/helper.*nested/);
});

it("discovers new workspaces and rejects absent or stale classifications", () => {
  const { root, rules } = fixture();
  put(root, "packages/new/package.json", { name: "@test/new" });
  expect(() => checkPackageBoundaries(root)).toThrow(/packages\/new.*classificação/);
  put(root, "scripts/build/package-boundaries.json", {
    schemaVersion: 1,
    workspaces: { ...rules, "packages/new": { kind: "node", external: [], workspaces: [] } },
  });
  expect(checkPackageBoundaries(root).workspaces).toBe(4);
  put(root, "package.json", { workspaces: ["platform"] });
  expect(() => checkPackageBoundaries(root)).toThrow(/classificação sem workspace/);
});

it("distinguishes Node connectors from pure packages and rejects a pure-to-Node edge", () => {
  const { root, rules } = fixture();
  put(root, "packages/helper/src/index.ts", 'import { readFile } from "node:fs";');
  expect(() => checkPackageBoundaries(root)).toThrow(/Node proibido/);
  rules["packages/helper"].kind = "node";
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  expect(checkPackageBoundaries(root).independent).toBe(2);
  put(root, "packages/fiscal/src/index.ts", 'export * from "@helper/index";');
  expect(() => checkPackageBoundaries(root)).toThrow(/pure -> node/);
});

it.each(["import(name);", "require(name);", 'export * from "missing-package";'])(
  "fails closed for an unverifiable import: %s",
  (source) => {
    const { root } = fixture();
    put(root, "packages/fiscal/src/index.ts", source);
    expect(() => checkPackageBoundaries(root)).toThrow(/calculado|não resolvido/);
  },
);

// A Node workspace whose `./pure` export promises a subset without Node, as
// packages/fiscal-nfse does for the Convex mutations.
function pureEntryFixture() {
  const { root, rules } = fixture();
  rules["packages/fiscal"] = {
    kind: "node",
    workspaces: ["@test/helper"],
    external: ["parser"],
    entryPoints: { "./pure": { kind: "pure", workspaces: [], external: [] } },
  };
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./pure": { types: "./dist/pure.d.ts", default: "./dist/pure.js" },
    },
  });
  put(root, "packages/fiscal/tsconfig.json", {
    extends: "../../tsconfig.json",
    compilerOptions: { outDir: "dist", rootDir: "src" },
  });
  // The main entry point keeps the workspace's Node classification.
  put(
    root,
    "packages/fiscal/src/index.ts",
    'import { gzipSync } from "node:zlib"; export const zip = gzipSync; export * from "./pure";',
  );
  put(root, "packages/fiscal/src/pure.ts", 'export * from "./route";');
  put(root, "packages/fiscal/src/route.ts", "export const route = 1;");
  put(
    root,
    "packages/fiscal/src/transport.ts",
    'import { readFile } from "node:fs"; export type Transport = typeof readFile;',
  );
  return { root, rules };
}

it("classifies an export subpath of a Node workspace as pure, checked from source", () => {
  const { root } = pureEntryFixture();
  expect(checkPackageBoundaries(root)).toEqual({ workspaces: 3, independent: 2, entryPoints: 1 });
});

it.each([
  [
    "directly",
    "packages/fiscal/src/pure.ts",
    'import { readFile } from "node:fs"; export const read = readFile;',
    /exports \.\/pure\] -> packages\/fiscal\/src\/pure.ts \[node:fs\]: runtime Node proibido em pacote puro/,
  ],
  [
    "through a relative module",
    "packages/fiscal/src/route.ts",
    'import { readFile } from "node:fs"; export const route = readFile;',
    /exports \.\/pure\] -> packages\/fiscal\/src\/pure.ts \[\.\/route\] -> packages\/fiscal\/src\/route.ts \[node:fs\]: runtime Node proibido em pacote puro/,
  ],
  [
    "through a type-only import",
    "packages/fiscal/src/route.ts",
    'import type { Transport } from "./transport"; export const route: Transport | 1 = 1;',
    /src\/pure.ts \[\.\/route\] -> packages\/fiscal\/src\/route.ts \[\.\/transport\] -> packages\/fiscal\/src\/transport.ts \[node:fs\]: runtime Node proibido/,
  ],
])(
  "rejects Node reachable from a pure entry point %s and passes after removing it",
  (_, path, source, error) => {
    const { root } = pureEntryFixture();
    put(root, path, source);
    expect(() => checkPackageBoundaries(root)).toThrow(error);
    put(
      root,
      path,
      path.endsWith("pure.ts") ? 'export * from "./route";' : "export const route = 1;",
    );
    expect(checkPackageBoundaries(root).entryPoints).toBe(1);
  },
);

it("applies the entry point's own allowlist to external packages and workspaces", () => {
  const { root } = pureEntryFixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    dependencies: { parser: "1" },
    exports: { "./pure": "./dist/pure.js" },
  });
  put(root, "node_modules/parser/package.json", { name: "parser", types: "index.d.ts" });
  put(root, "node_modules/parser/index.d.ts", "export declare const parse: unknown;");
  // The whole workspace may use the parser; its pure subset may not.
  put(root, "packages/fiscal/src/index.ts", 'export { parse } from "parser";');
  expect(checkPackageBoundaries(root).entryPoints).toBe(1);
  put(root, "packages/fiscal/src/route.ts", 'export { parse } from "parser";');
  expect(() => checkPackageBoundaries(root)).toThrow(
    /exports \.\/pure\].*route.ts \[parser\]: dependência externa não permitida: parser/,
  );
  put(root, "packages/fiscal/src/route.ts", 'export * from "@helper/index";');
  expect(() => checkPackageBoundaries(root)).toThrow(
    /exports \.\/pure\].*workspace não permitido: @test\/helper/,
  );
});

it("checks the compiled file of a pure entry point when it exists", () => {
  const { root } = pureEntryFixture();
  put(root, "packages/fiscal/dist/pure.d.ts", "export declare const route: number;");
  put(root, "packages/fiscal/dist/pure.js", 'import "node:zlib"; export const route = 1;');
  expect(() => checkPackageBoundaries(root)).toThrow(
    /exports \.\/pure\] -> packages\/fiscal\/dist\/pure.js \[node:zlib\]/,
  );
  put(root, "packages/fiscal/dist/pure.js", "export const route = 1;");
  expect(checkPackageBoundaries(root).entryPoints).toBe(1);
});

it("rejects an entry point absent from exports, without implementation or wider than its workspace", () => {
  const { root, rules } = pureEntryFixture();
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    exports: { ".": "./dist/index.js" },
  });
  expect(() => checkPackageBoundaries(root)).toThrow(/exports \.\/pure\]: .*ausente dos exports/);
  put(root, "packages/fiscal/package.json", {
    name: "@test/fiscal",
    exports: { "./pure": "./dist/missing.js" },
  });
  expect(() => checkPackageBoundaries(root)).toThrow(/sem implementação verificável/);
  rules["packages/fiscal"]!.entryPoints = {
    "./pure": { kind: "pure", workspaces: [], external: ["zod"] },
  };
  put(root, "scripts/build/package-boundaries.json", { schemaVersion: 1, workspaces: rules });
  expect(() => checkPackageBoundaries(root)).toThrow(
    /packages\/fiscal -> \.\/pure: ponto de entrada sem classificação/,
  );
});
