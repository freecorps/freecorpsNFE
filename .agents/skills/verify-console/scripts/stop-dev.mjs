// Encerra o dev que start-dev.mjs iniciou, pelo PID gravado e só se a
// identidade (criação e comando) ainda for a mesma. Primeiro pede a parada ao
// supervisor, que para o dev pela API e libera a trava do worktree; só se ele
// não sair no prazo encerra a árvore do PID. Nunca procura processos por nome e
// não toca num dev que já rodava antes da skill.
//
//   node .agents/skills/verify-console/scripts/stop-dev.mjs [--timeout-ms <n>]
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { processIsRunning } from "../../../../scripts/lib/worktree/exec.mjs";
import { readOperation } from "../../../../scripts/lib/worktree/operation.mjs";
import { worktreePaths } from "../../../../scripts/lib/worktree/paths.mjs";
import {
  readProcessIdentity,
  stopRecordedProcesses,
} from "../../../../scripts/lib/worktree/process-identity.mjs";
import { outputDirectory, stopDecision, stopRequestName } from "./lib.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Uso: node .agents/skills/verify-console/scripts/stop-dev.mjs [--timeout-ms <n>]\n" +
      `Encerra o PID gravado em ${outputDirectory}/dev.json, se for o mesmo processo.`,
  );
  process.exit(0);
}
const timeoutIndex = args.indexOf("--timeout-ms");
const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 60_000;
const recordFile = join(root, outputDirectory, "dev.json");
const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : null;
const identity = record?.pid ? readProcessIdentity(record.pid) : null;
const decision = stopDecision(record, identity);
console.log(`stop-dev: ${decision.reason}`);

let forced = false;
if (decision.stop) {
  writeFileSync(join(root, outputDirectory, stopRequestName), `${new Date().toISOString()}\n`);
  const deadline = Date.now() + timeoutMs;
  const same = () =>
    processIsRunning(record.pid) && readProcessIdentity(record.pid) === record.identity;
  while (same() && Date.now() < deadline) await delay(500);
  if (same()) {
    console.log(`stop-dev: o dev não saiu em ${timeoutMs} ms; encerrando a árvore do PID.`);
    await stopRecordedProcesses({
      pids: [record.pid],
      identities: { [record.pid]: record.identity },
    });
    forced = true;
  }
  rmSync(join(root, outputDirectory, stopRequestName), { force: true });
}
if (record?.startedBySkill) rmSync(recordFile, { force: true });

// A trava só fica para trás se o dev não parou por conta própria.
const operation = readOperation(worktreePaths(root));
if (decision.stop && operation.command === "dev" && operation.state === "interrupted")
  console.log(
    "stop-dev: a trava do dev ficou sem dono. Confira com bun run worktree:status que nenhum processo deste worktree roda e peça a quem cuida do checkout para removê-la.",
  );
else if (decision.stop) console.log(`stop-dev: dev encerrado${forced ? " à força" : ""}.`);
