import { v } from "convex/values";
import { environment, integrationScope } from "./projectValues";

export const workload = v.union(
  v.literal("import"),
  v.literal("capture"),
  v.literal("webhook"),
  v.literal("issuance"),
);
export const operationState = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("retry_wait"),
  v.literal("reconciling"),
  v.literal("paused"),
  v.literal("succeeded"),
  v.literal("failed"),
);
export const operationStage = v.union(
  v.literal("ready"),
  v.literal("calling"),
  v.literal("response"),
  v.literal("checkpoint"),
);
export const scopeFields = {
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  companyId: v.id("companies"),
  environment,
};
/**
 * Selectors of the console: people work on the company, without a project. The server resolves
 * the organization's console project when a record needs an owner (`lib/projectAccess.ts`).
 */
export const companyScopeFields = {
  organizationId: v.id("organizations"),
  companyId: v.id("companies"),
  environment,
};
/**
 * The function names are persisted on each operation and resolved only when it runs, so renaming
 * or removing one breaks the pending operations that stored it: keep the old export as an alias
 * until they are migrated or finished. `operationTasks.test.ts` checks every exported task.
 */
export const taskSpec = v.object({
  name: v.string(),
  workload,
  scope: integrationScope,
  executor: v.string(),
  reconciler: v.optional(v.string()),
  checkpoint: v.optional(v.string()),
  onSucceeded: v.optional(v.string()),
});
export const claimFields = {
  operationId: v.id("operations"),
  generation: v.number(),
  fence: v.number(),
};
/**
 * Shape of an answer the adapter could not read (`ResponseDiagnostic` of `@freecorps/fiscal-nfse`):
 * status, media type, body kind and the NAMES of the top-level JSON keys, never values. Kept on
 * the attempt to learn an authority's format without logging its body.
 */
export const responseDiagnostic = v.object({
  httpStatus: v.number(),
  contentType: v.union(v.string(), v.null()),
  body: v.string(),
  keys: v.array(v.string()),
});
export const outcome = v.union(
  v.object({ kind: v.literal("absent"), code: v.string(), notBefore: v.optional(v.number()) }),
  v.object({ kind: v.literal("success"), response: v.string() }),
  v.object({ kind: v.literal("transient"), code: v.string(), notBefore: v.optional(v.number()) }),
  v.object({ kind: v.literal("definitive"), code: v.string() }),
  /**
   * Nothing was sent and the source, or a gate before it, asks to come back at `notBefore` (the
   * source window, the hourly ceiling). A wait is not a failure: it spends no attempt nor
   * recovery (`waitOperation`, #421).
   */
  v.object({ kind: v.literal("wait"), code: v.string(), notBefore: v.number() }),
  v.object({
    kind: v.literal("uncertain"),
    code: v.string(),
    notBefore: v.optional(v.number()),
    diagnostic: v.optional(responseDiagnostic),
  }),
);
export const operationSummary = v.object({
  id: v.string(),
  /** The first ID of a rehydrated operation (ADR 0009, §6); absent otherwise. */
  originalId: v.optional(v.string()),
  state: operationState,
  generation: v.number(),
  attempts: v.number(),
  nextAttemptAt: v.union(v.number(), v.null()),
  code: v.union(v.string(), v.null()),
  result: v.union(v.string(), v.null()),
  uncertain: v.boolean(),
});
export const LEASE_MS = 60_000;
export const RECOVERY_BATCH = 20;
export const MAX_ATTEMPTS = 6;

/** JSON equivalence ignores object key order, never array order or value types. */
export function canonicalRequest(json: string): string {
  if (new TextEncoder().encode(json).length > 32_768) throw new Error("INVALID_REQUEST");
  const normalize = (value: unknown, depth: number): unknown => {
    if (depth > 20) throw new Error("INVALID_REQUEST");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("INVALID_REQUEST");
    if (Array.isArray(value)) return value.map((item) => normalize(item, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, normalize(item, depth + 1)]),
      );
    return value;
  };
  return JSON.stringify(normalize(JSON.parse(json) as unknown, 0));
}
export function backoff(attempt: number) {
  const base = Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 9));
  return { backoffMs: base, jitterMs: Math.floor((Math.random() * base) / 4) };
}
