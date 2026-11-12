import assert from "node:assert/strict";
import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { byCodeUnit, objectKeys, sha256, snapshotReserve } from "./offsite-backup.mjs";
import { fileDigest, writeZip } from "./offsite-backup-zip.mjs";
import { tableRows, sortedTableDigest } from "./backup-table-stream.mjs";

// Explicit opt-in for streaming format 2; the active format-1 plan remains at 1 GiB.
export const GLOBAL_LIMIT = 8 * 1024 ** 3;
// Ciphertext grows with the number of age chunks; a fixed 1 MiB allowance fails at large sizes.
export const ciphertextLimit = (maxBytes) =>
  maxBytes + Math.max(1024 ** 2, Math.ceil(maxBytes / 1024));
export const STORAGE_FIELDS = {
  importFiles: "storageId",
  documentArtifacts: "storageId",
  documentVersions: "contentStorageId",
  captureBatches: "rawId",
  issuanceArtifacts: "storageId",
  referenceVersions: "storageId",
  exportParts: "storageId",
  documentDanfes: "storageId",
  capacityFiles: "storageId",
};
export const COMPONENT_PATHS = [
  "",
  "betterAuth",
  "rateLimiter",
  "importPool",
  "capturePool",
  "webhookPool",
  "exportPool",
  "issuancePool",
  "contentPool",
];
const safeBytes = (n) => Number.isSafeInteger(n) && n >= 0;
const validHash = (n) => typeof n === "string" && /^[a-f0-9]{64}$/.test(n);
export function incrementalPlan(plan) {
  const config = plan.incremental;
  assert.equal(config?.version, 2, "Configure incremental.version=2 antes de ativar");
  assert.equal(
    config.blobPrefix,
    `${plan.prefix}objects/`,
    "Prefixo de objetos deve ser separado de snapshots/",
  );
  assert.equal(
    config.retentionConfigured,
    true,
    "Confirme lifecycle separado, lock e coleta por referências antes de ativar",
  );
  assert.equal(plan.cadenceHours, 12, "Incremental mantém a cadência de 12 h");
  assert.ok(
    safeBytes(plan.maxSnapshotBytes) &&
      plan.maxSnapshotBytes <= GLOBAL_LIMIT &&
      plan.maxSnapshotBytes > 0,
    "Limite global máximo: 8 GiB",
  );
  return config;
}
export function recipientSet(plan) {
  return sha256(
    plan.recipients
      .map((r) => r.recipient)
      .sort(byCodeUnit)
      .join("\n"),
  );
}
export function blobKeys(plan, hash) {
  assert.ok(validHash(hash), "Hash de arquivo inválido");
  const base = `${incrementalPlan(plan).blobPrefix}${recipientSet(plan)}/${hash}`;
  return { cipher: `${base}.age`, proof: `${base}.json` };
}
export function metadataHash(metadata) {
  return sha256(
    JSON.stringify([
      metadata._id,
      metadata._creationTime,
      metadata.sha256,
      metadata.size,
      metadata.contentType ?? null,
    ]),
  );
}
export function validateMetadata(metadata) {
  assert.ok(
    typeof metadata?._id === "string" && /^[a-zA-Z0-9_-]+$/.test(metadata._id),
    "Storage ID inválido",
  );
  assert.ok(
    safeBytes(metadata.size) && Number.isFinite(metadata._creationTime),
    "Metadados de storage inválidos",
  );
  const hash = Buffer.from(metadata.sha256 ?? "", "base64");
  assert.ok(
    hash.length === 32 && hash.toString("base64") === metadata.sha256,
    "Hash de storage inválido",
  );
  return hash.toString("hex");
}
export function preflight({ databaseBytes, storage, maxBytes, tables = 0 }) {
  assert.ok(safeBytes(databaseBytes) && safeBytes(tables), "Preflight sem medição de banco");
  assert.ok(
    safeBytes(maxBytes) && maxBytes > 0 && maxBytes <= GLOBAL_LIMIT,
    "Limite global inválido",
  );
  let storageBytes = 0;
  for (const { metadata } of storage) {
    validateMetadata(metadata);
    storageBytes += metadata.size;
  }
  // The monitor warns against the same estimate (evaluateBackups).
  const reserveBytes = snapshotReserve({ databaseBytes, tables, files: storage.length });
  const estimatedBytes = databaseBytes + storageBytes + reserveBytes;
  assert.ok(
    estimatedBytes <= maxBytes,
    "Preflight: banco + arquivos + reserva acima do limite global; export não iniciado",
  );
  return { databaseBytes, storageBytes, reserveBytes, estimatedBytes, maxBytes };
}

/** Uses the same admin system queries as `convex data`; no customer rows leave this process. */
export async function readSystemInventory(query, maxBytes, { legacyFormat = false } = {}) {
  let databaseBytes = 0,
    tables = 0;
  const references = new Set();
  async function* pages(path, args, componentPath) {
    let cursor = null;
    do {
      const page = await query(
        path,
        { ...args, paginationOpts: { cursor, numItems: 128, maximumBytesRead: 2 * 1024 ** 2 } },
        componentPath,
      );
      assert.ok(
        Array.isArray(page.page) && typeof page.isDone === "boolean",
        "Inventário incompleto",
      );
      yield page.page;
      if (page.isDone) return;
      assert.ok(page.continueCursor && page.continueCursor !== cursor, "Inventário sem progresso");
      cursor = page.continueCursor;
    } while (true);
  }
  for (const component of COMPONENT_PATHS) {
    for await (const names of pages("_system/cli/tables", {}, component)) {
      for (const { name } of names) {
        assert.ok(typeof name === "string", "Tabela inválida no inventário");
        tables++;
        let tableBytes = 0;
        for await (const rows of pages(
          "_system/cli/tableData",
          { table: name, order: "asc" },
          component,
        )) {
          for (const row of rows) {
            const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
            databaseBytes += bytes;
            tableBytes += bytes;
            assert.ok(
              !legacyFormat || tableBytes <= 64 * 1024 ** 2,
              "Preflight: tabela acima do limite de processamento (64 MiB)",
            );
            assert.ok(
              databaseBytes <= maxBytes,
              "Preflight: banco acima do limite global; export não iniciado",
            );
            const field =
              component === "" &&
              !["exportParts", "capacityFiles"].includes(name) &&
              STORAGE_FIELDS[name];
            if (field && row[field]) references.add(row[field]);
          }
        }
      }
    }
  }
  return { databaseBytes, tables, references };
}

// Uniform export encodes int64 as integer tokens and float64 as decimal/exponent tokens.
// Keep every original numeric token, including nested values, while patching control fields.
class ExportNumber {
  constructor(raw) {
    this.raw = raw;
  }
}
function parseSnapshotRow(line, uniform) {
  return JSON.parse(line, (_key, value, context) => {
    if (!uniform || typeof value !== "number") return value;
    assert.ok(context?.source, "Runtime sem JSON.parse source; preserve o export original");
    return new ExportNumber(context.source);
  });
}
function encodeSnapshotRow(value, uniform) {
  if (value instanceof ExportNumber) return value.raw;
  if (typeof value === "number" && uniform) {
    if (Object.is(value, -0)) return "-0.0";
    const text = JSON.stringify(value);
    return Number.isInteger(value) && !/[.eE]/.test(text) ? `${text}.0` : text;
  }
  if (Array.isArray(value)) return `[${value.map((v) => encodeSnapshotRow(v, uniform)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, v]) => `${JSON.stringify(key)}:${encodeSnapshotRow(v, uniform)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function uniformTable(entries, name) {
  const schemaPath = entries.get(name.replace(/documents\.jsonl$/, "generated_schema.jsonl"));
  return !!schemaPath && (await readFile(schemaPath, "utf8")).trim() === '"uniform"';
}
/** Invalidate derived downloads; all fiscal/source rows remain byte-for-byte unchanged. */
export async function prepareDatabase(entries) {
  const references = new Set();
  const coldArchives = await coldArchiveReferences(entries);
  let invalidatedExports = 0;
  for (const [name, path] of entries) {
    if (name.startsWith("_components/")) {
      assert.ok(
        COMPONENT_PATHS.some((p) => p && name.startsWith(`_components/${p}/`)),
        "Componente ausente do preflight",
      );
      assert.ok(!name.includes("/_storage/"), "Storage de componente exige inventário próprio");
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*\/documents.jsonl$/.test(name)) continue;
    const table = name.split("/")[0];
    const uniform = await uniformTable(entries, name);
    const encode = (value) => encodeSnapshotRow(value, uniform);
    if (table === "exportTickets") {
      await writeFile(path, "", { mode: 0o600 });
      continue;
    }
    if (table === "capacityAccounts" || table === "documentExports") {
      const transformed = path + ".restore";
      async function* transformRows() {
        for await (const line of tableRows(path)) {
          const row = parseSnapshotRow(line, uniform);
          if (table === "capacityAccounts") {
            row.ready = false;
            row.phase = 0;
            row.cursor = null;
          } else {
            if (row.state === "running" || row.state === "succeeded") {
              row.state = "expired";
              row.code = "BACKUP_REGENERATE_EXPORT";
              invalidatedExports++;
            }
            delete row.expireJobId;
          }
          yield encode(row) + "\n";
        }
      }
      try {
        await pipeline(
          Readable.from(transformRows()),
          createWriteStream(transformed, { flags: "wx", mode: 0o600 }),
        );
        await rename(transformed, path);
      } finally {
        await unlink(transformed).catch(() => {});
      }
    }
    const field = !["exportParts", "capacityFiles"].includes(table) && STORAGE_FIELDS[table];
    if (field)
      for await (const line of tableRows(path)) {
        const row = JSON.parse(line);
        if (row[field]) references.add(row[field]);
      }
  }
  return { references, invalidatedExports, coldArchives };
}

/** Archived fiscal rows live in independent immutable packages, not in the hot DB export. */
export async function coldArchiveReferences(entries) {
  const path = entries.get("coldArchiveRuns/documents.jsonl");
  if (!path) return [];
  const references = [];
  for await (const line of tableRows(path)) {
    const run = JSON.parse(line);
    if (["hot", "notice", "frozen", "sealed", "verified"].includes(run.state)) continue;
    assert.equal(
      run.state,
      "archived",
      "Backup aguarda conclusão da movimentação do arquivo econômico",
    );
    assert.ok(
      run.manifest && sha256(run.manifest) === run.manifestSha256,
      "Catálogo frio sem manifesto íntegro",
    );
    const manifest = JSON.parse(run.manifest);
    assert.ok(
      manifest.format === "fnfe-cold-archive/1" &&
        manifest.runId === run._id &&
        manifest.organizationId === run.organizationId,
      "Manifesto frio fora da organização",
    );
    assert.ok(
      validHash(manifest.ciphertextSha256) && safeBytes(manifest.ciphertextBytes),
      "Cifra fria inválida",
    );
    assert.equal(manifest.objectKey, `${manifest.prefix}${manifest.runId}/archive.zip.age`);
    // A compacted catalogue (ADR 0009, §4) left the hot DB: its R2 object is now as permanent a
    // dependency of this backup as the package, from the moment it is recorded as verified.
    if (run.catalog)
      assert.ok(validHash(run.catalog.manifestSha256), "Catálogo compactado sem manifesto");
    references.push({
      body: run.manifest,
      sha256: run.manifestSha256,
      ...(run.catalog ? { catalogSha256: run.catalog.manifestSha256 } : {}),
    });
  }
  return references;
}
/**
 * Tables whose rows may name an object of the cold tier (ADR 0010, phase C): the content of a
 * version (`content-<sha>.gz`) and, decision 8, the XML original of a cold note
 * (`original-<sha>.gz`). Each row keeps the object in exactly one place: storage or bucket.
 */
export const COLD_OBJECT_TABLES = {
  documentVersions: {
    storage: "contentStorageId",
    key: "contentObjectKey",
    sha256: "contentObjectSha256",
    bytes: "contentObjectSize",
    kind: "content",
  },
  documentArtifacts: {
    storage: "storageId",
    key: "objectKey",
    sha256: "objectSha256",
    bytes: "objectSize",
    kind: "original",
  },
};
/**
 * Cold documents of ADR 0010, phase C: the objects moved to the cold tier's bucket, named by the
 * rows of `COLD_OBJECT_TABLES`. The bytes stay in that bucket, outside the export; the row,
 * inside the encrypted database, names the key, the SHA-256 and the size of the object. The
 * manifest binds the sorted list by its count and digest; publication checks that every object
 * exists with its size, and recovery reads each one back and checks its hash.
 */
export async function coldDocumentReferences(entries) {
  const references = [];
  for (const table of Object.keys(COLD_OBJECT_TABLES)) {
    const path = entries.get(`${table}/documents.jsonl`);
    if (path)
      for await (const line of tableRows(path)) {
        const reference = coldReferenceOf(JSON.parse(line), table);
        if (reference) references.push(reference);
      }
  }
  return coldDocumentList(references);
}
const coldKey =
  /^documents\/(?:sandbox|production\/guard-\d{4})\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/(content|original)-[a-f0-9]{64}\.gz$/;
/**
 * The cold object a row of `table` (a version by default) names, or `null` for a hot one; a
 * partial reference, or a key of another kind, fails.
 */
export function coldReferenceOf(row, table = "documentVersions") {
  const fields = COLD_OBJECT_TABLES[table];
  assert.ok(fields, "Tabela sem objeto frio");
  const key = row[fields.key];
  if (key === undefined) return null;
  assert.ok(
    typeof key === "string" &&
      coldKey.exec(key)?.[1] === fields.kind &&
      row[fields.storage] === undefined &&
      validHash(row[fields.sha256]) &&
      safeBytes(row[fields.bytes]) &&
      row[fields.bytes] > 0,
    "Documento frio sem referência íntegra",
  );
  return { key, sha256: row[fields.sha256], bytes: row[fields.bytes] };
}
/** Sorted references, their text (`key sha256 bytes`, one per line) and its SHA-256. */
export function coldDocumentList(references) {
  const sorted = [...references].sort((a, b) => byCodeUnit(a.key, b.key));
  const body = sorted.map((r) => `${r.key} ${r.sha256} ${r.bytes}\n`).join("");
  return { count: sorted.length, digest: sha256(body), body, references: sorted };
}
/** Where a package of ADR 0009 keeps the list of the cold documents it references. */
export const coldDocumentListKey = (manifest) =>
  `${manifest.prefix}${manifest.runId}/cold-documents.txt`;
/** Parses a list written by `coldDocumentList`, checking it against its count and digest. */
export function parseColdDocumentList(body, { count, digest }) {
  assert.equal(sha256(body), digest, "Lista de documentos frios ausente ou alterada");
  const references = body
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [key, hash, bytes] = line.split(" ");
      const table =
        coldKey.exec(key)?.[1] === "original" ? "documentArtifacts" : "documentVersions";
      const fields = COLD_OBJECT_TABLES[table];
      return coldReferenceOf(
        { [fields.key]: key, [fields.sha256]: hash, [fields.bytes]: Number(bytes) },
        table,
      );
    });
  assert.equal(references.length, count, "Lista de documentos frios ausente ou alterada");
  return references;
}
/** The manifest's binding of the cold documents: absent for a backup without any. */
export function coldDocumentsManifest(cold, bucket) {
  if (cold.count === 0) return undefined;
  assert.ok(bucket, "Backup com documentos frios exige coldTier.bucket no plano");
  return { bucket, count: cold.count, digest: cold.digest };
}
/**
 * `full`: reads every object and checks its SHA-256 (recovery). Otherwise only its existence
 * and size, by HEAD (publication, twice a day).
 */
export async function verifyColdDocuments(client, references, { full = false } = {}) {
  if (references.length === 0) return;
  assert.ok(client, "Backup com documentos frios exige acesso de leitura ao bucket frio");
  for (const reference of references) {
    if (full) {
      await client.verifyFile(reference.key, { sha256: reference.sha256, bytes: reference.bytes });
      continue;
    }
    const head = await client.head(reference.key);
    assert.ok(head && head.size === reference.bytes, "Documento frio ausente ou alterado");
  }
}
/**
 * Each package of ADR 0009 and, since phase C of ADR 0010, the cold documents it references by
 * hash: the list next to the package, bound by the manifest's count and digest, and every object
 * in the cold tier's bucket (`coldStorage(bucket)`), by HEAD or, `full`, by its SHA-256.
 * `documents: false` skips them (the collection, which only reads the backup bucket).
 */
export async function verifyColdArchives(
  client,
  references,
  {
    coldStorage = /** @type {(bucket: string | undefined) => any} */ (() => null),
    full = false,
    documents = true,
  } = {},
) {
  for (const reference of references) {
    assert.equal(sha256(reference.body), reference.sha256, "Manifesto frio corrompido");
    const manifest = JSON.parse(reference.body);
    assert.ok(/^[A-Za-z0-9/_-]+\/cold\/$/.test(manifest.prefix) && !manifest.prefix.includes(".."));
    assert.equal(
      (await client.get(`${manifest.prefix}${manifest.runId}/manifest.json`)).toString("utf8"),
      reference.body,
      "Manifesto frio ausente ou alterado",
    );
    await client.verifyFile(manifest.objectKey, {
      sha256: manifest.ciphertextSha256,
      bytes: manifest.ciphertextBytes,
    });
    if (documents && manifest.coldDocuments) {
      const listed = parseColdDocumentList(
        (await client.get(coldDocumentListKey(manifest))).toString("utf8"),
        manifest.coldDocuments,
      );
      await verifyColdDocuments(coldStorage(manifest.coldDocuments.bucket), listed, { full });
    }
    if (reference.catalogSha256 === undefined) continue;
    const body = (
      await client.get(`${manifest.prefix}${manifest.runId}/catalog-manifest.json`)
    ).toString("utf8");
    assert.equal(
      sha256(body),
      reference.catalogSha256,
      "Manifesto do catálogo ausente ou alterado",
    );
    const catalog = JSON.parse(body);
    assert.ok(
      catalog.format === "fnfe-cold-archive-catalog/1" &&
        catalog.runId === manifest.runId &&
        catalog.packageManifestSha256 === reference.sha256 &&
        catalog.objectKey === `${manifest.prefix}${manifest.runId}/catalog.jsonl.age` &&
        validHash(catalog.ciphertextSha256) &&
        safeBytes(catalog.ciphertextBytes),
      "Catálogo frio fora do pacote",
    );
    await client.verifyFile(catalog.objectKey, {
      sha256: catalog.ciphertextSha256,
      bytes: catalog.ciphertextBytes,
    });
  }
}

function canonicalSnapshotJson(value) {
  if (value instanceof ExportNumber) {
    if (!/[.eE]/.test(value.raw)) {
      const bytes = Buffer.alloc(8);
      bytes.writeBigInt64LE(BigInt(value.raw));
      return JSON.stringify({ $integer: bytes.toString("base64") });
    }
    const number = Number(value.raw);
    if (Object.is(number, -0)) {
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleLE(number);
      return JSON.stringify({ $float: bytes.toString("base64") });
    }
    return JSON.stringify(number);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalSnapshotJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function diskSummary(entries, { verifyStorage = true } = {}) {
  const tables = {},
    digests = {};
  let files = 0,
    bytes = 0;
  assert.ok(entries.has("_tables/documents.jsonl"), "Snapshot sem índice de tabelas");
  for (const [name, path] of entries) {
    if (!name.endsWith("/documents.jsonl") || /(^|\/)_(tables|scheduled_functions)\//.test(name))
      continue;
    // Export adds an internal blob locator which changes after an import. It is not an
    // original _storage field; IDs, creation time, MIME, size and checksum remain compared.
    const uniform = name !== "_storage/documents.jsonl" && (await uniformTable(entries, name));
    let count = 0;
    async function* canonicalRows() {
      for await (const line of tableRows(path)) {
        const row = parseSnapshotRow(line, uniform);
        if (name === "_storage/documents.jsonl") delete row.internalId;
        count++;
        yield canonicalSnapshotJson(row);
      }
    }
    digests[name] = await sortedTableDigest(canonicalRows(), path);
    if (name === "_storage/documents.jsonl") {
      for await (const line of tableRows(path)) {
        const metadata = JSON.parse(line),
          hash = validateMetadata(metadata);
        if (verifyStorage) {
          const blob =
            entries.get(`_storage/${metadata._id}`) ??
            [...entries].find(([n]) => n.startsWith(`_storage/${metadata._id}.`))?.[1];
          assert.ok(blob, "Arquivo ausente no snapshot");
          const actual = await fileDigest(blob);
          assert.ok(
            actual.sha256 === hash && actual.bytes === metadata.size,
            "Arquivo divergente no snapshot",
          );
        }
        files++;
        bytes += metadata.size;
      }
    } else if (/^(?:_components\/.+\/)?[A-Za-z][A-Za-z0-9_]*\/documents.jsonl$/.test(name)) {
      tables[name.slice(0, -"/documents.jsonl".length)] = count;
    } else delete digests[name];
  }
  return { tables, digests, storage: { files, bytes } };
}

async function download(url, path, metadata, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  assert.ok(response.ok, `Download de storage falhou: HTTP ${response.status}`);
  assert.ok(
    Number(response.headers.get("content-length") ?? 0) <= metadata.size,
    "Storage excedeu tamanho previsto",
  );
  let bytes = 0;
  await pipeline(
    response.body,
    new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(bytes > metadata.size ? new Error("Storage excedeu tamanho previsto") : null, chunk);
      },
    }),
    createWriteStream(path, { mode: 0o600, flags: "wx" }),
  );
  const actual = await fileDigest(path);
  assert.ok(
    actual.bytes === metadata.size && actual.sha256 === validateMetadata(metadata),
    "Storage diverge dos metadados",
  );
  return actual;
}

function validateProof(proof, plan, hash, size) {
  assert.ok(
    proof?.format === 2 &&
      proof.recipientSet === recipientSet(plan) &&
      proof.plaintext?.sha256 === hash &&
      proof.plaintext?.bytes === size &&
      validHash(proof.ciphertext?.sha256) &&
      safeBytes(proof.ciphertext?.bytes),
    "Prova de objeto inválida",
  );
  return proof;
}
/** Reuses only an object whose upload roundtrip and present ciphertext have been verified. */
export async function copyBlob({
  plan,
  client,
  item,
  directory,
  encrypt,
  fetchImpl = fetch,
  metrics = /** @type {ReturnType<typeof import("./offsite-backup.mjs").backupMetrics> | undefined} */ (
    undefined
  ),
}) {
  const hash = validateMetadata(item.metadata),
    keys = blobKeys(plan, hash);
  if (await client.head(keys.proof)) {
    const proof = validateProof(
      JSON.parse((await client.get(keys.proof)).toString("utf8")),
      plan,
      hash,
      item.metadata.size,
    );
    await client.verifyFile(keys.cipher, proof.ciphertext);
    if (metrics) metrics.observed.reusedBlobReferences++;
    return { key: keys.cipher, ...proof, reused: true };
  }
  // An interrupted or simultaneous writer cannot be overwritten. Retry after reconciliation.
  assert.ok(!(await client.head(keys.cipher)), "Objeto sem prova; reconciliar antes de repetir");
  assert.ok(item.url, "Arquivo desapareceu antes da cópia; manifesto não publicado");
  const plain = join(directory, "blob"),
    cipher = join(directory, "blob.age");
  try {
    const plaintext = await download(item.url, plain, item.metadata, fetchImpl);
    await encrypt(plain, cipher); // callback must verify an age encrypt/decrypt roundtrip
    const ciphertext = await fileDigest(cipher);
    assert.ok(
      await client.putFile(keys.cipher, cipher, { immutable: true }),
      "Objeto criado por outro executor; repita",
    );
    if (metrics) metrics.observed.newBlobObjects++;
    await client.verifyFile(keys.cipher, ciphertext);
    const proof = { format: 2, recipientSet: recipientSet(plan), plaintext, ciphertext };
    assert.ok(
      await client.putImmutable(keys.proof, Buffer.from(JSON.stringify(proof)), "application/json"),
      "Prova concorrente; repita",
    );
    return { key: keys.cipher, ...proof, reused: false };
  } finally {
    await unlink(plain).catch(() => {});
    await unlink(cipher).catch(() => {});
  }
}

/** Private index lives inside the age-encrypted DB ZIP, with original Convex storage metadata. */
export async function attachStorage(entries, items, directory) {
  const path = join(directory, "storage-metadata.jsonl");
  const unique = new Map();
  for (const item of items) {
    validateMetadata(item.metadata);
    assert.ok(!unique.has(item.metadata._id), "Storage ID repetido");
    unique.set(item.metadata._id, item.metadata);
  }
  await writeFile(path, [...unique.values()].map((m) => JSON.stringify(m) + "\n").join(""), {
    mode: 0o600,
  });
  entries.set("_storage/documents.jsonl", path);
}

/** Offline reconstruction. No source Convex access and no hot deletion. */
export async function restoreIncremental({
  manifest,
  entries,
  client,
  coldStorage = /** @type {(bucket: string | undefined) => any} */ (() => null),
  directory,
  decrypt,
  zip,
  maxBytes,
}) {
  assert.equal(manifest.format, 2);
  const coldArchives = await coldArchiveReferences(entries);
  assert.deepEqual(manifest.coldArchives ?? [], coldArchives, "Backup não cobre o catálogo frio");
  await verifyColdArchives(client, coldArchives, { coldStorage, full: true });
  const cold = await coldDocumentReferences(entries);
  const bound = manifest.coldDocuments;
  assert.deepEqual(
    bound ? { count: bound.count, digest: bound.digest } : null,
    cold.count ? { count: cold.count, digest: cold.digest } : null,
    "Backup não cobre os documentos frios",
  );
  await verifyColdDocuments(coldStorage(bound?.bucket), cold.references, { full: true });
  assert.ok(Array.isArray(manifest.objects), "Manifesto sem objetos");
  const objects = new Map(manifest.objects.map((o) => [o.plaintext?.sha256, o]));
  assert.equal(objects.size, manifest.objects.length, "Objeto repetido no manifesto");
  const metadataPath = entries.get("_storage/documents.jsonl");
  assert.ok(metadataPath, "Snapshot sem metadados de storage");
  let storageBytes = 0;
  const restored = new Map();
  for await (const line of tableRows(metadataPath)) {
    const metadata = JSON.parse(line),
      hash = validateMetadata(metadata),
      object = objects.get(hash);
    storageBytes += metadata.size;
    assert.ok(storageBytes <= maxBytes, "Restore acima do limite global");
    assert.ok(
      object &&
        object.plaintext.bytes === metadata.size &&
        validHash(object.ciphertext?.sha256) &&
        safeBytes(object.ciphertext?.bytes),
      "Manifesto não cobre referência de storage",
    );
    assert.ok(
      new RegExp(`^${manifest.deployment}/objects/[a-f0-9]{64}/${hash}\\.age$`).test(object.key),
      "Objeto fora do prefixo permanente",
    );
    let plain = restored.get(hash);
    if (!plain) {
      const cipher = join(directory, `${hash}.age`);
      plain = join(directory, hash);
      const actual = await client.getFile(object.key, cipher, ciphertextLimit(maxBytes));
      assert.deepEqual(actual, object.ciphertext, "Cifra de objeto divergente");
      await decrypt(cipher, plain);
      assert.deepEqual(await fileDigest(plain), object.plaintext, "Original restaurado divergente");
      await unlink(cipher);
      restored.set(hash, plain);
    }
    assert.ok(!entries.has(`_storage/${metadata._id}`), "Storage ID repetido no restore");
    entries.set(`_storage/${metadata._id}`, plain);
  }
  const summary = await diskSummary(entries);
  assert.deepEqual(summary.digests, manifest.digests, "Conteúdo restaurado diverge do manifesto");
  await writeZip(entries, zip, maxBytes);
  return summary;
}

/** Local proof for the archival executor; uploading a caller-supplied receipt is insufficient. */
export async function restoredObjectProof({
  metadata,
  path,
  ciphertext,
  verifierRunId,
  verifiedAt,
}) {
  const actual = await fileDigest(path);
  assert.ok(
    actual.sha256 === validateMetadata(metadata) && actual.bytes === metadata.size,
    "Prova de restore diverge do original",
  );
  assert.ok(
    validHash(ciphertext.sha256) &&
      typeof verifierRunId === "string" &&
      verifierRunId.length > 0 &&
      Number.isFinite(verifiedAt),
  );
  return {
    originalStorageId: metadata._id,
    restoredMetadataSha256: metadataHash(metadata),
    restoredPlaintextSha256: actual.sha256,
    restoredBytes: actual.bytes,
    objectCiphertextSha256: ciphertext.sha256,
    verifierRunId,
    verifiedAt,
  };
}

export async function publishIncremental({
  plan,
  client,
  manifest,
  cipher,
  coldStorage = /** @type {(bucket: string | undefined) => any} */ (() => null),
}) {
  const keys = objectKeys(plan, manifest.id);
  assert.equal(manifest.format, 2);
  assert.deepEqual(await fileDigest(cipher), manifest.ciphertext, "Cifra do banco divergente");
  assert.ok(
    await client.putFile(keys.snapshot, cipher, { immutable: true }),
    "Snapshot concorrente",
  );
  await client.verifyFile(keys.snapshot, manifest.ciphertext);
  await verifyColdArchives(client, manifest.coldArchives ?? [], { coldStorage });
  for (const object of manifest.objects) await client.verifyFile(object.key, object.ciphertext);
  assert.ok(
    await client.putImmutable(
      keys.manifest,
      Buffer.from(JSON.stringify(manifest)),
      "application/json",
    ),
    "Manifesto concorrente",
  );
}
