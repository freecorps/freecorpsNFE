import type { Id } from "../../../platform/convex/_generated/dataModel";

/**
 * Arguments of the first queries of the organization's pages, shared by the page and by its
 * route loader. The loader asks for them ahead (`convex.prewarmQuery`) while the page's code
 * arrives; the page then subscribes to the same query with the same arguments and finds the
 * answer already there. The Convex client tells two subscriptions apart by the serialized
 * arguments, key order included, so both sides build them here (docs/desenvolvimento/frontend.md,
 * "Consultas antecipadas").
 */

/**
 * The first page of a paginated query, as `usePaginatedQuery` of the query cache
 * (`convex-helpers/react/cache`) asks for it: the page's arguments, then `paginationOpts` with a
 * fixed id. Proved by `query-cache.test.tsx`; if the library changes it, the prewarm only misses.
 */
export function firstPageArgs<A extends object>(args: A, numItems: number) {
  return { ...args, paginationOpts: { numItems, cursor: null, id: 0 } };
}

type Scope = { org: { id: Id<"organizations"> }; contextKey: string };

/** `companies.list` on the companies page and on the fiscal screens' company picker. */
export const COMPANIES_PAGE_SIZE = 20;
export const companiesListArgs = ({ org, contextKey }: Scope) => ({
  organizationId: org.id,
  contextKey,
});

/** `companies.get` of `/companies/$companyId`; the segment is untrusted text, checked there. */
export const companyArgs = ({ org, contextKey }: Scope, companyId: string) => ({
  organizationId: org.id,
  companyId,
  contextKey,
});

/** Only the opaque company id is kept, per organization: never names, documents or secrets. */
export const storageKey = (organizationId: string) => `fnfe:console-company:${organizationId}`;
/** The company this browser last used in the organization; `""` when none. */
export function rememberedCompany(organizationId: string) {
  try {
    return globalThis.localStorage?.getItem(storageKey(organizationId)) ?? "";
  } catch {
    return "";
  }
}
/** `consoleCompany.context`: the company chosen by the URL, the screen or this browser. */
export const companyContextArgs = ({ org, contextKey }: Scope, company: string) => ({
  organizationId: org.id,
  company,
  contextKey,
});
/** `consoleCompany.sole`: the only company, when nothing was chosen. */
export const soleCompanyArgs = ({ org, contextKey }: Scope) => ({
  organizationId: org.id,
  contextKey,
});
/** The scope a fiscal screen hands to its company's queries, in the deployment's environment. */
export const companyScope = (
  organizationId: Id<"organizations">,
  companyId: Id<"companies">,
  environment: "sandbox" | "production",
) => ({
  organizationId,
  companyId,
  environment,
});

/** The usage period opens on the current month, in UTC. */
export const currentUsagePeriod = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
export const usageArgs = ({ org, contextKey }: Scope, period: string) => ({
  organizationId: org.id,
  period,
  contextKey,
});

export const operationsOverviewArgs = ({ org, contextKey }: Scope) => ({
  organizationId: org.id,
  contextKey,
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export type AuditFilters = { actor: string; action: string; from: number; until: number };
export const AUDIT_PAGE_SIZE = 20;
/**
 * The audit opens on the last 7 days. The period moves by the hour, not by the millisecond:
 * coming back within the hour (or the loader asking a moment before the page) is the same query.
 */
export function defaultAuditFilters(now = Date.now()): AuditFilters {
  const hour = Math.floor(now / HOUR) * HOUR;
  return { actor: "", action: "", from: hour - 7 * DAY, until: hour + DAY };
}
export const auditArgs = ({ org, contextKey }: Scope, filters: AuditFilters) => ({
  organizationId: org.id,
  contextKey,
  ...filters,
  actor: filters.actor || undefined,
  action: filters.action || undefined,
});
