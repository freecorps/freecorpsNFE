import { convexTest } from "convex-test";
import { expect, it, vi, afterEach } from "vite-plus/test";
import schema from "../platform/convex/schema";
import { components } from "../platform/convex/_generated/api";
import { register } from "../platform/test-setup";
import { modules } from "./helpers/convex-modules";
afterEach(() => vi.useRealTimers());

it("consome orçamentos existentes atomicamente e conserva o primeiro quando o último recusa", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  register(t);
  const config = { kind: "token bucket" as const, rate: 1, capacity: 1, period: 60_000 };
  const actor = { name: "actor", key: "one", config };
  const org = { name: "organization", key: "one", config };
  const api = components.rateLimiter.lib;
  expect((await t.mutation(api.rateLimit, org)).ok).toBe(true);
  expect((await t.mutation(api.rateLimitMany, { limits: [actor, org] })).ok).toBe(false);
  expect((await t.query(api.checkRateLimit, actor)).ok).toBe(true);
  vi.setSystemTime(Date.now() + 60_000);
  expect((await t.mutation(api.rateLimitMany, { limits: [actor, org] })).ok).toBe(true);
  expect((await t.query(api.checkRateLimit, actor)).ok).toBe(false);
  expect((await t.query(api.checkRateLimit, org)).ok).toBe(false);
  expect(
    (
      await t.mutation(api.rateLimitMany, {
        limits: [
          { ...actor, key: "two" },
          { ...org, key: "two" },
        ],
      })
    ).ok,
  ).toBe(true);
});

it("recusa orçamento duplicado e lote vazio sem consumir tokens", async () => {
  const t = convexTest(schema, modules);
  register(t);
  const budget = {
    name: "same",
    config: { kind: "fixed window" as const, rate: 1, period: 60_000, start: 0 },
  };
  await expect(
    t.mutation(components.rateLimiter.lib.rateLimitMany, { limits: [budget, budget] }),
  ).rejects.toThrow("distinct");
  await expect(
    t.mutation(components.rateLimiter.lib.rateLimitMany, { limits: [] }),
  ).rejects.toThrow("distinct");
  expect((await t.query(components.rateLimiter.lib.checkRateLimit, budget)).ok).toBe(true);
});

it("migra o saldo restante, conserva cotas e permite leitores/escritores antigos", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  register(t);
  const api = components.rateLimiter.lib;
  const budget = {
    name: "migration",
    key: "one",
    config: { kind: "token bucket" as const, rate: 60, capacity: 60, period: 60_000 },
  };
  // Start on the singleton layout, with a partially spent budget.
  for (let i = 0; i < 17; i++) expect((await t.mutation(api.rateLimit, budget)).ok).toBe(true);
  const consume = () => t.mutation(api.rateLimitMany, { limits: [budget], partitionShards: 8 });
  expect((await consume()).ok).toBe(true);
  expect((await t.query(api.getValue, budget)).value).toBe(42);
  for (let i = 0; i < 42; i++) {
    const result = i % 2 ? await consume() : await t.mutation(api.rateLimit, budget);
    expect(result.ok).toBe(true);
  }
  expect((await consume()).ok).toBe(false);
  expect((await t.query(api.checkRateLimit, budget)).ok).toBe(false);
  expect((await t.query(api.getValue, budget)).value).toBe(0);
  // Fractional balances must combine into one token, rather than falsely refuse.
  vi.setSystemTime(Date.now() + 1000);
  expect((await consume()).ok).toBe(true);
  expect((await consume()).ok).toBe(false);
  vi.setSystemTime(Date.now() + 60_000);
  for (let i = 0; i < 60; i++) expect((await consume()).ok).toBe(true);
  expect((await consume()).ok).toBe(false);
  await expect(
    t.mutation(api.rateLimitMany, { limits: [budget], partitionShards: 4 }),
  ).rejects.toThrow("migration");
  await expect(
    t.mutation(api.rateLimit, { ...budget, config: { ...budget.config, rate: 120 } }),
  ).rejects.toThrow("migration");
});

it("migração e recusa conjunta não recriam nem consomem cotas de outro orçamento", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  register(t);
  const api = components.rateLimiter.lib;
  const config = { kind: "token bucket" as const, rate: 8, period: 60_000 };
  const actor = { name: "migration-actor", config };
  const org = { name: "migration-org", config };
  for (let i = 0; i < 8; i++) await t.mutation(api.rateLimit, org);
  const args = { limits: [actor, org], partitionShards: 8 };
  expect((await t.mutation(api.rateLimitMany, args)).ok).toBe(false);
  expect((await t.query(api.getValue, actor)).value).toBe(8);
  expect((await t.query(api.getValue, org)).value).toBe(0);
  expect((await t.mutation(api.rateLimitMany, args)).ok).toBe(false);
  expect((await t.query(api.getValue, actor)).value).toBe(8);
  await expect(t.mutation(api.clearAll, {})).rejects.toThrow("Reset partitioned");
  await t.mutation(api.resetRateLimit, { name: org.name });
  expect((await t.mutation(api.rateLimitMany, args)).ok).toBe(true);
  expect((await t.query(api.getValue, actor)).value).toBe(7);
  expect((await t.query(api.getValue, org)).value).toBe(7);
});

it("preserva o saldo e a fronteira UTC da janela fixa de importações", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(55_000);
  const t = convexTest(schema, modules);
  register(t);
  const api = components.rateLimiter.lib;
  const budget = {
    name: "fixed-migration",
    config: { kind: "fixed window" as const, rate: 20, capacity: 20, period: 60_000, start: 0 },
  };
  for (let i = 0; i < 11; i++) expect((await t.mutation(api.rateLimit, budget)).ok).toBe(true);
  const consume = () => t.mutation(api.rateLimitMany, { limits: [budget], partitionShards: 8 });
  for (let i = 0; i < 9; i++) expect((await consume()).ok).toBe(true);
  expect(await consume()).toEqual({ ok: false, retryAfter: 5000 });
  vi.setSystemTime(59_999);
  expect(await consume()).toEqual({ ok: false, retryAfter: 1 });
  // Touch lanes at different instants across multiple windows. Persisted lane
  // timestamps may lag, but calculateRateLimit aligns each read to start=0.
  for (const windowStart of [60_000, 120_000, 300_000]) {
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(windowStart + i * 1000);
      expect((await consume()).ok).toBe(true);
    }
    expect(await consume()).toEqual({ ok: false, retryAfter: 41_000 });
    vi.setSystemTime(windowStart + 59_999);
    expect(await consume()).toEqual({ ok: false, retryAfter: 1 });
  }
});

it("a faixa preferida só muda a ordem de leitura, nunca o saldo nem a recusa (#559)", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(60_000);
  const t = convexTest(schema, modules);
  register(t);
  const api = components.rateLimiter.lib;
  const window = (key: string) => ({
    name: "lane-window",
    key,
    config: { kind: "fixed window" as const, rate: 20, capacity: 20, period: 60_000, start: 0 },
  });
  const bucket = (key: string) => ({
    name: "lane-bucket",
    key,
    config: { kind: "token bucket" as const, rate: 60, capacity: 60, period: 60_000 },
  });
  type Call = { limits: ReturnType<typeof window | typeof bucket>[]; partitionLane?: number };
  const accepted = async (calls: number, args: (i: number) => Call) => {
    let ok = 0;
    for (let i = 0; i < calls; i++)
      if ((await t.mutation(api.rateLimitMany, { partitionShards: 8, ...args(i) })).ok) ok++;
    return ok;
  };
  // Always the same lane, each lane holding 2.5 of the 20: the rest still comes from the others.
  expect(await accepted(25, () => ({ limits: [window("pinned")], partitionLane: 3 }))).toBe(20);
  // A lane per call, out of range included, and no lane at all: the same 20.
  expect(await accepted(25, (i) => ({ limits: [window("rotating")], partitionLane: i * 7 }))).toBe(
    20,
  );
  expect(await accepted(25, () => ({ limits: [window("random")] }))).toBe(20);
  // Two budgets charged together share the lane and still refuse together, without consuming.
  expect(
    await accepted(70, () => ({
      limits: [bucket("shared"), window("shared")],
      partitionLane: 5,
    })),
  ).toBe(20);
  expect((await t.query(api.getValue, bucket("shared"))).value).toBeCloseTo(40, 6);
});
