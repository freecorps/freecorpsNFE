/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { api, internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { OPERATOR_CLOSURE_LIMIT } from "./organizationClosure";
import { hashApiKey } from "./lib/apiKeyCrypto";
import { authenticateKey } from "./lib/operationAccess";
import { insertTerm } from "./lib/planTerms";
import { trackStoredFile } from "./lib/capacityCore";
import { DOCUMENT_CONTENT_FORMAT, encodeDocumentContent } from "./lib/documentContent";
import { fixture as importedNote, actor } from "../../tests/helpers/export-fixture";
import { keepInline, writeContent } from "../../tests/helpers/document-footprint";
import { fixture as xmlFixture } from "../../tests/helpers/nfe-corpus";
import { decisionGuardUntil, fiscalGuardUntil, retentionClass } from "./lib/retentionClasses";

const DAY = 86_400_000;
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
/**
 * The imported note with its content blob already written (ADR 0010, B4), so the counts taken
 * before a closure include it rather than see it arrive with the scheduled work.
 */
async function fixture() {
  // Keeps the inline copy (B8 would clear it), so every guarded table, `documentItems` included,
  // holds a row of the organization.
  const f = await importedNote(keepInline());
  for (const version of await f.t.run((ctx) => ctx.db.query("documentVersions").collect()))
    await f.t.action(internal.importProcessing.storeContent, {
      versionId: version._id,
      attempt: 1,
    });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Runs the jobs that are due now, including the continuations they schedule. */
async function settle(f: Fixture) {
  for (let i = 0; i < 40; i++) {
    vi.advanceTimersByTime(1);
    await f.t.finishInProgressScheduledFunctions();
  }
}
/**
 * Only the continuations scheduled for now. Fake timers clamp delays above 2^31 ms to 1 ms, so a
 * 1 ms step would also fire the 30-day deadlines.
 */
async function settleNow(f: Fixture) {
  for (let i = 0; i < 20; i++) {
    vi.advanceTimersByTime(0);
    await f.t.finishInProgressScheduledFunctions();
  }
}
async function at(f: Fixture, time: number) {
  vi.setSystemTime(time);
  await settle(f);
}
function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}
async function slug(f: Fixture) {
  return (await f.t.run((ctx) => ctx.db.get("organizations", f.scope.organizationId)))!.slug;
}
async function closureOf(f: Fixture) {
  return f.t.run((ctx) =>
    ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.scope.organizationId))
      .unique(),
  );
}
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
const conserved = [
  "fiscalDocuments",
  "documentArtifacts",
  "documentVersions",
  "documentItems",
  "documentFiscalEvidence",
  "imports",
  "importFiles",
  "operations",
  "operationAttempts",
  "operationAudit",
  "idempotencyRecords",
  "usageEvents",
  "usageTotals",
  "accessRecords",
  "certificateAudit",
] as const satisfies TableNames[];
async function counts(f: Fixture, tables: readonly TableNames[]) {
  return f.t.run(async (ctx) => {
    const result: Record<string, number> = {};
    for (const table of tables) result[table] = (await ctx.db.query(table).collect()).length;
    result._storage = (await ctx.db.system.query("_storage").collect()).length;
    return result;
  });
}
/** One row of each excluded class that the import fixture does not create by itself. */
async function seed(f: Fixture, membershipId: Id<"memberships">) {
  const { organizationId, companyId, projectId } = f.scope;
  return f.t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("registryLookups", {
      organizationId,
      cnpj: "11222333000181",
      actorUserId: "synthetic-closure",
      key: "synthetic-closure-lookup",
      environment: "sandbox",
      quotaExceeded: false,
      createdAt: now,
      expiresAt: now + DAY,
    });
    await ctx.db.insert("invitations", {
      organizationId,
      email: "convidado@development.invalid",
      role: "viewer",
      tokenHash: "synthetic-closure-token",
      status: "pending",
      expiresAt: now + DAY,
      issuerMembershipId: membershipId,
      issuerVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("termsOfUseNotices", {
      organizationId,
      version: "termos-de-uso-sinteticos",
      state: "sent",
      recipients: 1,
      confirmed: 1,
      withheld: 0,
      createdAt: now,
      finishedAt: now,
    });
    await ctx.db.insert("companyGrants", {
      organizationId,
      companyId,
      membershipId,
      membershipEpoch: 0,
      active: true,
      version: 1,
      updatedAt: now,
    });
    const certificateId = await ctx.db.insert("certificates", {
      organizationId,
      companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic-closure",
      membershipId,
      membershipVersion: 1,
      envelopeRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("certificateHeads", {
      organizationId,
      companyId,
      nextVersion: 2,
      latestId: certificateId,
      activeId: certificateId,
    });
    await ctx.db.insert("nfseProfiles", {
      organizationId,
      companyId,
      municipalityCode: "3550308",
      opSimpNac: 1,
      regEspTrib: 0,
      dpsSeries: "1",
      activities: [
        {
          code: "sintetica",
          label: "Atividade sintética",
          cnae: "6202300",
          lc116Item: "01.05",
          cTribNac: "010501",
        },
      ],
      version: 1,
      updatedBy: "synthetic-closure",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("issuanceGates", {
      organizationId,
      companyId,
      production: false,
      actor: "synthetic-closure",
      reason: "Gate sintético do encerramento",
      version: 1,
      updatedAt: now,
    });
    await ctx.db.insert("certificateAudit", {
      organizationId,
      companyId,
      certificateId,
      version: 1,
      actor: "synthetic-closure",
      action: "certificate.used",
      result: "OK",
      createdAt: now,
    });
    const endpointId = await ctx.db.insert("webhookEndpoints", {
      organizationId,
      projectId,
      companyId,
      environment: "sandbox",
      name: "Sintético",
      url: "https://example.invalid/hook",
      events: ["document.received"],
      active: true,
      version: 1,
      secretVersion: 1,
      secret: "synthetic-closure-webhook-secret",
      projectEpoch: 0,
      grantEpoch: 0,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("outboxEvents", {
      organizationId,
      companyId,
      environment: "sandbox",
      projectId,
      logicalKey: `closure:${organizationId}`,
      eventId: crypto.randomUUID(),
      type: "document.received",
      resourceType: "document",
      resourceId: f.documentId,
      resourceVersion: 1,
      body: "{}",
      createdAt: now,
    });
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      endpointId,
      eventId,
      state: "delivered",
      generation: 1,
      attempts: 1,
      resends: 0,
      cycleAttempts: 1,
      nextAttemptAt: now,
      leaseUntil: 0,
      createdAt: now,
    });
    await ctx.db.insert("webhookAttempts", {
      deliveryId,
      generation: 1,
      number: 1,
      startedAt: now,
      finishedAt: now,
      httpStatus: 204,
    });
  });
}

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

const guarded = (Object.entries(retentionClass) as [TableNames, string][])
  .filter(([, c]) => c === "fiscal" || c === "commercial")
  .map(([table]) => table);

/**
 * One row of each guarded class that the import fixture does not create by itself, under an
 * operation of its own in `environment`.
 */
async function seedGuarded(f: Fixture, environment: "sandbox" | "production") {
  const { organizationId, companyId, projectId, keyId } = f.scope;
  return f.t.run(async (ctx) => {
    const now = Date.now();
    const blob = () => ctx.storage.store(new Blob([crypto.randomUUID()]));
    const scope = { organizationId, projectId, companyId, environment };
    const { _id, _creationTime, ...template } = (await ctx.db.query("operations").first())!;
    const operation = { _id: await ctx.db.insert("operations", { ...template, ...scope }) };
    const streamId = await ctx.db.insert("captureStreams", {
      ...scope,
      identity: `guard-${organizationId}`,
      service: "nfe-distribution",
      state: "paused",
      version: 1,
      checkpoint: "0",
      mode: "distNSU",
      nextAllowedAt: now,
      received: 1,
      createdAt: now,
    });
    const batchId = await ctx.db.insert("captureBatches", {
      streamId,
      operationId: operation._id,
      ownerVersion: 1,
      requestNsu: "0",
      mode: "distNSU",
      rawId: await blob(),
      rawHash: "synthetic",
      saved: 1,
      committed: true,
      createdAt: now,
    });
    const artifactId = await ctx.db.insert("documentArtifacts", {
      ...scope,
      captureStreamId: streamId,
      storageId: await blob(),
      sha256: "synthetic",
      size: 36,
      source: "distribution-xml",
      importedAt: now,
    });
    const envelopeId = await ctx.db.insert("captureEnvelopes", {
      streamId,
      nsu: "1",
      batchId,
      artifactId,
      schema: "resNFe_v1.01.xsd",
      sha256: "synthetic",
    });
    await ctx.db.insert("captureBatchEntries", { batchId, position: 0, envelopeId });
    await ctx.db.insert("captureAudit", {
      streamId,
      organizationId,
      action: "capture.paused",
      actor: "synthetic",
      checkpoint: "0",
      createdAt: now,
    });
    await ctx.db.insert("captureProofResponses", { streamId, xml: "<retDistDFeInt/>", calls: 1 });
    await ctx.db.insert("operationProofDocuments", { operationId: operation._id, response: "{}" });
    const issuanceId = await ctx.db.insert("issuances", {
      ...scope,
      operationId: operation._id,
      state: "authorized",
      transport: "simulated",
      target: "sefin-nacional",
      series: "1",
      number: 1,
      dpsId: "DPS3550308211222333000181000010000000000000001",
      snapshot: "{}",
      snapshotSha256: "synthetic",
      submissions: 1,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const cancellationId = await ctx.db.insert("issuanceCancellations", {
      ...scope,
      issuanceId,
      operationId: operation._id,
      sequence: 1,
      reasonCode: "1",
      reason: "Cancelamento sintético da guarda",
      requestedAt: "2026-10-08T12:00:00-03:00",
      state: "registered",
      submissions: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("issuanceArtifacts", {
      organizationId,
      issuanceId,
      cancellationId,
      kind: "cancel-request",
      storageId: await blob(),
      sha256: "synthetic",
      size: 36,
      signed: false,
      createdAt: now,
    });
    await ctx.db.insert("issuanceEvents", {
      organizationId,
      issuanceId,
      kind: "accepted",
      createdAt: now,
    });
    await ctx.db.insert("dpsSequences", {
      organizationId,
      companyId,
      environment,
      series: "1",
      last: 1,
      updatedAt: now,
    });
    await ctx.db.insert("issuanceProbeEvents", {
      organizationId,
      companyId,
      kind: "probe",
      environment: "producao-restrita",
      result: "authorized",
      operator: "operador-freecorps",
      reason: "Linha sintética do histórico do probe",
      buildSha: null,
      deployment: "https://brave-otter-123.convex.cloud",
      createdAt: now,
    });
    await ctx.db.insert("issuanceGateEvents", {
      organizationId,
      companyId,
      version: 1,
      kind: "emergency_disable",
      production: false,
      operator: "operador-freecorps",
      reason: "Linha sintética do histórico do gate",
      runId: "4242",
      runAttempt: 1,
      buildSha: null,
      deployment: "https://brave-otter-123.convex.cloud",
      createdAt: now,
    });
    await ctx.db.insert("captureReleaseEvents", {
      organizationId,
      companyId,
      version: 1,
      kind: "emergency_withdraw",
      released: false,
      blocked: true,
      minIntervalHours: 1,
      revokedKeys: 0,
      operator: "operador-freecorps",
      reason: "Linha sintética do histórico da liberação",
      runId: "4243",
      runAttempt: 1,
      buildSha: null,
      deployment: "https://brave-otter-123.convex.cloud",
      createdAt: now,
    });
    await ctx.db.insert("issuanceSimulations", {
      organizationId,
      companyId,
      environment,
      dpsId: "DPS3550308211222333000181000010000000000000001",
      posts: 1,
      lag: 0,
      cancelled: true,
      eventPosts: 1,
    });
    // An ID map entry of a past rehydration (ADR 0009, §6). Its run is gone, so the closure still
    // reads as never archived: the map follows the fiscal class, not the run.
    const runId = await ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: "synthetic-guard-run",
      version: 1,
      state: "hot",
      reason: "free_inactive",
      noticeAt: now,
      eligibleAt: now,
      retainUntil: now,
      createdAt: now,
      updatedAt: now,
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "",
    });
    await ctx.db.delete("coldArchiveRuns", runId);
    await ctx.db.insert("coldArchiveIdMap", {
      organizationId,
      runId,
      table: "operations",
      previousId: "synthetic-previous-operation",
      previousCreationTime: now - DAY,
      newId: operation._id,
    });
    await ctx.db.insert("registryCalls", {
      operationId: operation._id,
      organizationId,
      provider: "opencnpj",
      startedAt: now,
      state: "responded",
      costMinor: 0,
    });
    await ctx.db.insert("operationReceipts", {
      operationId: operation._id,
      organizationId,
      projectId,
      kind: "usage",
      createdAt: now,
    });
    const limits = { imports: 10, captures: 10, registry: 10, bytes: 10, deliveries: 10 };
    await ctx.db.insert("usagePlans", {
      organizationId,
      name: "Piloto",
      startsAt: now - DAY,
      endsAt: now + DAY,
      limits,
      concurrency: 1,
      version: 1,
      updatedAt: now,
    });
    await ctx.db.insert("usagePlanAudit", {
      organizationId,
      actor: "synthetic",
      reason: "guarda",
      before: null,
      after: "{}",
      createdAt: now,
    });
    // The acceptance outlives the membership of who accepted, removed with the closure.
    const membershipId = await ctx.db.insert("memberships", {
      organizationId,
      authUserId: "synthetic-guard-owner",
      name: "Proprietário sintético",
      email: "guard@development.invalid",
      role: "owner",
      state: "removed",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    });
    await ctx.db.delete("memberships", membershipId);
    await ctx.db.insert("termsOfUseAcceptances", {
      organizationId,
      membershipId,
      version: "termos-de-uso-sinteticos",
      sha256: "a".repeat(64),
      createdAt: now,
    });
    await ctx.db.insert("platformFreeClaims", {
      organizationId,
      authUserId: "synthetic-guard-owner",
      createdAt: now,
    });
    await ctx.db.insert("platformPlanAllocations", {
      organizationId,
      tier: "free",
      filesBytes: 100,
      databaseBytes: 100,
      custodyCents: 6000,
      freeMonthlyCents: 1700,
      updatedAt: now,
    });
    // Expired: a term in force would refuse the closure itself.
    await insertTerm(ctx, {
      organizationId,
      tier: "intermediate",
      firstPeriod: Date.UTC(2025, 0, 1),
      endsAt: Date.UTC(2026, 0, 1),
      source: "stripe",
      references: ["synthetic-guard-term"],
      paidCents: 149000,
      purchasedAt: Date.UTC(2025, 0, 1),
      segments: [],
      state: "expired",
    });
    await ctx.db.insert("platformPlanReceipts", {
      organizationId,
      paymentReference: "synthetic-guard-receipt",
      monthlyCents: 14900,
      baseCostCents: 8000,
      stressCostCents: 9000,
      custodyCents: 10800,
      planVersion: 1,
      createdAt: now,
    });
    await ctx.db.insert("billingAccounts", {
      organizationId,
      customerId: `cus_guard_${organizationId}`,
      livemode: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("billingCheckouts", {
      organizationId,
      key: "synthetic-guard-checkout",
      kind: "start",
      tier: "intermediate",
      period: "2026-10",
      grantCents: 14900,
      state: "expired",
      expiresAt: now,
      requestedBy: "synthetic-guard-owner",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("billingGrants", {
      organizationId,
      invoiceId: `in_guard_${organizationId}`,
      tier: "intermediate",
      period: "2026-10",
      amountCents: 14900,
      state: "applied",
      createdAt: now,
    });
    await ctx.db.insert("billingEvents", {
      stripeEventId: `evt_guard_${organizationId}`,
      type: "invoice.paid",
      livemode: false,
      objectId: `in_guard_${organizationId}`,
      organizationId,
      state: "processed",
      review: false,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("apiUsageEvents", {
      organizationId,
      projectId,
      keyId,
      requestId: crypto.randomUUID(),
      route: "companies.list",
      environment,
      day: new Date(now).toISOString().slice(0, 10),
      shard: 0,
      createdAt: now,
    });
    await ctx.db.insert("apiUsageTotals", {
      organizationId,
      projectId,
      environment,
      route: "companies.get",
      count: 1,
      firstAt: now,
      lastAt: now,
    });
    if (
      !(await ctx.db
        .query("operationalRetention")
        .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
        .unique())
    )
      await ctx.db.insert("operationalRetention", {
        organizationId,
        nextAt: now + DAY,
        generation: 99,
        scheduledId: await ctx.scheduler.runAfter(DAY, internal.telemetryRetention.sweep, {
          organizationId,
          generation: 99,
        }),
      });
    const version = (await ctx.db.query("documentVersions").first())!;
    if (
      !(await ctx.db.query("documentFiscalEvidence").first()) &&
      (await ctx.db.get("fiscalDocuments", f.documentId))
    )
      await ctx.db.insert("documentFiscalEvidence", {
        documentId: f.documentId,
        ruleVersion: "nfe-status/1",
        originalSha256: "synthetic",
        fingerprint: "synthetic",
        snapshot: "{}",
        versionId: version._id,
      });
  });
}

type Twin = { organizationId: Id<"organizations">; ids: Set<string>; storageId: Id<"_storage"> };
/**
 * The fixture's document tree with a file of its own, cloned into another organization or, with
 * `environment`, into the same organization in that environment.
 */
async function twin(f: Fixture, environment?: "production"): Promise<Twin> {
  const other = environment
    ? f.scope
    : await f.t.mutation(internal.testing.operationProof.prepare, {
        keyHash: await hashApiKey(`fnfe_${"e".repeat(43)}`),
        suffix: crypto.randomUUID(),
      });
  const env = environment ? { environment } : {};
  const result = await f.t.run(async (ctx) => {
    const ids = new Set<string>();
    const keep = <T extends string>(id: T) => (ids.add(id), id);
    const strip = <T extends { _id: unknown; _creationTime: number }>({
      _id,
      _creationTime,
      ...rest
    }: T) => rest;
    const scope = {
      organizationId: other.organizationId,
      projectId: other.projectId,
      companyId: other.companyId,
      ...env,
    };
    const storageId = await ctx.storage.store(new Blob(["twin"]));
    const operation = (await ctx.db.query("operations").first())!;
    const operationId = keep(await ctx.db.insert("operations", { ...strip(operation), ...scope }));
    const source = (await ctx.db.query("imports").first())!;
    const importId = keep(await ctx.db.insert("imports", { ...strip(source), ...scope }));
    const file = (await ctx.db.query("importFiles").first())!;
    const fileId = keep(
      await ctx.db.insert("importFiles", {
        ...strip(file),
        importId,
        storageId,
        operationId,
        processingOperationId: operationId,
      }),
    );
    const document = (await ctx.db.get("fiscalDocuments", f.documentId))!;
    const documentId = keep(
      await ctx.db.insert("fiscalDocuments", {
        ...strip(document),
        organizationId: other.organizationId,
        companyId: other.companyId,
        ...env,
        publishedVersionId: undefined,
      }),
    );
    const artifact = (await ctx.db.query("documentArtifacts").first())!;
    const artifactId = keep(
      await ctx.db.insert("documentArtifacts", {
        ...strip(artifact),
        ...scope,
        documentId,
        fileId,
        storageId,
        parentArtifactId: undefined,
        captureStreamId: undefined,
        processingOperationId: operationId,
      }),
    );
    const version = (await ctx.db.query("documentVersions").first())!;
    const versionId = keep(
      await ctx.db.insert("documentVersions", {
        ...strip(version),
        artifactId,
        operationId,
        documentId,
        parentVersionId: undefined,
        // The twin's version has no blob of its own; sharing this one would keep it (B4).
        contentStorageId: undefined,
        contentSha256: undefined,
        contentSize: undefined,
        contentFormat: undefined,
      }),
    );
    const item = await ctx.db.query("documentItems").first();
    if (item) keep(await ctx.db.insert("documentItems", { ...strip(item), versionId }));
    const listing = (await ctx.db.query("documentListings").first())!;
    keep(
      await ctx.db.insert("documentListings", {
        ...strip(listing),
        documentId,
        companyId: other.companyId,
        ...env,
      }),
    );
    const event = (await ctx.db.query("usageEvents").first())!;
    keep(
      await ctx.db.insert("usageEvents", {
        ...strip(event),
        organizationId: other.organizationId,
        ...env,
      }),
    );
    return { organizationId: other.organizationId, ids: [...ids], storageId };
  });
  return { ...result, ids: new Set(result.ids) };
}
/** Rows of the guarded classes split between the twin organization and everything else. */
async function guardedRows(f: Fixture, other: Twin) {
  return f.t.run(async (ctx) => {
    const mine: Record<string, number> = {},
      theirs: Record<string, number> = {};
    for (const table of guarded) {
      const rows: { _id: string; organizationId?: string }[] = await ctx.db.query(table).collect();
      const owned = (row: (typeof rows)[number]) =>
        other.ids.has(row._id) || row.organizationId === other.organizationId;
      mine[table] = rows.filter((row) => !owned(row)).length;
      theirs[table] = rows.filter(owned).length;
    }
    return { mine, theirs };
  });
}
/** Moves the fixture organization's guarded rows to Production, the environment the guard keeps. */
async function production(f: Fixture) {
  await f.t.run(async (ctx) => {
    for (const table of guarded) {
      const rows: {
        _id: string;
        organizationId?: string;
        companyId?: string;
        environment?: string;
      }[] = await ctx.db.query(table).collect();
      for (const row of rows)
        if (
          row.environment === "sandbox" &&
          (row.organizationId === f.scope.organizationId || row.companyId === f.scope.companyId)
        )
          await ctx.db.patch(table as "operations", row._id as Id<"operations">, {
            environment: "production",
          });
    }
  });
}
/** Ids of every guarded row and stored file, by table. */
async function snapshot(f: Fixture) {
  return f.t.run(async (ctx) => {
    const ids: Record<string, string[]> = {};
    for (const table of guarded)
      ids[table] = (await ctx.db.query(table).collect()).map((r) => r._id);
    ids._storage = (await ctx.db.system.query("_storage").collect()).map((file) => file._id);
    return ids;
  });
}
/** Tables where rows of `before` still exist in `after`. */
function survivors(before: Record<string, string[]>, after: Record<string, string[]>) {
  return Object.keys(before)
    .filter((table) => before[table].some((id) => after[table].includes(id)))
    .sort();
}

it("guarda as classes conservadas até o fim do prazo, respeita a retenção legal e expurga só a organização encerrada", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await seed(f, owner.membershipId);
  await production(f);
  await f.t.mutation(internal.accessRecords.recordActor, {
    actor: `key:${f.scope.keyId}`,
    ip: "203.0.113.9",
  });
  const organizationId = f.scope.organizationId;
  const other = await twin(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  let closure = (await closureOf(f))!;
  expect(closure.state).toBe("purged");
  // The guard waits in a job checked again at most weekly.
  expect(closure.scheduledId).toBeDefined();
  const guardUntil = fiscalGuardUntil(closure.requestedAt);
  const decisions = await f.t.query(internal.organizationClosure.decisions, {
    paginationOpts: { numItems: 10, cursor: null },
  });
  expect(decisions.page).toEqual([
    expect.objectContaining({ organizationId, state: "purged", guardUntil, expiredAt: null }),
  ]);

  await seedGuarded(f, "production");
  const kept = await guardedRows(f, other);
  const empty = guarded.filter((table) => kept.mine[table] === 0);
  expect(empty, "every guarded table needs a row of the closed organization").toEqual([]);
  const files = await f.t.run(async (ctx) =>
    (await ctx.db.system.query("_storage").collect()).map((file) => file._id),
  );
  const access = await f.t.run(
    async (ctx) => (await ctx.db.query("accessRecords").collect()).length,
  );

  // Right before the deadline the job only checks again.
  vi.setSystemTime(guardUntil - 1);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await guardedRows(f, other)).toEqual(kept);
  closure = (await closureOf(f))!;

  // A legal hold, operator only, validated on the server.
  const hold = (args: Partial<{ reference: string; responsible: string; reviewAt: number }>) =>
    f.t.mutation(internal.fiscalGuard.hold, {
      organizationId,
      reference: "fiscalizacao-2032-01",
      responsible: "operacao-sintetica",
      reviewAt: guardUntil + 30 * DAY,
      ...args,
    });
  expect(await code(hold({ reference: "  " }))).toBe("INVALID_REQUEST");
  expect(await code(hold({ responsible: "x".repeat(201) }))).toBe("INVALID_REQUEST");
  expect(await code(hold({ reviewAt: Date.now() }))).toBe("INVALID_REQUEST");
  const ghost = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("organizations", {
      name: "Inexistente",
      slug: crypto.randomUUID(),
      ownerCount: 0,
      memberCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.delete("organizations", id);
    return id;
  });
  expect(
    await code(
      f.t.mutation(internal.fiscalGuard.hold, {
        organizationId: ghost,
        reference: "x",
        responsible: "y",
        reviewAt: guardUntil,
      }),
    ),
  ).toBe("NOT_FOUND");
  expect(await hold({})).toBe("held");
  expect(await hold({ reviewAt: guardUntil + 60 * DAY })).toBe("held");
  // A hold on another organization does not keep this one.
  expect(
    await f.t.mutation(internal.fiscalGuard.hold, {
      organizationId: other.organizationId,
      reference: "outro-processo",
      responsible: "operacao-sintetica",
      reviewAt: guardUntil + DAY,
    }),
  ).toBe("held");
  expect(
    (
      await f.t.query(internal.fiscalGuard.holds, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page,
  ).toHaveLength(2);

  // Past the deadline, and past the review date, the hold keeps every row.
  for (const time of [guardUntil, guardUntil + 61 * DAY]) {
    vi.setSystemTime(time);
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: closure._id,
      generation: closure.generation,
    });
    expect(await guardedRows(f, other)).toEqual(kept);
    closure = (await closureOf(f))!;
    expect(closure.expiredAt).toBeUndefined();
  }

  expect(
    await code(f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "outro" })),
  ).toBe("NOT_FOUND");
  expect(
    await f.t.mutation(internal.fiscalGuard.release, {
      organizationId,
      reference: "fiscalizacao-2032-01",
    }),
  ).toEqual({ active: 0 });
  const releasedAt = Date.now();
  await settle(f);
  closure = (await closureOf(f))!;
  expect(closure.expiredAt).toBeDefined();
  // The hold kept the guard past 31/12/2031, so the extra year counts from its release.
  const decisionUntil = decisionGuardUntil(releasedAt);
  expect(decisionUntil).toBe(Date.UTC(2034, 0, 1) + 3 * 3_600_000);
  // Only ids, dates and the state of its own job are left.
  expect(Object.keys(closure).sort()).toEqual(
    [
      "_creationTime",
      "_id",
      "decisionUntil",
      "expiredAt",
      "exportUntil",
      "generation",
      "organizationId",
      "purgeBy",
      "purgedAt",
      "requestedAt",
      "scheduledId",
      "state",
    ].sort(),
  );
  expect(closure.decisionUntil).toBe(decisionUntil);
  const holdRows = () =>
    f.t.run((ctx) =>
      ctx.db
        .query("retentionHolds")
        .collect()
        .then((rows) => rows.map(({ _id, _creationTime, ...row }) => row)),
    );
  expect(await holdRows()).toEqual([
    {
      organizationId,
      reviewAt: guardUntil + 60 * DAY,
      createdAt: expect.any(Number),
      releasedAt,
    },
    expect.objectContaining({ organizationId: other.organizationId, reference: "outro-processo" }),
  ]);
  expect(
    (
      await f.t.query(internal.organizationClosure.decisions, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page,
  ).toEqual([
    expect.objectContaining({ organizationId, removed: null, guardUntil, decisionUntil }),
  ]);

  const after = await guardedRows(f, other);
  expect(
    Object.values(after.mine).every((n) => n === 0),
    JSON.stringify(after.mine),
  ).toBe(true);
  expect(after.theirs).toEqual(kept.theirs);
  await f.t.run(async (ctx) => {
    const left = (await ctx.db.system.query("_storage").collect()).map((file) => file._id);
    expect(left).toEqual([other.storageId]);
    expect(files.length).toBeGreaterThan(2);
    expect(await ctx.db.get("organizations", other.organizationId)).not.toBeNull();
    // Access records keep their own 184 days; the closure record stays as the decision.
    expect((await ctx.db.query("accessRecords").collect()).length).toBe(access);
  });

  // Running it again changes nothing, and a late hold cannot bring anything back.
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await guardedRows(f, other)).toEqual(after);
  expect(await hold({ reviewAt: Date.now() + DAY })).toBe("expired");

  // The decision stays until its own deadline, then goes with the holds of this organization.
  const forget = async (time: number) => {
    vi.setSystemTime(time);
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.forget, {
      closureId: current._id,
      generation: current.generation,
    });
    await settleNow(f);
  };
  await forget(decisionUntil - 1);
  expect(await closureOf(f)).not.toBeNull();
  expect(await holdRows()).toHaveLength(2);
  await forget(decisionUntil);
  expect(await closureOf(f)).toBeNull();
  expect(await holdRows()).toEqual([
    expect.objectContaining({ organizationId: other.organizationId, reference: "outro-processo" }),
  ]);
  expect(await guardedRows(f, other)).toEqual(after);
  // Nothing is left to hold, release or reapply; running the job again changes nothing.
  await f.t.mutation(internal.fiscalGuard.forget, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await code(hold({ reviewAt: Date.now() + DAY }))).toBe("NOT_FOUND");
  expect(
    await f.t.mutation(internal.organizationClosure.reapply, {
      organizationId,
      requestedAt: closure.requestedAt,
    }),
  ).toBe("absent");
});

it("conserva a decisão até o fim da guarda mais um ano e só depois do expurgo fiscal", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  const other = await twin(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  let closure = (await closureOf(f))!;
  const guardUntil = fiscalGuardUntil(closure.requestedAt);
  const decisionUntil = decisionGuardUntil(guardUntil);
  expect(decisionUntil).toBe(Date.UTC(2033, 0, 1) + 3 * 3_600_000);
  const run = async (time: number) => {
    vi.setSystemTime(time);
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.forget, {
      closureId: current._id,
      generation: current.generation,
    });
  };

  // Released holds of both organizations, more than one batch of this one.
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 450; i++)
      await ctx.db.insert("retentionHolds", {
        organizationId,
        reference: `processo-${i}`,
        responsible: "operacao-sintetica",
        reviewAt: Date.now() + DAY,
        createdAt: Date.now(),
        releasedAt: Date.now(),
      });
    await ctx.db.insert("retentionHolds", {
      organizationId: other.organizationId,
      reference: "outro-processo",
      responsible: "operacao-sintetica",
      reviewAt: Date.now() + DAY,
      createdAt: Date.now(),
      releasedAt: Date.now(),
    });
  });
  const holds = () =>
    f.t.run(async (ctx) => {
      const rows = await ctx.db.query("retentionHolds").collect();
      const mine = rows.filter((row) => row.organizationId === organizationId);
      return {
        mine: mine.length,
        named: mine.filter((row) => row.reference !== undefined).length,
        theirs: rows.filter((row) => row.organizationId === other.organizationId),
      };
    });
  const theirs = (await holds()).theirs;

  // Before the fiscal purge ends, nothing of the decision goes, however late it is.
  await run(decisionUntil + 365 * DAY);
  expect(await closureOf(f)).toEqual(closure);
  expect(await holds()).toEqual({ mine: 450, named: 450, theirs });

  // The fiscal purge at its exact deadline; the references go in batches right after it.
  vi.setSystemTime(guardUntil);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: (await closureOf(f))!.generation,
  });
  await settleNow(f);
  closure = (await closureOf(f))!;
  expect(closure.expiredAt).toBeDefined();
  expect(closure.decisionUntil).toBe(decisionUntil);
  expect(await holds()).toEqual({ mine: 450, named: 0, theirs });
  // The next check is scheduled, at most a week ahead.
  const job = await f.t.run((ctx) =>
    ctx.db.system.get("_scheduled_functions", closure.scheduledId!),
  );
  expect(job?.name).toContain("forget");
  expect(job?.scheduledTime).toBe(guardUntil + 7 * DAY);

  // A hold still active (a restore, or a row out of the expected path) keeps everything.
  const active = await f.t.run((ctx) =>
    ctx.db.insert("retentionHolds", {
      organizationId,
      reference: "fiscalizacao-tardia",
      responsible: "operacao-sintetica",
      reviewAt: decisionUntil + DAY,
      createdAt: Date.now(),
    }),
  );
  await run(decisionUntil);
  expect(await closureOf(f)).not.toBeNull();
  expect((await holds()).mine).toBe(451);
  vi.setSystemTime(decisionUntil - 1);
  expect(
    await f.t.mutation(internal.fiscalGuard.release, {
      organizationId,
      reference: "fiscalizacao-tardia",
    }),
  ).toEqual({ active: 0 });
  expect((await f.t.run((ctx) => ctx.db.get("retentionHolds", active)))?.releasedAt).toBe(
    decisionUntil - 1,
  );

  // One instant before the deadline nothing goes; at the deadline, batch by batch, all of it.
  await run(decisionUntil - 1);
  expect(await closureOf(f)).not.toBeNull();
  expect(await holds()).toEqual({ mine: 451, named: 0, theirs });
  await run(decisionUntil);
  expect((await holds()).mine).toBe(251);
  expect(await closureOf(f)).not.toBeNull();
  await settleNow(f);
  expect(await closureOf(f)).toBeNull();
  expect(await holds()).toEqual({ mine: 0, named: 0, theirs });
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query("organizationClosures").collect()).toEqual([]);
    expect(await ctx.db.get("organizations", other.organizationId)).not.toBeNull();
  });
  // Running it again changes nothing.
  await f.t.mutation(internal.fiscalGuard.forget, {
    closureId: closure._id,
    generation: closure.generation + 10,
  });
  expect(await holds()).toEqual({ mine: 0, named: 0, theirs });
});

it("após um restore, rearma o prazo da decisão e trata os encerramentos expirados antes dele", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  let closure = (await closureOf(f))!;
  const guardUntil = fiscalGuardUntil(closure.requestedAt);
  vi.setSystemTime(guardUntil);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  // A closure expired by the previous version: no job, no deadline, the old fields and a named hold.
  await f.t.run(async (ctx) => {
    const row = (await ctx.db.query("organizationClosures").first())!;
    await ctx.scheduler.cancel(row.scheduledId!);
    await ctx.db.patch("organizationClosures", row._id, {
      scheduledId: undefined,
      decisionUntil: undefined,
      requestedBy: "member:legacy",
      revoked: true,
      removed: 32,
      expired: 48,
    });
    await ctx.db.insert("retentionHolds", {
      organizationId,
      reference: "fiscalizacao-antiga",
      responsible: "operacao-sintetica",
      reviewAt: guardUntil - DAY,
      createdAt: guardUntil - 30 * DAY,
      releasedAt: guardUntil - 2 * DAY,
    });
  });
  const closures = () => f.t.query(internal.retentionRecovery.inspect, { phase: 0, cursor: null });
  expect((await closures()).missing).toBe(1);
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closures()).missing).toBe(0);
  closure = (await closureOf(f))!;
  expect(closure).toEqual(
    expect.objectContaining({ decisionUntil: decisionGuardUntil(guardUntil) }),
  );
  for (const field of ["requestedBy", "revoked", "removed", "expired"])
    expect(closure).not.toHaveProperty(field);
  const hold = await f.t.run((ctx) => ctx.db.query("retentionHolds").first());
  expect(hold).not.toHaveProperty("reference");
  expect(hold).not.toHaveProperty("responsible");
  // Recovering again changes nothing.
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closureOf(f))!.generation).toBe(closure.generation);

  // A snapshot restored after the deadline: the recovered job removes the decision at once.
  await f.t.run(async (ctx) => {
    await ctx.scheduler.cancel(closure.scheduledId!);
  });
  vi.setSystemTime(closure.decisionUntil!);
  expect((await closures()).missing).toBe(1);
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect(await closureOf(f)).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.query("retentionHolds").collect())).toEqual([]);
  expect((await closures()).missing).toBe(0);
});

it("após um restore, rearma a guarda das organizações já expurgadas", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await production(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId: f.scope.organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  // A snapshot without the job, or a closure purged before the guard existed.
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db.query("organizationClosures").first())!;
    expect(closure.state).toBe("purged");
    await ctx.scheduler.cancel(closure.scheduledId!);
    await ctx.db.patch("organizationClosures", closure._id, { scheduledId: undefined });
  });
  const closures = () => f.t.query(internal.retentionRecovery.inspect, { phase: 0, cursor: null });
  expect((await closures()).missing).toBe(1);
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closures()).missing).toBe(0);
  const recovered = (await closureOf(f))!;
  await f.t.mutation(internal.retentionRecovery.recover, { phase: 0, cursor: null });
  await settleNow(f);
  expect((await closureOf(f))!.generation).toBe(recovered.generation);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).not.toBeNull();
});

it("para o expurgo da guarda sem apagar nada quando a árvore alcança outra organização", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await production(f);
  const other = await twin(f);
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId: f.scope.organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  // A corrupted link: an artifact of the other organization under one of this organization.
  const foreign = await f.t.run(async (ctx) => {
    const parent = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const { _id, _creationTime, ...rest } = parent;
    return ctx.db.insert("documentArtifacts", {
      ...rest,
      organizationId: other.organizationId,
      documentId: undefined,
      parentArtifactId: parent._id,
      entryIndex: 0,
    });
  });
  const closure = (await closureOf(f))!;
  const before = await guardedRows(f, other);
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  await expect(
    f.t.mutation(internal.fiscalGuard.expire, {
      closureId: closure._id,
      generation: closure.generation,
    }),
  ).rejects.toThrow("Cross-organization artifact");
  expect(await guardedRows(f, other)).toEqual(before);
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", foreign))).not.toBeNull();
  expect((await closureOf(f))!.expiredAt).toBeUndefined();
});

const operatorArgs = { actor: "operacao-sintetica", reason: "Sobra sintética do teste de carga" };
it("o operador encerra pelo mesmo fluxo uma organização sem dado fiscal de produção", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  const other = await f.t.mutation(internal.testing.operationProof.prepare, {
    keyHash: await hashApiKey(`fnfe_${"o".repeat(43)}`),
    suffix: crypto.randomUUID(),
  });
  const close = (args: { organizationId: Id<"organizations">; actor?: string; reason?: string }) =>
    f.t.mutation(internal.organizationClosure.closeByOperator, { ...operatorArgs, ...args });

  expect(await code(close({ organizationId, actor: " " }))).toBe("INVALID_REQUEST");
  expect(await code(close({ organizationId, actor: "a@b.invalid" }))).toBe("INVALID_REQUEST");
  expect(await code(close({ organizationId, reason: "curto" }))).toBe("INVALID_REQUEST");
  expect(await code(close({ organizationId, reason: "x".repeat(501) }))).toBe("INVALID_REQUEST");
  const missing = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("organizations", {
      name: "Apagada",
      slug: crypto.randomUUID(),
      ownerCount: 0,
      memberCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    await ctx.db.delete("organizations", id);
    return id;
  });
  expect(await code(close({ organizationId: missing }))).toBe("NOT_FOUND");
  expect(await f.t.run((ctx) => ctx.db.query("organizationClosures").collect())).toEqual([]);

  // The fixture's only fiscal document is a sandbox one, and a free plan in force is no refusal.
  await f.t.run((ctx) => planInForce(ctx, f, "free"));
  const closed = await close({ organizationId });
  expect(closed.exportUntil - Date.now()).toBe(30 * DAY);
  expect(closed.purgeBy - closed.exportUntil).toBe(7 * DAY);
  expect(await closureOf(f)).toMatchObject({
    state: "closing",
    requestedBy: "operator:operacao-sintetica",
  });
  const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(jobs.map((job) => job.name)).toEqual(
    expect.arrayContaining(["organizationClosure:revoke", "organizationClosure:purge"]),
  );
  const audit = await f.t.run((ctx) =>
    ctx.db
      .query("organizationAudit")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .collect(),
  );
  expect(audit).toEqual([
    expect.objectContaining({
      actorUserId: "operator:freecorps",
      action: "organization.closure-requested",
      target: organizationId,
    }),
  ]);
  expect(
    await code(
      owner.client.mutation(api.organizations.update, { organizationId, name: "Outro nome" }),
    ),
  ).toBe("ORGANIZATION_CLOSED");

  // A second call creates nothing.
  expect(await code(close({ organizationId }))).toBe("ORGANIZATION_CLOSED");
  await settleNow(f);
  const rows = await f.t.run((ctx) => ctx.db.query("organizationClosures").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ organizationId, revoked: true });

  // The other organization is untouched.
  const untouched = await f.t.run(async (ctx) => ({
    projects: await ctx.db
      .query("projects")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", other.organizationId))
      .collect(),
    key: await ctx.db.get("apiKeys", other.keyId),
    audit: await ctx.db
      .query("organizationAudit")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", other.organizationId))
      .collect(),
    closures: await ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", other.organizationId))
      .collect(),
  }));
  expect(untouched.projects.length).toBeGreaterThan(0);
  expect(untouched.projects.every((p) => p.state === "active")).toBe(true);
  expect(untouched.key?.revokedAt).toBeNull();
  expect(untouched.audit).toEqual([]);
  expect(untouched.closures).toEqual([]);
});

const closeAsOperator = (f: Fixture, organizationId = f.scope.organizationId) =>
  f.t.mutation(internal.organizationClosure.closeByOperator, { organizationId, ...operatorArgs });
/** A second company of the fixture's organization, as the console would create it. */
async function anotherCompany(ctx: MutationCtx, f: Fixture) {
  const { _id, _creationTime, ...company } = (await ctx.db.get("companies", f.scope.companyId))!;
  return ctx.db.insert("companies", { ...company, cnpj: "11222333000181" });
}
function productionStream(f: Fixture, companyId = f.scope.companyId) {
  const now = Date.now();
  return {
    organizationId: f.scope.organizationId,
    projectId: f.scope.projectId,
    companyId,
    environment: "production" as const,
    identity: `operator-${companyId}`,
    service: "nfe-distribution" as const,
    state: "paused" as const,
    version: 1,
    checkpoint: "0",
    mode: "distNSU" as const,
    nextAllowedAt: now,
    received: 0,
    createdAt: now,
  };
}
/** An annual term starting on the 1st of `firstPeriod`'s month: in force now, or long ended. */
function annualTerm(ctx: MutationCtx, f: Fixture, firstPeriod: number) {
  const start = new Date(firstPeriod);
  const from = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
  return insertTerm(ctx, {
    organizationId: f.scope.organizationId,
    tier: "intermediate",
    firstPeriod: from,
    endsAt: Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 1),
    source: "stripe",
    references: ["synthetic-operator-term"],
    paidCents: 149000,
    purchasedAt: from,
    segments: [],
    state: "active",
  });
}
/** A plan of the organization that has not ended, with the given tier. */
function planInForce(
  ctx: MutationCtx,
  f: Fixture,
  catalogTier: "free" | "intermediate" | "custom" | undefined,
  endsAt: number | null = Date.now() + DAY,
) {
  return ctx.db.insert("usagePlans", {
    organizationId: f.scope.organizationId,
    catalogTier,
    name: "Plano sintético",
    startsAt: Date.now() - 2 * DAY,
    endsAt,
    limits: { imports: 10, captures: 10, registry: 10, bytes: 10, deliveries: 10 },
    concurrency: 1,
    version: 1,
    updatedAt: Date.now(),
  });
}
const operatorRefusals: [string, string, (ctx: MutationCtx, f: Fixture) => Promise<unknown>][] = [
  [
    "documento de produção",
    "PRODUCTION_DATA",
    (ctx, f) => ctx.db.patch("fiscalDocuments", f.documentId, { environment: "production" }),
  ],
  [
    "artefato de produção sem documento",
    "PRODUCTION_DATA",
    async (ctx, f) =>
      ctx.db.insert("documentArtifacts", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        storageId: await ctx.storage.store(new Blob(["production"])),
        sha256: "synthetic",
        size: 10,
        source: "distribution-xml",
        importedAt: Date.now(),
      }),
  ],
  [
    "importação de produção",
    "PRODUCTION_DATA",
    async (ctx, f) => {
      for (const row of await ctx.db
        .query("imports")
        .withIndex("by_organizationId_and_projectId_and_key", (q) =>
          q.eq("organizationId", f.scope.organizationId),
        )
        .collect())
        await ctx.db.patch("imports", row._id, { environment: "production" });
    },
  ],
  [
    "emissão de produção",
    "PRODUCTION_DATA",
    async (ctx, f) => {
      const now = Date.now();
      const operation = (await ctx.db
        .query("operations")
        .withIndex("by_organizationId_and_projectId_and_environment", (q) =>
          q.eq("organizationId", f.scope.organizationId),
        )
        .first())!;
      await ctx.db.insert("issuances", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        operationId: operation._id,
        state: "authorized",
        transport: "simulated",
        target: "sefin-nacional",
        series: "1",
        number: 1,
        dpsId: "DPS3550308211222333000181000010000000000000001",
        snapshot: "{}",
        snapshotSha256: "synthetic",
        submissions: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    },
  ],
  [
    "stream de captura de produção",
    "PRODUCTION_DATA",
    (ctx, f) => ctx.db.insert("captureStreams", productionStream(f)),
  ],
  [
    "captura liberada antes e retirada",
    "PRODUCTION_DATA",
    async (ctx, f) => {
      const now = Date.now();
      const eventId = await ctx.db.insert("captureReleaseEvents", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        version: 2,
        kind: "emergency_withdraw",
        released: false,
        blocked: false,
        minIntervalHours: 1,
        revokedKeys: 0,
        operator: "operador-freecorps",
        reason: "Liberação sintética retirada",
        runId: "4243",
        runAttempt: 1,
        buildSha: null,
        deployment: "https://brave-otter-123.convex.cloud",
        createdAt: now,
      });
      await ctx.db.insert("captureReleases", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        released: false,
        releasedBefore: true,
        blocked: false,
        minIntervalHours: 1,
        actor: "operator:freecorps",
        reason: "Liberação sintética retirada",
        version: 2,
        updatedAt: now,
        eventId,
      });
    },
  ],
  [
    "gate de emissão em produção",
    "PRODUCTION_DATA",
    (ctx, f) =>
      ctx.db.insert("issuanceGates", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        production: true,
        actor: "operator:freecorps",
        reason: "Gate sintético em produção",
        version: 1,
        updatedAt: Date.now(),
      }),
  ],
  [
    "sondagem de emissão em produção",
    "PRODUCTION_DATA",
    (ctx, f) =>
      ctx.db.insert("issuanceProbeEvents", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        kind: "probe",
        environment: "producao",
        result: "authorized",
        operator: "operador-freecorps",
        reason: "Sondagem sintética de produção",
        buildSha: null,
        deployment: "https://brave-otter-123.convex.cloud",
        createdAt: Date.now(),
      }),
  ],
  [
    "produção só na segunda empresa",
    "PRODUCTION_DATA",
    async (ctx, f) =>
      ctx.db.insert("captureStreams", productionStream(f, await anotherCompany(ctx, f))),
  ],
  [
    "conexão Stripe de produção",
    "PRODUCTION_DATA",
    (ctx, f) =>
      ctx.db.insert("stripeConnections", {
        organizationId: f.scope.organizationId,
        projectId: f.scope.projectId,
        companyId: f.scope.companyId,
        environment: "production",
        name: "Stripe sintético",
        active: false,
        config: {
          market: "domestic",
          description: "{itens}",
          invoices: true,
          checkouts: false,
          foreignWithoutNif: "hold",
          refundPolicy: "notify",
        },
        secret: "",
        projectEpoch: 0,
        grantEpoch: 0,
        version: 1,
        createdBy: "synthetic",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  ],
  ["plano intermediate vigente", "PAID_PLAN", (ctx, f) => planInForce(ctx, f, "intermediate")],
  ["plano custom vigente", "PAID_PLAN", (ctx, f) => planInForce(ctx, f, "custom")],
  ["plano sem tier vigente", "PAID_PLAN", (ctx, f) => planInForce(ctx, f, undefined)],
  ["termo anual em vigor", "PAID_PLAN", (ctx, f) => annualTerm(ctx, f, Date.now())],
  // Like a receipt: an annual term once paid keeps the operator out, even after it ended.
  ["termo anual já encerrado", "PAID_PLAN", (ctx, f) => annualTerm(ctx, f, Date.UTC(2020, 0, 1))],
  [
    "mais sondagens de emissão que o limite",
    "OPERATOR_CLOSURE_LIMIT",
    async (ctx, f) => {
      for (let i = 0; i <= OPERATOR_CLOSURE_LIMIT; i++)
        await ctx.db.insert("issuanceProbeEvents", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          kind: "probe",
          environment: "producao-restrita",
          result: "authorized",
          operator: "operador-freecorps",
          reason: "Sondagem sintética de homologação",
          buildSha: null,
          deployment: "https://brave-otter-123.convex.cloud",
          createdAt: Date.now(),
        });
    },
  ],
  // The card still charges: a subscription that renews, in either Stripe mode, or an open
  // Checkout (`cardBilling`).
  ...([true, false] as const).map(
    (livemode): [string, string, (ctx: MutationCtx, f: Fixture) => Promise<unknown>] => [
      `assinatura do cartão que renova (livemode ${livemode})`,
      "PAID_PLAN",
      (ctx, f) =>
        ctx.db.insert("billingAccounts", {
          organizationId: f.scope.organizationId,
          customerId: `cus_operator_${livemode}`,
          livemode,
          subscription: {
            id: `sub_operator_${livemode}`,
            status: "active",
            tier: "intermediate",
            cancelAtPeriodEnd: false,
            periodEnd: Date.now() + 30 * DAY,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    ],
  ),
  [
    "Checkout do cartão aberto",
    "PAID_PLAN",
    (ctx, f) =>
      ctx.db.insert("billingCheckouts", {
        organizationId: f.scope.organizationId,
        key: "synthetic-operator-checkout",
        kind: "start",
        tier: "intermediate",
        grantCents: 14900,
        state: "open",
        expiresAt: Date.now() + DAY,
        requestedBy: "synthetic-operator-owner",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  ],
  [
    "recibo de plano da plataforma",
    "PAID_PLAN",
    (ctx, f) =>
      ctx.db.insert("platformPlanReceipts", {
        organizationId: f.scope.organizationId,
        paymentReference: "synthetic-operator-receipt",
        monthlyCents: 14900,
        baseCostCents: 8000,
        stressCostCents: 9000,
        custodyCents: 10800,
        planVersion: 1,
        createdAt: Date.now(),
      }),
  ],
  [
    "mais empresas que o limite",
    "OPERATOR_CLOSURE_LIMIT",
    async (ctx, f) => {
      for (let i = 0; i < OPERATOR_CLOSURE_LIMIT; i++) await anotherCompany(ctx, f);
    },
  ],
];
it("o owner não encerra organização com plano anual em vigor ou agendado", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => annualTerm(ctx, f, Date.now()));
  expect(
    await code(
      owner.client.mutation(api.organizationClosure.close, {
        organizationId: f.scope.organizationId,
        confirmation: await slug(f),
      }),
    ),
  ).toBe("ANNUAL_TERM_ACTIVE");
  expect(await f.t.run((ctx) => ctx.db.query("organizationClosures").collect())).toEqual([]);
});
it("depois da rescisão pelo suporte, o owner volta a encerrar a organização", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const termId = await f.t.run((ctx) => annualTerm(ctx, f, Date.now()));
  const confirmation = await slug(f);
  const close = () =>
    owner.client.mutation(api.organizationClosure.close, {
      organizationId: f.scope.organizationId,
      confirmation,
    });
  expect(await code(close())).toBe("ANNUAL_TERM_ACTIVE");
  await f.t.mutation(internal.plans.rescindTerm, {
    termId,
    key: "rescission-before-closure",
    actor: "operador-sintetico",
    reason: "Cliente pediu a rescisão e o encerramento",
  });
  expect(await code(close())).toBe("OK");
  expect(await closureOf(f)).toMatchObject({ state: "closing" });
});
it.each(operatorRefusals)("o operador recusa organização com %s", async (_, refusal, setup) => {
  const f = await fixture();
  await f.t.run((ctx) => setup(ctx, f));
  expect(await code(closeAsOperator(f))).toBe(refusal);
  const left = await f.t.run(async (ctx) => ({
    closures: await ctx.db.query("organizationClosures").collect(),
    audit: await ctx.db
      .query("organizationAudit")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.scope.organizationId))
      .collect(),
  }));
  expect(left).toEqual({ closures: [], audit: [] });
});

it("o operador encerra organização sem empresa e com plano pago já encerrado", async () => {
  const f = await fixture();
  const organizationId = await f.t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("organizations", {
      name: "Sobra sintética",
      slug: crypto.randomUUID(),
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("usagePlans", {
      organizationId: id,
      catalogTier: "large",
      name: "Grande",
      startsAt: now - 2 * DAY,
      endsAt: now - DAY,
      limits: { imports: 10, captures: 10, registry: 10, bytes: 10, deliveries: 10 },
      concurrency: 1,
      version: 1,
      updatedAt: now,
    });
    return id;
  });
  const closed = await closeAsOperator(f, organizationId);
  expect(closed.exportUntil - Date.now()).toBe(30 * DAY);
  await settleNow(f);
  const closures = await f.t.run((ctx) => ctx.db.query("organizationClosures").collect());
  expect(closures).toEqual([
    expect.objectContaining({
      organizationId,
      revoked: true,
      requestedBy: "operator:operacao-sintetica",
    }),
  ]);
});

it("o operador não encerra fora de um perfil válido da plataforma", async () => {
  const f = await fixture();
  vi.stubEnv("APP_ENV", "installation");
  await expect(closeAsOperator(f)).rejects.toThrow("explicit HTTPS origin");
  vi.stubEnv("APP_ENV", "development");
  expect(await f.t.run((ctx) => ctx.db.query("organizationClosures").collect())).toEqual([]);
});

async function closeAndPurge(f: Fixture, owner: Awaited<ReturnType<typeof actor>>) {
  const closed = await owner.client.mutation(api.organizationClosure.close, {
    organizationId: f.scope.organizationId,
    confirmation: await slug(f),
  });
  await settle(f);
  await at(f, closed.exportUntil + 1);
  const closure = (await closureOf(f))!;
  expect(closure.state).toBe("purged");
  return closure;
}
/** Every row, guarded or not, outside the ids of `before`: what the Sandbox purge must not touch. */
async function rest(f: Fixture, before: Record<string, string[]>) {
  return f.t.run(async (ctx) => {
    const known = new Set(Object.values(before).flat());
    const rows: Record<string, unknown[]> = {};
    for (const table of guarded)
      rows[table] = (await ctx.db.query(table).collect()).filter((row) => !known.has(row._id));
    rows._storage = (await ctx.db.system.query("_storage").collect())
      .map((file) => file._id)
      .filter((id) => !known.has(id));
    return rows;
  });
}

// Freecorps' own plan, payment and capacity records: the early removal leaves them to the guard.
const ownRecords = [
  "billingAccounts",
  "billingCheckouts",
  "billingEvents",
  "billingGrants",
  "capacityAccounts",
  "capacityEvents",
  "capacityTotals",
  "platformFreeClaims",
  "platformPlanAllocations",
  "platformPlanReceipts",
  "platformPlanTerms",
  "termsOfUseAcceptances",
  "usagePlanAudit",
  "usagePlans",
];
const own = (ids: Record<string, string[]>) => ownRecords.filter((table) => ids[table]?.length);

/** Rows with no environment: certificate audit, an orphan idempotency record, usage before #429. */
async function seedWithoutEnvironment(f: Fixture, membershipId: Id<"memberships">) {
  await seed(f, membershipId);
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...template } = (await ctx.db.query("operations").first())!;
    const operationId = await ctx.db.insert("operations", template);
    await ctx.db.delete("operations", operationId);
    await ctx.db.insert("idempotencyRecords", {
      organizationId: f.scope.organizationId,
      projectId: f.scope.projectId,
      name: "documents.import",
      key: "orphan",
      requestHash: "synthetic",
      operationId,
    });
    await ctx.db.insert("usageEvents", {
      organizationId: f.scope.organizationId,
      metric: "imports",
      key: "before-429",
      period: "2026-10",
      quantity: 1,
      state: "committed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

it("remove depois do encerramento os dados fiscais de uma organização que nunca teve Produção, sem os registros próprios da Freecorps", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await seedGuarded(f, "sandbox");
  await seedWithoutEnvironment(f, owner.membershipId);
  const before = await snapshot(f);
  const other = await twin(f);
  // A real note of another organization decides nothing here (#108).
  await f.t.run(async (ctx) => {
    for (const row of await ctx.db.query("fiscalDocuments").collect())
      if (row.organizationId === other.organizationId)
        await ctx.db.patch("fiscalDocuments", row._id, { tpAmb: "1" });
  });
  const untouched = await rest(f, before);
  expect((await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId)))!.tpAmb).toBe("2");
  const closure = await closeAndPurge(f, owner);
  const after = await snapshot(f);
  // Plans, payments and capacity stay for their own deadline.
  expect(survivors(before, after)).toEqual(own(before));
  expect(own(before)).toEqual(
    expect.arrayContaining(["platformFreeClaims", "platformPlanReceipts", "platformPlanTerms"]),
  );
  expect(after._storage).toEqual([other.storageId]);
  // Another organization keeps its Sandbox.
  expect(await rest(f, before)).toEqual(untouched);
  expect(closure.expiredAt).toBeUndefined();
  expect(closure.sandboxOnly).toBe(true);
  // The guard then ends at its deadline as for an organization without fiscal data.
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  expect(await rest(f, before)).toEqual(untouched);
});

it("com qualquer sinal de Produção, a guarda conserva tudo até o prazo, como antes", async () => {
  const now = () => Date.now();
  const gate = (f: Fixture, production: boolean) =>
    f.t.run((ctx) =>
      ctx.db.insert("issuanceGateEvents", {
        organizationId: f.scope.organizationId,
        companyId: f.scope.companyId,
        version: 1,
        kind: "emergency_disable",
        production,
        operator: "operador-freecorps",
        reason: "Gate sintético",
        runId: "2",
        runAttempt: 1,
        buildSha: null,
        deployment: "https://brave-otter-123.convex.cloud",
        createdAt: now(),
      }),
    );
  const signals = {
    usage: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("usageEvents", {
          organizationId: f.scope.organizationId,
          environment: "production",
          metric: "imports",
          key: "production",
          period: "2026-10",
          quantity: 1,
          state: "committed",
          createdAt: now(),
          updatedAt: now(),
        }),
      ),
    release: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("captureReleaseEvents", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          version: 1,
          kind: "emergency_withdraw",
          released: true,
          blocked: false,
          minIntervalHours: 1,
          revokedKeys: 0,
          operator: "operador-freecorps",
          reason: "Liberação sintética",
          runId: "1",
          runAttempt: 1,
          buildSha: null,
          deployment: "https://brave-otter-123.convex.cloud",
          createdAt: now(),
        }),
      ),
    gate: (f: Fixture) => gate(f, true),
    // #108: an imported NF-e whose XML says Produção, and one not known to be homologação.
    real: (f: Fixture) =>
      f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "1" })),
    unmarked: (f: Fixture) =>
      f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: undefined })),
    // More history than one read covers counts as Production, even without a production event.
    events: async (f: Fixture) => {
      for (let i = 0; i < 101; i++) await gate(f, false);
    },
    probe: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("issuanceProbeEvents", {
          organizationId: f.scope.organizationId,
          companyId: f.scope.companyId,
          kind: "probe",
          environment: "producao",
          result: "authorized",
          operator: "operador-freecorps",
          reason: "Probe sintético",
          buildSha: null,
          deployment: "https://brave-otter-123.convex.cloud",
          createdAt: now(),
        }),
      ),
    imports: (f: Fixture) =>
      f.t.run(async (ctx) => {
        const row = (await ctx.db.query("imports").first())!;
        await ctx.db.patch("imports", row._id, { environment: "production" });
      }),
    issuances: async (f: Fixture) => {
      await seedGuarded(f, "sandbox");
      await f.t.run(async (ctx) => {
        const row = (await ctx.db.query("issuances").first())!;
        await ctx.db.patch("issuances", row._id, { environment: "production" });
      });
    },
    // Cold archive moves rows out of the tables the decision reads: an archive run is enough.
    archived: (f: Fixture) =>
      f.t.run((ctx) =>
        ctx.db.insert("coldArchiveRuns", {
          organizationId: f.scope.organizationId,
          key: `archive-${f.scope.organizationId}`,
          version: 1,
          state: "archived",
          reason: "closed",
          noticeAt: now(),
          eligibleAt: now(),
          retainUntil: now() + 365 * DAY,
          createdAt: now(),
          updatedAt: now(),
          phase: 0,
          cursor: null,
          rows: 0,
          files: 0,
          bytes: 0,
          digest: "synthetic",
        }),
      ),
  };
  for (const [name, signal] of Object.entries(signals)) {
    vi.setSystemTime(Date.UTC(2026, 9, 27, 12));
    const f = await fixture(),
      owner = await actor(f);
    // The signal appears during the closing window: the decision is taken at the purge.
    const closed = await owner.client.mutation(api.organizationClosure.close, {
      organizationId: f.scope.organizationId,
      confirmation: await slug(f),
    });
    await signal(f);
    const kept = await counts(f, conserved);
    await settle(f);
    await at(f, closed.exportUntil + 1);
    const closure = (await closureOf(f))!;
    expect(closure.state, name).toBe("purged");
    expect(closure.sandboxOnly, name).toBe(false);
    expect(await counts(f, conserved), name).toEqual(kept);
    // Only the deadline removes it.
    vi.setSystemTime(fiscalGuardUntil(closure.requestedAt) - 1);
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: closure._id,
      generation: closure.generation,
    });
    expect(await counts(f, conserved), name).toEqual(kept);
  }
});

it("uma NF-e importada com tpAmb 1 no Sandbox não sai na remoção antecipada, chamada direto", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "1" }));
  const kept = await counts(f, conserved);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(false);
  expect(await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id })).toEqual({
    done: true,
    removed: 0,
  });
  expect(await counts(f, conserved)).toEqual(kept);
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).not.toBeNull();
});

it("a NF-e com tpAmb 1 do Sandbox fica até o prazo da guarda e sai na expiração final", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "1" }));
  const closure = await closeAndPurge(f, owner);
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt) - 1);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).not.toBeNull();
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  const current = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: current._id,
    generation: current.generation,
  });
  await settleNow(f);
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  expect(await f.t.run((ctx) => ctx.db.get("fiscalDocuments", f.documentId))).toBeNull();
});

it("uma decisão de só Sandbox tomada antes da #108 para uma vez diante de uma NF-e real", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "anterior-108",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  // The note as it was before #108: no mark, under a decision already recorded.
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: undefined }));
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "anterior-108" });
  const kept = await counts(f, conserved);
  const warn = vi.spyOn(console, "warn");
  for (let i = 0; i < 2; i++) {
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: current._id,
      generation: current.generation,
    });
  }
  const stopped = warn.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("organization.sandbox-purge-stopped"));
  warn.mockRestore();
  expect(stopped).toHaveLength(1);
  expect(JSON.parse(stopped[0]!)).toMatchObject({ reason: "fiscal-document" });
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
});

/**
 * Imports `xml` as one more file of the fixture's company and runs its operation. The corpus note
 * with another issuer is refused as COMPANY_MISMATCH and keeps no document, only its original.
 */
async function importRefused(f: Fixture, xml: string) {
  const bytes = Buffer.from(xml);
  const key = crypto.randomUUID();
  const data = async (path: string, body?: unknown) =>
    (await (await f.request(path, "POST", body, `${key}-${path}`)).json()).data;
  const batch = await data("/v1/imports", {
    companyId: f.scope.companyId,
    files: [
      {
        name: "recusada.xml",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  });
  const file = `/v1/imports/${batch.importId}/files/${batch.fileIds[0]}`;
  const upload = await data(`${file}/upload`);
  const sent = await f.t.fetch("/v1/import-upload", {
    method: "POST",
    headers: { "X-Upload-Token": upload.token },
    body: new Uint8Array(bytes),
  });
  expect(sent.status).toBe(200);
  const { operationId } = await data(`${file}/confirm`);
  await f.t.action(internal.operationWorker.run, { operationId, generation: 1 });
  // The content blob of the new version, written now so later counts do not see it arrive.
  await writeContent(f.t);
  return f.t.run(async (ctx) => {
    const artifact = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_fileId", (q) => q.eq("fileId", batch.fileIds[0]))
      .unique())!;
    const versions = await ctx.db
      .query("documentVersions")
      .withIndex("by_artifactId", (q) => q.eq("artifactId", artifact._id))
      .collect();
    return { artifact, codes: versions.map((version) => version.code) };
  });
}
/** The corpus note, homologação, issued by a CNPJ other than the fixture company's. */
const otherIssuer = (tpAmb: "1" | "2") =>
  xmlFixture("invoice-authorized")
    .toString("utf8")
    .replaceAll("<tpAmb>2</tpAmb>", `<tpAmb>${tpAmb}</tpAmb>`)
    .replace("<emit><CNPJ>11222333000181</CNPJ>", "<emit><CNPJ>12345678000195</CNPJ>");

it("uma NF-e recusada com tpAmb 1 marca o original, que conta como Produção e fica até o prazo", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const { artifact, codes } = await importRefused(f, otherIssuer("1"));
  expect(codes).toEqual(["COMPANY_MISMATCH"]);
  expect([artifact.documentId, artifact.tpAmb]).toEqual([undefined, "1"]);
  const kept = await counts(f, conserved);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(false);
  expect(await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id })).toEqual({
    done: true,
    removed: 0,
  });
  expect(await counts(f, conserved)).toEqual(kept);
  expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifact._id))).not.toBeNull();
});

it("um XML recusado antes da nota normalizada guarda a marca dos bytes, e sem ela conta como Produção", async () => {
  const nfce = await (async () => {
    const f = await fixture(),
      owner = await actor(f);
    await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
    // An NFC-e is refused by the parser, with no document: only its bytes say Produção.
    const { artifact, codes } = await importRefused(
      f,
      otherIssuer("1").replace("<mod>55</mod>", "<mod>65</mod>"),
    );
    return { artifact, codes, closure: await closeAndPurge(f, owner) };
  })();
  expect([nfce.codes, nfce.artifact.tpAmb]).toEqual([["XML_MODEL_UNSUPPORTED"], "1"]);
  expect(nfce.closure.sandboxOnly).toBe(false);
  // A file the parser could not read is not known to hold no note.
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
  const malformed = await importRefused(f, "<NFe><infNFe>");
  expect([malformed.codes, malformed.artifact.tpAmb]).toEqual([["XML_MALFORMED"], undefined]);
  expect((await closeAndPurge(f, owner)).sandboxOnly).toBe(false);
});

it("uma NF-e recusada de homologação não segura a remoção antecipada, e um arquivo que não é nota também não", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
  const test = await importRefused(f, otherIssuer("2"));
  expect([test.codes, test.artifact.tpAmb]).toEqual([["COMPANY_MISMATCH"], "2"]);
  const junk = await importRefused(f, '<?xml version="1.0"?><nota>sintética</nota>');
  expect([junk.codes, junk.artifact.tpAmb]).toEqual([["XML_NAMESPACE_UNSUPPORTED"], undefined]);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  await at(f, Date.now() + 1);
  for (const { artifact } of [test, junk])
    expect(await f.t.run((ctx) => ctx.db.get("documentArtifacts", artifact._id))).toBeNull();
});

it("os limites da leitura dos originais recusados contam como Produção, e o original sem versão também", async () => {
  /** `artifacts` unmarked originals without a document, each with `versions` refusals of a non-NF-e root. */
  const decide = async (artifacts: number, versions: number) => {
    const f = await fixture(),
      owner = await actor(f);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" });
      const original = (await ctx.db.query("documentArtifacts").first())!;
      const { _id, _creationTime, documentId: _document, ...artifact } = original;
      const {
        _id: _versionId,
        _creationTime: _versionTime,
        documentId: _versionDocument,
        ...version
      } = (await ctx.db.query("documentVersions").first())!;
      for (let i = 0; i < artifacts; i++) {
        const artifactId = await ctx.db.insert("documentArtifacts", artifact);
        for (let n = 0; n < versions; n++)
          await ctx.db.insert("documentVersions", {
            ...version,
            artifactId,
            code: "XML_NAMESPACE_UNSUPPORTED",
            kind: "unknown",
          });
      }
    });
    return (await closeAndPurge(f, owner)).sandboxOnly;
  };
  expect(await decide(1, 10)).toBe(true);
  expect(await decide(1, 11)).toBe(false);
  expect(await decide(1, 0)).toBe(false);
  expect(await decide(100, 1)).toBe(true);
  expect(await decide(101, 1)).toBe(false);
});

it("um original recusado sem a marca, de antes dela, para uma decisão de só Sandbox já gravada", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await f.t.run((ctx) => ctx.db.patch("fiscalDocuments", f.documentId, { tpAmb: "2" }));
  const organizationId = f.scope.organizationId;
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "recusada-sem-marca",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const { artifact } = await importRefused(f, otherIssuer("2"));
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  // The refused original as it was before the mark: a note, but not known to be a test one.
  await f.t.run((ctx) => ctx.db.patch("documentArtifacts", artifact._id, { tpAmb: undefined }));
  await f.t.mutation(internal.fiscalGuard.release, {
    organizationId,
    reference: "recusada-sem-marca",
  });
  const kept = await counts(f, conserved);
  const warn = vi.spyOn(console, "warn");
  const current = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: current._id,
    generation: current.generation,
  });
  const stopped = warn.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("organization.sandbox-purge-stopped"));
  warn.mockRestore();
  expect(stopped.map((line) => JSON.parse(line).reason)).toEqual(["fiscal-document"]);
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
});

it("uma retenção legal ativa segura a remoção antecipada, que vem na verificação depois da liberação", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await seedGuarded(f, "sandbox");
  const organizationId = f.scope.organizationId;
  const reference = "fiscalizacao-sandbox";
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference,
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const kept = await counts(f, conserved);
  const before = await snapshot(f);
  let closure = await closeAndPurge(f, owner);
  expect(await counts(f, conserved)).toEqual(kept);
  await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id });
  expect(await counts(f, conserved)).toEqual(kept);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference });
  closure = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  expect(survivors(before, await snapshot(f))).toEqual(own(before));
  expect((await closureOf(f))!.expiredAt).toBeUndefined();
});

it("a remoção antecipada chamada direto não apaga uma organização ainda em encerramento", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const kept = await counts(f, conserved);
  await owner.client.mutation(api.organizationClosure.close, {
    organizationId: f.scope.organizationId,
    confirmation: await slug(f),
  });
  const closure = (await closureOf(f))!;
  expect(await f.t.mutation(internal.fiscalGuard.early, { closureId: closure._id })).toEqual({
    done: true,
    removed: 0,
  });
  expect(await counts(f, conserved)).toEqual(kept);
});

it("um encerramento expurgado antes da decisão de 27/10/2026 perde os dados na verificação seguinte, em lotes", async () => {
  const f = await fixture(),
    owner = await actor(f);
  await twin(f);
  const closure = await closeAndPurge(f, owner);
  const kept = await snapshot(f);
  const untouched = await rest(f, {});
  // As the previous version left it: everything waiting for the guard, more than one batch.
  await seedGuarded(f, "sandbox");
  await f.t.run(async (ctx) => {
    for (let i = 0; i < 250; i++)
      await ctx.db.insert("usageEvents", {
        organizationId: f.scope.organizationId,
        environment: "sandbox",
        metric: "imports",
        key: `legacy-${i}`,
        period: "2026-10",
        quantity: 1,
        state: "committed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
  });
  const seeded = await snapshot(f);
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  expect((await closureOf(f))!.expired).toBe((closure.expired ?? 0) + 200);
  expect((await closureOf(f))!.removed).toBe(closure.removed);
  await settleNow(f);
  // Every seeded row went; the rows that were there before, of the other organization, stay.
  const added = Object.fromEntries(
    Object.entries(seeded).map(([table, ids]) => [
      table,
      ids.filter((id) => !kept[table].includes(id)),
    ]),
  );
  expect(survivors(added, await snapshot(f))).toEqual(own(added));
  expect(await rest(f, added)).toEqual(untouched);
  const current = (await closureOf(f))!;
  expect(current.expiredAt).toBeUndefined();
  const job = await f.t.run((ctx) =>
    ctx.db.system.get("_scheduled_functions", current.scheduledId!),
  );
  expect(job?.name).toContain("expire");
  expect(job?.scheduledTime).toBe(Date.now() + 7 * DAY);
});

it("um erro na remoção antecipada desfaz o lote, avisa e mantém a agenda da guarda", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const other = await twin(f);
  // A corrupted link: an artifact of the other organization under this organization's document.
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...rest } = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    await ctx.db.insert("documentArtifacts", {
      ...rest,
      organizationId: other.organizationId,
      fileId: undefined,
      storageId: await ctx.storage.store(new Blob(["other"])),
    });
  });
  const kept = await counts(f, conserved);
  const warn = vi.spyOn(console, "warn");
  const closure = await closeAndPurge(f, owner);
  const failed = warn.mock.calls.filter(([line]) =>
    String(line).includes("organization.sandbox-purge-failed"),
  );
  warn.mockRestore();
  expect(failed.length).toBeGreaterThan(0);
  expect(await counts(f, conserved)).toEqual(kept);
  const job = await f.t.run((ctx) =>
    ctx.db.system.get("_scheduled_functions", closure.scheduledId!),
  );
  expect(job?.name).toContain("expire");
  expect(job?.state.kind).toBe("pending");
});

it("um arquivo também guardado por outra organização fica; os da própria organização saem", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const other = await twin(f);
  const { shared, alone, foreign } = await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...rest } = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const shared = await ctx.storage.store(new Blob(["shared"]));
    const alone = await ctx.storage.store(new Blob(["own"]));
    // More holders in this organization than one read covers, for both files.
    for (let i = 0; i < 25; i++)
      for (const storageId of [shared, alone])
        await ctx.db.insert("documentArtifacts", { ...rest, fileId: undefined, storageId });
    const foreign = await ctx.db.insert("documentArtifacts", {
      ...rest,
      organizationId: other.organizationId,
      documentId: undefined,
      fileId: undefined,
      storageId: shared,
    });
    return { shared, alone, foreign };
  });
  await closeAndPurge(f, owner);
  await f.t.run(async (ctx) => {
    const holders = (await ctx.db.query("documentArtifacts").collect()).filter(
      (row) => row.organizationId === f.scope.organizationId,
    );
    expect(holders).toEqual([]);
    expect(await ctx.db.get("documentArtifacts", foreign)).not.toBeNull();
    expect(await ctx.db.system.get("_storage", shared)).not.toBeNull();
    expect(await ctx.db.system.get("_storage", alone)).toBeNull();
  });
});

it("um encerramento sem decisão gravada decide na verificação seguinte, e arquivo frio conta como Produção", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  // Held, so the purge leaves the data in place, as a closure purged before 27/10/2026 did.
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "anterior",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  await closeAndPurge(f, owner);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "anterior" });
  const kept = await counts(f, conserved);
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db.query("organizationClosures").first())!;
    await ctx.db.patch("organizationClosures", closure._id, { sandboxOnly: undefined });
    await ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: `archive-${organizationId}`,
      version: 1,
      state: "archived",
      reason: "closed",
      noticeAt: Date.now(),
      eligibleAt: Date.now(),
      retainUntil: Date.now() + 365 * DAY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "synthetic",
    });
  });
  const closure = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
  // Decided once: removing the archive run later changes nothing.
  await f.t.run(async (ctx) => {
    for (const run of await ctx.db.query("coldArchiveRuns").collect())
      await ctx.db.delete("coldArchiveRuns", run._id);
  });
  const again = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: again._id,
    generation: again.generation,
  });
  expect(await counts(f, conserved)).toEqual(kept);
});

it("um arquivo cujo outro dono não pode ser lido desfaz o lote e não apaga a linha", async () => {
  const f = await fixture(),
    owner = await actor(f);
  // An import file of a vanished import holds the same original as this organization's artifact.
  await f.t.run(async (ctx) => {
    const { _id, _creationTime, ...file } = (await ctx.db.query("importFiles").first())!;
    const {
      _id: _importId,
      _creationTime: _created,
      ...source
    } = (await ctx.db.query("imports").first())!;
    const gone = await ctx.db.insert("imports", source);
    await ctx.db.delete("imports", gone);
    await ctx.db.insert("importFiles", { ...file, importId: gone });
  });
  const kept = await counts(f, conserved);
  const storageId = await f.t.run(
    async (ctx) => (await ctx.db.query("importFiles").first())!.storageId!,
  );
  const warn = vi.spyOn(console, "warn");
  const closure = await closeAndPurge(f, owner);
  const logged = (text: string) =>
    warn.mock.calls.filter(([line]) => String(line).includes(text)).length;
  expect(closure.sandboxOnly).toBe(true);
  expect(logged("Unreadable file holder")).toBeGreaterThan(0);
  expect(await counts(f, conserved)).toEqual(kept);

  // At the deadline the guard does not stop: the rows go, the file stays and is logged.
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  const current = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: current._id,
    generation: current.generation,
  });
  await settleNow(f);
  const fileKept = logged("organization.file-kept");
  warn.mockRestore();
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  expect(fileKept).toBeGreaterThan(0);
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get("fiscalDocuments", f.documentId)).toBeNull();
    expect(await ctx.db.system.get("_storage", storageId)).not.toBeNull();
  });
});

it("um arquivo frio iniciado depois da decisão para a remoção antecipada, uma vez", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  // Held through the purge, so the data is still there after the decision.
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "arquivo",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  const kept = await counts(f, conserved);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(true);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "arquivo" });
  await f.t.run((ctx) =>
    ctx.db.insert("coldArchiveRuns", {
      organizationId,
      key: `archive-${organizationId}`,
      version: 1,
      state: "notice",
      reason: "closed",
      noticeAt: Date.now(),
      eligibleAt: Date.now(),
      retainUntil: Date.now() + 365 * DAY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phase: 0,
      cursor: null,
      rows: 0,
      files: 0,
      bytes: 0,
      digest: "synthetic",
    }),
  );
  const warn = vi.spyOn(console, "warn");
  for (let i = 0; i < 2; i++) {
    const current = (await closureOf(f))!;
    await f.t.mutation(internal.fiscalGuard.expire, {
      closureId: current._id,
      generation: current.generation,
    });
  }
  const stopped = warn.mock.calls.filter(([line]) =>
    String(line).includes("organization.sandbox-purge-stopped"),
  ).length;
  warn.mockRestore();
  expect(stopped).toBe(1);
  expect((await closureOf(f))!.sandboxOnly).toBe(false);
  expect(await counts(f, conserved)).toEqual(kept);
});

it("um encerramento sem decisão gravada, só com Sandbox e sem arquivo frio, perde os dados na verificação seguinte", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const organizationId = f.scope.organizationId;
  await f.t.mutation(internal.fiscalGuard.hold, {
    organizationId,
    reference: "anterior",
    responsible: "operacao-sintetica",
    reviewAt: Date.now() + 400 * DAY,
  });
  await closeAndPurge(f, owner);
  await f.t.mutation(internal.fiscalGuard.release, { organizationId, reference: "anterior" });
  await f.t.run(async (ctx) => {
    const closure = (await ctx.db.query("organizationClosures").first())!;
    await ctx.db.patch("organizationClosures", closure._id, { sandboxOnly: undefined });
  });
  const before = await snapshot(f);
  const closure = (await closureOf(f))!;
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  const after = (await closureOf(f))!;
  expect(after.sandboxOnly).toBe(true);
  expect(after.expiredAt).toBeUndefined();
  expect(after.expired).toBeGreaterThan(0);
  expect(survivors(before, await snapshot(f))).toEqual(own(before));
});

it("um arquivo também guardado pela caixa de privacidade fica, como no arquivo frio", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const storageId = await f.t.run(async (ctx) => {
    const artifact = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    await ctx.db.insert("privacyIntakes", {
      key: "synthetic-intake",
      hash: "synthetic",
      from: "titular@development.invalid",
      to: "privacidade@development.invalid",
      raw: artifact.storageId!,
      state: "pending",
    });
    return artifact.storageId!;
  });
  await closeAndPurge(f, owner);
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get("fiscalDocuments", f.documentId)).toBeNull();
    expect(await ctx.db.system.get("_storage", storageId)).not.toBeNull();
  });
});

/**
 * Two versions holding a content blob (ADR 0010, phase B), tracked in the capacity inventory:
 * one on the fixture document, removed with it, and one without a document, which only the
 * operations path reaches, once the artifacts are gone.
 */
async function contentBlobs(f: Fixture) {
  return f.t.run(async (ctx) => {
    const { _id, _creationTime, ...template } = (await ctx.db
      .query("documentVersions")
      .withIndex("by_documentId", (q) => q.eq("documentId", f.documentId))
      .first())!;
    const ids: Id<"_storage">[] = [];
    for (const documentId of [f.documentId, undefined]) {
      const encoded = await encodeDocumentContent({ result: template.result!, items: [] });
      const contentStorageId = await ctx.storage.store(new Blob([Uint8Array.from(encoded.bytes)]));
      await ctx.db.insert("documentVersions", {
        ...template,
        documentId,
        contentStorageId,
        contentSha256: encoded.contentSha256,
        contentSize: encoded.contentSize,
        contentFormat: DOCUMENT_CONTENT_FORMAT,
      });
      await trackStoredFile(ctx, f.scope.organizationId, contentStorageId);
      ids.push(contentStorageId);
    }
    return ids;
  });
}
async function contentBlobsGone(f: Fixture, ids: Id<"_storage">[]) {
  await f.t.run(async (ctx) => {
    expect(await ctx.db.query("documentVersions").collect()).toEqual([]);
    for (const id of ids) {
      expect(await ctx.db.system.get("_storage", id)).toBeNull();
      expect(
        await ctx.db
          .query("capacityFiles")
          .withIndex("by_storageId", (q) => q.eq("storageId", id))
          .collect(),
      ).toEqual([]);
    }
  });
}

it("a remoção antecipada apaga o blob de conteúdo das versões e libera sua capacidade, pelos documentos e pelas operações", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const ids = await contentBlobs(f);
  await closeAndPurge(f, owner);
  expect((await closureOf(f))!.sandboxOnly).toBe(true);
  await contentBlobsGone(f, ids);
});

it("o expurgo no fim da guarda apaga o blob de conteúdo das versões e libera sua capacidade", async () => {
  const f = await fixture(),
    owner = await actor(f);
  const ids = await contentBlobs(f);
  await production(f);
  const closure = await closeAndPurge(f, owner);
  expect(closure.sandboxOnly).toBe(false);
  vi.setSystemTime(fiscalGuardUntil(closure.requestedAt));
  await f.t.mutation(internal.fiscalGuard.expire, {
    closureId: closure._id,
    generation: closure.generation,
  });
  await settleNow(f);
  expect((await closureOf(f))!.expiredAt).toBeDefined();
  await contentBlobsGone(f, ids);
});
