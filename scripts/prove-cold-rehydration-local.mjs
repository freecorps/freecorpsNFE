// Real-path proof of the rehydration's cold stage (#689, ADR 0010, phase C2) on the local Convex
// of this worktree, with the REAL cold bucket. ADR 0009 runs need the platform profile, which a
// bare proof preview does not carry, and the archive executor locks its package prefix with a
// Cloudflare API token this proof does not use; so the executor's library runs here, against the
// local backend, with the package under `proof-689/cold/` of the cold bucket (no lock rule) and
// two throwaway age identities. The cold stage itself writes, reads back and checks every object
// in the real bucket, from the local backend's actions.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { localUrls, readLocalConfig } from "./lib/worktree/deployment.mjs";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";
import { failureCode, redact } from "./lib/hosted-read-proof.mjs";
import {
  COLD_ACCOUNT,
  COLD_BUCKET,
  PACKAGE_PREFIX,
  clearPrefixes,
  coldLocalUsage,
  coldVariables,
  keyShape,
  objectDigest,
  parseColdArgs,
  readR2Credentials,
  sha256,
  updateVariables,
  waitFor,
  PROOF_XML,
  parsedFixture,
  proofFiscalKey,
} from "./lib/cold-tier-proof.mjs";
import { r2Client } from "./lib/offsite-backup.mjs";
import {
  canonical,
  compactCatalog,
  createArchive,
  publishArchive,
  rehydrate,
  removeHot,
  verifyArchive,
} from "./lib/cold-archive.mjs";
import { repoRoot } from "./lib/repo-root.mjs";

if (process.argv.includes("--help")) {
  console.log(coldLocalUsage);
  process.exit(0);
}

const root = repoRoot;
const receiptPath = join(root, "docs/v1.0/evidence/689/receipts/local.json");
const secrets = [];
const report = {
  version: 1,
  issue: 689,
  target: "local-worktree",
  productionTouched: false,
  bucket: COLD_BUCKET,
  packagePrefix: PACKAGE_PREFIX,
  startedAt: new Date().toISOString(),
  steps: {},
};
const step = (name, value) => {
  report.steps[name] = value;
  console.log(`ok ${name}`);
};
let failed = false;
let receipt;
let cleanup = async () => {};
const DAY = 86_400_000;
const ARCHIVE_VARIABLES = { FNFE_COLD_ARCHIVE: "enabled" };

try {
  const args = parseColdArgs(process.argv.slice(2), { local: true });
  if (
    await access(receiptPath).then(
      () => true,
      () => false,
    )
  )
    throw new Error("RECEIPT_EXISTS");
  const paths = worktreePaths(root);
  const config = readLocalConfig(paths);
  if (!config || paths.app !== "platform") throw new Error("LOCAL_TARGET_INVALID");
  const urls = localUrls(config);
  if (urls.cloud !== `http://127.0.0.1:${args.port}`) throw new Error("LOCAL_TARGET_INVALID");
  secrets.push(config.adminKey);
  const credentials = readR2Credentials(args, root);
  secrets.push(credentials.accessKeyId, credentials.secretAccessKey);
  report.port = args.port;
  report.revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();

  const request = async (kind, path, callArgs = {}) => {
    const response = await fetch(`${urls.cloud}/api/${kind}`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Convex ${config.adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: callArgs, format: "json" }),
      signal: AbortSignal.timeout(180_000),
    });
    const result = await response.json();
    if (result?.status === "success") return result.value;
    // The server's code, so the executor tells a refusal from a lost response, as its CLI does.
    const code = result?.errorData?.code;
    const message =
      typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
        ? code
        : redact(String(result?.errorMessage ?? response.status).slice(0, 400), secrets);
    throw Object.assign(new Error(message), typeof code === "string" ? { refusal: { code } } : {});
  };
  const source = {
    query: (path, a) => request("query", path, a),
    mutation: (path, a) => request("mutation", path, a),
    action: (path, a) => request("action", path, a),
  };
  const safety = JSON.parse(await source.query("coldArchive:restoreSafety", {}));
  assert.ok(safety.cronsOff && safety.fiscalDisabled && safety.captureDisabled, "LOCAL_UNSAFE");
  receipt = receiptPath;

  const cold = coldVariables(credentials);
  cleanup = async () => {
    await updateVariables(
      urls.cloud,
      config.adminKey,
      Object.fromEntries(Object.keys({ ...cold, ...ARCHIVE_VARIABLES }).map((n) => [n, null])),
    );
    report.cleanup = { ...report.cleanup, variablesRemoved: true };
  };
  await updateVariables(urls.cloud, config.adminKey, { ...cold, ...ARCHIVE_VARIABLES });
  assert.equal(await source.query("testing/coldArchiveProof:gate", {}), "enabled");
  const bucket = r2Client({ accountId: COLD_ACCOUNT, bucket: COLD_BUCKET, credentials });

  const scope = await source.mutation("testing/operationProof:prepare", {
    keyHash: sha256(randomUUID()),
    suffix: `cold689-${randomUUID()}`,
  });
  const organizationId = scope.organizationId;
  const previous = cleanup;
  cleanup = async () => {
    report.cleanup = {
      objectsLeft: await clearPrefixes(
        bucket,
        [`documents/sandbox/${organizationId}/`, PACKAGE_PREFIX],
        [organizationId],
      ),
    };
    await previous();
  };
  const { keyId: _key, ...ids } = scope;
  const xml = await readFile(join(root, PROOF_XML), "utf8");
  const fixture = parsedFixture(root);
  const inspect = async () =>
    JSON.parse(await source.query("testing/coldTierProof:inspect", { organizationId }));
  const byKey = async (fiscalKey) =>
    JSON.parse(await source.query("testing/coldTierProof:byKey", { organizationId, fiscalKey }));
  const notes = {};
  const seed = async (names) => {
    for (const [name, ageDays] of names) {
      const storageId = await source.action("testing/coldArchiveProof:store", { xml });
      const fiscalKey = proofFiscalKey();
      const seeded = await source.mutation("testing/coldTierProof:seed", {
        ...ids,
        storageId,
        ageDays,
        fiscalKey,
        ...fixture,
      });
      await source.mutation("importProcessing:published", { operationId: seeded.operationId });
      notes[name] = { ...seeded, ageDays, fiscalKey };
    }
    await waitFor(async () =>
      (await Promise.all(names.map(([name]) => byKey(notes[name].fiscalKey)))).every(
        (note) => note?.versions[0]?.contentStored,
      ),
    );
    await source.mutation("contentMigration:start", { kind: "audit", restart: true });
    await waitFor(async () => {
      const state = await inspect();
      return (
        state.audit?.state === "done" &&
        (await Promise.all(names.map(([name]) => byKey(notes[name].fiscalKey)))).every(
          (note) => note?.versions[0]?.verified,
        )
      );
    });
  };
  const read = async (name) => {
    const note = await byKey(notes[name].fiscalKey);
    return {
      note,
      read: JSON.parse(
        await source.action("testing/coldTierProof:read", { documentId: note.documentId }),
      ),
    };
  };

  // 1. A note already cold in the package: the sweep moves it before the archive.
  await seed([["frozen400", 400]]);
  const hotNote = await byKey(notes.frozen400.fiscalKey);
  const hotFiles = [hotNote.versions[0].contentStorageId, hotNote.artifacts[0].storageId];
  assert.equal(await source.mutation("coldTier:start", {}), "started");
  const frozen = await waitFor(
    async () => {
      const note = await byKey(notes.frozen400.fiscalKey);
      return note?.coldState === "cold" ? note : null;
    },
    { attempts: 90, delay: 4000, code: "PASSAGE_TIMEOUT" },
  );
  // The hot files' grace: `dropHot`, as the scheduler runs it an hour later.
  for (const storageId of hotFiles)
    await source.mutation("coldTier:dropHot", { organizationId, storageId });
  assert.deepEqual(
    JSON.parse(
      await source.query("testing/coldTierProof:stored", { organizationId, storageIds: hotFiles }),
    ),
    [false, false],
  );
  const frozenRead = await read("frozen400");
  // 2. The window (10 days, Free keeps 3 months) and an older note (100 days), both hot.
  await seed([
    ["recent10", 10],
    ["old100", 100],
  ]);
  await source.mutation("testing/coldTierProof:age", { organizationId });
  const before = {
    frozen400: frozenRead.read,
    recent10: (await read("recent10")).read,
    old100: (await read("old100")).read,
  };
  // The listing rows each note held before the archive: one per filter key (`updateListings`).
  const listingsBefore = Object.fromEntries(
    await Promise.all(
      Object.keys(before).map(async (name) => [
        name,
        (await byKey(notes[name].fiscalKey)).listings,
      ]),
    ),
  );
  assert.ok(Object.values(listingsBefore).every((count) => count > 0));
  assert.equal(before.frozen400.contentTier, "cold");
  assert.equal(before.old100.contentTier, "hot");
  const frozenKeys = {
    content: frozen.versions[0].contentObjectKey,
    original: frozen.artifacts[0].objectKey,
  };
  const frozenDigest = {
    content: await objectDigest(bucket, frozenKeys.content),
    original: await objectDigest(bucket, frozenKeys.original),
  };
  step("seed", {
    plan: "free (3 meses quentes)",
    notes: {
      frozen400: "fria antes do arquivo",
      old100: "quente, fora da janela",
      recent10: "quente, na janela",
    },
    frozenKeys: [keyShape(frozenKeys.content), keyShape(frozenKeys.original)],
  });

  // 3. ADR 0009: notice, its end, freeze, package, proof, removal and catalogue.
  const scratch = await mkdtemp(join(tmpdir(), "fnfe-689-archive-"));
  const tool = (bin, toolArgs) => {
    const result = spawnSync(bin, toolArgs, {
      env: subprocessEnvironment(process.env),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    });
    if (result.status !== 0) throw new Error("AGE_FAILED");
    return result.stdout.trim();
  };
  try {
    const identities = [join(scratch, "custodian-a.key"), join(scratch, "custodian-b.key")];
    for (const identity of identities) tool("age-keygen", ["-o", identity]);
    const recipients = identities.map((identity) => tool("age-keygen", ["-y", identity]));
    const encrypt = async (from, to) =>
      tool("age", ["-e", ...recipients.flatMap((r) => ["-r", r]), "-o", to, from]);
    const decrypt = async (from, to) => tool("age", ["-d", "-i", identities[1], "-o", to, from]);
    const runId = await source.mutation("coldArchive:notice", {
      organizationId,
      key: `proof-689-${randomUUID()}`,
    });
    await source.mutation("testing/coldTierProof:elapse", { runId });
    await source.mutation("coldArchive:freeze", { runId, version: 1 });
    const created = await createArchive({ source, runId, directory: join(scratch, "package") });
    const manifest = await publishArchive({
      source,
      store: bucket,
      archive: created,
      directory: scratch,
      prefix: PACKAGE_PREFIX,
      recipients,
      encrypt,
      coldBucket: COLD_BUCKET,
      coldStore: bucket,
    });
    await verifyArchive({
      source,
      store: bucket,
      manifest,
      directory: join(scratch, "proof"),
      decrypt,
      // The real import and re-export into an isolated Convex is #691's proof; here the package
      // itself stands for the re-export, as in tests/platform.coldArchiveRehydration.test.ts.
      restoreAndExport: async (zip) => zip,
      verifierRunId: `proof-689-${randomUUID()}`,
    });
    await removeHot(source, manifest);
    await compactCatalog({
      source,
      store: bucket,
      runId,
      packageManifest: manifest,
      directory: join(scratch, "catalog"),
      recipients,
      encrypt,
      decrypt,
    });
    const archived = JSON.parse(await source.query("coldArchive:inspect", { runId }));
    assert.equal(archived.state, "archived");
    assert.equal((await inspect()).notes.length, 0);
    step("archive", {
      state: archived.state,
      rows: manifest.rows,
      files: manifest.files,
      coldDocuments: manifest.coldDocuments
        ? { count: manifest.coldDocuments.count, bucket: manifest.coldDocuments.bucket }
        : null,
      packageObjects: (await bucket.list(`${PACKAGE_PREFIX}${runId}/`)).map((key) =>
        key.slice(`${PACKAGE_PREFIX}${runId}/`.length),
      ),
      verifyArchive: "pacote decifrado e comparado; reimportação isolada não refeita (ver #691)",
      notesInOrigin: 0,
    });

    // 4. Rehydration, killed in the middle of the cold stage, then resumed.
    const upload = async ({ url, path, contentType }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: contentType ? { "Content-Type": contentType } : {},
        body: await readFile(path),
        redirect: "error",
        signal: AbortSignal.timeout(15 * 60_000),
      });
      assert.ok(response.ok, "UPLOAD_FAILED");
      const { storageId } = await response.json();
      return storageId;
    };
    let coldSeen = false;
    let interrupted = false;
    const crashing = {
      ...source,
      mutation: async (path, a) => {
        if (/coldArchiveRehydration:(coldStep|coldBatch)$/.test(path)) coldSeen = true;
        return source.mutation(path, a);
      },
    };
    const crashUpload = async (input) => {
      if (coldSeen && !interrupted) {
        interrupted = true;
        throw new Error("SIMULATED_INTERRUPTION");
      }
      return upload(input);
    };
    const options = {
      store: bucket,
      runId,
      packageManifest: manifest,
      decrypt,
    };
    const t0 = Date.now();
    await assert.rejects(
      rehydrate({
        ...options,
        source: crashing,
        directory: join(scratch, "rehydrate-1"),
        upload: crashUpload,
      }),
      /SIMULATED_INTERRUPTION/,
    );
    const halfway = JSON.parse(await source.query("coldArchive:inspect", { runId }));
    assert.equal(halfway.state, "restoring");
    assert.equal(halfway.rehydration.stage, "cold");
    const result = await rehydrate({
      ...options,
      source,
      directory: join(scratch, "rehydrate-2"),
      upload,
    });
    const back = JSON.parse(await source.query("coldArchive:inspect", { runId }));
    assert.equal(back.state, "hot");
    step("rehydration", {
      interruptedAt: { state: halfway.state, stage: halfway.rehydration.stage },
      resumed: true,
      finalState: back.state,
      finalStage: back.rehydration?.stage ?? null,
      result,
      seconds: Math.round((Date.now() - t0) / 1000),
    });

    // 5. What came back: the window hot, the older notes cold, the residue whole.
    const recent = await byKey(notes.recent10.fiscalKey);
    const old = await byKey(notes.old100.fiscalKey);
    const frozenBack = await byKey(notes.frozen400.fiscalKey);
    for (const [name, note] of [
      ["recent10", recent],
      ["old100", old],
      ["frozen400", frozenBack],
    ]) {
      assert.equal(note.listings, listingsBefore[name], `${name}.listings`);
      assert.equal(note.dedup, 1);
    }
    assert.equal(recent.coldState, null);
    assert.ok(recent.versions[0].contentStored && recent.artifacts[0].stored);
    for (const note of [old, frozenBack]) {
      assert.equal(note.coldState, "cold");
      assert.equal(note.versions[0].contentStorageId, null);
      assert.equal(note.artifacts[0].storageId, null);
      assert.deepEqual(await objectDigest(bucket, note.versions[0].contentObjectKey), {
        sha256: note.versions[0].contentObjectSha256,
        bytes: note.versions[0].contentObjectSize,
      });
      assert.deepEqual(await objectDigest(bucket, note.artifacts[0].objectKey), {
        sha256: note.artifacts[0].objectSha256,
        bytes: note.artifacts[0].objectSize,
      });
    }
    // The old note goes under its new IDs; the note cold in the package keeps its keys and bytes.
    assert.ok(old.versions[0].contentObjectKey.includes(`/${old.versions[0].versionId}/`));
    assert.ok(old.artifacts[0].objectKey.includes(`/${old.artifacts[0].artifactId}/`));
    assert.equal(frozenBack.versions[0].contentObjectKey, frozenKeys.content);
    assert.equal(frozenBack.artifacts[0].objectKey, frozenKeys.original);
    assert.deepEqual(await objectDigest(bucket, frozenKeys.content), frozenDigest.content);
    assert.deepEqual(await objectDigest(bucket, frozenKeys.original), frozenDigest.original);
    const after = {
      frozen400: (await read("frozen400")).read,
      recent10: (await read("recent10")).read,
      old100: (await read("old100")).read,
    };
    for (const name of Object.keys(after))
      for (const field of ["contentSha256", "items", "originalSha256", "originalSize"])
        assert.equal(after[name][field], before[name][field], `${name}.${field}`);
    assert.equal(after.old100.contentTier, "cold");
    assert.equal(after.recent10.contentTier, "hot");
    const state = await inspect();
    assert.equal(state.uploads.length, 0);
    step("verify", {
      window: { recent10: "quente, blob e original no storage" },
      cold: {
        old100: [keyShape(old.versions[0].contentObjectKey), keyShape(old.artifacts[0].objectKey)],
        frozen400: "mesmas chaves e bytes de antes do arquivo",
      },
      residue: { listingsPerNoteAsBeforeArchive: listingsBefore, dedupPerNote: 1 },
      readsIdenticalToBeforeArchive: Object.keys(after),
      objectsCheckedInBucket: 4,
      coldIntentsLeft: 0,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} catch (error) {
  failed = true;
  report.error = failureCode(error, secrets);
  console.error(redact(String(error?.message ?? error).slice(0, 400), secrets));
}
try {
  await cleanup();
} catch (error) {
  failed = true;
  report.cleanupError = failureCode(error, secrets);
}
if (receipt) {
  report.passed = !failed;
  report.finishedAt = new Date().toISOString();
  report.codeHashes = Object.fromEntries(
    await Promise.all(
      [
        "scripts/prove-cold-rehydration-local.mjs",
        "scripts/lib/cold-tier-proof.mjs",
        "scripts/lib/cold-archive.mjs",
        "platform/convex/testing/coldTierProof.ts",
        "platform/convex/coldArchiveRehydration.ts",
        "platform/convex/coldTier.ts",
        "platform/convex/coldTierWorker.ts",
      ].map(async (path) => [path, sha256(await readFile(join(root, path)))]),
    ),
  );
  report.limitations = [
    "Convex local do worktree, não preview hospedado: o ciclo da ADR 0009 exige o perfil da plataforma",
    "Pacote no prefixo proof-689/cold/ do bucket frio, sem regra de lock: o executor real trava o prefixo com token Cloudflare",
    "verifyArchive sem reimportação isolada (o pacote faz as vezes da reexportação); a reimportação real foi provada na #691",
    "Identidades age descartáveis; volume de três notas",
  ];
  const text = JSON.stringify(report, null, 2) + "\n";
  assert.ok(!secrets.some((secret) => secret && text.includes(secret)));
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(receipt, text);
}
if (failed) console.error(report.error ?? report.cleanupError);
process.exitCode = failed ? 1 : 0;
