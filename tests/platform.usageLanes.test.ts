import { convexTest } from "convex-test";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { internal } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { hashApiKey } from "../platform/convex/lib/apiKeyCrypto";
import {
  USAGE_LANES,
  commitUsage,
  refundUsage,
  releaseUsage,
  reserveUsage,
  totalFor,
} from "../platform/convex/lib/usageCore";
import { ConvexError } from "convex/values";
import type { Id } from "../platform/convex/_generated/dataModel";
import { modules } from "./helpers/convex-modules";

/**
 * #559: an environment's balance is split in lanes so concurrent admissions of one organization
 * do not all rewrite the same total. These tests prove the lanes never admit beyond the plan.
 *
 * convex-test runs one mutation at a time, so the `Promise.all` batches here check the
 * accounting under every ordering it produces, not real interleaving. Under real concurrency,
 * exactness rests on Convex serializability over each path's read set (`reserveLane`):
 * - fast path: the plan (`usagePlans`, and `platformPlanSettings` through `requireActivePlan`)
 *   and its own lane row, which it also writes;
 * - slow path: the plan, every lane of the environment and the unattributed total (two index
 *   ranges of `usageTotals`), and the rows it writes;
 * - settlement (`changeTotal`): the event and the lane row it writes, plus the other lanes it
 *   reads only when that lane no longer holds the event's units.
 * Any write to a row or range in a read set between the read and the commit retries the
 * mutation. The local load probe (#559) checked exactly min(N, balance) under real concurrency.
 */
const PERIOD = "2026-09";
type Metric = "imports" | "bytes" | "captures";
type Environment = "sandbox" | "production";
type Tester = Awaited<ReturnType<typeof fixture>>;

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function organization(t: Tester, secret: string) {
  return t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(secret),
    suffix: crypto.randomUUID(),
  });
}
async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}
function planner(t: Tester, organizationId: Id<"organizations">) {
  let version = 0;
  return (limits: { imports?: number | null; bytes?: number | null; captures?: number | null }) =>
    t
      .mutation(internal.usage.assignPlan, {
        organizationId,
        name: "Plano de teste",
        startsAt: Date.now() - 1,
        endsAt: Date.now() + 86400000,
        limits: { imports: 1, bytes: 1000, captures: 2, registry: 1, deliveries: 1, ...limits },
        concurrency: 1,
        actor: "local-test",
        reason: "Synthetic proof",
        expectedVersion: version,
      })
      .then((next) => (version = next));
}
const reserve = (
  t: Tester,
  organizationId: Id<"organizations">,
  key: string,
  options: {
    metric?: Metric;
    environment?: Environment;
    quantity?: number;
    measured?: boolean;
  } = {},
) =>
  t
    .run((ctx) =>
      reserveUsage(
        ctx,
        organizationId,
        options.environment ?? "sandbox",
        options.metric ?? "imports",
        key,
        options.quantity ?? 1,
        options.measured ?? false,
      ),
    )
    .then(
      () => "accepted" as const,
      (error: unknown) => {
        const code =
          error instanceof ConvexError ? (error.data as { code?: string }).code : undefined;
        if (code !== "QUOTA_EXCEEDED") throw error;
        return "refused" as const;
      },
    );
/**
 * The lanes' invariant: counted units plus the allowances valid under the current plan never
 * exceed the limit, and the summed total equals the units of the live events.
 */
async function audit(
  t: Tester,
  organizationId: Id<"organizations">,
  metric: Metric = "imports",
  environment: Environment = "sandbox",
) {
  return t.run(async (ctx) => {
    const plan = (await ctx.db
      .query("usagePlans")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .unique())!;
    const limit = plan.limits[metric];
    const grant = `${plan._id}:${plan.version}:${limit}`;
    const rows = (
      await ctx.db
        .query("usageTotals")
        .withIndex("by_organizationId_and_period_and_metric_and_environment", (q) =>
          q.eq("organizationId", organizationId).eq("period", PERIOD).eq("metric", metric),
        )
        .collect()
    ).filter((row) => !row.environment || row.environment === environment);
    const counted = rows.reduce((sum, row) => sum + row.committed + row.reserved, 0);
    const spare = rows.reduce(
      (sum, row) => sum + (row.grant === grant ? (row.allowance ?? 0) : 0),
      0,
    );
    const events = (
      await ctx.db
        .query("usageEvents")
        .withIndex("by_organizationId_and_updatedAt", (q) => q.eq("organizationId", organizationId))
        .collect()
    ).filter(
      (e) =>
        e.metric === metric &&
        e.environment === environment &&
        e.period === PERIOD &&
        e.state !== "released",
    );
    return {
      limit,
      counted,
      spare,
      events: events.reduce((sum, e) => sum + e.quantity, 0),
      lanes: new Set(rows.map((row) => row.lane ?? 0)).size,
    };
  });
}

it("concurrent reservations admit exactly the balance, never more, and the lanes add up", async () => {
  const t = await fixture();
  for (const [limit, requests] of [
    [13, 40],
    [1, 20],
    [100, 30],
  ] as const) {
    const fresh = await organization(
      t,
      `fnfe_${crypto.randomUUID().replaceAll("-", "")}abcdefghijk`,
    );
    const assign = planner(t, fresh.organizationId);
    await assign({ imports: limit });
    const outcomes = await Promise.all(
      Array.from({ length: requests }, (_, i) => reserve(t, fresh.organizationId, `file-${i}`)),
    );
    const accepted = outcomes.filter((o) => o === "accepted").length;
    expect(accepted).toBe(Math.min(limit, requests));
    const state = await audit(t, fresh.organizationId);
    expect(state.counted).toBe(accepted);
    expect(state.events).toBe(accepted);
    expect(state.counted + state.spare).toBeLessThanOrEqual(limit);
    expect(
      await t.run((ctx) => totalFor(ctx, fresh.organizationId, "sandbox", PERIOD, "imports")),
    ).toMatchObject({ committed: 0, reserved: accepted });
  }
});

it("the balance is spread over lanes, and a reservation then reads and writes one lane", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"d".repeat(43)}`);
  await planner(t, organizationId)({ imports: 80 });
  // The first reservation goes to lane 0, so the second one, on the last lane, is alone there.
  const first = vi.spyOn(Math, "random").mockReturnValue(0.01);
  expect(await reserve(t, organizationId, "first")).toBe("accepted");
  first.mockRestore();
  // The first reservation sets aside a share of the limit in every lane.
  let state = await audit(t, organizationId);
  expect(state.lanes).toBe(USAGE_LANES);
  expect(state).toMatchObject({ counted: 1, spare: 79 });
  // From there, a reservation in a funded lane changes only that lane's row.
  const before = await t.run((ctx) => ctx.db.query("usageTotals").collect());
  vi.spyOn(Math, "random").mockReturnValue(0.99);
  expect(await reserve(t, organizationId, "second")).toBe("accepted");
  const after = await t.run((ctx) => ctx.db.query("usageTotals").collect());
  const changed = after.filter(
    (row) => JSON.stringify(row) !== JSON.stringify(before.find((b) => b._id === row._id)),
  );
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatchObject({ lane: USAGE_LANES - 1, reserved: 1 });
  state = await audit(t, organizationId);
  expect(state.counted + state.spare).toBeLessThanOrEqual(80);
});

it("a lower limit voids every allowance set aside under the previous plan", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"e".repeat(43)}`);
  const plan = planner(t, organizationId);
  await plan({ imports: 1000 });
  for (let i = 0; i < 3; i++)
    expect(await reserve(t, organizationId, `before-${i}`)).toBe("accepted");
  expect((await audit(t, organizationId)).spare).toBeGreaterThan(100);
  await plan({ imports: 5 });
  const outcomes = await Promise.all(
    Array.from({ length: 10 }, (_, i) => reserve(t, organizationId, `after-${i}`)),
  );
  expect(outcomes.filter((o) => o === "accepted")).toHaveLength(2);
  const state = await audit(t, organizationId);
  expect(state).toMatchObject({ limit: 5, counted: 5 });
  expect(state.counted + state.spare).toBeLessThanOrEqual(5);
  // Raising it again does not revive the old allowances: only the new limit counts.
  await plan({ imports: 7 });
  const more = await Promise.all(
    Array.from({ length: 10 }, (_, i) => reserve(t, organizationId, `raised-${i}`)),
  );
  expect(more.filter((o) => o === "accepted")).toHaveLength(2);
  expect((await audit(t, organizationId)).counted).toBe(7);
});

it("measured-only units spend the allowances first and leave none that admits past the limit", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"f".repeat(43)}`);
  await planner(t, organizationId)({ imports: 16 });
  expect(await reserve(t, organizationId, "gated")).toBe("accepted");
  expect((await audit(t, organizationId)).spare).toBe(15);
  // Never refused, even past the limit.
  for (let i = 0; i < 20; i++)
    expect(await reserve(t, organizationId, `measured-${i}`, { measured: true })).toBe("accepted");
  const state = await audit(t, organizationId);
  expect(state).toMatchObject({ counted: 21, spare: 0 });
  expect(await reserve(t, organizationId, "gated-after")).toBe("refused");
});

it("replaying a key adds nothing, and commit and release land on the event's lane", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"g".repeat(43)}`);
  await planner(t, organizationId)({ bytes: 1000 });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const lane = Math.floor(0.5 * USAGE_LANES);
  for (let i = 0; i < 3; i++)
    expect(await reserve(t, organizationId, "file", { metric: "bytes", quantity: 300 })).toBe(
      "accepted",
    );
  expect(await reserve(t, organizationId, "other", { metric: "bytes", quantity: 300 })).toBe(
    "accepted",
  );
  const event = await t.run((ctx) =>
    ctx.db
      .query("usageEvents")
      .withIndex("by_organizationId_and_metric_and_key", (q) =>
        q.eq("organizationId", organizationId).eq("metric", "bytes").eq("key", "file"),
      )
      .unique(),
  );
  expect(event).toMatchObject({ lane, quantity: 300, state: "reserved" });
  await t.run((ctx) => commitUsage(ctx, organizationId, "bytes", "file", 120));
  await t.run((ctx) => releaseUsage(ctx, organizationId, "bytes", "other"));
  const row = await t.run((ctx) =>
    ctx.db
      .query("usageTotals")
      .withIndex("by_organizationId_and_period_and_metric_and_environment_and_lane", (q) =>
        q
          .eq("organizationId", organizationId)
          .eq("period", PERIOD)
          .eq("metric", "bytes")
          .eq("environment", "sandbox")
          .eq("lane", lane),
      )
      .unique(),
  );
  expect(row).toMatchObject({ committed: 120, reserved: 0 });
  expect(
    await t.run((ctx) => totalFor(ctx, organizationId, "sandbox", PERIOD, "bytes")),
  ).toMatchObject({ committed: 120, reserved: 0 });
  // 880 bytes are left, from the free remainder and every lane's allowance.
  vi.restoreAllMocks();
  expect(await reserve(t, organizationId, "big", { metric: "bytes", quantity: 880 })).toBe(
    "accepted",
  );
  expect(await reserve(t, organizationId, "one-more", { metric: "bytes", quantity: 1 })).toBe(
    "refused",
  );
});

it("environments and organizations keep separate lanes, and unattributed units count in both", async () => {
  const t = await fixture();
  const a = await organization(t, `fnfe_${"h".repeat(43)}`);
  const b = await organization(t, `fnfe_${"i".repeat(43)}`);
  await planner(t, a.organizationId)({ imports: 6 });
  await planner(t, b.organizationId)({ imports: 6 });
  // Units of the period not yet attributed to an environment (#429) count against both.
  await t.run((ctx) =>
    ctx.db.insert("usageTotals", {
      organizationId: a.organizationId,
      period: PERIOD,
      metric: "imports",
      committed: 2,
      reserved: 0,
      updatedAt: Date.now(),
      startedAt: Date.now(),
    }),
  );
  const requests = (organizationId: Id<"organizations">, environment: Environment) =>
    Array.from({ length: 10 }, (_, i) =>
      reserve(t, organizationId, `${environment}-${i}`, { environment }),
    );
  const [sandboxA, productionA, sandboxB] = await Promise.all([
    Promise.all(requests(a.organizationId, "sandbox")),
    Promise.all(requests(a.organizationId, "production")),
    Promise.all(requests(b.organizationId, "sandbox")),
  ]);
  expect(sandboxA.filter((o) => o === "accepted")).toHaveLength(4);
  expect(productionA.filter((o) => o === "accepted")).toHaveLength(4);
  expect(sandboxB.filter((o) => o === "accepted")).toHaveLength(6);
  for (const [organizationId, environment, counted] of [
    [a.organizationId, "sandbox", 6],
    [a.organizationId, "production", 6],
    [b.organizationId, "sandbox", 6],
  ] as const) {
    const state = await audit(t, organizationId, "imports", environment);
    expect(state.counted).toBe(counted);
    expect(state.counted + state.spare).toBeLessThanOrEqual(6);
  }
});

it("an admission charges its imports and bytes on one lane, the lane its rate budgets try first", async () => {
  const t = await fixture();
  const secret = `fnfe_${"o".repeat(43)}`;
  const org = await organization(t, secret);
  await planner(t, org.organizationId)({ imports: 50, bytes: 10_000 });
  for (const [draw, lane] of [
    [0.3, 2],
    [0.9, 7],
    [0.05, 0],
  ] as const) {
    const random = vi.spyOn(Math, "random").mockReturnValue(draw);
    const response = await t.fetch("/v1/imports", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Environment": "sandbox",
        "Content-Type": "application/json",
        "Idempotency-Key": `lane-${lane}`,
      },
      body: JSON.stringify({
        companyId: org.companyId,
        files: [
          { name: "a.xml", size: 10, sha256: "a".repeat(64) },
          { name: "b.xml", size: 20, sha256: "b".repeat(64) },
        ],
      }),
    });
    random.mockRestore();
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { fileIds: string[] } };
    const events = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    const own = events.filter((e) => data.fileIds.includes(e.key));
    expect(own).toHaveLength(4);
    expect(own.map((e) => e.lane ?? 0)).toEqual([lane, lane, lane, lane]);
  }
});

it("concurrent REST admissions of two organizations admit exactly each balance, once per key", async () => {
  const t = await fixture();
  const secrets = [`fnfe_${"j".repeat(43)}`, `fnfe_${"k".repeat(43)}`];
  const orgs = await Promise.all(secrets.map((secret) => organization(t, secret)));
  await planner(t, orgs[0]!.organizationId)({ imports: 7 });
  await planner(t, orgs[1]!.organizationId)({ imports: 1000 });
  const admit = (i: number, key: string) =>
    t.fetch("/v1/imports", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secrets[i]}`,
        "X-Environment": "sandbox",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        companyId: orgs[i]!.companyId,
        files: [{ name: "nota.xml", size: 10, sha256: "a".repeat(64) }],
      }),
    });
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, k) => admit(k % 2, `key-${k}`)),
  );
  const statuses = responses.map((r) => r.status);
  expect(statuses.filter((s, k) => k % 2 === 0 && s === 200)).toHaveLength(7);
  expect(statuses.filter((s, k) => k % 2 === 0 && s === 429)).toHaveLength(3);
  expect(statuses.filter((s, k) => k % 2 === 1 && s === 200)).toHaveLength(10);
  // A replay of an accepted key returns the same batch and adds nothing.
  const accepted = statuses.findIndex((s, k) => k % 2 === 0 && s === 200);
  const first = (await responses[accepted]!.json()) as { data: { importId: string } };
  const replay = await admit(0, `key-${accepted}`);
  expect(((await replay.json()) as { data: { importId: string } }).data.importId).toBe(
    first.data.importId,
  );
  for (const [i, units] of [
    [0, 7],
    [1, 10],
  ] as const) {
    const state = await audit(t, orgs[i]!.organizationId);
    expect(state).toMatchObject({ counted: units, events: units });
    expect(state.counted + state.spare).toBeLessThanOrEqual(state.limit!);
  }
});

it("rollback: with the lanes off the limit stays exact, and the fold leaves no lane field", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"n".repeat(43)}`);
  await planner(t, organizationId)({ imports: 20 });
  const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
  for (let i = 0; i < 5; i++) expect(await reserve(t, organizationId, `on-${i}`)).toBe("accepted");
  random.mockRestore();
  await t.run((ctx) => commitUsage(ctx, organizationId, "imports", "on-0"));
  await expect(t.mutation(internal.usageMigration.foldLanes, { cursor: null })).rejects.toThrow(
    "FNFE_USAGE_LANES=off",
  );
  vi.stubEnv("FNFE_USAGE_LANES", "off");
  // Off: new units go to lane 0 and spend the allowances other lanes still hold.
  const outcomes = await Promise.all(
    Array.from({ length: 30 }, (_, i) => reserve(t, organizationId, `off-${i}`)),
  );
  expect(outcomes.filter((o) => o === "accepted")).toHaveLength(15);
  const events = await t.run((ctx) => ctx.db.query("usageEvents").collect());
  expect(events.filter((e) => e.key.startsWith("off-")).every((e) => e.lane === undefined)).toBe(
    true,
  );
  // Between the stages, an event still names a lane whose row was merged: it commits on lane 0.
  const spread = events.find((e) => e.key.startsWith("on-") && e.key !== "on-0" && e.lane)!;
  expect(spread).toBeDefined();
  await t.mutation(internal.usageMigration.foldLanes, { cursor: null });
  await t.run((ctx) => commitUsage(ctx, organizationId, "imports", spread.key));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const rows = await t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ committed: 2, reserved: 18 });
  expect(rows[0]).not.toHaveProperty("lane");
  expect(rows[0]).not.toHaveProperty("allowance");
  expect(rows[0]).not.toHaveProperty("grant");
  expect(
    (await t.run((ctx) => ctx.db.query("usageEvents").collect())).some((e) => "lane" in e),
  ).toBe(false);
  expect(await reserve(t, organizationId, "after-fold")).toBe("refused");
  // Traffic after the fold, lanes still off, writes no lane field anywhere: release, commit, an
  // accepted reservation and the first total of a new period.
  await t.run((ctx) => releaseUsage(ctx, organizationId, "imports", "off-0"));
  await t.run((ctx) => commitUsage(ctx, organizationId, "imports", "off-1"));
  expect(await reserve(t, organizationId, "after-release")).toBe("accepted");
  vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  expect(await reserve(t, organizationId, "next-period", { measured: true })).toBe("accepted");
  const after = await t.run(async (ctx) => ({
    totals: await ctx.db.query("usageTotals").collect(),
    events: await ctx.db.query("usageEvents").collect(),
  }));
  expect(after.totals.map((row) => row.period).sort()).toEqual(["2026-09", "2026-10"]);
  for (const row of after.totals)
    for (const field of ["lane", "allowance", "grant"]) expect(row).not.toHaveProperty(field);
  for (const event of after.events) expect(event).not.toHaveProperty("lane");
  expect(after.totals.find((row) => row.period === "2026-09")).toMatchObject({
    committed: 3,
    reserved: 17,
  });
});

it("lanes turned back on mid-fold: an event's units split across lanes still settle exactly", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"q".repeat(43)}`);
  await planner(t, organizationId)({ bytes: 1000 });
  const onLane = async (lane: number, key: string, quantity: number) => {
    const random = vi.spyOn(Math, "random").mockReturnValue((lane + 0.5) / USAGE_LANES);
    expect(await reserve(t, organizationId, key, { metric: "bytes", quantity })).toBe("accepted");
    random.mockRestore();
  };
  await onLane(1, "E1", 5);
  await onLane(2, "E2", 5);
  vi.stubEnv("FNFE_USAGE_LANES", "off");
  // Totals stage only: lanes 1 and 2 merged into lane 0; the events still name lanes 1 and 2.
  await t.mutation(internal.usageMigration.foldLanes, { cursor: null });
  vi.stubEnv("FNFE_USAGE_LANES", "on");
  await onLane(1, "N1", 6);
  const settle = (key: string) => t.run((ctx) => commitUsage(ctx, organizationId, "bytes", key));
  // E1 is paid by the new lane 1 (6 -> 1). N1's 6 units are then in no single lane of its own:
  // 1 comes from lane 1 and 5 from lane 0 (10 -> 5). E2's lane 2 is gone; lane 0 pays its 5.
  // Taking from a single lane, as before, would leave 4 + 1 for E2's 5 and throw forever.
  await settle("E1");
  await settle("N1");
  await settle("E2");
  const rows = await t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(rows.every((row) => row.committed >= 0 && row.reserved >= 0)).toBe(true);
  expect(
    await t.run((ctx) => totalFor(ctx, organizationId, "sandbox", PERIOD, "bytes")),
  ).toMatchObject({ committed: 16, reserved: 0 });
  const state = await audit(t, organizationId, "bytes");
  expect(state).toMatchObject({ counted: 16, events: 16 });
  expect(state.counted + state.spare).toBeLessThanOrEqual(1000);
  // The released balance is usable again, exactly: 984 bytes left.
  expect(await reserve(t, organizationId, "rest", { metric: "bytes", quantity: 984 })).toBe(
    "accepted",
  );
  expect(await reserve(t, organizationId, "over", { metric: "bytes", quantity: 1 })).toBe(
    "refused",
  );
});

it("lanes turned back on mid-fold: stale events settle from the lane that holds their units", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"p".repeat(43)}`);
  await planner(t, organizationId)({ imports: 40 });
  const onLane5 = () => vi.spyOn(Math, "random").mockReturnValue(5.5 / USAGE_LANES);
  let random = onLane5();
  for (let i = 0; i < 3; i++)
    expect(await reserve(t, organizationId, `stale-${i}`)).toBe("accepted");
  random.mockRestore();
  vi.stubEnv("FNFE_USAGE_LANES", "off");
  // Only the totals stage: lane 5 merged into lane 0, the events still name lane 5.
  await t.mutation(internal.usageMigration.foldLanes, { cursor: null });
  vi.stubEnv("FNFE_USAGE_LANES", "on");
  random = onLane5();
  expect(await reserve(t, organizationId, "fresh-0")).toBe("accepted");
  random.mockRestore();
  // Lane 5 now holds 1 reserved unit of a fresh event; the three stale ones are in lane 0.
  for (let i = 0; i < 3; i++)
    await t.run((ctx) => releaseUsage(ctx, organizationId, "imports", `stale-${i}`));
  await t.run((ctx) => commitUsage(ctx, organizationId, "imports", "fresh-0"));
  const state = await audit(t, organizationId);
  expect(state).toMatchObject({ counted: 1, events: 1 });
  expect(state.counted + state.spare).toBeLessThanOrEqual(40);
  expect(
    await t.run((ctx) => totalFor(ctx, organizationId, "sandbox", PERIOD, "imports")),
  ).toMatchObject({ committed: 1, reserved: 0 });
  const rows = await t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(rows.every((row) => row.committed >= 0 && row.reserved >= 0)).toBe(true);
});

it("rollback: a zero-unit settlement after the fold writes no lane row", async () => {
  const t = await fixture();
  const { organizationId } = await organization(t, `fnfe_${"z".repeat(43)}`);
  await planner(t, organizationId)({ bytes: 1000 });
  const random = vi.spyOn(Math, "random").mockReturnValue(3.5 / USAGE_LANES);
  expect(await reserve(t, organizationId, "Z", { metric: "bytes", quantity: 5 })).toBe("accepted");
  random.mockRestore();
  // A capture that stored nothing commits 0 bytes; the event keeps naming lane 3.
  await t.run((ctx) => commitUsage(ctx, organizationId, "bytes", "Z", 0));
  vi.stubEnv("FNFE_USAGE_LANES", "off");
  // Totals stage only: lane 3 is folded away while the event still names it.
  await t.mutation(internal.usageMigration.foldLanes, { cursor: null });
  await t.run((ctx) => refundUsage(ctx, organizationId, "bytes", "Z"));
  const rows = await t.run((ctx) => ctx.db.query("usageTotals").collect());
  expect(rows.some((row) => row.lane !== undefined || row.allowance !== undefined)).toBe(false);
});
