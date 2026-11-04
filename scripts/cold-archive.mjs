import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { backendRequest } from "./lib/validation.mjs";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";
import { byCodeUnit, coldReadCredentials, r2Client, sha256 } from "./lib/offsite-backup.mjs";
import { cloudflareLocks } from "./lib/cold-tier-locks.mjs";
import {
  assertIsolatedRestore,
  assistedExport,
  canonical,
  collectOrphans,
  compactCatalog,
  createArchive,
  publishArchive,
  rehydrate,
  removeHot,
  restoreIsolated,
  validateAssistedRequest,
  validateManifest,
  verifyArchive,
} from "./lib/cold-archive.mjs";
import { r2LockClient, runLockRule } from "./lib/r2-lock.mjs";
import { repoRoot } from "./lib/repo-root.mjs";

const root = repoRoot;
function tool(bin, args) {
  const result = spawnSync(bin, args, {
    cwd: join(root, "platform"),
    env: subprocessEnvironment(process.env),
    windowsHide: true,
    encoding: "utf8",
    timeout: 60 * 60_000,
    maxBuffer: 2 * 1024 ** 2,
  });
  // CLI output may contain customer rows/URLs/credentials. Never forward it to a receipt/log.
  if (result.status !== 0)
    throw new Error("Ferramenta administrativa falhou; nenhum recibo de prova emitido");
}
export function validateTargets(config) {
  const source = new URL(config.sourceUrl),
    destination = new URL(config.destinationUrl);
  assert.ok(source.protocol === "https:" || ["127.0.0.1", "localhost"].includes(source.hostname));
  assert.ok(
    destination.protocol === "http:" && ["127.0.0.1", "localhost"].includes(destination.hostname),
    "Ensaio exige destino isolado em loopback",
  );
  assert.notEqual(
    source.port || "443",
    destination.port,
    "Origem e destino precisam ser distintos",
  );
  assert.equal(config.destinationIsDisposable, true, "Destino precisa ser descartável");
  assert.equal(
    config.retentionConfigured,
    true,
    "Lock e retenção por referências são obrigatórios",
  );
  assert.ok(
    config.prefix.endsWith("/cold/"),
    "Prefixo frio deve ser separado de snapshots e objetos",
  );
  assert.ok(
    Array.isArray(config.recipients) && new Set(config.recipients).size >= 2,
    "Dois custodiantes são obrigatórios",
  );
  if (config.coldBucket !== undefined)
    assert.match(config.coldBucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "Bucket frio inválido");
  // ADR 0010, C2: the budget of one batch of the rehydration's cold stage, in MiB.
  if (config.coldBatchMiB !== undefined)
    assert.ok(
      Number.isSafeInteger(config.coldBatchMiB) &&
        config.coldBatchMiB > 0 &&
        config.coldBatchMiB <= 1024,
      "Lote da camada fria inválido",
    );
  return config;
}
/** A refusal code of the server, like `ASSISTED_EXPORT_NOT_OWNER`, with no message nor data. */
const REFUSAL = /^[A-Z][A-Z0-9_]{2,63}$/;
/**
 * The code an interrupted run prints: the server's refusal, or the executor's own check that
 * failed with a bare code (`assertIsolatedRestore` before reading R2). Any other message may carry
 * customer data and is never printed.
 */
export function refusalOf(error) {
  if (error?.refusal) return error.refusal;
  const message = String(error?.message ?? "");
  return /^ARCHIVE_[A-Z0-9_]{2,57}$/.test(message) ? { code: message } : null;
}
function client(url, key) {
  assert.ok(key, "Credencial administrativa ausente");
  const request = async (kind, path, args) => {
    let refusal;
    // Only the server's refusal code reaches the operator: messages may carry customer data.
    const peek = async (input, init) => {
      const response = await fetch(input, init);
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      const data = body?.status === "error" ? body.errorData : null;
      if (typeof data?.code === "string" && REFUSAL.test(data.code))
        refusal = {
          code: data.code,
          ...(Number.isSafeInteger(data.retryAt) ? { retryAt: data.retryAt } : {}),
        };
      return response;
    };
    try {
      return (
        await backendRequest(
          { target: { url }, key },
          `/api/${kind}`,
          { path, args, format: "json" },
          peek,
        )
      ).value;
    } catch (error) {
      if (refusal) throw Object.assign(new Error(refusal.code), { refusal });
      throw error;
    }
  };
  return {
    query: (path, args) => request("query", path, args),
    mutation: (path, args) => request("mutation", path, args),
    action: (path, args) => request("action", path, args),
  };
}
/** Downloads a generated part from the loopback destination, never following a redirect. */
async function downloadPart(config, url) {
  const target = new URL(url),
    destination = new URL(config.destinationUrl);
  assert.equal(target.origin, destination.origin, "Parte fora do destino isolado");
  const response = await fetch(target, {
    redirect: "error",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  assert.ok(response.ok, "Falha ao baixar a parte do destino");
  return Buffer.from(await response.arrayBuffer());
}
/** Uploads a part to the origin's upload URL, with the private MIME of the export parts. */
async function uploadPart(url, bytes) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.freecorps.export+gzip" },
    body: bytes,
    redirect: "error",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  assert.ok(response.ok, "Falha no envio da parte");
  const { storageId } = await response.json();
  assert.ok(typeof storageId === "string" && /^[A-Za-z0-9_-]+$/.test(storageId));
  return storageId;
}
export async function assertRestoreDestination(config, destination) {
  validateTargets(config);
  const safety = JSON.parse(await destination.query("coldArchive:restoreSafety", {}));
  assert.ok(
    safety.cronsOff && safety.fiscalDisabled && safety.captureDisabled,
    "Destino deve ter crons, emissão e captura fiscal desativados",
  );
}
/**
 * Sends one original to a Convex upload URL (ADR 0009, §5, item 4) with its content type and
 * returns the new storage ID. The bytes are checked by the server before anything points at them.
 */
async function uploadOriginal({ url, path, contentType }) {
  const response = await fetch(url, {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    body: await readFile(path),
    redirect: "error",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  assert.ok(response.ok, "Falha no envio do original");
  const { storageId } = await response.json();
  assert.ok(typeof storageId === "string" && /^[A-Za-z0-9_-]+$/.test(storageId));
  return storageId;
}
export async function main(args = process.argv.slice(2)) {
  const [mode, configPath, runId, identityPath, requestPath] = args;
  assert.ok(
    [
      "notice",
      "freeze",
      "archive",
      "compact",
      "restore",
      "export",
      "rehydrate",
      "orphans",
      "renew",
      "due",
    ].includes(mode),
    "Use notice|freeze|archive|compact|restore|export|rehydrate|orphans|renew|due plano.json organizaçãoOuRunIdOuDias [chaveOuIdentidade] [pedido.json]",
  );
  // The assisted export (ADR 0009, §7) reads the support request before touching anything.
  const request =
    mode === "export"
      ? validateAssistedRequest(JSON.parse(await readFile(resolve(requestPath ?? ""), "utf8")))
      : null;
  const config = validateTargets(JSON.parse(await readFile(resolve(configPath), "utf8")));
  const source = client(config.sourceUrl, process.env.CONVEX_DEPLOY_KEY);
  if (mode === "notice") {
    const id = await source.mutation("coldArchive:notice", {
      organizationId: runId,
      key: identityPath,
    });
    console.log(JSON.stringify({ state: "notice", runId: id }));
    return;
  }
  if (mode === "due") {
    // Packages whose custody ends within the given days, for `renew` (ADR 0009, §2).
    const days = Number(runId);
    assert.ok(Number.isSafeInteger(days) && days > 0, "Informe os dias até o vencimento");
    console.log(
      JSON.stringify(
        await source.query("coldArchive:renewalDue", { before: Date.now() + days * 86_400_000 }),
      ),
    );
    return;
  }
  const run = JSON.parse(await source.query("coldArchive:inspect", { runId }));
  // Every object of a run lives under `<prefix><runId>/`, locked by the run's own dated rule.
  const lockRule = () =>
    runLockRule(run.manifest ? JSON.parse(run.manifest).prefix : config.prefix, runId);
  const locks = () =>
    r2LockClient({
      accountId: config.accountId,
      bucket: config.bucket,
      token: process.env.R2_LOCK_API_TOKEN,
    });
  if (mode === "renew") {
    // Lock first, then record: the run never claims a date R2 does not already hold.
    const retention = await source.query("coldArchive:retention", { runId });
    const lockedUntil = await locks().ensure(lockRule(), retention.target);
    await source.mutation("coldArchive:renewRetention", {
      runId,
      version: retention.version,
      retainUntil: retention.target,
    });
    console.log(
      JSON.stringify({
        runId,
        retainUntil: retention.target,
        previous: retention.retainUntil,
        lockedUntil,
      }),
    );
    return;
  }
  // The isolated restore (ADR 0009, §7) serves closed and open organizations alike, read-only;
  // a run without a sealed package, or an open organization already rehydrated, stops here.
  if (mode === "restore" || mode === "export") assertIsolatedRestore(run);
  const fence = { runId, version: run.version };
  if (mode === "orphans") {
    // Orphan uploads of a rehydration, once old enough to judge (ADR 0009, §5, item 4).
    console.log(JSON.stringify(await collectOrphans({ source, runId })));
    return;
  }
  if (mode === "freeze") {
    await source.mutation("coldArchive:freeze", fence);
    console.log("Congelamento concluído.");
    return;
  }
  assert.ok(identityPath, "Identidade age do custodiante é obrigatória");
  // Compacting the catalogue (ADR 0009, §4) and rehydrating (§5) only talk to the source and R2.
  const destination =
    mode === "compact" || mode === "rehydrate"
      ? null
      : client(config.destinationUrl, process.env.COLD_ARCHIVE_DESTINATION_ADMIN_KEY);
  if (destination) await assertRestoreDestination(config, destination);
  const scratch = await mkdtemp(join(tmpdir(), "fnfe-cold-"));
  try {
    const recipients = join(scratch, "recipients.txt");
    await writeFile(recipients, config.recipients.join("\n"), { mode: 0o600 });
    const store = r2Client({
      accountId: config.accountId,
      bucket: config.bucket,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    const age = process.env.AGE_BIN || "age";
    const decrypt = async (from, to) =>
      tool(age, ["-d", "-i", resolve(identityPath), "-o", to, from]);
    const encrypt = async (from, to) => tool(age, ["-e", "-R", recipients, "-o", to, from]);
    const custody = (manifest) =>
      assert.equal(
        manifest.recipientSetSha256,
        sha256([...config.recipients].sort(byCodeUnit).join("\n")),
        "Custódia diverge do plano",
      );
    const compact = (manifest) =>
      compactCatalog({
        source,
        store,
        runId,
        packageManifest: manifest,
        directory: join(scratch, "catalog"),
        recipients: config.recipients,
        encrypt,
        decrypt,
      });
    if (mode === "rehydrate") {
      assert.ok(run.manifest, "Run sem pacote selado");
      const manifest = validateManifest(JSON.parse(run.manifest));
      custody(manifest);
      // The rehydration reads the catalogue from R2: finish a compaction left halfway first.
      if (run.state === "archived" && run.catalog?.state !== "compacted") await compact(manifest);
      const result = await rehydrate({
        source,
        store,
        runId,
        packageManifest: manifest,
        directory: join(scratch, "rehydrate"),
        decrypt,
        upload: uploadOriginal,
        // Without it, `REHYDRATE_COLD_BATCH_BYTES`.
        coldBatchBytes: config.coldBatchMiB ? config.coldBatchMiB * 1024 ** 2 : undefined,
      });
      console.log(JSON.stringify({ state: "hot", ...result }));
      return;
    }
    if (mode === "compact") {
      assert.ok(run.manifest, "Run sem pacote selado");
      const manifest = validateManifest(JSON.parse(run.manifest));
      custody(manifest);
      await locks().ensure(lockRule(), run.retainUntil);
      const catalog = await compact(manifest);
      console.log(
        JSON.stringify({
          state: "archived",
          catalog: "compacted",
          entries: catalog.entries,
          catalogManifestSha256: sha256(canonical(catalog)),
        }),
      );
      return;
    }
    const cli = (url, key, command) =>
      tool(process.execPath, [
        join(root, "platform/node_modules/convex/bin/main.js"),
        ...command,
        "--url",
        url,
        "--admin-key",
        key,
      ]);
    const restoreAndExport = async (zip) => {
      await assertRestoreDestination(config, destination);
      // Clear table-number collisions in this separately named disposable loopback only.
      cli(config.destinationUrl, process.env.COLD_ARCHIVE_DESTINATION_ADMIN_KEY, [
        "import",
        zip,
        "--replace-all",
        "--yes",
      ]);
      const exported = join(scratch, `reexport-${randomUUID()}.zip`);
      cli(config.destinationUrl, process.env.COLD_ARCHIVE_DESTINATION_ADMIN_KEY, [
        "export",
        "--include-file-storage",
        "--path",
        exported,
      ]);
      return exported;
    };
    const restore = () =>
      restoreIsolated({
        source,
        store,
        runId,
        directory: join(scratch, "restore"),
        decrypt,
        restoreAndExport,
        custody,
      });
    if (mode === "restore") {
      console.log(JSON.stringify(await restore()));
      return;
    }
    if (mode === "export") {
      // Owner and 30-day checks first, then the isolated restore, the generation there with the
      // normal generator and the publication in the origin. The destination is deleted after.
      console.log(
        JSON.stringify(
          await assistedExport({
            source,
            destination,
            runId,
            request,
            restore,
            download: (url) => downloadPart(config, url),
            upload: uploadPart,
          }),
        ),
      );
      return;
    }
    // The package is locked before it exists: no object of the run is ever unprotected in R2.
    await locks().ensure(lockRule(), run.retainUntil);
    let manifest;
    if (run.manifest) manifest = validateManifest(JSON.parse(run.manifest));
    else {
      // Recover a lost response after publishing the immutable manifest but before sealing it.
      const key = `${config.prefix}${runId}/manifest.json`;
      if (await store.head(key)) {
        manifest = validateManifest(JSON.parse((await store.get(key)).toString("utf8")));
        await source.mutation("coldArchive:seal", { ...fence, manifest: canonical(manifest) });
      } else {
        const archive = await createArchive({ source, runId, directory: join(scratch, "package") });
        manifest = await publishArchive({
          source,
          store,
          archive,
          directory: scratch,
          prefix: config.prefix,
          recipients: config.recipients,
          encrypt,
          // ADR 0010, phase C: the cold tier's bucket, read with its read-only token
          // (`R2_COLD_READ_*`, else the R2 credentials), for an organization with cold notes.
          // Configured in `coldBucket`.
          coldBucket: config.coldBucket,
          coldStore: config.coldBucket
            ? r2Client({
                accountId: config.accountId,
                bucket: config.coldBucket,
                credentials: coldReadCredentials(),
              })
            : undefined,
          coldLocks:
            config.coldBucket && process.env.CLOUDFLARE_API_TOKEN
              ? cloudflareLocks({
                  accountId: config.accountId,
                  bucket: config.coldBucket,
                  token: process.env.CLOUDFLARE_API_TOKEN,
                })
              : undefined,
        });
      }
    }
    custody(manifest);
    await verifyArchive({
      source,
      store,
      manifest,
      directory: join(scratch, "proof"),
      decrypt,
      restoreAndExport,
      verifierRunId: randomUUID(),
      recordProof: true,
    });
    // Every run that reaches `archived` compacts its catalogue; `compact` resumes an interruption.
    await removeHot(source, manifest);
    await compact(manifest);
    console.log(
      JSON.stringify({
        state: "archived",
        catalog: "compacted",
        rows: manifest.rows,
        files: manifest.files,
        manifestSha256: sha256(canonical(manifest)),
        sameOriginReactivationSupported: false,
      }),
    );
  } finally {
    // This directory was allocated above, outside the checkout; it contains plaintext fiscal data.
    assert.ok(
      resolve(scratch).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")),
    );
    await rm(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    // A refusal (not the owner, the 30-day limit, already hot) names its code; nothing else.
    const refusal = refusalOf(error);
    if (refusal) console.error(JSON.stringify(refusal));
    console.error(
      "Arquivo econômico interrompido. Nenhuma nova autorização de remoção ou reativação foi concedida.",
    );
    process.exitCode = 1;
  });
