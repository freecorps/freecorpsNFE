// Roda o dev do worktree pela API (`dev({ signal })`) e o para quando
// stop-dev.mjs cria o pedido de parada. Assim a parada é a do próprio dev:
// filhos encerrados, registro removido e trava da operação liberada, inclusive
// no Windows, onde encerrar a árvore à força deixaria a trava para trás.
// Iniciado só por start-dev.mjs.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dev } from "../../../../scripts/lib/worktree/session.mjs";
import { outputDirectory, stopRequestName } from "./lib.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const stopRequest = join(root, outputDirectory, stopRequestName);
rmSync(stopRequest, { force: true });
const controller = new AbortController();
const watch = setInterval(() => {
  if (existsSync(stopRequest)) {
    console.log("dev-supervisor: parada pedida; encerrando o dev.");
    controller.abort();
  }
}, 500);
try {
  await dev({ root, signal: controller.signal });
} finally {
  clearInterval(watch);
  rmSync(stopRequest, { force: true });
}
