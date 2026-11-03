import { capacityPlan, capacityPolicy } from "./capacityCore";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { components } from "../_generated/api";
import { noteLimit, planEnded, planLimit, usagePeriod, type UsageMetric } from "./usageValues";
import type { environment } from "./projectValues";
import { deny } from "./organizationAccess";

/**
 * Each environment has its own balance under the same plan limits (#429): sandbox use never
 * pauses production and the reverse. A row without environment predates #429 and is only read
 * here until `usageMigration.backfillEnvironment` attributes it.
 */
export type UsageEnvironment = typeof environment.type;
type StoredEnvironment = UsageEnvironment | undefined;

export const planFor = (ctx: QueryCtx, organizationId: Id<"organizations">) =>
  ctx.db
    .query("usagePlans")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
/** Keys name records of one environment, so a key is unique in the organization and metric. */
export const eventFor = (
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  metric: UsageMetric,
  key: string,
) =>
  ctx.db
    .query("usageEvents")
    .withIndex("by_organizationId_and_metric_and_key", (q) =>
      q.eq("organizationId", organizationId).eq("metric", metric).eq("key", key),
    )
    .unique();
/**
 * An environment's balance is split in `USAGE_LANES` rows (#559), so concurrent reservations of
 * one organization write different documents instead of all serializing on one total. Lane 0 is
 * the row without `lane`: every total written before the lanes, and the only lane of a total not
 * yet attributed to an environment. The balance is the sum of the lanes.
 */
export const USAGE_LANES = 8;
/**
 * `FNFE_USAGE_LANES=off` in the deployment stops new reservations from spreading: they all go to
 * lane 0 and no lane receives a new allowance, while reads keep summing every lane. It is the
 * first step of a rollback (`usageMigration.foldLanes`, docs/plataforma/USAGE.md).
 */
export const usageLanesEnabled = () => process.env.FNFE_USAGE_LANES !== "off";
/**
 * One lane index for everything an admission charges: its usage totals and its rate-limiter
 * budgets, also partitioned in 8 lanes (`rateUsage`). Two admissions of the same organization
 * then touch the same documents only when they draw the same lane (1 in 8), instead of whenever
 * any of the independently drawn lanes coincide. Which lane is used never changes a balance.
 */
export const pickLane = () => Math.floor(Math.random() * USAGE_LANES);
const laneField = (lane: number | undefined) => (lane ? lane : undefined);
/** One lane's row; an `undefined` environment reads the total not yet attributed (#429). */
export const laneTotal = (
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: StoredEnvironment,
  period: string,
  metric: UsageMetric,
  lane: number | undefined,
) =>
  ctx.db
    .query("usageTotals")
    .withIndex("by_organizationId_and_period_and_metric_and_environment_and_lane", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("period", period)
        .eq("metric", metric)
        .eq("environment", environment)
        .eq("lane", laneField(lane)),
    )
    .unique();
/** Every lane of one environment's total, or of the total not yet attributed. */
const environmentLanes = (
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: StoredEnvironment,
  period: string,
  metric: UsageMetric,
) =>
  ctx.db
    .query("usageTotals")
    .withIndex("by_organizationId_and_period_and_metric_and_environment", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("period", period)
        .eq("metric", metric)
        .eq("environment", environment),
    )
    .take(USAGE_LANES);
/**
 * The total of one environment, summed over its lanes; `undefined` reads the total not yet
 * attributed (#429). `null` when nothing was ever counted there.
 */
export async function totalFor(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: StoredEnvironment,
  period: string,
  metric: UsageMetric,
) {
  const rows = await environmentLanes(ctx, organizationId, environment, period, metric);
  if (!rows.length) return null;
  const sum = sumTotals(rows);
  return { ...sum, updatedAt: sum.updatedAt!, startedAt: sum.startedAt! };
}
/** Every total of the metric in the period: the lanes of sandbox and production, and one not yet attributed. */
export const periodTotals = (
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  period: string,
  metric: UsageMetric,
) =>
  ctx.db
    .query("usageTotals")
    .withIndex("by_organizationId_and_period_and_metric_and_environment", (q) =>
      q.eq("organizationId", organizationId).eq("period", period).eq("metric", metric),
    )
    .take(2 * USAGE_LANES + 1);
/**
 * Whether the quota of `environment` counts a total: its own and one not yet attributed, which
 * may belong to either environment and so counts against both until the backfill moves it.
 */
export const countedIn = (environment: UsageEnvironment) => (row: Doc<"usageTotals">) =>
  !row.environment || row.environment === environment;
export function sumTotals(rows: Doc<"usageTotals">[]) {
  return {
    committed: rows.reduce((sum, row) => sum + row.committed, 0),
    reserved: rows.reduce((sum, row) => sum + row.reserved, 0),
    updatedAt: rows.length ? Math.max(...rows.map((row) => row.updatedAt)) : null,
    startedAt: rows.length ? Math.min(...rows.map((row) => row.startedAt)) : null,
  };
}

/**
 * Refuses a new import or capture query once the month's new notes reached the limit. Only a new
 * admission: a note of work already admitted is always recorded (measured only), even past it.
 * An NFS-e batch asks for its `quantity` of new notes at once, without the `held` units of the
 * provisional note it replaces (#649).
 */
export async function requireNotes(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  period: string,
  limit: number,
  quantity = 1,
  held = 0,
) {
  const total = sumTotals(
    (await periodTotals(ctx, organizationId, period, "documents")).filter(countedIn("production")),
  );
  if (total.committed + total.reserved - held + quantity > limit)
    throw new ConvexError({
      code: "QUOTA_EXCEEDED",
      metric: "documents",
      environment: "production",
      period,
      limit,
    });
}
/**
 * Whether a capture stream that shows `code` stopped on the notes quota: QUOTA_EXCEEDED under a
 * plan with `notes` in its environment, with the notes of the pause's month already at the limit.
 * The stream keeps only the code; the pause's instant is its paused operation's last update.
 */
export async function notesQuotaStop(
  ctx: QueryCtx,
  stream: Doc<"captureStreams">,
  code: string | null | undefined,
) {
  if (code !== "QUOTA_EXCEEDED") return false;
  const limit = noteLimit(
    await planFor(ctx, stream.organizationId),
    "captures",
    stream.environment,
  );
  if (limit === null) return false;
  const op = stream.operationId ? await ctx.db.get("operations", stream.operationId) : null;
  const at = op?.updatedAt ?? stream.lastAttemptAt ?? stream.createdAt;
  const total = sumTotals(
    (await periodTotals(ctx, stream.organizationId, usagePeriod(at), "documents")).filter(
      countedIn("production"),
    ),
  );
  return total.committed + total.reserved >= limit;
}

export async function requireActivePlan(ctx: QueryCtx, organizationId: Id<"organizations">) {
  if (await capacityPolicy(ctx)) return capacityPlan(ctx, organizationId);
  const plan = await planFor(ctx, organizationId);
  // Other domains meter without a plan; production capture also calls requireCapturePlan.
  if (plan && (plan.startsAt > Date.now() || planEnded(plan, Date.now()))) deny("PLAN_INACTIVE");
  return plan;
}
/**
 * Production capture, on every deployment and the #50 proof included, needs a plan assigned to the organization with finite
 * `captures` (or `notes`, which gates Production in its place) and `bytes` quotas, the free tier
 * included (#429): without one, a new query is
 * refused with PLAN_REQUIRED, and only `usage.assignPlan` lifts it. The plan's term stays
 * PLAN_INACTIVE (`requireActivePlan`). Sandbox, imports and the other metrics keep metering an
 * organization without a plan. Work already admitted (a query charged under its usage key, a
 * received batch, documents already stored) is not refused here.
 */
export const capturePlanRequired = (environment: UsageEnvironment) => environment === "production";
export const capturePlanMissing = (plan: Doc<"usagePlans"> | null) =>
  !plan ||
  (plan.limits.notes === undefined && plan.limits.captures === null) ||
  plan.limits.bytes === null;
export async function requireCapturePlan(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: UsageEnvironment,
) {
  if (!capturePlanRequired(environment)) return;
  if (capturePlanMissing(await planFor(ctx, organizationId))) deny("PLAN_REQUIRED");
}
export async function checkUsage(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: UsageEnvironment,
  metric: UsageMetric,
  key: string,
  quantity = 1,
) {
  if (await eventFor(ctx, organizationId, metric, key)) return;
  await requireQuota(ctx, organizationId, environment, metric, quantity);
}
/**
 * Whether the plan admits `quantity` more of `metric` in `environment` now; throws PLAN_INACTIVE
 * or QUOTA_EXCEEDED. The limit is the plan's, counted in the environment's own balance; in
 * Production, a plan with `notes` gates imports and captures by the month's new notes.
 */
export async function requireQuota(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  environment: UsageEnvironment,
  metric: UsageMetric,
  quantity = 1,
) {
  const plan = await requireActivePlan(ctx, organizationId);
  const period = usagePeriod(Date.now());
  const notes = noteLimit(plan, metric, environment);
  if (notes !== null) await requireNotes(ctx, organizationId, period, notes);
  const limit = planLimit(plan, metric, environment);
  if (limit !== null) {
    const total = sumTotals(
      (await periodTotals(ctx, organizationId, period, metric)).filter(countedIn(environment)),
    );
    if (total.committed + total.reserved + quantity > limit)
      throw new ConvexError({ code: "QUOTA_EXCEEDED", metric, environment, period });
  }
}
export function usageError(error: unknown) {
  const data = error instanceof ConvexError ? error.data : null;
  return data &&
    typeof data === "object" &&
    "code" in data &&
    typeof data.code === "string" &&
    ["PLAN_INACTIVE", "PLAN_REQUIRED", "QUOTA_EXCEEDED", "CAPACITY_INVENTORY_REQUIRED"].includes(
      data.code,
    )
    ? data.code
    : null;
}
type LaneFields = { committed: number; reserved: number; allowance?: number; grant?: string };
/** Writes one lane's new balance, creating the row; never a negative or fractional unit. */
async function writeLane(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  environment: StoredEnvironment,
  period: string,
  metric: UsageMetric,
  lane: number | undefined,
  row: Doc<"usageTotals"> | null,
  fields: LaneFields,
) {
  if (
    ![fields.committed, fields.reserved, fields.allowance ?? 0].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new Error("Invalid usage balance");
  if (!usageLanesEnabled()) {
    // Lanes off (rollback): write no lane field at all, and strip the allowance a row still has,
    // so code from before the lanes can be published under traffic once `foldLanes` ends.
    // Dropping an allowance only lowers what is set aside, so the limit stays exact.
    const plain = { committed: fields.committed, reserved: fields.reserved, updatedAt: Date.now() };
    if (row) {
      const { _id, _creationTime, allowance, grant, ...kept } = row;
      if (allowance !== undefined || grant !== undefined)
        await ctx.db.replace("usageTotals", _id, { ...kept, ...plain });
      else await ctx.db.patch("usageTotals", _id, plain);
    } else
      await ctx.db.insert("usageTotals", {
        organizationId,
        ...(environment ? { environment } : {}),
        period,
        metric,
        ...(laneField(lane) ? { lane: laneField(lane) } : {}),
        ...plain,
        startedAt: Date.now(),
      });
    return;
  }
  const value = { ...fields, updatedAt: Date.now() };
  if (row) await ctx.db.patch("usageTotals", row._id, value);
  else
    await ctx.db.insert("usageTotals", {
      organizationId,
      ...(environment ? { environment } : {}),
      period,
      metric,
      ...(laneField(lane) ? { lane: laneField(lane) } : {}),
      ...value,
      startedAt: Date.now(),
    });
}
async function changeTotal(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  environment: StoredEnvironment,
  period: string,
  metric: UsageMetric,
  lane: number | undefined,
  committed: number,
  reserved: number,
) {
  // Nothing to settle: writing would only create an empty row, which after `foldLanes` would carry
  // a lane field again and block publishing the code from before the lanes.
  if (committed === 0 && reserved === 0) return;
  let row = await laneTotal(ctx, organizationId, environment, period, metric, lane);
  // With the lanes off, units added to a lane whose row was folded go to lane 0, never to a new
  // lane row.
  if (!row && lane && !usageLanesEnabled()) {
    lane = undefined;
    row = await laneTotal(ctx, organizationId, environment, period, metric, lane);
  }
  const write = (at: number | undefined, r: Doc<"usageTotals"> | null, c: number, res: number) =>
    writeLane(ctx, organizationId, environment, period, metric, at, r, {
      committed: (r?.committed ?? 0) + c,
      reserved: (r?.reserved ?? 0) + res,
    });
  if (
    (committed >= 0 && reserved >= 0) ||
    (row && row.committed + committed >= 0 && row.reserved + reserved >= 0)
  )
    return write(lane, row, committed, reserved);
  // Settlement takes units out of the event's lane. That lane may no longer hold them all:
  // `foldLanes` moved them to lane 0, and lanes turned back on before `foldLaneEvents` ended may
  // have created a new row there with other events' units, so an event's units can end up split
  // across lanes. Only the sum of the lanes is the balance, so the units come out of the event's
  // lane, then lane 0, then the others, as many as each holds (at most `USAGE_LANES` rows, read
  // only in this case). The summed total, and so the quota, is the same whichever lanes pay; if
  // the lanes together do not hold the units, nothing is written and the balance error stands.
  const lanes = await environmentLanes(ctx, organizationId, environment, period, metric);
  const own = lane ?? 0;
  const order = [...lanes].sort(
    (a, b) =>
      Number((b.lane ?? 0) === own) - Number((a.lane ?? 0) === own) ||
      Number(!b.lane) - Number(!a.lane) ||
      (a.lane ?? 0) - (b.lane ?? 0),
  );
  let dueCommitted = Math.max(0, -committed),
    dueReserved = Math.max(0, -reserved);
  const held = (key: "committed" | "reserved") => order.reduce((sum, r) => sum + r[key], 0);
  if (held("committed") < dueCommitted || held("reserved") < dueReserved)
    return write(lane, row, committed, reserved);
  // Units added (a commit's `committed`) go to the first lane in the order.
  let added = { committed: Math.max(0, committed), reserved: Math.max(0, reserved) };
  for (const r of order) {
    const takeCommitted = Math.min(r.committed, dueCommitted);
    const takeReserved = Math.min(r.reserved, dueReserved);
    if (!takeCommitted && !takeReserved && !added.committed && !added.reserved) continue;
    dueCommitted -= takeCommitted;
    dueReserved -= takeReserved;
    await write(r.lane, r, added.committed - takeCommitted, added.reserved - takeReserved);
    added = { committed: 0, reserved: 0 };
  }
}
/**
 * Adds `quantity` reserved units to a lane of the environment's balance, in the caller's
 * transaction, and returns the lane. Exactness (#559): every lane may hold an `allowance`, units
 * of the plan limit already set aside for it under one `grant` (plan, version and limit). For the
 * environment, the counted units (committed and reserved of its lanes and of the total not yet
 * attributed) plus the allowances valid under the current grant never exceed the limit. A
 * reservation that fits its lane's allowance moves units from the allowance to `reserved` and
 * reads and writes only that lane; the invariant holds without reading the others. Otherwise it
 * reads every lane, refuses only when the counted units plus `quantity` exceed the limit, and
 * then sets aside up to a lane's share of what is left. A new plan, version or limit voids every
 * earlier allowance, so a limit that drops is never exceeded by units set aside before it.
 * Measured-only units are never refused: they spend allowances first, so they do not leave
 * allowances behind that would admit units beyond the limit.
 */
async function reserveLane(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  environment: UsageEnvironment,
  period: string,
  metric: UsageMetric,
  quantity: number,
  measuredOnly: boolean,
  preferredLane: number | undefined,
) {
  // Measured-only units never answer PLAN_INACTIVE; out of its term, a plan gates nothing.
  const current = measuredOnly ? await planFor(ctx, organizationId) : null;
  const plan = measuredOnly
    ? current && current.startsAt <= Date.now() && !planEnded(current, Date.now())
      ? current
      : null
    : await requireActivePlan(ctx, organizationId);
  const notes = measuredOnly ? null : noteLimit(plan, metric, environment);
  if (notes !== null) await requireNotes(ctx, organizationId, period, notes);
  const limit = planLimit(plan, metric, environment);
  const spread = usageLanesEnabled();
  const lane = spread ? (preferredLane ?? pickLane()) % USAGE_LANES : 0;
  const own = await laneTotal(ctx, organizationId, environment, period, metric, lane);
  const reserved = (own?.reserved ?? 0) + quantity;
  const committed = own?.committed ?? 0;
  const write = (row: Doc<"usageTotals"> | null, at: number, fields: LaneFields) =>
    writeLane(ctx, organizationId, environment, period, metric, at, row, fields);
  if (limit === null) {
    // Nothing to gate. Allowances of another grant stay void.
    await write(own, lane, { committed, reserved });
    return lane;
  }
  const grant = `${plan!._id}:${plan!.version}:${limit}`;
  const spare = (row: Doc<"usageTotals"> | null) =>
    row && row.grant === grant ? (row.allowance ?? 0) : 0;
  if (spare(own) >= quantity) {
    await write(own, lane, { committed, reserved, allowance: spare(own) - quantity, grant });
    return lane;
  }
  const [lanes, unattributed] = await Promise.all([
    environmentLanes(ctx, organizationId, environment, period, metric),
    environmentLanes(ctx, organizationId, undefined, period, metric),
  ]);
  const counted = [...lanes, ...unattributed].reduce(
    (sum, row) => sum + row.committed + row.reserved,
    0,
  );
  const byLane = new Map(lanes.map((row) => [row.lane ?? 0, row]));
  const allowances = Array.from({ length: USAGE_LANES }, (_, i) =>
    i === lane ? 0 : spare(byLane.get(i) ?? null),
  );
  // What is neither counted nor set aside; below zero only after measured-only units.
  let free = limit - counted - spare(own) - allowances.reduce((sum, n) => sum + n, 0);
  if (!measuredOnly && counted + quantity > limit)
    throw new ConvexError({ code: "QUOTA_EXCEEDED", metric, environment, period });
  // Pay the quantity from this lane's allowance, then from what is free, then from the others'.
  let due = quantity - spare(own);
  const fromFree = Math.min(Math.max(free, 0), due);
  free -= fromFree;
  due -= fromFree;
  for (let i = 0; i < USAGE_LANES && due > 0; i++) {
    const taken = Math.min(allowances[i]!, due);
    allowances[i]! -= taken;
    due -= taken;
  }
  // Then set aside up to a share of what is left in every lane, this one first, so the next
  // reservations of the organization spend their own lane and read nothing else.
  const share = spread ? Math.floor(limit / USAGE_LANES) : 0;
  const order = [lane, ...allowances.keys()].filter((i, n) => n === 0 || i !== lane);
  for (const i of order) {
    const added = Math.min(Math.max(free, 0), Math.max(share - allowances[i]!, 0));
    allowances[i]! += added;
    free -= added;
  }
  for (let i = 0; i < USAGE_LANES; i++) {
    const row = i === lane ? own : (byLane.get(i) ?? null);
    if (i === lane) {
      await write(own, lane, { committed, reserved, allowance: allowances[i]!, grant });
      continue;
    }
    if (allowances[i] === spare(row)) continue;
    await write(row, i, {
      committed: row?.committed ?? 0,
      reserved: row?.reserved ?? 0,
      allowance: allowances[i]!,
      grant,
    });
  }
  return lane;
}
/**
 * Moves an event's committed and reserved units from one total to another of the same period
 * and metric, in the caller's transaction. Only the environment backfill uses it (#429).
 */
export async function moveTotal(
  ctx: MutationCtx,
  event: Doc<"usageEvents">,
  from: StoredEnvironment,
  to: UsageEnvironment,
) {
  const committed = event.state === "committed" ? event.quantity : 0;
  const reserved = event.state === "reserved" ? event.quantity : 0;
  if (!committed && !reserved) return;
  const { organizationId, period, metric, lane } = event;
  const source = await laneTotal(ctx, organizationId, from, period, metric, lane);
  await changeTotal(ctx, organizationId, from, period, metric, lane, -committed, -reserved);
  await changeTotal(ctx, organizationId, to, period, metric, lane, committed, reserved);
  // The moved units were counted since the source started: keep the earliest start.
  const target = (await laneTotal(ctx, organizationId, to, period, metric, lane))!;
  if (source && source.startedAt < target.startedAt)
    await ctx.db.patch("usageTotals", target._id, { startedAt: source.startedAt });
}
/**
 * Reservation and domain admission must commit in the same mutation. No counter shared across
 * organizations; within one, the reservation writes one lane of the balance (`reserveLane`).
 */
export async function reserveUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  environment: UsageEnvironment,
  metric: UsageMetric,
  key: string,
  quantity = 1,
  measuredOnly = false,
  /** The lane to use, shared with the other budgets of the same admission (`pickLane`). */
  lane?: number,
) {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1e12 || key.length > 300)
    deny("INVALID_REQUEST");
  const existing = await eventFor(ctx, organizationId, metric, key);
  if (existing) {
    // A key names a record of one environment; another environment is a caller's error.
    if (existing.state === "released" || (existing.environment ?? environment) !== environment)
      deny("OPERATION_CONFLICT");
    return existing;
  }
  const period = usagePeriod(Date.now());
  const used = await reserveLane(
    ctx,
    organizationId,
    environment,
    period,
    metric,
    quantity,
    measuredOnly,
    lane,
  );
  const id = await ctx.db.insert("usageEvents", {
    organizationId,
    environment,
    metric,
    key,
    period,
    quantity,
    ...(laneField(used) ? { lane: used } : {}),
    state: "reserved",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return (await ctx.db.get("usageEvents", id))!;
}
/** Commit, release and refund follow the event's own environment, never the caller's. */
export async function commitUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  metric: UsageMetric,
  key: string,
  actual?: number,
) {
  const event = await eventFor(ctx, organizationId, metric, key);
  if (!event || event.state !== "reserved") return;
  const quantity = actual ?? event.quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > event.quantity)
    deny("INVALID_REQUEST");
  await changeTotal(
    ctx,
    organizationId,
    event.environment,
    event.period,
    metric,
    event.lane,
    quantity,
    -event.quantity,
  );
  await ctx.db.patch("usageEvents", event._id, {
    quantity,
    state: "committed",
    updatedAt: Date.now(),
  });
}
export async function releaseUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  metric: UsageMetric,
  key: string,
) {
  const event = await eventFor(ctx, organizationId, metric, key);
  if (!event || event.state !== "reserved") return;
  await changeTotal(
    ctx,
    organizationId,
    event.environment,
    event.period,
    metric,
    event.lane,
    0,
    -event.quantity,
  );
  await ctx.db.patch("usageEvents", event._id, { state: "released", updatedAt: Date.now() });
}
/**
 * Undoes a usage that provably did not happen, reserved or already committed: the totals drop it
 * and the event stays as `released`. Only for a key nothing else will reserve again, since a
 * released key refuses a new reservation.
 */
export async function refundUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  metric: UsageMetric,
  key: string,
) {
  const event = await eventFor(ctx, organizationId, metric, key);
  if (!event || event.state === "released") return;
  const committed = event.state === "committed" ? event.quantity : 0;
  await changeTotal(
    ctx,
    organizationId,
    event.environment,
    event.period,
    metric,
    event.lane,
    -committed,
    -(event.quantity - committed),
  );
  await ctx.db.patch("usageEvents", event._id, { state: "released", updatedAt: Date.now() });
}
export async function recordUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  environment: UsageEnvironment,
  metric: UsageMetric,
  key: string,
  quantity = 1,
  measuredOnly = false,
) {
  await reserveUsage(ctx, organizationId, environment, metric, key, quantity, measuredOnly);
  await commitUsage(ctx, organizationId, metric, key);
}
export async function rateUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  sourceKeyId?: Id<"apiKeys">,
  fixedBudget?: { name: string; rate: number },
  lane = pickLane(),
) {
  const budgets = [
    ["usage-organization", organizationId, 120],
    ...(sourceKeyId ? [["usage-key", sourceKeyId, 60] as const] : []),
  ] as const;
  const result = await ctx.runMutation(components.rateLimiter.lib.rateLimitMany, {
    partitionShards: 8,
    // Every budget tries this lane first; a short lane still falls back to the others.
    partitionLane: lane,
    limits: [
      ...budgets.map(([name, key, rate]) => ({
        name,
        key,
        config: { kind: "token bucket" as const, rate, capacity: rate, period: 60_000 },
      })),
      ...(fixedBudget
        ? [
            {
              name: fixedBudget.name,
              key: organizationId,
              config: {
                kind: "fixed window" as const,
                rate: fixedBudget.rate,
                capacity: fixedBudget.rate,
                period: 60_000,
                start: 0,
              },
            },
          ]
        : []),
    ],
  });
  if (!result.ok) deny("RATE_LIMITED");
}
export async function acquireUsageLease(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  key: string,
  expiresAt: number,
) {
  const own = await ctx.db
    .query("usageLeases")
    .withIndex("by_organizationId_and_key", (q) =>
      q.eq("organizationId", organizationId).eq("key", key),
    )
    .unique();
  const limit = (await planFor(ctx, organizationId))?.concurrency ?? 8;
  const active = await ctx.db
    .query("usageLeases")
    .withIndex("by_organizationId_and_expiresAt", (q) =>
      q.eq("organizationId", organizationId).gt("expiresAt", Date.now()),
    )
    .take(33);
  if (active.filter((row) => row.key !== key).length >= limit) return false;
  if (own) await ctx.db.patch("usageLeases", own._id, { expiresAt });
  else await ctx.db.insert("usageLeases", { organizationId, key, expiresAt });
  return true;
}
export async function releaseUsageLease(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  key: string,
) {
  const own = await ctx.db
    .query("usageLeases")
    .withIndex("by_organizationId_and_key", (q) =>
      q.eq("organizationId", organizationId).eq("key", key),
    )
    .unique();
  if (own) await ctx.db.delete("usageLeases", own._id);
}
