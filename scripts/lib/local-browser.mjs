import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { worktreePaths } from "./worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./worktree/deployment.mjs";
import { currentLocalSiteUrl } from "./worktree/env-file.mjs";
import { assertLinkedWorktree } from "./worktree/state.mjs";
import { assertPrivateDirectories, runningOperation } from "./worktree/operation.mjs";
import { localBrowserIdentity, localBrowserIdentityPath } from "./local-browser-identity.mjs";

/** Prazo de cada chamada das jornadas; timeout não provoca reenvio de efeitos. */
export function localBrowserFetch(input, options = {}) {
  const timeout = AbortSignal.timeout(30_000);
  return fetch(input, {
    ...options,
    redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
}

/** Nunca segue redirecionamento, inclusive ao autenticar no backend local.
 * @param {{site: string, cloud: string, backendSite: string, deploymentName: string, adminKey: string, frontendRoot: string}} target
 * @param {(url: string, options: RequestInit) => Promise<Response>} fetcher
 */
export async function probeLocalBrowser(target, fetcher = fetch, timeoutMs = 5000) {
  const { site, cloud, backendSite, deploymentName, adminKey, frontendRoot } = target;
  for (const address of [site, cloud, backendSite]) {
    const url = new URL(address);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("O preflight do navegador exige URLs locais de loopback.");
  }
  const request = (url, options = {}) =>
    fetcher(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  const instance = await request(`${cloud}/instance_name`);
  if (!instance.ok || (await instance.text()).trim() !== deploymentName)
    throw new Error("O backend na porta reservada não corresponde ao worktree.");
  const identity = await request(`${cloud}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ path: "_system/frontend/listCronJobs", args: {}, format: "json" }),
  });
  if (!identity.ok || (await identity.json()).status !== "success")
    throw new Error("O backend local recusou a identidade deste worktree.");
  const frontend = await request(`${site}${localBrowserIdentityPath}`);
  if (!frontend.ok)
    throw new Error("O frontend local não oferece a sonda do worktree. Reinicie o dev.");
  const body = await frontend.json();
  if (
    body.schemaVersion !== 1 ||
    body.application !== "freecorps-console" ||
    body.rootId !== localBrowserIdentity(frontendRoot) ||
    body.convexUrl !== cloud ||
    body.authUrl !== backendSite ||
    body.apiUrl !== backendSite
  )
    throw new Error("O frontend não corresponde ao worktree e backend esperados.");
}

/** Exclusão do ensaio, independente do lock que o dev mantém durante a sessão. */
export function acquireLocalBrowserLock(directory, runId) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "browser.lock");
  try {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, pid: process.pid, runId }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      "Já existe uma jornada local em andamento ou interrompida. Confira browser.lock antes de repetir.",
    );
  }
  return () => {
    // Não recupera automaticamente lock antigo: ler e apagar permitiria apagar
    // um novo dono. Esta liberação pertence somente à execução que o criou.
    try {
      if (JSON.parse(readFileSync(path, "utf8")).runId === runId) unlinkSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

/**
 * Recibo separado dos relatórios de domínio. A trava pertence ao processo,
 * inclusive após complete(). SIGKILL deixa o recibo e o lock para inspeção.
 */
export async function beginLocalBrowser(root, journey) {
  const runId = randomUUID();
  const directory = join(root, ".browser-results", "runs", runId);
  mkdirSync(directory, { recursive: true });
  const started = performance.now();
  const report = {
    schemaVersion: 1,
    runId,
    journey,
    environment: "anonymous-local",
    startedAt: new Date().toISOString(),
    phase: "preflight",
    result: "running",
    durationMs: 0,
  };
  const save = () => {
    report.durationMs = Math.round(performance.now() - started);
    writeFileSync(
      join(directory, "preflight.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  };
  let release;
  let completed = false;
  const saveAfterFailure = () => {
    try {
      save();
    } catch {
      // O erro original continua sendo a causa; disco indisponível pode impedir o recibo.
      if (!Number(process.exitCode)) process.exitCode = 1;
    }
  };
  const onError = () => {
    report.result = "failed";
    saveAfterFailure();
  };
  const onExit = (code) => {
    if (code !== 0) report.result = "failed";
    else if (report.result === "running") report.result = "incomplete";
    if (report.phase === "journey") report.phase = "finished";
    try {
      release?.();
    } catch {
      report.result = "failed";
      if (!Number(process.exitCode)) process.exitCode = 1;
    }
    saveAfterFailure();
  };
  process.on("uncaughtExceptionMonitor", onError);
  process.once("exit", onExit);
  try {
    save();
    console.log(`Navegador: conferindo ${journey}. Recibo: ${join(directory, "preflight.json")}`);
    const paths = worktreePaths(root);
    assertLinkedWorktree(paths);
    assertPrivateDirectories(paths);
    if (paths.app !== "platform") throw new Error("Esta jornada exige um worktree da plataforma.");
    const operation = runningOperation(paths);
    if (operation !== null && operation !== "dev")
      throw new Error(
        "O worktree está em preparação ou estado indeterminado. Aguarde antes da jornada.",
      );
    release = acquireLocalBrowserLock(paths.convexDir, runId);
    const config = readLocalConfig(paths);
    const site = currentLocalSiteUrl(paths);
    if (!config || !site)
      throw new Error("Prepare o worktree e inicie bun run dev antes da jornada.");
    await probeLocalBrowser({
      site,
      cloud: localUrls(config).cloud,
      backendSite: localUrls(config).site,
      deploymentName: config.deploymentName,
      adminKey: config.adminKey,
      frontendRoot: paths.frontendRoot,
    });
    report.phase = "journey";
    save();
    return {
      complete(result) {
        if (completed) return;
        completed = true;
        report.result = result === "passed" && report.result !== "failed" ? "passed" : "failed";
        report.phase = "finished";
        try {
          save();
        } catch (error) {
          report.result = "failed";
          throw error;
        }
      },
    };
  } catch (error) {
    report.result = "failed";
    saveAfterFailure();
    if (report.phase === "preflight") {
      try {
        release?.();
        release = undefined;
      } catch {
        // O hook de saída ainda pode liberar a trava; não substitui o erro de preparação.
        if (!Number(process.exitCode)) process.exitCode = 1;
      }
    }
    // Não registra o corpo HTTP, chave administrativa ou mensagem bruta no recibo.
    throw error;
  }
}

/** O callback inclui preparação, recursos, diagnóstico e relatório de domínio.
 * Só seu retorno explícito "passed" aprova; a conclusão é tentada uma única vez.
 */
export async function withLocalBrowser(root, journey, callback) {
  const run = await beginLocalBrowser(root, journey);
  let result;
  let failed = false;
  let primaryError;
  try {
    result = await callback();
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  try {
    run.complete(failed ? "failed" : result);
  } catch (error) {
    if (!failed) {
      failed = true;
      primaryError = error;
    }
  }
  if (failed || result !== "passed") {
    if (!Number(process.exitCode)) process.exitCode = 1;
  }
  if (failed) throw primaryError;
  return result;
}
