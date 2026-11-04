import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { enablePix, platformTest, person, usePlatformEnvironment } from "./helpers/platform";
import { addMonths, termEndsAt } from "../platform/convex/lib/annualTerms";
import { activateCatalogPlan } from "../platform/convex/lib/planCore";
import { insertTerm, termTierAt } from "../platform/convex/lib/planTerms";
import { archiveStatus } from "../platform/convex/lib/coldArchiveCore";
import { checkUsage, planFor, reserveUsage } from "../platform/convex/lib/usageCore";
import { quotaPeriod } from "../platform/convex/lib/quotaPeriod";
import { PLATFORM_PLANS } from "../platform/convex/lib/planCatalog";
import * as plansModule from "../platform/convex/plans";

/**
 * The annual plan sold by assisted Pix (ADR 0010, decision 9), server side only, on anniversary
 * terms (ADR 0012): `now` starts at the confirmation, a `renewal` at the end of the Pix plan in
 * force, keeping the chain's anchor.
 */
const OCT = Date.UTC(2026, 9, 10, 12);
const OCT_1 = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);
const DAY = 24 * 60 * 60 * 1000;
/** The term confirmed at `OCT`: from 10/10/2026 12:00 UTC to 10/10/2027 12:00 UTC. */
const END = termEndsAt(OCT);
/** The start of its last month, from which it may be renewed. */
const LAST_MONTH = Date.UTC(2027, 8, 10, 12);
/** A monthly Pix confirmed at `OCT` ends on its first anniversary, 10/11/2026 12:00 UTC (ADR 0012). */
const MONTHLY_END = addMonths(OCT, 1);
/** The annual that renews that monthly starts at its end and keeps its anchor, `OCT`. */
const RENEWAL_END = termEndsAt(MONTHLY_END, OCT);
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
/** The refusal's data: its code and, for a sale that waits, when it becomes available. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: unknown }) => error.data,
  );

const requestAnnual = (
  member: Member,
  organizationId: Id<"organizations">,
  start: "now" | "renewal",
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
          start: "renewal",
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
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe("ANNUAL_DISABLED");
  });

  it("cobra o annualCents, começa na confirmação e vale 7 dias; sem plano, não há renovação", async () => {
    const f = await fixture();
    const now = await requestAnnual(f.owner, f.organizationId, "now", "annual-now-key", "large");
    // No civil month is bought: the term runs from the confirmation.
    expect(now).toEqual({ id: now.id, amountCents: PLATFORM_PLANS.large.annualCents });
    const stored = await f.t.run((ctx) => ctx.db.get("platformPlanRequests", now.id));
    expect(stored).toMatchObject({ cycle: "annual", startsAt: OCT, endsAt: OCT + 7 * DAY });
    expect(stored).not.toHaveProperty("firstPeriod");
    expect(stored).not.toHaveProperty("period");
    // Nothing in force to renew.
    await f.owner.mutation(api.plans.cancelRequest, {
      organizationId: f.organizationId,
      requestId: now.id,
    });
    expect(await refusal(requestAnnual(f.owner, f.organizationId, "renewal"))).toEqual({
      code: "PLAN_UNAVAILABLE",
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
    expect(await code(requestAnnual(f.owner, f.organizationId, "renewal", "annual-now-key"))).toBe(
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
      await code(requestAnnual(f.owner, f.organizationId, "renewal", "annual-larger", "large")),
    ).toBe("PLAN_UNAVAILABLE");
    const other = await f.org("Sem reserva");
    const otherOwner = await person(f.t, other, "owner");
    expect(await code(requestAnnual(otherOwner, other, "now"))).toBe("PLAN_UNAVAILABLE");
    const same = await requestAnnual(f.owner, f.organizationId, "renewal");
    await confirm(f, same.id, "annual-same-tier-ref");
    expect(await f.terms()).toMatchObject([{ state: "scheduled", tier: "intermediate" }]);
  });

  it("com um mensal Pix em vigor, o anual só entra como renovação no fim dele, de qualquer tier", async () => {
    const f = await fixture();
    const request = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "large",
      key: "monthly-large",
    });
    await confirm(f, request.id, "monthly-large-ref", request.amountCents);
    // One paid plan at a time (ADR 0012): starting now would replace the month in force.
    expect(await refusal(requestAnnual(f.owner, f.organizationId, "now"))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: MONTHLY_END,
    });
    // A smaller tier enters as the renewal: from the end of the month paid, until the anniversary,
    // keeping the monthly's anchor (slice 1c).
    const renewal = await requestAnnual(f.owner, f.organizationId, "renewal");
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", renewal.id))).toMatchObject({
      tier: "intermediate",
      firstPeriod: MONTHLY_END,
      anchor: OCT,
      // Paid within the term's first month, as a renewal paid late starts at once.
      endsAt: addMonths(OCT, 2),
    });
  });

  it("com o Pix desligado responde PIX_DISABLED; com o anual também desligado, ANNUAL_DISABLED", async () => {
    const f = await fixture();
    await f.t.mutation(internal.plans.configurePix, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-pix-off",
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe("PIX_DISABLED");
    expect(await code(requestAnnual(f.owner, f.organizationId, "renewal"))).toBe("PIX_DISABLED");
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
  it("começando agora, o termo vai da confirmação, truncada ao segundo, ao mesmo instante 12 meses depois", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    expect(await code(confirm(f, request.id, "annual-now-ref", 149000 - 1))).toBe(
      "PLAN_REQUEST_UNAVAILABLE",
    );
    // Confirmed mid-month, at 14:30:07.250 UTC.
    const paidAt = Date.UTC(2026, 9, 13, 14, 30, 7, 250);
    const start = Date.UTC(2026, 9, 13, 14, 30, 7);
    vi.setSystemTime(paidAt);
    await confirm(f, request.id, "annual-now-ref");
    await confirm(f, request.id, "annual-now-ref");
    const [term, ...rest] = await f.terms();
    expect(rest).toEqual([]);
    expect(term).toMatchObject({
      organizationId: f.organizationId,
      tier: "intermediate",
      firstPeriod: start,
      endsAt: Date.UTC(2027, 9, 13, 14, 30, 7),
      source: "pix",
      references: ["annual-now-ref"],
      paidCents: 149000,
      purchasedAt: paidAt,
      segments: [],
      state: "active",
    });
    // A new chain: the term is its own anchor.
    expect(term).not.toHaveProperty("anchor");
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: term!._id,
      startsAt: paidAt,
      endsAt: term!.endsAt,
      periodAnchor: start,
      version: 1,
    });
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      state: "activated",
      paymentReference: "annual-now-ref",
    });
    // The quotas count by the term's months, from the anchor.
    await f.t.run((ctx) =>
      reserveUsage(ctx, f.organizationId, "production", "imports", "first-import", 1),
    );
    const totals = await f.t.run((ctx) => ctx.db.query("usageTotals").collect());
    expect(totals.filter((row) => row.reserved > 0)).toMatchObject([
      { period: "2026-10-13T14:30:07.000Z", metric: "imports", reserved: 1 },
    ]);
    // A second annual is the renewal, from the term's last month.
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      await refusal(requestAnnual(owner, f.organizationId, "renewal", "annual-second")),
    ).toEqual({ code: "ANNUAL_TERM_ACTIVE", availableAt: Date.UTC(2027, 8, 13, 14, 30, 7) });
    expect(await refusal(requestAnnual(owner, f.organizationId, "now", "annual-third"))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: Date.UTC(2027, 8, 13, 14, 30, 7),
    });
  });

  it("as cotas seguem os meses do termo e o Pix mensal é recusado até o último mês dele", async () => {
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
    // The civil month turns, the term month does not: until 10/11 at 12:00 UTC.
    vi.setSystemTime(NOV + 3600_000);
    expect(await another("november-1st")).toBe("QUOTA_EXCEEDED");
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12) - 1);
    expect(await another("november-9th")).toBe("QUOTA_EXCEEDED");
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12));
    expect(await another("second-month")).toBe("OK");
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      await refusal(
        owner.mutation(api.plans.requestPaid, {
          organizationId: f.organizationId,
          tier: "large",
          key: "monthly-under-annual",
        }),
      ),
      // The monthly opens in the term's last month, as its renewal (slice 1c).
    ).toEqual({ code: "ANNUAL_TERM_ACTIVE", availableAt: LAST_MONTH });
  });

  it("a renovação de um mensal Pix agenda o termo e só troca o plano no fim do mês pago", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const monthly = await f.plan();
    const request = await requestAnnual(f.owner, f.organizationId, "renewal");
    // Paid 10 days before the month ends: the fake timers hold at most 24.8 days.
    vi.setSystemTime(MONTHLY_END - 10 * DAY);
    await confirm(f, request.id, "annual-next-ref");
    const [term] = await f.terms();
    expect(term).toMatchObject({
      state: "scheduled",
      firstPeriod: MONTHLY_END,
      anchor: OCT,
      endsAt: RENEWAL_END,
    });
    expect(await f.plan()).toEqual(monthly);
    await runUntil(f, MONTHLY_END - 1);
    expect(await f.plan()).toEqual(monthly);
    await runUntil(f, MONTHLY_END);
    expect(await f.terms()).toMatchObject([{ state: "active" }]);
    const annual = await f.plan();
    // The chain keeps the monthly's anchor: the quota periods do not move.
    expect(annual).toMatchObject({
      catalogTier: "intermediate",
      termId: term!._id,
      startsAt: MONTHLY_END,
      endsAt: RENEWAL_END,
      periodAnchor: OCT,
      version: 2,
    });
    // Running it again, late or twice, changes nothing.
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    expect(await f.plan()).toEqual(annual);
  });

  it("um termo rescindido antes do início não é ativado", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const request = await requestAnnual(f.owner, f.organizationId, "renewal");
    await confirm(f, request.id, "annual-rescinded-ref");
    const [term] = await f.terms();
    await f.t.run((ctx) => ctx.db.patch("platformPlanTerms", term!._id, { state: "rescinded" }));
    await runUntil(f, MONTHLY_END);
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    expect(await f.plan()).toMatchObject({ endsAt: MONTHLY_END });
    expect(await f.plan()).not.toHaveProperty("termId");
    expect(await f.terms()).toMatchObject([{ state: "rescinded" }]);
  });

  it("uma ativação recusada fica registrada no termo e o operador a repete", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const request = await requestAnnual(f.owner, f.organizationId, "renewal");
    await confirm(f, request.id, "annual-blocked-ref");
    const [term] = await f.terms();
    const catalog = (enabled: boolean) =>
      f.t.run(async (ctx) => {
        const settings = (await ctx.db.query("platformPlanSettings").first())!;
        await ctx.db.patch("platformPlanSettings", settings._id, { enabled });
      });
    await catalog(false);
    await runUntil(f, MONTHLY_END);
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "PLANS_DISABLED" }]);
    expect(await f.plan()).not.toHaveProperty("termId");
    await catalog(true);
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    const [active] = await f.terms();
    expect(active).toMatchObject({ state: "active" });
    expect(active).not.toHaveProperty("blockedCode");
    expect(await f.plan()).toMatchObject({ termId: term!._id, endsAt: RENEWAL_END });
  });

  it("o now é pago em 7 dias; a renovação, até o fim do primeiro mês do termo", async () => {
    const f = await fixture();
    const now = await requestAnnual(f.owner, f.organizationId, "now");
    const g = await fixture();
    await payMonthly(g, g.owner, g.organizationId);
    const next = await requestAnnual(g.owner, g.organizationId, "renewal");
    const h = await fixture();
    await payMonthly(h, h.owner, h.organizationId);
    const late = await requestAnnual(h.owner, h.organizationId, "renewal");
    vi.setSystemTime(OCT + 7 * DAY);
    expect(await code(confirm(f, now.id, "annual-late-now"))).toBe("PLAN_REQUEST_UNAVAILABLE");
    expect(await f.terms()).toEqual([]);
    // Paid within the renewal's first month: it starts at once, at its own start.
    vi.setSystemTime(MONTHLY_END + DAY);
    await confirm(g, next.id, "annual-next-in-november");
    expect(await g.terms()).toMatchObject([{ state: "active", firstPeriod: MONTHLY_END }]);
    expect(await g.plan()).toMatchObject({ startsAt: MONTHLY_END + DAY, endsAt: RENEWAL_END });
    vi.setSystemTime(addMonths(OCT, 2));
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
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: MONTHLY_END });
    expect(await f.plan()).not.toHaveProperty("termId");
    expect(await f.plan(other)).toMatchObject({ endsAt: END });
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
    // A new chain waits for this one to end; its renewal keeps the anchor.
    expect(await refusal(requestAnnual(f.owner, f.organizationId, "now"))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: NOV,
    });
    const renewal = await requestAnnual(f.owner, f.organizationId, "renewal");
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
    expect(renewed).toMatchObject({
      state: "scheduled",
      firstPeriod: NOV,
      anchor: firstPeriod,
      endsAt: termEndsAt(NOV),
    });
    // A second scheduled term is refused: the next renewal opens in the renewal's last month.
    expect(
      await refusal(requestAnnual(f.owner, f.organizationId, "renewal", "annual-third")),
    ).toEqual({ code: "ANNUAL_TERM_ACTIVE", availableAt: Date.UTC(2027, 9, 1) });
    expect(await f.plan()).toMatchObject({ termId: old, endsAt: NOV });
    await runUntil(f, NOV);
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanTerms", renewed._id))).toMatchObject({
      state: "active",
    });
    expect(await stock()).toEqual(before);
    // The quotas keep the chain's anchor.
    expect(await f.plan()).toMatchObject({
      termId: renewed._id,
      startsAt: NOV,
      endsAt: termEndsAt(NOV),
      periodAnchor: firstPeriod,
      version: 2,
    });
  });

  it("a mesma chave ainda responde depois de o anual ser desligado", async () => {
    const f = await fixture();
    const request = await requestAnnual(f.owner, f.organizationId, "now");
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await requestAnnual(f.owner, f.organizationId, "now")).toEqual(request);
  });

  it("um pedido mensal e um anual não ficam pendentes juntos", async () => {
    const f = await fixture();
    const monthly = await f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key: "monthly-pending",
    });
    expect(await code(requestAnnual(f.owner, f.organizationId, "now"))).toBe(
      "PLAN_REQUEST_PENDING",
    );
    await f.owner.mutation(api.plans.cancelRequest, {
      organizationId: f.organizationId,
      requestId: monthly.id,
    });
    await requestAnnual(f.owner, f.organizationId, "now");
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
    await payMonthly(f, f.owner, f.organizationId);
    const late = await requestAnnual(f.owner, f.organizationId, "renewal");
    await confirm(f, late.id, "annual-ended-ref");
    const [ended] = await f.terms();
    vi.setSystemTime(RENEWAL_END);
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: ended!._id });
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "TERM_ENDED" }]);
    expect(await f.plan()).not.toHaveProperty("termId");
    // Running it again stays blocked, and the ended term no longer stops a new annual sale.
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: ended!._id });
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "TERM_ENDED" }]);
    const owner = await person(f.t, f.organizationId, "owner");
    expect(await code(requestAnnual(owner, f.organizationId, "now", "annual-after-ended"))).toBe(
      "OK",
    );

    vi.setSystemTime(OCT);
    const g = await fixture();
    await payMonthly(g, g.owner, g.organizationId);
    const request = await requestAnnual(g.owner, g.organizationId, "renewal");
    await confirm(g, request.id, "annual-archiving-ref");
    const [term] = await g.terms();
    // An archived organization buys plans; its rehydration may start before the renewal.
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
    vi.setSystemTime(MONTHLY_END);
    await g.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    expect(await g.terms()).toMatchObject([
      { state: "scheduled", blockedCode: "ORGANIZATION_ARCHIVING" },
    ]);
    expect(await g.plan()).not.toHaveProperty("termId");
  });
});

describe("cadeia de renovações pelo Pix (ADR 0012, seção 1)", () => {
  it("uma cadeia de 29/02/2028 vira em 28/02/2029, 2030 e 2031 e volta a 29/02/2032, sem deriva", async () => {
    const ANCHOR = Date.UTC(2028, 1, 29, 9, 15);
    vi.setSystemTime(ANCHOR - 3600_000);
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, {
        admissionsUntil: Date.UTC(2035, 0, 1),
      });
    });
    const first = await requestAnnual(f.owner, f.organizationId, "now");
    vi.setSystemTime(ANCHOR + 400);
    await confirm(f, first.id, "annual-leap-0");
    let [current] = await f.terms();
    expect(current).toMatchObject({ firstPeriod: ANCHOR, endsAt: Date.UTC(2029, 1, 28, 9, 15) });
    const starts = [
      Date.UTC(2029, 1, 28, 9, 15),
      Date.UTC(2030, 1, 28, 9, 15),
      Date.UTC(2031, 1, 28, 9, 15),
      Date.UTC(2032, 1, 29, 9, 15),
    ];
    for (const [n, start] of starts.slice(0, 3).entries()) {
      // The last month of term n + 1 starts on the anchor's anniversary 12(n + 1) − 1.
      const lastMonth = addMonths(ANCHOR, 12 * (n + 1) - 1);
      expect(lastMonth).toBe(Date.UTC(2029 + n, 0, 29, 9, 15));
      vi.setSystemTime(lastMonth);
      const owner = await person(f.t, f.organizationId, "owner");
      const request = await requestAnnual(owner, f.organizationId, "renewal", `renewal-${n}`);
      await confirm(f, request.id, `annual-leap-${n + 1}`);
      await runUntil(f, start);
      const renewal = (await f.terms()).find((term) => term.firstPeriod === start)!;
      expect(renewal).toMatchObject({
        state: "active",
        anchor: ANCHOR,
        endsAt: starts[n + 1],
      });
      // The plan and its quota periods keep the chain's anchor: the month after 28/02 turns on
      // the 29th, as the anchor's, not on the 28th.
      const plan = await f.plan();
      expect(plan).toMatchObject({ termId: renewal._id, periodAnchor: ANCHOR });
      expect(quotaPeriod(plan!, start)).toEqual({
        key: new Date(start).toISOString(),
        startsAt: start,
        endsAt: Date.UTC(2029 + n, 2, 29, 9, 15),
      });
      // So do the term months: a Pix upgrade in the first one is paid by the 29th.
      expect((await view(f)).terms.at(-1)!.upgrade).toMatchObject({
        from: start,
        until: Date.UTC(2029 + n, 2, 29, 9, 15),
        months: 12,
      });
      current = renewal;
    }
    expect(current).toMatchObject({ firstPeriod: starts[2], endsAt: Date.UTC(2032, 1, 29, 9, 15) });
    expect(await f.t.run((ctx) => planFor(ctx, f.organizationId))).toMatchObject({
      endsAt: Date.UTC(2032, 1, 29, 9, 15),
    });
  });
});

const view = async (f: Fixture) =>
  (await person(f.t, f.organizationId, "owner")).query(api.plans.overview, {
    organizationId: f.organizationId,
    contextKey: "annual-view",
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

  it("confirmar um anual encerra o aviso e impede outro", async () => {
    vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled");
    const f = await fixture();
    await expired(f);
    await notice(f, "synthetic-notice-1");
    expect(await run(f)).toMatchObject({ state: "notice" });
    const request = await requestAnnual(f.owner, f.organizationId, "now");
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
  /** In the 5th term month, from 10/02 at 12:00 UTC to 10/03 at 12:00 UTC. */
  const FEB = Date.UTC(2027, 1, 11, 9);
  const FEB_10 = Date.UTC(2027, 1, 10, 12);
  const MAR_10 = Date.UTC(2027, 2, 10, 12);
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
    // The 5th term month, from 10/02 at 12:00 UTC: 8 months left, the current one whole.
    vi.setSystemTime(FEB);
    const request = await requestUpgrade(f);
    expect(request).toEqual({ id: request.id, amountCents: 233333 });
    // It starts with the term month, and is paid before the next one.
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", request.id))).toMatchObject({
      tier: "large",
      cycle: "annual",
      termId: term._id,
      firstPeriod: FEB_10,
      endsAt: MAR_10,
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
      firstPeriod: OCT,
      endsAt: END,
      segments: [{ tier: "large", fromPeriod: FEB_10 }],
      references: ["annual-pix-ref", "annual-upgrade-ref"],
      paidCents: 149000 + 233333,
      purchasedAt: OCT,
      upgrades: [
        {
          fromTier: "intermediate",
          tier: "large",
          fromPeriod: FEB_10,
          reference: "annual-upgrade-ref",
          paidCents: 233333,
          paidAt: FEB,
        },
      ],
    });
    expect(termTierAt(upgraded!, FEB_10 - 1)).toBe("intermediate");
    expect(termTierAt(upgraded!, FEB_10)).toBe("large");
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
        upgrades: [{ fromPeriod: OCT, paidCents: 350000 }],
      },
    ]);
    expect(await f.plan()).toMatchObject({ catalogTier: "large", termId: term._id, endsAt: END });

    const g = await fixture();
    await annualNow(g);
    // 30/09/2027 is still in the last term month, from 10/09 at 12:00 UTC.
    vi.setSystemTime(Date.UTC(2027, 8, 30, 23));
    const last = await requestUpgrade(g);
    expect(last).toEqual({ id: last.id, amountCents: 29166 });
    await confirm(g, last.id, "annual-upgrade-last", 29166);
    expect(await g.terms()).toMatchObject([
      { endsAt: END, segments: [{ tier: "large", fromPeriod: LAST_MONTH }] },
    ]);
    expect(await g.plan()).toMatchObject({ catalogTier: "large", endsAt: END });
  });

  it("recusa sem termo, com termo agendado, com renovação agendada e com o anual desligado", async () => {
    const none = await fixture();
    expect(await code(requestUpgrade(none))).toBe("ANNUAL_TERM_REQUIRED");
    // Not started yet: upgraded once it starts.
    const scheduled = await fixture();
    await payMonthly(scheduled, scheduled.owner, scheduled.organizationId);
    const next = await requestAnnual(scheduled.owner, scheduled.organizationId, "renewal");
    await confirm(scheduled, next.id, "annual-next-upgrade");
    expect(await code(requestUpgrade(scheduled))).toBe("ANNUAL_TERM_SCHEDULED");
    // The renewal was paid at its own tier: the term it follows is no longer upgraded.
    const renewed = await fixture();
    await annualNow(renewed);
    vi.setSystemTime(Date.UTC(2027, 8, 15));
    const renewal = await requestAnnual(
      await person(renewed.t, renewed.organizationId, "owner"),
      renewed.organizationId,
      "renewal",
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

  it("a confirmação vale só no mês do termo do pedido e recusa a admissão sem gravar nada", async () => {
    const f = await fixture();
    await annualNow(f);
    vi.setSystemTime(FEB);
    const late = await requestUpgrade(f);
    vi.setSystemTime(MAR_10);
    // From the next term month the same difference covers one month fewer.
    expect(await code(confirm(f, late.id, "annual-upgrade-late", 233333))).toBe(
      "PLAN_REQUEST_UNAVAILABLE",
    );
    // The civil month turning does not end the term month.
    vi.setSystemTime(OCT);
    const h = await fixture();
    await annualNow(h);
    vi.setSystemTime(FEB);
    const inMarch = await requestUpgrade(h);
    vi.setSystemTime(MAR_10 - 1);
    await confirm(h, inMarch.id, "annual-upgrade-march", 233333);
    expect(await h.terms()).toMatchObject([{ segments: [{ tier: "large", fromPeriod: FEB_10 }] }]);

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
  /** In the 5th term month of a term from `OCT`, which runs from 10/02 to 10/03 at 12:00 UTC. */
  const FEB = Date.UTC(2027, 1, 11, 9);
  const FEB_10 = Date.UTC(2027, 1, 10, 12);
  const MAR_10 = Date.UTC(2027, 2, 10, 12);
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
        accessEndsAt: FEB_10,
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
        accessEndsAt: FEB_10,
      },
    });
    // Access until the end of the term month, 10/02 at 12:00 UTC, at the same tier, with the
    // same quota periods.
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      termId: annual._id,
      endsAt: FEB_10,
      periodAnchor: OCT,
      version: 2,
    });
    // The reservation stays, as on any expiry: only the legal purge returns it.
    expect(await stock(f)).toEqual(reserved);
    // The same key answers the same rescission; another one is refused.
    expect(await rescind(f, annual._id)).toEqual(result);
    expect(await code(rescind(f, annual._id, "rescission-other"))).toBe("TERM_RESCINDED");
    expect(await f.plan()).toMatchObject({ version: 2 });
    // The access left is a paid plan in force: any sale, a larger monthly or an annual
    // included, waits for its end (ADR 0012, one paid plan at a time).
    const owner = await person(f.t, f.organizationId, "owner");
    for (const tier of ["intermediate", "large"] as const)
      expect(
        await refusal(
          owner.mutation(api.plans.requestPaid, {
            organizationId: f.organizationId,
            tier,
            key: `monthly-after-rescission-${tier}`,
          }),
        ),
      ).toEqual({ code: "PLAN_UNAVAILABLE", availableAt: FEB_10 });
    for (const start of ["now", "renewal"] as const)
      expect(
        await refusal(requestAnnual(owner, f.organizationId, start, `after-rescission-${start}`)),
      ).toEqual({
        code: "PLAN_UNAVAILABLE",
        availableAt: FEB_10,
      });
    await runUntil(f, FEB_10);
    const ended = await f.plan();
    expect(ended).toMatchObject({ endsAt: FEB_10, version: 2, updatedAt: FEB_10 });
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
      { cents: 60000, reference: "pix-refund-0001", actor: OPERATOR, at: FEB_10 },
      { cents: 29400, reference: "pix-refund-0002", actor: OPERATOR, at: FEB_10 },
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
    // Access until the end of the term's first month, 10/11 at 12:00 UTC.
    expect(await rescind(g, late._id)).toMatchObject([
      {
        withdrawal: false,
        usedMonths: 1,
        refundCents: 149000 - 14900,
        accessEndsAt: Date.UTC(2026, 10, 10, 12),
      },
    ]);
  });

  it("a partir do 10º mês o reembolso é zero e não há o que registrar", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    // 02/07 is still the 9th term month; the 10th starts on 10/07 at 12:00 UTC.
    vi.setSystemTime(Date.UTC(2027, 6, 2));
    expect(await rescind(f, annual._id)).toMatchObject([
      { usedMonths: 9, refundCents: 14900, accessEndsAt: Date.UTC(2027, 6, 10, 12) },
    ]);
    vi.setSystemTime(OCT);
    const h = await fixture();
    const tenth = await annualNow(h);
    vi.setSystemTime(Date.UTC(2027, 6, 10, 12));
    expect(await rescind(h, tenth._id)).toMatchObject([
      { usedMonths: 10, refundCents: 0, accessEndsAt: Date.UTC(2027, 7, 10, 12) },
    ]);
    expect(await code(refund(h, tenth._id, 1))).toBe("REFUND_NOT_DUE");
    expect(await refund(f, annual._id, 14900)).toEqual({
      refundCents: 14900,
      refundedCents: 14900,
    });
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
    // The 8th term month starts on 10/05 at 12:00 UTC.
    vi.setSystemTime(Date.UTC(2027, 4, 10, 12));
    // 4 × R$ 149 + 4 × R$ 499 used, out of R$ 1.490 + R$ 2.333,33 paid.
    expect(await rescind(f, annual._id)).toEqual([
      {
        termId: annual._id,
        withdrawal: false,
        usedMonths: 8,
        refundCents: 123133,
        accessEndsAt: Date.UTC(2027, 5, 10, 12),
      },
    ]);
    const rescinded = (await term(f, annual._id))!;
    expect(rescinded).toMatchObject({
      paidCents: 382333,
      segments: [{ tier: "large", fromPeriod: FEB_10 }],
      rescission: { usedCents: 4 * 14900 + 4 * 49900, refundCents: 123133 },
    });
    expect(rescinded.undoneUpgrades).toBeUndefined();
    expect(await f.plan()).toMatchObject({
      catalogTier: "large",
      endsAt: Date.UTC(2027, 5, 10, 12),
    });
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
          fromPeriod: FEB_10,
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
    vi.setSystemTime(Date.UTC(2027, 4, 10, 12));
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
        accessEndsAt: MAR_10,
      },
    ]);
    expect(await term(f, annual._id)).toMatchObject({
      state: "rescinded",
      segments: [],
      paidCents: 149000,
      undoneUpgrades: [{ reference: "annual-upgrade-ref", refundCents: 233333, via: "rescission" }],
    });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: MAR_10 });
    // The rescission's key does not answer for an undo.
    expect(await code(undo(f, annual._id, "rescission-key"))).toBe("OPERATION_CONFLICT");
  });

  it("um termo agendado com a ativação recusada não usou nada: tudo volta, sem acesso a encerrar", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const request = await requestAnnual(f.owner, f.organizationId, "renewal");
    await confirm(f, request.id, "annual-blocked-ref");
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").first())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { enabled: false });
    });
    await runUntil(f, MONTHLY_END);
    const [blocked] = await f.terms();
    expect(blocked).toMatchObject({ state: "scheduled", blockedCode: "PLANS_DISABLED" });
    const monthly = await f.plan();
    expect(monthly).toMatchObject({ endsAt: MONTHLY_END });
    expect(monthly).not.toHaveProperty("termId");
    // In its first month and past the 7 days of the payment: still nothing was used.
    const at = MONTHLY_END + 10 * DAY;
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
    expect(await f.plan()).toEqual(monthly);
  });

  it("leva junto a renovação agendada, já paga, com tudo devolvido, e cancela o pedido anual pendente", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    // The first instant of the term's last month: the renewal opens.
    const SEP = LAST_MONTH;
    vi.setSystemTime(SEP - 1);
    const owner = await person(f.t, f.organizationId, "owner");
    expect(
      await refusal(requestAnnual(owner, f.organizationId, "renewal", "annual-renewal")),
    ).toEqual({ code: "ANNUAL_TERM_ACTIVE", availableAt: SEP });
    vi.setSystemTime(SEP);
    const next = await requestAnnual(owner, f.organizationId, "renewal", "annual-renewal");
    await confirm(f, next.id, "annual-renewal-ref");
    const renewal = (await f.terms()).find((row) => row._id !== annual._id)!;
    expect(renewal).toMatchObject({ state: "scheduled", firstPeriod: END, anchor: OCT });
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
      "renewal",
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

describe("pedidos anteriores à fatia 1b e pedidos vencidos", () => {
  /** An annual request as written before slice 1b: a term from a 1st, without `anchor`. */
  const legacy = (f: Fixture, firstPeriod: number, key: string, period: string, endsAt: number) =>
    f.t.run((ctx) =>
      ctx.db.insert("platformPlanRequests", {
        organizationId: f.organizationId,
        tier: "intermediate",
        key,
        cycle: "annual",
        firstPeriod,
        amountCents: 149000,
        period,
        startsAt: OCT,
        endsAt,
        expectedVersion: 0,
        state: "awaiting_payment",
        requestedBy: "synthetic",
        createdAt: OCT,
        updatedAt: OCT,
      }),
    );

  it("um now ou next anterior à 1b é mostrado, repetido e confirmado como foi pedido", async () => {
    const f = await fixture();
    const now = await legacy(f, OCT_1, "legacy-now-key", "2026-10", NOV);
    expect((await view(f)).request).toMatchObject({
      id: now,
      start: "now",
      firstPeriod: OCT_1,
      periodStartsAt: OCT_1,
      expired: false,
    });
    expect(await requestAnnual(f.owner, f.organizationId, "now", "legacy-now-key")).toMatchObject({
      id: now,
    });
    await confirm(f, now, "legacy-now-ref");
    expect(await f.terms()).toMatchObject([
      { state: "active", firstPeriod: OCT_1, endsAt: termEndsAt(OCT_1) },
    ]);

    const g = await fixture();
    const next = await legacy(g, NOV, "legacy-next-key", "2026-11", DEC);
    expect((await view(g)).request).toMatchObject({ id: next, start: "next", firstPeriod: NOV });
    const replay = (key: string) =>
      g.owner.mutation(api.plans.requestPaid, {
        organizationId: g.organizationId,
        tier: "intermediate",
        key,
        cycle: "annual",
        start: "next",
      });
    expect(await replay("legacy-next-key")).toMatchObject({ id: next });
    // Nothing new starts on the next 1st.
    expect(await code(replay("brand-new-next"))).toBe("INVALID_REQUEST");
    await confirm(g, next, "legacy-next-ref");
    expect(await g.terms()).toMatchObject([{ state: "scheduled", firstPeriod: NOV }]);
  });

  it("um pedido vencido não segura a organização e o pedido seguinte o cancela", async () => {
    const f = await fixture();
    const stale = await requestAnnual(f.owner, f.organizationId, "now");
    vi.setSystemTime(OCT + 7 * DAY);
    const owner = await person(f.t, f.organizationId, "owner");
    expect(await view(f)).toMatchObject({
      request: { id: stale.id, payBy: OCT + 7 * DAY, expired: true },
      availability: { canClaimFree: true },
    });
    const fresh = await requestAnnual(owner, f.organizationId, "now", "annual-fresh");
    expect(await f.t.run((ctx) => ctx.db.get("platformPlanRequests", stale.id))).toMatchObject({
      state: "cancelled",
    });
    expect((await view(f)).request).toMatchObject({ id: fresh.id, expired: false });
    // Within its deadline, a request still holds the next one.
    expect(await code(requestAnnual(owner, f.organizationId, "now", "annual-third"))).toBe(
      "PLAN_REQUEST_PENDING",
    );
  });
});

describe("visão do anual no console (plans:overview)", () => {
  const FEB = Date.UTC(2027, 1, 11, 9);
  const FEB_10 = Date.UTC(2027, 1, 10, 12);
  /** The card term below starts on a 1st: its months are the civil ones. */
  const FEB_1 = Date.UTC(2027, 1, 1);
  const CARD_END = termEndsAt(OCT_1);

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

  it("com um Checkout aberto, o anual por Pix não é oferecido, como o pedido o recusa", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.insert("billingCheckouts", {
        organizationId: f.organizationId,
        key: "open-card-checkout",
        kind: "start",
        tier: "intermediate",
        period: "2026-10",
        grantCents: 14900,
        state: "open",
        expiresAt: OCT + 3600_000,
        requestedBy: "synthetic",
        createdAt: OCT,
        updatedAt: OCT,
      }),
    );
    expect((await view(f)).annualStart).toEqual({
      start: null,
      startsAt: null,
      endsAt: null,
      code: "PAYMENT_METHOD_CARD",
      availableAt: null,
    });
    expect(await refusal(requestAnnual(f.owner, f.organizationId, "now"))).toEqual({
      code: "PAYMENT_METHOD_CARD",
    });
  });

  it("mostra o pedido anual, o termo agendado sem upgrade e o termo em vigor com o preço do upgrade", async () => {
    const f = await fixture();
    await payMonthly(f, f.owner, f.organizationId);
    const next = await requestAnnual(f.owner, f.organizationId, "renewal");
    expect((await view(f)).request).toMatchObject({
      id: next.id,
      tier: "intermediate",
      cycle: "annual",
      start: "renewal",
      firstPeriod: MONTHLY_END,
      periodStartsAt: MONTHLY_END,
      payBy: addMonths(OCT, 2),
      amountCents: 149000,
      state: "awaiting_payment",
    });
    await confirm(f, next.id, "annual-view-next");
    expect((await view(f)).terms).toEqual([
      {
        id: expect.any(String),
        tier: "intermediate",
        segments: [],
        firstPeriod: MONTHLY_END,
        endsAt: RENEWAL_END,
        renewalFrom: Date.UTC(2027, 9, 10, 12),
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
    // Starting at the confirmation: no instant to show yet, only the deadline.
    expect((await view(g)).request).toMatchObject({
      start: "now",
      firstPeriod: null,
      periodStartsAt: null,
      periodEndsAt: null,
      payBy: OCT + 7 * DAY,
    });
    await confirm(g, now.id, "annual-view-now");
    // The first month: the upgrade covers all 12 months.
    expect((await view(g)).terms).toMatchObject([
      {
        state: "active",
        firstPeriod: OCT,
        endsAt: END,
        renewalFrom: LAST_MONTH,
        upgrade: {
          tier: "large",
          amountCents: 350000,
          months: 12,
          from: OCT,
          until: Date.UTC(2026, 10, 10, 12),
          cardUntil: null,
        },
      },
    ]);
    // The 5th term month: 8 months left, the same price the request is charged.
    vi.setSystemTime(FEB);
    expect((await view(g)).terms[0]!.upgrade).toEqual({
      tier: "large",
      amountCents: 233333,
      months: 8,
      from: FEB_10,
      until: Date.UTC(2027, 2, 10, 12),
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
      firstPeriod: FEB_10,
      periodStartsAt: FEB_10,
      payBy: Date.UTC(2027, 2, 10, 12),
      amountCents: 233333,
    });
    await confirm(g, upgrade.id, "annual-view-upgrade-ref", 233333);
    // Upgraded: the segment shows, and there is nothing left to raise.
    expect((await view(g)).terms).toMatchObject([
      { tier: "intermediate", segments: [{ tier: "large", fromPeriod: FEB_10 }], upgrade: null },
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
      // A term in force holds a new annual until its last month, when its renewal opens.
      annualStart: {
        start: null,
        startsAt: null,
        endsAt: null,
        code: "ANNUAL_TERM_ACTIVE",
        availableAt: LAST_MONTH,
      },
      terms: [{ state: "active", upgrade: null }],
    });
    const g = await fixture();
    expect((await view(g)).annualStart).toEqual({
      start: "now",
      startsAt: null,
      endsAt: null,
      code: null,
      availableAt: null,
    });
    await confirm(g, (await requestAnnual(g.owner, g.organizationId, "now")).id, "annual-a");
    vi.setSystemTime(LAST_MONTH);
    // The last month: only the renewal, from the end of the term, keeping its anchor.
    expect((await view(g)).annualStart).toEqual({
      start: "renewal",
      startsAt: END,
      endsAt: termEndsAt(END),
      code: null,
      availableAt: null,
    });
    const owner = await person(g.t, g.organizationId, "owner");
    await confirm(
      g,
      (await requestAnnual(owner, g.organizationId, "renewal", "annual-renewal")).id,
      "annual-b",
    );
    expect((await view(g)).terms).toMatchObject([
      { state: "active", firstPeriod: OCT, upgrade: null },
      { state: "scheduled", firstPeriod: END, upgrade: null },
    ]);
    // The next renewal opens in the renewal's own last month.
    expect((await view(g)).annualStart).toMatchObject({
      start: null,
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: Date.UTC(2028, 8, 10, 12),
    });
  });

  it("o termo do cartão fecha o upgrade 72 horas antes do fim, e o rescindido mostra o fim do acesso", async () => {
    const f = await fixture();
    const termId = await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: CARD_END,
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
      { source: "stripe", renews: false, upgrade: { cardUntil: CARD_END - 72 * 3600_000 } },
    ]);
    const subscription = (cancelAtPeriodEnd: boolean) => ({
      id: "sub_annual_view",
      status: "active",
      tier: "intermediate" as const,
      cancelAtPeriodEnd,
      periodEnd: CARD_END,
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
