import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import rule from "./no-wall-clock-in-tests.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const test = (code: string, filename = "tests/example.test.ts") => ({ code, filename });

new RuleTester().run("no-wall-clock-in-tests", rule, {
  valid: [
    // Timers falsos no arquivo: o relógio é o do Vitest.
    test(`beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 0, 15)); });
      it("x", () => { expect(Date.now()).toBe(1); setTimeout(() => {}, 10); });`),
    test(`usePlatformEnvironment({ siteUrl, convexSiteUrl, secret, now });
      it("x", () => { const at = Date.now() + 1000; });`),
    // Data explícita não lê o relógio.
    test(`const at = new Date("2026-01-15T12:00:00Z"); const ms = Date.UTC(2026, 0, 1);`),
    // Espera limitada do Vitest.
    test(`await vi.waitFor(() => expect(existsSync(file)).toBe(true));`),
    // Benchmarks e arquivos que não são teste ficam de fora.
    test(`const started = performance.now();`, "tests/render.benchmark.test.ts"),
    test(`const now = Date.now();`, "tests/helpers/clock.ts"),
    // Loop sem espera não é polling.
    test(`for (const row of rows) await insert(row);`),
  ],
  invalid: [
    { ...test(`const now = Date.now();`), errors: [{ messageId: "clock" }] },
    { ...test(`const started = performance.now();`), errors: [{ messageId: "clock" }] },
    { ...test(`const at = new Date().toISOString();`), errors: [{ messageId: "clock" }] },
    { ...test(`setTimeout(() => controller.abort(), 20);`), errors: [{ messageId: "timer" }] },
    { ...test(`globalThis.setInterval(tick, 5);`), errors: [{ messageId: "timer" }] },
    {
      ...test(`import { setTimeout as sleep } from "node:timers/promises";
        await sleep(20);`),
      errors: [{ messageId: "timer" }],
    },
    {
      // Polling reprova mesmo com timers falsos no arquivo.
      ...test(`vi.useFakeTimers();
        while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 30));`),
      errors: [{ messageId: "polling" }],
    },
    {
      ...test(`vi.useFakeTimers();
        for (;;) { if (done()) break; await sleep(10); }`),
      errors: [{ messageId: "polling" }],
    },
    {
      ...test(`vi.useFakeTimers();
        for (const attempt of [1, 2, 3]) { if (done()) break; await sleep(10); }`),
      errors: [{ messageId: "polling" }],
    },
    {
      ...test(`vi.useFakeTimers();
        for (const key in pending) await delay(5);`),
      errors: [{ messageId: "polling" }],
    },
  ],
});
