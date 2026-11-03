import { defineTable } from "convex/server";
import { v } from "convex/values";

export const accessTables = {
  // Marco Civil, art. 15: date, time and IP of each application access, kept for six months.
  // One row per user or REST actor, IP and hour. Internal only; no public query reads this table.
  accessRecords: defineTable({
    userId: v.optional(v.string()),
    // `key:<id>` or `member:<id>` for calls through the public REST address.
    actor: v.optional(v.string()),
    ip: v.string(),
    hour: v.number(),
    at: v.number(),
    expiresAt: v.number(),
  })
    .index("by_userId_and_ip_and_hour", ["userId", "ip", "hour"])
    .index("by_actor_and_ip_and_hour", ["actor", "ip", "hour"])
    .index("by_expiresAt", ["expiresAt"]),
  accessRetention: defineTable({
    nextAt: v.number(),
    scheduledId: v.id("_scheduled_functions"),
  }),
};
