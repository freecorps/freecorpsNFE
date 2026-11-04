import { afterEach, expect, it, vi } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  requireIntegrationWriter,
  validateTarget,
  validationChildEnv,
  validationTarget,
  verifyRemoteEnvironment,
} from "../scripts/lib/validation.mjs";

const key = "dev:modest-seal-118|synthetic-test-key";
afterEach(() => vi.restoreAllMocks());

it.each([
  "prod:elated-possum-295|never-a-real-key",
  "dev:happy-animal-123|never-a-real-key",
  "preview:freecorps:freecorpsnfe|never-a-real-key",
  "project:freecorps:freecorpsnfe|never-a-real-key",
  "",
])(
  "rejects the wrong credential in the real deploy command before network I/O: %s",
  (credential) => {
    const script = fileURLToPath(new URL("../scripts/validation/validation.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [script, "deploy", "--bootstrap"], {
      env: { ...process.env, VALIDATION_CONVEX_DEPLOY_KEY: credential },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("A deployment-scoped dev key for validation is required");
    expect(child.stdout).not.toContain("target:");
    expect(child.stderr).not.toContain(credential || "never-a-real-key");
  },
);

it.each([
  { VALIDATION_CONVEX_URL: "https://elated-possum-295.convex.cloud" },
  { VALIDATION_CONVEX_DEPLOYMENT: "elated-possum-295" },
  { VALIDATION_CONVEX_SITE_URL: "https://elated-possum-295.convex.site" },
  { APP_ENV: "production" },
  { PRODUCT_ENV: "production" },
  { FISCAL_ENV: "homologation" },
  { CONVEX_DEPLOY_KEY: "prod:elated-possum-295|synthetic" },
  { CONVEX_DEPLOYMENT: "prod:elated-possum-295" },
  { CONVEX_SELF_HOSTED_URL: "https://other.example" },
])("rejects conflicting deployment inputs: %j", (overrides) => {
  expect(() => validateTarget({ VALIDATION_CONVEX_DEPLOY_KEY: key, ...overrides })).toThrow();
});

it("does not trust a manifest changed to production or a temporary preview", () => {
  for (const change of [
    { deploymentName: "elated-possum-295" },
    { deploymentType: "prod" },
    { expiresAt: 1 },
  ]) {
    expect(() =>
      validateTarget({ VALIDATION_CONVEX_DEPLOY_KEY: key }, { ...validationTarget, ...change }),
    ).toThrow();
  }
});

it("removes inherited selectors and provider credentials from the Convex child", () => {
  const env = validationChildEnv(
    {
      PATH: "bin",
      CONVEX_DEPLOYMENT: "prod:other",
      CONVEX_PROVISION_HOST: "https://other.example",
      CONVEX_AGENT_MODE: "anonymous",
      FNFE_CERT_MASTER_KEY: "synthetic",
      VITE_CONVEX_URL: "https://other.example",
      RESEND_API_KEY: "synthetic",
      CLOUDFLARE_EMAIL_API_TOKEN: "synthetic",
      ACCOUNT_EMAIL_RECIPIENTS: "private",
      AUTH_PROXY_SECRET: "private",
      VALIDATION_CONVEX_DEPLOY_KEY: key,
    },
    key,
  );
  expect(env).toEqual({ PATH: "bin", CONVEX_DEPLOY_KEY: key });
});

it.each([
  { branch: "feat/fiscal-platform-v1" },
  { environment: { ...validationTarget.environment, RESEND_API_KEY: "synthetic" } },
  { environment: { ...validationTarget.environment, EMAIL_MODE: "enabled" } },
  { environment: null },
  { environment: {} },
])("refuses manifest changes that weaken the shared environment contract: %j", (change) => {
  expect(() =>
    validateTarget({ VALIDATION_CONVEX_DEPLOY_KEY: key }, { ...validationTarget, ...change }),
  ).toThrow("fixed branch or environment invariants");
});

it("compares manifest environment fields without depending on JSON property order", () => {
  const environment = Object.fromEntries(Object.entries(validationTarget.environment).reverse());
  expect(() =>
    validateTarget({ VALIDATION_CONVEX_DEPLOY_KEY: key }, { ...validationTarget, environment }),
  ).not.toThrow();
});

it("only permits the integration pipeline and an explicit local bootstrap to write", () => {
  const pipeline = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  };
  expect(() => requireIntegrationWriter(pipeline, false)).not.toThrow();
  expect(() => requireIntegrationWriter(pipeline, true)).toThrow();
  expect(() => requireIntegrationWriter({}, true)).not.toThrow();
  for (const overrides of [
    { GITHUB_REF: "refs/heads/feat/fiscal-platform-v1" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "fork/repo" },
  ]) {
    expect(() => requireIntegrationWriter({ ...pipeline, ...overrides }, false)).toThrow();
    expect(() => requireIntegrationWriter({ ...pipeline, ...overrides }, true)).toThrow();
  }
  expect(() => requireIntegrationWriter({}, false)).toThrow();
});

it("authenticates only against the fixed host and refuses remote credential or mode drift", async () => {
  const context = validateTarget({ VALIDATION_CONVEX_DEPLOY_KEY: key });
  const variables = Object.entries(validationTarget.environment).map(([name, value]) => ({
    name,
    value,
  }));
  variables.push({ name: "BETTER_AUTH_SECRET", value: "synthetic-secret-for-tests-32-characters" });
  const fetcher = vi.fn().mockResolvedValue(Response.json({ status: "success", value: variables }));
  await verifyRemoteEnvironment(context, fetcher);
  expect(fetcher).toHaveBeenCalledWith(
    "https://modest-seal-118.convex.cloud/api/query",
    expect.objectContaining({ redirect: "error" }),
  );
  for (const invalid of [
    variables.slice(1),
    [...variables, { name: "RESEND_API_KEY", value: "must-never-print" }],
  ]) {
    fetcher.mockResolvedValue(Response.json({ status: "success", value: invalid }));
    await expect(verifyRemoteEnvironment(context, fetcher)).rejects.toThrow(
      "Remote environment differs",
    );
  }
});

it("accepts only a complete controlled Cloudflare configuration in remote preflight", async () => {
  const context = validateTarget({ VALIDATION_CONVEX_DEPLOY_KEY: key });
  const env = {
    ...validationTarget.environment,
    BETTER_AUTH_SECRET: "a".repeat(48),
    EMAIL_MODE: "cloudflare",
    AUTH_PROXY_MODE: "signed",
    AUTH_PROXY_SECRET: "b".repeat(64),
    CLOUDFLARE_EMAIL_API_TOKEN: "synthetic-provider-token",
    ACCOUNT_EMAIL_FROM: "sender@validation.invalid",
    ACCOUNT_EMAIL_RECIPIENTS: "recipient@validation.invalid",
  };
  const fetcher = (environment: Record<string, string>) =>
    vi.fn(async () =>
      Response.json({
        status: "success",
        value: Object.entries(environment).map(([name, value]) => ({ name, value })),
      }),
    );
  await verifyRemoteEnvironment(context, fetcher(env));
  for (const overrides of [
    { AUTH_PROXY_MODE: "disabled" },
    { ACCOUNT_EMAIL_RECIPIENTS: "" },
    { EMAIL_MODE: "resend" },
    { EMAIL_MODE: "disabled" },
    { AUTH_PROXY_SECRET: "private-short-secret" },
  ])
    await expect(
      verifyRemoteEnvironment(context, fetcher({ ...env, ...overrides })),
    ).rejects.toThrow();
});
