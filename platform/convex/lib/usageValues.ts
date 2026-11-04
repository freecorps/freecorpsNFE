import { v } from "convex/values";
import { assignedTier, planCapacity } from "./planCatalog";

/** Metrics shown by the usage overview. */
export const reportedMetric = v.union(
  v.literal("imports"),
  v.literal("documents"),
  v.literal("captures"),
  v.literal("registry"),
  v.literal("bytes"),
  v.literal("deliveries"),
  v.literal("attempts"),
  v.literal("issuances"),
);
/**
 * Stored metrics, all shown by the overview. `issuances` counts NFS-e authorized by the
 * platform: measured only, without a plan limit.
 */
export const usageMetric = reportedMetric;
export type UsageMetric = typeof usageMetric.type;
export const metrics: (typeof reportedMetric.type)[] = [
  "imports",
  "documents",
  "captures",
  "registry",
  "bytes",
  "deliveries",
  "attempts",
  "issuances",
];
const limit = v.union(v.number(), v.null());
export const planLimits = v.object({
  imports: limit,
  captures: limit,
  registry: limit,
  bytes: limit,
  deliveries: limit,
  /**
   * New notes per month in Production only (ADR 0010, decisions 10 and 11), counted by the
   * `documents` metric. A plan with it gates new imports and capture queries in Production by
   * the notes instead of `imports` and `captures`, which keep gating the sandbox. In the
   * catalog, only the free tier has it; the paid tiers keep their units (decision 4).
   */
  notes: v.optional(v.number()),
});
type PlanLimits = typeof planLimits.type;
type UsageEnvironment = "sandbox" | "production";
/** Metrics with a commercial quota of their own in the plan; the others are measured only. */
const limited = (metric: UsageMetric): metric is Exclude<keyof PlanLimits, "notes"> =>
  metric !== "documents" && metric !== "attempts" && metric !== "issuances";
/**
 * The metrics a plan with `notes` gates by the notes in Production (ADR 0010, decision 10): the
 * admissions that bring new notes in, a capture query and an imported file.
 */
const noteAdmission = (metric: UsageMetric) => metric === "imports" || metric === "captures";
/**
 * The plan's own limit of `metric` in `environment`, or null when nothing caps it. In Production,
 * a plan with `notes` caps imports and captures by the notes instead (`noteLimit`).
 */
export function planLimit(
  plan: { limits: PlanLimits } | null,
  metric: UsageMetric,
  environment: UsageEnvironment,
) {
  if (!plan || !limited(metric)) return null;
  if (environment === "production" && plan.limits.notes !== undefined && noteAdmission(metric))
    return null;
  return plan.limits[metric];
}
/**
 * The notes quota that gates a new admission of `metric` in `environment`, or null. The notes are
 * the production `documents` (one per `fiscalDocuments`, so per company and key): a summary, the
 * full XML and events of the same key count once, the same key in two companies counts twice.
 */
export function noteLimit(
  plan: { limits: PlanLimits } | null,
  metric: UsageMetric,
  environment: UsageEnvironment,
) {
  return plan && environment === "production" && noteAdmission(metric)
    ? (plan.limits.notes ?? null)
    : null;
}
/**
 * `endsAt: null` is a plan without an end (#429: a permanent free tier); `startsAt` stays required,
 * so a plan not yet started is not in force. Quotas are monthly either way, in the plan's quota
 * period (`quotaPeriod`).
 */
export const planFields = {
  catalogTier: v.optional(assignedTier),
  capacity: v.optional(planCapacity),
  name: v.string(),
  startsAt: v.number(),
  endsAt: v.union(v.number(), v.null()),
  limits: planLimits,
  concurrency: v.number(),
  /**
   * The instant, in ms truncated to the whole second, whose monthly anniversaries open the quota
   * periods (ADR 0012, section 4). Missing is the civil UTC month; the free tier never has one. A
   * row replacing another does not inherit it.
   */
  periodAnchor: v.optional(v.number()),
};
/** Whether the plan's term has ended at `now`; a plan without `endsAt` never ends. */
export function planEnded(plan: { endsAt: number | null }, now: number) {
  return plan.endsAt !== null && plan.endsAt <= now;
}
/** The civil UTC month of `now`, `AAAA-MM`: billing months. Quotas use `quotaPeriod`. */
export function usagePeriod(now: number) {
  return new Date(now).toISOString().slice(0, 7);
}
/** First instant of the civil UTC month after the one of `now` (as `usagePeriod`). */
export function nextUsagePeriodStart(now: number) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
