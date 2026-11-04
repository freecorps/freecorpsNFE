import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { convexToJson, jsonToConvex } from "convex/values";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { readLocalConfig, localUrls } from "./lib/worktree/deployment.mjs";
import { readEnvFile, formatEnvFile } from "./lib/worktree/env-file.mjs";
import { syntheticCertificate } from "../tests/helpers/certificates.ts";
import {
  encryptCertificate,
  certificateKeyring,
} from "../platform/convex/lib/certificateCrypto.ts";
import { validateCertificate } from "../platform/convex/lib/certificateValidation.ts";
import { processNfe } from "../packages/fiscal-nfe/dist/index.js";
import { repoRoot } from "./lib/repo-root.mjs";

const root = repoRoot;
const output = join(root, ".ci-results/81");
mkdirSync(output, { recursive: true });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function target(directory) {
  const paths = worktreePaths(directory),
    config = readLocalConfig(paths);
  assert.equal(paths.app, "platform");
  assert.ok(config);
  const urls = localUrls(config);
  assert.match(urls.cloud, /^http:\/\/127\.0\.0\.1:\d+$/);
  return { paths, config, urls };
}
const source = target(root);
async function call(target, kind, path, args) {
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
  assert.equal(result.status, "success", `${path}: ${result.errorMessage ?? response.status}`);
  return jsonToConvex(result.value);
}
async function safe(target) {
  const health = await (await fetch(`${target.urls.site}/health`)).json();
  assert.equal(health.appEnv, "development");
  assert.equal(health.fiscalEnv, "disabled");
  assert.deepEqual(await call(target, "query", "_system/frontend/listCronJobs", {}), []);
  return health;
}
async function verifyKeys(target, organizationId) {
  for (let i = 0; i < 60; i++) {
    try {
      return JSON.parse(
        await call(target, "action", "testing/restoreCertificateProof:verify", { organizationId }),
      );
    } catch (error) {
      if (!error.message.includes("CERTIFICATE_KEY_UNAVAILABLE") || i === 59) throw error;
      await delay(500);
    }
  }
}
function cli(target, args, name) {
  console.log(`target: local-anonymous ${target.urls.cloud}; ${name}`);
  // Explicit loopback selectors override inherited credentials; no secret enters the shell or receipt.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("CONVEX_") && !key.startsWith("VITE_"),
    ),
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
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (run.status !== 0)
    throw new Error(
      `${name} failed: ${String(run.stderr).replaceAll(target.config.adminKey, "[redacted]")}`,
    );
  return { exitCode: run.status, logSha256: sha(`${run.stdout}\n${run.stderr}`) };
}
function setKeys(target, ring) {
  const values = readEnvFile(target.paths.backendEnv);
  values.set("FNFE_PLATFORM_CERT_KEYS", JSON.stringify(ring));
  writeFileSync(
    target.paths.backendEnv,
    formatEnvFile(Object.fromEntries(values), "Ambiente local sintético; chaves fora do snapshot"),
    "utf8",
  );
  cli(
    target,
    ["env", "set", "--from-file", target.paths.backendEnv, "--force"],
    "restore synthetic key custody",
  );
}
async function api(target, secret, path, method = "GET", body, key = randomUUID()) {
  const response = await fetch(`${target.urls.site}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Environment": "sandbox",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${result.error?.code ?? response.status}`);
  return result.data;
}
async function importXml(scope, secret, bytes) {
  const batch = await api(source, secret, "/v1/imports", "POST", {
    companyId: scope.companyId,
    files: [{ name: "sintetico.xml", size: bytes.length, sha256: sha(bytes) }],
  });
  const path = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
  const upload = await api(source, secret, `${path}/upload`, "POST");
  const response = await fetch(`${source.urls.site}/v1/import-upload`, {
    method: "POST",
    headers: { "X-Upload-Token": upload.token },
    body: bytes,
  });
  assert.equal(response.status, 200);
  await api(source, secret, `${path}/confirm`, "POST");
  for (let i = 0; i < 120; i++) {
    const value = await api(source, secret, `/v1/imports/${batch.importId}`);
    if (value.files[0].state === "succeeded")
      return { ...value.files[0], fileId: batch.fileIds[0] };
    if (value.files[0].documentId) return { ...value.files[0], fileId: batch.fileIds[0] };
    await delay(500);
  }
  throw new Error("Synthetic import did not complete");
}
const mode = process.argv[2];
const receipt = {
  codeSha: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain") !== "",
  runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  recordedAt: new Date().toISOString(),
  source: source.urls,
  syntheticOnly: true,
  result: "running",
};
try {
  assert.equal(receipt.dirty, false, "Restore proof requires a clean checkout before any writes");
  await safe(source);
  if (mode === "prepare") {
    const suffix = `restore81-${randomUUID()}`;
    const frontend = readEnvFile(source.paths.backendEnv).get("SITE_URL");
    const email = `${suffix}@development.invalid`,
      password = randomBytes(24).toString("base64url");
    const auth = async (path, body) => {
      const res = await fetch(`${source.urls.site}/api/auth/${path}`, {
        method: "POST",
        headers: { Origin: frontend, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      assert.ok(res.ok, `Local auth ${path}: ${result.code ?? res.status}`);
      return result;
    };
    const user = await auth("sign-up/email", {
      name: "Operador sintético de restauração",
      email,
      password,
    });
    const messages = await call(source, "query", "mail:inbox", { email });
    await auth("email-otp/verify-email", {
      email,
      otp: messages.find((m) => m.type === "email-verification").otp,
    });
    const secret = `fnfe_${randomBytes(32).toString("base64url")}`;
    const scope =
      /** @type {{organizationId: string, companyId: string, projectId: string, keyId: string}} */ (
        await call(source, "mutation", "testing/operationProof:prepare", {
          keyHash: sha(secret),
          suffix,
        })
      );
    const invoice = readFileSync(join(root, "tests/fixtures/nfe/4.00/invoice-authorized.xml"));
    const model = processNfe(invoice).normalized.document;
    await call(source, "mutation", "testing/restoreProof:configure", {
      ...scope,
      cnpj: model.issuer.document,
      authUserId: user.user.id,
    });
    const imported = [];
    for (const name of ["invoice-authorized", "event-110111", "invoice-authorized"]) {
      const bytes = readFileSync(join(root, `tests/fixtures/nfe/4.00/${name}.xml`));
      imported.push(await importXml(scope, secret, bytes));
    }
    // Reprocess preserves the original version and references, instead of creating another identity.
    const documentId = imported[0].documentId;
    await api(
      source,
      secret,
      `/v1/documents/${documentId}/reprocess?companyId=${scope.companyId}`,
      "POST",
      {},
    );
    for (let i = 0; i < 120; i++) {
      const data = jsonToConvex(
        JSON.parse(
          await call(source, "query", "testing/restoreProof:inspect", {
            organizationId: scope.organizationId,
          }),
        ),
      );
      if (
        data.records[0]?.versions.length >= 3 &&
        data.records.every(
          (r) =>
            r.document.projectionState === "ready" &&
            r.versions.every((v) => v.state === "complete"),
        )
      )
        break;
      if (i === 119) throw new Error("Projection did not settle");
      await delay(500);
    }
    const oldRing = certificateKeyring(
      readEnvFile(source.paths.backendEnv).get("FNFE_PLATFORM_CERT_KEYS"),
    );
    const nextKeyVersion = `restore81-${randomBytes(4).toString("hex")}`;
    const ring = {
      active: nextKeyVersion,
      keys: { ...oldRing.keys, [nextKeyVersion]: randomBytes(32).toString("hex") },
    };
    const custodyDirectory = mkdtempSync(join(tmpdir(), "fnfe81-custody-")),
      snapshotDirectory = mkdtempSync(join(tmpdir(), "fnfe81-snapshot-"));
    writeFileSync(join(custodyDirectory, "keys.json"), JSON.stringify(ring), { mode: 0o600 });
    setKeys(source, ring);
    const runtimeEnvironment = await call(
      source,
      "action",
      "testing/restoreCertificateProof:environmentVersions",
      {},
    );
    assert.ok(runtimeEnvironment.current.includes(ring.active));
    const certificateIds = await call(
      source,
      "mutation",
      "testing/restoreProof:reserveCertificates",
      scope,
    );
    for (const [index, certificateId] of certificateIds.entries()) {
      const material = syntheticCertificate({ cnpj: model.issuer.document });
      try {
        const context = {
          organizationId: scope.organizationId,
          companyId: scope.companyId,
          id: certificateId,
          version: index + 1,
        };
        await call(source, "mutation", "testing/restoreProof:seal", {
          certificateId,
          envelope: encryptCertificate(
            index === 0 ? oldRing : ring,
            context,
            material.pfx,
            material.password,
          ),
          metadata: validateCertificate(material.pfx, material.password, model.issuer.document),
        });
      } finally {
        material.pfx.fill(0);
        material.password.fill(0);
      }
    }
    const before = await call(source, "query", "testing/restoreProof:inspect", {
      organizationId: scope.organizationId,
    });
    const certProof = await verifyKeys(source, scope.organizationId);
    const exportJob = await api(source, secret, "/v1/exports", "POST", {
      companyId: scope.companyId,
      documentId,
    });
    for (let i = 0; i < 120; i++) {
      const job = await api(source, secret, `/v1/exports/${exportJob.id}`);
      if (job.state === "succeeded") break;
      assert.equal(job.state, "running");
      if (i === 119) throw new Error("Export timeout");
      await delay(500);
    }
    const parts = await api(source, secret, `/v1/exports/${exportJob.id}/parts`);
    assert.equal(parts.nextCursor, null);
    const records = [];
    for (const part of parts.page) {
      const ticket = await api(source, secret, `/v1/export-parts/${part.id}/ticket`, "POST");
      const response = await fetch(`${source.urls.site}/v1/export-download`, {
        headers: { "X-Download-Token": ticket.token },
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha(bytes), part.sha256);
      const text = gunzipSync(bytes).toString();
      assert.doesNotMatch(text, /storageId|wrappedKey|password|keyHash|tokenHash/);
      records.push(
        ...text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    }
    assert.ok(records.some((row) => row.type === "version" && row.payload.kind === "event"));
    assert.ok(
      records.some(
        (row) =>
          row.type === "original" && sha(Buffer.from(row.content, "base64")) === sha(invoice),
      ),
    );
    const snapshotStarted = Date.now(),
      snapshot = join(snapshotDirectory, "snapshot.zip");
    const exported = cli(
      source,
      ["export", "--include-file-storage", "--path", snapshot],
      "export synthetic snapshot with storage",
    );
    const snapshotFinished = Date.now();
    const postSnapshotWriteAt = await call(
      source,
      "mutation",
      "testing/restoreProof:postSnapshotWrite",
      { organizationId: scope.organizationId },
    );
    const privateState = {
      codeSha: receipt.codeSha,
      snapshotSha256: sha(readFileSync(snapshot)),
      custodySha256: sha(readFileSync(join(custodyDirectory, "keys.json"))),
      scope,
      secret,
      before,
      certificateIds,
      certProof,
      snapshot,
      custodyDirectory,
      snapshotDirectory,
      snapshotStarted,
      snapshotFinished,
      postSnapshotWriteAt,
      email,
      password,
      frontend,
      slug: suffix,
      imported,
      documentId,
      exportId: exportJob.id,
    };
    writeFileSync(join(output, "private.json"), JSON.stringify(privateState), { mode: 0o600 });
    Object.assign(receipt, {
      snapshotStarted,
      snapshotFinished,
      snapshotSha256: sha(readFileSync(snapshot)),
      domainSha256: sha(before),
      certificateProof: certProof,
      runtimeEnvironment,
      exported,
      export: {
        id: exportJob.id,
        parts: parts.page,
        records: records.length,
        originalHash: sha(invoice),
      },
      result: "passed",
    });
  } else if (mode === "restore") {
    const state = JSON.parse(readFileSync(join(output, "private.json"), "utf8"));
    assert.equal(receipt.dirty, false, "Restore source checkout must be clean");
    assert.equal(state.codeSha, receipt.codeSha, "Restore requires the snapshot code revision");
    assert.equal(
      sha(readFileSync(state.snapshot)),
      state.snapshotSha256,
      "Snapshot differs from backup",
    );
    assert.equal(
      sha(readFileSync(join(state.custodyDirectory, "keys.json"))),
      state.custodySha256,
      "Key custody differs from backup",
    );
    const destination = target(resolve(process.argv[3]));
    const destinationSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: destination.paths.root,
      encoding: "utf8",
    }).trim();
    assert.equal(
      destinationSha,
      receipt.codeSha,
      "Restore requires matching source and destination code",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: destination.paths.root,
        encoding: "utf8",
      }).trim(),
      "",
      "Restore destination must be clean",
    );
    assert.notEqual(destination.paths.root, source.paths.root);
    assert.notEqual(destination.urls.cloud, source.urls.cloud);
    await safe(destination);
    await call(destination, "query", "testing/restoreProof:assertEmpty", {});
    const started = Date.now();
    const imported = cli(
      destination,
      ["import", state.snapshot, "--replace", "--yes"],
      "restore into disposable local deployment",
    );
    const restored = await call(destination, "query", "testing/restoreProof:inspect", {
      organizationId: state.scope.organizationId,
    });
    assert.equal(
      sha(restored),
      sha(state.before),
      "Restored content/relationships/envelopes differ",
    );
    let missingKeyRejected = false;
    try {
      await call(destination, "action", "testing/restoreCertificateProof:verify", {
        organizationId: state.scope.organizationId,
      });
    } catch (error) {
      // A fresh worktree can reuse the version name with different key bytes.
      // The vault deliberately sanitizes that AEAD failure instead of exposing OpenSSL errors.
      assert.match(error.message, /CERTIFICATE_KEY_UNAVAILABLE|CERTIFICATE_ENVELOPE_INVALID/);
      missingKeyRejected = true;
    }
    assert.equal(missingKeyRejected, true);
    setKeys(
      destination,
      JSON.parse(readFileSync(join(state.custodyDirectory, "keys.json"), "utf8")),
    );
    const certificates = await verifyKeys(destination, state.scope.organizationId);
    assert.deepEqual(certificates, state.certProof);
    const originals = [];
    for (const file of state.imported) {
      const original = await call(destination, "action", "testing/importProof:original", {
        fileId: file.fileId,
      });
      const sourceOriginal = await call(source, "action", "testing/importProof:original", {
        fileId: file.fileId,
      });
      assert.deepEqual(original, sourceOriginal);
      originals.push(original);
    }
    const completed = Date.now();
    await safe(destination);
    const live = await call(source, "query", "testing/restoreProof:inspect", {
      organizationId: state.scope.organizationId,
    });
    assert.notEqual(sha(live), sha(restored), "Post-snapshot write must be absent from restore");
    Object.assign(receipt, {
      destination: destination.urls,
      imported,
      destinationSha,
      emptyTargetConfirmed: { applicationTables: true, storage: true, authentication: true },
      snapshotSha256: sha(readFileSync(state.snapshot)),
      domainSha256: sha(restored),
      originals,
      certificates,
      missingKeyRejected,
      rtoMs: completed - started,
      snapshotAgeAtRecoveryStartMs: started - state.snapshotStarted,
      rpo: {
        datasetWritesLost: 1,
        postSnapshotWriteAt: state.postSnapshotWriteAt,
        recoveryPointAgeMs: started - state.snapshotStarted,
        scope:
          "one controlled metadata write after the snapshot; measured recovery window, not a production objective",
      },
      result: "passed",
    });
    // Separate, known temporary directories; no recursive deletion or repository data removal.
    unlinkSync(state.snapshot);
    rmdirSync(state.snapshotDirectory);
    unlinkSync(join(state.custodyDirectory, "keys.json"));
    rmdirSync(state.custodyDirectory);
    receipt.restrictedTemporaryCopiesRemoved = true;
  } else throw new Error("Use prepare or restore <fresh-platform-worktree>");
} catch (error) {
  receipt.result = "failed";
  receipt.error = error.message;
  process.exitCode = 1;
}
writeFileSync(join(output, `${mode}.json`), JSON.stringify(receipt, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ mode, result: receipt.result, error: receipt.error }));
