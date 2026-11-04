// The quota period of ADR 0012, slice Q: canonical keys, `quotaPeriod`, the anchored counters of
// usage and capacity, the anchor of the rows an annual term grants, the Personalizado rules of
// `usage:assignPlan` and the periods `usage:overview` names. Without an anchor nothing changes.
import { describe, expect, it, vi } from "vite-plus/test";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { civilPeriod, keyPeriod, periodKey, periodKeyStart, quotaPeriod } from "./quotaPeriod";
import { commitUsage, reserveUsage, totalFor } from "./usageCore";
import { commitCapacity, reserveCapacity } from "./capacityCore";
import { grantTerm } from "./planCore";
import { insertTerm } from "./planTerms";
import { termEndsAt } from "./annualTerms";
import { PLATFORM_PLANS } from "./planCatalog";
import {
  person,
  platformTest,
  usePlatformEnvironment,
  type PlatformTest,
} from "../../../tests/helpers/platform";

const NOW = Date.UTC(2026, 9, 27, 12);
usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-quota-period-only",
  now: NOW,
});

const at = (iso: string) => Date.parse(iso);

describe("chaves canônicas", () => {
  it("um início no dia 1 à meia-noite é AAAA-MM; qualquer outro, o ISO exato", () => {
    expect(periodKey(at("2026-11-01T00:00:00.000Z"))).toBe("2026-11");
    expect(periodKey(at("2026-11-15T14:30:00.000Z"))).toBe("2026-11-15T14:30:00.000Z");
    expect(periodKey(at("2026-11-01T00:00:00.001Z"))).toBe("2026-11-01T00:00:00.001Z");
    for (const key of [
      "2026-11",
      "1970-01",
      "2026-11-15T14:30:00.000Z",
      "2026-11-01T00:00:00.001Z",
      "2028-02-29T23:59:59.999Z",
    ])
      expect(periodKey(periodKeyStart(key)!)).toBe(key);
  });

  it("recusa outra escrita do mesmo instante e o ISO de um dia 1 à meia-noite", () => {
    for (const key of [
      "2026-11-15T14:30:00Z",
      "2026-11-15T14:30:00.000+00:00",
      "2026-11-15T14:30:00.000z",
      "2026-11-15 14:30:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2026-11-01",
      "2026-1",
      "2026-00",
      "2026-13",
      "2026-02-30T00:00:00.000Z",
      "+002026-11",
      "+010000-01",
      "stock",
      "",
    ])
      expect(periodKeyStart(key), key).toBeNull();
  });

  it("a ordem alfabética das chaves é a cronológica", () => {
    const starts = [
      at("2026-10-01T00:00:00.000Z"),
      at("2026-10-15T14:30:00.000Z"),
      at("2026-11-01T00:00:00.000Z"),
      at("2026-11-01T00:00:00.001Z"),
      at("2026-11-15T14:30:00.000Z"),
      at("2026-12-01T00:00:00.000Z"),
      at("2027-01-31T10:00:00.000Z"),
    ];
    const keys = starts.map(periodKey);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("quotaPeriod", () => {
  it("sem âncora, ou antes dela, é o mês civil UTC", () => {
    const civil = {
      key: "2026-11",
      startsAt: at("2026-11-01T00:00:00.000Z"),
      endsAt: at("2026-12-01T00:00:00.000Z"),
    };
    expect(quotaPeriod(null, at("2026-11-15T14:30:00.000Z"))).toEqual(civil);
    expect(quotaPeriod({}, at("2026-11-30T23:59:59.999Z"))).toEqual(civil);
    expect(civilPeriod(at("2026-11-01T00:00:00.000Z"))).toEqual(civil);
    const anchor = at("2026-11-15T14:30:00.000Z");
    expect(quotaPeriod({ periodAnchor: anchor }, anchor - 1)).toEqual(civil);
  });

  it("vira no aniversário mensal, ao milissegundo", () => {
    const anchor = at("2026-11-15T14:30:00.000Z");
    const plan = { periodAnchor: anchor };
    const first = {
      key: "2026-11-15T14:30:00.000Z",
      startsAt: anchor,
      endsAt: at("2026-12-15T14:30:00.000Z"),
    };
    expect(quotaPeriod(plan, anchor)).toEqual(first);
    expect(quotaPeriod(plan, first.endsAt - 1)).toEqual(first);
    expect(quotaPeriod(plan, first.endsAt)).toEqual({
      key: "2026-12-15T14:30:00.000Z",
      startsAt: first.endsAt,
      endsAt: at("2027-01-15T14:30:00.000Z"),
    });
  });

  it("ajusta o dia 31 ao fim do mês sem deriva, e o 29/02 em ano bissexto", () => {
    const plan = { periodAnchor: at("2027-01-31T10:00:00.000Z") };
    expect(quotaPeriod(plan, at("2027-02-28T09:59:59.999Z")).key).toBe("2027-01-31T10:00:00.000Z");
    expect(quotaPeriod(plan, at("2027-02-28T10:00:00.000Z"))).toEqual({
      key: "2027-02-28T10:00:00.000Z",
      startsAt: at("2027-02-28T10:00:00.000Z"),
      endsAt: at("2027-03-31T10:00:00.000Z"),
    });
    expect(quotaPeriod(plan, at("2027-03-30T10:00:00.000Z")).key).toBe("2027-02-28T10:00:00.000Z");
    const leap = { periodAnchor: at("2028-01-31T10:00:00.000Z") };
    expect(quotaPeriod(leap, at("2028-02-29T10:00:00.000Z")).startsAt).toBe(
      at("2028-02-29T10:00:00.000Z"),
    );
    const born = { periodAnchor: at("2028-02-29T00:00:00.000Z") };
    expect(quotaPeriod(born, at("2029-02-28T00:00:00.000Z")).key).toBe("2029-02-28T00:00:00.000Z");
    expect(quotaPeriod(born, at("2028-03-29T00:00:00.000Z")).key).toBe("2028-03-29T00:00:00.000Z");
  });

  it("uma âncora no dia 1 à meia-noite dá as chaves de hoje", () => {
    const plan = { periodAnchor: at("2026-11-01T00:00:00.000Z") };
    for (const instant of ["2026-11-01T00:00:00.000Z", "2027-02-28T23:59:59.999Z"])
      expect(quotaPeriod(plan, at(instant))).toEqual(civilPeriod(at(instant)));
  });

  it("keyPeriod só conhece o fim de uma chave ancorada da âncora do plano", () => {
    const plan = { periodAnchor: at("2026-11-15T14:30:00.000Z") };
    expect(keyPeriod(plan, "2026-12-15T14:30:00.000Z")?.endsAt).toBe(
      at("2027-01-15T14:30:00.000Z"),
    );
    expect(keyPeriod(plan, "2026-10")?.endsAt).toBe(at("2026-11-01T00:00:00.000Z"));
    expect(keyPeriod(null, "2026-08-20T09:00:00.000Z")).toEqual({
      key: "2026-08-20T09:00:00.000Z",
      startsAt: at("2026-08-20T09:00:00.000Z"),
      endsAt: null,
    });
    expect(keyPeriod(plan, "2026-11-01T00:00:00.000Z")).toBeNull();
  });
});

function organization(t: PlatformTest) {
  return t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Organização sintética do período de cota",
      slug: crypto.randomUUID(),
      ownerCount: 1,
      memberCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}
type Assignment = FunctionArgs<typeof internal.usage.assignPlan>;
const limits = { imports: 1, captures: 10, registry: 10, bytes: 1000, deliveries: 10 };
const assign = (
  t: PlatformTest,
  args: Partial<Assignment> & { organizationId: Id<"organizations"> },
) =>
  t.mutation(internal.usage.assignPlan, {
    name: "Plano assistido sintético",
    startsAt: NOW,
    endsAt: null,
    limits,
    concurrency: 2,
    actor: "operador-sintetico",
    reason: "Prova do período de cota",
    expectedVersion: 0,
    ...args,
  });
const plan = (t: PlatformTest, organizationId: Id<"organizations">) =>
  t.run((ctx) =>
    ctx.db
      .query("usagePlans")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .unique(),
  );
const configure = (t: PlatformTest) =>
  t.mutation(internal.plans.configure, {
    enabled: true,
    expectedVersion: 0,
    filesBytes: 20 * 2 ** 30,
    databaseBytes: 2 * 2 ** 30,
    custodyCents: 100_000,
    freeMonthlyCents: 10_000,
    admissionsUntil: Date.UTC(2027, 11, 1),
    evidence: "synthetic-quota-period",
  });

describe("contadores de uso pelo período do plano", () => {
  it("um plano ancorado conta pelos aniversários, e a liquidação fica no período da reserva", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const anchor = at("2027-01-31T10:00:00.000Z");
    vi.setSystemTime(anchor);
    await assign(t, { organizationId, startsAt: anchor, periodAnchor: anchor });
    const reserve = (key: string) =>
      t.run((ctx) => reserveUsage(ctx, organizationId, "sandbox", "imports", key));
    const total = (period: string) =>
      t.run((ctx) => totalFor(ctx, organizationId, "sandbox", period, "imports"));
    expect((await reserve("janeiro")).period).toBe("2027-01-31T10:00:00.000Z");
    await expect(reserve("janeiro-de-novo")).rejects.toThrow("QUOTA_EXCEEDED");
    vi.setSystemTime(at("2027-02-28T09:59:59.999Z"));
    await expect(reserve("ainda-janeiro")).rejects.toThrow("QUOTA_EXCEEDED");
    vi.setSystemTime(at("2027-02-28T10:00:00.000Z"));
    expect((await reserve("fevereiro")).period).toBe("2027-02-28T10:00:00.000Z");
    // Committed after the roll, the January reservation stays in its own period.
    await t.run((ctx) => commitUsage(ctx, organizationId, "imports", "janeiro"));
    expect(await total("2027-01-31T10:00:00.000Z")).toMatchObject({ committed: 1, reserved: 0 });
    expect(await total("2027-02-28T10:00:00.000Z")).toMatchObject({ committed: 0, reserved: 1 });
    // The next anniversary is 31/03, from the anchor, not 28/03.
    vi.setSystemTime(at("2027-03-28T10:00:00.000Z"));
    await expect(reserve("fim-de-marco")).rejects.toThrow("QUOTA_EXCEEDED");
    vi.setSystemTime(at("2027-03-31T10:00:00.000Z"));
    expect((await reserve("marco")).period).toBe("2027-03-31T10:00:00.000Z");
    expect(await total("2027-02")).toBeNull();
  });

  it("antes da âncora de um plano agendado, a medição fica no mês civil", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const anchor = at("2026-11-15T14:30:00.000Z");
    await assign(t, { organizationId, startsAt: anchor, periodAnchor: anchor });
    const measured = await t.run((ctx) =>
      reserveUsage(ctx, organizationId, "sandbox", "attempts", "antes", 1, true),
    );
    expect(measured.period).toBe("2026-10");
    vi.setSystemTime(anchor);
    const after = await t.run((ctx) =>
      reserveUsage(ctx, organizationId, "sandbox", "attempts", "depois", 1, true),
    );
    expect(after.period).toBe("2026-11-15T14:30:00.000Z");
  });

  it("o Gratuito do catálogo não tem âncora e continua no mês civil", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    await configure(t);
    const owner = await person(t, organizationId, "owner");
    await owner.mutation(api.plans.claimFree, { organizationId });
    const free = await plan(t, organizationId);
    expect(free).toMatchObject({ catalogTier: "free" });
    expect(free?.periodAnchor).toBeUndefined();
    const event = await t.run((ctx) =>
      reserveUsage(ctx, organizationId, "sandbox", "imports", "gratuito"),
    );
    expect(event.period).toBe("2026-10");
  });

  it("uma linha do Gratuito atribuída à mão não aceita âncora", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    await expect(
      assign(t, { organizationId, catalogTier: "free", periodAnchor: NOW }),
    ).rejects.toThrow("INVALID_REQUEST");
    expect(await plan(t, organizationId)).toBeNull();
  });
});

describe("capacidade pelo período do plano", () => {
  it("leituras e downloads ficam no período ancorado; o estoque continua em stock", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    const anchor = at("2026-10-15T14:30:00.000Z");
    await assign(t, { organizationId, startsAt: anchor, periodAnchor: anchor });
    const event = await t.run((ctx) =>
      reserveCapacity(ctx, organizationId, "restReads", "leitura-1", 1),
    );
    expect(event.period).toBe("2026-10-15T14:30:00.000Z");
    const download = await t.run((ctx) =>
      reserveCapacity(ctx, organizationId, "downloadsBytes", "download-1", 500),
    );
    expect(download.period).toBe("2026-10-15T14:30:00.000Z");
    const stock = await t.run((ctx) =>
      reserveCapacity(ctx, organizationId, "filesBytes", "arquivo-1", 10),
    );
    expect(stock.period).toBe("stock");
    // Settled after the anniversary, the read stays in the period of its reservation.
    vi.setSystemTime(at("2026-11-15T14:30:00.000Z"));
    await t.run((ctx) => commitCapacity(ctx, organizationId, "restReads", "leitura-1"));
    const later = await t.run((ctx) =>
      reserveCapacity(ctx, organizationId, "restReads", "leitura-2", 1),
    );
    expect(later.period).toBe("2026-11-15T14:30:00.000Z");
    const totals = await t.run((ctx) => ctx.db.query("capacityTotals").collect());
    expect(
      totals
        .filter((row) => row.metric === "restReads")
        .map(({ period, committed, reserved }) => ({ period, committed, reserved })),
    ).toEqual([
      { period: "2026-10-15T14:30:00.000Z", committed: 1, reserved: 0 },
      { period: "2026-11-15T14:30:00.000Z", committed: 0, reserved: 1 },
    ]);
  });
});

describe("âncora dos termos anuais", () => {
  async function term(t: PlatformTest, organizationId: Id<"organizations">, firstPeriod: number) {
    return t.run(async (ctx) => {
      const termId = await insertTerm(ctx, {
        organizationId,
        tier: "intermediate",
        firstPeriod,
        endsAt: termEndsAt(firstPeriod),
        source: "pix",
        references: ["synthetic-annual-term"],
        paidCents: PLATFORM_PLANS.intermediate.annualCents,
        purchasedAt: firstPeriod,
        segments: [],
        state: "active",
      });
      await grantTerm(ctx, termId, 0, "operador-sintetico", "Prova da âncora do termo");
      return termId;
    });
  }

  it("a linha concedida por um termo do dia 1 tem a âncora dele e as chaves de hoje", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    await configure(t);
    const firstPeriod = Date.UTC(2026, 9, 1);
    const termId = await term(t, organizationId, firstPeriod);
    expect(await plan(t, organizationId)).toMatchObject({ termId, periodAnchor: firstPeriod });
    const event = await t.run((ctx) =>
      reserveUsage(ctx, organizationId, "sandbox", "imports", "termo"),
    );
    expect(event.period).toBe("2026-10");
  });

  it("um termo iniciado fora do dia 1 conta pelos aniversários dele", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    await configure(t);
    const firstPeriod = at("2026-10-15T14:30:00.000Z");
    await term(t, organizationId, firstPeriod);
    expect((await plan(t, organizationId))?.periodAnchor).toBe(firstPeriod);
    const event = await t.run((ctx) =>
      reserveUsage(ctx, organizationId, "sandbox", "imports", "termo"),
    );
    expect(event.period).toBe("2026-10-15T14:30:00.000Z");
  });
});

describe("usage:assignPlan e a âncora", () => {
  it("com o catálogo desligado, não há âncora por padrão e o operador pode passar uma até startsAt", async () => {
    const t = platformTest();
    const organizationId = await organization(t);
    await assign(t, { organizationId });
    expect((await plan(t, organizationId))?.periodAnchor).toBeUndefined();
    for (const periodAnchor of [NOW + 1000, NOW - 1, -1000, 1.5])
      await expect(assign(t, { organizationId, expectedVersion: 1, periodAnchor })).rejects.toThrow(
        "INVALID_REQUEST",
      );
    await assign(t, { organizationId, expectedVersion: 1, periodAnchor: NOW - 86_400_000 });
    expect((await plan(t, organizationId))?.periodAnchor).toBe(NOW - 86_400_000);
    // The row that replaces an anchored one does not inherit its anchor.
    await assign(t, { organizationId, expectedVersion: 2 });
    expect((await plan(t, organizationId))?.periodAnchor).toBeUndefined();
  });

  describe("com o catálogo ligado", () => {
    const startsAt = NOW - 30_500;
    const anchor = NOW - 31_000;
    const commercial = (organizationId: Id<"organizations">, args: Partial<Assignment>) => ({
      organizationId,
      catalogTier: "custom" as const,
      name: "Contrato comercial sintético",
      startsAt,
      endsAt: at("2026-11-27T11:59:29.000Z"),
      limits: { ...PLATFORM_PLANS.free.limits },
      capacity: { ...PLATFORM_PLANS.free.capacity },
      commercial: {
        monthlyCents: 10_000,
        baseCostCents: 6_000,
        stressCostCents: 6_500,
        custodyCents: 2_500,
        paymentReference: `synthetic-${crypto.randomUUID()}`,
      },
      ...args,
    });

    it("a âncora é startsAt truncado ao segundo, e endsAt é o aniversário que fecha o mês corrente", async () => {
      const t = platformTest();
      const organizationId = await organization(t);
      await configure(t);
      expect(anchor).toBe(at("2026-10-27T11:59:29.000Z"));
      for (const endsAt of [
        Date.UTC(2026, 10, 1),
        at("2026-11-27T11:59:29.500Z"),
        at("2026-12-27T11:59:29.000Z"),
      ])
        await expect(assign(t, commercial(organizationId, { endsAt }))).rejects.toThrow(
          "INVALID_REQUEST",
        );
      await assign(t, commercial(organizationId, {}));
      expect(await plan(t, organizationId)).toMatchObject({
        catalogTier: "custom",
        startsAt,
        periodAnchor: anchor,
        endsAt: at("2026-11-27T11:59:29.000Z"),
      });
    });

    it("aceita uma âncora anterior a startsAt e recusa uma posterior", async () => {
      const t = platformTest();
      const organizationId = await organization(t);
      await configure(t);
      await expect(
        assign(
          t,
          commercial(organizationId, { periodAnchor: NOW, endsAt: Date.UTC(2026, 10, 27, 12) }),
        ),
      ).rejects.toThrow("INVALID_REQUEST");
      await assign(
        t,
        commercial(organizationId, {
          periodAnchor: Date.UTC(2026, 9, 1),
          endsAt: Date.UTC(2026, 10, 1),
        }),
      );
      expect((await plan(t, organizationId))?.periodAnchor).toBe(Date.UTC(2026, 9, 1));
    });
  });
});

describe("usage:overview", () => {
  async function fixture() {
    const t = platformTest();
    const organizationId = await organization(t);
    // A session of its own per read: the clock moves past a session's hour in some cases.
    const view = async (args: { period?: string; asOf?: number }) =>
      (await person(t, organizationId, "owner")).query(api.usage.overview, {
        organizationId,
        contextKey: "test",
        ...args,
      });
    const reserve = (key: string) =>
      t.run((ctx) => reserveUsage(ctx, organizationId, "sandbox", "attempts", key, 1, true));
    return { t, organizationId, view, reserve };
  }

  it("com o período de antes, responde o mês civil, e recusa uma chave não canônica", async () => {
    const f = await fixture();
    await f.reserve("outubro");
    const view = await f.view({ period: "2026-10" });
    expect(view.period).toEqual(civilPeriod(NOW));
    expect(view.recent).toEqual([civilPeriod(NOW)]);
    expect(view.current).toBeNull();
    // The last instant a key names is the end of 9999.
    expect((await f.view({ asOf: 253402300799999 })).period.key).toBe("9999-12");
    expect(view.environments.sandbox.find((row) => row.metric === "attempts")).toMatchObject({
      reserved: 1,
    });
    for (const args of [
      {},
      { period: "2026-10-01T00:00:00.000Z" },
      { period: "2026-10-15T14:30:00Z" },
      { asOf: -1 },
      { asOf: 1.5 },
      { asOf: 253402300800000 },
    ])
      await expect(f.view(args)).rejects.toThrow("INVALID_REQUEST");
  });

  it("com asOf, resolve o período do plano e lista os recentes, do mais novo ao mais antigo", async () => {
    const f = await fixture();
    await f.reserve("outubro-civil");
    const anchor = at("2026-10-27T12:00:00.000Z");
    await assign(f.t, { organizationId: f.organizationId, startsAt: anchor, periodAnchor: anchor });
    await f.reserve("primeiro-mes");
    vi.setSystemTime(at("2026-11-27T12:00:00.000Z"));
    await f.reserve("segundo-mes");
    await f.reserve("segundo-mes-2");
    const first = {
      key: "2026-10-27T12:00:00.000Z",
      startsAt: anchor,
      endsAt: at("2026-11-27T12:00:00.000Z"),
    };
    const second = {
      key: "2026-11-27T12:00:00.000Z",
      startsAt: first.endsAt,
      endsAt: at("2026-12-27T12:00:00.000Z"),
    };
    const current = await f.view({ asOf: Date.now() });
    expect(current.period).toEqual(second);
    expect(current.current).toEqual(second);
    expect(current.plan?.periodAnchor).toBe(anchor);
    expect(current.recent).toEqual([second, first, civilPeriod(NOW)]);
    const attempts = (view: typeof current) =>
      view.environments.sandbox.find((row) => row.metric === "attempts")?.reserved;
    expect(attempts(current)).toBe(2);
    // Before the anniversary, `asOf` still reads the first anchored month.
    expect((await f.view({ asOf: first.endsAt - 1 })).period).toEqual(first);
    const past = await f.view({ period: first.key, asOf: Date.now() });
    expect(past.period).toEqual(first);
    expect(attempts(past)).toBe(1);
    // A period with no usage yet is listed too, as the one holding `asOf`.
    const next = await f.view({ asOf: second.endsAt });
    expect(next.recent[0]).toMatchObject({ key: "2026-12-27T12:00:00.000Z" });
    expect(attempts(next)).toBe(0);
  });
});
