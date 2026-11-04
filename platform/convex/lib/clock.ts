import type { QueryCtx } from "../_generated/server";

/**
 * The clock for a time check shared by queries and mutations: `Date.now()` in a mutation, `null`
 * in a query. A query never reads the clock (#45): its result is cached and not rerun as time
 * passes, so a deadline it compared would stay stale. With `null` the check falls back to what
 * the deadline's scheduled job persists (`certificates.expire`, `exports.expire`, the closure's
 * purge) or to the admission that already compared it (`observedAction`, #79). A mutation's
 * context is told apart by the scheduler only mutations carry.
 */
export function clockOf(ctx: QueryCtx): number | null {
  return "scheduler" in ctx ? Date.now() : null;
}
