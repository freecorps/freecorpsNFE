import { defineTable } from "convex/server";
import { v } from "convex/values";
export const mailbox = v.union(
  v.literal("privacy"),
  v.literal("security"),
  v.literal("support"),
  v.literal("operation"),
);
export const privacyStatus = v.union(v.literal("open"), v.literal("waiting"), v.literal("closed"));
export const replyStatus = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("accepted"),
  v.literal("failed"),
  v.literal("uncertain"),
);
export const privacyTables = {
  privacyIntakes: defineTable({
    key: v.string(),
    hash: v.string(),
    from: v.string(),
    to: v.string(),
    raw: v.id("_storage"),
    state: v.union(v.literal("pending"), v.literal("filed")),
    threadId: v.optional(v.id("privacyThreads")),
  })
    .index("by_key", ["key"])
    .index("by_state", ["state"])
    .index("by_raw", ["raw"]),
  privacyThreads: defineTable({
    // Optional until the maintenance sweep fills it in on threads stored before the security
    // mailbox; read it through `mailboxOf`.
    mailbox: v.optional(mailbox),
    token: v.string(),
    subject: v.string(),
    contact: v.string(),
    status: privacyStatus,
    updatedAt: v.number(),
    unread: v.boolean(),
    expiresAt: v.optional(v.number()),
  })
    .index("by_mailbox_and_token", ["mailbox", "token"])
    .index("by_mailbox_and_status_and_updatedAt", ["mailbox", "status", "updatedAt"])
    .index("by_expiresAt", ["expiresAt"]),
  privacyMessages: defineTable({
    threadId: v.id("privacyThreads"),
    kind: v.union(v.literal("received"), v.literal("reply"), v.literal("note")),
    text: v.string(),
    from: v.string(),
    createdAt: v.number(),
    raw: v.optional(v.id("_storage")),
    intakeId: v.optional(v.id("privacyIntakes")),
    attachmentNames: v.optional(v.array(v.string())),
    messageId: v.optional(v.string()),
    state: v.optional(replyStatus),
    actorId: v.optional(v.string()),
    requestId: v.optional(v.string()),
  })
    .index("by_threadId", ["threadId"])
    .index("by_actorId_and_requestId", ["actorId", "requestId"])
    .index("by_raw", ["raw"]),
  privacyDownloads: defineTable({
    token: v.string(),
    messageId: v.id("privacyMessages"),
    actorId: v.string(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_expiresAt", ["expiresAt"]),
  /** Progress of the orphan collector over `_storage`, by creation time, from the beginning. */
  privacyMaintenance: defineTable({
    key: v.literal("orphan-originals"),
    scannedUntil: v.number(),
    scanBefore: v.optional(v.number()),
    cursor: v.optional(v.string()),
    // Creation of this row: only older `message/rfc822` blobs can be originals of this flow.
    legacyUntil: v.number(),
    lastRunAt: v.number(),
    // Blobs created from here on are kept until an operator releases them.
    heldFrom: v.optional(v.number()),
  }).index("by_key", ["key"]),
};
