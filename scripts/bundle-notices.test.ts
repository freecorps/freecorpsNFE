import { describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleNotices } from "./lib/bundle-notices.mjs";

const docs = createRequire(new URL("../apps/docs/package.json", import.meta.url));
const consoleApp = createRequire(new URL("../apps/console/package.json", import.meta.url));
const react = consoleApp.resolve("react");
const reactVersion: string = consoleApp("react/package.json").version;

// A fake package under node_modules, outside the reviewed inventory or without license.
function fakePackage(name: string, version: string, license?: string) {
  const root = mkdtempSync(join(tmpdir(), "fnfe-notices-"));
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(join(directory, "index.js"), "export {};");
  if (license) writeFileSync(join(directory, "LICENSE"), license);
  return { file: join(directory, "index.js"), root };
}

describe("avisos de terceiros do bundle", () => {
  it("traz licença declarada e texto de cada pacote, uma vez", () => {
    const text = bundleNotices([react, `\0${react}?commonjs-proxy`, "/repo/src/main.tsx"]);
    expect(text.match(/^react@\S+$/gm)).toHaveLength(1);
    expect(text).toContain("Declared license: MIT");
    expect(text).toContain("Permission is hereby granted");
  });
  it("inclui a cópia embutida pelo fumadocs-openapi com o texto registrado", () => {
    const host = dirname(docs.resolve("fumadocs-openapi/package.json"));
    const copy = join(
      host,
      "dist/node_modules/.pnpm/xml-js@1.6.11/node_modules/xml-js/lib/js2xml.js",
    );
    const text = bundleNotices([copy]);
    expect(text).toContain(
      "xml-js@1.6.11\nDeclared license: MIT\nVendored in fumadocs-openapi@12.5.5",
    );
    expect(text).toContain("Yousuf Almarzooqi");
  });
  it("usa o texto suplementar do pacote publicado sem licença", () => {
    const published = fakePackage("react-remove-scroll-bar", "2.3.8");
    try {
      const text = bundleNotices([published.file]);
      expect(text).toContain(
        "License text from https://github.com/theKashey/react-remove-scroll-bar/blob/",
      );
      expect(text).toContain("Anton Korzunov");
    } finally {
      rmSync(published.root, { recursive: true, force: true });
    }
  });
  it("recusa pacote fora do inventário e pacote sem licença", () => {
    const unknown = fakePackage("left-pad-unreviewed", "9.9.9", "MIT");
    const unlicensed = fakePackage("react", reactVersion);
    try {
      expect(() => bundleNotices([unknown.file])).toThrow("fora do inventário");
      expect(() => bundleNotices([unlicensed.file])).toThrow("Licença ausente");
    } finally {
      rmSync(unknown.root, { recursive: true, force: true });
      rmSync(unlicensed.root, { recursive: true, force: true });
    }
  });
});
