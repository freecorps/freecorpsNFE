import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { deny, requireMembership, requireManager } from "./organizationAccess";
import { findCompany } from "./companyAccess";
import { authenticateKey, keyAccess, projectAccess } from "./operationAccess";
import { readTask } from "./documentCore";
import { canManageProject } from "./projectAccess";
import { requirePlatformEnvironment } from "../environment";
import { environmentServed, organizationEnvironmentServed } from "./environmentAccess";
import { closureOf, exportWindowOpen } from "./organizationClosure";
import { clockOf } from "./clock";

/**
 * Re-check the accepting actor, including epochs, even in workers and bearer tickets. The
 * worker's queries pass their caller's `now`; any other query never reads the clock (`clockOf`).
 */
export async function exportAllowed(
  ctx: QueryCtx,
  job: Doc<"documentExports">,
  now: number | null = clockOf(ctx),
) {
  requirePlatformEnvironment();
  // The destination job of an assisted export has no actor: no ticket is ever issued for it,
  // and it only runs where the organization does not exist (ADR 0009, §7).
  if (job.assisted) return assertAssistedDestination(ctx, job.organizationId);
  // An organization export outside the base environment needs a company served there, and
  // reads only those companies (`exportSource`); a document export follows its company
  // (`projectAccess` checks it again below).
  if (job.selection.kind === "organization") {
    if (
      !(await organizationEnvironmentServed(
        ctx,
        job.organizationId,
        job.environment,
        readTask.scope,
      ))
    )
      return deny("ENVIRONMENT_DENIED");
  } else {
    const company = await ctx.db.get("companies", job.selection.companyId);
    if (company && !(await environmentServed(ctx, company, job.environment, readTask.scope)))
      return deny("ENVIRONMENT_DENIED");
  }
  const closure = await closureOf(ctx, job.organizationId);
  if (closure && !exportWindowOpen(closure, now)) return deny("NOT_FOUND");
  let member: Doc<"memberships"> | null = null;
  if (job.membershipId) {
    member = await ctx.db.get("memberships", job.membershipId);
    if (
      !member ||
      member.state !== "active" ||
      member.organizationId !== job.organizationId ||
      member.version !== job.membershipVersion
    )
      return deny("NOT_FOUND");
  }
  if (job.selection.kind === "organization") {
    if (!member) return deny("NOT_FOUND");
    requireManager(member);
  } else {
    const scope = {
      ...job.selection,
      organizationId: job.organizationId,
      environment: job.environment,
      task: readTask,
    };
    const { project, grant } = await projectAccess(ctx, scope);
    if (project.accessEpoch !== job.projectEpoch || grant.accessEpoch !== job.grantEpoch)
      return deny("NOT_FOUND");
    if (member) {
      const access = await findCompany(ctx, member, scope.companyId);
      if (
        !access ||
        access.accessVersion !== job.accessVersion ||
        (member.role === "developer" && !canManageProject(member, project))
      )
        return deny("NOT_FOUND");
    } else {
      const key = job.keyId ? await ctx.db.get("apiKeys", job.keyId) : null;
      if (!key) return deny("NOT_FOUND");
      await keyAccess(ctx, key.keyHash, scope);
    }
  }
}
/**
 * Refuses the isolated generation of an assisted export (ADR 0009, §7) anywhere but in a
 * disposable restore destination: there the package brought only the `fiscal` class, so the
 * organization's row is absent, and crons, issuance and the fiscal capture are off, as
 * `coldArchive:restoreSafety` requires. In the origin the organization exists, so a job like this
 * never reads nor serves anything there.
 */
export async function assertAssistedDestination(
  ctx: QueryCtx,
  organizationId: Doc<"documentExports">["organizationId"],
) {
  if (
    process.env.FNFE_CRONS !== "off" ||
    process.env.FISCAL_ENV !== "disabled" ||
    process.env.FNFE_CAPTURE_FISCAL === "enabled" ||
    (await ctx.db.get("organizations", organizationId))
  )
    return deny("ASSISTED_EXPORT_NOT_ISOLATED");
}
export async function exportActor(ctx: QueryCtx, job: Doc<"documentExports">, keyHash?: string) {
  if (keyHash) {
    const key = await authenticateKey(ctx, keyHash);
    if (key._id !== job.keyId) return deny("NOT_FOUND");
  } else {
    // An assisted export is the one export an archived organization's owner downloads (ADR 0009,
    // §2 and §7); every other one keeps the archive refusal.
    const { membership } = await requireMembership(ctx, job.organizationId, {
      closed: "export",
      ...(job.assistedRequestId ? { archived: "allowed" as const } : {}),
    });
    if (membership._id !== job.membershipId) return deny("NOT_FOUND");
  }
  await exportAllowed(ctx, job);
}
/** `now` is `null` in a query (`clockOf`): `exports.expire` persists `expired` at `expiresAt`. */
export function summarizeExport(job: Doc<"documentExports">, now: number | null) {
  return {
    id: job._id,
    selection: job.selection,
    environment: job.environment,
    state: now !== null && job.expiresAt <= now ? ("expired" as const) : job.state,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    parts: job.sequence,
    bytes: job.bytes,
    code: job.code ?? null,
  };
}
export function summarizePart(part: Doc<"exportParts">) {
  return { id: part._id, sequence: part.sequence, sha256: part.sha256, size: part.size };
}
