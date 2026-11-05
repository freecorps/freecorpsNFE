import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";
import { sendNoticeMail, STUCK_LIST } from "./archiveNotice";
import { sandboxOnly } from "./fiscalGuard";
import { paidPlanInForce, requestClosure } from "./organizationClosure";
import { ARCHIVE_DAY, archiveGate, lastActivity } from "./lib/coldArchiveCore";
import { archiveNoticeMailState } from "./lib/coldArchiveSchema";
import { FREECORPS_OPERATOR } from "./lib/issuanceGate";
import { closureOf, EXPORT_WINDOW } from "./lib/organizationClosure";
import {
  audit,
  deny,
  limitOrganizationAction,
  requireManager,
  requireMembership,
} from "./lib/organizationAccess";
import { sandboxClosureCancel, sandboxClosureState } from "./lib/sandboxClosureSchema";
import { planFor } from "./lib/usageCore";
import { brasiliaDate } from "./termsOfUseNotice";

/**
 * ADR 0009, decision 2 of 29/10/2026: an open organization that only ever had Sandbox, by the
 * closure's own criterion (`sandboxOnly`), and is idle for 90 days, by the same activity as the
 * Free archive notice, gets a 30-day notice: one e-mail to its active owners and admins and the
 * console notice, where they keep it active. Without that, Freecorps closes it through the usual
 * closure (D01), whose early purge then removes its Sandbox data (`fiscalGuard:early`).
 *
 * Kept out of `coldArchiveRuns` on purpose: the early purge reads any run as Production. As the
 * cold archive, only the deployment administrator creates and closes, behind `FNFE_COLD_ARCHIVE`.
 */

/** Days without activity before the notice, and days of notice before the closure. */
export const SANDBOX_IDLE_DAYS = 90;
export const SANDBOX_NOTICE_DAYS = 30;
/** `requestedBy` of the closures Freecorps starts after the notice. */
export const SANDBOX_CLOSURE_REQUESTER = "freecorps:sandbox-inactive";

type Refusal =
  | "SANDBOX_CLOSURE_NOT_FOUND"
  | "SANDBOX_CLOSURE_CLOSED"
  | "SANDBOX_CLOSURE_PRODUCTION"
  | "SANDBOX_CLOSURE_PAID_PLAN"
  | "SANDBOX_CLOSURE_ACTIVE";

/**
 * Why the organization may not get, or keep, a Sandbox-only closure notice; null when it may.
 * `since` is the instant activity must not pass: 90 days ago for a new notice, the notice itself
 * when closing.
 */
async function refusal(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  since: number,
): Promise<Refusal | null> {
  const organization = await ctx.db.get("organizations", organizationId);
  if (!organization) return "SANDBOX_CLOSURE_NOT_FOUND";
  if (await closureOf(ctx, organizationId)) return "SANDBOX_CLOSURE_CLOSED";
  if (!(await sandboxOnly(ctx, organizationId))) return "SANDBOX_CLOSURE_PRODUCTION";
  // A plan still being paid for is never closed by Freecorps on its own (as `closeByOperator`).
  if (await paidPlanInForce(ctx, organizationId)) return "SANDBOX_CLOSURE_PAID_PLAN";
  const plan = await planFor(ctx, organizationId);
  if ((await lastActivity(ctx, organization, plan)) > since) return "SANDBOX_CLOSURE_ACTIVE";
  return null;
}

const latest = (ctx: Pick<MutationCtx, "db">, organizationId: Id<"organizations">) =>
  ctx.db
    .query("sandboxClosureNotices")
    .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
    .order("desc")
    .first();

/**
 * The notice, by the deployment administrator. Idempotent by `key`: repeating it returns the same
 * notice and sends nothing again. Eligibility is read in the same transaction as the insert.
 */
export const notice = internalMutation({
  args: { organizationId: v.id("organizations"), key: v.string() },
  returns: v.id("sandboxClosureNotices"),
  handler: async (ctx, args) => {
    archiveGate();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.key)) throw new Error("SANDBOX_CLOSURE_INVALID_KEY");
    const same = await ctx.db
      .query("sandboxClosureNotices")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (same) {
      if (same.organizationId !== args.organizationId)
        throw new Error("SANDBOX_CLOSURE_KEY_REUSED");
      return same._id;
    }
    const now = Date.now();
    const refused = await refusal(ctx, args.organizationId, now - SANDBOX_IDLE_DAYS * ARCHIVE_DAY);
    if (refused) throw new Error(refused);
    if ((await latest(ctx, args.organizationId))?.state === "notice")
      throw new Error("SANDBOX_CLOSURE_NOTICE_EXISTS");
    // Told once, written before the send so a repeated notice never sends again. Without the
    // account e-mail channel, the console notice stands alone.
    const { local, accounts } = requirePlatformEnvironment();
    const mail = local || accounts.enabled ? ("pending" as const) : ("skipped" as const);
    const noticeId = await ctx.db.insert("sandboxClosureNotices", {
      organizationId: args.organizationId,
      key: args.key,
      state: "notice",
      version: 1,
      noticeAt: now,
      closeAt: now + SANDBOX_NOTICE_DAYS * ARCHIVE_DAY,
      updatedAt: now,
      noticeMail: { state: mail, recipients: 0, confirmed: 0, withheld: 0 },
    });
    if (mail === "pending")
      await ctx.scheduler.runAfter(0, internal.sandboxClosure.deliver, { noticeId });
    return noticeId;
  },
});

/** Ends the notice without a closure: anything that showed the organization is in use. */
async function cancel(
  ctx: MutationCtx,
  notice: Doc<"sandboxClosureNotices">,
  reason: "activity" | "production" | "paid_plan" | "organization_closed",
) {
  const now = Date.now();
  await ctx.db.patch("sandboxClosureNotices", notice._id, {
    state: "cancelled",
    version: notice.version + 1,
    cancelled: { reason, at: now },
    updatedAt: now,
  });
}

const cancelReason = {
  SANDBOX_CLOSURE_NOT_FOUND: "organization_closed",
  SANDBOX_CLOSURE_CLOSED: "organization_closed",
  SANDBOX_CLOSURE_PRODUCTION: "production",
  SANDBOX_CLOSURE_PAID_PLAN: "paid_plan",
  SANDBOX_CLOSURE_ACTIVE: "activity",
} as const;

/**
 * The closure, by the deployment administrator, once `closeAt` passed. Rechecks everything in the
 * same transaction: still only Sandbox, no plan being paid, no closure yet and no activity since
 * the notice ("Manter ativa" counts). Otherwise the notice ends `cancelled` and nothing closes.
 * Repeating it after the notice ended changes nothing and returns how it ended.
 */
export const close = internalMutation({
  args: { noticeId: v.id("sandboxClosureNotices"), version: v.number() },
  returns: v.object({
    state: sandboxClosureState,
    cancelled: v.optional(sandboxClosureCancel),
    closureId: v.optional(v.id("organizationClosures")),
  }),
  handler: async (ctx, args) => {
    archiveGate();
    const notice = await ctx.db.get("sandboxClosureNotices", args.noticeId);
    if (!notice) throw new Error("SANDBOX_CLOSURE_NOTICE_NOT_FOUND");
    const ended = (row: Doc<"sandboxClosureNotices">) => ({
      state: row.state,
      ...(row.cancelled ? { cancelled: row.cancelled.reason } : {}),
      ...(row.closureId ? { closureId: row.closureId } : {}),
    });
    if (notice.state !== "notice") return ended(notice);
    if (notice.version !== args.version) throw new Error("SANDBOX_CLOSURE_STALE_FENCE");
    if (Date.now() < notice.closeAt) throw new Error("SANDBOX_CLOSURE_NOTICE_PENDING");
    const refused = await refusal(ctx, notice.organizationId, notice.noticeAt);
    if (refused) {
      await cancel(ctx, notice, cancelReason[refused]);
      return ended((await ctx.db.get("sandboxClosureNotices", notice._id))!);
    }
    // The same closure as the owner's, requested by Freecorps: the customer's audit shows
    // Freecorps; the closure row says why.
    const closure = await requestClosure(ctx, {
      organizationId: notice.organizationId,
      requestedBy: SANDBOX_CLOSURE_REQUESTER,
      actor: FREECORPS_OPERATOR,
    });
    await ctx.db.patch("sandboxClosureNotices", notice._id, {
      state: "closed",
      version: notice.version + 1,
      closureId: closure.closureId,
      updatedAt: Date.now(),
    });
    console.info(
      JSON.stringify({
        type: "organization.closure-sandbox-inactive",
        organizationId: notice.organizationId,
        noticeId: notice._id,
        requestedAt: closure.requestedAt,
      }),
    );
    return { state: "closed" as const, closureId: closure.closureId };
  },
});

/** The operator's list of notices whose `closeAt` passed before `before`, up to `STUCK_LIST`. */
export const due = internalQuery({
  args: { before: v.number() },
  returns: v.array(
    v.object({
      noticeId: v.id("sandboxClosureNotices"),
      organizationId: v.id("organizations"),
      version: v.number(),
      closeAt: v.number(),
    }),
  ),
  handler: async (ctx, { before }) =>
    (
      await ctx.db
        .query("sandboxClosureNotices")
        .withIndex("by_state_and_closeAt", (q) => q.eq("state", "notice").lt("closeAt", before))
        .take(STUCK_LIST)
    ).map((row) => ({
      noticeId: row._id,
      organizationId: row.organizationId,
      version: row.version,
      closeAt: row.closeAt,
    })),
});

/**
 * The Sandbox-only closure notice of an organization, for any active member: `null` without a
 * pending one. `canAct` tells owners and admins, who keep it active.
 */
export const status = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.null(),
    v.object({
      noticeId: v.id("sandboxClosureNotices"),
      closeAt: v.number(),
      canAct: v.boolean(),
    }),
  ),
  handler: async (ctx, { organizationId }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    const notice = await ctx.db
      .query("sandboxClosureNotices")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .order("desc")
      .first();
    if (notice?.state !== "notice") return null;
    return {
      noticeId: notice._id,
      closeAt: notice.closeAt,
      canAct: membership.role === "owner" || membership.role === "admin",
    };
  },
});

/**
 * "Manter ativa": an owner or admin ends the pending notice. It counts as activity, so the 90 days
 * start over. `noticeId` is the notice the person saw: repeating it after it ended changes nothing.
 */
export const keepActive = mutation({
  args: { organizationId: v.id("organizations"), noticeId: v.id("sandboxClosureNotices") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, membership, organization } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    const notice = await ctx.db.get("sandboxClosureNotices", args.noticeId);
    if (!notice || notice.organizationId !== args.organizationId)
      return deny("SANDBOX_CLOSURE_NOTICE_NOT_FOUND");
    if (notice.state !== "notice") return null;
    await limitOrganizationAction(ctx, "sandbox-keep-active", args.organizationId);
    const now = Date.now();
    await ctx.db.patch("sandboxClosureNotices", notice._id, {
      state: "kept_active",
      version: notice.version + 1,
      keptActiveAt: now,
      updatedAt: now,
    });
    await ctx.db.patch("organizations", organization._id, { updatedAt: now });
    await audit(ctx, {
      organizationId: args.organizationId,
      actorUserId: user._id,
      action: "organization.kept-active",
      target: notice._id,
    });
    return null;
  },
});

/**
 * Claims the notice's single send and returns what the message needs. A notice that already
 * ended, or an organization gone or closed, ends it as `skipped`. Only one claim succeeds.
 */
export const claim = internalMutation({
  args: { noticeId: v.id("sandboxClosureNotices") },
  returns: v.union(
    v.null(),
    v.object({
      organizationId: v.id("organizations"),
      organization: v.string(),
      slug: v.string(),
      closeAt: v.number(),
    }),
  ),
  handler: async (ctx, { noticeId }) => {
    const notice = await ctx.db.get("sandboxClosureNotices", noticeId);
    if (notice?.noticeMail.state !== "pending") return null;
    const organization = await ctx.db.get("organizations", notice.organizationId);
    if (
      notice.state !== "notice" ||
      !organization ||
      (await closureOf(ctx, notice.organizationId))
    ) {
      await ctx.db.patch("sandboxClosureNotices", noticeId, {
        noticeMail: { ...notice.noticeMail, state: "skipped", finishedAt: Date.now() },
      });
      return null;
    }
    await ctx.db.patch("sandboxClosureNotices", noticeId, {
      noticeMail: { ...notice.noticeMail, state: "sending", claimedAt: Date.now() },
    });
    return {
      organizationId: notice.organizationId,
      organization: organization.name,
      slug: organization.slug,
      closeAt: notice.closeAt,
    };
  },
});

/** Ends a claimed send with its outcome; a late or repeated call changes nothing. */
export const finish = internalMutation({
  args: {
    noticeId: v.id("sandboxClosureNotices"),
    state: archiveNoticeMailState,
    recipients: v.number(),
    confirmed: v.number(),
    withheld: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { noticeId, ...result }) => {
    const notice = await ctx.db.get("sandboxClosureNotices", noticeId);
    if (notice?.noticeMail.state !== "sending") return null;
    await ctx.db.patch("sandboxClosureNotices", noticeId, {
      noticeMail: { ...notice.noticeMail, ...result, finishedAt: Date.now() },
    });
    return null;
  },
});

/** The one send of a notice, by the channel and rules of the archive notice. Never resent. */
export const deliver = internalAction({
  args: { noticeId: v.id("sandboxClosureNotices") },
  returns: v.null(),
  handler: async (ctx, { noticeId }) => {
    const claimed = await ctx.runMutation(internal.sandboxClosure.claim, { noticeId });
    if (!claimed) return null;
    const outcome = await sendNoticeMail(ctx, {
      organizationId: claimed.organizationId,
      type: "sandbox-closure-notice",
      otp: noticeId,
      message: (siteUrl) => sandboxClosureMail({ ...claimed, siteUrl }),
    });
    if (outcome.state !== "sent" && outcome.state !== "skipped")
      console.warn(
        JSON.stringify({
          type: "sandbox_closure_notice_delivery",
          noticeId,
          state: outcome.state,
          recipients: outcome.recipients,
          confirmed: outcome.confirmed,
        }),
      );
    await ctx.runMutation(internal.sandboxClosure.finish, { noticeId, ...outcome });
    return null;
  },
});

/**
 * The operator's view of notice e-mails without an outcome, as `archiveNotice:mailStatus`: up to
 * `STUCK_LIST` notices per mail state, `pending` and `sending`, created before `before`.
 */
export const mailStatus = internalQuery({
  args: { before: v.number() },
  returns: v.array(
    v.object({
      noticeId: v.id("sandboxClosureNotices"),
      organizationId: v.id("organizations"),
      mail: v.union(v.literal("pending"), v.literal("sending")),
      state: sandboxClosureState,
      noticeAt: v.number(),
      claimedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { before }) => {
    const stuck = [];
    for (const mail of ["pending", "sending"] as const)
      for (const notice of await ctx.db
        .query("sandboxClosureNotices")
        .withIndex("by_noticeMail_state_and_noticeAt", (q) =>
          q.eq("noticeMail.state", mail).lt("noticeAt", before),
        )
        .take(STUCK_LIST))
        stuck.push({
          noticeId: notice._id,
          organizationId: notice.organizationId,
          mail,
          state: notice.state,
          noticeAt: notice.noticeAt,
          ...(notice.noticeMail.claimedAt === undefined
            ? {}
            : { claimedAt: notice.noticeMail.claimedAt }),
        });
    return stuck;
  },
});

/**
 * Schedules again the send of notices still `pending` created more than `olderThanMinutes` ago,
 * as `archiveNotice:resumePending`: only one claim succeeds, and `sending` is never resumed.
 */
export const resumePending = internalMutation({
  args: { olderThanMinutes: v.optional(v.number()) },
  returns: v.object({ resumed: v.number() }),
  handler: async (ctx, { olderThanMinutes = 60 }) => {
    const notices = await ctx.db
      .query("sandboxClosureNotices")
      .withIndex("by_noticeMail_state_and_noticeAt", (q) =>
        q.eq("noticeMail.state", "pending").lt("noticeAt", Date.now() - olderThanMinutes * 60_000),
      )
      .take(STUCK_LIST);
    for (const notice of notices)
      await ctx.scheduler.runAfter(0, internal.sandboxClosure.deliver, { noticeId: notice._id });
    return { resumed: notices.length };
  },
});

/**
 * The notice: which organization, from when Freecorps may close it, why, what is deleted and the
 * one action that avoids it. Plain text; the organization's name only says which one it concerns.
 */
export function sandboxClosureMail(notice: {
  organization: string;
  slug: string;
  closeAt: number;
  siteUrl: string;
}) {
  const date = brasiliaDate(notice.closeAt);
  const link = `${new URL(notice.siteUrl).origin}/app/${encodeURIComponent(notice.slug)}`;
  const exportDays = EXPORT_WINDOW / ARCHIVE_DAY;
  return {
    subject: `A organização ${notice.organization} será encerrada a partir de ${date}`,
    text: [
      `A organização ${notice.organization} não tem documento com validade fiscal e está há ${SANDBOX_IDLE_DAYS} dias sem atividade na Freecorps Fiscal. A partir de ${date}, a Freecorps vai encerrá-la.`,
      "",
      `Depois do encerramento, a exportação fica disponível por ${exportDays} dias; em seguida, a organização e os dados dela são apagados. A conta de cada pessoa continua.`,
      "",
      `Para manter a organização ativa, um proprietário ou administrador escolhe "Manter ativa" no aviso do console: ${link}`,
      "",
      "Você recebe este e-mail por ser proprietário ou administrador da organização.",
    ].join("\n"),
  };
}
