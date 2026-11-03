import { v, convexToJson, type Value } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import type { Id, TableNames } from "../_generated/dataModel";
import schema from "../schema";
import { requireLocalProof } from "./operationProof";
import { armRetention } from "../lib/operationalRetention";
import { arm as armAccess } from "../accessRecords";
import { startClosure } from "../organizationClosure";

/** D05 proof. Only synthetic organizations created by `prove-closure-restore` can be changed. */
const PREFIX = "closure05-";
const scope = {
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
  projectId: v.id("projects"),
  keyId: v.id("apiKeys"),
};
async function proofOrganization(ctx: QueryCtx, organizationId: Id<"organizations">) {
  requireLocalProof();
  const org = await ctx.db.get("organizations", organizationId);
  if (!org?.slug.startsWith(PREFIX)) throw new Error("CLOSURE_PROOF_SCOPE");
  return org;
}

export const configure = internalMutation({
  args: { ...scope, cnpj: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await proofOrganization(ctx, args.organizationId);
    const company = await ctx.db.get("companies", args.companyId);
    const key = await ctx.db.get("apiKeys", args.keyId);
    if (company?.organizationId !== org._id || key?.organizationId !== org._id)
      throw new Error("CLOSURE_PROOF_SCOPE");
    const scopes = ["documents:read", "documents:import"] as const;
    await ctx.db.patch("companies", company._id, { cnpj: args.cnpj });
    await ctx.db.patch("apiKeys", key._id, {
      scopes: [...scopes],
      expiresAt: Date.now() + 86_400_000,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", args.projectId).eq("companyId", args.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, { scopes: [...scopes] });
    return null;
  },
});

/**
 * Rows of the classes the purge removes that the REST import does not create, plus retention rows
 * that are current and rows whose deadline `shortUntil` passes while the snapshot is restored.
 */
export const seed = internalMutation({
  args: { ...scope, shortUntil: v.number(), excluded: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await proofOrganization(ctx, args.organizationId);
    const now = Date.now();
    const member = (await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) => q.eq("organizationId", org._id))
      .first())!;
    for (const [action, expiresAt] of [
      ["proof.expired", args.shortUntil],
      ["proof.current", now + 365 * 86_400_000],
    ] as const)
      await ctx.db.insert("operationalAudit", {
        organizationId: org._id,
        actor: "system",
        action,
        target: org._id,
        createdAt: now,
        expiresAt,
      });
    const old = new Date(now - 40 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    for (const day of [old, old, old, today])
      await ctx.db.insert("apiUsageEvents", {
        organizationId: org._id,
        projectId: args.projectId,
        keyId: args.keyId,
        requestId: crypto.randomUUID(),
        route: "companies.list",
        environment: "sandbox",
        day,
        shard: 0,
        createdAt: Date.parse(`${day}T12:00:00Z`),
      });
    await armRetention(ctx, org._id, args.shortUntil);
    for (const [ip, expiresAt] of [
      ["198.51.100.10", args.shortUntil],
      ["198.51.100.11", now + 184 * 86_400_000],
    ] as const) {
      await ctx.db.insert("accessRecords", {
        actor: `key:${args.keyId}`,
        ip,
        hour: Math.floor(now / 3_600_000) * 3_600_000,
        at: now,
        expiresAt,
      });
      await armAccess(ctx, expiresAt);
    }
    if (!args.excluded) return null;
    await ctx.db.insert("invitations", {
      organizationId: org._id,
      email: `${org.slug}@development.invalid`,
      role: "viewer",
      tokenHash: crypto.randomUUID(),
      status: "pending",
      expiresAt: now + 86_400_000,
      issuerMembershipId: member._id,
      issuerVersion: member.version,
      createdAt: now,
      updatedAt: now,
    });
    const certificateId = await ctx.db.insert("certificates", {
      organizationId: org._id,
      companyId: args.companyId,
      version: 1,
      state: "active",
      uploaderId: "synthetic-closure05",
      membershipId: member._id,
      membershipVersion: member.version,
      envelopeRevision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("certificateHeads", {
      organizationId: org._id,
      companyId: args.companyId,
      nextVersion: 2,
      latestId: certificateId,
      activeId: certificateId,
    });
    await ctx.db.insert("certificateAudit", {
      organizationId: org._id,
      companyId: args.companyId,
      certificateId,
      version: 1,
      actor: "synthetic-closure05",
      action: "proof.sealed",
      result: "OK",
      createdAt: now,
    });
    const endpointId = await ctx.db.insert("webhookEndpoints", {
      organizationId: org._id,
      projectId: args.projectId,
      companyId: args.companyId,
      environment: "sandbox",
      name: "Ensaio de expurgo",
      url: "https://example.invalid/closure05",
      events: ["document.received"],
      active: false,
      version: 1,
      secretVersion: 1,
      secret: crypto.randomUUID(),
      projectEpoch: 0,
      grantEpoch: 0,
      createdAt: now,
      updatedAt: now,
    });
    const eventId = await ctx.db.insert("outboxEvents", {
      organizationId: org._id,
      companyId: args.companyId,
      environment: "sandbox",
      projectId: args.projectId,
      logicalKey: `${org.slug}:event`,
      eventId: crypto.randomUUID(),
      type: "webhook.test",
      resourceType: "endpoint",
      resourceId: endpointId,
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
    // A Production copy of the first imported document, with its own original. An organization
    // that never had Production loses its fiscal data right after the purge (decision of
    // 27/10/2026); this one had, so the guard keeps all of it and the proof checks conservation.
    const production = { environment: "production" as const };
    const document = (await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_and_environment", (q) =>
        q.eq("organizationId", org._id).eq("environment", "sandbox"),
      )
      .first())!;
    const source = (await ctx.db
      .query("documentArtifacts")
      .withIndex("by_documentId", (q) => q.eq("documentId", document._id))
      .first())!;
    const operation = (await ctx.db
      .query("operations")
      .withIndex("by_organizationId_and_environment", (q) =>
        q.eq("organizationId", org._id).eq("environment", "sandbox"),
      )
      .first())!;
    const strip = <T extends { _id: unknown; _creationTime: number }>({
      _id,
      _creationTime,
      ...rest
    }: T) => rest;
    const operationId = await ctx.db.insert("operations", { ...strip(operation), ...production });
    const documentId = await ctx.db.insert("fiscalDocuments", {
      ...strip(document),
      ...production,
      publishedVersionId: undefined,
    });
    await ctx.db.insert("documentArtifacts", {
      ...strip(source),
      ...production,
      documentId,
      fileId: undefined,
      parentArtifactId: undefined,
      processingOperationId: operationId,
      storageId: await ctx.storage.store(new Blob([`${org.slug}:production`])),
    });
    await ctx.db.insert("usageEvents", {
      organizationId: org._id,
      ...production,
      metric: "imports",
      key: `${org.slug}:production`,
      period: new Date(now).toISOString().slice(0, 7),
      quantity: 1,
      state: "committed",
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/** The decision made after the snapshot, with an elapsed window so the purge starts at once. */
export const closeNow = internalMutation({
  args: { organizationId: v.id("organizations"), requestedAt: v.number() },
  returns: v.id("organizationClosures"),
  handler: async (ctx, args) => {
    await proofOrganization(ctx, args.organizationId);
    return startClosure(ctx, { ...args, requestedBy: "proof:closure05" });
  },
});

const LIMIT = 2000;
/**
 * Every row that names one of the given organizations or descends from one, the row counts of all
 * tables and the stored files. Bounded for the disposable local deployment; the caller hashes and compares.
 */
export const inventory = internalQuery({
  args: { organizationIds: v.array(v.id("organizations")) },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const wanted = new Set<string>(args.organizationIds);
    const rows: Record<string, Value[]> = {};
    const totals: Record<string, number> = {};
    for (const table of Object.keys(schema.tables) as TableNames[]) {
      const all = await ctx.db.query(table).take(LIMIT);
      if (all.length >= LIMIT) throw new Error("CLOSURE_PROOF_DATASET_LIMIT");
      totals[table] = all.length;
      const mine = all.filter(
        (row) =>
          wanted.has(String(row._id)) ||
          ("organizationId" in row && wanted.has(String(row.organizationId))),
      );
      if (mine.length) rows[table] = mine as unknown as Value[];
    }
    // Child tables without `organizationId`, in parent order.
    const owned = (table: string) =>
      new Set((rows[table] ?? []).map((row) => String((row as { _id: string })._id)));
    for (const [table, parent, field] of [
      ["exportParts", "documentExports", "exportId"],
      ["exportTickets", "documentExports", "exportId"],
      ["webhookDeliveries", "webhookEndpoints", "endpointId"],
      ["webhookAttempts", "webhookDeliveries", "deliveryId"],
    ] as const) {
      const parents = owned(parent);
      const mine = (await ctx.db.query(table).take(LIMIT)).filter((row) =>
        parents.has(String((row as Record<string, unknown>)[field])),
      );
      if (mine.length) rows[table] = mine as unknown as Value[];
    }
    const storage = await ctx.db.system.query("_storage").take(LIMIT);
    if (storage.length >= LIMIT) throw new Error("CLOSURE_PROOF_DATASET_LIMIT");
    return JSON.stringify(
      convexToJson({
        rows,
        totals,
        storage: storage.map((file) => ({ id: file._id, sha256: file.sha256, size: file.size })),
      } as unknown as Value),
    );
  },
});
