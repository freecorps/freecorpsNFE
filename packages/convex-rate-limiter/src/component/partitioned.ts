import { calculateRateLimit, type RateLimitArgs, type RateLimitReturns } from "../shared.js";
import type { Doc } from "./_generated/dataModel.js";
import type { DatabaseReader, MutationCtx } from "./_generated/server.js";

export const findPartition = (db: DatabaseReader, args: Pick<RateLimitArgs, "name" | "key">) =>
  db
    .query("partitions")
    .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key))
    .unique();

function validate(args: RateLimitArgs, layout?: Doc<"partitions"> | null) {
  const { config } = args;
  const capacity = config.capacity ?? config.rate;
  if (
    (config.kind === "fixed window" && config.start !== 0) ||
    args.reserve ||
    config.maxReserved ||
    (config.shards ?? 1) !== 1 ||
    (args.count ?? 1) !== 1 ||
    ![config.rate, capacity, config.period].every((n) => Number.isFinite(n) && n > 0)
  )
    throw new Error(
      "Partitioned budgets require count=1 without reservations; fixed windows must start at zero",
    );
  if (
    layout &&
    ((layout.kind ?? "token bucket") !== config.kind ||
      layout.rate !== config.rate ||
      layout.capacity !== capacity ||
      layout.period !== config.period ||
      (config.kind === "fixed window" && layout.start !== config.start))
  )
    throw new Error("Partitioned budget configuration cannot change without migration");
  const common = { rate: config.rate, capacity, period: config.period };
  return config.kind === "fixed window"
    ? { ...common, kind: "fixed window" as const, start: 0 }
    : { ...common, kind: "token bucket" as const };
}

/** Lazy, atomic migration. Read the existing balance, never grant a new budget. */
export async function preparePartition(ctx: MutationCtx, args: RateLimitArgs, shards: number) {
  const layout = await findPartition(ctx.db, args);
  const config = validate(args, layout);
  if (!Number.isInteger(shards) || shards < 2 || shards > 32 || shards > config.capacity)
    throw new Error("Expected 2 to 32 partitions, each with capacity >= 1");
  if (layout) {
    if (layout.shards !== shards)
      throw new Error("Partition count cannot change without migration");
    return;
  }
  const previous = await ctx.db
    .query("rateLimits")
    .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key))
    .take(33);
  if (previous.length > 1 || (previous.length === 1 && previous[0]!.shard !== 0))
    throw new Error("Only singleton budgets can migrate to partitions");
  const now = Date.now();
  const { value: balance, ts } = calculateRateLimit(previous[0] ?? null, args.config, now);
  if (balance < 0) throw new Error("Reserved debt must settle before partition migration");
  await ctx.db.insert("partitions", { name: args.name, key: args.key, shards, ...config });
  for (let shard = 0; shard < shards; shard++) {
    const row = { name: args.name, key: args.key, shard, value: balance / shards, ts };
    if (shard === 0 && previous[0]) await ctx.db.patch(previous[0]._id, row);
    else await ctx.db.insert("rateLimits", row);
  }
}

/** Fast path reads one lane; exhaustion searches the remainder before refusing. */
export async function checkPartition(
  db: DatabaseReader,
  args: RateLimitArgs,
  layout: Doc<"partitions">,
  lane?: number,
) {
  const config = validate(args, layout);
  const divided = {
    ...config,
    rate: config.rate / layout.shards,
    capacity: config.capacity / layout.shards,
    period: config.period,
  };
  const now = Date.now();
  const order = Array.from({ length: layout.shards }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // A caller may name the lane to try first, so budgets charged together share one lane index.
  // Which lane is read first never changes a balance or a refusal.
  if (lane !== undefined && Number.isInteger(lane) && lane >= 0) {
    const first = order.indexOf(lane % layout.shards);
    [order[0], order[first]] = [order[first]!, order[0]!];
  }
  const updates: { existing: Doc<"rateLimits">; shard: number; value: number; ts: number }[] = [];
  const read = async (shard: number) => {
    const existing = await db
      .query("rateLimits")
      .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key).eq("shard", shard))
      .unique();
    if (!existing) throw new Error("Incomplete partitioned budget");
    return { existing, shard, ...calculateRateLimit(existing, divided, now) };
  };
  // A funded lane needs no second read: every extra lane expands the OCC conflict set.
  // If it is short, prefer a funded second lane before combining partial balances.
  const first = [await read(order.shift()!)];
  if (first[0]!.value < 1) {
    first.push(await read(order.shift()!));
    first.sort((a, b) => b.value - a.value);
  }
  let remaining = 1;
  let windowEnd = now;
  for (let i = 0; i < layout.shards; i++) {
    const { existing, shard, value, ts } =
      i < first.length ? first[i]! : await read(order[i - first.length]!);
    windowEnd = ts + config.period;
    const consumed = Math.min(Math.max(0, value), remaining);
    if (consumed > 0) updates.push({ existing, shard, value: value - consumed, ts });
    remaining -= consumed;
    if (remaining <= 0) return { status: { ok: true } as RateLimitReturns, updates };
  }
  // Every lane is below one token here, so every lane refills at its divided rate.
  return {
    status: {
      ok: false,
      retryAfter:
        config.kind === "fixed window"
          ? windowEnd - now
          : Math.ceil((remaining * config.period) / config.rate),
    } as RateLimitReturns,
    updates: [],
  };
}
