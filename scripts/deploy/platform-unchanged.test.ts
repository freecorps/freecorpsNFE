import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { parse } from "yaml";
import {
  changedFiles,
  maxChangedFiles,
  publishedRevision,
  unchangedPublication,
  undeployed,
} from "../lib/platform-unchanged.mjs";
import { publishRevision } from "../lib/validation-deploy.mjs";

const target = {
  site: "https://site.example",
  frontend: "https://frontend.example",
  api: "https://api.example",
};
const published = "a".repeat(40);
const sha = "b".repeat(40);
const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const serving = (shas: Record<string, string>) =>
  vi.fn((url: string) => answer({ sha: shas[new URL(url).origin] ?? published }));

it("publishes everything a build reads and skips only tests, CI, agents and internal docs", () => {
  for (const file of [
    "platform/convex/keys.test.ts",
    "apps/console/src/navigation.test.tsx",
    "scripts/deploy/platform-unchanged.test.ts",
    "apps/console/e2e/m0.mjs",
    ".github/workflows/ci.yml",
    ".agents/skills/x/SKILL.md",
    "docs/desenvolvimento/ci.md",
    "docs/operacao/deploy-producao.md",
    "docs/README.md",
    "AGENTS.md",
    "README.md",
  ])
    expect(undeployed(file), file).toBe(true);
  for (const file of [
    // A documentação pública lê o OpenAPI e cita as licenças.
    "docs/v1.0/openapi.json",
    "docs/v1.0/evidence/49/README.md",
    "LICENSING.md",
    "LICENSES/MIT.txt",
    "apps/docs/content/docs/primeira-chamada.mdx",
    "apps/console/src/navigation.tsx",
    "platform/convex/keys.ts",
    "packages/fiscal-nfe/src/parser.ts",
    "deploy/platform-release.json",
    "scripts/console/console.mjs",
    "examples/nfe-demonstracao.xml",
    "package.json",
    "bun.lock",
    "vite.config.ts",
  ])
    expect(undeployed(file), file).toBe(false);
});

it("reads the revision only when backend, frontend and API serve the same one", async () => {
  const request = serving({});
  expect(await publishedRevision(target, request)).toBe(published);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "https://site.example/health",
    "https://frontend.example/build.json",
    "https://api.example/health",
  ]);
  // Uma publicação parcial: o frontend ficou na revisão anterior.
  expect(await publishedRevision(target, serving({ "https://frontend.example": sha }))).toBeNull();
  expect(await publishedRevision(target, () => answer({ sha: published }, 503))).toBeNull();
  expect(await publishedRevision(target, () => answer({ sha: "abc" }))).toBeNull();
  expect(await publishedRevision(target, () => Promise.reject(new Error("offline")))).toBeNull();
});

it("lists the changes from an ancestor, both sides of a rename, and refuses anything else", () => {
  const repo = mkdtempSync(join(tmpdir(), "fnfe-unchanged-"));
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
    });
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), content);
    }
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  try {
    git(["init", "-q"]);
    const base = commit({ "platform/convex/keys.ts": "export {};\n" }, "base");
    const head = commit({ "tests/keys.test.ts": "x\n" }, "test");
    mkdirSync(join(repo, "docs/desenvolvimento"), { recursive: true });
    git(["mv", "platform/convex/keys.ts", "docs/desenvolvimento/keys.ts"]);
    const moved = commit({}, "move");
    expect(changedFiles(base, head, git)).toEqual(["tests/keys.test.ts"]);
    // Mover um arquivo publicado para docs/ também muda o que é publicado.
    expect(changedFiles(head, moved, git)?.sort()).toEqual([
      "docs/desenvolvimento/keys.ts",
      "platform/convex/keys.ts",
    ]);
    expect(changedFiles(head, base, git)).toBeNull();
    expect(changedFiles("c".repeat(40), head, git)).toBeNull();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

it("skips only a descendant of the published revision whose changes are never published", async () => {
  const request = serving({});
  const diff = (files: string[]) => (args: string[]) =>
    args[0] === "merge-base" ? "" : `${files.join("\n")}\n`;
  const decide = (files: string[], options = {}) =>
    unchangedPublication(sha, target, { request, run: diff(files), ...options });
  expect(await decide(["tests/keys.test.ts", "docs/desenvolvimento/ci.md"])).toEqual({
    skip: true,
    published,
    files: 2,
  });
  expect(await decide(["tests/keys.test.ts", "platform/convex/keys.ts"])).toMatchObject({
    skip: false,
    reason: "1 deployed files changed",
  });
  const many = Array.from({ length: maxChangedFiles + 1 }, (_, i) => `tests/${i}.test.ts`);
  expect((await decide(many)).skip).toBe(false);
  expect(
    (
      await decide([], {
        run: () => {
          throw new Error("not an ancestor");
        },
      })
    ).skip,
  ).toBe(false);
  expect((await unchangedPublication(published, target, { request, run: diff([]) })).reason).toBe(
    "already published",
  );
  expect((await decide([], { request: () => Promise.reject(new Error("offline")) })).reason).toBe(
    "published revision unknown",
  );
});

it("ends an unchanged release after the preflight, before any build or write", async () => {
  const operations = {
    preflight: vi.fn(async () => {}),
    unchanged: vi.fn(async () => ({ skip: true, published, files: 2 })),
    build: vi.fn(),
    probe: vi.fn(),
    eligible: vi.fn(),
    backend: vi.fn(),
    frontend: vi.fn(),
    smoke: vi.fn(),
  };
  const record = vi.fn();
  const receipt = await publishRevision(sha, operations, record);
  expect(receipt).toMatchObject({ state: "unchanged", phase: "complete", publishedSha: published });
  expect(operations.preflight).toHaveBeenCalledOnce();
  for (const step of ["build", "probe", "eligible", "backend", "frontend", "smoke"] as const)
    expect(operations[step]).not.toHaveBeenCalled();
  expect(record.mock.lastCall?.[0]).toMatchObject({ state: "unchanged" });
});

it("gives the publication the history it compares against", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy.yml", "utf8"));
  const checkout = workflow.jobs.publish.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout.with["fetch-depth"]).toBe(0);
});
