import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";
import { accountSenderName, sendAccountMail } from "./lib/accountMail";
import { archiveStatus, endArchiveNotice, FISCAL_READ_WINDOW } from "./lib/coldArchiveCore";
import { archiveNoticeMailState, archiveState } from "./lib/coldArchiveSchema";
import {
  audit,
  deny,
  limitOrganizationAction,
  requireManager,
  requireMembership,
} from "./lib/organizationAccess";
import { brasiliaDate } from "./termsOfUseNotice";

/**
 * The console's side of the cold custody of open organizations (ADR 0009, §1): the notice every
 * member sees, "Manter ativa" for owners and admins on Free, and the one e-mail of each notice.
 * The notice itself is created only by the deployment administrator (`coldArchive:notice`); an
 * open organization stops there until the rehydration under new IDs exists.
 */

/** Owners or admins read per page while gathering the recipients of one notice. */
const RECIPIENT_PAGE = 100;
/** Messages handed to the provider at once, one per recipient, each with its own timeout. */
const SEND_CONCURRENCY = 10;
/** Runs listed per state by `mailStatus`, and resumed per call of `resumePending`. */
export const STUCK_LIST = 100;

const openReason = v.union(v.literal("free_inactive"), v.literal("paid_expired"));

/**
 * The archive standing of an open organization, for any active member: `null` while it is hot.
 * `canAct` tells owners and admins, who keep it active (Free) or renew (paid).
 */
export const status = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.null(),
    v.object({
      runId: v.id("coldArchiveRuns"),
      state: archiveState,
      reason: openReason,
      eligibleAt: v.number(),
      /** When the archive was proven and the hot copy started to go; only once `archived`. */
      archivedAt: v.union(v.number(), v.null()),
      canAct: v.boolean(),
    }),
  ),
  handler: async (ctx, { organizationId }) => {
    const { membership } = await requireMembership(ctx, organizationId, { archived: "allowed" });
    const run = await archiveStatus(ctx, organizationId);
    if (!run || run.state === "hot" || run.reason === "closed") return null;
    return {
      runId: run._id,
      state: run.state,
      reason: run.reason,
      eligibleAt: run.eligibleAt,
      archivedAt: run.state === "archived" ? (run.verifiedAt ?? run.updatedAt) : null,
      canAct: membership.role === "owner" || membership.role === "admin",
    };
  },
});

/**
 * "Manter ativa": an owner or admin of a Free organization ends its pending notice. It counts as
 * activity, so the 90 days start over. `runId` is the notice the person saw: repeating it after
 * the notice ended changes nothing. A paid notice ends only by renewing the plan.
 */
export const keepActive = mutation({
  args: { organizationId: v.id("organizations"), runId: v.id("coldArchiveRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, membership, organization } = await requireMembership(ctx, args.organizationId, {
      archived: "allowed",
    });
    requireManager(membership);
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    if (!run || run.organizationId !== args.organizationId || run.reason === "closed")
      return deny("ARCHIVE_NOTICE_NOT_FOUND");
    if (run.state === "hot") return null;
    if (run.state === "archived") return deny("ORGANIZATION_ARCHIVED");
    if (run.state !== "notice") return deny("ORGANIZATION_ARCHIVING");
    if (run.reason !== "free_inactive") return deny("PLAN_RENEWAL_REQUIRED");
    await limitOrganizationAction(ctx, "archive-keep-active", args.organizationId);
    await endArchiveNotice(ctx, args.organizationId, "keep_active");
    await ctx.db.patch("organizations", organization._id, { updatedAt: Date.now() });
    await audit(ctx, {
      organizationId: args.organizationId,
      actorUserId: user._id,
      action: "organization.kept-active",
      target: run._id,
    });
    return null;
  },
});

/**
 * A read of fiscal data in the console (the list or the detail of a document or of an issuance)
 * counts as activity of an open organization (ADR 0009, §1; #641). The console's queries cannot
 * write, so the console calls this once the read arrives. Any active member counts, whatever the
 * role. The mark is `organizations.updatedAt`, the one "Manter ativa" moves and `lastActivity`
 * reads, written at most once per organization per `FISCAL_READ_WINDOW`: a recent mark makes the
 * call a read, so simultaneous readers do not contend on the organization. During the notice the
 * mark does not end it, but the freeze, which evaluates eligibility again, refuses. In custody the
 * fiscal reads are refused, and so is this.
 */
export const markFiscalRead = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { organization } = await requireMembership(ctx, args.organizationId);
    const now = Date.now();
    if (organization.updatedAt + FISCAL_READ_WINDOW > now) return null;
    await ctx.db.patch("organizations", organization._id, { updatedAt: now });
    return null;
  },
});

/**
 * Claims the notice's single send and returns what the message needs. A notice that already
 * ended, or an organization gone, ends it as `skipped`. Only one claim succeeds.
 */
export const claim = internalMutation({
  args: { runId: v.id("coldArchiveRuns") },
  returns: v.union(
    v.null(),
    v.object({
      organizationId: v.id("organizations"),
      organization: v.string(),
      slug: v.string(),
      reason: openReason,
      eligibleAt: v.number(),
    }),
  ),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get("coldArchiveRuns", runId);
    if (!run?.noticeMail || run.noticeMail.state !== "pending") return null;
    const organization = await ctx.db.get("organizations", run.organizationId);
    if (run.state !== "notice" || run.reason === "closed" || !organization) {
      await ctx.db.patch("coldArchiveRuns", runId, {
        noticeMail: { ...run.noticeMail, state: "skipped", finishedAt: Date.now() },
      });
      return null;
    }
    await ctx.db.patch("coldArchiveRuns", runId, {
      noticeMail: { ...run.noticeMail, state: "sending", claimedAt: Date.now() },
    });
    return {
      organizationId: run.organizationId,
      organization: organization.name,
      slug: organization.slug,
      reason: run.reason,
      eligibleAt: run.eligibleAt,
    };
  },
});

/** Ends a claimed send with its outcome; a late or repeated call changes nothing. */
export const finish = internalMutation({
  args: {
    runId: v.id("coldArchiveRuns"),
    state: archiveNoticeMailState,
    recipients: v.number(),
    confirmed: v.number(),
    withheld: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { runId, ...result }) => {
    const run = await ctx.db.get("coldArchiveRuns", runId);
    if (run?.noticeMail?.state !== "sending") return null;
    await ctx.db.patch("coldArchiveRuns", runId, {
      noticeMail: { ...run.noticeMail, ...result, finishedAt: Date.now() },
    });
    return null;
  },
});

/**
 * The one send of a notice, as the notice of the terms of use: one message per active owner or
 * admin, through the account e-mail channel. `sent` when the provider accepted every message,
 * `partial` when only some, `unconfirmed` when none; none is sent again.
 */
export const deliver = internalAction({
  args: { runId: v.id("coldArchiveRuns") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const claimed = await ctx.runMutation(internal.archiveNotice.claim, { runId });
    if (!claimed) return null;
    const outcome = await sendNoticeMail(ctx, {
      organizationId: claimed.organizationId,
      type: "archive-notice",
      otp: runId,
      message: (siteUrl) => archiveNoticeMail({ ...claimed, siteUrl }),
    });
    if (outcome.state !== "sent" && outcome.state !== "skipped")
      console.warn(
        JSON.stringify({
          type: "archive_notice_delivery",
          runId,
          state: outcome.state,
          recipients: outcome.recipients,
          confirmed: outcome.confirmed,
        }),
      );
    await ctx.runMutation(internal.archiveNotice.finish, { runId, ...outcome });
    return null;
  },
});

/**
 * The single send of a notice about one organization, as the notice of the terms of use: one
 * message per active owner or admin, through the account e-mail channel, never logging an
 * address or the provider's response. `skipped` when the channel is off or nobody may receive it,
 * `sent` when the provider accepted every message, `partial` when only some, `unconfirmed` when
 * none. The caller claimed the notice before and records the outcome after; nothing is retried.
 */
export async function sendNoticeMail(
  ctx: ActionCtx,
  notice: {
    organizationId: Id<"organizations">;
    type: "archive-notice" | "sandbox-closure-notice";
    /** Identifies the notice in the development mailbox. */
    otp: string;
    message: (siteUrl: string) => { subject: string; text: string };
  },
): Promise<{
  state: Infer<typeof archiveNoticeMailState>;
  recipients: number;
  confirmed: number;
  withheld: number;
}> {
  const { local, accounts, siteUrl } = requirePlatformEnvironment();
  // Account e-mail turned off since the notice: nothing goes out; the console notice stands.
  if (!local && !accounts.enabled)
    return { state: "skipped", recipients: 0, confirmed: 0, withheld: 0 };
  const found = new Set<string>();
  for (const role of ["owner", "admin"] as const) {
    let cursor: string | null = null;
    for (;;) {
      const page: { emails: string[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.termsOfUseNotice.recipients, {
          organizationId: notice.organizationId,
          role,
          paginationOpts: { cursor, numItems: RECIPIENT_PAGE },
        });
      for (const email of page.emails) found.add(email);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  // Outside development, the channel only reaches its authorized recipients, unless the
  // installation lifted the allowlist (`ACCOUNT_EMAIL_RECIPIENTS=*`).
  const allowed =
    local || accounts.allowedRecipients === "any" ? null : new Set(accounts.recipients);
  const to = [...found].filter((email) => !allowed || allowed.has(email));
  const withheld = found.size - to.length;
  if (to.length === 0) return { state: "skipped", recipients: 0, confirmed: 0, withheld };
  const message = notice.message(siteUrl);
  let confirmed = 0;
  for (let index = 0; index < to.length; index += SEND_CONCURRENCY) {
    const sends = await Promise.allSettled(
      to
        .slice(index, index + SEND_CONCURRENCY)
        .map((email) =>
          local
            ? ctx.runMutation(internal.mail.capture, { email, otp: notice.otp, type: notice.type })
            : sendAccountMail(accounts, { name: accountSenderName(), to: [email], ...message }),
        ),
    );
    confirmed += sends.filter((send) => send.status === "fulfilled").length;
  }
  const state = confirmed === to.length ? "sent" : confirmed === 0 ? "unconfirmed" : "partial";
  return { state, recipients: to.length, confirmed, withheld };
}

/**
 * The operator's view of notice e-mails without an outcome (runbook in `arquivo-economico.md`):
 * up to `STUCK_LIST` runs per state, `pending` and `sending`, whose notice was created before
 * `before`, an instant the operator passes. `pending`: its `deliver` never claimed it, so nothing
 * went out. `sending`: claimed, without `finish`; the messages may have gone out.
 */
export const mailStatus = internalQuery({
  args: { before: v.number() },
  returns: v.array(
    v.object({
      runId: v.id("coldArchiveRuns"),
      organizationId: v.id("organizations"),
      mail: v.union(v.literal("pending"), v.literal("sending")),
      state: archiveState,
      noticeAt: v.number(),
      claimedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { before }) => {
    const stuck = [];
    for (const mail of ["pending", "sending"] as const)
      for (const run of await ctx.db
        .query("coldArchiveRuns")
        .withIndex("by_noticeMail_state_and_noticeAt", (q) =>
          q.eq("noticeMail.state", mail).lt("noticeAt", before),
        )
        .take(STUCK_LIST))
        stuck.push({
          runId: run._id,
          organizationId: run.organizationId,
          mail,
          state: run.state,
          noticeAt: run.noticeAt,
          ...(run.noticeMail?.claimedAt === undefined
            ? {}
            : { claimedAt: run.noticeMail.claimedAt }),
        });
    return stuck;
  },
});

/**
 * Schedules again the send of notices still `pending` whose notice was created more than
 * `olderThanMinutes` ago: their `deliver` was lost before the claim. Safe to repeat and to race the
 * original `deliver`, since only one claim succeeds; a notice that ended in between is claimed as
 * `skipped`. Up to `STUCK_LIST` runs per call; the operator calls again while `resumed` is not
 * zero. `sending` is never resumed: its messages may have gone out.
 */
export const resumePending = internalMutation({
  args: { olderThanMinutes: v.optional(v.number()) },
  returns: v.object({ resumed: v.number() }),
  handler: async (ctx, { olderThanMinutes = 60 }) => {
    const runs = await ctx.db
      .query("coldArchiveRuns")
      .withIndex("by_noticeMail_state_and_noticeAt", (q) =>
        q.eq("noticeMail.state", "pending").lt("noticeAt", Date.now() - olderThanMinutes * 60_000),
      )
      .take(STUCK_LIST);
    for (const run of runs)
      await ctx.scheduler.runAfter(0, internal.archiveNotice.deliver, { runId: run._id });
    return { resumed: runs.length };
  },
});

/**
 * The notice: which organization, from when it may be archived, what archiving does and the one
 * action that avoids it. Plain text; the organization's name only says which one it concerns.
 */
export function archiveNoticeMail(notice: {
  organization: string;
  slug: string;
  reason: "free_inactive" | "paid_expired";
  eligibleAt: number;
  siteUrl: string;
}) {
  const date = brasiliaDate(notice.eligibleAt);
  const free = notice.reason === "free_inactive";
  const origin = new URL(notice.siteUrl).origin;
  const link = `${origin}/app/${encodeURIComponent(notice.slug)}${free ? "" : "/usage"}`;
  return {
    subject: `A organização ${notice.organization} pode ser arquivada a partir de ${date}`,
    text: [
      free
        ? `A organização ${notice.organization}, no plano Gratuito, está há 90 dias sem atividade na Freecorps Fiscal. A partir de ${date}, ela pode ser arquivada.`
        : `O período pago do plano da organização ${notice.organization} terminou sem renovação. A partir de ${date}, ela pode ser arquivada.`,
      "",
      "No arquivamento, param as importações, as capturas e a emissão de notas, e os dados fiscais vão para uma guarda fria cifrada, pelo mesmo prazo de guarda. A consulta passa a ser por exportação assistida, pelo suporte. A organização pode ser reativada, mas não na hora.",
      "",
      "Enquanto a organização estiver arquivada, a captura de NF-e fica parada. A Receita só disponibiliza os documentos por tempo limitado, então alguns podem não estar mais lá quando a organização voltar.",
      "",
      free
        ? `Para manter a organização ativa, um proprietário ou administrador escolhe "Manter ativa" no aviso do console: ${link}`
        : `Para manter a organização ativa, um proprietário ou administrador renova o plano em Uso e limites, na seção Cobrança: ${link}`,
      "",
      "Você recebe este e-mail por ser proprietário ou administrador da organização.",
    ].join("\n"),
  };
}
