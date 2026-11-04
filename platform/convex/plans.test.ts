import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import {
  enablePix,
  platformTest,
  person,
  usePlatformEnvironment,
} from "../../tests/helpers/platform";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { reserveUsage } from "./lib/usageCore";
import { annualEnabled, pixEnabled, requireEntitySlot } from "./lib/planCore";
import { consoleProjectFor } from "../../tests/helpers/console";
import { normalizeCnpj } from "../../packages/fiscal-core/src/cnpj";
import type { Id } from "./_generated/dataModel";

usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-plans-only",
  now: Date.UTC(2026, 9, 31, 12),
});
async function fixture() {
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
  const configure = async (custodyCents = 100000) => {
    const version = await t.mutation(internal.plans.configure, {
      enabled: true,
      expectedVersion: 0,
      filesBytes: 10 * 2 ** 30,
      databaseBytes: 2 ** 30,
      custodyCents,
      freeMonthlyCents: 10000,
      admissionsUntil: Date.now() + 86400000,
      evidence: "synthetic-local-proof",
    });
    await enablePix(t);
    return version;
  };
  return { t, organizationId, owner, configure };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Owner = Fixture["owner"];

/** Branch `n` of the fictitious root 11.222.333, with valid check digits. */
function syntheticCnpj(n: number) {
  const base = `11222333${String(n).padStart(4, "0")}`;
  for (let suffix = 0; suffix < 100; suffix++) {
    const cnpj = normalizeCnpj(base + String(suffix).padStart(2, "0"));
    if (cnpj) return cnpj;
  }
  throw new Error(`No check digits for ${base}`);
}
const createCompany = (owner: Owner, organizationId: Id<"organizations">, n: number) =>
  owner.mutation(api.companies.create, {
    organizationId,
    cnpj: syntheticCnpj(n),
    name: `Empresa sintética ${n}`,
    address: {
      street: "Rua sintética",
      number: String(n),
      complement: "",
      district: "Centro",
      city: "Cidade sintética",
      state: "SP",
      postalCode: "01000-000",
    },
  });
async function payIntermediate(
  f: Fixture,
  owner: Owner,
  organizationId: Id<"organizations">,
  key: string,
) {
  const request = await owner.mutation(api.plans.requestPaid, {
    organizationId,
    tier: "intermediate",
    key,
  });
  await f.t.mutation(internal.plans.confirmPayment, {
    requestId: request.id,
    amountCents: 14900,
    paymentReference: `${key}-receipt`,
    actor: "operator",
  });
}
const companyCount = (f: Fixture, organizationId: Id<"organizations">) =>
  f.t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("companies")
          .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
          .collect()
      ).length,
  );

it("denies enrollment without rollout, unauthorized roles and cross-organization access", async () => {
  const f = await fixture();
  await expect(
    f.owner.mutation(api.plans.claimFree, { organizationId: f.organizationId }),
  ).rejects.toThrow("PLANS_DISABLED");
  await f.configure();
  const viewer = await person(f.t, f.organizationId, "viewer");
  await expect(
    viewer.query(api.plans.overview, {
      asOf: Date.now(),
      organizationId: f.organizationId,
      contextKey: "test",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    viewer.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "large",
      key: "request-invalid",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
  await expect(
    f.t.mutation(api.plans.claimFree, { organizationId: f.organizationId }),
  ).rejects.toThrow("UNAUTHENTICATED");
  const otherId = await f.t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Outra organização",
      slug: "other-org",
      ownerCount: 1,
      memberCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await expect(
    f.owner.query(api.plans.overview, {
      asOf: Date.now(),
      organizationId: otherId,
      contextKey: "other",
    }),
  ).rejects.toThrow("ACCESS_DENIED");
});

it("claims permanent free once and reserves capacity and custody exactly once", async () => {
  const f = await fixture();
  await f.configure();
  await f.owner.mutation(api.plans.claimFree, { organizationId: f.organizationId });
  await f.owner.mutation(api.plans.claimFree, { organizationId: f.organizationId });
  const result = await f.owner.query(api.plans.overview, {
    asOf: Date.now(),
    organizationId: f.organizationId,
    contextKey: "test",
  });
  expect(result.subscription).toMatchObject({ tier: "free", endsAt: null, version: 1 });
  expect(await f.t.run((ctx) => ctx.db.query("platformPlanSettings").unique())).toMatchObject({
    allocatedCustodyCents: 6000,
    allocatedFreeMonthlyCents: 1700,
    allocatedFilesBytes: 384 * 2 ** 20,
  });
  const second = await f.owner.mutation(api.organizations.create, {
    name: "Segunda organização",
    slug: "second-synthetic",
  });
  await expect(
    f.owner.mutation(api.plans.claimFree, { organizationId: second.organizationId }),
  ).rejects.toThrow("FREE_PLAN_UNAVAILABLE");
});

it("refuses enrollment without prefunded company cash and rolls back every reservation", async () => {
  const f = await fixture();
  await f.configure(5999);
  await expect(
    f.owner.mutation(api.plans.claimFree, { organizationId: f.organizationId }),
  ).rejects.toThrow("PLAN_UNAVAILABLE");
  expect(await f.t.run((ctx) => ctx.db.query("usagePlans").collect())).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("platformPlanAllocations").collect())).toEqual([]);
});

it("charges the full month, activates only on operator confirmation and deduplicates payment", async () => {
  const f = await fixture();
  await f.configure();
  const args = {
    organizationId: f.organizationId,
    tier: "intermediate" as const,
    key: "synthetic-payment-1",
  };
  const request = await f.owner.mutation(api.plans.requestPaid, args);
  // No civil month is bought (ADR 0012): the month runs from the confirmation.
  expect(request).toEqual({ id: request.id, amountCents: 14900 });
  expect(await f.t.run((ctx) => ctx.db.query("platformPlanAllocations").collect())).toEqual([]);
  expect(await f.t.run((ctx) => ctx.db.query("platformPlanSettings").unique())).toMatchObject({
    allocatedCustodyCents: 0,
    allocatedFilesBytes: 0,
  });
  expect(await f.owner.mutation(api.plans.requestPaid, args)).toEqual(request);
  expect(
    (
      await f.owner.query(api.plans.overview, {
        asOf: Date.now(),
        organizationId: f.organizationId,
        contextKey: "test",
      })
    ).subscription,
  ).toBeNull();
  const payment = {
    requestId: request.id,
    amountCents: 14900,
    paymentReference: "synthetic-bank-reference",
    actor: "operator",
  };
  await expect(
    f.t.mutation(internal.plans.confirmPayment, { ...payment, amountCents: 14899 }),
  ).rejects.toThrow("PLAN_REQUEST_UNAVAILABLE");
  await f.t.mutation(internal.plans.confirmPayment, payment);
  await f.t.mutation(internal.plans.confirmPayment, payment);
  expect(
    (
      await f.owner.query(api.plans.overview, {
        asOf: Date.now(),
        organizationId: f.organizationId,
        contextKey: "test",
      })
    ).subscription,
  ).toMatchObject({ tier: "intermediate", version: 1, endsAt: Date.UTC(2026, 10, 30, 12) });
});

it("upgrade bills the full difference, preserves usage and never duplicates custody", async () => {
  const f = await fixture();
  await f.configure();
  const first = await f.owner.mutation(api.plans.requestPaid, {
    organizationId: f.organizationId,
    tier: "intermediate",
    key: "synthetic-first",
  });
  await f.t.mutation(internal.plans.confirmPayment, {
    requestId: first.id,
    amountCents: 14900,
    paymentReference: "synthetic-first-receipt",
    actor: "operator",
  });
  await f.t.run((ctx) =>
    reserveUsage(ctx, f.organizationId, "production", "imports", "before-upgrade", 1),
  );
  const next = await f.owner.mutation(api.plans.requestPaid, {
    organizationId: f.organizationId,
    tier: "large",
    key: "synthetic-upgrade",
  });
  expect(next.amountCents).toBe(35000);
  await expect(
    f.t.mutation(internal.plans.confirmPayment, {
      requestId: next.id,
      amountCents: 35000,
      paymentReference: "synthetic-first-receipt",
      actor: "operator",
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await f.t.mutation(internal.plans.confirmPayment, {
    requestId: next.id,
    amountCents: 35000,
    paymentReference: "synthetic-upgrade-receipt",
    actor: "operator",
  });
  expect(await f.t.run((ctx) => ctx.db.query("usageEvents").collect())).toHaveLength(1);
  expect(await f.t.run((ctx) => ctx.db.query("platformPlanSettings").unique())).toMatchObject({
    allocatedCustodyCents: 28000,
  });
});

it("cancellation never grants quota or recycles custody, and expired payment cannot activate", async () => {
  const f = await fixture();
  await f.configure();
  const request = await f.owner.mutation(api.plans.requestPaid, {
    organizationId: f.organizationId,
    tier: "intermediate",
    key: "synthetic-cancel",
  });
  await f.owner.mutation(api.plans.cancelRequest, {
    organizationId: f.organizationId,
    requestId: request.id,
  });
  await expect(
    f.t.mutation(internal.plans.confirmPayment, {
      requestId: request.id,
      amountCents: 14900,
      paymentReference: "synthetic-cancel-receipt",
      actor: "operator",
    }),
  ).rejects.toThrow("PLAN_REQUEST_UNAVAILABLE");
  const next = await f.owner.mutation(api.plans.requestPaid, {
    organizationId: f.organizationId,
    tier: "intermediate",
    key: "synthetic-expire",
  });
  // The request is paid within 7 days.
  vi.setSystemTime(Date.UTC(2026, 10, 7, 12));
  await expect(
    f.t.mutation(internal.plans.confirmPayment, {
      requestId: next.id,
      amountCents: 14900,
      paymentReference: "synthetic-expire-receipt",
      actor: "operator",
    }),
  ).rejects.toThrow("PLAN_REQUEST_UNAVAILABLE");
});

it("enforces entity capacity and cannot disable enforcement to evade quotas", async () => {
  const f = await fixture();
  await f.configure();
  await f.owner.mutation(api.plans.claimFree, { organizationId: f.organizationId });
  await consoleProjectFor(f.t, f.organizationId);
  await f.owner.mutation(api.projects.create, {
    organizationId: f.organizationId,
    name: "Projeto",
    externalReference: "first",
  });
  await expect(
    f.owner.mutation(api.projects.create, {
      organizationId: f.organizationId,
      name: "Segundo",
      externalReference: "second",
    }),
  ).rejects.toThrow("QUOTA_EXCEEDED");
  await f.t.run((ctx) =>
    ctx.db.patch("organizations", f.organizationId, {
      memberCount: PLATFORM_PLANS.free.capacity.members,
    }),
  );
  await expect(
    f.t.run((ctx) => requireEntitySlot(ctx, f.organizationId, "members")),
  ).rejects.toThrow("QUOTA_EXCEEDED");
  const settings = (await f.t.run((ctx) => ctx.db.query("platformPlanSettings").unique()))!;
  await expect(
    f.t.mutation(internal.plans.configure, {
      enabled: false,
      expectedVersion: settings.version,
      filesBytes: settings.filesBytes,
      databaseBytes: settings.databaseBytes,
      custodyCents: settings.custodyCents,
      freeMonthlyCents: settings.freeMonthlyCents,
      admissionsUntil: 0,
      evidence: "synthetic-disable",
    }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

it("Intermediário admits the fifth company and refuses the sixth, counting each organization apart", async () => {
  const f = await fixture();
  await f.configure();
  const otherId = await f.t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Outra organização",
      slug: "other-intermediate",
      ownerCount: 1,
      memberCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const otherOwner = await person(f.t, otherId, "owner");
  await payIntermediate(f, f.owner, f.organizationId, "synthetic-five");
  await payIntermediate(f, otherOwner, otherId, "synthetic-other-five");
  // The other organization fills its own five slots first, with the same CNPJs.
  for (let n = 1; n <= 5; n++) await createCompany(otherOwner, otherId, n);
  for (let n = 1; n <= 5; n++)
    expect(await createCompany(f.owner, f.organizationId, n)).toMatchObject({ reused: false });
  await expect(createCompany(f.owner, f.organizationId, 6)).rejects.toThrow("QUOTA_EXCEEDED");
  await expect(createCompany(otherOwner, otherId, 6)).rejects.toThrow("QUOTA_EXCEEDED");
  expect(await companyCount(f, f.organizationId)).toBe(5);
  expect(await companyCount(f, otherId)).toBe(5);
});

it("an Intermediário activated with three companies keeps them until the next activation copies the catalog", async () => {
  const f = await fixture();
  await f.configure();
  await payIntermediate(f, f.owner, f.organizationId, "synthetic-before");
  // A plan activated before the catalog moved to five companies holds its own copy.
  await f.t.run(async (ctx) => {
    const plan = (await ctx.db.query("usagePlans").unique())!;
    await ctx.db.patch("usagePlans", plan._id, { capacity: { ...plan.capacity!, companies: 3 } });
  });
  for (let n = 1; n <= 3; n++) await createCompany(f.owner, f.organizationId, n);
  await expect(createCompany(f.owner, f.organizationId, 4)).rejects.toThrow("QUOTA_EXCEEDED");
  // The month ends on 30/11 at 12:00 UTC, a month after the confirmation; the next one is paid
  // after it, with a fresh session, since the first one expired meanwhile.
  vi.setSystemTime(Date.UTC(2026, 10, 30, 13));
  const owner = await person(f.t, f.organizationId, "owner");
  await payIntermediate(f, owner, f.organizationId, "synthetic-renewal");
  await createCompany(owner, f.organizationId, 4);
  await createCompany(owner, f.organizationId, 5);
  await expect(createCompany(owner, f.organizationId, 6)).rejects.toThrow("QUOTA_EXCEEDED");
  expect(await companyCount(f, f.organizationId)).toBe(5);
});

describe("annual switch", () => {
  const annual = (f: Fixture, enabled: boolean, expectedVersion: number, evidence = "fase-e-ok") =>
    f.t.mutation(internal.plans.configureAnnual, { enabled, expectedVersion, evidence });
  const settings = (f: Fixture) => f.t.run((ctx) => ctx.db.query("platformPlanSettings").unique());
  const isOn = (f: Fixture) => f.t.run((ctx) => annualEnabled(ctx));

  it("is off by default and refused while the catalog is off", async () => {
    const f = await fixture();
    expect(await isOn(f)).toBe(false);
    await expect(annual(f, true, 0)).rejects.toThrow("PLANS_DISABLED");
    await f.configure();
    expect(await isOn(f)).toBe(false);
  });

  it("with the catalog row present but off, refuses turning on and accepts turning off", async () => {
    const f = await fixture();
    await f.t.mutation(internal.plans.configure, {
      enabled: false,
      expectedVersion: 0,
      filesBytes: 0,
      databaseBytes: 0,
      custodyCents: 0,
      freeMonthlyCents: 0,
      admissionsUntil: 0,
      evidence: "synthetic-catalog-off",
    });
    await expect(annual(f, true, 1)).rejects.toThrow("PLANS_DISABLED");
    expect(await annual(f, false, 1)).toBe(2);
    expect(await settings(f)).toMatchObject({ enabled: false, annual: { enabled: false } });
    expect(await isOn(f)).toBe(false);
  });

  it("shows the annual price to the console only while the annual is on sale", async () => {
    const f = await fixture();
    await f.configure();
    const view = () =>
      f.owner.query(api.plans.overview, {
        asOf: Date.now(),
        organizationId: f.organizationId,
        contextKey: "annual",
      });
    const off = await view();
    expect(off.annualEnabled).toBe(false);
    for (const offer of off.offers) expect(offer).not.toHaveProperty("annualCents");
    await annual(f, true, 1);
    const on = await view();
    expect(on.annualEnabled).toBe(true);
    // Custody and subsidy stay out; the free tier has no annual.
    expect(on.offers.map((offer) => [offer.tier, offer.annualCents])).toEqual([
      ["free", undefined],
      ["intermediate", 149000],
      ["large", 499000],
    ]);
    for (const offer of on.offers) expect(offer).not.toHaveProperty("custodyCents");
  });

  it("turns on and off with the catalog on, under the settings version", async () => {
    const f = await fixture();
    await f.configure();
    expect(await annual(f, true, 1)).toBe(2);
    expect(await isOn(f)).toBe(true);
    expect((await settings(f))?.annual).toEqual({
      enabled: true,
      evidence: "fase-e-ok",
      updatedAt: Date.now(),
    });
    expect(await annual(f, false, 2, "rollback-proof")).toBe(3);
    expect(await isOn(f)).toBe(false);
  });

  it("refuses a stale version, short or long evidence and a misconfigured environment", async () => {
    const f = await fixture();
    await f.configure();
    await expect(annual(f, true, 0)).rejects.toThrow("OPERATION_CONFLICT");
    await expect(annual(f, true, 1, "curta")).rejects.toThrow("INVALID_REQUEST");
    await expect(annual(f, true, 1, "x".repeat(501))).rejects.toThrow("INVALID_REQUEST");
    vi.stubEnv("APP_ENV", "installation");
    await expect(annual(f, true, 1)).rejects.toThrow("Installation requires");
    vi.stubEnv("APP_ENV", "development");
    expect(await settings(f)).toMatchObject({ version: 1 });
    expect((await settings(f))?.annual).toBeUndefined();
  });

  it("survives a catalog reconfiguration", async () => {
    const f = await fixture();
    await f.configure();
    await annual(f, true, 1);
    const before = (await settings(f))!;
    await f.t.mutation(internal.plans.configure, {
      enabled: true,
      expectedVersion: 2,
      filesBytes: before.filesBytes,
      databaseBytes: before.databaseBytes,
      custodyCents: before.custodyCents + 1,
      freeMonthlyCents: before.freeMonthlyCents,
      admissionsUntil: before.admissionsUntil,
      evidence: "synthetic-more-custody",
    });
    expect(await settings(f)).toMatchObject({ version: 3, annual: before.annual });
    expect(await isOn(f)).toBe(true);
  });

  it("is off whenever the catalog is off, even with the annual flag set", async () => {
    const f = await fixture();
    await f.configure();
    await annual(f, true, 1);
    // `configure` never turns the catalog off; the state is written directly.
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", row._id, { enabled: false });
    });
    expect((await settings(f))?.annual?.enabled).toBe(true);
    expect(await isOn(f)).toBe(false);
  });
});

describe("Pix switch", () => {
  const pix = (
    f: Fixture,
    enabled: boolean,
    expectedVersion: number,
    evidence = "cartao-somente",
  ) => f.t.mutation(internal.plans.configurePix, { enabled, expectedVersion, evidence });
  const settings = (f: Fixture) => f.t.run((ctx) => ctx.db.query("platformPlanSettings").unique());
  const isOn = (f: Fixture) => f.t.run((ctx) => pixEnabled(ctx));
  const view = (f: Fixture) =>
    f.owner.query(api.plans.overview, {
      asOf: Date.now(),
      organizationId: f.organizationId,
      contextKey: "pix",
    });
  const request = (f: Fixture, key: string) =>
    f.owner.mutation(api.plans.requestPaid, {
      organizationId: f.organizationId,
      tier: "intermediate",
      key,
    });
  const requests = (f: Fixture) => f.t.run((ctx) => ctx.db.query("platformPlanRequests").collect());
  /** The catalog on without the fixture's Pix: what a deployment has before `configurePix`. */
  const catalogOnly = (f: Fixture) =>
    f.t.mutation(internal.plans.configure, {
      enabled: true,
      expectedVersion: 0,
      filesBytes: 10 * 2 ** 30,
      databaseBytes: 2 ** 30,
      custodyCents: 100000,
      freeMonthlyCents: 10000,
      admissionsUntil: Date.now() + 86400000,
      evidence: "synthetic-local-proof",
    });

  it("is off by default: the request is refused before anything is written", async () => {
    const f = await fixture();
    await expect(pix(f, true, 0)).rejects.toThrow("PLANS_DISABLED");
    await catalogOnly(f);
    expect(await isOn(f)).toBe(false);
    expect((await view(f)).pixEnabled).toBe(false);
    await expect(request(f, "pix-while-off")).rejects.toThrow("PIX_DISABLED");
    expect(await requests(f)).toEqual([]);
    // The free tier does not go through Pix.
    await f.owner.mutation(api.plans.claimFree, { organizationId: f.organizationId });
  });

  it("turned off, keeps the request already made and its confirmation", async () => {
    const f = await fixture();
    await catalogOnly(f);
    expect(await pix(f, true, 1)).toBe(2);
    expect((await view(f)).pixEnabled).toBe(true);
    const made = await request(f, "pix-before-off");
    expect(await pix(f, false, 2, "so-cartao-por-ora")).toBe(3);
    expect(await settings(f)).toMatchObject({
      pix: { enabled: false, evidence: "so-cartao-por-ora", updatedAt: Date.now() },
    });
    expect((await view(f)).pixEnabled).toBe(false);
    expect(await request(f, "pix-before-off")).toEqual(made);
    await expect(request(f, "pix-after-off")).rejects.toThrow("PIX_DISABLED");
    await f.t.mutation(internal.plans.confirmPayment, {
      requestId: made.id,
      amountCents: 14900,
      paymentReference: "pix-before-off-receipt",
      actor: "operator",
    });
    expect((await view(f)).subscription?.tier).toBe("intermediate");
  });

  it("refuses a stale version and short evidence, and survives a catalog reconfiguration", async () => {
    const f = await fixture();
    await catalogOnly(f);
    await expect(pix(f, true, 0)).rejects.toThrow("OPERATION_CONFLICT");
    await expect(pix(f, true, 1, "curta")).rejects.toThrow("INVALID_REQUEST");
    await pix(f, true, 1);
    const before = (await settings(f))!;
    await f.t.mutation(internal.plans.configure, {
      enabled: true,
      expectedVersion: 2,
      filesBytes: before.filesBytes,
      databaseBytes: before.databaseBytes,
      custodyCents: before.custodyCents + 1,
      freeMonthlyCents: before.freeMonthlyCents,
      admissionsUntil: before.admissionsUntil,
      evidence: "synthetic-more-custody",
    });
    expect(await settings(f)).toMatchObject({ version: 3, pix: before.pix });
    expect(await isOn(f)).toBe(true);
  });

  it("is off whenever the catalog is off, even with the Pix flag set", async () => {
    const f = await fixture();
    await f.configure();
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", row._id, { enabled: false });
    });
    expect((await settings(f))?.pix?.enabled).toBe(true);
    expect(await isOn(f)).toBe(false);
  });
});
