import { v, convexToJson, type Value } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireLocalProof } from "./operationProof";
import { envelope, certificateMeta } from "../lib/certificateValues";
import schema from "../schema";
import { components } from "../_generated/api";
import type { TableNames } from "../_generated/dataModel";

const scope = {
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
  projectId: v.id("projects"),
  keyId: v.id("apiKeys"),
};
export const assertEmpty = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    requireLocalProof();
    for (const table of Object.keys(schema.tables) as TableNames[]) {
      if (await ctx.db.query(table).first()) throw new Error("RESTORE_TARGET_NOT_EMPTY");
    }
    if (await ctx.db.system.query("_storage").first()) throw new Error("RESTORE_TARGET_NOT_EMPTY");
    for (const model of [
      "user",
      "session",
      "account",
      "verification",
      "twoFactor",
      "oauthApplication",
      "oauthAccessToken",
      "oauthConsent",
      "jwks",
      "rateLimit",
    ] as const) {
      const page = await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model,
        paginationOpts: { numItems: 1, cursor: null },
      });
      if (page.page.length) throw new Error("RESTORE_TARGET_NOT_EMPTY");
    }
    return null;
  },
});
export const postSnapshotWrite = internalMutation({
  args: { organizationId: v.id("organizations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    if (!org?.slug.startsWith("restore81-")) throw new Error("RESTORE_PROOF_SCOPE");
    const now = Date.now();
    await ctx.db.patch("organizations", org._id, {
      name: "Ensaio de restauração, escrita após o snapshot",
      updatedAt: now,
    });
    return now;
  },
});
/** Only synthetic records created by the restore proof runner can be changed here. */
export const configure = internalMutation({
  args: { ...scope, cnpj: v.string(), authUserId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    const company = await ctx.db.get("companies", args.companyId);
    const key = await ctx.db.get("apiKeys", args.keyId);
    if (
      !org?.slug.startsWith("restore81-") ||
      company?.organizationId !== org._id ||
      key?.organizationId !== org._id ||
      key.projectId !== args.projectId
    )
      throw new Error("RESTORE_PROOF_SCOPE");
    await ctx.db.patch("organizations", org._id, { name: "Ensaio sintético de recuperação" });
    await ctx.db.patch("companies", company._id, { cnpj: args.cnpj });
    await ctx.db.patch("apiKeys", key._id, {
      scopes: ["documents:read", "documents:import"],
      expiresAt: Date.now() + 7 * 86_400_000,
    });
    const grant = (await ctx.db
      .query("projectCompanies")
      .withIndex("by_projectId_and_companyId", (q) =>
        q.eq("projectId", args.projectId).eq("companyId", args.companyId),
      )
      .unique())!;
    await ctx.db.patch("projectCompanies", grant._id, {
      scopes: ["documents:read", "documents:import"],
    });
    if (args.authUserId)
      await ctx.db.patch("memberships", key.creatorMembershipId, {
        authUserId: args.authUserId,
        name: "Operador sintético de restauração",
        email: "restore81@development.invalid",
      });
    return null;
  },
});
export const reserveCertificates = internalMutation({
  args: scope,
  returns: v.array(v.id("certificates")),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    const key = await ctx.db.get("apiKeys", args.keyId);
    if (!org?.slug.startsWith("restore81-") || key?.organizationId !== org._id)
      throw new Error("RESTORE_PROOF_SCOPE");
    const ids = [];
    for (const version of [1, 2])
      ids.push(
        await ctx.db.insert("certificates", {
          organizationId: org._id,
          companyId: args.companyId,
          version,
          state: version === 1 ? "replaced" : "active",
          uploaderId: "synthetic-restore81",
          membershipId: key.creatorMembershipId,
          membershipVersion: 1,
          envelopeRevision: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    await ctx.db.insert("certificateHeads", {
      organizationId: org._id,
      companyId: args.companyId,
      nextVersion: 3,
      latestId: ids[1],
      activeId: ids[1],
    });
    return ids;
  },
});
export const seal = internalMutation({
  args: { certificateId: v.id("certificates"), envelope, metadata: certificateMeta },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const cert = await ctx.db.get("certificates", args.certificateId);
    if (!cert || cert.uploaderId !== "synthetic-restore81") throw new Error("RESTORE_PROOF_SCOPE");
    await ctx.db.patch("certificates", cert._id, {
      envelope: args.envelope,
      metadata: args.metadata,
      envelopeRevision: cert.envelopeRevision + 1,
    });
    await ctx.db.insert("certificateAudit", {
      organizationId: cert.organizationId,
      companyId: cert.companyId,
      certificateId: cert._id,
      version: cert.version,
      actor: "synthetic-restore81",
      action: "restore-proof.sealed",
      result: "OK",
      keyVersion: args.envelope.keyVersion,
      createdAt: Date.now(),
    });
    return null;
  },
});
export const inspect = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const org = await ctx.db.get("organizations", args.organizationId);
    if (!org?.slug.startsWith("restore81-")) throw new Error("RESTORE_PROOF_SCOPE");
    const companies = await ctx.db
      .query("companies")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", org._id))
      .take(10);
    const documents = await ctx.db
      .query("fiscalDocuments")
      .withIndex("by_organizationId_companyId_environment_model_fiscalKey", (q) =>
        q.eq("organizationId", org._id),
      )
      .take(10);
    if (companies.length >= 10 || documents.length >= 10)
      throw new Error("RESTORE_PROOF_DATASET_LIMIT");
    const records: Record<string, Value>[] = [];
    for (const document of documents) {
      const versions = await ctx.db
        .query("documentVersions")
        .withIndex("by_documentId", (q) => q.eq("documentId", document._id))
        .take(100);
      const artifacts = await ctx.db
        .query("documentArtifacts")
        .withIndex("by_documentId", (q) => q.eq("documentId", document._id))
        .take(100);
      const evidence = await ctx.db
        .query("documentFiscalEvidence")
        .withIndex("by_documentId_ruleVersion", (q) => q.eq("documentId", document._id))
        .take(100);
      if ([versions, artifacts, evidence].some((rows) => rows.length >= 100))
        throw new Error("RESTORE_PROOF_DATASET_LIMIT");
      const items = [];
      for (const version of versions) {
        const rows = await ctx.db
          .query("documentItems")
          .withIndex("by_versionId_and_position", (q) => q.eq("versionId", version._id))
          .take(100);
        if (rows.length >= 100) throw new Error("RESTORE_PROOF_DATASET_LIMIT");
        items.push(...rows);
      }
      records.push({ document, versions, artifacts, evidence, items });
    }
    const certificates = [],
      heads = [],
      audit = [];
    for (const company of companies) {
      certificates.push(
        ...(await ctx.db
          .query("certificates")
          .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
          .take(10)),
      );
      heads.push(
        ...(await ctx.db
          .query("certificateHeads")
          .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
          .take(2)),
      );
      audit.push(
        ...(await ctx.db
          .query("certificateAudit")
          .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
          .take(30)),
      );
    }
    // The caller writes only hashes and assertions into public receipts. The full value remains restricted.
    return JSON.stringify(
      convexToJson({ organization: org, companies, records, certificates, heads, audit }),
    );
  },
});
