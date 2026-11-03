import { afterEach, expect, it, vi } from "vite-plus/test";
import { proxyAuthentication } from "../apps/console/auth-proxy";
import { proxyApi } from "../apps/console/api-proxy";
import {
  signAuthRequest,
  verifyAuthRequest,
  signApiRequest,
  verifyApiRequest,
  clientIp,
  ipBucket,
} from "../platform/auth-transport";

const origin = "https://freecorpsnfe-validation.freecorps.workers.dev";
const secret = "a".repeat(64);
const bytes = new TextEncoder().encode(JSON.stringify({ email: "synthetic@validation.invalid" }));
afterEach(() => vi.unstubAllGlobals());
function incoming(headers: Record<string, string> = {}, body: Uint8Array = bytes, method = "POST") {
  const request = new Request(`${origin}/api/auth/sign-in/email`, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...headers,
    },
    ...(method === "POST" ? { body: new Uint8Array(body) } : {}),
  });
  Object.defineProperty(request, "cf", { value: {} });
  return request;
}
it("overwrites forged forwarding headers and signs the actual edge IP, body, method and origin", async () => {
  const fetch = vi.fn(async (request: Request) => {
    expect(request.url).toBe("https://modest-seal-118.convex.site/api/auth/sign-in/email");
    expect(request.headers.get("x-forwarded-for")).toBeNull();
    expect(request.headers.get("x-better-auth-forwarded-host")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
    expect(
      await verifyAuthRequest(request, new Uint8Array(await request.arrayBuffer()), secret),
    ).toBe("203.0.113.7");
    return Response.json(
      { success: true },
      {
        headers: {
          "set-better-auth-cookie": "synthetic",
          "set-cookie": "should-not-reach-client",
          "x-private": "private",
        },
      },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const result = await proxyAuthentication(
    incoming({
      "x-forwarded-for": "192.0.2.1",
      "x-fnfe-auth-ip": "192.0.2.1",
      "x-fnfe-auth-signature": "forged",
      "x-better-auth-forwarded-host": "foreign.invalid",
      Cookie: "browser-cookie",
    }),
    secret,
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("set-better-auth-cookie")).toBe("synthetic");
  expect(result.headers.get("set-cookie")).toBeNull();
  expect(result.headers.get("x-private")).toBeNull();
  expect(result.headers.get("cache-control")).toBe("no-store");
});
it("rejects changed signed fields and stale or wrong-key signatures", async () => {
  const request = incoming();
  const signature = await signAuthRequest(request, bytes, "203.0.113.7", secret);
  for (const [name, value] of Object.entries(signature)) request.headers.set(name, value);
  expect(await verifyAuthRequest(request, bytes, secret)).toBe("203.0.113.7");
  expect(await verifyAuthRequest(request, new TextEncoder().encode("tampered"), secret)).toBeNull();
  expect(await verifyAuthRequest(request, bytes, "b".repeat(64))).toBeNull();
  expect(await verifyAuthRequest(request, bytes, secret, Date.now() + 31_000)).toBeNull();
  for (const [header, value] of [
    ["x-fnfe-auth-ip", "192.0.2.3"],
    ["origin", "https://foreign.invalid"],
  ]) {
    const changed = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body: new Uint8Array(bytes),
    });
    changed.headers.set(header, value);
    expect(await verifyAuthRequest(changed, bytes, secret)).toBeNull();
  }
  const changedPath = new Request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: request.headers,
    body: bytes,
  });
  expect(await verifyAuthRequest(changedPath, bytes, secret)).toBeNull();
});
it("rejects foreign origins, missing edge IP, oversized bodies and redirects", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { Location: "https://foreign.invalid" } }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    (await proxyAuthentication(incoming({ Origin: "https://foreign.invalid" }), secret)).status,
  ).toBe(403);
  expect((await proxyAuthentication(incoming({ "cf-connecting-ip": "" }), secret)).status).toBe(
    503,
  );
  expect((await proxyAuthentication(incoming({}, new Uint8Array(32769)), secret)).status).toBe(413);
  expect(fetch).not.toHaveBeenCalled();
  expect((await proxyAuthentication(incoming(), secret)).status).toBe(502);
});
it("accepts same-origin GETs without Origin and fails closed on upstream errors", async () => {
  const request = incoming({ "sec-fetch-site": "same-origin" }, bytes, "GET");
  request.headers.delete("origin");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("private upstream diagnostic");
    }),
  );
  const result = await proxyAuthentication(request, secret);
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ code: "AUTH_UPSTREAM_UNAVAILABLE" });
});
it("normalizes IPv6 and rejects chains, ports and malformed IPv4", () => {
  expect(clientIp("2001:0DB8:1:2::1234")).toBe("2001:db8:1:2::1234");
  expect(ipBucket(clientIp("2001:db8:1:2::1234")!)).toBe(ipBucket(clientIp("2001:db8:1:2::beef")!));
  for (const value of [
    "203.0.113.1, 192.0.2.1",
    "203.0.113.1:123",
    "256.0.0.1",
    "01.2.3.4",
    "::bad::ip",
  ])
    expect(clientIp(value)).toBeNull();
});
it("forwards REST calls with the edge IP signed, streaming body and response unchanged", async () => {
  const api = "https://api.example.invalid";
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://backend.example.invalid/v1/imports?x=1");
    const headers = new Headers(init.headers);
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("cf-connecting-ip")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer synthetic");
    expect(await verifyApiRequest({ method: "POST", url, headers }, secret)).toBe("203.0.113.7");
    // An auth signature over the same fields never verifies as an API signature.
    expect(
      await verifyAuthRequest(new Request(url, { method: "POST", headers }), bytes, secret),
    ).toBeNull();
    expect(new Uint8Array(await new Response(init.body).arrayBuffer())).toEqual(bytes);
    return new Response("created", { status: 202, headers: { "x-request-id": "r1" } });
  });
  vi.stubGlobal("fetch", fetch);
  const request = new Request(`${api}/v1/imports?x=1`, {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic",
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "192.0.2.1",
      "x-fnfe-api-ip": "192.0.2.1",
      "x-fnfe-api-signature": "forged",
    },
    body: new Uint8Array(bytes),
  });
  Object.defineProperty(request, "cf", { value: {} });
  const result = await proxyApi(request, secret, "https://backend.example.invalid");
  expect(result.status).toBe(202);
  expect(await result.text()).toBe("created");
  expect(result.headers.get("x-request-id")).toBe("r1");
  const other = new Request(`${api}/login`, { headers: { "cf-connecting-ip": "203.0.113.7" } });
  Object.defineProperty(other, "cf", { value: {} });
  expect((await proxyApi(other, secret, "https://backend.example.invalid")).status).toBe(404);
  expect((await proxyApi(request, undefined, "https://backend.example.invalid")).status).toBe(503);
  const noIp = new Request(`${api}/v1/companies`);
  Object.defineProperty(noIp, "cf", { value: {} });
  expect((await proxyApi(noIp, secret, "https://backend.example.invalid")).status).toBe(503);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("refuses stale API signatures and changed paths", async () => {
  const url = "https://backend.example.invalid/v1/companies";
  const headers = new Headers(
    await signApiRequest({ method: "GET", url }, "203.0.113.7", secret, 1_000_000_000_000),
  );
  expect(await verifyApiRequest({ method: "GET", url, headers }, secret, 1_000_000_000_000)).toBe(
    "203.0.113.7",
  );
  expect(
    await verifyApiRequest({ method: "GET", url, headers }, secret, 1_000_000_031_000),
  ).toBeNull();
  expect(
    await verifyApiRequest({ method: "GET", url: url + "/x", headers }, secret, 1_000_000_000_000),
  ).toBeNull();
  expect(
    await verifyApiRequest({ method: "POST", url, headers }, secret, 1_000_000_000_000),
  ).toBeNull();
});
