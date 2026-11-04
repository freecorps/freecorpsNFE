import { execFileSync } from "node:child_process";
import { afterAll, expect, it, vi } from "vite-plus/test";
import { PLATFORM_PLANS } from "../../platform/convex/lib/planCatalog";
import {
  ADMISSION_P95_MS,
  INTERMEDIATE,
  READ_P95_MS,
  amplePlan,
  assessAmpleRound,
  assessContentionRound,
  classifyAdmission,
  classifyRead,
  cleanupWithPlans,
  closePlans,
  contentionPlan,
  occByTable,
  planLoad,
  planLoadOptions,
  summarizeReads,
  summarizeRound,
} from "../lib/hosted-plan-load.mjs";

// Relógio fixo: as fixtures são relativas a este instante, longe de virada de dia e de mês
// (freecorps/no-wall-clock-in-tests).
vi.setSystemTime(new Date("2026-06-15T15:00:00Z"));
afterAll(() => vi.useRealTimers());

const quota = { error: { code: "RATE_LIMITED", retryable: false } };
const limiter = { error: { code: "RATE_LIMITED", retryable: true } };
const sample = (outcome: string, ms = 100, status = outcome === "accepted" ? 200 : 429) => ({
  outcome,
  ms,
  status,
});
const samples = (n: number, outcome: string, ms = 100) =>
  Array.from({ length: n }, () => sample(outcome, ms));

it("sizes the plan from the Intermediário catalog and the balance to contend for", () => {
  const { name, concurrency, limits } = PLATFORM_PLANS.intermediate;
  expect(INTERMEDIATE).toEqual({ name, concurrency, limits });
  expect(amplePlan(10, 51).limits.imports).toBe(1000);
  expect(amplePlan(990, 51).limits.imports).toBe(1041);
  expect(contentionPlan(163, 1).limits).toEqual({ ...limits, imports: 164 });
  expect(() => contentionPlan(163, 0)).toThrow();
  expect(() => amplePlan(-1, 51)).toThrow();
});

it("keeps every round inside the organization admission window", () => {
  expect(planLoadOptions([])).toEqual({
    rounds: 3,
    clients: 20,
    admissionsPerRound: 34,
    readsPerRound: 0,
    contentionRequests: 20,
    contentionBalance: 1,
  });
  expect(planLoadOptions(["--contention-balance", "5"]).contentionBalance).toBe(5);
  // 10 admissions and 50 reads per organization fill one `rest-actor` minute of its key.
  expect(
    planLoadOptions(["--admissions-per-round", "20", "--reads-per-round", "100"]).readsPerRound,
  ).toBe(100);
  for (const args of [
    ["--admissions-per-round", "41"],
    ["--clients", "0"],
    ["--contention-balance", "20"],
    ["--contention-balance"],
    ["--max-documents", "10000"],
    ["--admissions-per-round", "20", "--reads-per-round", "101"],
    ["--reads-per-round", "87"],
  ])
    expect(() => planLoadOptions(args)).toThrow();
});

it("tells the plan quota refusal from the rate limiter and other answers", () => {
  expect(classifyAdmission(200, { data: { importId: "i1", fileIds: ["f1"] } })).toBe("accepted");
  expect(classifyAdmission(200, { data: {} })).toBe("other");
  expect(classifyAdmission(200, null)).toBe("other");
  expect(classifyAdmission(429, quota)).toBe("quota");
  expect(classifyAdmission(429, limiter)).toBe("rateLimited");
  expect(classifyAdmission(503, { error: { code: "UNAVAILABLE" } })).toBe("other");
  expect(classifyAdmission(429, null)).toBe("other");
});

it("counts a read only for a 200 with a page, apart from the limiter", () => {
  expect(classifyRead(200, { data: { page: [] } })).toBe("read");
  expect(classifyRead(200, { data: {} })).toBe("other");
  expect(classifyRead(429, limiter)).toBe("rateLimited");
  expect(classifyRead(503, null)).toBe("other");
  const reads = summarizeReads([
    { status: 200, outcome: "read", ms: 100, page: 50 },
    { status: 200, outcome: "read", ms: 300, page: 49 },
    { status: 429, outcome: "rateLimited", ms: 5000, page: null },
  ]);
  expect(reads).toMatchObject({ requests: 3, p95Ms: 300, maxMs: 5000, minPage: 49 });
  expect(reads.outcomes).toEqual({ read: 2, rateLimited: 1, other: 0 });
});

it("fails an ample round with reads on a refused read or a slow read p95", () => {
  const facts = { expected: 2, totalsDelta: 2, effects: 2, distinctImports: 2 };
  const round = summarizeRound("ample", samples(2, "accepted"));
  const read = (ms: number, outcome = "read") => ({
    status: outcome === "read" ? 200 : 429,
    outcome,
    ms,
    page: 50,
  });
  const ok = summarizeReads([read(100), read(READ_P95_MS)]);
  expect(assessAmpleRound(round, facts).checks).not.toHaveProperty("readsAnswered");
  expect(assessAmpleRound(round, { ...facts, expectedReads: 2, reads: ok }).passed).toBe(true);
  const slow = summarizeReads([read(100), read(READ_P95_MS + 1)]);
  expect(
    assessAmpleRound(round, { ...facts, expectedReads: 2, reads: slow }).checks.readsWithinLatency,
  ).toBe(false);
  const refused = summarizeReads([read(100), read(100, "rateLimited")]);
  expect(
    assessAmpleRound(round, { ...facts, expectedReads: 2, reads: refused }).checks.readsAnswered,
  ).toBe(false);
  expect(assessAmpleRound(round, { ...facts, expectedReads: 2 }).passed).toBe(false);
});

it("fails an ample round on any 429, a missing admission, a duplicate effect or a slow p95", () => {
  const facts = { expected: 34, totalsDelta: 34, effects: 34, distinctImports: 34 };
  const ok = summarizeRound("ample", samples(34, "accepted", ADMISSION_P95_MS));
  expect(assessAmpleRound(ok, facts).passed).toBe(true);
  const refused = summarizeRound("ample", [...samples(33, "accepted"), sample("quota")]);
  expect(assessAmpleRound(refused, facts).checks.allAccepted).toBe(false);
  const limited = summarizeRound("ample", [...samples(33, "accepted"), sample("rateLimited")]);
  expect(assessAmpleRound(limited, facts).passed).toBe(false);
  expect(assessAmpleRound(summarizeRound("ample", samples(33, "accepted")), facts).passed).toBe(
    false,
  );
  expect(assessAmpleRound(ok, { ...facts, totalsDelta: 35 }).checks.noDuplicateEffect).toBe(false);
  expect(assessAmpleRound(ok, { ...facts, effects: 33 }).checks.noDuplicateEffect).toBe(false);
  const slow = summarizeRound("ample", samples(34, "accepted", ADMISSION_P95_MS + 1));
  expect(assessAmpleRound(slow, facts).checks).toMatchObject({
    allAccepted: true,
    withinLatency: false,
  });
});

it("expects exactly the balance accepted in contention, without refusals in the success p95", () => {
  const replay = { requests: 1, sameImports: 1, totalsDelta: 0 };
  const facts = {
    requests: 20,
    balance: 1,
    totalsDelta: 1,
    effects: 1,
    distinctImports: 1,
    replay,
  };
  const round = summarizeRound("contention", [
    sample("accepted", 900),
    ...samples(19, "quota", 5000),
  ]);
  expect(round).toMatchObject({ successP95Ms: 900, refusalP95Ms: 5000, statuses: { 429: 19 } });
  expect(assessContentionRound(round, facts).passed).toBe(true);
  const two = summarizeRound("contention", [...samples(2, "accepted"), ...samples(18, "quota")]);
  expect(assessContentionRound(two, { ...facts, totalsDelta: 2, effects: 2 }).checks).toMatchObject(
    {
      acceptedBalance: false,
      effectsMatchAccepted: false,
    },
  );
  const limited = summarizeRound("contention", [
    sample("accepted"),
    ...samples(18, "quota"),
    sample("rateLimited"),
  ]);
  expect(assessContentionRound(limited, facts).checks.noOtherAnswer).toBe(false);
  const duplicated = { ...facts, replay: { ...replay, totalsDelta: 1 } };
  expect(assessContentionRound(round, duplicated).checks.replayWithoutEffect).toBe(false);
});

it("refuses plan-load options before credentials or network access", () => {
  let stderr = "";
  try {
    execFileSync(
      process.execPath,
      [
        "scripts/proofs/prove-hosted-operations.mjs",
        "missing-private-credential.json",
        "plan-load",
        "missing-private-state.json",
        "--clients",
        "21",
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    stderr = String((error as { stderr: string }).stderr);
  }
  expect(stderr).toContain("--clients");
  expect(stderr).not.toContain("ENOENT");
});

type Row = Record<string, any>;
/** Simulated deployment: the runner's query bodies run against in-memory tables. */
function simulated({ failAssignment = -1, expiring = false, events = 0, commercial = false } = {}) {
  const period = new Date().toISOString().slice(0, 7);
  const org = (organizationId: string, extra: Row) => ({
    organizationId,
    period,
    metric: "imports",
    ...extra,
  });
  const scopes = ["jd7orgA", "jd7orgB"].map((organizationId, i) => ({
    organizationId,
    companyId: `jd7company${i}`,
    secret: `fnfe_jd7secret${i}`,
    source: {},
  }));
  const tables: Record<string, Row[]> = {
    platformPlanSettings: commercial ? [{ key: "platform", enabled: true }] : [],
    usagePlans: [],
    // Unattributed and Sandbox count against the Sandbox quota; Production does not.
    usageTotals: [
      org("jd7orgA", { committed: 5, reserved: 0 }),
      org("jd7orgA", { environment: "production", committed: 50, reserved: 0 }),
      org("jd7orgA", { environment: "sandbox", committed: 0, reserved: 3 }),
    ],
    usageEvents: [
      ...(expiring
        ? [org("jd7orgB", { state: "reserved", createdAt: Date.now() - 86_340_000 })]
        : []),
      ...Array.from({ length: events }, () => org("jd7orgB", { state: "committed", createdAt: 0 })),
    ],
  };
  const select = (table: string, fields: Row) =>
    (tables[table] ??= []).filter((r) => Object.entries(fields).every(([k, v]) => r[k] === v));
  const db = {
    query(table: string) {
      const fields: Row = {};
      const chain = {
        withIndex(_index: string, build?: (q: Row) => unknown) {
          const q = { eq: (k: string, v: unknown) => ((fields[k] = v), q) };
          build?.(q);
          return chain;
        },
        take: async (n: number) => select(table, fields).slice(0, n),
        unique: async () => select(table, fields)[0] ?? null,
      };
      return chain;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  let assignments = 0;
  const hosted = {
    target: { siteUrl: "https://site.invalid" },
    query: (body: string) => new AsyncFunction("ctx", body)({ db }),
    rows: async (table: string, _index: string, fields: Row) => select(table, fields),
    logs: async () => ({ cursor: 1, entries: [] }),
    rpc: async (_kind: string, path: string, args: Row) => {
      expect(path).toBe("usage:assignPlan");
      if (assignments++ === failAssignment) throw new Error("Validation backend rejected");
      const { organizationId, expectedVersion, actor, reason, ...plan } = args;
      expect([actor, reason].every(Boolean)).toBe(true);
      const before = select("usagePlans", { organizationId })[0];
      expect(before?.version ?? 0).toBe(expectedVersion);
      tables.usagePlans = tables.usagePlans!.filter((p) => p !== before);
      tables.usagePlans.push({ organizationId, ...plan, version: expectedVersion + 1 });
      return expectedVersion + 1;
    },
  };
  const imports = new Map<string, Row>();
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  let reads = 0;
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    await Promise.resolve();
    const scope = scopes.find((s) => init.headers.Authorization === `Bearer ${s.secret}`)!;
    if (url.includes("/v1/documents?")) {
      expect(url).toContain(`companyId=${scope.companyId}&limit=50`);
      reads++;
      return reply(200, { data: { page: Array.from({ length: 50 }, () => ({})) } });
    }
    const key = init.headers["Idempotency-Key"]!;
    if (imports.has(key)) return reply(200, { data: imports.get(key) });
    const organizationId = scope.organizationId;
    const counted = select("usageTotals", { organizationId, period }).filter(
      (r) => !r.environment || r.environment === "sandbox",
    );
    const used = counted.reduce((n, r) => n + r.committed + r.reserved, 0);
    const plan = select("usagePlans", { organizationId })[0];
    if (plan && used + 1 > plan.limits.imports)
      return reply(429, { error: { code: "RATE_LIMITED", retryable: false } });
    const fileId = `jd7file${imports.size}`;
    tables.usageEvents!.push(
      org(organizationId, { environment: "sandbox", key: fileId, state: "reserved" }),
    );
    let total = counted.find((r) => r.environment === "sandbox");
    if (!total)
      tables.usageTotals!.push(
        (total = org(organizationId, { environment: "sandbox", committed: 0, reserved: 0 })),
      );
    total.reserved++;
    imports.set(key, { importId: `jd7import${imports.size}`, fileIds: [fileId] });
    return reply(200, { data: imports.get(key) });
  };
  return { hosted, fetch, state: { scopes } as Row, tables, reads: () => reads };
}
const run = (env: ReturnType<typeof simulated>, args: string[] = []) =>
  planLoad(
    env.hosted,
    env.state,
    () => {},
    planLoadOptions(["--contention-balance", "2", ...args]),
    { fetch: env.fetch, spacingMs: 0 },
  );

it("assigns the ample plans, then the contended balance, and reports without ids or keys", async () => {
  const env = simulated();
  const report = await run(env);
  expect(report.result).toBe("passed");
  expect(report.plans.map((p: Row) => [p.organization, p.phase, p.limits.imports])).toEqual([
    [1, "ample", 1000],
    [2, "ample", 1000],
    // 8 counted before the run (Production excluded) + 51 ample admissions + 2 left.
    [1, "contention", 61],
  ]);
  expect(report.rounds.slice(0, 3).map((r: Row) => r.perOrganization)).toEqual([
    [17, 17],
    [17, 17],
    [17, 17],
  ]);
  expect(report.rounds[3]).toMatchObject({
    outcomes: { accepted: 2, quota: 18 },
    effects: 2,
    totalsDelta: 2,
    replay: { requests: 2, sameImports: 2, totalsDelta: 0 },
  });
  expect(report.leftPlans).toEqual([
    { organization: 1, phase: "contention", version: 2, imports: 61 },
    { organization: 2, phase: "ample", version: 1, imports: 1000 },
  ]);
  expect(JSON.stringify(report)).not.toMatch(/jd7|fnfe_/);
  expect(await closePlans(env.hosted, env.state)).toEqual({ closed: 2, skipped: [], failed: [] });
  expect(env.tables.usagePlans!.every((p) => p.limits.imports === 0)).toBe(true);
  expect((await closePlans(env.hosted, env.state)).skipped).toHaveLength(2);
});

it("reads the first page during the ample rounds, never during the contention", async () => {
  const env = simulated();
  const report = await run(env, ["--admissions-per-round", "20", "--reads-per-round", "100"]);
  expect(report.result).toBe("passed");
  expect(env.reads()).toBe(300);
  for (const round of report.rounds.slice(0, 3)) {
    expect(round.perOrganization).toEqual([10, 10]);
    expect(round.reads).toMatchObject({ requests: 100, outcomes: { read: 100 }, minPage: 50 });
    expect(round.assessment.checks).toMatchObject({
      readsAnswered: true,
      readsWithinLatency: true,
    });
  }
  expect(report.rounds[3]).not.toHaveProperty("reads");
});

it("records the run before assigning, so cleanup closes the plans of a partial failure", async () => {
  const env = simulated({ failAssignment: 1 });
  const report = await run(env);
  expect(report).toMatchObject({ result: "failed", error: "Validation backend rejected" });
  expect(report.leftPlans).toEqual([
    { organization: 1, phase: "ample", version: 1, imports: 1000 },
    { organization: 2, phase: null },
  ]);
  expect(await closePlans(env.hosted, env.state)).toEqual({
    closed: 1,
    skipped: [{ organization: 2, reason: "noPlan" }],
    failed: [],
  });
});

it("refuses to start while a reservation of these organizations expires during the run", async () => {
  const env = simulated({ expiring: true });
  const report = await run(env);
  expect(report.result).toBe("failed");
  expect(report.error).toContain("expiram durante o ensaio");
  expect(report.plans).toEqual([]);
  expect(env.state.planLoad).toBeDefined();
});

it("refuses a commercial deployment and an organization beyond the expiry check", async () => {
  await expect(run(simulated({ commercial: true }))).rejects.toThrow("PLAN_UNAVAILABLE");
  const crowded = await run(simulated({ events: 4000 }));
  expect(crowded.error).toContain("4.000 eventos");
  expect(crowded.plans).toEqual([]);
});

it("revokes and removes in cleanup even when closing a plan is refused", async () => {
  const env = simulated({ failAssignment: 3 });
  expect((await run(env)).result).toBe("passed");
  const order: string[] = [];
  const result = await cleanupWithPlans(env.hosted, env.state, async () => {
    order.push("cleanup");
    return { result: "passed", revokedKeys: 2 };
  });
  expect(order).toEqual(["cleanup"]);
  expect(result).toMatchObject({
    result: "passed",
    revokedKeys: 2,
    closedPlans: {
      closed: 1,
      failed: [{ organization: 1, error: "Validation backend rejected" }],
    },
  });
  const unreadable = { ...env.hosted, rows: () => Promise.reject(new Error("rows down")) };
  const again = await cleanupWithPlans(unreadable, env.state, async () => ({ result: "passed" }));
  expect(again.closedPlans.failed).toHaveLength(2);
});
it("counts retried completions per function and conflicting table, never the clean ones", () => {
  const entry = (
    identifier: string,
    occRetries: number,
    occTable: string | null,
    path?: string,
  ) => ({
    identifier,
    occRetries,
    occTable,
    componentPath: path ?? null,
  });
  expect(
    occByTable([
      entry("importRest.js:dispatch", 2, "usageTotals"),
      entry("importRest.js:dispatch", 1, "usageTotals"),
      entry("lib.js:rateLimitMany", 1, "rateLimits", "rateLimiter"),
      entry("importRest.js:dispatch", 0, null),
      entry("observability.js:recordRequest", 3, null),
    ]),
  ).toEqual({
    "importRest.js:dispatch usageTotals": 2,
    "rateLimiter/lib.js:rateLimitMany rateLimits": 1,
    "observability.js:recordRequest unknown": 1,
  });
});
