// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { getFunctionName } from "convex/server";
import type { Id } from "../../../platform/convex/_generated/dataModel";
import { useFiscalRead } from "./fiscal-read";

const mark = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({
  useMutation: (fn: Parameters<typeof getFunctionName>[0]) => (args: unknown) =>
    mark(getFunctionName(fn), args),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const org = (id: string) => id as Id<"organizations">;

it("marks the read once it arrived, at most once an hour per organization (#641)", () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 30, 12) });
  mark.mockResolvedValue(null);
  const { rerender } = renderHook(({ loaded }) => useFiscalRead(org("a"), loaded), {
    initialProps: { loaded: false },
  });
  expect(mark).not.toHaveBeenCalled();
  rerender({ loaded: true });
  expect(mark).toHaveBeenCalledWith("archiveNotice:markFiscalRead", { organizationId: "a" });
  renderHook(() => useFiscalRead(org("a"), true));
  expect(mark).toHaveBeenCalledTimes(1);
  // Another organization is its own mark.
  renderHook(() => useFiscalRead(org("b"), true));
  expect(mark).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(3_600_000);
  renderHook(() => useFiscalRead(org("a"), true));
  expect(mark).toHaveBeenCalledTimes(3);
});

it("a refused mark changes nothing on the page", () => {
  mark.mockRejectedValue(new Error("ORGANIZATION_ARCHIVED"));
  expect(() => renderHook(() => useFiscalRead(org("c"), true))).not.toThrow();
});
