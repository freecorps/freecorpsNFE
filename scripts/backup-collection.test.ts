import { describe, it, expect } from "vite-plus/test";
import {
  applyCollection,
  collectionPlan,
  sourceReferences,
  retainedLockRules,
  bucketLocks,
} from "./lib/backup-collection.mjs";
import { BACKUP_LEASE_KEY, withBackupLease } from "./lib/backup-lease.mjs";
import { r2Client, sha256, snapshotId, backupFailure } from "./lib/offsite-backup.mjs";

const now = Date.parse("2026-10-31T12:00:00Z");
const plan = {
  prefix: "synthetic/",
  deployment: "synthetic",
  bucket: "drill",
  retentionDays: 14,
  alertAfterHours: 13,
};
type Rule = { id: string; enabled: boolean; prefix: string; condition: { type: string } };
function fixture() {
  const data = new Map<string, { body: Buffer; modifiedAt: number }>();
  const put = (key: string, value: unknown, modifiedAt = now - 15 * 86400_000) => {
    data.set(key, {
      body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
      modifiedAt,
    });
  };
  let rules: Rule[] = [
    {
      id: "permanent",
      prefix: "synthetic/objects/",
      enabled: true,
      condition: { type: "Indefinite" },
    },
    { id: "other-deployment", prefix: "other/", enabled: true, condition: { type: "Indefinite" } },
  ];
  const initialRules = structuredClone(rules),
    deletions: string[] = [];
  const client = {
    list: async (prefix: string): Promise<string[]> =>
      [...data.keys()].filter((k) => k.startsWith(prefix)),
    get: async (key: string): Promise<Buffer> => {
      const found = data.get(key);
      if (!found) throw Error("missing");
      return found.body;
    },
    head: async (key: string) => {
      const found = data.get(key);
      return found ? { size: found.body.length, modifiedAt: found.modifiedAt } : null;
    },
    verifyFile: async (key: string, expected: { sha256: string; bytes: number }) => {
      const found = data.get(key);
      expect(found).toBeDefined();
      expect({ sha256: sha256(found!.body), bytes: found!.body.length }).toEqual(expected);
    },
    putImmutable: async (key: string, body: Buffer) => {
      if (data.has(key)) return false;
      put(key, body, now);
      return true;
    },
    delete: async (key: string) => {
      if (rules.some((r) => r.enabled && key.startsWith(r.prefix))) throw Error("locked");
      deletions.push(key);
      data.delete(key);
    },
  };
  const locks = {
    get: async () => structuredClone(rules),
    set: async (next: Rule[]) => {
      rules = structuredClone(next);
    },
  };
  const addObject = (label: string, modifiedAt?: number, epoch = sha256("custodians")) => {
    const hash = sha256(label),
      base = `${plan.prefix}objects/${epoch}/${hash}`;
    const body = Buffer.from(`encrypted-${label}`),
      ciphertext = { sha256: sha256(body), bytes: body.length };
    const proof = {
      format: 2,
      recipientSet: epoch,
      plaintext: { sha256: hash, bytes: label.length },
      ciphertext,
    };
    put(base + ".age", body, modifiedAt);
    put(base + ".json", proof, modifiedAt);
    return { base, key: base + ".age", ...proof };
  };
  const addSnapshot = (objects: ReturnType<typeof addObject>[], at = now, format = 2) => {
    const id = snapshotId(new Date(at)),
      body = Buffer.from("database");
    const manifest = {
      id,
      format,
      deployment: plan.deployment,
      ciphertext: { sha256: sha256(body), bytes: body.length },
      objects,
    };
    put(`${plan.prefix}snapshots/${id}/snapshot.zip.age`, body);
    put(`${plan.prefix}snapshots/${id}/manifest.json`, manifest);
    return manifest;
  };
  let hashes: string[] = [];
  let legacyHashes: string[] = [];
  let coldArchives: { body: string; sha256: string }[] = [];
  const inventory = () =>
    collectionPlan({
      plan,
      client,
      now,
      readSource: async () => ({ hashes, coldArchives }),
      readSnapshotHashes: async () => ({ hashes: legacyHashes, coldArchives: [] }),
      readArchiveHashes: async () => [sha256("cold")],
    });
  const paused = async () => {};
  return {
    data,
    put,
    client,
    locks,
    addObject,
    addSnapshot,
    inventory,
    initialRules,
    deletions,
    paused,
    setHashes: (next: string[]) => {
      hashes = next;
    },
    setLegacy: (next: string[]) => {
      legacyHashes = next;
    },
    setCold: (next: typeof coldArchives) => {
      coldArchives = next;
    },
  };
}

describe("reference collection", () => {
  it("keeps live, legacy, all retained snapshots, young and shared hashes across custodian epochs", async () => {
    const f = fixture();
    const live = f.addObject("live"),
      legacy = f.addObject("legacy"),
      old = f.addObject("old snapshot");
    const shared = f.addObject("live", undefined, sha256("old custodians"));
    const young = f.addObject("young", now - 1000),
      orphan = f.addObject("orphan");
    f.setHashes([live.plaintext.sha256]);
    f.setLegacy([legacy.plaintext.sha256]);
    f.addSnapshot([old], now - 30 * 86400_000);
    f.addSnapshot([], now, 1);
    const result = await f.inventory();
    expect(result.candidates).toEqual([orphan.base]);
    expect(new Set(result.keep)).toEqual(
      new Set([live.base, legacy.base, old.base, shared.base, young.base]),
    );
    expect(f.deletions).toEqual([]);
  });
  it("preserves live economic archives even without hot originals", async () => {
    const f = fixture(),
      cold = f.addObject("cold");
    f.addSnapshot([]);
    const body = Buffer.from("cold encrypted");
    const manifest = {
      format: "fnfe-cold-archive/1",
      prefix: "synthetic/cold/",
      runId: "run",
      objectKey: "synthetic/cold/run/archive.zip.age",
      ciphertextSha256: sha256(body),
      ciphertextBytes: body.length,
    };
    const text = JSON.stringify(manifest);
    f.put(manifest.objectKey, body);
    f.put("synthetic/cold/run/manifest.json", Buffer.from(text));
    f.setCold([{ body: text, sha256: sha256(text) }]);
    expect((await f.inventory()).keep).toContain(cold.base);
  });
  it("never unlocks retained or other-deployment objects while deleting only orphans", async () => {
    const f = fixture(),
      keep = f.addObject("keep"),
      orphan = f.addObject("orphan");
    f.addSnapshot([keep]);
    const result = await f.inventory();
    const originalSet = f.locks.set;
    f.locks.set = async (rules: Rule[]) => {
      expect(rules.some((r) => r.enabled && keep.key.startsWith(r.prefix))).toBe(true);
      expect(rules).toContainEqual(f.initialRules[1]);
      await originalSet(rules);
    };
    await expect(
      withBackupLease(f.client, "collection", () =>
        applyCollection({
          plan,
          client: f.client,
          locks: f.locks,
          inventory: f.inventory,
          expected: result.fingerprint,
          assertPaused: f.paused,
        }),
      ),
    ).resolves.toEqual({ deletedObjects: 2 });
    expect(f.data.has(orphan.key)).toBe(false);
    expect(f.data.has(keep.key)).toBe(true);
    expect(await f.locks.get()).toEqual(f.initialRules);
    expect(f.deletions).toEqual([orphan.base + ".age", orphan.base + ".json", BACKUP_LEASE_KEY]);
    const next = await f.inventory();
    expect(next.candidates).toEqual([]);
  });
  it.each(["snapshot", "object", "stale", "corrupt"])(
    "refuses incomplete or invalid input: %s",
    async (kind) => {
      const f = fixture(),
        object = f.addObject("x");
      const snap = f.addSnapshot([object]);
      if (kind === "snapshot") f.data.delete(`${plan.prefix}snapshots/${snap.id}/manifest.json`);
      if (kind === "object") f.data.delete(object.base + ".json");
      if (kind === "stale") {
        f.data.clear();
        f.addSnapshot([], now - 14 * 3600_000);
      }
      if (kind === "corrupt") f.put(object.key, Buffer.from("bad"));
      await expect(f.inventory()).rejects.toThrow();
      expect(f.deletions).toEqual([]);
    },
  );
  it("rejects a stale reviewed plan before changing any lock", async () => {
    const f = fixture(),
      object = f.addObject("x");
    f.addSnapshot([]);
    const result = await f.inventory();
    f.setHashes([object.plaintext.sha256]);
    await expect(
      applyCollection({
        plan,
        client: f.client,
        locks: f.locks,
        inventory: f.inventory,
        expected: result.fingerprint,
        assertPaused: f.paused,
      }),
    ).rejects.toThrow("PLAN_CHANGED");
    expect(await f.locks.get()).toEqual(f.initialRules);
    expect(f.deletions).toEqual([]);
  });
  it("confirms deletion instead of trusting a successful DELETE", async () => {
    const f = fixture();
    f.addObject("orphan");
    f.addSnapshot([]);
    f.client.delete = async () => {};
    await expect(
      applyCollection({
        plan,
        client: f.client,
        locks: f.locks,
        inventory: f.inventory,
        expected: (await f.inventory()).fingerprint,
        assertPaused: f.paused,
      }),
    ).rejects.toThrow("DELETE_NOT_CONFIRMED");
    expect(await f.locks.get()).toEqual(f.initialRules);
  });
  it("leaves the bucket lease in place if restoring the permanent lock fails", async () => {
    const f = fixture();
    f.addObject("orphan");
    f.addSnapshot([]);
    const set = f.locks.set;
    let calls = 0;
    f.locks.set = async (rules: Rule[]) => {
      if (++calls === 3) throw Error("offline");
      await set(rules);
    };
    const expected = (await f.inventory()).fingerprint;
    await expect(
      withBackupLease(f.client, "collection", () =>
        applyCollection({
          plan,
          client: f.client,
          locks: f.locks,
          inventory: f.inventory,
          expected,
          assertPaused: f.paused,
        }),
      ),
    ).rejects.toThrow("LOCK_RECOVERY_REQUIRED");
    expect(f.data.has(BACKUP_LEASE_KEY)).toBe(true);
    await expect(withBackupLease(f.client, "snapshot", async () => {})).rejects.toThrow(
      "BACKUP_BUSY",
    );
  });
  it("serializes snapshots and collectors, including a snapshot that fails", async () => {
    const f = fixture();
    await expect(
      withBackupLease(f.client, "snapshot", async () => {
        await expect(withBackupLease(f.client, "collection", async () => {})).rejects.toThrow(
          "BACKUP_BUSY",
        );
        throw Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect(f.data.has(BACKUP_LEASE_KEY)).toBe(false);
  });
  it("groups retained prefixes without covering any candidate", () => {
    const rules = retainedLockRules("p/", ["p/aa1", "p/aa2", "p/bb1"], ["p/ab1"]);
    expect(
      ["p/aa1", "p/aa2", "p/bb1"].every((key) => rules.some((r) => key.startsWith(r.prefix))),
    ).toBe(true);
    expect(rules.some((r) => "p/ab1".startsWith(r.prefix))).toBe(false);
  });
});

describe("source and provider refusals", () => {
  it.each(["running", "hold", "moving", "pagination"])("blocks unsafe source %s", async (kind) => {
    const query = async (path: string, args: { table?: string }) => {
      if (path.includes("deploymentState"))
        return { state: kind === "running" ? "running" : "paused" };
      const page =
        args.table === "retentionHolds" && kind === "hold"
          ? [{ releasedAt: undefined }]
          : args.table === "coldArchiveRuns" && kind === "moving"
            ? [{ state: "removing" }]
            : [];
      return { page, isDone: kind !== "pagination", continueCursor: "repeated" };
    };
    await expect(sourceReferences(query, true)).rejects.toThrow(/^BACKUP_GC_/);
  });
  it("reads all storage and all organizations, retaining zero-byte files", async () => {
    const metadata = {
      _id: "synthetic",
      _creationTime: 1,
      size: 0,
      sha256: Buffer.from(sha256(""), "hex").toString("base64"),
    };
    const query = async (path: string, args: { table?: string }) =>
      path.includes("deploymentState")
        ? { state: "paused" }
        : { isDone: true, page: args.table === "_storage" ? [metadata] : [] };
    expect((await sourceReferences(query, true)).hashes).toEqual([sha256("")]);
  });
  it.each([
    "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
    "<ListBucketResult><Key>x</Key>",
  ])("rejects truncated S3 listing %s", async (body) => {
    const client = r2Client({
      accountId: "fake",
      bucket: "fake",
      credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
      fetchImpl: async () => new Response(body),
    });
    await expect(client.list("p/")).rejects.toThrow("LIST_INCOMPLETE");
  });
  it("hides Cloudflare response bodies and assertion values", async () => {
    const locks = bucketLocks({
      accountId: "fake",
      bucket: "fake",
      token: "synthetic-private-marker",
      fetchImpl: async () => new Response("synthetic-private-marker", { status: 403 }),
    });
    await expect(locks.get()).rejects.toThrow("LOCK_API_FAILED");
    expect(backupFailure(new Error("BACKUP_GC_SOURCE_NOT_PAUSED\nsynthetic-private-marker"))).toBe(
      "BACKUP_GC_SOURCE_NOT_PAUSED",
    );
  });
});
