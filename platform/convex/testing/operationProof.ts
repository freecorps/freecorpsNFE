import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requirePlatformEnvironment } from "../environment";
import schema from "../schema";

export function requireLocalProof() {
  if (!requirePlatformEnvironment().local) throw new Error("Local synthetic proof only");
}

/** Marker of the throwaway Convex preview of the pre-B5 read evaluation (#642, ADR 0010). */
export const HOSTED_READ_PROOF = "preview-642";
/**
 * Marker of the throwaway preview of the cold tier's real-path proof (#689, ADR 0010, phase C):
 * the same bare profile plus the cold tier's gate and bucket, which no platform function reads
 * there, since all of them refuse the marker.
 */
export const HOSTED_COLD_PROOF = "preview-689";
/** Names a bare proof preview never carries: a platform profile, accounts or fiscal access. */
const hostedReadForbidden = [
  "APP_ENV",
  "PRODUCT_ENV",
  "SITE_URL",
  "API_URL",
  "WEBHOOK_MODE",
  "EMAIL_MODE",
  "BETTER_AUTH_SECRET",
  "AUTH_PROXY_MODE",
  "AUTH_PROXY_SECRET",
  "CLOUDFLARE_EMAIL_API_TOKEN",
  "ACCOUNT_EMAIL_FROM",
  "ACCOUNT_EMAIL_RECIPIENTS",
  "FNFE_CAPTURE_FISCAL",
  "FNFE_CAPTURE_TRANSPORT",
  "FNFE_FISCAL_PROOF",
  "FNFE_PROOF_FISCAL_ENV",
  "FNFE_ISSUANCE_ENV",
  "FNFE_NFSE_PRODUCTION_COMPANIES",
];

/**
 * The read evaluation runs locally or on a hosted preview created only for it. A hosted
 * deployment cannot be the loopback development profile (Convex provides `CONVEX_SITE_URL`),
 * so the preview carries no platform profile at all, only the marker, crons off and fiscal
 * transport disabled. Every platform function refuses the marker (`environment.ts`).
 */
export function requireReadProof() {
  if (process.env.FNFE_HOSTED_PROOF === undefined) return requireLocalProof();
  if (
    (process.env.FNFE_HOSTED_PROOF !== HOSTED_READ_PROOF &&
      process.env.FNFE_HOSTED_PROOF !== HOSTED_COLD_PROOF) ||
    process.env.FNFE_CRONS !== "off" ||
    process.env.FISCAL_ENV !== "disabled" ||
    // The URL shape only rules out loopback and self-hosted backends; it cannot tell a preview
    // from production. The real protection is the forbidden list, the exact variables the runner
    // checks before writing and every platform function refusing the marker.
    !/^https:\/\/[a-z]+-[a-z]+-\d+\.convex\.cloud$/.test(process.env.CONVEX_CLOUD_URL ?? "") ||
    hostedReadForbidden.some((name) => process.env[name] !== undefined)
  )
    throw new Error("Local synthetic proof only");
}
export const prepare = internalMutation({
  args: { keyHash: v.string(), suffix: v.string() },
  returns: v.object({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    companyId: v.id("companies"),
    keyId: v.id("apiKeys"),
  }),
  handler: async (ctx, { keyHash, suffix }) => {
    requireReadProof();
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Prova sintética de operações",
      slug: suffix,
      ownerCount: 1,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    const member = await ctx.db.insert("memberships", {
      organizationId,
      authUserId: `proof-${suffix}`,
      name: "Prova",
      email: "proof@development.invalid",
      role: "owner",
      state: "active",
      version: 1,
      joinedAt: now,
      updatedAt: now,
    });
    const companyId = await ctx.db.insert("companies", {
      organizationId,
      cnpj: "00000000000191",
      name: "Empresa sintética",
      kind: "demonstration",
      declaredBy: "proof",
      declaredAt: now,
      address: {
        street: "Rua sintética",
        number: "1",
        complement: "",
        district: "Centro",
        city: "Cidade",
        state: "SP",
        postalCode: "01000000",
      },
      fieldSources: { name: "demonstration", address: "demonstration" },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Prova de operações",
      externalReference: suffix,
      state: "active",
      version: 1,
      accessEpoch: 0,
      creatorMembershipId: member,
      creatorEpoch: 0,
      createdAt: now,
    });
    const scopes = ["documents:import", "connections:write", "webhooks:manage"] as const;
    await ctx.db.insert("projectCompanies", {
      organizationId,
      projectId,
      companyId,
      scopes: [...scopes],
      environments: ["sandbox"],
      active: true,
      version: 1,
      accessEpoch: 0,
    });
    const keyId = await ctx.db.insert("apiKeys", {
      organizationId,
      projectId,
      projectEpoch: 0,
      name: "Prova sintética",
      keyHash,
      prefix: "fnfe_proof",
      scopes: [...scopes],
      environment: "sandbox",
      companyIds: [companyId],
      grantEpochs: [0],
      expiresAt: now + 3600_000,
      revokedAt: null,
      rotatedAt: null,
      createdAt: now,
      creatorMembershipId: member,
    });
    return { organizationId, projectId, companyId, keyId };
  },
});
export const checkpoint = internalMutation({
  args: { operationId: v.id("operations"), response: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const previous = await ctx.db
      .query("operationProofDocuments")
      .withIndex("by_operationId", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (!previous) await ctx.db.insert("operationProofDocuments", args);
    return null;
  },
});
export const retire = internalMutation({
  args: { keyId: v.id("apiKeys") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    const key = await ctx.db.get("apiKeys", args.keyId);
    if (!key || key.name !== "Prova sintética") throw new Error("Expected synthetic proof key");
    await ctx.db.patch("apiKeys", key._id, { revokedAt: Date.now() });
    return null;
  },
});
export const failCheckpoint = internalMutation({
  args: { operationId: v.id("operations"), response: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalProof();
    await ctx.db.insert("operationProofDocuments", args);
    throw new Error("SYNTHETIC_CHECKPOINT_FAILURE");
  },
});
export const inspect = internalQuery({
  args: { operationId: v.id("operations") },
  returns: v.object({
    operation: v.union(schema.doc("operations"), v.null()),
    attempts: v.array(schema.doc("operationAttempts")),
    receipts: v.array(schema.doc("operationReceipts")),
    documents: v.array(schema.doc("operationProofDocuments")),
  }),
  handler: async (ctx, { operationId }) => {
    requireLocalProof();
    return {
      operation: await ctx.db.get("operations", operationId),
      attempts: await ctx.db
        .query("operationAttempts")
        .withIndex("by_operationId_and_generation_and_fence", (q) =>
          q.eq("operationId", operationId),
        )
        .take(50),
      receipts: await ctx.db
        .query("operationReceipts")
        .withIndex("by_operationId_and_kind", (q) => q.eq("operationId", operationId))
        .take(3),
      documents: await ctx.db
        .query("operationProofDocuments")
        .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
        .take(2),
    };
  },
});
