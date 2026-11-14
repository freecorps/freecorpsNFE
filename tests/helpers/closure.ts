import { expect, vi } from "vite-plus/test";
import { api, internal } from "../../platform/convex/_generated/api";
import type { Id, TableNames } from "../../platform/convex/_generated/dataModel";
import { hashApiKey } from "../../platform/convex/lib/apiKeyCrypto";
import { insertTerm } from "../../platform/convex/lib/planTerms";
import { fixture as importedNote, actor } from "./export-fixture";
import { keepInline } from "./document-footprint";
import { retentionClass } from "../../platform/convex/lib/retentionClasses";

/**
 * Fixtures of the organization closure suites: an organization with its data, the scheduled
 * purge run to the end, and the snapshots that compare what each purge kept.
 */
export const DAY = 86_400_000;
/**
 * The imported note with its content blob already written (ADR 0010, B4), so the counts taken
 * before a closure include it rather than see it arrive with the scheduled work.
 */
export async function fixture() {
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
export type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Runs the jobs that are due now, including the continuations they schedule. */
export async function settle(f: Fixture) {
  for (let i = 0; i < 40; i++) {
    vi.advanceTimersByTime(1);
    await f.t.finishInProgressScheduledFunctions();
  }
}
/**
 * Only the continuations scheduled for now. Fake timers clamp delays above 2^31 ms to 1 ms, so a
 * 1 ms step would also fire the 30-day deadlines.
 */
export async function settleNow(f: Fixture) {
  for (let i = 0; i < 20; i++) {
    vi.advanceTimersByTime(0);
    await f.t.finishInProgressScheduledFunctions();
  }
}
export async function at(f: Fixture, time: number) {
  vi.setSystemTime(time);
  await settle(f);
}
export function code(promise: Promise<unknown>) {
  return promise.then(
    () => "OK",
    (error: { data?: { code?: string } }) => error.data?.code ?? "ERROR",
  );
}
export async function slug(f: Fixture) {
  return (await f.t.run((ctx) => ctx.db.get("organizations", f.scope.organizationId)))!.slug;
}
export async function closureOf(f: Fixture) {
  return f.t.run((ctx) =>
    ctx.db
      .query("organizationClosures")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", f.scope.organizationId))
      .unique(),
  );
}
export const conserved = [
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
export async function counts(f: Fixture, tables: readonly TableNames[]) {
  return f.t.run(async (ctx) => {
    const result: Record<string, number> = {};
    for (const table of tables) result[table] = (await ctx.db.query(table).collect()).length;
    result._storage = (await ctx.db.system.query("_storage").collect()).length;
    return result;
  });
}
/** One row of each excluded class that the import fixture does not create by itself. */
export async function seed(f: Fixture, membershipId: Id<"memberships">) {
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

export const guarded = (Object.entries(retentionClass) as [TableNames, string][])
  .filter(([, c]) => c === "fiscal" || c === "commercial")
  .map(([table]) => table);

/**
 * One row of each guarded class that the import fixture does not create by itself, under an
 * operation of its own in `environment`.
 */
export async function seedGuarded(f: Fixture, environment: "sandbox" | "production") {
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

export type Twin = {
  organizationId: Id<"organizations">;
  ids: Set<string>;
  storageId: Id<"_storage">;
};
/**
 * The fixture's document tree with a file of its own, cloned into another organization or, with
 * `environment`, into the same organization in that environment.
 */
export async function twin(f: Fixture, environment?: "production"): Promise<Twin> {
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
/** Moves the fixture organization's guarded rows to Production, the environment the guard keeps. */
export async function production(f: Fixture) {
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
export async function snapshot(f: Fixture) {
  return f.t.run(async (ctx) => {
    const ids: Record<string, string[]> = {};
    for (const table of guarded)
      ids[table] = (await ctx.db.query(table).collect()).map((r) => r._id);
    ids._storage = (await ctx.db.system.query("_storage").collect()).map((file) => file._id);
    return ids;
  });
}
/** Tables where rows of `before` still exist in `after`. */
export function survivors(before: Record<string, string[]>, after: Record<string, string[]>) {
  return Object.entries(before)
    .filter(([table, ids]) => ids.some((id) => after[table]?.includes(id)))
    .map(([table]) => table)
    .sort();
}

export async function closeAndPurge(f: Fixture, owner: Awaited<ReturnType<typeof actor>>) {
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
export async function rest(f: Fixture, before: Record<string, string[]>) {
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
export const ownRecords = [
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
export const own = (ids: Record<string, string[]>) =>
  ownRecords.filter((table) => ids[table]?.length);
