// Prova recorrente da captura NF-e (entrega 78): validação geral, transporte
// TLS real em loopback com o bundle Node e a jornada de captura no navegador,
// tudo local e sintético. O recibo histórico está em docs/v1.0/evidence/78.
//
//   bun scripts/prove-capture.mjs [--base <ref>] [--output <dir>]
import { fileURLToPath } from "node:url";
import { acceptanceSteps, proofArguments, runProof } from "./lib/proof-runner.mjs";

if (!process.versions.bun) throw new Error("Use Bun para a prova");
const root = fileURLToPath(new URL("..", import.meta.url));
const options = proofArguments(process.argv.slice(2), { output: ".ci-results/78" });
const bundle = `${options.output}/local-tls.mjs`;
const receipt = runProof({
  root,
  proof: "capture",
  runner: "scripts/prove-capture.mjs",
  output: options.output,
  base: options.base,
  inputs: ["platform/convex/lib/captureSchema.ts", "tests/fixtures/nfe/4.00/manifest.json"],
  steps: [
    ...acceptanceSteps(options.base),
    {
      name: "bundle-tls",
      command: [
        "bun",
        "build",
        "scripts/prove-certificate-transport.ts",
        "--target",
        "node",
        "--outfile",
        bundle,
      ],
    },
    { name: "node-tls", command: ["node", bundle] },
    {
      name: "browser",
      command: ["node", "--experimental-strip-types", "apps/console/e2e/captures.mjs"],
    },
  ],
});
if (receipt.result !== "passed") process.exitCode = 1;
