import { expect, it } from "vite-plus/test";
import {
  approvedTests,
  areaReceipt,
  collectTests,
  pendingBudget,
  publicationSha,
  revision,
  sanitizeReport,
  testEnvironment,
} from "../scripts/lib/ci.mjs";
import { testProjects } from "../scripts/lib/test-projects.mjs";

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
          name: "/repo/platform/convex/example.test.ts",
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

const areas = testProjects.map(({ name }) => name);
const passing = (area: string, files = 2) => ({
  schemaVersion: 1,
  area,
  result: "passed",
  files,
  passed: 3,
  failed: 0,
  pending: 0,
  ranOn: { sha: head, runId: "1" },
});
const everyArea = (files = 2): Record<string, ReturnType<typeof passing>> =>
  Object.fromEntries(areas.map((area) => [area, passing(area, files)]));
const expected = (files = 2) => Object.fromEntries(areas.map((area) => [area, files]));
it("records an area receipt from counts only, never the revision", () => {
  const raw = {
    success: true,
    testResults: [
      {
        name: "/repo/platform/convex/example.test.ts",
        assertionResults: [
          { status: "passed", fullName: "private identity" },
          { status: "skipped" },
        ],
      },
    ],
  };
  const receipt = areaReceipt(raw, "/repo", "platform", 0, {
    GITHUB_SHA: checked,
    GITHUB_RUN_ID: "7",
  });
  expect(receipt).toEqual({
    schemaVersion: 1,
    area: "platform",
    result: "passed",
    files: 1,
    passed: 1,
    failed: 0,
    pending: 1,
    ranOn: { sha: checked, runId: "7" },
  });
  expect(JSON.stringify(receipt)).not.toContain("private");
  expect(areaReceipt(raw, "/repo", "platform", 0, {}).ranOn).toBeNull();
  // A crash, a failed exit or a file from another area never passes.
  expect(areaReceipt({}, "/repo", "platform", 0).result).toBe("failed");
  expect(areaReceipt(raw, "/repo", "platform", 1).result).toBe("failed");
  // An area that ran no file fails before the cache stores its receipt.
  expect(areaReceipt({ success: true, testResults: [] }, "/repo", "platform", 0).result).toBe(
    "failed",
  );
  expect(() => areaReceipt(raw, "/repo", "console", 0)).toThrow("outside the area");
});
it("approves the checkout only with a passing receipt for every area under its revision", () => {
  const metadata = revision({}, {}, checked);
  const report = collectTests(metadata, everyArea(), expected());
  expect(report.result).toBe("passed");
  expect(Object.keys(report.areas)).toEqual(areas);
  expect(approvedTests(metadata, report)).toBe(true);
  // A replayed receipt (another run's SHA) is still valid evidence for these inputs.
  expect(report.areas.platform).toMatchObject({ result: "passed", ranOn: { sha: head } });
  // A receipt's ranOn keeps only the shape areaReceipt writes.
  for (const ranOn of ["abc", 7, { sha: null }, { sha: "short", runId: "1" }]) {
    const odd = { ...everyArea(), platform: { ...passing("platform"), ranOn } };
    expect(collectTests(metadata, odd as never, expected()).areas.platform!.ranOn).toBeNull();
  }
  expect(
    collectTests(
      metadata,
      {
        ...everyArea(),
        platform: { ...passing("platform"), ranOn: { sha: head, runId: 9 } },
      } as never,
      expected(),
    ).areas.platform!.ranOn,
  ).toEqual({ sha: head, runId: null });
  // Another checkout's tests.json does not approve this one.
  expect(approvedTests(revision({}, {}, head), report)).toBe(false);
  for (const area of areas) {
    const missing = everyArea();
    delete missing[area];
    const failed = { ...everyArea(), [area]: { ...passing(area), result: "failed", failed: 1 } };
    const fewer = { ...everyArea(), [area]: passing(area, 1) };
    const other = { ...everyArea(), [area]: passing(areas.find((name) => name !== area)!) };
    for (const receipts of [missing, failed, fewer, other]) {
      const collected = collectTests(metadata, receipts, expected());
      expect(collected.result, area).toBe("failed");
      expect(collected.areas[area]!.result).not.toBe("passed");
      expect(approvedTests(metadata, collected)).toBe(false);
    }
  }
  // The whole-suite report of `ci:test` (schema 1) never approves the graph.
  expect(approvedTests(metadata, { ...report, schemaVersion: 1 })).toBe(false);
});
it("fails an area that skips more tests than its budget under CI, and only there", () => {
  const ci = { CI: "true" };
  // Every budget names an area of the graph, with a ceiling and the reason for it.
  for (const [area, budget] of Object.entries(pendingBudget)) {
    expect(areas).toContain(area);
    expect(Number.isInteger(budget.max) && budget.max > 0, area).toBe(true);
    expect(budget.reason.length, area).toBeGreaterThan(20);
  }
  const metadata = revision({}, {}, checked);
  for (const area of areas) {
    const max = pendingBudget[area]?.max ?? 0;
    const at = { ...everyArea(), [area]: { ...passing(area), pending: max } };
    const over = { ...everyArea(), [area]: { ...passing(area), pending: max + 1 } };
    expect(collectTests(metadata, at, expected(), ci).result, area).toBe("passed");
    const collected = collectTests(metadata, over, expected(), ci);
    expect(collected.result, area).toBe("failed");
    expect(collected.areas[area]).toMatchObject({ result: "failed", pending: max + 1 });
    expect(approvedTests(metadata, collected)).toBe(false);
    // On a developer machine (Windows, no age) the same receipt is not judged.
    expect(collectTests(metadata, over, expected()).result, area).toBe("passed");
  }
  // The receipt itself fails, so the task cache never keeps a run over budget.
  const raw = (file: string, skipped: number) => ({
    success: true,
    testResults: [
      {
        name: `/repo/${file}`,
        assertionResults: [
          { status: "passed" },
          ...Array.from({ length: skipped }, () => ({ status: "skipped" })),
        ],
      },
    ],
  });
  const platform = "platform/convex/example.test.ts";
  expect(areaReceipt(raw(platform, 1), "/repo", "platform", 0, ci).result).toBe("failed");
  expect(areaReceipt(raw(platform, 1), "/repo", "platform", 0, {}).result).toBe("passed");
  const tooling = "scripts/example.test.ts";
  const toolingMax = pendingBudget.tooling!.max;
  expect(areaReceipt(raw(tooling, toolingMax), "/repo", "tooling", 0, ci).result).toBe("passed");
  expect(areaReceipt(raw(tooling, toolingMax + 1), "/repo", "tooling", 0, ci).result).toBe(
    "failed",
  );
});
