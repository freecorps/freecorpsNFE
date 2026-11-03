import { expect, it, vi } from "vite-plus/test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { git } from "../scripts/lib/worktree/exec.mjs";
import { writeProcessRecord } from "../scripts/lib/worktree/state.mjs";
import { worktreePaths } from "../scripts/lib/worktree/paths.mjs";
import { withOperation } from "../scripts/lib/worktree/operation.mjs";
import { remove } from "../scripts/lib/worktree/lifecycle.mjs";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../scripts/lib/worktree/paths.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/lib/worktree/paths.mjs")>()),
  get currentRoot() {
    return fixture.root;
  },
}));

it("remove recusa dev durante startup e só remove depois de liberar a operação", async () => {
  // O git grava o caminho real; no macOS o tmpdir `/var/...` é `/private/var/...`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fnfe-removal-test-")));
  fixture.root = root;
  const target = join(root, "linked");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn");
    git(["init", "-b", "main"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), ".convex/\nlinked/\n");
    git(["add", ".gitignore"], { cwd: root });
    git(
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    git(["worktree", "add", "-b", "fixture", target], { cwd: root });
    const paths = worktreePaths(target);
    await withOperation(paths, "dev", async () => {
      // O lock existe antes de a sessão publicar seus primeiros filhos.
      await expect(remove(target, { force: true })).rejects.toThrow(/worktree:dev/);
      // Também recusa quando o backend já foi registrado e o frontend ainda vai nascer.
      writeProcessRecord(paths, { cwd: target, pid: child.pid, pids: [child.pid] });
      await expect(remove(target, { force: true })).rejects.toThrow(/worktree:dev/);
      expect(existsSync(join(target, ".git"))).toBe(true);
      expect(git(["worktree", "list", "--porcelain"], { cwd: root })).toContain(
        "refs/heads/fixture",
      );
    });
    await remove(target);
    expect(existsSync(target)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], { cwd: root })).not.toContain(
      "refs/heads/fixture",
    );
  } finally {
    child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
