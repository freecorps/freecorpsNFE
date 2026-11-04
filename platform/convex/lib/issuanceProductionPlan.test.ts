/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

/**
 * A malformed `deploy/issuance-production.json` names no deployment: whatever URL and mark the
 * backend has, nothing turns into the NFS-e fiscal production. Each case loads the profile
 * again with the plan replaced (`vi.doMock`), because the plan is read once per module.
 */
const PLAN_URL = "https://brave-otter-123.convex.cloud";
beforeEach(() => {
  for (const [name, value] of Object.entries({
    APP_ENV: "installation",
    PRODUCT_ENV: "production",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    WEBHOOK_MODE: "https",
    EMAIL_MODE: "disabled",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: "c".repeat(64),
    SITE_URL: "https://console.producao.invalid",
    CONVEX_SITE_URL: "https://brave-otter-123.convex.site",
    CONVEX_CLOUD_URL: PLAN_URL,
    API_URL: "https://api.producao.invalid",
    FNFE_ISSUANCE_ENV: "production",
  }))
    vi.stubEnv(name, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../../../deploy/issuance-production.json");
  vi.resetModules();
});

async function profileWith(plan: unknown) {
  vi.resetModules();
  vi.doMock("../../../deploy/issuance-production.json", () => ({ default: plan }));
  const { requirePlatformEnvironment } = await import("../environment");
  return requirePlatformEnvironment;
}

it.each([
  ["sem plano", null],
  ["versão desconhecida", { version: 2, deployment: "brave-otter-123", url: PLAN_URL }],
  ["deployment nulo com URL", { version: 1, deployment: null, url: PLAN_URL }],
  ["sem URL", { version: 1, deployment: "brave-otter-123", url: null }],
  ["URL de outro nome", { version: 1, deployment: "brave-otter-124", url: PLAN_URL }],
  [
    "URL http",
    { version: 1, deployment: "brave-otter-123", url: PLAN_URL.replace("https", "http") },
  ],
  ["URL com barra final", { version: 1, deployment: "brave-otter-123", url: `${PLAN_URL}/` }],
  ["URL em maiúsculas", { version: 1, deployment: "brave-otter-123", url: PLAN_URL.toUpperCase() }],
  ["nome malformado", { version: 1, deployment: PLAN_URL, url: PLAN_URL }],
])("plano %s não nomeia nenhum deployment", async (_, plan) => {
  const requirePlatformEnvironment = await profileWith(plan);
  expect(() => requirePlatformEnvironment()).toThrow(
    "Invalid platform configuration: FNFE_ISSUANCE_ENV",
  );
});

it("o plano bem formado nomeia o deployment da URL exata", async () => {
  const requirePlatformEnvironment = await profileWith({
    version: 1,
    deployment: "brave-otter-123",
    url: PLAN_URL,
  });
  expect(requirePlatformEnvironment()).toMatchObject({
    productEnv: "production",
    issuanceEnv: "production",
  });
});
