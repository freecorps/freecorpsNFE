// D04: cópia cifrada de banco e storage fora do host de origem, monitor e ensaio de perda do host.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { convexToJson, jsonToConvex } from "convex/values";
import { releaseTarget } from "./lib/platform-release.mjs";
import { GateRefusal } from "./lib/issuance-gate.mjs";
import { issuanceBackupTarget } from "./lib/issuance-release.mjs";
import { backendRequest } from "./lib/validation.mjs";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";
import { validateBackupDirectory } from "./lib/validation-backup.mjs";
import {
  backupPlan,
  backupFailure,
  backupMetrics,
  measureBackupPhase,
  byCodeUnit,
  certificateEnvelopes,
  custodyFingerprints,
  evaluateBackups,
  objectKeys,
  r2Client,
  coldReadCredentials,
  readZip,
  sha256,
  snapshotId,
  snapshotSummary,
  verifyCustody,
  webhookSecrets,
} from "./lib/offsite-backup.mjs";
import { extractZip, fileDigest, writeZip } from "./lib/offsite-backup-zip.mjs";
import { tableRows } from "./lib/backup-table-stream.mjs";
import { withBackupLease } from "./lib/backup-lease.mjs";
import {
  sourceReferences,
  collectionPlan,
  applyCollection,
  bucketLocks,
} from "./lib/backup-collection.mjs";
import {
  attachStorage,
  copyBlob,
  ciphertextLimit,
  diskSummary,
  incrementalPlan,
  preflight,
  prepareDatabase,
  publishIncremental,
  readSystemInventory,
  coldArchiveReferences,
  validateMetadata,
  restoreIncremental,
  coldDocumentReferences,
  coldDocumentsManifest,
  verifyColdDocuments,
} from "./lib/incremental-backup.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, ".ci-results/offsite-backup");
const [mode, ...rest] = process.argv.slice(2);
const options = {},
  positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) options[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}
// Loaded inside the receipt's try: an incomplete plan must still produce a receipt.
let plan;
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
/**
 * The hosted sandbox by default, as always. `--target issuance` is the NFS-e fiscal production
 * deployment (#198): the same bucket, custody and cadence, under its own prefix; while
 * deploy/issuance-production.json names no deployment, it is skipped (`PLAN_NOT_NAMED`).
 */
const loadPlan = () => {
  const raw = readJson("deploy/offsite-backup.json");
  const sandbox = releaseTarget(readJson("deploy/platform-release.json"));
  if (options.target === undefined) return backupPlan(raw, sandbox);
  if (options.target !== "issuance") throw new Error("Use --target issuance, ou nenhum");
  if (mode !== "snapshot" && mode !== "check")
    throw new Error("--target issuance só vale para snapshot e check");
  const target = issuanceBackupTarget(
    readJson("deploy/issuance-production.json"),
    sandbox.accountId,
  );
  return backupPlan({ ...raw, prefix: `${target.deployment}/` }, target);
};
const age = process.env.AGE_BIN || "age",
  ageKeygen = process.env.AGE_KEYGEN_BIN || "age-keygen";
const storage = (metrics) =>
  r2Client({
    metrics,
    accountId: plan.accountId,
    bucket: plan.bucket,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
/**
 * The cold tier's bucket (ADR 0010, phase C), read with its own read-only token
 * (`R2_COLD_READ_*`), so the backup's write token never writes there. Without it, the backup's
 * credentials are used and need read access to that bucket. `null` without cold documents.
 */
const coldStorage = (bucket, metrics) =>
  bucket
    ? r2Client({
        metrics,
        accountId: plan.accountId,
        bucket,
        credentials: coldReadCredentials(),
      })
    : null;
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function tool(bin, args) {
  const run = spawnSync(bin, args, {
    env: subprocessEnvironment(process.env),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  // Neither executable paths nor external stderr belong in the receipt.
  if (run.status !== 0)
    throw new Error("BACKUP_CRYPTO_TOOL_FAILED: confira age e age-keygen no runner");
  return run.stdout;
}
async function productionHealth() {
  const response = await fetch(`${plan.site}/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Health de produção: HTTP ${response.status}`);
  const health = await response.json();
  assert.match(String(health.sha), /^[a-f0-9]{40}$/, "Produção não informa o SHA publicado");
  return health;
}
function convexCli(args, env, cwd) {
  const run = spawnSync(
    process.execPath,
    [join(root, "node_modules/convex/bin/main.js"), ...args],
    {
      cwd,
      env: { ...subprocessEnvironment(process.env), ...env },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  // Provider output may contain credentials; only the exit code leaves this function.
  if (run.status !== 0) throw new Error(`convex ${args[0]} falhou (código ${run.status})`);
}
/** Snapshot ids with their manifest presence, newest first. */
async function listSnapshots(client) {
  const found = new Map(),
    snapshotPrefix = `${plan.prefix}snapshots/`;
  for (const key of await client.list(snapshotPrefix)) {
    const match = key
      .slice(snapshotPrefix.length)
      .match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\/(snapshot\.zip\.age|manifest\.json)$/);
    if (!match) continue;
    found.set(match[1], { ...found.get(match[1]), [match[2]]: true });
  }
  return [...found].sort(([a], [b]) => b.localeCompare(a));
}
async function readManifest(client, id) {
  const manifest = JSON.parse((await client.get(objectKeys(plan, id).manifest)).toString("utf8"));
  assert.ok([1, 2].includes(manifest.format), `Manifesto ${id}: formato desconhecido`);
  assert.equal(manifest.id, id, `Manifesto ${id}: identificador divergente`);
  assert.equal(manifest.deployment, plan.deployment, `Manifesto ${id}: alvo divergente`);
  return manifest;
}
async function verifiedCiphertext(client, manifest) {
  const cipher = await client.get(objectKeys(plan, manifest.id).snapshot);
  assert.equal(
    cipher.length,
    manifest.ciphertext.bytes,
    `Snapshot ${manifest.id}: tamanho divergente`,
  );
  assert.equal(
    sha256(cipher),
    manifest.ciphertext.sha256,
    `Snapshot ${manifest.id}: hash divergente`,
  );
  return cipher;
}

async function snapshot(receipt) {
  assert.ok(
    process.env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${plan.deployment}|`),
    "CONVEX_DEPLOY_KEY deve ser a chave de produção do alvo aprovado",
  );
  const client = storage(receipt.metrics);
  const workdir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "fnfe-offsite-"));
  try {
    const before = await productionHealth();
    const environment = await backendRequest(
      { target: { url: plan.cloud }, key: process.env.CONVEX_DEPLOY_KEY },
      "/api/query",
      { path: "_system/cli/queryEnvironmentVariables", args: {}, format: "json" },
    );
    const custody = custodyFingerprints(
      new Map(environment.value.map(({ name, value }) => [name, value])),
    );
    const zip = join(workdir, "snapshot.zip");
    const inventory = await sourceInventory();
    receipt.preflight = preflight({
      ...inventory.database,
      storage: inventory.storage,
      maxBytes: plan.maxSnapshotBytes,
    });
    console.log(`target: prod (${plan.deployment}); export --include-file-storage`);
    const startedAt = Date.now();
    await measureBackupPhase(receipt.metrics, "export", () =>
      convexCli(
        ["export", "--include-file-storage", "--path", zip],
        { CONVEX_DEPLOY_KEY: process.env.CONVEX_DEPLOY_KEY },
        join(root, "platform"),
      ),
    );
    receipt.metrics.observed.exportZipBytes = statSync(zip).size;
    receipt.metrics.observed.snapshotZipBytes = statSync(zip).size;
    const exportedAt = Date.now();
    const after = await productionHealth();
    assert.equal(
      after.sha,
      before.sha,
      "Houve publicação durante o export; o próximo ciclo repete",
    );
    // Checked before reading: the limit exists to avoid loading an oversized export.
    assert.ok(statSync(zip).size <= plan.maxSnapshotBytes, "Snapshot acima do limite do plano");
    const plain = readFileSync(zip);
    const entries = readZip(plain);
    receipt.metrics.observed.databaseJsonlBytes = [...entries]
      .filter(([name]) => name.endsWith("/documents.jsonl"))
      .reduce((sum, [, data]) => sum + data.length, 0);
    const coldRows =
      entries
        .get("coldArchiveRuns/documents.jsonl")
        ?.toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)) ?? [];
    assert.ok(
      !coldRows.some((row) => ["deleting", "archived", "restoring"].includes(row.state)),
      "Arquivo econômico exige backup incremental com manifesto frio verificável",
    );
    const summary = snapshotSummary(entries);
    const required = [
      ...new Set(certificateEnvelopes(entries).map(({ envelope }) => envelope.keyVersion)),
    ].sort(byCodeUnit);
    for (const version of required)
      assert.ok(
        custody.FNFE_PLATFORM_CERT_KEYS.versions[version],
        `Versão de chave usada por certificados ausente do ambiente: ${version}`,
      );

    // An ephemeral recipient proves the ciphertext decrypts; its identity never leaves workdir.
    const verifier = join(workdir, "verifier.key"),
      recipients = join(workdir, "recipients.txt"),
      cipherPath = join(workdir, "snapshot.zip.age"),
      roundtrip = join(workdir, "roundtrip.zip");
    tool(ageKeygen, ["-o", verifier]);
    writeFileSync(
      recipients,
      [
        ...plan.recipients.map(({ recipient }) => recipient),
        tool(ageKeygen, ["-y", verifier]).trim(),
      ].join("\n") + "\n",
    );
    tool(age, ["-e", "-R", recipients, "-o", cipherPath, zip]);
    tool(age, ["-d", "-i", verifier, "-o", roundtrip, cipherPath]);
    assert.equal(sha256(readFileSync(roundtrip)), sha256(plain), "Cifra não reproduz o snapshot");
    for (const path of [verifier, roundtrip, zip]) unlinkSync(path);

    const cipher = readFileSync(cipherPath);
    receipt.metrics.observed.snapshotCiphertextBytes = cipher.length;
    const id = snapshotId(new Date(startedAt)),
      keys = objectKeys(plan, id);
    const manifest = {
      format: 1,
      id,
      deployment: plan.deployment,
      codeSha: before.sha,
      snapshotStartedAt: startedAt,
      exportedAt,
      plaintext: { sha256: sha256(plain), bytes: plain.length },
      ciphertext: { sha256: sha256(cipher), bytes: cipher.length },
      recipients: plan.recipients,
      tables: summary.tables,
      storage: summary.storage,
      digests: summary.digests,
      requiredCertificateKeyVersions: required,
      custody,
      runner: { sha: git("rev-parse", "HEAD"), run: process.env.GITHUB_RUN_ID ?? null },
    };
    await client.put(keys.snapshot, cipher, "application/octet-stream");
    const stored = await client.head(keys.snapshot);
    assert.equal(stored?.size, cipher.length, "Cópia enviada difere do arquivo cifrado");
    // The manifest goes last: its presence marks a complete copy.
    await client.put(
      keys.manifest,
      Buffer.from(JSON.stringify(manifest, null, 2)),
      "application/json",
    );
    Object.assign(receipt, {
      id,
      codeSha: before.sha,
      snapshotStartedAt: new Date(startedAt).toISOString(),
      exportMs: exportedAt - startedAt,
      uploadedAt: new Date().toISOString(),
      plaintextBytes: plain.length,
      ciphertext: manifest.ciphertext,
      tables: Object.keys(summary.tables).length,
      documents: Object.values(summary.tables).reduce((a, b) => a + b, 0),
      storage: summary.storage,
      custodians: plan.recipients.map(({ custodian }) => custodian),
      requiredCertificateKeyVersions: required,
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function sourceQuery(path, args, componentPath) {
  const response = await backendRequest(
    { target: { url: plan.cloud }, key: process.env.CONVEX_DEPLOY_KEY },
    "/api/query",
    { path, args, format: "json", ...(componentPath !== undefined ? { componentPath } : {}) },
  );
  return response.value;
}
async function sourceInventory(incremental = false) {
  const database = await readSystemInventory(sourceQuery, plan.maxSnapshotBytes, {
    legacyFormat: !incremental,
  });
  const storage = [];
  let cursor = null;
  let retainedBytes = 0,
    retainedFiles = 0;
  for (;;) {
    const page = await sourceQuery("backupInventory:page", {
      paginationOpts: { cursor, numItems: 128, maximumBytesRead: 2 * 1024 ** 2 },
    });
    storage.push(...page.page);
    for (const item of page.page) {
      if (!incremental || !item.exportPart || database.references.has(item.metadata._id)) {
        assert.ok(
          Number.isSafeInteger(item.metadata.size) && item.metadata.size >= 0,
          "Inventário de storage inválido",
        );
        retainedBytes += item.metadata.size;
        retainedFiles++;
      }
    }
    assert.ok(
      database.databaseBytes + retainedBytes + retainedFiles * 2048 <= plan.maxSnapshotBytes,
      "Preflight: acima do limite global; export não iniciado",
    );
    if (page.isDone) break;
    assert.ok(page.continueCursor && page.continueCursor !== cursor, "Inventário sem progresso");
    cursor = page.continueCursor;
  }
  return { database, storage };
}

async function incrementalSnapshot(receipt) {
  incrementalPlan(plan);
  assert.ok(
    process.env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${plan.deployment}|`),
    "CONVEX_DEPLOY_KEY deve ser a chave de produção do alvo aprovado",
  );
  const client = storage(receipt.metrics),
    workdir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "fnfe-incremental-"));
  try {
    const before = await productionHealth();
    const inventory = await sourceInventory(true);
    const retained = inventory.storage.filter(
      (item) => !item.exportPart || inventory.database.references.has(item.metadata._id),
    );
    receipt.preflight = preflight({
      ...inventory.database,
      storage: retained,
      maxBytes: plan.maxSnapshotBytes,
    });
    const custody = custodyFingerprints(
      new Map(
        (await sourceQuery("_system/cli/queryEnvironmentVariables", {})).map(({ name, value }) => [
          name,
          value,
        ]),
      ),
    );
    const verifier = join(workdir, "verifier.key"),
      recipients = join(workdir, "recipients.txt");
    tool(ageKeygen, ["-o", verifier]);
    writeFileSync(
      recipients,
      [...plan.recipients.map((r) => r.recipient), tool(ageKeygen, ["-y", verifier]).trim()].join(
        "\n",
      ) + "\n",
      { mode: 0o600 },
    );
    const encrypt = async (plain, cipher) => {
      const roundtrip = join(workdir, "roundtrip");
      tool(age, ["-e", "-R", recipients, "-o", cipher, plain]);
      tool(age, ["-d", "-i", verifier, "-o", roundtrip, cipher]);
      try {
        assert.deepEqual(
          await fileDigest(roundtrip),
          await fileDigest(plain),
          "Cifra não reproduz o original",
        );
      } finally {
        unlinkSync(roundtrip);
      }
    };
    const objects = new Map(),
      copied = new Map();
    const copy = async (item) => {
      const proof = await copyBlob({
        plan,
        client,
        item,
        directory: workdir,
        encrypt,
        metrics: receipt.metrics,
      });
      copied.set(item.metadata._id, item);
      objects.set(proof.plaintext.sha256, proof);
    };
    // Copy before exporting: a deletion during export can no longer destroy a required original.
    await measureBackupPhase(receipt.metrics, "initialBlobCopies", async () => {
      for (const item of retained) await copy(item);
    });
    const startedAt = Date.now(),
      id = snapshotId(new Date(startedAt)),
      keys = objectKeys(plan, id);
    assert.ok(
      !(await client.head(keys.snapshot)) && !(await client.head(keys.manifest)),
      "Snapshot já existe; não sobrescrever",
    );
    const raw = join(workdir, "database-export.zip");
    console.log(`target: prod (${plan.deployment}); export DB-only (formato 2)`);
    await measureBackupPhase(receipt.metrics, "export", () =>
      convexCli(
        ["export", "--path", raw],
        { CONVEX_DEPLOY_KEY: process.env.CONVEX_DEPLOY_KEY },
        join(root, "platform"),
      ),
    );
    receipt.metrics.observed.exportZipBytes = statSync(raw).size;
    const exportedAt = Date.now();
    assert.equal(
      (await productionHealth()).sha,
      before.sha,
      "Houve publicação durante o export; repetir",
    );
    assert.ok(statSync(raw).size <= plan.maxSnapshotBytes, "Banco acima do limite global");
    const entries = await extractZip(raw, join(workdir, "entries"), plan.maxSnapshotBytes);
    const { references, invalidatedExports, coldArchives } = await prepareDatabase(entries);
    const cold = await coldDocumentReferences(entries);
    const coldDocuments = coldDocumentsManifest(cold, plan.coldTier?.bucket);
    await verifyColdDocuments(coldStorage(coldDocuments?.bucket, receipt.metrics), cold.references);
    const missing = [...references].filter((id) => !copied.has(id));
    for (let i = 0; i < missing.length; i += 128) {
      const resolved = await sourceQuery("backupInventory:resolve", {
        ids: missing.slice(i, i + 128),
      });
      for (const item of resolved) {
        assert.ok(
          item,
          "Referência criada/removida durante snapshot sem cópia comprovada; repetir",
        );
        preflight({
          databaseBytes: statSync(raw).size,
          storage: [...copied.values(), item],
          maxBytes: plan.maxSnapshotBytes,
        });
        await copy(item);
      }
    }
    assert.ok(
      [...references].every((id) => copied.has(id)),
      "Snapshot incompleto",
    );
    await attachStorage(entries, [...copied.values()], workdir);
    const summary = await diskSummary(entries, { verifyStorage: false });
    const databaseBytes = [...entries.values()].reduce((sum, path) => sum + statSync(path).size, 0);
    preflight({ databaseBytes, storage: [...copied.values()], maxBytes: plan.maxSnapshotBytes });
    const sensitive = new Map();
    for (const name of ["certificates/documents.jsonl", "webhookEndpoints/documents.jsonl"])
      if (entries.has(name)) sensitive.set(name, readFileSync(entries.get(name)));
    const required = [
      ...new Set(certificateEnvelopes(sensitive).map(({ envelope }) => envelope.keyVersion)),
    ].sort(byCodeUnit);
    for (const version of required)
      assert.ok(
        custody.FNFE_PLATFORM_CERT_KEYS.versions[version],
        "Versão de chave ausente da custódia",
      );
    const zip = join(workdir, "database.zip"),
      cipher = join(workdir, "database.zip.age");
    await writeZip(entries, zip, plan.maxSnapshotBytes);
    receipt.metrics.observed.databaseJsonlBytes = [...entries]
      .filter(([name]) => name.endsWith("/documents.jsonl"))
      .reduce((sum, [, path]) => sum + statSync(path).size, 0);
    receipt.metrics.observed.snapshotZipBytes = statSync(zip).size;
    await encrypt(zip, cipher);
    receipt.metrics.observed.snapshotCiphertextBytes = statSync(cipher).size;
    const manifest = {
      format: 2,
      id,
      deployment: plan.deployment,
      codeSha: before.sha,
      snapshotStartedAt: startedAt,
      exportedAt,
      plaintext: await fileDigest(zip),
      ciphertext: await fileDigest(cipher),
      recipients: plan.recipients,
      ...summary,
      objects: [...objects.values()].map(({ reused: _reused, ...proof }) => proof),
      coldArchives,
      ...(coldDocuments ? { coldDocuments } : {}),
      invalidatedExports,
      requiredCertificateKeyVersions: required,
      custody,
      runner: { sha: git("rev-parse", "HEAD"), run: process.env.GITHUB_RUN_ID ?? null },
    };
    await measureBackupPhase(receipt.metrics, "publication", () =>
      publishIncremental({
        plan,
        client,
        manifest,
        cipher,
        coldStorage: (bucket) => coldStorage(bucket, receipt.metrics),
      }),
    );
    Object.assign(receipt, {
      format: 2,
      id,
      codeSha: before.sha,
      snapshotStartedAt: new Date(startedAt).toISOString(),
      exportMs: exportedAt - startedAt,
      ciphertext: manifest.ciphertext,
      storage: summary.storage,
      invalidatedExports,
      objects: objects.size,
      reusedObjects: [...objects.values()].filter((o) => o.reused).length,
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function check(receipt) {
  const client = storage(),
    snapshots = await listSnapshots(client),
    problems = [];
  let latest = null;
  for (const [id, parts] of snapshots) {
    if (!parts["manifest.json"] || !parts["snapshot.zip.age"]) continue;
    try {
      const manifest = await readManifest(client, id);
      if (manifest.format === 2) {
        await client.verifyFile(objectKeys(plan, id).snapshot, manifest.ciphertext);
        for (const object of manifest.objects)
          await client.verifyFile(object.key, object.ciphertext);
      } else await verifiedCiphertext(client, manifest);
      latest = manifest;
      break;
    } catch (error) {
      problems.push(backupFailure(error));
    }
  }
  const health = evaluateBackups(
    plan,
    snapshots.map(([id]) => id),
    latest,
    Date.now(),
  );
  problems.push(...health.problems);
  Object.assign(receipt, {
    ...health,
    problems,
    latest: latest && { id: latest.id, codeSha: latest.codeSha, ciphertext: latest.ciphertext },
  });
  if (problems.length) throw new Error("BACKUP_CHECK_FAILED: consulte problems no recibo");
}

// Recovery helpers reach TypeScript modules; Bun runs them, the CI jobs never load them.
const recoveryHelpers = async () => ({
  ...(await import("./lib/worktree/paths.mjs")),
  ...(await import("./lib/worktree/deployment.mjs")),
  ...(await import("./lib/worktree/env-file.mjs")),
  ...(await import("./lib/recovery-custody.mjs")),
});
function outsideCheckout(path) {
  const directory = validateBackupDirectory(resolve(path), root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assert.deepEqual(readdirSync(directory), [], "O diretório de recuperação precisa estar vazio");
  return directory;
}
async function openCustody(manifest, entries, custodyPath) {
  const { readEnvFile } = await recoveryHelpers();
  const values = readEnvFile(resolve(custodyPath));
  verifyCustody(manifest, values);
  const { certificateKeyring, decryptCertificate } =
    await import("../platform/convex/lib/certificateCrypto.ts");
  const ring = certificateKeyring(values.get("FNFE_PLATFORM_CERT_KEYS"));
  let certificates = 0;
  for (const { context, envelope } of certificateEnvelopes(entries)) {
    decryptCertificate(ring, context, envelope).dispose();
    certificates++;
  }
  const raw = Buffer.from(values.get("FNFE_WEBHOOK_MASTER_KEY"), "hex");
  const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  let secrets = 0;
  for (const { cipher, context } of webhookSecrets(entries)) {
    const [iv, data] = cipher.split(":").map((part) => Buffer.from(part, "hex"));
    await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: Buffer.from(context) },
      key,
      data,
    );
    secrets++;
  }
  return { values, certificates, secrets };
}
/** Custodian side: needs only R2 read access, an age identity and the separate key custody. */
async function recover(directory, receipt) {
  assert.ok(options.identity && options.custody, "Informe --identity e --custody");
  const client = storage();
  const snapshots = await listSnapshots(client);
  const id =
    options.snapshot ??
    snapshots.find(([, parts]) => parts["manifest.json"] && parts["snapshot.zip.age"])?.[0];
  assert.ok(id, "Nenhum backup externo completo encontrado");
  const manifest = await readManifest(client, id);
  if (manifest.format === 2) return recoverIncremental(directory, receipt, client, manifest);
  const cipherPath = join(directory, "snapshot.zip.age"),
    zip = join(directory, "snapshot.zip");
  writeFileSync(cipherPath, await verifiedCiphertext(client, manifest), { mode: 0o600 });
  const downloadedAt = Date.now();
  tool(age, ["-d", "-i", resolve(options.identity), "-o", zip, cipherPath]);
  unlinkSync(cipherPath);
  const plain = readFileSync(zip);
  assert.equal(sha256(plain), manifest.plaintext.sha256, "Snapshot decifrado difere do manifesto");
  const entries = readZip(plain),
    summary = snapshotSummary(entries);
  assert.deepEqual(summary.digests, manifest.digests, "Conteúdo do snapshot difere do manifesto");
  const custody = await openCustody(manifest, entries, options.custody);
  Object.assign(receipt, {
    id,
    codeSha: manifest.codeSha,
    snapshotStartedAt: new Date(manifest.snapshotStartedAt).toISOString(),
    downloadMs: downloadedAt - receipt.startedAtMs,
    ciphertext: manifest.ciphertext,
    tables: Object.keys(summary.tables).length,
    documents: Object.values(summary.tables).reduce((a, b) => a + b, 0),
    storage: summary.storage,
    certificateEnvelopesOpened: custody.certificates,
    webhookSecretsOpened: custody.secrets,
    custodyVerified: true,
  });
  return { manifest, zip, custody: custody.values };
}

async function recoverIncremental(directory, receipt, client, manifest) {
  const scratch = mkdtempSync(join(directory, "incremental-")),
    zip = join(directory, "snapshot.zip");
  try {
    const cipher = join(scratch, "database.age"),
      database = join(scratch, "database.zip");
    const actual = await client.getFile(
      objectKeys(plan, manifest.id).snapshot,
      cipher,
      ciphertextLimit(plan.maxSnapshotBytes),
    );
    assert.deepEqual(actual, manifest.ciphertext, "Cifra do banco divergente");
    tool(age, ["-d", "-i", resolve(options.identity), "-o", database, cipher]);
    assert.deepEqual(await fileDigest(database), manifest.plaintext, "Banco decifrado divergente");
    const entries = await extractZip(database, join(scratch, "entries"), plan.maxSnapshotBytes);
    const summary = await restoreIncremental({
      manifest,
      entries,
      client,
      coldStorage: (bucket) => coldStorage(bucket),
      directory: scratch,
      zip,
      maxBytes: plan.maxSnapshotBytes,
      decrypt: async (from, to) => {
        tool(age, ["-d", "-i", resolve(options.identity), "-o", to, from]);
      },
    });
    const sensitive = new Map();
    for (const name of ["certificates/documents.jsonl", "webhookEndpoints/documents.jsonl"])
      if (entries.has(name)) sensitive.set(name, readFileSync(entries.get(name)));
    const custody = await openCustody(manifest, sensitive, options.custody);
    Object.assign(receipt, {
      format: 2,
      id: manifest.id,
      codeSha: manifest.codeSha,
      snapshotStartedAt: new Date(manifest.snapshotStartedAt).toISOString(),
      ciphertext: manifest.ciphertext,
      tables: Object.keys(summary.tables).length,
      storage: summary.storage,
      invalidatedExports: manifest.invalidatedExports,
      certificateEnvelopesOpened: custody.certificates,
      webhookSecretsOpened: custody.secrets,
      custodyVerified: true,
    });
    return { manifest, zip, custody: custody.values };
  } catch (error) {
    rmSync(zip, { force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function localTarget(directory) {
  const { worktreePaths, readLocalConfig, localUrls } = await recoveryHelpers();
  const paths = worktreePaths(directory),
    config = readLocalConfig(paths);
  assert.equal(paths.app, "platform", "Destino precisa ser um worktree da plataforma");
  assert.ok(config, "Destino sem deployment local configurado");
  const urls = localUrls(config);
  assert.match(urls.cloud, /^http:\/\/127\.0\.0\.1:\d+$/, "Destino precisa ser local");
  return { paths, config, urls };
}
async function localCall(target, kind, path, args) {
  const response = await fetch(`${target.urls.cloud}/api/${kind}`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${target.config.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, args: convexToJson(args), format: "convex_encoded_json" }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.equal(
    result.status,
    "success",
    "BACKUP_LOCAL_CALL_FAILED: confira o backend local e as pré-condições do ensaio",
  );
  return jsonToConvex(result.value);
}
function localCli(target, args) {
  console.log(`target: local ${target.urls.cloud}; convex ${args[0]}`);
  // Loopback selectors override inherited Convex credentials; the admin key is local.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CONVEX_")),
  );
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
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60 * 60_000,
    },
  );
  if (run.status !== 0)
    throw new Error(`convex ${args[0]} no destino falhou (código ${run.status})`);
}
/** Host-loss rehearsal into an empty local platform worktree at the snapshot's code SHA. */
async function rehearse(receipt) {
  const { readEnvFile, formatEnvFile, recoveryKeys } = await recoveryHelpers();
  const destination = await localTarget(resolve(positional[0] ?? ""));
  const scratch = mkdtempSync(join(tmpdir(), "fnfe-d04-"));
  try {
    const { manifest, zip, custody } = await recover(scratch, receipt);
    const destinationSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: destination.paths.root,
      encoding: "utf8",
    }).trim();
    assert.equal(destinationSha, manifest.codeSha, "O destino precisa estar no SHA do snapshot");
    const health = await (await fetch(`${destination.urls.site}/health`)).json();
    assert.equal(health.appEnv, "development");
    assert.equal(health.fiscalEnv, "disabled");
    assert.deepEqual(
      await localCall(destination, "query", "_system/frontend/listCronJobs", {}),
      [],
    );
    await localCall(destination, "query", "testing/restoreProof:assertEmpty", {});

    localCli(destination, ["import", zip, "--replace", "--yes"]);
    const values = readEnvFile(destination.paths.backendEnv);
    for (const key of recoveryKeys) values.set(key, custody.get(key));
    writeFileSync(
      destination.paths.backendEnv,
      formatEnvFile(Object.fromEntries(values), "Custódia recuperada no ensaio D04"),
      { mode: 0o600 },
    );
    localCli(destination, ["env", "set", "--from-file", destination.paths.backendEnv, "--force"]);

    const reexport = join(scratch, "restored.zip");
    localCli(destination, ["export", "--include-file-storage", "--path", reexport]);
    const restored =
      manifest.format === 2
        ? await diskSummary(
            await extractZip(reexport, join(scratch, "reexport"), plan.maxSnapshotBytes),
          )
        : snapshotSummary(readZip(readFileSync(reexport)));
    const differences = Object.keys({ ...manifest.digests, ...restored.digests }).filter(
      (name) => manifest.digests[name] !== restored.digests[name],
    );
    assert.deepEqual(differences, [], `Destino difere do snapshot: ${differences.join(", ")}`);
    const completedAt = Date.now();
    const rtoHours = (completedAt - receipt.startedAtMs) / 3_600_000,
      rpoHours = (receipt.startedAtMs - manifest.snapshotStartedAt) / 3_600_000;
    Object.assign(receipt, {
      destination: destination.urls,
      destinationSha,
      importedTablesCompared: Object.keys(restored.digests).length,
      storageCompared: restored.storage,
      rtoHours,
      rpoHours,
      targets: { rpoHours: plan.rpoHours, rtoHours: plan.rtoHours },
      withinTargets: rtoHours <= plan.rtoHours && rpoHours <= plan.rpoHours,
      login: "pendente: entrar no console do destino com uma conta real e registrar o resultado",
    });
    assert.ok(receipt.withinTargets, "Ensaio fora das metas de RPO/RTO");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function collect(receipt) {
  console.log(
    `target: prod (${plan.deployment}); collect ${options.apply === undefined ? "plan" : "apply"}`,
  );
  assert.ok(
    process.env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${plan.deployment}|`),
    "CONVEX_DEPLOY_KEY deve ser a chave de produção do alvo aprovado",
  );
  const client = storage();
  await withBackupLease(client, "collection", async () => {
    const applying = options.apply !== undefined;
    const paused = async () => {
      const state = await sourceQuery("_system/frontend/deploymentState:deploymentState", {});
      assert.equal(state.state, "paused", "BACKUP_GC_SOURCE_NOT_PAUSED");
    };
    if (applying) await paused();
    const inspectZip = async (key, cipherDigest, plainDigest, archive = false) => {
      assert.ok(options.identity, "BACKUP_GC_IDENTITY_REQUIRED");
      const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "fnfe-gc-"));
      try {
        const cipher = join(directory, "input.age"),
          plain = join(directory, "input.zip");
        assert.deepEqual(
          await client.getFile(key, cipher, ciphertextLimit(plan.maxSnapshotBytes)),
          cipherDigest,
          "Cifra do banco divergente",
        );
        tool(age, ["-d", "-i", resolve(options.identity), "-o", plain, cipher]);
        assert.deepEqual(await fileDigest(plain), plainDigest, "BACKUP_GC_MANIFEST_INVALID");
        const entries = await extractZip(plain, join(directory, "expanded"), plan.maxSnapshotBytes);
        const metadata = entries.get("_storage/documents.jsonl");
        assert.ok(metadata, "Snapshot sem metadados de storage");
        const hashes = [];
        for await (const row of tableRows(metadata)) hashes.push(validateMetadata(JSON.parse(row)));
        return { hashes, coldArchives: archive ? [] : await coldArchiveReferences(entries) };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    const inventory = () =>
      collectionPlan({
        plan,
        client,
        readSource: () => sourceReferences(sourceQuery, applying),
        readSnapshotHashes: (manifest) =>
          inspectZip(
            objectKeys(plan, manifest.id).snapshot,
            manifest.ciphertext,
            manifest.plaintext,
          ),
        readArchiveHashes: async (reference) => {
          const manifest = JSON.parse(reference.body);
          const result = await inspectZip(
            manifest.objectKey,
            { sha256: manifest.ciphertextSha256, bytes: manifest.ciphertextBytes },
            { sha256: manifest.plaintextSha256, bytes: manifest.plaintextBytes },
            true,
          );
          return result.hashes;
        },
      });
    if (applying) {
      assert.match(options.apply, /^[a-f0-9]{64}$/, "BACKUP_GC_PLAN_INVALID");
      receipt.collection = await applyCollection({
        plan,
        client,
        inventory,
        assertPaused: paused,
        expected: options.apply,
        locks: bucketLocks({
          accountId: plan.accountId,
          bucket: plan.bucket,
          token: process.env.CLOUDFLARE_API_TOKEN,
        }),
      });
    } else {
      const result = await inventory();
      receipt.collection = {
        fingerprint: result.fingerprint,
        retainedPairs: result.keep.length,
        candidatePairs: result.candidates.length,
        snapshots: result.snapshots,
        deletedObjects: 0,
      };
    }
    console.log(JSON.stringify(receipt.collection));
  });
}

if (mode !== "collect") mkdirSync(output, { recursive: true });
const receipt = { mode, startedAtMs: Date.now() };
const receiptStart = performance.now();
try {
  plan = loadPlan();
  Object.assign(receipt, { deployment: plan.deployment, bucket: plan.bucket });
  if (mode === "snapshot") {
    receipt.metrics = backupMetrics(plan.incremental?.version === 2 ? 2 : 1);
    await withBackupLease(storage(), "snapshot", async () => {
      if (plan.incremental?.version === 2) await incrementalSnapshot(receipt);
      else await snapshot(receipt);
    });
  } else if (mode === "check") await check(receipt);
  else if (mode === "fetch") {
    const directory = outsideCheckout(options.out ?? "");
    try {
      await recover(directory, receipt);
    } catch (error) {
      // A rejected copy must not leave decrypted data behind.
      for (const file of ["snapshot.zip.age", "snapshot.zip"])
        rmSync(join(directory, file), { force: true });
      throw error;
    }
  } else if (mode === "rehearse") await rehearse(receipt);
  else if (mode === "collect") await collect(receipt);
  else
    throw new Error(
      "Use snapshot, check, fetch --out <dir> ou rehearse <worktree>, com --identity/--custody na recuperação",
    );
  receipt.result = "passed";
} catch (error) {
  if (error instanceof GateRefusal && error.code === "PLAN_NOT_NAMED") {
    // Nothing to copy: no fiscal production deployment exists yet.
    receipt.result = "skipped";
    receipt.error = error.message;
  } else {
    receipt.result = "failed";
    // Arbitrary provider/assertion errors can contain payloads, paths or credentials.
    receipt.error = backupFailure(error);
    process.exitCode = 1;
  }
}
if (receipt.metrics) {
  receipt.metrics.observed.durationsMs.total = performance.now() - receiptStart;
  receipt.metrics.complete = receipt.result === "passed";
}
receipt.finishedAt = new Date().toISOString();
const name = ["snapshot", "check", "fetch", "rehearse"].includes(mode) ? mode : "usage";
const file = options.target === "issuance" ? `${name}-issuance` : name;
if (mode !== "collect")
  writeFileSync(join(output, `${file}.json`), JSON.stringify(receipt, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ mode, result: receipt.result, error: receipt.error }));
