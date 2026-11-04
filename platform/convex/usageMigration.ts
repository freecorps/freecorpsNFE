import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { laneTotal, moveTotal, usageLanesEnabled, type UsageEnvironment } from "./lib/usageCore";
import { usageMetric } from "./lib/usageValues";

/**
 * Environment of a usage recorded before #429 without one, read from the record its key names.
 * Every key carries the id of an import file, operation, document, webhook delivery or NFS-e,
 * alone or between `:` (`capture:<operation>:<fence>`, `webhook:<delivery>:<generation>`), and
 * each of these records has its environment and stays until the organization's closure.
 */
async function sourceEnvironment(ctx: MutationCtx, key: string): Promise<UsageEnvironment | null> {
  for (const part of key.split(":")) {
    const fileId = ctx.db.normalizeId("importFiles", part);
    if (fileId) {
      const file = await ctx.db.get("importFiles", fileId);
      const batch = file ? await ctx.db.get("imports", file.importId) : null;
      if (batch) return batch.environment;
    }
    const operationId = ctx.db.normalizeId("operations", part);
    if (operationId) {
      const op = await ctx.db.get("operations", operationId);
      if (op) return op.environment;
    }
    const documentId = ctx.db.normalizeId("fiscalDocuments", part);
    if (documentId) {
      const doc = await ctx.db.get("fiscalDocuments", documentId);
      if (doc) return doc.environment;
    }
    const deliveryId = ctx.db.normalizeId("webhookDeliveries", part);
    if (deliveryId) {
      const delivery = await ctx.db.get("webhookDeliveries", deliveryId);
      const endpoint = delivery ? await ctx.db.get("webhookEndpoints", delivery.endpointId) : null;
      if (endpoint) return endpoint.environment;
    }
    const issuanceId = ctx.db.normalizeId("issuances", part);
    if (issuanceId) {
      const issuance = await ctx.db.get("issuances", issuanceId);
      if (issuance) return issuance.environment;
    }
  }
  return null;
}

/**
 * Where a usage whose record no longer resolves goes: production, whose quota guards the only
 * effect outside the platform (the site capture, ADR 0007). Counting it there can only pause
 * production earlier, never give it a unit the shared balance had already spent.
 */
const UNRESOLVED: UsageEnvironment = "production";

const progress = v.object({
  scanned: v.number(),
  attributed: v.number(),
  unresolved: v.number(),
  isDone: v.boolean(),
});

/**
 * Attributes each usage event recorded before #429 to its environment and moves its units from
 * the unattributed total to the environment's, in the same transaction, so the totals always
 * equal their events. Run once after the rollout on each deployment, with `{"cursor":null}`; it
 * goes through the events 100 at a time, then the totals (`backfillTotals`). Safe to repeat and
 * to run beside new traffic: an attributed event is skipped, and new events already carry their
 * environment. Deletes nothing but the emptied unattributed totals.
 */
export const backfillEnvironment = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: progress,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("usageEvents").paginate({ cursor: args.cursor, numItems: 100 });
    let attributed = 0,
      unresolved = 0;
    for (const event of page.page) {
      if (event.environment) continue;
      const found = await sourceEnvironment(ctx, event.key);
      if (!found) unresolved++;
      await attributeEvent(ctx, event, found ?? UNRESOLVED);
      attributed++;
    }
    if (page.isDone)
      await ctx.scheduler.runAfter(0, internal.usageMigration.backfillTotals, { cursor: null });
    else
      await ctx.scheduler.runAfter(1000, internal.usageMigration.backfillEnvironment, {
        cursor: page.continueCursor,
      });
    const result = { scanned: page.page.length, attributed, unresolved, isDone: page.isDone };
    console.info(
      JSON.stringify({ type: "usage_environment_backfill", stage: "events", ...result }),
    );
    return result;
  },
});

async function attributeEvent(
  ctx: MutationCtx,
  event: Doc<"usageEvents">,
  environment: UsageEnvironment,
) {
  await moveTotal(ctx, event, undefined, environment);
  await ctx.db.patch("usageEvents", event._id, { environment });
}

/**
 * Second stage, after every event has its environment: an unattributed total is then empty, since
 * its units and start moved with its events, and is deleted. One that still has units would mean
 * a total without its events; it stays as it is, counted in `unresolved` and still charged to
 * both environments (`countedIn`), for a person to investigate before the field is required.
 * Only `backfillEnvironment` schedules this stage, once it has gone through every event.
 */
export const backfillTotals = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: progress,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("usageTotals").paginate({ cursor: args.cursor, numItems: 100 });
    let attributed = 0,
      unresolved = 0;
    for (const row of page.page) {
      if (row.environment) continue;
      if (row.committed || row.reserved) unresolved++;
      else {
        await ctx.db.delete("usageTotals", row._id);
        attributed++;
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(1000, internal.usageMigration.backfillTotals, {
        cursor: page.continueCursor,
      });
    const result = { scanned: page.page.length, attributed, unresolved, isDone: page.isDone };
    console.info(
      JSON.stringify({ type: "usage_environment_backfill", stage: "totals", ...result }),
    );
    return result;
  },
});

/**
 * Read-only status of the #429 migration, one page at a time, for the before and after receipts
 * (`scripts/billing/usage-migration-status.mjs`). A page returns only sums grouped by metric, environment
 * (`unattributed` for a row written before #429) and state: no id, organization, key or period
 * leaves the deployment. The pages are separate transactions, not a snapshot: traffic between
 * them can move a unit from a page already read to one still ahead, so a receipt read beside
 * traffic shows the deployment as it was over the window, not at an instant.
 */
const statusEnvironment = v.union(
  v.literal("sandbox"),
  v.literal("production"),
  v.literal("unattributed"),
);
const eventGroup = v.object({
  metric: usageMetric,
  environment: statusEnvironment,
  state: v.union(v.literal("reserved"), v.literal("committed"), v.literal("released")),
  events: v.number(),
  units: v.number(),
});
const totalGroup = v.object({
  metric: usageMetric,
  environment: statusEnvironment,
  rows: v.number(),
  committed: v.number(),
  reserved: v.number(),
});
const pageFields = { scanned: v.number(), continueCursor: v.string(), isDone: v.boolean() };

function group<Row, Group>(
  rows: Row[],
  key: (row: Row) => string,
  start: (row: Row) => Group,
  add: (group: Group, row: Row) => void,
) {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const k = key(row);
    if (!groups.has(k)) groups.set(k, start(row));
    add(groups.get(k)!, row);
  }
  return [...groups.values()];
}

export const eventStatus = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({ ...pageFields, groups: v.array(eventGroup) }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("usageEvents").paginate(args.paginationOpts);
    const groups = group(
      page.page,
      (e) => `${e.metric}:${e.environment ?? "unattributed"}:${e.state}`,
      (e) => ({
        metric: e.metric,
        environment: e.environment ?? ("unattributed" as const),
        state: e.state,
        events: 0,
        units: 0,
      }),
      (g, e) => {
        g.events++;
        g.units += e.quantity;
      },
    );
    return {
      scanned: page.page.length,
      groups,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const totalStatus = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({ ...pageFields, groups: v.array(totalGroup) }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("usageTotals").paginate(args.paginationOpts);
    const groups = group(
      page.page,
      (t) => `${t.metric}:${t.environment ?? "unattributed"}`,
      (t) => ({
        metric: t.metric,
        environment: t.environment ?? ("unattributed" as const),
        rows: 0,
        committed: 0,
        reserved: 0,
      }),
      (g, t) => {
        g.rows++;
        g.committed += t.committed;
        g.reserved += t.reserved;
      },
    );
    return {
      scanned: page.page.length,
      groups,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

const folded = v.object({ scanned: v.number(), changed: v.number(), isDone: v.boolean() });
/**
 * Rollback of the usage lanes (#559), after `FNFE_USAGE_LANES=off` is set in the deployment:
 * merges every lane into lane 0 of its total, keeping the summed balance and the earliest start,
 * and drops the allowances. Then `foldLaneEvents` removes `lane` from the events. Afterwards no
 * document carries the lane fields, so code from before the lanes can be published. Refuses with
 * the lanes on, since new reservations would spread again. Safe to repeat and beside traffic: a
 * commit or release whose lane was merged lands on lane 0 (`changeTotal`).
 */
export const foldLanes = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: folded,
  handler: async (ctx, args) => {
    if (usageLanesEnabled()) throw new Error("Set FNFE_USAGE_LANES=off before folding the lanes");
    const page = await ctx.db.query("usageTotals").paginate({ cursor: args.cursor, numItems: 50 });
    let changed = 0;
    for (const listed of page.page) {
      // Re-read: an earlier lane of this page may have merged into this row.
      const row = await ctx.db.get("usageTotals", listed._id);
      if (!row || (row.lane === undefined && row.allowance === undefined && !row.grant)) continue;
      const { _id, _creationTime, lane, allowance: _allowance, grant: _grant, ...fields } = row;
      changed++;
      if (!lane) {
        await ctx.db.replace("usageTotals", _id, fields);
        continue;
      }
      const base = await laneTotal(
        ctx,
        row.organizationId,
        row.environment,
        row.period,
        row.metric,
        undefined,
      );
      if (base) {
        const { _id: baseId, _creationTime: _baseTime, allowance: _a, grant: _g, ...rest } = base;
        await ctx.db.replace("usageTotals", baseId, {
          ...rest,
          committed: base.committed + row.committed,
          reserved: base.reserved + row.reserved,
          startedAt: Math.min(base.startedAt, row.startedAt),
          updatedAt: Math.max(base.updatedAt, row.updatedAt),
        });
      } else await ctx.db.insert("usageTotals", fields);
      await ctx.db.delete("usageTotals", _id);
    }
    if (page.isDone)
      await ctx.scheduler.runAfter(0, internal.usageMigration.foldLaneEvents, { cursor: null });
    else
      await ctx.scheduler.runAfter(1000, internal.usageMigration.foldLanes, {
        cursor: page.continueCursor,
      });
    const result = { scanned: page.page.length, changed, isDone: page.isDone };
    console.info(JSON.stringify({ type: "usage_lanes_fold", stage: "totals", ...result }));
    return result;
  },
});
/** Second stage of `foldLanes`: removes `lane` from the events, 200 at a time. */
export const foldLaneEvents = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: folded,
  handler: async (ctx, args) => {
    if (usageLanesEnabled()) throw new Error("Set FNFE_USAGE_LANES=off before folding the lanes");
    const page = await ctx.db.query("usageEvents").paginate({ cursor: args.cursor, numItems: 200 });
    let changed = 0;
    for (const event of page.page) {
      if (event.lane === undefined) continue;
      const { _id, _creationTime, lane: _lane, ...fields } = event;
      await ctx.db.replace("usageEvents", _id, fields);
      changed++;
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(1000, internal.usageMigration.foldLaneEvents, {
        cursor: page.continueCursor,
      });
    const result = { scanned: page.page.length, changed, isDone: page.isDone };
    console.info(JSON.stringify({ type: "usage_lanes_fold", stage: "events", ...result }));
    return result;
  },
});
