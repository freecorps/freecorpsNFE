import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { platformTest, person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { addMonths, termEndsAt } from "./lib/annualTerms";
import { activateCatalogPlan, startTerm, upgradeTerm } from "./lib/planCore";
import {
  insertTerm,
  termMonth,
  termTierAt,
  termUpgradeCents,
  upgradableTerm,
} from "./lib/planTerms";
import { archiveStatus } from "./lib/coldArchiveCore";
import { planFor } from "./lib/usageCore";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import * as plansModule from "./plans";

/**
 * The annual term after it is paid (ADR 0010, decision 9, and ADR 0012): its scheduled start, the
 * grant it allows, the operator's rescission, withdrawn upgrade and refunds, the console's view of
 * it and the cold custody it holds. Terms are written as the card invoice writes them
 * (`startTerm`, `upgradeTerm`), without Stripe: `billing.test.ts` proves the invoices themselves.
 */
const OCT = Date.UTC(2026, 9, 10, 12);
const OCT_1 = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);
const DEC = Date.UTC(2026, 11, 1);
const DAY = 24 * 60 * 60 * 1000;
/** The term bought at `OCT`: from 10/10/2026 12:00 UTC to 10/10/2027 12:00 UTC. */
const END = termEndsAt(OCT);
/**
 * Its renewal, paid in its last month 10 days before the end: the fake timers hold at most 24.8
 * days ahead.
 */
const RENEWAL_PAID = END - 10 * DAY;
/** A monthly card plan signed at `OCT` ends on its first anniversary (ADR 0012). */
const MONTHLY_END = addMonths(OCT, 1);
/** The annual that follows that monthly starts at its end and keeps its anchor, `OCT`. */
const RENEWAL_END = termEndsAt(MONTHLY_END, OCT);
/** In the 5th term month, from 10/02 at 12:00 UTC to 10/03 at 12:00 UTC. */
const FEB = Date.UTC(2027, 1, 11, 9);
const FEB_10 = Date.UTC(2027, 1, 10, 12);
const MAR_10 = Date.UTC(2027, 2, 10, 12);
const OPERATOR = "operador-sintetico";
usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-annual-terms-only",
  now: OCT,
});

type Tier = "intermediate" | "large";
async function fixture({ annual = true } = {}) {
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
  const terms = () => t.run((ctx) => ctx.db.query("platformPlanTerms").collect());
  return { t, organizationId, owner, plan, terms };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { data?: { code?: string } | string }) =>
      typeof error.data === "string" ? error.data : (error.data?.code ?? "ERROR"),
  );
/** Runs what the scheduler has due at `at`, as the deployment would. */
async function runUntil(f: Fixture, at: number) {
  vi.advanceTimersByTime(at - Date.now());
  await f.t.finishInProgressScheduledFunctions();
}
const view = async (f: Fixture) =>
  (await person(f.t, f.organizationId, "owner")).query(api.plans.overview, {
    asOf: Date.now(),
    organizationId: f.organizationId,
    contextKey: "annual-view",
  });

/** An Intermediário annual paid now: the term starts at once and the plan is granted. */
async function annualNow(f: Fixture, reference = "in_annual_ref") {
  const termId = await f.t.run(async (ctx) =>
    startTerm(
      ctx,
      {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: Date.now(),
        endsAt: termEndsAt(Date.now()),
        source: "stripe",
        references: [reference],
        paidCents: 149000,
        purchasedAt: Date.now(),
        segments: [],
      },
      {
        expectedVersion: (await planFor(ctx, f.organizationId))?.version ?? 0,
        actor: `stripe:${reference}`,
        reason: "Pagamento anual por cartão confirmado (Stripe)",
      },
    ),
  );
  return (await f.t.run((ctx) => ctx.db.get("platformPlanTerms", termId)))!;
}
/** A monthly card plan signed at `OCT`, to `MONTHLY_END`, anchored there. */
const monthly = (f: Fixture) =>
  f.t.run((ctx) =>
    activateCatalogPlan(
      ctx,
      f.organizationId,
      "intermediate",
      OCT,
      MONTHLY_END,
      0,
      "stripe:in_monthly",
      "Pagamento mensal por cartão confirmado (Stripe)",
      undefined,
      OCT,
    ),
  );
/** The annual that renews the plan in force at `firstPeriod`, paid now, before it starts. */
const renewal = (f: Fixture, firstPeriod: number, reference = "in_annual_renewal") =>
  f.t.run(async (ctx) =>
    startTerm(
      ctx,
      {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod,
        anchor: OCT,
        endsAt: termEndsAt(firstPeriod, OCT),
        source: "stripe",
        references: [reference],
        paidCents: 149000,
        purchasedAt: Date.now(),
        segments: [],
      },
      {
        expectedVersion: (await planFor(ctx, f.organizationId))!.version,
        actor: `stripe:${reference}`,
        reason: "Pagamento anual por cartão confirmado (Stripe)",
      },
    ),
  );
/** The upgrade to Grande paid at `at`, priced on the term month under way. */
async function upgradeAt(f: Fixture, at: number, amountCents: number) {
  vi.setSystemTime(at);
  await f.t.run(async (ctx) => {
    const term = await upgradableTerm(ctx, f.organizationId, at);
    const month = termMonth(term, at);
    expect(termUpgradeCents(term, "large", month.startsAt)).toBe(amountCents);
    await upgradeTerm(
      ctx,
      term,
      {
        tier: "large",
        fromPeriod: month.startsAt,
        reference: "in_annual_upgrade_ref",
        paidCents: amountCents,
        paidAt: at,
      },
      {
        expectedVersion: (await planFor(ctx, f.organizationId))!.version,
        actor: "stripe:in_annual_upgrade_ref",
        reason: "Upgrade anual por cartão confirmado (Stripe)",
      },
    );
  });
}
const setCatalog = (f: Fixture, enabled: boolean) =>
  f.t.run(async (ctx) => {
    const settings = (await ctx.db.query("platformPlanSettings").first())!;
    await ctx.db.patch("platformPlanSettings", settings._id, { enabled });
  });

describe("início do termo agendado", () => {
  it("o termo pago antes do início fica agendado e só troca o plano no início", async () => {
    const f = await fixture();
    await monthly(f);
    const before = await f.plan();
    // Paid 10 days before the month ends: the fake timers hold at most 24.8 days.
    vi.setSystemTime(MONTHLY_END - 10 * DAY);
    await renewal(f, MONTHLY_END);
    const [term] = await f.terms();
    expect(term).toMatchObject({
      state: "scheduled",
      firstPeriod: MONTHLY_END,
      anchor: OCT,
      endsAt: RENEWAL_END,
    });
    expect(await f.plan()).toEqual(before);
    await runUntil(f, MONTHLY_END - 1);
    expect(await f.plan()).toEqual(before);
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
    await monthly(f);
    await renewal(f, MONTHLY_END);
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
    await monthly(f);
    await renewal(f, MONTHLY_END);
    const [term] = await f.terms();
    await setCatalog(f, false);
    await runUntil(f, MONTHLY_END);
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "PLANS_DISABLED" }]);
    expect(await f.plan()).not.toHaveProperty("termId");
    await setCatalog(f, true);
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: term!._id });
    const [active] = await f.terms();
    expect(active).toMatchObject({ state: "active" });
    expect(active).not.toHaveProperty("blockedCode");
    expect(await f.plan()).toMatchObject({ termId: term!._id, endsAt: RENEWAL_END });
  });

  it("registra TERM_ENDED e ORGANIZATION_ARCHIVING sem conceder o plano", async () => {
    const f = await fixture();
    await monthly(f);
    await renewal(f, MONTHLY_END);
    const [ended] = await f.terms();
    vi.setSystemTime(RENEWAL_END);
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: ended!._id });
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "TERM_ENDED" }]);
    expect(await f.plan()).not.toHaveProperty("termId");
    // Running it again stays blocked.
    await f.t.mutation(internal.plans.activateScheduledTerm, { termId: ended!._id });
    expect(await f.terms()).toMatchObject([{ state: "scheduled", blockedCode: "TERM_ENDED" }]);

    vi.setSystemTime(OCT);
    const g = await fixture();
    await monthly(g);
    await renewal(g, MONTHLY_END);
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

describe("activateCatalogPlan com termo", () => {
  const insert = (f: Fixture, state: "scheduled" | "active" | "rescinded" = "active") =>
    f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "stripe",
        references: ["in_synthetic_term"],
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state,
      }),
    );
  const grant = (
    f: Fixture,
    termId: Id<"platformPlanTerms">,
    { tier = "intermediate" as Tier, startsAt = OCT, endsAt = termEndsAt(OCT_1), version = 0 } = {},
  ) =>
    code(
      f.t.run((ctx) =>
        activateCatalogPlan(
          ctx,
          f.organizationId,
          tier,
          startsAt,
          endsAt,
          version,
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

  it("concede o tier do segmento em vigor no mês do início", async () => {
    const f = await fixture();
    const SEP_1 = Date.UTC(2026, 8, 1);
    const term = {
      organizationId: f.organizationId,
      tier: "intermediate" as const,
      firstPeriod: SEP_1,
      endsAt: termEndsAt(SEP_1),
      source: "stripe" as const,
      references: ["in_annual_segment"],
      paidCents: 149000,
      purchasedAt: SEP_1,
      segments: [{ tier: "large" as const, fromPeriod: OCT_1 }],
      state: "active" as const,
    };
    expect(termTierAt(term, SEP_1 + DAY)).toBe("intermediate");
    expect(termTierAt(term, OCT)).toBe("large");
    const termId = await f.t.run((ctx) => insertTerm(ctx, term));
    const endsAt = term.endsAt;
    expect(await grant(f, termId, { tier: "large", startsAt: SEP_1, endsAt })).toBe(
      "INVALID_REQUEST",
    );
    expect(await grant(f, termId, { startsAt: SEP_1, endsAt })).toBe("OK");
    expect(await grant(f, termId, { startsAt: OCT, endsAt, version: 1 })).toBe("INVALID_REQUEST");
    expect(await grant(f, termId, { tier: "large", startsAt: OCT, endsAt, version: 1 })).toBe("OK");
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

  it("o anual concedido encerra o aviso e impede outro", async () => {
    vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled");
    const f = await fixture();
    await expired(f);
    await notice(f, "synthetic-notice-1");
    expect(await run(f)).toMatchObject({ state: "notice" });
    await annualNow(f);
    expect(await run(f)).toMatchObject({ state: "hot", noticeEnded: { by: "plan" } });
    await expect(notice(f, "synthetic-notice-2")).rejects.toThrow("ARCHIVE_PAID_ACTIVE");
  });

  it("não congela com termo em vigor e volta a ser elegível quando ele termina", async () => {
    vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled");
    const f = await fixture();
    await expired(f);
    const runId = await notice(f, "synthetic-notice-1");
    // A term written without its grant, so the notice stays pending.
    await f.t.run((ctx) =>
      insertTerm(ctx, {
        organizationId: f.organizationId,
        tier: "intermediate",
        firstPeriod: OCT_1,
        endsAt: termEndsAt(OCT_1),
        source: "stripe",
        references: ["in_annual_freeze"],
        paidCents: 149000,
        purchasedAt: OCT,
        segments: [],
        state: "active",
      }),
    );
    vi.setSystemTime(OCT + 31 * DAY);
    await expect(f.t.mutation(internal.coldArchive.freeze, { runId, version: 1 })).rejects.toThrow(
      "ARCHIVE_PAID_ACTIVE",
    );
    vi.setSystemTime(termEndsAt(OCT_1));
    await f.t.mutation(internal.coldArchive.freeze, { runId, version: 1 });
    expect(await run(f)).toMatchObject({ state: "frozen" });
  });
});

describe("rescisão do anual pelo suporte e upgrade desfeito em 7 dias", () => {
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
    reference = "re_refund_0001",
    upgradeReference?: string,
  ) =>
    f.t.mutation(internal.plans.recordTermRefund, {
      termId,
      amountCents,
      reference,
      actor: OPERATOR,
      ...(upgradeReference ? { upgradeReference } : {}),
    });
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
    await runUntil(f, FEB_10);
    expect(await f.plan()).toMatchObject({ endsAt: FEB_10, version: 2, updatedAt: FEB_10 });
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
    expect(await code(refund(f, annual._id, 29401, "re_refund_0002"))).toBe("AMOUNT_MISMATCH");
    expect(await refund(f, annual._id, 29400, "re_refund_0002")).toEqual({
      refundCents: 89400,
      refundedCents: 89400,
    });
    expect((await term(f, annual._id))!.rescission!.refunds).toEqual([
      { cents: 60000, reference: "re_refund_0001", actor: OPERATOR, at: FEB_10 },
      { cents: 29400, reference: "re_refund_0002", actor: OPERATOR, at: FEB_10 },
    ]);
    expect(await code(refund(f, annual._id, 1, "re_refund_0003"))).toBe("AMOUNT_MISMATCH");
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
    const undone = {
      reference: "in_annual_upgrade_ref",
      refundCents: 233333,
      tier: "intermediate",
    };
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
      references: ["in_annual_ref", "in_annual_upgrade_ref"],
      undoneUpgrades: [
        {
          fromTier: "intermediate",
          tier: "large",
          fromPeriod: FEB_10,
          reference: "in_annual_upgrade_ref",
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
      await code(refund(f, annual._id, 233333, "re_refund_upgrade", "in_annual_upgrade_unknown")),
    ).toBe("NOT_FOUND");
    await refund(f, annual._id, 233333, "re_refund_upgrade", "in_annual_upgrade_ref");
    expect((await term(f, annual._id))!.undoneUpgrades![0]!.refunds).toMatchObject([
      { cents: 233333, reference: "re_refund_upgrade" },
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
      undoneUpgrades: [
        { reference: "in_annual_upgrade_ref", refundCents: 233333, via: "rescission" },
      ],
    });
    expect(await f.plan()).toMatchObject({ catalogTier: "intermediate", endsAt: MAR_10 });
    // The rescission's key does not answer for an undo.
    expect(await code(undo(f, annual._id, "rescission-key"))).toBe("OPERATION_CONFLICT");
  });

  it("um termo agendado com a ativação recusada não usou nada: tudo volta, sem acesso a encerrar", async () => {
    const f = await fixture();
    await monthly(f);
    await renewal(f, MONTHLY_END);
    await setCatalog(f, false);
    await runUntil(f, MONTHLY_END);
    const [blocked] = await f.terms();
    expect(blocked).toMatchObject({ state: "scheduled", blockedCode: "PLANS_DISABLED" });
    const before = await f.plan();
    expect(before).toMatchObject({ endsAt: MONTHLY_END });
    expect(before).not.toHaveProperty("termId");
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
    expect(await f.plan()).toEqual(before);
  });

  it("leva junto a renovação agendada, já paga, com tudo devolvido", async () => {
    const f = await fixture();
    const annual = await annualNow(f);
    vi.setSystemTime(RENEWAL_PAID);
    await renewal(f, END);
    const next = (await f.terms()).find((row) => row._id !== annual._id)!;
    expect(next).toMatchObject({ state: "scheduled", firstPeriod: END, anchor: OCT });
    expect(await rescind(f, annual._id)).toEqual([
      { termId: annual._id, withdrawal: false, usedMonths: 12, refundCents: 0, accessEndsAt: END },
      // Paid today: within its own 7 days, and unused either way.
      {
        termId: next._id,
        withdrawal: true,
        usedMonths: 0,
        refundCents: 149000,
        accessEndsAt: RENEWAL_PAID,
      },
    ]);
    expect(await term(f, next._id)).toMatchObject({
      state: "rescinded",
      rescission: { after: annual._id, refundCents: 149000 },
    });
    // Rescinded, the renewal is never activated; the plan ends with the term.
    await runUntil(f, END);
    expect(await f.plan()).toMatchObject({ termId: annual._id, endsAt: END });
    expect(await term(f, next._id)).toMatchObject({ state: "rescinded" });
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
  /** The term below starts on a 1st: its months are the civil ones. */
  const FEB_1 = Date.UTC(2027, 1, 1);
  const CARD_END = termEndsAt(OCT_1);

  it("mostra o termo agendado sem upgrade e o termo em vigor com o preço do upgrade", async () => {
    const f = await fixture();
    await monthly(f);
    await renewal(f, MONTHLY_END);
    expect((await view(f)).terms).toEqual([
      {
        id: expect.any(String),
        tier: "intermediate",
        segments: [],
        firstPeriod: MONTHLY_END,
        endsAt: RENEWAL_END,
        state: "scheduled",
        blocked: false,
        accessEndsAt: null,
        renews: false,
        upgrade: null,
      },
    ]);

    const g = await fixture();
    await annualNow(g);
    // The first month: the upgrade covers all 12 months.
    expect((await view(g)).terms).toMatchObject([
      {
        state: "active",
        firstPeriod: OCT,
        endsAt: END,
        upgrade: {
          tier: "large",
          amountCents: 350000,
          months: 12,
          from: OCT,
          closesAt: END - 72 * 3600_000,
        },
      },
    ]);
    // The 5th term month: 8 months left, the price the Checkout charges.
    vi.setSystemTime(FEB);
    expect((await view(g)).terms[0]!.upgrade).toEqual({
      tier: "large",
      amountCents: 233333,
      months: 8,
      from: FEB_10,
      closesAt: END - 72 * 3600_000,
    });
    await upgradeAt(g, FEB, 233333);
    // Upgraded: the segment shows, and there is nothing left to raise.
    expect((await view(g)).terms).toMatchObject([
      { tier: "intermediate", segments: [{ tier: "large", fromPeriod: FEB_10 }], upgrade: null },
    ]);
  });

  it("sem o anual à venda ou com renovação agendada, o termo não oferece upgrade", async () => {
    const f = await fixture();
    await annualNow(f);
    await f.t.mutation(internal.plans.configureAnnual, {
      enabled: false,
      expectedVersion: 2,
      evidence: "synthetic-annual-off",
    });
    expect(await view(f)).toMatchObject({
      annualEnabled: false,
      terms: [{ state: "active", upgrade: null }],
    });
    const g = await fixture();
    await annualNow(g);
    vi.setSystemTime(RENEWAL_PAID);
    await renewal(g, END);
    expect((await view(g)).terms).toMatchObject([
      { state: "active", firstPeriod: OCT, upgrade: null },
      { state: "scheduled", firstPeriod: END, upgrade: null },
    ]);
  });

  it("o termo fecha o upgrade 72 horas antes do fim, e o rescindido mostra o fim do acesso", async () => {
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
      { renews: false, upgrade: { closesAt: CARD_END - 72 * 3600_000 } },
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
      actor: OPERATOR,
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
