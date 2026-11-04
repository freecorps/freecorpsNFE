import { afterEach, expect, it, vi } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { isAbortedRateConflict, retryRestAdmission } from "./restAdmission";

const conflict =
  'Documents read from or written to the "rateLimits" table changed while this mutation was being run and on every subsequent retry.';
afterEach(() => vi.useRealTimers());

it("repete uma vez somente o conflito comprovadamente abortado do orçamento", async () => {
  vi.useFakeTimers();
  const attempt = vi
    .fn()
    .mockRejectedValueOnce(new Error(`Uncaught Error: ${conflict}`))
    .mockResolvedValue({ ok: true });
  const result = retryRestAdmission(attempt);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ ok: true });
  expect(attempt).toHaveBeenCalledTimes(2);
  expect(
    isAbortedRateConflict(new Error(conflict.replace('"rateLimits" table', 'table "rateLimits"'))),
  ).toBe(true);
});

it("não duplica débito sob falha de transporte, erro de domínio ou mensagem não reconhecida", async () => {
  for (const error of [
    new Error("fetch failed"),
    new Error("timeout after commit"),
    new ConvexError(conflict),
    new Error(conflict.replace("rateLimits", "usageTotals")),
    new Error("OCC unknown format"),
  ]) {
    const attempt = vi.fn().mockRejectedValue(error);
    await expect(retryRestAdmission(attempt)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  }
});

it("propaga um segundo conflito e conserva a recusa de cota como resultado", async () => {
  vi.useFakeTimers();
  const error = new Error(conflict);
  const attempt = vi.fn().mockRejectedValue(error);
  const rejection = expect(retryRestAdmission(attempt)).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await rejection;
  expect(attempt).toHaveBeenCalledTimes(2);
  const refused = vi.fn().mockResolvedValue({ ok: false, retryAfter: 1000 });
  expect(await retryRestAdmission(refused)).toEqual({ ok: false, retryAfter: 1000 });
  expect(refused).toHaveBeenCalledTimes(1);
});
