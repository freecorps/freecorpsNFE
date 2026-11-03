import { v, type Infer } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { claimFields, outcome } from "./lib/operationValues";
import { lookupOpenCnpj } from "./lib/registryProvider";

export const argsValue = v.object({ ...claimFields, request: v.string() });
export async function runRegistry(
  ctx: ActionCtx,
  args: Infer<typeof argsValue>,
  transport?: typeof fetch,
): Promise<Infer<typeof outcome>> {
  const request = JSON.parse(args.request) as { cnpj: string };
  const claim = {
    operationId: args.operationId,
    generation: args.generation,
    fence: args.fence,
    cnpj: request.cnpj,
  };
  const decision = await ctx.runMutation(internal.registryStore.begin, claim);
  if (decision === "wait")
    return { kind: "absent", code: "REGISTRY_BUSY", notBefore: Date.now() + 15_000 };
  if (decision === "restricted") return { kind: "definitive", code: "REGISTRY_RESTRICTED" };
  if (decision === "denied" || decision === "unknown")
    return {
      kind: "definitive",
      code: decision === "unknown" ? "REGISTRY_RESULT_UNKNOWN" : "ACCESS_REVOKED",
    };
  if (decision === "call") {
    const result = await lookupOpenCnpj(request.cnpj, transport);
    const saved = await ctx.runMutation(internal.registryStore.complete, { ...claim, ...result });
    if (!saved) return { kind: "uncertain", code: "REGISTRY_RESULT_UNKNOWN" };
  }
  // No cadastral payload in the long-lived operation history.
  return {
    kind: "success",
    response: JSON.stringify({ provider: "opencnpj", cnpj: request.cnpj }),
  };
}
export const execute = internalAction({
  args: argsValue,
  returns: outcome,
  handler: (ctx, args) => runRegistry(ctx, args),
});
export const reconcile = internalAction({
  args: argsValue,
  returns: outcome,
  handler: (ctx, args) => runRegistry(ctx, args),
});
/** Calls the provider for a pre-creation lookup that `registry.lookup` reserved. */
export const lookup = internalAction({
  args: { lookupId: v.id("registryLookups"), cnpj: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // An unexpected failure is an answer too: saving it applies the error cooldown, so a new
    // lookup does not dispatch (and charge) again right away.
    const result = await lookupOpenCnpj(args.cnpj).catch(() => ({
      status: "unavailable" as const,
      data: null,
    }));
    await ctx.runMutation(internal.registryStore.completeLookup, { ...args, ...result });
    return null;
  },
});
