import { ConvexError, getDocumentSize, type Value } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";
import { deny, type CustodyOption } from "./organizationAccess";
import { planEnded } from "./usageValues";
import { quotaPeriod } from "./quotaPeriod";
import { capacityMetric } from "./capacitySchema";
import { archiveStatus, assertOrganizationHot } from "./coldArchiveCore";

type Metric = typeof capacityMetric.type;
type Capacity = {
  filesBytes: number;
  databaseBytes: number;
  companies: number;
  members: number;
  projects: number;
  downloadsBytes: number;
  exportsCount: number;
  exportsBytes: number;
  restReads: number;
};
const stock = (metric: Metric) =>
  metric === "filesBytes" || metric === "databaseBytes" || metric === "temporaryBytes";
const planMetric = (metric: Metric) => (metric === "temporaryBytes" ? "exportsBytes" : metric);
async function assertCapacityWritable(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  restoringInventory = false,
  options: CustodyOption = {},
) {
  if (options.archived === "allowed") return;
  if (restoringInventory && (await archiveStatus(ctx, organizationId))?.state === "restoring")
    return;
  await assertOrganizationHot(ctx, organizationId);
}
export const capacityPolicy = async (ctx: QueryCtx) =>
  (
    await ctx.db
      .query("platformPlanSettings")
      .withIndex("by_key", (q) => q.eq("key", "platform"))
      .unique()
  )?.enabled === true;
export const capacityAccount = (ctx: QueryCtx, organizationId: Id<"organizations">) =>
  ctx.db
    .query("capacityAccounts")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
/**
 * The key a capacity metric counts under at `now`: the fixed `stock` for the stock metrics, the
 * only key that is not a period, or the quota period of the organization's plan row (ADR 0012,
 * section 2), read in the caller's transaction.
 */
export async function capacityPeriod(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  now: number,
) {
  if (stock(metric)) return "stock";
  const plan = await ctx.db
    .query("usagePlans")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  return quotaPeriod(plan, now).key;
}
export const capacityTotal = async (
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  now: number,
) => {
  const period = await capacityPeriod(ctx, organizationId, metric, now);
  return ctx.db
    .query("capacityTotals")
    .withIndex("by_organizationId_and_period_and_metric", (q) =>
      q.eq("organizationId", organizationId).eq("period", period).eq("metric", metric),
    )
    .unique();
};
export const capacityEvent = (
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  key: string,
) =>
  ctx.db
    .query("capacityEvents")
    .withIndex("by_organizationId_and_metric_and_key", (q) =>
      q.eq("organizationId", organizationId).eq("metric", metric).eq("key", key),
    )
    .unique();

export async function capacityPlan(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  admitted = false,
  options: CustodyOption = {},
) {
  if (options.archived !== "allowed") await assertOrganizationHot(ctx, organizationId);
  if (!(await capacityPolicy(ctx))) return null;
  const plan = await ctx.db
    .query("usagePlans")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (
    !plan?.catalogTier ||
    !plan.capacity ||
    Object.values(plan.capacity).some((n) => !Number.isSafeInteger(n) || n < 0) ||
    Object.values(plan.limits).some((n) => n === null || !Number.isSafeInteger(n) || n < 0)
  )
    deny("PLAN_REQUIRED");
  if (!admitted && (plan.startsAt > Date.now() || planEnded(plan, Date.now())))
    deny("PLAN_INACTIVE");
  return plan;
}

/** Proves a new organization has no fiscal sources. Legacy organizations must inventory first. */
export async function ensureCapacityReady(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const account = await capacityAccount(ctx, organizationId);
  if (account) return account.ready;
  const sources = await Promise.all([
    ctx.db
      .query("imports")
      .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
        q.eq("organizationId", organizationId),
      )
      .first(),
    ctx.db
      .query("captureStreams")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .first(),
    ctx.db
      .query("issuances")
      .withIndex("by_organizationId_and_companyId_and_environment_and_createdAt", (q) =>
        q.eq("organizationId", organizationId),
      )
      .first(),
    ctx.db
      .query("documentExports")
      .withIndex("by_organizationId_and_state", (q) => q.eq("organizationId", organizationId))
      .first(),
    ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
        q.eq("organizationId", organizationId),
      )
      .first(),
  ]);
  const companies = await ctx.db
    .query("companies")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .take(51);
  const artifacts =
    companies.length <= 50
      ? await Promise.all(
          companies.map((company) =>
            ctx.db
              .query("documentArtifacts")
              .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
                q.eq("companyId", company._id),
              )
              .first(),
          ),
        )
      : [];
  const ready =
    sources.every((row) => row === null) &&
    companies.length <= 50 &&
    artifacts.every((row) => row === null);
  await ctx.db.insert("capacityAccounts", {
    organizationId,
    ready,
    phase: 0,
    cursor: null,
    updatedAt: Date.now(),
  });
  return ready;
}

async function changeTotal(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  period: string,
  committed: number,
  reserved: number,
) {
  const total = await ctx.db
    .query("capacityTotals")
    .withIndex("by_organizationId_and_period_and_metric", (q) =>
      q.eq("organizationId", organizationId).eq("period", period).eq("metric", metric),
    )
    .unique();
  const values = {
    committed: (total?.committed ?? 0) + committed,
    reserved: (total?.reserved ?? 0) + reserved,
    updatedAt: Date.now(),
  };
  if (![values.committed, values.reserved].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("Invalid capacity balance");
  // The revision only tells a running recount (`capacity.reconcile`, account not ready) that stock
  // moved under it. A ready account has no recount to restart, so stock writes do not rewrite the
  // organization's account (#559). The account read stays in this transaction: one turned
  // not ready concurrently conflicts with it, and the retry counts the write.
  if (stock(metric)) {
    const account = await capacityAccount(ctx, organizationId);
    if (account && !account.ready)
      await ctx.db.patch("capacityAccounts", account._id, {
        revision: (account.revision ?? 0) + 1,
      });
  }
  if (total) await ctx.db.patch("capacityTotals", total._id, values);
  else await ctx.db.insert("capacityTotals", { organizationId, metric, period, ...values });
}

export async function checkCapacity(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  quantity: number,
  admitted = false,
  options: CustodyOption = {},
) {
  // Expiry stops new fiscal work, not bounded access to documents already held.
  // Keep quotas and archive/closure authorization in their respective guards.
  const accessToExisting = [
    "downloadsBytes",
    "exportsCount",
    "exportsBytes",
    "temporaryBytes",
    "restReads",
  ].includes(metric);
  const plan = await capacityPlan(ctx, organizationId, admitted || accessToExisting, options);
  if (!plan) return;
  if (stock(metric) && !(await capacityAccount(ctx, organizationId))?.ready)
    deny("CAPACITY_INVENTORY_REQUIRED");
  const now = Date.now();
  const total = await capacityTotal(ctx, organizationId, metric, now);
  if (
    (total?.committed ?? 0) + (total?.reserved ?? 0) + quantity >
    plan.capacity![planMetric(metric)]
  )
    throw new ConvexError({
      code: "QUOTA_EXCEEDED",
      metric,
      period: await capacityPeriod(ctx, organizationId, metric, now),
    });
}

/** The organization, key and metric identify an intent across both environments and all retries. */
export async function reserveCapacity(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  key: string,
  quantity: number,
  inventory = false,
  options: CustodyOption = {},
) {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || key.length > 400) deny("INVALID_REQUEST");
  await assertCapacityWritable(ctx, organizationId, inventory, options);
  const prior = await capacityEvent(ctx, organizationId, metric, key);
  if (prior) {
    if (prior.quantity !== quantity || prior.state === "released") deny("OPERATION_CONFLICT");
    return prior;
  }
  if (stock(metric)) await ensureCapacityReady(ctx, organizationId);
  if (!inventory) await checkCapacity(ctx, organizationId, metric, quantity, false, options);
  // Resolved once, here; commit and release use the event's stored period.
  const period = await capacityPeriod(ctx, organizationId, metric, Date.now());
  const id = await ctx.db.insert("capacityEvents", {
    organizationId,
    metric,
    key,
    period,
    quantity,
    remaining: quantity,
    state: "reserved",
    updatedAt: Date.now(),
  });
  await changeTotal(ctx, organizationId, metric, period, 0, quantity);
  return (await ctx.db.get("capacityEvents", id))!;
}

export async function commitCapacity(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  key: string,
  actual?: number,
) {
  const event = await capacityEvent(ctx, organizationId, metric, key);
  if (!event || event.state !== "reserved") return;
  const quantity = actual ?? event.remaining;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > event.remaining)
    deny("INVALID_REQUEST");
  await changeTotal(ctx, organizationId, metric, event.period, quantity, -event.remaining);
  await ctx.db.patch("capacityEvents", event._id, {
    state: "committed",
    remaining: 0,
    updatedAt: Date.now(),
  });
}
export async function releaseCapacity(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  metric: Metric,
  key: string,
) {
  const event = await capacityEvent(ctx, organizationId, metric, key);
  if (!event || event.state !== "reserved") return;
  await changeTotal(ctx, organizationId, metric, event.period, 0, -event.remaining);
  await ctx.db.patch("capacityEvents", event._id, {
    state: "released",
    remaining: 0,
    updatedAt: Date.now(),
  });
}

/** Consumes part of a reservation as durable originals arrive. Never refuses an admitted fiscal response. */
export async function trackStoredFile(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  storageId: Id<"_storage">,
  reservationKey?: string,
  options: { temporary?: boolean; restoringInventory?: boolean } = {},
) {
  await assertCapacityWritable(ctx, organizationId, options.restoringInventory);
  const prior = await ctx.db
    .query("capacityFiles")
    .withIndex("by_organizationId_and_storageId", (q) =>
      q.eq("organizationId", organizationId).eq("storageId", storageId),
    )
    .unique();
  if (prior) {
    const kind = options.temporary ? "temporary" : "original";
    if ((prior.kind ?? "original") !== kind) {
      await changeTotal(
        ctx,
        organizationId,
        prior.kind === "temporary" ? "temporaryBytes" : "filesBytes",
        "stock",
        -prior.size,
        0,
      );
      await changeTotal(
        ctx,
        organizationId,
        kind === "temporary" ? "temporaryBytes" : "filesBytes",
        "stock",
        prior.size,
        0,
      );
      await ctx.db.patch("capacityFiles", prior._id, { kind });
    }
    return;
  }
  const meta = await ctx.db.system.get("_storage", storageId);
  if (!meta) return;
  const metric = options.temporary ? "temporaryBytes" : "filesBytes";
  const event = reservationKey
    ? await capacityEvent(ctx, organizationId, metric, reservationKey)
    : null;
  const consumed = event?.state === "reserved" ? Math.min(meta.size, event.remaining) : 0;
  await changeTotal(ctx, organizationId, metric, "stock", meta.size, -consumed);
  if (event && consumed)
    await ctx.db.patch("capacityEvents", event._id, {
      remaining: event.remaining - consumed,
      updatedAt: Date.now(),
    });
  await ctx.db.insert("capacityFiles", {
    organizationId,
    storageId,
    size: meta.size,
    kind: options.temporary ? "temporary" : "original",
  });
}
/** Call after the existing retention/authorization decision and physical deletion, in the same mutation. */
export async function releaseStoredFile(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  storageId: Id<"_storage">,
) {
  const row = await ctx.db
    .query("capacityFiles")
    .withIndex("by_organizationId_and_storageId", (q) =>
      q.eq("organizationId", organizationId).eq("storageId", storageId),
    )
    .unique();
  if (!row) return;
  if (await ctx.db.system.get("_storage", storageId)) deny("OPERATION_CONFLICT");
  await changeTotal(
    ctx,
    organizationId,
    row.kind === "temporary" ? "temporaryBytes" : "filesBytes",
    "stock",
    -row.size,
    0,
  );
  await ctx.db.delete("capacityFiles", row._id);
}

/** Logical Convex document bytes, including system fields. Excludes indexes, replicas and component storage. */
export async function trackDatabaseRecord(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  table: string,
  id: string,
  record: Record<string, Value | undefined>,
  enforce = true,
  restoringInventory = false,
) {
  await assertCapacityWritable(ctx, organizationId, restoringInventory);
  const key = `${table}:${id}`;
  const prior = await ctx.db
    .query("capacityRecords")
    .withIndex("by_organizationId_and_key", (q) =>
      q.eq("organizationId", organizationId).eq("key", key),
    )
    .unique();
  const size = getDocumentSize(
    Object.fromEntries(
      Object.entries(record).filter((entry): entry is [string, Value] => entry[1] !== undefined),
    ),
  );
  const delta = size - (prior?.size ?? 0);
  // Parsing and materialization complete an already admitted original, even after plan expiry.
  if (enforce && delta > 0) await checkCapacity(ctx, organizationId, "databaseBytes", delta, true);
  await changeTotal(ctx, organizationId, "databaseBytes", "stock", delta, 0);
  if (prior) await ctx.db.patch("capacityRecords", prior._id, { size });
  else await ctx.db.insert("capacityRecords", { organizationId, key, size });
}
export async function releaseDatabaseRecord(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  table: string,
  id: string,
) {
  const row = await ctx.db
    .query("capacityRecords")
    .withIndex("by_organizationId_and_key", (q) =>
      q.eq("organizationId", organizationId).eq("key", `${table}:${id}`),
    )
    .unique();
  if (!row) return;
  await changeTotal(ctx, organizationId, "databaseBytes", "stock", -row.size, 0);
  await ctx.db.delete("capacityRecords", row._id);
}

export async function getCapacityUsage(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now = Date.now(),
) {
  const metrics: Metric[] = [
    "temporaryBytes",
    "filesBytes",
    "databaseBytes",
    "downloadsBytes",
    "exportsCount",
    "exportsBytes",
    "restReads",
  ];
  const rows = await Promise.all(
    metrics.map((metric) => capacityTotal(ctx, organizationId, metric, now)),
  );
  return {
    ready: (await capacityAccount(ctx, organizationId))?.ready ?? false,
    databaseMeasurement: "convex-document-bytes" as const,
    physicalDatabaseBytes: null,
    totals: Object.fromEntries(
      metrics.map((metric, i) => [
        metric,
        { committed: rows[i]?.committed ?? 0, reserved: rows[i]?.reserved ?? 0 },
      ]),
    ),
  };
}
export async function assertPlanCapacity(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  capacity: Capacity,
) {
  if (!(await capacityAccount(ctx, organizationId))?.ready) deny("CAPACITY_INVENTORY_REQUIRED");
  for (const metric of ["filesBytes", "databaseBytes", "temporaryBytes"] as const) {
    const total = await capacityTotal(ctx, organizationId, metric, Date.now());
    if ((total?.committed ?? 0) + (total?.reserved ?? 0) > capacity[planMetric(metric)])
      throw new ConvexError({ code: "QUOTA_EXCEEDED", metric, period: "stock" });
  }
}

/** A fresh server-generated transfer key per HTTP attempt. Client request ids cannot waive transfer accounting. */
export async function chargeDownload(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  storageId: Id<"_storage">,
  transferKey: string,
) {
  const meta = await ctx.db.system.get("_storage", storageId);
  if (!meta) deny("ORIGINAL_UNAVAILABLE");
  await chargeDownloadBytes(ctx, organizationId, meta.size, transferKey);
}
/**
 * A download of `size` bytes with no stored file to measure: a cold original (ADR 0010, decision
 * 8) is served as its raw XML, so it counts the same bytes as when it was hot.
 */
export async function chargeDownloadBytes(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  size: number,
  transferKey: string,
) {
  await reserveCapacity(ctx, organizationId, "downloadsBytes", transferKey, size);
  await commitCapacity(ctx, organizationId, "downloadsBytes", transferKey);
}

type FiscalTable =
  | "fiscalDocuments"
  | "documentArtifacts"
  | "documentVersions"
  | "documentItems"
  | "documentListings"
  | "documentFiscalEvidence";
async function fiscalOwner(
  ctx: MutationCtx,
  record: Doc<FiscalTable>,
): Promise<Id<"organizations">> {
  if ("organizationId" in record) return record.organizationId;
  if ("artifactId" in record) {
    const artifact = await ctx.db.get("documentArtifacts", record.artifactId);
    if (artifact) return artifact.organizationId;
  }
  if ("documentId" in record && record.documentId) {
    const document = await ctx.db.get("fiscalDocuments", record.documentId);
    if (document) return document.organizationId;
  }
  if ("versionId" in record) {
    const version = await ctx.db.get("documentVersions", record.versionId);
    if (version) return fiscalOwner(ctx, version);
  }
  return deny("NOT_FOUND");
}
/** Domain writes and their logical byte deltas commit or roll back together. */
export async function insertFiscal<T extends FiscalTable>(
  ctx: MutationCtx,
  table: T,
  value: WithoutSystemFields<Doc<T>>,
  enforce = true,
): Promise<Id<T>> {
  const id = await ctx.db.insert(table, value);
  const record = (await ctx.db.get<FiscalTable>(table, id))!;
  await trackDatabaseRecord(
    ctx,
    await fiscalOwner(ctx, record),
    table,
    id,
    record,
    enforce && table !== "documentArtifacts",
  );
  return id;
}
/**
 * `restoringInventory`: the write belongs to the rehydration of ADR 0009 (the cold stage of ADR
 * 0010, C2), so it is tracked while the organization is `restoring`, as the rehydration's own rows.
 */
export async function patchFiscal<T extends FiscalTable>(
  ctx: MutationCtx,
  table: T,
  id: Id<T>,
  value: Partial<Doc<T>>,
  enforce = true,
  restoringInventory = false,
) {
  await ctx.db.patch(table, id, value);
  const record = (await ctx.db.get<FiscalTable>(table, id))!;
  await trackDatabaseRecord(
    ctx,
    await fiscalOwner(ctx, record),
    table,
    id,
    record,
    enforce && table !== "documentArtifacts",
    restoringInventory,
  );
}
export async function deleteFiscal<T extends FiscalTable>(ctx: MutationCtx, table: T, id: Id<T>) {
  const record = await ctx.db.get<FiscalTable>(table, id);
  if (!record) return;
  await releaseDatabaseRecord(ctx, await fiscalOwner(ctx, record), table, id);
  await ctx.db.delete(table, id);
}
