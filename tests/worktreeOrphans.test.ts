import { spawn, spawnSync } from "node:child_process";
import {
  type PathLike,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  findOrphanedProcesses,
  listUserProcesses,
  owningWorktree,
  parseLsofFields,
  worktreeParentDirs,
} from "../scripts/lib/worktree/orphans.mjs";
import { processIsRunning, stopWorktreeNodeExecutors } from "../scripts/lib/worktree/exec.mjs";

const parents = ["/home/me/.t3/worktrees/freecorpsNFE", "/work/freecorpsNFE-worktrees"];

describe("worktree orphan detection", () => {
  it("lists the T3, sibling, Claude and Codex worktree parents", () => {
    expect(worktreeParentDirs("/work/freecorpsNFE", "/home/me")).toEqual([
      "/home/me/.t3/worktrees/freecorpsNFE",
      "/work/freecorpsNFE-worktrees",
      "/work/freecorpsNFE/.claude/worktrees",
      "/work/freecorpsNFE/.codex/worktrees",
    ]);
  });

  it("maps a nested path to the worktree that owns it", () => {
    expect(
      owningWorktree("/home/me/.t3/worktrees/freecorpsNFE/t3-ab/.convex/runtime/node", parents),
    ).toBe("/home/me/.t3/worktrees/freecorpsNFE/t3-ab");
    expect(owningWorktree("/work/freecorpsNFE-worktrees/feat/apps/web", parents)).toBe(
      "/work/freecorpsNFE-worktrees/feat",
    );
  });

  it("ignores paths outside worktree parents, the parents themselves and relative paths", () => {
    expect(owningWorktree("/work/freecorpsNFE/apps/web", parents)).toBeNull();
    expect(owningWorktree("/work/freecorpsNFE-worktrees", parents)).toBeNull();
    expect(owningWorktree("/work/freecorpsNFE-worktrees-old/x", parents)).toBeNull();
    expect(owningWorktree("node", parents)).toBeNull();
  });

  it("flags only processes whose worktree directory is gone", () => {
    const alive = "/work/freecorpsNFE-worktrees/alive";
    const processes = [
      { pid: 101, paths: ["/opt/homebrew/bin/node", `${alive}/apps/web`] },
      { pid: 102, paths: ["/home/me/.t3/worktrees/freecorpsNFE/t3-gone/.convex/runtime/bin/node"] },
      { pid: 103, paths: ["/opt/homebrew/bin/node", "/work/freecorpsNFE-worktrees/gone/apps/web"] },
      { pid: 104, paths: ["/bin/zsh", "/work/freecorpsNFE"] },
    ];
    const exists = (path: PathLike) => path === alive;
    expect(findOrphanedProcesses(processes, parents, exists)).toEqual([
      { pid: 102, worktree: "/home/me/.t3/worktrees/freecorpsNFE/t3-gone" },
      { pid: 103, worktree: "/work/freecorpsNFE-worktrees/gone" },
    ]);
  });

  it("never flags the current process", () => {
    const processes = [{ pid: process.pid, paths: ["/work/freecorpsNFE-worktrees/gone"] }];
    expect(findOrphanedProcesses(processes, parents, () => false)).toEqual([]);
  });

  it("parses lsof field output", () => {
    expect(parseLsofFields("p12\nfcwd\nn/a/b\np34\nfcwd\nn/c d\n")).toEqual(
      new Map([
        [12, "/a/b"],
        [34, "/c d"],
      ]),
    );
  });
});

describe.skipIf(process.platform === "win32")("worktree orphan detection on a live process", () => {
  let root = "";
  const children: number[] = [];
  afterEach(() => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("reports each process's executable and finds one whose cwd was deleted", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "wt-orphans-")));
    const gone = join(root, "gone");
    mkdirSync(gone);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      cwd: gone,
      stdio: "ignore",
    });
    children.push(child.pid!);
    await vi.waitFor(() => {
      expect(listUserProcesses().find(({ pid }) => pid === child.pid)?.paths).toContain(gone);
    });
    rmSync(gone, { recursive: true, force: true });

    const processes = listUserProcesses();
    // The executable is what identifies a worktree's Convex runtime (the
    // deleted-executable case is covered by the pure tests above: macOS
    // refuses to launch a relocated copy of most binaries).
    const entry = processes.find(({ pid }) => pid === child.pid);
    expect(entry?.paths[0]).toBe(realpathSync(process.execPath));
    expect(findOrphanedProcesses(processes, [root])).toEqual([{ pid: child.pid, worktree: gone }]);
  });
});

// macOS refuses to launch a relocated copy of most system binaries, so the
// stand-in for a worktree's private Convex runtime is compiled on the spot.
const hasCompiler = process.platform !== "win32" && spawnSync("cc", ["--version"]).status === 0;

describe.skipIf(!hasCompiler)("worktree Node runtime processes", () => {
  let root = "";
  const children: number[] = [];
  afterEach(() => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  function runtime(dir: string, ignoreTerm: boolean) {
    const bin = join(dir, ".convex", "runtime", "bin");
    mkdirSync(bin, { recursive: true });
    const source = join(root, ignoreTerm ? "stubborn.c" : "plain.c");
    writeFileSync(
      source,
      "#include <signal.h>\n#include <unistd.h>\n" +
        `int main(void) { ${ignoreTerm ? "signal(SIGTERM, SIG_IGN);" : ""} sleep(30); return 0; }\n`,
    );
    const node = join(bin, "node");
    expect(spawnSync("cc", ["-o", node, source]).status).toBe(0);
    return node;
  }

  async function start(executable: string) {
    const child = spawn(executable, [], { cwd: root, stdio: "ignore" });
    children.push(child.pid!);
    await vi.waitFor(() => {
      expect(listUserProcesses().find(({ pid }) => pid === child.pid)?.paths[0]).toBe(executable);
    });
    return child.pid!;
  }

  it("finds a process whose executable lived in a deleted worktree", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "wt-orphans-")));
    const worktree = join(root, "gone");
    const pid = await start(runtime(worktree, false));
    rmSync(worktree, { recursive: true, force: true });

    expect(findOrphanedProcesses(listUserProcesses(), [root])).toEqual([{ pid, worktree }]);
  });

  it("stops the worktree's executors, escalating to SIGKILL when SIGTERM is ignored", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "wt-orphans-")));
    const node = runtime(join(root, "alive"), true);
    const pid = await start(node);

    stopWorktreeNodeExecutors(node);
    await vi.waitFor(() => expect(processIsRunning(pid)).toBe(false));
  });
});
