import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vite-plus/test";
import config from "../vite.config";
import { sanitizeReport } from "../scripts/lib/ci.mjs";
import { subprocessEnvironment } from "../scripts/lib/subprocess-environment.mjs";
import {
  areaCommand,
  mocks,
  projectsFor,
  reportSuites,
  suiteFor,
  testProjects,
  vitestProjects,
} from "../scripts/lib/test-projects.mjs";

/**
 * Os testes rodam em projetos do Vitest por área, definidos uma vez em
 * scripts/lib/test-projects.mjs. vite.config.ts monta os projetos e as tarefas
 * `test:<área>` dessa lista, e o relatório do CI (scripts/lib/ci.mjs) agrupa
 * cada arquivo pela suíte do projeto que o contém. Um arquivo fora de todos os
 * projetos não roda em lugar nenhum, nem no CI; um arquivo em dois roda duas
 * vezes.
 */
type Project = {
  name: string;
  include: string[];
  exclude?: string[];
  isolate?: boolean;
  setupFiles?: string[];
};
const projects = (config.test!.projects as Array<{ test: Project }>).map(({ test }) => test);
const tasks = config.run!.tasks! as Record<
  string,
  { command?: string; cache?: unknown; dependsOn?: string[] }
>;
const testFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts", "*.test.tsx"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
const owners = (file: string) => projectsFor(file).map(({ name }) => name);

it("builds the Vitest projects from the shared list", () => {
  const expected = vitestProjects();
  expect(projects.map(({ name, include, isolate }) => ({ name, include, isolate }))).toEqual(
    expected.map(({ name, include, isolate }) => ({ name, include, isolate })),
  );
  for (const [index, { exclude = [] }] of expected.entries())
    expect(projects[index]!.exclude ?? []).toEqual(
      exclude.length ? ["**/node_modules/**", "**/.git/**", ...exclude] : [],
    );
});

it("shares workers only in shared areas, and isolates every file that mocks a module", () => {
  // Um vi.mock não substitui um módulo que outro arquivo do worker já
  // carregou; quem moca, direto ou por um helper de tests/, roda isolado.
  const shared = projects.filter(({ isolate }) => isolate === false);
  expect(shared.map(({ name }) => name)).toEqual(
    testProjects.filter(({ shared }) => shared).map(({ name }) => name),
  );
  for (const project of shared) {
    expect(project.setupFiles?.[0]).toBe("./tests/setup/file-isolation.ts");
    const isolated = projects.find(({ name }) => name === `${project.name}-isolated`)!;
    expect(isolated.isolate).toBe(true);
    const files = testFiles.filter((file) => owners(file).includes(project.name));
    expect(isolated.include.length).toBeGreaterThan(0);
    for (const file of files) expect(isolated.include.includes(file), file).toBe(mocks(file));
    for (const file of isolated.include) expect(files).toContain(file);
    for (const file of isolated.include) expect(project.exclude).toContain(file);
  }
});

it("runs the platform tests without terms of use in effect, and only them", () => {
  // tests/setup/terms-of-use.ts: the organizations of the suites never accepted the terms.
  for (const project of projects)
    expect(project.setupFiles?.includes("./tests/setup/terms-of-use.ts"), project.name).toBe(
      project.name === "platform" || project.name === "platform-isolated",
    );
});

it("finds a mock through every kind of local import of a tests/ helper", () => {
  const scan = (name: string) => mocks(`tests/fixtures/mock-scan/${name}.case.ts`);
  expect(scan("direct")).toBe(true);
  // `import "./helpers/dir"`: diretório com index.ts que chama vi.doMock.
  expect(scan("index")).toBe(true);
  // `from "./helpers/mocking.js"`, resolvido para mocking.ts.
  expect(scan("js")).toBe(true);
  expect(scan("dynamic")).toBe(true);
  // Helpers sem mock que se importam em ciclo: termina e não acusa.
  expect(scan("plain")).toBe(false);
});

it("assigns every test file to exactly one project and one report suite", () => {
  expect(testFiles.length).toBeGreaterThan(150);
  const wrong = testFiles
    .map((file): [string, string] => [file, owners(file).join(",") || "nenhum"])
    .filter(([, names]) => names.includes(",") || names === "nenhum");
  expect(wrong).toEqual([]);
  for (const file of testFiles) expect(reportSuites).toContain(suiteFor(file));
});

it("classifies a new test file from the shared list", () => {
  expect(owners("src/pages/example.test.ts")).toEqual([]);
  expect(owners("platform/convex/companies.test.ts")).toEqual(["platform"]);
  expect(owners("apps/console/auth-proxy.test.ts")).toEqual(["platform"]);
  expect(owners("packages/sdk/index.test.ts")).toEqual(["packages"]);
  expect(owners("platform/convex/exports.benchmark.test.ts")).toEqual(["benchmark"]);
  expect(owners("tests/worktreeSetup.benchmark.test.ts")).toEqual(["benchmark"]);
  expect(owners("tests/worktreeSafety.test.ts")).toEqual(["tooling"]);
  expect(owners("scripts/lib/worktree-local.test.ts")).toEqual(["tooling"]);
  // Os prefixos do backoffice legado, aposentado na #345, não têm mais dono.
  expect(owners("tests/convex.core.test.ts")).toEqual([]);
  expect(owners("tests/engine.novo.test.ts")).toEqual([]);
  expect(owners("platform/convex/lib/apiKeyCrypto.test.ts")).toEqual(["platform"]);
  expect(owners("packages/contracts/webhooks.test.ts")).toEqual(["packages"]);
  expect(owners("apps/docs/scripts/output.test.ts")).toEqual(["tooling"]);
  // Os testes que leem a árvore inteira ficam fora de tooling.
  expect(owners("scripts/public-copy/public-tree.test.ts")).toEqual(["repository"]);
  expect(owners("scripts/public-copy/public-identifiers.test.ts")).toEqual(["repository"]);
  expect(owners("tests/ci.changes.test.ts")).toEqual(["repository"]);
  expect(owners("scripts/repo/adr-status.test.ts")).toEqual(["repository"]);
  expect(owners("scripts/repo/doc-links.test.ts")).toEqual(["repository"]);
  expect(owners("scripts/public-copy/public-scan.test.ts")).toEqual(["tooling"]);
  // Nenhum projeto recolhe o restante: um teste novo sem dono reprova.
  expect(() => suiteFor("tests/novo.test.ts")).toThrow("no project");
  expect(() => suiteFor("lib/novo.test.ts")).toThrow("no project");
  expect(suiteFor("apps/console/src/novo.test.tsx")).toBe("platform");
  expect(suiteFor("scripts/novo.test.ts")).toBe("infrastructure");
  expect(() => suiteFor("src/pages/example.test.ts")).toThrow("no project");
});

it("refuses a report entry outside every project", () => {
  const raw = { success: true, testResults: [{ name: "/repo/src/solto.test.ts" }] };
  expect(() => sanitizeReport(raw, "/repo", {}, 0)).toThrow("no project");
});

it("gives every project a local task and runs all of them in CI", () => {
  for (const { name } of testProjects)
    expect(tasks[`test:${name}`]?.command).toBe(areaCommand(name));
  // A tarefa de uma área roda os projetos dela, inclusive o isolado.
  expect(tasks["test:platform"]?.command).toBe(
    "vp test run --project platform --project platform-isolated",
  );
  expect(tasks["test:packages"]?.command).toBe("vp test run --project packages");
  // The CI graph has one cached task per area, each writing only its receipt,
  // and ci:tests, never cached, collects every area's receipt.
  for (const { name } of testProjects)
    expect(tasks[`ci:test:${name}`]).toMatchObject({
      command: `node scripts/ci/ci.mjs test-area ${name}`,
      cache: { output: [`.ci-results/tests/${name}.json`] },
    });
  expect(tasks["ci:tests"]).toMatchObject({
    command: "node scripts/ci/ci.mjs collect-tests",
    cache: false,
    dependsOn: testProjects.map(({ name }) => `ci:test:${name}`),
  });
  expect(tasks.validate?.dependsOn).toContain("ci:tests");
});

/**
 * Runs the real `scripts/ci/ci.mjs <command>` with Vitest and the .ci-results
 * writes replaced, and returns the Vitest commands it would start.
 */
function vitestCalls(...command: string[]) {
  const root = mkdtempSync(join(tmpdir(), "fnfe-ci-runner-"));
  try {
    const log = join(root, "calls.json"),
      preload = join(root, "preload.mjs");
    writeFileSync(
      preload,
      `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const calls = [], write = fs.writeFileSync, spawn = cp.spawnSync;
const results = (file) => String(file).replaceAll("\\\\", "/").includes("/.ci-results");
cp.spawnSync = (_file, args) => {
  if (args[1] !== "test" || args[2] !== "run") return spawn(_file, args, { encoding: "utf8", windowsHide: true });
  calls.push(args);
  write(${JSON.stringify(log)}, JSON.stringify(calls));
  return { status: 0 };
};
fs.mkdirSync = ((mkdir) => (file, ...args) => results(file) ? undefined : mkdir(file, ...args))(fs.mkdirSync);
fs.writeFileSync = (file, ...args) => results(file) ? undefined : write(file, ...args);
fs.rmSync = ((rm) => (file, ...args) => results(file) ? undefined : rm(file, ...args))(fs.rmSync);
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, resolve("scripts/ci/ci.mjs"), ...command],
      { cwd: resolve("."), env: subprocessEnvironment(process.env), encoding: "utf8" },
    );
    expect(existsSync(log), result.stderr).toBe(true);
    return JSON.parse(readFileSync(log, "utf8")) as string[][];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("runs exactly the area's projects from each CI area task, and every project in one area", () => {
  const ran: string[] = [];
  for (const { name } of testProjects) {
    const [args, ...others] = vitestCalls("test-area", name);
    expect(others).toEqual([]);
    expect(args!.slice(1, 3)).toEqual(["test", "run"]);
    const options = args!.slice(3);
    // No file filter, changed set or shard: the area's projects and options only.
    expect(options.filter((arg) => /^--(changed|shard)\b/.test(arg))).toEqual([]);
    const projectNames = options.filter((_, index) => options[index - 1] === "--project");
    expect(options.filter((arg) => !arg.startsWith("--"))).toEqual(projectNames);
    expect(projectNames).toEqual(
      vitestProjects()
        .filter((project) => project.area === name)
        .map((project) => project.name),
    );
    ran.push(...projectNames);
  }
  // Together the area tasks run every Vitest project, each once.
  expect(ran.sort()).toEqual(
    vitestProjects()
      .map(({ name }) => name)
      .sort(),
  );
});

it("runs the whole suite from the CI test command, without a filter", () => {
  // Runs the real `scripts/ci/ci.mjs test` with Vitest and the .ci-results
  // writes replaced, and records the command it would start.
  const root = mkdtempSync(join(tmpdir(), "fnfe-ci-runner-"));
  try {
    const log = join(root, "calls.json"),
      preload = join(root, "preload.mjs");
    writeFileSync(
      preload,
      `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const calls = [], write = fs.writeFileSync, read = fs.readFileSync, spawn = cp.spawnSync;
const artifacts = new Map();
const results = (file) => String(file).replaceAll("\\\\", "/").includes("/.ci-results");
cp.spawnSync = (_file, args) => {
  if (args[1] !== "test" || args[2] !== "run") return spawn(_file, args, { encoding: "utf8", windowsHide: true });
  calls.push(args);
  write(${JSON.stringify(log)}, JSON.stringify(calls));
  return { status: 0 };
};
fs.mkdirSync = ((mkdir) => (file, ...args) => results(file) ? undefined : mkdir(file, ...args))(fs.mkdirSync);
fs.readFileSync = (file, ...args) => results(file) ? (artifacts.get(String(file)) ?? "{}") : read(file, ...args);
fs.writeFileSync = (file, ...args) => results(file) ? artifacts.set(String(file), args[0]) : write(file, ...args);
fs.unlinkSync = ((unlink) => (file, ...args) => results(file) ? artifacts.delete(String(file)) : unlink(file, ...args))(fs.unlinkSync);
fs.rmdirSync = ((rmdir) => (file, ...args) => results(file) ? undefined : rmdir(file, ...args))(fs.rmdirSync);
syncBuiltinESMExports();
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, resolve("scripts/ci/ci.mjs"), "test"],
      { cwd: resolve("."), env: subprocessEnvironment(process.env), encoding: "utf8" },
    );
    expect(existsSync(log), result.stderr).toBe(true);
    const [args, ...others] = JSON.parse(readFileSync(log, "utf8")) as string[][];
    expect(others).toEqual([]);
    expect(args!.slice(1, 3)).toEqual(["test", "run"]);
    // Only options: no file filter, project, changed set or shard.
    const options = args!.slice(3);
    expect(options.filter((arg) => !arg.startsWith("--"))).toEqual([]);
    expect(options.filter((arg) => /^--(project|changed|shard)\b/.test(arg))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the platform commands on the platform and packages projects", () => {
  const read = (path: string) =>
    (JSON.parse(readFileSync(path, "utf8")) as { scripts: Record<string, string> }).scripts;
  // O `test` do workspace roda o projeto que leva o nome dele; o
  // `platform:test` da raiz soma os pacotes fiscais (AGENTS.md).
  expect(read("platform/package.json").test).toBe(
    "vp test run --root .. --project platform --project platform-isolated",
  );
  expect(read("package.json")["platform:test"]).toBe(
    "vp run test:platform && vp run test:packages",
  );
});
