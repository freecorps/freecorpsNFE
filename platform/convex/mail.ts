import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { requirePlatformEnvironment } from "./environment";

export const accountMail = v.object({
  email: v.string(),
  otp: v.string(),
  type: v.union(
    v.literal("email-verification"),
    v.literal("forget-password"),
    v.literal("organization-invitation"),
    v.literal("email-change"),
    // The notice of a new version of the terms of use (#594): `otp` carries the version.
    v.literal("terms-of-use"),
    // The notice before the cold custody of an open organization (ADR 0009): `otp` carries the run.
    v.literal("archive-notice"),
    // The notice before Freecorps closes a Sandbox-only organization (ADR 0009): `otp` carries it.
    v.literal("sandbox-closure-notice"),
  ),
});
/** Messages about one organization: several can be pending for the same address. */
const perOrganization = (type: string) =>
  type === "organization-invitation" ||
  type === "terms-of-use" ||
  type === "archive-notice" ||
  type === "sandbox-closure-notice";

function requireCollector() {
  if (!requirePlatformEnvironment().local) throw new Error("Local mailbox unavailable");
}

export const capture = internalMutation({
  args: accountMail.fields,
  returns: v.null(),
  handler: async (ctx, message) => {
    requireCollector();
    const now = Date.now();
    const expired = await ctx.db
      .query("developmentMail")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(100);
    for (const mail of expired) await ctx.db.delete("developmentMail", mail._id);
    const email = message.email.trim().toLowerCase();
    // Bounded cleanup also removes old local collector history. Inbox selects
    // only the newest OTP per purpose even when a legacy backlog remains.
    // Invitations and notices can target different organizations and remain independent.
    const previous = perOrganization(message.type)
      ? []
      : await ctx.db
          .query("developmentMail")
          .withIndex("by_email_and_type", (q) => q.eq("email", email).eq("type", message.type))
          .order("desc")
          .take(100);
    for (const mail of previous) await ctx.db.delete("developmentMail", mail._id);
    await ctx.db.insert("developmentMail", {
      ...message,
      email,
      createdAt: now,
      expiresAt: now + 10 * 60_000,
    });
    return null;
  },
});

// Only the operator's local deployment credential can inspect this test mailbox. An expired
// message stays listed with its `expiresAt` until `capture` removes it: a query never reads the
// clock (#45).
export const inbox = internalQuery({
  args: { email: v.string() },
  returns: v.array(accountMail.extend({ createdAt: v.number(), expiresAt: v.number() })),
  handler: async (ctx, { email }) => {
    requireCollector();
    const messages = [];
    for (const type of [
      "email-verification",
      "forget-password",
      "organization-invitation",
      "email-change",
      "terms-of-use",
      "archive-notice",
      "sandbox-closure-notice",
    ] as const) {
      const latest = await ctx.db
        .query("developmentMail")
        .withIndex("by_email_and_type", (q) =>
          q.eq("email", email.trim().toLowerCase()).eq("type", type),
        )
        .order("desc")
        .take(perOrganization(type) ? 20 : 1);
      messages.push(...latest);
    }
    messages.sort((a, b) => b.createdAt - a.createdAt);
    return messages.map(({ email, otp, type, createdAt, expiresAt }) => ({
      email,
      otp,
      type,
      createdAt,
      expiresAt,
    }));
  },
});
