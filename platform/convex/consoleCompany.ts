import { companyCapabilities } from "@freecorps/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { findCompany } from "./lib/companyAccess";
import { READ_ROLES, WRITE_ROLES } from "./lib/operationAccess";
import { requireMembership } from "./lib/organizationAccess";

const consoleCompany = v.union(
  v.null(),
  v.object({
    id: v.id("companies"),
    name: v.string(),
    cnpj: v.string(),
    kind: v.union(v.literal("declared"), v.literal("demonstration")),
    /** Owner, admin, operator or viewer: reads documents, imports and issuances. */
    canRead: v.boolean(),
    /** Owner, admin or operator: imports, issues, cancels, refreshes and controls work. */
    canWrite: v.boolean(),
    /** Owner or admin: manages the company and who has access to it. */
    canManage: v.boolean(),
  }),
);

/** The company as the console's fiscal screens show it, with what the member may do there. */
function answer(company: Doc<"companies">, membership: Doc<"memberships">) {
  return {
    id: company._id,
    name: company.name,
    cnpj: company.cnpj,
    kind: company.kind,
    canRead: READ_ROLES.includes(membership.role),
    canWrite: WRITE_ROLES.includes(membership.role),
    canManage: companyCapabilities(membership.role).manage,
  };
}

/**
 * Company the console works on, from an untrusted URL or stored selector, and what the member
 * may do there. `null` when the company does not exist or the member has no access to it, without
 * telling the cases apart. The capabilities guide the screens; every function checks again.
 * `contextKey` is not read on purpose: it makes each console context (organization, membership
 * version, reconnection) open a fresh subscription instead of reusing the previous one, the
 * same convention as `companies.list` (docs/desenvolvimento/frontend.md, "Contexto de empresa").
 */
export const context = query({
  args: { organizationId: v.id("organizations"), company: v.string(), contextKey: v.string() },
  returns: consoleCompany,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    const companyId = ctx.db.normalizeId("companies", args.company);
    const access = companyId ? await findCompany(ctx, membership, companyId) : null;
    return access ? answer(access.company, membership) : null;
  },
});

/** As many rows as the first page of the console's company picker (`companies.list`). */
const SOLE_SCAN = 20;

/**
 * The only company the member can open in the organization, for the fiscal screens when neither
 * the URL nor this browser chose one. Same answer as `context` for that company; `null` when the
 * member can open none or more than one. It answers in the same round trip as `companies.list`,
 * instead of the screen waiting for the whole list before asking `context`. Bounded like the
 * picker's first page: past `SOLE_SCAN` companies or grants it is `null` and the person chooses.
 * Every company found goes through `findCompany`, the same check as `context`.
 */
export const sole = query({
  args: { organizationId: v.id("organizations"), contextKey: v.string() },
  returns: consoleCompany,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    const ids = await candidateIds(ctx, membership, args.organizationId);
    if (!ids) return null;
    const found: Doc<"companies">[] = [];
    for (const id of ids) {
      const access = await findCompany(ctx, membership, id);
      if (access) found.push(access.company);
      if (found.length > 1) return null;
    }
    return found.length === 1 ? answer(found[0]!, membership) : null;
  },
});
/** The companies the member may see, as `companies.list` reads them; `null` past the bound. */
async function candidateIds(
  ctx: QueryCtx,
  membership: Doc<"memberships">,
  organizationId: Id<"organizations">,
): Promise<Id<"companies">[] | null> {
  if (companyCapabilities(membership.role).manage) {
    // A manager sees every company of the organization: two rows already mean a choice.
    const rows = await ctx.db
      .query("companies")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .take(2);
    return rows.map((row) => row._id);
  }
  const grants = await ctx.db
    .query("companyGrants")
    .withIndex("by_membershipId_and_membershipEpoch_and_active", (q) =>
      q
        .eq("membershipId", membership._id)
        .eq("membershipEpoch", membership.companyAccessEpoch ?? 0)
        .eq("active", true),
    )
    .take(SOLE_SCAN + 1);
  if (grants.length > SOLE_SCAN) return null;
  return grants.flatMap((grant) =>
    grant.organizationId === organizationId ? [grant.companyId] : [],
  );
}
