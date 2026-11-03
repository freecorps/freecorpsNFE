import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { jsonRoute } from "./lib/externalHttp";
import { authenticateKey } from "./lib/operationAccess";
import { captureAccess, captureView, scopedStream } from "./lib/captureCore";
import { startCapture, controlCapture } from "./captures";
import { deny } from "./lib/organizationAccess";
export const dispatch = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    companyId: v.string(),
    action: v.optional(
      v.union(v.literal("activate"), v.literal("sync"), v.literal("pause"), v.literal("resume")),
    ),
    expectedVersion: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const key = await authenticateKey(ctx, args.keyHash);
    if (key.environment !== args.environment) return deny("ENVIRONMENT_DENIED");
    const companyId = ctx.db.normalizeId("companies", args.companyId);
    if (!companyId) return deny("NOT_FOUND");
    const scope = {
      organizationId: key.organizationId,
      projectId: key.projectId,
      companyId,
      environment: key.environment,
    };
    await captureAccess(ctx, scope, !!args.action, args.keyHash);
    if (args.action === "activate")
      return JSON.stringify(await startCapture(ctx, scope, args.keyHash));
    if (args.action) {
      if (!Number.isSafeInteger(args.expectedVersion)) return deny("INVALID_REQUEST");
      return JSON.stringify(
        await controlCapture(ctx, scope, args.action, args.expectedVersion!, args.keyHash),
      );
    }
    const stream = await scopedStream(ctx, scope);
    return JSON.stringify(stream ? await captureView(ctx, stream) : null);
  },
});
export const route = jsonRoute({ notFound: "Conexão não encontrada." }, async (input) => {
  if (!input.route) return deny("NOT_FOUND");
  const body = input.route.value.body as {
    companyId: string;
    action: "activate" | "sync" | "pause" | "resume";
    expectedVersion?: number;
  };
  const post = input.request.method === "POST";
  const data: string = await input.ctx.runMutation(internal.captureRest.dispatch, {
    keyHash: input.keyHash,
    environment: input.environment,
    companyId: post ? body.companyId : (input.url.searchParams.get("companyId") ?? ""),
    ...(post ? { action: body.action, expectedVersion: body.expectedVersion } : {}),
  });
  return { data: JSON.parse(data) as unknown };
});
