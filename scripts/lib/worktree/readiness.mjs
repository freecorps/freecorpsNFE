/** Observação somente leitura; não exige dependências instaladas nem inicia serviços. */
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { readLocalConfig } from "./deployment.mjs";
import { fail } from "./exec.mjs";
import { readOperation, readOperationRecord, operationOwnerState } from "./operation.mjs";
import { currentRoot, worktreePaths } from "./paths.mjs";

export const DEFAULT_SETUP_TIMEOUT_MS = 600_000;

function setupStatus(control, operation, options) {
  const receipt = readOperationRecord(join(control.convexDir, "worktree-setup.json"));
  // O lock de um setup novo sempre prevalece sobre um resultado anterior.
  if (operation.command === "setup") {
    return {
      state: operation.state,
      runId: operation.runId,
      startedAt: operation.startedAt,
      finishedAt: null,
    };
  }
  if (operation.state === "indeterminate" && !operation.command)
    return { state: "indeterminate", runId: null };
  if (receipt.state === "absent") return { state: "unobserved", runId: null };
  if (
    receipt.state !== "recorded" ||
    receipt.version !== 1 ||
    receipt.command !== "setup" ||
    !receipt.runId ||
    !receipt.outcome ||
    !receipt.startedAt ||
    (receipt.outcome !== "running" && !receipt.finishedAt)
  )
    return { state: "indeterminate", runId: null };
  const state =
    receipt.outcome === "running"
      ? operationOwnerState(receipt, options) === "interrupted"
        ? "interrupted"
        : "indeterminate"
      : receipt.outcome;
  return {
    state,
    runId: receipt.runId,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
  };
}

export function readWorktreeStatus(root = currentRoot, options = {}) {
  const control = { root: resolve(root), convexDir: join(resolve(root), ".convex") };
  const operation = readOperation(control, options);
  let configuration;
  try {
    const paths = worktreePaths(root);
    const config = readLocalConfig(paths);
    configuration = { state: config ? "present" : "absent", app: paths.app };
  } catch {
    configuration = { state: "invalid", app: null };
  }
  return { version: 1, operation, setup: setupStatus(control, operation, options), configuration };
}

/** Espera o setup observado, ou o primeiro que aparecer. Não adota outra execução. */
export async function waitForSetup(
  root = currentRoot,
  { timeoutMs = DEFAULT_SETUP_TIMEOUT_MS, pollMs = 200, runId = null } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
    fail("--timeout-ms espera um inteiro não negativo.");
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) fail("pollMs espera um inteiro positivo.");
  const start = performance.now();
  // Zero mantém a consulta única do estado atual, sem entrar em polling.
  const options = timeoutMs === 0 ? {} : { deadlineMs: start + timeoutMs };
  let observed = runId;
  while (true) {
    const status = readWorktreeStatus(root, options);
    const setup = status.setup;
    if (!observed && setup.runId) observed = setup.runId;
    let outcome = null;
    if (observed && setup.runId !== observed) outcome = "indeterminate";
    else if (["succeeded", "failed", "interrupted"].includes(setup.state)) outcome = setup.state;
    const elapsed = performance.now() - start;
    const elapsedMs = Math.round(elapsed);
    // I/O síncrono pode exceder o prazo mesmo com a sonda limitada. Um estado
    // terminal lido depois dele não comprova conclusão dentro da espera.
    if (timeoutMs > 0 && elapsed >= timeoutMs)
      return { version: 1, outcome: "timeout", runId: observed, elapsedMs, status };
    if (outcome) return { version: 1, outcome, runId: observed, elapsedMs, status };
    if (elapsed >= timeoutMs)
      return {
        version: 1,
        outcome: setup.state === "indeterminate" ? "indeterminate" : "timeout",
        runId: observed,
        elapsedMs,
        status,
      };
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.min(pollMs, timeoutMs - elapsed)),
    );
  }
}

/** Dev conserva ambientes antigos e o reparo de deriva, mas não ignora setup falho. */
export async function waitForObservedSetup(root = currentRoot, options = {}) {
  let status = readWorktreeStatus(root);
  if (status.operation.command === "setup" && status.setup.state === "running") {
    console.log("Aguardando a preparação deste worktree…");
    const result = await waitForSetup(root, { ...options, runId: status.setup.runId });
    if (result.outcome !== "succeeded")
      fail(`A preparação não concluiu com sucesso (${result.outcome}). Consulte worktree status.`);
    status = result.status;
  }
  if (!["succeeded", "unobserved"].includes(status.setup.state))
    fail(
      `A preparação está em ${status.setup.state}. Consulte worktree status e conclua o setup antes do dev.`,
    );
}
