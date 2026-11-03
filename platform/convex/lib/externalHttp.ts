import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { hashApiKey } from "./apiKeyCrypto";
import { httpAction, type ActionCtx } from "../_generated/server";
import { matchRoute, parseRequest } from "@freecorps/contracts/external";

/** The contract route of a request, or `null` when it matches none or cannot be parsed. */
function routeName(request: Request) {
  try {
    return matchRoute(request.method, new URL(request.url).pathname)?.name ?? null;
  } catch {
    return null;
  }
}
import { admitRestRequest } from "./restLimits";
import { apiProxyHeaders, verifyApiRequest } from "../../auth-transport";
import { requirePlatformEnvironment } from "../environment";
import { deny } from "./organizationAccess";
import { errorJson, publicError, refusal } from "./publicErrors";

const apiKey = /^Bearer fnfe_[A-Za-z0-9_-]{43}$/;
/** Largest JSON body of any public route; a larger one is not a valid request. */
const MAX_JSON_BYTES = 16_384;

/** Reads the whole body once, refusing it with `code` as soon as it passes `limit` bytes. */
export async function readLimited(request: Request, limit: number, code = "FILE_TOO_LARGE") {
  const reader = request.body?.getReader();
  if (!reader) return deny("INVALID_REQUEST");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return deny(code);
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** Correlation references a successful answer hands to the request telemetry. */
type References = { operationId?: string; eventId?: string };
/** A transport answer, optionally with the references read from its structured result. */
export type Observed = Response | ({ response: Response } & References);

export type ParsedRoute = NonNullable<ReturnType<typeof parseRequest>>;

/** What the transport hands a JSON route: everything is read, parsed and checked once. */
export type JsonInput = {
  ctx: ActionCtx;
  /** Headers and URL only: the body was already consumed into `body`. */
  request: Request;
  url: URL;
  requestId: string;
  /** The contract route and its validated input; `null` for paths outside the contract. */
  route: ParsedRoute | null;
  /** The JSON body as received (`{}` for GET or an empty body), already checked by `route`. */
  body: unknown;
  keyHash: string;
  environment: string;
  idempotencyKey: string;
};
/** A successful structured answer; the transport validates it before serializing. */
export type JsonResult = {
  data: unknown;
  status?: number;
  headers?: Record<string, string>;
  /** Top-level cursor of `GET /v1/companies`, the only route that pages outside `data`. */
  nextCursor?: string | null;
};

function references(data: unknown): References {
  if (!data || typeof data !== "object") return {};
  const value = data as Record<string, unknown>;
  return {
    ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
    ...(typeof value.operationId === "string"
      ? { operationId: value.operationId }
      : "generation" in value && typeof value.id === "string"
        ? { operationId: value.id }
        : {}),
  };
}

/**
 * Serializes a structured result once, after checking it against the contract's output and
 * status: the public wire schema holds independently of the domain's own checks.
 */
export function jsonAnswer(
  route: ParsedRoute | null,
  result: JsonResult,
  requestId: string,
): Observed {
  const status = result.status ?? 200;
  const payload = {
    data: result.data,
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    requestId,
  };
  if (!route || status !== route.entry.status || !route.entry.output.safeParse(payload).success)
    return errorJson(requestId, refusal("UNAVAILABLE"));
  return {
    response: Response.json(payload, {
      status,
      headers: { ...result.headers, "X-Request-Id": requestId, "Cache-Control": "no-store" },
    }),
    ...references(result.data),
  };
}

/**
 * A JSON route of the public API. The transport authenticates the key's shape, reads and parses
 * the body once within its limit, validates the input against the contract and hands the domain
 * the parsed request. The domain still validates authorization, scope and state in its own
 * transaction. Its structured result is checked against the contract's output and status before
 * it is serialized, and errors become the public vocabulary with the route's `notFound` wording.
 * A route may answer a raw `Response` only outside the contract (binary downloads).
 */
export function jsonRoute(
  options: { notFound: string; maxBody?: number },
  handler: (input: JsonInput) => Promise<JsonResult | Response>,
) {
  const maxBody = options.maxBody ?? MAX_JSON_BYTES;
  return observedAction(async (ctx, request): Promise<Observed> => {
    const requestId = request.headers.get("X-Request-Id")!;
    const bearer = request.headers.get("Authorization") ?? "";
    if (!apiKey.test(bearer)) return errorJson(requestId, refusal("INVALID_API_KEY"));
    let url: URL;
    let route: ParsedRoute | null = null;
    let body: unknown = {};
    try {
      url = new URL(request.url);
      const match = matchRoute(request.method, url.pathname);
      // Paths outside the contract (binary downloads, unknown routes) are the domain's to refuse.
      if (match) {
        if (request.method !== "GET" && request.body) {
          const bytes = await readLimited(
            request,
            maxBody,
            maxBody < MAX_JSON_BYTES ? "FILE_TOO_LARGE" : "INVALID_REQUEST",
          );
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes) || "{}");
        }
        route = parseRequest(request.method, url, body);
      }
    } catch (error) {
      return errorJson(
        requestId,
        error instanceof ConvexError ? publicError(error) : refusal("INVALID_REQUEST"),
      );
    }
    let result: JsonResult | Response;
    try {
      result = await handler({
        ctx,
        request,
        url,
        requestId,
        route,
        body,
        keyHash: await hashApiKey(bearer.slice(7)),
        environment: request.headers.get("X-Environment") ?? "",
        idempotencyKey: request.headers.get("Idempotency-Key") ?? "",
      });
    } catch (error) {
      return errorJson(requestId, publicError(error, options.notFound));
    }
    if (result instanceof Response)
      return route ? errorJson(requestId, refusal("UNAVAILABLE")) : result;
    return jsonAnswer(route, result, requestId);
  });
}

/** Allocate the reference before validation, and never accept a caller supplied correlation ID. */
export function observedAction(
  handler: (ctx: ActionCtx, request: Request) => Promise<Observed>,
  transport?: string,
) {
  return httpAction(async (ctx, original) => {
    const requestId = crypto.randomUUID(),
      started = Date.now();
    const headers = new Headers(original.headers);
    const proxied = Object.values(apiProxyHeaders).some((name) => headers.has(name));
    for (const name of Object.values(apiProxyHeaders)) headers.delete(name);
    headers.set("X-Request-Id", requestId);
    const request = new Request(original, { headers });
    let observed: Observed;
    try {
      // Calls through the public REST address carry the client IP signed by the Worker.
      // An installation refuses direct calls; elsewhere they stay accepted without a record.
      // A forged or stale signature is always refused.
      let ip: string | null = null;
      const { accounts, installation } = requirePlatformEnvironment();
      if (proxied || installation) {
        ip = proxied && accounts.proxy ? await verifyApiRequest(original, accounts.secret) : null;
        if (!ip) return errorJson(requestId, refusal("INVALID_REQUEST"));
      }
      let actor: string | undefined;
      // Admission precedes parsing, domain IO and per-request telemetry.
      const bearer = request.headers.get("Authorization") ?? "";
      const downloadToken = request.headers.get("X-Download-Token") ?? "";
      let retryAfter = 0;
      if (!transport && apiKey.test(bearer)) {
        const admission = await ctx.runQuery(internal.usage.restAdmissionScope, {
          keyHash: await hashApiKey(bearer.slice(7)),
        });
        // A cached admission may outlive the key: the clock here decides the expiry.
        if (admission === null || admission.expiresAt <= Date.now())
          return errorJson(requestId, refusal("INVALID_API_KEY"));
        actor = admission.actor;
        if (request.method === "GET" && admission.chargeReads)
          await ctx.runMutation(internal.usage.chargeRestRead, {
            organizationId: admission.organizationId,
            requestId,
            route: routeName(request),
          });
        retryAfter = await admitRestRequest(
          ctx,
          admission.organizationId,
          admission.actor,
          requestId,
        );
      } else if (
        request.method === "GET" &&
        downloadToken.length === 72 &&
        (transport === "documentDownload" || transport === "exportDownload")
      ) {
        const admission = await ctx.runQuery(internal.usage.downloadAdmissionScope, {
          tokenHash: await hashApiKey(downloadToken),
          kind: transport,
        });
        if (admission) {
          actor = admission.actor;
          retryAfter = await admitRestRequest(
            ctx,
            admission.organizationId,
            admission.actor,
            requestId,
          );
        }
      }
      if (ip && actor)
        try {
          await ctx.runMutation(internal.accessRecords.recordActor, { actor, ip });
        } catch {
          console.warn(JSON.stringify({ type: "access_record_unavailable", requestId }));
        }
      if (retryAfter > 0) {
        const origin = request.headers.get("Origin");
        return errorJson(requestId, refusal("RATE_LIMITED"), {
          "Retry-After": String(retryAfter),
          ...(origin && origin === process.env.SITE_URL
            ? {
                "Access-Control-Allow-Origin": origin,
                Vary: "Origin",
                "Access-Control-Expose-Headers": "Retry-After, X-Request-Id",
              }
            : {}),
        });
      }
      observed = await handler(ctx, request);
    } catch (error) {
      observed = errorJson(requestId, publicError(error));
    }
    const { response, operationId, eventId }: { response: Response } & References =
      observed instanceof Response ? { response: observed } : observed;
    let route = transport ?? "unmatched";
    try {
      route = transport ?? matchRoute(request.method, new URL(request.url).pathname)?.name ?? route;
    } catch {
      /* Do not copy paths or parser errors into logs. */
    }
    const durationMs = Date.now() - started;
    console.info(
      JSON.stringify({ type: "http", requestId, route, status: response.status, durationMs }),
    );
    const bearer = request.headers.get("Authorization") ?? "";
    if (!transport && apiKey.test(bearer)) {
      try {
        await ctx.runMutation(internal.observability.recordRequest, {
          keyHash: await hashApiKey(bearer.slice(7)),
          requestId,
          route,
          status: response.status,
          durationMs,
          ...(operationId ? { operationId } : {}),
          ...(eventId ? { eventId } : {}),
        });
      } catch {
        // A telemetry failure must not turn a committed command into an apparent failure.
        console.warn(JSON.stringify({ type: "telemetry_unavailable", requestId, route }));
      }
    }
    response.headers.set("X-Request-Id", requestId);
    return response;
  });
}
