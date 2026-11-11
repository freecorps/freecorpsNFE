/**
 * O que acontece DENTRO de um worktree: `setup`, `dev` e `cleanup`.
 *
 * O `dev` sobe dois processos (Convex e Vite) e grava os PIDs, porque parar por
 * padrão de nome mataria o `bun dev` do checkout principal junto.
 */
import { spawnOwnedProcess } from "./owned-process.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { worktreeConvexPorts, worktreeSiteUrl } from "../worktree-local.ts";
import {
  localPortArgs,
  runConvexStreaming,
  ensureLocalNode,
  spawnConvexDev,
  stopWorktreeBackends,
  waitForBackend,
  syncBackendEnvironment,
} from "./convex-local.mjs";
import { readLocalConfig } from "./deployment.mjs";
import { reapDeletedWorktrees } from "./orphans.mjs";
import {
  ensureBackendEnvFile,
  readEnvFile,
  writeBlockedRuntimeEnv,
  writeRuntimeEnv,
} from "./env-file.mjs";
import { commandResult, fail, stopWorktreeNodeExecutors, waitForExit } from "./exec.mjs";
import {
  assertPrivateDirectories,
  ownsOperation,
  readOperation,
  releaseInterruptedDev,
  withOperation,
} from "./operation.mjs";
import { waitForObservedSetup } from "./readiness.mjs";
import {
  bunExecutable,
  currentRoot,
  isWindows,
  requestedWorktreeApp,
  worktreePaths,
} from "./paths.mjs";
import { resolveConvexPort, resolveFrontendPort } from "./registry.mjs";
import { readProcessIdentity, stopRecordedProcesses } from "./process-identity.mjs";
import { assertLegacySeedProfile, syncWorktree } from "./sync.mjs";
import {
  assertLinkedWorktree,
  assertPlatformWorktree,
  devIsRunning,
  doctor,
  readProcessRecord,
  recordIsForThisWorktree,
  removeProcessRecordFor,
  writeProcessRecord,
} from "./state.mjs";

const FRONTEND_START_ATTEMPTS = 5;
const FRONTEND_START_TIMEOUT_MS = 120_000;

// O Vite imprime a porta em negrito, então a URL de "pronto" só casa depois de
// tirar as sequências SGR: `http://localhost:\e[1m5174\e[22m/`.
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE, "");
}

function frontendEnv(paths) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(ACCOUNT_|AUTH_PROXY_|CONVEX_|VITE_|FNFE_|RESEND_|VALIDATION_|BETTER_AUTH_|CLOUDFLARE_|MAIL_|CLERK_|APP_ENV$|PRODUCT_ENV$|FISCAL_ENV$|SITE_URL$|EMAIL_|WEBHOOK_)/.test(
        key,
      )
    )
      delete env[key];
  }
  for (const [name, value] of readEnvFile(paths.runtimeEnv)) {
    env[name] = value;
  }
  return env;
}

function spawnFrontend(paths, port) {
  const child = spawnOwnedProcess(
    bunExecutable,
    // Sem --host, o frontend permanece em loopback.
    ["run", "--", "vp", "dev", "--port", String(port), "--strictPort"],
    {
      cwd: paths.frontendRoot,
      env: frontendEnv(paths),
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWindows,
    },
    paths.nodeExecutable,
  );

  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => console.error(error));
  return child;
}

function waitForFrontendStart(child, siteUrl, timeoutMs = FRONTEND_START_TIMEOUT_MS) {
  return new Promise((resolveStart) => {
    let output = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      resolveStart({ ...result, output });
    };
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-16_000);
      if (stripAnsi(output).includes(`${siteUrl}/`)) {
        finish({ status: "started" });
      }
    };
    const onError = (error) => finish({ error, status: "error" });
    const onExit = (code, signal) => finish({ code, signal, status: "exited" });
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/** Só troca de vaga se a colisão for na porta deste frontend. */
function isPortBindCollision(output, port) {
  const text = stripAnsi(output);
  if (!/(?:address already in use|EADDRINUSE|is already in use)/i.test(text)) {
    return false;
  }
  return [port].some((candidate) => new RegExp(`[:\\s]${candidate}\\b`).test(text));
}

/** Reescreve as URLs se outra aplicação tomar a porta antes do bind. */
async function startFrontendWithRetry(paths, config, trackFrontend) {
  const exclude = [];
  for (let attempt = 1; attempt <= FRONTEND_START_ATTEMPTS; attempt += 1) {
    const port = await resolveFrontendPort(paths.root, { exclude });
    const siteUrl = worktreeSiteUrl(port);
    ensureBackendEnvFile(paths, siteUrl);
    writeRuntimeEnv(paths, config, siteUrl);
    syncBackendEnvironment(paths);
    console.log(`Subindo o frontend do freecorpsNFE em ${siteUrl}`);
    const child = spawnFrontend(paths, port);
    if (!child.pid) fail("Não consegui iniciar o processo do Vite.");

    const ownedFrontend = {
      pids: [child.pid],
      identities: { [child.pid]: readProcessIdentity(child.pid) },
    };
    // Registra a propriedade antes que a prontidão ou a limpeza possam falhar. Se
    // a parada deste frontend não se confirmar, o registro mantém os dois filhos.
    trackFrontend(ownedFrontend);
    const result = await waitForFrontendStart(child, siteUrl);
    if (result.status === "started") return { child, port, siteUrl, processRecord: ownedFrontend };

    await stopRecordedProcesses(ownedFrontend);
    const canRetry =
      result.status === "exited" &&
      isPortBindCollision(result.output, port) &&
      attempt < FRONTEND_START_ATTEMPTS;
    if (canRetry) {
      console.warn(
        `A porta ${port} foi tomada antes de o Vite ligar nela; tentando de novo (${attempt}/${FRONTEND_START_ATTEMPTS}).`,
      );
      exclude.push(port);
      continue;
    }

    if (result.status === "timeout") {
      fail(`Esgotou o tempo esperando o Vite subir em ${siteUrl}.`);
    }
    const detail =
      result.error instanceof Error
        ? result.error.message
        : (result.signal ?? result.code ?? "desconhecido");
    fail(`O Vite saiu antes de subir em ${siteUrl} (${detail}).`);
  }

  fail(
    `O Vite não conseguiu ligar numa porta de frontend em ${FRONTEND_START_ATTEMPTS} tentativas.`,
  );
}

export async function setup(options = {}) {
  let paths = worktreePaths(options.root);
  assertLinkedWorktree(paths);
  assertPrivateDirectories(paths);
  // O T3 Code roda o setup a cada worktree novo: cada um limpa o que os
  // anteriores deixaram quando foram apagados sem `worktree:cleanup`.
  reapDeletedWorktrees(paths.root);
  const app = requestedWorktreeApp(paths, options.app);
  if (app !== undefined) {
    if (app !== "platform")
      fail(
        "O backoffice legado foi aposentado na #345; worktrees preparam só a plataforma (`--app platform` ou sem `--app`).",
      );
    if (app !== paths.app) {
      if (devIsRunning(paths) || existsSync(paths.localConfig))
        fail("Use outra worktree para mudar de aplicativo; este banco ja foi preparado.");
    }
    if (app !== paths.app || !existsSync(paths.appFile)) {
      mkdirSync(paths.convexDir, { recursive: true });
      writeFileSync(paths.appFile, JSON.stringify({ app }));
      paths = worktreePaths(options.root);
    }
  }
  assertPlatformWorktree(paths);
  assertLegacySeedProfile(options.profile);

  // Mesma trava do `dev`, e pelo mesmo motivo invertido: rodar o setup por cima
  // de um worktree vivo faria a sondagem achar a porta do próprio Vite ocupada
  // e migrar o worktree para outra vaga — reescrevendo `.env.local` e o
  // `SITE_URL` embaixo de um servidor que continua servindo a origem antiga —,
  // e o CLI do Convex derrubaria o backend com que aquele `dev` está falando.
  if (devIsRunning(paths)) {
    fail(
      "Este worktree tem um processo de dev rodando. Pare com `bun run worktree:cleanup` antes de rodar o setup de novo.",
    );
  }

  console.log("Preparando worktree isolado do freecorpsNFE…");
  if (options.install !== false) {
    const required = JSON.parse(readFileSync(join(paths.root, "package.json"), "utf8")).devEngines
      ?.packageManager?.version;
    const actual = commandResult(bunExecutable, ["--version"], { capture: true }).trim();
    if (required && actual !== required)
      fail(
        `Este projeto fixa Bun ${required}; o comando está usando ${actual}. Use a versão fixada antes do setup.`,
      );
  }
  if (options.install !== false) {
    commandResult(bunExecutable, ["install", "--frozen-lockfile"], {
      cwd: paths.root,
    });
  }
  console.log(`Usando ${ensureLocalNode(paths)} para as actions locais do Convex.`);

  // Um backend que sobrou de um setup ou dev interrompido segura a porta deste
  // worktree; sem encerrá-lo, a reserva migraria para outro par.
  await stopWorktreeBackends(paths);
  const port = await resolveFrontendPort(paths.root, { preferred: options.port });
  const siteUrl = worktreeSiteUrl(port);
  const convexPorts = worktreeConvexPorts(
    await resolveConvexPort(paths.root, {
      preferred: readLocalConfig(paths)?.ports.cloud,
    }),
  );
  console.log(`Reservei ${siteUrl} e as portas Convex ${convexPorts.cloud}/${convexPorts.site}.`);

  mkdirSync(paths.convexDir, { recursive: true });
  let config = readLocalConfig(paths);
  if (!config) {
    try {
      writeFileSync(
        paths.runtimeEnv,
        `CONVEX_DEPLOYMENT=anonymous:anonymous-fnfe-${randomUUID()}\n`,
      );
      const created = await runConvexStreaming(paths, [
        "dev",
        "--once",
        "--skip-push",
        "--env-file",
        paths.runtimeEnv,
        "--typecheck",
        "disable",
        ...localPortArgs(convexPorts),
      ]);
      if (created.code !== 0) fail("Falhou a criação do Convex local.");
    } catch (error) {
      await stopWorktreeBackends(paths);
      writeBlockedRuntimeEnv(paths, siteUrl);
      throw error;
    }
    // `dev --once --skip-push` sai com código 0 e deixa o backend vivo.
    await stopWorktreeBackends(paths);
    config = readLocalConfig(paths);
    if (!config) fail("O Convex não criou um deployment local do projeto.");
  }

  ensureBackendEnvFile(paths, siteUrl);
  writeRuntimeEnv(paths, config, siteUrl);

  await syncWorktree(paths, { siteUrl });
  stopWorktreeNodeExecutors(paths.nodeExecutable);
  doctor(paths);
  console.log("");
  console.log(`Worktree pronto em ${siteUrl}: bun run dev`);
  return { paths, port, siteUrl };
}

export async function dev(options = {}) {
  assertLinkedWorktree({ root: options.root ?? currentRoot });
  await waitForObservedSetup(options.root, { timeoutMs: options.timeoutMs });
  // Setup pode escolher o aplicativo enquanto esperamos. Derive os caminhos
  // novamente antes da exclusão, e confira o resultado depois de adquiri-la.
  return withOperation(worktreePaths(options.root), "dev", async () => {
    await waitForObservedSetup(options.root, { timeoutMs: options.timeoutMs });
    return runDev(options);
  });
}

async function runDev(options) {
  const paths = worktreePaths(options.root);
  assertLinkedWorktree(paths);
  assertPlatformWorktree(paths);
  if (devIsRunning(paths)) {
    fail("Este worktree já tem um processo de dev rodando.");
  }

  // Só o deployment é pré-requisito — de propósito. Gatear no `doctor` inteiro
  // recusava por deriva no `.env.local` que este mesmo comando reescreve logo
  // abaixo (`startFrontendWithRetry` → `writeRuntimeEnv`), e em modo quiet a
  // mensagem era um número de checks sem dizer qual. Quem quiser o relatório
  // roda `bun run worktree doctor`.
  const existingConfig = readLocalConfig(paths);
  if (!existingConfig) {
    fail(
      "Este worktree não tem deployment local do Convex. Rode `bun run worktree:setup` primeiro.",
    );
  }
  if (existsSync(paths.processFile)) rmSync(paths.processFile, { force: true });
  // Sobra de um dev morto sem limpeza (SIGKILL no terminal, por exemplo).
  await stopWorktreeBackends(paths);

  // Prefira o par que o deployment já ligou, para fixar um worktree existente
  // não movê-lo de portas que nunca estiveram em conflito.
  const convexPorts = worktreeConvexPorts(
    await resolveConvexPort(paths.root, {
      preferred: existingConfig.ports.cloud,
    }),
  );
  await syncWorktree(paths);
  options.signal?.throwIfAborted();
  const convexChild = spawnConvexDev(paths, convexPorts);
  if (!convexChild.pid) fail("Não consegui iniciar o processo do Convex.");
  convexChild.on("error", (error) => console.error(error));

  let startingRecord = writeProcessRecord(paths, {
    cwd: paths.root,
    pid: convexChild.pid,
    pids: [convexChild.pid],
    startedAt: new Date().toISOString(),
  });

  // A config lida antes de subir fica velha no instante em que o Convex escreve
  // as portas que de fato ligou; escrever o `.env.local` a partir dela é o que
  // apontava o frontend de um worktree para o backend de outro.
  let config;
  try {
    config = await waitForBackend(paths, convexChild, { ports: convexPorts });
  } catch (error) {
    await stopRecordedProcesses(startingRecord);
    removeProcessRecordFor(paths, convexChild.pid, startingRecord.recordId);
    throw error;
  }

  let frontend;
  try {
    frontend = await startFrontendWithRetry(paths, config, (record) => {
      startingRecord = writeProcessRecord(
        paths,
        {
          cwd: paths.root,
          pid: convexChild.pid,
          pids: [convexChild.pid, ...record.pids],
          startedAt: startingRecord.startedAt,
        },
        { [convexChild.pid]: startingRecord.identities[convexChild.pid], ...record.identities },
      );
    });
  } catch (error) {
    await stopRecordedProcesses(startingRecord);
    removeProcessRecordFor(paths, convexChild.pid, startingRecord.recordId);
    throw error;
  }

  const { child: frontendChild, port, siteUrl } = frontend;
  const ownedRecord = writeProcessRecord(
    paths,
    {
      cwd: paths.root,
      pid: convexChild.pid,
      pids: [convexChild.pid, frontendChild.pid],
      port,
      siteUrl,
      startedAt: new Date().toISOString(),
    },
    { ...startingRecord.identities, ...frontend.processRecord.identities },
  );

  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      await stopRecordedProcesses(ownedRecord);
      let timeout;
      try {
        await Promise.race([
          Promise.all([waitForExit(convexChild), waitForExit(frontendChild)]),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("DEV_EXIT_PENDING")), 10000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    })();
    return stopping;
  };
  let rejectStop;
  const stopFailure = new Promise((_, reject) => {
    rejectStop = reject;
  });
  const onStop = () => {
    void stop().catch(rejectStop);
  };
  if (!options.signal) {
    process.on("SIGINT", onStop);
    process.on("SIGTERM", onStop);
  }
  options.signal?.addEventListener("abort", onStop, { once: true });
  try {
    const exited = Promise.race([
      waitForExit(convexChild).then((exit) => ({ process: "Convex", ...exit })),
      waitForExit(frontendChild).then((exit) => ({ process: "Vite", ...exit })),
    ]);
    if (options.signal?.aborted) await stop();
    else options.onReady?.();
    const result = await Promise.race([exited, stopFailure]);
    const unexpected = !stopping;
    await stop();
    if (unexpected) fail(`${result.process} saiu sem ser pedido.`);
  } finally {
    // Os handlers saem mesmo se a parada falhar; o registro só sai se ela
    // terminar, para um cleanup posterior repetir.
    try {
      await stop();
      removeProcessRecordFor(paths, convexChild.pid, ownedRecord.recordId);
    } finally {
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
      options.signal?.removeEventListener("abort", onStop);
    }
  }
}

async function stopOrphanBackends(paths, quiet) {
  const stopped = await stopWorktreeBackends(paths);
  if (stopped.length > 0 && !quiet) {
    console.log(`Parei o backend Convex local órfão deste worktree (PID ${stopped.join(", ")}).`);
  }
}

/** Para o que ESTE worktree registrou, sem encostar nos outros. */
export async function cleanup(options = {}) {
  const paths = worktreePaths(options.root);
  assertLinkedWorktree(paths);
  assertPrivateDirectories(paths);
  const operation = readOperation(paths);
  if (operation.command === "dev") {
    if (operation.state === "interrupted") {
      // O dono morreu sem soltar o lock (parada forçada, terminal fechado):
      // encerra os filhos que ele registrou, apaga o registro e libera o lock,
      // se ainda for o mesmo. Um filho que não para mantém tudo como está.
      await stopDevRecord(paths, options.quiet);
      if (releaseInterruptedDev(paths, operation) && !options.quiet)
        console.log("Liberei o lock de um dev que terminou sem soltá-lo.");
      return;
    }
    // O dono continua segurando o lock enquanto encerramos somente os filhos
    // registrados. Não varremos executores ou backends neste caminho.
    await stopDevRecord(paths, options.quiet, operation);
    return;
  }
  const sweep = async () => {
    const currentPaths = worktreePaths(paths.root);
    await stopDevRecord(currentPaths, options.quiet);
    await stopOrphanBackends(currentPaths, options.quiet);
    stopWorktreeNodeExecutors(currentPaths.nodeExecutable);
    reapDeletedWorktrees(currentPaths.root, { quiet: options.quiet });
  };
  // `remove` já possui exclusão nesta mesma execução. Não libera nem readquire.
  if (ownsOperation(paths, ["remove"])) return sweep();
  if (operation.state !== "idle") {
    if (!options.quiet)
      console.log(
        "Limpeza de órfãos adiada: outra operação possui o lock. Consulte worktree status.",
      );
    return;
  }
  return withOperation(paths, "cleanup", sweep);
}

async function stopDevRecord(paths, quiet, expectedOperation) {
  const record = readProcessRecord(paths);
  if (!record) return;
  if (!recordIsForThisWorktree(record, paths)) {
    fail("Recusando parar um processo registrado para outro worktree.");
  }

  if (expectedOperation) {
    const current = readOperation(paths);
    if (
      current.runId !== expectedOperation.runId ||
      current.pid !== expectedOperation.pid ||
      current.command !== "dev"
    )
      return;
  }

  const running = await stopRecordedProcesses(record);
  if (running.length > 0) {
    if (!quiet) {
      console.log(`Parei os processos de dev do worktree ${running.join(", ")}.`);
    }
  }
  // Sem lock próprio, o dev proprietário remove seu registro antes de liberar
  // a operação. Comparar e apagar aqui poderia remover o registro do próximo dev.
  if (!expectedOperation) {
    if (record.recordId) removeProcessRecordFor(paths, record.pid, record.recordId);
    else if (JSON.stringify(readProcessRecord(paths)) === JSON.stringify(record)) {
      // Registro antigo não tem geração. Compara o registro inteiro sob o lock
      // da operação, sem intervalo assíncrono antes de remover.
      rmSync(paths.processFile, { force: true });
    }
  }
}
