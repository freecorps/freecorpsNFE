import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireLocalProof } from "./operationProof";
import schema from "../schema";
function requireSyntheticSource() {
  requireLocalProof();
  if (process.env.FISCAL_ENV !== "disabled") throw new Error("SYNTHETIC_FISCAL_ENV_REQUIRED");
}
export const set = internalMutation({
  args: { streamId: v.id("captureStreams"), xml: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireSyntheticSource();
    if (args.xml.length > 2 * 1024 * 1024) throw new Error("PROOF_LIMIT");
    const previous = await ctx.db
      .query("captureProofResponses")
      .withIndex("by_streamId", (q) => q.eq("streamId", args.streamId))
      .unique();
    if (previous) await ctx.db.patch("captureProofResponses", previous._id, { xml: args.xml });
    else await ctx.db.insert("captureProofResponses", { ...args, calls: 0 });
    return null;
  },
});
export const next = internalMutation({
  args: { streamId: v.id("captureStreams") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireSyntheticSource();
    const response = await ctx.db
      .query("captureProofResponses")
      .withIndex("by_streamId", (q) => q.eq("streamId", args.streamId))
      .unique();
    if (!response) return null;
    await ctx.db.patch("captureProofResponses", response._id, { calls: response.calls + 1 });
    return response.xml;
  },
});
export const inspect = internalQuery({
  args: { streamId: v.id("captureStreams") },
  returns: v.object({
    stream: v.union(schema.doc("captureStreams"), v.null()),
    calls: v.number(),
    envelopes: v.array(schema.doc("captureEnvelopes")),
    audit: v.array(schema.doc("captureAudit")),
  }),
  handler: async (ctx, args) => {
    requireSyntheticSource();
    const response = await ctx.db
      .query("captureProofResponses")
      .withIndex("by_streamId", (q) => q.eq("streamId", args.streamId))
      .unique();
    return {
      stream: await ctx.db.get("captureStreams", args.streamId),
      calls: response?.calls ?? 0,
      envelopes: await ctx.db
        .query("captureEnvelopes")
        .withIndex("by_streamId_nsu", (q) => q.eq("streamId", args.streamId))
        .take(100),
      audit: await ctx.db
        .query("captureAudit")
        .withIndex("by_streamId", (q) => q.eq("streamId", args.streamId))
        .take(100),
    };
  },
});
export const allowNow = internalMutation({
  args: { streamId: v.id("captureStreams") },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireSyntheticSource();
    const proof = await ctx.db
      .query("captureProofResponses")
      .withIndex("by_streamId", (q) => q.eq("streamId", args.streamId))
      .unique();
    if (!proof) throw new Error("SYNTHETIC_SOURCE_REQUIRED");
    await ctx.db.patch("captureStreams", args.streamId, { nextAllowedAt: 0 });
    return null;
  },
});
