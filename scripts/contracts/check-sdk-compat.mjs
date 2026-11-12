// Gate de compatibilidade do SDK (#135), na tarefa `ci:sdk`. Compara a API
// TypeScript de packages/sdk com as declarações da versão publicada, registradas
// em packages/sdk/published.json, e exige o incremento de versão coerente
// (docs/v1.0/SDK.md#versão-do-sdk). Não consulta o npm.
//
//   bun run sdk:compat
//   bun run sdk:compat --record <tarball> --accepted <evidência>/accepted.json --published-at <ISO>
//
// --record grava o registro de uma publicação nova a partir dos bytes aceitos:
// confere o SHA-256 do tarball no accepted.json, copia `types/` para
// packages/sdk/published/<versão>/ e reescreve published.json.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { apiVersion } from "../../packages/contracts/src/external.ts";
import { repoRoot } from "../lib/repo-root.mjs";
import {
  compareSdk,
  publicationRecord,
  readPublished,
  versionFailures,
} from "../lib/sdk-compat.mjs";

const root = repoRoot;
const { values } = parseArgs({
  options: {
    record: { type: "string" },
    accepted: { type: "string" },
    "published-at": { type: "string" },
  },
});

if (values.record) {
  const accepted = values.accepted;
  const publishedAt = values["published-at"];
  if (!accepted || !publishedAt)
    throw new Error("--record exige --accepted <accepted.json> e --published-at <data ISO>");
  const recordPath = resolve(root, "packages/sdk/published.json");
  const { files, record } = publicationRecord({
    tarball: readFileSync(values.record),
    accepted: JSON.parse(readFileSync(accepted, "utf8")),
    acceptedPath: relative(root, resolve(accepted)).replaceAll("\\", "/"),
    publishedAt,
    current: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : undefined,
  });
  const directory = resolve(root, record.published.declarations);
  rmSync(directory, { recursive: true, force: true });
  for (const { path, bytes } of files) {
    const target = resolve(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  readPublished(root);
  console.log(
    `Registro do SDK ${record.published.version} (contrato ${record.published.contractVersion}) gravado.`,
  );
} else {
  const { published } = readPublished(root);
  const manifest = JSON.parse(readFileSync(resolve(root, "packages/sdk/package.json"), "utf8"));
  const result = compareSdk({
    previous: Object.fromEntries(
      Object.entries(published.entries).map(([entry, path]) => [
        entry,
        resolve(root, published.declarations, path),
      ]),
    ),
    next: Object.fromEntries(
      Object.entries(manifest.exports).map(([entry, path]) => [
        entry,
        resolve(root, "packages/sdk", path),
      ]),
    ),
    compatPath: resolve(root, "packages/sdk/compat.ts"),
  });
  const failures = versionFailures({
    published,
    version: manifest.version,
    contractVersion: apiVersion,
    classification: result.classification,
  });
  const label = { equal: "igual", additive: "aditiva", breaking: "quebra" }[result.classification];
  mkdirSync(resolve(root, ".ci-results/135"), { recursive: true });
  writeFileSync(resolve(root, ".ci-results/135/compat.ts"), result.compat);
  writeFileSync(
    resolve(root, ".ci-results/135/sdk-compat.json"),
    JSON.stringify(
      {
        published: published.version,
        version: manifest.version,
        contract: { published: published.contractVersion, current: apiVersion },
        classification: result.classification,
        checks: result.checks,
        changes: result.changes,
        failures,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `SDK ${manifest.version} contra o publicado ${published.version}: ${label} (${result.checks} comparações; contrato ${apiVersion}).`,
  );
  for (const change of result.changes)
    console.log(`  ${change.change.padEnd(8)} ${change.subject}: ${change.detail}`);
  for (const failure of failures) console.error(`Recusado: ${failure}`);
  if (failures.length) process.exitCode = 1;
}
