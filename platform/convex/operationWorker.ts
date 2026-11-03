import { makeFunctionReference } from "convex/server";
import { v, type Infer } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { outcome } from "./lib/operationValues";
import type { Claim } from "./lib/operationCore";

export const run = internalAction({
  args: { operationId: v.id("operations"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const op: Doc<"operations"> | null = await ctx.runMutation(internal.operations.claim, args);
    if (!op) return null;
    const claim = { ...args, fence: op.fence };
    if (op.stage === "ready") {
      const started: boolean = await ctx.runMutation(internal.operations.beginEffect, claim);
      if (!started) return null;
      const handler = op.uncertain ? op.task.reconciler : op.task.executor;
      if (!handler) return null; // watchdog retains uncertainty; never substitutes the executor.
      const result: Infer<typeof outcome> = await ctx.runAction(
        makeFunctionReference<"action", Claim & { request: string }, Infer<typeof outcome>>(
          handler,
        ),
        { ...claim, request: op.request },
      );
      const saved: boolean = await ctx.runMutation(internal.operations.recordOutcome, {
        ...claim,
        outcome: result,
      });
      if (!saved) return null;
    }
    if (op.stage !== "checkpoint") {
      const saved: boolean = await ctx.runMutation(internal.operations.checkpoint, claim);
      if (!saved) return null;
    }
    await ctx.runMutation(internal.operations.publish, claim);
    return null;
  },
});
