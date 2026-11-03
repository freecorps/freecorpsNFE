import { RateLimiter } from "@convex-dev/rate-limiter";
import { components, internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./operationalAudit";
import { retryRestAdmission } from "./restAdmission";

const limiter = new RateLimiter(components.rateLimiter);

/** Check both buckets before consuming either, in the same transaction. */
export async function admitRestRequest(
  ctx: ActionCtx,
  organizationId: Id<"organizations">,
  actor: string,
  requestId: string,
) {
  const buckets = [
    { name: "rest-actor", key: actor, rate: 60 },
    { name: "rest-organization", key: organizationId, rate: 120 },
  ];
  // Keep checks and writes inside one component call to shorten the hot transaction.
  const result = await retryRestAdmission(() =>
    ctx.runMutation(components.rateLimiter.lib.rateLimitMany, {
      partitionShards: 8,
      // Both budgets try the same lane first, so two requests conflict only when they draw the
      // same lane (#559). The lane read first never changes a balance or a refusal.
      partitionLane: Math.floor(Math.random() * 8),
      limits: buckets.map(({ name, key, rate }) => ({
        name,
        key,
        config: { kind: "token bucket" as const, rate, capacity: rate, period: 60_000 },
      })),
    }),
  );
  if (!result.ok) {
    await ctx.runMutation(internal.usage.restRefusal, { organizationId, actor, requestId });
    return Math.max(1, Math.ceil(result.retryAfter / 1000));
  }
  return 0;
}

export async function recordRestRefusal(
  ctx: MutationCtx,
  {
    organizationId,
    actor,
    requestId,
  }: {
    organizationId: Id<"organizations">;
    actor: string;
    requestId: string;
  },
) {
  const diagnostic = await limiter.limit(ctx, "rest-refusal-diagnostic", {
    key: organizationId,
    config: { kind: "token bucket", rate: 1, capacity: 1, period: 60_000 },
  });
  if (diagnostic.ok)
    await recordAudit(ctx, {
      organizationId,
      actor,
      action: "http.rateLimited",
      target: organizationId,
      requestId,
      code: "RATE_LIMITED",
      status: 429,
    });
}
