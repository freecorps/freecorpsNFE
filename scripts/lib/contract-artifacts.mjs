import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "vite-plus/fmt";

/**
 * Renders every file derived from the REST contract, keyed by its path
 * relative to the repository root. `contracts:generate` writes these bytes and
 * `contracts:check` compares them, so both use this single rendering.
 * @param {{ paths: Record<string, Record<string, object>> }} document
 * @returns {Promise<Record<string, string>>}
 */
export async function renderContractArtifacts(document) {
  /** @type {Record<string, string>} */
  const sources = {
    "docs/v1.0/openapi.json": JSON.stringify(document, null, 2) + "\n",
    "docs/v1.0/API-REFERENCE.md":
      "# Referência REST gerada\n\nGerada por `bun run contracts:generate`. Edite `packages/contracts/src/external.ts`.\n\n| Operação SDK | Método | Rota | Escopo | Retry automático |\n| --- | --- | --- | --- | --- |\n" +
      Object.entries(document.paths)
        .flatMap(([path, methods]) =>
          Object.entries(methods).map(([method, operation]) => {
            const op =
              /** @type {{ operationId: string, "x-scope": string, "x-retry-policy": string }} */ (
                operation
              );
            return `| ${op.operationId} | ${method.toUpperCase()} | \`${path}\` | ${op["x-scope"]} | ${op["x-retry-policy"]} |`;
          }),
        )
        .join("\n") +
      "\n\nSchemas completos, opcionais, limites e respostas estão em [openapi.json](openapi.json).\n",
  };
  /** @type {Record<string, string>} */
  const artifacts = {};
  for (const [path, source] of Object.entries(sources)) {
    const formatted = await format(path, source);
    if (formatted.errors.length) throw new Error(`Falha ao formatar ${path}`);
    artifacts[path] = formatted.code;
  }
  return artifacts;
}

/**
 * Paths whose committed bytes differ from the rendering, including absent
 * files. Line endings from a Windows checkout are not a difference.
 * @param {Record<string, string>} artifacts
 * @param {string} root
 */
export function staleContractArtifacts(artifacts, root = ".") {
  return Object.entries(artifacts)
    .filter(([path, content]) => {
      const file = join(root, path);
      return !existsSync(file) || readFileSync(file, "utf8").replaceAll("\r\n", "\n") !== content;
    })
    .map(([path]) => path);
}
