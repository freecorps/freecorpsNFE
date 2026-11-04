// Tarefa `ci:contracts` do grafo `validate`. Resolve a base da comparação de
// compatibilidade sem expansão de shell, que o Vite Task não faz no Windows:
// CONTRACT_BASE vem do workflow; sem ela (ou com o SHA nulo de um push novo),
// compara com HEAD^, como o job.
import { execFileSync, spawnSync } from "node:child_process";

const declared = process.env.CONTRACT_BASE?.trim();
const base =
  declared && !/^0+$/.test(declared)
    ? declared
    : execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
const result = spawnSync(
  process.execPath,
  ["scripts/contracts/generate-contracts.mjs", "--check", "--base", base],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
