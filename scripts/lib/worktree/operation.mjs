import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fail, processIsRunning } from "./exec.mjs";
import { readProcessIdentity } from "./process-identity.mjs";
import { normalizePath } from "./paths.mjs";

const owned = new Map();
const commands = new Set(["setup", "sync", "dev", "remove", "cleanup"]);

export function readOperationRecord(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      !commands.has(value.command) ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    )
      return { state: "indeterminate" };
    return {
      state: "recorded",
      version: value.version === 1 ? 1 : null,
      command: value.command,
      pid: value.pid,
      runId: /^[a-f0-9-]{36}$/.test(value.runId ?? "") ? value.runId : null,
      identity: /^[a-f0-9]{64}$/.test(value.identity ?? "") ? value.identity : null,
      startedAt: validDate(value.startedAt),
      finishedAt: validDate(value.finishedAt),
      outcome: ["running", "succeeded", "failed"].includes(value.outcome) ? value.outcome : null,
    };
  } catch (error) {
    return { state: error.code === "ENOENT" ? "absent" : "indeterminate" };
  }
}

function validDate(value) {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

export function operationOwnerState(record, options = {}) {
  if (!processIsRunning(record.pid)) return "interrupted";
  const actual = record.identity ? readProcessIdentity(record.pid, options) : null;
  if (!actual) return "indeterminate";
  return actual === record.identity ? "running" : "interrupted";
}

export function readOperation(paths, options = {}) {
  const record = readOperationRecord(lockPath(paths));
  if (record.state === "absent") return { state: "idle" };
  if (record.state !== "recorded") return record;
  const state = operationOwnerState(record, options);
  // A consulta de identidade pode levar tempo. O dono pode ter terminado
  // nesse intervalo; não descreva seu lock já liberado como interrompido.
  const latest = readOperationRecord(lockPath(paths));
  if (latest.state === "absent") return { state: "idle" };
  if (JSON.stringify(latest) !== JSON.stringify(record)) return { state: "indeterminate" };
  return { ...record, state };
}

export function ownsOperation(paths, allowedCommands) {
  const record = readOperationRecord(lockPath(paths));
  return (
    record.runId != null &&
    owned.get(normalizePath(paths.root)) === record.runId &&
    allowedCommands.includes(record.command)
  );
}

function writeSetupResult(paths, record) {
  if (readOperationRecord(lockPath(paths)).runId !== record.runId)
    fail("O lock mudou durante o setup. Resultado não publicado; consulte worktree:status.");
  const destination = join(paths.convexDir, "worktree-setup.json");
  const temporary = `${destination}.${record.runId}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
}

export function assertPrivateDirectories(paths) {
  for (const name of [
    "node_modules",
    ".convex",
    ".convex/worktree-app.json",
    "platform",
    "platform/.convex",
  ]) {
    const path = join(paths.root, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      fail(`Recusando operar sobre ${path}: remova a junção ou symlink sem seguir o destino.`);
    }
  }
}

function lockPath(paths) {
  return join(paths.convexDir, "worktree-operation.lock");
}

/**
 * Libera a trava de um `dev` cujo dono morreu sem soltá-la (parada forçada,
 * terminal fechado). Só apaga se a trava ainda for a lida em `expected` e o
 * dono continuar morto ou com outra identidade; dono vivo, identidade ilegível
 * ou trava trocada ficam como estão. Quem chama já encerrou os filhos
 * registrados. Devolve se apagou.
 */
export function releaseInterruptedDev(paths, expected) {
  const path = lockPath(paths);
  const current = readOperationRecord(path);
  if (
    current.state !== "recorded" ||
    current.command !== "dev" ||
    current.runId !== expected.runId ||
    current.pid !== expected.pid ||
    operationOwnerState(current) !== "interrupted"
  )
    return false;
  // Sem intervalo assíncrono entre a última leitura e a remoção.
  if (JSON.stringify(readOperationRecord(path)) !== JSON.stringify(current)) return false;
  try {
    unlinkSync(path);
  } catch (error) {
    // Outro cleanup simultâneo passou pela mesma conferência e já liberou.
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return true;
}

export function operationIsRunning(paths) {
  return runningOperation(paths) !== null;
}

/** Qualquer lock existente bloqueia, inclusive dono morto ou registro ilegível. */
export function runningOperation(paths) {
  const operation = readOperationRecord(lockPath(paths));
  return operation.state === "absent" ? null : (operation.command ?? "unknown");
}

export async function withOperation(paths, command, action) {
  assertPrivateDirectories(paths);
  mkdirSync(paths.convexDir, { recursive: true });
  const path = lockPath(paths);
  const record = {
    version: 1,
    runId: randomUUID(),
    pid: process.pid,
    identity: readProcessIdentity(process.pid),
    command,
    startedAt: new Date().toISOString(),
    outcome: "running",
  };
  try {
    writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = readOperationRecord(path);
    fail(
      `worktree:${owner.command ?? "desconhecido"} já está rodando ou deixou um lock sem conclusão. Consulte worktree:status; aguarde o dono ou confirme manualmente os processos antes de remover o lock. Use worktree:cleanup para parar um dev identificado ou liberar o lock de um dev que terminou sem soltá-lo.`,
    );
  }
  owned.set(normalizePath(paths.root), record.runId);
  let canRelease = command !== "setup";
  try {
    if (command === "setup") writeSetupResult(paths, record);
    const result = await action();
    if (command === "setup")
      writeSetupResult(paths, {
        ...record,
        outcome: "succeeded",
        finishedAt: new Date().toISOString(),
      });
    canRelease = true;
    return result;
  } catch (error) {
    // O resultado precede a liberação. Não persistimos mensagens de subprocessos,
    // que podem conter ambiente ou credenciais.
    if (command === "setup")
      writeSetupResult(paths, {
        ...record,
        outcome: "failed",
        finishedAt: new Date().toISOString(),
      });
    canRelease = true;
    throw error;
  } finally {
    // Sem resultado durável, preserve o lock para não expor um sucesso antigo.
    if (canRelease && readOperationRecord(path).runId === record.runId) unlinkSync(path);
    if (owned.get(normalizePath(paths.root)) === record.runId)
      owned.delete(normalizePath(paths.root));
  }
}
