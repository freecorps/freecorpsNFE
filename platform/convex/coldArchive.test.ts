import { beforeEach, expect, it, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import {
  platformTest,
  usePlatformEnvironment,
  issuerScope,
  person,
} from "../../tests/helpers/platform";
import {
  ARCHIVE_DAY,
  ARCHIVE_FENCE_TABLES,
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVE_TABLES,
  archiveHash,
  archiveRowJson,
  archiveStatus,
  assertOrganizationHot,
} from "./lib/coldArchiveCore";
import { fiscalGuardUntil, retentionClass } from "./lib/retentionClasses";
import { captureAudit } from "./lib/captureAttention";
import * as cold from "./coldArchive";

usePlatformEnvironment({
  siteUrl: "http://localhost:5196",
  convexSiteUrl: "http://127.0.0.1:3251",
  secret: "synthetic-cold-only",
  now: Date.UTC(2026, 9, 27, 12),
});
beforeEach(() => vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled"));

it("only issues capacity-drill upload URLs on the local development profile", async () => {
  const t = platformTest();
  expect(await t.mutation(internal.testing.coldArchiveProof.capacityUploadUrl, {})).toEqual(
    expect.any(String),
  );
  vi.stubEnv("APP_ENV", "installation");
  vi.stubEnv("SITE_URL", "https://synthetic.invalid");
  vi.stubEnv("CONVEX_SITE_URL", "https://synthetic-deployment.convex.site");
  vi.stubEnv("API_URL", "https://api.synthetic.invalid");
  vi.stubEnv("AUTH_PROXY_MODE", "signed");
  vi.stubEnv("AUTH_PROXY_SECRET", "a".repeat(64));
  vi.stubEnv("EMAIL_MODE", "disabled");
  await expect(t.mutation(internal.testing.coldArchiveProof.capacityUploadUrl, {})).rejects.toThrow(
    "Local synthetic proof only",
  );
});
async function fixture(closed = true) {
  const t = platformTest();
  const scope = await issuerScope(t, {
    keyHash: crypto.randomUUID(),
    kind: "demonstration",
    grantScopes: [],
    keyScopes: [],
  });
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["<NFe>arquivo sintético</NFe>"], { type: "application/xml" })),
  );
  const artifactId = await t.run((ctx) =>
    ctx.db.insert("documentArtifacts", {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      environment: "sandbox",
      storageId,
      sha256: "synthetic",
      size: 28,
      source: "imported-xml",
      importedAt: Date.now(),
    }),
  );
  await t.run(async (ctx) => {
    if (closed)
      await ctx.db.insert("organizationClosures", {
        organizationId: scope.organizationId,
        state: "purged",
        requestedAt: Date.now() - 40 * ARCHIVE_DAY,
        exportUntil: 0,
        purgeBy: 0,
        generation: 1,
        purgedAt: Date.now() - ARCHIVE_DAY,
      });
    else {
      await ctx.db.patch("organizations", scope.organizationId, {
        updatedAt: Date.now() - 100 * ARCHIVE_DAY,
      });
      await ctx.db.insert("usagePlans", {
        organizationId: scope.organizationId,
        catalogTier: "free",
        name: "Gratuito",
        startsAt: 0,
        endsAt: null,
        limits: { imports: 100, captures: 0, registry: 0, bytes: 1e8, deliveries: 0 },
        concurrency: 1,
        version: 1,
        updatedAt: Date.now() - 100 * ARCHIVE_DAY,
      });
      // A Production total: an open organization that only used Sandbox is never eligible.
      await ctx.db.insert("usageTotals", {
        organizationId: scope.organizationId,
        environment: "production",
        period: "2026-01",
        metric: "imports",
        committed: 1,
        reserved: 0,
        updatedAt: Date.now() - 100 * ARCHIVE_DAY,
        startedAt: Date.now() - 100 * ARCHIVE_DAY,
      });
    }
  });
  const runId = closed
    ? await t.mutation(internal.coldArchive.notice, {
        organizationId: scope.organizationId,
        key: "synthetic-run-001",
      })
    : await t.run((ctx) =>
        ctx.db.insert("coldArchiveRuns", {
          organizationId: scope.organizationId,
          key: "synthetic-run-001",
          reason: "free_inactive",
          planVersion: 1,
          state: "notice",
          version: 1,
          noticeAt: Date.now(),
          eligibleAt: Date.now() + 30 * ARCHIVE_DAY,
          retainUntil: Date.now() + 365 * 6 * ARCHIVE_DAY,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          phase: 0,
          cursor: null,
          rows: 0,
          files: 0,
          bytes: 0,
          digest: "",
        }),
      );
  const fence = { runId, version: 1 };
  const state = () => t.run((ctx) => archiveStatus(ctx, scope.organizationId));
  return { t, scope, storageId, artifactId, runId, fence, state };
}
async function scan(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.mutation(internal.coldArchive.freeze, f.fence);
  for (let i = 0; i < 100; i++) {
    const run = (await f.state())!;
    const step = JSON.parse(
      await f.t.mutation(internal.coldArchive.scan, {
        ...f.fence,
        phase: run.phase,
        cursor: run.cursor,
      }),
    );
    if (step.done) return;
  }
  throw new Error("scan did not complete");
}
async function prove(f: Awaited<ReturnType<typeof fixture>>) {
  await scan(f);
  await sealAndVerify(f);
}
async function sealAndVerify(f: Awaited<ReturnType<typeof fixture>>) {
  const run = (await f.state())!;
  const manifest = JSON.stringify({
    runId: run._id,
    organizationId: run.organizationId,
    version: 1,
    digest: run.digest,
    rows: run.rows,
    files: run.files,
    databaseBytes: run.bytes,
    fileBytes: 28,
    retainUntil: run.retainUntil,
  });
  await f.t.mutation(internal.coldArchive.seal, { ...f.fence, manifest });
  await f.t.mutation(internal.coldArchive.verified, {
    ...f.fence,
    manifestSha256: await archiveHash(manifest),
    verifierRunId: "synthetic-executor-001",
  });
}
it("classifies every fiscal model and exposes only administrative functions", () => {
  // The ID map is fiscal too, but only exists after a rehydration (ADR 0009, §6); packing it on a
  // later archiving is still open.
  expect([...ARCHIVE_TABLES, "coldArchiveIdMap"].sort()).toEqual(
    Object.entries(retentionClass)
      .filter(([, c]) => c === "fiscal")
      .map(([t]) => t)
      .sort(),
  );
  for (const fn of Object.values(cold)) expect(fn.isInternal).toBe(true);
});
it("seals only a package made with the current fiscal schema version", async () => {
  const f = await fixture();
  await scan(f);
  const run = (await f.state())!;
  const manifest = (schemaVersion: unknown) =>
    JSON.stringify({
      runId: run._id,
      organizationId: run.organizationId,
      version: 1,
      digest: run.digest,
      rows: run.rows,
      files: run.files,
      databaseBytes: run.bytes,
      fileBytes: 28,
      retainUntil: run.retainUntil,
      schemaVersion,
    });
  for (const version of [ARCHIVE_SCHEMA_VERSION + 1, 0])
    await expect(
      f.t.mutation(internal.coldArchive.seal, { ...f.fence, manifest: manifest(version) }),
    ).rejects.toThrow("ARCHIVE_MANIFEST_MISMATCH");
  await f.t.mutation(internal.coldArchive.seal, {
    ...f.fence,
    manifest: manifest(ARCHIVE_SCHEMA_VERSION),
  });
  expect((await f.state())?.state).toBe("sealed");
});
it("never deletes hot data without integral proof, rejects corrupt proof and fences writes", async () => {
  const f = await fixture();
  await scan(f);
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" }),
  ).rejects.toThrow("ARCHIVE_PROOF_REQUIRED");
  await expect(
    f.t.mutation(internal.coldArchive.verified, {
      ...f.fence,
      manifestSha256: "wrong",
      verifierRunId: "synthetic-executor",
    }),
  ).rejects.toThrow("ARCHIVE_PROOF_MISMATCH");
  await expect(
    f.t.run((ctx) => assertOrganizationHot(ctx, f.scope.organizationId)),
  ).rejects.toThrow("ORGANIZATION_ARCHIVED");
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", f.storageId))).not.toBeNull();
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", f.artifactId))).not.toBeNull();
});
it("freezes an open free account only after the notice: repeated notices are idempotent", async () => {
  const f = await fixture(false);
  expect((await f.state())?.state).toBe("notice");
  expect(
    await f.t.mutation(internal.coldArchive.notice, {
      organizationId: f.scope.organizationId,
      key: "synthetic-run-001",
    }),
  ).toBe(f.runId);
  await expect(
    f.t.mutation(internal.coldArchive.notice, {
      organizationId: f.scope.organizationId,
      key: "synthetic-run-002",
    }),
  ).rejects.toThrow("ARCHIVE_ALREADY_EXISTS");
  await f.t.run((ctx) => assertOrganizationHot(ctx, f.scope.organizationId));
  await expect(f.t.mutation(internal.coldArchive.freeze, f.fence)).rejects.toThrow(
    "ARCHIVE_NOTICE_PENDING",
  );
  // An open organization comes back by the rehydration under new IDs (ADR 0009, §5), so once
  // the notice ends it freezes like a closed one; nothing is closed.
  vi.advanceTimersByTime(30 * ARCHIVE_DAY);
  await f.t.mutation(internal.coldArchive.freeze, f.fence);
  expect((await f.state())?.state).toBe("frozen");
  await expect(
    f.t.run((ctx) => assertOrganizationHot(ctx, f.scope.organizationId)),
  ).rejects.toThrow("ORGANIZATION_ARCHIVED");
  expect(await f.t.run((ctx) => ctx.db.query("organizationClosures").first())).toBeNull();
  expect(
    await f.t.run((ctx) => ctx.db.get("organizations", f.scope.organizationId)),
  ).not.toBeNull();
});
it.each(["running", "reconciling", "queued", "failed"] as const)(
  "does not freeze capture/cancellation in %s with an uncertain response",
  async (state) => {
    const f = await fixture();
    const operationId = await f.t.run((ctx) =>
      ctx.db.insert("operations", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "sandbox",
        task: {
          name: "documents.cancel",
          workload: "issuance",
          scope: "documents:cancel",
          executor: "synthetic",
        },
        request: "{}",
        requestHash: "synthetic",
        projectEpoch: 0,
        grantEpoch: 0,
        state,
        stage: "calling",
        generation: 1,
        fence: 1,
        attempts: 1,
        maxAttempts: 3,
        leaseUntil: Date.now() + 1000,
        nextAttemptAt: 0,
        backoffMs: 1,
        jitterMs: 1,
        uncertain: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(f.t.mutation(internal.coldArchive.freeze, f.fence)).rejects.toThrow(
      "ARCHIVE_IN_FLIGHT",
    );
    expect((await f.state())?.state).toBe("notice");
    // A received fiscal response is still allowed to persist because freeze rolled back.
    await f.t.run(async (ctx) => {
      await assertOrganizationHot(ctx, f.scope.organizationId);
      await ctx.db.patch("operations", operationId, {
        response: "received",
        state: "succeeded",
        uncertain: false,
      });
    });
    await f.t.mutation(internal.coldArchive.freeze, f.fence);
  },
);
it("holds, expired proof and stale fence conserve originals", async () => {
  const f = await fixture();
  await prove(f);
  const holdId = await f.t.run((ctx) =>
    ctx.db.insert("retentionHolds", {
      organizationId: f.scope.organizationId,
      reference: "synthetic-hold",
      responsible: "synthetic",
      reviewAt: Date.now(),
      createdAt: Date.now(),
    }),
  );
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" }),
  ).rejects.toThrow("ARCHIVE_LEGAL_HOLD");
  await f.t.run((ctx) => ctx.db.patch("retentionHolds", holdId, { releasedAt: Date.now() }));
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, version: 2, kind: "file" }),
  ).rejects.toThrow("ARCHIVE_STALE_FENCE");
  vi.advanceTimersByTime(ARCHIVE_DAY + 1);
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" }),
  ).rejects.toThrow("ARCHIVE_PROOF_EXPIRED");
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", f.storageId))).not.toBeNull();
});
it("removes files and fiscal rows transactionally only after proof and repeats idempotently", async () => {
  const f = await fixture();
  await prove(f);
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" }),
  ).rejects.toThrow("ARCHIVE_FILES_FIRST");
  await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" });
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", f.storageId))).toBeNull();
  await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" });
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", f.artifactId))).toBeNull();
  expect((await f.state())?.state).toBe("archived");
  expect(await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" })).toBe(
    true,
  );
  await expect(f.t.mutation(internal.coldArchive.beginRestore, f.fence)).rejects.toThrow(
    "ARCHIVE_SAME_ORIGIN_RESTORE_UNSUPPORTED",
  );
  expect((await f.state())?.state).toBe("archived");
});
it("rejects a mutated row and a file shared by another organization", async () => {
  const f = await fixture();
  await prove(f);
  const other = await issuerScope(f.t, {
    keyHash: crypto.randomUUID(),
    kind: "demonstration",
    grantScopes: [],
    keyScopes: [],
  });
  await f.t.run(async (ctx) => {
    const original = (await ctx.db.get("documentArtifacts", f.artifactId))!;
    const { _id, _creationTime, ...fields } = original;
    await ctx.db.insert("documentArtifacts", {
      ...fields,
      organizationId: other.organizationId,
      projectId: other.projectId,
      companyId: other.companyId,
    });
  });
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" }),
  ).rejects.toThrow("ARCHIVE_SHARED_FILE");
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", f.storageId))).not.toBeNull();
});
it("denies unauthorized tenant reads and keeps other tenants hot", async () => {
  const f = await fixture();
  vi.advanceTimersByTime(30 * ARCHIVE_DAY);
  await scan(f);
  const other = await issuerScope(f.t, {
    keyHash: crypto.randomUUID(),
    kind: "demonstration",
    grantScopes: [],
    keyScopes: [],
  });
  const outsider = await person(f.t, other.organizationId, "owner");
  await expect(
    outsider.query(api.plans.overview, {
      asOf: Date.now(),
      organizationId: f.scope.organizationId,
      contextKey: "cold-test",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  await f.t.run((ctx) => assertOrganizationHot(ctx, other.organizationId));
});
it("hashes record content independently of insertion order", async () => {
  expect(await archiveHash(archiveRowJson({ a: 1, b: "ç" }))).toBe(
    await archiveHash(archiveRowJson({ b: "ç", a: 1 })),
  );
});

it("recent download/REST traffic invalidates free inactivity before freezing", async () => {
  const f = await fixture(false);
  vi.advanceTimersByTime(30 * ARCHIVE_DAY);
  await f.t.run((ctx) =>
    ctx.db.insert("capacityEvents", {
      organizationId: f.scope.organizationId,
      key: "synthetic-read",
      metric: "restReads",
      period: "2026-11",
      quantity: 1,
      remaining: 0,
      state: "committed",
      updatedAt: Date.now(),
    }),
  );
  await f.t.run((ctx) => ctx.db.delete("coldArchiveRuns", f.runId));
  await expect(
    f.t.mutation(internal.coldArchive.notice, {
      organizationId: f.scope.organizationId,
      key: "new-active-notice",
    }),
  ).rejects.toThrow("ARCHIVE_FREE_ACTIVE");
  expect(await f.state()).toBeNull();
});
it("a racing admission and freeze cannot both commit", async () => {
  const f = await fixture();
  vi.advanceTimersByTime(30 * ARCHIVE_DAY);
  const results = await Promise.allSettled([
    f.t.mutation(internal.coldArchive.freeze, f.fence),
    f.t.run(async (ctx) => {
      await assertOrganizationHot(ctx, f.scope.organizationId);
      return ctx.db.insert("usageLeases", {
        organizationId: f.scope.organizationId,
        key: "synthetic-admission",
        expiresAt: Date.now() + 60000,
      });
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const lease = await f.t.run((ctx) => ctx.db.query("usageLeases").first());
  expect((await f.state())?.state).toBe(lease ? "notice" : "frozen");
});
it("paid expiry starts the notice when the paid period ends, then 30 days of persisted notice", async () => {
  const f = await fixture(false);
  await f.t.run(async (ctx) => {
    await ctx.db.delete("coldArchiveRuns", f.runId);
    const plan = (await ctx.db.query("usagePlans").first())!;
    await ctx.db.patch("usagePlans", plan._id, {
      catalogTier: "intermediate",
      endsAt: Date.now() + ARCHIVE_DAY,
      version: 2,
    });
  });
  const args = { organizationId: f.scope.organizationId, key: "synthetic-paid-expiry" };
  await expect(f.t.mutation(internal.coldArchive.notice, args)).rejects.toThrow(
    "ARCHIVE_PAID_ACTIVE",
  );
  expect(await f.state()).toBeNull();
  vi.advanceTimersByTime(ARCHIVE_DAY);
  const runId = await f.t.mutation(internal.coldArchive.notice, args);
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await f.state()).toMatchObject({
    _id: runId,
    state: "notice",
    reason: "paid_expired",
    planVersion: 2,
    eligibleAt: Date.now() + 30 * ARCHIVE_DAY,
  });
  await expect(f.t.mutation(internal.coldArchive.freeze, { runId, version: 1 })).rejects.toThrow(
    "ARCHIVE_NOTICE_PENDING",
  );
  vi.advanceTimersByTime(30 * ARCHIVE_DAY);
  await f.t.mutation(internal.coldArchive.freeze, { runId, version: 1 });
  expect((await f.state())?.state).toBe("frozen");
});
it("keeps changed fiscal rows hot even after an administrative proof", async () => {
  const f = await fixture();
  await prove(f);
  // Simulates an administrative write bypassing the normal frozen access guard.
  await f.t.run((ctx) => ctx.db.patch("documentArtifacts", f.artifactId, { size: 999 }));
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" }),
  ).rejects.toThrow("ARCHIVE_ROW_CHANGED");
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", f.artifactId))).not.toBeNull();
});
it("legacy verification checks original IDs and invalidates inventory without allowing reactivation", async () => {
  const f = await fixture();
  await prove(f);
  await f.t.run(async (ctx) => {
    await ctx.db.patch("coldArchiveRuns", f.runId, { state: "restoring" });
    await ctx.db.insert("capacityAccounts", {
      organizationId: f.scope.organizationId,
      ready: true,
      phase: 100,
      cursor: null,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("retentionHolds", {
      organizationId: f.scope.organizationId,
      reviewAt: Date.now(),
      createdAt: Date.now(),
    });
  });
  // Existing legacy state can still be inspected; no executor may begin same-origin restore.
  await expect(f.t.mutation(internal.coldArchive.beginRestore, f.fence)).rejects.toThrow(
    "ARCHIVE_SAME_ORIGIN_RESTORE_UNSUPPORTED",
  );
  await expect(
    f.t.mutation(internal.coldArchive.verifyRestoredBatch, {
      ...f.fence,
      version: 2,
      cursor: null,
    }),
  ).rejects.toThrow("ARCHIVE_STALE_FENCE");
  expect(
    JSON.parse(await f.t.query(internal.coldArchive.restoreRemaining, { ...f.fence, cursor: null }))
      .missing,
  ).toEqual([]);
  const result = JSON.parse(
    await f.t.mutation(internal.coldArchive.verifyRestoredBatch, { ...f.fence, cursor: null }),
  );
  expect(result.done).toBe(true);
  expect((await f.state())?.restoredAt).toBe(Date.now());
  await expect(
    f.t.run((ctx) => assertOrganizationHot(ctx, f.scope.organizationId)),
  ).rejects.toThrow("ORGANIZATION_ARCHIVED");
  const cost = await f.t.query(internal.coldArchive.catalogueCost, {
    runId: f.runId,
    cursor: null,
  });
  expect(cost).toMatchObject({ rowEntries: 1, fileEntries: 1, isDone: true });
  expect(cost.runBytes).toBeGreaterThan(500);
  expect(cost.entryBytes).toBeGreaterThan(500);
});

it.each(["frozen", "verified", "deleting"] as const)(
  "removes an open %s run only with the proof, as a closed one (ADR 0009, §5)",
  async (state) => {
    const f = await fixture();
    await prove(f);
    await f.t.run(async (ctx) => {
      const closure = (await ctx.db.query("organizationClosures").first())!;
      await ctx.db.delete("organizationClosures", closure._id);
      await ctx.db.patch("coldArchiveRuns", f.runId, {
        state,
        reason: "free_inactive",
        ...(state === "frozen" ? { verifiedAt: undefined } : {}),
      });
    });
    if (state === "frozen") {
      // No proof, nothing leaves.
      for (const kind of ["file", "row"] as const)
        await expect(
          f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind }),
        ).rejects.toThrow("ARCHIVE_PROOF_REQUIRED");
      expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", f.artifactId))).not.toBeNull();
      expect(await f.t.run((ctx) => ctx.db.system.get("_storage", f.storageId))).not.toBeNull();
      expect((await f.state())?.state).toBe(state);
      return;
    }
    // An open organization is not read for eligibility again: from `frozen` on, nothing reopens
    // it by itself, and it comes back by the rehydration under new IDs.
    for (const kind of ["file", "row"] as const)
      await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind });
    expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", f.artifactId))).toBeNull();
    expect(await f.t.run((ctx) => ctx.db.system.get("_storage", f.storageId))).toBeNull();
    expect((await f.state())?.state).toBe("archived");
  },
);
it("rechecks the real closure even when an old run says closed", async () => {
  const f = await fixture();
  await prove(f);
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db.query("organizationClosures").first())!;
    await ctx.db.patch("organizationClosures", closure._id, { state: "closing" });
  });
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" }),
  ).rejects.toThrow("ARCHIVE_CLOSURE_NOT_ELIGIBLE");
  expect(await f.t.run((ctx) => ctx.db.system.get("_storage", f.storageId))).not.toBeNull();
});

/** The minimal fence of ADR 0009, §3: numbering and capture rows (synthetic) stay hot. */
async function fenceRows(f: Awaited<ReturnType<typeof fixture>>, sequences = 1) {
  return f.t.run(async (ctx) => {
    const streamId = await ctx.db.insert("captureStreams", {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      companyId: f.scope.companyId,
      environment: "production",
      identity: "synthetic-identity",
      service: "nfe-distribution",
      state: "active",
      version: 3,
      checkpoint: "000000000000042",
      mode: "distNSU",
      nextAllowedAt: Date.now(),
      received: 42,
      createdAt: Date.now(),
    });
    const sequenceIds = [];
    for (let i = 0; i < sequences; i++)
      sequenceIds.push(
        await ctx.db.insert("dpsSequences", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          environment: "production",
          series: String(900 + i),
          last: 17 + i,
          updatedAt: Date.now(),
        }),
      );
    for (const key of [
      `captureStreams:${streamId}`,
      ...sequenceIds.map((id) => `dpsSequences:${id}`),
    ])
      await ctx.db.insert("capacityRecords", {
        organizationId: f.scope.organizationId,
        key,
        size: 321,
      });
    return { streamId, sequenceIds };
  });
}
function fenceInventory(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.run(async (ctx) =>
    (
      await ctx.db
        .query("capacityRecords")
        .withIndex("by_organizationId_and_key", (q) =>
          q.eq("organizationId", f.scope.organizationId),
        )
        .collect()
    )
      .filter(({ key }) => ARCHIVE_FENCE_TABLES.some((table) => key.startsWith(`${table}:`)))
      .map(({ _id, key, size }) => ({ _id, key, size })),
  );
}
type Materialized = { kind: string; originalId: string; sha256: string; json?: string };
async function materialized(f: Awaited<ReturnType<typeof fixture>>) {
  const items: Materialized[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = JSON.parse(
      await f.t.query(internal.coldArchive.materialize, { runId: f.runId, cursor }),
    ) as { page: Materialized[]; isDone: boolean; continueCursor: string };
    items.push(...page.page);
    if (page.isDone) return items;
    cursor = page.continueCursor;
  }
}
it("packs the numbering and capture fence with its scan snapshot, even after a write in custody", async () => {
  const f = await fixture();
  const fence = await fenceRows(f);
  const sequenceId = fence.sequenceIds[0]!;
  const before = await f.t.run(async (ctx) => ({
    stream: archiveRowJson((await ctx.db.get("captureStreams", fence.streamId))!),
    sequence: archiveRowJson((await ctx.db.get("dpsSequences", sequenceId))!),
  }));
  await scan(f);
  const entries = await f.t.run((ctx) =>
    ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", f.runId))
      .collect(),
  );
  const stream = entries.find((e) => e.originalId === fence.streamId);
  const sequence = entries.find((e) => e.originalId === sequenceId);
  expect(stream).toMatchObject({ kind: "row", table: "captureStreams", snapshot: before.stream });
  expect(stream?.sha256).toBe(await archiveHash(before.stream));
  expect(sequence).toMatchObject({ kind: "row", table: "dpsSequences", snapshot: before.sequence });
  expect(sequence?.sha256).toBe(await archiveHash(before.sequence));
  // Only the fence carries a snapshot; every other row is reread and compared by hash.
  expect(entries.filter((e) => e.snapshot !== undefined)).toHaveLength(2);
  expect((await f.state())?.rows).toBe(3);
  // Withdrawing the capture release in custody runs the normal stop (`stopProductionStream`):
  // the stream is paused and a fiscal audit row is written after the scan.
  const auditId = await f.t.run(async (ctx) => {
    const current = (await ctx.db.get("captureStreams", fence.streamId))!;
    await ctx.db.patch("captureStreams", current._id, {
      state: "paused",
      version: current.version + 1,
      code: "CAPTURE_RELEASE_WITHDRAWN",
    });
    await captureAudit(ctx, current, "release_withdrawn");
    return (await ctx.db
      .query("captureAudit")
      .withIndex("by_streamId", (q) => q.eq("streamId", current._id))
      .unique())!._id;
  });
  // The package still gets the scan's rows, hash for hash, for the isolated restore.
  const items = await materialized(f);
  const rows = items.filter((i) => i.kind === "row");
  expect(rows).toHaveLength(3);
  expect(rows.find((i) => i.originalId === fence.streamId)?.json).toBe(before.stream);
  expect(rows.find((i) => i.originalId === sequenceId)?.json).toBe(before.sequence);
  for (const row of rows) expect(await archiveHash(row.json!)).toBe(row.sha256);
  expect(items.some((i) => i.originalId === auditId)).toBe(false);
  await sealAndVerify(f);
  await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" });
  expect(await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" })).toBe(
    true,
  );
  expect((await f.state())?.state).toBe("archived");
  const after = await f.t.run(async (ctx) => ({
    artifact: await ctx.db.get("documentArtifacts", f.artifactId),
    stream: await ctx.db.get("captureStreams", fence.streamId),
    sequence: await ctx.db.get("dpsSequences", sequenceId),
    audit: await ctx.db.get("captureAudit", auditId),
  }));
  expect(after.artifact).toBeNull();
  // The fence keeps its IDs and its current state, including the write after the scan.
  expect(after.stream).toMatchObject({ _id: fence.streamId, state: "paused", version: 4 });
  expect(after.sequence && archiveRowJson(after.sequence)).toBe(before.sequence);
  // The audit row written after the scan is outside the package and stays hot, still pointing at
  // the hot stream; the next cycle's scan packs it.
  expect(after.audit).toMatchObject({ streamId: fence.streamId, action: "release_withdrawn" });
});
it("removes in resumable batches, never deleting the fence nor its capacity inventory", async () => {
  const f = await fixture();
  // The artifact and eleven fence rows: more than one batch of eight.
  const fence = await fenceRows(f, 10);
  const fenceIds: string[] = [fence.streamId, ...fence.sequenceIds];
  const inventory = await fenceInventory(f);
  expect(inventory).toHaveLength(11);
  await prove(f);
  await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" });
  expect(await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" })).toBe(
    false,
  );
  // An interrupted executor resumes from the catalogue; the fence is untouched in between.
  expect((await f.state())?.state).toBe("deleting");
  expect(await fenceInventory(f)).toEqual(inventory);
  for (let i = 0; i < 3; i++)
    expect(
      await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" }),
    ).toBe(true);
  expect((await f.state())?.state).toBe("archived");
  const kept = await f.t.run(async (ctx) => [
    (await ctx.db.get("captureStreams", fence.streamId))?._id,
    ...(await Promise.all(
      fence.sequenceIds.map(async (id) => (await ctx.db.get("dpsSequences", id))?._id),
    )),
  ]);
  expect(kept).toEqual(fenceIds);
  expect(await fenceInventory(f)).toEqual(inventory);
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", f.artifactId))).toBeNull();
  const pending = await f.t.run((ctx) =>
    ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId_and_removed", (q) => q.eq("runId", f.runId).eq("removed", false))
      .collect(),
  );
  expect(pending).toEqual([]);
  // The legacy diagnostics see a changed fence row as present, never missing or conflicting.
  await f.t.run(async (ctx) => {
    await ctx.db.patch("coldArchiveRuns", f.runId, { state: "restoring" });
    const stream = (await ctx.db.get("captureStreams", fence.streamId))!;
    await ctx.db.patch("captureStreams", stream._id, { version: stream.version + 1 });
  });
  const missing: string[] = JSON.parse(
    await f.t.query(internal.coldArchive.restoreRemaining, { ...f.fence, cursor: null }),
  ).missing;
  expect(missing.sort()).toEqual([String(f.artifactId), String(f.storageId)].sort());
});
it("stops the removal when a fence row is gone, deleting nothing of that batch", async () => {
  const f = await fixture();
  const fence = await fenceRows(f);
  await prove(f);
  await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" });
  await f.t.run((ctx) => ctx.db.delete("captureStreams", fence.streamId));
  await expect(
    f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" }),
  ).rejects.toThrow("ARCHIVE_FENCE_MISSING");
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", f.artifactId))).not.toBeNull();
});

/** An archived run: proven, files and rows removed (ADR 0009, §4 starts here). */
async function archive(f: Awaited<ReturnType<typeof fixture>>) {
  await prove(f);
  await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" });
  for (let i = 0; i < 20; i++)
    if (await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" }))
      return;
  throw new Error("removal did not complete");
}
const hex = (c: string) => c.repeat(64);
async function catalogManifest(
  f: Awaited<ReturnType<typeof fixture>>,
  change: Record<string, unknown> = {},
) {
  const run = (await f.state())!;
  return JSON.stringify({
    format: "fnfe-cold-archive-catalog/1",
    runId: run._id,
    organizationId: run.organizationId,
    version: run.version,
    packageManifestSha256: run.manifestSha256,
    entries: run.rows + run.files,
    rows: run.rows,
    files: run.files,
    retainUntil: run.retainUntil,
    prefix: "synthetic/cold/",
    objectKey: `synthetic/cold/${run._id}/catalog.jsonl.age`,
    plaintextSha256: hex("a"),
    plaintextBytes: 100,
    ciphertextSha256: hex("b"),
    ciphertextBytes: 300,
    recipientSetSha256: hex("c"),
    ...change,
  });
}
const hotEntries = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.t.run((ctx) =>
    ctx.db
      .query("coldArchiveEntries")
      .withIndex("by_runId", (q) => q.eq("runId", f.runId))
      .collect(),
  );
it("compacts the catalogue only after the verified manifest is recorded on an archived run", async () => {
  const f = await fixture();
  await fenceRows(f, 70);
  await prove(f);
  // Before `archived`, nothing is recorded nor deleted.
  await expect(
    f.t.mutation(internal.coldArchive.catalogVerified, {
      ...f.fence,
      manifest: await catalogManifest(f),
    }),
  ).rejects.toThrow("ARCHIVE_NOT_ARCHIVED");
  await expect(f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).rejects.toThrow(
    "ARCHIVE_CATALOG_UNVERIFIED",
  );
  await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "file" });
  for (let i = 0; i < 20; i++)
    if (await f.t.mutation(internal.coldArchive.removeHotBatch, { ...f.fence, kind: "row" })) break;
  expect((await f.state())?.state).toBe("archived");
  const total = (await hotEntries(f)).length;
  expect(total).toBe(73);
  // Archived but not verified: the deletion refuses and every entry stays.
  await expect(f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).rejects.toThrow(
    "ARCHIVE_CATALOG_UNVERIFIED",
  );
  expect(await hotEntries(f)).toHaveLength(total);
  const manifest = await catalogManifest(f);
  await expect(
    f.t.mutation(internal.coldArchive.catalogVerified, { ...f.fence, version: 2, manifest }),
  ).rejects.toThrow("ARCHIVE_STALE_FENCE");
  await f.t.mutation(internal.coldArchive.catalogVerified, { ...f.fence, manifest });
  // Repeating the same manifest is a no-op; another one never replaces it.
  await f.t.mutation(internal.coldArchive.catalogVerified, { ...f.fence, manifest });
  await expect(
    f.t.mutation(internal.coldArchive.catalogVerified, {
      ...f.fence,
      manifest: await catalogManifest(f, { plaintextBytes: 101 }),
    }),
  ).rejects.toThrow("ARCHIVE_CATALOG_IMMUTABLE");
  expect((await f.state())?.catalog).toMatchObject({
    state: "verified",
    manifestSha256: await archiveHash(manifest),
    entries: total,
    removed: 0,
  });
  // The first batch deletes 64; an interrupted executor resumes from the count on the run.
  expect(await f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).toBe(false);
  expect((await f.state())?.catalog).toMatchObject({ state: "compacting", removed: 64 });
  expect(await hotEntries(f)).toHaveLength(total - 64);
  // Partial entries: nobody may read them as the whole catalogue any more.
  await expect(
    f.t.query(internal.coldArchive.entries, { runId: f.runId, cursor: null }),
  ).rejects.toThrow("ARCHIVE_CATALOG_COMPACTED");
  expect(await f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).toBe(true);
  expect(await hotEntries(f)).toEqual([]);
  expect((await f.state())?.catalog).toMatchObject({
    state: "compacted",
    removed: total,
    compactedAt: Date.now(),
  });
  expect(await f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).toBe(true);
  const cost = await f.t.query(internal.coldArchive.catalogueCost, {
    runId: f.runId,
    cursor: null,
  });
  expect(cost).toMatchObject({ entryBytes: 0, catalogState: "compacted", isDone: true });
  // Only the run and the fence stay hot; the package manifest did not change.
  const run = (await f.state())!;
  expect(run.manifestSha256).toBe(await archiveHash(run.manifest!));
  expect(await f.t.run((ctx) => ctx.db.query("captureStreams").collect())).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("dpsSequences").collect())).toHaveLength(70);
});
it.each([
  ["entries", { entries: 3 }],
  ["rows", { rows: 0, entries: 1 }],
  ["package", { packageManifestSha256: hex("d") }],
  ["run", { runId: "other" }],
  ["version", { version: 2 }],
  ["format", { format: "fnfe-cold-archive/1" }],
  ["cipher", { ciphertextSha256: "nope" }],
  ["size", { ciphertextBytes: 0 }],
] as const)("refuses a catalogue manifest with a different %s", async (_name, change) => {
  const f = await fixture();
  await archive(f);
  await expect(
    f.t.mutation(internal.coldArchive.catalogVerified, {
      ...f.fence,
      manifest: await catalogManifest(f, change),
    }),
  ).rejects.toThrow("ARCHIVE_CATALOG_MISMATCH");
  expect((await f.state())?.catalog).toBeUndefined();
  expect(await hotEntries(f)).toHaveLength(2);
});
it("refuses the deletion when the hot entries do not match the verified count", async () => {
  const f = await fixture();
  await archive(f);
  await f.t.mutation(internal.coldArchive.catalogVerified, {
    ...f.fence,
    manifest: await catalogManifest(f),
  });
  // An extra entry the object does not have: nothing of the batch goes.
  const extra = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...fields } = (await ctx.db.query("coldArchiveEntries").first())!;
    return ctx.db.insert("coldArchiveEntries", { ...fields, originalId: "synthetic-extra" });
  });
  await expect(f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).rejects.toThrow(
    "ARCHIVE_CATALOG_COUNT_MISMATCH",
  );
  expect(await hotEntries(f)).toHaveLength(3);
  // One short of the object: the last batch refuses and rolls back.
  await f.t.run(async (ctx) => {
    await ctx.db.delete("coldArchiveEntries", extra);
    const entry = (await ctx.db.query("coldArchiveEntries").first())!;
    await ctx.db.delete("coldArchiveEntries", entry._id);
  });
  await expect(f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).rejects.toThrow(
    "ARCHIVE_CATALOG_COUNT_MISMATCH",
  );
  expect(await hotEntries(f)).toHaveLength(1);
  expect((await f.state())?.catalog?.state).toBe("verified");
});
it("refuses the legacy restore diagnostics of a compacted run instead of reading it as restored", async () => {
  const f = await fixture();
  await archive(f);
  await f.t.mutation(internal.coldArchive.catalogVerified, {
    ...f.fence,
    manifest: await catalogManifest(f),
  });
  expect(await f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).toBe(true);
  await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", f.runId, { state: "restoring" }));
  await expect(
    f.t.query(internal.coldArchive.restoreRemaining, { ...f.fence, cursor: null }),
  ).rejects.toThrow("ARCHIVE_CATALOG_COMPACTED");
  await expect(
    f.t.mutation(internal.coldArchive.verifyRestoredBatch, { ...f.fence, cursor: null }),
  ).rejects.toThrow("ARCHIVE_CATALOG_COMPACTED");
});
it("keeps the hot catalogue under a legal hold", async () => {
  const f = await fixture();
  await archive(f);
  await f.t.mutation(internal.coldArchive.catalogVerified, {
    ...f.fence,
    manifest: await catalogManifest(f),
  });
  await f.t.run((ctx) =>
    ctx.db.insert("retentionHolds", {
      organizationId: f.scope.organizationId,
      reference: "synthetic-hold",
      responsible: "synthetic",
      reviewAt: Date.now(),
      createdAt: Date.now(),
    }),
  );
  await expect(f.t.mutation(internal.coldArchive.compactCatalogBatch, f.fence)).rejects.toThrow(
    "ARCHIVE_LEGAL_HOLD",
  );
  expect(await hotEntries(f)).toHaveLength(2);
});

/** An open organization's run in `state` with a sealed package dated like the run. */
async function sealedOpen(state: "notice" | "frozen" | "archived" | "restoring" | "hot") {
  const f = await fixture(false);
  const retainUntil = fiscalGuardUntil(Date.now());
  await f.t.run((ctx) =>
    ctx.db.patch("coldArchiveRuns", f.runId, {
      state,
      retainUntil,
      ...(state === "notice" || state === "frozen"
        ? {}
        : { manifest: JSON.stringify({ retainUntil }) }),
    }),
  );
  return { ...f, retainUntil };
}
it("renews an open archived package's custody from today, only forward and only while archived", async () => {
  const f = await sealedOpen("archived");
  const retention = () =>
    f.t.query(internal.coldArchive.retention, { runId: f.runId, now: Date.now() });
  // Archived this year: the guard from today is the sealed date, so nothing moves yet.
  expect(await retention()).toEqual({
    version: 1,
    retainUntil: f.retainUntil,
    target: f.retainUntil,
  });
  vi.setSystemTime(Date.UTC(2027, 10, 3, 12));
  const { target } = await retention();
  expect(target).toBe(fiscalGuardUntil(Date.now()));
  expect(target).toBeGreaterThan(f.retainUntil);
  // Never back, never past today's target, never with a stale fence.
  for (const retainUntil of [f.retainUntil - 1, target + 1])
    await expect(
      f.t.mutation(internal.coldArchive.renewRetention, {
        ...f.fence,
        now: Date.now(),
        retainUntil,
      }),
    ).rejects.toThrow("ARCHIVE_RETENTION_MISMATCH");
  await expect(
    f.t.mutation(internal.coldArchive.renewRetention, {
      ...f.fence,
      now: Date.now(),
      version: 2,
      retainUntil: target,
    }),
  ).rejects.toThrow("ARCHIVE_STALE_FENCE");
  // A legal hold keeps the package longer; it never blocks a renewal.
  await f.t.run((ctx) =>
    ctx.db.insert("retentionHolds", {
      organizationId: f.scope.organizationId,
      reference: "synthetic-hold",
      responsible: "synthetic",
      reviewAt: Date.now(),
      createdAt: Date.now(),
    }),
  );
  await f.t.mutation(internal.coldArchive.renewRetention, {
    ...f.fence,
    now: Date.now(),
    retainUntil: target,
  });
  await f.t.mutation(internal.coldArchive.renewRetention, {
    ...f.fence,
    now: Date.now(),
    retainUntil: target,
  });
  const run = (await f.state())!;
  expect(run.retainUntil).toBe(target);
  expect(run.retentionRenewedAt).toBe(Date.now());
  // The sealed manifest keeps its date.
  expect(JSON.parse(run.manifest!).retainUntil).toBe(f.retainUntil);
});
it("honors the executor's clock up to an hour ahead when the year turns", async () => {
  const f = await sealedOpen("archived");
  const midnight = Date.UTC(2027, 0, 1, 3); // 1 January 2027, 00:00 in Brasília.
  const renew = async (now: number) => {
    const { target } = await f.t.query(internal.coldArchive.retention, { runId: f.runId, now });
    expect(target).toBe(fiscalGuardUntil(now));
    return f.t.mutation(internal.coldArchive.renewRetention, {
      ...f.fence,
      now,
      retainUntil: target,
    });
  };
  // Two hours early on the server: an executor already in 2027 is refused.
  vi.setSystemTime(midnight - 2 * 3_600_000);
  await expect(renew(midnight + 60_000)).rejects.toThrow("ARCHIVE_RETENTION_MISMATCH");
  // A minute early: the executor two minutes ahead gets the 2027 target R2 already holds.
  vi.setSystemTime(midnight - 60_000);
  await renew(midnight + 60_000);
  expect((await f.state())!.retainUntil).toBe(fiscalGuardUntil(midnight));
});
it("refuses a renewal without a package or after the rehydration", async () => {
  for (const [state, code] of [
    ["notice", "ARCHIVE_NOT_SEALED"],
    ["frozen", "ARCHIVE_NOT_SEALED"],
    ["hot", "ARCHIVE_ORGANIZATION_HOT"],
  ] as const) {
    const f = await sealedOpen(state);
    await expect(
      f.t.query(internal.coldArchive.retention, { runId: f.runId, now: Date.now() }),
    ).rejects.toThrow(code);
    await expect(
      f.t.mutation(internal.coldArchive.renewRetention, {
        ...f.fence,
        now: Date.now(),
        retainUntil: f.retainUntil,
      }),
    ).rejects.toThrow(code);
  }
  const f = await sealedOpen("restoring");
  expect(
    (await f.t.query(internal.coldArchive.retention, { runId: f.runId, now: Date.now() })).target,
  ).toBe(f.retainUntil);
});
it("counts a closed run's custody from its closure and never extends it past that", async () => {
  const f = await fixture();
  await archive(f);
  vi.setSystemTime(Date.UTC(2028, 5, 1, 12));
  const run = (await f.state())!;
  expect(
    await f.t.query(internal.coldArchive.retention, { runId: f.runId, now: Date.now() }),
  ).toEqual({
    version: 1,
    retainUntil: run.retainUntil,
    target: run.retainUntil,
  });
  await expect(
    f.t.mutation(internal.coldArchive.renewRetention, {
      ...f.fence,
      now: Date.now(),
      retainUntil: fiscalGuardUntil(Date.now()),
    }),
  ).rejects.toThrow("ARCHIVE_RETENTION_MISMATCH");
});
it("moves an archived open organization's custody to its closure guard when it is closed", async () => {
  const f = await sealedOpen("archived");
  const closedAt = Date.UTC(2028, 2, 1, 12);
  vi.setSystemTime(closedAt);
  await f.t.run((ctx) =>
    ctx.db.insert("organizationClosures", {
      organizationId: f.scope.organizationId,
      state: "closing",
      requestedAt: closedAt,
      exportUntil: 0,
      purgeBy: 0,
      generation: 1,
    }),
  );
  // Later renewals stop at the closure's guard instead of following today.
  vi.setSystemTime(Date.UTC(2031, 5, 1, 12));
  expect(
    (await f.t.query(internal.coldArchive.retention, { runId: f.runId, now: Date.now() })).target,
  ).toBe(fiscalGuardUntil(closedAt));
});
it("lists the packages to renew and compacts a renewed run against its sealed date", async () => {
  const f = await fixture();
  await archive(f);
  const sealed = (await f.state())!.retainUntil;
  const due = (before: number) => f.t.query(internal.coldArchive.renewalDue, { before });
  expect(await due(sealed)).toEqual([]);
  expect(await due(sealed + 1)).toEqual([{ runId: f.runId, retainUntil: sealed }]);
  // A renewal between `archived` and the compaction: the catalogue still carries the sealed date.
  await f.t.run((ctx) =>
    ctx.db.patch("coldArchiveRuns", f.runId, { retainUntil: sealed + 365 * ARCHIVE_DAY }),
  );
  await expect(
    f.t.mutation(internal.coldArchive.catalogVerified, {
      ...f.fence,
      manifest: await catalogManifest(f),
    }),
  ).rejects.toThrow("ARCHIVE_CATALOG_MISMATCH");
  await f.t.mutation(internal.coldArchive.catalogVerified, {
    ...f.fence,
    manifest: await catalogManifest(f, { retainUntil: sealed }),
  });
});
