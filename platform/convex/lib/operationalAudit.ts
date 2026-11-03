import type { Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { auditFields } from "./observabilitySchema";
import { armRetention } from "./operationalRetention";

export type AuditEntry = { [K in keyof typeof auditFields]: Infer<(typeof auditFields)[K]> };
type Entry = Pick<AuditEntry, "organizationId" | "actor" | "action" | "target"> &
  Partial<AuditEntry>;
export const DAY = 86_400_000;
// Domain fields only. No arbitrary metadata, exception messages, URL, body or headers.
export function safeToken(value: string | undefined, max = 120) {
  return value && value.length <= max && /^[a-zA-Z0-9_.:/-]+$/.test(value) ? value : undefined;
}
export async function recordAudit(ctx: MutationCtx, input: Entry) {
  const createdAt = Date.now();
  const entry = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    companyId: input.companyId,
    environment: input.environment,
    actor: safeToken(input.actor) ?? "redacted",
    action: safeToken(input.action) ?? "redacted",
    target: safeToken(input.target) ?? "redacted",
    requestId: safeToken(input.requestId, 36),
    operationId: input.operationId,
    eventId: safeToken(input.eventId, 36),
    code: safeToken(input.code, 80),
    status: input.status,
    durationMs: input.durationMs,
    createdAt,
    expiresAt: createdAt + (input.action.startsWith("http.") ? 30 : 365) * DAY,
  };
  await ctx.db.insert("operationalAudit", entry);
  await armRetention(ctx, input.organizationId, entry.expiresAt);
  console.info(JSON.stringify({ type: "operational", ...entry }));
}
