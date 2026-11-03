import { useContext, useEffect, type ReactNode } from "react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache";
import { ConvexQueryCacheContext } from "convex-helpers/react/cache/provider";

/**
 * Queries of an organization's pages. Same contract as `convex/react`, but a page that unmounts
 * leaves its subscriptions open for a while, so coming back to it renders the current answer at
 * once instead of loading it again. Mutations and actions keep coming from `convex/react`.
 *
 * Only under `OrganizationQueryCache`, which the organization layout mounts once per
 * authorized organization, address and connection (docs/desenvolvimento/frontend.md, "Cache de consultas").
 */
export { useQuery, usePaginatedQuery } from "convex-helpers/react/cache";

/**
 * How long a subscription nobody renders stays open. A minute covers going to a record and back,
 * or to another page and back, which is what the cache is for; the subscription stays live
 * meanwhile, so what comes back is the current answer, not a copy. Longer would keep the
 * server re-running queries of pages left behind for little gain.
 */
export const QUERY_CACHE_EXPIRATION_MS = 60_000;
/**
 * Most idle subscriptions kept at once. Each page holds from one to about eight; this keeps a
 * full tour of the organization's pages and drops the next ones right away beyond it.
 */
export const QUERY_CACHE_MAX_IDLE = 64;

/**
 * The organization's query cache, only in memory: nothing is written to the browser's storage.
 * Unmounting it (another organization, membership lost or changed, disconnect, logout) closes
 * every subscription it held at once, without waiting for the expiration.
 */
export function OrganizationQueryCache({ children }: { children: ReactNode }) {
  return (
    <ConvexQueryCacheProvider
      expiration={QUERY_CACHE_EXPIRATION_MS}
      maxIdleEntries={QUERY_CACHE_MAX_IDLE}
    >
      <DropOnUnmount />
      {children}
    </ConvexQueryCacheProvider>
  );
}

/**
 * The provider keeps idle subscriptions on timers even after it unmounts. Closing them here,
 * whatever the order the pages below release theirs: once the entries are gone, a late release
 * finds nothing to keep.
 */
function DropOnUnmount() {
  const { registry } = useContext(ConvexQueryCacheContext);
  useEffect(() => {
    if (!registry) return;
    return () => {
      for (const entry of registry.queries.values()) {
        if (entry.evictTimer !== null) clearTimeout(entry.evictTimer);
        entry.unsub();
      }
      registry.queries.clear();
      registry.subs.clear();
      registry.idle = 0;
    };
  }, [registry]);
  return null;
}
