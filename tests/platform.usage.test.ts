/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { api, internal, components } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import {
  reserveUsage,
  commitUsage,
  releaseUsage,
  recordUsage,
  totalFor,
  acquireUsageLease,
  releaseUsageLease,
  rateUsage,
} from "../platform/convex/lib/usageCore";
import { usagePeriod } from "../platform/convex/lib/usageValues";
import { retryImportAdmission } from "../platform/convex/lib/importAdmission";
import { ConvexError } from "convex/values";
import type { Id } from "../platform/convex/_generated/dataModel";

const modules = import.meta.glob("../platform/convex/**/*.ts");
it("admission retries a lost commit response with the same intent and never reserves twice", async () => {
  const f = await fixture();
  await f.plan();
  const key = await hashApiKey(`fnfe_${"b".repeat(43)}`);
  const args = {
    keyHash: key,
    environment: "sandbox",
    path: "/v1/imports",
    method: "POST",
    key: "response-lost",
    body: JSON.stringify({
      companyId: f.scope.companyId,
      files: [{ name: "nota.xml", size: 10, sha256: "a".repeat(64) }],
    }),
  };
  let calls = 0;
  const result = await retryImportAdmission(async () => {
    const admitted = await f.t.mutation(internal.importRest.dispatch, args);
    if (++calls === 1) throw new Error("Synthetic response loss after commit");
    return JSON.parse(admitted) as { reused: boolean };
  });
  expect(calls).toBe(2);
  expect(result.reused).toBe(true);
  expect(await f.total()).toMatchObject({ reserved: 1, committed: 0 });
  expect(await f.total("bytes")).toMatchObject({ reserved: 10, committed: 0 });
  expect(await f.t.run((ctx) => ctx.db.query("imports").collect())).toHaveLength(1);
});
it("admission does not retry domain errors and caps technical retries at one", async () => {
  for (const code of ["QUOTA_EXCEEDED", "PLAN_INACTIVE", "NOT_FOUND", "INVALID_FILE"]) {
    const admit = vi.fn().mockRejectedValue(new ConvexError({ code }));
    await expect(retryImportAdmission(admit)).rejects.toThrow();
    expect(admit).toHaveBeenCalledTimes(1);
  }
  const unavailable = vi.fn().mockRejectedValue(new Error("Synthetic transport failure"));
  await expect(retryImportAdmission(unavailable)).rejects.toThrow();
  expect(unavailable).toHaveBeenCalledTimes(2);
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5199",
    CONVEX_SITE_URL: "http://127.0.0.1:3257",
    BETTER_AUTH_SECRET: "synthetic-usage-test-only",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const secret = `fnfe_${"b".repeat(43)}`;
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secret),
    suffix: crypto.randomUUID(),
  });
  async function plan(
    imports: number | null = 1,
    endsAt: number | null = Date.now() + 86400000,
    expectedVersion = 0,
  ) {
    return t.mutation(internal.usage.assignPlan, {
      organizationId: scope.organizationId,
      name: "Plano de teste",
      startsAt: Date.now() - 1,
      endsAt,
      limits: { imports, bytes: 100, captures: 2, registry: 1, deliveries: 1 },
      concurrency: 1,
      actor: "local-test",
      reason: "Synthetic proof",
      expectedVersion,
    });
  }
  async function reserve(key: string, size = 10) {
    return t.fetch("/v1/imports", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Environment": "sandbox",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        companyId: scope.companyId,
        files: [{ name: "nota.xml", size, sha256: "a".repeat(64) }],
      }),
    });
  }
  const total = (
    metric: "imports" | "bytes" | "documents" | "attempts" | "registry" | "captures" = "imports",
    period = usagePeriod(Date.now()),
    environment: "sandbox" | "production" = "sandbox",
  ) => t.run((ctx) => totalFor(ctx, scope.organizationId, environment, period, metric));
  return { t, scope, plan, reserve, total };
}
/** A Better Auth session of an active owner in the fixture's organization. */
async function owner(f: Awaited<ReturnType<typeof fixture>>) {
  const now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pessoa sintética",
        email: `${crypto.randomUUID()}@development.invalid`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await f.t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId: f.scope.organizationId,
      authUserId: user._id,
      name: user.name,
      email: user.email,
      role: "owner",
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  return f.t.withIdentity({ subject: user._id, sessionId: session._id });
}
it("reserves the last commercial unit through HTTP, reuses intent and refuses the next request", async () => {
  const f = await fixture();
  await f.plan();
  expect((await f.reserve("one")).status).toBe(200);
  expect((await f.reserve("one")).status).toBe(200);
  const denied = await f.reserve("two");
  expect(denied.status).toBe(429);
  expect((await denied.json()).error).toMatchObject({ code: "RATE_LIMITED", retryable: false });
  expect(await f.total()).toMatchObject({ committed: 0, reserved: 1 });
  expect(await f.total("bytes")).toMatchObject({ committed: 0, reserved: 10 });
});
it("rolls back every reservation when the bytes quota cannot admit a batch", async () => {
  const f = await fixture();
  await f.plan(10);
  expect((await f.reserve("too-large", 101)).status).toBe(429);
  expect(await f.total()).toBeNull();
  expect(await f.total("bytes")).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.query("imports").collect())).toHaveLength(0);
});
it("rolls back files, balances and jobs when the final technical budget refuses admission", async () => {
  const f = await fixture();
  await f.plan(10);
  for (let i = 0; i < 20; i++)
    await f.t.run((ctx) =>
      rateUsage(ctx, f.scope.organizationId, f.scope.keyId, {
        name: "organization-imports",
        rate: 20,
      }),
    );
  const jobsBefore = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const args = {
    keyHash: await hashApiKey(`fnfe_${"b".repeat(43)}`),
    environment: "sandbox",
    path: "/v1/imports",
    method: "POST",
    key: "final-budget",
    body: JSON.stringify({
      companyId: f.scope.companyId,
      files: [
        { name: "a.xml", size: 5, sha256: "a".repeat(64) },
        { name: "b.xml", size: 7, sha256: "b".repeat(64) },
      ],
    }),
  };
  await expect(f.t.mutation(internal.importRest.dispatch, args)).rejects.toThrow("RATE_LIMITED");
  for (const table of [
    "imports",
    "importFiles",
    "usageEvents",
    "usageTotals",
    "importMaintenance",
  ] as const)
    expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toHaveLength(0);
  expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(
    jobsBefore,
  );
  vi.setSystemTime(Date.now() + 60_000);
  await f.t.mutation(internal.importRest.dispatch, args);
  expect(await f.total()).toMatchObject({ reserved: 2, committed: 0 });
  expect(await f.total("bytes")).toMatchObject({ reserved: 12, committed: 0 });
});
it("expires abandoned upload reservations and permits another intention", async () => {
  const f = await fixture();
  await f.plan(1, Date.now() + 86400000 * 3);
  const response = await f.reserve("first");
  const batch = (await response.json()).data;
  vi.setSystemTime(Date.now() + 86400001);
  await f.t.mutation(internal.imports.expire, { importId: batch.importId });
  await f.t.run((ctx) =>
    ctx.db.patch("apiKeys", f.scope.keyId, { expiresAt: Date.now() + 3600000 }),
  );
  expect(await f.total()).toMatchObject({ reserved: 0, committed: 0 });
  expect((await f.reserve("next")).status).toBe(200);
});
it("cancelling a console import releases the quota; the console cannot release an integration's", async () => {
  const f = await fixture();
  await f.plan();
  const person = await owner(f);
  // ADR 0005: a person's batch belongs to the console project, which the console can cancel.
  const batch = await person.mutation(api.imports.reserve, {
    organizationId: f.scope.organizationId,
    companyId: f.scope.companyId,
    environment: "sandbox",
    key: "console-cancel",
    files: [{ name: "nota.xml", size: 10, sha256: "c".repeat(64) }],
  });
  expect(await f.total()).toMatchObject({ reserved: 1, committed: 0 });
  expect((await f.reserve("while-full")).status).toBe(429);
  await person.mutation(api.imports.cancel, { fileId: batch.fileIds[0]! });
  expect(await f.total()).toMatchObject({ reserved: 0, committed: 0 });
  expect(await f.total("bytes")).toMatchObject({ reserved: 0, committed: 0 });
  const file = await f.t.run((ctx) => ctx.db.get("importFiles", batch.fileIds[0]!));
  expect(file?.state).toBe("expired");
  // The released unit is admitted again, now by the integration's key.
  const integration = await f.reserve("after-cancel");
  expect(integration.status).toBe(200);
  expect(await f.total()).toMatchObject({ reserved: 1, committed: 0 });
  const { fileIds } = (await integration.json()).data as { fileIds: Id<"importFiles">[] };
  await expect(person.mutation(api.imports.cancel, { fileId: fileIds[0]! })).rejects.toThrow(
    "INTEGRATION_RECORD",
  );
  expect(await f.total()).toMatchObject({ reserved: 1, committed: 0 });
});
it("commits once in the reservation month, releases excess bytes and never resets committed usage", async () => {
  const f = await fixture();
  await f.plan();
  await f.t.run((ctx) =>
    reserveUsage(ctx, f.scope.organizationId, "sandbox", "bytes", "capture", 100),
  );
  vi.setSystemTime(new Date("2026-10-01T01:00:00Z"));
  await f.t.run((ctx) => commitUsage(ctx, f.scope.organizationId, "bytes", "capture", 25));
  await f.t.run((ctx) => commitUsage(ctx, f.scope.organizationId, "bytes", "capture", 25));
  await f.t.run((ctx) => releaseUsage(ctx, f.scope.organizationId, "bytes", "capture"));
  expect(await f.total("bytes", "2026-09")).toMatchObject({ committed: 25, reserved: 0 });
  expect(await f.total("bytes")).toBeNull();
});
it("plan expiry blocks a new request but not a reserved intent or its authorized read", async () => {
  const f = await fixture();
  await f.plan(1, Date.now() + 1000);
  const response = await f.reserve("existing");
  const batch = (await response.json()).data;
  vi.setSystemTime(Date.now() + 1001);
  expect((await f.reserve("new")).status).toBe(403);
  expect((await f.reserve("existing")).status).toBe(200);
  const read = await f.t.fetch(`/v1/imports/${batch.importId}`, {
    headers: { Authorization: `Bearer fnfe_${"b".repeat(43)}`, "X-Environment": "sandbox" },
  });
  expect(read.status).toBe(200);
  await f.t.run((ctx) => commitUsage(ctx, f.scope.organizationId, "imports", batch.fileIds[0]));
  expect(await f.total()).toMatchObject({ committed: 1, reserved: 0 });
});
it("persists plan audit, rejects stale edits and keeps usage when the limit changes", async () => {
  const f = await fixture();
  await f.plan();
  await f.reserve("one");
  await expect(f.plan(10)).rejects.toThrow("OPERATION_CONFLICT");
  await f.plan(0, Date.now() + 10000, 1);
  expect(await f.total()).toMatchObject({ reserved: 1 });
  expect((await f.reserve("new")).status).toBe(429);
  expect(await f.t.run((ctx) => ctx.db.query("usagePlanAudit").collect())).toHaveLength(2);
});
it("scope and revocation are checked before revealing usage or deduplicated imports", async () => {
  const f = await fixture();
  await f.plan();
  await f.reserve("one");
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other",
    suffix: "other",
  });
  await f.t.run((ctx) =>
    ctx.db.patch("apiKeys", f.scope.keyId, { organizationId: other.organizationId }),
  );
  expect((await f.reserve("one")).status).toBe(401);
  await expect(
    f.t.query(api.usage.overview, {
      organizationId: f.scope.organizationId,
      period: "2026-09",
      contextKey: "test",
    }),
  ).rejects.toThrow();
});
it("commercial usage is scoped to the organization and document duplicates do not multiply it", async () => {
  const f = await fixture();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other",
    suffix: "other",
  });
  for (const organizationId of [
    f.scope.organizationId,
    f.scope.organizationId,
    other.organizationId,
  ])
    await f.t.run((ctx) =>
      recordUsage(ctx, organizationId, "sandbox", "documents", "same-logical-key", 1, true),
    );
  expect(await f.total("documents")).toMatchObject({ committed: 1 });
  expect(
    await f.t.run((ctx) => totalFor(ctx, other.organizationId, "sandbox", "2026-09", "documents")),
  ).toMatchObject({ committed: 1 });
});
it("technical attempts remain measurable when the plan is expired", async () => {
  const f = await fixture();
  await f.plan(0, Date.now() + 1);
  vi.setSystemTime(Date.now() + 2);
  await f.t.run((ctx) =>
    recordUsage(ctx, f.scope.organizationId, "sandbox", "attempts", "attempt:1", 1, true),
  );
  await f.t.run((ctx) =>
    recordUsage(ctx, f.scope.organizationId, "sandbox", "attempts", "attempt:2", 1, true),
  );
  expect(await f.total("attempts")).toMatchObject({ committed: 2 });
  expect(await f.total()).toBeNull();
});
it("rate limits each key independently and then caps their shared organization", async () => {
  const f = await fixture();
  const second = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...key } = (await ctx.db.get("apiKeys", f.scope.keyId))!;
    void _id;
    void _creationTime;
    return ctx.db.insert("apiKeys", { ...key, keyHash: "second-key" });
  });
  const admit = (keyId: Id<"apiKeys">) =>
    f.t.run((ctx) => rateUsage(ctx, f.scope.organizationId, keyId));
  for (let i = 0; i < 60; i++) await admit(f.scope.keyId);
  await expect(admit(f.scope.keyId)).rejects.toThrow("RATE_LIMITED");
  for (let i = 0; i < 60; i++) await admit(second);
  await expect(f.t.run((ctx) => rateUsage(ctx, f.scope.organizationId))).rejects.toThrow(
    "RATE_LIMITED",
  );
  vi.setSystemTime(Date.now() + 1000);
  await expect(admit(f.scope.keyId)).resolves.toBeNull();
});
it("leases limit one organization's concurrency, expire, and do not block another organization", async () => {
  const f = await fixture();
  await f.plan();
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other",
    suffix: "other",
  });
  const acquire = (organizationId: Id<"organizations">, key: string) =>
    f.t.run((ctx) => acquireUsageLease(ctx, organizationId, key, Date.now() + 1000));
  expect(await acquire(f.scope.organizationId, "one")).toBe(true);
  expect(await acquire(f.scope.organizationId, "two")).toBe(false);
  expect(await acquire(other.organizationId, "one")).toBe(true);
  await f.t.run((ctx) => releaseUsageLease(ctx, f.scope.organizationId, "one"));
  expect(await acquire(f.scope.organizationId, "two")).toBe(true);
  vi.setSystemTime(Date.now() + 1001);
  expect(await acquire(f.scope.organizationId, "three")).toBe(true);
});
it("only owners/admins read organization-wide consumption, and a removed membership loses access", async () => {
  const f = await fixture();
  const now = Date.now();
  const user = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Synthetic",
        email: "usage@development.invalid",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const session = await f.t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        expiresAt: now + 3600000,
        token: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  const member = await f.t.run((ctx) =>
    ctx.db.insert("memberships", {
      organizationId: f.scope.organizationId,
      authUserId: user._id,
      name: "Synthetic",
      email: user.email,
      role: "viewer",
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    }),
  );
  const human = f.t.withIdentity({ subject: user._id, sessionId: session._id });
  const args = { organizationId: f.scope.organizationId, period: "2026-09", contextKey: "test" };
  await expect(human.query(api.usage.overview, args)).rejects.toThrow("ACCESS_DENIED");
  await f.t.run((ctx) => ctx.db.patch("memberships", member, { role: "admin" }));
  expect((await human.query(api.usage.overview, args)).rows).toHaveLength(8);
  await f.t.run((ctx) => ctx.db.delete("memberships", member));
  await expect(human.query(api.usage.overview, args)).rejects.toThrow("ACCESS_DENIED");
});

// #429: each environment has its own balance under the same plan limits.
it("sandbox and production keep separate balances under the same plan limit", async () => {
  const f = await fixture();
  await f.plan();
  expect((await f.reserve("sandbox-one")).status).toBe(200);
  const full = await f.reserve("sandbox-two");
  expect(full.status).toBe(429);
  expect((await full.json()).error).toMatchObject({ code: "RATE_LIMITED", retryable: false });
  // The sandbox has no unit left; production still has the plan's whole limit.
  await f.t.run((ctx) =>
    reserveUsage(ctx, f.scope.organizationId, "production", "imports", "production-file"),
  );
  const refused = await f.t
    .run((ctx) =>
      reserveUsage(ctx, f.scope.organizationId, "production", "imports", "production-next"),
    )
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ConvexError);
  expect((refused as ConvexError<Record<string, string>>).data).toMatchObject({
    code: "QUOTA_EXCEEDED",
    metric: "imports",
    environment: "production",
    period: "2026-09",
  });
  expect(await f.total("imports")).toMatchObject({ reserved: 1, committed: 0 });
  expect(await f.total("imports", "2026-09", "production")).toMatchObject({ reserved: 1 });
});
it("a limit reached in production does not refuse a sandbox import through REST", async () => {
  const f = await fixture();
  await f.plan();
  await f.t.run((ctx) =>
    recordUsage(ctx, f.scope.organizationId, "production", "imports", "production-file"),
  );
  expect((await f.reserve("sandbox-after-production")).status).toBe(200);
  expect(await f.total("imports")).toMatchObject({ reserved: 1, committed: 0 });
  expect(await f.total("imports", "2026-09", "production")).toMatchObject({ committed: 1 });
});
it("commit and release follow the event's environment, and a key cannot change environment", async () => {
  const f = await fixture();
  await f.t.run((ctx) =>
    reserveUsage(ctx, f.scope.organizationId, "production", "bytes", "file", 30),
  );
  await f.t.run((ctx) => commitUsage(ctx, f.scope.organizationId, "bytes", "file", 12));
  expect(await f.total("bytes", "2026-09", "production")).toMatchObject({
    committed: 12,
    reserved: 0,
  });
  expect(await f.total("bytes")).toBeNull();
  await expect(
    f.t.run((ctx) => reserveUsage(ctx, f.scope.organizationId, "sandbox", "bytes", "file", 30)),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

/**
 * Usage recorded before #429, without environment: events whose keys name a sandbox import, a
 * production import and a record that no longer exists, and one total per metric that sums them.
 */
async function legacyUsage(f: Awaited<ReturnType<typeof fixture>>) {
  return f.t.run(async (ctx) => {
    const file = async (environment: "sandbox" | "production") => {
      const importId = await ctx.db.insert("imports", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment,
        key: `legacy-${environment}`,
        requestHash: "a".repeat(64),
        createdAt: Date.now(),
      });
      return String(
        await ctx.db.insert("importFiles", {
          importId,
          position: 0,
          name: "nota.xml",
          size: 10,
          sha256: "a".repeat(64),
          state: "reserved",
          expiresAt: Date.now() + 3600000,
        }),
      );
    };
    const sandbox = await file("sandbox");
    const production = await file("production");
    const released = await file("production");
    const event = (
      metric: "imports" | "bytes" | "documents",
      key: string,
      state: "reserved" | "committed" | "released",
      quantity = 1,
    ) =>
      ctx.db.insert("usageEvents", {
        organizationId: f.scope.organizationId,
        metric,
        key,
        period: "2026-09",
        quantity,
        state,
        createdAt: Date.UTC(2026, 8, 2),
        updatedAt: Date.UTC(2026, 8, 2),
      });
    await event("imports", sandbox, "reserved");
    await event("bytes", sandbox, "reserved", 10);
    await event("imports", production, "committed");
    await event("imports", released, "released");
    await event("documents", "record-that-is-gone", "committed");
    for (const [metric, committed, reserved] of [
      ["imports", 1, 1],
      ["bytes", 0, 10],
      ["documents", 1, 0],
    ] as const)
      await ctx.db.insert("usageTotals", {
        organizationId: f.scope.organizationId,
        period: "2026-09",
        metric,
        committed,
        reserved,
        startedAt: Date.UTC(2026, 8, 1),
        updatedAt: Date.UTC(2026, 8, 2),
      });
    return { sandbox, production, released };
  });
}
const usageRows = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.t.run(async (ctx) => ({
    events: await ctx.db.query("usageEvents").collect(),
    totals: await ctx.db.query("usageTotals").collect(),
  }));
async function backfill(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await f.t.mutation(internal.usageMigration.backfillEnvironment, { cursor: null });
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  return first;
}
it("an unattributed total counts against both environments until the backfill", async () => {
  const f = await fixture();
  await f.plan(2);
  await legacyUsage(f);
  // Two legacy import units may belong to either environment: neither admits a third.
  for (const environment of ["sandbox", "production"] as const)
    await expect(
      f.t.run((ctx) => reserveUsage(ctx, f.scope.organizationId, environment, "imports", "new")),
    ).rejects.toThrow("QUOTA_EXCEEDED");
  await backfill(f);
  for (const environment of ["sandbox", "production"] as const)
    await f.t.run((ctx) =>
      reserveUsage(ctx, f.scope.organizationId, environment, "imports", `new-${environment}`),
    );
});
it("the backfill attributes legacy usage by its record, keeps the balances and is idempotent", async () => {
  const f = await fixture();
  const { sandbox } = await legacyUsage(f);
  // A legacy reservation committed before the backfill stays on the unattributed total.
  await f.t.run((ctx) => commitUsage(ctx, f.scope.organizationId, "imports", sandbox));
  expect(await f.total("imports")).toBeNull();
  expect(
    await f.t.run((ctx) => totalFor(ctx, f.scope.organizationId, undefined, "2026-09", "imports")),
  ).toMatchObject({ committed: 2, reserved: 0 });
  expect(await backfill(f)).toEqual({ scanned: 5, attributed: 5, unresolved: 1, isDone: true });
  const after = await usageRows(f);
  expect(after.events.every((event) => event.environment)).toBe(true);
  expect(
    Object.fromEntries(
      after.events.map((event) => [`${event.metric}:${event.key}`, event.environment]),
    ),
  ).toMatchObject({
    [`imports:${sandbox}`]: "sandbox",
    [`bytes:${sandbox}`]: "sandbox",
    "documents:record-that-is-gone": "production",
  });
  const start = Date.UTC(2026, 8, 1);
  expect(
    after.totals
      .map(({ environment, metric, committed, reserved, startedAt }) => ({
        environment,
        metric,
        committed,
        reserved,
        startedAt,
      }))
      .sort((a, b) => `${a.metric}:${a.environment}`.localeCompare(`${b.metric}:${b.environment}`)),
  ).toEqual([
    { environment: "sandbox", metric: "bytes", committed: 0, reserved: 10, startedAt: start },
    { environment: "production", metric: "documents", committed: 1, reserved: 0, startedAt: start },
    { environment: "production", metric: "imports", committed: 1, reserved: 0, startedAt: start },
    { environment: "sandbox", metric: "imports", committed: 1, reserved: 0, startedAt: start },
  ]);
  // Repeating changes nothing.
  expect(await backfill(f)).toEqual({ scanned: 5, attributed: 0, unresolved: 0, isDone: true });
  expect(await usageRows(f)).toEqual(after);
  // A legacy reservation released after the backfill leaves its environment's total.
  await f.t.run((ctx) => releaseUsage(ctx, f.scope.organizationId, "bytes", sandbox));
  expect(await f.total("bytes")).toMatchObject({ committed: 0, reserved: 0 });
});
it("the overview shows each environment, flags unattributed usage and keeps the summed rows", async () => {
  const f = await fixture();
  const person = await owner(f);
  await legacyUsage(f);
  await f.t.run((ctx) =>
    recordUsage(ctx, f.scope.organizationId, "sandbox", "imports", "sandbox-new"),
  );
  const args = { organizationId: f.scope.organizationId, period: "2026-09", contextKey: "test" };
  const imports = (rows: { metric: string; committed: number; reserved: number }[]) =>
    rows.find((row) => row.metric === "imports");
  const before = await person.query(api.usage.overview, args);
  expect(before.unattributed).toBe(true);
  expect(imports(before.environments.sandbox)).toMatchObject({ committed: 2, reserved: 1 });
  expect(imports(before.environments.production)).toMatchObject({ committed: 1, reserved: 1 });
  expect(imports(before.rows)).toMatchObject({ committed: 2, reserved: 1 });
  await backfill(f);
  const after = await person.query(api.usage.overview, args);
  expect(after.unattributed).toBe(false);
  expect(imports(after.environments.sandbox)).toMatchObject({ committed: 1, reserved: 1 });
  expect(imports(after.environments.production)).toMatchObject({ committed: 1, reserved: 0 });
  expect(imports(after.rows)).toMatchObject({ committed: 2, reserved: 1 });
});
it("only owners and admins read the usage of either environment, never another organization's", async () => {
  const f = await fixture();
  const person = await owner(f);
  const membership = await f.t.run(async (ctx) =>
    (await ctx.db.query("memberships").collect()).find((m) => m.name === "Pessoa sintética")!,
  );
  const args = { organizationId: f.scope.organizationId, period: "2026-09", contextKey: "test" };
  for (const role of ["viewer", "operator", "developer"] as const) {
    await f.t.run((ctx) => ctx.db.patch("memberships", membership._id, { role }));
    await expect(person.query(api.usage.overview, args)).rejects.toThrow("ACCESS_DENIED");
  }
  for (const role of ["admin", "owner"] as const) {
    await f.t.run((ctx) => ctx.db.patch("memberships", membership._id, { role }));
    const overview = await person.query(api.usage.overview, args);
    expect(overview.environments.sandbox).toHaveLength(8);
    expect(overview.environments.production).toHaveLength(8);
  }
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: "other",
    suffix: "other",
  });
  await expect(
    person.query(api.usage.overview, { ...args, organizationId: other.organizationId }),
  ).rejects.toThrow();
});

// #429: a plan without an end (the permanent free tier). Its quotas stay monthly in UTC.
it("a plan without an end stays in force for years, keeps its limit and never carries a quota over", async () => {
  const f = await fixture();
  await f.plan(1, null);
  const reserve = (key: string) =>
    f.t.run((ctx) => reserveUsage(ctx, f.scope.organizationId, "sandbox", "imports", key));
  await reserve("september");
  await expect(reserve("september-again")).rejects.toThrow("QUOTA_EXCEEDED");
  for (const day of ["2026-10-01T00:00:00Z", "2027-01-01T00:00:00Z", "2031-06-15T12:00:00Z"]) {
    vi.setSystemTime(new Date(day));
    // The new month has exactly one unit: the earlier months' unused units do not accumulate.
    await reserve(`first-${day}`);
    await expect(reserve(`second-${day}`)).rejects.toThrow("QUOTA_EXCEEDED");
    expect(await f.total()).toMatchObject({ reserved: 1, committed: 0 });
  }
  expect(await f.total("imports", "2026-09")).toMatchObject({ reserved: 1 });
});
it("a plan without an end that has not started is not in force", async () => {
  const f = await fixture();
  await f.t.mutation(internal.usage.assignPlan, {
    organizationId: f.scope.organizationId,
    name: "Plano gratuito futuro",
    startsAt: Date.now() + 1000,
    endsAt: null,
    limits: { imports: 5, bytes: 100, captures: 2, registry: 1, deliveries: 1 },
    concurrency: 1,
    actor: "local-test",
    reason: "Synthetic proof",
    expectedVersion: 0,
  });
  expect((await f.reserve("early")).status).toBe(403);
  vi.setSystemTime(Date.now() + 1000);
  expect((await f.reserve("started")).status).toBe(200);
});
it("assigning a plan without an end validates the numbers, audits null and the overview shows it", async () => {
  const f = await fixture();
  const base = {
    organizationId: f.scope.organizationId,
    name: "Plano gratuito",
    startsAt: Date.now(),
    endsAt: null,
    limits: { imports: 5, bytes: 100, captures: 2, registry: 1, deliveries: 1 },
    concurrency: 1,
    actor: "local-test",
    reason: "Synthetic proof",
    expectedVersion: 0,
  };
  for (const invalid of [
    { startsAt: -1 },
    { startsAt: 1.5 },
    { startsAt: Number.NaN },
    { endsAt: Number.POSITIVE_INFINITY },
    { endsAt: base.startsAt },
    { limits: { ...base.limits, captures: -1 } },
    { limits: { ...base.limits, bytes: 0.5 } },
    { concurrency: 0 },
  ])
    await expect(f.t.mutation(internal.usage.assignPlan, { ...base, ...invalid })).rejects.toThrow(
      "INVALID_REQUEST",
    );
  expect(await f.t.run((ctx) => ctx.db.query("usagePlans").collect())).toHaveLength(0);
  expect(await f.t.mutation(internal.usage.assignPlan, base)).toBe(1);
  await f.plan(1, Date.now() + 1000, 1);
  expect(await f.t.mutation(internal.usage.assignPlan, { ...base, expectedVersion: 2 })).toBe(3);
  const audit = await f.t.run((ctx) => ctx.db.query("usagePlanAudit").collect());
  expect(audit.map((row) => JSON.parse(row.after).endsAt)).toEqual([
    null,
    expect.any(Number),
    null,
  ]);
  expect(JSON.parse(audit[1].before!).endsAt).toBeNull();
  expect(JSON.parse(audit[2].before!).endsAt).toEqual(expect.any(Number));
  const person = await owner(f);
  const view = await person.query(api.usage.overview, {
    organizationId: f.scope.organizationId,
    period: "2026-09",
    contextKey: "test",
  });
  expect(view.plan).toMatchObject({ name: "Plano gratuito", endsAt: null, version: 3 });
});
