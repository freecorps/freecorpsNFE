import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  partitions: defineTable({
    name: v.string(),
    key: v.optional(v.string()),
    shards: v.number(),
    rate: v.number(),
    capacity: v.number(),
    period: v.number(),
    kind: v.optional(v.union(v.literal("token bucket"), v.literal("fixed window"))),
    start: v.optional(v.number()),
  }).index("name", ["name", "key"]),
  rateLimits: defineTable({
    name: v.string(),
    key: v.optional(v.string()), // undefined is singleton
    shard: v.number(), // 0 is singleton
    value: v.number(), // can go negative if capacity is reserved ahead of time
    ts: v.number(),
  }).index("name", ["name", "key", "shard"]),
});
