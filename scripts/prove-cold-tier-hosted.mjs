// Real-path proof of the cold tier's passage (#689, ADR 0010, phase C) on a throwaway Convex
// preview, against the real cold bucket, with synthetic Sandbox notes. The preview runs the bare
// proof profile of #642 (`requireReadProof`), with its own marker, plus the cold tier's gate and
// bucket: no platform function answers there, so REST, console and export jobs are out of reach;
// the readers they use are called directly (`testing/coldTierProof*`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  HOSTED_COLD_ENVIRONMENT,
  checkHostedEnvironment,
  coldPreviewNamePattern,
  deniedDeployments,
  deploymentSuffix,
  failureCode,
  prepareCommands,
  previewChildEnv,
  readPreviewKey,
  redact,
  resolvePreviewTarget,
  verifyPreviewEnvironment,
} from "./lib/hosted-read-proof.mjs";
import {
  COLD_ACCOUNT,
  COLD_BUCKET,
  clearPrefixes,
  coldHostedUsage,
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
import { coldReadCredentials, r2Client } from "./lib/offsite-backup.mjs";
import { extractZip } from "./lib/offsite-backup-zip.mjs";
import { coldDocumentReferences, verifyColdDocuments } from "./lib/incremental-backup.mjs";

if (process.argv.includes("--help")) {
  console.log(coldHostedUsage);
  process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const receiptPath = join(root, "docs/v1.0/evidence/689/receipts/hosted.json");
const secrets = [];
const report = {
  version: 1,
  issue: 689,
  target: "hosted-preview",
  productionTouched: false,
  bucket: COLD_BUCKET,
  startedAt: new Date().toISOString(),
  steps: {},
};
let receipt;
let failed = false;
let cleanup = async () => {};
const step = (name, value) => {
  report.steps[name] = value;
  console.log(`ok ${name}`);
};
try {
  const args = parseColdArgs(process.argv.slice(2));
  checkHostedEnvironment(process.env);
  const parsed = readPreviewKey(args.keyFile, root);
  secrets.push(parsed.key);
  if (args.prepare) {
    const commands = prepareCommands(parsed, args.keyFile, args.previewName, {
      environment: HOSTED_COLD_ENVIRONMENT,
      namePattern: coldPreviewNamePattern,
    });
    console.log(`preparando ${args.previewName}: deploy e ${commands.length - 1} variáveis`);
    for (const command of commands)
      try {
        execFileSync(process.execPath, ["node_modules/convex/bin/main.js", ...command], {
          cwd: join(root, "platform"),
          env: previewChildEnv(process.env),
          stdio: "inherit",
        });
      } catch {
        throw new Error(`PREPARE_${command[0] === "deploy" ? "DEPLOY" : "ENV"}_FAILED`);
      }
    console.log("preview preparado; rode --run com o mesmo --preview-name");
    process.exit(0);
  }
  if (
    await access(receiptPath).then(
      () => true,
      () => false,
    )
  )
    throw new Error("RECEIPT_EXISTS");
  const credentials = readR2Credentials(args, root);
  secrets.push(credentials.accessKeyId, credentials.secretAccessKey);
  const clientVersion = JSON.parse(
    await readFile(join(root, "platform/node_modules/convex/package.json"), "utf8"),
  ).version;
  const target = await resolvePreviewTarget(parsed, args.previewName, {
    clientVersion,
    denied: deniedDeployments(root),
  });
  secrets.push(target.adminKey);
  report.previewName = args.previewName;
  report.deploymentSuffix = deploymentSuffix(target.deploymentName);
  report.revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  console.log(
    `alvo: preview ...-${report.deploymentSuffix} (${args.previewName}); dados sintéticos`,
  );
  async function call(kind, path, callArgs = {}) {
    let result;
    try {
      const response = await fetch(`${target.url}/api/${kind}`, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Convex ${target.adminKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path, args: callArgs, format: "json" }),
        signal: AbortSignal.timeout(180_000),
      });
      result = await response.json();
    } catch {
      throw new Error("PROOF_CALL_FAILED");
    }
    if (result?.status !== "success") {
      // Synthetic data only; the message still goes through the redaction before the terminal.
      console.error(`${path}: ${redact(String(result?.errorMessage).slice(0, 400), secrets)}`);
      throw new Error("PROOF_CALL_FAILED");
    }
    return result.value;
  }
  // The bare profile first, before anything is written; then the gate and the bucket, and the
  // exact list again, values compared in memory.
  await verifyPreviewEnvironment(call, HOSTED_COLD_ENVIRONMENT);
  receipt = receiptPath;
  const cold = coldVariables(credentials);
  cleanup = async () => {
    await updateVariables(
      target.url,
      target.adminKey,
      Object.fromEntries(Object.keys(cold).map((name) => [name, null])),
    );
    await verifyPreviewEnvironment(call, HOSTED_COLD_ENVIRONMENT);
    report.cleanup = { ...report.cleanup, coldVariablesRemoved: true };
  };
  await updateVariables(target.url, target.adminKey, cold);
  await verifyPreviewEnvironment(call, { ...HOSTED_COLD_ENVIRONMENT, ...cold });
  const safety = JSON.parse(await call("query", "coldArchive:restoreSafety"));
  assert.ok(safety.cronsOff && safety.fiscalDisabled && safety.captureDisabled, "PREVIEW_UNSAFE");
  const bucket = r2Client({ accountId: COLD_ACCOUNT, bucket: COLD_BUCKET, credentials });

  // Synthetic organization and four Sandbox notes, published by the real writer and audited by
  // the real B7 audit. No plan: 12 hot months. 500 and 400 days go cold; 200 days is read by the
  // sweep and stays in the window; 30 days is not even read.
  const xml = await readFile(join(root, PROOF_XML), "utf8");
  const fixture = parsedFixture(root);
  const scope = await call("mutation", "testing/operationProof:prepare", {
    keyHash: sha256(randomUUID()),
    suffix: `cold689-${randomUUID()}`,
  });
  const organizationId = scope.organizationId;
  const previous = cleanup;
  cleanup = async () => {
    report.cleanup = {
      objectsLeft: await clearPrefixes(
        bucket,
        [`documents/sandbox/${organizationId}/`],
        [organizationId],
      ),
    };
    await previous();
  };
  const { keyId: _key, ...ids } = scope;
  const plan = [
    ["old500", 500],
    ["old400", 400],
    ["window200", 200],
    ["recent30", 30],
  ];
  const notes = {};
  for (const [name, ageDays] of plan) {
    const storageId = await call("action", "testing/coldArchiveProof:store", { xml });
    const fiscalKey = proofFiscalKey();
    const seeded = await call("mutation", "testing/coldTierProof:seed", {
      ...ids,
      storageId,
      ageDays,
      fiscalKey,
      ...fixture,
    });
    await call("mutation", "importProcessing:published", { operationId: seeded.operationId });
    notes[name] = { ...seeded, ageDays };
  }
  const inspect = async () =>
    JSON.parse(await call("query", "testing/coldTierProof:inspect", { organizationId }));
  const view = (state, name) => state.notes.find((n) => n.documentId === notes[name].documentId);
  await waitFor(async () => {
    const state = await inspect();
    return plan.every(([name]) => view(state, name)?.versions[0]?.contentStored === true);
  });
  await call("mutation", "contentMigration:start", { kind: "audit", restart: true });
  const audited = await waitFor(async () => {
    const state = await inspect();
    return state.audit?.state === "done" &&
      plan.every(([name]) => view(state, name)?.versions[0]?.verified)
      ? state
      : null;
  });
  step("seed", {
    notes: plan.map(([name, ageDays]) => ({
      name,
      ageDays,
      items: fixture.items.length,
      model: "55",
    })),
    environment: "sandbox",
    original: PROOF_XML,
    phaseBBlobs: 4,
    b7Audit: audited.audit.counts,
  });

  const readAll = async () =>
    Object.fromEntries(
      await Promise.all(
        plan.map(async ([name]) => [
          name,
          {
            ...JSON.parse(
              await call("action", "testing/coldTierProof:read", {
                documentId: notes[name].documentId,
              }),
            ),
            ...JSON.parse(
              await call("action", "testing/coldTierProofNode:render", {
                documentId: notes[name].documentId,
              }),
            ),
          },
        ]),
      ),
    );
  const before = await readAll();
  for (const value of Object.values(before))
    assert.ok(value.contentTier === "hot" && value.originalTier === "hot");
  const hotFiles = Object.fromEntries(
    ["old500", "old400"].map((name) => {
      const note = view(audited, name);
      return [name, [note.versions[0].contentStorageId, note.artifacts[0].storageId]];
    }),
  );

  // The passage: the operator's `coldTier:start`, then the scheduler alone.
  const started = await call("mutation", "coldTier:start");
  assert.equal(started, "started");
  const t0 = Date.now();
  const passed = await waitFor(
    async () => {
      const state = await inspect();
      return state.sweep?.state === "done" &&
        ["old500", "old400"].every((name) => view(state, name)?.coldState === "cold")
        ? state
        : null;
    },
    { attempts: 90, delay: 4000, code: "PASSAGE_TIMEOUT" },
  );
  const objects = {};
  for (const name of ["old500", "old400"]) {
    const note = view(passed, name);
    const [version] = note.versions;
    const [artifact] = note.artifacts;
    const contentKey = `documents/sandbox/${organizationId}/${version.versionId}/content-${version.contentSha256}.gz`;
    const originalKey = `documents/sandbox/${organizationId}/${artifact.artifactId}/original-${artifact.sha256}.gz`;
    assert.equal(version.contentObjectKey, contentKey);
    assert.equal(version.contentStorageId, null);
    assert.equal(artifact.objectKey, originalKey);
    assert.equal(artifact.storageId, null);
    const content = await objectDigest(bucket, contentKey);
    assert.deepEqual(content, {
      sha256: version.contentObjectSha256,
      bytes: version.contentObjectSize,
    });
    const originalObject = await bucket.get(originalKey);
    assert.deepEqual(
      { sha256: sha256(originalObject), bytes: originalObject.length },
      { sha256: artifact.objectSha256, bytes: artifact.objectSize },
    );
    const raw = gunzipSync(originalObject);
    assert.deepEqual(
      { sha256: sha256(raw), bytes: raw.length },
      {
        sha256: artifact.sha256,
        bytes: artifact.size,
      },
    );
    objects[name] = { contentKey, originalKey };
  }
  for (const name of ["window200", "recent30"]) {
    const note = view(passed, name);
    assert.equal(note.coldState, null);
    assert.ok(note.versions[0].contentStored && note.artifacts[0].stored);
    assert.equal(note.versions[0].contentObjectKey, null);
  }
  assert.equal(passed.uploads.length, 0);
  step("passage", {
    started,
    secondsUntilCold: Math.round((Date.now() - t0) / 1000),
    sweepCounts: passed.sweep.counts,
    cold: ["old500", "old400"],
    hot: ["window200", "recent30"],
    keys: Object.values(objects).flatMap((o) => [keyShape(o.contentKey), keyShape(o.originalKey)]),
    objectsCheckedInBucket: 4,
    contentObjectMatchesRow: true,
    originalObjectMatchesRow: true,
    originalGunzipMatchesXml: true,
    intentsLeft: 0,
  });

  // The hot files stay for `HOT_GRACE` (1 h); `dropHot` is what the scheduler runs then.
  const storedFiles = async () =>
    JSON.parse(
      await call("query", "testing/coldTierProof:stored", {
        organizationId,
        storageIds: Object.values(hotFiles).flat(),
      }),
    );
  const duringGrace = await storedFiles();
  assert.ok(duringGrace.every(Boolean));
  for (const storageId of Object.values(hotFiles).flat())
    await call("mutation", "coldTier:dropHot", { organizationId, storageId });
  const afterGrace = await storedFiles();
  assert.ok(afterGrace.every((stored) => !stored));
  step("hotGrace", {
    filesDuringGrace: duringGrace.length,
    storedDuringGrace: true,
    droppedBy: "coldTier:dropHot, chamado antes da hora agendada",
    storedAfterDrop: 0,
  });

  const after = await readAll();
  const compared = ["contentSha256", "items", "originalSha256", "originalSize"];
  const node = ["danfeSha256", "danfeBytes", "exportRecordSha256"];
  for (const [name] of plan) {
    for (const field of [...compared, ...node])
      assert.equal(after[name][field], before[name][field], `${name}.${field}`);
    const cold = ["old500", "old400"].includes(name);
    assert.equal(after[name].contentTier, cold ? "cold" : "hot");
    assert.equal(after[name].originalTier, cold ? "cold" : "hot");
  }
  step("reads", {
    readers: [
      "lib/documentContentRead.readStoredContent (detalhe, itens, versões)",
      "lib/documentOriginalRead.readOriginal (download REST/ticket, DANFE, exportação)",
      "renderDanfe de @freecorps/fiscal-nfe (o gerador de danfeWorker.render)",
      "registro original da exportação, como exportWorker.runExport o monta",
    ],
    identicalAfterPassage: Object.fromEntries(
      plan.map(([name]) => [name, [...compared, ...node].map((f) => f)]),
    ),
    danfeSha256Prefix: before.old500.danfeSha256.slice(0, 12),
    originalSha256Prefix: before.old500.originalSha256.slice(0, 12),
  });

  // Backup: a real export of the preview, read by the backup's own code, checked against the
  // bucket with full reads; a reference with another hash is refused.
  const scratch = await mkdtemp(join(tmpdir(), "fnfe-689-export-"));
  try {
    const zip = join(scratch, "preview.zip");
    try {
      execFileSync(
        process.execPath,
        [
          "node_modules/convex/bin/main.js",
          "export",
          "--env-file",
          args.keyFile,
          "--preview-name",
          args.previewName,
          "--path",
          zip,
        ],
        { cwd: join(root, "platform"), env: previewChildEnv(process.env), stdio: "ignore" },
      );
    } catch {
      throw new Error("PREVIEW_EXPORT_FAILED");
    }
    const entries = await extractZip(zip, join(scratch, "entries"), 256 * 1024 ** 2);
    const references = await coldDocumentReferences(entries);
    const expected = Object.values(objects)
      .flatMap((o) => [o.contentKey, o.originalKey])
      .sort();
    assert.deepEqual(references.references.map((r) => r.key).sort(), expected);
    const reader = r2Client({
      accountId: COLD_ACCOUNT,
      bucket: COLD_BUCKET,
      credentials: coldReadCredentials({
        R2_COLD_READ_ACCESS_KEY_ID: credentials.accessKeyId,
        R2_COLD_READ_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      }),
    });
    await verifyColdDocuments(reader, references.references, { full: true });
    const [first] = references.references;
    await assert.rejects(
      verifyColdDocuments(reader, [{ ...first, sha256: "0".repeat(64) }], { full: true }),
    );
    await assert.rejects(
      verifyColdDocuments(reader, [{ ...first, bytes: first.bytes + 1 }], { full: false }),
    );
    step("backup", {
      export: "convex export do preview (ZIP sem arquivos)",
      references: references.count,
      kinds: {
        content: references.references.filter((r) => r.key.includes("/content-")).length,
        original: references.references.filter((r) => r.key.includes("/original-")).length,
      },
      digestPrefix: references.digest.slice(0, 12),
      verifiedFull: true,
      tamperedHashRefused: true,
      wrongSizeRefusedByHead: true,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  // Purge: the guard's queue, then the collection; and an orphan intent, collected with it.
  const queued = await call("mutation", "testing/coldTierProof:purge", {
    documentId: notes.old500.documentId,
  });
  assert.deepEqual(
    [...queued].sort(),
    [objects.old500.contentKey, objects.old500.originalKey].sort(),
  );
  const orphanKey = await call("action", "testing/coldTierProof:orphan", { organizationId });
  assert.ok(await bucket.head(orphanKey));
  const collected = await call("action", "coldTierWorker:collect");
  assert.equal(collected, 3);
  for (const key of [objects.old500.contentKey, objects.old500.originalKey, orphanKey])
    assert.equal(await bucket.head(key), null, keyShape(key));
  for (const key of [objects.old400.contentKey, objects.old400.originalKey])
    assert.ok(await bucket.head(key), keyShape(key));
  const final = await inspect();
  assert.equal(final.deletions.length, 0);
  assert.equal(final.uploads.length, 0);
  step("collect", {
    purgeQueued: queued.length,
    orphanIntents: 1,
    deletedByCollect: collected,
    goneFromBucket: 3,
    otherNoteIntact: true,
    queueLeft: 0,
    intentsLeft: 0,
  });
} catch (error) {
  failed = true;
  report.error = failureCode(error, secrets);
  if (error instanceof assert.AssertionError)
    console.error(redact(String(error.message).slice(0, 400), secrets));
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
  try {
    report.localChanges =
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
  } catch {
    report.localChanges = "unavailable";
  }
  report.codeHashes = Object.fromEntries(
    await Promise.all(
      [
        "scripts/prove-cold-tier-hosted.mjs",
        "scripts/lib/cold-tier-proof.mjs",
        "scripts/lib/hosted-read-proof.mjs",
        "platform/convex/testing/coldTierProof.ts",
        "platform/convex/testing/coldTierProofNode.ts",
        "platform/convex/coldTier.ts",
        "platform/convex/coldTierWorker.ts",
        "platform/convex/lib/coldObjects.ts",
        "platform/convex/lib/documentOriginalRead.ts",
        "scripts/lib/incremental-backup.mjs",
      ].map(async (path) => [path, sha256(await readFile(join(root, path)))]),
    ),
  );
  report.limitations = [
    "Preview com o perfil nu da #642: REST, ticket do console, job de exportação e cache do DANFE não respondem nele; os leitores que eles usam foram chamados direto",
    "Expurgo pela fila explícita (testing/coldTierProof:purge), com o efeito do fiscalGuard; o prazo da guarda não foi simulado",
    "HOT_GRACE de 1 h encurtado chamando coldTier:dropHot, a função que o agendador roda",
    "Volume pequeno: quatro notas com os itens da fixture; sem concorrência nem medida de custo",
    "Hashes das fontes locais; o código publicado no preview é o da revisão registrada",
  ];
  const text = JSON.stringify(report, null, 2) + "\n";
  assert.ok(!secrets.some((secret) => secret && text.includes(secret)));
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(receipt, text);
}
if (failed) console.error(report.error ?? report.cleanupError);
process.exitCode = failed ? 1 : 0;
