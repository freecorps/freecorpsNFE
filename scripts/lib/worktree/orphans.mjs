import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { sleepSync } from "./exec.mjs";
import { resolveWorktreesRoot } from "./location.mjs";
import { defaultWorktreesRoot, isWindows } from "./paths.mjs";
import { mainWorktreePath } from "./registry.mjs";

/**
 * Editores e agentes apagam o diretório do worktree sem rodar
 * `worktree:cleanup` antes (o T3 Code só tem gancho de criação). O backend
 * Convex, os executores Node destacados e o Vite continuam rodando de um
 * diretório que não existe mais e seguram os arquivos apagados abertos: o
 * espaço em disco nunca volta e o `du` não enxerga.
 *
 * Estes são os diretórios cujos filhos são worktrees deste checkout.
 */
export function worktreeParentDirs(mainRoot, home = homedir()) {
  const main = resolve(mainRoot);
  return [
    join(home, ".t3", "worktrees", basename(main)),
    defaultWorktreesRoot(main),
    join(main, ".claude", "worktrees"),
    join(main, ".codex", "worktrees"),
  ];
}

/** O worktree em que `path` está, quando fica sob um dos `parents`. */
export function owningWorktree(path, parents) {
  if (!path || !isAbsolute(path)) return null;
  for (const parent of parents) {
    const rel = relative(parent, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    return join(parent, rel.split(sep)[0]);
  }
  return null;
}

/**
 * Processos cujo executável ou diretório de trabalho pertence a um worktree
 * apagado. `processes` é `[{ pid, paths: string[] }]`.
 */
export function findOrphanedProcesses(processes, parents, exists = existsSync) {
  const orphans = [];
  for (const { pid, paths } of processes) {
    if (pid === process.pid || pid === process.ppid) continue;
    for (const path of paths) {
      const worktree = owningWorktree(path, parents);
      if (worktree && !exists(worktree)) {
        orphans.push({ pid, worktree });
        break;
      }
    }
  }
  return orphans;
}

/** Converte a saída de `lsof -F pn` em pid -> caminho. */
export function parseLsofFields(output) {
  const byPid = new Map();
  let pid = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) byPid.set(pid, line.slice(1));
  }
  return byPid;
}

function run(command, args) {
  // O lsof sai com 1 quando não consegue inspecionar algum processo, mas imprime o resto.
  return spawnSync(command, args, { encoding: "utf8" }).stdout ?? "";
}

/** Todo processo do usuário atual, com executável e diretório de trabalho. */
export function listUserProcesses() {
  if (isWindows) return [];
  const uid = String(process.getuid());

  if (process.platform === "linux") {
    const processes = [];
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid)) continue;
      const paths = [];
      for (const link of ["exe", "cwd"]) {
        try {
          // Alvo apagado volta como "/caminho (deleted)".
          paths.push(readlinkSync(`/proc/${pid}/${link}`).replace(/ \(deleted\)$/, ""));
        } catch {
          // Processo de outro usuário, ou já saiu.
        }
      }
      if (paths.length > 0) processes.push({ pid, paths });
    }
    return processes;
  }

  // macOS: `comm` é o caminho completo do executável; o lsof dá o cwd, mesmo
  // quando o diretório foi apagado.
  const byPid = new Map();
  for (const line of run("ps", ["-U", uid, "-o", "pid=,comm="]).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) byPid.set(Number(match[1]), [match[2].trim()]);
  }
  const cwds = parseLsofFields(run("lsof", ["-a", "-u", uid, "-d", "cwd", "-F", "pn"]));
  for (const [pid, cwd] of cwds) byPid.set(pid, [...(byPid.get(pid) ?? []), cwd]);
  return [...byPid].map(([pid, paths]) => ({ pid, paths }));
}

/** SIGTERM, um segundo de prazo e SIGKILL em quem não saiu. */
function terminate(pids) {
  for (const pid of pids) signalQuietly(pid, "SIGTERM");
  if (pids.length === 0) return;
  sleepSync(1000);
  for (const pid of pids) signalQuietly(pid, "SIGKILL");
}

function signalQuietly(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // Já saiu.
  }
}

/**
 * Para todo processo deixado por um worktree apagado deste checkout e limpa o
 * registro do Git desses worktrees. Só toca processos cujo diretório de
 * worktree sumiu. A busca de processos é POSIX; o `git worktree prune` roda em
 * toda plataforma.
 */
export function reapOrphanedWorktrees(mainRoot, { quiet = false, parents } = {}) {
  let orphans = [];
  if (!isWindows) {
    orphans = findOrphanedProcesses(listUserProcesses(), parents ?? worktreeParentDirs(mainRoot));
    terminate(orphans.map(({ pid }) => pid));
    if (orphans.length > 0 && !quiet) {
      const worktrees = [...new Set(orphans.map(({ worktree }) => basename(worktree)))];
      console.log(
        `Parei ${orphans.length} processo(s) deixados por worktrees apagados: ${worktrees.join(", ")}.`,
      );
    }
  }
  spawnSync("git", ["worktree", "prune"], { cwd: mainRoot, stdio: "ignore" });
  return orphans;
}

/**
 * Ponto de entrada de setup, cleanup e `worktree reap`, a partir de qualquer
 * checkout do repositório. Inclui o diretório de worktrees configurado
 * (`worktree config --set-dir`). É limpeza de melhor esforço: fora de um
 * repositório Git, ou se a listagem falhar, não faz nada em vez de derrubar o
 * comando que a chamou.
 */
export function reapDeletedWorktrees(root, options = {}) {
  try {
    const mainRoot = mainWorktreePath(root);
    const parents = worktreeParentDirs(mainRoot);
    try {
      parents.push(resolveWorktreesRoot(mainRoot).path);
    } catch {
      // Configuração inválida: o `worktree config` já reclama dela.
    }
    return reapOrphanedWorktrees(mainRoot, { ...options, parents: [...new Set(parents)] });
  } catch {
    return [];
  }
}
