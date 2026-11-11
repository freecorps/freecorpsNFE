/**
 * Primitivas de processo: rodar comando, falar com o git, matar árvore de
 * processo. Tudo que o resto do módulo usa para tocar o sistema operacional
 * passa por aqui, então o comportamento no Windows fica num lugar só.
 */
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";

import { stopPosixNodeExecutors } from "./orphans.mjs";
import { isWindows } from "./paths.mjs";

/** Separa erro esperado de operador de crash de verdade na CLI. */
export class WorktreeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** @returns {never} */
export function fail(message) {
  throw new WorktreeError(message);
}

export function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
    timeout: options.timeoutMs,
    killSignal: options.timeoutMs === undefined ? undefined : "SIGKILL",
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT")
      fail(`O comando excedeu o limite de ${options.timeoutMs} ms.`);
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stderr ?? ""}${result.stdout ?? ""}`.trimEnd()
      : "";
    fail(`${command} ${args.join(" ")} falhou com código ${result.status}.${detail}`);
  }
  return result.stdout ?? "";
}

export function git(args, options = {}) {
  return commandResult("git", args, { ...options, capture: true }).trim();
}

/** Variante que não lança, para sondagem do tipo "essa branch existe?". */
export function tryGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

export function waitForExit(child) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

export function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM confirma um processo existente que não podemos sondar.
    return error.code !== "ESRCH";
  }
}

export async function stopProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (isWindows) {
    // O Windows não tem grupo de processo, então `taskkill /T` é o único jeito
    // de alcançar os filhos (Vite e Convex).
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  // O alvo é o GRUPO (`-pid`), não o processo. `bun x vite` e o CLI do Convex
  // são invólucros: matar só eles deixa o workerd e o backend local vivos,
  // segurando as portas reservadas — e o `worktree remove` apagaria o diretório
  // embaixo de um backend rodando. Os filhos nascem `detached` fora do Windows
  // (session/convex-local) exatamente para terem grupo próprio.
  const signalGroupThenSelf = (signal) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!signalGroupThenSelf("SIGTERM")) return;
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  signalGroupThenSelf("SIGKILL");
}

/**
 * O Convex sobe executores Node destacados que sobrevivem ao `convex dev` e ao
 * backend. No Windows seguram um handle no diretório do worktree, o que impede
 * a remoção; no macOS e no Linux são adotados pelo launchd/init e rodam para
 * sempre, segurando o runtime Node do worktree aberto.
 */
export function stopWorktreeNodeExecutors(nodeExecutable) {
  if (!isWindows) {
    stopPosixNodeExecutors(nodeExecutable);
    return;
  }
  if (!existsSync(nodeExecutable)) return;
  const escaped = nodeExecutable.replaceAll("'", "''");
  const script = [
    `$target = [IO.Path]::GetFullPath('${escaped}')`,
    "Get-CimInstance Win32_Process |",
    "Where-Object {",
    "  $_.ExecutablePath -and",
    "  [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target -and",
    "  $_.CommandLine -like '*cvx-node-executor*'",
    "} |",
    "ForEach-Object {",
    "  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** Bloqueia a thread sem busy loop; usado só enquanto se segura um lock. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Troca `destination` por `temporary` com rename, para que nenhum leitor veja o
 * arquivo pela metade. O Windows recusa a troca (EPERM, EACCES ou EBUSY)
 * enquanto outro processo lê o destino, o que `worktree status`, `wait` e
 * `list` fazem por alguns ms; a troca se repete a cada `waitMs` até `timeoutMs`.
 * O prazo, e não um número de tentativas, porque um leitor frequente recusa a
 * maioria das trocas. Esgotado o prazo, ou num erro de outro tipo, o temporário
 * sai e o erro sobe.
 */
export function replaceFileSync(temporary, destination, { timeoutMs = 2000, waitMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      renameSync(temporary, destination);
      return;
    } catch (error) {
      const transient = ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      if (!transient || Date.now() >= deadline) {
        rmSync(temporary, { force: true });
        throw error;
      }
      sleepSync(waitMs);
    }
  }
}
