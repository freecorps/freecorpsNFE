import { jsonRoute } from "./lib/externalHttp";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { authenticateKey } from "./lib/operationAccess";
import { endpointAccess, keptEndpointAccess, keptWebhookAccess } from "./lib/webhookAccess";
import { assertOrganizationHot } from "./lib/coldArchiveCore";
import { deny } from "./lib/organizationAccess";
import { webhookEvents, type WebhookEventType } from "@freecorps/contracts";
import {
  createEndpoint,
  editEndpoint,
  rotateEndpoint,
  testEndpoint,
  retryDelivery,
  listEndpoints,
  summarizeDelivery,
  summarizeEndpoint,
} from "./webhooks";
function fields(body: Record<string, unknown>, names: string[]) {
  if (Object.keys(body).sort().join() !== names.sort().join()) return deny("INVALID_REQUEST");
}
function endpointInput(body: Record<string, unknown>) {
  if (
    typeof body.name !== "string" ||
    typeof body.url !== "string" ||
    !Array.isArray(body.events) ||
    body.events.some((e) => !webhookEvents.includes(e))
  )
    return deny("INVALID_REQUEST");
  return { name: body.name, url: body.url, events: body.events as WebhookEventType[] };
}
export const dispatch = internalMutation({
  args: {
    keyHash: v.string(),
    environment: v.string(),
    path: v.string(),
    search: v.string(),
    method: v.string(),
    key: v.string(),
    body: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    // In cold custody the key keeps three webhook actions (ADR 0009, §§2-3): listing, switching an
    // endpoint off and rotating its secret, each through `keptWebhookAccess`/`keptEndpointAccess`.
    // Any other route refuses `ORGANIZATION_ARCHIVED` here, as `authenticateKey` would.
    const key = await authenticateKey(ctx, args.keyHash, { archived: "allowed" });
    if (args.environment !== key.environment) return deny("ENVIRONMENT_DENIED");
    if (
      !(
        (args.path === "/v1/webhook-endpoints" && args.method === "GET") ||
        (/^\/v1\/webhook-endpoints\/[^/]+$/.test(args.path) && args.method === "PATCH") ||
        (/^\/v1\/webhook-endpoints\/[^/]+\/rotate-secret$/.test(args.path) &&
          args.method === "POST")
      )
    )
      await assertOrganizationHot(ctx, key.organizationId);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(args.body) as Record<string, unknown>;
    } catch {
      return deny("INVALID_REQUEST");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return deny("INVALID_REQUEST");
    const params = new URLSearchParams(args.search);
    if (args.method !== "GET" && args.search) return deny("INVALID_REQUEST");
    if (args.path === "/v1/webhook-endpoints") {
      if (args.method === "POST") {
        fields(body, ["companyId", "name", "url", "events"]);
        const companyId =
          typeof body.companyId === "string"
            ? ctx.db.normalizeId("companies", body.companyId)
            : null;
        if (!companyId) return deny("NOT_FOUND");
        return JSON.stringify(
          await createEndpoint(
            ctx,
            {
              organizationId: key.organizationId,
              projectId: key.projectId,
              companyId,
              environment: key.environment,
            },
            endpointInput(body),
            args.keyHash,
          ),
        );
      }
      if (args.method !== "GET" || [...params.keys()].join() !== "companyId")
        return deny("INVALID_REQUEST");
      const companyId = ctx.db.normalizeId("companies", params.get("companyId") ?? "");
      if (!companyId) return deny("NOT_FOUND");
      const scope = {
        organizationId: key.organizationId,
        projectId: key.projectId,
        companyId,
        environment: key.environment,
      };
      await keptWebhookAccess(ctx, scope, args.keyHash);
      return JSON.stringify(await listEndpoints(ctx, scope));
    }
    if (args.path === "/v1/webhook-deliveries" && args.method === "GET") {
      if (
        [...params.keys()].some((k) => !["endpointId", "cursor", "limit"].includes(k)) ||
        [...params.keys()].length !== new Set(params.keys()).size
      )
        return deny("INVALID_REQUEST");
      const endpointId = ctx.db.normalizeId("webhookEndpoints", params.get("endpointId") ?? "");
      if (!endpointId) return deny("NOT_FOUND");
      await endpointAccess(ctx, endpointId, args.keyHash);
      const limit = Number(params.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return deny("INVALID_PAGINATION");
      const page = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_endpointId", (q) => q.eq("endpointId", endpointId))
        .order("desc")
        .paginate({ numItems: limit, cursor: params.get("cursor"), maximumRowsRead: 50 })
        .catch((error: unknown) => {
          if (
            params.get("cursor") &&
            error instanceof Error &&
            /InvalidCursor|invalid cursor|cursor.*invalid|JSON Parse error|not valid JSON/i.test(
              error.message,
            )
          )
            return deny("INVALID_CURSOR");
          throw error;
        });
      return JSON.stringify({
        items: await Promise.all(page.page.map((d) => summarizeDelivery(ctx, d))),
        nextCursor: page.isDone ? null : page.continueCursor,
      });
    }
    const endpointMatch = /^\/v1\/webhook-endpoints\/([^/]+)(?:\/(rotate-secret|test))?$/.exec(
      args.path,
    );
    if (endpointMatch) {
      const id = ctx.db.normalizeId("webhookEndpoints", endpointMatch[1]!);
      if (!id) return deny("NOT_FOUND");
      const { endpoint } = await keptEndpointAccess(ctx, id, args.keyHash);
      if (args.method === "GET" && !endpointMatch[2] && !args.search)
        return JSON.stringify(summarizeEndpoint(endpoint));
      if (args.method === "PATCH" && !endpointMatch[2]) {
        fields(body, ["name", "url", "events", "active", "expectedVersion"]);
        if (typeof body.active !== "boolean" || !Number.isSafeInteger(body.expectedVersion))
          return deny("INVALID_REQUEST");
        return JSON.stringify(
          await editEndpoint(
            ctx,
            {
              endpointId: id,
              expectedVersion: body.expectedVersion as number,
              active: body.active,
              ...endpointInput(body),
            },
            args.keyHash,
          ),
        );
      }
      if (args.method === "POST" && endpointMatch[2] === "rotate-secret") {
        fields(body, ["expectedVersion", "overlapMs"]);
        if (!Number.isSafeInteger(body.expectedVersion) || !Number.isSafeInteger(body.overlapMs))
          return deny("INVALID_REQUEST");
        return JSON.stringify(
          await rotateEndpoint(
            ctx,
            {
              endpointId: id,
              expectedVersion: body.expectedVersion as number,
              overlapMs: body.overlapMs as number,
            },
            args.keyHash,
          ),
        );
      }
      if (args.method === "POST" && endpointMatch[2] === "test") {
        fields(body, []);
        return JSON.stringify(await testEndpoint(ctx, id, args.key, args.keyHash));
      }
    }
    const retryMatch = /^\/v1\/webhook-deliveries\/([^/]+)\/retry$/.exec(args.path);
    if (retryMatch && args.method === "POST") {
      fields(body, ["expectedGeneration"]);
      const id = ctx.db.normalizeId("webhookDeliveries", retryMatch[1]!);
      if (!id) return deny("NOT_FOUND");
      if (!Number.isSafeInteger(body.expectedGeneration)) return deny("INVALID_REQUEST");
      return JSON.stringify(
        await retryDelivery(ctx, id, body.expectedGeneration as number, args.key, args.keyHash),
      );
    }
    return deny("NOT_FOUND");
  },
});
export const route = jsonRoute(
  { notFound: "Endpoint ou entrega de webhook não encontrado.", maxBody: 8192 },
  async (input) => {
    const data = await input.ctx.runMutation(internal.webhookRest.dispatch, {
      keyHash: input.keyHash,
      environment: input.environment,
      path: input.url.pathname,
      search: input.url.search,
      method: input.request.method,
      key: input.idempotencyKey,
      body: JSON.stringify(input.body),
    });
    return { data: JSON.parse(data) as unknown };
  },
);
