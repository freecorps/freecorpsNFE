import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { authenticateKey } from "./lib/operationAccess";
import { deny } from "./lib/organizationAccess";
import { keyEnvironmentServed, type EnvironmentPurpose } from "./lib/environmentAccess";
import { jsonRoute } from "./lib/externalHttp";
import { apiVersion } from "@freecorps/contracts/external";
import { webhookEvents } from "@freecorps/contracts/webhooks";
import { documentModels, type DocumentModel } from "@freecorps/contracts";
import { documentModel } from "./lib/documentValues";

/**
 * Each implemented capability and the purpose its routes check with `environmentServed`. The key
 * sees a capability only where the environment serves that purpose, so the list follows the same
 * rule as the routes: a released company's production key never sees imports or issuance.
 */
const capabilityPurposes = [
  ["companies.read", "companies:read"],
  ["documents.import", "documents:import"],
  ["documents.read", "documents:read"],
  ["documents.issue", "documents:issue"],
  ["documents.cancel", "documents:cancel"],
  ["webhooks", "webhooks:manage"],
  ["references.read", "references:read"],
  ["connections.read", "connections:read"],
  ["connections.write", "connections:write"],
  ["registry.read", "registry:read"],
] as const satisfies readonly (readonly [string, EnvironmentPurpose])[];
/**
 * The capability that brings each model in: NF-e 55 is read (imported or captured), NFS-e only
 * arrives by issuance, which the site's production never serves. The ABRASF import that also
 * brought it in was retired on 2026-11-02; its notes stay read-only.
 */
const modelCapabilities: Record<DocumentModel, (typeof capabilityPurposes)[number][0]> = {
  "55": "documents.read",
  nfse: "documents.issue",
};

/**
 * The key's environment and the models and capabilities it reaches there. Like the entry check of every
 * route, a capability is listed when the environment serves it for at least one of the key's
 * companies; each call still checks its own company, scope and grant. Capabilities describe what
 * is implemented, never what the key's scopes grant.
 */
export const authorize = internalQuery({
  args: { keyHash: v.string(), environment: v.string() },
  returns: v.object({
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    models: v.array(documentModel),
    capabilities: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    // Capabilities describe the deployment, not fiscal data: kept in cold custody (ADR 0009, §2).
    const key = await authenticateKey(ctx, args.keyHash, { archived: "allowed" });
    if (
      key.environment !== args.environment ||
      !(await keyEnvironmentServed(ctx, key, "companies:read"))
    )
      return deny("ENVIRONMENT_DENIED");
    const capabilities: string[] = [];
    for (const [capability, purpose] of capabilityPurposes)
      if (await keyEnvironmentServed(ctx, key, purpose)) capabilities.push(capability);
    // A model exists where the capability that brings it in does.
    const models = documentModels.filter((model) =>
      capabilities.includes(modelCapabilities[model]),
    );
    return { environment: key.environment, models, capabilities };
  },
});
export const route = jsonRoute({ notFound: "Rota não encontrada." }, async (input) => {
  const { environment, models, capabilities } = await input.ctx.runQuery(
    internal.capabilityRest.authorize,
    { keyHash: input.keyHash, environment: input.environment },
  );
  return {
    data: {
      apiVersion,
      environment,
      models,
      capabilities,
      webhookEvents,
      limits: { importFiles: 20, importBytes: 2097152, pageSize: 50 },
    },
  };
});
