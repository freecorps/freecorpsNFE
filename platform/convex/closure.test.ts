import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { authenticateKey } from "./lib/operationAccess";
import { actor } from "../../tests/helpers/export-fixture";
import { decisionGuardUntil, fiscalGuardUntil } from "./lib/retentionClasses";
import {
  DAY,
  fixture,
  settle,
  settleNow,
  at,
  code,
  slug,
  closureOf,
  conserved,
  counts,
  seed,
  production,
} from "../../tests/helpers/closure";

/** Closing an organization: who may close it, what the purge removes and keeps, and the deadlines. */
beforeEach(() => {
  vi.useFakeTimers();
  for (const [key, value] of Object.entries({
    APP_ENV: "development",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    EMAIL_MODE: "local",
    WEBHOOK_MODE: "disabled",
    SITE_URL: "http://localhost:5203",
    CONVEX_SITE_URL: "http://127.0.0.1:3265",
    BETTER_AUTH_SECRET: "synthetic-closure-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const excluded = [
  "organizations",
  "memberships",
  "invitations",
  "termsOfUseNotices",
  "organizationAudit",
  "onboarding",
  "companies",
  "companyGrants",
  "companyAudit",
  "projects",
  "projectCompanies",
  "apiKeys",
  "integrationAudit",
  "certificates",
  "certificateHeads",
  "nfseProfiles",
  "issuanceGates",
  "webhookEndpoints",
  "webhookDeliveries",
  "webhookAttempts",
  "outboxEvents",
  "documentExports",
  "exportParts",
  "exportTickets",
  "documentDownloads",
  "operationalAudit",
  "operationalMonitors",
  "registryLookups",
] as const satisfies TableNames[];

it("encerrar exige o owner e a confirmação, bloqueia operações e revoga as integrações", async () => {
  const f = await fixture(),
    owner = await actor(f),
    admin = await actor(f, "viewer");
  await seed(f, owner.membershipId);
  const organizationId = f.scope.organizationId;
  expect(
    await code(
      admin.client.mutation(api.organizationClosure.close, {
        organizationId,
        confirmation: await slug(f),
      }),
    ),
  ).toBe("ACCESS_DENIED");
  expect(
    await code(
      owner.client.mutation(api.organizationClosure.close, {
        organizationId,
        confirmation: "outra",
      }),
    ),
  ).toBe("CONFIRMATION_MISMATCH");
  const before = await f.create("before-closure");
  const keyHash = await hashApiKey(`fnfe_${"a".repeat(43)}`);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: (await slug(f)).toUpperCase(),
  });
  expect(closed.exportUntil - Date.now()).toBe(30 * DAY);
  expect(closed.purgeBy - closed.exportUntil).toBe(7 * DAY);
  expect(
    await code(
      owner.client.mutation(api.organizationClosure.close, {
        organizationId,
        confirmation: await slug(f),
      }),
    ),
  ).toBe("ORGANIZATION_CLOSED");

  // Immediate effect, before the revocation job runs.
  expect((await f.request(`/v1/exports/${before.id}`)).status).toBe(401);
  expect(
    (await f.request("/v1/imports", "POST", { companyId: f.scope.companyId, files: [] }, "after"))
      .status,
  ).toBe(401);
  expect(await code(f.t.run((ctx) => authenticateKey(ctx, keyHash)))).toBe("INVALID_API_KEY");
  const contextKey = "closure";
  expect(
    await code(
      owner.client.query(api.organizations.members, {
        organizationId,
        contextKey,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ),
  ).toBe("ORGANIZATION_CLOSED");
  expect(
    await code(
      owner.client.mutation(api.organizations.update, { organizationId, name: "Outro nome" }),
    ),
  ).toBe("ORGANIZATION_CLOSED");
  const context = await owner.client.query(api.organizations.context, {
    slug: await slug(f),
    contextKey,
  });
  expect(context?.closure).toMatchObject({ state: "closing", exportUntil: closed.exportUntil });

  // The organization export stays available to the manager during the window.
  const exportArgs = {
    organizationId,
    selection: { kind: "organization" as const },
    key: "closing",
  };
  expect(await code(admin.client.mutation(api.exports.create, exportArgs))).toBe("ACCESS_DENIED");
  const job = await owner.client.mutation(api.exports.create, exportArgs);
  expect((await f.finish(job.id)).state).toBe("succeeded");
  const parts = await owner.client.query(api.exports.parts, {
    exportId: job.id,
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(parts.page.length).toBeGreaterThan(0);

  await settle(f);
  const state = await f.t.run(async (ctx) => ({
    projects: await ctx.db.query("projects").collect(),
    keys: await ctx.db.query("apiKeys").collect(),
    endpoints: await ctx.db.query("webhookEndpoints").collect(),
    invitations: await ctx.db.query("invitations").collect(),
  }));
  expect(state.projects.every((p) => p.state === "disabled")).toBe(true);
  expect(state.keys.every((k) => k.revokedAt !== null)).toBe(true);
  expect(state.endpoints.every((e) => !e.active)).toBe(true);
  expect(state.invitations.every((i) => i.status === "revoked")).toBe(true);
  expect((await closureOf(f))?.revoked).toBe(true);

  // After the window the export closes as well, before any row is purged: a mutation compares
  // the clock, a query the state the purge persists once the window ends (#45).
  vi.setSystemTime(closed.exportUntil);
  const later = await actor(f);
  expect(
    await code(later.client.mutation(api.exports.create, { ...exportArgs, key: "late" })),
  ).toBe("ORGANIZATION_CLOSED");
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .unique())!;
    await ctx.db.patch("organizationClosures", closure._id, { state: "purging" });
  });
  expect(
    await code(
      later.client.query(api.exports.parts, {
        exportId: job.id,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ),
  ).toBe("ORGANIZATION_CLOSED");
});

it("expurga as classes elegíveis em até 7 dias e conserva documentos, uso, operações e acessos", async () => {
  const f = await fixture();
  let owner = await actor(f);
  await seed(f, owner.membershipId);
  await production(f);
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(`fnfe_${"c".repeat(43)}`),
    suffix: crypto.randomUUID(),
  });
  await f.t.mutation(internal.accessRecords.recordActor, {
    actor: `key:${f.scope.keyId}`,
    ip: "203.0.113.7",
  });
  const organizationId = f.scope.organizationId;
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  // An export near the end of the window still has its file when the purge starts.
  vi.setSystemTime(closed.exportUntil - DAY / 2);
  owner = await actor(f);
  const job = await owner.client.mutation(api.exports.create, {
    organizationId,
    selection: { kind: "organization" },
    key: "last-day",
  });
  await f.finish(job.id);
  const storageBefore = await f.t.run(async (ctx) => {
    const parts = await ctx.db.query("exportParts").collect();
    const artifacts = await ctx.db.query("documentArtifacts").collect();
    return { parts: parts.map((p) => p.storageId), artifacts: artifacts.map((a) => a.storageId!) };
  });
  expect(storageBefore.parts.length).toBeGreaterThan(0);
  const keep = await counts(f, conserved);

  await at(f, closed.exportUntil + 1);
  const closure = (await closureOf(f))!;
  expect(closure.state).toBe("purged");
  expect(closure.purgedAt).toBeLessThanOrEqual(closure.purgeBy);
  expect(closure.removed).toBeGreaterThan(20);

  const left = await f.t.run(async (ctx) => {
    const result: Record<string, number> = {};
    for (const table of excluded) {
      const rows = await ctx.db.query(table).collect();
      result[table] = rows.filter((row) =>
        "organizationId" in row
          ? row.organizationId === organizationId
          : row._id === organizationId,
      ).length;
    }
    for (const table of [
      "webhookDeliveries",
      "webhookAttempts",
      "exportParts",
      "exportTickets",
    ] as const)
      result[table] = (await ctx.db.query(table).collect()).length;
    return result;
  });
  expect(
    Object.values(left).every((n) => n === 0),
    JSON.stringify(left),
  ).toBe(true);
  const after = await counts(f, conserved);
  expect({ ...after, _storage: 0 }).toEqual({ ...keep, _storage: 0 });
  await f.t.run(async (ctx) => {
    for (const id of storageBefore.parts)
      expect(await ctx.db.system.get("_storage", id)).toBeNull();
    for (const id of storageBefore.artifacts)
      expect(await ctx.db.system.get("_storage", id)).not.toBeNull();
    expect(await ctx.db.get("organizations", other.organizationId)).not.toBeNull();
    expect(await ctx.db.get("apiKeys", other.keyId)).not.toBeNull();
    expect(await ctx.db.get("companies", other.companyId)).not.toBeNull();
  });
  // Running the purge again changes nothing.
  await f.t.mutation(internal.organizationClosure.purge, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await counts(f, conserved)).toEqual(after);
});

it("após um restore, recupera os prazos sem job e reaplica a decisão guardada fora do banco", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.mutation(internal.accessRecords.recordActor, {
    actor: `key:${f.scope.keyId}`,
    ip: "203.0.113.8",
  });
  const exportJob = await f.create("restore-export");
  await production(f);
  const requestedAt = Date.now();
  const organizationId = f.scope.organizationId;
  await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  const decisions = await f.t.query(internal.organizationClosure.decisions, {
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(decisions.page).toEqual([
    expect.objectContaining({ organizationId, requestedAt, state: "closing", purgedAt: null }),
  ]);
  expect(JSON.stringify(decisions)).not.toMatch(/@|name|slug/);

  // A restored snapshot keeps the control rows but none of their scheduled functions.
  await f.t.run(async (ctx) => {
    const jobs = [
      (await ctx.db.query("organizationClosures").first())!.scheduledId,
      (await ctx.db.query("accessRetention").first())!.scheduledId,
      ...(await ctx.db.query("operationalRetention").collect()).map((r) => r.scheduledId),
      (await ctx.db.get("documentExports", exportJob.id))!.expireJobId,
    ];
    for (const id of jobs) await ctx.scheduler.cancel(id!);
  });
  type Progress = { phase: number; cursor: string | null } | null;
  const scan = async () => {
    let missing = 0,
      next: Progress = { phase: 0, cursor: null };
    while (next) {
      const page: { missing: number; next: Progress } = await f.t.query(
        internal.retentionRecovery.inspect,
        next,
      );
      missing += page.missing;
      next = page.next;
    }
    return missing;
  };
  expect(await scan()).toBeGreaterThanOrEqual(4);
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect(await scan()).toBe(0);
  const recovered = (await closureOf(f))!;
  const exportJobId = async () =>
    (await f.t.run((ctx) => ctx.db.get("documentExports", exportJob.id)))!.expireJobId;
  const recoveredExport = await exportJobId();
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  // A second run finds every job alive and schedules nothing new.
  expect((await closureOf(f))!.generation).toBe(recovered.generation);
  expect(await exportJobId()).toBe(recoveredExport);
  // A phase outside the list is refused before any page is read or fixed.
  for (const phase of [-1, 5])
    await expect(
      f.t.mutation(internal.retentionRecovery.recover, { phase, cursor: null }),
    ).rejects.toThrow(`Unknown retention recovery phase ${phase}`);
  await expect(
    f.t.query(internal.retentionRecovery.inspect, { phase: 5, cursor: null }),
  ).rejects.toThrow("Unknown retention recovery phase 5");

  // Reapplying the same decision is a no-op; an earlier decision wins and purges at once.
  expect(
    await f.t.mutation(internal.organizationClosure.reapply, { organizationId, requestedAt }),
  ).toBe("closing");
  expect((await closureOf(f))!.exportUntil).toBe(recovered.exportUntil);
  await f.t.mutation(internal.organizationClosure.reapply, {
    organizationId,
    requestedAt: requestedAt - 31 * DAY,
  });
  await settle(f);
  expect((await closureOf(f))!.state).toBe("purged");
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).not.toBeNull();
  expect(
    await f.t.mutation(internal.organizationClosure.reapply, { organizationId, requestedAt }),
  ).toBe("purged");

  // A decision about an organization the snapshot still holds without a closure row.
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(`fnfe_${"d".repeat(43)}`),
    suffix: crypto.randomUUID(),
  });
  const otherAt = Date.now() - 40 * DAY;
  expect(
    await f.t.mutation(internal.organizationClosure.reapply, {
      organizationId: other.organizationId,
      requestedAt: otherAt,
    }),
  ).toBe("closing");
  await settle(f);
  expect(await f.t.run((ctx) => ctx.db.get("organizations", other.organizationId))).toBeNull();
});

it("calcula o fim da guarda pelo ano do encerramento no horário de Brasília", () => {
  const brasilia = 3 * 3_600_000;
  expect(fiscalGuardUntil(Date.UTC(2026, 5, 15))).toBe(Date.UTC(2032, 0, 1) + brasilia);
  // 31/12/2026 às 23:30 em Brasília já é 2027 em UTC, mas o fato é de 2026.
  expect(fiscalGuardUntil(Date.UTC(2027, 0, 1, 2, 30))).toBe(Date.UTC(2032, 0, 1) + brasilia);
  expect(fiscalGuardUntil(Date.UTC(2027, 0, 1, 3))).toBe(Date.UTC(2033, 0, 1) + brasilia);
});

it("calcula o fim da classe decision um ano depois do fim da guarda fiscal, em Brasília", () => {
  const brasilia = 3 * 3_600_000;
  // Guarda até 31/12/2031: as decisões ficam até 31/12/2032, para qualquer encerramento de 2026.
  for (const closedAt of [Date.UTC(2026, 0, 1, 3), Date.UTC(2027, 0, 1, 2, 59, 59, 999)])
    expect(decisionGuardUntil(fiscalGuardUntil(closedAt))).toBe(Date.UTC(2033, 0, 1) + brasilia);
  expect(decisionGuardUntil(fiscalGuardUntil(Date.UTC(2027, 0, 1, 3)))).toBe(
    Date.UTC(2034, 0, 1) + brasilia,
  );
  // Uma retenção legal que segura a guarda além do prazo: o ano conta da liberação.
  const held = Date.UTC(2034, 0, 1) + brasilia;
  expect(decisionGuardUntil(held)).toBe(Date.UTC(2035, 0, 1) + brasilia);
  expect(decisionGuardUntil(held + 1)).toBe(Date.UTC(2036, 0, 1) + brasilia);
  expect(decisionGuardUntil(Date.UTC(2034, 2, 15))).toBe(Date.UTC(2036, 0, 1) + brasilia);
});
