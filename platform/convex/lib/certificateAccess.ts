import { recordAudit } from "./operationalAudit";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
export function certificateHead(ctx: QueryCtx, companyId: Id<"companies">) {
  return ctx.db
    .query("certificateHeads")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
    .unique();
}
export async function certificateUsable(
  ctx: QueryCtx,
  scope: { organizationId: Id<"organizations">; companyId: Id<"companies"> },
  pin: { id: Id<"certificates">; version: number },
  now: number,
) {
  const [head, cert] = await Promise.all([
    certificateHead(ctx, scope.companyId),
    ctx.db.get("certificates", pin.id),
  ]);
  return (
    !!cert &&
    head?.activeId === cert._id &&
    cert.organizationId === scope.organizationId &&
    cert.companyId === scope.companyId &&
    cert.version === pin.version &&
    cert.state === "active" &&
    !!cert.envelope &&
    !!cert.metadata &&
    cert.metadata.notBefore <= now &&
    cert.metadata.notAfter > now
  );
}
export async function certificateAudit(
  ctx: MutationCtx,
  cert: Doc<"certificates">,
  action: string,
  result: string,
  actor = "system",
  operationId?: Id<"operations">,
) {
  await recordAudit(ctx, {
    organizationId: cert.organizationId,
    companyId: cert.companyId,
    actor,
    action: `certificate.${action}`,
    target: cert._id,
    operationId,
    code: result,
  });
  await ctx.db.insert("certificateAudit", {
    organizationId: cert.organizationId,
    companyId: cert.companyId,
    certificateId: cert._id,
    version: cert.version,
    actor,
    action,
    result,
    createdAt: Date.now(),
    ...(cert.envelope ? { keyVersion: cert.envelope.keyVersion } : {}),
    ...(operationId ? { operationId } : {}),
  });
}
export function certificateSummary(cert: Doc<"certificates">) {
  return {
    id: cert._id,
    version: cert.version,
    state: cert.state,
    metadata: cert.metadata ?? null,
    code: cert.code ?? null,
    createdAt: cert.createdAt,
  };
}
