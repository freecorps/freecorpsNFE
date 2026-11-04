import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { execFileSync, spawn as spawnProcess, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acceptanceSteps,
  proofArguments,
  runLocalValidation,
  runProof,
} from "./lib/proof-runner.mjs";
import { acquireValidationLock, VALIDATION_LOCK_TOKEN } from "./lib/validation-lock.mjs";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";

// Só o teste de substituição recusada troca a implementação real.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "proof-runner-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/prove-x.mjs"), "runner");
  writeFileSync(join(root, "schema.ts"), "schema");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.renameSync).mockReset();
  rmSync(root, { recursive: true, force: true });
});

// Git e subprocessos simulados: nenhuma prova real roda nestes testes.
function fakeGit(status: string[] = [""]) {
  const calls: string[][] = [];
  const git = (...args: string[]) => {
    calls.push(args);
    if (args[0] === "status") return status.length > 1 ? status.shift()! : status[0];
    if (args[0] === "rev-parse" && args[1] === "--verify") return BASE;
    if (args[0] === "rev-parse") return HEAD;
    if (args[0] === "diff" || args[0] === "ls-files") return "";
    throw new Error(`git ${args.join(" ")}`);
  };
  return { git, calls };
}

function fakeSpawn(outcomes: Record<string, { status: number; stdout?: string; error?: Error }>) {
  const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const spawn = (file: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push({ file, args, env: options.env });
    const outcome = outcomes[args.join(" ")] ?? { status: 0 };
    return {
      status: outcome.status,
      signal: null,
      stdout: outcome.stdout ?? "",
      stderr: "",
      error: outcome.error,
    };
  };
  return { spawn, calls };
}

const steps = [
  { name: "first", command: ["bun", "run", "first"] },
  { name: "second", command: ["node", "second.mjs"], env: { CONTRACT_BASE: "origin/main" } },
  { name: "third", command: ["bun", "run", "third"] },
];

function prove(overrides: Partial<Parameters<typeof runProof>[0]> = {}) {
  return runProof({
    root,
    proof: "x",
    runner: "scripts/prove-x.mjs",
    output: "out",
    base: "origin/main",
    inputs: ["schema.ts"],
    steps,
    env: { PATH: "/bin", SECRET_TOKEN: "não pode vazar" },
    spawn: fakeSpawn({}).spawn,
    git: fakeGit().git,
    now: () => new Date("2026-10-20T12:00:00.000Z"),
    ...overrides,
  });
}

describe("runProof", () => {
  it("records revision, base, environment, commands, inputs and log hashes", () => {
    const { spawn, calls } = fakeSpawn({ "run first": { status: 0, stdout: "ok" } });
    const receipt = prove({ spawn });

    expect(receipt).toMatchObject({
      proof: "x",
      codeSha: HEAD,
      dirty: false,
      base: { ref: "origin/main", sha: BASE },
      runnerSha256: sha("runner"),
      inputs: { "schema.ts": sha("schema") },
      environment: "local-only",
      syntheticOnly: true,
      result: "passed",
    });
    expect(receipt.runtime.platform).toBe(process.platform);
    expect(receipt.commands.map((command: { name: string }) => command.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(receipt.commands[0]).toMatchObject({
      command: "bun run first",
      exitCode: 0,
      logFile: "first.txt",
      logSha256: sha("ok\n"),
      result: "passed",
    });
    expect(readFileSync(join(root, "out/first.txt"), "utf8")).toBe("ok\n");
    expect(JSON.parse(readFileSync(join(root, "out/receipt.json"), "utf8"))).toEqual(receipt);
    // Runtime, ambiente da etapa e a posse desta execução chegam ao subprocesso.
    expect(calls[1].env).toEqual({
      PATH: "/bin",
      CONTRACT_BASE: BASE,
      [VALIDATION_LOCK_TOKEN]: expect.any(String),
    });
  });

  it("stops at the failing step and writes a failure receipt pointing to its log", () => {
    const { spawn, calls } = fakeSpawn({ "second.mjs": { status: 2, stdout: "quebrou" } });
    const receipt = prove({ spawn });

    expect(receipt.result).toBe("failed");
    expect(receipt.failedStep).toBe("second");
    expect(receipt.error).toBe("second falhou; veja out/second.txt");
    expect(calls).toHaveLength(2);
    expect(receipt.commands[1]).toMatchObject({
      exitCode: 2,
      result: "failed",
      logSha256: sha("quebrou\n"),
    });
    const written = JSON.parse(readFileSync(join(root, "out/receipt.json"), "utf8"));
    expect(written.result).toBe("failed");
    expect(written.failedStep).toBe("second");
  });

  it("fails a step that could not start or timed out", () => {
    const { spawn } = fakeSpawn({
      "run first": { status: null as unknown as number, error: new Error("spawn ETIMEDOUT") },
    });
    const receipt = prove({ spawn });

    expect(receipt.result).toBe("failed");
    expect(receipt.failedStep).toBe("first");
    expect(readFileSync(join(root, "out/first.txt"), "utf8")).toContain("spawn ETIMEDOUT");
  });

  it("refuses a dirty checkout before running anything", () => {
    const { spawn, calls } = fakeSpawn({});
    expect(prove({ spawn, git: fakeGit([" M file.ts"]).git })).toMatchObject({
      result: "failed",
      failedStep: "preconditions",
      error: expect.stringMatching(/commit/),
    });
    expect(calls).toHaveLength(0);
  });

  it("does not approve a proof that changed the checkout", () => {
    const receipt = prove({ git: fakeGit(["", " M generated.ts"]).git });
    expect(receipt.result).toBe("failed");
    expect(receipt.error).toBe("A prova alterou o checkout");
  });

  it("copies the reports a step declares, also when the step fails", () => {
    const receipt = prove({
      spawn: () => {
        writeFileSync(join(root, ".ci-results/tests.json"), '{"result":"failed"}');
        return { status: 1 };
      },
      steps: [
        { name: "tests", command: ["bun", "t"], reports: { ".ci-results/tests.json": "t.json" } },
      ],
    });
    expect(receipt.failedStep).toBe("tests");
    expect(readFileSync(join(root, "out/t.json"), "utf8")).toBe('{"result":"failed"}');
  });

  it("hashes absolute inputs and writes to an absolute output as given", () => {
    const outside = mkdtempSync(join(tmpdir(), "proof-runner-outside-"));
    try {
      writeFileSync(join(outside, "corpus.json"), "corpus");
      const receipt = prove({
        inputs: [join(outside, "corpus.json")],
        output: join(outside, "out"),
      });
      expect(receipt.inputs).toEqual({ [join(outside, "corpus.json")]: sha("corpus") });
      expect(readFileSync(join(outside, "out/receipt.json"), "utf8")).toContain('"passed"');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("proofArguments", () => {
  it("defaults the base to origin/main and accepts explicit base, output and inputs", () => {
    expect(proofArguments([], { output: ".ci-results/x" })).toEqual({
      base: "origin/main",
      output: ".ci-results/x",
      inputs: [],
    });
    expect(
      proofArguments(
        ["--base", "v1.0.0", "--output", "out", "--input", "a.ts", "--input", "b.ts"],
        {
          output: ".ci-results/x",
        },
      ),
    ).toEqual({ base: "v1.0.0", output: "out", inputs: ["a.ts", "b.ts"] });
  });

  it("rejects unknown flags, missing values and unsafe refs", () => {
    expect(() => proofArguments(["--bse", "x"], { output: "o" })).toThrow(/desconhecido/);
    expect(() => proofArguments(["--base"], { output: "o" })).toThrow(/valor/);
    expect(() => proofArguments(["--output", "--base"], { output: "o" })).toThrow(/valor/);
    expect(() => proofArguments(["--base", "main;rm"], { output: "o" })).toThrow(/Base/);
    expect(() => proofArguments(["--base", "-h"], { output: "o" })).toThrow(/Base/);
  });
});

it("reuses the CI validate graph without cache and with the explicit contract base", () => {
  const steps = acceptanceSteps("origin/release");
  expect(steps.map((step: { name: string }) => step.name)).toEqual([
    "identity",
    "validate",
    "boundaries",
  ]);
  expect(steps[1]).toMatchObject({
    command: ["bun", "x", "vp", "run", "--no-cache", "validate"],
    env: { CONTRACT_BASE: "origin/release" },
  });
  expect(JSON.stringify(steps)).not.toContain("fiscal-platform-v1");
});

function local(overrides: Partial<Parameters<typeof runProof>[0]> = {}) {
  return runLocalValidation({
    root,
    proof: "local",
    runner: "scripts/prove-x.mjs",
    output: "out",
    base: "origin/main",
    steps: acceptanceSteps("origin/main", { cache: true }),
    git: fakeGit().git,
    spawn: fakeSpawn({}).spawn,
    ...overrides,
  });
}

function initializeGit() {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), ".ci-results/\nout/\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Proof Test",
    "-c",
    "user.email=proof@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  git("branch", "base");
  return git;
}

describe("local and candidate attempts", () => {
  it.each(["identity", "validate", "boundaries"])(
    "returns failure and a summary when %s fails",
    (failedStep) => {
      const graph = acceptanceSteps(BASE, { cache: true });
      let index = 0;
      const receipt = local({
        steps: graph,
        spawn: () => ({ status: graph[index++].name === failedStep ? 1 : 0 }),
      });
      expect(receipt).toMatchObject({ result: "failed", failedStep });
      expect(receipt.commands).toHaveLength(
        graph.findIndex((step) => step.name === failedStep) + 1,
      );
      expect(readFileSync(join(root, receipt.output, "summary.md"), "utf8")).toContain(
        `Falha: ${failedStep}`,
      );
    },
  );

  it("allows cache only in the local graph, without removing any step", () => {
    const cached = acceptanceSteps(BASE, { cache: true });
    expect(cached.map((step) => step.name)).toEqual(acceptanceSteps(BASE).map((step) => step.name));
    expect(cached[1].command).toEqual(["bun", "x", "vp", "run", "validate"]);
    expect(acceptanceSteps(BASE)[1].command).toContain("--no-cache");
    expect(() => proofArguments(["--allow-dirty", "yes"], { output: "out" })).toThrow(
      /desconhecido/,
    );
  });

  it.each(["staged", "unstaged", "untracked"])(
    "accepts %s locally but refuses it as proof",
    (kind) => {
      const git = initializeGit();
      writeFileSync(join(root, kind === "untracked" ? "new.txt" : "schema.ts"), "changed");
      if (kind === "staged") git("add", "schema.ts");
      const strict = prove({ git: undefined, base: "base", uniqueAttempt: true });
      expect(strict).toMatchObject({
        result: "failed",
        codeSha: null,
        failedStep: "preconditions",
        dirty: true,
      });
      const receipt = local({ git: undefined, base: "base" });
      expect(receipt).toMatchObject({
        result: "passed",
        mode: "local",
        codeSha: null,
        headReference: git("rev-parse", "HEAD"),
        checkout: { start: { dirty: true }, end: { dirty: true }, changed: false },
        cache: { policy: "eligible", observed: "not-measured" },
      });
      expect(receipt.output).not.toBe(strict.output);
    },
  );

  it.each(["tracked", "untracked"])("detects further edits to an already dirty %s file", (kind) => {
    initializeGit();
    const file = join(root, kind === "tracked" ? "schema.ts" : "new.txt");
    writeFileSync(file, "first");
    const receipt = local({
      git: undefined,
      base: "base",
      spawn: () => {
        writeFileSync(file, "second");
        return { status: 0 };
      },
    });
    expect(receipt.checkout.changed).toBe(true);
    expect(receipt.limitation).toContain("estados diferentes");
    expect(receipt.codeSha).toBeNull();
  });

  it("proves a clean temporary candidate and pins a moving base before executing steps", () => {
    const git = initializeGit();
    git(
      "-c",
      "user.name=Proof Test",
      "-c",
      "user.email=proof@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "candidate",
    );
    const originalBase = git("rev-parse", "base");
    const bases: string[] = [];
    const receipt = prove({
      git: undefined,
      base: "base",
      uniqueAttempt: true,
      spawn: (_file, _args, options) => {
        bases.push(options.env.CONTRACT_BASE);
        git("branch", "-f", "base", "HEAD");
        return { status: 0 };
      },
    });
    expect(receipt.result).toBe("passed");
    expect(receipt.codeSha).toBe(git("rev-parse", "HEAD"));
    expect(receipt.base).toEqual({ ref: "base", sha: originalBase });
    expect(new Set(bases)).toEqual(new Set([originalBase]));
    expect(git("rev-parse", "base")).not.toBe(originalBase);
  });

  it("refuses a candidate whose HEAD moves during execution", () => {
    const git = initializeGit();
    const receipt = prove({
      git: undefined,
      base: "base",
      uniqueAttempt: true,
      spawn: () => {
        git(
          "-c",
          "user.name=Proof Test",
          "-c",
          "user.email=proof@example.invalid",
          "commit",
          "--allow-empty",
          "-qm",
          "moved",
        );
        return { status: 0 };
      },
    });
    expect(receipt).toMatchObject({ result: "failed", failedStep: "checkout" });
  });

  it("does not inherit reports from a previous passing attempt", () => {
    const reportSteps = [
      {
        name: "tests",
        command: ["node", "test"],
        reports: { ".ci-results/tests.json": "tests.json" },
      },
    ];
    const first = prove({
      steps: reportSteps,
      uniqueAttempt: true,
      spawn: () => {
        writeFileSync(join(root, ".ci-results/tests.json"), '{"result":"passed"}');
        return { status: 0 };
      },
    });
    const next = prove({ steps: reportSteps, uniqueAttempt: true, spawn: () => ({ status: 1 }) });
    expect(first.output).not.toBe(next.output);
    expect(existsSync(join(root, first.output, "tests.json"))).toBe(true);
    expect(existsSync(join(root, next.output, "tests.json"))).toBe(false);
    expect(next.commands[0].reports).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, first.output, "receipt.json"), "utf8")).result).toBe(
      "passed",
    );
  });

  it("persists the active step before spawn and completed steps before the next one", () => {
    const observed: string[][] = [];
    prove({
      spawn: () => {
        const receipt = JSON.parse(readFileSync(join(root, "out/receipt.json"), "utf8"));
        expect(receipt.result).toBe("running");
        observed.push(receipt.commands.map((command: { result: string }) => command.result));
        return { status: 0 };
      },
    });
    expect(observed).toEqual([["running"], ["passed", "running"], ["passed", "passed", "running"]]);
  });

  it("retries a receipt replacement refused while a reader holds it open", () => {
    // O Windows recusa o rename sobre um recibo aberto por quem acompanha a tentativa.
    const busy = Object.assign(new Error("EPERM: operation not permitted, rename"), {
      code: "EPERM",
    });
    vi.mocked(fs.renameSync)
      .mockImplementationOnce(() => {
        throw busy;
      })
      .mockImplementationOnce(() => {
        throw busy;
      });
    expect(prove().result).toBe("passed");
    expect(JSON.parse(readFileSync(join(root, "out/receipt.json"), "utf8")).result).toBe("passed");
  });

  it("fails the attempt when the receipt replacement keeps being refused", () => {
    const busy = Object.assign(new Error("EPERM"), { code: "EPERM" });
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw busy;
    });
    expect(() => prove()).toThrow(/EPERM/);
  });

  it("replaces a fixed legacy receipt with running before another attempt starts", () => {
    prove();
    prove({
      spawn: () => {
        expect(JSON.parse(readFileSync(join(root, "out/receipt.json"), "utf8")).result).toBe(
          "running",
        );
        expect(readFileSync(join(root, "out/summary.md"), "utf8")).toContain("incompleta");
        return { status: 1 };
      },
    });
  });

  it("summarizes real failing processes and timeouts without copying their private output", () => {
    initializeGit();
    const receipt = prove({
      git: undefined,
      base: "base",
      uniqueAttempt: true,
      spawn: undefined,
      steps: [
        {
          name: "check",
          command: ["node", "-e", "console.error('PRIVATE_XML_SECRET'); process.exit(2)"],
        },
      ],
    });
    expect(receipt).toMatchObject({ result: "failed", failedStep: "check" });
    expect(receipt.commands[0].exitCode).toBe(2);
    const summary = readFileSync(join(root, receipt.output, "summary.md"), "utf8");
    expect(summary).toContain("[log](check.txt)");
    expect(summary).not.toContain("PRIVATE_XML_SECRET");
    const timeout = prove({
      git: undefined,
      base: "base",
      uniqueAttempt: true,
      spawn: undefined,
      steps: [
        { name: "timeout", command: ["node", "-e", "setTimeout(() => {}, 30000)"], timeoutMs: 50 },
      ],
    });
    expect(timeout).toMatchObject({ result: "failed", failedStep: "timeout", lockRetained: true });
    expect(existsSync(join(root, ".ci-results/validation.lock"))).toBe(true);
    expect(() => prove()).toThrow(/Validação indisponível/);
  });

  it("records wall time and reports a failed precondition", () => {
    let clock = 0;
    const receipt = prove({
      uniqueAttempt: true,
      now: () => new Date(clock++ * 100),
      git: (...args) => {
        if (args[1] === "--verify") throw new Error("missing base");
        return fakeGit().git(...args);
      },
    });
    expect(receipt).toMatchObject({ result: "failed", failedStep: "preconditions" });
    expect(receipt.durationMs).toBeGreaterThan(0);
    expect(receipt.finishedAt).toBeDefined();
    expect(readFileSync(join(root, receipt.output, "summary.md"), "utf8")).toContain(
      "Falha: preconditions",
    );
  });
});

// CLI real em checkout descartável; apenas o Vitest interno é substituído por
// um processo que produz um relatório sintético, sem disparar a suíte inteira.
function prepareCi() {
  for (const file of [
    "ci.mjs",
    "lib/ci.mjs",
    "lib/repository.mjs",
    "lib/test-projects.mjs",
    "lib/subprocess-environment.mjs",
    "lib/validation-lock.mjs",
    "lib/worktree/process-identity.mjs",
    "lib/worktree/exec.mjs",
    "lib/worktree/paths.mjs",
  ]) {
    const target = join(root, "scripts", file);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(new URL(file, import.meta.url), target);
  }
  mkdirSync(join(root, "node_modules/vite-plus/bin"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/vite-plus/bin/vp"),
    `const fs = require('node:fs');
     const file = process.argv.find(arg => arg.startsWith('--outputFile.json=')).split('=')[1];
     fs.writeFileSync(file, JSON.stringify({ success: true, testResults: [] }));`,
  );
  initializeGit();
  mkdirSync(join(root, ".ci-results"), { recursive: true });
  writeFileSync(join(root, ".ci-results/revision.json"), JSON.stringify({ checkedSha: HEAD }));
  writeFileSync(join(root, ".ci-results/tests.json"), "sentinel");
  const preload = join(root, "pause-write.mjs");
  writeFileSync(
    preload,
    `import fs from 'node:fs';
     import { basename, join } from 'node:path';
     import { syncBuiltinESMExports } from 'node:module';
     const write = fs.writeFileSync;
     fs.writeFileSync = (file, ...args) => {
       const name = basename(String(file));
       if (process.env.PAUSE_CI_WRITE && ['revision.json', 'tests.json'].includes(name)) {
         // Rename, so the test never sees the marker before its content.
         const ready = join(process.cwd(), name + '.ready');
         write(ready + '.tmp', fs.readFileSync(join(process.cwd(), '.ci-results/validation.lock/owner.json')));
         fs.renameSync(ready + '.tmp', ready);
         const deadline = Date.now() + 20000;
         while (!fs.existsSync(join(process.cwd(), name + '.allow'))) {
           if (Date.now() > deadline) throw new Error('Timed out waiting for test');
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
         }
       }
       return write(file, ...args);
     };
     syncBuiltinESMExports();`,
  );
  return ["--import", pathToFileURL(preload).href, join(root, "scripts/ci.mjs")];
}

function rawCi(command: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(root, "scripts/ci.mjs"), command], {
    cwd: root,
    env: { ...subprocessEnvironment(process.env), ...env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
}

function expectWritersBlocked() {
  const read = (file: string) =>
    existsSync(join(root, ".ci-results", file))
      ? readFileSync(join(root, ".ci-results", file), "utf8")
      : null;
  const revision = read("revision.json");
  const tests = read("tests.json");
  for (const command of ["identity-test", "identity", "test", "summary"]) {
    const result = rawCi(command);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Validação indisponível");
    expect(read("revision.json")).toBe(revision);
    expect(read("tests.json")).toBe(tests);
  }
}

describe("shared CI writers", () => {
  it.each(["identity-test", "identity", "test"])(
    "excludes other writers and runners throughout raw %s",
    async (command) => {
      const args = prepareCi();
      const child = spawnProcess(process.execPath, [...args, command], {
        cwd: root,
        env: { ...subprocessEnvironment(process.env), PAUSE_CI_WRITE: "1" },
        stdio: "ignore",
        windowsHide: true,
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const tokens: string[] = [];
      try {
        const writes =
          command === "identity-test"
            ? ["revision.json", "tests.json"]
            : [command === "identity" ? "revision.json" : "tests.json"];
        for (const file of writes) {
          const ready = join(root, `${file}.ready`);
          // Espera o marcador do filho; um filho que saiu antes encerra a espera.
          await vi.waitFor(
            () => {
              if (child.exitCode === null) expect(existsSync(ready)).toBe(true);
            },
            { timeout: 15000, interval: 30 },
          );
          expect(existsSync(ready)).toBe(true);
          tokens.push(JSON.parse(readFileSync(ready, "utf8")).token);
          writeFileSync(join(root, ".ci-results/tests.json"), "sentinel");
          expectWritersBlocked();
          expect(() => local()).toThrow(/Validação indisponível/);
          expect(existsSync(join(root, "out"))).toBe(false);
          writeFileSync(join(root, `${file}.allow`), "");
        }
        expect(await exited).toBe(0);
        expect(new Set(tokens).size).toBe(1);
        expect(existsSync(join(root, ".ci-results/validation.lock"))).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    },
    30000,
  );

  it("passes the runner's current token to real CI subprocesses without releasing its lock", () => {
    prepareCi();
    const receipt = local({
      env: { ...process.env, [VALIDATION_LOCK_TOKEN]: "forged" },
      steps: ["identity", "test"].map((command) => ({
        name: command,
        command: ["node", "scripts/ci.mjs", command],
        env: { [VALIDATION_LOCK_TOKEN]: "stale" },
      })),
      spawn: (file, args, options) => {
        expectWritersBlocked();
        const result = spawnSync(file, args, { ...options, encoding: "utf8" });
        expect(result.status, String(result.stderr)).toBe(0);
        expectWritersBlocked();
        return result;
      },
    });
    expect(receipt.result).toBe("passed");
    expect(JSON.parse(readFileSync(join(root, ".ci-results/tests.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      result: "passed",
      revision: { workingTree: { dirty: true } },
    });
    expect(existsSync(join(root, ".ci-results/validation.lock"))).toBe(false);
  }, 20000);

  it("rejects forged, released and replaced tokens before touching either report", () => {
    prepareCi();
    const previous = acquireValidationLock(root);
    const stale = previous.token;
    previous();
    const check = (token: string) => {
      for (const command of ["identity-test", "identity", "test"]) {
        const result = rawCi(command, { [VALIDATION_LOCK_TOKEN]: token });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Token de validação inválido");
        expect(JSON.parse(readFileSync(join(root, ".ci-results/revision.json"), "utf8"))).toEqual({
          checkedSha: HEAD,
        });
        expect(readFileSync(join(root, ".ci-results/tests.json"), "utf8")).toBe("sentinel");
      }
    };
    check(stale);
    const release = acquireValidationLock(root);
    try {
      check("forged");
      check("");
      check(stale);
      const ownerFile = join(root, ".ci-results/validation.lock/owner.json");
      const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
      for (const changed of [{ identity: null }, { identity: "reused-pid" }, { pid: 99999999 }]) {
        writeFileSync(ownerFile, JSON.stringify({ ...owner, ...changed }));
        check(release.token);
      }
    } finally {
      release();
    }
  }, 30000);

  it("keeps hosted identity and test commands working with their original report schema", () => {
    prepareCi();
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" };
    expect(rawCi("identity", env).status).toBe(0);
    expect(rawCi("test", env).status).toBe(0);
    const revision = JSON.parse(readFileSync(join(root, ".ci-results/revision.json"), "utf8"));
    expect(revision.workingTree).toBeUndefined();
    expect(JSON.parse(readFileSync(join(root, ".ci-results/tests.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      result: "passed",
      revision,
    });
  });
});

describe("checkout exclusion", () => {
  it("refuses concurrency before creating an attempt or modifying shared artifacts", () => {
    const release = acquireValidationLock(root);
    writeFileSync(join(root, ".ci-results/tests.json"), "sentinel");
    try {
      expect(() => local()).toThrow(/Validação indisponível/);
      expect(existsSync(join(root, "out"))).toBe(false);
      expect(readFileSync(join(root, ".ci-results/tests.json"), "utf8")).toBe("sentinel");
    } finally {
      release();
    }
    expect(local().result).toBe("passed");
  });

  it.each(["", "broken json", JSON.stringify({ pid: 99999999, identity: "stale" })])(
    "preserves an unverifiable or abandoned lock (%s)",
    (contents) => {
      const lock = join(root, ".ci-results/validation.lock");
      mkdirSync(lock, { recursive: true });
      if (contents) writeFileSync(join(lock, "owner.json"), contents);
      expect(() => local()).toThrow(/Trava ilegível/);
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(join(root, "out"))).toBe(false);
    },
  );

  it("leaves an interrupted subprocess attempt running and blocks another runner", async () => {
    prepareCi();
    const moduleUrl = new URL("./lib/proof-runner.mjs", import.meta.url).href;
    const code = `import { runProof } from ${JSON.stringify(moduleUrl)};
      runProof({ root: ${JSON.stringify(root)}, proof: 'interrupted', runner: 'scripts/prove-x.mjs', output: 'out', uniqueAttempt: true,
        steps: [{ name: 'blocked', command: ['node', 'unused'] }],
        git: (...args) => args[0] === 'status' ? '' : '${HEAD}',
        spawn: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); return { status: 0 }; }
      });`;
    const child = spawnProcess(process.execPath, ["--input-type=module", "-e", code], {
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let receiptPath = "";
    try {
      // Espera o recibo registrar a etapa; um filho que saiu antes encerra a espera.
      await vi.waitFor(
        () => {
          if (child.exitCode !== null) return;
          const out = join(root, "out");
          const attempt = existsSync(out) ? readdirSync(out)[0] : undefined;
          const file = attempt && join(out, attempt, "receipt.json");
          if (!file || !existsSync(file) || !JSON.parse(readFileSync(file, "utf8")).commands.length)
            throw new Error("Receipt has no step yet");
          receiptPath = file;
        },
        { timeout: 15000, interval: 30 },
      );
      if (!receiptPath && child.exitCode !== null)
        throw new Error("Child exited before recording its step");
      expect(receiptPath).not.toBe("");
      expectWritersBlocked();
      expect(() => local()).toThrow(/Validação indisponível/);
      child.kill("SIGKILL");
      await exited;
      const owner = JSON.parse(
        readFileSync(join(root, ".ci-results/validation.lock/owner.json"), "utf8"),
      );
      const stale = rawCi("identity", { [VALIDATION_LOCK_TOKEN]: owner.token });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("Token de validação inválido");
      expectWritersBlocked();
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
        result: "running",
        commands: [{ result: "running" }],
      });
      expect(() => local()).toThrow(/Validação indisponível/);
      expect(readdirSync(join(root, "out"))).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }, 20000);
});
