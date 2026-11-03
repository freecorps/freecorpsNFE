// Antecipa o gate de revisão do dono do `deploy.yml` (#51): roda ao lado do `validate`, sem
// credenciais de produção, e reprova a publicação em segundos em vez de depois da validação. Não
// substitui o gate: o publicador o repete no preflight, contra a revisão publicada naquele momento.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewGate } from "./lib/owner-review-gate.mjs";
import { releaseTarget } from "./lib/platform-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = releaseTarget(JSON.parse(readFileSync(join(root, "deploy/platform-release.json"))));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
await reviewGate({ root, sha, target, env: process.env });
console.log(`owner review: ${sha} may publish`);
