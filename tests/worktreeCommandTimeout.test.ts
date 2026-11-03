import { afterEach, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexRun } from "../scripts/lib/worktree/convex-local.mjs";
import { worktreePaths } from "../scripts/lib/worktree/paths.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("encerra um CLI local bloqueado e devolve o controle para a limpeza", () => {
  const root = mkdtempSync(join(tmpdir(), "fnfe-worktree-timeout-"));
  roots.push(root);
  // O CLI roda com cwd no backend da plataforma do worktree.
  mkdirSync(join(root, "platform"));
  const cli = join(root, "hung-cli.mjs");
  const pidFile = join(root, "pid");
  // The fallback exit keeps the regression test finite before the fix.
  writeFileSync(
    cli,
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], String(process.pid)); process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 4000);",
  );
  let cleanupReached = false;
  const start = Date.now();
  try {
    expect(() =>
      convexRun(
        { ...worktreePaths(root), nodeExecutable: process.execPath, convexCli: cli },
        [pidFile],
        { capture: true, timeoutMs: 1000 },
      ),
    ).toThrow("O comando excedeu o limite de 1000 ms.");
  } finally {
    cleanupReached = true;
  }
  expect(cleanupReached).toBe(true);
  expect(Date.now() - start).toBeLessThan(3000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
