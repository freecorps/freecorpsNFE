import { expect, it, vi } from "vite-plus/test";

const leftover = globalThis as typeof globalThis & { ranFirst?: boolean; fired?: boolean };

it("runs in the worker the previous file used", () => {
  expect(leftover.ranFirst).toBe(true);
});

it("starts as a fresh worker would", async () => {
  expect(vi.isFakeTimers()).toBe(false);
  expect(process.env.FILE_ISOLATION_LEAK).toBeUndefined();
  expect(process.env.FILE_ISOLATION_STUB).toBeUndefined();
  expect("fileIsolationGlobal" in globalThis).toBe(false);
  expect(vi.isMockFunction(Math.random)).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(leftover.fired).toBeUndefined();
});
