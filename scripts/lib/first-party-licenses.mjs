import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const packageLicenses = {
  "@freecorps/contracts": "SEE LICENSE IN LICENSING.md",
  "@freecorps/fiscal-core": "SEE LICENSE IN LICENSING.md",
  "@freecorps/fiscal-nfe": "SEE LICENSE IN LICENSING.md",
  "@freecorps/fiscal-nfse": "SEE LICENSE IN LICENSING.md",
  "@freecorps/freecorpsnfe-sdk": "MIT",
};
export function firstPartyScope() {
  return JSON.parse(readFileSync("docs/licenses/first-party.json", "utf8"));
}
export function assertDeclaredMitScope(path, source) {
  const scope = firstPartyScope();
  if (/^\/\/ SPDX-License-Identifier: MIT\s*$/m.test(source) && source.includes(scope.licensor))
    assert.ok(scope.mit.files.includes(path), "Concessão MIT própria fora da lista: " + path);
}
export function packageLicenseText(name) {
  assert.ok(Object.hasOwn(packageLicenses, name), "Pacote sem política de licença");
  const scope = firstPartyScope();
  return readFileSync(
    name === "@freecorps/freecorpsnfe-sdk" ? scope.mit.text : scope.default.text,
    "utf8",
  ).replaceAll("\r\n", "\n");
}
export function assertMitSources(paths) {
  assert.ok(paths.length > 0, "Grafo MIT vazio");
  const permitted = new Set(firstPartyScope().mit.files);
  for (const path of paths) {
    const source = relative(resolve("."), resolve(path)).replaceAll("\\", "/");
    assert.ok(permitted.has(source), "Fonte fora do escopo MIT do SDK: " + source);
  }
}
export function assertSdkDeclarations(paths) {
  const declarations = paths.filter((path) => path.startsWith("types/"));
  assert.ok(declarations.length > 0, "SDK sem declarações");
  for (const path of declarations) {
    assert.ok(path.endsWith(".d.ts"), "Arquivo inesperado nos tipos do SDK");
    assertMitSources(["packages/" + path.slice("types/".length).replace(/\.d\.ts$/, ".ts")]);
  }
}
