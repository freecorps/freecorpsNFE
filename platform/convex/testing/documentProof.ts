import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireLocalProof } from "./operationProof";
import { createCompany } from "../lib/companyAccess";
import { normalizeCnpj } from "@freecorps/contracts";

/** Bounded, synthetic selector dataset; never available in a remote deployment. */
export const selectorPages = internalMutation({
  args: { companyId: v.id("companies"), projectId: v.id("projects") },
  returns: v.object({ companyId: v.id("companies"), projectId: v.id("projects") }),
  handler: async (ctx, args) => {
    requireLocalProof();
    const source = await ctx.db.get("companies", args.companyId);
    const project = await ctx.db.get("projects", args.projectId);
    if (!source || !project || source.organizationId !== project.organizationId)
      throw new Error("Synthetic selector scope absent");
    let companyId = args.companyId;
    for (let i = 0; i < 21; i++) {
      const base = `72727272${String(i).padStart(4, "0")}`;
      const cnpj = Array.from({ length: 100 }, (_, digit) =>
        normalizeCnpj(base + String(digit).padStart(2, "0")),
      ).find((value) => value !== null)!;
      const created = await createCompany(
        ctx,
        source.organizationId,
        source.declaredBy,
        { cnpj, name: `Empresa paginada ${i + 1}`, address: source.address },
        "demonstration",
      );
      companyId = created.company._id;
    }
    let projectId = args.projectId;
    for (let i = 0; i < 21; i++) {
      projectId = await ctx.db.insert("projects", {
        organizationId: source.organizationId,
        name: `Projeto paginado ${i + 1}`,
        externalReference: crypto.randomUUID(),
        state: "active",
        version: 1,
        accessEpoch: 0,
        creatorMembershipId: project.creatorMembershipId,
        creatorEpoch: project.creatorEpoch,
        createdAt: Date.now(),
      });
      await ctx.db.insert("projectCompanies", {
        organizationId: source.organizationId,
        projectId,
        companyId,
        scopes: ["documents:read", "documents:import"],
        environments: ["sandbox"],
        active: true,
        version: 1,
        accessEpoch: 0,
      });
    }
    return { companyId, projectId };
  },
});

export const projection = internalQuery({
  args: { documentId: v.id("fiscalDocuments") },
  returns: v.object({ generation: v.number(), state: v.string() }),
  handler: async (ctx, args) => {
    requireLocalProof();
    const doc = await ctx.db.get("fiscalDocuments", args.documentId);
    if (!doc) throw new Error("Synthetic document absent");
    return { generation: doc.projectionGeneration ?? 0, state: doc.projectionState ?? "pending" };
  },
});

export const ready = internalQuery({
  args: {},
  returns: v.literal("documents/1"),
  handler: async (ctx) => {
    requireLocalProof();
    await ctx.db
      .query("documentListings")
      .withIndex("by_companyId_environment_filterKey_date")
      .take(1);
    await ctx.db.query("documentFiscalEvidence").withIndex("by_variant").take(1);
    await ctx.db.query("documentVersions").withIndex("by_documentId_kind_publishedAt").take(1);
    await ctx.db
      .query("documentArtifacts")
      .withIndex("by_companyId_environment_documentId_importedAt")
      .take(1);
    await ctx.db.query("documentDownloads").withIndex("by_tokenHash").take(1);
    return "documents/1" as const;
  },
});
