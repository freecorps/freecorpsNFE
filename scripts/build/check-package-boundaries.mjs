import { checkPackageBoundaries } from "../lib/package-boundaries.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

try {
  const result = checkPackageBoundaries(repoRoot);
  console.log(
    `Grafo aprovado: ${result.workspaces} workspaces, ${result.independent} independentes, ${result.entryPoints} pontos de entrada classificados.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Falha ao verificar dependências.");
  process.exitCode = 1;
}
