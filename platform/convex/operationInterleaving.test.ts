import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Infer } from "convex/values";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { register } from "../test-setup";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { LEASE_MS, type outcome } from "./lib/operationValues";
import { abandonBeforeEffect } from "./lib/operationCore";
import { modules } from "../../tests/helpers/convex-modules";

/**
 * The guarantees of OPERATIONS.md under interleaving (#122). Each seed drives one operation
 * through a random order of claims, effect steps, results, stale and crossed tokens, recoveries,
 * duplicated callbacks, pauses, retries, abandons and expired leases, under a fake clock, and
 * checks after every step:
 *
 * 1. only the active claim (generation + fence, running, lease valid) writes;
 * 2. after `calling`, an effect that may have left is only reconciled or resumed, never executed;
 * 3. one effect per operation: one result document, one receipt of each kind;
 * 4. `succeeded` comes only from `publish`;
 * 5. attempts and recoveries stay within their budgets.
 *
 * A failure names the seed and the steps, so the same order replays.
 */

const SEEDS = Array.from({ length: 48 }, (_, i) => 0x1220 + i);
const STEPS = 60;
const EFFECT_URL = "http://127.0.0.1:9/effect";
/** Recoveries per operation (OPERATIONS.md, "Recuperação e limites"). */
const RECOVERY_BUDGET = 12;

beforeEach(() => {
  vi.useFakeTimers();
  // A fixed start, so a seed replays the same usage periods and day boundaries too.
  vi.setSystemTime(Date.UTC(2026, 0, 15, 12));
  for (const [k, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5190",
    CONVEX_SITE_URL: "http://127.0.0.1:3239",
    BETTER_AUTH_SECRET: "synthetic-operations-secret",
  }))
    vi.stubEnv(k, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** mulberry32: small, fixed and enough to replay an order from its seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const task = {
  name: "proof.import",
  workload: "import" as const,
  scope: "documents:import" as const,
  executor: "testing/operationTransport:execute",
  reconciler: "testing/operationTransport:reconcile",
  checkpoint: "testing/operationProof:checkpoint",
};

async function fixture() {
  const t = convexTest(schema, modules);
  register(t);
  const keyHash = await hashApiKey(`fnfe_${"a".repeat(43)}`);
  const scope = await t.mutation(internal.testing.operationProof.prepare, {
    keyHash,
    suffix: crypto.randomUUID(),
  });
  // The clock walks for hours across a run; the key stays valid so access is not what decides.
  await t.run((ctx) =>
    ctx.db.patch("apiKeys", scope.keyId, { expiresAt: Date.now() + 365 * 86_400_000 }),
  );
  const { operationId } = await t.mutation(internal.operations.reserve, {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    companyId: scope.companyId,
    environment: "sandbox",
    keyHash,
    key: "interleaving",
    request: JSON.stringify({ url: EFFECT_URL }),
    task,
  });
  return { t, keyHash, operationId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Op = Doc<"operations">;
type Token = { generation: number; fence: number };

async function snapshot(f: Fixture) {
  const seen = await f.t.query(internal.testing.operationProof.inspect, {
    operationId: f.operationId,
  });
  return { ...seen, operation: seen.operation! };
}
const isActive = (op: Op, token: Token) =>
  op.generation === token.generation &&
  op.fence === token.fence &&
  op.state === "running" &&
  op.leaseUntil > Date.now();
const terminal = (op: Op) => op.state === "succeeded" || op.state === "failed";

type Outcome = Infer<typeof outcome>;

it.each(SEEDS)("semente %i: intercalação preserva as garantias do protocolo", async (seed) => {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number) => random() < p;
  // Backoff jitter reads Math.random; a second fixed stream keeps the replay exact.
  vi.spyOn(Math, "random").mockImplementation(prng(seed ^ 0x5eed));
  const f = await fixture();
  const trace: string[] = [];
  const fail = (message: string) => `seed ${seed}: ${message}\n  ${trace.join("\n  ")}`;

  /** Every (generation, fence) a claim handed out, and the work IDs the pool was given. */
  const tokens: Token[] = [];
  const workIds = new Set<NonNullable<Op["workId"]>>();
  /** An effect may have reached the source and no recorded result settled it. */
  let pending = false;
  /** The token whose attempt is in `calling` from a step of the driver, if any. */
  let calling: Token | null = null;
  let posts = 0;
  /** A guarantee broken inside the worker, where a throw would only fail the action. */
  let violation: string | null = null;
  const check = (ok: boolean, message: string) => {
    if (!ok) violation ??= fail(message);
  };

  const remember = (op: Op) => {
    if (!tokens.some((t) => t.generation === op.generation && t.fence === op.fence))
      tokens.push({ generation: op.generation, fence: op.fence });
    if (op.workId) workIds.add(op.workId);
  };
  /**
   * The active token, a stale one, or one crossing the current fence with another generation
   * (or the reverse), so each half of the claim is checked on its own.
   */
  const someToken = (op: Op): Token => {
    const current = { generation: op.generation, fence: op.fence };
    if (op.state === "running" && chance(0.5)) return current;
    const generations = [...new Set([...tokens.map((t) => t.generation), op.generation + 1])];
    const fences = [...new Set([...tokens.map((t) => t.fence), op.fence + 1])];
    const other = <T>(items: T[], not: T) => pick(items.filter((item) => item !== not));
    return pick([
      { ...current, generation: other(generations, op.generation) },
      { ...current, fence: other(fences, op.fence) },
      tokens.length ? pick(tokens) : { ...current, fence: op.fence + 1 },
    ]);
  };

  // The source: the executor POSTs (the effect), the reconciler GETs (a consultation).
  let interleave: (() => Promise<void>) | null = null;
  let status = 200;
  let call: { token: Token; method: string; alive: boolean } | null = null;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const op = (await snapshot(f)).operation;
    remember(op);
    const token = { generation: op.generation, fence: op.fence };
    // Invariant 2: the executor never runs while an earlier effect may have left.
    if (method === "POST") {
      posts++;
      check(!pending, "executor ran while an effect was pending");
      check(!op.uncertain, "executor ran on an uncertain operation");
    }
    if (interleave) await interleave();
    call = { token, method, alive: isActive((await snapshot(f)).operation, token) };
    return new Response(JSON.stringify({ synthetic: seed }), { status });
  });

  /** Recorded results the model accepts; anything else leaves the source unsettled. */
  const settle = (kind: Outcome["kind"], before: Op) => {
    if (kind === "success" || kind === "definitive") pending = false;
    else if (kind === "uncertain" || kind === "absent") pending = true;
    else pending = pending && before.uncertain;
  };

  const outcomes = (op: Op): Outcome[] => [
    { kind: "success", response: JSON.stringify({ synthetic: seed }) },
    { kind: "success", response: JSON.stringify({ synthetic: seed }) },
    { kind: "uncertain", code: "SYNTHETIC_TIMEOUT" },
    { kind: "transient", code: "SYNTHETIC_BUSY" },
    { kind: "definitive", code: "SYNTHETIC_REJECTED" },
    { kind: "wait", code: "SYNTHETIC_WINDOW", notBefore: Date.now() + 5_000 },
    // Absence is only valid while reconciling; outside it the call is refused whole.
    { kind: "absent", code: op.uncertain ? "NOT_OBSERVED_YET" : "INVALID_ABSENT" },
  ];

  const pauseOrRetry = async (action: "pause" | "retry", generation: number) => {
    await f.t.mutation(internal.operationRest.access, {
      keyHash: f.keyHash,
      environment: "sandbox",
      id: f.operationId,
      action,
      expectedGeneration: generation,
    });
  };

  /** The steps of the driver, repeated by weight. */
  type Kind =
    | "worker"
    | "claim"
    | "begin"
    | "outcome"
    | "checkpoint"
    | "publish"
    | "recover"
    | "expire"
    | "complete"
    | "dispatch"
    | "pause"
    | "retry"
    | "abandon"
    | "tick";
  const kinds: Kind[] = [
    "worker",
    "worker",
    "worker",
    "claim",
    "claim",
    "begin",
    "begin",
    "outcome",
    "outcome",
    "checkpoint",
    "publish",
    "recover",
    "expire",
    "expire",
    "complete",
    "dispatch",
    "pause",
    "retry",
    "retry",
    "abandon",
    "tick",
  ];

  const nextStage = {
    ready: "begin",
    calling: "outcome",
    response: "checkpoint",
    checkpoint: "publish",
  } as const satisfies Record<Op["stage"], Kind>;

  remember((await snapshot(f)).operation);
  for (let step = 0; step < STEPS; step++) {
    const before = await snapshot(f);
    const op = before.operation;
    const pendingBefore = pending;
    // A held claim usually moves to its next stage, so the driver walks whole attempts too; past
    // the response its worker sometimes dies, which the next claim must resume, not repeat.
    const held = op.state === "running" && op.leaseUntil > Date.now();
    const answered = op.stage === "response" || op.stage === "checkpoint";
    const roll = random();
    const next: Kind | null =
      held && roll < 0.6 ? (answered && chance(0.3) ? "expire" : nextStage[op.stage]) : null;
    // A late worker of the same claim number but another generation, or the reverse, calls the
    // step the operation is waiting for: each half of the claim must refuse it alone.
    const forged: Token | null =
      held && roll >= 0.6 && roll < 0.8
        ? chance(0.5)
          ? { generation: op.generation + pick([-1, 1]), fence: op.fence }
          : { generation: op.generation, fence: op.fence + pick([-1, 1]) }
        : null;
    const kind: Kind = next ?? (forged ? nextStage[op.stage] : pick(kinds));
    let expectUnchanged = false;
    let acceptedPublish = false;
    let token: Token | null = null;
    let label: string = kind;
    let threw: unknown = null;
    let abandoned = false;

    try {
      switch (kind) {
        case "worker": {
          if (op.nextAttemptAt > Date.now() && chance(0.8)) vi.setSystemTime(op.nextAttemptAt);
          status = pick([200, 500, 404, 500]);
          const during = pick(["none", "none", "pause", "lease", "stale", "complete"] as const);
          label = `worker(g${op.generation}, reply ${status}, during ${during})`;
          interleave = async () => {
            const now = (await snapshot(f)).operation;
            if (during === "pause") await pauseOrRetry("pause", now.generation).catch(() => {});
            if (during === "lease") {
              vi.setSystemTime(now.leaseUntil + 1);
              await f.t.mutation(internal.operations.recoverOne, { operationId: f.operationId });
            }
            if (during === "stale" && tokens.length > 1) {
              const old = tokens[0]!;
              const written = await f.t.mutation(internal.operations.recordOutcome, {
                operationId: f.operationId,
                ...old,
                outcome: { kind: "success", response: "stale" },
              });
              check(!written, "stale token recorded a result during the effect");
            }
            if (during === "complete" && now.workId)
              await f.t.mutation(internal.operations.onComplete, {
                workId: now.workId,
                context: { operationId: f.operationId, generation: now.generation },
                result: { kind: "success", returnValue: null },
              });
          };
          call = null;
          const postsBefore = posts;
          await f.t.action(internal.operationWorker.run, {
            operationId: f.operationId,
            generation: op.generation,
          });
          interleave = null;
          const done = call as { token: Token; method: string; alive: boolean } | null;
          // Only a 200 settles the source; a consultation answering 404 is absence, which keeps
          // the uncertainty, and a claim lost during the call leaves the effect unknown.
          if (done) pending = !(done.alive && status === 200);
          if (posts > postsBefore) label += " POST";
          break;
        }
        case "claim": {
          if (op.nextAttemptAt > Date.now() && chance(0.9)) vi.setSystemTime(op.nextAttemptAt);
          const generation = chance(0.85) ? op.generation : Math.max(1, op.generation - 1);
          label = `claim(g${generation})`;
          const claimed = await f.t.mutation(internal.operations.claim, {
            operationId: f.operationId,
            generation,
          });
          if (claimed) remember(claimed);
          break;
        }
        case "begin":
        case "outcome":
        case "checkpoint":
        case "publish": {
          token = next ? { generation: op.generation, fence: op.fence } : (forged ?? someToken(op));
          const active = isActive(op, token);
          const args = { operationId: f.operationId, ...token };
          label = `${kind}(g${token.generation}/f${token.fence}${active ? "" : " stale"})`;
          if (!active) expectUnchanged = true;
          let result: boolean;
          if (kind === "begin") {
            result = await f.t.mutation(internal.operations.beginEffect, args);
            if (result) calling = token;
          } else if (kind === "outcome") {
            const chosen = pick(outcomes(op));
            label += ` ${chosen.kind}`;
            result = await f.t.mutation(internal.operations.recordOutcome, {
              ...args,
              outcome: chosen,
            });
            if (active && op.stage === "calling") {
              settle(chosen.kind, op);
              calling = null;
            }
          } else if (kind === "checkpoint") {
            result = await f.t.mutation(internal.operations.checkpoint, args);
          } else {
            result = await f.t.mutation(internal.operations.publish, args);
            acceptedPublish = result;
          }
          if (!active) check(!result, `${label} was accepted`);
          break;
        }
        case "recover": {
          vi.setSystemTime(Date.now() + Math.floor(random() * 2 * LEASE_MS));
          label = `recover(+clock)`;
          await f.t.mutation(internal.operations.recoverOne, { operationId: f.operationId });
          break;
        }
        case "expire": {
          // The attempt's worker died wherever it was; the watchdog takes the operation back.
          label = `expire(${op.state}/${op.stage})`;
          if (op.state === "running") vi.setSystemTime(Math.max(Date.now(), op.leaseUntil));
          await f.t.mutation(internal.operations.recoverOne, { operationId: f.operationId });
          break;
        }
        case "complete": {
          const ids = [...workIds];
          const workId = op.workId && chance(0.6) ? op.workId : ids.length ? pick(ids) : null;
          if (!workId) break;
          const generation = chance(0.7) ? op.generation : Math.max(1, op.generation - 1);
          const lease = op.state === "running" && op.leaseUntil > Date.now();
          label = `onComplete(g${generation}${lease ? ", lease held" : ""})`;
          // A late or duplicated callback never takes a lease that is still held.
          if (lease) expectUnchanged = true;
          await f.t.mutation(internal.operations.onComplete, {
            workId,
            context: { operationId: f.operationId, generation },
            result: pick([
              { kind: "success" as const, returnValue: null },
              { kind: "failed" as const, error: "SYNTHETIC" },
              { kind: "canceled" as const },
            ]),
          });
          break;
        }
        case "dispatch": {
          label = `dispatch(g${op.generation})`;
          await f.t.mutation(internal.operations.dispatch, {
            operationId: f.operationId,
            generation: op.generation,
          });
          break;
        }
        case "pause":
        case "retry": {
          const generation = chance(0.85) ? op.generation : op.generation + 1;
          label = `${kind}(g${generation})`;
          await pauseOrRetry(kind, generation);
          break;
        }
        case "abandon": {
          label = `abandon(${op.state}/${op.stage})`;
          if (op.state !== "running" || op.leaseUntil <= Date.now()) break;
          // Only the driver knows its own `calling` sent nothing; a worker's may have.
          if (op.stage === "calling" && !(calling && isActive(op, calling))) break;
          abandoned = true;
          await f.t.run(async (ctx) =>
            abandonBeforeEffect(
              ctx,
              (await ctx.db.get("operations", f.operationId))!,
              "PLAN_REQUIRED",
            ),
          );
          // The domain proved nothing left: the attempt in `calling` sent nothing.
          calling = null;
          break;
        }
        case "tick": {
          const delta = pick([1_000, LEASE_MS, LEASE_MS + 1, 10 * LEASE_MS]);
          label = `tick(+${delta})`;
          vi.setSystemTime(Date.now() + delta);
          break;
        }
      }
    } catch (error) {
      threw = error;
      interleave = null;
      label += ` threw ${error instanceof Error ? error.message.slice(0, 60) : String(error)}`;
    }

    const after = await snapshot(f);
    const now = after.operation;
    remember(now);
    trace.push(`${step}: ${label} -> ${now.state}/${now.stage} g${now.generation} f${now.fence}`);

    expect(violation).toBeNull();
    // Nothing in the driver makes the worker throw; a throw would hide what its call left.
    if (kind === "worker") expect(threw, fail("the worker threw")).toBeNull();
    // `inspect` reads at most 50 attempts; past that the checks below would see too little.
    expect(after.attempts.length, fail("too many attempts to inspect")).toBeLessThan(50);
    // A refused call, or a mutation that threw, rolls back whole.
    if (expectUnchanged || (threw && kind !== "worker"))
      expect(JSON.stringify(after), fail(`${label} wrote`)).toBe(JSON.stringify(before));
    // An abandon is allowed only before the response; past it, it is refused.
    if (abandoned)
      expect(!!threw, fail("abandon accepted past the response, or refused before it")).toBe(
        op.stage === "response" || op.stage === "checkpoint",
      );

    // The driver's own attempt in `calling` that lost its claim may have reached the source.
    if (calling && !isActive(now, calling)) {
      pending = true;
      calling = null;
    }

    // Invariant 1: a new claim is the only thing that hands out a fence, one at a time.
    expect(now.fence, fail("fence went back")).toBeGreaterThanOrEqual(op.fence);
    expect(now.generation, fail("generation went back")).toBeGreaterThanOrEqual(op.generation);

    // Invariant 2: an effect that may have left keeps the operation uncertain (or still in
    // `calling`, which the recovery reads as uncertain), and every new attempt after it
    // reconciles or resumes.
    if (pending && !terminal(now))
      expect(
        now.uncertain || now.stage === "calling",
        fail("pending effect without uncertainty"),
      ).toBe(true);
    for (const attempt of after.attempts.slice(before.attempts.length))
      if (pendingBefore)
        expect(attempt.mode, fail("new execution after an effect that may have left")).not.toBe(
          "execute",
        );

    // Invariant 3: one effect per operation.
    expect(after.documents.length, fail("more than one result document")).toBeLessThanOrEqual(1);
    for (const receiptKind of ["result", "usage"] as const)
      expect(
        after.receipts.filter((r) => r.kind === receiptKind).length,
        fail(`more than one ${receiptKind} receipt`),
      ).toBeLessThanOrEqual(1);
    if (terminal(op)) {
      expect(now.state, fail("terminal state changed")).toBe(op.state);
      expect(after.receipts.length, fail("receipts changed after the end")).toBe(
        before.receipts.length,
      );
    }

    // Invariant 4: succeeded only through publish.
    if (now.state === "succeeded" && op.state !== "succeeded") {
      expect(
        acceptedPublish || kind === "worker",
        fail(`${label} produced succeeded without publish`),
      ).toBe(true);
      expect(after.receipts.map((r) => r.kind).sort(), fail("success without receipts")).toEqual([
        "result",
        "usage",
      ]);
      expect(after.documents, fail("success without checkpoint")).toHaveLength(1);
      expect(now.stage).toBe("checkpoint");
    }
    if (now.state !== "succeeded")
      expect(after.receipts, fail("receipts before success")).toHaveLength(0);

    // Invariant 5: budgets.
    expect(now.attempts, fail("attempts over the limit")).toBeLessThanOrEqual(now.maxAttempts);
    expect(now.recoveryAttempts ?? 0, fail("recoveries over the limit")).toBeLessThanOrEqual(
      RECOVERY_BUDGET,
    );
    // A wait gives back the attempt it was counted as (`waitOperation`).
    expect(now.attempts, fail("attempts disagree with their rows")).toBe(
      after.attempts.filter((a) => a.mode !== "resume" && a.code !== "SYNTHETIC_WINDOW").length,
    );
    if (now.state === "running")
      expect(now.leaseUntil - Date.now(), fail("lease longer than LEASE_MS")).toBeLessThanOrEqual(
        LEASE_MS,
      );

    if (terminal(now) && chance(0.1)) break;
  }
});
