import { it, expect } from "vite-plus/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

it("rejects stale, dirty, failed or replaced package evidence before importing a consumer", () => {
  const directory = mkdtempSync(join(tmpdir(), "sdk-proof-guard-"));
  const moduleUrl = pathToFileURL(resolve("scripts/lib/sdk-proof.mjs")).href;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    writeFileSync(join(directory, ".gitignore"), ".ci-results/\n");
    mkdirSync(join(directory, "packages/sdk"), { recursive: true });
    writeFileSync(
      join(directory, "packages/sdk/package.json"),
      JSON.stringify({ name: "@freecorps/freecorpsnfe-sdk", version: "0.1.1" }),
    );
    git("add", ".gitignore", "packages/sdk/package.json");
    git(
      "-c",
      "user.name=SDK test",
      "-c",
      "user.email=sdk@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const artifacts = join(directory, ".ci-results/74");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "freecorps-freecorpsnfe-sdk-0.1.0.tgz"), "stale-package");
    const tarball = join(artifacts, "freecorps-freecorpsnfe-sdk-0.1.1.tgz");
    writeFileSync(tarball, "synthetic-package");
    const report = {
      result: "passed",
      dirty: false,
      codeSha: git("rev-parse", "HEAD"),
      tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
    };
    const run = (changes = {}) => {
      writeFileSync(join(artifacts, "package.json"), JSON.stringify({ ...report, ...changes }));
      return spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `import { packageProof } from ${JSON.stringify(moduleUrl)}; packageProof();`,
        ],
        { cwd: directory, encoding: "utf8" },
      );
    };
    expect(run().status).toBe(0);
    // The previous version remains on disk but must not satisfy the receipt.
    expect(
      run({
        tarballSha256: createHash("sha256").update("stale-package").digest("hex"),
      }).status,
    ).toBe(1);
    for (const changes of [{ result: "failed" }, { dirty: true }, { codeSha: "0".repeat(40) }])
      expect(run(changes).status).toBe(1);
    writeFileSync(join(directory, ".gitignore"), ".ci-results/\n# changed\n");
    expect(run().status).toBe(1);
    writeFileSync(join(directory, ".gitignore"), ".ci-results/\n");
    writeFileSync(tarball, "replaced-package");
    expect(run().status).toBe(1);
  } finally {
    // mkdtemp created this exact directory; no caller-controlled deletion target.
    rmSync(directory, { recursive: true, force: true });
  }
});
