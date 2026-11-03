import { describe, expect, it, vi } from "vite-plus/test";
import { reusableValidation } from "../scripts/lib/validation-reuse.mjs";

const main = "a".repeat(40);
const before = "b".repeat(40);
const head = "c".repeat(40);
const merge = "d".repeat(40);
const other = "e".repeat(40);
const env = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
  GITHUB_SHA: main,
};
const pull = {
  number: 74,
  merged_at: "2026-11-03T23:06:14Z",
  merge_commit_sha: main,
  base: { ref: "main" },
  head: { sha: head },
};
const run = (id: number) => ({
  id,
  run_attempt: 1,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  conclusion: "success",
  head_sha: head,
  repository: { full_name: "freecorps/freecorpsNFE" },
});
const revision = { checkedSha: merge, headSha: head, baseSha: before, kind: "pr-merge" };

// The world of a PR that entered main up to date: its synthetic merge, validated by the PR CI,
// has the main commit's tree and the previous main as first parent.
function world(
  overrides: {
    pulls?: unknown[];
    runs?: unknown[];
    revisions?: Record<number, unknown>;
    trees?: Record<string, string | null>;
    parents?: Record<string, string[] | null>;
    fetchable?: string[];
  } = {},
) {
  const trees = overrides.trees ?? { [main]: "tree-1", [merge]: "tree-1" };
  const parents = overrides.parents ?? { [merge]: [before, head] };
  const fetchable = overrides.fetchable ?? [merge];
  const github = vi.fn(async (path: string) => {
    if (path === `commits/${main}/pulls`) return overrides.pulls ?? [pull];
    if (path.startsWith("actions/workflows/ci.yml/runs?"))
      return { workflow_runs: overrides.runs ?? [run(1)] };
    throw new Error(`unexpected ${path}`);
  });
  const revisionOf = vi.fn(
    async ({ id }: { id: number }) => (overrides.revisions ?? { 1: revision })[id] ?? null,
  );
  const git = {
    fetch: vi.fn((sha: string) => fetchable.includes(sha)),
    tree: (sha: string) => trees[sha] ?? null,
    parents: (sha: string) => parents[sha] ?? null,
  };
  return { env, event: { before }, github, revisionOf, git };
}

describe("reusableValidation", () => {
  it("reuses the PR validation of the same tree against the same previous main", async () => {
    const options = world();
    const result = await reusableValidation(options);
    expect(result.testedSha).toBe(main);
    expect(result.reason).toContain("PR #74");
    // Only the final head's successful pull_request runs of ci.yml are listed.
    expect(options.github).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`event=pull_request&status=success&head_sha=${head}(&|$)`)),
    );
    expect(options.git.fetch).toHaveBeenCalledWith(merge);
  });

  it("only considers a push to main of the project repository with a previous main", async () => {
    for (const [overrides, event] of [
      [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, { before }],
      [{ GITHUB_REF: "refs/heads/feature" }, { before }],
      [{ GITHUB_REPOSITORY: "external/fork" }, { before }],
      [{ GITHUB_SHA: "not-a-sha" }, { before }],
      [{}, { before: "0".repeat(40) }],
      [{}, {}],
    ] as const) {
      const options = { ...world(), env: { ...env, ...overrides }, event };
      expect((await reusableValidation(options)).testedSha).toBe("");
      expect(options.github).not.toHaveBeenCalled();
    }
  });

  it("requires the commit to be the merge of a pull request into main", async () => {
    for (const pulls of [
      [],
      [{ ...pull, merged_at: null }],
      [{ ...pull, merge_commit_sha: other }],
      [{ ...pull, base: { ref: "release" } }],
    ]) {
      const result = await reusableValidation(world({ pulls }));
      expect(result).toEqual({ testedSha: "", reason: expect.stringContaining("not the merge") });
    }
  });

  it("ignores runs that are not a successful pull_request CI of the final head", async () => {
    for (const changed of [
      { event: "push" },
      { path: ".github/workflows/deploy.yml" },
      { conclusion: "failure" },
      { head_sha: other },
      { repository: { full_name: "external/fork" } },
    ]) {
      const result = await reusableValidation(world({ runs: [{ ...run(1), ...changed }] }));
      expect(result.testedSha, JSON.stringify(changed)).toBe("");
    }
  });

  it("validates again when the PR was validated against an older main", async () => {
    // The PR entered without the merges that main received after its CI.
    const result = await reusableValidation(
      world({ revisions: { 1: { ...revision, baseSha: other } } }),
    );
    expect(result.testedSha).toBe("");
    expect(result.reason).toContain(`validated against ${other}`);
  });

  it("validates again when the validated merge has another tree or other parents", async () => {
    expect(
      (await reusableValidation(world({ trees: { [main]: "tree-1", [merge]: "tree-2" } })))
        .testedSha,
    ).toBe("");
    expect(
      (await reusableValidation(world({ parents: { [merge]: [head, before] } }))).testedSha,
    ).toBe("");
    expect(
      (await reusableValidation(world({ parents: { [merge]: [before, other] } }))).testedSha,
    ).toBe("");
    expect((await reusableValidation(world({ parents: { [merge]: [before] } }))).testedSha).toBe(
      "",
    );
  });

  it("validates again when the revision or the merge cannot be read", async () => {
    for (const revisions of [
      {},
      { 1: { ...revision, kind: "commit" } },
      { 1: { ...revision, headSha: other } },
      { 1: { ...revision, checkedSha: "short" } },
    ])
      expect((await reusableValidation(world({ revisions }))).testedSha).toBe("");
    expect((await reusableValidation(world({ fetchable: [] }))).testedSha).toBe("");
    expect((await reusableValidation(world({ trees: { [merge]: "tree-1" } }))).reason).toContain(
      "tree of the main commit",
    );
  });

  it("checks the next successful run when one has no usable record", async () => {
    const result = await reusableValidation(
      world({ runs: [run(2), run(1)], revisions: { 1: revision } }),
    );
    expect(result.testedSha).toBe(main);
    expect(result.reason).toContain("CI run 1");
  });

  it("lets GitHub API errors reach the caller, which validates again", async () => {
    const options = world();
    options.github.mockRejectedValueOnce(new Error("GitHub API commits: 502"));
    await expect(reusableValidation(options)).rejects.toThrow("502");
  });
});
