import { expect, it } from "vite-plus/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { spawnOwnedProcess } from "../scripts/lib/worktree/owned-process.mjs";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendPidsFromProcessList,
  stopWorktreeBackends,
} from "../scripts/lib/worktree/convex-local.mjs";
import { processIsRunning } from "../scripts/lib/worktree/exec.mjs";
import { worktreePaths } from "../scripts/lib/worktree/paths.mjs";
import { readProcessRecord, writeProcessRecord } from "../scripts/lib/worktree/state.mjs";
import {
  readProcessIdentity,
  recordedProcessIsRunning,
  stopRecordedProcesses,
} from "../scripts/lib/worktree/process-identity.mjs";

it("cleanup preserva PID reutilizado e só encerra o processo com identidade confirmada", async () => {
  const child = spawnOwnedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  const root = mkdtempSync(join(tmpdir(), "fnfe-process-test-"));
  try {
    await once(child, "spawn");
    const pid = child.pid!;
    const identity = readProcessIdentity(pid);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    const stale = { pids: [pid], identities: { [pid]: "previous-process" } };
    expect(recordedProcessIsRunning(stale, pid)).toBe(false);
    expect(await stopRecordedProcesses(stale)).toEqual([]);
    expect(processIsRunning(pid)).toBe(true);
    await expect(stopRecordedProcesses({ pids: [pid] })).rejects.toThrow(/identidade/);
    expect(processIsRunning(pid)).toBe(true);
    const paths = worktreePaths(root);
    mkdirSync(paths.convexDir);
    writeFileSync(paths.processFile, JSON.stringify({ ...stale, cwd: root, pid }));
    writeProcessRecord(paths, { cwd: root, pid, pids: [pid] }, stale.identities);
    expect(readProcessRecord(paths).identities[pid]).toBe("previous-process");
    expect(await stopRecordedProcesses(readProcessRecord(paths))).toEqual([]);
    expect(processIsRunning(pid)).toBe(true);
    writeProcessRecord(paths, { cwd: root, pid, pids: [pid] });
    const record = readProcessRecord(paths);
    expect(record.identities[pid]).toBe(identity);
    expect(recordedProcessIsRunning(record, pid)).toBe(true);
    expect(await stopRecordedProcesses(record)).toEqual([pid]);
    await exited;
    expect(processIsRunning(pid)).toBe(false);
  } finally {
    child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

it("acha só os backends cujo banco fica dentro deste worktree", () => {
  // Só a raiz do banco importa; `worktreePaths` resolveria `/w/wt` para `C:\w\wt` no Windows.
  const posix = { backendRoot: "/w/wt" };
  const storage = (root: string) => `${root}/.convex/local/default/convex_local_storage`;
  const backend = "/home/dev/.cache/convex/binaries/x/convex-local-backend --port 3210";
  expect(
    backendPidsFromProcessList(
      [
        `  101 ${backend} --local-storage ${storage("/w/wt")} /w/wt/.convex/local/default/db.sqlite3`,
        // Outro worktree com o mesmo prefixo de caminho.
        `  102 ${backend} --local-storage ${storage("/w/wt-2")} /w/wt-2/db.sqlite3`,
        // Backend de outro projeto na máquina.
        `  103 ${backend} --local-storage /outro/projeto/.convex/local/default/s /outro/db`,
        // Processo que só menciona o caminho, sem ser backend.
        `  104 /usr/bin/node script.js --local-storage ${storage("/w/wt")}`,
        "  linha malformada",
      ],
      posix,
      "linux",
    ),
  ).toEqual([101]);

  // No Windows a caixa do caminho varia entre shells e o CIM pode citar o argumento.
  const windows = { backendRoot: "C:\\w\\wt" };
  const root = windows.backendRoot;
  expect(
    backendPidsFromProcessList(
      [
        `7 "C:\\cache\\convex-local-backend.exe" --local-storage "${root.toUpperCase()}\\.convex\\local\\default\\s"`,
        `8 C:\\cache\\convex-local-backend.exe --local-storage ${root}-2\\.convex\\local\\default\\s`,
      ],
      windows,
      "win32",
    ),
  ).toEqual([7]);
});

it.skipIf(process.platform === "win32")(
  "encerra o backend órfão deste worktree e preserva o de outro",
  async () => {
    const base = mkdtempSync(join(tmpdir(), "fnfe-backend-test-"));
    const own = worktreePaths(join(base, "wt"));
    const other = worktreePaths(join(base, "wt-2"));
    // Processos que imitam a linha de comando do backend local do Convex.
    const fake = (root: string) =>
      spawn(
        process.execPath,
        [
          "-e",
          "setInterval(() => {}, 1000)",
          "convex-local-backend",
          "--local-storage",
          join(root, ".convex", "local", "default", "convex_local_storage"),
        ],
        { stdio: "ignore" },
      );
    const children = [fake(own.backendRoot), fake(other.backendRoot)];
    const exits = children.map((child) => once(child, "exit"));
    try {
      await Promise.all(children.map((child) => once(child, "spawn")));
      const [ownPid, otherPid] = children.map((child) => child.pid!);
      expect(await stopWorktreeBackends(own)).toEqual([ownPid]);
      await exits[0];
      expect(processIsRunning(ownPid)).toBe(false);
      expect(processIsRunning(otherPid)).toBe(true);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(exits);
      rmSync(base, { recursive: true, force: true });
    }
  },
  30000,
);

// O recurso observável é um socket real. A folha ignora TERM, então matar só o
// CLI (ou esperar só a saída dele) não satisfaz a asserção.
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function canBind(port: number) {
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

it.skipIf(process.platform === "win32").each(["alive", "exited", "unowned-control"])(
  "grupo próprio e porta real: %s",
  async (mode) => {
    const exitCli = mode !== "alive";
    const root = mkdtempSync(join(tmpdir(), "fnfe-owned-group-"));
    const ready = join(root, "ready.json");
    const release = join(root, "exit");
    const leaf = `
      const net = require('node:net'), fs = require('node:fs');
      process.on('SIGTERM', () => {});
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, port: server.address().port}));
      });
      setTimeout(() => process.exit(), 15000);
    `;
    const cli = `
      const {spawn} = require('node:child_process'), fs = require('node:fs');
      spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], {stdio:'ignore'}).unref();
      setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(); }, 10);
    `;
    const launch = mode === "unowned-control" ? spawn : spawnOwnedProcess;
    const owner = launch(process.execPath, ["-e", cli], { stdio: "ignore", detached: true });
    const exited = once(owner, "exit");
    let leafRecord;
    try {
      await once(owner, "spawn");
      const pid = owner.pid!;
      const record = { pids: [pid], identities: { [pid]: readProcessIdentity(pid) } };
      const deadline = Date.now() + 5000;
      while (!existsSync(ready) && Date.now() < deadline) await delay(20);
      const resource = JSON.parse(readFileSync(ready, "utf8"));
      leafRecord = {
        pids: [resource.pid],
        identities: { [resource.pid]: readProcessIdentity(resource.pid) },
      };
      expect(await canBind(resource.port)).toBe(false);
      // Um registro antigo preserva o substituto vivo e o recurso dele.
      await stopRecordedProcesses({ pids: [pid], identities: { [pid]: "old-owner" } });
      expect(await canBind(resource.port)).toBe(false);
      if (exitCli) {
        writeFileSync(release, "exit");
        await exited;
      }
      if (mode === "unowned-control") {
        expect(await canBind(resource.port)).toBe(false);
        await expect(stopRecordedProcesses(record)).rejects.toThrow(/ainda possui processos/);
        return;
      }
      await stopRecordedProcesses(record);
      await exited;
      expect(await canBind(resource.port)).toBe(true);
      await stopRecordedProcesses(record);
      expect(await canBind(resource.port)).toBe(true);
    } finally {
      owner.kill("SIGTERM");
      await exited;
      // Só a folha sintética capturada; o tempo de vida limitado também protege
      // o host quando a implementação testada está quebrada de propósito.
      if (leafRecord) {
        const pid = leafRecord.pids[0];
        if (readProcessIdentity(pid) === leafRecord.identities[pid]) process.kill(pid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

it.skipIf(process.platform === "win32").each([
  ["process.exit(7)", 7, null],
  ['process.kill(process.pid, "SIGUSR2")', null, "SIGUSR2"],
])("supervisor repassa o desfecho do CLI: %s", async (code, exitCode, signalCode) => {
  const owner = spawnOwnedProcess(process.execPath, ["-e", code], { stdio: "ignore" });
  const [actualCode, actualSignal] = await once(owner, "exit");
  expect([actualCode, actualSignal]).toEqual([exitCode, signalCode]);
});
