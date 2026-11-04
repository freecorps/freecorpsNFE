import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { enablePix, platformTest, person, usePlatformEnvironment } from "./helpers/platform";
import { addMonths } from "../platform/convex/lib/annualTerms";
import { activateCatalogPlan } from "../platform/convex/lib/planCore";
import { checkUsage, reserveUsage } from "../platform/convex/lib/usageCore";
import { quotaPeriod } from "../platform/convex/lib/quotaPeriod";
import { PLATFORM_PLANS } from "../platform/convex/lib/planCatalog";

/**
 * The monthly plan sold by assisted Pix on anniversaries (ADR 0012, slice 1c): `now` starts at the
 * confirmation, a renewal at the end of the Pix plan in force and an upgrade now, all keeping the
 * chain's anchor; any other sale waits for the plan in force, with the date it opens.
 */
const CONFIRMED = Date.UTC(2027, 0, 31, 10, 0, 7, 450);
/** The anchor: the confirmation truncated to the second. */
const ANCHOR = Date.UTC(2027, 0, 31, 10, 0, 7);
const FEB_28 = Date.UTC(2027, 1, 28, 10, 0, 7);
const MAR_31 = Date.UTC(2027, 2, 31, 10, 0, 7);
const APR_30 = Date.UTC(2027, 3, 30, 10, 0, 7);
const DAY = 24 * 60 * 60 * 1000;
usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-monthly-pix-only",
  now: CONFIRMED,
});

type Tier = "intermediate" | "large";
async function fixture({ annual = false } = {}) {
  const t = platformTest();
  const organizationId = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Organização sintética",
      slug: crypto.randomUUID(),
      ownerCount: 1,
      memberCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await t.mutation(internal.plans.configure, {
    enabled: true,
    expectedVersion: 0,
    filesBytes: 10 * 2 ** 30,
    databaseBytes: 2 ** 30,
    custodyCents: 1_000_000,
    freeMonthlyCents: 10000,
    admissionsUntil: Date.UTC(2029, 11, 31),
    evidence: "synthetic-local-proof",
  });
  await enablePix(t);
  if (annual)
    await t.mutation(internal.plans.configureAnnual, {
      enabled: true,
      expectedVersion: 1,
      evidence: "synthetic-annual-on",
    });
  const plan = () =>
    t.run((ctx) =>
      ctx.db
        .query("usagePlans")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .unique(),
    );
  const stored = (id: Id<"platformPlanRequests">) =>
    t.run((ctx) => ctx.db.get("platformPlanRequests", id));
  // Sessions last an hour: each step of a long chain signs in again.
  const owner = () => person(t, organizationId, "owner");
  const request = async (tier: Tier, key: string) =>
    (await owner()).mutation(api.plans.requestPaid, { organizationId, tier, key });
  const requestAnnual = async (start: "now" | "renewal", key: string, tier: Tier = "large") =>
    (await owner()).mutation(api.plans.requestPaid, {
      organizationId,
      tier,
      key,
      cycle: "annual",
      start,
    });
  const confirm = (requestId: Id<"platformPlanRequests">, amountCents: number, ref: string) =>
    t.mutation(internal.plans.confirmPayment, {
      requestId,
      amountCents,
      paymentReference: ref,
      actor: "operator",
    });
  const view = async () =>
    (await owner()).query(api.plans.overview, { organizationId, contextKey: "monthly" });
  return { t, organizationId, plan, stored, owner, request, requestAnnual, confirm, view };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
/** The refusal's data: its code and, for a sale that waits, when it becomes available. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: unknown }) => error.data,
  );
/** Runs what the scheduler has due at `at`, as the deployment would. */
async function runUntil(f: Fixture, at: number) {
  vi.advanceTimersByTime(at - Date.now());
  await f.t.finishInProgressScheduledFunctions();
}
/** Pays a monthly Pix of `tier` now and returns the request. */
async function payNow(f: Fixture, tier: Tier = "intermediate", key = "monthly-now") {
  const request = await f.request(tier, key);
  await f.confirm(request.id, request.amountCents, `${key}-ref`);
  return request;
}
const usage = (f: Fixture, key: string) =>
  code(f.t.run((ctx) => checkUsage(ctx, f.organizationId, "production", "imports", key)));

describe("mensal por Pix nos aniversários", () => {
  it("começa na confirmação, truncada ao segundo, e renova em 28/02 e 31/03, sem deriva", async () => {
    const f = await fixture();
    const now = await f.request("intermediate", "monthly-now");
    // No civil month is bought: the request is paid within 7 days and the month runs from then.
    expect(now).toEqual({ id: now.id, amountCents: 14900 });
    const asked = await f.stored(now.id);
    expect(asked).toMatchObject({ start: "now", startsAt: CONFIRMED, endsAt: CONFIRMED + 7 * DAY });
    expect(asked).not.toHaveProperty("period");
    expect(asked).not.toHaveProperty("firstPeriod");
    expect((await f.view()).request).toMatchObject({
      cycle: "monthly",
      start: "now",
      periodStartsAt: null,
      periodEndsAt: null,
      payBy: CONFIRMED + 7 * DAY,
    });
    await f.confirm(now.id, 14900, "monthly-now-ref");
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      startsAt: ANCHOR,
      periodAnchor: ANCHOR,
      endsAt: FEB_28,
      version: 1,
    });

    // The same tier in the month in force is its renewal: from its end, with its anchor.
    vi.setSystemTime(Date.UTC(2027, 1, 20));
    expect((await f.view()).monthlyStart).toEqual({
      intermediate: {
        start: "renewal",
        amountCents: 14900,
        startsAt: FEB_28,
        endsAt: MAR_31,
        code: null,
        availableAt: null,
      },
      large: {
        start: "upgrade",
        amountCents: 35000,
        startsAt: null,
        endsAt: FEB_28,
        code: null,
        availableAt: null,
      },
    });
    const renewal = await f.request("intermediate", "monthly-renewal-1");
    expect(renewal).toEqual({ id: renewal.id, amountCents: 14900 });
    expect(await f.stored(renewal.id)).toMatchObject({
      start: "renewal",
      firstPeriod: FEB_28,
      anchor: ANCHOR,
      // Paid within the month it buys, as the annual renewal within its first month.
      endsAt: MAR_31,
    });
    expect((await f.view()).request).toMatchObject({
      start: "renewal",
      periodStartsAt: FEB_28,
      periodEndsAt: MAR_31,
      payBy: MAR_31,
    });
    const monthly = await f.plan();
    await f.confirm(renewal.id, 14900, "monthly-renewal-1-ref");
    // Paid before its start: the month in force runs on, and the renewal waits for it.
    expect(await f.plan()).toEqual(monthly);
    expect(await f.stored(renewal.id)).toMatchObject({ state: "activated", scheduled: true });
    const waiting = await f.view();
    expect(waiting.scheduledRenewal).toEqual({
      tier: "intermediate",
      startsAt: FEB_28,
      endsAt: MAR_31,
      blocked: false,
    });
    // Renewed: nothing else is sold until the renewal starts.
    expect(waiting.monthlyStart.large).toMatchObject({
      start: null,
      code: "PLAN_UNAVAILABLE",
      availableAt: FEB_28,
    });
    expect(await refusal(f.request("large", "monthly-after-renewal"))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: FEB_28,
    });

    // The quota period turns on the anniversary, to the second, with the plan.
    const limit = PLATFORM_PLANS.intermediate.limits.imports;
    await f.t.run((ctx) =>
      reserveUsage(ctx, f.organizationId, "production", "imports", "february-fill", limit),
    );
    await runUntil(f, FEB_28 - 1);
    expect(await usage(f, "february-last-ms")).toBe("QUOTA_EXCEEDED");
    await runUntil(f, FEB_28);
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      startsAt: FEB_28,
      periodAnchor: ANCHOR,
      endsAt: MAR_31,
      version: 2,
    });
    expect(await f.stored(renewal.id)).not.toHaveProperty("scheduled");
    expect(await usage(f, "march-first")).toBe("OK");
    expect(quotaPeriod(await f.plan(), FEB_28)).toEqual({
      key: "2027-02-28T10:00:07.000Z",
      startsAt: FEB_28,
      endsAt: MAR_31,
    });
    // Running the activation again changes nothing.
    await f.t.mutation(internal.plans.activatePixRenewal, { requestId: renewal.id });
    expect(await f.plan()).toMatchObject({ version: 2 });

    // From the original anchor: 31/03, not 28/03, and then 30/04.
    vi.setSystemTime(Date.UTC(2027, 2, 25));
    const next = await f.request("intermediate", "monthly-renewal-2");
    expect(await f.stored(next.id)).toMatchObject({ firstPeriod: MAR_31, anchor: ANCHOR });
    await f.confirm(next.id, 14900, "monthly-renewal-2-ref");
    await runUntil(f, MAR_31);
    expect(await f.plan()).toMatchObject({
      startsAt: MAR_31,
      periodAnchor: ANCHOR,
      endsAt: APR_30,
      version: 3,
    });
    expect(quotaPeriod(await f.plan(), MAR_31).key).toBe("2027-03-31T10:00:07.000Z");
  });

  it("a renovação paga depois do fim começa na hora, até o mesmo aniversário; depois dele, é recusada", async () => {
    const f = await fixture();
    await payNow(f);
    vi.setSystemTime(Date.UTC(2027, 1, 20));
    const late = await f.request("intermediate", "monthly-late");
    expect(await code(f.request("intermediate", "monthly-second"))).toBe("PLAN_REQUEST_PENDING");
    vi.setSystemTime(Date.UTC(2027, 2, 5, 15));
    await f.confirm(late.id, 14900, "monthly-late-ref");
    expect(await f.plan()).toMatchObject({
      startsAt: Date.UTC(2027, 2, 5, 15),
      periodAnchor: ANCHOR,
      endsAt: MAR_31,
    });
    expect(await f.stored(late.id)).not.toHaveProperty("scheduled");

    vi.setSystemTime(CONFIRMED);
    const g = await fixture();
    await payNow(g);
    vi.setSystemTime(Date.UTC(2027, 1, 20));
    const missed = await g.request("intermediate", "monthly-missed");
    vi.setSystemTime(MAR_31);
    expect(await code(g.confirm(missed.id, 14900, "monthly-missed-ref"))).toBe(
      "PLAN_REQUEST_UNAVAILABLE",
    );
    expect(await g.plan()).toMatchObject({ endsAt: FEB_28 });
  });

  it("o upgrade cobra a diferença agora, no mesmo período, com a mesma âncora e o mesmo fim", async () => {
    const f = await fixture();
    await payNow(f);
    vi.setSystemTime(Date.UTC(2027, 1, 10, 9));
    await f.t.run((ctx) =>
      reserveUsage(ctx, f.organizationId, "production", "imports", "before-upgrade", 5),
    );
    const before = quotaPeriod(await f.plan(), Date.now());
    const upgrade = await f.request("large", "monthly-upgrade");
    expect(upgrade).toEqual({ id: upgrade.id, amountCents: 35000 });
    expect(await f.stored(upgrade.id)).toMatchObject({ start: "upgrade", endsAt: FEB_28 });
    expect(await f.stored(upgrade.id)).not.toHaveProperty("firstPeriod");
    expect((await f.view()).request).toMatchObject({
      start: "upgrade",
      periodStartsAt: null,
      periodEndsAt: FEB_28,
      payBy: FEB_28,
    });
    await f.confirm(upgrade.id, 35000, "monthly-upgrade-ref");
    const plan = await f.plan();
    expect(plan).toMatchObject({
      catalogTier: "large",
      startsAt: Date.UTC(2027, 1, 10, 9),
      periodAnchor: ANCHOR,
      endsAt: FEB_28,
      version: 2,
    });
    // The same quota period: what was used stays counted.
    expect(quotaPeriod(plan, Date.now())).toEqual(before);
    expect(
      await f.t.run(async (ctx) =>
        (await ctx.db.query("usageEvents").collect()).map((event) => event.period),
      ),
    ).toEqual([before.key]);
    // A downgrade only comes as the renewal.
    expect((await f.view()).monthlyStart.intermediate).toMatchObject({
      start: "renewal",
      startsAt: FEB_28,
      endsAt: MAR_31,
    });
  });

  it("no último mês de um termo anual Pix, o mensal renova no fim dele com a âncora da cadeia, e o anual volta a renová-lo", async () => {
    const f = await fixture({ annual: true });
    const annual = await f.requestAnnual("now", "annual-now", "intermediate");
    await f.confirm(annual.id, PLATFORM_PLANS.intermediate.annualCents, "annual-now-ref");
    const termEnd = addMonths(ANCHOR, 12);
    const lastMonth = addMonths(ANCHOR, 11);
    // Outside the last month, the monthly waits for it.
    vi.setSystemTime(Date.UTC(2027, 11, 1));
    expect(await refusal(f.request("large", "monthly-too-early"))).toEqual({
      code: "ANNUAL_TERM_ACTIVE",
      availableAt: lastMonth,
    });
    // In it, any tier renews the term at its end, keeping the chain's anchor: 29/02 in 2028.
    vi.setSystemTime(Date.UTC(2028, 0, 20));
    const renewal = await f.request("large", "monthly-after-annual");
    expect(renewal.amountCents).toBe(PLATFORM_PLANS.large.monthlyCents);
    const leapEnd = Date.UTC(2028, 1, 29, 10, 0, 7);
    expect(await f.stored(renewal.id)).toMatchObject({
      start: "renewal",
      firstPeriod: termEnd,
      anchor: ANCHOR,
      endsAt: leapEnd,
    });
    await f.confirm(renewal.id, PLATFORM_PLANS.large.monthlyCents, "monthly-after-annual-ref");
    await runUntil(f, termEnd);
    const monthly = await f.plan();
    expect(monthly).toMatchObject({
      catalogTier: "large",
      startsAt: termEnd,
      periodAnchor: ANCHOR,
      endsAt: leapEnd,
    });
    expect(monthly).not.toHaveProperty("termId");
    // The annual by Pix renews the monthly at its end, on the same chain: 28/02/2029.
    vi.setSystemTime(Date.UTC(2028, 1, 20));
    const back = await f.requestAnnual("renewal", "annual-after-monthly", "intermediate");
    expect(await f.stored(back.id)).toMatchObject({ firstPeriod: leapEnd, anchor: ANCHOR });
    await f.confirm(back.id, PLATFORM_PLANS.intermediate.annualCents, "annual-after-monthly-ref");
    await runUntil(f, leapEnd);
    expect(await f.plan()).toMatchObject({
      catalogTier: "intermediate",
      startsAt: leapEnd,
      periodAnchor: ANCHOR,
      endsAt: Date.UTC(2029, 1, 28, 10, 0, 7),
    });
  });
});

describe("um plano pago por vez no mensal por Pix", () => {
  it("com um plano do cartão em vigor, mesmo sem renovação, o Pix espera o fim dele, inclusive num tier maior", async () => {
    const f = await fixture();
    const cardEnd = Date.UTC(2027, 1, 1);
    await f.t.run(async (ctx) => {
      await activateCatalogPlan(
        ctx,
        f.organizationId,
        "intermediate",
        Date.now(),
        cardEnd,
        0,
        "stripe:in_card_monthly",
        "Fatura do cartão",
      );
      await ctx.db.insert("billingGrants", {
        organizationId: f.organizationId,
        invoiceId: "in_card_monthly",
        tier: "intermediate",
        period: "2027-01",
        amountCents: 14900,
        state: "applied",
        planVersion: 1,
        createdAt: Date.now(),
      });
      await ctx.db.insert("billingAccounts", {
        organizationId: f.organizationId,
        customerId: "cus_cancelled",
        livemode: false,
        subscription: {
          id: "sub_cancelled",
          status: "active",
          tier: "intermediate",
          cancelAtPeriodEnd: true,
          periodEnd: cardEnd,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    for (const tier of ["intermediate", "large"] as const)
      expect(await refusal(f.request(tier, `pix-over-card-${tier}`))).toEqual({
        code: "PAYMENT_METHOD_CARD",
        availableAt: cardEnd,
      });
    expect((await f.view()).monthlyStart.large).toMatchObject({
      start: null,
      code: "PAYMENT_METHOD_CARD",
      availableAt: cardEnd,
    });
    // With the card renewing, no date: it depends on the client cancelling it.
    await f.t.run(async (ctx) => {
      const account = (await ctx.db.query("billingAccounts").first())!;
      await ctx.db.patch("billingAccounts", account._id, {
        subscription: { ...account.subscription!, cancelAtPeriodEnd: false },
      });
    });
    expect(await refusal(f.request("large", "pix-over-renewing-card"))).toEqual({
      code: "PAYMENT_METHOD_CARD",
    });
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanRequests").collect())).toEqual([]);
  });

  it("um now pedido sem plano é recusado na confirmação se um plano pago entrou em vigor", async () => {
    const f = await fixture();
    const first = await f.request("intermediate", "monthly-first");
    // Another `now` paid meanwhile, as an operator assignment would, changes the plan.
    await f.t.run((ctx) =>
      activateCatalogPlan(
        ctx,
        f.organizationId,
        "large",
        ANCHOR,
        FEB_28,
        0,
        "operator",
        "Mensal sintético",
        undefined,
        ANCHOR,
      ),
    );
    expect(await refusal(f.confirm(first.id, 14900, "monthly-first-ref"))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: FEB_28,
    });
  });

  it("uma renovação com a ativação recusada fica registrada e o operador a repete", async () => {
    const f = await fixture();
    await payNow(f);
    vi.setSystemTime(Date.UTC(2027, 1, 20));
    const renewal = await f.request("intermediate", "monthly-blocked");
    await f.confirm(renewal.id, 14900, "monthly-blocked-ref");
    const catalog = (enabled: boolean) =>
      f.t.run(async (ctx) => {
        const settings = (await ctx.db.query("platformPlanSettings").first())!;
        await ctx.db.patch("platformPlanSettings", settings._id, { enabled });
      });
    await catalog(false);
    await runUntil(f, FEB_28);
    expect(await f.stored(renewal.id)).toMatchObject({
      scheduled: true,
      blockedCode: "PLANS_DISABLED",
    });
    expect(await f.plan()).toMatchObject({ endsAt: FEB_28, version: 1 });
    await catalog(true);
    // Waiting for the team, it still holds the organization until the end of its month.
    expect((await f.view()).scheduledRenewal).toMatchObject({ blocked: true, endsAt: MAR_31 });
    expect(await refusal(f.request("large", "monthly-while-blocked"))).toEqual({
      code: "PLAN_UNAVAILABLE",
      availableAt: MAR_31,
    });
    await f.t.mutation(internal.plans.activatePixRenewal, { requestId: renewal.id });
    expect(await f.plan()).toMatchObject({ startsAt: FEB_28, endsAt: MAR_31, version: 2 });
    const done = await f.stored(renewal.id);
    expect(done).not.toHaveProperty("scheduled");
    expect(done).not.toHaveProperty("blockedCode");
  });

  it("com o Pix desligado responde PIX_DISABLED sem gravar", async () => {
    const f = await fixture();
    await f.t.mutation(internal.plans.configurePix, {
      enabled: false,
      expectedVersion: 1,
      evidence: "synthetic-pix-off",
    });
    expect(await code(f.request("intermediate", "monthly-pix-off"))).toBe("PIX_DISABLED");
    expect(await f.t.run((ctx) => ctx.db.query("platformPlanRequests").collect())).toEqual([]);
  });
});

describe("pedido mensal anterior à fatia 1c", () => {
  it("é repetido e confirmado como foi pedido: o mês civil, sem âncora", async () => {
    const f = await fixture();
    const owner = await f.owner();
    const id = await f.t.run((ctx) =>
      ctx.db.insert("platformPlanRequests", {
        organizationId: f.organizationId,
        tier: "intermediate",
        key: "legacy-monthly",
        cycle: "monthly",
        amountCents: 14900,
        period: "2027-01",
        startsAt: Date.now(),
        endsAt: Date.UTC(2027, 1, 1),
        expectedVersion: 0,
        state: "awaiting_payment",
        requestedBy: "legacy-user",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(
      await owner.mutation(api.plans.requestPaid, {
        organizationId: f.organizationId,
        tier: "intermediate",
        key: "legacy-monthly",
      }),
    ).toEqual({ id, amountCents: 14900, period: "2027-01" });
    expect((await f.view()).request).toMatchObject({
      start: null,
      periodStartsAt: Date.UTC(2027, 0, 1),
      periodEndsAt: Date.UTC(2027, 1, 1),
      payBy: Date.UTC(2027, 1, 1),
    });
    await f.confirm(id, 14900, "legacy-monthly-ref");
    const plan = await f.plan();
    expect(plan).toMatchObject({ catalogTier: "intermediate", endsAt: Date.UTC(2027, 1, 1) });
    expect(plan).not.toHaveProperty("periodAnchor");
    // Its renewal anchors a chain of its own at its end, a 1st at 00:00 UTC.
    const renewal = await f.request("intermediate", "legacy-renewal");
    expect(await f.stored(renewal.id)).toMatchObject({
      start: "renewal",
      firstPeriod: Date.UTC(2027, 1, 1),
      anchor: Date.UTC(2027, 1, 1),
      endsAt: Date.UTC(2027, 2, 1),
    });
  });
});
