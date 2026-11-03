import { expect, it } from "vite-plus/test";
import {
  browserPlan,
  browserTarget,
  accessibilityCounts,
  accessibilityBlocked,
  browserStep,
} from "../scripts/lib/browser-validation.mjs";

const sha = "a".repeat(40);
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: sha,
  CI_TESTED_SHA: sha,
  VALIDATION_E2E_SHA: sha,
  VALIDATION_SMOKE_EMAIL: "viewer@validation.invalid",
  VALIDATION_SMOKE_PASSWORD: "synthetic-not-a-real-password",
};
it("runs only a viewer after an approved publication of the exact checkout", () => {
  expect(browserPlan(env, sha, null, { sha, state: "validated" })).toMatchObject({
    mode: "smoke",
    sha,
    accounts: [{ role: "viewer" }],
  });
  for (const overrides of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { VALIDATION_E2E_CANDIDATE_CSS: "1" },
    { GITHUB_REPOSITORY: "attacker/fork" },
    { GITHUB_REF: "refs/heads/feat/fiscal-platform-v1" },
    { GITHUB_EVENT_NAME: "push" },
    { CI_TESTED_SHA: "b".repeat(40) },
    { VALIDATION_E2E_SHA: "b".repeat(40) },
    { VALIDATION_SMOKE_EMAIL: "customer@example.com" },
    { VALIDATION_SMOKE_PASSWORD: "short" },
  ])
    expect(() =>
      browserPlan({ ...env, ...overrides }, sha, null, { sha, state: "validated" }),
    ).toThrow();
});
it("does not authenticate against partial, stale or absent publication receipts", () => {
  for (const receipt of [
    null,
    { sha, state: "partial" },
    { sha: "b".repeat(40), state: "validated" },
  ])
    expect(() => browserPlan(env, sha, null, receipt)).toThrow();
  expect(browserPlan(env, sha, null, { sha, state: "obsolete" })).toEqual({
    sha,
    mode: "obsolete",
    accounts: [],
  });
});
it("requires complete synthetic review accounts and refuses passing them to CI", () => {
  const accounts = {
    url: browserTarget.consoleUrl,
    accounts: ["viewer", "operator", "none"].map((role) => ({
      role,
      email: `${role}@validation.invalid`,
      password: env.VALIDATION_SMOKE_PASSWORD,
      created: true,
    })),
  };
  expect(browserPlan({ VALIDATION_E2E_SHA: sha }, sha, accounts).mode).toBe("review");
  expect(() => browserPlan(env, sha, accounts, { sha, state: "validated" })).toThrow();
  for (const invalid of [
    { ...accounts, url: "https://production.example" },
    { ...accounts, accounts: accounts.accounts.slice(0, 2) },
    { ...accounts, accounts: accounts.accounts.map((a) => ({ ...a, role: "viewer" })) },
    { ...accounts, accounts: accounts.accounts.map((a) => ({ ...a, created: false })) },
  ])
    expect(() => browserPlan({ VALIDATION_E2E_SHA: sha }, sha, invalid)).toThrow();
});
it("removes private DOM and messages while preserving blocking accessibility evidence", () => {
  const result = accessibilityCounts({
    violations: [
      {
        id: "color-contrast",
        impact: "serious",
        description: "private",
        nodes: [{ html: "private password", target: "private identity" }],
      },
    ],
    incomplete: [{ html: "private" }],
  });
  expect(result).toEqual({
    violations: [{ id: "color-contrast", impact: "serious", nodes: 1 }],
    needsManualReview: 1,
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(accessibilityBlocked(result)).toBe(true);
  expect(accessibilityBlocked({ violations: [{ impact: "minor" }] })).toBe(false);
});

it("records the failed step, Playwright method and error class without the error message", async () => {
  const secret = "synthetic-not-a-real-password";
  const report: Record<string, unknown> = {};
  await expect(browserStep(report, "open-login:goto", "page.goto", async () => "ok")).resolves.toBe(
    "ok",
  );
  expect(report).toEqual({ checkpoint: "open-login:goto" });
  const failure = new Error(`locator.fill: Timeout 30000ms exceeded filling "${secret}"`);
  failure.name = "TimeoutError";
  await expect(
    browserStep(report, "open-login:password", "locator.fill", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(report).toEqual({
    checkpoint: "open-login:password",
    failure: {
      checkpoint: "open-login:password",
      method: "locator.fill",
      error: "TimeoutError",
      cause: "timeout",
    },
  });
  expect(JSON.stringify(report)).not.toContain(secret);
  const forged = new Error("x");
  forged.name = secret.replaceAll("-", " ");
  await expect(
    browserStep(report, "open-login:email", "locator.fill", async () => {
      throw forged;
    }),
  ).rejects.toBe(forged);
  expect(report.failure).toEqual({
    checkpoint: "open-login:email",
    method: "locator.fill",
    error: "unknown",
    cause: "unknown",
  });
});

it("maps known Playwright failures to fixed causes without copying the message", async () => {
  const secret = "synthetic-not-a-real-password";
  const cases: Array<[string, string, string]> = [
    [
      "page.goto",
      `page.goto: net::ERR_CONNECTION_RESET at https://example.test/login?p=${secret}`,
      "ERR_CONNECTION_RESET",
    ],
    [
      "page.goto",
      "page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.test/login",
      "ERR_HTTP2_PROTOCOL_ERROR",
    ],
    [
      "locator.fill",
      `locator.fill: Error: strict mode violation: getByLabel("${secret}") resolved to 2 elements`,
      "strict-mode-violation",
    ],
    [
      "locator.fill",
      `locator.fill: Target page, context or browser has been closed\n${secret}`,
      "target-closed",
    ],
    ["page.goto", `page.goto: net::ERR_${secret}`, "unknown"],
    // A filled value echoed in the message must not select a code or a label.
    [
      "locator.fill",
      'locator.fill: Timeout 30000ms exceeded filling "net::ERR_HUNTER_TWO!"',
      "timeout",
    ],
    [
      "locator.fill",
      'locator.fill: Timeout 30000ms exceeded filling "strict mode violation: has been closed"',
      "timeout",
    ],
    ["locator.fill", "page.goto: net::ERR_HUNTER_TWO at https://example.test", "unknown"],
  ];
  for (const [method, message, cause] of cases) {
    const report: Record<string, unknown> = {};
    await expect(
      browserStep(report, "open-login:goto", method, async () => {
        throw new Error(message);
      }),
    ).rejects.toThrow();
    expect(report.failure).toEqual({
      checkpoint: "open-login:goto",
      method,
      error: "Error",
      cause,
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("HUNTER");
  }
});
