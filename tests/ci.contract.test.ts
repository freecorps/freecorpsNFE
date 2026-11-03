import { expect, it } from "vite-plus/test";
import { publicationSha, revision, sanitizeReport, testEnvironment } from "../scripts/lib/ci.mjs";

const head = "a".repeat(40);
const checked = "b".repeat(40);
it("preserves Windows runtime path casing without admitting unknown variables", () => {
  expect(
    testEnvironment({
      Path: "bin",
      SystemRoot: "C:/Windows",
      NODE_OPTIONS: "--inspect",
      CUSTOM_SECRET: "private",
    }),
  ).toEqual({ Path: "bin", SystemRoot: "C:/Windows" });
});
it("records the synthetic merge separately from the PR head, including draft PRs", () => {
  expect(
    revision(
      { GITHUB_SHA: checked, GITHUB_EVENT_NAME: "pull_request" },
      { pull_request: { head: { sha: head }, base: { sha: "c".repeat(40) }, draft: true } },
      checked,
    ),
  ).toMatchObject({ checkedSha: checked, headSha: head, kind: "pr-merge", draft: true });
  expect(() => revision({ GITHUB_SHA: checked }, {}, head)).toThrow();
});
it("only issues a publication SHA for a manual validation run of main", () => {
  const env = {
    GITHUB_SHA: checked,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
    GITHUB_WORKFLOW_REF:
      "freecorps/freecorpsNFE/.github/workflows/deploy-validation.yml@refs/heads/main",
  };
  expect(publicationSha(env, checked)).toBe(checked);
  for (const overrides of [
    { GITHUB_EVENT_NAME: "pull_request" },
    // The production push on main calls the same CI and must not get a SHA.
    {
      GITHUB_EVENT_NAME: "push",
      GITHUB_WORKFLOW_REF: "freecorps/freecorpsNFE/.github/workflows/deploy.yml@refs/heads/main",
    },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_WORKFLOW_REF: "freecorps/freecorpsNFE/.github/workflows/deploy.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_REF: "freecorps/freecorpsNFE/.github/workflows/ci.yml@refs/heads/main" },
    { GITHUB_REF: "refs/heads/feat/fiscal-platform-v1" },
    { GITHUB_REPOSITORY: "external/fork" },
  ])
    expect(publicationSha({ ...env, ...overrides }, checked)).toBe("");
  expect(() => publicationSha(env, head)).toThrow();
  expect(() => publicationSha(env, "")).toThrow();
});
it("does not carry provider credentials into the test subprocess", () => {
  expect(
    testEnvironment({
      PATH: "bin",
      CONVEX_DEPLOY_KEY: "private",
      BETTER_AUTH_SECRET: "private",
      GH_TOKEN: "private",
      VITE_CONVEX_URL: "shared",
      FNFE_CERT_MASTER_KEY: "private",
      ACTIONS_RUNTIME_TOKEN: "private",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private",
      CUSTOM_RUNNER_CREDENTIAL: "private",
      npm_config_registry: "private",
      CF_API_TOKEN: "private",
      NODE_OPTIONS: "--require=private",
    }),
  ).toEqual({ PATH: "bin" });
});
it("publishes counts and revision only, including failed and pending suites", () => {
  const report = sanitizeReport(
    {
      success: false,
      testResults: [
        {
          name: "/repo/tests/platform.example.test.ts",
          message: "private XML",
          assertionResults: [
            { status: "passed", fullName: "private identity" },
            { status: "failed", failureMessages: ["private password"] },
            { status: "pending" },
          ],
        },
      ],
    },
    "/repo",
    revision({}, {}, checked),
    1,
  );
  expect(report.suites.platform).toEqual({ files: 1, passed: 1, failed: 1, pending: 1 });
  expect(report.result).toBe("failed");
  expect(JSON.stringify(report)).not.toContain("private");
});
it("does not turn a missing or crashed runner report into success", () => {
  expect(sanitizeReport({}, "/repo", {}, 0).result).toBe("failed");
  expect(sanitizeReport({ success: true }, "/repo", {}, 1).result).toBe("failed");
});
