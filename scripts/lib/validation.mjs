import { readFileSync } from "node:fs";
import { isProjectRepository } from "./repository.mjs";
import { accountPolicy, accountEnvironmentNames } from "../../platform/account-policy.mjs";

const INTEGRATION_BRANCH = "main";
const EXPECTED_ENVIRONMENT = Object.freeze({
  APP_ENV: "validation",
  PRODUCT_ENV: "sandbox",
  FISCAL_ENV: "disabled",
  FNFE_CRONS: "off",
  EMAIL_MODE: "disabled",
  WEBHOOK_MODE: "disabled",
  SITE_URL: "https://freecorpsnfe-validation.freecorps.workers.dev",
});

export const validationTarget = JSON.parse(
  readFileSync(new URL("../../platform/validation.json", import.meta.url), "utf8"),
);

/** No default deployment lookup, project keys, production keys or URL overrides. */
export function validateTarget(env, target = validationTarget) {
  const environment = target.environment;
  if (
    target.branch !== INTEGRATION_BRANCH ||
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.keys(environment).length !== Object.keys(EXPECTED_ENVIRONMENT).length ||
    Object.entries(EXPECTED_ENVIRONMENT).some(([name, value]) => environment[name] !== value)
  ) {
    throw new Error("Validation manifest violates fixed branch or environment invariants");
  }
  if (
    target.deploymentType !== "dev" ||
    target.deploymentName !== "modest-seal-118" ||
    target.reference !== "dev/fiscal-platform-v1-validation" ||
    target.expiresAt !== null ||
    target.url !== "https://modest-seal-118.convex.cloud" ||
    target.siteUrl !== "https://modest-seal-118.convex.site"
  ) {
    throw new Error("Target is not the registered persistent validation deployment");
  }
  const expected = {
    VALIDATION_CONVEX_DEPLOYMENT: target.deploymentName,
    VALIDATION_CONVEX_URL: target.url,
    VALIDATION_CONVEX_SITE_URL: target.siteUrl,
    APP_ENV: "validation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (env[name] !== undefined && env[name] !== value) {
      throw new Error(`Unexpected ${name}; no writes performed`);
    }
  }
  const key = env.VALIDATION_CONVEX_DEPLOY_KEY;
  if (typeof key !== "string" || !/^dev:modest-seal-118\|[^\s|]+$/.test(key)) {
    throw new Error("A deployment-scoped dev key for validation is required");
  }
  // A stale generic key must not silently take precedence over the scoped one.
  if (env.CONVEX_DEPLOY_KEY || env.CONVEX_SELF_HOSTED_ADMIN_KEY || env.CONVEX_SELF_HOSTED_URL) {
    throw new Error("Remove generic Convex credentials before using validation commands");
  }
  if (/^prod(?::|$)/.test(env.CONVEX_DEPLOYMENT ?? "")) {
    throw new Error("Production selector is not allowed in validation commands");
  }
  return { target, key };
}

export function validationChildEnv(env, key) {
  const result = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !/^(CLOUDFLARE_|ACCOUNT_|AUTH_PROXY_|CONVEX_|VALIDATION_|FNFE_|VITE_|CLERK_|RESEND_|BETTER_AUTH_|NODE_OPTIONS$)/i.test(
          name,
        ),
    ),
  );
  return { ...result, CONVEX_DEPLOY_KEY: key };
}

export async function backendRequest(context, path, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${context.target.url}${path}`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Convex ${context.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Validation backend HTTP ${response.status}`);
  const result = await response.json();
  if (result.status === "error") throw new Error("Validation backend rejected the operation");
  return result;
}

export async function verifyRemoteEnvironment(context, fetchImpl = fetch) {
  const response = await backendRequest(
    context,
    "/api/query",
    { path: "_system/cli/queryEnvironmentVariables", args: {}, format: "json" },
    fetchImpl,
  );
  const actual = Object.fromEntries(response.value.map(({ name, value }) => [name, value]));
  const expected = { ...EXPECTED_ENVIRONMENT, EMAIL_MODE: actual.EMAIL_MODE };
  accountPolicy(actual);
  if (
    Object.keys(actual).some(
      (name) =>
        !Object.hasOwn(expected, name) &&
        name !== "BETTER_AUTH_SECRET" &&
        !accountEnvironmentNames.includes(name),
    ) ||
    Object.entries(expected).some(([name, value]) => actual[name] !== value) ||
    typeof actual.BETTER_AUTH_SECRET !== "string" ||
    actual.BETTER_AUTH_SECRET.length < 32
  ) {
    throw new Error(
      "Remote environment differs from the bootstrap allowlist; inspect names in the dashboard",
    );
  }
}

export function requireIntegrationWriter(env, bootstrap) {
  if (bootstrap) {
    if (env.GITHUB_ACTIONS === "true")
      throw new Error("Bootstrap is a local operator exception only");
    return;
  }
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== `refs/heads/${INTEGRATION_BRANCH}` ||
    !isProjectRepository(env.GITHUB_REPOSITORY) ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch"
  ) {
    throw new Error(
      "Shared writes require the integration pipeline; initial operator setup uses --bootstrap",
    );
  }
}
