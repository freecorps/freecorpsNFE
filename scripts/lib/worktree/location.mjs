/**
 * Onde os worktrees nascem. Nada aqui é fixo: o padrão é a pasta irmã, mas o
 * dev pode apontar para outro disco sem tocar em arquivo versionado.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { fail, git, tryGit } from "./exec.mjs";
import { defaultWorktreesRoot } from "./paths.mjs";

/**
 * Guardado no `.git/config`, então é por clone e por máquina, compartilhado por
 * todo worktree daquele clone, e nunca commitado. Um valor `--global` posto
 * pelo dev entra pela hierarquia normal de config do git.
 */
export const WORKTREES_DIR_KEY = "freecorpsnfe.worktreesDir";
export const WORKTREES_DIR_ENV = "FNFE_WORKTREES_DIR";

/** `~/worktrees` é uma coisa natural de digitar, inclusive no Windows. */
export function expandHome(value) {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function readConfiguredWorktreesDir(cwd) {
  const result = tryGit(["config", "--get", WORKTREES_DIR_KEY], { cwd });
  return result.ok && result.stdout ? result.stdout : null;
}

export function setConfiguredWorktreesDir(value, options = {}) {
  const args = ["config"];
  if (options.global) args.push("--global");
  args.push(WORKTREES_DIR_KEY, value);
  git(args, { cwd: options.cwd });
}

export function unsetConfiguredWorktreesDir(options = {}) {
  const args = ["config"];
  if (options.global) args.push("--global");
  args.push("--unset", WORKTREES_DIR_KEY);
  const result = tryGit(args, { cwd: options.cwd });
  // Código 5 significa que a chave não estava definida, o que não é erro aqui.
  if (!result.ok && result.status !== 5) {
    fail(`Não consegui limpar ${WORKTREES_DIR_KEY}: ${result.stderr}`);
  }
  return result.ok;
}

/**
 * Resolve onde um worktree novo é colocado, em ordem de precedência:
 *
 * 1. `--into <dir>` para uma invocação só
 * 2. a variável de ambiente `FNFE_WORKTREES_DIR`
 * 3. o valor `freecorpsnfe.worktreesDir` no config do git
 * 4. uma pasta irmã do checkout principal
 *
 * Valor relativo resolve contra o checkout principal, para significar a mesma
 * coisa de qualquer diretório em que o comando rode.
 */
export function resolveWorktreesRoot(mainRoot, options = {}) {
  const candidates = [
    { source: "--into", value: options.into },
    { source: WORKTREES_DIR_ENV, value: process.env[WORKTREES_DIR_ENV] },
    {
      source: WORKTREES_DIR_KEY,
      value: readConfiguredWorktreesDir(options.cwd ?? mainRoot),
    },
  ];

  for (const candidate of candidates) {
    const raw = typeof candidate.value === "string" ? candidate.value.trim() : "";
    if (!raw) continue;
    const expanded = expandHome(raw);
    return {
      path: isAbsolute(expanded) ? resolve(expanded) : resolve(mainRoot, expanded),
      source: candidate.source,
    };
  }

  return { path: defaultWorktreesRoot(mainRoot), source: "padrão" };
}
