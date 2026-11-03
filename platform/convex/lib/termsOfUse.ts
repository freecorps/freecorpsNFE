import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { audit, deny } from "./organizationAccess";
import { DAY } from "./operationalAudit";
import { TERMS_OF_USE_ARCHIVE, TERMS_OF_USE_VERSION } from "./termsOfUseArchive";

/**
 * Days between a version entering the console and taking effect (terms of use, section 11): the
 * notice to the organizations that accepted an older one, or none. A new organization accepts the
 * current version when it is created.
 */
export const TERMS_OF_USE_NOTICE_DAYS = 30;
/** Code of a new command refused because the organization has not accepted the terms in effect. */
export const TERMS_OF_USE_REQUIRED = "TERMS_OF_USE_REQUIRED";

/**
 * The version the console asks for now, with the SHA-256 of its text, the day it entered the
 * console (`since`, midnight in Brasília) and when it takes effect for the organizations that have
 * not accepted it. `null` while no version is current.
 */
export function currentTermsOfUse() {
  const version = TERMS_OF_USE_VERSION;
  if (version === null) return null;
  const archived = TERMS_OF_USE_ARCHIVE[version];
  if (!archived) throw new Error("Current terms of use missing from the archive");
  const since = Date.parse(`${archived.since}T00:00:00-03:00`);
  return {
    version,
    sha256: archived.sha256,
    since,
    effectiveAt: since + TERMS_OF_USE_NOTICE_DAYS * DAY,
  };
}

/** The organization's last acceptance, the one that holds. */
export async function termsOfUseAcceptance(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return await ctx.db
    .query("termsOfUseAcceptances")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .first();
}

/**
 * What the organization still has to accept: `null` when no version is current or it accepted the
 * current one; otherwise the version and when it takes effect. Unknown versions count as older.
 */
export function pendingTermsOfUse(accepted: string | null) {
  const current = currentTermsOfUse();
  if (!current || accepted === current.version) return null;
  return { version: current.version, effectiveAt: current.effectiveAt };
}

/**
 * The cut of section 11: once the current version is in effect, an organization that has not
 * accepted it creates no new command. Reading, exports, data subject requests and the work already
 * admitted go on; the callers are the entries of new commands (`operations.reserve`, import
 * admission). No read while no version is current.
 */
export async function requireTermsOfUse(ctx: QueryCtx, organizationId: Id<"organizations">) {
  if (!currentTermsOfUse()) return;
  const pending = pendingTermsOfUse(
    (await termsOfUseAcceptance(ctx, organizationId))?.version ?? null,
  );
  if (pending && Date.now() >= pending.effectiveAt) deny(TERMS_OF_USE_REQUIRED);
}

/**
 * Records an owner's acceptance of the current version, with the SHA-256 of its text, both chosen
 * by the server. `terms` is the version the person read: another one, or any while none is
 * current, is TERMS_OF_USE_OUTDATED, and the console shows the text again.
 */
export async function acceptTermsOfUse(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    membershipId: Id<"memberships">;
    authUserId: string;
    terms: string | undefined;
  },
) {
  const terms = currentTermsOfUse();
  if (!terms) {
    if (args.terms !== undefined) deny("TERMS_OF_USE_OUTDATED");
    return null;
  }
  if (args.terms !== terms.version) return deny("TERMS_OF_USE_OUTDATED");
  await ctx.db.insert("termsOfUseAcceptances", {
    organizationId: args.organizationId,
    membershipId: args.membershipId,
    version: terms.version,
    sha256: terms.sha256,
    createdAt: Date.now(),
  });
  await audit(ctx, {
    organizationId: args.organizationId,
    actorUserId: args.authUserId,
    action: "organization.terms-accepted",
    target: terms.version,
  });
  return terms.version;
}
