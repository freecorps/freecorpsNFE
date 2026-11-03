// Compara o custo dos locks reais em snapshots pequenos, sem trocar arquivos
// do checkout, instalar dependências ou iniciar Convex. Ver docs/desenvolvimento/ci.md.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { subprocessEnvironment } from "./lib/subprocess-environment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = [
  "scripts/lib/validation-lock.mjs",
  ...["operation", "process-identity", "exec", "paths"].map(
    (name) => `scripts/lib/worktree/${name}.mjs`,
  ),
];

async function worker(snapshot, cycles) {
  const load = (file) => import(pathToFileURL(join(snapshot, file)).href);
  const { acquireValidationLock } = await load(files[0]);
  const { withOperation, runningOperation } = await load(files[1]);
  const fixture = join(snapshot, "fixture", randomUUID());
  const paths = { root: fixture, convexDir: join(fixture, ".convex") };
  mkdirSync(fixture, { recursive: true });
  const start = performance.now();
  for (let index = 0; index < cycles; index++) {
    const release = acquireValidationLock(fixture);
    const participant = acquireValidationLock(fixture, release.token);
    participant();
    assert.ok(existsSync(join(fixture, ".ci-results/validation.lock")));
    assert.throws(() => acquireValidationLock(fixture), /Validação indisponível/);
    release();
    assert.ok(!existsSync(join(fixture, ".ci-results/validation.lock")));
    await withOperation(paths, "sync", async () => {
      assert.equal(runningOperation(paths), "sync");
      await assert.rejects(
        withOperation(paths, "sync", async () => {}),
        /já está rodando/,
      );
    });
    assert.equal(runningOperation(paths), null);
  }
  console.log(JSON.stringify({ durationMs: performance.now() - start, cycles, result: "passed" }));
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3], Number(process.argv[4]));
} else {
  assert.equal(
    process.argv[2],
    "--base",
    "Use: node scripts/bench-workflow-locks.mjs --base <ref>",
  );
  assert.ok(process.argv[3] && process.argv.length === 4, "Informe exatamente uma base Git");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const base = git("rev-parse", "--verify", `${process.argv[3]}^{commit}`);
  const output = join(root, ".ci-results/workflow-bench", randomUUID());
  const revisions = {};
  for (const variant of ["base", "candidate"]) {
    const hashes = {};
    for (const file of files) {
      const content =
        variant === "base"
          ? execFileSync("git", ["show", `${base}:${file}`], { cwd: root })
          : readFileSync(join(root, file));
      const destination = join(output, variant, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
      hashes[file] = createHash("sha256").update(content).digest("hex");
    }
    revisions[variant] = {
      head: variant === "base" ? base : git("rev-parse", "HEAD"),
      files: hashes,
    };
  }
  const receipt = {
    schemaVersion: 1,
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    operation:
      "quatro ciclos de acquire/join/contender/release e withOperation com concorrente recusado",
    protocol:
      "um aquecimento por variante; cinco pares alternados; subprocesso novo por amostra; primeira sonda incluída",
    revisions,
    samples: [],
    result: "running",
  };
  const save = () =>
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  save();
  try {
    for (let round = -1; round < 5; round++) {
      const variants = round % 2 === 0 ? ["candidate", "base"] : ["base", "candidate"];
      for (const variant of variants) {
        const run = spawnSync(
          process.execPath,
          [fileURLToPath(import.meta.url), "--worker", join(output, variant), "4"],
          {
            cwd: root,
            encoding: "utf8",
            env: subprocessEnvironment(process.env),
            timeout: 120_000,
          },
        );
        const sample = {
          variant,
          warmup: round === -1,
          round,
          exitCode: run.status,
          signal: run.signal,
          result: "failed",
        };
        receipt.samples.push(sample);
        if (run.status === 0 && !run.error) Object.assign(sample, JSON.parse(run.stdout));
        save();
        assert.equal(sample.result, "passed", `Amostra ${variant}/${round} falhou; veja ${output}`);
        console.log(
          `${variant} ${round === -1 ? "aquecimento" : round}: ${sample.durationMs.toFixed(1)} ms`,
        );
      }
    }
    receipt.result = "passed";
  } finally {
    if (receipt.result === "running") receipt.result = "failed";
    save();
    console.log(`Recibo: ${resolve(output, "receipt.json")}`);
  }
}
