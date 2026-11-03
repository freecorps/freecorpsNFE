import { clientIp, signApiRequest } from "../../platform/auth-transport";
import { installationOrigin } from "../../platform/installation";

const methods = new Set(["GET", "HEAD", "POST", "PATCH", "OPTIONS"]);
// Forwarding and proxy headers come only from this Worker, never from the caller.
const dropped =
  /^(host|connection|keep-alive|transfer-encoding|upgrade|cf-[a-z-]+|x-forwarded-[a-z-]+|x-real-ip|true-client-ip|forwarded|x-fnfe-[a-z-]+)$/i;

/** Public REST address. Streams body and response, adding the signed client IP. */
export async function proxyApi(
  request: Request & { cf?: unknown },
  secret: string | undefined,
  backendSite: string | undefined,
) {
  let site: string;
  try {
    site = installationOrigin(backendSite);
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Missing proxy secret");
  } catch {
    return Response.json({ code: "API_CONFIGURATION_INVALID" }, { status: 503 });
  }
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/") && url.pathname !== "/health")
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  if (!methods.has(request.method)) return new Response(null, { status: 405 });
  const ip = clientIp(request.headers.get("cf-connecting-ip"));
  if (!request.cf || !ip)
    return Response.json({ code: "API_CLIENT_IP_UNAVAILABLE" }, { status: 503 });
  const headers = new Headers();
  for (const [name, value] of request.headers) if (!dropped.test(name)) headers.set(name, value);
  const target = site + url.pathname + url.search;
  for (const [name, value] of Object.entries(
    await signApiRequest({ method: request.method, url: target }, ip, secret),
  ))
    headers.set(name, value);
  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body } : {}),
      redirect: "manual",
    });
    return new Response(upstream.body, upstream);
  } catch {
    return Response.json({ code: "API_UPSTREAM_UNAVAILABLE" }, { status: 503 });
  }
}
