import { boundedAuthBody, clientIp, signAuthRequest } from "../../platform/auth-transport";
import { installationOrigin } from "../../platform/installation";

const site = "https://modest-seal-118.convex.site";
const consoleOrigin = "https://freecorpsnfe-validation.freecorps.workers.dev";

export async function proxyAuthentication(
  request: Request & { cf?: unknown },
  secret?: string,
  installation?: { site: string; consoleOrigin: string },
) {
  let targetSite = site,
    targetOrigin = consoleOrigin;
  if (installation) {
    try {
      targetSite = installationOrigin(installation.site);
      targetOrigin = installationOrigin(installation.consoleOrigin);
      if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Missing proxy secret");
    } catch {
      return Response.json({ code: "AUTH_CONFIGURATION_INVALID" }, { status: 503 });
    }
  }
  const url = new URL(request.url);
  if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 405 });
  const origin = request.headers.get("origin");
  if (
    url.origin !== targetOrigin ||
    (origin !== null && origin !== targetOrigin) ||
    (request.method === "POST" && origin !== targetOrigin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return Response.json({ code: "INVALID_ORIGIN" }, { status: 403 });
  const ip = clientIp(request.headers.get("cf-connecting-ip"));
  if (!request.cf || !ip)
    return Response.json({ code: "AUTH_CLIENT_IP_UNAVAILABLE" }, { status: 503 });
  let body: Uint8Array;
  try {
    body = await boundedAuthBody(request);
  } catch {
    return Response.json({ code: "AUTH_PAYLOAD_TOO_LARGE" }, { status: 413 });
  }
  // Copy only application auth headers. Caller-supplied forwarding/signature headers never pass.
  const headers = new Headers({ Origin: targetOrigin, "Content-Type": "application/json" });
  for (const name of ["better-auth-cookie", "authorization", "user-agent"])
    if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
  const forwarded = new Request(targetSite + url.pathname + url.search, {
    method: request.method,
    headers,
    ...(request.method === "POST" ? { body: new Uint8Array(body) } : {}),
    redirect: "manual",
  });
  try {
    if (secret) {
      const signature = await signAuthRequest(forwarded, body, ip, secret);
      for (const [name, value] of Object.entries(signature)) forwarded.headers.set(name, value);
    }
    const upstream = await fetch(forwarded, {
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
    // Cross-domain auth uses the explicit cookie header, not an HTTP cookie on this origin.
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const name of ["content-type", "set-better-auth-cookie", "retry-after", "x-retry-after"])
      if (upstream.headers.has(name)) responseHeaders.set(name, upstream.headers.get(name)!);
    if (upstream.status >= 300 && upstream.status < 400)
      return Response.json({ code: "AUTH_REDIRECT_REFUSED" }, { status: 502 });
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ code: "AUTH_UPSTREAM_UNAVAILABLE" }, { status: 503 });
  }
}
