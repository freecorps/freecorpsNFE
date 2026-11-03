import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";

if (!process.versions.bun) throw new Error("Execute com Bun fixado");
const path = "docs/v1.0/openapi.json";
const original = readFileSync(path);
const check = () =>
  spawnSync(process.execPath, ["scripts/generate-contracts.mjs", "--check"], { encoding: "utf8" });
assert.equal(check().status, 0, "Start with current artifacts");
let rejected;
try {
  // A valid JSON file with stale generated formatting must still fail the actual CI command.
  writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
  rejected = check();
  assert.notEqual(rejected.status, 0);
  assert.ok(rejected.stderr.includes(`Artefato desatualizado: ${path}`));
} finally {
  writeFileSync(path, original);
}
const restored = check();
assert.equal(restored.status, 0, restored.stderr);
mkdirSync(".ci-results/74", { recursive: true });
writeFileSync(
  ".ci-results/74/drift.json",
  JSON.stringify(
    {
      codeSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      command: "bun scripts/prove-contract-drift.mjs",
      staleArtifactExit: rejected.status,
      restoredExit: restored.status,
      result: "passed",
    },
    null,
    2,
  ) + "\n",
);
console.log("Artefato divergente recusado; bytes originais restaurados e check aprovado.");
