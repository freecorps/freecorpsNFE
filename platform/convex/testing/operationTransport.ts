"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { requirePlatformEnvironment } from "../environment";
import { claimFields, outcome } from "../lib/operationValues";

async function transport(request: string, operationId: string, reconcile: boolean) {
  if (!requirePlatformEnvironment().local) throw new Error("Local synthetic proof only");
  const input: unknown = JSON.parse(request);
  if (
    !input ||
    typeof input !== "object" ||
    !("url" in input) ||
    typeof input.url !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+\/effect(?:\/(import|capture|webhook|late))?$/.test(input.url)
  )
    throw new Error("Expected loopback proof transport");
  const response = await fetch(`${input.url}/${operationId}`, {
    method: reconcile ? "GET" : "POST",
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (reconcile && response.status === 404)
    return { kind: "absent" as const, code: "NOT_OBSERVED_YET" };
  if (!response.ok) return { kind: "uncertain" as const, code: "TRANSPORT_UNCERTAIN" };
  const body = await response.text();
  if (!reconcile && "crashAfterEffect" in input && input.crashAfterEffect === true)
    throw new Error("SYNTHETIC_CRASH_AFTER_EFFECT");
  return { kind: "success" as const, response: body };
}
export const execute = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: async (_ctx, args) => transport(args.request, args.operationId, false),
});
export const reconcile = internalAction({
  args: { ...claimFields, request: v.string() },
  returns: outcome,
  handler: async (_ctx, args) => transport(args.request, args.operationId, true),
});
