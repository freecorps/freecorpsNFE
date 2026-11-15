import { createHash } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { internal, api } from "./_generated/api";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { PARSER_VERSION } from "../../packages/fiscal-nfe/src/index";
import { NFE_PARSER_VERSION } from "./lib/importValues";
import type { Id } from "./_generated/dataModel";
import { CAPTURE_TERMS_VERSION } from "./lib/fiscalCaptureRelease";
import { actor, documentsFixture } from "../../tests/helpers/documents";

/** Reprocessing technical refusals of an older parser into the NF-e history (#499). */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5190",
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-import-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("pins the parser the mutations compare to the NF-e package (#499)", () => {
  expect(NFE_PARSER_VERSION).toBe(PARSER_VERSION);
});

type DocumentsFixture = Awaited<ReturnType<typeof documentsFixture>>;
/**
 * A supported event original refused before #498, as `nfe-parser/4` did: the bytes of `fixture`
 * imported under a type the parser still refuses, then the artifact gets the supported bytes and
 * the version the older parser. `capture` turns the artifact into one received by the capture;
 * `keep` leaves the unsupported bytes, a type the current parser still refuses.
 */
async function olderRefusal(
  f: DocumentsFixture,
  fixture: string,
  { capture = false, keep = false } = {},
) {
  const unsupported = Buffer.from(xmlFixture(fixture).toString().replaceAll("112150", "110001"));
  const bytes = keep ? unsupported : xmlFixture(fixture);
  const refused = await f.importXml(unsupported);
  expect(refused.file).toMatchObject({ code: "XML_EVENT_UNSUPPORTED", documentId: null });
  const artifactId = refused.version.artifactId;
  await f.t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)]));
    await ctx.db.patch("documentArtifacts", artifactId, {
      storageId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(capture
        ? {
            source: "distribution-xml" as const,
            fileId: undefined,
            processingOperationId: refused.version.operationId,
          }
        : {}),
    });
    await ctx.db.patch("documentVersions", refused.version._id, { parserVersion: "nfe-parser/4" });
  });
  return { artifactId, version: refused.version };
}
async function refusalChildren(f: DocumentsFixture, run: string) {
  const records = await f.t.run((ctx) => ctx.db.query("idempotencyRecords").collect());
  return records.filter(
    (r) => r.name === "documents.reprocess_refusals" && r.key.startsWith(`${run}:`),
  );
}
async function eventsReceived(f: DocumentsFixture) {
  return f.t.run((ctx) =>
    ctx.db
      .query("operationalAudit")
      .withIndex("by_organizationId_and_action_and_createdAt", (q) =>
        q.eq("organizationId", f.scope.organizationId).eq("action", "document.event_received"),
      )
      .collect(),
  );
}
async function artifactVersions(f: DocumentsFixture, artifactId: Id<"documentArtifacts">) {
  return f.t.run((ctx) =>
    ctx.db
      .query("documentVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
      .collect(),
  );
}
/** Runs the operation's attempts, each at its persisted time, until it leaves the queue. */
async function drive(f: DocumentsFixture, operationId: Id<"operations">) {
  for (let n = 0; n < 30; n++) {
    const op = (await f.t.run((ctx) => ctx.db.get("operations", operationId)))!;
    if (!["queued", "retry_wait", "reconciling"].includes(op.state)) return op;
    if (op.nextAttemptAt > Date.now()) vi.setSystemTime(op.nextAttemptAt);
    await f.t.action(internal.operationWorker.run, { operationId, generation: op.generation });
  }
  throw new Error("operation did not settle");
}
async function driveChildren(f: DocumentsFixture, run: string) {
  const children = await refusalChildren(f, run);
  return Promise.all(children.map((child) => drive(f, child.operationId)));
}
/** The release state the approved workflow would leave (`captureRelease.set`). */
async function release(f: DocumentsFixture, released: boolean) {
  await f.t.run(async (ctx) => {
    const { organizationId, companyId } = f.scope;
    const prior = await ctx.db
      .query("captureReleases")
      .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
      .unique();
    const version = (prior?.version ?? 0) + 1;
    const fields = { organizationId, companyId, released, blocked: false, minIntervalHours: 1 };
    const eventId = await ctx.db.insert("captureReleaseEvents", {
      ...fields,
      version,
      kind: released ? "console_release" : "console_withdraw",
      ...(released ? { terms: CAPTURE_TERMS_VERSION } : {}),
      revokedKeys: 0,
      reason: "Liberação sintética da captura",
      buildSha: null,
      deployment: "",
      createdAt: Date.now(),
    });
    const state = {
      ...fields,
      releasedBefore: true,
      actor: "operator:freecorps",
      reason: "Liberação sintética da captura",
      version,
      updatedAt: Date.now(),
      eventId,
    };
    if (prior) await ctx.db.replace("captureReleases", prior._id, state);
    else await ctx.db.insert("captureReleases", state);
  });
}

it("reprocesses technical refusals of an older parser into the NF-e history, once (#499)", async () => {
  const f = await documentsFixture();
  const invoice = await f.importXml(xmlFixture("invoice-authorized"));
  const documentId = invoice.file.documentId as Id<"fiscalDocuments">;
  const imported = await olderRefusal(f, "event-112150");
  const captured = await olderRefusal(f, "event-summary-112150", { capture: true });
  // Refused before and still unsupported: reprocessed once, refused again.
  const still = await olderRefusal(f, "event-112150", { keep: true });
  // Refused by the current parser: reprocessing would only repeat it.
  const current = await f.importXml(
    Buffer.from(xmlFixture("event-112150").toString().replaceAll("112150", "110001")),
  );
  // Out of reach: another environment, another company of the organization, another organization.
  const production = await olderRefusal(f, "event-112150");
  const otherCompany = await olderRefusal(f, "event-summary-112150");
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...company } = (await ctx.db.get("companies", f.scope.companyId))!;
    const companyId = await ctx.db.insert("companies", { ...company, cnpj: "11444777000161" });
    await ctx.db.patch("documentArtifacts", production.artifactId, { environment: "production" });
    await ctx.db.patch("documentArtifacts", otherCompany.artifactId, { companyId });
  });
  const other = await documentsFixture(f.t);
  const foreign = await olderRefusal(other, "event-112150");
  const received = (await eventsReceived(f)).length;

  const owner = await actor(f.t, f.scope.organizationId, "owner");
  expect(await owner.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(true);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toBeNull();
  const run = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(run.reused).toBe(false);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: run.operationId,
    state: "queued",
    done: false,
    live: true,
    requested: 0,
  });
  // While the run is live, asking again returns it; two requests at once open one run.
  const [again, twin] = await Promise.all([
    owner.client.mutation(api.refusalReprocess.request, f.queryScope),
    owner.client.mutation(api.refusalReprocess.request, f.queryScope),
  ]);
  expect([again, twin]).toEqual([
    { operationId: run.operationId, reused: true },
    { operationId: run.operationId, reused: true },
  ]);
  const swept = await drive(f, run.operationId);
  expect(swept.state).toBe("succeeded");
  expect(JSON.parse(swept.response!)).toEqual({ requested: 3 });
  const children = await refusalChildren(f, run.operationId);
  expect(children.flatMap((r) => r.key.split(":").slice(1, 2)).sort()).toEqual(
    [imported.artifactId, captured.artifactId, still.artifactId].sort(),
  );
  // The children start one at a time, never all at once.
  const starts = await f.t.run((ctx) =>
    Promise.all(children.map(async (r) => (await ctx.db.get("operations", r.operationId))!)),
  );
  expect(new Set(starts.map((op) => op.nextAttemptAt)).size).toBe(3);
  // Finished searching is not finished reprocessing: with children pending, the run is still
  // live, and asking again returns it.
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    done: true,
    live: true,
    requested: 3,
    busy: 0,
    pending: 3,
    reprocessed: 0,
  });
  expect(await owner.client.mutation(api.refusalReprocess.request, f.queryScope)).toEqual({
    operationId: run.operationId,
    reused: true,
  });

  const tasks = await driveChildren(f, run.operationId);
  expect(tasks.map((t) => `${t.task.name}:${t.state}`).sort((a, b) => a.localeCompare(b))).toEqual([
    "documents.capture:succeeded",
    "documents.reprocess:succeeded",
    "documents.reprocess:succeeded",
  ]);
  for (const refusal of [imported, captured]) {
    const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", refusal.artifactId)))!;
    expect(artifact.documentId).toBe(documentId);
    // The earlier refusal stays in the artifact's history; the new interpretation joins the NF-e.
    expect(
      (await artifactVersions(f, refusal.artifactId)).map((v) => [
        v.code,
        v.parserVersion,
        v.documentId ?? null,
      ]),
    ).toEqual([
      ["XML_EVENT_UNSUPPORTED", "nfe-parser/4", null],
      ["IMPORTED", PARSER_VERSION, documentId],
    ]);
  }
  for (const kind of ["event", "event-summary"]) {
    const path = `/v1/documents/${documentId}/events`;
    expect((await (await f.get(path, `&kind=${kind}`)).json()).data.page).toHaveLength(1);
  }
  // As in the normal ingestion, the event (not its summary) notifies `document.event_received`.
  const notified = (await eventsReceived(f)).slice(received);
  expect(notified.map((row) => row.operationId)).toEqual([
    children.find((r) => r.key.endsWith(imported.artifactId))!.operationId,
  ]);
  expect(
    (await artifactVersions(f, still.artifactId)).map((v) => [v.parserVersion, v.documentId]),
  ).toEqual([
    ["nfe-parser/4", undefined],
    [PARSER_VERSION, undefined],
  ]);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    done: true,
    live: false,
    requested: 3,
    reprocessed: 2,
    stillRefused: 1,
    failed: 0,
    pending: 0,
    partial: false,
  });

  // Asking again after it finished opens a run that finds nothing left: no version, no webhook.
  const versionCount = (await f.t.run((ctx) => ctx.db.query("documentVersions").collect())).length;
  const admin = await actor(f.t, f.scope.organizationId, "admin");
  const next = await admin.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(next).toMatchObject({ reused: false });
  expect(JSON.parse((await drive(f, next.operationId)).response!)).toEqual({ requested: 0 });
  expect(await refusalChildren(f, next.operationId)).toEqual([]);
  expect(await admin.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: next.operationId,
    done: true,
    requested: 0,
  });
  expect(await refusalChildren(f, run.operationId)).toHaveLength(3);
  expect((await f.t.run((ctx) => ctx.db.query("documentVersions").collect())).length).toBe(
    versionCount,
  );
  expect((await eventsReceived(f)).length).toBe(received + 1);

  // What it must not reach keeps its single refused version and no document.
  for (const [fixture, artifactId] of [
    [f, current.version.artifactId],
    [f, production.artifactId],
    [f, otherCompany.artifactId],
    [other, foreign.artifactId],
  ] as const) {
    expect(await artifactVersions(fixture, artifactId)).toHaveLength(1);
    const artifact = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifactId)))!;
    expect(artifact.documentId).toBeUndefined();
  }
});

it("resumes the sweep from the persisted cursor after a lost lease, page by page (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const refusals = [
    await olderRefusal(f, "event-112150"),
    await olderRefusal(f, "event-summary-112150"),
    await olderRefusal(f, "event-112150", { keep: true }),
  ];
  // A leftover version of an operation that finished does not hold an original back; one of an
  // operation still working does.
  const leftover = await olderRefusal(f, "event-summary-112150", { keep: true });
  const busy = await olderRefusal(f, "event-112150", { keep: true });
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const run = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  await f.t.run(async (ctx) => {
    for (const [refusal, operationId] of [
      [leftover, leftover.version.operationId],
      [busy, run.operationId],
    ] as const) {
      const { _id, _creationTime, publishedAt: _published, ...version } = refusal.version;
      await ctx.db.insert("documentVersions", {
        ...version,
        operationId,
        state: "staging",
        entryIndex: 9,
      });
    }
  });
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: run.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: op._id, generation: op.generation, fence: op.fence };
  expect(await f.t.mutation(internal.operations.beginEffect, claim)).toBe(true);
  const first = await f.t.mutation(internal.refusalReprocess.sweep, { ...claim, pageSize: 2 });
  expect(first).toMatchObject({ kind: "page", done: false });
  const afterFirst = (await f.t.run((ctx) => ctx.db.get("operations", run.operationId)))!;
  expect(afterFirst.refusalSweep?.cursor).not.toBeNull();
  // The attempt is lost before its outcome: recovery reconciles from the cursor kept above.
  vi.setSystemTime(Date.now() + 61_000);
  await f.t.mutation(internal.operations.recoverOne, { operationId: run.operationId });
  expect((await f.t.run((ctx) => ctx.db.get("operations", run.operationId)))!.state).toBe(
    "reconciling",
  );
  const done = await drive(f, run.operationId);
  expect(done.state).toBe("succeeded");
  const children = await refusalChildren(f, run.operationId);
  const artifacts = children.flatMap((r) => r.key.split(":").slice(1, 2));
  expect(artifacts.sort()).toEqual(
    [...refusals.map((r) => r.artifactId), leftover.artifactId].sort(),
  );
  expect(JSON.parse(done.response!)).toEqual({ requested: 4 });
  expect(done.refusalSweep?.requested).toBe(4);
});

it("reads one page per attempt, waits for its children to start and counts partially (#499)", async () => {
  const f = await documentsFixture();
  const model = await olderRefusal(f, "event-112150", { keep: true });
  // 51 more originals refused by the older parser: two pages of the executor (50 each).
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...artifact } = (await ctx.db.get(
      "documentArtifacts",
      model.artifactId,
    ))!;
    const { _id: _v, _creationTime: _vc, ...version } = model.version;
    for (let n = 0; n < 51; n++) {
      const artifactId = await ctx.db.insert("documentArtifacts", artifact);
      await ctx.db.insert("documentVersions", {
        ...version,
        artifactId,
        parserVersion: "nfe-parser/4",
      });
    }
  });
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const run = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  const startedAt = Date.now();
  await f.t.action(internal.operationWorker.run, { operationId: run.operationId, generation: 1 });
  const waiting = (await f.t.run((ctx) => ctx.db.get("operations", run.operationId)))!;
  // A wait, not a failure: no attempt spent, the next page after the page's last child starts.
  expect(waiting).toMatchObject({ state: "retry_wait", code: "SWEEP_CONTINUES", attempts: 0 });
  expect(waiting.refusalSweep?.requested).toBe(50);
  expect(waiting.nextAttemptAt).toBeGreaterThanOrEqual(startedAt + 49 * 2_000);
  const firstPage = await refusalChildren(f, run.operationId);
  expect(firstPage).toHaveLength(50);
  const starts = await f.t.run((ctx) =>
    Promise.all(firstPage.map(async (r) => (await ctx.db.get("operations", r.operationId))!)),
  );
  const times = starts.map((op) => op.nextAttemptAt).sort((a, b) => a - b);
  expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(49 * 2_000);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    state: "retry_wait",
    done: false,
    requested: 50,
  });

  const done = await drive(f, run.operationId);
  expect(done.state).toBe("succeeded");
  expect(JSON.parse(done.response!)).toEqual({ requested: 52 });
  expect(await refusalChildren(f, run.operationId)).toHaveLength(52);

  // Past the 200 children the status reads, the counts are partial even with the sweep done.
  const pending = firstPage[0]!.operationId;
  await f.t.run(async (ctx) => {
    for (let n = 0; n < 150; n++)
      await ctx.db.insert("idempotencyRecords", {
        organizationId: f.scope.organizationId,
        projectId: done.projectId,
        name: "documents.reprocess_refusals",
        key: `${run.operationId}:extra${n}`,
        requestHash: done.requestHash,
        operationId: pending,
      });
  });
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    done: true,
    requested: 52,
    partial: true,
    pending: 200,
  });
});

it("opens a new run once the requester lost access mid-run (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const first = await olderRefusal(f, "event-112150");
  const second = await olderRefusal(f, "event-summary-112150");
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const runA = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  // The first page reprocesses one original; then the requester loses the role mid-run.
  const op = (await f.t.mutation(internal.operations.claim, {
    operationId: runA.operationId,
    generation: 1,
  }))!;
  const claim = { operationId: op._id, generation: op.generation, fence: op.fence };
  await f.t.mutation(internal.operations.beginEffect, claim);
  await f.t.mutation(internal.refusalReprocess.sweep, { ...claim, pageSize: 1 });
  await driveChildren(f, runA.operationId);
  await f.t.run((ctx) => ctx.db.patch("memberships", owner.membershipId, { role: "viewer" }));
  vi.setSystemTime(Date.now() + 61_000);
  await f.t.mutation(internal.operations.recoverOne, { operationId: runA.operationId });
  const stopped = await drive(f, runA.operationId);
  expect(stopped).toMatchObject({ state: "paused", code: "ACCESS_REVOKED" });
  // Paused for good: nobody can resume it, so it is not live.
  const admin = await actor(f.t, f.scope.organizationId, "admin");
  expect(await admin.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    live: false,
  });
  const runB = await admin.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(runB.reused).toBe(false);
  expect((await drive(f, runB.operationId)).state).toBe("succeeded");
  await driveChildren(f, runB.operationId);
  const reprocessed = [
    ...(await refusalChildren(f, runA.operationId)),
    ...(await refusalChildren(f, runB.operationId)),
  ].flatMap((r) => r.key.split(":").slice(1, 2));
  // Each original once, across both runs.
  expect(reprocessed.sort()).toEqual([first.artifactId, second.artifactId].sort());
  for (const refusal of [first, second])
    expect(await artifactVersions(f, refusal.artifactId)).toHaveLength(2);
  expect(await admin.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runB.operationId,
    done: true,
    reprocessed: 1,
  });
});

it("serves Production of the site while the release holds and after it is withdrawn (#499)", async () => {
  vi.stubEnv("FNFE_CAPTURE_FISCAL", "enabled");
  const f = await documentsFixture();
  await f.t.run((ctx) => ctx.db.patch("companies", f.scope.companyId, { kind: "declared" }));
  const first = await olderRefusal(f, "event-112150", { capture: true });
  const second = await olderRefusal(f, "event-summary-112150", { capture: true });
  await f.t.run(async (ctx) => {
    for (const refusal of [first, second])
      await ctx.db.patch("documentArtifacts", refusal.artifactId, { environment: "production" });
  });
  const production = { ...f.queryScope, environment: "production" as const };
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  // Never released: Production does not exist for the company.
  expect(await owner.client.query(api.refusalReprocess.canRequest, production)).toBe(false);
  await expect(owner.client.mutation(api.refusalReprocess.request, production)).rejects.toThrow();
  await expect(owner.client.query(api.refusalReprocess.status, production)).rejects.toThrow();

  await release(f, true);
  expect(await owner.client.query(api.refusalReprocess.canRequest, production)).toBe(true);
  const run = await owner.client.mutation(api.refusalReprocess.request, production);
  expect((await drive(f, run.operationId)).state).toBe("succeeded");
  // Withdrawn before the children run: what was received still becomes a document.
  await release(f, false);
  const tasks = await driveChildren(f, run.operationId);
  expect(tasks.map((t) => [t.task.name, t.state, t.environment])).toEqual([
    ["documents.capture", "succeeded", "production"],
    ["documents.capture", "succeeded", "production"],
  ]);
  const doc = (await f.t.run((ctx) => ctx.db.get("documentArtifacts", first.artifactId)))!;
  const fiscal = (await f.t.run((ctx) => ctx.db.get("fiscalDocuments", doc.documentId!)))!;
  expect(fiscal.environment).toBe("production");
  expect(await owner.client.query(api.refusalReprocess.status, production)).toMatchObject({
    done: true,
    reprocessed: 2,
  });
  expect(await owner.client.query(api.refusalReprocess.canRequest, production)).toBe(true);
  // After the withdrawal, a new request still opens a run, which finds nothing left.
  const again = await owner.client.mutation(api.refusalReprocess.request, production);
  expect(again.reused).toBe(false);
  expect(JSON.parse((await drive(f, again.operationId)).response!)).toEqual({ requested: 0 });
  // A viewer reads the status in Production and cannot ask.
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      membershipId: viewer.membershipId,
      companyId: f.scope.companyId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  expect(await viewer.client.query(api.refusalReprocess.canRequest, production)).toBe(false);
  expect(await viewer.client.query(api.refusalReprocess.status, production)).toMatchObject({
    operationId: again.operationId,
  });
});

it("lets only owner, admin and operator of the company ask for the reprocessing (#499)", async () => {
  const f = await documentsFixture();
  const other = await documentsFixture(f.t);
  for (const role of ["viewer", "developer"] as const) {
    const member = await actor(f.t, f.scope.organizationId, role);
    expect(await member.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(false);
    await expect(
      member.client.mutation(api.refusalReprocess.request, f.queryScope),
    ).rejects.toThrow();
  }
  // A member of another organization reaches neither this company nor its status.
  const stranger = await actor(f.t, other.scope.organizationId, "owner");
  await expect(
    stranger.client.mutation(api.refusalReprocess.request, f.queryScope),
  ).rejects.toThrow();
  await expect(stranger.client.query(api.refusalReprocess.status, f.queryScope)).rejects.toThrow();
  await expect(
    stranger.client.query(api.refusalReprocess.canRequest, f.queryScope),
  ).rejects.toThrow();
  // Its own organization with this company as selector is not a way in either.
  await expect(
    stranger.client.mutation(api.refusalReprocess.request, {
      ...f.queryScope,
      organizationId: other.scope.organizationId,
    }),
  ).rejects.toThrow();
  const operator = await actor(f.t, f.scope.organizationId, "operator");
  // An operator acts on the companies granted to it.
  expect(await operator.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(false);
  await expect(
    operator.client.mutation(api.refusalReprocess.request, f.queryScope),
  ).rejects.toThrow();
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      membershipId: operator.membershipId,
      companyId: f.scope.companyId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  expect(await operator.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(true);
  const run = await operator.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(run.reused).toBe(false);
  // Through the executor, with nothing to reprocess.
  await drive(f, run.operationId);
  expect(await operator.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    state: "succeeded",
    done: true,
    requested: 0,
    pending: 0,
  });
  const records = await f.t.run((ctx) => ctx.db.query("idempotencyRecords").collect());
  // The run's own reservation and the pointer of the company and environment, no child.
  expect(
    records.filter((r) => r.name === "documents.reprocess_refusals").map((r) => r.operationId),
  ).toEqual([run.operationId, run.operationId]);
});

it("lets a later run pick only the leftovers, and a resumed old run duplicate nothing (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const done = await olderRefusal(f, "event-112150");
  const stuck = await olderRefusal(f, "event-summary-112150");
  const byArtifact = await olderRefusal(f, "event-112150");
  const byFile = await olderRefusal(f, "event-112150");
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const runA = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  // Reprocessings asked elsewhere (REST, the capture) that have not written a version yet.
  const queued = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...op } = (await ctx.db.get("operations", runA.operationId))!;
    const id = await ctx.db.insert("operations", { ...op, nextAttemptAt: Date.now() + 3_600_000 });
    await ctx.db.patch("documentArtifacts", byArtifact.artifactId, { processingOperationId: id });
    const artifact = (await ctx.db.get("documentArtifacts", byFile.artifactId))!;
    await ctx.db.patch("importFiles", artifact.fileId!, { processingOperationId: id });
    return id;
  });
  expect((await drive(f, runA.operationId)).state).toBe("succeeded");
  // The two held originals are counted, not reprocessed.
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    requested: 2,
    busy: 2,
    live: true,
  });
  const childrenA = await refusalChildren(f, runA.operationId);
  expect(childrenA.flatMap((r) => r.key.split(":").slice(1, 2)).sort()).toEqual(
    [done.artifactId, stuck.artifactId].sort(),
  );
  // One child stops for good; the operation that held the other two fails.
  const stuckChild = childrenA.find((r) => r.key.endsWith(stuck.artifactId))!.operationId;
  await f.t.run(async (ctx) => {
    await ctx.db.patch("operations", stuckChild, {
      state: "paused",
      code: "ATTEMPTS_EXHAUSTED",
      attempts: 6,
    });
    await ctx.db.patch("operations", queued, { state: "failed", code: "TASK_FAILED" });
  });
  await drive(f, childrenA.find((r) => r.key.endsWith(done.artifactId))!.operationId);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    live: false,
    reprocessed: 1,
    failed: 1,
  });

  // A new run takes only what is left: the stuck original and the two no longer held.
  const runB = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(runB.reused).toBe(false);
  expect((await drive(f, runB.operationId)).state).toBe("succeeded");
  const childrenB = await refusalChildren(f, runB.operationId);
  expect(childrenB.flatMap((r) => r.key.split(":").slice(1, 2)).sort()).toEqual(
    [stuck.artifactId, byArtifact.artifactId, byFile.artifactId].sort(),
  );
  // Run A comes back (a resumption by hand) while B's children are live: it adds none.
  await f.t.run((ctx) =>
    ctx.db.patch("operations", runA.operationId, {
      state: "queued",
      stage: "ready",
      attempts: 0,
      response: undefined,
      refusalSweep: { cursor: null, requested: 2 },
      nextAttemptAt: Date.now(),
    }),
  );
  expect((await drive(f, runA.operationId)).state).toBe("succeeded");
  expect(await refusalChildren(f, runA.operationId)).toHaveLength(2);
  // Its second pass skips its own stuck original (its child exists) and finds the two others B
  // is handling: busy, not reprocessed.
  const resumed = (await f.t.run((ctx) => ctx.db.get("operations", runA.operationId)))!;
  expect(resumed.refusalSweep).toMatchObject({ requested: 2, busy: 2 });
  await driveChildren(f, runB.operationId);
  for (const refusal of [done, stuck, byArtifact, byFile])
    expect(await artifactVersions(f, refusal.artifactId)).toHaveLength(2);
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runB.operationId,
    reprocessed: 3,
    failed: 0,
    pending: 0,
  });
});

it("lets a reader follow the reprocessing without asking for it (#499)", async () => {
  const f = await documentsFixture();
  const viewer = await actor(f.t, f.scope.organizationId, "viewer");
  await f.t.run((ctx) =>
    ctx.db.insert("companyGrants", {
      organizationId: f.scope.organizationId,
      membershipId: viewer.membershipId,
      companyId: f.scope.companyId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: Date.now(),
    }),
  );
  expect(await viewer.client.query(api.refusalReprocess.canRead, f.queryScope)).toBe(true);
  expect(await viewer.client.query(api.refusalReprocess.canRequest, f.queryScope)).toBe(false);
  const developer = await actor(f.t, f.scope.organizationId, "developer");
  expect(await developer.client.query(api.refusalReprocess.canRead, f.queryScope)).toBe(false);
});

it("reports originals still held by an earlier operation instead of nothing left (#499)", async () => {
  const f = await documentsFixture();
  await f.importXml(xmlFixture("invoice-authorized"));
  const held = await olderRefusal(f, "event-112150");
  const owner = await actor(f.t, f.scope.organizationId, "owner");
  const runA = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect((await drive(f, runA.operationId)).state).toBe("succeeded");
  const [child] = await refusalChildren(f, runA.operationId);
  // A's child pauses by a person's hand: resumable, so A stays live and the console follows it.
  await f.t.run((ctx) =>
    ctx.db.patch("operations", child!.operationId, { state: "paused", code: "PAUSED_BY_USER" }),
  );
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runA.operationId,
    live: true,
    pending: 1,
  });
  expect(await owner.client.mutation(api.refusalReprocess.request, f.queryScope)).toEqual({
    operationId: runA.operationId,
    reused: true,
  });
  // Once nobody can resume the child, a new run opens; an outside operation holds the original.
  const outside = await f.t.run(async (ctx) => {
    await ctx.db.patch("operations", child!.operationId, {
      state: "failed",
      code: "TASK_FAILED",
    });
    const { _id, _creationTime, ...op } = (await ctx.db.get("operations", runA.operationId))!;
    const id = await ctx.db.insert("operations", { ...op, state: "queued" });
    await ctx.db.patch("documentArtifacts", held.artifactId, { processingOperationId: id });
    return id;
  });
  expect(outside).toBeTruthy();
  const runB = await owner.client.mutation(api.refusalReprocess.request, f.queryScope);
  expect(runB.reused).toBe(false);
  expect(JSON.parse((await drive(f, runB.operationId)).response!)).toEqual({ requested: 0 });
  expect(await owner.client.query(api.refusalReprocess.status, f.queryScope)).toMatchObject({
    operationId: runB.operationId,
    done: true,
    live: false,
    requested: 0,
    busy: 1,
  });
});
