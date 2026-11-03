import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { headers } from "./hosted-fixtures.mjs";
import { runtimeUsage } from "./hosted-load.mjs";

/** Private criterion for admissions with ample balance (#79/#429). */
export const ADMISSION_P95_MS = 2500;
/** Private criterion for the first page of metadata, accepted on 06/10 (#79). */
export const READ_P95_MS = 1200;
/** `restLimits.ts`: each synthetic organization has one key, and `rest-actor` admits 60 a minute. */
export const REST_ACTOR_PER_MINUTE = 60;
/** `imports.ts` admits at most 20 batches per organization in a fixed 60 s window. */
export const IMPORTS_PER_ORGANIZATION_WINDOW = 20;
const MiB = 2 ** 20;
/** Mirrors PLATFORM_PLANS.intermediate; the test keeps both equal. */
export const INTERMEDIATE = {
  name: "Intermediário",
  concurrency: 2,
  limits: { imports: 1000, captures: 1000, registry: 100, bytes: 128 * MiB, deliveries: 3000 },
};

const integer = (args, flag, fallback, min, max) => {
  const at = args.indexOf(flag);
  const value = at === -1 ? fallback : Number(args[at + 1]);
  assert.ok(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${flag} precisa ser inteiro entre ${min} e ${max}`,
  );
  return value;
};
/** Validated before credentials: each round must stay inside the organization admission window. */
export function planLoadOptions(args) {
  const known = [
    "--clients",
    "--admissions-per-round",
    "--reads-per-round",
    "--contention-balance",
  ];
  for (let i = 0; i < args.length; i += 2)
    assert.ok(known.includes(args[i]), `Opção desconhecida para plan-load: ${args[i]}`);
  const perWindow = IMPORTS_PER_ORGANIZATION_WINDOW;
  // 34 per round, 17 per organization: 102 admissions with ample balance.
  const admissionsPerRound = integer(args, "--admissions-per-round", 34, 2, 2 * perWindow);
  // Reads share the key with the admissions, so both together stay inside one `rest-actor` minute.
  const readsPerRound = integer(
    args,
    "--reads-per-round",
    0,
    0,
    2 * (REST_ACTOR_PER_MINUTE - Math.ceil(admissionsPerRound / 2)),
  );
  return {
    rounds: 3,
    clients: integer(args, "--clients", 20, 1, 20),
    admissionsPerRound,
    readsPerRound,
    // The contention round sends 20 admissions to one organization, so at least one is refused.
    contentionRequests: perWindow,
    contentionBalance: integer(args, "--contention-balance", 1, 1, perWindow - 1),
  };
}

/** Intermediário limits with an imports quota that cannot run out during the ample rounds. */
export function amplePlan(used, planned) {
  assert.ok([used, planned].every((n) => Number.isSafeInteger(n) && n >= 0));
  const imports = Math.max(INTERMEDIATE.limits.imports, used + planned);
  return { ...INTERMEDIATE, limits: { ...INTERMEDIATE.limits, imports } };
}
/** Same plan with exactly `balance` imports left in the Sandbox balance. */
export function contentionPlan(used, balance) {
  assert.ok(
    Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(balance) && balance > 0,
  );
  return { ...INTERMEDIATE, limits: { ...INTERMEDIATE.limits, imports: used + balance } };
}
/** Left by `cleanup`: the plan stays assigned and audited, with no quota left. */
export const closedPlan = {
  name: "Ensaio encerrado",
  concurrency: 1,
  limits: { imports: 0, captures: 0, registry: 0, bytes: 0, deliveries: 0 },
};

/** A plan quota refusal is 429 RATE_LIMITED without retry; the rate limiter's is retryable. */
export function classifyAdmission(status, body) {
  // A 200 without the admission's ids is not counted as accepted; the status stays in the round.
  if (status === 200)
    return typeof body?.data?.importId === "string" && body.data.fileIds?.[0] != null
      ? "accepted"
      : "other";
  if (status === 429 && body?.error?.code === "RATE_LIMITED")
    return body.error.retryable === false ? "quota" : "rateLimited";
  return "other";
}
/** The first page of metadata, as in the 05/10 load; a 429 from the limiter is not a read. */
export function classifyRead(status, body) {
  if (status === 200) return Array.isArray(body?.data?.page) ? "read" : "other";
  if (status === 429 && body?.error?.code === "RATE_LIMITED") return "rateLimited";
  return "other";
}
const quantile = (values, p) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
/** Success and refusal latencies are separate, so refusals never improve the success p95. */
export function summarizeRound(name, samples) {
  const statuses = {},
    outcomes = { accepted: 0, quota: 0, rateLimited: 0, other: 0 };
  for (const s of samples) {
    statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    outcomes[s.outcome]++;
  }
  const ms = (outcome) => samples.filter((s) => s.outcome === outcome).map((s) => s.ms);
  return {
    name,
    requests: samples.length,
    statuses,
    outcomes,
    successP95Ms: quantile(ms("accepted"), 0.95),
    refusalP95Ms: quantile(ms("quota"), 0.95),
    maxMs: samples.length ? Math.max(...samples.map((s) => s.ms)) : null,
  };
}

/** Reads of one round; `minPage` shows whether the pages were full (50) as in 05/10. */
export function summarizeReads(samples) {
  const statuses = {},
    outcomes = { read: 0, rateLimited: 0, other: 0 };
  for (const s of samples) {
    statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    outcomes[s.outcome]++;
  }
  const ok = samples.filter((s) => s.outcome === "read");
  return {
    requests: samples.length,
    statuses,
    outcomes,
    p95Ms: quantile(
      ok.map((s) => s.ms),
      0.95,
    ),
    maxMs: samples.length ? Math.max(...samples.map((s) => s.ms)) : null,
    minPage: ok.length ? Math.min(...ok.map((s) => s.page)) : null,
  };
}

const verdict = (checks) => ({ checks, passed: Object.values(checks).every(Boolean) });
/**
 * Ample balance: every admission accepted once, within the private p95. A 429 is a failure.
 * `effects` counts the usage events of this run's accepted keys, so the check does not depend on
 * other reservations of the organization; `totalsDelta` must agree with it.
 * @param {any} round
 * @param {{ expected: number, totalsDelta: number, effects: number, distinctImports: number,
 *   reads?: ReturnType<typeof summarizeReads>, expectedReads?: number }} facts
 */
export function assessAmpleRound(
  round,
  { expected, totalsDelta, effects, distinctImports, reads, expectedReads = 0 },
) {
  return verdict({
    complete: round.requests === expected,
    allAccepted: round.outcomes.accepted === expected && round.statuses[200] === expected,
    withinLatency: Number.isFinite(round.successP95Ms) && round.successP95Ms <= ADMISSION_P95_MS,
    noDuplicateEffect:
      effects === expected && totalsDelta === expected && distinctImports === expected,
    // Concurrent reads (#79): every one answered 200 within the read p95.
    ...(expectedReads > 0 && {
      readsAnswered: reads?.requests === expectedReads && reads.outcomes.read === expectedReads,
      readsWithinLatency: Number.isFinite(reads?.p95Ms) && reads.p95Ms <= READ_P95_MS,
    }),
  });
}
/** Last units: exactly `balance` accepted, every other answer the plan quota refusal. */
export function assessContentionRound(
  round,
  { requests, balance, totalsDelta, effects, distinctImports, replay },
) {
  return verdict({
    complete: round.requests === requests,
    acceptedBalance: round.outcomes.accepted === balance,
    refusedByQuota: round.outcomes.quota === requests - balance,
    noOtherAnswer: round.outcomes.rateLimited === 0 && round.outcomes.other === 0,
    effectsMatchAccepted:
      effects === balance && totalsDelta === balance && distinctImports === balance,
    replayWithoutEffect: replay.sameImports === balance && replay.totalsDelta === 0,
  });
}

/**
 * Retried completions per function and the table Convex named in the conflict (`occInfo`), so a
 * round says which documents the admissions disputed (#559). A completion without a named table
 * counts under `unknown`.
 */
export function occByTable(entries) {
  const counts = {};
  for (const e of entries) {
    if (!(e.occRetries > 0)) continue;
    const key = `${e.componentPath ? `${e.componentPath}/` : ""}${e.identifier} ${e.occTable ?? "unknown"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** `imports.ts` RESERVATION_TTL: a batch never uploaded releases its usage after 24 h. */
const RESERVATION_TTL = 24 * 3600_000;
/** Longer than the run (four windows of 61 s plus the requests), with margin. */
const RUN_HORIZON = 30 * 60_000;
/** Plan term; `cleanup` after it finds PLAN_INACTIVE (403) answers in between, then closes. */
export const PLAN_TERM = 7 * 86_400_000;

/**
 * Runs against the prepared synthetic scopes and returns a report without keys or ids. A failed
 * step ends the run with `result: "failed"`; `leftPlans` lists what was really assigned.
 */
export async function planLoad(hosted, state, savePrivate, options, deps = {}) {
  const { fetch: request = fetch, spacingMs = 61_000 } = deps;
  assert.equal(state.scopes.length, 2, "Prepare as duas organizações antes de plan-load");
  assert.ok(
    state.scopes.every((s) => s.source),
    "Conclua prepare antes de plan-load",
  );
  const commercial = await hosted.query(
    `return (await ctx.db.query("platformPlanSettings").withIndex("by_key", q => q.eq("key", "platform")).unique())?.enabled === true;`,
  );
  assert.equal(
    commercial,
    false,
    "Política comercial ligada: assignPlan recusaria o plano assistido (PLAN_UNAVAILABLE)",
  );
  const period = new Date().toISOString().slice(0, 7);
  const org = (s) => JSON.stringify(s.organizationId);
  // Every lane of both environments and the unattributed total (`USAGE_LANES`, #559).
  const usage = (s) =>
    hosted.query(`
      const rows = await ctx.db.query("usageTotals").withIndex("by_organizationId_and_period_and_metric_and_environment",
        q => q.eq("organizationId", ${org(s)}).eq("period", ${JSON.stringify(period)}).eq("metric", "imports")).take(17);
      return rows.filter(r => !r.environment || r.environment === "sandbox").reduce((n, r) => n + r.committed + r.reserved, 0);`);
  // Usage events of this run's accepted file keys, in Sandbox and not released.
  const effects = (s, keys) =>
    hosted.query(`
      const rows = await Promise.all(${JSON.stringify(keys)}.map(key => ctx.db.query("usageEvents")
        .withIndex("by_organizationId_and_metric_and_key", q => q.eq("organizationId", ${org(s)}).eq("metric", "imports").eq("key", key)).unique()));
      return rows.filter(r => r && r.environment === "sandbox" && r.state !== "released").length;`);
  // A reservation released mid-run would move the totals and the contended balance.
  const assertNoExpiry = async () => {
    const horizon = Date.now() + RUN_HORIZON;
    for (const s of state.scopes) {
      const due = await hosted.query(`
        const rows = await ctx.db.query("usageEvents").withIndex("by_organizationId_and_updatedAt", q => q.eq("organizationId", ${org(s)})).take(4000);
        if (rows.length === 4000) return -1;
        return rows.filter(r => r.metric === "imports" && r.state === "reserved" && r.createdAt + ${RESERVATION_TTL} <= ${horizon}).length;`);
      assert.notEqual(
        due,
        -1,
        "Organização com 4.000 eventos de uso ou mais: a conferência de vencimento não cobre todos; use um estado novo",
      );
      assert.equal(
        due,
        0,
        "Reservas de importação destas organizações expiram durante o ensaio; use um estado novo ou aguarde a expiração",
      );
    }
  };
  const current = async (s) =>
    (
      await hosted.rows("usagePlans", "by_organizationId", { organizationId: s.organizationId }, 1)
    )[0]?.version ?? 0;
  /** @type {Record<string, any>} */
  const report = { period, environment: "sandbox", plans: [], rounds: [] };
  const assign = async (i, plan, phase, reason) => {
    const s = state.scopes[i];
    const startsAt = Date.now() - 60_000;
    const version = await hosted.rpc("mutation", "usage:assignPlan", {
      organizationId: s.organizationId,
      ...plan,
      startsAt,
      endsAt: startsAt + PLAN_TERM,
      expectedVersion: await current(s),
      actor: "hosted-plan-load",
      reason,
    });
    report.plans.push({ organization: i + 1, phase, version, ...plan });
  };
  const admit = async (s, key = randomUUID()) => {
    const at = performance.now();
    try {
      const res = await request(`${hosted.target.siteUrl}/v1/imports`, {
        method: "POST",
        headers: { ...headers(s), "Idempotency-Key": key },
        body: JSON.stringify({
          companyId: s.companyId,
          files: [{ name: "synthetic.xml", size: 100, sha256: "a".repeat(64) }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json().catch(() => null);
      const outcome = classifyAdmission(res.status, body);
      const accepted = outcome === "accepted";
      return {
        status: res.status,
        outcome,
        ms: performance.now() - at,
        key,
        importId: accepted ? body.data.importId : null,
        fileKey: accepted ? String(body.data.fileIds[0]) : null,
      };
    } catch {
      return { status: 0, outcome: "other", ms: performance.now() - at, key, importId: null };
    }
  };
  const read = async (s) => {
    const at = performance.now();
    try {
      const res = await request(
        `${hosted.target.siteUrl}/v1/documents?companyId=${s.companyId}&limit=50`,
        { headers: headers(s), signal: AbortSignal.timeout(30_000) },
      );
      const body = await res.json().catch(() => null);
      const outcome = classifyRead(res.status, body);
      const page = outcome === "read" ? body.data.page.length : null;
      return { status: res.status, outcome, ms: performance.now() - at, page };
    } catch {
      return { status: 0, outcome: "other", ms: performance.now() - at, page: null };
    }
  };
  // Admissions and reads spread evenly over the round, taken in order by the same clients.
  const jobs = [
    ...Array.from({ length: options.admissionsPerRound }, (_, k) => ({
      kind: "admit",
      k,
      at: (k + 0.5) / options.admissionsPerRound,
    })),
    ...Array.from({ length: options.readsPerRound ?? 0 }, (_, k) => ({
      kind: "read",
      k,
      at: (k + 0.5) / options.readsPerRound,
    })),
  ].sort((a, b) => a.at - b.at);
  // Sampled once after each round: entries that arrive later fall into the next sample.
  let cursor = null;
  for (let i = 0; i < 3 && cursor === null; i++) {
    const first = await hosted.logs(0);
    if (!first.idle) cursor = first.cursor;
  }
  const runtime = async () => {
    if (cursor === null) return null;
    const { cursor: next, entries } = await hosted.logs(cursor);
    cursor = next;
    const { total } = runtimeUsage(entries);
    return {
      calls: total.calls,
      errors: total.errors,
      occRetryAttempts: total.observedRetryAttempts,
      occByTable: occByTable(entries),
    };
  };
  report.runtimeNote =
    "Conflitos aproximados: amostra única do stream de logs após cada rodada; entradas atrasadas caem na rodada seguinte. Nulo se o cursor inicial não foi obtido.";
  // Before the first assignment, so `cleanup` closes plans after a partial failure.
  state.planLoad = { startedAt: new Date().toISOString() };
  savePrivate(state);
  try {
    await assertNoExpiry();
    const planned = Math.ceil(options.admissionsPerRound / 2) * options.rounds;
    for (const [i, s] of state.scopes.entries())
      await assign(i, amplePlan(await usage(s), planned), "ample", "Carga com plano (#429)");
    await runtime();
    for (let r = 1; r <= options.rounds; r++) {
      await assertNoExpiry();
      const before = await Promise.all(state.scopes.map(usage));
      const samples = [],
        readSamples = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: options.clients }, async () => {
          for (let j = next++; j < jobs.length; j = next++) {
            const { kind, k } = jobs[j];
            if (kind === "read") readSamples.push(await read(state.scopes[k % 2]));
            else samples.push({ ...(await admit(state.scopes[k % 2])), scope: k % 2 });
          }
        }),
      );
      const after = await Promise.all(state.scopes.map(usage));
      const counted = await Promise.all(
        state.scopes.map((s, i) =>
          effects(
            s,
            samples.flatMap((x) => (x.scope === i && x.fileKey ? [x.fileKey] : [])),
          ),
        ),
      );
      const round = summarizeRound(`ample-round-${r}`, samples);
      const facts = {
        expected: options.admissionsPerRound,
        perOrganization: [0, 1].map((i) => samples.filter((x) => x.scope === i).length),
        totalsDelta: after.reduce((n, v, i) => n + v - before[i], 0),
        effects: counted[0] + counted[1],
        distinctImports: new Set(samples.flatMap((x) => (x.importId ? [x.importId] : []))).size,
        ...(options.readsPerRound > 0 && {
          expectedReads: options.readsPerRound,
          reads: summarizeReads(readSamples),
        }),
      };
      const assessment = assessAmpleRound(round, facts);
      report.rounds.push({ ...round, ...facts, runtime: await runtime(), assessment });
      console.log(JSON.stringify(report.rounds.at(-1)));
      // A new fixed admission window per round, as in the 05/10 load.
      await delay(spacingMs);
    }
    await assertNoExpiry();
    const target = state.scopes[0];
    const used = await usage(target);
    const plan = contentionPlan(used, options.contentionBalance);
    await assign(0, plan, "contention", "Disputa das últimas unidades (#429)");
    const samples = await Promise.all(
      Array.from({ length: options.contentionRequests }, () => admit(target)),
    );
    const afterContention = await usage(target);
    const accepted = samples.filter((x) => x.importId);
    const replays = await Promise.all(accepted.map((x) => admit(target, x.key)));
    const round = summarizeRound("contention", samples);
    const facts = {
      requests: options.contentionRequests,
      balance: options.contentionBalance,
      totalsDelta: afterContention - used,
      effects: await effects(
        target,
        accepted.map((x) => x.fileKey),
      ),
      distinctImports: new Set(accepted.map((x) => x.importId)).size,
      replay: {
        requests: replays.length,
        sameImports: replays.filter((x, i) => x.importId === accepted[i].importId).length,
        totalsDelta: (await usage(target)) - afterContention,
      },
    };
    const assessment = assessContentionRound(round, facts);
    report.rounds.push({ ...round, ...facts, runtime: await runtime(), assessment });
    console.log(JSON.stringify(report.rounds.at(-1)));
    assert.equal(
      new Date().toISOString().slice(0, 7),
      period,
      "O período de uso mudou durante o ensaio",
    );
    report.result = report.rounds.every((r) => r.assessment.passed) ? "passed" : "failed";
  } catch (error) {
    report.result = "failed";
    report.error = error.message;
  }
  const last = new Map(report.plans.map((p) => [p.organization, p]));
  report.leftPlans = [1, 2].map((organization) => {
    const plan = last.get(organization);
    return plan
      ? { organization, phase: plan.phase, version: plan.version, imports: plan.limits.imports }
      : { organization, phase: null };
  });
  return report;
}

/**
 * Called by `cleanup`: closes the plan of each organization of a started `plan-load`. Never
 * throws: a refusal (commercial policy, version conflict, closed organization) is reported per
 * organization, so key revocation and metadata removal still run.
 */
export async function closePlans(hosted, state) {
  const result = { closed: 0, skipped: [], failed: [] };
  if (!state.planLoad) return result;
  for (const [i, s] of state.scopes.entries()) {
    try {
      const current = (
        await hosted.rows(
          "usagePlans",
          "by_organizationId",
          { organizationId: s.organizationId },
          1,
        )
      )[0];
      if (!current || current.name === closedPlan.name) {
        result.skipped.push({ organization: i + 1, reason: current ? "alreadyClosed" : "noPlan" });
        continue;
      }
      await hosted.rpc("mutation", "usage:assignPlan", {
        organizationId: s.organizationId,
        ...closedPlan,
        startsAt: current.startsAt,
        endsAt: current.endsAt,
        expectedVersion: current.version,
        actor: "hosted-plan-load",
        reason: "Encerramento do ensaio de carga com plano (#429)",
      });
      result.closed++;
    } catch (error) {
      result.failed.push({ organization: i + 1, error: error.message });
    }
  }
  return result;
}

/** `cleanup`: plan closing first, without blocking the revocation and removal that follow. */
export async function cleanupWithPlans(hosted, state, cleanup) {
  const closedPlans = await closePlans(hosted, state);
  return { ...(await cleanup(hosted, state)), closedPlans };
}
