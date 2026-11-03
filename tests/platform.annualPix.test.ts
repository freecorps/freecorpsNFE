import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { enablePix, platformTest, person, usePlatformEnvironment } from "./helpers/platform";
import { termEndsAt } from "../platform/convex/lib/annualTerms";
import { activateCatalogPlan } from "../platform/convex/lib/planCore";
import { insertTerm, termTierAt } from "../platform/convex/lib/planTerms";
import { archiveStatus } from "../platform/convex/lib/coldArchiveCore";
import { checkUsage, reserveUsage } from "../platform/convex/lib/usageCore";
import { PLATFORM_PLANS } from "../platform/convex/lib/planCatalog";
import * as plansModule from "../platform/convex/plans";

/** The annual plan sold by assisted Pix (ADR 0010, decision 9), server side only. */
const OCT = Date.UTC(2026, 9, 10, 12);
const OCT_1 = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);
usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-annual-pix-only",
  now: OCT,
});

type Tier = "intermediate" | "large";
async function fixture({ annual = true } = {}) {
  const t = platformTest();
  const org = (name: string) =>
    t.run((ctx) =>
      ctx.db.insert("organizations", {
        name,
        slug: crypto.randomUUID(),
        ownerCount: 1,
        memberCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  const organizationId = await org("Organização sintética");
  const owner = await person(t, organizationId, "owner");
  await t.mutation(internal.plans.configure, {
    enabled: true,
    expectedVersion: 0,
    filesBytes: 10 * 2 ** 30,
    databaseBytes: 2 ** 30,
    custodyCents: 1_000_000,
    freeMonthlyCents: 10000,
    admissionsUntil: Date.UTC(2027, 11, 31),
    evidence: "synthetic-local-proof",
  });
  await enablePix(t);
  if (annual)
    await t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
  const plan = (id = organizationId) =>
    t.run((ctx) =>
      ctx.db
        .query("usagePlans")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", id))
        .unique(),
    );
  const terms = () => t.run((ctx) => ctx.db.query("platformPlanTerms").collect());
  return { t, org, organizationId, owner, plan, terms };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Member = Fixture["owner"];
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: { code?: string } | string }) =>
      typeof error.data === "string" ? error.data : (error.data?.code ?? "ERROR"),
  );

const requestAnnual = (
  member: Member,
  organizationId: Id<"organizations">,
  start: "now" | "next",
  key = `annual-${start}-key`,
  tier: Tier = "intermediate",
) => member.mutation(api.plans.requestPaid, { organizationId, tier, key, cycle: "annual", start });
const confirm = (
  f: Fixture,
  requestId: Id<"platformPlanRequests">,
  paymentReference: string,
  amountCents = 149000,
) =>
  f.t.mutation(internal.plans.confirmPayment, {
    requestId,
    amountCents,
    paymentReference,
    actor: "operator",
  });
async function payMonthly(f: Fixture, member: Member, organizationId: Id<"organizations">) {
  const tier: Tier = "intermediate";
  const request = await member.mutation(api.plans.requestPaid, {
    organizationId,
    tier,
    key: `monthly-${organizationId}`,
  });
  await confirm(f, request.id, `monthly-ref-${organizationId}`, request.amountCents);
}
/** Runs what the scheduler has due at `at`, as the deployment would. */
async function runUntil(f: Fixture, at: number) {
  vi.advanceTimersByTime(at - Date.now());
  await f.t.finishInProgressScheduledFunctions();
}

describe("pedido anual por Pix", () => {
  it("é recusado com o anual desligado e exige o início só no anual", async () => {
    const f = await fixture({ annual: false });
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe("ANNUAL_DISABLED");
    const g = await fixture();
    expect(
      await code(
        g.owner.mutation(api.plans.requestPaid, {
          organizationId: g.organizationId,
          tier: "intermediate",
          key: "annual-without-start",
          cycle: "annual",
        }),
      ),
    ).toBe("INVALID_REQUEST");
    expect(
      await code(
        g.owner.mutation(api.plans.requestPaid, {
          organizationId: g.organizationId,
          tier: "intermediate",
          key: "monthly-with-start",
          start: "next",
        }),
      ),
    ).toBe("INVALID_REQUEST");
    expect(await g.t.run((ctx) => ctx.db.query("platformPlanRequests").collect())).toEqual([]);
  });

  it("com o catálogo desligado, o anual ligado ainda responde ANNUAL_DISABLED", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { enabled: false });
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "next"))).toBe("ANNUAL_DISABLED");
  });

  it("cobra o annualCents e começa no dia 1 deste mês ou do seguinte", async () => {
    const f = await fixture();
    const now = await requestAnnual(f.owner, f.organizationId, "now", "annual-now-key", "large");
    expect(now).toMatchObject({ amountCents: PLATFORM_PLANS.large.annualCents, period: "2026-10" });
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", now.id))).toMatchObject({
      cycle: "annual",
      firstPeriod: OCT_1,
      endsAt: NOV,
    });
    await f.owner.mutation(api.plans.cancelRequest, {
      organizationId: f.organizationId,
      requestId: now.id,
    });
    const next = await requestAnnual(f.owner, f.organizationId, "next");
    expect(next).toMatchObject({ amountCents: 149000, period: "2026-11" });
    // The deadline is the end of the term's first month.
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", next.id))).toMatchObject({
      firstPeriod: NOV,
      endsAt: DEC,
    });
    // The intent reserves nothing.
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanAllocations").collect())).toEqual([]);
  });

  it("recusa papel sem gestão, sessão sem vínculo e o pedido de outra organização", async () => {
    const f = await fixture();
    for (const role of ["developer", "operator", "viewer"] as const) {
      const member = await person(f.t, f.organizationId, role);
      expect(await code(requestAnnual(member, f.organizationId, "now", `annual-${role}`))).toBe(
        "ACCESS_DENIED",
      );
    }
    expect(await code(requestAnnual(f.t as unknown as Member, f.organizationId, "now"))).toBe(
      "UNAUTHENTICATED",
    );
    const other = await f.org("Outra organização");
    const outsider = await person(f.t, other, "owner");
    expect(await code(requestAnnual(outsider, f.organizationId, "now"))).toBe("ACCESS_DENIED");
    const foreign = await requestAnnual(outsider, other, "now");
    expect(
      await code(
        f.owner.mutation(api.plans.cancelRequest, {
          organizationId: f.organizationId,
          requestId: foreign.id,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", foreign.id))).toMatchObject({
      state: "awaiting_payment",
    });
  });

  it("repete o mesmo pedido pela chave e recusa a mesma chave com outra escolha", async () => {
    const f = await fixture();
    const first = await requestAnnual(f.owner, f.organizationId, "now");
    expect(await requestAnnual(f.owner, f.organizationId, "now")).toEqual(first);
    expect(await code(requestAnnual(f.owner, f.organizationId, "next", "annual-now-key"))).toBe(
      "OPERATION_CONFLICT",
    );
    expect(
      await code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "annual-now-key",
        }),
      ),
    ).toBe("OPERATION_CONFLICT");
  });

  it("fechada a janela de admissão, o anual do plano já reservado vale e a nova reserva não", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").first())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { admissionsUntil: OCT - 1 });
    });
    expect(
      await code(requestAnnual(f.owner, f.organizationId, "next", "annual-larger", "large")),
    ).toBe("PLAN_UNAVAILABLE");
    const other = await f.org("Sem reserva");
    const otherOwner = await person(f.t, other, "owner");
    expect(await code(requestAnnual(otherOwner, other, "next"))).toBe("PLAN_UNAVAILABLE");
    const same = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, same.id, "annual-same-tier-ref");
    expect(await f.terms()).toMatchObject([{ state: "scheduled", tier: "intermediate" }]);
  });

  it("começar agora não desce de plano no meio do mês", async () => {
    const f = await fixture();
    const request = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "large",
      key: "monthly-large",
    });
    await confirm(f, request.id, "monthly-large-ref", request.amountCents);
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe("PLAN_UNAVAILABLE");
    expect(await code(requestAnnual(f.owner, f.organizationId, "next"))).toBe("OK");
  });

  it("com o Pix desligado responde PIX_DISABLED; com o anual também desligado, ANNUAL_DISABLED", async () => {
    const f = await fixture();
    await f.t.mutation(internal.plans.configurePix, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-pix-off",
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe("PIX_DISABLED");
    expect(await code(requestAnnual(f.owner, f.organizationId, "next"))).toBe("PIX_DISABLED");
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 3,
      evidence: "synthetic-annual-off",
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe("ANNUAL_DISABLED");
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanRequests").collect())).toEqual([]);
  });
});

describe("confirmação do anual por Pix", () => {
  it("começando agora, cria um termo ativo e concede o plano até o fim do termo, uma vez", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    expect(await code(confirm(f, request.id, "annual-now-ref", 149000 - 1))).toBe(
      "PLAN_REQUEST_UNAVAILABLE",
    );
    await confirm(f, request.id, "annual-now-ref");
    await confirm(f, request.id, "annual-now-ref");
    const [term, ...rest] = await f.terms();
    expect(rest).toEqual([]);
    expect(term).toMatchObject({
      organizationId: f.organizationId,
      tier: "intermediate",
      firstPeriod: OCT_1,
      endsAt: termEndsAt(OCT_1),
      source: "pix",
      references: ["annual-now-ref"],
      paidCents: 149000,
      purchasedAt: OCT,
      segments: [],
      state: "active",
    });
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: term!._id,
      endsAt: term!.endsAt,
      version: 2,
    });
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      state: "activated",
      paymentReference: "annual-now-ref",
    });
    // A second annual waits for this one to end.
    expect(await code(requestAnnual(f.owner, f.organizationId, "next", "annual-second"))).toBe(
      "ANNUAL_TERM_ACTIVE",
    );
  });

  it("as cotas continuam mensais e o Pix mensal do mês seguinte é recusado", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    await confirm(f, request.id, "annual-quota-ref");
    const limit = PLATFORM_PLANS.intermediate.limits.imports;
    await f.t.run((ctx) =>
      reserveUsage(ctx, f.organizationId, "production", "imports", "october-fill", limit),
    );
    const another = (key: string) =>
      code(f.t.run((ctx) => checkUsage(ctx, f.organizationId, "production", "imports", key)));
    expect(await another("october-more")).toBe("QUOTA_EXCEEDED");
    vi.setSystemTime(NOV + 3600_000);
    expect(await another("november-first")).toBe("OK");
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      await code(
        owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "large",
          key: "monthly-under-annual",
        }),
      ),
    ).toBe("ANNUAL_TERM_ACTIVE");
  });

  it("começando no mês seguinte, agenda o termo e só troca o plano no dia 1", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const monthly = await f.plan();
    const request = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, request.id, "annual-next-ref");
    const [term] = await f.terms();
    expect(term).toMatchObject({ state: "scheduled", firstPeriod: NOV, endsAt: termEndsAt(NOV) });
    expect(await f.plan()).toEqual(monthly);
    await runUntil(f, NOV - 1);
    expect(await f.plan()).toEqual(monthly);
    await runUntil(f, NOV);
    expect(await f.terms()).toMatchObject([{ state: "active" }]);
    const annual = await f.plan();
    expect(annual).toMatchObject({
      catalogTier: "intermediate",
      termId: term!._id,
      startsAt: NOV,
      endsAt: termEndsAt(NOV),
      version: 2,
    });
    // Running it again, late or twice, changes nothing.
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    expect(await f.plan()).toEqual(annual);
  });

  it("um termo rescindido antes do dia 1 não é ativado", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, request.id, "annual-rescinded-ref");
    const [term] = await f.terms();
    await f.t.run((ctx) => ctx.db.patch("platformPlanTerms", term!._id, { state: "rescinded" }));
    await runUntil(f, NOV);
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    expect(await f.plan()).toBeNull();
    expect(await f.terms()).toMatchObject([{ state: "rescinded" }]);
  });

  it("uma ativação recusada fica registrada no termo e o operador a repete", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, request.id, "annual-blocked-ref");
    const [term] = await f.terms();
    const catalog = (enabled: boolean) =>
      f.t.run(async (ctx) => {
        const settings = (await ctx.db.query("platformPlanSettings").first())!;
        await ctx.db.patch("platformPlanSettings", settings._id, { enabled });
      });
    await catalog(false);
    await runUntil(f, NOV);
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "PLANS_DISABLED" }]);
    expect(await f.plan()).toBeNull();
    await catalog(true);
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    const [active] = await f.terms();
    expect(active).toMatchObject({ state: "active" });
    expect(active).not.toHaveProperty("blockedCode");
    expect(await f.plan()).toMatchObject({ termId: term!._id, endsAt: termEndsAt(NOV) });
  });

  it("pago até o fim do primeiro mês do termo; depois, é recusado", async () => {
    const f = await fixture();
    const now = await requestAnnual(f.owner, f.organizationId, "now");
    const g = await fixture();
    const next = await requestAnnual(g.owner, g.organizationId, "next");
    const h = await fixture();
    const late = await requestAnnual(h.owner, h.organizationId, "next");
    vi.setSystemTime(NOV);
    expect(await code(confirm(f, now.id, "annual-late-now"))).toBe("PLAN_REQUEST_UNAVAILABLE");
    expect(await f.terms()).toEqual([]);
    // Paid within November, the term's first month: it starts at once.
    vi.setSystemTime(NOV + 86400_000);
    await confirm(g, next.id, "annual-next-in-november");
    expect(await g.terms()).toMatchObject([{ state: "active", firstPeriod: NOV }]);
    expect(await g.plan()).toMatchObject({ startsAt: NOV + 86400_000, endsAt: termEndsAt(NOV) });
    vi.setSystemTime(DEC);
    expect(await code(confirm(h, late.id, "annual-late-next"))).toBe("PLAN_REQUEST_UNAVAILABLE");
    expect(await h.terms()).toEqual([]);
  });

  it("recusa a referência de pagamento já usada, inclusive por outra organização", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const other = await f.org("Outra organização");
    const otherOwner = await person(f.t, other, "owner");
    const request = await requestAnnual(otherOwner, other, "now");
    expect(await code(confirm(f, request.id, `monthly-ref-${f.organizationId}`))).toBe(
      "OPERATION_CONFLICT",
    );
    expect(await f.terms()).toEqual([]);
    await confirm(f, request.id, "annual-other-ref");
    // Each organization keeps its own plan; the other's term does not touch this one.
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: NOV });
    expect(await f.plan()).not.toHaveProperty("termId");
    expect(await f.plan(other)).toMatchObject({ endsAt: termEndsAt(OCT_1) });
  });

  it("desligar o anual depois do pedido não recusa a confirmação", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "now", "annual-after-off"))).toBe(
      "ANNUAL_DISABLED",
    );
    await confirm(f, request.id, "annual-after-switch-off");
    expect(await f.terms()).toMatchObject([{ state: "active" }]);
  });
});

describe("activateCatalogPlan com termo", () => {
  const insert = (f: Fixture, state: "scheduled" | "active" | "rescinded" = "active") =>
    f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "pix",
        references: ["synthetic-term-ref"],
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state,
      }),
    );
  const grant = (
    f: Fixture,
    termId: Id<"platformPlanTerms">,
    { tier = "intermediate" as Tier, startsAt = OCT, endsAt = termEndsAt(OCT_1) } = {},
  ) =>
    code(
      f.t.run((ctx) =>
        activateCatalogPlan(
          ctx,
          f.organizationId,
          tier,
          startsAt,
          endsAt,
          0,
          "operator",
          "Anual sintético",
          termId,
        ),
      ),
    );

  it("recusa tier, início, fim ou estado que não sejam os do termo", async () => {
    const f = await fixture();
    const termId = await insert(f);
    expect(await grant(f, termId, { tier: "large" })).toBe("INVALID_REQUEST");
    expect(await grant(f, termId, { startsAt: OCT_1 - 1 })).toBe("INVALID_REQUEST");
    expect(await grant(f, termId, { startsAt: termEndsAt(OCT_1) })).toBe("INVALID_REQUEST");
    expect(await grant(f, termId, { endsAt: NOV })).toBe("INVALID_REQUEST");
    expect(await f.plan()).toBeNull();
    expect(await grant(f, termId)).toBe("OK");
    const g = await fixture();
    expect(await grant(g, await insert(g, "rescinded"))).toBe("INVALID_REQUEST");
    expect(await grant(g, await insert(g, "scheduled"))).toBe("OK");
  });
});

describe("revisão: versão, renovação, pedidos e bloqueios", () => {
  it("começar agora recusa um plano alterado depois do pedido, como o mensal", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    await f.t.run((ctx) =>
      activateCatalogPlan(ctx, f.organizationId, "free", OCT, null, 0, "operator", "Sintético"),
    );
    expect(await code(confirm(f, request.id, "annual-stale-version"))).toBe("OPERATION_CONFLICT");
    expect(await f.terms()).toEqual([]);
    expect(await f.plan()).toMatchObject({ catalogTier: "free", version: 1 });
  });

  it("no último mês do termo, o anual seguinte renova sem intervalo", async () => {
    const f = await fixture();
    // November 2025 to November 2026: October is its last month.
    const firstPeriod = Date.UTC(2025, 10, 1);
    const old = await f.t.run(async (ctx) => {
      const termId = await insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod,
        endsAt: NOV,
        source: "pix",
        references: ["annual-2025-ref"],
        paidCents: 149000,
        purchasedAt: firstPeriod,
        segments: [],
        state: "active",
      });
      await activateCatalogPlan(
        ctx,
        f.organizationId,
        "intermediate",
        OCT,
        NOV,
        0,
        "operator",
        "Anual sintético",
        termId,
      );
      return termId;
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe("ANNUAL_TERM_ACTIVE");
    const renewal = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, renewal.id, "annual-renewal-ref");
    // Same tier: the renewal reserves nothing more, at confirmation or on the 1st.
    const stock = () =>
      f.t.run(async (ctx) => {
        const settings = (await ctx.db.query("platformPlanSettings").unique())!;
        const allocations = await ctx.db.query("platformPlanAllocations").collect();
        return {
          totals: [
            settings.allocatedFilesBytes,
            settings.allocatedDatabaseBytes,
            settings.allocatedCustodyCents,
            settings.allocatedFreeMonthlyCents,
          ],
          allocations: allocations.map((row) => [
            row.tier,
            row.filesBytes,
            row.databaseBytes,
            row.custodyCents,
            row.freeMonthlyCents,
          ]),
        };
      });
    const before = await stock();
    const renewed = (await f.terms()).find((term) => term._id !== old)!;
    expect(renewed).toMatchObject({ state: "scheduled", firstPeriod: NOV });
    // A second scheduled term is refused, even for a later month.
    expect(await code(requestAnnual(f.owner, f.organizationId, "next", "annual-third"))).toBe(
      "ANNUAL_TERM_ACTIVE",
    );
    expect(await f.plan()).toMatchObject({ termId: old, endsAt: NOV });
    await runUntil(f, NOV);
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanTerms", renewed._id))).toMatchObject({
      state: "active",
    });
    expect(await stock()).toEqual(before);
    expect(await f.plan()).toMatchObject({
      termId: renewed._id,
      startsAt: NOV,
      endsAt: termEndsAt(NOV),
      version: 2,
    });
  });

  it("a mesma chave ainda responde depois de o anual ser desligado", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "next");
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await requestAnnual(f.owner, f.organizationId, "next")).toEqual(request);
  });

  it("um pedido mensal e um anual não ficam pendentes juntos", async () => {
    const f = await fixture();
    const monthly = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "monthly-pending",
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "next"))).toBe(
      "PLAN_REQUEST_PENDING",
    );
    await f.owner.mutation(api.plans.cancelRequest, {
      organizationId: f.organizationId,
      requestId: monthly.id,
    });
    await requestAnnual(f.owner, f.organizationId, "next");
    expect(
      await code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "monthly-after-annual",
        }),
      ),
    ).toBe("PLAN_REQUEST_PENDING");
  });

  it("concede o tier do segmento em vigor no mês do início", async () => {
    const f = await fixture();
    const SEP_1 = Date.UTC(2026, 8, 1);
    const term = {
      organizationId: f.organizationId,
      tier: "intermediate" as const,
      firstPeriod: SEP_1,
      endsAt: termEndsAt(SEP_1),
      source: "pix" as const,
      references: ["annual-segment-ref"],
      paidCents: 149000,
      purchasedAt: SEP_1,
      segments: [{ tier: "large" as const, fromPeriod: OCT_1 }],
      state: "active" as const,
    };
    expect(termTierAt(term, SEP_1 + 86400_000)).toBe("intermediate");
    expect(termTierAt(term, OCT)).toBe("large");
    const termId = await f.t.run((ctx) => insertTerm(ctx, term));
    const grant = (tier: Tier, startsAt: number, version: number) =>
      code(
        f.t.run((ctx) =>
          activateCatalogPlan(
            ctx,
            f.organizationId,
            tier,
            startsAt,
            term.endsAt,
            version,
            "operator",
            "Anual sintético",
            termId,
          ),
        ),
      );
    expect(await grant("large", SEP_1, 0)).toBe("INVALID_REQUEST");
    expect(await grant("intermediate", SEP_1, 0)).toBe("OK");
    expect(await grant("intermediate", OCT, 1)).toBe("INVALID_REQUEST");
    expect(await grant("large", OCT, 1)).toBe("OK");
  });

  it("registra TERM_ENDED e ORGANIZATION_ARCHIVING sem conceder o plano", async () => {
    const f = await fixture();
    const late = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, late.id, "annual-ended-ref");
    const [ended] = await f.terms();
    vi.setSystemTime(termEndsAt(NOV));
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: ended!._id });
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "TERM_ENDED" }]);
    expect(await f.plan()).toBeNull();
    // Running it again stays blocked, and the ended term no longer stops a new annual sale.
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: ended!._id });
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "TERM_ENDED" }]);
    const owner = await person(f.t, f.organizationId, "owner");
    expect(await code(requestAnnual(owner, f.organizationId, "next", "annual-after-ended"))).toBe(
      "OK",
    );

    vi.setSystemTime(OCT);
    const g = await fixture();
    const request = await requestAnnual(g.owner, g.organizationId, "next");
    await confirm(g, request.id, "annual-archiving-ref");
    const [term] = await g.terms();
    // An archived organization buys plans; its rehydration may start before the 1st.
    await g.t.run((ctx) =>
      ctx.db.insert("coldArchiveRuns", {
        organizationId: g.organizationId,
        key: "synthetic-restoring",
        version: 1,
        state: "restoring",
        reason: "paid_expired",
        noticeAt: OCT,
        eligibleAt: OCT,
        retainUntil: DEC,
        createdAt: OCT,
        updatedAt: OCT,
        phase: 0,
        cursor: null,
        rows: 0,
        files: 0,
        bytes: 0,
        digest: "",
      }),
    );
    vi.setSystemTime(NOV);
    await g.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    expect(await g.terms()).toMatchObject([
      { state: "scheduled", blockedCode: "ORGANIZATION_ARCHIVING" },
    ]);
    expect(await g.plan()).toBeNull();
  });
});

describe("custódia fria com termo anual", () => {
  /** A paid monthly plan ended on the 1st and Production use, so only the term keeps it hot. */
  async function expired(f: Fixture) {
    await f.t.run(async (ctx) => {
      await ctx.db.insert("usagePlans", {
        organizationId: f.organizationId,
        catalogTier: "intermediate",
        name: "Intermediário",
        startsAt: Date.UTC(2026, 8, 1),
        endsAt: OCT_1,
        limits: PLATFORM_PLANS.intermediate.limits,
        capacity: PLATFORM_PLANS.intermediate.capacity,
        concurrency: 1,
        version: 1,
        updatedAt: OCT_1,
      });
      await ctx.db.insert("usageTotals", {
        organizationId: f.organizationId,
        environment: "production",
        period: "2026-09",
        metric: "imports",
        committed: 1,
        reserved: 0,
        updatedAt: OCT_1,
        startedAt: OCT_1,
      });
    });
  }
  const notice = (f: Fixture, key: string) =>
    f.t.mutation(internal.coldArchive.notice, { organizationId: f.organizationId, key });
  const run = (f: Fixture) => f.t.run((ctx) => archiveStatus(ctx, f.organizationId));

  it("confirmar um anual agendado encerra o aviso e impede outro", async () => {
    vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled");
    const f = await fixture();
    await expired(f);
    await notice(f, "synthetic-notice-1");
    expect(await run(f)).toMatchObject({ state: "notice" });
    const request = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, request.id, "annual-notice-ref");
    expect(await run(f)).toMatchObject({ state: "hot", noticeEnded: { by: "plan" } });
    await expect(notice(f, "synthetic-notice-2")).rejects.toThrow("ARCHIVE_PAID_ACTIVE");
  });

  it("não congela com termo em vigor e volta a ser elegível quando ele termina", async () => {
    vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled");
    const f = await fixture();
    await expired(f);
    const runId = await notice(f, "synthetic-notice-1");
    // A term written without the confirmation, so the notice stays pending.
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "pix",
        references: ["annual-freeze-ref"],
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state: "active",
      }),
    );
    vi.setSystemTime(OCT + 31 * 86400_000);
    await expect(f.t.mutation(internal.coldArchive.freeze, { runId, version: 1 })).rejects.toThrow(
      "ARCHIVE_PAID_ACTIVE",
    );
    vi.setSystemTime(termEndsAt(OCT_1));
    await f.t.mutation(internal.coldArchive.freeze, { runId, version: 1 });
    expect(await run(f)).toMatchObject({ state: "frozen" });
  });
});

describe("upgrade do Intermediário anual para o Grande anual por Pix", () => {
  const FEB = Date.UTC(2027, 1, 10, 12);
  const FEB_1 = Date.UTC(2027, 1, 1);
  const END = termEndsAt(OCT_1);
  /** A session lasts an hour: the owner signs in again after each jump in time. */
  const requestUpgrade = async (
    f: Fixture,
    key = "annual-upgrade-key",
    tier: Tier = "large",
    member?: Member,
  ) =>
    (member ?? (await person(f.t, f.organizationId, "owner"))).mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier,
      key,
      cycle: "annual",
      start: "upgrade",
    });
  /** An Intermediário annual by Pix from October 2026, active now. */
  async function annualNow(f: Fixture) {
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    await confirm(f, request.id, "annual-pix-ref");
    return (await f.terms())[0]!;
  }
  const custody = (f: Fixture) =>
    f.t.run(async (ctx) => ({
      settings: (await ctx.db.query("platformPlanSettings").unique())!.allocatedCustodyCents,
      organization: (await ctx.db.query("platformPlanAllocations").unique())?.custodyCents,
    }));

  it("cobra a diferença pelos meses restantes, mantém o fim do termo e reserva o aporte do Grande", async () => {
    const f = await fixture();
    const term = await annualNow(f);
    expect(await custody(f)).toEqual({ settings: 10800, organization: 10800 });
    // February: February to September, 8 months left, the current one whole.
    vi.setSystemTime(FEB);
    const request = await requestUpgrade(f);
    expect(request).toEqual({ id: request.id, amountCents: 233333, period: "2027-02" });
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      tier: "large",
      cycle: "annual",
      termId: term._id,
      firstPeriod: FEB_1,
      endsAt: Date.UTC(2027, 2, 1),
      state: "awaiting_payment",
    });
    // The intent reserves nothing, and repeating it answers the same request.
    expect(await custody(f)).toEqual({ settings: 10800, organization: 10800 });
    expect(await requestUpgrade(f)).toEqual(request);
    await confirm(f, request.id, "annual-upgrade-ref", 233333);
    const [upgraded] = await f.terms();
    expect(upgraded).toMatchObject({
      _id: term._id,
      state: "active",
      tier: "intermediate",
      firstPeriod: OCT_1,
      endsAt: END,
      segments: [{ tier: "large", fromPeriod: FEB_1 }],
      references: ["annual-pix-ref", "annual-upgrade-ref"],
      paidCents: 149000 + 233333,
      purchasedAt: OCT,
      upgrades: [
        {
          fromTier: "intermediate",
          tier: "large",
          fromPeriod: FEB_1,
          reference: "annual-upgrade-ref",
          paidCents: 233333,
          paidAt: FEB,
        },
      ],
    });
    expect(termTierAt(upgraded!, FEB)).toBe("large");
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      termId: term._id,
      startsAt: FEB,
      endsAt: END,
      version: 2,
    });
    // The Freecorps complements the custody fund from R$ 108 to R$ 280 before granting.
    expect(await custody(f)).toEqual({ settings: 28000, organization: 28000 });
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      state: "activated",
      paymentReference: "annual-upgrade-ref",
    });
    // A repeated confirmation changes nothing; another upgrade has nothing left to raise.
    await confirm(f, request.id, "annual-upgrade-ref", 233333);
    expect(await f.terms()).toEqual([upgraded]);
    expect(await code(requestUpgrade(f, "annual-upgrade-again"))).toBe("PLAN_UNAVAILABLE");
  });

  it("no primeiro mês cobre os 12 meses e troca o tier do termo; no último, cobra um mês", async () => {
    const f = await fixture();
    const term = await annualNow(f);
    const first = await requestUpgrade(f);
    expect(first.amountCents).toBe(350000);
    await confirm(f, first.id, "annual-upgrade-first", 350000);
    expect(await f.terms()).toMatchObject([
      {
        tier: "large",
        segments: [],
        paidCents: 499000,
        upgrades: [{ fromPeriod: OCT_1, paidCents: 350000 }],
      },
    ]);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", termId: term._id, endsAt: END });

    const g = await fixture();
    await annualNow(g);
    // September 2027, the last month of the term.
    vi.setSystemTime(Date.UTC(2027, 8, 30, 23));
    const last = await requestUpgrade(g);
    expect(last).toMatchObject({ amountCents: 29166, period: "2027-09" });
    await confirm(g, last.id, "annual-upgrade-last", 29166);
    expect(await g.terms()).toMatchObject([
      { endsAt: END, segments: [{ tier: "large", fromPeriod: Date.UTC(2027, 8, 1) }] },
    ]);
    expect(await g.plan()).toMatchObject({ catalogTier: "large", endsAt: END });
  });

  it("recusa sem termo, com termo agendado, com renovação agendada e com o anual desligado", async () => {
    const none = await fixture();
    expect(await code(requestUpgrade(none))).toBe("ANNUAL_TERM_REQUIRED");
    // Not started yet: upgraded once it starts.
    const scheduled = await fixture();
    const next = await requestAnnual(scheduled.owner, scheduled.organizationId, "next");
    await confirm(scheduled, next.id, "annual-next-upgrade");
    expect(await code(requestUpgrade(scheduled))).toBe("ANNUAL_TERM_SCHEDULED");
    // The renewal was paid at its own tier: the term it follows is no longer upgraded.
    const renewed = await fixture();
    await annualNow(renewed);
    vi.setSystemTime(Date.UTC(2027, 8, 10));
    const renewal = await requestAnnual(
      await person(renewed.t, renewed.organizationId, "owner"),
      renewed.organizationId,
      "next",
      "renew-key",
    );
    await confirm(renewed, renewal.id, "annual-renewal-ref");
    expect(await code(requestUpgrade(renewed))).toBe("ANNUAL_TERM_SCHEDULED");
    vi.setSystemTime(OCT);
    const off = await fixture();
    await annualNow(off);
    await off.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await code(requestUpgrade(off))).toBe("ANNUAL_DISABLED");
    expect(
      await off.t.run((ctx) =>
        ctx.db
          .query("platformPlanRequests")
          .collect()
          .then((rows) => rows.filter((row) => row.termId)),
      ),
    ).toEqual([]);
  });

  it("com o Pix desligado, o upgrade do termo Pix responde PIX_DISABLED sem gravar", async () => {
    const f = await fixture();
    await annualNow(f);
    await f.t.mutation(internal.plans.configurePix, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-pix-off",
    });
    expect(await code(requestUpgrade(f))).toBe("PIX_DISABLED");
    const requests = await f.t.run((ctx) => ctx.db.query("platformPlanRequests").collect());
    expect(requests.filter((row) => row.termId)).toEqual([]);
  });

  it("recusa papel sem gestão, Grande já em vigor, pedido pendente, chave repetida e termo do cartão", async () => {
    const f = await fixture();
    await annualNow(f);
    const viewer = await person(f.t, f.organizationId, "viewer");
    expect(await code(requestUpgrade(f, undefined, undefined, viewer))).toBe("ACCESS_DENIED");
    expect(await code(requestUpgrade(f, "same-tier", "intermediate"))).toBe("PLAN_UNAVAILABLE");
    expect(
      await code(
        f.owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "large",
          key: "upgrade-without-annual",
          start: "upgrade",
        }),
      ),
    ).toBe("INVALID_REQUEST");
    await requestUpgrade(f);
    expect(await code(requestUpgrade(f, "another-upgrade"))).toBe("PLAN_REQUEST_PENDING");
    // The same key is the same choice: not a new annual term.
    expect(
      await code(requestAnnual(f.owner, f.organizationId, "now", "annual-upgrade-key", "large")),
    ).toBe("OPERATION_CONFLICT");

    const card = await fixture();
    await card.t.run(async (ctx) => {
      const termId = await insertTerm(ctx, {
        organizationId: card.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "stripe",
        references: ["in_synthetic_card_term"],
        stripeSubscriptionId: "sub_synthetic",
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state: "active",
      });
      await activateCatalogPlan(
        ctx,
        card.organizationId,
        "intermediate",
        OCT,
        termEndsAt(OCT_1),
        0,
        "operator",
        "Anual sintético",
        termId,
      );
    });
    expect(await code(requestUpgrade(card))).toBe("PAYMENT_METHOD_CARD");
  });

  it("a confirmação vale só no mês do pedido e recusa a admissão sem gravar nada", async () => {
    const f = await fixture();
    await annualNow(f);
    vi.setSystemTime(FEB);
    const late = await requestUpgrade(f);
    vi.setSystemTime(Date.UTC(2027, 2, 1));
    // In March the same difference covers one month fewer.
    expect(await code(confirm(f, late.id, "annual-upgrade-late", 233333))).toBe(
      "PLAN_REQUEST_UNAVAILABLE",
    );

    vi.setSystemTime(OCT);
    const g = await fixture();
    const term = await annualNow(g);
    vi.setSystemTime(FEB);
    const request = await requestUpgrade(g);
    const plan = await g.plan();
    // The custody budget no longer holds the R$ 172 the Grande needs.
    await g.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { custodyCents: 20000 });
    });
    expect(await code(confirm(g, request.id, "annual-upgrade-refused", 233333))).toBe(
      "PLAN_UNAVAILABLE",
    );
    expect(await g.terms()).toEqual([term]);
    expect(await g.plan()).toEqual(plan);
    expect(await custody(g)).toEqual({ settings: 10800, organization: 10800 });
    expect(await g.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      state: "awaiting_payment",
    });
  });
});

describe("rescisão do anual pelo suporte e upgrade desfeito em 7 dias", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FEB = Date.UTC(2027, 1, 10, 12);
  const FEB_1 = Date.UTC(2027, 1, 1);
  const MAR_1 = Date.UTC(2027, 2, 1);
  const END = termEndsAt(OCT_1);
  const OPERATOR = "operador-sintetico";
  const rescind = (f: Fixture, termId: Id<"platformPlanTerms">, key = "rescission-key") =>
    f.t.mutation(internal.plans.rescindTerm, {
      termId,
      key,
      actor: OPERATOR,
      reason: "Cliente pediu a rescisão ao suporte",
    });
  const undo = (f: Fixture, termId: Id<"platformPlanTerms">, key = "undo-upgrade-key") =>
    f.t.mutation(internal.plans.undoTermUpgrade, {
      termId,
      key,
      actor: OPERATOR,
      reason: "Cliente desistiu do upgrade em 7 dias",
    });
  const refund = (
    f: Fixture,
    termId: Id<"platformPlanTerms">,
    amountCents: number,
    reference = "pix-refund-0001",
    upgradeReference?: string,
  ) =>
    f.t.mutation(internal.plans.recordTermRefund, {
      termId,
      amountCents,
      reference,
      actor: OPERATOR,
      ...(upgradeReference ? { upgradeReference } : {}),
    });
  async function annualNow(f: Fixture) {
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    await confirm(f, request.id, "annual-pix-ref");
    return (await f.terms())[0]!;
  }
  async function upgradeAt(f: Fixture, at: number, amountCents: number) {
    vi.setSystemTime(at);
    const owner = await person(f.t, f.organizationId, "owner");
    const request = await owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "large",
      key: "annual-upgrade-key",
      cycle: "annual",
      start: "upgrade",
    });
    expect(request.amountCents).toBe(amountCents);
    await confirm(f, request.id, "annual-upgrade-ref", amountCents);
  }
  const term = (f: Fixture, id: Id<"platformPlanTerms">) =>
    f.t.run((ctx) => ctx.db.get("platformPlanTerms", id));
  const stock = (f: Fixture) =>
    f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      return {
        settings: [settings.allocatedFilesBytes, settings.allocatedCustodyCents],
        allocations: await ctx.db.query("platformPlanAllocations").collect(),
      };
    });

  it("no 4º mês devolve R$ 894, o acesso vai até o fim do mês e então o plano termina", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    const reserved = await stock(f);
    const JAN = Date.UTC(2027, 0, 15, 12);
    vi.setSystemTime(JAN);
    const result = await rescind(f, annual._id);
    expect(result).toEqual([
      {
        termId: annual._id,
        withdrawal: false,
        usedMonths: 4,
        refundCents: 149000 - 4 * 14900,
        accessEndsAt: FEB_1,
      },
    ]);
    expect(await term(f, annual._id)).toMatchObject({
      state: "rescinded",
      endsAt: END,
      paidCents: 149000,
      rescission: {
        key: "rescission-key",
        actor: OPERATOR,
        reason: "Cliente pediu a rescisão ao suporte",
        at: JAN,
        withdrawal: false,
        usedMonths: 4,
        usedCents: 4 * 14900,
        refundCents: 89400,
        accessEndsAt: FEB_1,
      },
    });
    // Access until the end of the civil month, at the same tier.
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: annual._id,
      endsAt: FEB_1,
      version: 2,
    });
    // The reservation stays, as on any expiry: only the legal purge returns it.
    expect(await stock(f)).toEqual(reserved);
    // The same key answers the same rescission; another one is refused.
    expect(await rescind(f, annual._id)).toEqual(result);
    expect(await code(rescind(f, annual._id, "rescission-other"))).toBe("TERM_RESCINDED");
    expect(await f.plan()).toMatchObject({ version: 2 });
    // The term no longer holds the month: the monthly paths answer as for any monthly plan.
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      await code(
        owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "intermediate",
          key: "monthly-after-rescission",
        }),
      ),
    ).toBe("PLAN_UNAVAILABLE");
    await runUntil(f, FEB_1);
    const ended = await f.plan();
    expect(ended).toMatchObject({ endsAt: FEB_1, version: 2, updatedAt: FEB_1 });
    expect(await stock(f)).toEqual(reserved);

    // The operator records each refund made; together they reach the computed amount.
    expect(await code(refund(f, annual._id, 89401))).toBe("AMOUNT_MISMATCH");
    expect(await refund(f, annual._id, 60000)).toEqual({
      refundCents: 89400,
      refundedCents: 60000,
    });
    // The same refund again changes nothing; with another amount it is a conflict.
    expect(await refund(f, annual._id, 60000)).toEqual({
      refundCents: 89400,
      refundedCents: 60000,
    });
    expect(await code(refund(f, annual._id, 29400))).toBe("OPERATION_CONFLICT");
    // Going past what is due is refused.
    expect(await code(refund(f, annual._id, 29401, "pix-refund-0002"))).toBe("AMOUNT_MISMATCH");
    expect(await refund(f, annual._id, 29400, "pix-refund-0002")).toEqual({
      refundCents: 89400,
      refundedCents: 89400,
    });
    expect((await term(f, annual._id))!.rescission!.refunds).toEqual([
      { cents: 60000, reference: "pix-refund-0001", actor: OPERATOR, at: FEB_1 },
      { cents: 29400, reference: "pix-refund-0002", actor: OPERATOR, at: FEB_1 },
    ]);
    expect(await code(refund(f, annual._id, 1, "pix-refund-0003"))).toBe("AMOUNT_MISMATCH");
  });

  it("até 7 dias da compra devolve tudo e o acesso termina na hora; depois, não", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    vi.setSystemTime(OCT + 7 * DAY);
    expect(await rescind(f, annual._id)).toEqual([
      {
        termId: annual._id,
        withdrawal: true,
        usedMonths: 1,
        refundCents: 149000,
        accessEndsAt: OCT + 7 * DAY,
      },
    ]);
    expect(await f.plan()).toMatchObject({ endsAt: OCT + 7 * DAY, version: 2 });

    vi.setSystemTime(OCT);
    const g = await fixture();
    const late = await annualNow(g);
    vi.setSystemTime(OCT + 7 * DAY + 1);
    expect(await rescind(g, late._id)).toMatchObject([
      { withdrawal: false, usedMonths: 1, refundCents: 149000 - 14900, accessEndsAt: NOV },
    ]);
  });

  it("a partir do 10º mês o reembolso é zero e não há o que registrar", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    vi.setSystemTime(Date.UTC(2027, 6, 2));
    expect(await rescind(f, annual._id)).toMatchObject([
      { usedMonths: 10, refundCents: 0, accessEndsAt: Date.UTC(2027, 7, 1) },
    ]);
    expect(await code(refund(f, annual._id, 1))).toBe("REFUND_NOT_DUE");
    // An ended term is refused.
    vi.setSystemTime(OCT);
    const g = await fixture();
    const old = await annualNow(g);
    vi.setSystemTime(END);
    expect(await code(rescind(g, old._id))).toBe("TERM_ENDED");
  });

  it("com upgrade no 5º mês, rescindido no 8º devolve R$ 1.231,33 e o acesso segue no Grande até o fim do mês", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    await upgradeAt(f, FEB, 233333);
    vi.setSystemTime(Date.UTC(2027, 4, 10, 12));
    // 4 × R$ 149 + 4 × R$ 499 used, out of R$ 1.490 + R$ 2.333,33 paid.
    expect(await rescind(f, annual._id)).toEqual([
      {
        termId: annual._id,
        withdrawal: false,
        usedMonths: 8,
        refundCents: 123133,
        accessEndsAt: Date.UTC(2027, 5, 1),
      },
    ]);
    const rescinded = (await term(f, annual._id))!;
    expect(rescinded).toMatchObject({
      paidCents: 382333,
      segments: [{ tier: "large", fromPeriod: FEB_1 }],
      rescission: { usedCents: 4 * 14900 + 4 * 49900, refundCents: 123133 },
    });
    expect(rescinded.undoneUpgrades).toBeUndefined();
    expect(await f.plan()).toMatchObject({ catalogTier: "large", endsAt: Date.UTC(2027, 5, 1) });
  });

  it("desfaz o upgrade em 7 dias: devolve a cobrança e o termo volta ao Intermediário", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    await upgradeAt(f, FEB, 233333);
    const reserved = await stock(f);
    vi.setSystemTime(FEB + 2 * DAY);
    const undone = { reference: "annual-upgrade-ref", refundCents: 233333, tier: "intermediate" };
    expect(await undo(f, annual._id)).toEqual(undone);
    expect(await term(f, annual._id)).toMatchObject({
      state: "active",
      tier: "intermediate",
      endsAt: END,
      purchasedAt: OCT,
      segments: [],
      upgrades: [],
      paidCents: 149000,
      // The charge stays known, so its reference is never reused.
      references: ["annual-pix-ref", "annual-upgrade-ref"],
      undoneUpgrades: [
        {
          fromTier: "intermediate",
          tier: "large",
          fromPeriod: FEB_1,
          reference: "annual-upgrade-ref",
          paidCents: 233333,
          paidAt: FEB,
          key: "undo-upgrade-key",
          actor: OPERATOR,
          at: FEB + 2 * DAY,
          refundCents: 233333,
        },
      ],
    });
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: annual._id,
      endsAt: END,
      version: 3,
    });
    expect(await stock(f)).toEqual(reserved);
    // Repeating answers the same; without another upgrade there is nothing to undo.
    expect(await undo(f, annual._id)).toEqual(undone);
    expect(await f.plan()).toMatchObject({ version: 3 });
    expect(await code(undo(f, annual._id, "undo-upgrade-other"))).toBe("UPGRADE_NOT_FOUND");
    expect(
      await code(refund(f, annual._id, 233333, "pix-refund-upgrade", "annual-upgrade-unknown")),
    ).toBe("NOT_FOUND");
    await refund(f, annual._id, 233333, "pix-refund-upgrade", "annual-upgrade-ref");
    expect((await term(f, annual._id))!.undoneUpgrades![0]!.refunds).toMatchObject([
      { cents: 233333, reference: "pix-refund-upgrade" },
    ]);
    // A key belongs to one action: the undo's key cannot rescind the term.
    expect(await code(rescind(f, annual._id, "undo-upgrade-key"))).toBe("OPERATION_CONFLICT");
    // The term keeps its own rules: rescinded later, it is an Intermediário all along.
    vi.setSystemTime(Date.UTC(2027, 4, 10));
    expect(await rescind(f, annual._id)).toMatchObject([
      { usedMonths: 8, refundCents: 149000 - 8 * 14900 },
    ]);
  });

  it("no primeiro mês o upgrade desfeito devolve o tier do termo; depois de 7 dias é recusado", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    await upgradeAt(f, OCT + DAY, 350000);
    expect(await term(f, annual._id)).toMatchObject({ tier: "large", segments: [] });
    vi.setSystemTime(OCT + 3 * DAY);
    await undo(f, annual._id);
    expect(await term(f, annual._id)).toMatchObject({
      tier: "intermediate",
      segments: [],
      paidCents: 149000,
    });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: END });

    vi.setSystemTime(OCT);
    const g = await fixture();
    const late = await annualNow(g);
    await upgradeAt(g, FEB, 233333);
    vi.setSystemTime(FEB + 7 * DAY + 1);
    expect(await code(undo(g, late._id))).toBe("WITHDRAWAL_ENDED");
    expect(await g.plan()).toMatchObject({ catalogTier: "large" });
  });

  it("rescindido nos 7 dias do upgrade, o upgrade volta inteiro e os meses voltam ao Intermediário", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    await upgradeAt(f, FEB, 233333);
    vi.setSystemTime(FEB + 2 * DAY);
    // The upgrade back in full, and 5 months at R$ 149 out of the R$ 1.490.
    expect(await rescind(f, annual._id)).toEqual([
      {
        termId: annual._id,
        withdrawal: false,
        usedMonths: 5,
        refundCents: 149000 - 5 * 14900,
        accessEndsAt: MAR_1,
      },
    ]);
    expect(await term(f, annual._id)).toMatchObject({
      state: "rescinded",
      segments: [],
      paidCents: 149000,
      undoneUpgrades: [{ reference: "annual-upgrade-ref", refundCents: 233333, via: "rescission" }],
    });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: MAR_1 });
    // The rescission's key does not answer for an undo.
    expect(await code(undo(f, annual._id, "rescission-key"))).toBe("OPERATION_CONFLICT");
  });

  it("um termo agendado com a ativação recusada não usou nada: tudo volta, sem acesso a encerrar", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "next");
    await confirm(f, request.id, "annual-blocked-ref");
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").first())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { enabled: false });
    });
    await runUntil(f, NOV);
    const [blocked] = await f.terms();
    expect(blocked).toMatchObject({ state: "scheduled", blockedCode: "PLANS_DISABLED" });
    expect(await f.plan()).toBeNull();
    // In its first month and past the 7 days of the payment: still nothing was used.
    const at = NOV + 10 * DAY;
    vi.setSystemTime(at);
    expect(await rescind(f, blocked!._id)).toEqual([
      {
        termId: blocked!._id,
        withdrawal: false,
        usedMonths: 0,
        refundCents: 149000,
        accessEndsAt: at,
      },
    ]);
    expect(await f.plan()).toBeNull();
  });

  it("leva junto a renovação agendada, já paga, com tudo devolvido, e cancela o pedido anual pendente", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    const SEP = Date.UTC(2027, 8, 10, 12);
    vi.setSystemTime(SEP);
    const owner = await person(f.t, f.organizationId, "owner");
    const next = await requestAnnual(owner, f.organizationId, "next", "annual-renewal");
    await confirm(f, next.id, "annual-renewal-ref");
    const renewal = (await f.terms()).find((row) => row._id !== annual._id)!;
    expect(renewal).toMatchObject({ state: "scheduled", firstPeriod: END });
    expect(await rescind(f, annual._id)).toEqual([
      { termId: annual._id, withdrawal: false, usedMonths: 12, refundCents: 0, accessEndsAt: END },
      // Paid today: within its own 7 days, and unused either way.
      {
        termId: renewal._id,
        withdrawal: true,
        usedMonths: 0,
        refundCents: 149000,
        accessEndsAt: SEP,
      },
    ]);
    expect(await term(f, renewal._id)).toMatchObject({
      state: "rescinded",
      rescission: { after: annual._id, refundCents: 149000 },
    });
    // Rescinded, the renewal is never activated; the plan ends with the term.
    await runUntil(f, END);
    expect(await f.plan()).toMatchObject({ termId: annual._id, endsAt: END });
    expect(await term(f, renewal._id)).toMatchObject({ state: "rescinded" });

    // A renewal still awaiting payment is cancelled instead.
    vi.setSystemTime(OCT);
    const g = await fixture();
    const current = await annualNow(g);
    vi.setSystemTime(SEP);
    const pending = await requestAnnual(
      await person(g.t, g.organizationId, "owner"),
      g.organizationId,
      "next",
      "annual-renewal",
    );
    await rescind(g, current._id);
    expect(await g.t.run((ctx) => ctx.db.get("platformPlanRequests", pending.id))).toMatchObject({
      state: "cancelled",
    });
    expect(await code(confirm(g, pending.id, "annual-renewal-late"))).toBe(
      "PLAN_REQUEST_UNAVAILABLE",
    );
  });

  it("só o operador rescinde: as funções são internas e exigem login, motivo e chave válidos", async () => {
    for (const fn of [
      plansModule.rescindTerm,
      plansModule.undoTermUpgrade,
      plansModule.recordTermRefund,
    ]) {
      const registered = fn as unknown as { isPublic?: boolean; isInternal?: boolean };
      expect(registered.isPublic).toBeFalsy();
      expect(registered.isInternal).toBe(true);
    }
    const f = await fixture();
    const annual = await annualNow(f);
    const base = {
      termId: annual._id,
      key: "rescission-key",
      actor: OPERATOR,
      reason: "Cliente pediu a rescisão ao suporte",
    };
    for (const bad of [{ actor: "operador com espaço" }, { reason: "curto" }, { key: "curta" }])
      expect(await code(f.t.mutation(internal.plans.rescindTerm, { ...base, ...bad }))).toBe(
        "INVALID_REQUEST",
      );
    expect(await code(refund(f, annual._id, 1, "x"))).toBe("INVALID_REQUEST");
    // Nothing rescinded yet: no refund to record.
    expect(await code(refund(f, annual._id, 1))).toBe("NOT_FOUND");
    expect(await f.terms()).toMatchObject([{ state: "active" }]);
  });
});

describe("visão do anual no console (plans:overview)", () => {
  const FEB = Date.UTC(2027, 1, 10, 12);
  const FEB_1 = Date.UTC(2027, 1, 1);
  const END = termEndsAt(OCT_1);
  const view = async (f: Fixture) =>
    (await person(f.t, f.organizationId, "owner")).query(api.plans.overview, {
      organizationId: f.organizationId,
      contextKey: "annual-view",
    });

  it("o preço anual e o interruptor só aparecem com o anual à venda", async () => {
    const off = await view(await fixture({ annual: false }));
    expect(off).toMatchObject({ annualEnabled: false, terms: [] });
    expect(off.offers.map((offer) => offer.annualCents)).toEqual([undefined, undefined, undefined]);
    const on = await view(await fixture());
    expect(on.annualEnabled).toBe(true);
    expect(on.offers.map((offer) => [offer.tier, offer.annualCents])).toEqual([
      ["free", undefined],
      ["intermediate", 149000],
      ["large", 499000],
    ]);
  });

  it("mostra o pedido anual, o termo agendado sem upgrade e o termo em vigor com o preço do upgrade", async () => {
    const f = await fixture();
    const next = await requestAnnual(f.owner, f.organizationId, "next");
    expect((await view(f)).request).toMatchObject({
      id: next.id,
      tier: "intermediate",
      cycle: "annual",
      start: "next",
      firstPeriod: NOV,
      amountCents: 149000,
      state: "awaiting_payment",
    });
    await confirm(f, next.id, "annual-view-next");
    expect((await view(f)).terms).toEqual([
      {
        id: expect.any(String),
        tier: "intermediate",
        segments: [],
        firstPeriod: NOV,
        endsAt: termEndsAt(NOV),
        source: "pix",
        state: "scheduled",
        blocked: false,
        accessEndsAt: null,
        renews: false,
        upgrade: null,
      },
    ]);

    const g = await fixture();
    const now = await requestAnnual(g.owner, g.organizationId, "now");
    expect((await view(g)).request).toMatchObject({ start: "now", firstPeriod: OCT_1 });
    await confirm(g, now.id, "annual-view-now");
    // The first month: the upgrade covers all 12 months.
    expect((await view(g)).terms).toMatchObject([
      {
        state: "active",
        firstPeriod: OCT_1,
        endsAt: END,
        upgrade: { tier: "large", amountCents: 350000, months: 12, cardUntil: null },
      },
    ]);
    // February: 8 months left, the same price the request is charged.
    vi.setSystemTime(FEB);
    expect((await view(g)).terms[0]!.upgrade).toEqual({
      tier: "large",
      amountCents: 233333,
      months: 8,
      cardUntil: null,
    });
    const owner = await person(g.t, g.organizationId, "owner");
    const upgrade = await owner.mutation(api.plans.requestPaid, {
      organizationId: g.organizationId,
      tier: "large",
      key: "annual-view-upgrade",
      cycle: "annual",
      start: "upgrade",
    });
    expect((await view(g)).request).toMatchObject({
      tier: "large",
      cycle: "annual",
      start: "upgrade",
      firstPeriod: FEB_1,
      amountCents: 233333,
    });
    await confirm(g, upgrade.id, "annual-view-upgrade-ref", 233333);
    // Upgraded: the segment shows, and there is nothing left to raise.
    expect((await view(g)).terms).toMatchObject([
      { tier: "intermediate", segments: [{ tier: "large", fromPeriod: FEB_1 }], upgrade: null },
    ]);
  });

  it("sem o anual à venda ou com renovação agendada, o termo não oferece upgrade", async () => {
    const f = await fixture();
    const now = await requestAnnual(f.owner, f.organizationId, "now");
    await confirm(f, now.id, "annual-view-now");
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await view(f)).toMatchObject({
      annualEnabled: false,
      // A term in force holds a new annual for both starts until its last month.
      annualStarts: { now: false, next: false },
      terms: [{ state: "active", upgrade: null }],
    });
    const g = await fixture();
    expect((await view(g)).annualStarts).toEqual({ now: true, next: true });
    await confirm(g, (await requestAnnual(g.owner, g.organizationId, "now")).id, "annual-a");
    vi.setSystemTime(Date.UTC(2027, 8, 10, 12));
    // The last month: only the renewal starting next month.
    expect((await view(g)).annualStarts).toEqual({ now: false, next: true });
    const owner = await person(g.t, g.organizationId, "owner");
    await confirm(
      g,
      (await requestAnnual(owner, g.organizationId, "next", "annual-renewal")).id,
      "annual-b",
    );
    expect((await view(g)).terms).toMatchObject([
      { state: "active", firstPeriod: OCT_1, upgrade: null },
      { state: "scheduled", firstPeriod: END, upgrade: null },
    ]);
    expect((await view(g)).annualStarts).toEqual({ now: false, next: false });
  });

  it("o termo do cartão fecha o upgrade 72 horas antes do fim, e o rescindido mostra o fim do acesso", async () => {
    const f = await fixture();
    const termId = await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: END,
        source: "stripe",
        references: ["in_annual_view_card"],
        stripeSubscriptionId: "sub_annual_view",
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state: "active",
      }),
    );
    // No subscription renews it here, so it does not renew.
    expect((await view(f)).terms).toMatchObject([
      { source: "stripe", renews: false, upgrade: { cardUntil: END - 72 * 3600_000 } },
    ]);
    const subscription = (cancelAtPeriodEnd: boolean) => ({
      id: "sub_annual_view",
      status: "active",
      tier: "intermediate" as const,
      cancelAtPeriodEnd,
      periodEnd: END,
      annual: true as const,
    });
    const accountId = await f.t.run((ctx) =>
      ctx.db.insert("billingAccounts", {
        organizationId: f.organizationId,
        customerId: "cus_annual_view",
        livemode: false,
        subscription: subscription(false),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect((await view(f)).terms).toMatchObject([{ renews: true }]);
    await f.t.run((ctx) =>
      ctx.db.patch("billingAccounts", accountId, { subscription: subscription(true) }),
    );
    expect((await view(f)).terms).toMatchObject([{ renews: false }]);
    // An open Checkout shows; once it is gone the console starts a new intention.
    expect((await view(f)).checkout).toBe(false);
    const checkoutId = await f.t.run((ctx) =>
      ctx.db.insert("billingCheckouts", {
        organizationId: f.organizationId,
        key: "annual-view-checkout",
        kind: "upgrade",
        tier: "large",
        cycle: "annual",
        period: "2026-10",
        grantCents: 350000,
        state: "open",
        expiresAt: Date.now() + 3600_000,
        requestedBy: "synthetic",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect((await view(f)).checkout).toBe(true);
    await f.t.run((ctx) => ctx.db.patch("billingCheckouts", checkoutId, { state: "expired" }));
    expect((await view(f)).checkout).toBe(false);
    vi.setSystemTime(Date.UTC(2027, 0, 15, 12));
    await f.t.mutation(internal.plans.rescindTerm, {
      termId,
      key: "annual-view-rescission",
      actor: "operador-sintetico",
      reason: "Cliente pediu a rescisão ao suporte",
    });
    expect((await view(f)).terms).toMatchObject([
      { state: "rescinded", accessEndsAt: FEB_1, renews: false, upgrade: null },
    ]);
    // Once its access is over it leaves the screen, before the term's year ends.
    vi.setSystemTime(FEB_1);
    expect((await view(f)).terms).toEqual([]);
  });
});
