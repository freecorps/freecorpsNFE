import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal, components } from "../_generated/api";
import { requireLocalProof } from "./operationProof";
import { recordAudit } from "../lib/operationalAudit";

export const prepare = internalMutation({
  args: { email: v.string(), keyHash: v.string(), suffix: v.string() },
  returns: v.object({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    companyId: v.id("companies"),
    keyId: v.id("apiKeys"),
    operationId: v.id("operations"),
    membershipId: v.id("memberships"),
    lateOwnerId: v.id("memberships"),
    slug: v.string(),
  }),
  handler: async (ctx, a) => {
    requireLocalProof();
    if (!a.email.endsWith("@development.invalid")) throw new Error("Synthetic account required");
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", value: a.email }],
    });
    if (!user) throw new Error("Expected verified synthetic account");
    const scope: {
      organizationId: import("../_generated/dataModel").Id<"organizations">;
      projectId: import("../_generated/dataModel").Id<"projects">;
      companyId: import("../_generated/dataModel").Id<"companies">;
      keyId: import("../_generated/dataModel").Id<"apiKeys">;
    } = await ctx.runMutation(internal.testing.operationProof.prepare, {
      keyHash: a.keyHash,
      suffix: a.suffix,
    });
    const member = (await ctx.db
      .query("memberships")
      .withIndex("by_organizationId_and_state", (q) =>
        q.eq("organizationId", scope.organizationId).eq("state", "active"),
      )
      .first())!;
    await ctx.db.patch("memberships", member._id, { authUserId: user._id });
    const { _id: _memberId, _creationTime: _created, ...template } = member;
    let lateOwnerId = member._id;
    for (let i = 0; i < 21; i++)
      lateOwnerId = await ctx.db.insert("memberships", {
        ...template,
        role: "admin",
        authUserId: `synthetic-${a.suffix}-${i}`,
        name: `Responsável sintético ${i}`,
        email: `owner-${a.suffix}-${i}@development.invalid`,
      });
    const operationId = await ctx.db.insert("operations", {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      companyId: scope.companyId,
      environment: "sandbox",
      sourceKeyId: scope.keyId,
      task: {
        name: "proof.import",
        workload: "import",
        scope: "documents:import",
        executor: "testing/operationTransport:execute",
      },
      request: "synthetic-body-must-never-appear-in-support",
      response: "synthetic-response-must-never-appear-in-support",
      requestHash: "synthetic",
      projectEpoch: 0,
      grantEpoch: 0,
      state: "queued",
      stage: "ready",
      generation: 1,
      fence: 0,
      attempts: 0,
      maxAttempts: 6,
      leaseUntil: 0,
      nextAttemptAt: Date.now() - 600_000,
      backoffMs: 0,
      jitterMs: 0,
      uncertain: false,
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      companyId: scope.companyId,
      actor: "controlled-proof",
      action: "operation.controlled_incident",
      target: operationId,
      operationId,
    });
    return { ...scope, operationId, membershipId: member._id, lateOwnerId, slug: a.suffix };
  },
});
export const seedAuthBuckets = internalMutation({
  args: { suffix: v.string(), offset: v.number(), count: v.number(), expired: v.boolean() },
  returns: v.number(),
  handler: async (ctx, a) => {
    requireLocalProof();
    if (!Number.isSafeInteger(a.count) || a.count < 1 || a.count > 100)
      throw new Error("Invalid batch");
    for (let i = 0; i < a.count; i++)
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "rateLimit",
          data: {
            key: `observability-${a.suffix}-${a.offset + i}`,
            count: 1,
            lastRequest: a.expired ? 1 : Date.now(),
          },
        },
      });
    return a.count;
  },
});
export const authCleanup = internalMutation({
  args: {},
  returns: v.object({ count: v.number(), documentsRead: v.number(), bytesRead: v.number() }),
  handler: async (ctx) => {
    requireLocalProof();
    const before = await ctx.meta.getTransactionMetrics();
    const result = await ctx.runMutation(
      components.betterAuth.adapter.deleteMany,
      {
        input: {
          model: "rateLimit",
          where: [{ field: "lastRequest", operator: "lt", value: 1000 }],
        },
        paginationOpts: { cursor: null, numItems: 50, maximumRowsRead: 50 },
      },
      { transactionLimits: { documentsRead: 100, bytesRead: 1_048_576 } },
    );
    const after = await ctx.meta.getTransactionMetrics();
    return {
      count: result.count,
      documentsRead: before.documentsRead.remaining - after.documentsRead.remaining,
      bytesRead: before.bytesRead.remaining - after.bytesRead.remaining,
    };
  },
});
