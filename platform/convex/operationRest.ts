import { jsonRoute } from "./lib/externalHttp";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { authenticateKey, keyAccess } from "./lib/operationAccess";
import { deny } from "./lib/organizationAccess";
import { summary } from "./lib/operationCore";
import { controlOperation, controlKind } from "./operations";
import { operationSummary } from "./lib/operationValues";
import { currentRow } from "./lib/coldArchiveCurrent";

export const access = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    id: v.string(),
    action: v.optional(controlKind),
    expectedGeneration: v.optional(v.number()),
  },
  returns: operationSummary,
  handler: async (ctx, args) => {
    const { organizationId } = await authenticateKey(ctx, args.keyHash);
    // An ID of before a rehydration resolves through the key organization's map (ADR 0009, §6).
    const op = await currentRow(ctx, organizationId, "operations", args.id);
    if (!op) return deny("NOT_FOUND");
    const key = await keyAccess(ctx, args.keyHash, op);
    if (args.environment !== op.environment) deny("ENVIRONMENT_DENIED");
    if (args.action) {
      if (!Number.isSafeInteger(args.expectedGeneration)) deny("INVALID_REQUEST");
      await controlOperation(ctx, op, args.action, args.expectedGeneration!, `key:${key._id}`);
    }
    return summary((await ctx.db.get("operations", op._id))!);
  },
});
export const route = jsonRoute({ notFound: "Operação não encontrada." }, async (input) => {
  const action =
    input.route?.name === "pauseOperation"
      ? "pause"
      : input.route?.name === "retryOperation"
        ? "retry"
        : undefined;
  if (!input.route || input.url.search) return deny("NOT_FOUND");
  const { path, body } = input.route.value as {
    path: { operationId: string };
    body: { expectedGeneration?: number };
  };
  const data = await input.ctx.runMutation(internal.operationRest.access, {
    keyHash: input.keyHash,
    environment: input.environment,
    id: path.operationId,
    ...(action ? { action, expectedGeneration: body.expectedGeneration } : {}),
  });
  return { data };
});
