import { expect, it } from "vite-plus/test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checks, utilities, wrappers } from "./access-helpers.mjs";

const convex = fileURLToPath(new URL("../../platform/convex/", import.meta.url));
const exportsOf = (module: string) =>
  [
    ...readFileSync(`${convex}${module}.ts`, "utf8").matchAll(
      /^export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)\s*(?:[=(<:])/gm,
    ),
  ]
    .map((match) => match[1]!)
    .filter((name) => {
      // Só funções: constantes como `READ_ROLES` ou validadores ficam de fora.
      const source = readFileSync(`${convex}${module}.ts`, "utf8");
      return new RegExp(
        `^export (?:async )?function ${name}\\b|^export const ${name}\\s*=\\s*(?:async\\s*)?\\(`,
        "m",
      ).test(source);
    })
    .sort();

const accessModules = readdirSync(`${convex}lib`)
  .filter((file) => /Access\.ts$/.test(file))
  .map((file) => `lib/${file.replace(/\.ts$/, "")}`)
  .sort();

it("classifica cada função exportada dos lib/*Access.ts como checagem ou utilitário", () => {
  expect(Object.keys({ ...checks, ...utilities }).sort()).toEqual(accessModules);
  for (const module of accessModules) {
    const classified = [
      ...(checks[module as keyof typeof checks] ?? []),
      ...(utilities[module as keyof typeof utilities] ?? []),
    ].sort();
    expect({ module, functions: classified }).toEqual({ module, functions: exportsOf(module) });
  }
});

it("não classifica a mesma função como checagem e utilitário", () => {
  for (const module of accessModules) {
    const both = (checks[module as keyof typeof checks] ?? []).filter((name) =>
      (utilities[module as keyof typeof utilities] ?? []).includes(name as never),
    );
    expect({ module, both }).toEqual({ module, both: [] });
  }
});

it("aponta cada wrapper para uma função exportada que existe", () => {
  for (const [module, names] of Object.entries(wrappers))
    for (const name of names) expect(exportsOf(module)).toContain(name);
});
