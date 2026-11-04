import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "../lib/worktree/deployment.mjs";
import { loadReadFixtures, readProof } from "../lib/document-read-proof.mjs";
import { repoRoot } from "../lib/repo-root.mjs";

if (process.argv.includes("--help")) {
  console.log(
    "bun run content:prove-local <porta-local> [--read <fixtures.json> | --read-node <fixtures.json>]\nSomente backend do worktree preparado e iniciado por dev. --read-node acrescenta amostras Node e preserva recibos existentes; --read avalia retorno completo pré-B5; fixtures saem de platform.documentReadProof.test.ts com FNFE_READ_FIXTURES. Grava recibo agregado em docs/v1.0/evidence/642; preserva dados sintéticos no banco.",
  );
  process.exit(0);
}
const node = process.argv[3] === "--read-node";
const reading = process.argv[3] === "--read" || node;
assert.ok(process.argv.length === 3 || (reading && process.argv.length === 5), "Use --help");

const root = repoRoot;
// The existing worktree tool consumes the private descriptor; never print its contents.
const config = readLocalConfig(worktreePaths(root));
assert.ok(config, "Execute worktree:setup e dev antes do smoke");
const url = localUrls(config).cloud;
assert.equal(url, `http://127.0.0.1:${Number(process.argv[2])}`, "Informe a porta local esperada");
const receipt = join(
  root,
  `docs/v1.0/evidence/642/${node ? "read-node-local" : reading ? "read-local" : "content-local"}.json`,
);
if (node) {
  const exists = await access(receipt).then(
    () => true,
    () => false,
  );
  assert.ok(!exists, "Preserve o recibo read-node-local.json com outro nome antes de repetir");
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function call(kind, path, args = {}) {
  const response = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (result.status !== "success")
    throw new Error(
      ["BLOB_MISSING", "DOCUMENT_CONTENT_CORRUPT"].find((code) =>
        String(result.errorMessage).includes(code),
      ) ?? "PROOF_CALL_FAILED",
    );
  return result.value;
}
const report = {
  version: 1,
  target: "local-anonymous",
  productionTouched: false,
  startedAt: new Date().toISOString(),
  memory: node ? "phase-samples-not-peak" : "unavailable",
  results: [],
};
let failed = false;
try {
  const fixtures = reading ? await loadReadFixtures(process.argv[4]) : undefined;
  const safety = JSON.parse(await call("query", "coldArchive:restoreSafety"));
  assert.ok(safety.cronsOff && safety.fiscalDisabled && safety.captureDisabled);
  const scope = await call("mutation", "testing/operationProof:prepare", {
    keyHash: hash(randomUUID()),
    suffix: `content642-${randomUUID()}`,
  });
  const xml = "<synthetic>Prova local B4, sem validade fiscal</synthetic>";
  const storageId = await call("action", "testing/coldArchiveProof:store", { xml });
  if (reading) await readProof({ call, scope, storageId, report, fixtures, node });
  else {
    for (const model of ["55", "nfse"]) {
      for (const size of [1024, 8 * 1024 * 1024 - 4096, 8 * 1024 * 1024 + 1024]) {
        const row = { model, inputBytes: size };
        let phase = "prepare";
        report.results.push(row);
        try {
          const { keyId: _key, ...ids } = scope;
          const fixture = await call("mutation", "testing/documentContentProof:seed", {
            ...ids,
            storageId,
            model,
          });
          let remaining = size;
          const expectedItems = [];
          while (remaining) {
            const bytes = Math.min(512 * 1024, remaining);
            expectedItems.push(JSON.stringify("x".repeat(bytes - 2)));
            await call("mutation", "testing/documentContentProof:append", {
              versionId: fixture.versionId,
              bytes,
            });
            remaining -= bytes;
            // Fixture preparation stays below the observed local 4 MiB/s write rate.
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const before = JSON.parse(
            await call("query", "testing/documentContentProof:inspect", {
              versionId: fixture.versionId,
            }),
          );
          phase = "publication";
          await call("mutation", "importProcessing:published", {
            operationId: fixture.operationId,
          });
          // Publication queued the writer in the content pool, whose jobs the app does not see.
          // Running it here waits for its outcome; a repeat keeps the first blob, so the queued
          // one that may run alongside changes nothing.
          await call("action", "importProcessing:storeContent", {
            versionId: fixture.versionId,
            attempt: 1,
          });
          const state = JSON.parse(
            await call("query", "testing/documentContentProof:inspect", {
              versionId: fixture.versionId,
            }),
          );
          phase = "preservation";
          assert.equal(state.itemBytes, size);
          assert.equal(state.inlineSha256, before.inlineSha256, "Inline content changed");
          assert.equal(
            hash(Buffer.from(await (await fetch(state.original)).arrayBuffer())),
            hash(xml),
          );
          row.originalPreserved = true;
          row.inlinePreserved = true;
          if (size > 8 * 1024 * 1024) {
            assert.equal(state.version.contentStorageId, undefined);
            row.outcome = "inline-too-large";
          } else {
            phase = "verification";
            assert.ok(state.version.contentStorageId, "Published version has no blob");
            row.verified = JSON.parse(
              await call("action", "testing/documentContentProof:verify", {
                versionId: fixture.versionId,
              }),
            );
            const canonical = JSON.stringify({
              format: "document-content/1",
              result: before.version.result,
              items: expectedItems,
            });
            assert.equal(row.verified.contentSha256, hash(canonical));
            assert.equal(row.verified.contentSize, Buffer.byteLength(canonical));
            row.outcome = "attached";
          }
          phase = "retry";
          await call("mutation", "importProcessing:published", {
            operationId: fixture.operationId,
          });
          await call("action", "importProcessing:storeContent", {
            versionId: fixture.versionId,
            attempt: 1,
          });
          const repeat = JSON.parse(
            await call("query", "testing/documentContentProof:inspect", {
              versionId: fixture.versionId,
            }),
          );
          assert.equal(repeat.version.contentStorageId, state.version.contentStorageId);
          assert.equal(repeat.storageCount, state.storageCount, "Retry created another file");
          assert.equal(repeat.inlineSha256, before.inlineSha256, "Retry changed inline content");
          row.idempotent = true;
        } catch {
          failed = true;
          row.outcome = "failed";
          row.error = `PROOF_${phase.toUpperCase()}_FAILED`;
        }
        console.log(JSON.stringify(row));
      }
    }
  }
} catch {
  failed = true;
  report.error = "PROOF_SETUP_FAILED";
}
report.passed = !failed;
report.finishedAt = new Date().toISOString();
report.codeHashes = Object.fromEntries(
  await Promise.all(
    [
      "scripts/proofs/prove-document-content-local.mjs",
      "platform/convex/testing/documentContentProof.ts",
      "platform/convex/importProcessing.ts",
      "platform/convex/lib/documentContentWriter.ts",
      "platform/convex/lib/documentContent.ts",
      ...(reading
        ? [
            "platform/convex/testing/documentReadProof.ts",
            ...(node ? ["platform/convex/testing/documentReadNodeProof.ts"] : []),
            "scripts/lib/document-read-proof.mjs",
            "tests/platform.documentReadProof.test.ts",
          ]
        : []),
    ].map(async (path) => [path, hash(await readFile(join(root, path)))]),
  ),
);
report.limitations = reading
  ? [
      "Avaliação funcional pré-B5, sem migração de consumidores",
      "Pico V8 indisponível; métricas transacionais não medem heap",
      "Preparação após parser; parser exercitado apenas no convex-test",
      "Sem prova de memória, concorrência ou capacidade hospedada",
    ]
  : [
      "Fixtures após o parser; não exercita REST, upload nem validação fiscal",
      "Itens repetitivos; não mede razão de compressão representativa nem memória",
      "Sem fiscalEvidence/snapshot nem entradas de lote ABRASF neste smoke",
      "Sucesso próximo de 8 MiB não determina o máximo geral de query/action/retorno",
      "Preparação espaçada em 200 ms por item por limite local observado de 4 MiB/s",
      "Dados sintéticos permanecem no banco descartável; sem limpeza inline, backfill ou B5",
    ];
await writeFile(
  join(
    root,
    `docs/v1.0/evidence/642/${node ? "read-node-local" : reading ? "read-local" : "content-local"}.json`,
  ),
  JSON.stringify(report, null, 2) + "\n",
);
process.exitCode = failed ? 1 : 0;
