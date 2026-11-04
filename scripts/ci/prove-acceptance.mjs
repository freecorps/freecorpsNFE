// Prova de aceite recorrente: o grafo `validate` do CI, sem cache, e as
// fronteiras de pacote, com recibo da revisão, ambiente, comandos e hashes de
// log. Substitui os roteiros históricos das entregas 73, 74, 79 e 80; os
// recibos deles continuam em docs/v1.0/evidence (docs/desenvolvimento/ci.md).
//
//   bun scripts/ci/prove-acceptance.mjs [--base <ref>] [--output <dir>] [--input <arquivo>]...
import { acceptanceSteps, proofArguments, runProof } from "../lib/proof-runner.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

if (!process.versions.bun) throw new Error("Use Bun para a prova");
const root = repoRoot;
const options = proofArguments(process.argv.slice(2), { output: ".ci-results/acceptance" });
const receipt = runProof({
  root,
  proof: "acceptance",
  runner: "scripts/ci/prove-acceptance.mjs",
  output: options.output,
  base: options.base,
  inputs: options.inputs,
  uniqueAttempt: true,
  steps: acceptanceSteps(options.base),
});
if (receipt.result !== "passed") process.exitCode = 1;
