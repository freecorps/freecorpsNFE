import assert from "node:assert/strict";
import { byCodeUnit, objectKeys, sha256, snapshotTime } from "./offsite-backup.mjs";
import { validateMetadata, verifyColdArchives } from "./incremental-backup.mjs";

const HASH = /^[a-f0-9]{64}$/;
const fail = (condition, code) => assert.ok(condition, `BACKUP_GC_${code}`);
const sorted = (values) => [...values].sort(byCodeUnit);
const jsonHash = (value) =>
  sha256(
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => byCodeUnit(a, b)))
        : item,
    ),
  );
const rulesHash = (rules) => jsonHash([...rules].sort((a, b) => byCodeUnit(a.id, b.id)));

/** No customer rows or storage URLs escape the collector. Paused source uses admin system UDFs. */
export async function sourceReferences(query, requirePaused = false) {
  const state = await query("_system/frontend/deploymentState:deploymentState", {});
  fail(!requirePaused || state.state === "paused", "SOURCE_NOT_PAUSED");
  async function* rows(table) {
    const seen = new Set();
    let cursor = null;
    for (;;) {
      const page = await query("_system/cli/tableData", {
        table,
        order: "asc",
        paginationOpts: { cursor, numItems: 128 },
      });
      fail(Array.isArray(page.page) && typeof page.isDone === "boolean", "INVENTORY_INCOMPLETE");
      yield* page.page;
      if (page.isDone) return;
      fail(
        typeof page.continueCursor === "string" && !seen.has(page.continueCursor),
        "INVENTORY_INCOMPLETE",
      );
      seen.add(page.continueCursor);
      cursor = page.continueCursor;
    }
  }
  for await (const hold of rows("retentionHolds"))
    fail(hold.releasedAt !== undefined, "LEGAL_HOLD");
  const hashes = new Set();
  for await (const metadata of rows("_storage")) hashes.add(validateMetadata(metadata));
  const coldArchives = [];
  for await (const run of rows("coldArchiveRuns")) {
    if (["hot", "notice"].includes(run.state)) continue;
    fail(run.state === "archived", "ARCHIVE_MOVING");
    fail(
      typeof run.manifest === "string" && sha256(run.manifest) === run.manifestSha256,
      "ARCHIVE_INCOMPLETE",
    );
    const manifest = JSON.parse(run.manifest);
    fail(
      manifest.runId === run._id && manifest.organizationId === run.organizationId,
      "ARCHIVE_INCOMPLETE",
    );
    coldArchives.push({
      body: run.manifest,
      sha256: run.manifestSha256,
      ...(run.catalog ? { catalogSha256: run.catalog.manifestSha256 } : {}),
    });
  }
  return { hashes: sorted(hashes), coldArchives };
}

/** Complete listing + complete snapshot pairs. Age alone never makes an object collectible. */
export async function collectionPlan({
  plan,
  client,
  readSource,
  readSnapshotHashes,
  readArchiveHashes,
  now = Date.now(),
}) {
  const source = await readSource();
  fail(
    Array.isArray(source.hashes) && source.hashes.every((hash) => HASH.test(hash)),
    "INVENTORY_INCOMPLETE",
  );
  const hashes = new Set(source.hashes),
    cold = new Map();
  const rememberCold = (references) => {
    fail(Array.isArray(references), "ARCHIVE_INCOMPLETE");
    for (const reference of references) cold.set(jsonHash(reference), reference);
  };
  rememberCold(source.coldArchives);
  const snapshotsPrefix = `${plan.prefix}snapshots/`,
    objectsPrefix = `${plan.prefix}objects/`;
  const snapshotKeys = sorted(await client.list(snapshotsPrefix));
  fail(
    new Set(snapshotKeys).size === snapshotKeys.length && snapshotKeys.length > 0,
    "SNAPSHOTS_INCOMPLETE",
  );
  const snapshots = new Map();
  for (const key of snapshotKeys) {
    fail(key.startsWith(snapshotsPrefix), "SNAPSHOTS_INCOMPLETE");
    const match = key
      .slice(snapshotsPrefix.length)
      .match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\/(manifest\.json|snapshot\.zip\.age)$/);
    fail(match, "SNAPSHOTS_INCOMPLETE");
    const parts = snapshots.get(match[1]) ?? new Set();
    parts.add(match[2]);
    snapshots.set(match[1], parts);
  }
  const snapshotDigests = [],
    requiredObjects = new Map();
  for (const [id, parts] of snapshots) {
    fail(parts.size === 2, "SNAPSHOTS_INCOMPLETE");
    fail(Number.isFinite(snapshotTime(id)) && snapshotTime(id) <= now, "MANIFEST_INVALID");
    const body = await client.get(objectKeys(plan, id).manifest);
    const manifest = JSON.parse(body.toString("utf8"));
    fail(
      manifest.id === id &&
        manifest.deployment === plan.deployment &&
        [1, 2].includes(manifest.format),
      "MANIFEST_INVALID",
    );
    fail(
      HASH.test(manifest.ciphertext?.sha256) &&
        Number.isSafeInteger(manifest.ciphertext?.bytes) &&
        manifest.ciphertext.bytes > 0,
      "MANIFEST_INVALID",
    );
    await client.verifyFile(objectKeys(plan, id).snapshot, manifest.ciphertext);
    snapshotDigests.push([id, sha256(body)]);
    if (manifest.format === 1) {
      const recovered = await readSnapshotHashes(manifest);
      for (const hash of recovered.hashes) {
        fail(HASH.test(hash), "MANIFEST_INVALID");
        hashes.add(hash);
      }
      rememberCold(recovered.coldArchives);
    } else {
      fail(Array.isArray(manifest.objects), "MANIFEST_INVALID");
      for (const object of manifest.objects) {
        const match =
          typeof object.key === "string" &&
          object.key.startsWith(objectsPrefix) &&
          object.key.slice(objectsPrefix.length).match(/^([a-f0-9]{64})\/([a-f0-9]{64})\.age$/);
        fail(
          match &&
            match[2] === object.plaintext?.sha256 &&
            HASH.test(object.ciphertext?.sha256) &&
            Number.isSafeInteger(object.ciphertext?.bytes) &&
            object.ciphertext.bytes > 0,
          "MANIFEST_INVALID",
        );
        if (requiredObjects.has(object.key))
          fail(
            jsonHash(requiredObjects.get(object.key)) === jsonHash(object.ciphertext),
            "MANIFEST_INVALID",
          );
        requiredObjects.set(object.key, object.ciphertext);
        hashes.add(match[2]);
      }
      rememberCold(manifest.coldArchives ?? []);
    }
  }
  // Keep every still-present snapshot, even one older than the configured lifecycle.
  fail(
    now - Math.max(...[...snapshots.keys()].map(snapshotTime)) <= plan.alertAfterHours * 3_600_000,
    "BACKUP_STALE",
  );
  for (const reference of cold.values()) {
    fail(JSON.parse(reference.body).prefix === `${plan.prefix}cold/`, "ARCHIVE_INCOMPLETE");
    await verifyColdArchives(client, [reference], { documents: false });
    for (const hash of await readArchiveHashes(reference)) {
      fail(HASH.test(hash), "ARCHIVE_INCOMPLETE");
      hashes.add(hash);
    }
  }
  const keys = sorted(await client.list(objectsPrefix));
  fail(new Set(keys).size === keys.length, "OBJECT_INCOMPLETE");
  const pairs = new Map();
  for (const key of keys) {
    const match =
      key.startsWith(objectsPrefix) &&
      key.slice(objectsPrefix.length).match(/^([a-f0-9]{64})\/([a-f0-9]{64})\.(age|json)$/);
    fail(match, "OBJECT_INCOMPLETE");
    const base = `${objectsPrefix}${match[1]}/${match[2]}`;
    const pair = pairs.get(base) ?? {
      base,
      recipientSet: match[1],
      hash: match[2],
      parts: new Set(),
    };
    pair.parts.add(match[3]);
    pairs.set(base, pair);
  }
  for (const key of requiredObjects.keys()) fail(keys.includes(key), "OBJECT_INCOMPLETE");
  const keep = [],
    candidates = [],
    objects = [];
  for (const pair of pairs.values()) {
    fail(pair.parts.size === 2, "OBJECT_INCOMPLETE");
    const proofBody = await client.get(`${pair.base}.json`),
      proof = JSON.parse(proofBody.toString("utf8"));
    fail(
      proof.format === 2 &&
        proof.recipientSet === pair.recipientSet &&
        proof.plaintext?.sha256 === pair.hash &&
        Number.isSafeInteger(proof.plaintext?.bytes) &&
        proof.plaintext.bytes >= 0 &&
        HASH.test(proof.ciphertext?.sha256) &&
        Number.isSafeInteger(proof.ciphertext?.bytes) &&
        proof.ciphertext.bytes > 0,
      "OBJECT_INCOMPLETE",
    );
    const head = await client.head(`${pair.base}.age`),
      proofHead = await client.head(`${pair.base}.json`);
    fail(
      head &&
        proofHead &&
        head.size === proof.ciphertext.bytes &&
        Number.isFinite(head.modifiedAt) &&
        Number.isFinite(proofHead.modifiedAt) &&
        head.modifiedAt <= now &&
        proofHead.modifiedAt <= now,
      "OBJECT_INCOMPLETE",
    );
    const expected = requiredObjects.get(`${pair.base}.age`);
    if (expected) fail(jsonHash(expected) === jsonHash(proof.ciphertext), "OBJECT_INCOMPLETE");
    await client.verifyFile(`${pair.base}.age`, proof.ciphertext);
    const retained =
      hashes.has(pair.hash) ||
      now - Math.max(head.modifiedAt, proofHead.modifiedAt) < plan.retentionDays * 86_400_000;
    (retained ? keep : candidates).push(pair.base);
    objects.push([pair.base, sha256(proofBody), head.modifiedAt, proofHead.modifiedAt]);
  }
  const fingerprint = jsonHash({
    deployment: plan.deployment,
    bucket: plan.bucket,
    prefix: plan.prefix,
    snapshotDigests,
    hashes: sorted(hashes),
    objects,
    keep,
    candidates,
  });
  return { fingerprint, keep, candidates, snapshots: snapshots.size };
}

/** Cover retained keys with prefixes that cover no candidate, without removing their lock. */
export function retainedLockRules(prefix, keep, candidates) {
  const prefixes = new Set();
  for (const key of keep) {
    let length = prefix.length;
    while (candidates.some((candidate) => candidate.startsWith(key.slice(0, length)))) length++;
    prefixes.add(key.slice(0, length));
  }
  return sorted(prefixes).map((prefix, i) => ({
    id: `fnfe-gc-retained-${i}`,
    prefix,
    enabled: true,
    condition: { type: "Indefinite" },
  }));
}

/** Caller holds the bucket lease. Failures restoring lock rules retain that lease across crashes. */
export async function applyCollection({ plan, client, locks, expected, inventory, assertPaused }) {
  await assertPaused();
  const current = await inventory();
  fail(current.fingerprint === expected, "PLAN_CHANGED");
  if (!current.candidates.length) return { deletedObjects: 0 };
  const prefix = `${plan.prefix}objects/`,
    original = await locks.get();
  const broad = original.filter(
    (rule) => rule.enabled && rule.prefix === prefix && rule.condition?.type === "Indefinite",
  );
  fail(broad.length === 1, "PERMANENT_LOCK_MISSING");
  fail(!original.some((rule) => rule.id.startsWith("fnfe-gc-retained-")), "LOCK_RECOVERY_REQUIRED");
  const temporary = retainedLockRules(prefix, current.keep, current.candidates);
  fail(original.length + temporary.length <= 1000, "LOCK_RULE_LIMIT");
  const protectedRules = [...original, ...temporary];
  const selective = protectedRules.filter((rule) => rule.id !== broad[0].id);
  let deletedObjects = 0;
  let failure;
  try {
    // First add protection. Only then narrow the broad rule; crash leaves retained bytes locked.
    await locks.set(protectedRules);
    fail(rulesHash(await locks.get()) === rulesHash(protectedRules), "LOCK_VERIFY_FAILED");
    await assertPaused();
    fail((await inventory()).fingerprint === expected, "PLAN_CHANGED");
    await locks.set(selective);
    fail(rulesHash(await locks.get()) === rulesHash(selective), "LOCK_VERIFY_FAILED");
    for (const base of current.candidates) {
      await assertPaused();
      await client.delete(`${base}.age`);
      fail((await client.head(`${base}.age`)) === null, "DELETE_NOT_CONFIRMED");
      await client.delete(`${base}.json`);
      fail((await client.head(`${base}.json`)) === null, "DELETE_NOT_CONFIRMED");
      deletedObjects += 2;
    }
  } catch (error) {
    failure = error;
  }
  try {
    await locks.set(original);
    fail(rulesHash(await locks.get()) === rulesHash(original), "LOCK_VERIFY_FAILED");
  } catch {
    // An uncertain lock dominates the original failure: no writer may resume.
    const error = new Error("BACKUP_GC_LOCK_RECOVERY_REQUIRED");
    error.retainBackupLease = true;
    throw error;
  }
  if (failure) throw failure;
  return { deletedObjects };
}

/** The scoped token is consumed here; provider bodies and headers are never diagnostics. */
export function bucketLocks({ accountId, bucket, token, fetchImpl = fetch }) {
  fail(typeof token === "string" && token.length > 0, "LOCK_TOKEN_REQUIRED");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/lock`;
  async function request(method, rules) {
    const response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(rules ? { body: JSON.stringify({ rules }) } : {}),
    });
    fail(response.ok, "LOCK_API_FAILED");
    const body = await response.json();
    fail(body.success === true, "LOCK_API_FAILED");
    return body.result;
  }
  return {
    get: async () => {
      const result = await request("GET");
      fail(Array.isArray(result.rules), "LOCK_API_FAILED");
      return result.rules;
    },
    set: async (rules) => {
      await request("PUT", rules);
    },
  };
}
