import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, open, writeFile, readFile, copyFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./lib/worktree/deployment.mjs";
import { convexToJson, jsonToConvex } from "convex/values";
import { extractZip, writeZip, fileDigest } from "./lib/offsite-backup-zip.mjs";
import {
  attachStorage,
  copyBlob,
  diskSummary,
  prepareDatabase,
  publishIncremental,
  restoreIncremental,
  preflight,
  readSystemInventory,
  GLOBAL_LIMIT,
} from "./lib/incremental-backup.mjs";
import { sha256, snapshotId, objectKeys } from "./lib/offsite-backup.mjs";
import { repoRoot } from "./lib/repo-root.mjs";

const root = repoRoot;
assert.ok(
  process.argv[2] && process.argv[3] && process.argv[4],
  "Informe destino, porta de origem e porta de destino",
);
function target(directory, port) {
  const paths = worktreePaths(directory),
    config = readLocalConfig(paths);
  assert.ok(config && paths.app === "platform");
  const urls = localUrls(config);
  assert.equal(urls.cloud, `http://127.0.0.1:${Number(port)}`);
  return { paths, config, urls };
}
const source = target(root, process.argv[3]),
  destination = target(resolve(process.argv[2]), process.argv[4]);
assert.notEqual(source.urls.cloud, destination.urls.cloud);
assert.notEqual(source.paths.root, destination.paths.root);
console.log(`Alvos locais: origem ${source.urls.cloud}; restauração ${destination.urls.cloud}`);
const bucket = process.argv[5];
if (bucket) assert.match(bucket, /^freecorpsnfe-backup-drill-688-\d{8}$/);
const reuse = process.argv.includes("--reuse-synthetic");
const scratch = await mkdtemp(join(tmpdir(), "fnfe-backup-capacity-"));
const objectPrefix = `synthetic${Date.now()}`;
const uploaded = new Set();
function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60 * 60_000,
    maxBuffer: 1024 ** 2,
    ...options,
  });
  if (result.status !== 0) {
    const error = new Error("PROOF_COMMAND_FAILED");
    error.missing = result.stderr?.includes("The specified key does not exist.");
    throw error;
  }
  return result.stdout.trim();
}
function cli(target, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("CONVEX_") && !key.startsWith("VITE_"),
    ),
  );
  command(
    process.execPath,
    [
      target.paths.convexCli,
      ...args,
      "--url",
      target.urls.cloud,
      "--admin-key",
      target.config.adminKey,
    ],
    { cwd: target.paths.backendRoot, env },
  );
}
async function call(target, kind, path, args = {}, componentPath = "") {
  const response = await fetch(`${target.urls.cloud}/api/${kind}`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${target.config.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path,
      args: convexToJson(args),
      format: "convex_encoded_json",
      ...(componentPath ? { componentPath } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.equal(result.status, "success", "LOCAL_PROOF_FUNCTION_FAILED");
  return jsonToConvex(result.value);
}
const remote = (...args) =>
  command(process.execPath, [
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    "r2",
    "object",
    ...args,
  ]);
const storePath = (key) => {
  assert.ok(key.startsWith(objectPrefix + "/") && !key.includes(".."));
  return join(scratch, "store", key);
};
const store = {
  async getFile(key, path, limit) {
    if (bucket) remote("get", `${bucket}/${key}`, "--remote", "--file", path);
    else await copyFile(storePath(key), path);
    const digest = await fileDigest(path);
    assert.ok(digest.bytes <= limit);
    return digest;
  },
  async head(key) {
    if (!bucket) {
      try {
        return { size: (await stat(storePath(key))).size };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }
    const path = join(scratch, `head-${randomUUID()}`);
    try {
      return { size: (await this.getFile(key, path, GLOBAL_LIMIT)).bytes };
    } catch (error) {
      if (error.missing) return null;
      throw error;
    } finally {
      await rm(path, { force: true });
    }
  },
  async get(key) {
    const path = join(scratch, `get-${randomUUID()}`);
    try {
      await this.getFile(key, path, GLOBAL_LIMIT);
      return await readFile(path);
    } finally {
      await rm(path, { force: true });
    }
  },
  async putFile(key, path) {
    if (await this.head(key)) return false;
    uploaded.add(key);
    if (bucket) remote("put", `${bucket}/${key}`, "--remote", "--file", path);
    else {
      await mkdir(dirname(storePath(key)), { recursive: true });
      await copyFile(path, storePath(key));
    }
    return true;
  },
  async putImmutable(key, bytes) {
    const path = join(scratch, `put-${randomUUID()}`);
    try {
      await writeFile(path, bytes, { mode: 0o600 });
      return await this.putFile(key, path);
    } finally {
      await rm(path, { force: true });
    }
  },
  async verifyFile(key, expected) {
    const path = join(scratch, `verify-${randomUUID()}`);
    try {
      assert.deepEqual(await this.getFile(key, path, GLOBAL_LIMIT), expected);
    } finally {
      await rm(path, { force: true });
    }
  },
};
const started = performance.now();
let phase = "safety";
let proved = false,
  lockAdded = false;
const oneRow = async (target, table) => {
  const page = await call(target, "query", "_system/cli/tableData", {
    table,
    order: "asc",
    paginationOpts: { cursor: null, numItems: 2 },
  });
  assert.ok(page.isDone && page.page.length === 1, "Reuso exige uma única fixture sintética");
  return page.page[0];
};
try {
  for (const target of [source, destination]) {
    const health = await (await fetch(`${target.urls.site}/health`)).json();
    assert.equal(health.appEnv, "development");
    assert.equal(health.fiscalEnv, "disabled");
    assert.equal(health.captureFiscal, "disabled");
    assert.deepEqual(await call(target, "query", "_system/frontend/listCronJobs"), []);
    const inventory = await readSystemInventory(
      (path, args, componentPath) => call(target, "query", path, args, componentPath),
      GLOBAL_LIMIT,
    );
    if (!reuse) assert.equal(inventory.databaseBytes, 0, "Ensaio exige bancos vazios");
    else
      assert.ok(
        (await oneRow(target, "organizations")).slug.startsWith("cold429-"),
        "Somente fixture sintética própria",
      );
  }
  phase = "seed";
  let controls;
  if (reuse) {
    assert.equal(
      (await oneRow(source, "organizations"))._id,
      (await oneRow(destination, "organizations"))._id,
    );
    controls = {
      accountId: (await oneRow(source, "capacityAccounts"))._id,
      exportId: (await oneRow(source, "documentExports"))._id,
    };
  } else {
    const scope = await call(source, "mutation", "testing/operationProof:prepare", {
      keyHash: sha256(randomUUID()),
      suffix: `cold429-${randomUUID()}`,
    });
    controls = await call(source, "mutation", "testing/coldArchiveProof:seedIncrementalControls", {
      organizationId: scope.organizationId,
    });
    const fixture = join(scratch, "fixture");
    const file = await open(fixture, "wx", 0o600);
    try {
      for (let i = 0; i < 96; i++) await file.writeFile(randomBytes(1024 ** 2));
    } finally {
      await file.close();
    }
    // Distinct bytes on every upload prevent content-addressed deduplication from hiding volume.
    const storageIds = [];
    for (let i = 0; i < 24; i++) {
      const handle = await open(fixture, "r+");
      try {
        await handle.write(randomBytes(64), 0, 64, 0);
      } finally {
        await handle.close();
      }
      const url = await call(source, "mutation", "testing/coldArchiveProof:capacityUploadUrl");
      assert.equal(new URL(url).origin, source.urls.cloud);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: createReadStream(fixture),
        duplex: "half",
      });
      assert.ok(response.ok, "Upload sintético recusado");
      storageIds.push((await response.json()).storageId);
      if (storageIds.length === 3) {
        await call(source, "mutation", "testing/coldArchiveProof:seed", {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          companyId: scope.companyId,
          storageIds,
        });
        storageIds.length = 0;
      }
      console.log(`Arquivo sintético ${i + 1}/24 gravado na origem`);
    }
    await rm(fixture);
  }
  const identity = join(scratch, "identity");
  command(process.env.AGE_KEYGEN_BIN ?? "age-keygen", ["-o", identity]);
  const recipient = command(process.env.AGE_KEYGEN_BIN ?? "age-keygen", ["-y", identity]);
  const encrypt = async (from, to) => {
    command(process.env.AGE_BIN ?? "age", ["-r", recipient, "-o", to, from]);
  };
  const decrypt = async (from, to) => {
    command(process.env.AGE_BIN ?? "age", ["-d", "-i", identity, "-o", to, from]);
  };
  // Transport adapter runs one executor under a fresh synthetic prefix; it is not the S3 concurrency proof.
  const plan = {
    deployment: objectPrefix,
    prefix: objectPrefix + "/",
    cadenceHours: 12,
    maxSnapshotBytes: GLOBAL_LIMIT,
    recipients: [{ recipient }],
    incremental: { version: 2, blobPrefix: objectPrefix + "/objects/", retentionConfigured: true },
  };
  if (bucket) {
    command(process.execPath, [
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "r2",
      "bucket",
      "lock",
      "add",
      bucket,
      objectPrefix,
      plan.incremental.blobPrefix,
      "--retention-indefinite",
      "--force",
    ]);
    lockAdded = true;
  }
  const items = [],
    objects = [];
  let cursor = null;
  phase = "copy";
  for (;;) {
    const page = await call(source, "query", "backupInventory:page", {
      paginationOpts: { numItems: 32, cursor },
    });
    for (const item of page.page) {
      items.push(item);
      objects.push(await copyBlob({ plan, client: store, item, directory: scratch, encrypt }));
      console.log(`Objeto ${objects.length} cifrado e conferido`);
    }
    if (page.isDone) break;
    assert.notEqual(cursor, page.continueCursor);
    cursor = page.continueCursor;
  }
  phase = "snapshot";
  const raw = join(scratch, "raw.zip");
  cli(source, ["export", "--path", raw]);
  const entries = await extractZip(raw, join(scratch, "entries"), GLOBAL_LIMIT);
  const prepared = await prepareDatabase(entries);
  for (const id of prepared.references) assert.ok(items.some((item) => item.metadata._id === id));
  await attachStorage(entries, items, scratch);
  const summary = await diskSummary(entries, { verifyStorage: false });
  const inventory = preflight({
    databaseBytes: (await fileDigest(raw)).bytes,
    storage: items,
    maxBytes: GLOBAL_LIMIT,
  });
  assert.ok(inventory.storageBytes >= 2 * 1024 ** 3);
  const database = join(scratch, "database.zip"),
    cipher = join(scratch, "database.age");
  await writeZip(entries, database, GLOBAL_LIMIT);
  await encrypt(database, cipher);
  const manifest = {
    format: 2,
    id: snapshotId(new Date()),
    deployment: plan.deployment,
    ...summary,
    objects,
    coldArchives: prepared.coldArchives,
    plaintext: await fileDigest(database),
    ciphertext: await fileDigest(cipher),
  };
  await publishIncremental({ plan, client: store, manifest, cipher });
  phase = "recover";
  const recoveryStarted = performance.now();
  const downloaded = join(scratch, "download.age"),
    decoded = join(scratch, "decoded.zip");
  const keys = objectKeys(plan, manifest.id);
  assert.deepEqual(JSON.parse((await store.get(keys.manifest)).toString()), manifest);
  assert.deepEqual(
    await store.getFile(keys.snapshot, downloaded, GLOBAL_LIMIT),
    manifest.ciphertext,
  );
  await decrypt(downloaded, decoded);
  assert.deepEqual(await fileDigest(decoded), manifest.plaintext);
  const restored = await extractZip(decoded, join(scratch, "decoded"), GLOBAL_LIMIT),
    zip = join(scratch, "restore.zip");
  await restoreIncremental({
    manifest,
    entries: restored,
    client: store,
    directory: scratch,
    decrypt,
    zip,
    maxBytes: GLOBAL_LIMIT,
  });
  phase = "import";
  cli(destination, ["import", zip, "--replace-all", "--yes"]);
  phase = "reexport";
  const reexport = join(scratch, "reexport.zip");
  cli(destination, ["export", "--include-file-storage", "--path", reexport]);
  const actual = await diskSummary(
    await extractZip(reexport, join(scratch, "reexport"), GLOBAL_LIMIT),
  );
  assert.deepEqual(actual.digests, summary.digests);
  assert.deepEqual(actual.storage, summary.storage);
  assert.deepEqual(
    await call(
      destination,
      "query",
      "testing/coldArchiveProof:inspectIncrementalControls",
      controls,
    ),
    {
      ready: false,
      phase: 0,
      reservedFiles: 18 * 1024 ** 2,
      reservedDatabase: 16 * 1024 ** 2,
      state: "expired",
      code: "BACKUP_REGENERATE_EXPORT",
    },
  );
  proved = true;
  console.log(
    JSON.stringify({
      passed: true,
      store: bucket ? "R2 via Wrangler" : "isolated-filesystem",
      bytes: actual.storage.bytes,
      files: actual.storage.files,
      tables: Object.keys(actual.digests).length,
      recoveryMs: performance.now() - recoveryStarted,
      totalMs: performance.now() - started,
      receiptsWritten: false,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      phase,
      code:
        error.message === "PROOF_COMMAND_FAILED" ? error.message : "LOCAL_CAPACITY_PROOF_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  // Both targets were empty or explicitly identified as this drill's disposable synthetic fixture.
  if (proved) {
    const empty = await extractZip(join(scratch, "raw.zip"), join(scratch, "empty"), GLOBAL_LIMIT);
    const storageIds = (await readFile(empty.get("_storage/documents.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)._id);
    for (const [name, path] of empty)
      if (name.endsWith("/documents.jsonl") && !name.includes("_tables/"))
        await writeFile(path, "");
    const emptyZip = join(scratch, "empty.zip");
    await writeZip(empty, emptyZip, GLOBAL_LIMIT);
    for (const target of [source, destination])
      cli(target, ["import", emptyZip, "--replace-all", "--yes"]);
    for (const target of [source, destination]) {
      const inventory = await readSystemInventory(
        (path, args, componentPath) => call(target, "query", path, args, componentPath),
        GLOBAL_LIMIT,
      );
      assert.equal(inventory.databaseBytes, 0, "Dados sintéticos ainda presentes após limpeza");
      // Import --replace-all empties tables but leaves file storage behind.
      // These IDs come from the synthetic snapshot just compared, never from an unrelated scan.
      await call(target, "mutation", "_system/frontend/fileStorageV2:deleteFiles", { storageIds });
      const files = await call(target, "query", "backupInventory:page", {
        paginationOpts: { cursor: null, numItems: 1 },
      });
      assert.ok(
        files.isDone && files.page.length === 0,
        "Arquivos sintéticos ainda presentes após limpeza",
      );
    }
    console.log("Fixtures removidas dos dois bancos locais após a comparação");
  }
  if (lockAdded)
    command(process.execPath, [
      join(root, "node_modules/wrangler/bin/wrangler.js"),
      "r2",
      "bucket",
      "lock",
      "remove",
      bucket,
      "--name",
      objectPrefix,
    ]);
  if (bucket)
    for (const key of uploaded) {
      try {
        remote("delete", `${bucket}/${key}`, "--remote");
        assert.equal(await store.head(key), null, "Objeto sintético não removido");
      } catch {
        console.error("Falha ao limpar objeto sintético");
        process.exitCode = 1;
      }
    }
  await rm(scratch, { recursive: true, force: true });
}
