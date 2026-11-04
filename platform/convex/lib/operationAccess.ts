import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { deny, requireMembership, type CustodyOption } from "./organizationAccess";
import { findCompany } from "./companyAccess";
import { canManageProject, isConsoleProject, projectGrant } from "./projectAccess";
import { requirePlatformEnvironment } from "../environment";
import { environmentServed, type EnvironmentPurpose } from "./environmentAccess";
import { isCaptureProcessing } from "./captureValues";
import { isRefusalReprocess } from "./importValues";
import { closureOf } from "./organizationClosure";
import { assertOrganizationHot } from "./coldArchiveCore";
import { CANCEL_SCOPE, ISSUE_SCOPE, cancelTask, issueTask } from "./issuanceValues";

type Task = Doc<"operations">["task"];
type TaskScope = {
  task: Pick<Task, "scope"> & Partial<Omit<Task, "scope">>;
  certificate?: Doc<"operations">["certificate"];
};
type Scope = Pick<Doc<"operations">, "organizationId" | "projectId" | "companyId" | "environment"> &
  TaskScope;
export type CompanyScope = Pick<Doc<"operations">, "organizationId" | "companyId" | "environment"> &
  TaskScope;
/**
 * Scope an operation is checked against, by keys, members and every worker attempt. Issuance
 * tasks take it from the task name, never from the stored scope: the console recorded
 * `documents:import` on `documents.issue` and `documents.cancel` before the issuance scopes
 * existed (#206). An unknown issuance task fails closed.
 */
export function requiredScope(task: Scope["task"]): Task["scope"] {
  if (task.workload !== "issuance") return task.scope;
  if (task.name === issueTask.name) return ISSUE_SCOPE;
  if (task.name === cancelTask.name) return CANCEL_SCOPE;
  return deny("NOT_FOUND");
}
/**
 * What the environment is checked for. The processing of a document the capture already stored
 * (`captureProcessingTask`, without a certificate) is `capture-processing`, which a withdrawn or
 * cut release still serves (#420): it reads the stored XML and never queries the source nor opens
 * the vault. The same task carrying a certificate is not that processing and keeps its scope.
 * Every other task uses its scope.
 */
export function environmentPurpose(op: TaskScope): EnvironmentPurpose {
  // The reprocessing of technical refusals (#499) is the same kind of work: stored originals
  // only, so it follows what was received after a withdrawal (`refusalTask`).
  return (isCaptureProcessing(op.task) || isRefusalReprocess(op.task)) && !op.certificate
    ? "capture-processing"
    : requiredScope(op.task);
}
/**
 * What any actor needs before its own rule: a company of the organization, an environment the
 * deployment serves for that company and task (`environmentServed`; demonstration only in
 * sandbox), a known task and an open organization.
 */
async function companyScopeAccess(ctx: QueryCtx, op: CompanyScope) {
  requirePlatformEnvironment();
  await assertOrganizationHot(ctx, op.organizationId);
  const company = await companyServed(ctx, await ctx.db.get("companies", op.companyId), op);
  // Closing an organization stops every operation at once, before its projects are disabled.
  if (await closureOf(ctx, op.organizationId)) deny("NOT_FOUND");
  return company;
}
/** The company is the scope's, and the deployment serves its environment for the task. */
async function companyServed(
  ctx: QueryCtx,
  company: Doc<"companies"> | null,
  op: CompanyScope,
): Promise<Doc<"companies">> {
  if (
    !company ||
    company._id !== op.companyId ||
    company.organizationId !== op.organizationId ||
    !(await environmentServed(ctx, company, op.environment, environmentPurpose(op)))
  )
    return deny("NOT_FOUND");
  return company;
}
/**
 * Project and grant an operation runs under. The console project has no grant: what it records
 * was authorized by a member (`memberAccess`), revalidated by the callers through the membership
 * and its company access version, so its grant epoch is always 0.
 */
export async function projectAccess(
  ctx: QueryCtx,
  op: Scope,
): Promise<{ project: Doc<"projects">; grant: Pick<Doc<"projectCompanies">, "accessEpoch"> }> {
  await companyScopeAccess(ctx, op);
  const project = await ctx.db.get("projects", op.projectId);
  if (!project || project.organizationId !== op.organizationId || project.state !== "active")
    return deny("NOT_FOUND");
  if (isConsoleProject(project)) return { project, grant: { accessEpoch: 0 } };
  const grant = await projectGrant(ctx, op.projectId, op.companyId);
  if (
    !grant?.active ||
    grant.organizationId !== op.organizationId ||
    !grant.scopes.includes(requiredScope(op.task)) ||
    !grant.environments.includes(op.environment)
  )
    return deny("NOT_FOUND");
  return { project, grant };
}
/** A mutation's context, told apart from a query's by the scheduler only mutations carry. */
const writes = (ctx: QueryCtx) => "scheduler" in ctx;
/**
 * The single key rule. `archived: "allowed"` only for what a key keeps in cold custody (ADR 0009,
 * §2): admission, the non-fiscal reads and switching off or rotating a webhook endpoint. Fiscal
 * routes keep the refusal here and again in `companyScopeAccess`, before any idempotency record.
 *
 * The expiry is compared with the clock only in a mutation. A query never reads it (#45): its
 * result is cached and not rerun as time passes. Every REST query runs after admission
 * (`observedAction`), which already compared `expiresAt` with the action's clock (#79).
 */
export async function authenticateKey(ctx: QueryCtx, keyHash: string, options: CustodyOption = {}) {
  requirePlatformEnvironment();
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
    .unique();
  if (!key || key.revokedAt !== null || (writes(ctx) && key.expiresAt <= Date.now()))
    deny("INVALID_API_KEY");
  const project = await ctx.db.get("projects", key.projectId);
  if (
    !project ||
    project.organizationId !== key.organizationId ||
    project.state !== "active" ||
    project.accessEpoch !== key.projectEpoch ||
    // No key is ever issued to the console project; refuse one all the same.
    isConsoleProject(project)
  )
    deny("INVALID_API_KEY");
  // Same answer as a revoked key; the revocation job follows the closure.
  if (await closureOf(ctx, key.organizationId)) deny("INVALID_API_KEY");
  if (options.archived !== "allowed") await assertOrganizationHot(ctx, key.organizationId);
  return key;
}
export async function keyAccess(ctx: QueryCtx, keyHash: string, op: Scope) {
  const key = await authenticateKey(ctx, keyHash);
  if (key.organizationId !== op.organizationId || key.projectId !== op.projectId) deny("NOT_FOUND");
  const { project, grant } = await projectAccess(ctx, op);
  if (key.projectEpoch !== project.accessEpoch) deny("INVALID_API_KEY");
  const index = key.companyIds.indexOf(op.companyId);
  if (index < 0 || key.grantEpochs[index] !== grant.accessEpoch) deny("NOT_FOUND");
  if (key.environment !== op.environment) deny("ENVIRONMENT_DENIED");
  if (!key.scopes.includes(requiredScope(op.task))) deny("SCOPE_DENIED");
  return key;
}
/** Roles that read the company's fiscal work in the console, and those that also change it. */
export const READ_ROLES: readonly string[] = ["owner", "admin", "operator", "viewer"];
export const WRITE_ROLES: readonly string[] = ["owner", "admin", "operator"];
/**
 * A person in the console works on the company, with no project or grant: active membership,
 * access to the company (`findCompany`: managers see all, the others by `companyGrants`) and
 * the role. Reading takes owner, admin, operator or viewer; writing, owner, admin or operator.
 * A developer reaches fiscal data only through the integrations it manages (`humanAccess`).
 * Without access to the company the answer is NOT_FOUND; with a role that cannot act,
 * SCOPE_DENIED.
 */
export async function memberAccess(ctx: QueryCtx, scope: CompanyScope, write: boolean) {
  // `requireMembership` already refused an archived or closed organization, and `findCompany`
  // read the company: only the environment the deployment serves is left to check.
  const { membership, user } = await requireMembership(ctx, scope.organizationId);
  const access = await findCompany(ctx, membership, scope.companyId);
  if (!access) return deny("NOT_FOUND");
  requirePlatformEnvironment();
  await companyServed(ctx, access.company, scope);
  if (!(write ? WRITE_ROLES : READ_ROLES).includes(membership.role)) deny("SCOPE_DENIED");
  return { user, membership, company: access.company, accessVersion: access.accessVersion };
}
/**
 * People read every record of the company, but change only what the console created: a record
 * of an integration project is managed by that integration. The answer names the integration
 * so the console can say where to go. (Cancelling an NFS-e is the one exception, in
 * `requestCancellation`, and notifies only the owning project.)
 */
export async function requireConsoleRecord(
  ctx: QueryCtx,
  record: Pick<Doc<"operations">, "organizationId" | "projectId">,
) {
  const project = await ctx.db.get("projects", record.projectId);
  if (project && project.organizationId === record.organizationId && isConsoleProject(project))
    return;
  throw new ConvexError({ code: "INTEGRATION_RECORD", integration: project?.name ?? null });
}
/**
 * Where a record came from, for the console to say it before any action: "console" or the
 * integration (project) that created it. Read only after the caller checked access to the
 * record; the name is of a project of the same organization. The server still refuses writes on
 * integration records (`requireConsoleRecord`).
 */
export const recordOrigin = v.object({
  kind: v.union(v.literal("console"), v.literal("integration")),
  integration: v.union(v.string(), v.null()),
});
export type RecordOrigin = Infer<typeof recordOrigin>;
export async function originOf(
  ctx: QueryCtx,
  record: Pick<Doc<"operations">, "organizationId" | "projectId">,
): Promise<RecordOrigin> {
  const project = await ctx.db.get("projects", record.projectId);
  const own = project && project.organizationId === record.organizationId ? project : null;
  if (own && isConsoleProject(own)) return { kind: "console", integration: null };
  return { kind: "integration", integration: own?.name ?? null };
}
/**
 * A person acting on a record that already has a project (an operation, an import, an
 * issuance): the console rule, whatever project created it, for reading; writing only on
 * records of the console project. A developer keeps what it had before the console stopped
 * asking for a project: records of a project it manages, under that project's grant, and
 * writes only on `webhooks:manage` work.
 */
export async function humanAccess(ctx: QueryCtx, op: Scope, write: boolean) {
  const { membership, user } = await requireMembership(ctx, op.organizationId);
  if (membership.role !== "developer") {
    const access = await memberAccess(ctx, op, write);
    if (write) await requireConsoleRecord(ctx, op);
    return access.user;
  }
  const { project } = await projectAccess(ctx, op);
  if (!(await findCompany(ctx, membership, op.companyId))) deny("NOT_FOUND");
  if (!canManageProject(membership, project)) deny("NOT_FOUND");
  if (write && requiredScope(op.task) !== "webhooks:manage") deny("SCOPE_DENIED");
  return user;
}
