import { RateLimiter } from "@convex-dev/rate-limiter";
import type { GenericCtx } from "@convex-dev/better-auth";
import type { DataModel } from "../_generated/dataModel";
import { components } from "../_generated/api";
import {
  authProxyHeaders,
  boundedAuthBody,
  digest,
  ipBucket,
  verifyAuthRequest,
} from "../../auth-transport";
import { recipientAllowed } from "../../account-policy.mjs";
import { requirePlatformEnvironment } from "../environment";

const limiter = new RateLimiter(components.rateLimiter);
/** Only these reads transfer their local budget out of Better Auth. */
export function localSessionRoute(request: Request) {
  if (request.method !== "GET") return null;
  // Match Better Auth's trailing-slash normalization so aliases share the budget.
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  return ["/api/auth/get-session", "/api/auth/convex/token", "/api/auth/convex/jwks"].includes(path)
    ? path
    : null;
}

const publicMetadata = new Set([
  "/api/auth/convex/jwks",
  "/api/auth/convex/.well-known/openid-configuration",
]);
const knownRoutes = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/sign-out",
  "/get-session",
  "/convex/token",
  "/change-password",
  "/change-email",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/list-sessions",
  "/update-user",
  "/email-otp/send-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/forget-password/email-otp",
]);

export const accountInitiationRoutes = new Set([
  "/sign-up/email",
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
]);
export function accountRequestAccepted() {
  return Response.json(
    { requestAccepted: true, delivery: "unconfirmed" },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}

export async function prepareAuthRequest(
  ctx: GenericCtx<DataModel>,
  request: Request,
): Promise<Request | Response> {
  const { local, accounts, siteUrl } = requirePlatformEnvironment();
  if (local) {
    const route = localSessionRoute(request);
    if (!route) return request;
    if (!("runMutation" in ctx))
      return Response.json({ code: "AUTH_UNAVAILABLE" }, { status: 503 });
    // One atomic, persistent budget per route across all local sessions. Requests
    // cannot postpone the window boundary or choose a bucket with forged IPs.
    const result = await limiter.limit(ctx, "local-auth-session", {
      key: route,
      config: { kind: "fixed window", rate: 30, period: 60_000, capacity: 30, start: 0 },
    });
    if (!result.ok) {
      const retryAfter = String(Math.max(1, Math.ceil(result.retryAfter / 1000)));
      return Response.json(
        { code: "TOO_MANY_REQUESTS" },
        { status: 429, headers: { "Retry-After": retryAfter, "X-Retry-After": retryAfter } },
      );
    }
    return request;
  }
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && publicMetadata.has(path)) return request;
  let ip: string | null = null;
  let body: Uint8Array;
  try {
    body = await boundedAuthBody(request);
  } catch {
    return Response.json({ code: "AUTH_PAYLOAD_TOO_LARGE" }, { status: 413 });
  }
  if (accounts.proxy) {
    ip = await verifyAuthRequest(request, body, accounts.secret);
    if (!ip) return Response.json({ code: "AUTH_PROXY_REQUIRED" }, { status: 403 });
  }
  if (request.method === "POST" && request.headers.get("origin") !== siteUrl)
    return Response.json({ code: "INVALID_ORIGIN" }, { status: 403 });
  // Off mode keeps the historical shared bucket. It never trusts caller-supplied IPs.
  if (!("runMutation" in ctx)) return Response.json({ code: "AUTH_UNAVAILABLE" }, { status: 503 });
  const requestedRoute = path.replace(/^\/api\/auth/, "");
  const route = knownRoutes.has(requestedRoute) ? requestedRoute : "other";
  const max = route.includes("email-otp")
    ? 3
    : ["/sign-in/email", "/sign-up/email", "/change-password", "/change-email"].includes(route)
      ? 5
      : 30;
  const result = await limiter.limit(ctx, "auth-request", {
    key: await digest(`${ip ? ipBucket(ip) : "no-trusted-ip"}|${route}`),
    config: { kind: "fixed window", rate: max, period: 60_000, capacity: max, start: 0 },
  });
  if (!result.ok) {
    const retryAfter = String(Math.max(1, Math.ceil(result.retryAfter / 1000)));
    return Response.json(
      { code: "TOO_MANY_REQUESTS" },
      { status: 429, headers: { "Retry-After": retryAfter, "X-Retry-After": retryAfter } },
    );
  }
  if (request.method === "POST" && accountInitiationRoutes.has(requestedRoute)) {
    if (!accounts.enabled) return Response.json({ code: "ACCOUNT_FLOW_DISABLED" }, { status: 400 });
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
    const email =
      input && typeof input === "object" && "email" in input && typeof input.email === "string"
        ? input.email.trim().toLowerCase()
        : "";
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    // Run before the allowlist and account lookup, including for unknown/denied emails.
    const recipient = await limitAccountMail(ctx, email);
    if (!recipient.ok) {
      const retryAfter = String(Math.max(1, Math.ceil(recipient.retryAfter / 1000)));
      return Response.json(
        { code: "TOO_MANY_REQUESTS" },
        { status: 429, headers: { "Retry-After": retryAfter, "X-Retry-After": retryAfter } },
      );
    }
    if (!recipientAllowed(accounts, email)) return accountRequestAccepted();
  }
  const headers = new Headers(request.headers);
  // Snapshot before deleting: iterating live Headers would skip adjacent entries.
  const headerNames = Array.from(headers.keys());
  for (const name of headerNames)
    if (
      /^(x-forwarded-|x-real-ip|cf-connecting-|true-client-ip|x-better-auth-forwarded-|x-fnfe-auth-)/i.test(
        name,
      )
    )
      headers.delete(name);
  if (ip) headers.set(authProxyHeaders.ip, ip);
  return new Request(request.url, {
    method: request.method,
    headers,
    ...(request.method === "POST" ? { body: new Uint8Array(body) } : {}),
  });
}

export async function limitAccountMail(ctx: GenericCtx<DataModel>, email: string) {
  if (!("runMutation" in ctx)) throw new Error("Account mail requires a write context");
  return limiter.limit(ctx, "account-mail", {
    key: await digest(email.trim().toLowerCase()),
    config: { kind: "fixed window", rate: 3, capacity: 3, period: 60_000, start: 0 },
  });
}
