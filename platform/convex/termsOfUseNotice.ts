import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";
import { sendCloudflareMail } from "./lib/accountMail";
import { closureOf } from "./lib/organizationClosure";
import { currentTermsOfUse, termsOfUseAcceptance } from "./lib/termsOfUse";

/**
 * The e-mail notice of a new version of the terms of use (#594), promised by section 11: once per
 * open organization that has not accepted the version, to its active owners and admins, through the
 * account e-mail channel (`ACCOUNT-EMAIL.md`). `start` runs after each publication of every profile
 * that holds organizations (hosted sandbox, NFS-e fiscal production, validation and self-host) and
 * does nothing while no version is current, while account e-mail is disabled or once the sweep of
 * the current version is done.
 *
 * The sweep visits the organizations in batches (`batch`), each one scheduling one `notify` per
 * organization. `notify` writes the organization's row before anything is sent, inside the index
 * by organization and version, so a retried batch, a second chain or a new deploy finds it and
 * sends nothing. The send itself is the account channel's, one message per recipient: no automatic
 * retry, and a timeout or a refusal is counted as unconfirmed, never sent again; the console
 * notice still holds. Outside local development only the addresses in `ACCOUNT_EMAIL_RECIPIENTS`
 * get mail, unless the installation sets it to `*`: the others are counted in the row's `withheld` and never get this version's notice,
 * not even once the allowlist is lifted, since the row is final. `status` lists those rows and,
 * with `resumePending`, is the operator's (`ORGANIZATIONS.md`).
 */

/** Organizations visited per batch: one read each, and one scheduled `notify` per organization. */
export const NOTICE_BATCH = 100;
/** Owners or admins read per page while gathering the recipients of one notice. */
const RECIPIENT_PAGE = 100;
/** Messages handed to the provider at once, one per recipient, each with its own timeout. */
const SEND_CONCURRENCY = 10;
/** Rows counted per state, and rows with withheld recipients, by `status`. */
const STATUS_SCAN = 1000;
/**
 * Rows listed per state, and rows with withheld recipients listed, by `status`; rows resumed per
 * call of `resumePending`.
 */
export const STUCK_LIST = 100;

const startOutcome = v.union(
  v.literal("none"),
  v.literal("disabled"),
  v.literal("started"),
  v.literal("resumed"),
  v.literal("done"),
);

/**
 * Starts, or resumes from its cursor, the sweep of the current version. Idempotent: a finished
 * sweep is never run again, and a resumed one fences the previous chain by its generation.
 */
export const start = internalMutation({
  args: {},
  returns: v.object({ version: v.union(v.string(), v.null()), outcome: startOutcome }),
  handler: async (ctx) => {
    const terms = currentTermsOfUse();
    if (!terms) return { version: null, outcome: "none" as const };
    const { local, accounts } = requirePlatformEnvironment();
    // Without a channel nothing is recorded, so enabling it and publishing again sends.
    if (!local && !accounts.enabled)
      return { version: terms.version, outcome: "disabled" as const };
    const run = await ctx.db
      .query("termsOfUseNoticeRuns")
      .withIndex("by_version", (q) => q.eq("version", terms.version))
      .unique();
    if (run?.state === "done") return { version: terms.version, outcome: "done" as const };
    let generation = 1;
    if (run) {
      generation = run.generation + 1;
      await ctx.db.patch("termsOfUseNoticeRuns", run._id, { generation });
    } else
      await ctx.db.insert("termsOfUseNoticeRuns", {
        version: terms.version,
        generation,
        cursor: null,
        state: "running",
        organizations: 0,
        startedAt: Date.now(),
      });
    await ctx.scheduler.runAfter(0, internal.termsOfUseNotice.batch, {
      version: terms.version,
      generation,
    });
    return { version: terms.version, outcome: run ? ("resumed" as const) : ("started" as const) };
  },
});

/** One page of organizations: schedules their `notify` and the next page, in one transaction. */
export const batch = internalMutation({
  args: { version: v.string(), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, { version, generation }) => {
    const run = await ctx.db
      .query("termsOfUseNoticeRuns")
      .withIndex("by_version", (q) => q.eq("version", version))
      .unique();
    if (!run || run.state === "done" || run.generation !== generation) return null;
    // A newer version replaced this one: its own sweep notifies.
    if (currentTermsOfUse()?.version !== version) {
      await ctx.db.patch("termsOfUseNoticeRuns", run._id, {
        state: "done",
        finishedAt: Date.now(),
      });
      return null;
    }
    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: run.cursor, numItems: NOTICE_BATCH });
    for (const organization of page.page)
      await ctx.scheduler.runAfter(0, internal.termsOfUseNotice.notify, {
        organizationId: organization._id,
        version,
      });
    await ctx.db.patch("termsOfUseNoticeRuns", run._id, {
      cursor: page.continueCursor,
      organizations: run.organizations + page.page.length,
      ...(page.isDone ? { state: "done" as const, finishedAt: Date.now() } : {}),
    });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.termsOfUseNotice.batch, { version, generation });
    return null;
  },
});

/** Whether the organization still gets the notice of `version`: open and not accepted. */
async function eligible(ctx: MutationCtx, organizationId: Id<"organizations">, version: string) {
  if (currentTermsOfUse()?.version !== version) return false;
  if (!(await ctx.db.get("organizations", organizationId))) return false;
  if (await closureOf(ctx, organizationId)) return false;
  return (await termsOfUseAcceptance(ctx, organizationId))?.version !== version;
}

/** Records the organization's notice, once per version, and schedules its send. */
export const notify = internalMutation({
  args: { organizationId: v.id("organizations"), version: v.string() },
  returns: v.null(),
  handler: async (ctx, { organizationId, version }) => {
    const existing = await ctx.db
      .query("termsOfUseNotices")
      .withIndex("by_organizationId_and_version", (q) =>
        q.eq("organizationId", organizationId).eq("version", version),
      )
      .unique();
    if (existing || !(await eligible(ctx, organizationId, version))) return null;
    const noticeId = await ctx.db.insert("termsOfUseNotices", {
      organizationId,
      version,
      state: "pending",
      recipients: 0,
      confirmed: 0,
      withheld: 0,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.termsOfUseNotice.deliver, { noticeId });
    return null;
  },
});

/**
 * Claims a pending notice for its single send and returns what the message needs. A closure or an
 * acceptance in between ends it as `skipped`. Only one claim of a row succeeds, so a resumed
 * `deliver` racing the original one never sends twice.
 */
export const claim = internalMutation({
  args: { noticeId: v.id("termsOfUseNotices") },
  returns: v.union(
    v.null(),
    v.object({
      organizationId: v.id("organizations"),
      organization: v.string(),
      version: v.string(),
    }),
  ),
  handler: async (ctx, { noticeId }) => {
    const notice = await ctx.db.get("termsOfUseNotices", noticeId);
    if (notice?.state !== "pending") return null;
    const organization = await ctx.db.get("organizations", notice.organizationId);
    if (!organization || !(await eligible(ctx, notice.organizationId, notice.version))) {
      await ctx.db.patch("termsOfUseNotices", noticeId, {
        state: "skipped",
        finishedAt: Date.now(),
      });
      return null;
    }
    await ctx.db.patch("termsOfUseNotices", noticeId, { state: "sending", claimedAt: Date.now() });
    return {
      organizationId: notice.organizationId,
      organization: organization.name,
      version: notice.version,
    };
  },
});

/**
 * One page of the organization's active members with one role, read by the index on the role:
 * every owner and admin is found however many other members the organization has.
 */
export const recipients = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    role: v.union(v.literal("owner"), v.literal("admin")),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    emails: v.array(v.string()),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { organizationId, role, paginationOpts }) => {
    const page = await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state_and_role", (q) =>
        q.eq("organizationId", organizationId).eq("state", "active").eq("role", role),
      )
      .paginate(paginationOpts);
    return {
      emails: page.page.map((member) => member.email.trim().toLowerCase()),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

const outcome = v.union(
  v.literal("sent"),
  v.literal("partial"),
  v.literal("unconfirmed"),
  v.literal("skipped"),
);

/** Ends a claimed send with its outcome; a late or repeated call changes nothing. */
export const finish = internalMutation({
  args: {
    noticeId: v.id("termsOfUseNotices"),
    state: outcome,
    recipients: v.number(),
    confirmed: v.number(),
    withheld: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, { noticeId, ...result }) => {
    const notice = await ctx.db.get("termsOfUseNotices", noticeId);
    if (notice?.state !== "sending") return null;
    await ctx.db.patch("termsOfUseNotices", noticeId, { ...result, finishedAt: Date.now() });
    return null;
  },
});

/**
 * The one send of a notice: one message per active owner or admin, so no address sees the others
 * and a bounce stays with its own recipient. `sent` when the provider accepted every message,
 * `partial` when only some, `unconfirmed` when none; none is sent again.
 */
export const deliver = internalAction({
  args: { noticeId: v.id("termsOfUseNotices") },
  returns: v.null(),
  handler: async (ctx, { noticeId }) => {
    const claimed = await ctx.runMutation(internal.termsOfUseNotice.claim, { noticeId });
    if (!claimed) return null;
    const { local, accounts, siteUrl } = requirePlatformEnvironment();
    const terms = currentTermsOfUse();
    const end = (state: Infer<typeof outcome>, recipients = 0, confirmed = 0, withheld = 0) =>
      ctx.runMutation(internal.termsOfUseNotice.finish, {
        noticeId,
        state,
        recipients,
        confirmed,
        withheld,
      });
    // A newer version, or account e-mail turned off since `notify`: nothing goes out.
    if (terms?.version !== claimed.version || (!local && !accounts.enabled)) {
      await end("skipped");
      return null;
    }
    const found = new Set<string>();
    for (const role of ["owner", "admin"] as const) {
      let cursor: string | null = null;
      for (;;) {
        const page: { emails: string[]; isDone: boolean; continueCursor: string } =
          await ctx.runQuery(internal.termsOfUseNotice.recipients, {
            organizationId: claimed.organizationId,
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
    if (to.length === 0) {
      await end("skipped", 0, 0, withheld);
      return null;
    }
    const message = termsOfUseNoticeMail({
      organization: claimed.organization,
      version: claimed.version,
      effectiveAt: terms.effectiveAt,
      siteUrl,
    });
    let confirmed = 0;
    for (let index = 0; index < to.length; index += SEND_CONCURRENCY) {
      const sends = await Promise.allSettled(
        to.slice(index, index + SEND_CONCURRENCY).map((email) =>
          local
            ? ctx.runMutation(internal.mail.capture, {
                email,
                otp: claimed.version,
                type: "terms-of-use",
              })
            : sendCloudflareMail(accounts, { name: "Freecorps Fiscal", to: [email], ...message }),
        ),
      );
      // Never log addresses or the provider response; the row keeps the counts.
      confirmed += sends.filter((send) => send.status === "fulfilled").length;
    }
    const state = confirmed === to.length ? "sent" : confirmed === 0 ? "unconfirmed" : "partial";
    if (state !== "sent")
      console.warn(
        JSON.stringify({
          type: "terms_of_use_notice_delivery",
          noticeId,
          state,
          recipients: to.length,
          confirmed,
        }),
      );
    await end(state, to.length, confirmed, withheld);
    return null;
  },
});

const STATES = ["pending", "sending", "sent", "partial", "unconfirmed", "skipped"] as const;
const noticeState = v.union(
  v.literal("pending"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("partial"),
  v.literal("unconfirmed"),
  v.literal("skipped"),
);

/**
 * The operator's view of a version's notices (runbook in `ORGANIZATIONS.md`): the sweep, the rows
 * per state, counted up to `STATUS_SCAN` each (`capped` beyond it), the oldest `pending` and
 * `sending` rows created before `before`, an instant the operator passes, and the rows whose send
 * left owners or admins out of `ACCOUNT_EMAIL_RECIPIENTS` (`withheld`): counted the same way and
 * listed up to `STUCK_LIST`, whatever their state. Those recipients are never sent this version.
 */
export const status = internalQuery({
  args: { version: v.optional(v.string()), before: v.number() },
  returns: v.object({
    version: v.union(v.string(), v.null()),
    sweep: v.union(
      v.null(),
      v.object({
        state: v.union(v.literal("running"), v.literal("done")),
        organizations: v.number(),
        startedAt: v.number(),
        finishedAt: v.optional(v.number()),
      }),
    ),
    counts: v.array(v.object({ state: noticeState, count: v.number(), capped: v.boolean() })),
    stuck: v.array(
      v.object({
        noticeId: v.id("termsOfUseNotices"),
        organizationId: v.id("organizations"),
        state: v.union(v.literal("pending"), v.literal("sending")),
        createdAt: v.number(),
        claimedAt: v.optional(v.number()),
      }),
    ),
    withheld: v.object({
      count: v.number(),
      capped: v.boolean(),
      rows: v.array(
        v.object({
          noticeId: v.id("termsOfUseNotices"),
          organizationId: v.id("organizations"),
          state: noticeState,
          recipients: v.number(),
          withheld: v.number(),
        }),
      ),
    }),
  }),
  handler: async (ctx, args) => {
    const version = args.version ?? currentTermsOfUse()?.version ?? null;
    if (version === null)
      return {
        version,
        sweep: null,
        counts: [],
        stuck: [],
        withheld: { count: 0, capped: false, rows: [] },
      };
    const run = await ctx.db
      .query("termsOfUseNoticeRuns")
      .withIndex("by_version", (q) => q.eq("version", version))
      .unique();
    const counts = [];
    for (const state of STATES) {
      const rows = await ctx.db
        .query("termsOfUseNotices")
        .withIndex("by_version_and_state_and_createdAt", (q) =>
          q.eq("version", version).eq("state", state),
        )
        .take(STATUS_SCAN + 1);
      counts.push({
        state,
        count: Math.min(rows.length, STATUS_SCAN),
        capped: rows.length > STATUS_SCAN,
      });
    }
    const stuck = [];
    for (const state of ["pending", "sending"] as const)
      for (const row of await ctx.db
        .query("termsOfUseNotices")
        .withIndex("by_version_and_state_and_createdAt", (q) =>
          q.eq("version", version).eq("state", state).lt("createdAt", args.before),
        )
        .take(STUCK_LIST))
        stuck.push({
          noticeId: row._id,
          organizationId: row.organizationId,
          state,
          createdAt: row.createdAt,
          ...(row.claimedAt === undefined ? {} : { claimedAt: row.claimedAt }),
        });
    // Only `finish` sets `withheld`, so these rows are final and nothing sends them again. The
    // organizations with the most recipients left out come first.
    const withheld = await ctx.db
      .query("termsOfUseNotices")
      .withIndex("by_version_and_withheld", (q) => q.eq("version", version).gt("withheld", 0))
      .order("desc")
      .take(STATUS_SCAN + 1);
    return {
      version,
      sweep: run && {
        state: run.state,
        organizations: run.organizations,
        startedAt: run.startedAt,
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      },
      counts,
      stuck,
      withheld: {
        count: Math.min(withheld.length, STATUS_SCAN),
        capped: withheld.length > STATUS_SCAN,
        rows: withheld.slice(0, STUCK_LIST).map((row) => ({
          noticeId: row._id,
          organizationId: row.organizationId,
          state: row.state,
          recipients: row.recipients,
          withheld: row.withheld,
        })),
      },
    };
  },
});

/**
 * Schedules again the send of the current version's `pending` rows created more than
 * `olderThanMinutes` ago: their `deliver` never claimed them (it failed before the claim, or the
 * claim threw). Safe to repeat and to race the original `deliver`, since only one claim succeeds.
 * Up to `STUCK_LIST` rows per call; the operator calls again while `resumed` is not zero. `sending`
 * rows are never resumed: their messages may have gone out.
 */
export const resumePending = internalMutation({
  args: { olderThanMinutes: v.optional(v.number()) },
  returns: v.object({ version: v.union(v.string(), v.null()), resumed: v.number() }),
  handler: async (ctx, { olderThanMinutes = 60 }) => {
    const version = currentTermsOfUse()?.version ?? null;
    if (version === null) return { version, resumed: 0 };
    const rows = await ctx.db
      .query("termsOfUseNotices")
      .withIndex("by_version_and_state_and_createdAt", (q) =>
        q
          .eq("version", version)
          .eq("state", "pending")
          .lt("createdAt", Date.now() - olderThanMinutes * 60_000),
      )
      .take(STUCK_LIST);
    for (const row of rows)
      await ctx.scheduler.runAfter(0, internal.termsOfUseNotice.deliver, { noticeId: row._id });
    return { version, resumed: rows.length };
  },
});

/** `dd/mm/aaaa` of an instant in Brasília, UTC−3 all year since 2019. */
export function brasiliaDate(at: number) {
  const day = new Date(at - 3 * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(day.getUTCDate())}/${pad(day.getUTCMonth() + 1)}/${day.getUTCFullYear()}`;
}

/**
 * The notice: the version, the day it takes effect and the link to its text in the console. Plain
 * text, with the organization's name only to say which one it concerns.
 */
export function termsOfUseNoticeMail(notice: {
  organization: string;
  version: string;
  effectiveAt: number;
  siteUrl: string;
}) {
  const date = brasiliaDate(notice.effectiveAt);
  const link = `${new URL(notice.siteUrl).origin}/termos/uso/${encodeURIComponent(notice.version)}`;
  return {
    subject: `Nova versão dos termos de uso da Freecorps Fiscal, vigente em ${date}`,
    text: [
      `Os termos de uso da Freecorps Fiscal têm uma versão nova, ${notice.version}, que passa a valer para a organização ${notice.organization} em ${date}.`,
      "",
      `Leia a versão nova: ${link}`,
      "",
      "Um proprietário da organização aceita a versão no console, no aviso que aparece ao entrar. Sem o aceite, a partir dessa data a organização mantém a leitura, a exportação e os pedidos de titulares, mas não cria operações novas. Quem não concordar pode cancelar o plano ou encerrar a organização antes da vigência, sem multa.",
      "",
      "Você recebe este e-mail por ser proprietário ou administrador da organização.",
    ].join("\n"),
  };
}
