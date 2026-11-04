// Valida a árvore em edição com o mesmo grafo do aceite. HEAD é referência,
// não o conteúdo validado. Cache é permitido apenas nas tarefas elegíveis.
import { acceptanceSteps, proofArguments, runLocalValidation } from "../lib/proof-runner.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

if (!process.versions.bun) throw new Error("Use Bun para a validação local");
const root = repoRoot;
const options = proofArguments(process.argv.slice(2), { output: ".ci-results/local" });
const receipt = runLocalValidation({
  root,
  proof: "local",
  runner: "scripts/ci/validate-local.mjs",
  output: options.output,
  base: options.base,
  inputs: options.inputs,
  steps: acceptanceSteps(options.base, { cache: true }),
});
if (receipt.result !== "passed") process.exitCode = 1;
