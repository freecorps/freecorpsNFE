import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  calculateRateLimit,
  getValueReturns,
  rateLimitArgs,
  configValidator,
  rateLimitReturns,
  type GetValueReturns,
} from "../shared.js";
import { checkRateLimitOrThrow, configWithDefaults, getShard } from "./internal.js";
import { api } from "./_generated/api.js";
import { findPartition, preparePartition } from "./partitioned.js";

export const rateLimit = mutation({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    const { status, updates } = await checkRateLimitOrThrow(ctx.db, args);
    for (const { value, ts, existing, shard } of updates) {
      if (existing) {
        await ctx.db.patch(existing._id, { ts, value });
      } else {
        const { name, key: optionalKey } = args;
        const key = optionalKey;
        await ctx.db.insert("rateLimits", { name, key, ts, value, shard });
      }
    }
    return status;
  },
});

export const checkRateLimit = query({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    const { status } = await checkRateLimitOrThrow(ctx.db, args);
    return status;
  },
});

/** Consume independent budgets together, with no partial consumption on refusal. */
export const rateLimitMany = mutation({
  args: {
    limits: v.array(v.object(rateLimitArgs)),
    partitionShards: v.optional(v.number()),
    partitionLane: v.optional(v.number()),
  },
  returns: rateLimitReturns,
  handler: async (ctx, { limits, partitionShards, partitionLane }) => {
    if (
      limits.length < 1 ||
      limits.length > 20 ||
      new Set(limits.map(({ name, key }) => JSON.stringify([name, key ?? null]))).size !==
        limits.length
    )
      throw new Error("Expected 1 to 20 distinct rate limit budgets");
    if (partitionShards !== undefined)
      for (const args of limits) await preparePartition(ctx, args, partitionShards);
    const checks = await Promise.all(
      limits.map((args) => checkRateLimitOrThrow(ctx.db, args, partitionLane)),
    );
    const retryAfter = Math.max(0, ...checks.map(({ status }) => status.retryAfter ?? 0));
    if (checks.some(({ status }) => !status.ok)) return { ok: false as const, retryAfter };
    for (let i = 0; i < checks.length; i++) {
      const { name, key } = limits[i]!;
      for (const { value, ts, existing, shard } of checks[i]!.updates) {
        if (existing) await ctx.db.patch(existing._id, { ts, value });
        else await ctx.db.insert("rateLimits", { name, key, ts, value, shard });
      }
    }
    return { ok: true as const, ...(retryAfter > 0 ? { retryAfter } : {}) };
  },
});

export const getValue = query({
  args: {
    name: v.string(),
    key: v.optional(v.string()),
    config: configValidator,
    sampleShards: v.optional(v.number()),
  },
  returns: getValueReturns,
  handler: async (ctx, args): Promise<GetValueReturns> => {
    const layout = await findPartition(ctx.db, args);
    if (layout) {
      const rows = await ctx.db
        .query("rateLimits")
        .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key))
        .take(33);
      if (rows.length !== layout.shards) throw new Error("Incomplete partitioned budget");
      const ts = Math.max(...rows.map((row) => row.ts));
      const common = { rate: layout.rate, capacity: layout.capacity, period: layout.period };
      const config =
        layout.kind === "fixed window"
          ? { ...common, kind: "fixed window" as const, start: layout.start }
          : { ...common, kind: "token bucket" as const };
      const divided = {
        ...config,
        rate: layout.rate / layout.shards,
        capacity: layout.capacity / layout.shards,
      };
      return {
        value: rows.reduce((sum, row) => sum + calculateRateLimit(row, divided, ts).value, 0),
        ts,
        shard: -1,
        config,
      };
    }
    const config = configWithDefaults(args.config);
    const requested = args.sampleShards ?? 1;
    if (!Number.isInteger(requested) || requested < 1)
      throw new Error("sampleShards must be a positive integer");
    const samplesToTake = Math.min(requested, config.shards);

    const shardIndices = Array.from({ length: config.shards }, (_, i) => i);
    const selectedShards: number[] = [];

    for (let i = 0; i < samplesToTake; i++) {
      if (shardIndices.length === 0) break;
      const randomIndex = Math.floor(Math.random() * shardIndices.length);
      selectedShards.push(shardIndices[randomIndex]);
      shardIndices.splice(randomIndex, 1);
    }

    const allShards = (
      await Promise.all(selectedShards.map((shard) => getShard(ctx.db, args.name, args.key, shard)))
    ).map((state, i) => state ?? { value: config.capacity, ts: 0, shard: selectedShards[i]! });

    const maxTs = Math.max(...allShards.map((shard) => shard.ts));
    // we calculate the values as if each shard was at the latest ts
    // we avoid passing Date.now() so the query isn't too time-aware.
    const values = allShards.map((state) => ({
      ...state,
      maxTs: calculateRateLimit(state, config, maxTs),
    }));
    const maxShard = values.reduce((a, b) => (a.maxTs.value > b.maxTs.value ? a : b));
    if (config.kind === "fixed window" && !config.start) {
      // we can modify here b/c config is our copy
      config.start = maxShard.maxTs.windowStart;
    }

    return {
      value: maxShard.value,
      ts: maxShard.ts,
      shard: maxShard.shard,
      config,
    };
  },
});

export const resetRateLimit = mutation({
  args: {
    name: v.string(),
    key: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const allShards = await ctx.db
      .query("rateLimits")
      .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key))
      .collect();
    for (const shard of allShards) {
      await ctx.db.delete(shard._id);
    }
    const layout = await findPartition(ctx.db, args);
    if (layout) await ctx.db.delete(layout._id);
  },
});

export const clearAll = mutation({
  args: { before: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Clearing individual lanes would grant capacity again or leave a broken layout.
    if (await ctx.db.query("partitions").first())
      throw new Error("Reset partitioned budgets by name and key before clearAll");
    const results = await ctx.db
      .query("rateLimits")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", args.before ?? Date.now()))
      .order("desc")
      .take(100);
    for (const m of results) {
      await ctx.db.delete(m._id);
    }
    if (results.length === 100) {
      await ctx.scheduler.runAfter(0, api.lib.clearAll, {
        before: results[99]._creationTime,
      });
    }
  },
});

export { getServerTime } from "./time.js";
