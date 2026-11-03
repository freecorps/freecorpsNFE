import { spawn } from "node:child_process";
import { resolveDev } from "./lib/commands.mjs";
import { bunExecutable, currentRoot, worktreePaths } from "./lib/worktree/paths.mjs";
import { isLinkedWorktree } from "./lib/worktree/registry.mjs";

const linked = isLinkedWorktree(currentRoot);
let resolved;
try {
  resolved = resolveDev(process.argv[2] ?? "dev", {
    linked,
    app: linked ? worktreePaths(currentRoot).app : undefined,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
console.log(`dev: ${resolved.target}`);
const child = spawn(bunExecutable, resolved.args, {
  cwd: currentRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
// Quem para o `bun run dev` em segundo plano sinaliza só este processo, não o
// grupo. Sem repassar, ele saía e deixava a sessão do worktree (Convex e Vite)
// viva segurando as portas. A sessão trata sinal repetido como um só.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
