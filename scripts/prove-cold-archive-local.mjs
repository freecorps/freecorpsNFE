import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./lib/worktree/deployment.mjs";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";
import { canonical } from "./lib/cold-archive.mjs";
import {
  attachStorage,
  copyBlob,
  diskSummary,
  prepareDatabase,
  publishIncremental,
  restoreIncremental,
} from "./lib/incremental-backup.mjs";
import { extractZip, fileDigest, writeZip } from "./lib/offsite-backup-zip.mjs";
import { objectKeys, sha256, snapshotId } from "./lib/offsite-backup.mjs";
import { assertRestoreDestination } from "./cold-archive.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.ok(
  process.argv[2] && !process.argv[2].startsWith("--"),
  "Informe o worktree descartável de destino",
);
const destinationRoot = resolve(process.argv[2]);
const portOption = (name) => {
  const index = process.argv.indexOf(name),
    port = Number(process.argv[index + 1]);
  assert.ok(
    index >= 3 && Number.isSafeInteger(port) && port > 0 && port < 65535,
    `Informe ${name}`,
  );
  return port;
};
const sourcePort = portOption("--source-port"),
  destinationPort = portOption("--destination-port");
assert.notEqual(sourcePort, destinationPort, "Origem e destino precisam de portas distintas");
const MAX = 256 * 1024 ** 2;
let diagnosticDirectory;
function target(directory, expectedPort) {
  const paths = worktreePaths(directory),
    config = readLocalConfig(paths);
  assert.ok(config && paths.app === "platform");
  const urls = localUrls(config);
  assert.equal(
    urls.cloud,
    `http://127.0.0.1:${expectedPort}`,
    "Alvo difere das portas do ensaio autorizado",
  );
  return { paths, config, urls };
}
async function call(target, kind, path, args = {}) {
  const response = await fetch(`${target.urls.cloud}/api/${kind}`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${target.config.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, args, format: "json" }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  assert.equal(result.status, "success", `${path}: ${result.errorMessage ?? response.status}`);
  return result.value;
}
function cli(target, args) {
  if (args.some((arg) => arg.startsWith("--replace")))
    assert.equal(target.paths.root, destinationRoot, "Replace só no destino descartável");
  console.log(`target: local-anonymous ${target.urls.cloud}; convex ${args[0]}`);
  const run = spawnSync(
    process.execPath,
    [
      target.paths.convexCli,
      ...args,
      "--url",
      target.urls.cloud,
      "--admin-key",
      target.config.adminKey,
    ],
    {
      cwd: target.paths.backendRoot,
      env: subprocessEnvironment(process.env),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 2 * 1024 ** 2,
    },
  );
  if (run.status !== 0) {
    if (diagnosticDirectory)
      writeFileSync(
        join(diagnosticDirectory, `convex-${args[0]}-${randomUUID()}.log`),
        String(run.stderr ?? "").replaceAll(target.config.adminKey, "[private]"),
        { mode: 0o600 },
      );
    const error = new Error(`CONVEX_${args[0].toUpperCase()}_FAILED`);
    error.phase = args[0];
    error.exitCode = run.status;
    throw error;
  }
}
function command(bin, args) {
  const result = spawnSync(bin, args, {
    env: subprocessEnvironment(process.env),
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
  if (result.status !== 0) throw new Error("Ferramenta age falhou");
  return result.stdout.trim();
}
function diskStore(directory) {
  const path = (key) => {
    const resolved = resolve(directory, key);
    assert.ok(resolved.startsWith(resolve(directory) + sep), "Objeto fora do store isolado");
    return resolved;
  };
  const head = async (key) => {
    try {
      return { size: (await stat(path(key))).size };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  };
  return {
    head,
    async get(key) {
      return readFile(path(key));
    },
    async putFile(key, from) {
      if (await head(key)) return false;
      await mkdir(dirname(path(key)), { recursive: true });
      await copyFile(from, path(key));
      return true;
    },
    async putImmutable(key, data) {
      if (await head(key)) return false;
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), data, { flag: "wx", mode: 0o600 });
      return true;
    },
    async verifyFile(key, expected) {
      assert.deepEqual(await fileDigest(path(key)), expected, "Objeto do store isolado diverge");
    },
    async getFile(key, to, limit) {
      assert.ok((await stat(path(key))).size <= limit);
      await copyFile(path(key), to);
      return fileDigest(to);
    },
  };
}
async function ready(target) {
  let failure;
  for (let i = 0; i < 40; i++) {
    try {
      const safety = JSON.parse(await call(target, "query", "coldArchive:restoreSafety"));
      assert.ok(safety.cronsOff && safety.fiscalDisabled && safety.captureDisabled);
      await call(target, "query", "testing/coldArchiveProof:gate");
      return;
    } catch (e) {
      failure = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw failure;
}
async function incremental({ source, store, scratch, name, recipients, encrypt, decrypt }) {
  const directory = join(scratch, name);
  await mkdir(directory);
  const plan = {
    prefix: "synthetic/",
    deployment: "synthetic",
    cadenceHours: 12,
    maxSnapshotBytes: MAX,
    recipients: recipients.map((recipient, i) => ({ custodian: `synthetic-${i}`, recipient })),
    incremental: { version: 2, blobPrefix: "synthetic/objects/", retentionConfigured: true },
  };
  const items = [],
    objects = new Map();
  let cursor = null,
    reused = 0;
  for (;;) {
    const page = await call(source, "query", "backupInventory:page", {
      paginationOpts: { numItems: 64, cursor },
    });
    for (const item of page.page) {
      const object = await copyBlob({ plan, client: store, item, directory, encrypt });
      items.push(item);
      objects.set(object.plaintext.sha256, object);
      if (object.reused) reused++;
    }
    if (page.isDone) break;
    assert.notEqual(page.continueCursor, cursor);
    cursor = page.continueCursor;
  }
  const raw = join(directory, "raw.zip");
  cli(source, ["export", "--path", raw]);
  const entries = await extractZip(raw, join(directory, "entries"), MAX);
  const { references, invalidatedExports, coldArchives } = await prepareDatabase(entries);
  for (const id of references)
    assert.ok(
      items.some((item) => item.metadata._id === id),
      "Inventário não cobre snapshot",
    );
  await attachStorage(entries, items, directory);
  const summary = await diskSummary(entries, { verifyStorage: false });
  const db = join(directory, "database.zip"),
    cipher = join(directory, "database.age");
  await writeZip(entries, db, MAX);
  await encrypt(db, cipher);
  const manifest = {
    format: 2,
    id: snapshotId(new Date()),
    deployment: "synthetic",
    ...summary,
    objects: [...objects.values()],
    invalidatedExports,
    coldArchives,
    plaintext: await fileDigest(db),
    ciphertext: await fileDigest(cipher),
  };
  await publishIncremental({ plan, client: store, manifest, cipher });
  const keys = objectKeys(plan, manifest.id),
    fetched = join(directory, "download.age"),
    decoded = join(directory, "decoded.zip");
  assert.deepEqual(await store.getFile(keys.snapshot, fetched, MAX), manifest.ciphertext);
  await decrypt(fetched, decoded);
  assert.deepEqual(await fileDigest(decoded), manifest.plaintext);
  const restoredEntries = await extractZip(decoded, join(directory, "decoded"), MAX),
    zip = join(directory, "restored.zip");
  await restoreIncremental({
    manifest,
    entries: restoredEntries,
    client: store,
    directory,
    decrypt,
    zip,
    maxBytes: MAX,
  });
  return { zip, manifest, reused, uniqueObjects: objects.size };
}
async function main() {
  const source = target(root, sourcePort),
    destination = target(destinationRoot, destinationPort);
  assert.notEqual(source.paths.root, destination.paths.root);
  await ready(source);
  await ready(destination);
  const scratch = await mkdtemp(join(tmpdir(), "fnfe-cold-real-")),
    startedAt = new Date().toISOString();
  diagnosticDirectory = await mkdtemp(join(tmpdir(), "fnfe-cold-diagnostic-"));
  await writeFile(join(diagnosticDirectory, "recovery-location.txt"), scratch, { mode: 0o600 });
  const report = {
    version: 2,
    startedAt,
    sourcePort,
    destinationPort,
    backupDataPort: destinationPort,
    store: "isolated-filesystem",
    age: "real",
    convexImportExport: "real",
    productionTouched: false,
    sourceWritten: false,
    gateChanged: false,
    recoveryMaterialPreserved: true,
    results: {},
  };
  let failed;
  try {
    const age = process.env.AGE_BIN || "age",
      keygen = process.env.AGE_KEYGEN_BIN || "age-keygen";
    const identities = [join(scratch, "custodian-one.key"), join(scratch, "custodian-two.key")];
    for (const identity of identities) command(keygen, ["-o", identity]);
    const recipients = identities.map((identity) => command(keygen, ["-y", identity]));
    const decrypt = async (from, to) => {
      command(age, ["-d", "-i", identities[0], "-o", to, from]);
    };
    const encrypt = async (from, to) => {
      command(age, ["-e", ...recipients.flatMap((recipient) => ["-r", recipient]), "-o", to, from]);
      for (const identity of identities) {
        const proof = join(scratch, `age-proof-${randomUUID()}`);
        command(age, ["-d", "-i", identity, "-o", proof, to]);
        assert.deepEqual(await fileDigest(proof), await fileDigest(from));
        await rm(proof);
      }
    };
    // Preserve and verify the only live copy BEFORE any mutation/import in the destination.
    const preserved = join(scratch, "destination-before.zip");
    cli(destination, ["export", "--include-file-storage", "--path", preserved]);
    const preservedEntries = await extractZip(preserved, join(scratch, "destination-before"), MAX);
    const preservedSummary = await diskSummary(preservedEntries);
    const records = new Map();
    for (const [name, path] of preservedEntries)
      if (
        name.endsWith("/documents.jsonl") &&
        !name.startsWith("_components/") &&
        !name.startsWith("_tables/")
      ) {
        for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
          const row = JSON.parse(line);
          if (name === "_storage/documents.jsonl") delete row.internalId;
          records.set(row._id, sha256(canonical(row)));
        }
      }
    const runs = await call(source, "query", "_system/cli/tableData", {
      table: "coldArchiveRuns",
      order: "desc",
      paginationOpts: { numItems: 1, cursor: null },
    });
    const run = runs.page[0];
    let compared = 0;
    if (run && ["restoring", "archived"].includes(run.state)) {
      assert.ok(run.key.startsWith("proof-"), "Somente fixture sintética no ensaio");
      let cursor = null;
      for (;;) {
        const page = JSON.parse(
          await call(source, "query", "coldArchive:entries", { runId: run._id, cursor }),
        );
        for (const entry of page.page) {
          assert.equal(
            records.get(entry.originalId),
            entry.sha256,
            "Pacote preservado diverge do catálogo da origem",
          );
          compared++;
        }
        if (page.isDone) break;
        assert.notEqual(cursor, page.continueCursor);
        cursor = page.continueCursor;
      }
      assert.equal(compared, run.rows + run.files);
    }
    await encrypt(preserved, join(scratch, "destination-before.zip.age"));
    report.results.preservedDestination = {
      ...preservedSummary.storage,
      tables: Object.keys(preservedSummary.digests).length,
      catalogueEntriesCompared: compared,
      plaintext: await fileDigest(preserved),
      verifiedBeforeDestruction: true,
      bothCustodiansVerified: true,
    };
    console.log(
      "Cópia completa do destino preservada e verificada fora do worktree antes de qualquer escrita.",
    );
    const scope = await call(destination, "mutation", "testing/operationProof:prepare", {
      keyHash: sha256(randomUUID()),
      suffix: `cold429-${randomUUID()}`,
    });
    const controls = await call(
      destination,
      "mutation",
      "testing/coldArchiveProof:seedIncrementalControls",
      { organizationId: scope.organizationId },
    );
    const store = diskStore(join(scratch, "offsite"));
    const backup = await incremental({
      source: destination,
      store,
      scratch,
      name: "incremental-isolated",
      recipients,
      encrypt,
      decrypt,
    });
    await assertRestoreDestination(
      {
        sourceUrl: source.urls.cloud,
        destinationUrl: destination.urls.cloud,
        destinationIsDisposable: true,
        retentionConfigured: true,
        prefix: "synthetic/cold/",
        recipients,
      },
      { query: (path, args) => call(destination, "query", path, args) },
    );
    // Explicit descriptor + URL guard: this is never an import into the application source.
    assert.notEqual(destination.urls.cloud, source.urls.cloud);
    cli(destination, ["import", backup.zip, "--replace-all", "--yes"]);
    const reexport = join(scratch, "after-import.zip");
    cli(destination, ["export", "--include-file-storage", "--path", reexport]);
    const result = await diskSummary(
      await extractZip(reexport, join(scratch, "after-import"), MAX),
    );
    assert.deepEqual(
      result.digests,
      backup.manifest.digests,
      "Restore incremental real diverge do snapshot",
    );
    const actualControls = await call(
      destination,
      "query",
      "testing/coldArchiveProof:inspectIncrementalControls",
      controls,
    );
    assert.deepEqual(actualControls, {
      ready: false,
      phase: 0,
      reservedFiles: 18 * 1024 * 1024,
      reservedDatabase: 16 * 1024 * 1024,
      state: "expired",
      code: "BACKUP_REGENERATE_EXPORT",
    });
    const repeated = await incremental({
      source: destination,
      store,
      scratch,
      name: "incremental-repeated",
      recipients,
      encrypt,
      decrypt,
    });
    assert.equal(repeated.reused, result.storage.files);
    report.results.incrementalIsolated = {
      tablesCompared: Object.keys(result.digests).length,
      filesCompared: result.storage.files,
      bytesCompared: result.storage.bytes,
      uniqueObjects: backup.uniqueObjects,
      objectsReusedOnRepeat: repeated.reused,
      coldManifests: backup.manifest.coldArchives.length,
      databaseSha256: backup.manifest.plaintext.sha256,
      verifiedRealImport: true,
      originalIdsAndMetadataCompared: true,
      controls: actualControls,
    };
  } catch (error) {
    failed = error;
    await writeFile(join(diagnosticDirectory, "failure.log"), String(error.stack), { mode: 0o600 });
    report.failure = {
      code: error.phase ? error.message : "LOCAL_PROOF_FAILED",
      phase: error.phase ?? "comparison",
      exitCode: error.exitCode ?? null,
    };
  }
  // The original fixture and recovery materials remain available even after a successful drill.
  report.finishedAt = new Date().toISOString();
  report.passed = !failed;
  report.limitations = [
    "R2 real, lock e lifecycle não exercitados",
    "Custódia age sintética local",
    "Não mede restauração de 2 GiB nem RTO de produção",
    "Sem ressurreição same-origin; fixture tombstoned preservada no destino e em pacote externo",
    "Catálogo frio com referências coberto por testes locais, não por este import incremental",
  ];
  report.codeHashes = Object.fromEntries(
    await Promise.all(
      [
        "platform/convex/coldArchive.ts",
        "scripts/lib/cold-archive.mjs",
        "scripts/lib/incremental-backup.mjs",
        "scripts/prove-cold-archive-local.mjs",
      ].map(async (path) => [path, sha256(await readFile(join(root, path)))]),
    ),
  );
  const output = join(root, "docs/v1.0/evidence/429/restore");
  await mkdir(output, { recursive: true });
  const name = `${startedAt.replaceAll(":", "-")}.json`;
  await writeFile(join(output, name), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence: `docs/v1.0/evidence/429/restore/${name}`,
      results: report.results,
      recoveryMaterialPreserved: true,
    }),
  );
  if (failed) throw failed;
}
main().catch((error) => {
  console.error(error.phase ? error.message : "LOCAL_PROOF_FAILED");
  process.exitCode = 1;
});
