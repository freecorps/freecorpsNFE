// Publishes the tarballs accepted on #83, exactly as `distribution:prove` produced them.
// The batch lists all packages or only some of them; each is checked against the proof.
// Usage: node scripts/distribution/publish-packages.mjs <accepted.json> [--dry-run]
// Requires `npm login` with the account of the `freecorps` organization; npm asks the
// 2FA code for each publication. Repeating it skips what is already published with the
// same bytes and stops on a published version with different bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const [acceptedPath] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
assert.ok(acceptedPath, "Informe o accepted.json do lote aceito na #83");
const accepted = JSON.parse(readFileSync(acceptedPath, "utf8"));
const proof = JSON.parse(readFileSync(".ci-results/83/tarballs.json", "utf8"));
assert.equal(proof.result, "passed", "A prova dos tarballs não passou");
assert.equal(proof.dirty, false, "A prova não veio de um checkout limpo");
assert.equal(proof.codeSha, accepted.codeSha, "Os tarballs não são da revisão aceita");

// npm refuses to run inside the repository (devEngines asks for Bun), so it runs elsewhere.
const npm = (args, inherit = false) => {
  const run = spawnSync("npm", args, {
    cwd: tmpdir(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: inherit ? "inherit" : "pipe",
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

// fiscal-core first: fiscal-nfe and fiscal-nfse depend on it. contracts stays private.
const order = [
  "@freecorps/fiscal-core",
  "@freecorps/fiscal-nfe",
  "@freecorps/fiscal-nfse",
  "@freecorps/freecorpsnfe-sdk",
];
// A batch may accept only part of the packages, such as the SDK under its new name;
// the others must already be on the registry with the bytes a previous batch accepted.
const names = accepted.packages.map((p) => p.name);
assert.ok(names.length > 0, "O accepted.json não lista pacotes");
assert.equal(new Set(names).size, names.length, "Pacote repetido no accepted.json");
for (const name of names) assert.ok(order.includes(name), `Pacote fora da publicação: ${name}`);
for (const name of order.filter((name) => names.includes(name))) {
  const { version, sha256 } = accepted.packages.find((p) => p.name === name);
  const proved = proof.artifacts.find((a) => a.name === name);
  assert.ok(proved && !proved.private, `Artefato sem prova publicável: ${name}`);
  assert.equal(version, proved.version, `Versão difere da prova: ${name}`);
  assert.equal(sha256, proved.tarballSha256, `Hash difere da prova: ${name}`);
  const tarball = resolve(".ci-results/83", `${name.slice(1).replace("/", "-")}-${version}.tgz`);
  const bytes = readFileSync(tarball);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, `Hash difere: ${name}`);
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const spec = `${name}@${version}`;
  const view = npm(["view", spec, "dist.integrity"]);
  const published = view.status === 0 ? view.stdout.trim() : "";
  if (view.status !== 0 && !/E404/.test(view.stderr)) throw new Error(view.stderr);
  if (published) {
    assert.equal(published, integrity, `${spec} já publicado com outros bytes`);
    console.log(`${spec} já publicado com os bytes aceitos.`);
    continue;
  }
  console.log(`${dryRun ? "Simulando" : "Publicando"} ${spec} (${sha256})`);
  const args = ["publish", tarball, "--access", "public", "--tag", "latest"];
  const run = npm(dryRun ? [...args, "--dry-run"] : args, true);
  if (run.status !== 0) throw new Error(`npm publish falhou para ${spec}`);
}
console.log(
  dryRun
    ? "Simulação concluída."
    : "Publicado. Prove: bun scripts/distribution/prove-distribution.mjs --registry",
);
