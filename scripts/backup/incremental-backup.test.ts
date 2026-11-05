import { afterEach, describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ageBinaries, hasAge as ageAvailable } from "../../tests/helpers/age";
import schema from "../../platform/convex/schema";
import {
  backupMetrics,
  measureBackupPhase,
  r2Client,
  readZip,
  sha256,
} from "../lib/offsite-backup.mjs";
import { extractZip, fileDigest, writeZip } from "../lib/offsite-backup-zip.mjs";
import {
  attachStorage,
  blobKeys,
  COMPONENT_PATHS,
  copyBlob,
  diskSummary,
  incrementalPlan,
  metadataHash,
  preflight,
  prepareDatabase,
  publishIncremental,
  readSystemInventory,
  restoredObjectProof,
  restoreIncremental,
  STORAGE_FIELDS,
} from "../lib/incremental-backup.mjs";

const directories: string[] = [];
const hasAge = ageAvailable();
const { age, keygen } = ageBinaries();
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "fnfe-incremental-test-"));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const plan = {
  prefix: "synthetic/",
  deployment: "synthetic",
  cadenceHours: 12,
  maxSnapshotBytes: 1024 ** 3,
  recipients: [{ recipient: "test-recipient-a" }, { recipient: "test-recipient-b" }],
  incremental: { version: 2, blobPrefix: "synthetic/objects/", retentionConfigured: true },
};
const bytes = Buffer.from("<NFe>original sintético\0</NFe>", "utf8");
const metadata = {
  _id: "synthetic_storage",
  _creationTime: 123,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("base64"),
  contentType: "application/xml",
};
const item = { metadata, url: "https://storage.invalid/synthetic", exportPart: false };
const maxBytes = 10 * 1024 ** 2;
const file = (dir: string, name: string, content: string | Buffer) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};
function fakeR2() {
  const objects = new Map<string, Buffer>(),
    writes: string[] = [];
  return {
    objects,
    writes,
    async head(key: string) {
      const data = objects.get(key);
      return data ? { size: data.length } : null;
    },
    async get(key: string) {
      const data = objects.get(key);
      if (!data) throw new Error("missing");
      return data;
    },
    async putFile(key: string, path: string) {
      if (objects.has(key)) return false;
      writes.push(key);
      objects.set(key, await readFile(path));
      return true;
    },
    async putImmutable(key: string, data: Buffer) {
      if (objects.has(key)) return false;
      writes.push(key);
      objects.set(key, data);
      return true;
    },
    async verifyFile(key: string, expected: { sha256: string; bytes: number }) {
      const data = objects.get(key);
      if (!data || data.length !== expected.bytes || sha256(data) !== expected.sha256)
        throw new Error("Objeto R2 corrompido");
    },
    async getFile(key: string, path: string, limit: number) {
      const data = objects.get(key);
      if (!data || data.length > limit) throw new Error("missing/limit");
      await writeFile(path, data, { flag: "wx" });
      return fileDigest(path);
    },
  };
}
function database(dir: string) {
  const contents = {
    "_tables/documents.jsonl": '{"name":"documentArtifacts","id":1}\n',
    "documentArtifacts/documents.jsonl":
      JSON.stringify({
        _id: "artifact",
        storageId: metadata._id,
        sha256: sha256(bytes),
        size: bytes.length,
      }) + "\n",
    "_components/betterAuth/user/documents.jsonl": '{"_id":"user","name":"Fictício"}\n',
    "documentExports/documents.jsonl":
      '{"_id":"export","state":"succeeded","expireJobId":"scheduled","bytes":123}\n',
    "exportParts/documents.jsonl":
      '{"_id":"part","exportId":"export","storageId":"temporary_zip","size":123}\n',
    "exportTickets/documents.jsonl":
      '{"_id":"ticket","exportId":"export","tokenHash":"synthetic"}\n',
    "capacityAccounts/documents.jsonl":
      '{"_id":"account","ready":true,"phase":5,"cursor":"done"}\n',
    "capacityFiles/documents.jsonl":
      '{"_id":"accounting","storageId":"temporary_zip","size":123}\n',
  };
  return new Map(
    Object.entries(contents).map(([name, value], i) => [name, file(dir, `table-${i}`, value)]),
  );
}

describe("incremental archive", () => {
  it("requires a separate lifetime for permanent objects and retains the global cap", () => {
    expect(incrementalPlan(plan)).toEqual(plan.incremental);
    expect(() =>
      incrementalPlan({
        ...plan,
        incremental: { ...plan.incremental, blobPrefix: "synthetic/snapshots/" },
      }),
    ).toThrow(/separado/);
    expect(() =>
      incrementalPlan({
        ...plan,
        incremental: { ...plan.incremental, retentionConfigured: false },
      }),
    ).toThrow(/lifecycle/);
    expect(preflight({ databaseBytes: 100, storage: [item], maxBytes })).toMatchObject({
      storageBytes: bytes.length,
      databaseBytes: 100,
    });
    expect(() => preflight({ databaseBytes: 1024 ** 3, storage: [], maxBytes: 1024 ** 3 })).toThrow(
      /export não iniciado/,
    );
    expect(() =>
      preflight({
        databaseBytes: 0,
        storage: [{ metadata: { ...metadata, size: 1024 ** 3 } }],
        maxBytes: 1024 ** 3,
      }),
    ).toThrow(/export não iniciado/);
  });

  it("keeps inventory coverage aligned with every schema storage field and mounted component", () => {
    const found: Record<string, string> = {};
    for (const [tableName, table] of Object.entries(schema.tables)) {
      if (table.validator.kind !== "object") continue;
      for (const [name, field] of Object.entries(table.validator.fields)) {
        if (field.kind === "id" && field.tableName === "_storage") {
          expect(found).not.toHaveProperty(tableName);
          found[tableName] = name;
        }
      }
    }
    expect(found).toEqual(STORAGE_FIELDS);
    const config = readFileSync("platform/convex/convex.config.ts", "utf8");
    const paths = [
      ...config.matchAll(/app\.use\((\w+)(?:,\s*\{\s*name:\s*"([^"]+)"\s*\})?\);/g),
    ].map((match) => match[2] ?? match[1]);
    expect(paths.sort()).toEqual(COMPONENT_PATHS.filter(Boolean).sort());
  });

  it("measures paginated database bytes including components and refuses before export", async () => {
    const seen: string[] = [];
    const query = async (
      path: string,
      args: { paginationOpts: { cursor: string | null }; table?: string },
      component: string,
    ) => {
      seen.push(component);
      if (path.endsWith("/tables"))
        return { page: [{ name: "documentArtifacts" }], isDone: true, continueCursor: "done" };
      if (!args.paginationOpts.cursor)
        return {
          page: [{ storageId: "synthetic_storage", value: "á" }],
          isDone: false,
          continueCursor: "next",
        };
      return { page: [{ value: "segundo" }], isDone: true, continueCursor: "done" };
    };
    const result = await readSystemInventory(query, maxBytes);
    expect(result.references.has(metadata._id)).toBe(true);
    expect(result.tables).toBe(COMPONENT_PATHS.length);
    expect(result.databaseBytes).toBe(
      COMPONENT_PATHS.length *
        (Buffer.byteLength(JSON.stringify({ storageId: "synthetic_storage", value: "á" })) +
          Buffer.byteLength(JSON.stringify({ value: "segundo" })) +
          2),
    );
    expect(new Set(seen)).toEqual(new Set(COMPONENT_PATHS));
    await expect(readSystemInventory(query, 1)).rejects.toThrow(/export não iniciado/);
  });

  it("references the content blob a document version holds (ADR 0010, phase B)", async () => {
    const version = { _id: "version", contentStorageId: "synthetic_content", result: "{}" };
    const query = async (path: string) =>
      path.endsWith("/tables")
        ? { page: [{ name: "documentVersions" }], isDone: true, continueCursor: "done" }
        : { page: [version], isDone: true, continueCursor: "done" };
    expect((await readSystemInventory(query, maxBytes)).references).toEqual(
      new Set(["synthetic_content"]),
    );
    const dir = scratch();
    const entries = database(dir);
    entries.set(
      "documentVersions/documents.jsonl",
      file(dir, "versions", JSON.stringify(version) + "\n"),
    );
    expect((await prepareDatabase(entries)).references).toEqual(
      new Set([metadata._id, "synthetic_content"]),
    );
  });

  it("roundtrips ZIP64 and detects CRC corruption with bounded extraction", async () => {
    const dir = scratch(),
      entries = database(dir),
      zip = join(dir, "db.zip");
    await writeZip(entries, zip, maxBytes);
    const extracted = await extractZip(zip, join(dir, "extract"), maxBytes);
    for (const [name, path] of entries)
      expect(await readFile(extracted.get(name)!)).toEqual(await readFile(path));
    expect(readZip(await readFile(zip), maxBytes).size).toBe(entries.size);
    await expect(extractZip(zip, join(dir, "small"), 5)).rejects.toThrow(/limite/);
    const corrupt = await readFile(zip);
    corrupt[corrupt.indexOf("artifact")]! ^= 1;
    await writeFile(join(dir, "bad.zip"), corrupt);
    await expect(extractZip(join(dir, "bad.zip"), join(dir, "bad"), maxBytes)).rejects.toThrow(
      /CRC/,
    );
  });

  it("invalidates derived exports and retains original references and part metadata", async () => {
    const dir = scratch(),
      entries = database(dir);
    const original = await readFile(entries.get("documentArtifacts/documents.jsonl")!);
    const result = await prepareDatabase(entries);
    expect([...result.references]).toEqual([metadata._id]);
    expect(result.invalidatedExports).toBe(1);
    expect(
      JSON.parse(await readFile(entries.get("documentExports/documents.jsonl")!, "utf8")),
    ).toEqual({ _id: "export", state: "expired", bytes: 123, code: "BACKUP_REGENERATE_EXPORT" });
    expect(await readFile(entries.get("exportTickets/documents.jsonl")!, "utf8")).toBe("");
    expect(await readFile(entries.get("exportParts/documents.jsonl")!, "utf8")).toContain(
      "temporary_zip",
    );
    expect(await readFile(entries.get("documentArtifacts/documents.jsonl")!)).toEqual(original);
    expect(
      JSON.parse(await readFile(entries.get("capacityAccounts/documents.jsonl")!, "utf8")),
    ).toMatchObject({ ready: false, phase: 0, cursor: null });
  });

  it.skipIf(!hasAge)(
    "copies once per hash, restores age-encrypted bytes and original Convex IDs offline",
    async () => {
      const dir = scratch(),
        client = fakeR2();
      const identity = join(dir, "identity.key");
      execFileSync(keygen, ["-o", identity], {
        stdio: "pipe",
        windowsHide: true,
      });
      const recipient = execFileSync(keygen, ["-y", identity], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      const secondIdentity = join(dir, "second.key");
      execFileSync(keygen, ["-o", secondIdentity], {
        stdio: "pipe",
        windowsHide: true,
      });
      const secondRecipient = execFileSync(keygen, ["-y", secondIdentity], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      const livePlan = { ...plan, recipients: [{ recipient }, { recipient: secondRecipient }] };
      const crypt = (args: string[]) => {
        execFileSync(age, args, { stdio: "pipe", windowsHide: true });
      };
      const encrypt = async (plain: string, cipher: string) => {
        crypt(["-e", "-r", recipient, "-r", secondRecipient, "-o", cipher, plain]);
        const roundtrip = join(dir, "roundtrip");
        crypt(["-d", "-i", identity, "-o", roundtrip, cipher]);
        expect(await fileDigest(roundtrip)).toEqual(await fileDigest(plain));
        rmSync(roundtrip);
      };
      let downloads = 0;
      const fetchImpl = (async () => {
        downloads++;
        return new Response(bytes);
      }) as typeof fetch;
      const object = await copyBlob({
        plan: livePlan,
        client,
        item,
        directory: dir,
        encrypt,
        fetchImpl,
      });
      const second = await copyBlob({
        plan: livePlan,
        client,
        item: { ...item, metadata: { ...metadata, _id: "another_id" }, url: null },
        directory: dir,
        encrypt,
        fetchImpl,
      });
      expect(second.reused).toBe(true);
      expect(downloads).toBe(1);
      expect(client.writes.filter((key) => key.endsWith(".age"))).toHaveLength(1);
      const entries = database(dir);
      await prepareDatabase(entries);
      await attachStorage(
        entries,
        [item, { ...item, metadata: { ...metadata, _id: "another_id" } }],
        dir,
      );
      const summary = await diskSummary(entries, { verifyStorage: false });
      const manifest = {
        format: 2,
        deployment: "synthetic",
        objects: [object],
        digests: summary.digests,
      };
      const restored = join(dir, "restored.zip");
      await restoreIncremental({
        manifest,
        entries,
        client,
        directory: dir,
        zip: restored,
        maxBytes,
        decrypt: async (from: string, to: string) =>
          crypt(["-d", "-i", secondIdentity, "-o", to, from]),
      });
      const restoredEntries = readZip(await readFile(restored), maxBytes);
      expect(restoredEntries.get(`_storage/${metadata._id}`)).toEqual(bytes);
      expect(restoredEntries.get("_storage/another_id")).toEqual(bytes);
      expect(
        JSON.parse(restoredEntries.get("_storage/documents.jsonl")!.toString().split("\n")[0]!),
      ).toEqual(metadata);
      expect(
        (await diskSummary(await extractZip(restored, join(dir, "verified-output"), maxBytes)))
          .digests,
      ).toEqual(summary.digests);
      const proof = await restoredObjectProof({
        metadata,
        path: entries.get(`_storage/${metadata._id}`),
        ciphertext: object.ciphertext,
        verifierRunId: "synthetic-test",
        verifiedAt: 42,
      });
      expect(proof).toMatchObject({
        originalStorageId: metadata._id,
        restoredMetadataSha256: metadataHash(metadata),
        restoredPlaintextSha256: sha256(bytes),
        restoredBytes: bytes.length,
      });
      const key = blobKeys(livePlan, sha256(bytes)).cipher;
      client.objects.get(key)![0]! ^= 1;
      await expect(
        copyBlob({ plan: livePlan, client, item, directory: dir, encrypt, fetchImpl }),
      ).rejects.toThrow(/corrompido/);
    },
  );

  it("measures new copies, repeated verification and partial failure without private data", async () => {
    const dir = scratch(),
      metrics = backupMetrics(2),
      objects = new Map<string, Buffer>();
    const client = r2Client({
      accountId: "synthetic",
      bucket: "synthetic",
      credentials: { accessKeyId: "private-access", secretAccessKey: "private-secret" },
      metrics,
      fetchImpl: (async (url: URL, init: RequestInit) => {
        const key = url.pathname;
        if (init.method === "PUT") {
          if (objects.has(key)) return new Response(null, { status: 412 });
          const chunks: Uint8Array[] = [];
          if (Buffer.isBuffer(init.body)) chunks.push(init.body);
          else
            for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>)
              chunks.push(chunk);
          objects.set(key, Buffer.concat(chunks));
          return new Response(null, { status: 200 });
        }
        const data = objects.get(key);
        if (!data) return new Response(null, { status: 404 });
        return new Response(init.method === "HEAD" ? null : new Uint8Array(data), {
          headers: { "content-length": String(data.length) },
        });
      }) as typeof fetch,
    });
    const copy = () =>
      copyBlob({
        plan,
        client,
        item,
        directory: dir,
        metrics,
        encrypt: copyFile,
        fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      });
    const first = await copy();
    expect(metrics.observed.newBlobObjects).toBe(1);
    expect(metrics.observed.r2.verifiedCiphertextBytes).toBe(bytes.length);
    const uploaded = metrics.observed.r2.acknowledgedPutBodyBytes;
    expect(uploaded).toBeGreaterThan(bytes.length); // includes the proof JSON
    const second = await copy();
    expect(second.reused).toBe(true);
    expect(metrics.observed.reusedBlobReferences).toBe(1);
    expect(metrics.observed.r2.acknowledgedPutBodyBytes).toBe(uploaded);
    expect(metrics.observed.r2.verifiedCiphertextBytes).toBe(2 * bytes.length);
    const cipher = file(dir, "metrics-db.age", "synthetic database");
    const manifest = {
      format: 2,
      id: "2026-10-27T03-00-00Z",
      ciphertext: await fileDigest(cipher),
      objects: [first],
    };
    const original = JSON.stringify(manifest);
    await publishIncremental({ plan, client, manifest, cipher });
    expect(JSON.stringify(manifest)).toBe(original);
    expect(metrics.observed.r2.verifiedCiphertextBytes).toBe(
      3 * bytes.length + manifest.ciphertext.bytes,
    );
    expect([...objects.keys()].at(-1)).toMatch(/manifest.json$/);
    objects.get(`/synthetic/${first.key}`)![0]! ^= 1;
    const verified = metrics.observed.r2.verifiedCiphertextBytes;
    await expect(measureBackupPhase(metrics, "copy", copy)).rejects.toThrow(/corrompido/);
    expect(metrics.observed.r2.verifiedCiphertextBytes).toBe(verified);
    expect(metrics.observed.r2.verificationReadBytes).toBe(verified + bytes.length);
    expect(metrics.observed.reusedBlobReferences).toBe(1);
    expect(metrics.observed.durationsMs.copy).toBeGreaterThanOrEqual(0);
    expect(metrics.observed.exportZipBytes).toBeNull();
    expect(JSON.stringify(metrics)).not.toMatch(/private|synthetic|storage.invalid|NFe/);
    const failedManifest = { ...manifest, id: "2026-10-27T04-00-00Z" };
    await expect(
      publishIncremental({ plan, client, manifest: failedManifest, cipher }),
    ).rejects.toThrow(/corrompido/);
    expect(
      [...objects.keys()].some((key) => key.endsWith(`${failedManifest.id}/manifest.json`)),
    ).toBe(false);
    expect(metrics.observed.r2.acknowledgedPutBodyBytes).toBeGreaterThan(uploaded);
  });

  it("never publishes completion when a retained object was corrupted or disappeared", async () => {
    const dir = scratch(),
      client = fakeR2(),
      cipher = file(dir, "db.age", "synthetic cipher");
    const key = "synthetic/objects/missing.age";
    const manifest = {
      format: 2,
      id: "2026-10-27T03-00-00Z",
      ciphertext: await fileDigest(cipher),
      objects: [{ key, ciphertext: { sha256: sha256(bytes), bytes: bytes.length } }],
    };
    await expect(publishIncremental({ plan, client, manifest, cipher })).rejects.toThrow(
      /corrompido/,
    );
    expect(client.writes.some((key) => key.endsWith("manifest.json"))).toBe(false);
    const client2 = fakeR2();
    client2.objects.set(key, bytes);
    await publishIncremental({ plan, client: client2, manifest, cipher });
    expect(client2.writes.at(-1)).toMatch(/manifest.json$/);
  });

  it("restores with a simulated cipher on every runner and rejects uncovered references", async () => {
    const dir = scratch(),
      client = fakeR2();
    const encrypt = async (from: string, to: string) => copyFile(from, to);
    const object = await copyBlob({
      plan,
      client,
      item,
      directory: dir,
      encrypt,
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
    });
    const entries = database(dir);
    await prepareDatabase(entries);
    await attachStorage(entries, [item], dir);
    const summary = await diskSummary(entries, { verifyStorage: false });
    const manifest = {
      format: 2,
      deployment: "synthetic",
      objects: [object],
      digests: summary.digests,
    };
    await expect(
      restoreIncremental({
        manifest: { ...manifest, objects: [] },
        entries: new Map(entries),
        client,
        directory: dir,
        zip: join(dir, "missing.zip"),
        maxBytes,
        decrypt: encrypt,
      }),
    ).rejects.toThrow(/não cobre/);
    const zip = join(dir, "restored.zip");
    await restoreIncremental({
      manifest,
      entries,
      client,
      directory: dir,
      zip,
      maxBytes,
      decrypt: encrypt,
    });
    const actual = await diskSummary(await extractZip(zip, join(dir, "verified-output"), maxBytes));
    expect(actual.digests).toEqual(summary.digests);
    expect(actual.storage).toEqual({ files: 1, bytes: bytes.length });
    await expect(
      restoredObjectProof({
        metadata: { ...metadata, size: metadata.size + 1 },
        path: entries.get(`_storage/${metadata._id}`),
        ciphertext: object.ciphertext,
        verifierRunId: "bad-proof",
        verifiedAt: 42,
      }),
    ).rejects.toThrow(/diverge/);
  });

  it("fails closed on missing originals, wrong source bytes and incomplete previous uploads", async () => {
    const dir = scratch(),
      client = fakeR2(),
      encrypt = async (from: string, to: string) => copyFile(from, to);
    await expect(
      copyBlob({ plan, client, item: { ...item, url: null }, directory: dir, encrypt }),
    ).rejects.toThrow(/desapareceu/);
    await expect(
      copyBlob({
        plan,
        client,
        item,
        directory: dir,
        encrypt,
        fetchImpl: (async () => new Response("bad")) as typeof fetch,
      }),
    ).rejects.toThrow(/diverge/);
    const keys = blobKeys(plan, sha256(bytes));
    client.objects.set(keys.cipher, bytes);
    await expect(copyBlob({ plan, client, item, directory: dir, encrypt })).rejects.toThrow(
      /sem prova/,
    );
  });
});

it("preserves uniform int64, float64 and nested tagged values while invalidating control state", async () => {
  const dir = scratch();
  const nested =
    '"nested":{"big":9223372036854775807,"small":1,"float":1.0,"negativeZero":-0.0,"tagged":{"$integer":"AQAAAAAAAAA="},"nonfinite":{"$float":"AAAAAAAA8H8="}}';
  const account = '{"_id":"account","ready":true,"phase":4.0,"reservedFiles":18.0,' + nested + "}";
  const exp = '{"_id":"export","state":"succeeded","bytes":4.0,"expireJobId":"job",' + nested + "}";
  const entries = new Map([
    ["_tables/documents.jsonl", file(dir, "tables", "")],
    ["capacityAccounts/documents.jsonl", file(dir, "account", account)],
    ["capacityAccounts/generated_schema.jsonl", file(dir, "account-schema", '"uniform"')],
    ["documentExports/documents.jsonl", file(dir, "exports", exp)],
    ["documentExports/generated_schema.jsonl", file(dir, "exports-schema", '"uniform"')],
  ]);
  await prepareDatabase(entries);
  const actualAccount = await readFile(entries.get("capacityAccounts/documents.jsonl")!, "utf8");
  expect(actualAccount).toContain('"phase":0.0');
  expect(actualAccount).toContain('"reservedFiles":18.0');
  expect(actualAccount).toContain(nested);
  const actualExport = await readFile(entries.get("documentExports/documents.jsonl")!, "utf8");
  expect(actualExport).toContain('"state":"expired"');
  expect(actualExport).not.toContain("expireJobId");
  expect(actualExport).toContain(nested);
  const original = await diskSummary(entries);
  await writeFile(
    entries.get("capacityAccounts/documents.jsonl")!,
    actualAccount.replace('"small":1,', '"small":1.0,'),
  );
  expect((await diskSummary(entries)).digests).not.toEqual(original.digests);
  await writeFile(
    entries.get("capacityAccounts/documents.jsonl")!,
    actualAccount.replace("9223372036854775807", "9223372036854775806"),
  );
  expect((await diskSummary(entries)).digests).not.toEqual(original.digests);
});
