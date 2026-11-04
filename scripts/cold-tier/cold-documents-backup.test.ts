import { afterEach, describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPlan } from "../lib/offsite-backup.mjs";
import { publishArchive } from "../lib/cold-archive.mjs";
import {
  coldDocumentList,
  coldDocumentListKey,
  coldDocumentReferences,
  coldDocumentsManifest,
  coldReferenceOf,
  parseColdDocumentList,
  restoreIncremental,
  verifyColdArchives,
  verifyColdDocuments,
} from "../lib/incremental-backup.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Entries of an export with one `documentVersions` table, as `extractZip` maps them. */
function entries(rows: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "fnfe-cold-documents-"));
  directories.push(dir);
  const path = join(dir, "documents.jsonl");
  writeFileSync(path, rows.map((row) => JSON.stringify(row) + "\n").join(""));
  return new Map([["documentVersions/documents.jsonl", path]]);
}
const cold = (version: string, bytes = 120) => ({
  _id: version,
  contentObjectKey: `documents/sandbox/org1/${version}/content-${hash(version)}.gz`,
  contentObjectSha256: hash(`gzip-${version}`),
  contentObjectSize: bytes,
  contentSha256: hash(version),
});

describe("cold documents in the format 2 backup (ADR 0010, phase C)", () => {
  it("lists the cold versions only, sorted, and binds them by count and digest", async () => {
    const result = await coldDocumentReferences(
      entries([cold("v2"), { _id: "hot", contentStorageId: "kg2abc" }, cold("v1")]),
    );
    expect(result.count).toBe(2);
    expect(result.references.map((r) => r.key)).toEqual([
      cold("v1").contentObjectKey,
      cold("v2").contentObjectKey,
    ]);
    const again = await coldDocumentReferences(entries([cold("v1"), cold("v2")]));
    expect(again.digest).toBe(result.digest);
    const changed = await coldDocumentReferences(entries([cold("v1"), cold("v2", 121)]));
    expect(changed.digest).not.toBe(result.digest);
    expect(coldDocumentsManifest(result, "fnfe-cold")).toEqual({
      bucket: "fnfe-cold",
      count: 2,
      digest: result.digest,
    });
  });

  it("needs no bucket while nothing is cold, and refuses cold documents without one", async () => {
    const none = await coldDocumentReferences(entries([{ _id: "hot" }]));
    expect(coldDocumentsManifest(none, undefined)).toBeUndefined();
    await verifyColdDocuments(null, none.references);
    const some = await coldDocumentReferences(entries([cold("v1")]));
    expect(() => coldDocumentsManifest(some, undefined)).toThrow("coldTier.bucket");
    await expect(verifyColdDocuments(null, some.references)).rejects.toThrow(
      "acesso de leitura ao bucket frio",
    );
  });

  it("lists the cold originals of decision 8 with the versions", async () => {
    const original = (artifact: string) => ({
      _id: artifact,
      objectKey: `documents/production/guard-2031/org1/${artifact}/original-${hash(artifact)}.gz`,
      objectSha256: hash(`gzip-${artifact}`),
      objectSize: 80,
      sha256: hash(artifact),
    });
    const map = entries([cold("v1")]);
    const dir = mkdtempSync(join(tmpdir(), "fnfe-cold-originals-"));
    directories.push(dir);
    const path = join(dir, "documents.jsonl");
    writeFileSync(
      path,
      [original("a1"), { _id: "hot", storageId: "kg2abc" }]
        .map((row) => JSON.stringify(row) + "\n")
        .join(""),
    );
    map.set("documentArtifacts/documents.jsonl", path);
    const result = await coldDocumentReferences(map);
    expect(result.references.map((r) => r.key)).toEqual([
      original("a1").objectKey,
      cold("v1").contentObjectKey,
    ]);
    // The list read back keeps both kinds.
    expect(parseColdDocumentList(result.body, result)).toEqual(result.references);
    // An original with its storage still set, or a content key on an artifact, is refused.
    expect(() =>
      coldReferenceOf({ ...original("a1"), storageId: "kg2abc" }, "documentArtifacts"),
    ).toThrow("Documento frio sem referência íntegra");
    expect(() =>
      coldReferenceOf(
        { ...original("a1"), objectKey: cold("v1").contentObjectKey },
        "documentArtifacts",
      ),
    ).toThrow("Documento frio sem referência íntegra");
    expect(() => coldReferenceOf({ contentObjectKey: original("a1").objectKey })).toThrow(
      "Documento frio sem referência íntegra",
    );
  });

  it("refuses a partial reference", async () => {
    const { contentObjectSha256: _gone, ...partial } = cold("v1");
    await expect(coldDocumentReferences(entries([partial]))).rejects.toThrow(
      "Documento frio sem referência íntegra",
    );
    await expect(
      coldDocumentReferences(entries([{ ...cold("v1"), contentStorageId: "kg2abc" }])),
    ).rejects.toThrow("Documento frio sem referência íntegra");
  });

  it("checks existence and size on publication, and the hash on recovery", async () => {
    const { references } = await coldDocumentReferences(entries([cold("v1"), cold("v2")]));
    const heads: string[] = [];
    const verified: string[] = [];
    const client = {
      head: async (key: string) => {
        heads.push(key);
        return key.includes("/v2/") ? { size: 99 } : { size: 120 };
      },
      verifyFile: async (key: string, expected: { sha256: string; bytes: number }) => {
        verified.push(key);
        expect(expected.bytes).toBe(120);
      },
    };
    await expect(verifyColdDocuments(client, references)).rejects.toThrow(
      "Documento frio ausente ou alterado",
    );
    await verifyColdDocuments(client, references, { full: true });
    expect(verified).toEqual(references.map((r) => r.key));
    expect(heads.length).toBe(2);
  });

  it("refuses a recovery whose manifest does not cover the cold documents", async () => {
    await expect(
      restoreIncremental({
        manifest: { format: 2, objects: [] },
        entries: entries([cold("v1")]),
        client: {},
        coldStorage: () => null,
        directory: tmpdir(),
        zip: join(tmpdir(), "unused.zip"),
        maxBytes: 1024,
        decrypt: async () => {},
      }),
    ).rejects.toThrow("Backup não cobre os documentos frios");
  });

  it("validates the cold bucket of the plan", () => {
    const raw = {
      version: 1,
      bucket: "fnfe-backups",
      prefix: "deploy-1/",
      cadenceHours: 12,
      alertAfterHours: 13,
      retentionDays: 14,
      rpoHours: 24,
      rtoHours: 24,
      maxSnapshotBytes: 1024,
      recipients: [
        { custodian: "a", recipient: `age1${"q".repeat(58)}` },
        { custodian: "b", recipient: `age1${"p".repeat(58)}` },
      ],
    };
    const release = { deployment: "deploy-1", accountId: "x", site: "s", cloud: "c" };
    expect(backupPlan({ ...raw, coldTier: { bucket: "fnfe-cold" } }, release).coldTier).toEqual({
      bucket: "fnfe-cold",
    });
    expect(() => backupPlan({ ...raw, coldTier: { bucket: "X" } }, release)).toThrow(
      "bucket frio inválido",
    );
  });
});

describe("cold documents in the ADR 0009 package (ADR 0010, decision 6)", () => {
  /** An in-memory bucket with the client surface the executor and the backup use. */
  function bucket() {
    const objects = new Map<string, Buffer>();
    return {
      objects,
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
      async verifyFile(key: string, expected: { sha256: string; bytes: number }) {
        const bytes = await this.get(key);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== expected.sha256 || bytes.length !== expected.bytes)
          throw new Error("corrupt");
      },
    };
  }
  async function publish(
    coldObjects: Map<string, Buffer>,
    { retainUntil = 42, coldLocks }: { retainUntil?: number; coldLocks?: unknown } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "fnfe-cold-package-"));
    directories.push(dir);
    const zip = join(dir, "archive.zip");
    writeFileSync(zip, "pacote sintético");
    const store = bucket(),
      cold = bucket();
    for (const [key, bytes] of coldObjects) cold.objects.set(key, bytes);
    const references = [...coldObjects].map(([key, bytes]) => ({
      key,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    }));
    const sealed: string[] = [];
    const manifest = await publishArchive({
      source: {
        mutation: async (_path: string, args: { manifest: string }) => sealed.push(args.manifest),
      },
      store,
      archive: {
        zip,
        run: { _id: "run1", organizationId: "org1", version: 1, retainUntil },
        rows: 1,
        files: 0,
        databaseBytes: 10,
        fileBytes: 0,
        digest: hash("linhas"),
        coldDocuments: coldDocumentList(references),
      },
      directory: dir,
      prefix: "deploy-1/cold/",
      recipients: ["age-a", "age-b"],
      encrypt: (from: string, to: string) => copyFile(from, to),
      coldBucket: "fnfe-cold",
      coldStore: cold,
      coldLocks,
    });
    return { manifest, store, cold, sealed, references };
  }
  const object = (version: string) =>
    [
      `documents/production/guard-2031/org1/${version}/content-${hash(version)}.gz`,
      Buffer.from(`gzip-${version}`),
    ] as const;

  it("checks every cold object, writes the list next to the package and binds it", async () => {
    const f = await publish(new Map([object("v2"), object("v1")]));
    expect(f.manifest.coldDocuments).toMatchObject({ bucket: "fnfe-cold", count: 2 });
    const list = f.store.objects.get(coldDocumentListKey(f.manifest))!.toString("utf8");
    expect(hash(list)).toBe(f.manifest.coldDocuments.digest);
    expect(list.split("\n").filter(Boolean)[0]).toContain("/v1/");
    const reference = { body: f.sealed[0]!, sha256: hash(f.sealed[0]!) };
    const coldStorage = (name?: string) => (name === "fnfe-cold" ? f.cold : null);
    await verifyColdArchives(f.store, [reference], { coldStorage, full: true });
    // A cold object gone: the backup that depends on the package fails.
    f.cold.objects.delete(f.references[0]!.key);
    await expect(verifyColdArchives(f.store, [reference], { coldStorage })).rejects.toThrow(
      "Documento frio ausente ou alterado",
    );
    // The collection reads only the backup bucket and skips them.
    await verifyColdArchives(f.store, [reference], { documents: false });
    // A list rewritten does not match the digest of the manifest.
    f.store.objects.set(coldDocumentListKey(f.manifest), Buffer.from(list + "x"));
    await expect(
      verifyColdArchives(f.store, [reference], { coldStorage, documents: true }),
    ).rejects.toThrow("Lista de documentos frios ausente ou alterada");
  });

  it("refuses to seal a package whose cold object is missing or damaged", async () => {
    const [key] = object("v1");
    const store = bucket();
    const dir = mkdtempSync(join(tmpdir(), "fnfe-cold-package-"));
    directories.push(dir);
    writeFileSync(join(dir, "archive.zip"), "pacote");
    await expect(
      publishArchive({
        source: { mutation: async () => null },
        store,
        archive: {
          zip: join(dir, "archive.zip"),
          run: { _id: "run1", organizationId: "org1", version: 1, retainUntil: 42 },
          rows: 1,
          files: 0,
          databaseBytes: 10,
          fileBytes: 0,
          digest: hash("linhas"),
          coldDocuments: coldDocumentList([{ key, sha256: hash("x"), bytes: 1 }]),
        },
        directory: dir,
        prefix: "deploy-1/cold/",
        recipients: ["age-a", "age-b"],
        encrypt: (from: string, to: string) => copyFile(from, to),
        coldBucket: "fnfe-cold",
        coldStore: bucket(),
      }),
    ).rejects.toThrow("missing");
    expect(store.objects.size).toBe(0);
  });

  it("extends the lock of its cold notes to the package's retention before sealing", async () => {
    const retainUntil = Date.UTC(2034, 0, 1, 3);
    await expect(publish(new Map([object("v1")]), { retainUntil })).rejects.toThrow(
      "regras de lock",
    );
    const ensured: unknown[] = [];
    const f = await publish(new Map([object("v1"), object("v2")]), {
      retainUntil,
      coldLocks: { ensure: async (rules: unknown[]) => ensured.push(...rules) },
    });
    expect(ensured).toEqual([
      {
        id: "archive-run1-2031",
        enabled: true,
        prefix: "documents/production/guard-2031/org1/",
        condition: { type: "Date", date: new Date(retainUntil).toISOString() },
      },
    ]);
    expect(f.manifest.coldDocuments.count).toBe(2);
  });

  it("keeps a package without cold notes as before", async () => {
    const f = await publish(new Map());
    expect(f.manifest.coldDocuments).toBeUndefined();
    expect([...f.store.objects.keys()].some((key) => key.endsWith("cold-documents.txt"))).toBe(
      false,
    );
  });
});

describe("coldReadCredentials", () => {
  it("prefers the cold tier's read-only token and refuses half of it", async () => {
    const { coldReadCredentials } = await import("../lib/offsite-backup.mjs");
    const backup = { R2_ACCESS_KEY_ID: "backup-id", R2_SECRET_ACCESS_KEY: "backup-secret" };
    expect(coldReadCredentials(backup)).toEqual({
      accessKeyId: "backup-id",
      secretAccessKey: "backup-secret",
    });
    expect(
      coldReadCredentials({
        ...backup,
        R2_COLD_READ_ACCESS_KEY_ID: "cold-id",
        R2_COLD_READ_SECRET_ACCESS_KEY: "cold-secret",
      }),
    ).toEqual({ accessKeyId: "cold-id", secretAccessKey: "cold-secret" });
    expect(() => coldReadCredentials({ ...backup, R2_COLD_READ_ACCESS_KEY_ID: "cold-id" })).toThrow(
      /juntos/,
    );
  });
});
