import { afterEach, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_SCHEMA_VERSION,
  assertIsolatedRestore,
  assistedExport,
  buildRestoreDelta,
  canonical,
  catalogKeys,
  coldGuardYear,
  coldRehydrationPlan,
  COLD_BATCH_NOTES,
  compactCatalog,
  createArchive,
  FILE_LIMIT,
  DATABASE_LIMIT,
  ISOLATED_RESTORE_STATES,
  loadCatalog,
  manifestSchemaVersion,
  measureAdmission,
  PACKAGE_STORAGE_FIELDS,
  publishArchive,
  publishCatalog,
  rehydrate,
  removeHot,
  restoreIsolated,
  serverRefusal,
  validateAssistedRequest,
  validateCatalogManifest,
  validateManifest,
  verifyArchive,
} from "../lib/cold-archive.mjs";
import { extractZip, fileDigest, writeZip } from "../lib/offsite-backup-zip.mjs";
import {
  coldArchiveReferences,
  diskSummary,
  verifyColdArchives,
} from "../lib/incremental-backup.mjs";
import { sha256 } from "../lib/offsite-backup.mjs";
import { assertRestoreDestination, refusalOf, validateTargets } from "./cold-archive.mjs";
import schema from "../../platform/convex/schema";
import {
  ARCHIVE_SCHEMA_VERSION as CORE_SCHEMA_VERSION,
  ARCHIVE_STORAGE_FIELDS,
  ARCHIVE_TABLES,
} from "../../platform/convex/lib/coldArchiveCore";
import { archiveReferences } from "../../platform/convex/lib/coldArchiveReferences";
import { fiscalGuardUntil, retentionClass } from "../../platform/convex/lib/retentionClasses";
import { COLD_BATCH_NOTES as SERVER_COLD_BATCH_NOTES } from "../../platform/convex/lib/coldArchiveRehydration";

const directories: string[] = [];
const scratch = () => {
  const path = mkdtempSync(join(tmpdir(), "fnfe-cold-test-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const hasAge =
  spawnSync(process.env.AGE_BIN || "age", ["--version"], { windowsHide: true }).status === 0;
const original = readFileSync("tests/fixtures/nfe/4.00/summary-zero-number.xml");
/** Numbering and capture rows of the minimal fence (ADR 0009, §3), as `materialize` sends them. */
const fenceRows = [
  {
    table: "captureStreams",
    json: canonical({
      _id: "synthetic_stream",
      _creationTime: 124,
      organizationId: "synthetic_org",
      checkpoint: "000000000000042",
      state: "active",
      version: 3,
    }),
  },
  {
    table: "dpsSequences",
    json: canonical({
      _id: "synthetic_sequence",
      _creationTime: 125,
      organizationId: "synthetic_org",
      series: "900",
      last: 17,
    }),
  },
];
function fixture(fence = false) {
  const metadata = {
    _id: "synthetic_storage",
    _creationTime: 123,
    contentType: "application/xml",
    size: original.length,
    sha256: createHash("sha256").update(original).digest("base64"),
  };
  const json = canonical({
    _id: "synthetic_artifact",
    _creationTime: 123,
    organizationId: "synthetic_org",
    storageId: metadata._id,
    result: "registro original ç",
  });
  const rows = [{ table: "documentArtifacts", json }, ...(fence ? fenceRows : [])].map((row) => ({
    kind: "row",
    table: row.table,
    originalId: JSON.parse(row.json)._id as string,
    sha256: sha256(row.json),
    json: row.json,
  }));
  const run = {
    _id: "synthetic_run",
    organizationId: "synthetic_org",
    version: 1,
    state: "frozen",
    reason: "closed",
    phase: 0,
    cursor: null,
    rows: rows.length,
    files: 1,
    bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row.json), 0),
    retainUntil: Date.UTC(2032, 0, 1),
    digest: rows.reduce(
      (digest, row) => sha256(`${digest}\n${row.table}\n${row.originalId}\n${row.sha256}`),
      "",
    ),
    manifest: "",
    manifestSha256: "",
  };
  const items = [
    ...rows,
    {
      kind: "file",
      originalId: metadata._id,
      sha256: sha256(canonical(metadata)),
      metadata: canonical(metadata),
      url: "https://synthetic.invalid/original",
    },
  ];
  const calls: string[] = [];
  const source = {
    async query(path: string) {
      if (path === "_system/frontend/getTableMapping")
        return JSON.stringify({
          1: "documentArtifacts",
          2: "organizations",
          3: "_storage",
          4: "captureStreams",
          5: "dpsSequences",
        });
      if (path.endsWith(":inspect")) return JSON.stringify(run);
      return JSON.stringify({ page: items, isDone: true, continueCursor: "done" });
    },
    async mutation(path: string, args: Record<string, unknown>) {
      calls.push(path);
      if (path.endsWith(":scan")) return JSON.stringify({ done: true, phase: 1, cursor: null });
      if (path.endsWith(":seal")) {
        run.manifest = String(args.manifest);
        run.manifestSha256 = sha256(run.manifest);
        run.state = "sealed";
      }
      return null;
    },
  };
  const objects = new Map<string, Buffer>();
  const store = {
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async putFile(key: string, path: string) {
      if (objects.has(key)) return false;
      objects.set(key, await readFile(path));
      return true;
    },
    async putImmutable(key: string, bytes: Buffer) {
      if (objects.has(key)) return false;
      objects.set(key, bytes);
      return true;
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing");
      return bytes;
    },
    async getFile(key: string, path: string) {
      await writeFile(path, await this.get(key), { flag: "wx" });
      return fileDigest(path);
    },
    async verifyFile(key: string, expected: { sha256: string; bytes: number }) {
      const bytes = await this.get(key);
      if (sha256(bytes) !== expected.sha256 || bytes.length !== expected.bytes)
        throw new Error("corrupt");
    },
  };
  return { source, run, items, metadata, calls, store, objects };
}
function custody(dir: string) {
  const age = process.env.AGE_BIN || "age",
    keygen = process.env.AGE_KEYGEN_BIN || "age-keygen";
  const identities = [join(dir, "one.key"), join(dir, "two.key")];
  const exec = (bin: string, args: string[]) =>
    execFileSync(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  for (const id of identities) exec(keygen, ["-o", id]);
  const recipients = identities.map((id) => exec(keygen, ["-y", id]).trim());
  return {
    recipients,
    encrypt: async (from: string, to: string) => {
      exec(age, ["-e", ...recipients.flatMap((r) => ["-r", r]), "-o", to, from]);
    },
    decrypt: async (from: string, to: string) => {
      exec(age, ["-d", "-i", identities[0]!, "-o", to, from]);
    },
  };
}
it("covers every fiscal storage reference and separates the Grande file and DB limits", () => {
  const fields: Record<string, string[]> = {};
  for (const { table, path, target } of archiveReferences(schema))
    if (
      target === "_storage" &&
      retentionClass[table as keyof typeof retentionClass] === "fiscal" &&
      ARCHIVE_TABLES.includes(table as (typeof ARCHIVE_TABLES)[number])
    )
      (fields[table] ??= []).push(path);
  expect(fields).toEqual(ARCHIVE_STORAGE_FIELDS);
  expect(FILE_LIMIT).toBe(2 * 1024 ** 3);
  expect(DATABASE_LIMIT).toBe(256 * 1024 ** 2);
});
it("records the fiscal schema version and still accepts packages sealed before it existed", () => {
  expect(ARCHIVE_SCHEMA_VERSION).toBe(CORE_SCHEMA_VERSION);
  const old = {
    format: "fnfe-cold-archive/1",
    runId: "synthetic_run",
    organizationId: "synthetic_org",
    version: 1,
    rows: 3,
    files: 1,
    databaseBytes: 300,
    fileBytes: 28,
    digest: "a".repeat(64),
    retainUntil: 1,
    prefix: "synthetic/cold/",
    objectKey: "synthetic/cold/synthetic_run/archive.zip.age",
    plaintextSha256: "b".repeat(64),
    plaintextBytes: 10,
    ciphertextSha256: "c".repeat(64),
    ciphertextBytes: 20,
    recipientSetSha256: "d".repeat(64),
  };
  // An older package: no field, version 1, and the object (so its hash) is left as it was.
  const body = canonical(old);
  expect(validateManifest(old)).toBe(old);
  expect(canonical(old)).toBe(body);
  expect(manifestSchemaVersion(old)).toBe(1);
  expect(manifestSchemaVersion({ ...old, schemaVersion: ARCHIVE_SCHEMA_VERSION })).toBe(
    ARCHIVE_SCHEMA_VERSION,
  );
  expect(validateManifest({ ...old, schemaVersion: ARCHIVE_SCHEMA_VERSION })).toBeTruthy();
  // A package from a newer executor, or a malformed version, is refused before anything is read.
  for (const schemaVersion of [ARCHIVE_SCHEMA_VERSION + 1, 0, 1.5, "1"])
    expect(() => validateManifest({ ...old, schemaVersion })).toThrow(/schema fiscal/);
});
it("refuses a nonisolated rehearsal and any missing retention setup", () => {
  const plan = {
    sourceUrl: "http://127.0.0.1:3250",
    destinationUrl: "http://127.0.0.1:3260",
    destinationIsDisposable: true,
    retentionConfigured: true,
    prefix: "synthetic/cold/",
    recipients: ["one", "two"],
  };
  expect(validateTargets(plan)).toEqual(plan);
  expect(() => validateTargets({ ...plan, destinationUrl: plan.sourceUrl })).toThrow();
  expect(() =>
    validateTargets({ ...plan, destinationUrl: "https://remote.convex.cloud" }),
  ).toThrow();
  expect(() => validateTargets({ ...plan, retentionConfigured: false })).toThrow();
});
it.runIf(hasAge)(
  "encrypts a real XML fixture, downloads, decrypts and compares DB/metadata/bytes after restore",
  async () => {
    const f = fixture(),
      dir = scratch(),
      keys = custody(dir);
    const archive = await createArchive({
      source: f.source,
      runId: f.run._id,
      directory: join(dir, "package"),
      download: async (_item: unknown, path: string) => writeFile(path, original),
    });
    const manifest = await publishArchive({
      source: f.source,
      store: f.store,
      archive,
      directory: dir,
      prefix: "synthetic/cold/",
      recipients: keys.recipients,
      encrypt: keys.encrypt,
    });
    expect(f.calls).not.toContain("coldArchive:verified");
    let imported = false;
    const result = await verifyArchive({
      source: f.source,
      store: f.store,
      manifest,
      directory: join(dir, "proof"),
      decrypt: keys.decrypt,
      verifierRunId: "synthetic-proof-001",
      restoreAndExport: async (zip: string) => {
        const entries = await extractZip(zip, join(dir, "isolated-store"), 1e7);
        expect(await readFile(entries.get("_storage/synthetic_storage")!)).toEqual(original);
        const metadata = JSON.parse(
          await readFile(entries.get("_storage/documents.jsonl")!, "utf8"),
        );
        expect(metadata).toEqual(f.metadata);
        // Real Convex export adds this internal locator; it is not preserved storage metadata.
        await writeFile(
          entries.get("_storage/documents.jsonl")!,
          JSON.stringify({ ...metadata, internalId: "synthetic-export-locator" }) + "\n",
        );
        const rows = JSON.parse(
          await readFile(entries.get("documentArtifacts/documents.jsonl")!, "utf8"),
        );
        expect(rows._id).toBe("synthetic_artifact");
        imported = true;
        const output = join(dir, "isolated-reexport.zip");
        await writeZip(entries, output, 1e7);
        return output;
      },
    });
    expect(imported).toBe(true);
    expect(result.verifiedFiles).toBe(1);
    expect(f.calls.at(-1)).toBe("coldArchive:verified");
    const reference = { body: canonical(manifest), sha256: sha256(canonical(manifest)) };
    await verifyColdArchives(f.store, [reference]);
    const catalogue = join(dir, "catalogue");
    await writeFile(catalogue, JSON.stringify({ ...f.run, state: "archived" }) + "\n");
    expect(
      await coldArchiveReferences(new Map([["coldArchiveRuns/documents.jsonl", catalogue]])),
    ).toEqual([reference]);
    f.objects.delete(manifest.objectKey);
    await expect(verifyColdArchives(f.store, [reference])).rejects.toThrow("missing");
  },
);
it.runIf(hasAge).each(["complete", "missing"])(
  "packs the numbering and capture fence and proves it in the isolated restore (%s)",
  async (restore) => {
    const f = fixture(true),
      dir = scratch(),
      keys = custody(dir);
    const archive = await createArchive({
      source: f.source,
      runId: f.run._id,
      directory: join(dir, "package"),
      download: async (_item: unknown, path: string) => writeFile(path, original),
    });
    expect(archive).toMatchObject({ rows: 3, digest: f.run.digest });
    const manifest = await publishArchive({
      source: f.source,
      store: f.store,
      archive,
      directory: dir,
      prefix: "synthetic/cold/",
      recipients: keys.recipients,
      encrypt: keys.encrypt,
    });
    expect(manifest.rows).toBe(3);
    expect(manifest.schemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
    const proof = verifyArchive({
      source: f.source,
      store: f.store,
      manifest,
      directory: join(dir, "proof"),
      decrypt: keys.decrypt,
      verifierRunId: "synthetic-proof-001",
      restoreAndExport: async (zip: string) => {
        const entries = await extractZip(zip, join(dir, "isolated-store"), 1e7);
        // The fence goes into the package whole, with its original IDs, like any fiscal row.
        for (const row of fenceRows) {
          const path = entries.get(`${row.table}/documents.jsonl`)!;
          expect(await readFile(path, "utf8")).toBe(row.json + "\n");
          if (restore === "missing") await writeFile(path, "");
        }
        const output = join(dir, "isolated-reexport.zip");
        await writeZip(entries, output, 1e7);
        return output;
      },
    });
    if (restore === "complete") {
      await proof;
      expect(f.calls.at(-1)).toBe("coldArchive:verified");
    } else {
      await expect(proof).rejects.toThrow("Registros ausentes");
      expect(f.calls).not.toContain("coldArchive:verified");
    }
  },
);
it.runIf(hasAge).each(["cipher", "row", "bytes", "metadata"])(
  "never acknowledges proof with corrupt %s",
  async (corruption) => {
    const f = fixture(),
      dir = scratch(),
      keys = custody(dir);
    const archive = await createArchive({
      source: f.source,
      runId: f.run._id,
      directory: join(dir, "package"),
      download: async (_item: unknown, path: string) => writeFile(path, original),
    });
    const manifest = await publishArchive({
      source: f.source,
      store: f.store,
      archive,
      directory: dir,
      prefix: "synthetic/cold/",
      recipients: keys.recipients,
      encrypt: keys.encrypt,
    });
    if (corruption === "cipher") f.objects.set(manifest.objectKey, Buffer.from("corrupt"));
    await expect(
      verifyArchive({
        source: f.source,
        store: f.store,
        manifest,
        directory: join(dir, "proof"),
        decrypt: keys.decrypt,
        verifierRunId: "synthetic-proof-001",
        restoreAndExport: async (zip: string) => {
          const entries = await extractZip(zip, join(dir, "bad-restore"), 1e7);
          const name =
            corruption === "bytes"
              ? "_storage/synthetic_storage"
              : corruption === "metadata"
                ? "_storage/documents.jsonl"
                : "documentArtifacts/documents.jsonl";
          await writeFile(
            entries.get(name)!,
            corruption === "bytes" ? "wrong" : '{"_id":"wrong"}\n',
          );
          const output = join(dir, "bad.zip");
          await writeZip(entries, output, 1e7);
          return output;
        },
      }),
    ).rejects.toThrow();
    expect(f.calls).not.toContain("coldArchive:verified");
  },
);
it("fails closed while cold movement is incomplete or its manifest is missing", async () => {
  const dir = scratch(),
    path = join(dir, "catalogue");
  for (const state of ["deleting", "restoring", "archived"]) {
    writeFileSync(path, JSON.stringify({ state }) + "\n");
    await expect(
      coldArchiveReferences(new Map([["coldArchiveRuns/documents.jsonl", path]])),
    ).rejects.toThrow();
  }
});

it("resumes a partial append using only absent IDs and keeps storage metadata paired with bytes", async () => {
  const f = fixture(),
    dir = scratch();
  const archive = await createArchive({
    source: f.source,
    runId: f.run._id,
    directory: join(dir, "package"),
    download: async (_item: unknown, path: string) => writeFile(path, original),
  });
  const deltaSource = {
    query: async () =>
      JSON.stringify({ missing: [f.metadata._id], isDone: true, continueCursor: "done" }),
  };
  const delta = await buildRestoreDelta({
    source: deltaSource,
    manifest: { runId: f.run._id, version: 1 },
    zip: archive.zip,
    directory: join(dir, "delta"),
  });
  const entries = await extractZip(delta, join(dir, "check"), 1e7);
  expect(await readFile(entries.get("documentArtifacts/documents.jsonl")!, "utf8")).toBe("");
  expect(JSON.parse(await readFile(entries.get("_storage/documents.jsonl")!, "utf8"))).toEqual(
    f.metadata,
  );
  expect(await readFile(entries.get("_storage/synthetic_storage")!)).toEqual(original);
  expect(
    await buildRestoreDelta({
      source: { query: async () => JSON.stringify({ missing: [], isDone: true }) },
      manifest: { runId: f.run._id, version: 1 },
      zip: archive.zip,
      directory: join(dir, "complete"),
    }),
  ).toBeNull();
});

it.each(["cronsOff", "fiscalDisabled", "captureDisabled"])(
  "refuses destructive rehearsal when %s is false",
  async (flag) => {
    const config = {
      sourceUrl: "http://127.0.0.1:3250",
      destinationUrl: "http://127.0.0.1:3260",
      destinationIsDisposable: true,
      retentionConfigured: true,
      prefix: "synthetic/cold/",
      recipients: ["one", "two"],
    };
    const safety = { cronsOff: true, fiscalDisabled: true, captureDisabled: true, [flag]: false };
    await expect(
      assertRestoreDestination(config, { query: async () => JSON.stringify(safety) }),
    ).rejects.toThrow("desativados");
    await expect(
      assertRestoreDestination(
        { ...config, destinationUrl: config.sourceUrl },
        {
          query: async () =>
            JSON.stringify({ cronsOff: true, fiscalDisabled: true, captureDisabled: true }),
        },
      ),
    ).rejects.toThrow("distintos");
  },
);
it("canonicalizes export order and internal blob locator while preserving original metadata checks", async () => {
  const dir = scratch(),
    f = fixture(),
    tables = join(dir, "tables"),
    storage = join(dir, "storage");
  await writeFile(tables, '{"id":1,"name":"documentArtifacts"}\n');
  await writeFile(storage, JSON.stringify(f.metadata) + "\n");
  const entries = new Map([
    ["_tables/documents.jsonl", tables],
    ["_storage/documents.jsonl", storage],
  ]);
  const before = await diskSummary(entries, { verifyStorage: false });
  await writeFile(
    storage,
    JSON.stringify({
      internalId: "synthetic-locator",
      ...Object.fromEntries(Object.entries(f.metadata).reverse()),
    }) + "\n",
  );
  expect((await diskSummary(entries, { verifyStorage: false })).digests).toEqual(before.digests);
  await writeFile(
    storage,
    JSON.stringify({ ...f.metadata, contentType: "text/plain", internalId: "synthetic-locator" }) +
      "\n",
  );
  expect((await diskSummary(entries, { verifyStorage: false })).digests).not.toEqual(
    before.digests,
  );
});

it("refuses to rehydrate a closed run, or one outside archived and restoring, before reading R2", async () => {
  const f = fixture();
  const attempt = () =>
    rehydrate({
      source: f.source,
      store: f.store,
      runId: f.run._id,
      packageManifest: {},
      directory: scratch(),
      decrypt: async () => {
        throw new Error("never decrypts");
      },
      upload: async () => {
        throw new Error("never uploads");
      },
    });
  // A closed organization is recovered in isolation only (ADR 0009, §7); it never reopens.
  f.run.state = "archived";
  await expect(attempt()).rejects.toThrow("ARCHIVE_CLOSED_NOT_REACTIVATABLE");
  f.run.reason = "free_inactive";
  f.run.state = "frozen";
  await expect(attempt()).rejects.toThrow(/archived ou restoring/);
  expect(f.calls).toEqual([]);
  expect(f.objects.size).toBe(0);
});
it("restores in isolation closed and open runs alike, only with a sealed package and never once hot", async () => {
  const f = fixture();
  let imported = 0;
  const attempt = () =>
    restoreIsolated({
      source: f.source,
      store: f.store,
      runId: f.run._id,
      directory: scratch(),
      decrypt: async () => {
        throw new Error("never decrypts");
      },
      restoreAndExport: async () => {
        imported++;
        throw new Error("never imports");
      },
    });
  // Without a sealed package there is nothing to restore, and the restore never makes one: the
  // archiving (`scan`, `seal`) belongs to `archive`.
  for (const reason of ["closed", "free_inactive", "paid_expired"])
    for (const state of ["notice", "frozen"]) {
      f.run.reason = reason;
      f.run.state = state;
      await expect(attempt()).rejects.toThrow("ARCHIVE_NOT_SEALED");
    }
  // An open organization rehydrated is hot again: its data has the normal export.
  f.run.reason = "free_inactive";
  f.run.state = "hot";
  f.run.manifest = "{}";
  f.run.manifestSha256 = "0".repeat(64);
  await expect(attempt()).rejects.toThrow("ARCHIVE_ORGANIZATION_HOT");
  expect(f.calls).toEqual([]);
  expect(f.objects.size).toBe(0);
  expect(imported).toBe(0);
  // Every state from the seal to the end of the custody passes the guard, open or closed.
  for (const reason of ["closed", "free_inactive", "paid_expired"])
    for (const state of ISOLATED_RESTORE_STATES)
      expect(assertIsolatedRestore({ ...f.run, reason, state })).toMatchObject({ state });
  expect(ISOLATED_RESTORE_STATES).toEqual([
    "sealed",
    "verified",
    "deleting",
    "archived",
    "restoring",
  ]);
});
it("a partial hot removal failure preserves the independent immutable recovery store", async () => {
  const f = fixture();
  const archive = Buffer.from("synthetic encrypted complete package");
  f.objects.set("synthetic/cold/package.age", archive);
  let batches = 0;
  const source = {
    ...f.source,
    mutation: async () => {
      batches++;
      throw new Error("SIMULATED_INTERRUPTION_AFTER_PRIOR_BATCH");
    },
  };
  await expect(removeHot(source, { runId: f.run._id, version: 1 })).rejects.toThrow(
    "SIMULATED_INTERRUPTION",
  );
  expect(batches).toBe(1);
  expect(await f.store.get("synthetic/cold/package.age")).toEqual(archive);
});

type Entry = {
  _id: string;
  _creationTime: number;
  runId: string;
  organizationId: string;
  kind: string;
  table: string;
  originalId: string;
  sha256: string;
  bytes: number;
  metadata?: string;
  snapshot?: string;
  removed: boolean;
};
type Catalog = { state: string; manifestSha256: string; entries: number; removed: number };
/**
 * An `archived` run whose package is sealed in the fake R2, with its hot catalogue as the server
 * keeps it (fence snapshots included), and a source that mirrors the compaction functions: entries
 * in pages of two, refused once compacting, deleted two by two after `catalogVerified`.
 */
async function archivedRun(dir: string, keys: ReturnType<typeof custody>) {
  const f = fixture(true);
  const archive = await createArchive({
    source: f.source,
    runId: f.run._id,
    directory: join(dir, "package"),
    download: async (_item: unknown, path: string) => writeFile(path, original),
  });
  const packageManifest = await publishArchive({
    source: f.source,
    store: f.store,
    archive,
    directory: dir,
    prefix: "synthetic/cold/",
    recipients: keys.recipients,
    encrypt: keys.encrypt,
  });
  const run = Object.assign(f.run, { state: "archived" }) as typeof f.run & { catalog?: Catalog };
  const db: Entry[] = f.items.map((raw, i) => {
    const item = raw as { kind: string; table?: string; json?: string; metadata?: string };
    return {
      _id: `synthetic_entry_${i}`,
      _creationTime: 200 + i,
      runId: run._id,
      organizationId: run.organizationId,
      kind: item.kind,
      table: item.table ?? "_storage",
      originalId: raw.originalId,
      sha256: raw.sha256,
      bytes: item.json ? Buffer.byteLength(item.json) : f.metadata.size,
      ...(item.metadata ? { metadata: item.metadata } : {}),
      ...(item.table && item.table !== "documentArtifacts" ? { snapshot: item.json } : {}),
      removed: true,
    };
  });
  const hot = db.length;
  const calls: string[] = [];
  const control = { interruptAfter: Infinity, batches: 0 };
  const source = {
    async query(path: string, args: { cursor?: string | null }) {
      if (path.endsWith(":inspect")) return JSON.stringify(run);
      if (!path.endsWith(":entries")) throw new Error(path);
      if (run.catalog && run.catalog.state !== "verified")
        throw new Error("ARCHIVE_CATALOG_COMPACTED");
      const start = Number(args.cursor ?? 0);
      return JSON.stringify({
        page: db.slice(start, start + 2),
        isDone: start + 2 >= db.length,
        continueCursor: String(start + 2),
      });
    },
    async mutation(path: string, args: Record<string, unknown>) {
      calls.push(path);
      if (path.endsWith(":catalogVerified")) {
        run.catalog = {
          state: "verified",
          manifestSha256: sha256(String(args.manifest)),
          entries: db.length,
          removed: 0,
        };
        return null;
      }
      if (!path.endsWith(":compactCatalogBatch")) throw new Error(path);
      if (++control.batches > control.interruptAfter) throw new Error("SIMULATED_INTERRUPTION");
      if (!run.catalog) throw new Error("ARCHIVE_CATALOG_UNVERIFIED");
      run.catalog.removed += db.splice(0, 2).length;
      run.catalog.state = db.length ? "compacting" : "compacted";
      return !db.length;
    },
  };
  const compact = (directory: string) =>
    compactCatalog({
      source,
      store: f.store,
      runId: run._id,
      packageManifest,
      directory,
      recipients: keys.recipients,
      encrypt: keys.encrypt,
      decrypt: keys.decrypt,
    });
  return { f, run, db, hot, calls, control, source, packageManifest, compact };
}
it.runIf(hasAge)(
  "compacts the catalogue into an age object with its own manifest, deleting entries only after the comparison and resuming in batches",
  async () => {
    const dir = scratch(),
      keys = custody(dir),
      a = await archivedRun(dir, keys);
    const sealedPackage = a.f.run.manifest;
    a.control.interruptAfter = 1;
    await expect(a.compact(join(dir, "first"))).rejects.toThrow("SIMULATED_INTERRUPTION");
    // Recorded as verified before the first deletion; the interruption left part of it hot.
    expect(a.calls.indexOf("coldArchive:catalogVerified")).toBeLessThan(
      a.calls.indexOf("coldArchive:compactCatalogBatch"),
    );
    expect(a.run.catalog).toMatchObject({ state: "compacting", removed: 2 });
    expect(a.db).toHaveLength(a.hot - 2);
    a.control.interruptAfter = Infinity;
    const manifest = await a.compact(join(dir, "resume"));
    expect(a.db).toEqual([]);
    expect(a.run.catalog).toMatchObject({ state: "compacted", removed: a.hot, entries: a.hot });
    // The resumption never published nor recorded again.
    expect(a.calls.filter((c) => c === "coldArchive:catalogVerified")).toHaveLength(1);
    // Object and immutable manifest next to the package; the sealed package manifest is unchanged.
    const objectKeys = catalogKeys("synthetic/cold/", a.run._id);
    const body = (await a.f.store.get(objectKeys.manifest)).toString("utf8");
    expect(sha256(body)).toBe(a.run.catalog?.manifestSha256);
    expect(validateCatalogManifest(JSON.parse(body))).toMatchObject({
      runId: a.run._id,
      entries: 4,
      rows: 3,
      files: 1,
      objectKey: objectKeys.object,
      packageManifestSha256: sha256(sealedPackage),
      recipientSetSha256: a.packageManifest.recipientSetSha256,
      retainUntil: a.run.retainUntil,
    });
    expect(manifest.ciphertextSha256).toBe(sha256(await a.f.store.get(objectKeys.object)));
    expect(a.f.run.manifest).toBe(sealedPackage);
    // Both custodians read the same canonical lines: IDs, hashes, metadata and fence snapshots.
    const cipher = join(dir, "check.age"),
      plain = join(dir, "check.jsonl");
    await writeFile(cipher, await a.f.store.get(objectKeys.object));
    await keys.decrypt(cipher, plain);
    const lines = (await readFile(plain, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.originalId)).toEqual(a.f.items.map((i) => i.originalId));
    expect(lines.filter((l) => l.snapshot)).toHaveLength(2);
    expect(lines.find((l) => l.kind === "file")?.metadata).toBe(canonical(a.f.metadata));
    for (const line of lines) expect(line).not.toHaveProperty("removed");
    // Compacted is final: repeating does nothing.
    await a.compact(join(dir, "again"));
    expect(a.calls.at(-1)).toBe("coldArchive:compactCatalogBatch");
  },
);
/**
 * The server side of the rehydration as the executor sees it, in memory: offsets and stages kept
 * on the run, `rows` and `check` fenced by offset, uploads through intents. Records what arrived.
 */
function rehydrationServer(a: Awaited<ReturnType<typeof archivedRun>>) {
  type Progress = { stage: string; files: number; rows: number; checked: number };
  const run = a.run as typeof a.run & { rehydration?: Progress };
  const received = {
    admission: null as null | Record<string, unknown>,
    uploads: [] as { bytes: Buffer; contentType?: string }[],
    rows: [] as { table: string; json: string }[],
    checks: [] as Record<string, unknown>[],
    lost: 0,
  };
  const control = { loseRows: false };
  const uploaded = new Map<string, string>();
  const original = a.source;
  const source = {
    query: (path: string, args: { cursor?: string | null }) =>
      // The cold tier is off here: everything comes back hot, as before ADR 0010, C2.
      path === "coldArchiveRehydration:coldPolicy"
        ? Promise.resolve({ enabled: false, reason: "disabled" })
        : original.query(path, args),
    async mutation(path: string, args: Record<string, unknown>) {
      const progress = run.rehydration;
      switch (path) {
        case "coldArchiveRehydration:begin":
          received.admission = args;
          run.state = "restoring";
          run.rehydration = { stage: "files", files: 0, rows: 0, checked: 0 };
          return null;
        case "coldArchiveRehydration:beginUpload": {
          const id = (args.metadata as { _id: string })._id;
          return uploaded.has(id)
            ? { storageId: uploaded.get(id) }
            : { attempt: 1, uploadUrl: "https://synthetic.invalid/upload" };
        }
        case "coldArchiveRehydration:recordUpload":
          uploaded.set(String(args.previousId), String(args.storageId));
          progress!.files++;
          if (progress!.files === run.files) progress!.stage = "rows";
          return { ok: true };
        case "coldArchiveRehydration:rows": {
          const rows = args.rows as { table: string; json: string }[];
          if (args.offset !== progress!.rows) throw new Error("ARCHIVE_REHYDRATE_FENCE");
          received.rows.push(...rows);
          progress!.rows += rows.length;
          if (progress!.rows === run.rows) progress!.stage = "references";
          if (control.loseRows) {
            control.loseRows = false;
            received.lost++;
            throw new Error("SIMULATED_LOST_RESPONSE");
          }
          return { rows: progress!.rows };
        }
        case "coldArchiveRehydration:references":
          progress!.stage = "check";
          return { stage: "check", phase: 0 };
        case "coldArchiveRehydration:check": {
          if (args.offset !== progress!.checked) throw new Error("ARCHIVE_REHYDRATE_FENCE");
          const entries = args.entries as Record<string, unknown>[];
          received.checks.push(...entries);
          progress!.checked += entries.length;
          if (progress!.checked === run.rows + run.files) progress!.stage = "checked";
          return { checked: progress!.checked };
        }
        case "coldArchiveRehydration:finish":
          if (progress?.stage !== "checked") throw new Error("ARCHIVE_CHECK_INCOMPLETE");
          run.state = "hot";
          return null;
        case "coldArchiveRehydration:collectUploadOrphans":
          return { deleted: 0, pending: 0, isDone: true, continueCursor: "" };
        default:
          return original.mutation(path, args);
      }
    },
  };
  return { source, received, control, run };
}
it.runIf(hasAge)(
  "rehydrates from the decrypted package and catalogue: files, rows in catalogue order, the check",
  async () => {
    const dir = scratch(),
      keys = custody(dir),
      a = await archivedRun(dir, keys);
    a.run.reason = "free_inactive";
    await a.compact(join(dir, "compact"));
    const server = rehydrationServer(a);
    server.control.loseRows = true;
    const result = await rehydrate({
      source: server.source,
      store: a.f.store,
      runId: a.run._id,
      packageManifest: a.packageManifest,
      directory: join(dir, "rehydrate"),
      decrypt: keys.decrypt,
      upload: async ({ path, contentType }: { path: string; contentType?: string }) => {
        server.received.uploads.push({ bytes: await readFile(path), contentType });
        return "synthetic_new_storage";
      },
    });
    expect(result).toMatchObject({ rows: 3, files: 1, orphansDeleted: 0, orphansPending: 0 });
    expect(server.run.state).toBe("hot");
    // The admission measured the document rows with the origin pair, and the files by manifest.
    expect(server.received.admission).toMatchObject({ fileBytes: a.packageManifest.fileBytes });
    expect(server.received.admission!.databaseBytes).toBeGreaterThan(0);
    // The original's bytes and content type, once.
    expect(server.received.uploads).toEqual([{ bytes: original, contentType: "application/xml" }]);
    // Every row once, fence included, in catalogue order, even after a lost response.
    expect(server.received.lost).toBe(1);
    const rows = a.f.items.filter((item) => item.kind === "row") as {
      table: string;
      json: string;
    }[];
    expect(server.received.rows).toEqual(rows.map(({ table, json }) => ({ table, json })));
    // The check covers every catalogue entry, in order, with the catalogue's hashes.
    expect(server.received.checks).toEqual(
      a.f.items.map((item) => ({
        kind: item.kind,
        table: (item as { table?: string }).table ?? "_storage",
        originalId: item.originalId,
        sha256: item.sha256,
      })),
    );
  },
);
it.runIf(hasAge)("never overwrites a catalogue object or manifest already in R2", async () => {
  const dir = scratch(),
    keys = custody(dir),
    a = await archivedRun(dir, keys);
  const objectKeys = catalogKeys("synthetic/cold/", a.run._id);
  const foreign = join(dir, "foreign.jsonl"),
    foreignCipher = join(dir, "foreign.age");
  await writeFile(foreign, '{"originalId":"other"}\n');
  await keys.encrypt(foreign, foreignCipher);
  a.f.objects.set(objectKeys.object, await readFile(foreignCipher));
  const before = a.f.objects.get(objectKeys.object);
  await expect(a.compact(join(dir, "orphan"))).rejects.toThrow("revisão administrativa");
  expect(a.f.objects.get(objectKeys.object)).toBe(before);
  expect(a.f.objects.has(objectKeys.manifest)).toBe(false);
  // A manifest of another catalogue is never replaced either.
  a.f.objects.delete(objectKeys.object);
  a.f.objects.set(objectKeys.manifest, Buffer.from("{}"));
  await expect(a.compact(join(dir, "manifest"))).rejects.toThrow();
  expect(a.f.objects.get(objectKeys.manifest)?.toString()).toBe("{}");
  expect(a.calls).toEqual([]);
  expect(a.db).toHaveLength(a.hot);
});
it.runIf(hasAge)(
  "resumes a catalogue whose cipher went up without its manifest only when it is the same catalogue",
  async () => {
    const dir = scratch(),
      keys = custody(dir),
      a = await archivedRun(dir, keys);
    const objectKeys = catalogKeys("synthetic/cold/", a.run._id);
    const first = await publishCatalog({
      source: a.source,
      store: a.f.store,
      run: a.run,
      packageManifest: a.packageManifest,
      directory: join(dir, "lost"),
      recipients: keys.recipients,
      encrypt: keys.encrypt,
      decrypt: keys.decrypt,
    });
    // The manifest write was lost; the cipher stays and is reused, never rewritten.
    a.f.objects.delete(objectKeys.manifest);
    const cipher = a.f.objects.get(objectKeys.object);
    await a.compact(join(dir, "retry"));
    expect(a.f.objects.get(objectKeys.object)).toBe(cipher);
    expect(sha256((await a.f.store.get(objectKeys.manifest)).toString("utf8"))).toBe(
      sha256(canonical(first)),
    );
    expect(a.run.catalog?.state).toBe("compacted");
  },
);
it.runIf(hasAge).each(["cipher", "missing", "short", "tampered", "metadata"])(
  "never records nor deletes the hot catalogue when the comparison finds a %s catalogue",
  async (corruption) => {
    const dir = scratch(),
      keys = custody(dir),
      a = await archivedRun(dir, keys);
    const objectKeys = catalogKeys("synthetic/cold/", a.run._id);
    const putImmutable = a.f.store.putImmutable.bind(a.f.store);
    // Strikes after publication, between the upload and the download of the comparison.
    a.f.store.putImmutable = async (key: string, bytes: Buffer) => {
      const written = await putImmutable(key, bytes);
      if (key !== objectKeys.manifest) return written;
      if (corruption === "cipher") a.f.objects.set(objectKeys.object, Buffer.from("corrupt"));
      if (corruption === "missing") a.f.objects.delete(objectKeys.object);
      // The DB has an entry the object lacks: the object is short of the hot catalogue.
      if (corruption === "short") a.db.push({ ...a.db[0]!, _id: "late", originalId: "late" });
      if (corruption === "tampered") a.db[0]!.sha256 = "0".repeat(64);
      if (corruption === "metadata") a.db.at(-1)!.metadata = "{}";
      return written;
    };
    await expect(a.compact(join(dir, "proof"))).rejects.toThrow();
    expect(a.calls).toEqual([]);
    expect(a.run.catalog).toBeUndefined();
    expect(a.db.length).toBeGreaterThanOrEqual(a.hot);
  },
);
it.runIf(hasAge).each(["compacted", "absent", "wrong", "foreign"])(
  "restores a compacted run in isolation from its decrypted catalogue (%s)",
  async (variant) => {
    const dir = scratch(),
      keys = custody(dir),
      a = await archivedRun(dir, keys);
    await a.compact(join(dir, "compact"));
    const objectKeys = catalogKeys("synthetic/cold/", a.run._id);
    if (variant === "absent") a.f.objects.delete(objectKeys.manifest);
    if (variant === "wrong") a.run.catalog!.manifestSha256 = "0".repeat(64);
    const load = loadCatalog({
      store: a.f.store,
      run: a.run,
      packageManifest: a.packageManifest,
      directory: join(dir, "catalog"),
      decrypt: keys.decrypt,
    });
    if (variant === "absent" || variant === "wrong") {
      await expect(load).rejects.toThrow();
      return;
    }
    const catalog = await load;
    expect(catalog.size).toBe(a.hot);
    // A catalogue that does not vouch for the package stops before any import.
    if (variant === "foreign")
      catalog.set("synthetic_artifact", {
        ...catalog.get("synthetic_artifact"),
        sha256: "0".repeat(64),
      });
    let imported = false;
    const proof = verifyArchive({
      source: a.f.source,
      store: a.f.store,
      manifest: a.packageManifest,
      directory: join(dir, "restore"),
      decrypt: keys.decrypt,
      verifierRunId: "synthetic-restore-001",
      recordProof: false,
      catalog,
      restoreAndExport: async (zip: string) => {
        imported = true;
        return zip;
      },
    });
    if (variant === "foreign") {
      await expect(proof).rejects.toThrow("Pacote diverge do catálogo");
      expect(imported).toBe(false);
    } else {
      expect(await proof).toMatchObject({ verifiedRows: 3, verifiedFiles: 1 });
      expect(imported).toBe(true);
    }
    expect(a.f.calls).not.toContain("coldArchive:verified");
  },
);
it.runIf(hasAge).each(["archived", "restoring"])(
  "restores an open organization's compacted run in isolation with real age, read-only (%s)",
  async (state) => {
    const dir = scratch(),
      keys = custody(dir),
      a = await archivedRun(dir, keys);
    await a.compact(join(dir, "compact"));
    a.run.reason = "free_inactive";
    a.run.state = state;
    const calls = [...a.f.calls, ...a.calls];
    const objects = new Map(a.f.objects);
    let imported = 0;
    const restore = (custody?: (manifest: { recipientSetSha256: string }) => void) =>
      restoreIsolated({
        source: a.f.source,
        store: a.f.store,
        runId: a.run._id,
        directory: join(dir, `restore-${imported}`),
        decrypt: keys.decrypt,
        restoreAndExport: async (zip: string) => {
          imported++;
          return zip;
        },
        custody,
      });
    const result = await restore();
    expect(result).toMatchObject({
      state: "restored_isolated",
      reason: "free_inactive",
      runState: state,
      catalog: "compacted",
      rows: 3,
      files: 1,
      rehydratedRows: 0,
      manifestSha256: a.run.manifestSha256,
    });
    // Repeating gives the same result. Nothing was written to the origin nor to R2.
    expect(await restore()).toEqual(result);
    expect(imported).toBe(2);
    expect([...a.f.calls, ...a.calls]).toEqual(calls);
    expect(a.f.objects).toEqual(objects);
    // Custodians other than the package's stop it before any import.
    await expect(
      restore(() => {
        throw new Error("Custódia diverge do plano");
      }),
    ).rejects.toThrow("Custódia diverge do plano");
    expect(imported).toBe(2);
  },
);
it.runIf(hasAge)("keeps the compacted catalogue object as a backup dependency", async () => {
  const dir = scratch(),
    keys = custody(dir),
    a = await archivedRun(dir, keys);
  await a.compact(join(dir, "compact"));
  const catalogue = join(dir, "runs");
  await writeFile(catalogue, JSON.stringify(a.run) + "\n");
  const references = await coldArchiveReferences(
    new Map([["coldArchiveRuns/documents.jsonl", catalogue]]),
  );
  expect(references).toEqual([
    {
      body: a.run.manifest,
      sha256: a.run.manifestSha256,
      catalogSha256: a.run.catalog?.manifestSha256,
    },
  ]);
  await verifyColdArchives(a.f.store, references);
  a.f.objects.delete(catalogKeys("synthetic/cold/", a.run._id).object);
  await expect(verifyColdArchives(a.f.store, references)).rejects.toThrow("missing");
});
/**
 * The operator's side of the assisted export (ADR 0009, §7): origin and destination are fakes that
 * keep the state the real functions keep (`tests/platform.assistedExport.test.ts` covers those).
 */
function assistedFakes({ refuse = "" } = {}) {
  const part = Buffer.from("parte gerada no destino");
  const calls: string[] = [];
  const origin = { sequence: 0, state: "running", exportId: "export_1", attached: [] as string[] };
  let destinationJobs = 0;
  const source = {
    async query() {
      throw new Error("unexpected");
    },
    async mutation(path: string, args: Record<string, unknown>) {
      calls.push(`origin:${path}`);
      if (path === "assistedExport:request") {
        if (refuse) throw new Error(refuse);
        return { requestId: "request_1", environments: args.environments, repeated: false };
      }
      if (path === "assistedExport:prepare") {
        if (args.restart)
          Object.assign(origin, { exportId: "export_2", sequence: 0, attached: [] });
        return {
          exportId: origin.exportId,
          organizationId: "org_1",
          environment: args.environment,
          createdAt: 1,
          expiresAt: 2,
          state: origin.state,
          sequence: origin.sequence,
          companies: [],
        };
      }
      if (path === "assistedExport:uploadUrl") return "https://origin.invalid/upload";
      if (path === "assistedExport:attachPart") {
        expect(args.sequence).toBe(origin.sequence);
        origin.attached.push(String(args.storageId));
        origin.sequence++;
        if (args.done) origin.state = "succeeded";
        return { ok: true };
      }
      throw new Error(path);
    },
  };
  const destination = {
    progress: { state: "running", sequence: 0 },
    async query(path: string) {
      calls.push(`destination:${path}`);
      if (path === "assistedExport:progress") return destination.progress;
      return [0, 1].map((sequence) => ({
        sequence,
        sha256: sha256(part),
        size: part.length,
        url: `http://127.0.0.1:3299/part-${sequence}`,
      }));
    },
    async mutation(path: string) {
      calls.push(`destination:${path}`);
      return { jobId: "job_1", created: destinationJobs++ === 0 };
    },
    async action(path: string, args: { sequence: number }) {
      calls.push(`destination:${path}`);
      destination.progress =
        args.sequence === 1
          ? { state: "succeeded", sequence: 2 }
          : { state: "running", sequence: args.sequence + 1 };
      return null;
    },
  };
  return { part, calls, origin, source, destination };
}
const assistedRequest = {
  key: "ticket-001",
  email: "proprietario@development.invalid",
  basis: "owner",
  environments: ["sandbox"],
};
it("assisted export: the origin refuses the request before anything is restored", async () => {
  const f = assistedFakes({ refuse: "ASSISTED_EXPORT_NOT_OWNER" });
  let restored = false;
  await expect(
    assistedExport({
      source: f.source,
      destination: f.destination,
      runId: "run_1",
      request: assistedRequest,
      restore: async () => {
        restored = true;
      },
      download: async () => f.part,
      upload: async () => "storage_1",
    }),
  ).rejects.toThrow("ASSISTED_EXPORT_NOT_OWNER");
  expect(restored).toBe(false);
  expect(() => validateAssistedRequest({ ...assistedRequest, basis: "rights" })).toThrow();
  expect(() => validateAssistedRequest({ ...assistedRequest, rightsReference: "D02-1" })).toThrow();
});
it("assisted export: generates in the destination, checks each part and publishes it once", async () => {
  const f = assistedFakes();
  const run = (download = async () => f.part) =>
    assistedExport({
      source: f.source,
      destination: f.destination,
      runId: "run_1",
      request: assistedRequest,
      restore: async () => ({ rows: 3, files: 1 }),
      download,
      upload: async () => `storage_${f.origin.attached.length}`,
    });
  // A part that changed on the way stops before the upload.
  await expect(run(async () => Buffer.from("outra"))).rejects.toThrow("Parte divergente");
  expect(f.origin.attached).toEqual([]);
  const result = await run();
  expect(result).toMatchObject({
    state: "published",
    requestId: "request_1",
    exports: [{ environment: "sandbox", exportId: "export_1", parts: 2 }],
  });
  expect(f.origin.attached).toEqual(["storage_0", "storage_1"]);
  // Repeating finds the export already published: nothing is generated nor uploaded again.
  const before = f.calls.length;
  await run();
  expect(f.calls.slice(before).filter((call) => call.startsWith("destination:"))).toEqual([]);
  expect(f.origin.attached).toEqual(["storage_0", "storage_1"]);
});
it("assisted export: a new destination after attached parts restarts the origin's export", async () => {
  const f = assistedFakes();
  // One part was attached by a destination that no longer exists.
  Object.assign(f.origin, { sequence: 1, attached: ["lost"] });
  const result = await assistedExport({
    source: f.source,
    destination: f.destination,
    runId: "run_1",
    request: assistedRequest,
    restore: async () => ({}),
    download: async () => f.part,
    upload: async () => `storage_${f.origin.attached.length}`,
  });
  expect(result.exports[0]).toMatchObject({ exportId: "export_2", parts: 2 });
  expect(f.origin.attached).toEqual(["storage_0", "storage_1"]);
});

it("prints only a bare refusal code when a run stops, never another message", () => {
  expect(
    refusalOf(Object.assign(new Error("x"), { refusal: { code: "ASSISTED_EXPORT_NOT_OWNER" } })),
  ).toEqual({ code: "ASSISTED_EXPORT_NOT_OWNER" });
  let hot;
  try {
    assertIsolatedRestore({ state: "hot" });
  } catch (error) {
    hot = refusalOf(error);
  }
  expect(hot).toEqual({ code: "ARCHIVE_ORGANIZATION_HOT" });
  // The executor's own stops in the cold stage of a rehydration (ADR 0010, C2).
  for (const code of [
    "ARCHIVE_REHYDRATE_COLD_STALLED",
    "ARCHIVE_REHYDRATE_COLD_TIMEOUT",
    "ARCHIVE_REHYDRATE_COLD_PLAN_CHANGED",
    "ARCHIVE_REHYDRATE_COLD_UNKNOWN_FILE",
  ])
    expect(refusalOf(new Error(code))).toEqual({ code });
  for (const message of [
    "Falha no envio do original",
    "ARCHIVE_X: CNPJ 00000000000191",
    "OTHER_CODE",
  ])
    expect(refusalOf(new Error(message))).toBeNull();
});

/**
 * The executor's plan of the rehydration's cold stage (ADR 0010, C2), on package rows: it mirrors
 * the server's rule (`coldTier.notePlan` under the window), so it never defers a file the server
 * would keep hot. The end-to-end proof against the real functions is in
 * `tests/platform.coldArchiveRehydration.test.ts`.
 */
it("plans the cold stage of a rehydration with the server's rule, in batches", async () => {
  const dir = scratch();
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 30, 12);
  const tables: Record<string, Record<string, unknown>[]> = {
    fiscalDocuments: [],
    documentVersions: [],
    documentArtifacts: [],
    importFiles: [],
    captureBatches: [],
    _storage: [],
  };
  const note = (
    id: string,
    options: {
      createdAt?: number;
      environment?: string;
      doc?: Record<string, unknown>;
      version?: Record<string, unknown>;
    } = {},
  ) => {
    const createdAt = options.createdAt ?? now - 200 * day;
    tables.fiscalDocuments!.push({
      _id: id,
      organizationId: "org1",
      environment: options.environment ?? "sandbox",
      createdAt,
      ...options.doc,
    });
    tables.documentArtifacts!.push({
      _id: `${id}a`,
      organizationId: "org1",
      documentId: id,
      fileId: `${id}f`,
      storageId: `${id}x`,
    });
    tables.importFiles!.push({ _id: `${id}f`, storageId: `${id}x` });
    tables.documentVersions!.push({
      _id: `${id}v`,
      documentId: id,
      artifactId: `${id}a`,
      state: "complete",
      publishedAt: createdAt,
      contentStorageId: `${id}b`,
      contentSha256: "a".repeat(64),
      contentSize: 10,
      contentFormat: "document-content/1",
      contentVerifiedAt: createdAt,
      ...options.version,
    });
    tables._storage!.push({ _id: `${id}x`, size: 100 }, { _id: `${id}b`, size: 50 });
  };
  note("n1");
  note("n2", { createdAt: now - 10 * day });
  note("n3", { environment: "production" });
  note("n4", { version: { contentVerifiedAt: undefined } });
  note("n5");
  tables.documentVersions!.push({
    _id: "n5s",
    documentId: "n5",
    artifactId: "n5a",
    state: "staging",
  });
  note("n6");
  tables.captureBatches!.push({ _id: "batch", rawId: "n6x" });
  note("n7", { doc: { direction: "emitted" } });
  note("n8", { doc: { coldState: "cold" } });
  note("n9", { version: { publishedAt: undefined } });
  note("n10", { version: { contentStorageId: undefined, contentSha256: undefined } });
  const entries = new Map<string, string>();
  for (const [table, rows] of Object.entries(tables)) {
    const path = join(dir, `${table}.jsonl`);
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    entries.set(`${table}/documents.jsonl`, path);
  }
  const policy = { enabled: true, cutoff: now - 90 * day, lockedThrough: null };
  // No lock year: the Production note stays hot. The shared original stays hot too; its note
  // still goes, with only its content.
  const plan = await coldRehydrationPlan({ entries, policy });
  expect(plan.notes).toEqual([
    { id: "n1", files: ["n1b", "n1x"], bytes: 150 },
    { id: "n6", files: ["n6b"], bytes: 50 },
  ]);
  expect(plan).toMatchObject({ files: 3, bytes: 200, batchBytes: 200, batches: [["n1", "n6"]] });
  expect(plan.deferred).toEqual(new Set(["n1b", "n1x", "n6b"]));
  // With its guard year locked, it goes as well; a budget of one byte makes one note a batch.
  const year = coldGuardYear({ environment: "production", createdAt: now - 200 * day }, {});
  const locked = await coldRehydrationPlan({
    entries,
    policy: { ...policy, lockedThrough: year },
    batchBytes: 1,
  });
  expect(locked.notes.map((entry: { id: string }) => entry.id)).toEqual(["n1", "n3", "n6"]);
  expect(locked).toMatchObject({ batchBytes: 150, batches: [["n1"], ["n3"], ["n6"]] });
  // Policy off: nothing is deferred, and the admission counts every file.
  const off = await coldRehydrationPlan({ entries, policy: { enabled: false } });
  expect(off).toMatchObject({ files: 0, bytes: 0, batchBytes: 0, batches: [] });
  const measured = await measureAdmission({
    run: { _id: "run", organizationId: "org1" },
    order: [],
    entries: new Map(),
    fileBytes: 1_000,
    cold: plan,
  });
  // The deferred files leave the measure; the rows gain the cold reference of each.
  expect(measured).toEqual({ fileBytes: 800, databaseBytes: 3 * 320 + 2 * 64 });
});

it("keeps the executor's cold plan rules equal to the server's", () => {
  expect(COLD_BATCH_NOTES).toBe(SERVER_COLD_BATCH_NOTES);
  expect(PACKAGE_STORAGE_FIELDS).toEqual(ARCHIVE_STORAGE_FIELDS);
  // The guard year of D01 (`coldTier.guardYearOf`), at the edges of the year in Brasília.
  for (const fact of [
    Date.UTC(2026, 0, 1, 2, 59),
    Date.UTC(2026, 0, 1, 3),
    Date.UTC(2026, 11, 31, 23),
    Date.UTC(2027, 0, 1, 2),
  ]) {
    const expected = new Date(fiscalGuardUntil(fact)).getUTCFullYear() - 1;
    expect(coldGuardYear({ environment: "production", createdAt: fact }, {})).toBe(expected);
    expect(
      coldGuardYear(
        { environment: "production", createdAt: 0 },
        { card: { issuedAt: new Date(fact).toISOString() } },
      ),
    ).toBe(expected);
  }
  expect(coldGuardYear({ environment: "sandbox", createdAt: 0 }, {})).toBeNull();
});

it("repeats a cold-stage call only when its response may have been lost", () => {
  expect(serverRefusal(new Error("Uncaught Error: ARCHIVE_STALE_FENCE"))).toBe(true);
  expect(serverRefusal(new Error("COLD_TIER_ATTACH_REFUSED"))).toBe(true);
  expect(serverRefusal(new Error("QUOTA_EXCEEDED"))).toBe(true);
  expect(serverRefusal(new Error("fetch failed"))).toBe(false);
  expect(serverRefusal(new Error("socket hang up"))).toBe(false);
});
