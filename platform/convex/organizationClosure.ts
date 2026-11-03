import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { audit, deny, limitOrganizationAction, requireMembership } from "./lib/organizationAccess";
import { EXPORT_WINDOW, PURGE_WINDOW, closureOf } from "./lib/organizationClosure";
import { closureState } from "./lib/closureSchema";
import { purger, type Budget } from "./lib/purge";
import { armGuard, guardOf, sandboxOnly } from "./fiscalGuard";
import { requirePlatformEnvironment } from "./environment";
import { FREECORPS_OPERATOR, operatorAndReason } from "./lib/issuanceGate";
import { planFor } from "./lib/usageCore";
import { planEnded } from "./lib/usageValues";
import { cardBlocksPix } from "./lib/billingCore";
import { activeTerm } from "./lib/planTerms";
import { archiveStatus } from "./lib/coldArchiveCore";

// Rows removed per transaction. Each batch continues through the scheduler until nothing is left.
const BATCH = 200;
// How long the purge waits before checking again a cold archive run in `deleting` or `restoring`.
export const PURGE_ARCHIVE_WAIT = 60 * 60 * 1000;

/**
 * Starts D01 for one organization. New operations stop at once through the closure gate; the
 * revocation job then disables projects, keys, webhooks, monitors and invitations.
 */
export async function startClosure(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; requestedAt: number; requestedBy: string },
) {
  const exportUntil = args.requestedAt + EXPORT_WINDOW;
  const id = await ctx.db.insert("organizationClosures", {
    organizationId: args.organizationId,
    state: "closing",
    requestedAt: args.requestedAt,
    requestedBy: args.requestedBy,
    exportUntil,
    purgeBy: exportUntil + PURGE_WINDOW,
    generation: 1,
    revoked: false,
    removed: 0,
  });
  await ctx.scheduler.runAfter(0, internal.organizationClosure.revoke, {
    closureId: id,
    phase: 0,
    cursor: null,
  });
  await armPurge(ctx, id, 1, exportUntil);
  // A card subscription stops renewing with the organization (#556).
  if (
    await ctx.db
      .query("billingAccounts")
      .withIndex("by_organizationId_and_livemode", (q) =>
        q.eq("organizationId", args.organizationId),
      )
      .first()
  )
    await ctx.scheduler.runAfter(0, internal.billing.stopForClosure, {
      organizationId: args.organizationId,
      attempt: 0,
    });
  return id;
}
export async function armPurge(
  ctx: MutationCtx,
  closureId: Id<"organizationClosures">,
  generation: number,
  at: number,
) {
  const scheduledId = await ctx.scheduler.runAt(
    Math.max(Date.now(), at),
    internal.organizationClosure.purge,
    { closureId, generation },
  );
  await ctx.db.patch("organizationClosures", closureId, { generation, scheduledId });
}

/**
 * The closure request every path shares: the owner in the console, the operator and Freecorps
 * after the Sandbox-only notice (`sandboxClosure.close`). Starts D01 now and records
 * `organization.closure-requested` with `actor` in the organization's audit. The caller checks
 * who may close and that no closure exists yet.
 */
export async function requestClosure(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; requestedBy: string; actor: string },
) {
  const id = await startClosure(ctx, {
    organizationId: args.organizationId,
    requestedAt: Date.now(),
    requestedBy: args.requestedBy,
  });
  await audit(ctx, {
    organizationId: args.organizationId,
    actorUserId: args.actor,
    action: "organization.closure-requested",
    target: args.organizationId,
  });
  const closure = (await ctx.db.get("organizationClosures", id))!;
  return {
    closureId: id,
    requestedAt: closure.requestedAt,
    exportUntil: closure.exportUntil,
    purgeBy: closure.purgeBy,
  };
}

export const close = mutation({
  args: { organizationId: v.id("organizations"), confirmation: v.string() },
  returns: v.object({ exportUntil: v.number(), purgeBy: v.number() }),
  handler: async (ctx, args) => {
    // Accepted in cold custody too (ADR 0009, §2); `purge` waits for the run to settle.
    const { user, membership, organization } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    if (membership.role !== "owner") return deny();
    if (args.confirmation.trim().toLowerCase() !== organization.slug)
      return deny("CONFIRMATION_MISMATCH");
    await limitOrganizationAction(ctx, "close", user._id, 3);
    // An annual term ends through support ("Rescindir"), which computes the refund (30/10/2026).
    if (await activeTerm(ctx, organization._id, Date.now())) return deny("ANNUAL_TERM_ACTIVE");
    const { exportUntil, purgeBy } = await requestClosure(ctx, {
      organizationId: organization._id,
      requestedBy: `member:${membership._id}`,
      actor: user._id,
    });
    return { exportUntil, purgeBy };
  },
});

/**
 * A plan the organization is still paying for: a plan not yet ended whose tier is not `free`
 * (paid, `custom` or without tier, from the older assisted assignment), a plan request awaiting
 * payment, an annual term not yet ended, or a renewing card subscription or open Checkout.
 * Freecorps never closes it on its own.
 */
export async function paidPlanInForce(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const plan = await planFor(ctx, organizationId);
  return !!(
    (plan && plan.catalogTier !== "free" && !planEnded(plan, Date.now())) ||
    (await ctx.db
      .query("platformPlanRequests")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", organizationId).eq("state", "awaiting_payment"),
      )
      .first()) ||
    (await activeTerm(ctx, organizationId, Date.now())) ||
    (await cardBlocksPix(ctx, organizationId))
  );
}

// Companies and probe runs the operator check reads at most; above it the closure is refused.
export const OPERATOR_CLOSURE_LIMIT = 100;

/**
 * Why the operator may not close this organization, or null. Checked: a plan not yet ended whose
 * tier is not `free` (paid, `custom` or without tier, from the older assisted assignment), a
 * platform plan receipt or annual term ever, a plan request awaiting payment, a renewing card
 * subscription or an open Checkout; a production NFS-e probe; and, per company, the issuance
 * gate in production, a capture release ever granted, a Stripe connection in `production`, or a
 * fiscal document, artifact, import, issuance or capture stream in `production`. A company with fiscal history cannot be deleted (`companyHistory`), so the
 * current companies reach every such row.
 */
async function operatorClosureRefusal(ctx: MutationCtx, organizationId: Id<"organizations">) {
  if (
    (await paidPlanInForce(ctx, organizationId)) ||
    (await ctx.db
      .query("platformPlanReceipts")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .first()) ||
    // Any annual term ever paid, ended or not, like a receipt.
    (await ctx.db
      .query("platformPlanTerms")
      .withIndex("by_organizationId_and_state_and_endsAt", (q) =>
        q.eq("organizationId", organizationId),
      )
      .first())
  )
    return "PAID_PLAN";
  const probes = await ctx.db
    .query("issuanceProbeEvents")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .take(OPERATOR_CLOSURE_LIMIT + 1);
  if (probes.some((probe) => probe.environment === "producao")) return "PRODUCTION_DATA";
  const companies = await ctx.db
    .query("companies")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .take(OPERATOR_CLOSURE_LIMIT + 1);
  if (companies.length > OPERATOR_CLOSURE_LIMIT || probes.length > OPERATOR_CLOSURE_LIMIT)
    return "OPERATOR_CLOSURE_LIMIT";
  for (const { _id: companyId } of companies) {
    const [gate, release, ...found] = await Promise.all([
      ctx.db
        .query("issuanceGates")
        .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
        .unique(),
      ctx.db
        .query("captureReleases")
        .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
        .unique(),
      ctx.db
        .query("fiscalDocuments")
        .withIndex("by_companyId_environment_listedAt", (q) =>
          q.eq("companyId", companyId).eq("environment", "production"),
        )
        .first(),
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_companyId_environment_documentId_importedAt", (q) =>
          q.eq("companyId", companyId).eq("environment", "production"),
        )
        .first(),
      ctx.db
        .query("imports")
        .withIndex("by_organizationId_and_companyId_and_environment", (q) =>
          q
            .eq("organizationId", organizationId)
            .eq("companyId", companyId)
            .eq("environment", "production"),
        )
        .first(),
      ctx.db
        .query("issuances")
        .withIndex("by_companyId_and_environment_and_series_and_number", (q) =>
          q.eq("companyId", companyId).eq("environment", "production"),
        )
        .first(),
      ctx.db
        .query("captureStreams")
        .withIndex("by_companyId_environment", (q) =>
          q.eq("companyId", companyId).eq("environment", "production"),
        )
        .first(),
      ctx.db
        .query("stripeConnections")
        .withIndex("by_companyId_and_environment", (q) =>
          q.eq("companyId", companyId).eq("environment", "production"),
        )
        .first(),
    ]);
    if (gate?.production || release?.released || release?.releasedBefore || found.some(Boolean))
      return "PRODUCTION_DATA";
  }
  return null;
}

/**
 * D01 started by Freecorps for an organization nobody can log into (synthetic load-test leftovers,
 * test organizations). Same closure, windows, revocation and purge as `close`. It refuses the
 * organizations `operatorClosureRefusal` names, and only those: it is a safety net against
 * closing the wrong id, not proof that an organization has no customer behind it.
 */
export const closeByOperator = internalMutation({
  args: { organizationId: v.id("organizations"), actor: v.string(), reason: v.string() },
  returns: v.object({ exportUntil: v.number(), purgeBy: v.number() }),
  handler: async (ctx, args) => {
    requirePlatformEnvironment();
    // A GitHub login: the closure row keeps no names or e-mails.
    const { operator, reason } = operatorAndReason({ operator: args.actor, reason: args.reason });
    const organization = await ctx.db.get("organizations", args.organizationId);
    if (!organization) return deny("NOT_FOUND");
    if (await closureOf(ctx, organization._id)) return deny("ORGANIZATION_CLOSED");
    const refusal = await operatorClosureRefusal(ctx, organization._id);
    if (refusal) return deny(refusal);
    // The customer's audit shows Freecorps, not the login (as in the issuance gate).
    const closure = await requestClosure(ctx, {
      organizationId: organization._id,
      requestedBy: `operator:${operator}`,
      actor: FREECORPS_OPERATOR,
    });
    // The reason stays only here and in the issue or PR that asked for it: the organization audit
    // has no free-text field and leaves with the purge; the closure row keeps no free text.
    console.info(
      JSON.stringify({
        type: "organization.closure-by-operator",
        organizationId: organization._id,
        operator,
        reason,
        requestedAt: closure.requestedAt,
      }),
    );
    return { exportUntil: closure.exportUntil, purgeBy: closure.purgeBy };
  },
});

const PAGE = 20;
const revokePhases = ["projects", "companies", "invitations", "monitors"] as const;
/** Durable revocation of the integrations. Idempotent page by page; safe to run again. */
export const revoke = internalMutation({
  args: {
    closureId: v.id("organizationClosures"),
    phase: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const closure = await ctx.db.get("organizationClosures", args.closureId);
    if (!closure || closure.state !== "closing" || closure.revoked) return null;
    const organizationId = closure.organizationId;
    const phase = revokePhases[args.phase];
    const now = Date.now();
    const page = { cursor: args.cursor, numItems: PAGE };
    let result: { isDone: boolean; continueCursor: string };
    if (phase === "projects") {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate(page);
      result = projects;
      for (const project of projects.page) {
        if (project.state === "active")
          await ctx.db.patch("projects", project._id, {
            state: "disabled",
            version: project.version + 1,
            accessEpoch: project.accessEpoch + 1,
          });
        for await (const key of ctx.db
          .query("apiKeys")
          .withIndex("by_projectId", (q) => q.eq("projectId", project._id)))
          if (key.revokedAt === null) await ctx.db.patch("apiKeys", key._id, { revokedAt: now });
      }
    } else if (phase === "companies") {
      const companies = await ctx.db
        .query("companies")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate(page);
      result = companies;
      for (const company of companies.page)
        for await (const endpoint of ctx.db
          .query("webhookEndpoints")
          .withIndex("by_companyId_and_environment", (q) => q.eq("companyId", company._id)))
          if (endpoint.active)
            await ctx.db.patch("webhookEndpoints", endpoint._id, {
              active: false,
              version: endpoint.version + 1,
              updatedAt: now,
            });
      for (const company of companies.page)
        for await (const connection of ctx.db
          .query("stripeConnections")
          .withIndex("by_companyId_and_environment", (q) => q.eq("companyId", company._id)))
          if (connection.active)
            await ctx.db.patch("stripeConnections", connection._id, {
              active: false,
              version: connection.version + 1,
              updatedAt: now,
            });
    } else if (phase === "invitations") {
      const invitations = await ctx.db
        .query("invitations")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate(page);
      result = invitations;
      for (const invitation of invitations.page)
        if (invitation.status === "pending" || invitation.status === "sending")
          await ctx.db.patch("invitations", invitation._id, { status: "revoked", updatedAt: now });
    } else {
      const monitors = await ctx.db
        .query("operationalMonitors")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .paginate(page);
      result = monitors;
      for (const monitor of monitors.page) {
        if (!monitor.enabled) continue;
        if (
          monitor.scheduledId &&
          (await ctx.db.system.get("_scheduled_functions", monitor.scheduledId))?.state.kind ===
            "pending"
        )
          await ctx.scheduler.cancel(monitor.scheduledId);
        await ctx.db.patch("operationalMonitors", monitor._id, {
          enabled: false,
          generation: monitor.generation + 1,
          scheduledId: undefined,
        });
      }
    }
    const next = result.isDone
      ? { phase: args.phase + 1, cursor: null }
      : { phase: args.phase, cursor: result.continueCursor };
    if (next.phase >= revokePhases.length)
      await ctx.db.patch("organizationClosures", closure._id, { revoked: true });
    else
      await ctx.scheduler.runAfter(0, internal.organizationClosure.revoke, {
        closureId: closure._id,
        ...next,
      });
    return null;
  },
});

/**
 * Classes excluded after the window (decision of 07/10): registration, accounts and memberships,
 * credentials, certificates, NFS-e issuing profiles, API keys, webhooks, exports and panel telemetry. Fiscal documents,
 * their files, operations and original audit, usage and billing records and access records
 * stay, under their own retention.
 */
async function purgeBatch(ctx: MutationCtx, organizationId: Id<"organizations">, b: Budget) {
  const { del, drain, all: children, parent, blob } = purger(ctx, b);

  return children(
    () =>
      drain<"documentExports">(
        (n) =>
          ctx.db
            .query("documentExports")
            .withIndex("by_organizationId_and_state", (q) => q.eq("organizationId", organizationId))
            .take(n),
        parent("documentExports", (job) => [
          () =>
            drain<"exportTickets">(
              (n) =>
                ctx.db
                  .query("exportTickets")
                  .withIndex("by_exportId", (q) => q.eq("exportId", job._id))
                  .take(n),
              del("exportTickets"),
            ),
          () =>
            drain<"exportParts">(
              (n) =>
                ctx.db
                  .query("exportParts")
                  .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", job._id))
                  .take(n),
              async (part) => {
                await blob(part.storageId);
                return del("exportParts")(part);
              },
            ),
        ]),
      ),
    () =>
      drain<"assistedExports">(
        (n) =>
          ctx.db
            .query("assistedExports")
            .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("assistedExports"),
      ),
    () =>
      drain<"documentDownloads">(
        (n) =>
          ctx.db
            .query("documentDownloads")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("documentDownloads"),
      ),
    // DANFE PDFs are a cache of the organization: rendered again from the kept original.
    () =>
      drain<"documentDanfes">(
        (n) =>
          ctx.db
            .query("documentDanfes")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        async (row) => {
          // A remembered refusal has no file.
          if (row.storageId) await blob(row.storageId);
          return del("documentDanfes")(row);
        },
      ),
    () =>
      drain<"outboxEvents">(
        (n) =>
          ctx.db
            .query("outboxEvents")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("outboxEvents"),
      ),
    () =>
      drain<"companies">(
        (n) =>
          ctx.db
            .query("companies")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        parent("companies", (company) => [
          () =>
            drain<"webhookEndpoints">(
              (n) =>
                ctx.db
                  .query("webhookEndpoints")
                  .withIndex("by_companyId_and_environment", (q) => q.eq("companyId", company._id))
                  .take(n),
              parent("webhookEndpoints", (endpoint) => [
                () =>
                  drain<"webhookDeliveries">(
                    (n) =>
                      ctx.db
                        .query("webhookDeliveries")
                        .withIndex("by_endpointId", (q) => q.eq("endpointId", endpoint._id))
                        .take(n),
                    parent("webhookDeliveries", (delivery) => [
                      () =>
                        drain<"webhookAttempts">(
                          (n) =>
                            ctx.db
                              .query("webhookAttempts")
                              .withIndex("by_deliveryId", (q) => q.eq("deliveryId", delivery._id))
                              .take(n),
                          del("webhookAttempts"),
                        ),
                    ]),
                  ),
              ]),
            ),
          () =>
            drain<"stripeConnections">(
              (n) =>
                ctx.db
                  .query("stripeConnections")
                  .withIndex("by_companyId_and_environment", (q) => q.eq("companyId", company._id))
                  .take(n),
              parent("stripeConnections", (connection) => [
                () =>
                  drain<"stripeEvents">(
                    (n) =>
                      ctx.db
                        .query("stripeEvents")
                        .withIndex("by_connectionId_and_receivedAt", (q) =>
                          q.eq("connectionId", connection._id),
                        )
                        .take(n),
                    del("stripeEvents"),
                  ),
              ]),
            ),
          () =>
            drain<"companyGrants">(
              (n) =>
                ctx.db
                  .query("companyGrants")
                  .withIndex("by_companyId_and_membershipId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("companyGrants"),
            ),
          () =>
            drain<"companyAudit">(
              (n) =>
                ctx.db
                  .query("companyAudit")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("companyAudit"),
            ),
          () =>
            drain<"registryApplications">(
              (n) =>
                ctx.db
                  .query("registryApplications")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("registryApplications"),
            ),
          () =>
            drain<"certificateHeads">(
              (n) =>
                ctx.db
                  .query("certificateHeads")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("certificateHeads"),
            ),
          () =>
            drain<"nfseProfiles">(
              (n) =>
                ctx.db
                  .query("nfseProfiles")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("nfseProfiles"),
            ),
          () =>
            drain<"issuanceGates">(
              (n) =>
                ctx.db
                  .query("issuanceGates")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("issuanceGates"),
            ),
          () =>
            drain<"captureReleases">(
              (n) =>
                ctx.db
                  .query("captureReleases")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("captureReleases"),
            ),
          () =>
            drain<"captureSupervision">(
              (n) =>
                ctx.db
                  .query("captureSupervision")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("captureSupervision"),
            ),
          () =>
            drain<"captureAlerts">(
              (n) =>
                ctx.db
                  .query("captureAlerts")
                  .withIndex("by_companyId_and_createdAt", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("captureAlerts"),
            ),
          () =>
            drain<"certificates">(
              (n) =>
                ctx.db
                  .query("certificates")
                  .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
                  .take(n),
              del("certificates"),
            ),
        ]),
      ),
    () =>
      drain<"projectCompanies">(
        (n) =>
          ctx.db
            .query("projectCompanies")
            .withIndex("by_organizationId_and_companyId", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("projectCompanies"),
      ),
    () =>
      drain<"projects">(
        (n) =>
          ctx.db
            .query("projects")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        parent("projects", (project) => [
          () =>
            drain<"apiKeys">(
              (n) =>
                ctx.db
                  .query("apiKeys")
                  .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
                  .take(n),
              del("apiKeys"),
            ),
          () =>
            drain<"integrationAudit">(
              (n) =>
                ctx.db
                  .query("integrationAudit")
                  .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
                  .take(n),
              del("integrationAudit"),
            ),
        ]),
      ),
    () =>
      drain<"operationalNotifications">(
        (n) =>
          ctx.db
            .query("operationalNotifications")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("operationalNotifications"),
      ),
    () =>
      drain<"operationalAlerts">(
        (n) =>
          ctx.db
            .query("operationalAlerts")
            .withIndex("by_organizationId_and_state", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("operationalAlerts"),
      ),
    () =>
      drain<"operationalMonitors">(
        (n) =>
          ctx.db
            .query("operationalMonitors")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("operationalMonitors"),
      ),
    () =>
      drain<"operationalFailures">(
        (n) =>
          ctx.db
            .query("operationalFailures")
            .withIndex("by_organizationId_and_expiresAt", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("operationalFailures"),
      ),
    // operationalRetention stays: its sweep still compacts the conserved REST receipts and ends
    // by itself once none is left (telemetryRetention.sweep only re-arms while rows remain).
    () =>
      drain<"operationalAudit">(
        (n) =>
          ctx.db
            .query("operationalAudit")
            .withIndex("by_organizationId_and_createdAt", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("operationalAudit"),
      ),
    () =>
      drain<"usageLeases">(
        (n) =>
          ctx.db
            .query("usageLeases")
            .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("usageLeases"),
      ),
    () =>
      drain<"invitations">(
        (n) =>
          ctx.db
            .query("invitations")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("invitations"),
      ),
    () =>
      drain<"termsOfUseNotices">(
        (n) =>
          ctx.db
            .query("termsOfUseNotices")
            .withIndex("by_organizationId_and_version", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(n),
        del("termsOfUseNotices"),
      ),
    () =>
      drain<"sandboxClosureNotices">(
        (n) =>
          ctx.db
            .query("sandboxClosureNotices")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("sandboxClosureNotices"),
      ),
    () =>
      drain<"registryLookups">(
        (n) =>
          ctx.db
            .query("registryLookups")
            .withIndex("by_organizationId_and_key", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("registryLookups"),
      ),
    () =>
      drain<"onboarding">(
        (n) =>
          ctx.db
            .query("onboarding")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("onboarding"),
      ),
    () =>
      drain<"organizationAudit">(
        (n) =>
          ctx.db
            .query("organizationAudit")
            .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("organizationAudit"),
      ),
    () =>
      drain<"memberships">(
        (n) =>
          ctx.db
            .query("memberships")
            .withIndex("by_organizationId_and_state", (q) => q.eq("organizationId", organizationId))
            .take(n),
        del("memberships"),
      ),
  );
}

export const purge = internalMutation({
  args: { closureId: v.id("organizationClosures"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const closure = await ctx.db.get("organizationClosures", args.closureId);
    if (!closure || closure.generation !== args.generation || closure.state === "purged")
      return null;
    if (Date.now() < closure.exportUntil) {
      await armPurge(ctx, closure._id, closure.generation + 1, closure.exportUntil);
      return null;
    }
    // A run removing the hot rows or rehydrating them would race this purge (ADR 0009, §2): the
    // purge waits until the run leaves `deleting` or `restoring`, and checks again later.
    const run = await archiveStatus(ctx, closure.organizationId);
    if (run?.state === "deleting" || run?.state === "restoring") {
      await armPurge(ctx, closure._id, closure.generation + 1, Date.now() + PURGE_ARCHIVE_WAIT);
      return null;
    }
    // Decided once, before the first batch removes anything (decision of 27/10/2026).
    if (closure.state === "closing" && closure.sandboxOnly === undefined)
      await ctx.db.patch("organizationClosures", closure._id, {
        sandboxOnly: await sandboxOnly(ctx, closure.organizationId),
      });
    const budget = { left: BATCH };
    const done = await purgeBatch(ctx, closure.organizationId, budget);
    const removed = (closure.removed ?? 0) + BATCH - budget.left;
    if (!done) {
      await ctx.db.patch("organizationClosures", closure._id, { state: "purging", removed });
      await armPurge(ctx, closure._id, closure.generation + 1, 0);
      return null;
    }
    const organization = await ctx.db.get("organizations", closure.organizationId);
    if (organization) await ctx.db.delete("organizations", organization._id);
    const purgedAt = Date.now();
    const total = removed + Number(Boolean(organization));
    await ctx.db.patch("organizationClosures", closure._id, {
      state: "purged",
      removed: total,
      purgedAt,
    });
    // The conserved classes now wait for the end of the fiscal guard. Its first check runs at
    // once: an organization that never had Production loses them there (decision of 27/10/2026).
    await armGuard(ctx, (await ctx.db.get("organizationClosures", closure._id))!, purgedAt);
    // Copy this line to the restricted register outside the database: it is the decision a
    // restore must reapply (D05).
    console.info(
      JSON.stringify({
        type: "organization.purged",
        organizationId: closure.organizationId,
        requestedAt: closure.requestedAt,
        exportUntil: closure.exportUntil,
        purgedAt,
        onTime: purgedAt <= closure.purgeBy,
        // The count leaves the database when the fiscal guard ends.
        removed: total,
      }),
    );
    return null;
  },
});

const decision = v.object({
  organizationId: v.id("organizations"),
  state: closureState,
  requestedAt: v.number(),
  exportUntil: v.number(),
  purgeBy: v.number(),
  purgedAt: v.union(v.number(), v.null()),
  removed: v.union(v.number(), v.null()),
  guardUntil: v.number(),
  expiredAt: v.union(v.number(), v.null()),
  decisionUntil: v.union(v.number(), v.null()),
});
/** Operator export of the closure decisions, ids and dates only, for the off-database register. */
export const decisions = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(decision),
  handler: async (ctx, args) => {
    const result = await ctx.db.query("organizationClosures").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((c) => ({
        organizationId: c.organizationId,
        state: c.state,
        requestedAt: c.requestedAt,
        exportUntil: c.exportUntil,
        purgeBy: c.purgeBy,
        purgedAt: c.purgedAt ?? null,
        removed: c.removed ?? null,
        guardUntil: guardOf(c),
        expiredAt: c.expiredAt ?? null,
        decisionUntil: c.decisionUntil ?? null,
      })),
    };
  },
});

/**
 * D05: reapplies a closure decision kept outside the restored snapshot. The original dates are
 * preserved, so an expired window purges at once. Running it again changes nothing.
 */
export const reapply = internalMutation({
  args: { organizationId: v.id("organizations"), requestedAt: v.number() },
  returns: v.union(closureState, v.literal("absent")),
  handler: async (ctx, args) => {
    const closure = await closureOf(ctx, args.organizationId);
    if (closure) {
      // The earlier decision wins; a later local request cannot extend its deadline.
      if (closure.state !== "purged" && closure.requestedAt > args.requestedAt) {
        const exportUntil = args.requestedAt + EXPORT_WINDOW;
        await ctx.db.patch("organizationClosures", closure._id, {
          requestedAt: args.requestedAt,
          exportUntil,
          purgeBy: exportUntil + PURGE_WINDOW,
        });
        await armPurge(ctx, closure._id, closure.generation + 1, exportUntil);
      }
      return closure.state;
    }
    if (!(await ctx.db.get("organizations", args.organizationId))) return "absent";
    await startClosure(ctx, { ...args, requestedBy: "restore" });
    return "closing";
  },
});
