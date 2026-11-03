import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction } from "../_generated/server";
import { requireLocalProof } from "./operationProof";
import { readBatch } from "../exportSource";

// Local synthetic data only. The runner imports one real fixture first, then
// expands its persisted projections to measure export independently of import.
export const expand = internalMutation({
  args: { documentId: v.id("fiscalDocuments"), offset: v.number() },
  returns: v.null(),
  handler: async (ctx, { documentId, offset }) => {
    requireLocalProof();
    const doc = (await ctx.db.get("fiscalDocuments", documentId))!;
    const org = await ctx.db.get("organizations", doc.organizationId);
    if (
      !org?.slug.startsWith("export125-") ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 90
    )
      throw new Error("EXPORT_PROOF_SCOPE");
    const version = (await ctx.db.get("documentVersions", doc.publishedVersionId!))!;
    const artifact = (await ctx.db.get("documentArtifacts", version.artifactId))!;
    const item = (await ctx.db
      .query("documentItems")
      .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
      .first())!;
    const { _id: did, _creationTime: dt, ...df } = doc;
    const { _id: vid, _creationTime: vt, ...vf } = version;
    const { _id: aid, _creationTime: at, ...af } = artifact;
    void [did, dt, vid, vt, aid, at];
    for (let n = offset; n < offset + 10; n++) {
      const id =
        n === 0
          ? documentId
          : await ctx.db.insert("fiscalDocuments", {
              ...df,
              fiscalKey: String(n).padStart(44, "0"),
              publishedVersionId: undefined,
            });
      const originalId =
        n === 0
          ? artifact._id
          : await ctx.db.insert("documentArtifacts", {
              ...af,
              documentId: id,
              fileId: undefined,
            });
      for (let revision = 0; revision < 2; revision++) {
        const versionId =
          n === 0 && revision === 0
            ? version._id
            : await ctx.db.insert("documentVersions", {
                ...vf,
                documentId: id,
                artifactId: originalId,
              });
        for (let position = n === 0 && revision === 0 ? 1 : 0; position < 30; position++)
          await ctx.db.insert("documentItems", { versionId, position, data: item.data });
        await ctx.db.patch("documentVersions", versionId, { itemCount: 30, writtenItems: 30 });
        await ctx.db.patch("fiscalDocuments", id, { publishedVersionId: versionId });
      }
    }
    if (offset === 0)
      await ctx.db.insert("documentArtifacts", { ...af, documentId: undefined, fileId: undefined });
    return null;
  },
});

export const configure = internalMutation({
  args: { keyId: v.id("apiKeys"), cnpj: v.string() },
  returns: v.null(),
  handler: async (ctx, { keyId, cnpj }) => {
    requireLocalProof();
    const key = (await ctx.db.get("apiKeys", keyId))!;
    const org = await ctx.db.get("organizations", key.organizationId);
    if (!org?.slug.startsWith("export125-")) throw new Error("EXPORT_PROOF_SCOPE");
    const companyId = key.companyIds[0]!;
    await ctx.db.patch("companies", companyId, { cnpj });
    await ctx.db.patch("apiKeys", keyId, { scopes: ["documents:read", "documents:import"] });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", key.projectId).eq("companyId", companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: ["documents:read", "documents:import"],
    });
    return null;
  },
});

export const job = internalMutation({
  args: { organizationId: v.id("organizations"), batched: v.boolean() },
  returns: v.id("documentExports"),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    if (!org?.slug.startsWith("export125-")) throw new Error("EXPORT_PROOF_SCOPE");
    const member = (await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", org._id).eq("state", "active"),
      )
      .first())!;
    return ctx.db.insert("documentExports", {
      organizationId: org._id,
      environment: "sandbox",
      selection: { kind: "organization" },
      actor: `member:${member._id}`,
      membershipId: member._id,
      membershipVersion: member.version,
      key: "synthetic-measurement",
      state: "running",
      sequence: 0,
      bytes: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      checkpoint: JSON.stringify({
        phase: "documents",
        cursor: null,
        ...(args.batched ? { pagination: "keyset-v1" } : {}),
      }),
    });
  },
});

export const inspect = internalQuery({
  args: { exportId: v.id("documentExports") },
  returns: v.string(),
  handler: async (ctx, { exportId }) => {
    requireLocalProof();
    const job = await ctx.db.get("documentExports", exportId);
    const parts = await ctx.db
      .query("exportParts")
      .withIndex("by_exportId_and_sequence", (q) => q.eq("exportId", exportId))
      .take(100);
    return JSON.stringify({ job, parts });
  },
});

export const measuredRead = internalQuery({
  args: { exportId: v.id("documentExports"), sequence: v.number(), checkpoint: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const page = await readBatch(ctx, args);
    return JSON.stringify({ page, metrics: await ctx.meta.getTransactionMetrics() });
  },
});

export const part = internalAction({
  args: { storageId: v.id("_storage") },
  returns: v.bytes(),
  handler: async (ctx, { storageId }) => {
    requireLocalProof();
    return (await ctx.storage.get(storageId))!.arrayBuffer();
  },
});
