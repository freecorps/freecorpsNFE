import { convexTest } from "convex-test";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { register } from "../test-setup";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { commitUsage, recordUsage } from "./lib/usageCore";
import {
  collectStatus,
  compareReceipts,
  summarize,
} from "../../scripts/lib/usage-migration-status.mjs";
import { modules } from "../../tests/helpers/convex-modules";

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
    BETTER_AUTH_SECRET: "synthetic-usage-migration-test-only",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Metric = "imports" | "bytes";
type State = "reserved" | "committed" | "released";

async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(`fnfe_${"m".repeat(43)}`),
    suffix: crypto.randomUUID(),
  });
  const status = async (pageSize = 100) =>
    summarize(
      await collectStatus(
        (fn, paginationOpts) =>
          t.query(
            fn === "eventStatus"
              ? internal.usageMigration.eventStatus
              : internal.usageMigration.totalStatus,
            { paginationOpts },
          ),
        { pageSize },
      ),
    );
  const rows = () =>
    t.run(async (ctx) => ({
      events: await ctx.db.query("usageEvents").collect(),
      totals: await ctx.db.query("usageTotals").collect(),
    }));
  return { t, scope, status, rows };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Usage recorded before #429, more than two backfill pages of it: events whose keys name a
 * sandbox or production import file, some whose record is gone, over two periods, and the
 * unattributed totals that sum them, as the pre-#429 code kept them.
 */
async function legacyUsage(f: Fixture, perEnvironment = 110, gone = 15) {
  return f.t.run(async (ctx) => {
    const batch = async (environment: "sandbox" | "production") =>
      ctx.db.insert("imports", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment,
        key: `legacy-${environment}`,
        requestHash: "a".repeat(64),
        createdAt: Date.now(),
      });
    const batches = { sandbox: await batch("sandbox"), production: await batch("production") };
    const states: State[] = ["committed", "reserved", "released"];
    const specs: { metric: Metric; key: string; state: State; quantity: number; period: string }[] =
      [];
    for (const environment of ["sandbox", "production"] as const)
      for (let i = 0; i < perEnvironment; i++) {
        const key = String(
          await ctx.db.insert("importFiles", {
            importId: batches[environment],
            position: i,
            name: "nota.xml",
            size: 10,
            sha256: "a".repeat(64),
            state: "reserved",
            expiresAt: Date.now() + 3600000,
          }),
        );
        const period = i % 4 ? "2026-09" : "2026-08";
        specs.push({ metric: "imports", key, state: states[i % 3], quantity: 1, period });
        specs.push({ metric: "bytes", key, state: states[(i + 1) % 3], quantity: 10 + i, period });
      }
    for (let i = 0; i < gone; i++)
      specs.push({
        metric: "imports",
        key: `record-that-is-gone-${i}`,
        state: i % 2 ? "reserved" : "committed",
        quantity: 1,
        period: "2026-09",
      });
    const totals = new Map<string, { committed: number; reserved: number }>();
    for (const spec of specs) {
      await ctx.db.insert("usageEvents", {
        organizationId: f.scope.organizationId,
        metric: spec.metric,
        key: spec.key,
        period: spec.period,
        quantity: spec.quantity,
        state: spec.state,
        createdAt: Date.UTC(2026, 7, 2),
        updatedAt: Date.UTC(2026, 7, 2),
      });
      const k = `${spec.period}|${spec.metric}`;
      const total = totals.get(k) ?? { committed: 0, reserved: 0 };
      if (spec.state === "committed") total.committed += spec.quantity;
      if (spec.state === "reserved") total.reserved += spec.quantity;
      totals.set(k, total);
    }
    for (const [k, { committed, reserved }] of totals) {
      const [period, metric] = k.split("|") as [string, Metric];
      await ctx.db.insert("usageTotals", {
        organizationId: f.scope.organizationId,
        period,
        metric,
        committed,
        reserved,
        startedAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 2),
      });
    }
    return specs;
  });
}
async function backfill(f: Fixture) {
  const first = await f.t.mutation(internal.usageMigration.backfillEnvironment, { cursor: null });
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  return first;
}
const pick = (summary: Awaited<ReturnType<Fixture["status"]>>, environment: string) =>
  summary.balance.filter((row) => row.environment === environment);

it("the status proves zero legacy and the per-metric balances across a multi-page backfill", async () => {
  const f = await fixture();
  const specs = await legacyUsage(f);
  expect(specs.length).toBeGreaterThan(400);
  const before = await f.status(37);
  expect(before.observedZeroLegacy).toBe(false);
  expect(before.legacy.events).toBe(specs.length);
  // Before the backfill every unit sits on the unattributed totals, which match their events.
  expect(before.balance.every((row) => row.environment === "unattributed")).toBe(true);
  expect(before.balance.every((row) => row.observedEqual)).toBe(true);

  await backfill(f);
  const after = await f.status(37);
  expect(after.observedZeroLegacy).toBe(true);
  expect(after.legacy).toEqual({
    events: 0,
    eventUnits: 0,
    totals: 0,
    totalCommitted: 0,
    totalReserved: 0,
  });
  expect(after.balance.every((row) => row.observedEqual)).toBe(true);
  // Without traffic between the receipts, counts and units of each metric are the same.
  expect(compareReceipts(before, after)).toMatchObject({ differences: [], observedEqual: true });
  // Each environment got exactly its records' units; the gone records went to production.
  const expected = (environment: "sandbox" | "production", metric: Metric) => {
    const offset = environment === "sandbox" ? 0 : 220;
    const own = specs.slice(offset, offset + 220).filter((s) => s.metric === metric);
    const extra = environment === "production" && metric === "imports" ? specs.slice(440) : [];
    const sum = (state: State) =>
      [...own, ...extra].filter((s) => s.state === state).reduce((n, s) => n + s.quantity, 0);
    return { eventCommitted: sum("committed"), eventReserved: sum("reserved") };
  };
  for (const environment of ["sandbox", "production"] as const)
    for (const metric of ["imports", "bytes"] as const)
      expect(pick(after, environment).find((row) => row.metric === metric)).toMatchObject(
        expected(environment, metric),
      );
});

it("repeating the backfill and the status changes nothing", async () => {
  const f = await fixture();
  await legacyUsage(f, 60, 3);
  await backfill(f);
  const rows = await f.rows();
  const status = await f.status();
  expect(await backfill(f)).toMatchObject({ attributed: 0, unresolved: 0 });
  expect(await f.rows()).toEqual(rows);
  expect(await f.status()).toEqual(status);
  // The page size of the status read does not change the receipt.
  expect(await f.status(1000)).toEqual(status);
  expect(await f.status(7)).toEqual(status);
});

it("a legacy total without events stays, is reported and never reads as zero legacy", async () => {
  const f = await fixture();
  await legacyUsage(f, 5, 1);
  await f.t.run((ctx) =>
    ctx.db.insert("usageTotals", {
      organizationId: f.scope.organizationId,
      period: "2026-07",
      metric: "imports",
      committed: 3,
      reserved: 2,
      startedAt: Date.UTC(2026, 6, 1),
      updatedAt: Date.UTC(2026, 6, 2),
    }),
  );
  const before = await f.status();
  await backfill(f);
  const residual = await f.t.run((ctx) =>
    ctx.db
      .query("usageTotals")
      .collect()
      .then((rows) => rows.filter((row) => !row.environment)),
  );
  expect(residual).toMatchObject([{ period: "2026-07", committed: 3, reserved: 2 }]);
  const after = await f.status();
  expect(after.observedZeroLegacy).toBe(false);
  expect(after.legacy).toEqual({
    events: 0,
    eventUnits: 0,
    totals: 1,
    totalCommitted: 3,
    totalReserved: 2,
  });
  expect(pick(after, "unattributed")).toEqual([
    {
      metric: "imports",
      environment: "unattributed",
      eventCommitted: 0,
      eventReserved: 0,
      totalCommitted: 3,
      totalReserved: 2,
      observedEqual: false,
    },
  ]);
  expect(pick(after, "sandbox").every((row) => row.observedEqual)).toBe(true);
  expect(pick(after, "production").every((row) => row.observedEqual)).toBe(true);
  // The residual units stay counted: the per-metric sums still match the receipt before.
  expect(compareReceipts(before, after).differences).toEqual([]);
});

it("traffic beside the backfill keeps every balance, and the receipts show only the new usage", async () => {
  const f = await fixture();
  const specs = await legacyUsage(f, 110, 0);
  const before = await f.status();
  // First page only: the next one is scheduled, not yet run.
  expect(
    await f.t.mutation(internal.usageMigration.backfillEnvironment, { cursor: null }),
  ).toMatchObject({ scanned: 100, isDone: false });
  // Each page is one transaction: between pages, events and totals still agree per environment.
  const between = await f.status();
  expect(between.balance.every((row) => row.observedEqual)).toBe(true);
  expect(between.legacy.events).toBeGreaterThan(0);
  // New traffic, and a legacy reservation still ahead of the cursor committed meanwhile.
  const late = [...specs].reverse().find((s) => s.state === "reserved" && s.metric === "imports")!;
  await f.t.run(async (ctx) => {
    await recordUsage(ctx, f.scope.organizationId, "sandbox", "imports", "new-sandbox");
    await recordUsage(ctx, f.scope.organizationId, "production", "bytes", "new-production", 7);
    await commitUsage(ctx, f.scope.organizationId, "imports", late.key);
  });
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const after = await f.status();
  expect(after.observedZeroLegacy).toBe(true);
  expect(after.balance.every((row) => row.observedEqual)).toBe(true);
  // The comparison is data, not a verdict: here it shows exactly the traffic of the window.
  const { differences, observedEqual } = compareReceipts(before, after);
  expect(observedEqual).toBe(false);
  const byKey = <T extends { metric: string; field: string }>(rows: T[]) =>
    [...rows].sort((a, b) => `${a.metric}:${a.field}`.localeCompare(`${b.metric}:${b.field}`));
  expect(byKey(differences)).toEqual(
    byKey([
      { metric: "bytes", field: "events", before: 220, after: 221 },
      {
        metric: "bytes",
        field: "eventCommitted",
        before: before.byMetric.find((m) => m.metric === "bytes")!.eventCommitted,
        after: before.byMetric.find((m) => m.metric === "bytes")!.eventCommitted + 7,
      },
      {
        metric: "bytes",
        field: "totalCommitted",
        before: before.byMetric.find((m) => m.metric === "bytes")!.totalCommitted,
        after: before.byMetric.find((m) => m.metric === "bytes")!.totalCommitted + 7,
      },
      { metric: "imports", field: "events", before: 220, after: 221 },
      {
        metric: "imports",
        field: "eventCommitted",
        before: before.byMetric.find((m) => m.metric === "imports")!.eventCommitted,
        after: before.byMetric.find((m) => m.metric === "imports")!.eventCommitted + 2,
      },
      {
        metric: "imports",
        field: "eventReserved",
        before: before.byMetric.find((m) => m.metric === "imports")!.eventReserved,
        after: before.byMetric.find((m) => m.metric === "imports")!.eventReserved - 1,
      },
      {
        metric: "imports",
        field: "totalCommitted",
        before: before.byMetric.find((m) => m.metric === "imports")!.totalCommitted,
        after: before.byMetric.find((m) => m.metric === "imports")!.totalCommitted + 2,
      },
      {
        metric: "imports",
        field: "totalReserved",
        before: before.byMetric.find((m) => m.metric === "imports")!.totalReserved,
        after: before.byMetric.find((m) => m.metric === "imports")!.totalReserved - 1,
      },
    ]),
  );
});

it("a status read across a backfill page is not a snapshot and may not balance", async () => {
  const f = await fixture();
  await legacyUsage(f, 60, 0);
  // Events read before a backfill page, totals after it: the receipt mixes two instants.
  let moved = false;
  const summary = summarize(
    await collectStatus(
      async (fn, paginationOpts) => {
        if (fn === "totalStatus" && !moved) {
          moved = true;
          await f.t.mutation(internal.usageMigration.backfillEnvironment, { cursor: null });
        }
        return f.t.query(
          fn === "eventStatus"
            ? internal.usageMigration.eventStatus
            : internal.usageMigration.totalStatus,
          { paginationOpts },
        );
      },
      { pageSize: 50 },
    ),
  );
  expect(summary.balance.some((row) => !row.observedEqual)).toBe(true);
  // Read again without traffic, the same deployment balances.
  expect((await f.status()).balance.every((row) => row.observedEqual)).toBe(true);
});

it("the status returns only aggregates: no id, key, organization or period", async () => {
  const f = await fixture();
  await legacyUsage(f, 3, 1);
  await backfill(f);
  const pages = [
    await f.t.query(internal.usageMigration.eventStatus, {
      paginationOpts: { numItems: 1000, cursor: null },
    }),
    await f.t.query(internal.usageMigration.totalStatus, {
      paginationOpts: { numItems: 1000, cursor: null },
    }),
  ];
  for (const { groups } of pages) {
    const text = JSON.stringify(groups);
    expect(text).not.toContain(String(f.scope.organizationId));
    expect(text).not.toContain("record-that-is-gone");
    expect(text).not.toMatch(/2026-0\d/);
    for (const group of groups)
      expect(Object.keys(group).sort()).toEqual(
        "environment" in group && "state" in group
          ? ["environment", "events", "metric", "state", "units"]
          : ["committed", "environment", "metric", "reserved", "rows"],
      );
  }
});
