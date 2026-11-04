// Garante o dev deste worktree pronto para o navegador. Se ele já roda, só
// confere e registra que não é desta skill; senão inicia `bun run dev` em
// segundo plano e grava PID, identidade e log para stop-dev.mjs.
//
//   node .agents/skills/verify-console/scripts/start-dev.mjs [--timeout-ms <n>]
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { probeLocalBrowser } from "../../../../scripts/lib/local-browser.mjs";
import { readLocalConfig, localUrls } from "../../../../scripts/lib/worktree/deployment.mjs";
import { currentLocalSiteUrl } from "../../../../scripts/lib/worktree/env-file.mjs";
import { runningOperation } from "../../../../scripts/lib/worktree/operation.mjs";
import { worktreePaths } from "../../../../scripts/lib/worktree/paths.mjs";
import { readProcessIdentity } from "../../../../scripts/lib/worktree/process-identity.mjs";
import { assertLinkedWorktree, devIsRunning } from "../../../../scripts/lib/worktree/state.mjs";
import { outputDirectory } from "./lib.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Uso: node .agents/skills/verify-console/scripts/start-dev.mjs [--timeout-ms <n>]\n" +
      "Inicia ou reaproveita o dev do worktree e espera o frontend responder. Grava\n" +
      `${outputDirectory}/dev.json; stop-dev.mjs encerra só o que este script iniciou.`,
  );
  process.exit(0);
}
const timeoutIndex = args.indexOf("--timeout-ms");
const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 600_000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("--timeout-ms exige um número positivo");
  process.exit(2);
}

const paths = worktreePaths(root);
assertLinkedWorktree(paths);
if (paths.app !== "platform") throw new Error("A skill exige um worktree da plataforma.");
const output = join(root, outputDirectory);
mkdirSync(output, { recursive: true });
const recordFile = join(output, "dev.json");

const operation = runningOperation(paths);
if (operation !== null && operation !== "dev")
  throw new Error(
    `O worktree está em ${operation}. Aguarde com bun run worktree:wait e rode de novo.`,
  );

let record;
let exitCode = null;
if (devIsRunning(paths)) {
  record = { startedBySkill: false, startedAt: new Date().toISOString() };
  console.log("dev: já estava rodando neste worktree; a skill não vai encerrá-lo.");
} else {
  const log = join(output, "dev.log");
  const out = openSync(log, "a");
  // O supervisor chama o dev pela API e o para com um sinal de cancelamento, a
  // pedido de stop-dev.mjs. detached: fora do Windows, ele lidera o próprio grupo.
  const child = spawn("bun", [join(root, ".agents/skills/verify-console/scripts/dev-supervisor.mjs")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  child.once("exit", (code) => (exitCode = code ?? 1));
  const identity = readProcessIdentity(child.pid);
  if (!identity) throw new Error(`Não consegui ler a identidade do PID ${child.pid}.`);
  record = {
    startedBySkill: true,
    pid: child.pid,
    identity,
    log: `${outputDirectory}/dev.log`,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`dev: iniciado no PID ${child.pid}; log em ${record.log}`);
}

// Pronto é o preflight do navegador passar: backend deste worktree e frontend
// com a sonda que aponta para ele.
const deadline = Date.now() + timeoutMs;
let lastError = "";
for (;;) {
  const config = readLocalConfig(paths);
  const site = currentLocalSiteUrl(paths);
  if (config && site) {
    try {
      await probeLocalBrowser({
        site,
        cloud: localUrls(config).cloud,
        backendSite: localUrls(config).site,
        deploymentName: config.deploymentName,
        adminKey: config.adminKey,
        frontendRoot: paths.frontendRoot,
      });
      record.site = site;
      record.readyAt = new Date().toISOString();
      writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`dev: pronto em ${site}`);
      break;
    } catch (error) {
      lastError = error.message;
    }
  }
  // O dev que a skill iniciou saiu antes de ficar pronto: o motivo está no log.
  if (exitCode !== null) {
    console.error(`dev: saiu com código ${String(exitCode)} antes de ficar pronto. Veja ${record.log}.`);
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.error(
      `dev: não ficou pronto em ${timeoutMs} ms. Último erro: ${lastError || "sem configuração local"}`,
    );
    process.exit(1);
  }
  await delay(2000);
}
