import { fileURLToPath } from "node:url";
import { checkPackageBoundaries } from "./lib/package-boundaries.mjs";

try {
  const result = checkPackageBoundaries(fileURLToPath(new URL("..", import.meta.url)));
  console.log(
    `Grafo aprovado: ${result.workspaces} workspaces, ${result.independent} independentes, ${result.entryPoints} pontos de entrada classificados.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Falha ao verificar dependências.");
  process.exitCode = 1;
}
