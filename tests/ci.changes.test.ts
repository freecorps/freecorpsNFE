import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { parse } from "yaml";
import {
  cacheAllowed,
  changeMode,
  consumedDocumentation,
  documentationOnly,
  documentationTests,
} from "../scripts/lib/ci-changes.mjs";
import { findPullRequestTaskCache, TASK_CACHE_ARTIFACT } from "../scripts/lib/ci-task-cache.mjs";
import { areaFiles } from "../scripts/lib/test-projects.mjs";

/**
 * O job Validate escolhe no primeiro passo o que roda: só formatação e
 * credenciais numa PR só de documentação, ou o grafo `validate`, com o cache do
 * Vite Task em PR e push na `main` e sem ele nas publicações.
 */
const repository = "freecorps/freecorpsNFE";
const sha = "a".repeat(40);
const head = "b".repeat(40);

it("treats as documentation only the Markdown that no task but formatting reads", () => {
  for (const file of [
    "docs/adr/0012-periodo-por-aniversario.md",
    "docs/desenvolvimento/ci.md",
    "docs/plataforma/ISSUANCE.md",
    "docs/README.md",
    "CHANGELOG.md",
    "DESIGN.md",
    "CLAUDE.md",
    ".agents/README.md",
    ".agents/skills/ci-maintenance/privileged-workflows.md",
  ])
    expect(documentationOnly(file), file).toBe(true);
  for (const file of [
    // Read by tests or builds.
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "CONTRIBUICOES.md",
    "LICENSING.md",
    "docs/worktrees.md",
    "docs/operacao/deploy-producao.md",
    "docs/operacao/suporte-email.md",
    "docs/v1.0/ACCEPTANCE.md",
    "docs/v1.0/API-REFERENCE.md",
    "docs/termos/arquivo/termos-de-uso-v1.md",
    "docs/licenses/DISTRIBUTION.md",
    ".agents/skills/ci-maintenance/SKILL.md",
    ".agents/skills/EXTERNAS.md",
    ".claude/skills/ci-maintenance/SKILL.md",
    // Not Markdown, or Markdown outside the documentation paths.
    "docs/v1.0/openapi.json",
    "apps/docs/content/docs/primeira-chamada.mdx",
    "packages/sdk/README.md",
    "platform/convex/_generated/ai/guidelines.md",
    "tests/fixtures/fiscal-v1/README.md",
    ".github/pull_request_template.md",
    "docs/adr/0001.txt",
  ])
    expect(documentationOnly(file), file).toBe(false);
});

it("runs the graph unless every changed file of a pull request is documentation", () => {
  expect(changeMode({ eventName: "pull_request", files: ["docs/README.md", "DESIGN.md"] })).toEqual(
    { mode: "docs", reason: "só documentação (2 arquivos)" },
  );
  for (const change of [
    { eventName: "pull_request", files: ["docs/README.md", "vite.config.ts"] },
    { eventName: "pull_request", files: ["docs/README.md", "AGENTS.md"] },
    // A deleted or renamed document can break an existence check or a link.
    { eventName: "pull_request", files: ["docs/README.md"], deleted: ["docs/README.md"] },
    // Fails open: no diff, an empty diff, or not a pull request.
    { eventName: "pull_request", files: null },
    { eventName: "pull_request", files: [] },
    { eventName: "push", files: ["docs/README.md"] },
    { eventName: "workflow_dispatch", files: ["docs/README.md"] },
  ])
    expect(changeMode(change).mode, JSON.stringify(change)).toBe("graph");
});

it("uses the task cache only in this workflow's own pull request and push runs", () => {
  const own = {
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/pull/9/merge`,
  };
  expect(cacheAllowed({ ...own, GITHUB_EVENT_NAME: "pull_request" })).toBe(true);
  expect(
    cacheAllowed({
      ...own,
      GITHUB_EVENT_NAME: "push",
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
    }),
  ).toBe(true);
  // Manual runs and the publications that call ci.yml run every task.
  for (const env of [
    { ...own, GITHUB_EVENT_NAME: "workflow_dispatch" },
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy-validation.yml@refs/heads/main`,
    },
    {
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "push",
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy.yml@refs/heads/main`,
    },
    { GITHUB_EVENT_NAME: "pull_request" },
  ])
    expect(cacheAllowed(env), JSON.stringify(env)).toBe(false);
});

/** Fake GitHub API over a table of `path -> JSON`. */
const api = (routes: Record<string, unknown>) => async (path: string) => {
  const key = Object.keys(routes).find((route) => path.startsWith(route));
  if (!key) throw new Error(`GET ${path}: HTTP 404`);
  return routes[key];
};
const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 9,
  merge_commit_sha: sha,
  head: { sha: head, repo: { full_name: repository } },
  ...overrides,
});
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 41,
  path: ".github/workflows/ci.yml",
  event: "pull_request",
  conclusion: "success",
  head_sha: head,
  head_repository: { full_name: repository },
  repository: { full_name: repository },
  created_at: "2026-11-03T10:00:00Z",
  ...overrides,
});
const artifact = { name: TASK_CACHE_ARTIFACT, expired: false };

it("replays on main the task cache of the merged pull request's latest passing run", async () => {
  const found = await findPullRequestTaskCache({
    get: api({
      [`/commits/${sha}/pulls`]: [pull({ number: 8, merge_commit_sha: "c".repeat(40) }), pull()],
      "/actions/runs?": {
        workflow_runs: [
          run({ id: 40, created_at: "2026-11-03T09:00:00Z" }),
          run(),
          run({ id: 42, path: ".github/workflows/public-scan.yml" }),
        ],
      },
      "/actions/runs/41/artifacts": { artifacts: [artifact] },
    }),
    sha,
    repository,
  });
  expect(found.runId).toBe("41");
});

it("never replays a fork's, another workflow's or an expired cache", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no merged PR", { [`/commits/${sha}/pulls`]: [pull({ merge_commit_sha: head })] }],
    [
      "fork",
      {
        [`/commits/${sha}/pulls`]: [
          pull({ head: { sha: head, repo: { full_name: "someone/freecorpsNFE" } } }),
        ],
      },
    ],
    [
      "fork run",
      {
        [`/commits/${sha}/pulls`]: [pull()],
        "/actions/runs?": {
          workflow_runs: [run({ head_repository: { full_name: "someone/freecorpsNFE" } })],
        },
      },
    ],
    [
      "other workflow, event or head",
      {
        [`/commits/${sha}/pulls`]: [pull()],
        "/actions/runs?": {
          workflow_runs: [
            run({ path: ".github/workflows/public-scan.yml" }),
            run({ event: "push" }),
            run({ head_sha: sha }),
            run({ conclusion: "failure" }),
          ],
        },
      },
    ],
    [
      "expired or missing artifact",
      {
        [`/commits/${sha}/pulls`]: [pull()],
        "/actions/runs?": { workflow_runs: [run()] },
        "/actions/runs/41/artifacts": { artifacts: [{ ...artifact, expired: true }] },
      },
    ],
  ];
  for (const [name, routes] of cases)
    expect(
      (await findPullRequestTaskCache({ get: api(routes), sha, repository })).runId,
      name,
    ).toBe(null);
});

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  on: Record<string, unknown>;
  jobs: Record<string, { steps: Step[]; permissions: Record<string, string> }>;
};
const steps = workflow.jobs.validate!.steps;
const expression = (value: unknown) =>
  String(value)
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .replace(/\s+/g, "");
const named = (name: string) => {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`No step ${name}`);
  return step;
};

it("issues a tested SHA only after the whole graph, never in documentation mode", () => {
  const graph = "steps.changes.outputs.mode=='graph'";
  expect(named("Classify the change").run).toBe("node scripts/ci-changes.mjs");
  expect(named("Classify the change")).not.toHaveProperty("if");
  for (const name of [
    "Build, check and test",
    "Check independent package boundaries",
    "Approve the checked revision",
    "Require successful checks for the same commit",
  ]) {
    expect(expression(named(name).if), name).toBe(graph);
    expect(named(name), name).not.toHaveProperty("continue-on-error");
  }
  const docs = named("Check documentation");
  expect(expression(docs.if)).toBe("steps.changes.outputs.mode=='docs'");
  expect(docs.run!.trim().split("\n")).toEqual([
    "vp fmt --check",
    "node scripts/check-secrets.mjs",
    `vp test run ${documentationTests.join(" ")}`,
  ]);
  for (const file of documentationTests) expect(existsSync(file), file).toBe(true);
  // Every check comes before the approval.
  const at = (name: string) => steps.findIndex((step) => step.name === name);
  expect(at("Build, check and test")).toBeLessThan(at("Approve the checked revision"));
  expect(at("Approve the checked revision")).toBeLessThan(
    at("Require successful checks for the same commit"),
  );
});

it("keys the task cache by runner and run, and passes the token only to push steps", () => {
  const restore = named("Restore the task cache");
  expect(restore.uses).toMatch(/^actions\/cache\/restore@[a-f0-9]{40}$/);
  expect(restore.with!.path).toBe("node_modules/.vite/task-cache");
  // Vite+ guide: OS, architecture and run, never a hash of sources or the lockfile.
  expect(restore.with!.key).toBe(
    "vite-task-${{ runner.os }}-${{ runner.arch }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(String(restore.with!.key)).not.toContain("hashFiles");
  expect(String(restore.with!["restore-keys"]).trim()).toBe(
    "vite-task-${{ runner.os }}-${{ runner.arch }}-",
  );
  // The restore follows the install, which could recreate node_modules.
  const at = (name: string) => steps.findIndex((step) => step.name === name);
  expect(at("Install locked dependencies")).toBeLessThan(at("Restore the task cache"));
  const tokenSteps = steps.filter((step) => JSON.stringify(step).includes("github.token"));
  expect(tokenSteps.map((step) => step.name)).toEqual([
    "Find the merged pull request's task cache",
    "Download the merged pull request's task cache",
  ]);
  expect(expression(named("Find the merged pull request's task cache").if)).toBe(
    "steps.changes.outputs.cache=='true'&&github.event_name=='push'",
  );
  // Fetching another run's cache never fails the job.
  for (const name of [
    "Download the merged pull request's task cache",
    "Use the merged pull request's task cache",
    "Upload the task cache for main",
    "Save the task cache",
  ])
    expect(named(name)["continue-on-error"], name).toBe(true);
  // Only a pull request run uploads the cache main replays.
  const upload = named("Upload the task cache for main");
  expect(expression(upload.if)).toBe(
    "steps.changes.outputs.cache=='true'&&github.event_name=='pull_request'",
  );
  expect(upload.with!.name).toBe(TASK_CACHE_ARTIFACT);
  expect(named("Download the merged pull request's task cache").with!.name).toBe(
    TASK_CACHE_ARTIFACT,
  );
  expect(workflow.jobs.validate!.permissions).toEqual({
    contents: "read",
    actions: "read",
    "pull-requests": "read",
  });
});

/**
 * Sources that quote a documentation-only path without reading its content,
 * each with the reason. Anything else that quotes one is a possible reader: move
 * the file to `consumedDocumentation` or, if it is only a mention, add it here.
 */
const mentions: Record<string, string> = {
  // Provenance of the survey, never opened.
  "packages/fiscal-nfe/schemas/portal-survey.json -> docs/plataforma/NFE-SCHEMAS.md": "mention",
  // A link in an operator-facing message.
  "platform/convex/captures.ts -> docs/operacao/captura-fiscal.md": "mention",
  // Synthetic paths in classifiers' unit tests.
  "scripts/platform-unchanged.test.ts -> docs/README.md": "synthetic",
  "scripts/platform-unchanged.test.ts -> docs/desenvolvimento/ci.md": "synthetic",
  "scripts/public-tree.test.ts -> docs/operacao/backup.md": "synthetic",
  // tests/fixtureCorpus.test.ts checks that evidence exists; deleting a document
  // runs the graph.
  "tests/coverage-matrix.json -> docs/plataforma/IMPORTS.md": "existence",
  "tests/coverage-matrix.json -> docs/plataforma/ISSUANCE.md": "existence",
};
// scripts/public-tree.mjs names every file the public copy keeps or edits; its
// test runs in documentation mode (documentationTests).
const classifier = "scripts/public-tree.mjs";

it("never lets a documentation-only change skip a test or build that reads it", () => {
  // Every tracked documentation-only file, checked against every other source:
  // none quotes its path outside the known mentions. The list in
  // scripts/lib/ci-changes.mjs came from the inputs Vite Task recorded for each
  // task; this catches a new reader by its literal path.
  const tracked = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const documentation = tracked.filter(documentationOnly);
  expect(documentation.length).toBeGreaterThan(100);
  const sources = tracked.filter(
    (file) =>
      /\.(ts|tsx|mts|mjs|js|cjs|json|jsonc|yml|yaml)$/.test(file) &&
      !/^(docs|\.agents|\.claude)\//.test(file) &&
      ![classifier, "tests/ci.changes.test.ts", "scripts/lib/ci-changes.mjs"].includes(file),
  );
  const found: string[] = [];
  for (const source of sources) {
    const text = readFileSync(source, "utf8");
    for (const file of documentation) {
      // A quoted path, relative to the root or with leading `../`.
      const quoted = new RegExp(
        `["'\`](?:\\.\\./)*${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`,
      );
      if (quoted.test(text)) found.push(`${source} -> ${file}`);
    }
  }
  expect(found.filter((entry) => !(entry in mentions))).toEqual([]);
  // A mention that no longer exists leaves the list.
  expect(Object.keys(mentions).filter((entry) => !found.includes(entry))).toEqual([]);
  expect(documentationTests).toContain(classifier.replace(/\.mjs$/, ".test.ts"));
  // They read the whole tree, as this test does, so they share the area that
  // reruns on any change and leave `tooling` to its own inputs.
  for (const file of [...documentationTests, "tests/ci.changes.test.ts"])
    expect(areaFiles("repository"), file).toContain(file);
  // The exclusions stay specific: none swallows the documentation paths whole.
  expect(consumedDocumentation).not.toContain("docs/**");
});
