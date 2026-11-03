import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openApi, contractGateFailures, publishedBaseline } from "./lib/external-contract.mjs";
import { renderContractArtifacts, staleContractArtifacts } from "./lib/contract-artifacts.mjs";

const document = openApi();
const artifacts = await renderContractArtifacts(document);
if (process.argv.includes("--check")) {
  const stale = staleContractArtifacts(artifacts);
  if (stale.length) throw new Error(`Artefato desatualizado: ${stale.join(", ")}`);
} else
  for (const [path, content] of Object.entries(artifacts)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
const baseIndex = process.argv.indexOf("--base");
if (baseIndex !== -1) {
  const base = process.argv[baseIndex + 1];
  if (!base || !/^[\w/.-]+$/.test(base)) throw new Error("Base inválida");
  const openapiAt = (ref) =>
    execFileSync("git", ["show", `${ref}:docs/v1.0/openapi.json`], {
      encoding: "utf8",
      maxBuffer: 10_000_000,
    });
  const files = execFileSync("git", ["ls-tree", "--name-only", base, "docs/v1.0/openapi.json"], {
    encoding: "utf8",
  });
  if (!files.trim())
    console.log(
      "Primeira definição OpenAPI nesta base; testes de compatibilidade continuam obrigatórios.",
    );
  // Decisão de 26/10/2026: a comparação usa o último contrato publicado, não a base do PR.
  const record = JSON.parse(readFileSync("packages/contracts/published.json", "utf8"));
  const published = publishedBaseline(
    record,
    openapiAt,
    (text) => createHash("sha256").update(text).digest("hex"),
    (path) => readFileSync(path, "utf8"),
  );
  const failures = contractGateFailures({
    base: files.trim() ? JSON.parse(openapiAt(base)) : null,
    published,
    next: document,
  });
  if (failures.length)
    throw new Error(`Contrato publicado mudou sem versão major: ${failures.join(", ")}`);
  console.log(
    published
      ? `Contrato comparado com o publicado ${published.info.version}.`
      : `Nenhum contrato publicado: o major de ${document.info.version} aceita mudanças.`,
  );
}
console.log(`${Object.keys(document.paths).length} rotas OpenAPI conferidas.`);
