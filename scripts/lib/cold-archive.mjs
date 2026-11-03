import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { byCodeUnit, sha256 } from "./offsite-backup.mjs";
import { extractZip, fileDigest, writeZip } from "./offsite-backup-zip.mjs";
import { packageRules } from "./cold-tier-locks.mjs";
import {
  coldDocumentList,
  coldDocumentListKey,
  coldReferenceOf,
  COLD_OBJECT_TABLES,
  validateMetadata,
  verifyColdDocuments,
} from "./incremental-backup.mjs";
import { getDocumentSize, jsonToConvex } from "convex/values";

export const DATABASE_LIMIT = 256 * 1024 ** 2;
export const FILE_LIMIT = 2 * 1024 ** 3;
export const PACKAGE_LIMIT = 3 * 1024 ** 3;
/**
 * Fiscal schema version of the packages made now (ADR 0009, §5, "Mudança de schema durante a
 * guarda"), the same number as `ARCHIVE_SCHEMA_VERSION` in `platform/convex/lib/coldArchiveCore.ts`,
 * where the bump rule is. A manifest sealed before the field existed is version 1.
 */
export const ARCHIVE_SCHEMA_VERSION = 1;
/** The fiscal schema version of a package: the recorded one, or 1 for older manifests. */
export function manifestSchemaVersion(manifest) {
  return manifest.schemaVersion ?? 1;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const parse = (value) => (typeof value === "string" ? JSON.parse(value) : value);
async function* pages(source, name, runId) {
  let cursor = null;
  do {
    const result = parse(await source.query(`coldArchive:${name}`, { runId, cursor }));
    assert.ok(Array.isArray(result.page), "Inventário frio incompleto");
    yield result.page;
    if (result.isDone) return;
    assert.ok(
      result.continueCursor && result.continueCursor !== cursor,
      "Inventário frio sem progresso",
    );
    cursor = result.continueCursor;
  } while (true);
}
export async function downloadOriginal(item, target, fetchImpl = fetch) {
  const metadata = JSON.parse(item.metadata),
    hash = validateMetadata(metadata);
  assert.ok(item.url, "Original sem URL");
  const response = await fetchImpl(item.url, {
    redirect: "error",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  assert.ok(response.ok && response.body, "Falha no download do original");
  let bytes = 0;
  await pipeline(
    response.body,
    new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(
          bytes > metadata.size ? new Error("Original acima do tamanho declarado") : null,
          chunk,
        );
      },
    }),
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
  );
  assert.deepEqual(
    await fileDigest(target),
    { bytes: metadata.size, sha256: hash },
    "Bytes do original divergentes",
  );
}

/** Bounded per organization; files never enter a Buffer containing the whole package. */
export async function createArchive({ source, runId, directory, download = downloadOriginal }) {
  let run = parse(await source.query("coldArchive:inspect", { runId }));
  // An open organization comes back by `rehydrate` (ADR 0009, §5); a closed one never does.
  assert.ok(run?.state === "frozen", "Organização precisa estar congelada");
  const fence = { runId, version: run.version };
  for (let calls = 0; calls < 1_000_000; calls++) {
    try {
      const step = parse(
        await source.mutation("coldArchive:scan", {
          ...fence,
          phase: run.phase,
          cursor: run.cursor,
        }),
      );
      run = { ...run, phase: step.phase, cursor: step.cursor };
      if (step.done) break;
    } catch (error) {
      // A lost mutation response is recoverable using the durable cursor, never by advancing it.
      const latest = parse(await source.query("coldArchive:inspect", { runId }));
      if (latest.phase === run.phase && latest.cursor === run.cursor) throw error;
      run = latest;
    }
  }
  run = parse(await source.query("coldArchive:inspect", { runId }));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = new Map(),
    tables = new Map(),
    metadata = [];
  let digest = "",
    databaseBytes = 0,
    fileBytes = 0,
    rows = 0;
  // ADR 0010, decision 6: a cold version's content stays in the cold tier's bucket; the package
  // carries the row and references the object by its hash, never copies it.
  const cold = [];
  for await (const page of pages(source, "materialize", runId)) {
    for (const entry of page) {
      assert.ok(/^[A-Za-z0-9_-]+$/.test(entry.originalId), "ID inválido");
      if (entry.kind === "file") {
        const meta = JSON.parse(entry.metadata);
        assert.equal(sha256(canonical(meta)), entry.sha256, "Metadados divergentes");
        validateMetadata(meta);
        fileBytes += meta.size;
        assert.ok(fileBytes <= FILE_LIMIT, "Arquivos acima de 2 GiB");
        const path = join(directory, `blob-${metadata.length}`);
        await download(entry, path);
        assert.deepEqual(await fileDigest(path), {
          sha256: validateMetadata(meta),
          bytes: meta.size,
        });
        entries.set(`_storage/${entry.originalId}`, path);
        metadata.push(meta);
      } else {
        assert.ok(/^[A-Za-z][A-Za-z0-9_]*$/.test(entry.table), "Tabela inválida");
        assert.equal(sha256(entry.json), entry.sha256, "Registro divergente");
        // Fiscal schema currently uses JSON values. Supporting new bytes/int64 needs exported
        // generated_schema.jsonl; refusing is safer than silently changing a stored type.
        assert.ok(
          !/"\$(?:integer|bytes|float)"\s*:/.test(entry.json),
          "Tipo Convex exige schema de exportação",
        );
        assert.equal(JSON.parse(entry.json)._id, entry.originalId, "ID divergente");
        if (Object.hasOwn(COLD_OBJECT_TABLES, entry.table)) {
          const reference = coldReferenceOf(JSON.parse(entry.json), entry.table);
          if (reference) cold.push(reference);
        }
        databaseBytes += Buffer.byteLength(entry.json);
        rows++;
        assert.ok(
          databaseBytes <= DATABASE_LIMIT && rows <= 100_000,
          "Banco acima do limite de arquivo",
        );
        const path = tables.get(entry.table) ?? join(directory, `table-${tables.size}`);
        tables.set(entry.table, path);
        await appendFile(path, entry.json + "\n", { mode: 0o600 });
        digest = sha256(`${digest}\n${entry.table}\n${entry.originalId}\n${entry.sha256}`);
      }
    }
  }
  assert.equal(digest, run.digest, "Snapshot não corresponde à varredura");
  assert.equal(rows, run.rows);
  assert.equal(metadata.length, run.files);
  assert.equal(databaseBytes, run.bytes);
  for (const [table, path] of tables) entries.set(`${table}/documents.jsonl`, path);
  const storage = join(directory, "storage-metadata");
  await writeFile(storage, metadata.map(canonical).join("\n") + (metadata.length ? "\n" : ""), {
    mode: 0o600,
  });
  entries.set("_storage/documents.jsonl", storage);
  // IDs encode table numbers. Absent commercial parents still need their original mapping.
  const mapping = parse(await source.query("_system/frontend/getTableMapping", {}));
  assert.ok(
    mapping && typeof mapping === "object" && !Array.isArray(mapping),
    "Mapa de tabelas ausente",
  );
  const tableMapping = Object.entries(mapping)
    .filter(([, name]) => typeof name === "string" && !name.startsWith("_"))
    .map(([id, name]) => {
      assert.ok(
        Number.isSafeInteger(Number(id)) && /^[A-Za-z][A-Za-z0-9_]*$/.test(name),
        "Mapa de tabelas inválido",
      );
      return { id: Number(id), name };
    });
  const mappingPath = join(directory, "table-mapping.jsonl");
  await writeFile(mappingPath, tableMapping.map(canonical).join("\n") + "\n", { mode: 0o600 });
  entries.set("_tables/documents.jsonl", mappingPath);
  const zip = join(directory, "archive.zip");
  await writeZip(entries, zip, PACKAGE_LIMIT);
  return {
    zip,
    run,
    rows,
    files: metadata.length,
    databaseBytes,
    fileBytes,
    digest,
    coldDocuments: coldDocumentList(cold),
  };
}

export function validateManifest(manifest) {
  assert.equal(manifest.format, "fnfe-cold-archive/1");
  assert.ok(
    /^[A-Za-z0-9_-]+$/.test(manifest.runId) && /^[A-Za-z0-9_-]+$/.test(manifest.organizationId),
  );
  for (const name of ["plaintextSha256", "ciphertextSha256", "recipientSetSha256", "digest"])
    assert.match(manifest[name], /^[a-f0-9]{64}$|^$/);
  for (const name of [
    "rows",
    "files",
    "databaseBytes",
    "fileBytes",
    "ciphertextBytes",
    "plaintextBytes",
    "version",
    "retainUntil",
  ])
    assert.ok(Number.isSafeInteger(manifest[name]) && manifest[name] >= 0);
  // Absent in packages sealed before the version was recorded; never newer than this executor.
  const schemaVersion = manifestSchemaVersion(manifest);
  assert.ok(
    Number.isSafeInteger(schemaVersion) &&
      schemaVersion >= 1 &&
      schemaVersion <= ARCHIVE_SCHEMA_VERSION,
    "Versão do schema fiscal do pacote desconhecida",
  );
  assert.ok(
    manifest.databaseBytes <= DATABASE_LIMIT &&
      manifest.fileBytes <= FILE_LIMIT &&
      manifest.plaintextBytes <= PACKAGE_LIMIT &&
      manifest.ciphertextBytes <= PACKAGE_LIMIT,
  );
  assert.equal(manifest.objectKey, `${manifest.prefix}${manifest.runId}/archive.zip.age`);
  // Absent when the organization has no cold note (and in every package before phase C).
  if (manifest.coldDocuments !== undefined)
    assert.ok(
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(manifest.coldDocuments.bucket) &&
        Number.isSafeInteger(manifest.coldDocuments.count) &&
        manifest.coldDocuments.count > 0 &&
        /^[a-f0-9]{64}$/.test(manifest.coldDocuments.digest),
      "Documentos frios do pacote inválidos",
    );
  assert.ok(
    typeof manifest.prefix === "string" &&
      /^[A-Za-z0-9/_-]+\/$/.test(manifest.prefix) &&
      !manifest.prefix.includes(".."),
  );
  return manifest;
}
/** Immutable object and manifest. A retry can reuse a sealed manifest, never overwrite it. */
export async function publishArchive({
  source,
  store,
  archive,
  directory,
  prefix,
  recipients,
  encrypt,
  coldBucket = /** @type {string | undefined} */ (undefined),
  coldStore = /** @type {any} */ (undefined),
  coldLocks = /** @type {any} */ (undefined),
}) {
  assert.ok(recipients.length >= 2, "Dois custodiantes independentes são obrigatórios");
  // Every cold object the package references is read back and checked before it is sealed.
  const cold = archive.coldDocuments ?? coldDocumentList([]);
  if (cold.count) {
    assert.ok(coldBucket && coldStore, "Pacote com documentos frios exige o bucket frio");
    await verifyColdDocuments(coldStore, cold.references, { full: true });
    // The lock of a cold note follows the longer of its own guard and the package's (ADR 0010,
    // decision 6): a rule per organization and guard year, read back before the seal.
    const rules = packageRules({
      runId: archive.run._id,
      retainUntil: archive.run.retainUntil,
      references: cold.references,
    });
    if (rules.length) {
      assert.ok(coldLocks, "Pacote com documentos frios exige acesso às regras de lock");
      await coldLocks.ensure(rules);
    }
  }
  const cipher = join(directory, "archive.zip.age");
  await encrypt(archive.zip, cipher);
  const plaintext = await fileDigest(archive.zip),
    ciphertext = await fileDigest(cipher);
  const manifest = validateManifest({
    format: "fnfe-cold-archive/1",
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    runId: archive.run._id,
    organizationId: archive.run.organizationId,
    version: archive.run.version,
    rows: archive.rows,
    files: archive.files,
    databaseBytes: archive.databaseBytes,
    fileBytes: archive.fileBytes,
    digest: archive.digest,
    retainUntil: archive.run.retainUntil,
    prefix,
    objectKey: `${prefix}${archive.run._id}/archive.zip.age`,
    plaintextSha256: plaintext.sha256,
    plaintextBytes: plaintext.bytes,
    ciphertextSha256: ciphertext.sha256,
    ciphertextBytes: ciphertext.bytes,
    recipientSetSha256: sha256([...recipients].sort(byCodeUnit).join("\n")),
    ...(cold.count
      ? { coldDocuments: { bucket: coldBucket, count: cold.count, digest: cold.digest } }
      : {}),
  });
  const body = canonical(manifest),
    key = `${prefix}${manifest.runId}/manifest.json`;
  assert.ok(
    await store.putFile(manifest.objectKey, cipher, { immutable: true }),
    "Pacote já existe; retome pela cópia imutável",
  );
  await store.verifyFile(manifest.objectKey, ciphertext);
  // The list goes before the manifest: a published manifest always finds its list.
  if (cold.count) {
    const listKey = coldDocumentListKey(manifest);
    if (!(await store.putImmutable(listKey, Buffer.from(cold.body), "text/plain")))
      assert.equal(
        (await store.get(listKey)).toString("utf8"),
        cold.body,
        "Lista de documentos frios divergente",
      );
  }
  assert.ok(
    await store.putImmutable(key, Buffer.from(body), "application/json"),
    "Manifesto já existe",
  );
  assert.equal((await store.get(key)).toString("utf8"), body, "Manifesto externo divergente");
  await source.mutation("coldArchive:seal", {
    runId: manifest.runId,
    version: manifest.version,
    manifest: body,
  });
  return manifest;
}
async function compareRestore(original, restored) {
  for (const [name, path] of original) {
    const target =
      restored.get(name) ??
      (name.startsWith("_storage/") && !name.endsWith(".jsonl")
        ? [...restored].find(([n]) => n.startsWith(`${name}.`))?.[1]
        : undefined);
    assert.ok(target, `Restauração incompleta: ${name.split("/")[0]}`);
    if (name.endsWith("/documents.jsonl")) {
      const expected = new Map();
      for await (const line of createInterface({
        input: createReadStream(path),
        crlfDelay: Infinity,
      })) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (name === "_storage/documents.jsonl") delete row.internalId;
        const id = row._id ?? `${row.id}:${row.name}`;
        assert.ok(
          !expected.has(id) && expected.size < 100_000,
          "ID repetido ou limite de registros",
        );
        expected.set(id, sha256(canonical(row)));
      }
      for await (const line of createInterface({
        input: createReadStream(target),
        crlfDelay: Infinity,
      })) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (name === "_storage/documents.jsonl") delete row.internalId;
        const id = row._id ?? `${row.id}:${row.name}`;
        assert.equal(
          expected.get(id),
          sha256(canonical(row)),
          "IDs, metadados ou banco divergentes após importação",
        );
        expected.delete(id);
      }
      assert.equal(expected.size, 0, "Registros ausentes após importação");
    } else
      assert.deepEqual(
        await fileDigest(target),
        await fileDigest(path),
        "Bytes divergentes após importação",
      );
  }
}
/**
 * Downloads the sealed package, checks the cipher and the plaintext against the manifest the
 * server sealed and the copy in R2, decrypts and extracts it.
 */
export async function openPackage({ source, store, manifest: raw, directory, decrypt }) {
  const manifest = validateManifest(raw),
    body = canonical(manifest);
  const run = parse(await source.query("coldArchive:inspect", { runId: manifest.runId }));
  assert.equal(run.manifestSha256, sha256(body), "Manifesto não é o selado no servidor");
  assert.equal(
    (await store.get(`${manifest.prefix}${manifest.runId}/manifest.json`)).toString("utf8"),
    body,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cipher = join(directory, "download.age"),
    zip = join(directory, "recovered.zip");
  assert.deepEqual(
    await store.getFile(manifest.objectKey, cipher, PACKAGE_LIMIT),
    { sha256: manifest.ciphertextSha256, bytes: manifest.ciphertextBytes },
    "Cifra corrompida",
  );
  await decrypt(cipher, zip);
  assert.deepEqual(
    await fileDigest(zip),
    { sha256: manifest.plaintextSha256, bytes: manifest.plaintextBytes },
    "Pacote decifrado divergente",
  );
  return { zip, entries: await extractZip(zip, join(directory, "expected"), PACKAGE_LIMIT) };
}
/** Real adapter imports the ZIP into an isolated Convex and reexports it. A local unzip alone
 * never produces an administrative proof. Only after both comparisons may hot deletion start.
 * `catalog`, from `loadCatalog`, is the compacted catalogue the package must match first. */
export async function verifyArchive({
  source,
  store,
  manifest: raw,
  directory,
  decrypt,
  restoreAndExport,
  verifierRunId,
  recordProof = true,
  catalog = /** @type {Map<string, any> | null} */ (null),
}) {
  const manifest = validateManifest(raw),
    body = canonical(manifest);
  const { zip, entries: expected } = await openPackage({
    source,
    store,
    manifest,
    directory,
    decrypt,
  });
  // A compacted run has no hot catalogue: its decrypted object vouches for the package instead.
  if (catalog) await compareCatalogWithPackage(expected, catalog);
  const reexport = await restoreAndExport(zip);
  const restored = await extractZip(reexport, join(directory, "restored"), PACKAGE_LIMIT);
  await compareRestore(expected, restored);
  if (recordProof)
    await source.mutation("coldArchive:verified", {
      runId: manifest.runId,
      version: manifest.version,
      manifestSha256: sha256(body),
      verifierRunId,
    });
  return {
    zip,
    manifest,
    entries: expected,
    verifiedRows: manifest.rows,
    verifiedFiles: manifest.files,
  };
}
/**
 * Run states whose sealed package the isolated restore (ADR 0009, §7) reads: from the seal to the
 * end of the custody, including `restoring`, while an open organization is being rehydrated. In
 * `notice` and `frozen` there is no sealed package yet, and the data is still hot; in `hot` an
 * open organization was rehydrated and its data is in the origin again, with the normal export.
 */
export const ISOLATED_RESTORE_STATES = ["sealed", "verified", "deleting", "archived", "restoring"];
/**
 * Refuses, before reading R2, a run the isolated restore must not touch. Closed and open
 * organizations alike: the restore never writes to the origin, so it neither reopens a closed one
 * nor interferes with the rehydration of an open one.
 */
export function assertIsolatedRestore(run) {
  assert.ok(run, "Run inexistente");
  assert.notEqual(run.state, "hot", "ARCHIVE_ORGANIZATION_HOT");
  assert.ok(
    ISOLATED_RESTORE_STATES.includes(run.state) && run.manifest && run.manifestSha256,
    "ARCHIVE_NOT_SEALED",
  );
  return run;
}
/**
 * Rows of the package that came back by a rehydration in an earlier cycle: they carry the origin
 * pair (ADR 0009, §5, item 6), and their `_id` is no longer the first one.
 */
async function rehydratedRows(entries) {
  let count = 0;
  for (const [name, path] of entries) {
    if (!name.endsWith("/documents.jsonl") || name.startsWith("_")) continue;
    for await (const line of lines(path)) if (JSON.parse(line).originId !== undefined) count++;
  }
  return count;
}
/**
 * The isolated restore of ADR 0009, §7, for closed and open organizations: the base of the
 * assisted export. Reads the run, downloads and decrypts the sealed package and, when the run has
 * one, the compacted catalogue, checks them against their manifests and each other, imports into
 * the disposable destination (`restoreAndExport`) and compares the re-export with the package.
 * Never writes to the origin nor to R2: it records no proof, takes no fence and can run any number
 * of times, in parallel with the archiving or the rehydration of the same run.
 *
 * The destination receives the package as it was sealed: original IDs on a first cycle; on a later
 * one, the IDs of the previous cycle, with the first ID in `originId`. The ID map stays hot in the
 * origin (`coldArchiveIdMap`); the fence rows are the scan's snapshot.
 */
export async function restoreIsolated({
  source,
  store,
  runId,
  directory,
  decrypt,
  restoreAndExport,
  custody = (/** @type {any} */ _manifest) => {},
}) {
  const run = assertIsolatedRestore(parse(await source.query("coldArchive:inspect", { runId })));
  const manifest = validateManifest(JSON.parse(run.manifest));
  assert.ok(
    manifest.runId === run._id && manifest.organizationId === run.organizationId,
    "Pacote não pertence ao run",
  );
  // Packages are imported under the current fiscal schema; no package migration exists yet.
  assert.equal(
    manifestSchemaVersion(manifest),
    ARCHIVE_SCHEMA_VERSION,
    "ARCHIVE_SCHEMA_MIGRATION_REQUIRED",
  );
  custody(manifest);
  // A compacted run left its catalogue in R2 only: the package must match it before any import.
  const catalog = run.catalog
    ? await loadCatalog({
        store,
        run,
        packageManifest: manifest,
        directory: join(directory, "catalog"),
        decrypt,
      })
    : undefined;
  const proof = await verifyArchive({
    source,
    store,
    manifest,
    directory: join(directory, "proof"),
    decrypt,
    restoreAndExport,
    verifierRunId: "isolated-restore",
    recordProof: false,
    catalog,
  });
  return {
    state: "restored_isolated",
    runId: run._id,
    reason: run.reason,
    runState: run.state,
    ...(catalog ? { catalog: "compacted" } : {}),
    rows: manifest.rows,
    files: manifest.files,
    rehydratedRows: await rehydratedRows(proof.entries),
    manifestSha256: sha256(canonical(manifest)),
    sameOriginReactivationSupported: false,
  };
}
/** Parts read per call of `assistedExport:parts`, and worker steps before giving up. */
const ASSISTED_PARTS_PAGE = 100;
const ASSISTED_MAX_STEPS = 10_001;
/**
 * Validates the support request of an assisted export (ADR 0009, §7): the ticket (`key`), the
 * account e-mail it came from, its basis (`owner`, or `rights` with the RIGHTS.md reference) and
 * the environments. The server checks the owner and the 30-day limit.
 */
export function validateAssistedRequest(request) {
  assert.ok(request && typeof request === "object" && !Array.isArray(request), "Pedido inválido");
  const { key, email, basis, rightsReference, environments } = request;
  assert.ok(
    typeof key === "string" && /^[\x21-\x7e]{1,128}$/.test(key),
    "Chave do pedido inválida",
  );
  assert.ok(typeof email === "string" && email.includes("@"), "E-mail da conta ausente");
  assert.ok(basis === "owner" || basis === "rights", "Base do pedido: owner ou rights");
  assert.equal(
    basis === "rights",
    typeof rightsReference === "string",
    "Pedido de titular exige rightsReference, e só ele",
  );
  assert.ok(
    Array.isArray(environments) &&
      environments.length > 0 &&
      environments.every((e) => e === "sandbox" || e === "production"),
    "Ambientes: sandbox e/ou production",
  );
  return {
    key,
    email,
    basis,
    ...(basis === "rights" ? { rightsReference } : {}),
    environments: [...new Set(environments)],
  };
}
/**
 * Drives the worker of one destination job, step by step, until it ends. Each step is fenced by
 * its sequence in the server, so a lost response repeats it without a second part.
 */
async function generateInDestination(destination, jobId) {
  for (let steps = 0; steps < ASSISTED_MAX_STEPS; steps++) {
    const progress = parse(await destination.query("assistedExport:progress", { jobId }));
    if (progress.state === "succeeded") return;
    assert.equal(progress.state, "running", `Geração falhou: ${progress.code ?? progress.state}`);
    await destination.action("exportWorker:run", { exportId: jobId, sequence: progress.sequence });
  }
  throw new Error("Geração sem fim");
}
/**
 * The assisted export of ADR 0009, §7: the same file as EXPORTS.md, only with the organization's
 * fiscal documents, delivered by the normal signed download. In order:
 *
 * 1. records the request in the origin, which refuses anyone but the owner (by the account) and a
 *    second owner's request within 30 days, before any download from R2;
 * 2. `restore()`: the isolated restore of the package into the disposable destination;
 * 3. per environment, prepares the origin's export (owned by the owner, with the 24 hours of
 *    EXPORTS.md), generates its parts in the destination with the normal generator, downloads
 *    each one from the loopback destination checking its SHA-256 and size, uploads it to the
 *    origin and attaches it there, which checks the stored bytes again.
 *
 * Idempotent: the same ticket returns the same request; an export already published is not
 * generated again; a destination job and the parts already attached are reused. A destination
 * lost after some parts were attached restarts the origin's export from the first part.
 */
export async function assistedExport({
  source,
  destination,
  runId,
  request,
  restore,
  download,
  upload,
}) {
  const pedido = validateAssistedRequest(request);
  const requested = parse(await source.mutation("assistedExport:request", { runId, ...pedido }));
  const restored = await restore();
  const exports = [];
  for (const environment of requested.environments) {
    const prepareArgs = { requestId: requested.requestId, environment };
    let prepared = parse(await source.mutation("assistedExport:prepare", prepareArgs));
    if (prepared.state !== "succeeded") {
      const generateArgs = (p) => ({
        exportId: p.exportId,
        organizationId: p.organizationId,
        environment: p.environment,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        companies: p.companies,
      });
      let job = parse(
        await destination.mutation("assistedExport:generate", generateArgs(prepared)),
      );
      if (job.created && prepared.sequence > 0) {
        // The parts already attached came from a destination that no longer exists.
        prepared = parse(
          await source.mutation("assistedExport:prepare", { ...prepareArgs, restart: true }),
        );
        job = parse(await destination.mutation("assistedExport:generate", generateArgs(prepared)));
      }
      await generateInDestination(destination, job.jobId);
      const parts = [];
      for (let after = -1; ;) {
        const page = parse(
          await destination.query("assistedExport:parts", { jobId: job.jobId, after }),
        );
        parts.push(...page);
        if (page.length < ASSISTED_PARTS_PAGE) break;
        after = page.at(-1).sequence;
      }
      assert.ok(parts.length > 0, "Exportação sem partes");
      parts.forEach((part, index) => assert.equal(part.sequence, index, "Partes fora de ordem"));
      for (const part of parts.slice(prepared.sequence)) {
        const bytes = await download(part.url);
        assert.ok(
          bytes.length === part.size && sha256(bytes) === part.sha256,
          "Parte divergente no destino",
        );
        // The upload URL is a plain string, never JSON.
        const url = await source.mutation("assistedExport:uploadUrl", {
          exportId: prepared.exportId,
        });
        const storageId = await upload(url, bytes);
        const attached = parse(
          await source.mutation("assistedExport:attachPart", {
            exportId: prepared.exportId,
            sequence: part.sequence,
            storageId,
            sha256: part.sha256,
            size: part.size,
            done: part.sequence === parts.length - 1,
          }),
        );
        assert.ok(attached.ok, attached.code ?? "Parte recusada na origem");
      }
      prepared = parse(await source.mutation("assistedExport:prepare", prepareArgs));
      assert.equal(prepared.state, "succeeded", "Exportação não publicada");
    }
    exports.push({
      environment,
      exportId: prepared.exportId,
      parts: prepared.sequence,
      expiresAt: prepared.expiresAt,
    });
  }
  return {
    state: "published",
    requestId: requested.requestId,
    repeated: requested.repeated,
    rows: restored?.rows,
    files: restored?.files,
    exports,
  };
}
export async function removeHot(source, manifest) {
  const fence = { runId: manifest.runId, version: manifest.version };
  for (const kind of ["file", "row"]) {
    for (let batch = 0; batch < 100_000; batch++) {
      if (await source.mutation("coldArchive:removeHotBatch", { ...fence, kind })) return;
      let remains = false;
      for await (const entries of pages(source, "entries", manifest.runId))
        if (entries.some((e) => !e.removed && e.kind === kind)) {
          remains = true;
          break;
        }
      if (!remains) break;
    }
  }
  assert.equal(
    parse(await source.query("coldArchive:inspect", { runId: manifest.runId })).state,
    "archived",
    "Remoção não concluída",
  );
}

/** Diagnostic delta for an isolated destination only, never same-origin resurrection.
 * The server compares every already
 * restored row/metadata hash; a conflicting ID stops, it is never overwritten. */
export async function buildRestoreDelta({ source, manifest, zip, directory }) {
  const missing = new Set();
  let cursor = null;
  do {
    const page = parse(
      await source.query("coldArchive:restoreRemaining", {
        runId: manifest.runId,
        version: manifest.version,
        cursor,
      }),
    );
    for (const id of page.missing) {
      assert.ok(!missing.has(id));
      missing.add(id);
    }
    if (page.isDone) break;
    assert.ok(page.continueCursor && page.continueCursor !== cursor);
    cursor = page.continueCursor;
  } while (cursor !== null);
  if (!missing.size) return null;
  const entries = await extractZip(zip, join(directory, "input"), PACKAGE_LIMIT),
    delta = new Map();
  const found = new Set();
  for (const [name, path] of entries) {
    if (!name.endsWith("/documents.jsonl")) {
      const id = name.startsWith("_storage/") ? name.slice("_storage/".length).split(".")[0] : null;
      if (id && missing.has(id)) delta.set(name, path);
      continue;
    }
    const output = join(directory, `delta-${delta.size}`);
    await writeFile(output, "", { mode: 0o600 });
    for await (const line of createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    })) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (!missing.has(row._id)) continue;
      found.add(row._id);
      await appendFile(output, line + "\n");
    }
    delta.set(name, output);
  }
  assert.deepEqual(
    [...found].sort(byCodeUnit),
    [...missing].sort(byCodeUnit),
    "Pacote não cobre todos os IDs ausentes",
  );
  const result = join(directory, "append.zip");
  await writeZip(delta, result, PACKAGE_LIMIT);
  return result;
}

/**
 * Compacted catalogue (ADR 0009, §4). After `archived`, the run's `coldArchiveEntries` become one
 * JSONL object encrypted with age to the package's custodians, next to the package in R2, with
 * its own immutable manifest. The package manifest, already sealed, does not change.
 */
export const CATALOG_FORMAT = "fnfe-cold-archive-catalog/1";
/** Entries of 100 thousand rows and their files, with fence snapshots, fit with a wide margin. */
export const CATALOG_LIMIT = 512 * 1024 ** 2;
export const catalogKeys = (prefix, runId) => ({
  object: `${prefix}${runId}/catalog.jsonl.age`,
  manifest: `${prefix}${runId}/catalog-manifest.json`,
});
/**
 * One canonical line per entry, in the order of the run's index: kind, table, original ID, hash,
 * bytes and, when present, storage metadata and the fence snapshot. DB locators (`_id`,
 * `_creationTime`, `runId`, `organizationId`) and the removal flag stay out: the manifest names
 * the run, and every entry of an archived run was handled.
 */
export function catalogLine(entry) {
  const line = { ...entry };
  for (const name of ["_id", "_creationTime", "runId", "organizationId", "removed"])
    delete line[name];
  return canonical(line);
}
function catalogEntry(run, entry) {
  assert.ok(
    entry.runId === run._id && entry.organizationId === run.organizationId,
    "Entrada do catálogo fora do run",
  );
  assert.equal(entry.removed, true, "Catálogo só compacta entradas já tratadas");
  assert.ok(/^[A-Za-z0-9_-]+$/.test(entry.originalId), "ID inválido");
  assert.ok(entry.kind === "row" || entry.kind === "file", "Entrada de tipo desconhecido");
  return catalogLine(entry);
}
export function validateCatalogManifest(manifest) {
  assert.equal(manifest.format, CATALOG_FORMAT, "Manifesto do catálogo desconhecido");
  assert.ok(
    /^[A-Za-z0-9_-]+$/.test(manifest.runId) && /^[A-Za-z0-9_-]+$/.test(manifest.organizationId),
  );
  for (const name of [
    "plaintextSha256",
    "ciphertextSha256",
    "recipientSetSha256",
    "packageManifestSha256",
  ])
    assert.match(manifest[name], /^[a-f0-9]{64}$/);
  for (const name of [
    "version",
    "entries",
    "rows",
    "files",
    "plaintextBytes",
    "ciphertextBytes",
    "retainUntil",
  ])
    assert.ok(Number.isSafeInteger(manifest[name]) && manifest[name] >= 0);
  assert.equal(manifest.entries, manifest.rows + manifest.files, "Contagem do catálogo divergente");
  assert.ok(
    manifest.plaintextBytes <= CATALOG_LIMIT && manifest.ciphertextBytes <= CATALOG_LIMIT,
    "Catálogo acima do limite",
  );
  assert.ok(
    typeof manifest.prefix === "string" &&
      /^[A-Za-z0-9/_-]+\/$/.test(manifest.prefix) &&
      !manifest.prefix.includes(".."),
  );
  assert.equal(manifest.objectKey, catalogKeys(manifest.prefix, manifest.runId).object);
  return manifest;
}
/** Writes the hot entries of an archived run as the canonical catalogue, page by page. */
export async function writeCatalog({ source, run, path }) {
  await writeFile(path, "", { mode: 0o600, flag: "wx" });
  const seen = new Set();
  let rows = 0,
    files = 0,
    bytes = 0;
  for await (const page of pages(source, "entries", run._id)) {
    let chunk = "";
    for (const entry of page) {
      const line = catalogEntry(run, entry);
      assert.ok(!seen.has(entry.originalId), "ID repetido no catálogo");
      seen.add(entry.originalId);
      if (entry.kind === "row") rows++;
      else files++;
      chunk += line + "\n";
    }
    bytes += Buffer.byteLength(chunk);
    assert.ok(bytes <= CATALOG_LIMIT, "Catálogo acima do limite");
    await appendFile(path, chunk);
  }
  assert.ok(rows === run.rows && files === run.files, "Catálogo não cobre a varredura do run");
  return { entries: rows + files, rows, files };
}
/**
 * Compares the decrypted catalogue with the hot entries, line by line in the index order: count,
 * original IDs, hashes, sizes, storage metadata and fence snapshots.
 */
export async function compareCatalog({ source, run, path }) {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  let count = 0;
  try {
    for await (const page of pages(source, "entries", run._id))
      for (const entry of page) {
        const next = await lines.next();
        assert.ok(!next.done, "Catálogo decifrado incompleto");
        assert.equal(next.value, catalogEntry(run, entry), "Catálogo decifrado diverge do banco");
        count++;
      }
    assert.ok((await lines.next()).done, "Catálogo decifrado com entradas além do banco");
  } finally {
    reader.close();
  }
  assert.equal(count, run.rows + run.files, "Catálogo não cobre a varredura do run");
  return count;
}
const recipientSet = (recipients) => sha256([...recipients].sort(byCodeUnit).join("\n"));
/**
 * Publishes the catalogue object and its manifest by conditional writes; neither is ever
 * overwritten. A retry reuses a published manifest when it describes this same catalogue, and a
 * cipher left without manifest only when it decrypts to this same catalogue.
 */
export async function publishCatalog({
  source,
  store,
  run,
  packageManifest,
  directory,
  recipients,
  encrypt,
  decrypt,
}) {
  assert.ok(recipients.length >= 2, "Dois custodiantes independentes são obrigatórios");
  assert.equal(
    recipientSet(recipients),
    packageManifest.recipientSetSha256,
    "Catálogo exige os custodiantes do pacote",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const plain = join(directory, "catalog.jsonl"),
    cipher = join(directory, "catalog.jsonl.age"),
    keys = catalogKeys(packageManifest.prefix, run._id);
  const counts = await writeCatalog({ source, run, path: plain });
  const plaintext = await fileDigest(plain);
  if (await store.head(keys.manifest)) {
    const manifest = validateCatalogManifest(
      JSON.parse((await store.get(keys.manifest)).toString("utf8")),
    );
    assert.ok(
      manifest.runId === run._id &&
        manifest.plaintextSha256 === plaintext.sha256 &&
        manifest.plaintextBytes === plaintext.bytes,
      "Catálogo publicado diverge do banco",
    );
    return manifest;
  }
  let ciphertext;
  if (await store.head(keys.object)) {
    // The cipher went up but its manifest did not. Reuse it only if it is this same catalogue.
    ciphertext = await store.getFile(keys.object, cipher, CATALOG_LIMIT);
    const check = join(directory, "catalog-orphan.jsonl");
    await decrypt(cipher, check);
    assert.deepEqual(
      await fileDigest(check),
      plaintext,
      "Catálogo órfão no R2 diverge do banco; exige revisão administrativa",
    );
  } else {
    await encrypt(plain, cipher);
    ciphertext = await fileDigest(cipher);
    assert.ok(
      await store.putFile(keys.object, cipher, { immutable: true }),
      "Catálogo já existe; retome pela cópia imutável",
    );
  }
  await store.verifyFile(keys.object, ciphertext);
  const manifest = validateCatalogManifest({
    format: CATALOG_FORMAT,
    runId: run._id,
    organizationId: run.organizationId,
    version: run.version,
    packageManifestSha256: sha256(canonical(packageManifest)),
    ...counts,
    retainUntil: packageManifest.retainUntil,
    prefix: packageManifest.prefix,
    objectKey: keys.object,
    plaintextSha256: plaintext.sha256,
    plaintextBytes: plaintext.bytes,
    ciphertextSha256: ciphertext.sha256,
    ciphertextBytes: ciphertext.bytes,
    recipientSetSha256: packageManifest.recipientSetSha256,
  });
  const body = canonical(manifest);
  assert.ok(
    await store.putImmutable(keys.manifest, Buffer.from(body), "application/json"),
    "Manifesto do catálogo já existe",
  );
  assert.equal(
    (await store.get(keys.manifest)).toString("utf8"),
    body,
    "Manifesto externo divergente",
  );
  return manifest;
}
/** Downloads and decrypts the catalogue object, checking manifest, cipher and plaintext. */
async function fetchCatalog({ store, manifest, directory, decrypt }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cipher = join(directory, "catalog-download.age"),
    plain = join(directory, "catalog-recovered.jsonl");
  assert.equal(
    (await store.get(catalogKeys(manifest.prefix, manifest.runId).manifest)).toString("utf8"),
    canonical(manifest),
    "Manifesto do catálogo ausente ou alterado",
  );
  assert.deepEqual(
    await store.getFile(manifest.objectKey, cipher, CATALOG_LIMIT),
    { sha256: manifest.ciphertextSha256, bytes: manifest.ciphertextBytes },
    "Cifra do catálogo corrompida",
  );
  await decrypt(cipher, plain);
  assert.deepEqual(
    await fileDigest(plain),
    { sha256: manifest.plaintextSha256, bytes: manifest.plaintextBytes },
    "Catálogo decifrado divergente",
  );
  return plain;
}
/** The catalogue manifest recorded on the run, read back from R2 and checked by its hash. */
async function recordedCatalog({ store, run, packageManifest }) {
  assert.ok(run.catalog?.manifestSha256, "Run sem catálogo compactado");
  const body = (await store.get(catalogKeys(packageManifest.prefix, run._id).manifest)).toString(
    "utf8",
  );
  assert.equal(
    sha256(body),
    run.catalog.manifestSha256,
    "Manifesto do catálogo não é o registrado no servidor",
  );
  const manifest = validateCatalogManifest(JSON.parse(body));
  assert.ok(
    manifest.runId === run._id &&
      manifest.packageManifestSha256 === sha256(canonical(packageManifest)),
    "Catálogo não pertence ao pacote",
  );
  return manifest;
}
/**
 * The compaction step of an archived run: publish, download, decrypt and compare with the hot
 * entries, record the verified manifest on the run and only then delete the entries in batches.
 * Resumes from the recorded catalogue: the object must still match its manifest before more
 * entries go.
 */
export async function compactCatalog({
  source,
  store,
  runId,
  packageManifest,
  directory,
  recipients,
  encrypt,
  decrypt,
}) {
  let run = parse(await source.query("coldArchive:inspect", { runId }));
  assert.equal(run?.state, "archived", "Catálogo só compacta depois de archived");
  assert.equal(
    run.manifestSha256,
    sha256(canonical(packageManifest)),
    "Pacote não é o selado no servidor",
  );
  const fence = { runId, version: run.version };
  let manifest;
  if (!run.catalog) {
    manifest = await publishCatalog({
      source,
      store,
      run,
      packageManifest,
      directory: join(directory, "publish"),
      recipients,
      encrypt,
      decrypt,
    });
    const plain = await fetchCatalog({
      store,
      manifest,
      directory: join(directory, "proof"),
      decrypt,
    });
    await compareCatalog({ source, run, path: plain });
    await source.mutation("coldArchive:catalogVerified", {
      ...fence,
      manifest: canonical(manifest),
    });
  } else {
    manifest = await recordedCatalog({ store, run, packageManifest });
    await store.verifyFile(manifest.objectKey, {
      sha256: manifest.ciphertextSha256,
      bytes: manifest.ciphertextBytes,
    });
  }
  for (let batch = 0; batch < 100_000; batch++)
    if (await source.mutation("coldArchive:compactCatalogBatch", fence)) break;
  run = parse(await source.query("coldArchive:inspect", { runId }));
  assert.equal(run.catalog?.state, "compacted", "Compactação do catálogo não concluída");
  return manifest;
}
/**
 * The catalogue of a compacted run for the isolated restore (ADR 0009, §7): the recorded manifest,
 * the object downloaded and decrypted, one entry per original ID.
 */
export async function loadCatalog({ store, run, packageManifest, directory, decrypt }) {
  const manifest = await recordedCatalog({ store, run, packageManifest });
  const plain = await fetchCatalog({ store, manifest, directory, decrypt });
  const catalog = new Map();
  for await (const line of createInterface({
    input: createReadStream(plain),
    crlfDelay: Infinity,
  })) {
    if (!line) continue;
    const entry = JSON.parse(line);
    assert.equal(canonical(entry), line, "Catálogo fora da forma canônica");
    assert.ok(!catalog.has(entry.originalId), "ID repetido no catálogo");
    catalog.set(entry.originalId, entry);
  }
  assert.equal(catalog.size, manifest.entries, "Catálogo incompleto");
  return catalog;
}
/**
 * The package against its catalogue: every row and every storage metadata line has its entry,
 * with the same table and hash, and no entry is left without its line.
 */
export async function compareCatalogWithPackage(entries, catalog) {
  const seen = new Set();
  for (const [name, path] of entries) {
    if (!name.endsWith("/documents.jsonl") || name === "_tables/documents.jsonl") continue;
    const table = name.slice(0, -"/documents.jsonl".length);
    for await (const line of createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    })) {
      if (!line) continue;
      const id = JSON.parse(line)._id,
        entry = catalog.get(id);
      assert.ok(entry && !seen.has(id), "Pacote tem registro fora do catálogo");
      assert.ok(
        table === "_storage"
          ? entry.kind === "file" && entry.metadata === line
          : entry.kind === "row" && entry.table === table,
        "Pacote diverge do catálogo",
      );
      assert.equal(sha256(line), entry.sha256, "Pacote diverge do catálogo");
      seen.add(id);
    }
  }
  assert.equal(seen.size, catalog.size, "Catálogo tem entradas fora do pacote");
}

/**
 * Rehydration under new IDs (ADR 0009, §5 and §6). Only open organizations: a closed one is
 * recovered in isolation and never reopens. The fence tables keep their IDs; the six document
 * tables count as database stock (`capacityCore`).
 */
const FENCE_TABLES = new Set(["captureStreams", "dpsSequences"]);
const TRACKED_TABLES = new Set([
  "fiscalDocuments",
  "documentArtifacts",
  "documentVersions",
  "documentItems",
  "documentListings",
  "documentFiscalEvidence",
]);
export const REHYDRATE_ROWS = 32;
export const REHYDRATE_BYTES = 4 * 1024 ** 2;
export const CHECK_ENTRIES = 64;
async function* lines(path) {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of reader) if (line) yield line;
  } finally {
    reader.close();
  }
}
const originPair = (row) => ({
  originId: row.originId ?? row._id,
  originCreationTime: row.originCreationTime ?? row._creationTime,
});
/**
 * The cold stage of the rehydration (ADR 0010, decision 5, phase C2). Only the plan's hot window
 * comes back to Convex file storage; the notes outside it come back as their residue (every row
 * of the six document tables) with their content and original in the cold tier's bucket. The
 * executor never writes to that bucket: it leaves those notes' files out of the files stage and,
 * after the rows and references, uploads them to Convex a batch at a time; Convex moves each batch
 * to the bucket with the cold tier's own passage and deletes the hot files before the next one.
 *
 * `REHYDRATE_COLD_BATCH_BYTES` is the default budget of one batch (`coldBatchMiB` in the plan's
 * configuration), raised to the largest note when one note alone is bigger; the admission counts
 * the largest batch on top of the hot files. `COLD_BATCH_NOTES` is the server's own bound per
 * batch (`lib/coldArchiveRehydration.ts`). A batch claimed `COLD_ATTEMPTS` times without moving
 * stops the run (`ARCHIVE_REHYDRATE_COLD_STALLED`), and so does one whose passage does not end
 * within `COLD_POLLS` waits of `COLD_POLL_MS` (`ARCHIVE_REHYDRATE_COLD_TIMEOUT`); running again
 * resumes the same batch.
 */
export const REHYDRATE_COLD_BATCH_BYTES = 64 * 1024 ** 2;
export const COLD_BATCH_NOTES = 16;
export const COLD_ATTEMPTS = 3;
export const COLD_POLL_MS = 2_000;
export const COLD_POLLS = 900;
/**
 * Database bytes a note gains by going cold, over the package's rows: each moved version or
 * original swaps its storage ID for the object's key, SHA-256 and size (about 250 bytes), and the
 * note gains `coldState` and `coldAt`. Counted per deferred file and per cold note, on top of the
 * rows, before the server's margin.
 */
const COLD_FILE_GROWTH = 320;
const COLD_NOTE_GROWTH = 64;
const MAX_VERSIONS = 64;
const BRASILIA = 3 * 3_600_000;
/**
 * The guard year of a Production version, as `coldTier.guardYearOf` computes it: 31/12 of the fifth
 * year after the issue date of its card, or after the note's entry without one, in Brasília.
 */
export function coldGuardYear(doc, version) {
  if (doc.environment !== "production") return null;
  const issued = Date.parse(version.card?.issuedAt ?? "");
  const fact = Number.isFinite(issued) ? issued : doc.createdAt;
  return new Date(fact - BRASILIA).getUTCFullYear() + 5;
}
/** The stored-file fields of the package's tables (`ARCHIVE_STORAGE_FIELDS`; a test keeps them equal). */
export const PACKAGE_STORAGE_FIELDS = {
  importFiles: ["storageId"],
  documentArtifacts: ["storageId"],
  documentVersions: ["contentStorageId"],
  captureBatches: ["rawId"],
  issuanceArtifacts: ["storageId"],
};
async function packageRows(entries, table) {
  const path = entries.get(`${table}/documents.jsonl`);
  const rows = [];
  if (path) for await (const line of lines(path)) rows.push(JSON.parse(line));
  return rows;
}
/**
 * The executor's plan of the cold stage, from the package and the server's `coldPolicy`: the notes
 * whose files stay out of the files stage, each with those files (previous storage IDs) and their
 * bytes, in package order, grouped into batches. It mirrors, on the package's rows, the rule the
 * server applies to the rehydrated ones (`coldTier.notePlan` under `coldVerdict`): a hot note in
 * the package, received (no `direction`), entered before `cutoff`, with at most 64 versions, none
 * in processing, at least one published, every published one with its blob (hot ones verified by
 * B7) and its guard year under `lockedThrough`; its originals the ones `coldTier.noteOriginals`
 * takes. The server stays the authority: a file it keeps hot after all is admitted one upload at a
 * time, and a note this plan keeps hot is moved by the server's own pass once its files are in.
 */
export async function coldRehydrationPlan({
  entries,
  policy,
  batchBytes = REHYDRATE_COLD_BATCH_BYTES,
}) {
  const plan = { notes: [], files: 0, bytes: 0, batchBytes: 0, deferred: new Set(), batches: [] };
  if (!policy?.enabled) return plan;
  const locked = policy.lockedThrough;
  const lockPending = (year) => year !== null && (locked === null || year > locked);
  const sizes = new Map();
  for (const meta of await packageRows(entries, "_storage")) sizes.set(meta._id, meta.size);
  const holders = new Map();
  for (const [table, fields] of Object.entries(PACKAGE_STORAGE_FIELDS))
    for (const row of await packageRows(entries, table))
      for (const field of fields)
        if (typeof row[field] === "string") {
          const list = holders.get(row[field]) ?? [];
          if (!list.some((holder) => holder.table === table && holder.id === row._id))
            list.push({ table, id: row._id });
          holders.set(row[field], list);
        }
  const versions = await packageRows(entries, "documentVersions");
  const artifacts = new Map(
    (await packageRows(entries, "documentArtifacts")).map((row) => [row._id, row]),
  );
  const group = (key) => {
    const map = new Map();
    for (const version of versions) {
      const list = map.get(version[key]) ?? [];
      list.push(version);
      map.set(version[key], list);
    }
    return map;
  };
  const byDocument = group("documentId");
  const byArtifact = group("artifactId");
  const sole = (artifact) =>
    (holders.get(artifact.storageId) ?? []).every(
      (holder) =>
        (holder.table === "documentArtifacts" && holder.id === artifact._id) ||
        (holder.table === "importFiles" && holder.id === artifact.fileId),
    );
  /** The note's hot files the passage would move, or `null` when the note stays hot. */
  const noteFiles = (doc) => {
    if (doc.coldState !== undefined || doc.direction !== undefined) return null;
    if (!(doc.createdAt < policy.cutoff)) return null;
    const own = byDocument.get(doc._id) ?? [];
    if (own.length > MAX_VERSIONS) return null;
    const files = [];
    let published = 0;
    for (const version of own) {
      if (version.state === "staging") return null;
      if (version.publishedAt === undefined) continue;
      published++;
      const placed = [version.contentStorageId, version.contentObjectKey].filter(
        (field) => field !== undefined,
      ).length;
      const described = [version.contentSha256, version.contentSize, version.contentFormat];
      if (placed !== 1 || described.some((field) => field === undefined)) return null;
      if (version.contentObjectKey !== undefined) continue;
      if (version.contentVerifiedAt === undefined) return null;
      if (lockPending(coldGuardYear(doc, version))) return null;
      files.push(version.contentStorageId);
    }
    if (published === 0) return null;
    for (const artifactId of new Set(own.map((version) => version.artifactId))) {
      const artifact = artifacts.get(artifactId);
      if (
        !artifact ||
        artifact.documentId !== doc._id ||
        artifact.organizationId !== doc.organizationId ||
        artifact.parentArtifactId !== undefined
      )
        continue;
      const readers = byArtifact.get(artifactId) ?? [];
      if (
        readers.length > MAX_VERSIONS ||
        readers.some((reader) => reader.documentId !== undefined && reader.documentId !== doc._id)
      )
        continue;
      if (artifact.objectKey !== undefined || artifact.storageId === undefined) continue;
      if (!sole(artifact)) continue;
      let guardYear = null;
      for (const reader of readers) {
        const year = coldGuardYear(doc, reader);
        if (year !== null) guardYear = Math.max(guardYear ?? year, year);
      }
      if (lockPending(guardYear)) return null;
      files.push(artifact.storageId);
    }
    return [...new Set(files)];
  };
  for (const doc of await packageRows(entries, "fiscalDocuments")) {
    const files = noteFiles(doc);
    if (!files?.length) continue;
    let bytes = 0;
    for (const id of files) {
      assert.ok(sizes.has(id), "ARCHIVE_REHYDRATE_COLD_UNKNOWN_FILE");
      bytes += sizes.get(id);
      plan.deferred.add(id);
    }
    plan.notes.push({ id: doc._id, files, bytes });
    plan.files += files.length;
    plan.bytes += bytes;
  }
  // Batches in package order, each under the budget (or one note, when it alone is larger).
  const budget = Math.max(batchBytes, ...plan.notes.map((note) => note.bytes));
  let batch = null;
  for (const note of plan.notes) {
    if (!batch || batch.ids.length >= COLD_BATCH_NOTES || batch.bytes + note.bytes > budget) {
      batch = { ids: [], bytes: 0 };
      plan.batches.push(batch);
    }
    batch.ids.push(note.id);
    batch.bytes += note.bytes;
    plan.batchBytes = Math.max(plan.batchBytes, batch.bytes);
  }
  plan.batches = plan.batches.map((entry) => entry.ids);
  return plan;
}

/**
 * The admission's measure (ADR 0009, §5, item 1), in the unit `capacityCore` counts: the logical
 * size (`getDocumentSize`) of each row of the six document tables as it will be inserted, with
 * the origin pair, plus one ID map entry per rehydrated row and file. The server adds the margin
 * and compares with the current plan; files go by the manifest's bytes. With a cold plan (ADR
 * 0010, C2), the rows are all still counted (the residue of every note), plus what the notes gain
 * by going cold, and the files are the manifest's minus the deferred ones; the server adds the
 * batch.
 */
export async function measureAdmission({ run, order, entries, fileBytes, cold }) {
  let databaseBytes = 0;
  for (const table of TRACKED_TABLES) {
    const path = entries.get(`${table}/documents.jsonl`);
    if (!path) continue;
    for await (const line of lines(path)) {
      const row = JSON.parse(line);
      databaseBytes += getDocumentSize(jsonToConvex({ ...row, ...originPair(row) }));
    }
  }
  for (const entry of order) {
    if (entry.kind === "row" && FENCE_TABLES.has(entry.table)) continue;
    databaseBytes += getDocumentSize({
      _id: entry.originalId,
      _creationTime: 0,
      organizationId: run.organizationId,
      runId: run._id,
      table: entry.table,
      previousId: entry.originalId,
      previousCreationTime: 0,
      newId: entry.originalId,
    });
  }
  if (cold) databaseBytes += cold.files * COLD_FILE_GROWTH + cold.notes.length * COLD_NOTE_GROWTH;
  return { databaseBytes, fileBytes: fileBytes - (cold?.bytes ?? 0) };
}
/** Sends one original through its intent; a completed intent is reused and nothing is sent. */
async function rehydrateFile({ source, fence, metadata, path, upload }) {
  const start = parse(
    await source.mutation("coldArchiveRehydration:beginUpload", { ...fence, metadata }),
  );
  if (start.storageId) return start.storageId;
  const storageId = await upload({ url: start.uploadUrl, path, contentType: metadata.contentType });
  const args = { ...fence, previousId: metadata._id, attempt: start.attempt, storageId };
  let result;
  try {
    result = parse(await source.mutation("coldArchiveRehydration:recordUpload", args));
  } catch {
    // A lost response: recording the same storage ID again is idempotent.
    result = parse(await source.mutation("coldArchiveRehydration:recordUpload", args));
  }
  assert.ok(result.ok, "Original enviado diverge do pacote; reidratação interrompida");
  return storageId;
}
/** A deterministic refusal of the server (an error code), which repeating cannot change. */
export const serverRefusal = (error) =>
  /\b(?:ARCHIVE_[A-Z0-9_]+|COLD_TIER_[A-Z0-9_]+|QUOTA_EXCEEDED)\b/.test(
    error instanceof Error ? error.message : String(error),
  );
/**
 * Rehydrates an `archived` open organization, or resumes one in `restoring`, from the sealed
 * package and the compacted catalogue (ADR 0009, §5):
 *
 * 1. downloads and decrypts both, checks them against their manifests and each other;
 * 2. reads the server's cold policy and plans the cold stage (`coldRehydrationPlan`);
 * 3. `begin`: the server's admission (paid plan active, capacity of the hot files plus one batch),
 *    `archived` → `restoring`;
 * 4. first pass: every original but the deferred ones through an upload intent, then every row in
 *    catalogue order;
 * 5. second pass: the server rewrites the references, page by page;
 * 6. cold stage (ADR 0010, C2): the deferred files batch by batch, each moved to the cold tier by
 *    Convex before the next, then the server's own pass over every note;
 * 7. canonical check of every catalogue entry, in order, and `finish` back to `hot`;
 * 8. the collection of orphan uploads, which reports what is still too recent to judge.
 *
 * Every step resumes from the progress the server keeps on the run; a lost response is read back
 * from it, never guessed. `upload({ url, path, contentType })` sends a file to a Convex upload URL
 * and returns its storage ID; `sleep(ms)` waits between polls of a batch's passage.
 */
export async function rehydrate({
  source,
  store,
  runId,
  packageManifest,
  directory,
  decrypt,
  upload,
  coldBatchBytes = REHYDRATE_COLD_BATCH_BYTES,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const inspect = async () => parse(await source.query("coldArchive:inspect", { runId }));
  let run = await inspect();
  assert.ok(run, "Run inexistente");
  assert.notEqual(run.reason, "closed", "ARCHIVE_CLOSED_NOT_REACTIVATABLE");
  assert.ok(
    run.state === "archived" || run.state === "restoring",
    "Reidratação exige run em archived ou restoring",
  );
  assert.equal(
    run.manifestSha256,
    sha256(canonical(packageManifest)),
    "Pacote não é o selado no servidor",
  );
  const catalog = await loadCatalog({
    store,
    run,
    packageManifest,
    directory: join(directory, "catalog"),
    decrypt,
  });
  const { entries } = await openPackage({
    source,
    store,
    manifest: packageManifest,
    directory: join(directory, "package"),
    decrypt,
  });
  await compareCatalogWithPackage(entries, catalog);
  const order = [...catalog.values()];
  const fence = () => ({ runId, version: run.version });
  let cold;
  if (run.state === "archived") {
    // The cold stage is planned under the server's rule, and `begin` refuses a stale plan.
    const policy = parse(
      await source.query("coldArchiveRehydration:coldPolicy", { runId, now: Date.now() }),
    );
    cold = await coldRehydrationPlan({ entries, policy, batchBytes: coldBatchBytes });
    await source.mutation("coldArchiveRehydration:begin", {
      ...fence(),
      ...(await measureAdmission({
        run,
        order,
        entries,
        fileBytes: packageManifest.fileBytes,
        cold,
      })),
      ...(cold.files
        ? {
            cold: {
              cutoff: policy.cutoff,
              lockedThrough: policy.lockedThrough,
              files: cold.files,
              bytes: cold.bytes,
              batchBytes: cold.batchBytes,
            },
          }
        : {}),
    });
    run = await inspect();
  } else {
    // A resumed run: the same deferred files, from the rule recorded at `begin`.
    const recorded = run.rehydration?.cold;
    cold = await coldRehydrationPlan({
      entries,
      policy: recorded?.files
        ? { enabled: true, cutoff: recorded.cutoff, lockedThrough: recorded.lockedThrough }
        : null,
      batchBytes: coldBatchBytes,
    });
    if (recorded?.files && (cold.files !== recorded.files || cold.bytes !== recorded.bytes))
      throw new Error("ARCHIVE_REHYDRATE_COLD_PLAN_CHANGED");
  }
  assert.equal(run.state, "restoring", "Reidratação não começou");
  // Files first: every original, in catalogue order, through its intent; the deferred ones wait
  // for the cold stage.
  const metadata = new Map();
  const storage = entries.get("_storage/documents.jsonl");
  if (storage)
    for await (const line of lines(storage)) {
      const meta = JSON.parse(line);
      metadata.set(meta._id, meta);
    }
  for (const entry of order) {
    if (entry.kind !== "file" || cold.deferred.has(entry.originalId)) continue;
    const meta = metadata.get(entry.originalId);
    const path = entries.get(`_storage/${entry.originalId}`);
    assert.ok(meta && path, "Original do catálogo ausente no pacote");
    await rehydrateFile({ source, fence: fence(), metadata: meta, path, upload });
  }
  // Then every row, in catalogue order; each table's lines are in that same order.
  run = await inspect();
  if (run.rehydration.stage === "rows")
    await rehydrateRows({ source, inspect, run, order, entries });
  // Second pass, on the server, page by page.
  run = await inspect();
  for (let page = 0; page < 10_000_000; page++) {
    const step = parse(await source.mutation("coldArchiveRehydration:references", fence()));
    if (step.stage !== "references") break;
  }
  // The cold stage (ADR 0010, C2): batch by batch, then the server's own pass.
  run = await inspect();
  if (run.rehydration.stage === "cold")
    await rehydrateCold({ source, fence, cold, metadata, entries, upload, sleep });
  // Canonical check of every entry, in catalogue order.
  run = await inspect();
  if (run.rehydration.stage === "check") {
    let offset = run.rehydration.checked;
    const pending = order.slice(offset).map(({ kind, table, originalId, sha256: hash }) => ({
      kind,
      table,
      originalId,
      sha256: hash,
    }));
    for (let i = 0; i < pending.length; i += CHECK_ENTRIES) {
      const batch = pending.slice(i, i + CHECK_ENTRIES);
      const begin = offset;
      try {
        offset = parse(
          await source.mutation("coldArchiveRehydration:check", {
            ...fence(),
            offset: begin,
            entries: batch,
          }),
        ).checked;
      } catch (error) {
        const latest = (await inspect()).rehydration?.checked ?? 0;
        if (latest < begin + batch.length) throw error;
        offset = latest;
      }
    }
  }
  await source.mutation("coldArchiveRehydration:finish", fence());
  run = await inspect();
  assert.equal(run.state, "hot", "Reidratação não concluída");
  const recorded = run.rehydration?.cold;
  return {
    rows: run.rows,
    files: run.files,
    ...(recorded
      ? {
          cold: {
            deferredFiles: recorded.files,
            deferredBytes: recorded.bytes,
            batchBytes: recorded.batchBytes,
            moved: recorded.moved,
            kept: recorded.kept,
          },
        }
      : {}),
    ...(await collectOrphans({ source, runId })),
  };
}
/**
 * The cold stage of the rehydration (ADR 0010, C2). `drain` takes the batch under way to its end:
 * it uploads the deferred files the server asks for, through the same intents as the files stage,
 * and waits while Convex moves the claimed notes to the cold tier. Then each batch of the plan, by
 * the previous IDs of its notes, and the server's own pass until the stage ends. A call whose
 * response was lost is repeated once: the server reads every outcome back from the notes.
 */
async function rehydrateCold({ source, fence, cold, metadata, entries, upload, sleep }) {
  const call = async (name, args) => {
    try {
      return parse(await source.mutation(`coldArchiveRehydration:${name}`, args));
    } catch (error) {
      // Only a response that may have been lost is repeated; a server refusal stops at once.
      if (serverRefusal(error)) throw error;
      return parse(await source.mutation(`coldArchiveRehydration:${name}`, args));
    }
  };
  const drain = async () => {
    let attempt = 0,
      polls = 0;
    for (;;) {
      const step = await call("coldStep", fence());
      if (step.state === "idle" || step.state === "done") return;
      if (step.state === "upload") {
        for (const id of step.files) {
          const meta = metadata.get(id);
          const path = entries.get(`_storage/${id}`);
          assert.ok(meta && path, "ARCHIVE_REHYDRATE_COLD_UNKNOWN_FILE");
          await rehydrateFile({ source, fence: fence(), metadata: meta, path, upload });
        }
        continue;
      }
      if (step.attempt !== attempt) {
        attempt = step.attempt;
        polls = 0;
      }
      if (attempt > COLD_ATTEMPTS) throw new Error("ARCHIVE_REHYDRATE_COLD_STALLED");
      if (++polls > COLD_POLLS) throw new Error("ARCHIVE_REHYDRATE_COLD_TIMEOUT");
      await sleep(COLD_POLL_MS);
    }
  };
  const start = async (args) => {
    for (;;) {
      const result = await call("coldBatch", args);
      if (result.state !== "busy") return result;
      await drain();
    }
  };
  await drain();
  for (const documentIds of cold.batches) {
    if ((await start({ ...fence(), documentIds })).state === "done") return;
    await drain();
  }
  for (let page = 0; page < 10_000_000; page++) {
    if ((await start(fence())).state === "done") return;
    await drain();
  }
}
/** First pass over the rows, in batches from the server's offset; a lost response is read back. */
async function rehydrateRows({ source, inspect, run, order, entries }) {
  const fence = { runId: run._id, version: run.version };
  const readers = new Map();
  const next = async (table) => {
    if (!readers.has(table)) {
      const path = entries.get(`${table}/documents.jsonl`);
      assert.ok(path, "Tabela do catálogo ausente no pacote");
      readers.set(table, lines(path));
    }
    const line = await readers.get(table).next();
    assert.ok(!line.done, "Pacote sem a linha do catálogo");
    return line.value;
  };
  let offset = run.rehydration.rows,
    index = 0,
    batch = [],
    bytes = 0;
  const flush = async () => {
    const begin = offset;
    try {
      offset = parse(
        await source.mutation("coldArchiveRehydration:rows", {
          ...fence,
          offset: begin,
          rows: batch,
        }),
      ).rows;
    } catch (error) {
      const latest = (await inspect()).rehydration?.rows ?? 0;
      if (latest < begin + batch.length) throw error;
      offset = latest;
    }
    batch = [];
    bytes = 0;
  };
  try {
    for (const entry of order) {
      if (entry.kind !== "row") continue;
      const line = await next(entry.table);
      assert.ok(
        JSON.parse(line)._id === entry.originalId && sha256(line) === entry.sha256,
        "Pacote fora da ordem do catálogo",
      );
      if (index++ < offset) continue;
      const size = Buffer.byteLength(line);
      if (batch.length && (batch.length >= REHYDRATE_ROWS || bytes + size > REHYDRATE_BYTES))
        await flush();
      batch.push({ table: entry.table, json: line });
      bytes += size;
    }
    if (batch.length) await flush();
  } finally {
    for (const reader of readers.values()) await reader.return();
  }
}
/**
 * The collection of orphan uploads of a run (ADR 0009, §5, item 4), one attempt and one page of
 * its window per call; the server keeps the position and returns the same cursor until the
 * window is done. Attempts too recent to judge stay `pending`; running it again later collects
 * them.
 */
export async function collectOrphans({ source, runId }) {
  let cursor = null,
    orphansDeleted = 0,
    orphansPending = 0;
  for (let call = 0; call < 1_000_000; call++) {
    const page = parse(
      await source.mutation("coldArchiveRehydration:collectUploadOrphans", { runId, cursor }),
    );
    orphansDeleted += page.deleted;
    orphansPending += page.pending;
    if (page.isDone) return { orphansDeleted, orphansPending };
    cursor = page.continueCursor;
  }
  throw new Error("Coleta de órfãos sem fim");
}
