import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { authenticateKey, keyAccess, projectAccess } from "./operationAccess";
import { inCustody } from "./coldArchiveCore";
import { environmentServed } from "./environmentAccess";
import {
  isConsoleProject,
  projectGrant,
  requireProject,
  requireGrantableCompany,
} from "./projectAccess";
import { deny } from "./organizationAccess";
import { normalizeWebhookUrl } from "./webhookUrl";
import { webhookEventScope, webhookEvents, type WebhookEventType } from "@freecorps/contracts";
export type WebhookScope = Pick<
  Doc<"webhookEndpoints">,
  "organizationId" | "projectId" | "companyId" | "environment"
>;
export async function webhookAccess(ctx: QueryCtx, scope: WebhookScope, keyHash?: string) {
  if (keyHash) {
    const key = await keyAccess(ctx, keyHash, { ...scope, task: { scope: "webhooks:manage" } });
    return `key:${key._id}`;
  }
  const { membership, user } = await requireProject(ctx, scope.organizationId, scope.projectId);
  await requireGrantableCompany(ctx, membership, scope.companyId);
  await projectAccess(ctx, { ...scope, task: { scope: "webhooks:manage" } });
  return user._id;
}
export async function endpointAccess(ctx: QueryCtx, id: Id<"webhookEndpoints">, keyHash?: string) {
  const endpoint = await ctx.db.get("webhookEndpoints", id);
  if (!endpoint) return deny("NOT_FOUND");
  const actor = await webhookAccess(ctx, endpoint, keyHash);
  return { endpoint, actor };
}
/**
 * The access path of what custody keeps for webhooks (ADR 0009, §§2-3): listing, switching off and
 * rotating the secret. The key (or the member who manages the project, with access to the
 * company), the active project and the grant's `webhooks:manage` in the environment are checked
 * as in `webhookAccess`, without the archive refusal of `companyScopeAccess` and without reading
 * fiscal data. `companyScopeAccess` keeps that refusal for everything else, idempotent
 * repetitions included.
 */
async function custodyAccess(ctx: QueryCtx, scope: WebhookScope, keyHash?: string) {
  let actor: string;
  let grantEpoch: number | null = null;
  if (keyHash) {
    const key = await authenticateKey(ctx, keyHash, { archived: "allowed" });
    if (key.organizationId !== scope.organizationId || key.projectId !== scope.projectId)
      return deny("NOT_FOUND");
    const index = key.companyIds.indexOf(scope.companyId);
    if (index < 0) return deny("NOT_FOUND");
    grantEpoch = key.grantEpochs[index]!;
    if (key.environment !== scope.environment) deny("ENVIRONMENT_DENIED");
    if (!key.scopes.includes("webhooks:manage")) deny("SCOPE_DENIED");
    actor = `key:${key._id}`;
  } else {
    const { membership, user } = await requireProject(ctx, scope.organizationId, scope.projectId, {
      archived: "allowed",
    });
    await requireGrantableCompany(ctx, membership, scope.companyId);
    actor = user._id;
  }
  const company = await ctx.db.get("companies", scope.companyId);
  const project = await ctx.db.get("projects", scope.projectId);
  const grant = await projectGrant(ctx, scope.projectId, scope.companyId);
  if (
    !company ||
    company.organizationId !== scope.organizationId ||
    !(await environmentServed(ctx, company, scope.environment, "webhooks:manage")) ||
    !project ||
    project.organizationId !== scope.organizationId ||
    project.state !== "active" ||
    isConsoleProject(project) ||
    !grant?.active ||
    grant.organizationId !== scope.organizationId ||
    !grant.scopes.includes("webhooks:manage") ||
    !grant.environments.includes(scope.environment) ||
    (grantEpoch !== null && grantEpoch !== grant.accessEpoch)
  )
    return deny("NOT_FOUND");
  return actor;
}
/**
 * `webhookAccess` for what custody keeps: a hot organization (or one in its notice) takes the
 * usual path; one in custody, `custodyAccess`.
 */
export async function keptWebhookAccess(ctx: QueryCtx, scope: WebhookScope, keyHash?: string) {
  if (!(await inCustody(ctx, scope.organizationId))) return webhookAccess(ctx, scope, keyHash);
  return custodyAccess(ctx, scope, keyHash);
}
/** `endpointAccess` for switching off and rotating, which custody keeps; `custody` says which. */
export async function keptEndpointAccess(
  ctx: QueryCtx,
  id: Id<"webhookEndpoints">,
  keyHash?: string,
) {
  const endpoint = await ctx.db.get("webhookEndpoints", id);
  if (!endpoint) return deny("NOT_FOUND");
  if (!(await inCustody(ctx, endpoint.organizationId)))
    return { ...(await endpointAccess(ctx, id, keyHash)), custody: false };
  return { endpoint, actor: await custodyAccess(ctx, endpoint, keyHash), custody: true };
}
export async function subscribedAccess(
  ctx: QueryCtx,
  endpoint: WebhookScope,
  events: readonly string[],
  keyHash?: string,
) {
  const required = new Set(events.map((e) => webhookEventScope(e as WebhookEventType)));
  for (const scope of required) {
    const op = { ...endpoint, task: { scope } };
    if (keyHash) await keyAccess(ctx, keyHash, op);
    else await projectAccess(ctx, op);
  }
}
/**
 * The last event of a production capture whose release was withdrawn (#422). Withdrawing takes
 * `webhooks:manage` away from production (`environmentServed`), so this event alone is checked
 * with the reading the withdrawn release keeps (`connections:read`), plus the grant's own
 * `webhooks:manage`: it reaches, and is retried to, the endpoints that subscribed to it while the
 * release held. Every other check (active endpoint, project, grant, epochs, closure) stays.
 */
export const RELEASE_WITHDRAWN_EVENT = "connection.release_withdrawn" satisfies WebhookEventType;
export async function endpointAllowed(
  ctx: QueryCtx,
  endpoint: Doc<"webhookEndpoints">,
  type: string,
) {
  if (!endpoint.active) return false;
  try {
    const notice = type === RELEASE_WITHDRAWN_EVENT;
    const { project, grant } = await projectAccess(ctx, {
      ...endpoint,
      task: { scope: notice ? "connections:read" : "webhooks:manage" },
    });
    if (endpoint.projectEpoch !== project.accessEpoch || endpoint.grantEpoch !== grant.accessEpoch)
      return false;
    if (notice && !isConsoleProject(project)) {
      const own = await projectGrant(ctx, endpoint.projectId, endpoint.companyId);
      if (!own?.scopes.includes("webhooks:manage")) return false;
    }
    if (type !== "webhook.test") await subscribedAccess(ctx, endpoint, [type]);
    return true;
  } catch (error) {
    if (error instanceof ConvexError) return false;
    throw error;
  }
}
export function validateEndpoint(input: { name: string; url: string; events: WebhookEventType[] }) {
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    !input.events.length ||
    input.events.length > webhookEvents.length ||
    new Set(input.events).size !== input.events.length ||
    input.url.length > 2048
  )
    return deny("INVALID_REQUEST");
  try {
    if (new URL(input.url).hash) return deny("INVALID_REQUEST");
    const url = new URL(normalizeWebhookUrl(input.url));
    if (url.port && url.port !== "443") return deny("INVALID_REQUEST");
    if (url.search || url.hash) return deny("INVALID_REQUEST");
    return { name: input.name.trim(), url: url.href, events: input.events };
  } catch {
    return deny("INVALID_REQUEST");
  }
}
