/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { convexTest } from "convex-test";
import schema from "../platform/convex/schema";
import { internal } from "../platform/convex/_generated/api";
import { requirePlatformEnvironment } from "../platform/convex/environment";
import { proxyAuthentication } from "../apps/console/auth-proxy";
import { signApiRequest, verifyAuthRequest } from "../platform/auth-transport";

const modules = import.meta.glob("../platform/convex/**/*.ts");
const origin = "https://console.operator.invalid";
const site = "https://api.operator.invalid";
const secret = "b".repeat(64);
beforeEach(() => {
  for (const [name, value] of Object.entries({
    APP_ENV: "installation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    WEBHOOK_MODE: "disabled",
    EMAIL_MODE: "disabled",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: secret,
    SITE_URL: origin,
    CONVEX_SITE_URL: site,
    API_URL: "https://rest.operator.invalid",
  }))
    vi.stubEnv(name, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("accepts an operator origin and reports it without enabling fiscal or collector access", async () => {
  const t = convexTest(schema, modules);
  expect(requirePlatformEnvironment()).toMatchObject({
    profile: "installation",
    local: false,
    appEnv: "installation",
    siteUrl: origin,
    apiUrl: "https://rest.operator.invalid",
    fiscalEnv: "disabled",
  });
  expect(await (await t.fetch("/health")).json()).toMatchObject({
    appEnv: "installation",
    productEnv: "sandbox",
    fiscalEnv: "disabled",
  });
  await expect(
    t.query(internal.mail.inbox, { email: "synthetic@operator.invalid" }),
  ).rejects.toThrow("Local mailbox unavailable");
  await expect(t.query(internal.testing.restoreProof.assertEmpty, {})).rejects.toThrow(
    "Local synthetic proof only",
  );
});
it("refuses direct REST calls and admits only those signed by the Worker", async () => {
  const t = convexTest(schema, modules);
  const direct = await t.fetch("/v1/companies");
  expect(direct.status).toBe(400);
  expect((await direct.json()).error.code).toBe("INVALID_REQUEST");
  const headers = await signApiRequest(
    { method: "GET", url: `${site}/v1/companies` },
    "203.0.113.4",
    secret,
  );
  const proxied = await t.fetch("/v1/companies", { headers });
  expect(proxied.status).toBe(401);
  expect((await proxied.json()).error.code).toBe("INVALID_API_KEY");
  expect((await t.fetch("/health")).status).toBe(200);
});
it.each([
  ["SITE_URL", "http://console.operator.invalid"],
  ["SITE_URL", origin + "/path"],
  ["SITE_URL", "https://user:password@operator.invalid"],
  ["SITE_URL", "https://localhost"],
  ["CONVEX_SITE_URL", "http://127.0.0.1:3211"],
  ["API_URL", undefined],
  ["API_URL", "http://rest.operator.invalid"],
  ["AUTH_PROXY_MODE", "disabled"],
  ["AUTH_PROXY_SECRET", ""],
  ["FISCAL_ENV", "production"],
  ["FISCAL_ENV", "homologation"],
  ["FNFE_CRONS", "on"],
  ["PRODUCT_ENV", "production"],
  ["EMAIL_MODE", "local"],
])("refuses unsafe installation setting %s=%s", (name, value) => {
  vi.stubEnv(name, value);
  expect(() => requirePlatformEnvironment()).toThrow();
});
it("refuses the NFS-e fiscal production mark while no deployment is named", async () => {
  const t = convexTest(schema, modules);
  // `deploy/issuance-production.json` names no deployment: nothing turns into fiscal production.
  for (const url of [
    "https://elated-possum-295.convex.cloud",
    "https://modest-seal-118.convex.cloud",
    "https://brave-otter-123.convex.cloud",
    undefined,
  ])
    for (const mark of ["production", "", "disabled"]) {
      vi.stubEnv("CONVEX_CLOUD_URL", url);
      vi.stubEnv("FNFE_ISSUANCE_ENV", mark);
      expect(() => requirePlatformEnvironment()).toThrow(
        "Invalid platform configuration: FNFE_ISSUANCE_ENV",
      );
      vi.stubEnv("PRODUCT_ENV", "production");
      expect(() => requirePlatformEnvironment()).toThrow(
        "Invalid platform configuration: FNFE_ISSUANCE_ENV",
      );
      expect((await t.fetch("/health")).status).toBe(503);
      vi.stubEnv("PRODUCT_ENV", "sandbox");
    }
  vi.stubEnv("FNFE_ISSUANCE_ENV", undefined);
  expect(await (await t.fetch("/health")).json()).toMatchObject({
    productEnv: "sandbox",
    issuanceEnv: "disabled",
  });
});
it("keeps validation pinned to its existing origin", () => {
  vi.stubEnv("APP_ENV", "validation");
  expect(() => requirePlatformEnvironment()).toThrow("SITE_URL");
});
it("signs only the configured installation and rejects a caller-selected origin", async () => {
  const send = vi.fn(async (request: Request) => {
    expect(request.url).toBe(site + "/api/auth/get-session");
    expect(await verifyAuthRequest(request, new Uint8Array(), secret)).toBe("203.0.113.20");
    return Response.json(null);
  });
  vi.stubGlobal("fetch", send);
  const request = new Request(origin + "/api/auth/get-session", {
    headers: { "cf-connecting-ip": "203.0.113.20" },
  });
  Object.defineProperty(request, "cf", { value: {} });
  expect((await proxyAuthentication(request, secret, { site, consoleOrigin: origin })).status).toBe(
    200,
  );
  expect(
    (await proxyAuthentication(request, secret, { site, consoleOrigin: "https://foreign.invalid" }))
      .status,
  ).toBe(403);
  expect(
    (await proxyAuthentication(request, undefined, { site, consoleOrigin: origin })).status,
  ).toBe(503);
  expect(
    (
      await proxyAuthentication(request, secret, {
        site: "http://localhost:3211",
        consoleOrigin: origin,
      })
    ).status,
  ).toBe(503);
  expect(send).toHaveBeenCalledTimes(1);
});
