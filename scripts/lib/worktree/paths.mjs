/**
 * Todo caminho que a ferramenta de worktree toca, derivado de uma raiz de
 * checkout — é isso que deixa os comandos de ciclo de vida operarem sobre um
 * worktree que não é o deles.
 */
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

export const isWindows = process.platform === "win32";
export const bunExecutable = process.versions.bun
  ? process.execPath
  : isWindows
    ? "bun.exe"
    : "bun";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Raiz do checkout a que esta cópia do script pertence (principal ou linked). */
export const currentRoot = resolve(moduleDir, "..", "..", "..");

/**
 * O backend local do Convex só publica actions `"use node"` com Node 22 ou 24
 * (#609). Em vez de depender do Node da máquina (que aqui é o que o Bun
 * trouxer), cada worktree carrega o seu, fixado na mesma versão do CI.
 */
export const NODE_RUNTIME_VERSION = "24.22.1";

const NODE_RUNTIME_PACKAGES = {
  "darwin:arm64": "node-bin-darwin-arm64",
  "darwin:x64": "node-darwin-x64",
  "linux:arm64": "node-linux-arm64",
  "linux:x64": "node-linux-x64",
  "win32:arm64": "node-win-arm64",
  "win32:x64": "node-win-x64",
};

export function nodeRuntimePackage() {
  return NODE_RUNTIME_PACKAGES[`${process.platform}:${process.arch}`] ?? null;
}

// Sem `--app`, um worktree ainda não preparado nasce na plataforma.
export function requestedWorktreeApp(paths, app) {
  if (app !== undefined) return app;
  return existsSync(paths.appFile) || existsSync(paths.localConfig) ? undefined : "platform";
}

export function worktreePaths(root = currentRoot) {
  const resolvedRoot = resolve(root);
  const convexDir = join(resolvedRoot, ".convex");
  const appFile = join(convexDir, "worktree-app.json");
  // O backoffice legado foi aposentado na #345. Um worktree preparado para ele
  // (`worktree-app.json` com "legacy", ou banco na raiz sem esse arquivo)
  // continua reconhecido para listar, parar e remover; setup, dev e sync o
  // recusam, e o banco em `.convex/local` da raiz fica intacto.
  const app = existsSync(appFile)
    ? JSON.parse(readFileSync(appFile, "utf8")).app
    : existsSync(join(convexDir, "local", "default", "config.json"))
      ? "legacy"
      : "platform";
  if (!["legacy", "platform"].includes(app)) throw new Error("Invalid worktree application");
  const backendRoot = app === "platform" ? join(resolvedRoot, "platform") : resolvedRoot;
  const nodeRuntimeDir = join(convexDir, "runtime");
  const runtimePackage = nodeRuntimePackage();
  const nodeBinDir = runtimePackage
    ? join(nodeRuntimeDir, "node_modules", runtimePackage, "bin")
    : join(nodeRuntimeDir, "sem-suporte");

  return {
    root: resolvedRoot,
    app,
    appFile,
    backendRoot,
    frontendRoot: join(resolvedRoot, "apps", "console"),
    convexDir,
    nodeRuntimeDir,
    nodeBinDir,
    nodeExecutable: join(nodeBinDir, isWindows ? "node.exe" : "node"),
    convexCli: join(resolvedRoot, "node_modules", "convex", "bin", "main.js"),
    localConfig: join(backendRoot, ".convex", "local", "default", "config.json"),
    backendEnv: join(convexDir, "worktree.env"),
    processFile: join(convexDir, "worktree-dev-process.json"),
    runtimeEnv: join(resolvedRoot, ".env.local"),
    cli: join(resolvedRoot, "scripts", "worktree.mjs"),
  };
}

/** O git reporta com barra normal; iguale, para caminho impresso ficar igual. */
export function displayPath(value) {
  return String(value).replaceAll("\\", "/");
}

/** Sem diferenciar maiúscula no Windows, para a chave sobreviver ao "C:" vs "c:". */
export function normalizePath(value) {
  const normalized = resolve(value).replaceAll("\\", "/");
  return isWindows ? normalized.toLowerCase() : normalized;
}

/**
 * Local padrão: pasta irmã do checkout principal, então
 * `C:/Users/dev/projetos/freecorpsnfe` guarda os worktrees em
 * `C:/Users/dev/projetos/freecorpsnfe-worktrees`. O resto da busca está em
 * `location.mjs`.
 */
export function defaultWorktreesRoot(mainRoot) {
  const resolvedMain = resolve(mainRoot);
  return join(dirname(resolvedMain), `${basename(resolvedMain)}-worktrees`);
}

export function prependToPath(env, dir) {
  // O bloco de ambiente do Windows não diferencia maiúscula, então reaproveite
  // a chave existente em vez de criar uma segunda que o filho ignoraria.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${dir}${delimiter}${env[pathKey] ?? ""}`;
  return env;
}

/**
 * Nomes de dispositivo do DOS, que o Windows ainda recusa como nome de arquivo
 * ou pasta — e recusa com QUALQUER extensão, então `con.txt` também não vale.
 * Uma branch `nul` faria o `git worktree add` falhar com um erro que não
 * explica nada; o prefixo troca isso por uma pasta que funciona.
 */
const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/** Nome de pasta seguro para uma branch como `feat/minha-coisa`. */
export function slugifyWorktreeName(value) {
  const slug = String(value)
    .trim()
    .replaceAll("\\", "/")
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  // O prefixo entra antes do corte de 80, então o resultado continua no limite.
  return WINDOWS_RESERVED_NAMES.test(slug) ? `wt-${slug}`.slice(0, 80) : slug;
}
