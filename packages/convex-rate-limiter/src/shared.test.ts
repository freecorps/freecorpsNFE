import { describe, expect, test } from "vite-plus/test";
import { calculateRateLimit } from "./shared.js";

const Second = 1_000;
const Minute = 60 * Second;
// A fixed instant: calculateRateLimit receives the time as an argument.
const Now = Date.UTC(2026, 0, 1);

describe("calculateRateLimit", () => {
  test("token bucket with no existing state", () => {
    const now = Now;
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const result = calculateRateLimit(null, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeUndefined();
  });

  test("token bucket with existing state", () => {
    const now = Now;
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const existing = {
      value: 5,
      ts: now - 30 * Second,
    };

    const result = calculateRateLimit(existing, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeUndefined();
  });

  test("token bucket with consumption", () => {
    const now = Now;
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const existing = {
      value: 5,
      ts: now - 30 * Second,
    };

    const result = calculateRateLimit(existing, config, now, 8);

    expect(result.value).toBe(2);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeUndefined();
  });

  test("token bucket with over-consumption", () => {
    const now = Now;
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const existing = {
      value: 5,
      ts: now - 30 * Second,
    };

    const result = calculateRateLimit(existing, config, now, 15);

    expect(result.value).toBe(-5);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBe(30 * Second); // 5 tokens at 10 tokens/minute = 0.5 minutes
    expect(result.windowStart).toBeUndefined();
  });

  test("fixed window with no existing state", () => {
    const now = Now;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const result = calculateRateLimit(null, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBeDefined();
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeDefined();
  });

  test("fixed window with existing state in same window", () => {
    const windowStart = Now - 30 * Second;
    const now = windowStart + 45 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now);

    expect(result.value).toBe(5);
    expect(result.ts).toBe(windowStart);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBe(windowStart);
  });

  test("fixed window with existing state in next window", () => {
    const windowStart = Now - 90 * Second;
    const now = windowStart + 90 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBe(windowStart + Minute);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBe(windowStart);
  });

  test("fixed window with consumption", () => {
    const windowStart = Now - 30 * Second;
    const now = windowStart + 45 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now, 3);

    expect(result.value).toBe(2);
    expect(result.ts).toBe(windowStart);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBe(windowStart);
  });

  test("fixed window with over-consumption", () => {
    const windowStart = Now - 30 * Second;
    const now = windowStart + 45 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now, 8);

    expect(result.value).toBe(-3);
    expect(result.ts).toBe(windowStart);
    expect(result.retryAfter).toBe(15 * Second); // 15 seconds left in this window
    expect(result.windowStart).toBe(windowStart);
  });
});
