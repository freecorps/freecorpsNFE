import { describe, expect, it } from "vite-plus/test";
import {
  cloudflareLocks,
  guardEnd,
  mergeRules,
  packageRules,
  yearRules,
} from "./lib/cold-tier-locks.mjs";

describe("lock rules of the cold tier (ADR 0010, decision 6)", () => {
  it("locks each guard year until 01/01 of the next, 00:00 in Brasília", () => {
    expect(guardEnd(2031)).toBe("2032-01-01T03:00:00.000Z");
    expect(yearRules(2026, 2027)).toEqual([
      {
        id: "guard-2026",
        enabled: true,
        prefix: "documents/production/guard-2026/",
        condition: { type: "Date", date: "2027-01-01T03:00:00.000Z" },
      },
      {
        id: "guard-2027",
        enabled: true,
        prefix: "documents/production/guard-2027/",
        condition: { type: "Date", date: "2028-01-01T03:00:00.000Z" },
      },
    ]);
    expect(() => yearRules(2030, 2029)).toThrow("Anos de guarda inválidos");
  });

  it("extends only Production years that end before the package, never Sandbox", () => {
    const rules = packageRules({
      runId: "run1",
      retainUntil: Date.UTC(2033, 0, 1, 3),
      references: [
        { key: "documents/production/guard-2031/org1/v1/content-a.gz" },
        { key: "documents/production/guard-2031/org1/v2/content-b.gz" },
        { key: "documents/production/guard-2040/org1/v3/content-c.gz" },
        { key: "documents/sandbox/org1/v4/content-d.gz" },
      ],
    });
    expect(rules.map((rule) => rule.prefix)).toEqual(["documents/production/guard-2031/org1/"]);
  });

  it("adds and extends rules, never shortens or removes one", () => {
    const [y2031] = yearRules(2031, 2031);
    const other = { id: "outra", enabled: true, prefix: "x/", condition: { type: "Indefinite" } };
    expect(mergeRules([y2031!, other], [y2031!])).toBeNull();
    const shorter = { ...y2031!, condition: { type: "Date", date: "2031-06-01T00:00:00.000Z" } };
    expect(mergeRules([y2031!], [shorter])).toBeNull();
    const longer = { ...y2031!, condition: { type: "Date", date: "2040-01-01T00:00:00.000Z" } };
    expect(mergeRules([y2031!, other], [longer])).toEqual([longer, other]);
    expect(() => mergeRules([y2031!], [{ ...y2031!, prefix: "y/" }])).toThrow("divergente");
  });

  it("reads, writes and reads back the bucket's rules", async () => {
    let stored: unknown[] = [];
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.method!);
      if (init.method === "PUT") stored = JSON.parse(init.body as string).rules;
      return Response.json({ result: { rules: stored } });
    }) as unknown as typeof fetch;
    const locks = cloudflareLocks({ accountId: "acc", bucket: "fnfe-cold", token: "t", fetchImpl });
    expect(await locks.ensure(yearRules(2026, 2030))).toEqual({ changed: true, rules: 5 });
    expect(await locks.ensure(yearRules(2026, 2030))).toEqual({ changed: false, rules: 5 });
    expect(calls).toEqual(["GET", "PUT", "GET", "GET", "GET"]);
  });

  it("fails when the bucket kept a shorter date than the one written", async () => {
    let stored: { condition: { date: string } }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init.method === "PUT")
        stored = (JSON.parse(init.body as string).rules as typeof stored).map((rule) => ({
          ...rule,
          condition: { ...rule.condition, date: "2027-01-01T00:00:00.000Z" },
        }));
      return Response.json({ result: { rules: stored } });
    }) as unknown as typeof fetch;
    const locks = cloudflareLocks({ accountId: "acc", bucket: "fnfe-cold", token: "t", fetchImpl });
    await expect(locks.ensure(yearRules(2031, 2031))).rejects.toThrow("Regra de lock ausente");
  });
});
