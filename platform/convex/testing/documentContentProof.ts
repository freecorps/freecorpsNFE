import { v } from "convex/values";
import { decimal } from "@freecorps/fiscal-core";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { requireLocalProof, requireReadProof } from "./operationProof";
import { decodeDocumentContent, sha256 } from "../lib/documentContent";
import { internal } from "../_generated/api";

// Synthetic post-parser fixtures. Only publication and the real scheduler are under test.
export const seed = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    companyId: v.id("companies"),
    storageId: v.id("_storage"),
    model: v.union(v.literal("55"), v.literal("nfse")),
  },
  returns: v.object({ operationId: v.id("operations"), versionId: v.id("documentVersions") }),
  handler: async (ctx, args) => {
    requireReadProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    const project = await ctx.db.get("projects", args.projectId);
    const company = await ctx.db.get("companies", args.companyId);
    if (
      !org?.slug.startsWith("content642-") ||
      project?.organizationId !== org._id ||
      company?.organizationId !== org._id
    )
      throw new Error("SYNTHETIC_SCOPE");
    const now = Date.now();
    const issuer = {
      kind: "CNPJ",
      document: "00000000000191",
      name: "Empresa sintética",
      stateRegistration: null,
    };
    const common = {
      number: "1",
      issuedAt: "2026-10-01T12:00:00-03:00",
      issuer,
      recipient: null,
      total: "1.00",
    };
    const document =
      args.model === "55"
        ? {
            ...common,
            total: decimal("1.00"),
            kind: "invoice",
            key: "35260911222333000181550010000000691123456787",
            environment: "2",
            series: "1",
            operation: "Venda sintética",
            protocol: null,
            totals: [],
          }
        : {
            ...common,
            kind: "service-invoice",
            key: "nfse:3509502:00000000000191::1",
            municipality: "3509502",
            municipalRegistration: null,
            verificationCode: "SYNTHETIC",
            competence: "2026-10-01",
            serviceCode: "1.07",
            description: "Serviço sintético",
            values: [],
          };
    const scope = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      companyId: args.companyId,
      environment: "sandbox" as const,
    };
    const operationId = await ctx.db.insert("operations", {
      ...scope,
      task: {
        name: "synthetic.content",
        workload: "import",
        scope: "documents:import",
        executor: "testing/operationProof",
      },
      request: "{}",
      requestHash: "synthetic",
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
      createdAt: now,
      updatedAt: now,
    });
    const documentId = await ctx.db.insert("fiscalDocuments", {
      organizationId: args.organizationId,
      companyId: args.companyId,
      environment: "sandbox",
      model: args.model,
      fiscalKey: `synthetic-${operationId}`,
      completeness: 1,
      createdAt: now,
    });
    const metadata = (await ctx.db.system.get("_storage", args.storageId))!;
    const artifactId = await ctx.db.insert("documentArtifacts", {
      ...scope,
      documentId,
      storageId: args.storageId,
      sha256: metadata.sha256,
      size: metadata.size,
      source: "imported-xml",
      importedAt: now,
    });
    const versionId = await ctx.db.insert("documentVersions", {
      artifactId,
      operationId,
      documentId,
      state: "complete",
      code: "SYNTHETIC",
      kind: args.model === "55" ? "invoice" : "service-invoice",
      completeness: 1,
      schema: null,
      parserVersion: "synthetic/1",
      normalizerVersion: null,
      processorVersion: "synthetic/1",
      result: JSON.stringify({ document }),
      itemCount: 0,
      writtenItems: 0,
      createdAt: now,
    });
    return { operationId, versionId };
  },
});

export const append = internalMutation({
  args: { versionId: v.id("documentVersions"), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, { versionId, bytes }) => {
    requireLocalProof();
    const version = (await ctx.db.get("documentVersions", versionId))!;
    if (
      version.processorVersion !== "synthetic/1" ||
      version.publishedAt !== undefined ||
      version.itemCount >= 32 ||
      !Number.isInteger(bytes) ||
      bytes < 2 ||
      bytes > 512 * 1024
    )
      throw new Error("SYNTHETIC_FIXTURE_LIMIT");
    await ctx.db.insert("documentItems", {
      versionId,
      position: version.itemCount,
      data: JSON.stringify("x".repeat(bytes - 2)),
    });
    await ctx.db.patch("documentVersions", versionId, {
      itemCount: version.itemCount + 1,
      writtenItems: version.itemCount + 1,
    });
    return null;
  },
});

export const inspect = internalQuery({
  args: { versionId: v.id("documentVersions") },
  returns: v.string(),
  handler: async (ctx, { versionId }) => {
    requireLocalProof();
    const version = (await ctx.db.get("documentVersions", versionId))!;
    const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
    const items = await ctx.db
      .query("documentItems")
      .withIndex("by_versionId_and_position", (q) => q.eq("versionId", versionId))
      .take(32);
    const files = await ctx.db.system.query("_storage").take(512);
    if (files.length === 512) throw new Error("PROOF_STORAGE_COUNT_LIMIT");
    return JSON.stringify({
      version,
      original: await ctx.storage.getUrl(artifact.storageId!),
      itemBytes: items.reduce((sum, item) => sum + item.data.length, 0),
      itemCount: items.length,
      inlineSha256: await sha256(
        new TextEncoder().encode(
          JSON.stringify({ result: version.result, items: items.map((item) => item.data) }),
        ),
      ),
      storageCount: files.length,
    });
  },
});

export const verify = internalAction({
  args: { versionId: v.id("documentVersions") },
  returns: v.string(),
  handler: async (ctx, { versionId }): Promise<string> => {
    requireLocalProof();
    const { version } = JSON.parse(
      await ctx.runQuery(internal.testing.documentContentProof.inspect, { versionId }),
    );
    if (!version.contentStorageId) throw new Error("BLOB_MISSING");
    const blob = await ctx.storage.get(version.contentStorageId);
    if (!blob) throw new Error("BLOB_MISSING");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const decoded = await decodeDocumentContent(bytes, {
      format: version.contentFormat,
      contentSha256: version.contentSha256,
      contentSize: version.contentSize,
    });
    if (
      decoded.result !== version.result ||
      decoded.items.length !== version.itemCount ||
      decoded.items.some((item) => !/^"x*"$/.test(item))
    )
      throw new Error("CONTENT_MISMATCH");
    return JSON.stringify({
      contentSha256: version.contentSha256,
      contentSize: version.contentSize,
      storedSize: bytes.length,
      storedSha256: await sha256(bytes),
      items: decoded.items.length,
    });
  },
});
