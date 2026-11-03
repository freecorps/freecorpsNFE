import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { requireLocalProof, requireReadProof } from "./operationProof";
import { ARCHIVE_DAY, archiveHash } from "../lib/coldArchiveCore";

export const gate = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => {
    requireLocalProof();
    return process.env.FNFE_COLD_ARCHIVE ?? null;
  },
});
export const store = internalAction({
  args: { xml: v.string() },
  returns: v.id("_storage"),
  handler: async (ctx, args) => {
    requireReadProof();
    if (args.xml.length > 1024 * 1024) throw new Error("SYNTHETIC_FIXTURE_LIMIT");
    return ctx.storage.store(new Blob([args.xml], { type: "application/xml" }));
  },
});
/** Streaming upload for the local capacity drill; never available on a hosted deployment. */
export const capacityUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    requireLocalProof();
    return ctx.storage.generateUploadUrl();
  },
});
export const seed = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    companyId: v.id("companies"),
    storageIds: v.array(v.id("_storage")),
  },
  returns: v.object({ rows: v.number(), files: v.number() }),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    const project = await ctx.db.get("projects", args.projectId);
    const company = await ctx.db.get("companies", args.companyId);
    if (
      !org?.slug.startsWith("cold429-") ||
      project?.organizationId !== org._id ||
      company?.organizationId !== org._id ||
      args.storageIds.length !== 3
    )
      throw new Error("COLD_PROOF_SCOPE");
    const scope = {
      organizationId: org._id,
      projectId: project._id,
      companyId: company._id,
      environment: "sandbox" as const,
    };
    const now = Date.now(),
      old = now - 200 * ARCHIVE_DAY;
    const operationId = await ctx.db.insert("operations", {
      ...scope,
      task: {
        name: "synthetic.restore",
        workload: "import",
        scope: "documents:import",
        executor: "testing/operationProof",
      },
      request: "{}",
      requestHash: await archiveHash("synthetic"),
      projectEpoch: 0,
      grantEpoch: 0,
      state: "succeeded",
      stage: "checkpoint",
      generation: 1,
      fence: 1,
      attempts: 1,
      maxAttempts: 1,
      leaseUntil: 0,
      nextAttemptAt: 0,
      backoffMs: 1,
      jitterMs: 0,
      uncertain: false,
      createdAt: old,
      updatedAt: old,
    });
    const importId = await ctx.db.insert("imports", {
      ...scope,
      key: "cold429-synthetic",
      requestHash: await archiveHash("synthetic"),
      completedAt: old,
      createdAt: old,
    });
    let rows = 2;
    for (let i = 0; i < args.storageIds.length; i++) {
      const storageId = args.storageIds[i]!;
      const metadata = await ctx.db.system.get("_storage", storageId);
      if (!metadata) throw new Error("COLD_PROOF_FILE");
      const hash = [...Uint8Array.from(atob(metadata.sha256), (c) => c.charCodeAt(0))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      const fileId = await ctx.db.insert("importFiles", {
        importId,
        position: i,
        name: `synthetic-${i}.xml`,
        size: metadata.size,
        sha256: hash,
        state: "accepted",
        expiresAt: old,
        storageId,
        operationId,
        uploadedAt: old,
      });
      const documentId = await ctx.db.insert("fiscalDocuments", {
        organizationId: org._id,
        companyId: company._id,
        environment: "sandbox",
        model: i === 1 ? "nfse" : "55",
        fiscalKey: `synthetic-archive-${i}`,
        completeness: 1,
        createdAt: old,
      });
      const artifactId = await ctx.db.insert("documentArtifacts", {
        ...scope,
        documentId,
        fileId,
        storageId,
        sha256: hash,
        size: metadata.size,
        source: "imported-xml",
        importedAt: old,
      });
      const versionId = await ctx.db.insert("documentVersions", {
        artifactId,
        operationId,
        documentId,
        state: "complete",
        code: "SYNTHETIC",
        kind: "synthetic",
        completeness: 1,
        schema: null,
        parserVersion: "synthetic/1",
        normalizerVersion: null,
        processorVersion: "synthetic/1",
        result: JSON.stringify({ total: "123.45", note: "Prova sintética, sem validade fiscal" }),
        itemCount: 24,
        writtenItems: 24,
        createdAt: old,
      });
      for (let item = 0; item < 24; item++)
        await ctx.db.insert("documentItems", {
          versionId,
          position: item,
          data: JSON.stringify({ description: `Item sintético ${item}`, amount: "1.00" }),
        });
      await ctx.db.patch("fiscalDocuments", documentId, { publishedVersionId: versionId });
      rows += 28;
    }
    await ctx.db.patch("organizations", org._id, { updatedAt: old });
    await ctx.db.insert("usagePlans", {
      organizationId: org._id,
      catalogTier: "free",
      name: "Ensaio sintético",
      startsAt: old,
      endsAt: null,
      limits: { imports: null, captures: null, registry: null, bytes: null, deliveries: null },
      concurrency: 1,
      version: 1,
      updatedAt: old,
    });
    return { rows, files: args.storageIds.length };
  },
});
/** Only shortens the notice of this runner's synthetic organization, never production time. */
export const elapseNotice = internalMutation({
  args: { runId: v.id("coldArchiveRuns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const run = await ctx.db.get("coldArchiveRuns", args.runId);
    const org = run && (await ctx.db.get("organizations", run.organizationId));
    if (!run || run.state !== "notice" || !org?.slug.startsWith("cold429-"))
      throw new Error("COLD_PROOF_SCOPE");
    await ctx.db.patch("coldArchiveRuns", run._id, {
      noticeAt: Date.now() - 31 * ARCHIVE_DAY,
      eligibleAt: Date.now() - ARCHIVE_DAY,
    });
    return null;
  },
});
/** Used only in the separately owned disposable restore drill deployment. */
export const seedIncrementalControls = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ accountId: v.id("capacityAccounts"), exportId: v.id("documentExports") }),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    if (!org?.slug.startsWith("cold429-")) throw new Error("COLD_PROOF_SCOPE");
    const accountId = await ctx.db.insert("capacityAccounts", {
      organizationId: org._id,
      ready: true,
      phase: 27,
      cursor: null,
      reservedFiles: 18 * 1024 * 1024,
      reservedDatabase: 16 * 1024 * 1024,
      updatedAt: Date.now(),
    });
    const exportId = await ctx.db.insert("documentExports", {
      organizationId: org._id,
      environment: "sandbox",
      selection: { kind: "organization" },
      actor: "synthetic-drill",
      key: "synthetic-export",
      state: "succeeded",
      checkpoint: "",
      sequence: 0,
      bytes: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + ARCHIVE_DAY,
    });
    return { accountId, exportId };
  },
});
export const inspectIncrementalControls = internalQuery({
  args: { accountId: v.id("capacityAccounts"), exportId: v.id("documentExports") },
  returns: v.object({
    ready: v.boolean(),
    phase: v.number(),
    reservedFiles: v.number(),
    reservedDatabase: v.number(),
    state: v.string(),
    code: v.string(),
  }),
  handler: async (ctx, args) => {
    requireLocalProof();
    const account = await ctx.db.get("capacityAccounts", args.accountId),
      exp = await ctx.db.get("documentExports", args.exportId);
    const org = account && (await ctx.db.get("organizations", account.organizationId));
    if (
      !account ||
      !exp ||
      exp.organizationId !== account.organizationId ||
      !org?.slug.startsWith("cold429-")
    )
      throw new Error("COLD_PROOF_SCOPE");
    return {
      ready: account.ready,
      phase: account.phase,
      reservedFiles: account.reservedFiles ?? -1,
      reservedDatabase: account.reservedDatabase ?? -1,
      state: exp.state,
      code: exp.code ?? "",
    };
  },
});
