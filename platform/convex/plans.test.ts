import { describe, expect, it, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import { platformTest, person, usePlatformEnvironment } from "../../tests/helpers/platform";
import { PLATFORM_PLANS } from "./lib/planCatalog";
import { activateCatalogPlan, annualEnabled, requireEntitySlot } from "./lib/planCore";
import { planFor } from "./lib/usageCore";
import { addMonths } from "./lib/annualTerms";
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
  const configure = async (custodyCents = 100000) =>
    t.mutation(internal.plans.configure, {
      enabled: true,
      expectedVersion: 0,
      filesBytes: 10 * 2 ** 30,
      databaseBytes: 2 ** 30,
      custodyCents,
      freeMonthlyCents: 10000,
      admissionsUntil: Date.now() + 86400000,
      evidence: "synthetic-local-proof",
    });
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
/**
 * A month of Intermediário from now, granted as a paid card invoice grants it (`applyInvoice`):
 * the catalog plan over the version in force, anchored at the payment.
 */
const grantIntermediate = (f: Fixture, organizationId: Id<"organizations">) =>
  f.t.run(async (ctx) => {
    const anchor = Math.floor(Date.now() / 1000) * 1000;
    const version = (await planFor(ctx, organizationId))?.version ?? 0;
    await activateCatalogPlan(
      ctx,
      organizationId,
      "intermediate",
      anchor,
      addMonths(anchor, 1),
      version,
      "stripe:in_synthetic",
      "Pagamento mensal por cartão confirmado (Stripe)",
      undefined,
      anchor,
    );
  });
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
  await grantIntermediate(f, f.organizationId);
  await grantIntermediate(f, otherId);
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
  await grantIntermediate(f, f.organizationId);
  // A plan activated before the catalog moved to five companies holds its own copy.
  await f.t.run(async (ctx) => {
    const plan = (await ctx.db.query("usagePlans").unique())!;
    await ctx.db.patch("usagePlans", plan._id, { capacity: { ...plan.capacity!, companies: 3 } });
  });
  for (let n = 1; n <= 3; n++) await createCompany(f.owner, f.organizationId, n);
  await expect(createCompany(f.owner, f.organizationId, 4)).rejects.toThrow("QUOTA_EXCEEDED");
  // The month ends on 30/11 at 12:00 UTC, a month after the payment; the next one is paid after
  // it, with a fresh session, since the first one expired meanwhile.
  vi.setSystemTime(Date.UTC(2026, 10, 30, 13));
  const owner = await person(f.t, f.organizationId, "owner");
  await grantIntermediate(f, f.organizationId);
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
