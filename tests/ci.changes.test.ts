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
  optionalTasks,
  validateSkip,
} from "../scripts/lib/ci-changes.mjs";
import { findPullRequestTaskCache, TASK_CACHE_ARTIFACT } from "../scripts/lib/ci-task-cache.mjs";
import { areaFiles } from "../scripts/lib/test-projects.mjs";
import config, { runTasks } from "../vite.config";

/**
 * O job Validate escolhe no primeiro passo o que roda: só formatação e
 * credenciais numa PR só de documentação, o grafo `validate` sem as tarefas
 * que uma PR dentro dos workspaces não alcança, ou o grafo inteiro, com o cache
 * do Vite Task em PR e push na `main` e sem ele nas publicações.
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
    "docs/operacao/email.md",
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

/** The repository's workspaces, read as scripts/ci/ci-changes.mjs reads them. */
const boundaries = JSON.parse(readFileSync("scripts/build/package-boundaries.json", "utf8")) as {
  workspaces: Record<string, { kind: string }>;
};
const workspaces = Object.fromEntries(
  Object.entries(boundaries.workspaces).map(([dir, { kind }]) => [
    dir,
    { kind, manifest: JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) },
  ]),
);
const pullRequest = (files: string[] | null, deleted: string[] = []) =>
  changeMode({ eventName: "pull_request", ownWorkflow: true, files, deleted, workspaces });
const proofs = ["ci:sdk", "ci:xml-prove", "ci:distribution"];
const everyOptional = [...proofs, "ci:test:packages"];

it("runs only formatting, secrets and documentation tests when every file is documentation", () => {
  expect(pullRequest(["docs/README.md", "DESIGN.md"])).toEqual({
    mode: "docs",
    reason: "só documentação (2 arquivos)",
    skip: [],
  });
  // A deleted or renamed document can break an existence check or a link,
  // which the graph runs; nothing that only proves packages reads it.
  expect(pullRequest(["docs/README.md"], ["docs/README.md"])).toMatchObject({
    mode: "affected",
    skip: everyOptional,
  });
});

it("skips the package proofs and tests a change inside the platform workspaces cannot reach", () => {
  for (const files of [
    ["apps/console/src/routes.tsx"],
    ["platform/convex/http.ts"],
    ["platform/convex/http.ts", "apps/console/src/routes.tsx", "docs/README.md"],
    ["apps/docs/content/docs/sdk.mdx"],
  ])
    expect(pullRequest(files), files.join()).toMatchObject({
      mode: "affected",
      skip: everyOptional,
    });
  // Deleting a platform file breaks only what the graph still runs.
  expect(pullRequest(["platform/convex/old.ts"], ["platform/convex/old.ts"]).mode).toBe("affected");
  // The rate limiter is a platform package with tests in the packages area.
  expect(pullRequest(["packages/convex-rate-limiter/src/index.ts"])).toMatchObject({
    mode: "affected",
    skip: proofs,
  });
});

it("runs the whole graph when the change reaches a published package or leaves the workspaces", () => {
  const consoleFile = "apps/console/src/routes.tsx";
  for (const files of [
    // A published package, directly or as a dependency of one.
    ["packages/sdk/src/index.ts"],
    ["packages/contracts/src/index.ts"],
    ["packages/fiscal-core/src/index.ts", "platform/convex/http.ts"],
    ["packages/fiscal-nfse/src/index.ts"],
    // A manifest changes dependencies, inside a workspace too.
    ["apps/console/package.json"],
    // Outside every workspace, even next to a platform file.
    ...[
      "package.json",
      "bun.lock",
      "vite.config.ts",
      "tsconfig.json",
      "patches/convex@1.48.0.patch",
      ".github/workflows/ci.yml",
      "tests/setup/offline.ts",
      "tests/helpers/platform.ts",
      "tests/fixtures/nfe/4.00/a.xml",
      "scripts/lib/ci-changes.mjs",
      "tooling/oxlint-plugin-freecorps/index.mjs",
      "examples/quickstart.ts",
      "deploy/receipts.json",
      // Documentation a test or build reads.
      "AGENTS.md",
      "docs/v1.0/API-REFERENCE.md",
    ].map((file) => [consoleFile, file]),
  ])
    expect(pullRequest(files), files.join()).toMatchObject({ mode: "graph", skip: [] });
  // Fails open: no diff, an empty diff, no workspace list, not a pull request,
  // or ci.yml called by another workflow.
  for (const change of [
    { eventName: "pull_request", ownWorkflow: true, files: null, workspaces },
    { eventName: "pull_request", ownWorkflow: true, files: [], workspaces },
    { eventName: "pull_request", ownWorkflow: true, files: [consoleFile], workspaces: null },
    { eventName: "pull_request", ownWorkflow: true, files: [consoleFile] },
    { eventName: "pull_request", ownWorkflow: false, files: [consoleFile], workspaces },
    { eventName: "pull_request", files: ["docs/README.md"], workspaces },
    { eventName: "push", ownWorkflow: true, files: [consoleFile], workspaces },
    { eventName: "workflow_dispatch", ownWorkflow: true, files: ["docs/README.md"], workspaces },
  ])
    expect(changeMode(change), JSON.stringify(change)).toMatchObject({ mode: "graph", skip: [] });
});

it("covers with each optional group exactly the workspaces its tasks prove", () => {
  const covered = (tasks: string[]) => {
    const group = optionalTasks.find((candidate) => candidate.tasks.join() === tasks.join())!;
    return Object.entries(boundaries.workspaces)
      .filter(([dir, { kind }]) => group.covers({ dir, kind }))
      .map(([dir]) => dir)
      .sort();
  };
  // The five packages scripts/distribution/prove-distribution.mjs packs.
  expect(covered(proofs)).toEqual(
    ["contracts", "fiscal-core", "fiscal-nfe", "fiscal-nfse", "sdk"].map(
      (name) => `packages/${name}`,
    ),
  );
  // Every workspace that holds a test of the packages area.
  const dirs = Object.keys(boundaries.workspaces);
  const holders = new Set(
    areaFiles("packages").map((file) => dirs.find((dir) => file.startsWith(`${dir}/`))),
  );
  expect(holders.has(undefined)).toBe(false);
  for (const dir of holders) expect(covered(["ci:test:packages"]), dir).toContain(dir);
});

it("reads the skip list strictly and never skips a task outside the optional groups", () => {
  expect(validateSkip(undefined)).toEqual([]);
  expect(validateSkip("")).toEqual([]);
  expect(validateSkip(` ${proofs.join(",")},ci:test:packages ,ci:sdk`)).toEqual(everyOptional);
  expect(() => validateSkip("ci:check")).toThrow("ci:check");
  expect(() => validateSkip(`${proofs.join(",")},ci:sdk:build`)).toThrow("ci:sdk:build");
  // Half a group would leave ci:sdk running as a dependency of ci:distribution,
  // next to the tasks that then read the SDK built by ci:sdk:build.
  for (const partial of ["ci:sdk", "ci:sdk,ci:xml-prove", "ci:distribution"])
    expect(() => validateSkip(partial), partial).toThrow("grupo incompleto");
});

type Task = { command?: string; dependsOn?: string[] };
/** The tasks vite.config.ts builds for a CI_VALIDATE_SKIP list. */
const tasksWith = async (skip: string[]) =>
  runTasks(validateSkip(skip.join(","))) as Record<string, Task>;
/** Every task `validate` runs, its dependencies included. */
const reached = (tasks: Record<string, Task>) => {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dependency of tasks[name]!.dependsOn ?? []) visit(dependency);
  };
  visit("validate");
  return seen;
};

it("drops every skipped task from the validate graph, and builds the SDK without its proof", async () => {
  const wholeTasks = await tasksWith([]);
  // Without CI_VALIDATE_SKIP (tasks never receive it) the config is the whole graph.
  expect(config.run!.tasks).toEqual(wholeTasks);
  const whole = reached(wholeTasks);
  for (const task of everyOptional) expect(whole, task).toContain(task);
  // The whole graph is the one before #167: ci:sdk builds the SDK for its readers.
  expect(whole.has("ci:sdk:build")).toBe(false);
  const readers = ["ci:check", "ci:typecheck", "ci:console"];
  for (const reader of readers) expect(wholeTasks[reader]!.dependsOn, reader).toContain("ci:sdk");
  for (const skip of [proofs, everyOptional, ["ci:test:packages"]]) {
    const tasks = await tasksWith(skip);
    const reduced = reached(tasks);
    // A task still reached never waits on a skipped one, or the skipped one
    // would be reached too.
    expect([...whole].filter((task) => !reduced.has(task)).sort(), skip.join()).toEqual(
      [...skip].sort(),
    );
    expect(
      [...reduced].filter((task) => !whole.has(task)),
      skip.join(),
    ).toEqual(skip.includes("ci:sdk") ? ["ci:sdk:build"] : []);
    if (skip.includes("ci:sdk"))
      for (const reader of readers)
        expect(tasks[reader]!.dependsOn, reader).toEqual(expect.arrayContaining(["ci:sdk:build"]));
  }
  expect((await tasksWith(everyOptional))["ci:tests"]!.command).toBe(
    "node scripts/ci/ci.mjs collect-tests --skip packages",
  );
  expect((await tasksWith(proofs))["ci:tests"]!.command).toBe(
    "node scripts/ci/ci.mjs collect-tests",
  );
  // What licenses:check reads beyond the published packages runs in every graph.
  for (const skip of [[], everyOptional])
    expect(reached(await tasksWith(skip)), skip.join()).toContain("ci:first-party-licenses");
  expect(wholeTasks["ci:first-party-licenses"]!.command).toBe(
    "node scripts/licenses/check-first-party-licenses.mjs",
  );
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

it("issues a tested SHA only after the whole graph, never in documentation or affected mode", () => {
  const graph = "steps.changes.outputs.mode=='graph'";
  const anyGraph = "steps.changes.outputs.mode!='docs'";
  expect(named("Classify the change").run).toBe("node scripts/ci/ci-changes.mjs");
  expect(named("Classify the change")).not.toHaveProperty("if");
  for (const [name, condition] of [
    ["Install pinned age", anyGraph],
    ["Build, check and test", anyGraph],
    ["Check independent package boundaries", anyGraph],
    // The SDK package exists only when ci:sdk ran, and the approval needs
    // every test area.
    ["Locate the current SDK validation package", graph],
    ["Approve the checked revision", graph],
    ["Require successful checks for the same commit", graph],
  ] as const) {
    expect(expression(named(name).if), name).toBe(condition);
    expect(named(name), name).not.toHaveProperty("continue-on-error");
  }
  // The affected mode's skip list reaches the graph and the summary.
  for (const name of ["Build, check and test", "Summarize suites and pending coverage"])
    expect(expression(named(name).env!.CI_VALIDATE_SKIP), name).toBe("steps.changes.outputs.skip");
  const docs = named("Check documentation");
  expect(expression(docs.if)).toBe("steps.changes.outputs.mode=='docs'");
  expect(docs.run!.trim().split("\n")).toEqual([
    "vp fmt --check",
    "node scripts/public-copy/check-secrets.mjs",
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

it("gates every pull request on budget.json against the base it merges into", () => {
  const gate = named("Require the label for a budget increase");
  expect(expression(gate.if)).toBe("github.event_name=='pull_request'");
  expect(gate.run).toBe("node scripts/ci/budget.mjs compare --base HEAD^1");
  expect(gate).not.toHaveProperty("continue-on-error");
  expect(expression(gate.env!.PR_NUMBER)).toBe("github.event.pull_request.number");
  const at = (name: string) => steps.findIndex((step) => step.name === name);
  expect(at("Build, check and test")).toBeLessThan(at("Require the label for a budget increase"));
  expect(at("Require the label for a budget increase")).toBeLessThan(
    at("Approve the checked revision"),
  );
});

it("keys the task cache by runner and run, and passes the token only to push steps and the budget gate", () => {
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
    "Require the label for a budget increase",
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
  // Actions treats '' as false: with '' as the truthy branch the graph would
  // always run --no-cache, as the first run of #87 did.
  expect(expression(named("Build, check and test").env!.TASK_CACHE)).toBe(
    "steps.changes.outputs.cache!='true'&&'--no-cache'||''",
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
  "scripts/deploy/platform-unchanged.test.ts -> docs/README.md": "synthetic",
  "scripts/deploy/platform-unchanged.test.ts -> docs/desenvolvimento/ci.md": "synthetic",
  "scripts/public-copy/public-tree.test.ts -> docs/operacao/backup.md": "synthetic",
  "scripts/repo/adr-status.test.ts -> docs/README.md": "synthetic",
  "scripts/repo/doc-links.test.ts -> docs/ARQUITETURA.md": "synthetic",
  // Read by scripts/repo/docs-claims.test.ts, which documentationTests runs in
  // documentation mode too.
  "scripts/repo/docs-claims.test.ts -> docs/README.md": "documentation test",
  "scripts/repo/docs-claims.test.ts -> docs/plataforma/arquitetura-backend.md":
    "documentation test",
  "scripts/repo/docs-claims.test.ts -> docs/desenvolvimento/lint.md": "documentation test",
  // tests/fixtureCorpus.test.ts checks that evidence exists; deleting a document
  // runs the graph.
  "tests/coverage-matrix.json -> docs/plataforma/IMPORTS.md": "existence",
  "tests/coverage-matrix.json -> docs/plataforma/ISSUANCE.md": "existence",
};
// scripts/public-copy/public-tree.mjs names every file the public copy keeps or edits; its
// test runs in documentation mode (documentationTests).
const classifier = "scripts/public-copy/public-tree.mjs";

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
