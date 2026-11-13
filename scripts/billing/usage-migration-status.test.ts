import { describe, expect, it } from "vite-plus/test";
import { metrics as platformMetrics } from "../../platform/convex/lib/usageValues";
import {
  collectStatus,
  compareReceipts,
  convexPage,
  metrics,
  parseArgs,
  parseDeployment,
  readPage,
  readReceipt,
  receipt,
  sum,
} from "../lib/usage-migration-status.mjs";

const secret = "conteudo-que-nao-pode-vazar-12345678901234";
const eventGroup = {
  metric: "imports",
  environment: "sandbox",
  state: "committed",
  events: 2,
  units: 2,
};
const page = (groups: unknown[], isDone = true) => ({
  scanned: 2,
  continueCursor: "c",
  isDone,
  groups,
});
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => new Error(""),
    (e: unknown) => (e instanceof Error ? e : new Error("")),
  );
const reject = (run: () => unknown) => {
  let message = "";
  try {
    run();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).not.toBe("");
  expect(message).not.toContain(secret);
};

describe("usage migration status", () => {
  it("keeps the metric allowlist equal to the platform's", () => {
    expect([...metrics].sort()).toEqual([...platformMetrics].sort());
  });

  it("accepts only an explicit deployment name", () => {
    expect(parseDeployment("elated-possum-295")).toBe("elated-possum-295");
    expect(parseDeployment("prod:elated-possum-295")).toBe("elated-possum-295");
    for (const value of ["prod", "dev", "local", "dev/james", "team:project:prod", "", undefined])
      expect(() => parseDeployment(value)).toThrow("--deployment");
    expect(() => parseArgs([])).toThrow("--deployment");
    expect(() => parseArgs(["--out", "x.json"])).toThrow("--deployment");
    expect(() => parseArgs(["--deployment", "a-b-1", "--page-size", "0"])).toThrow();
    expect(parseArgs(["--deployment", "a-b-1"])).toEqual({ deployment: "a-b-1", pageSize: 500 });
  });

  it("refuses a page outside the contract without repeating its values", () => {
    expect(readPage("eventStatus", page([eventGroup])).groups).toEqual([eventGroup]);
    for (const bad of [
      { ...eventGroup, metric: secret },
      { ...eventGroup, environment: secret },
      { ...eventGroup, state: secret },
      { ...eventGroup, units: -1 },
      { ...eventGroup, units: 1.5 },
      { ...eventGroup, units: Number.MAX_SAFE_INTEGER + 2 },
      { ...eventGroup, units: String(secret) },
      { ...eventGroup, organizationId: secret },
    ])
      reject(() => readPage("eventStatus", page([bad])));
    reject(() => readPage("eventStatus", { ...page([]), extra: secret }));
    reject(() => readPage("eventStatus", { ...page([]), isDone: secret }));
    reject(() => readPage("totalStatus", page([eventGroup])));
  });

  it("fails instead of rounding a sum above the safe integer range", async () => {
    expect(() => sum(Number.MAX_SAFE_INTEGER, 1)).toThrow("MAX_SAFE_INTEGER");
    const half = { ...eventGroup, units: Math.ceil(Number.MAX_SAFE_INTEGER / 2) + 1 };
    let calls = 0;
    await expect(
      collectStatus(async (fn) =>
        fn === "eventStatus" ? page([half], ++calls > 1) : page([], true),
      ),
    ).rejects.toThrow("MAX_SAFE_INTEGER");
  });

  it("walks every page and refuses a cursor that does not advance", async () => {
    const seen: (string | null)[] = [];
    const status = await collectStatus(
      async (fn, opts) => {
        if (fn === "totalStatus") return page([]);
        seen.push(opts.cursor);
        return { ...page([eventGroup], seen.length === 3), continueCursor: `c${seen.length}` };
      },
      { pageSize: 10 },
    );
    expect(seen).toEqual([null, "c1", "c2"]);
    expect(status.events).toMatchObject({ pages: 3, scanned: 6 });
    expect(status.events.groups).toEqual([{ ...eventGroup, events: 6, units: 6 }]);
    await expect(collectStatus(async () => page([], false))).rejects.toThrow("cursor");
  });

  it("reads a previous receipt back and refuses any other file without echoing it", async () => {
    const status = await collectStatus(async (fn) =>
      fn === "eventStatus" ? page([eventGroup]) : page([]),
    );
    const before = receipt({
      deployment: "elated-possum-295",
      localCheckout: { commit: null, dirty: null },
      startedAt: "2026-10-27T10:00:00.000Z",
      finishedAt: "2026-10-27T10:00:01.000Z",
      status,
    });
    const read = readReceipt(JSON.stringify(before));
    expect(read).toEqual({
      deployment: "elated-possum-295",
      finishedAt: "2026-10-27T10:00:01.000Z",
      byMetric: before.byMetric,
    });
    expect(compareReceipts(read, before)).toMatchObject({ differences: [], observedEqual: true });
    expect(before.limitations.join(" ")).toContain("não é o SHA publicado");
    const variants = [
      `{"type":"usage_migration_status", ${secret}`,
      JSON.stringify({ ...before, type: secret }),
      JSON.stringify({ ...before, deployment: secret }),
      JSON.stringify({ ...before, byMetric: [{ ...before.byMetric[0], metric: secret }] }),
      JSON.stringify({ ...before, byMetric: [{ ...before.byMetric[0], note: secret }] }),
      JSON.stringify({ ...before, byMetric: [{ ...before.byMetric[0], events: -1 }] }),
      JSON.stringify({ ...before, byMetric: [before.byMetric[0], before.byMetric[0]] }),
    ];
    for (const text of variants) reject(() => readReceipt(text));
    expect(readReceipt(JSON.stringify({ ...before, finishedAt: secret })).finishedAt).toBeNull();
  });

  it("runs the official CLI read-only on the named deployment, with a clean environment", async () => {
    const previous = { key: process.env.CONVEX_DEPLOY_KEY, dep: process.env.CONVEX_DEPLOYMENT };
    process.env.CONVEX_DEPLOY_KEY = secret;
    process.env.CONVEX_DEPLOYMENT = "dev:other-deployment-1";
    try {
      const calls: { args: string[]; options: { env: Record<string, string>; cwd: string } }[] = [];
      const ok = convexPage("/repo", "prod:elated-possum-295", ((
        _: string,
        args: string[],
        options: { env: Record<string, string>; cwd: string },
      ) => {
        calls.push({ args, options });
        return { status: 0, stdout: JSON.stringify(page([eventGroup])) };
      }) as never);
      expect(await ok("eventStatus", { numItems: 5, cursor: null })).toEqual(page([eventGroup]));
      const [call] = calls;
      if (!call) throw new Error("Convex was not called");
      const { args, options } = call;
      expect(args.slice(1)).toEqual([
        "run",
        "usageMigration:eventStatus",
        '{"paginationOpts":{"numItems":5,"cursor":null}}',
        "--deployment",
        "elated-possum-295",
        "--codegen",
        "disable",
        "--typecheck",
        "disable",
      ]);
      expect(args).not.toContain("--push");
      expect(options.cwd.replaceAll("\\", "/")).toBe("/repo/platform");
      expect(Object.keys(options.env).some((name) => name.toUpperCase().startsWith("CONVEX"))).toBe(
        false,
      );
      const failing = convexPage("/repo", "elated-possum-295", (() => ({
        status: 1,
        stdout: secret,
        stderr: secret,
      })) as never);
      const error = await failure(failing("totalStatus", { numItems: 5, cursor: null }));
      expect(error.message).toContain("falhou");
      expect(error.message).not.toContain(secret);
      const garbled = convexPage("/repo", "elated-possum-295", (() => ({
        status: 0,
        stdout: secret,
      })) as never);
      const parse = await failure(garbled("totalStatus", { numItems: 5, cursor: null }));
      expect(parse.message).not.toContain(secret);
      expect(() => convexPage("/repo", "prod")).toThrow("--deployment");
    } finally {
      if (previous.key === undefined) delete process.env.CONVEX_DEPLOY_KEY;
      else process.env.CONVEX_DEPLOY_KEY = previous.key;
      if (previous.dep === undefined) delete process.env.CONVEX_DEPLOYMENT;
      else process.env.CONVEX_DEPLOYMENT = previous.dep;
    }
  });
});
