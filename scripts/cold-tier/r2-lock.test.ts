import { describe, expect, it } from "vite-plus/test";
import { lockDate, r2LockClient, runLockRule } from "../lib/r2-lock.mjs";

const DAY = 86_400_000;
const account = "a".repeat(32);
const production = [
  {
    id: "lock-14d",
    enabled: true,
    prefix: "host/snapshots/",
    condition: { type: "Age", maxAgeSeconds: 1_209_600 },
  },
  {
    id: "lock-permanent-objects",
    enabled: true,
    prefix: "host/objects/",
    condition: { type: "Indefinite" },
  },
];
/** The Cloudflare lock API in memory: PUT replaces the whole rule set, like the real one. */
function api(initial: unknown[], { dropOnPut }: { dropOnPut?: string } = {}) {
  let rules = structuredClone(initial) as Array<Record<string, unknown>>;
  const calls: string[] = [];
  const fetchImpl = async (_url: string, init: RequestInit) => {
    calls.push(init.method!);
    if (init.method === "PUT") {
      rules = JSON.parse(init.body as string).rules;
      if (dropOnPut) rules = rules.filter((r) => r.id !== dropOnPut);
    }
    return new Response(JSON.stringify({ success: true, result: { rules } }));
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls, rules: () => rules };
}
const client = (fetchImpl: typeof fetch) =>
  r2LockClient({ accountId: account, bucket: "synthetic-bucket", token: "synthetic", fetchImpl });
const rule = runLockRule("host/cold/", "run123");
const until = Date.UTC(2032, 0, 1, 3);

describe("R2 lock of a cold run", () => {
  it("adds the run's dated rule, keeping every other rule as it was", async () => {
    const fake = api(production);
    expect(await client(fake.fetchImpl).ensure(rule, until)).toBe(Date.UTC(2032, 0, 2));
    expect(fake.rules()).toEqual([
      ...production,
      {
        id: "fnfe-cold-run123",
        enabled: true,
        prefix: "host/cold/run123/",
        condition: { type: "Date", date: "2032-01-02T00:00:00.000Z" },
      },
    ]);
    // Already locked long enough: only reads.
    fake.calls.length = 0;
    await client(fake.fetchImpl).ensure(rule, until - DAY);
    expect(fake.calls).toEqual(["GET"]);
  });
  it("only extends a renewal and never weakens an indefinite rule", async () => {
    const fake = api(production);
    await client(fake.fetchImpl).ensure(rule, until);
    await client(fake.fetchImpl).ensure(rule, until + 365 * DAY);
    expect(fake.rules().at(-1)?.condition).toEqual({
      type: "Date",
      date: lockDate(until + 365 * DAY),
    });
    const indefinite = api([{ ...rule, enabled: true, condition: { type: "Indefinite" } }]);
    expect(await client(indefinite.fetchImpl).ensure(rule, until)).toBe(Infinity);
    expect(indefinite.calls).toEqual(["GET"]);
  });
  it("refuses a rule with another prefix or an age, and a write it cannot read back", async () => {
    await expect(
      client(
        api([{ ...rule, prefix: "host/", enabled: true, condition: { type: "Indefinite" } }])
          .fetchImpl,
      ).ensure(rule, until),
    ).rejects.toThrow("outro prefixo");
    await expect(
      client(
        api([{ ...rule, enabled: true, condition: { type: "Age", maxAgeSeconds: 1 } }]).fetchImpl,
      ).ensure(rule, until),
    ).rejects.toThrow("sem data");
    await expect(
      client(api(production, { dropOnPut: "fnfe-cold-run123" }).fetchImpl).ensure(rule, until),
    ).rejects.toThrow("não confirmado");
    await expect(
      client(api(production, { dropOnPut: "lock-14d" }).fetchImpl).ensure(rule, until),
    ).rejects.toThrow("Outra regra");
  });
  it("stops at the bucket's rule limit and reports only the HTTP status of a failure", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({
      id: `r${i}`,
      enabled: true,
      prefix: `p${i}/`,
      condition: { type: "Indefinite" },
    }));
    await expect(client(api(full).fetchImpl).ensure(rule, until)).rejects.toThrow("Limite");
    const failing = (async () =>
      new Response("secret echo", { status: 403 })) as unknown as typeof fetch;
    await expect(client(failing).ensure(rule, until)).rejects.toThrow(/^R2 lock GET: HTTP 403$/);
  });
});
