import { afterEach, expect, it, vi } from "vite-plus/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOperation, releaseInterruptedDev } from "../lib/worktree/operation.mjs";
import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readProcessIdentity } from "../lib/worktree/process-identity.mjs";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.unlinkSync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Um lock de dev cujo dono já morreu, como o de um dev encerrado à força. */
async function interruptedDev() {
  const root = mkdtempSync(join(tmpdir(), "fnfe-release-"));
  roots.push(root);
  const paths = worktreePaths(root);
  mkdirSync(paths.convexDir);
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
  });
  await once(owner, "spawn");
  const record = {
    version: 1,
    runId: randomUUID(),
    pid: owner.pid,
    identity: readProcessIdentity(owner.pid!),
    command: "dev",
    startedAt: "2026-11-04T12:00:00.000Z",
    outcome: "running",
  };
  writeFileSync(join(paths.convexDir, "worktree-operation.lock"), JSON.stringify(record));
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  await exited;
  return { paths, record };
}

it("libera o lock de um dev interrompido só uma vez", async () => {
  const { paths, record } = await interruptedDev();
  expect(readOperation(paths).state).toBe("interrupted");
  expect(releaseInterruptedDev(paths, record)).toBe(true);
  expect(readOperation(paths).state).toBe("idle");
  expect(releaseInterruptedDev(paths, record)).toBe(false);
}, 30000);

it("um cleanup simultâneo que liberou antes não faz este falhar", async () => {
  const { paths, record } = await interruptedDev();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  // O outro cleanup apaga o lock entre a conferência e a remoção deste.
  vi.mocked(fs.unlinkSync).mockImplementationOnce((path) => {
    actual.unlinkSync(path);
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  });
  expect(releaseInterruptedDev(paths, record)).toBe(false);
  expect(readOperation(paths).state).toBe("idle");
}, 30000);
