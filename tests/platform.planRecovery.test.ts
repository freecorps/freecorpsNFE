import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "../platform/convex/_generated/api";
import type { Id } from "../platform/convex/_generated/dataModel";
import { PLATFORM_PLANS } from "../platform/convex/lib/planCatalog";
import { assignPlan } from "../platform/convex/usage";
import { resumeArchived } from "../platform/convex/plans";
import {
  enablePix,
  person,
  platformTest,
  usePlatformEnvironment,
  type PlatformTest,
} from "./helpers/platform";

const NOW = Date.UTC(2026, 9, 27, 12);
const MONTH_END = Date.UTC(2026, 10, 1);
usePlatformEnvironment({
  siteUrl: "http://localhost:5199",
  convexSiteUrl: "http://127.0.0.1:3257",
  secret: "synthetic-plan-recovery-only",
  now: NOW,
});
beforeEach(() => vi.stubEnv("FNFE_COLD_ARCHIVE", "enabled"));

type Assignment = FunctionArgs<typeof internal.usage.assignPlan>;

function organization(t: PlatformTest) {
  return t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: "Organização sintética de recuperação",
      slug: crypto.randomUUID(),
      ownerCount: 1,
      memberCount: 1,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

function assignment(organizationId: Id<"organizations">): Assignment {
  return {
    organizationId,
    catalogTier: "custom",
    name: "Contrato comercial sintético",
    startsAt: NOW,
    endsAt: MONTH_END,
    limits: { ...PLATFORM_PLANS.free.limits },
    capacity: { ...PLATFORM_PLANS.free.capacity },
    concurrency: 2,
    expectedVersion: 0,
    actor: "operador-sintetico",
    reason: "Pagamento sintético conferido",
    commercial: {
      monthlyCents: 10_000,
      baseCostCents: 6_000,
      stressCostCents: 6_500,
      custodyCents: 2_500,
      paymentReference: "synthetic-custom-receipt",
    },
  };
}

async function fixture() {
  const t = platformTest();
  const organizationId = await organization(t);
  const otherId = await organization(t);
  await t.mutation(internal.plans.configure, {
    enabled: true,
    expectedVersion: 0,
    filesBytes: 20 * 2 ** 30,
    databaseBytes: 2 * 2 ** 30,
    custodyCents: 100_000,
    freeMonthlyCents: 10_000,
    admissionsUntil: MONTH_END,
    evidence: "synthetic-prefunded-admission",
  });
  await enablePix(t);
  return { t, organizationId, otherId, args: assignment(organizationId) };
}

// Include both tenants and scheduled expiry: a refusal must not leave any partial admission.
function persisted(t: PlatformTest) {
  return t.run(async (ctx) => ({
    plans: await ctx.db.query("usagePlans").collect(),
    receipts: await ctx.db.query("platformPlanReceipts").collect(),
    requests: await ctx.db.query("platformPlanRequests").collect(),
    audit: await ctx.db.query("usagePlanAudit").collect(),
    settings: await ctx.db.query("platformPlanSettings").collect(),
    allocations: await ctx.db.query("platformPlanAllocations").collect(),
    archives: await ctx.db.query("coldArchiveRuns").collect(),
    accounts: await ctx.db.query("capacityAccounts").collect(),
    totals: await ctx.db.query("capacityTotals").collect(),
    scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
  }));
}

async function refusesAtomically(t: PlatformTest, action: () => Promise<unknown>, code: string) {
  const before = await persisted(t);
  await expect(action()).rejects.toThrow(code);
  expect(await persisted(t)).toEqual(before);
}

async function closeOrganization(t: PlatformTest, organizationId: Id<"organizations">) {
  await t.run((ctx) =>
    ctx.db.insert("organizationClosures", {
      organizationId,
      state: "purged",
      requestedAt: NOW - 40 * 86_400_000,
      exportUntil: NOW - 10 * 86_400_000,
      purgeBy: NOW - 86_400_000,
      generation: 1,
      purgedAt: NOW - 86_400_000,
    }),
  );
}

describe("atribuição comercial com policy habilitada", () => {
  it("mantém atribuição e retomada restritas a funções internas", () => {
    expect(assignPlan.isInternal).toBe(true);
    expect(resumeArchived.isInternal).toBe(true);
  });

  it("persiste contrato finito, margens no limite, recibo e auditoria sem tocar outra organização", async () => {
    const f = await fixture();
    const otherArgs = assignment(f.otherId);
    otherArgs.commercial!.paymentReference = "synthetic-other-receipt";
    await f.t.mutation(internal.usage.assignPlan, otherArgs);
    const before = await persisted(f.t);
    expect(await f.t.mutation(internal.usage.assignPlan, f.args)).toBe(1);
    const after = await persisted(f.t);
    expect(after.plans.find((p) => p.organizationId === f.organizationId)).toMatchObject({
      catalogTier: "custom",
      version: 1,
      startsAt: NOW,
      endsAt: MONTH_END,
      capacity: f.args.capacity,
      limits: f.args.limits,
    });
    expect(after.receipts.find((p) => p.organizationId === f.organizationId)).toMatchObject({
      ...f.args.commercial,
      planVersion: 1,
    });
    expect(after.audit.find((p) => p.organizationId === f.organizationId)).toMatchObject({
      actor: f.args.actor,
      reason: f.args.reason,
      before: null,
    });
    expect(after.settings[0]).toMatchObject({
      allocatedCustodyCents: 5_000,
      allocatedFreeMonthlyCents: 0,
    });
    expect(after.allocations.find((p) => p.organizationId === f.organizationId)).toMatchObject({
      custodyCents: 2_500,
      filesBytes: f.args.capacity!.filesBytes + f.args.capacity!.exportsBytes,
      databaseBytes: f.args.capacity!.databaseBytes,
    });
    expect(after.scheduled).toHaveLength(before.scheduled.length + 1);
    for (const table of ["plans", "receipts", "audit", "allocations", "accounts"] as const)
      expect(after[table].filter((row) => row.organizationId === f.otherId)).toEqual(before[table]);
  });

  const invalid: Array<[string, (args: Assignment) => void, string]> = [
    [
      "tier de catálogo",
      (a) => {
        a.catalogTier = "free";
      },
      "PLAN_UNAVAILABLE",
    ],
    [
      "capacidade ausente",
      (a) => {
        delete a.capacity;
      },
      "PLAN_UNAVAILABLE",
    ],
    [
      "termos ausentes",
      (a) => {
        delete a.commercial;
      },
      "PLAN_UNAVAILABLE",
    ],
    [
      "vigência ilimitada",
      (a) => {
        a.endsAt = null;
      },
      "INVALID_REQUEST",
    ],
    [
      "início futuro",
      (a) => {
        a.startsAt = NOW + 1;
      },
      "INVALID_REQUEST",
    ],
    [
      "vigência expirada",
      (a) => {
        a.endsAt = NOW;
      },
      "INVALID_REQUEST",
    ],
    [
      "vigência além do mês",
      (a) => {
        a.endsAt = MONTH_END + 1;
      },
      "INVALID_REQUEST",
    ],
    [
      "margem base abaixo de 40%",
      (a) => {
        a.commercial!.baseCostCents = 6_001;
      },
      "INVALID_REQUEST",
    ],
    [
      "margem de estresse abaixo de 35%",
      (a) => {
        a.commercial!.stressCostCents = 6_501;
      },
      "INVALID_REQUEST",
    ],
    [
      "referência curta",
      (a) => {
        a.commercial!.paymentReference = "short";
      },
      "INVALID_REQUEST",
    ],
    [
      "referência com espaço",
      (a) => {
        a.commercial!.paymentReference = "invalid reference";
      },
      "INVALID_REQUEST",
    ],
    [
      "referência longa",
      (a) => {
        a.commercial!.paymentReference = "a".repeat(121);
      },
      "INVALID_REQUEST",
    ],
    [
      "versão divergente após reservar",
      (a) => {
        a.expectedVersion = 2;
      },
      "OPERATION_CONFLICT",
    ],
    [
      "ator vazio após reservar",
      (a) => {
        a.actor = " ";
      },
      "INVALID_REQUEST",
    ],
  ];
  for (const metric of ["imports", "captures", "registry", "bytes", "deliveries"] as const)
    invalid.push([
      `limite ilimitado de ${metric}`,
      (a) => {
        a.limits[metric] = null;
      },
      "INVALID_REQUEST",
    ]);
  for (const field of ["monthlyCents", "baseCostCents", "stressCostCents", "custodyCents"] as const)
    for (const value of [0, -1, 1.5, 1e12 + 1])
      invalid.push([
        `${field} inválido: ${value}`,
        (a) => {
          a.commercial![field] = value;
        },
        "INVALID_REQUEST",
      ]);
  for (const field of ["companies", "projects", "members"] as const)
    invalid.push([
      `${field} acima de 1000`,
      (a) => {
        a.capacity![field] = 1001;
      },
      "INVALID_REQUEST",
    ]);
  for (const value of [0, -1, 1.5, 1e12 + 1])
    invalid.push([
      `estoque inválido: ${value}`,
      (a) => {
        a.capacity!.filesBytes = value;
      },
      "INVALID_REQUEST",
    ]);

  it.each(invalid)("recusa %s sem efeitos parciais", async (_name, change, code) => {
    const f = await fixture();
    change(f.args);
    await refusesAtomically(f.t, () => f.t.mutation(internal.usage.assignPlan, f.args), code);
  });

  it("confere dinheiro disponível antes de assumir custódia", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, { custodyCents: 2_499 });
    });
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.usage.assignPlan, f.args),
      "PLAN_UNAVAILABLE",
    );
  });

  it("repetição do recibo não cobra nem altera versão e uma nova confirmação preserva o histórico", async () => {
    const f = await fixture();
    await f.t.mutation(internal.usage.assignPlan, f.args);
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.usage.assignPlan, f.args),
      "OPERATION_CONFLICT",
    );
    const next = {
      ...f.args,
      expectedVersion: 1,
      commercial: { ...f.args.commercial!, paymentReference: "synthetic-second-receipt" },
    };
    expect(await f.t.mutation(internal.usage.assignPlan, next)).toBe(2);
    const state = await persisted(f.t);
    expect(state.receipts.map((p) => p.planVersion)).toEqual([1, 2]);
    expect(state.audit).toHaveLength(2);
    expect(JSON.parse(state.audit[1]!.before!)).toMatchObject({ version: 1 });
    expect(state.settings[0]!.allocatedCustodyCents).toBe(2_500);
    await refusesAtomically(
      f.t,
      () =>
        f.t.mutation(internal.usage.assignPlan, {
          ...next,
          commercial: { ...next.commercial, paymentReference: "synthetic-stale-version" },
        }),
      "OPERATION_CONFLICT",
    );
  });

  it("não reutiliza recibo custom de outra organização", async () => {
    const f = await fixture();
    await f.t.mutation(internal.usage.assignPlan, { ...f.args, organizationId: f.otherId });
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.usage.assignPlan, f.args),
      "OPERATION_CONFLICT",
    );
  });

  it("não reutiliza pagamento de catálogo em custom nem recibo custom na confirmação de catálogo", async () => {
    const f = await fixture();
    const owner = await person(f.t, f.otherId, "owner");
    const request = await owner.mutation(api.plans.requestPaid, {
      organizationId: f.otherId,
      tier: "intermediate",
      key: "synthetic-paid-plan",
    });
    const payment = {
      requestId: request.id,
      amountCents: request.amountCents,
      paymentReference: "synthetic-catalog-receipt",
      actor: "operador-sintetico",
    };
    await f.t.mutation(internal.plans.confirmPayment, payment);
    await refusesAtomically(
      f.t,
      () =>
        f.t.mutation(internal.usage.assignPlan, {
          ...f.args,
          commercial: { ...f.args.commercial!, paymentReference: payment.paymentReference },
        }),
      "OPERATION_CONFLICT",
    );
    await f.t.mutation(internal.usage.assignPlan, f.args);
    const upgrade = await owner.mutation(api.plans.requestPaid, {
      organizationId: f.otherId,
      tier: "large",
      key: "synthetic-paid-upgrade",
    });
    await refusesAtomically(
      f.t,
      () =>
        f.t.mutation(internal.plans.confirmPayment, {
          ...payment,
          requestId: upgrade.id,
          amountCents: upgrade.amountCents,
          paymentReference: f.args.commercial!.paymentReference,
        }),
      "OPERATION_CONFLICT",
    );
  });

  it("não usa inventário pronto de outra organização para admitir a atual", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("capacityAccounts", {
        organizationId: f.organizationId,
        ready: false,
        phase: 0,
        cursor: null,
        updatedAt: NOW,
      });
      await ctx.db.insert("capacityAccounts", {
        organizationId: f.otherId,
        ready: true,
        phase: 0,
        cursor: null,
        updatedAt: NOW,
      });
    });
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.usage.assignPlan, f.args),
      "CAPACITY_INVENTORY_REQUIRED",
    );
  });

  it("recusa organização inexistente sem reservar recursos", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.delete("organizations", f.organizationId));
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.usage.assignPlan, f.args),
      "NOT_FOUND",
    );
  });

  it("recusa atribuição comercial a organização encerrada sem assumir nova custódia", async () => {
    const f = await fixture();
    await closeOrganization(f.t, f.organizationId);
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.usage.assignPlan, f.args),
      "ORGANIZATION_CLOSED",
    );
  });
});

async function archivedFixture(tier: "custom" | "free" = "custom") {
  const f = await fixture();
  if (tier === "custom") await f.t.mutation(internal.usage.assignPlan, f.args);
  else {
    const owner = await person(f.t, f.organizationId, "owner");
    await owner.mutation(api.plans.claimFree, { organizationId: f.organizationId });
  }
  const runId = await f.t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", {
      organizationId: f.organizationId,
      key: "synthetic-recovery-run",
      version: 7,
      state: "archived",
      reason: tier === "free" ? "free_inactive" : "paid_expired",
      planVersion: 1,
      noticeAt: NOW - 40 * 86_400_000,
      eligibleAt: NOW - 10 * 86_400_000,
      retainUntil: NOW + 365 * 86_400_000,
      createdAt: NOW - 40 * 86_400_000,
      updatedAt: NOW,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "synthetic-empty-archive",
    }),
  );
  const fence = { runId, version: 7 };
  const resume = {
    organizationId: f.organizationId,
    archiveVersion: 7,
    expectedSettingsVersion: 1,
  };
  return { ...f, runId, fence, resume, custodyCents: tier === "free" ? 6_000 : 2_500 };
}

async function inventory(t: PlatformTest, organizationId: Id<"organizations">) {
  for (let step = 0; step < 40; step++) {
    const result = await t.mutation(internal.capacity.inventory, { organizationId });
    if (result.ready) return;
  }
  throw new Error("O inventário sintético não concluiu em 40 páginas");
}

async function restoredFixture(tier: "custom" | "free" = "custom") {
  const f = await archivedFixture(tier);
  await legacyRestoringState(f);
  await f.t.mutation(internal.coldArchive.verifyRestoredBatch, { ...f.fence, cursor: null });
  await inventory(f.t, f.organizationId);
  return f;
}

// Exercises guards for persisted legacy state, not a usable same-origin restore.
// The real Convex drill rejected recreating deleted IDs; beginRestore stays blocked.
async function legacyRestoringState(f: Awaited<ReturnType<typeof archivedFixture>>) {
  await f.t.run(async (ctx) => {
    await ctx.db.patch("coldArchiveRuns", f.runId, { state: "restoring" });
    const account = (await ctx.db.query("capacityAccounts").first())!;
    await ctx.db.patch("capacityAccounts", account._id, { ready: false, phase: 0, cursor: null });
  });
}

describe("proteções de retomada para estado legado sintético", () => {
  it("recusa iniciar restauração na origem sem alterar arquivo ou orçamento", async () => {
    const f = await archivedFixture();
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.coldArchive.beginRestore, f.fence),
      "ARCHIVE_SAME_ORIGIN_RESTORE_UNSUPPORTED",
    );
  });
  it.each(["custom", "free"] as const)(
    "renova fundo do plano %s, volta a hot e cerca a repetição sem cobrar de novo",
    async (tier) => {
      const f = await restoredFixture(tier);
      const before = await persisted(f.t);
      await f.t.mutation(internal.plans.resumeArchived, f.resume);
      const after = await persisted(f.t);
      expect(after.archives[0]).toMatchObject({ state: "hot", version: 8 });
      expect(after.settings[0]).toMatchObject({
        version: 1,
        allocatedCustodyCents: before.settings[0]!.allocatedCustodyCents + f.custodyCents,
        allocatedFilesBytes: before.settings[0]!.allocatedFilesBytes,
        allocatedDatabaseBytes: before.settings[0]!.allocatedDatabaseBytes,
        allocatedFreeMonthlyCents: before.settings[0]!.allocatedFreeMonthlyCents,
      });
      expect(after.allocations[0]!.custodyCents).toBe(
        before.allocations[0]!.custodyCents + f.custodyCents,
      );
      expect(after.plans).toEqual(before.plans);
      expect(after.receipts).toEqual(before.receipts);
      await refusesAtomically(
        f.t,
        () => f.t.mutation(internal.plans.resumeArchived, f.resume),
        "OPERATION_CONFLICT",
      );
      await refusesAtomically(
        f.t,
        () => f.t.mutation(internal.plans.resumeArchived, { ...f.resume, archiveVersion: 8 }),
        "OPERATION_CONFLICT",
      );
    },
  );

  it.each(["notice", "frozen", "sealed", "verified", "deleting", "archived", "hot"] as const)(
    "recusa estado %s mesmo com restoredAt",
    async (state) => {
      const f = await restoredFixture();
      await f.t.run((ctx) => ctx.db.patch("coldArchiveRuns", f.runId, { state }));
      await refusesAtomically(
        f.t,
        () => f.t.mutation(internal.plans.resumeArchived, f.resume),
        "OPERATION_CONFLICT",
      );
    },
  );

  it("exige prova de restauração e inventário novo após essa prova", async () => {
    const f = await archivedFixture();
    await legacyRestoringState(f);
    let state = await persisted(f.t);
    expect(state.accounts[0]!.ready).toBe(false);
    await inventory(f.t, f.organizationId);
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.plans.resumeArchived, f.resume),
      "OPERATION_CONFLICT",
    );
    await f.t.mutation(internal.coldArchive.verifyRestoredBatch, { ...f.fence, cursor: null });
    state = await persisted(f.t);
    expect(state.archives[0]!.restoredAt).toBe(NOW);
    expect(state.accounts[0]!.ready).toBe(false);
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.plans.resumeArchived, f.resume),
      "CAPACITY_INVENTORY_REQUIRED",
    );
    await inventory(f.t, f.organizationId);
    await f.t.mutation(internal.plans.resumeArchived, f.resume);
    expect((await persisted(f.t)).archives[0]!.state).toBe("hot");
  });

  it.each(["arquivo", "configuração"])("recusa versão obsoleta de %s", async (version) => {
    const f = await restoredFixture();
    const args = {
      ...f.resume,
      ...(version === "arquivo" ? { archiveVersion: 6 } : { expectedSettingsVersion: 0 }),
    };
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.plans.resumeArchived, args),
      "OPERATION_CONFLICT",
    );
  });

  it("exige ausência de encerramento e não encerra outra organização por engano", async () => {
    const f = await restoredFixture();
    await closeOrganization(f.t, f.otherId);
    await f.t.mutation(internal.plans.resumeArchived, f.resume);
    const closed = await restoredFixture();
    await closeOrganization(closed.t, closed.organizationId);
    await refusesAtomically(
      closed.t,
      () => closed.t.mutation(internal.plans.resumeArchived, closed.resume),
      "ORGANIZATION_CLOSED",
    );
  });

  it("exige dinheiro novo, além da custódia já comprometida", async () => {
    const f = await restoredFixture();
    await f.t.run(async (ctx) => {
      const settings = (await ctx.db.query("platformPlanSettings").unique())!;
      await ctx.db.patch("platformPlanSettings", settings._id, {
        custodyCents: settings.allocatedCustodyCents + f.custodyCents - 1,
      });
    });
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.plans.resumeArchived, f.resume),
      "PLAN_UNAVAILABLE",
    );
  });

  it("desfaz hot e fundo adicional quando a última checagem recusa capacidade de membros", async () => {
    const f = await restoredFixture();
    await f.t.run((ctx) =>
      ctx.db.patch("organizations", f.organizationId, {
        memberCount: f.args.capacity!.members + 1,
      }),
    );
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.plans.resumeArchived, f.resume),
      "QUOTA_EXCEEDED",
    );
  });

  it.each(["filesBytes", "databaseBytes", "temporaryBytes"] as const)(
    "recusa estoque restaurado de %s acima do plano, incluindo reservas",
    async (metric) => {
      const f = await restoredFixture();
      const limit = f.args.capacity![metric === "temporaryBytes" ? "exportsBytes" : metric];
      await f.t.run(async (ctx) => {
        const total = (await ctx.db
          .query("capacityTotals")
          .withIndex("by_organizationId_and_period_and_metric", (q) =>
            q.eq("organizationId", f.organizationId).eq("period", "stock").eq("metric", metric),
          )
          .unique())!;
        await ctx.db.patch("capacityTotals", total._id, { committed: limit, reserved: 1 });
      });
      await refusesAtomically(
        f.t,
        () => f.t.mutation(internal.plans.resumeArchived, f.resume),
        "QUOTA_EXCEEDED",
      );
    },
  );

  it.each([
    "usagePlans",
    "platformPlanAllocations",
    "platformPlanReceipts",
    "capacityAccounts",
  ] as const)("não usa %s de outra organização para suprir ausência na atual", async (table) => {
    const f = await restoredFixture();
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query(table).first())!;
      await ctx.db.patch(table, row._id, { organizationId: f.otherId });
    });
    const error =
      table === "capacityAccounts"
        ? "CAPACITY_INVENTORY_REQUIRED"
        : table === "platformPlanReceipts"
          ? "PLAN_UNAVAILABLE"
          : "PLAN_REQUIRED";
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.plans.resumeArchived, f.resume),
      error,
    );
  });

  it("não usa restauração de outra organização e impede atribuição durante a reidratação", async () => {
    const f = await restoredFixture();
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.plans.resumeArchived, { ...f.resume, organizationId: f.otherId }),
      "OPERATION_CONFLICT",
    );
    await refusesAtomically(
      f.t,
      () => f.t.mutation(internal.usage.assignPlan, { ...f.args, expectedVersion: 1 }),
      // Rehydration under way: plans wait for it (ADR 0009, §2).
      "ORGANIZATION_ARCHIVING",
    );
  });
});
