import { recordAudit } from "./operationalAudit";
import { grantableScopes, type IntegrationScope } from "@freecorps/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { deny, requireMembership, type CustodyOption } from "./organizationAccess";
import { findCompany } from "./companyAccess";

export async function integrationActor(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  options: CustodyOption = {},
) {
  const access = await requireMembership(ctx, organizationId, options);
  if (!grantableScopes(access.membership.role).length) deny();
  return access;
}
/**
 * Console project: one per organization, owner of the operations, imports, issuances and
 * tickets people create in the console, and namespace of their idempotency keys. It has no
 * grants, API keys or webhooks and is never listed, edited or removed as an integration: no one
 * manages it (`canManageProject`). It is found by `kind`, never by its reference, so an old
 * integration with any reference cannot be mistaken for it nor make the lookup fail.
 */
export const CONSOLE_REFERENCE = "";
export const isConsoleProject = (project: Pick<Doc<"projects">, "kind">) =>
  project.kind === "console";
export async function consoleProject(ctx: QueryCtx, organizationId: Id<"organizations">) {
  // `ensureConsoleProject` reads this same index range before inserting, so concurrent first
  // writes conflict and retry instead of creating two. `first` (oldest) never throws.
  return ctx.db
    .query("projects")
    .withIndex("by_organizationId_and_kind", (q) =>
      q.eq("organizationId", organizationId).eq("kind", "console"),
    )
    .first();
}
/** Idempotent: the first console write of the organization creates it, the others reuse it. */
export async function ensureConsoleProject(
  ctx: MutationCtx,
  membership: Doc<"memberships">,
): Promise<Id<"projects">> {
  const existing = await consoleProject(ctx, membership.organizationId);
  if (existing) return existing._id;
  return ctx.db.insert("projects", {
    organizationId: membership.organizationId,
    name: "Console",
    externalReference: CONSOLE_REFERENCE,
    kind: "console",
    state: "active",
    version: 1,
    accessEpoch: 0,
    creatorMembershipId: membership._id,
    creatorEpoch: membership.companyAccessEpoch ?? 0,
    createdAt: Date.now(),
  });
}
export function canManageProject(member: Doc<"memberships">, project: Doc<"projects">) {
  return (
    !isConsoleProject(project) &&
    member.state === "active" &&
    member.organizationId === project.organizationId &&
    (member.role === "owner" ||
      member.role === "admin" ||
      (member.role === "developer" &&
        project.creatorMembershipId === member._id &&
        project.creatorEpoch === (member.companyAccessEpoch ?? 0)))
  );
}
export async function requireProject(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  options: CustodyOption = {},
) {
  const access = await integrationActor(ctx, organizationId, options);
  const project = await ctx.db.get("projects", projectId);
  if (!project || !canManageProject(access.membership, project)) return deny();
  return { ...access, project };
}
export function validateScopes(member: Doc<"memberships">, scopes: IntegrationScope[]) {
  const allowed = grantableScopes(member.role);
  if (
    !scopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((s) => !allowed.includes(s))
  )
    deny("SCOPE_DENIED");
}
export async function requireGrantableCompany(
  ctx: QueryCtx,
  member: Doc<"memberships">,
  companyId: Id<"companies">,
) {
  const result = await findCompany(ctx, member, companyId);
  if (!result) return deny();
  return result.company;
}
export async function projectGrant(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  companyId: Id<"companies">,
) {
  return ctx.db
    .query("projectCompanies")
    .withIndex("by_projectId_and_companyId", (q) =>
      q.eq("projectId", projectId).eq("companyId", companyId),
    )
    .unique();
}
export async function integrationAudit(
  ctx: MutationCtx,
  project: Doc<"projects">,
  actorUserId: string,
  action: string,
  target: string,
) {
  await recordAudit(ctx, {
    organizationId: project.organizationId,
    projectId: project._id,
    actor: actorUserId,
    action,
    target,
  });
  await ctx.db.insert("integrationAudit", {
    organizationId: project.organizationId,
    projectId: project._id,
    actorUserId,
    action,
    target,
    createdAt: Date.now(),
  });
}
export function summarizeProject(project: Doc<"projects">) {
  return {
    id: project._id,
    name: project.name,
    externalReference: project.externalReference,
    state: project.state,
    version: project.version,
    createdAt: project.createdAt,
  };
}
export function summarizeKey(key: Doc<"apiKeys">) {
  return {
    id: key._id,
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes,
    environment: key.environment,
    companyIds: key.companyIds,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    rotatedAt: key.rotatedAt,
    createdAt: key.createdAt,
  };
}
