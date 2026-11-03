import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import schema from "./schema";
import {
  mailboxActorAllowed,
  mailboxEmailAllowed,
  requireMailboxOperator,
} from "./lib/privacyAccess";
import { requireUser, deny } from "./lib/organizationAccess";
import {
  MAILBOXES,
  mailboxAddress,
  LEGACY_ORIGINAL_MIME,
  mailboxOf,
  ORIGINAL_MIME,
  ORPHAN_GRACE,
  recipient,
  validAddress,
  type Mailbox,
} from "./lib/privacyMailProtocol";
import { mailbox, privacyStatus, replyStatus } from "./lib/privacyMailSchema";

/** The thread's mailbox decides who may act on it; its id is only a selector. */
async function operatorThread(ctx: QueryCtx | MutationCtx, threadId: Id<"privacyThreads">) {
  const user = await requireUser(ctx);
  const row = await ctx.db.get("privacyThreads", threadId);
  const allowed = row
    ? mailboxEmailAllowed(mailboxOf(row), user.email)
    : (Object.keys(MAILBOXES) as Mailbox[]).some((name) => mailboxEmailAllowed(name, user.email));
  if (!allowed) deny();
  return { user, row };
}

export const access = query({
  args: { mailbox },
  returns: v.object({ allowed: v.boolean(), address: v.string(), simulated: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    return {
      allowed: mailboxEmailAllowed(args.mailbox, user.email),
      address: mailboxAddress(args.mailbox),
      simulated:
        process.env.APP_ENV === "development" && process.env.FNFE_PRIVACY_SEND_MODE === "local",
    };
  },
});
/** Which mailboxes the signed-in user operates, all in one subscription for the console shell. */
export const mailboxes = query({
  args: {},
  returns: v.object({
    privacy: v.boolean(),
    security: v.boolean(),
    support: v.boolean(),
    operation: v.boolean(),
  }),
  handler: async (ctx) => {
    const { email } = await requireUser(ctx);
    return {
      privacy: mailboxEmailAllowed("privacy", email),
      security: mailboxEmailAllowed("security", email),
      support: mailboxEmailAllowed("support", email),
      operation: mailboxEmailAllowed("operation", email),
    };
  },
});
export const list = query({
  args: { mailbox, status: privacyStatus, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("privacyThreads")),
  handler: async (ctx, args) => {
    await requireMailboxOperator(ctx, args.mailbox);
    return ctx.db
      .query("privacyThreads")
      .withIndex("by_mailbox_and_status_and_updatedAt", (q) =>
        q.eq("mailbox", args.mailbox).eq("status", args.status),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
export const thread = query({
  args: { threadId: v.id("privacyThreads") },
  returns: v.union(schema.doc("privacyThreads"), v.null()),
  handler: async (ctx, { threadId }) => (await operatorThread(ctx, threadId)).row,
});
export const messages = query({
  args: { threadId: v.id("privacyThreads"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("privacyMessages")),
  handler: async (ctx, args) => {
    await operatorThread(ctx, args.threadId);
    return ctx.db
      .query("privacyMessages")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
export const markRead = mutation({
  args: { threadId: v.id("privacyThreads") },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const { row } = await operatorThread(ctx, threadId);
    if (row) await ctx.db.patch("privacyThreads", threadId, { unread: false });
    return null;
  },
});
export const setStatus = mutation({
  args: { threadId: v.id("privacyThreads"), status: privacyStatus },
  returns: v.null(),
  handler: async (ctx, { threadId, status }) => {
    const { user, row } = await operatorThread(ctx, threadId);
    if (!row) deny("NOT_FOUND");
    if (row.status === status) return null;
    const expiry = new Date();
    expiry.setUTCFullYear(expiry.getUTCFullYear() + 5);
    await ctx.db.patch("privacyThreads", threadId, {
      status,
      expiresAt: status === "closed" ? expiry.getTime() : undefined,
    });
    await ctx.db.insert("privacyMessages", {
      threadId,
      kind: "note",
      text: `Situação alterada para ${status === "closed" ? "encerrado" : status === "waiting" ? "aguardando resposta" : "aberto"}.`,
      from: user.email,
      actorId: user._id,
      createdAt: Date.now(),
    });
    return null;
  },
});
export const note = mutation({
  args: { threadId: v.id("privacyThreads"), text: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId, text }) => {
    const { user, row } = await operatorThread(ctx, threadId);
    if (!row) deny("NOT_FOUND");
    if (!text.trim() || text.length > 20_000) deny("INVALID_INPUT");
    await ctx.db.insert("privacyMessages", {
      threadId,
      kind: "note",
      text: text.trim(),
      from: user.email,
      actorId: user._id,
      createdAt: Date.now(),
    });
    return null;
  },
});
export const queueReply = mutation({
  args: { threadId: v.id("privacyThreads"), text: v.string(), requestId: v.string() },
  returns: v.id("privacyMessages"),
  handler: async (ctx, { threadId, text, requestId }) => {
    const { user, row } = await operatorThread(ctx, threadId);
    if (!/^[a-f0-9-]{36}$/.test(requestId) || !text.trim() || text.length > 20_000)
      deny("INVALID_INPUT");
    const existing = await ctx.db
      .query("privacyMessages")
      .withIndex("by_actorId_and_requestId", (q) =>
        q.eq("actorId", user._id).eq("requestId", requestId),
      )
      .unique();
    if (existing) {
      if (existing.threadId !== threadId || existing.text !== text.trim())
        deny("IDEMPOTENCY_CONFLICT");
      return existing._id;
    }
    if (!row || row.status === "closed" || !validAddress(row.contact)) deny("INVALID_INPUT");
    if (
      process.env.FNFE_PRIVACY_SEND_MODE !== "cloudflare" &&
      process.env.FNFE_PRIVACY_SEND_MODE !== "local"
    )
      deny("EMAIL_DISABLED");
    const id = await ctx.db.insert("privacyMessages", {
      threadId,
      kind: "reply",
      text: text.trim(),
      from: mailboxAddress(mailboxOf(row)),
      actorId: user._id,
      requestId,
      state: "queued",
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.privacyMailActions.send, { messageId: id });
    return id;
  },
});
export const intake = internalQuery({
  args: { key: v.string() },
  returns: v.union(schema.doc("privacyIntakes"), v.null()),
  handler: (ctx, { key }) =>
    ctx.db
      .query("privacyIntakes")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
});
export const recordIntake = internalMutation({
  args: {
    key: v.string(),
    hash: v.string(),
    from: v.string(),
    to: v.string(),
    raw: v.id("_storage"),
  },
  returns: v.union(v.literal("stored"), v.literal("duplicate"), v.literal("conflict")),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("privacyIntakes")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing) {
      if (existing.hash !== args.hash || existing.to !== args.to || existing.from !== args.from)
        return "conflict";
      return "duplicate";
    }
    // A late commit must not point at a copy that `discardUnclaimed` already removed.
    if (!(await ctx.db.system.get("_storage", args.raw))) throw new Error("ORIGINAL_MISSING");
    const id = await ctx.db.insert("privacyIntakes", { ...args, state: "pending" });
    await ctx.scheduler.runAfter(0, internal.privacyMailActions.parse, { intakeId: id });
    return "stored";
  },
});
/**
 * After a failed `recordIntake`, removes this delivery's copy unless the intake took it. Reading
 * the intake and deleting in one transaction serializes against a late `recordIntake`.
 */
export const discardUnclaimed = internalMutation({
  args: { key: v.string(), raw: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { key, raw }) => {
    const intake = await ctx.db
      .query("privacyIntakes")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (intake?.raw !== raw && (await ctx.db.system.get("_storage", raw)))
      await ctx.storage.delete(raw);
    return null;
  },
});
export const intakeById = internalQuery({
  args: { intakeId: v.id("privacyIntakes") },
  returns: v.union(schema.doc("privacyIntakes"), v.null()),
  handler: (ctx, { intakeId }) => ctx.db.get("privacyIntakes", intakeId),
});
export const file = internalMutation({
  args: {
    intakeId: v.id("privacyIntakes"),
    subject: v.string(),
    text: v.string(),
    contact: v.string(),
    messageId: v.optional(v.string()),
    attachmentNames: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("privacyIntakes", args.intakeId);
    if (!row || row.state === "filed") return null;
    const target = recipient(row.to);
    if (!target) return null;
    const { mailbox, token } = target;
    // Only the unguessable address token joins a case, and only within its own mailbox. Never
    // trust sender-controlled headers.
    const byToken = (box: Mailbox | undefined) =>
      token
        ? ctx.db
            .query("privacyThreads")
            .withIndex("by_mailbox_and_token", (q) => q.eq("mailbox", box).eq("token", token))
            .unique()
        : null;
    const previous =
      (await byToken(mailbox)) ?? (mailbox === "privacy" ? await byToken(undefined) : null);
    const now = Date.now();
    const threadId =
      previous?._id ??
      (await ctx.db.insert("privacyThreads", {
        mailbox,
        token: crypto.randomUUID().replaceAll("-", ""),
        subject: args.subject.slice(0, 300) || "(Sem assunto)",
        contact: validAddress(args.contact) ? args.contact : "",
        status: "open",
        updatedAt: now,
        unread: true,
      }));
    await ctx.db.patch("privacyThreads", threadId, {
      mailbox,
      status: "open",
      updatedAt: now,
      unread: true,
      expiresAt: undefined,
    });
    await ctx.db.insert("privacyMessages", {
      threadId,
      kind: "received",
      text: args.text.slice(0, 100_000),
      from: args.contact.slice(0, 254),
      createdAt: now,
      raw: row.raw,
      intakeId: row._id,
      attachmentNames: args.attachmentNames.slice(0, 100),
      ...(args.messageId ? { messageId: args.messageId.slice(0, 500) } : {}),
    });
    await ctx.db.patch("privacyIntakes", row._id, { state: "filed", threadId });
    return null;
  },
});
export const claimReply = internalMutation({
  args: { messageId: v.id("privacyMessages") },
  returns: v.union(
    v.object({ message: schema.doc("privacyMessages"), thread: schema.doc("privacyThreads") }),
    v.null(),
  ),
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get("privacyMessages", messageId);
    if (!message || message.state !== "queued") return null;
    const row = await ctx.db.get("privacyThreads", message.threadId);
    if (
      !row ||
      row.status === "closed" ||
      !message.actorId ||
      !(await mailboxActorAllowed(ctx, mailboxOf(row), message.actorId))
    ) {
      await ctx.db.patch("privacyMessages", messageId, { state: "failed" });
      return null;
    }
    await ctx.db.patch("privacyMessages", messageId, { state: "sending" });
    await ctx.scheduler.runAfter(60_000, internal.privacyMail.finishReply, {
      messageId,
      state: "uncertain",
    });
    return { message, thread: row };
  },
});
export const finishReply = internalMutation({
  args: { messageId: v.id("privacyMessages"), state: replyStatus },
  returns: v.null(),
  handler: async (ctx, { messageId, state }) => {
    const message = await ctx.db.get("privacyMessages", messageId);
    if (!message || message.state !== "sending") return null;
    await ctx.db.patch("privacyMessages", messageId, { state });
    const row = await ctx.db.get("privacyThreads", message.threadId);
    // A new inbound message or a manual closure must not be overwritten by a delayed send.
    if (
      state === "accepted" &&
      row &&
      row.status !== "closed" &&
      row.updatedAt <= message.createdAt
    )
      await ctx.db.patch("privacyThreads", row._id, { status: "waiting" });
    return null;
  },
});
export const download = mutation({
  args: { messageId: v.id("privacyMessages") },
  returns: v.string(),
  handler: async (ctx, { messageId }) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get("privacyMessages", messageId);
    if (!row) deny("NOT_FOUND");
    await operatorThread(ctx, row.threadId);
    if (!row.raw) deny("NOT_FOUND");
    const token = crypto.randomUUID().replaceAll("-", "");
    await ctx.db.insert("privacyDownloads", {
      token,
      messageId,
      actorId: user._id,
      expiresAt: Date.now() + 120_000,
    });
    return `${process.env.CONVEX_SITE_URL}/privacy-mail/file/${token}`;
  },
});
export const redeem = internalMutation({
  args: { token: v.string() },
  returns: v.union(v.id("_storage"), v.null()),
  handler: async (ctx, { token }) => {
    const ticket = await ctx.db
      .query("privacyDownloads")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!ticket) return null;
    await ctx.db.delete("privacyDownloads", ticket._id);
    if (ticket.expiresAt <= Date.now()) return null;
    const message = await ctx.db.get("privacyMessages", ticket.messageId);
    const row = message && (await ctx.db.get("privacyThreads", message.threadId));
    if (!message || !row || !(await mailboxActorAllowed(ctx, mailboxOf(row), ticket.actorId)))
      return null;
    return message.raw ?? null;
  },
});
const ORPHAN_PAGE = 100;
/** Whether any row still points at a blob. A referenced original is never deleted (D02). */
async function referenced(ctx: MutationCtx, raw: Id<"_storage">) {
  return (
    (await ctx.db
      .query("privacyIntakes")
      .withIndex("by_raw", (q) => q.eq("raw", raw))
      .first()) !== null ||
    (await ctx.db
      .query("privacyMessages")
      .withIndex("by_raw", (q) => q.eq("raw", raw))
      .first()) !== null ||
    // Operator uploads choose their own content type; the legacy MIME could be one of them.
    (await ctx.db
      .query("referenceVersions")
      .withIndex("by_storageId", (q) => q.eq("storageId", raw))
      .first()) !== null
  );
}
const KEY = "orphan-originals";
/**
 * The Worker's cron fires every five minutes and calls the maintenance after draining its queue,
 * so a long backlog delays it. A gap beyond this means a pause or a restore: after a restore the
 * row comes back from the snapshot, and blobs received after it have no intake although they are
 * the only copy (the Worker drops its R2 copy on 2xx). Such a gap holds everything created since
 * the last run until an operator releases it. A restore must not rely on it: the runbook calls
 * `holdOriginals` before the Worker is turned back on.
 */
export const MAINTENANCE_GAP = 30 * 60_000;
const maintenanceRow = (ctx: QueryCtx | MutationCtx) =>
  ctx.db
    .query("privacyMaintenance")
    .withIndex("by_key", (q) => q.eq("key", KEY))
    .unique();
/**
 * Deletes originals that no intake or message took: a delivery that stored the blob and failed
 * before recording it, including those left before this collector existed. One page of
 * `_storage` per call, oldest first, only blobs older than ORPHAN_GRACE; the cursor is persisted
 * so the scan resumes and, once done, only looks at newer blobs. It fails closed: a new row and
 * a gap in the runs hold the scan at `heldFrom` until `releaseHeldOriginals`.
 */
export const collectOrphans = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const state = await maintenanceRow(ctx);
    if (!state) {
      // A missing row is a first deploy or a restore of an older snapshot; they look the same.
      await ctx.db.insert("privacyMaintenance", {
        key: KEY,
        scannedUntil: 0,
        legacyUntil: now,
        lastRunAt: now,
        heldFrom: 0,
      });
      return null;
    }
    const heldFrom =
      state.heldFrom ?? (now - state.lastRunAt > MAINTENANCE_GAP ? state.lastRunAt : undefined);
    const after = state.scannedUntil;
    // The scan covers [after, before). A pending one resumes unless a later hold cut below it.
    const resume = state.scanBefore !== undefined && state.scanBefore <= (heldFrom ?? Infinity);
    const before = resume ? state.scanBefore! : Math.min(now - ORPHAN_GRACE, heldFrom ?? Infinity);
    const page = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) =>
        q.gte("_creationTime", after).lt("_creationTime", before),
      )
      .paginate({ cursor: resume ? (state.cursor ?? null) : null, numItems: ORPHAN_PAGE });
    for (const blob of page.page)
      if (
        (blob.contentType === ORIGINAL_MIME ||
          (blob.contentType === LEGACY_ORIGINAL_MIME && blob._creationTime < state.legacyUntil)) &&
        !(await referenced(ctx, blob._id))
      )
        await ctx.storage.delete(blob._id);
    await ctx.db.patch("privacyMaintenance", state._id, {
      lastRunAt: now,
      heldFrom,
      ...(page.isDone
        ? { scannedUntil: Math.max(after, before), scanBefore: undefined, cursor: undefined }
        : { scanBefore: before, cursor: page.continueCursor }),
    });
    return null;
  },
});
/**
 * Restore step, before the Worker is turned back on (docs/operacao/restauracao.md): keeps every
 * original created from `from` on, typically the snapshot time. Holds only widen; an existing
 * earlier hold stays.
 */
export const holdOriginals = internalMutation({
  args: { from: v.number() },
  returns: v.null(),
  handler: async (ctx, { from }) => {
    const state = await maintenanceRow(ctx);
    const now = Date.now();
    if (!state)
      await ctx.db.insert("privacyMaintenance", {
        key: KEY,
        scannedUntil: 0,
        legacyUntil: now,
        lastRunAt: now,
        heldFrom: from,
      });
    else
      await ctx.db.patch("privacyMaintenance", state._id, {
        heldFrom: Math.min(state.heldFrom ?? from, from),
      });
    return null;
  },
});
/**
 * Operator step after reconciling a restore or a pause (docs/operacao/privacidade-email.md):
 * lets the collector go past `heldFrom`. The expected value guards against releasing a newer
 * hold than the one reviewed. Holds merge into the earliest, so this releases all of them.
 */
export const releaseHeldOriginals = internalMutation({
  args: { heldFrom: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await maintenanceRow(ctx);
    if (state?.heldFrom !== args.heldFrom) throw new Error("HOLD_MISMATCH");
    await ctx.db.patch("privacyMaintenance", state._id, {
      heldFrom: undefined,
      lastRunAt: Date.now(),
    });
    return null;
  },
});
/**
 * A closed case is kept for five years, independent of customer organizations: D02 for privacy
 * and the same period for security reports (docs/operacao/seguranca-email.md) and, until the
 * maintainer decides otherwise, for support conversations (docs/operacao/suporte-email.md) and
 * the operation mailbox (docs/operacao/operacao-email.md).
 */
export const sweep = internalMutation({
  args: {},
  // Whether the orphan collector is held, so the Worker can raise an alert. No content.
  returns: v.object({ held: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const pending = await ctx.db
      .query("privacyIntakes")
      .withIndex("by_state", (q) => q.eq("state", "pending"))
      .take(20);
    for (const row of pending)
      await ctx.scheduler.runAfter(0, internal.privacyMailActions.parse, { intakeId: row._id });
    const expired = await ctx.db
      .query("privacyThreads")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", 0).lt("expiresAt", now))
      .take(1);
    for (const row of expired) {
      const messages = await ctx.db
        .query("privacyMessages")
        .withIndex("by_threadId", (q) => q.eq("threadId", row._id))
        .take(20);
      for (const message of messages) {
        if (message.raw && (await ctx.db.system.get(message.raw)))
          await ctx.storage.delete(message.raw);
        if (message.intakeId && (await ctx.db.get("privacyIntakes", message.intakeId)))
          await ctx.db.delete("privacyIntakes", message.intakeId);
        await ctx.db.delete("privacyMessages", message._id);
      }
      if (messages.length < 20) await ctx.db.delete("privacyThreads", row._id);
    }
    const tickets = await ctx.db
      .query("privacyDownloads")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(100);
    for (const ticket of tickets) await ctx.db.delete("privacyDownloads", ticket._id);
    const unassigned = await ctx.db
      .query("privacyThreads")
      .withIndex("by_mailbox_and_token", (q) => q.eq("mailbox", undefined))
      .take(100);
    for (const row of unassigned)
      await ctx.db.patch("privacyThreads", row._id, { mailbox: "privacy" });
    // Its own transaction: a failure there must not undo the purge above.
    await ctx.scheduler.runAfter(0, internal.privacyMail.collectOrphans, {});
    const state = await maintenanceRow(ctx);
    return { held: !state || state.heldFrom !== undefined };
  },
});
