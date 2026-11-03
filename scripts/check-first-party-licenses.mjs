import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  firstPartyScope,
  packageLicenseText,
  assertDeclaredMitScope,
} from "./lib/first-party-licenses.mjs";

const scope = firstPartyScope();
assert.equal(scope.schema, 1);
assert.equal(scope.default.id, "LicenseRef-Freecorps-Source-Available-1.0");
assert.equal(scope.default.text, "LICENSE");
assert.equal(scope.mit.text, "LICENSES/MIT.txt");
assert.equal(scope.licensor, "FREECORPS TECNOLOGIA DA INFORMACAO LTDA");
assert.equal(scope.cnpj, "63.113.119/0001-90");
const normalize = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const license = normalize(scope.default.text);
assert.ok(license.includes(scope.default.id) && license.includes(scope.licensor));
assert.ok(license.includes(scope.cnpj));
assert.ok(
  !/PolyForm|polyformproject\.org/i.test(license),
  "Licença adaptada precisa de nome próprio",
);
for (const file of scope.mit.files) {
  const source = normalize(file);
  assert.ok(source.includes("SPDX-License-Identifier: MIT"), "Cabeçalho MIT ausente: " + file);
  assert.ok(source.includes(scope.licensor), "Titular ausente: " + file);
}
for (const path of scope.mit.documentation) normalize(path);
assert.equal(new Set(scope.mit.files).size, scope.mit.files.length);
const sources = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*.ts",
    "*.tsx",
    "*.js",
    "*.mjs",
    "*.cjs",
  ],
  { encoding: "utf8", windowsHide: true },
)
  .split("\0")
  .filter(Boolean);
for (const path of sources) assertDeclaredMitScope(path, normalize(path));
const publishedDirectories = new Set([
  "packages/fiscal-core",
  "packages/fiscal-nfe",
  "packages/fiscal-nfse",
]);
for (const directory of [
  ".",
  "platform",
  "apps/console",
  "apps/docs",
  "packages/contracts",
  "packages/fiscal-core",
  "packages/fiscal-nfe",
  "packages/fiscal-nfse",
  "packages/sdk",
]) {
  const manifest = JSON.parse(normalize(directory + "/package.json"));
  // The fiscal packages publish their own directory, accepted on #83 on 01/11/2026.
  // contracts and sdk publish the generated dist; their sources stay private.
  if (publishedDirectories.has(directory)) {
    assert.equal(manifest.private, undefined, "Pacote aceito publica pelo próprio diretório");
    assert.deepEqual(manifest.publishConfig, { access: "public" }, "Pacote aceito é público");
  } else assert.equal(manifest.private, true, "Diretório não aceito para publicação");
  assert.equal(
    manifest.license,
    directory === "packages/sdk" ? "MIT" : "SEE LICENSE IN LICENSING.md",
  );
  normalize(directory + "/LICENSING.md");
}
assert.equal(normalize("packages/contracts/LICENSE"), license);
assert.equal(normalize("packages/contracts/LICENSE-MIT"), normalize(scope.mit.text));
for (const name of ["fiscal-core", "fiscal-nfe", "fiscal-nfse", "sdk"])
  assert.equal(
    normalize("packages/" + name + "/LICENSE"),
    packageLicenseText("@freecorps/" + name),
  );
console.log("Licenças próprias, escopo MIT e manifests conferidos.");
