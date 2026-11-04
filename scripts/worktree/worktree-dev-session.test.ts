import { afterEach, expect, it, vi } from "vite-plus/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, dev } from "../lib/worktree/session.mjs";
import { ownsOperation, readOperation } from "../lib/worktree/operation.mjs";
import { worktreePaths } from "../lib/worktree/paths.mjs";
import { readProcessRecord, writeProcessRecord } from "../lib/worktree/state.mjs";
import { stopRecordedProcesses } from "../lib/worktree/process-identity.mjs";
import { spawnConvexDev, waitForBackend } from "../lib/worktree/convex-local.mjs";
import { syncWorktree } from "../lib/worktree/sync.mjs";
import { processIsRunning } from "../lib/worktree/exec.mjs";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("../lib/worktree/state.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/state.mjs")>()),
  assertLinkedWorktree: vi.fn(),
}));
vi.mock("../lib/worktree/readiness.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/readiness.mjs")>()),
  waitForObservedSetup: vi.fn(async () => {}),
}));
vi.mock("../lib/worktree/deployment.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/deployment.mjs")>()),
  readLocalConfig: vi.fn(() => ({
    deploymentName: "local-synthetic",
    ports: { cloud: 3210, site: 3211 },
    adminKey: "synthetic",
  })),
}));
vi.mock("../lib/worktree/registry.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/registry.mjs")>()),
  resolveConvexPort: vi.fn(async () => 3210),
  resolveFrontendPort: vi.fn(async () => 5205),
}));
vi.mock("../lib/worktree/env-file.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/env-file.mjs")>()),
  ensureBackendEnvFile: vi.fn(),
  writeRuntimeEnv: vi.fn(),
  readEnvFile: vi.fn(() => new Map()),
}));
vi.mock("../lib/worktree/sync.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/sync.mjs")>()),
  syncWorktree: vi.fn(async () => {}),
}));
vi.mock("../lib/worktree/convex-local.mjs", async (original) => ({
  ...(await original<typeof import("../lib/worktree/convex-local.mjs")>()),
  stopWorktreeBackends: vi.fn(async () => []),
  syncBackendEnvironment: vi.fn(),
  spawnConvexDev: vi.fn(),
  waitForBackend: vi.fn(),
}));
vi.mock("../lib/worktree/process-identity.mjs", async (original) => {
  const actual = await original<typeof import("../lib/worktree/process-identity.mjs")>();
  return { ...actual, stopRecordedProcesses: vi.fn(actual.stopRecordedProcesses) };
});
const children: ChildProcess[] = [];
const roots: string[] = [];
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function synthetic(code = "setInterval(() => {}, 1000)") {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const child = actual.spawn(process.execPath, ["-e", code], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  await once(child, "spawn");
  return child;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fnfe-dev-session-"));
  roots.push(root);
  const paths = worktreePaths(root);
  mkdirSync(paths.convexDir);
  return paths;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["before", "during", "none"])(
  "a parada encerra só os próprios filhos com substituição %s da limpeza",
  async (replacementAt) => {
    const paths = fixture();
    const backend = await synthetic();
    const frontend = await synthetic(
      'process.stdin.once("data", () => console.log("http://localhost:5205/")); setInterval(() => {}, 1000)',
    );
    const foreign = await synthetic();
    vi.mocked(spawnConvexDev).mockReturnValueOnce(backend);
    vi.mocked(waitForBackend).mockResolvedValueOnce({
      deploymentName: "local-synthetic",
      ports: { cloud: 3210, site: 3211 },
      adminKey: "synthetic",
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => frontend.stdin!.write("ready"));
      return frontend;
    });
    const actual = await vi.importActual<typeof import("../lib/worktree/process-identity.mjs")>(
      "../lib/worktree/process-identity.mjs",
    );
    let replacementRecord: ReturnType<typeof readProcessRecord>;
    let replacementLock: string | undefined;
    {
      const controller = new AbortController();
      const ready = latch();
      const stopping = latch();
      const releaseStop = latch();
      const done = dev({
        root: paths.root,
        signal: controller.signal,
        onReady: ready.release,
      });
      await ready.promise;
      const owned = readProcessRecord(paths);
      const replace = () => {
        replacementRecord = writeProcessRecord(paths, { cwd: paths.root, pid: foreign.pid });
        replacementLock = JSON.stringify({
          ...readOperation(paths),
          command: "dev",
          runId: randomUUID(),
        });
        writeFileSync(join(paths.convexDir, "worktree-operation.lock"), replacementLock);
      };
      if (replacementAt === "before") replace();
      vi.mocked(stopRecordedProcesses).mockImplementationOnce(async (record) => {
        expect(record).toEqual(owned);
        if (replacementAt === "during") replace();
        stopping.release();
        await releaseStop.promise;
        return actual.stopRecordedProcesses(record);
      });
      let finished = false;
      void done.then(() => {
        finished = true;
      });
      controller.abort();
      await stopping.promise;
      controller.abort();
      controller.abort();
      expect(finished).toBe(false);
      expect(processIsRunning(foreign.pid)).toBe(true);
      releaseStop.release();
      await done;
      expect(stopRecordedProcesses).toHaveBeenCalledOnce();
      expect(backend.exitCode !== null || backend.signalCode !== null).toBe(true);
      expect(frontend.exitCode !== null || frontend.signalCode !== null).toBe(true);
      expect(processIsRunning(foreign.pid)).toBe(true);
      if (replacementAt === "none") expect(readProcessRecord(paths)).toBeNull();
      else {
        expect(readProcessRecord(paths)).toEqual(replacementRecord);
        expect(ownsOperation(paths, ["dev"])).toBe(false);
      }
    }
    if (replacementAt === "none") expect(readOperation(paths).state).toBe("idle");
    else
      expect(readFileSync(join(paths.convexDir, "worktree-operation.lock"), "utf8")).toBe(
        replacementLock,
      );
  },
  30000,
);

it("cancelamento no startup espera a etapa em curso e não inicia o dev", async () => {
  const paths = fixture();
  const entered = latch();
  const release = latch();
  vi.mocked(syncWorktree).mockImplementationOnce(async () => {
    entered.release();
    await release.promise;
  });
  const controller = new AbortController();
  const done = dev({ root: paths.root, signal: controller.signal });
  await entered.promise;
  controller.abort();
  controller.abort();
  expect(readOperation(paths).command).toBe("dev");
  expect(readOperation(paths).state).toBe("running");
  release.release();
  await expect(done).rejects.toBe(controller.signal.reason);
  expect(spawnConvexDev).not.toHaveBeenCalled();
  expect(stopRecordedProcesses).not.toHaveBeenCalled();
  expect(readOperation(paths).state).toBe("idle");
});

it.each(["backend", "frontend"])(
  "falha de startup em %s encerra só os filhos sintéticos capturados",
  async (failedPhase) => {
    const paths = fixture();
    const backend = await synthetic();
    const foreign = await synthetic();
    vi.mocked(spawnConvexDev).mockReturnValueOnce(backend);
    if (failedPhase === "backend")
      vi.mocked(waitForBackend).mockRejectedValueOnce(new Error("SYNTHETIC_STARTUP_FAILURE"));
    else {
      const frontend = await synthetic(
        'process.stdin.once("data", () => process.exit(7)); setInterval(() => {}, 1000)',
      );
      vi.mocked(waitForBackend).mockResolvedValueOnce({
        deploymentName: "local-synthetic",
        ports: { cloud: 3210, site: 3211 },
        adminKey: "synthetic",
      });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => frontend.stdin!.write("fail"));
        return frontend;
      });
    }
    const exited = once(backend, "exit");
    await expect(dev({ root: paths.root })).rejects.toThrow();
    await exited;
    expect(processIsRunning(foreign.pid)).toBe(true);
    expect(readProcessRecord(paths)).toBeNull();
    expect(readOperation(paths).state).toBe("idle");
  },
  30000,
);

it("mantém o frontend cuja parada no startup falhou até uma limpeza posterior", async () => {
  const paths = fixture();
  const backend = await synthetic();
  const frontend = await synthetic();
  // Os filhos sintéticos são filhos diretos do teste: até o reap, um encerrado
  // continua visível como zumbi para `kill(pid, 0)` em POSIX. Usa o evento exit.
  // `events.once` rejeitaria no "error" sintético; aqui só importa a saída.
  const exitOf = (child: ChildProcess) => new Promise((resolve) => child.once("exit", resolve));
  const backendExited = exitOf(backend);
  const frontendExited = exitOf(frontend);
  vi.mocked(spawnConvexDev).mockReturnValueOnce(backend);
  vi.mocked(waitForBackend).mockResolvedValueOnce({
    deploymentName: "local-synthetic",
    ports: { cloud: 3210, site: 3211 },
    adminKey: "synthetic",
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => frontend.emit("error", new Error("SYNTHETIC_STARTUP_FAILURE")));
    return frontend;
  });
  const actual = await vi.importActual<typeof import("../lib/worktree/process-identity.mjs")>(
    "../lib/worktree/process-identity.mjs",
  );
  vi.mocked(stopRecordedProcesses).mockImplementation(async (record) => {
    const pids = record.pids ?? [record.pid];
    if (pids.includes(backend.pid)) {
      await actual.stopRecordedProcesses({ ...record, pids: [backend.pid] });
    }
    if (pids.includes(frontend.pid)) throw new Error("SYNTHETIC_IDENTITY_PROBE_FAILED");
    return [];
  });
  await expect(dev({ root: paths.root })).rejects.toThrow("SYNTHETIC_IDENTITY_PROBE_FAILED");
  const pending = readProcessRecord(paths);
  expect(pending?.pids).toContain(frontend.pid);
  expect(pending?.identities[frontend.pid!]).toEqual(expect.any(String));
  await backendExited;
  expect(frontend.exitCode ?? frontend.signalCode).toBeNull();
  expect(readOperation(paths).state).toBe("idle");
  vi.mocked(stopRecordedProcesses).mockImplementation(actual.stopRecordedProcesses);
  await cleanup({ root: paths.root, quiet: true });
  await frontendExited;
  expect(readProcessRecord(paths)).toBeNull();
}, 30000);

it("parada que falha remove os handlers de sinal e preserva o registro", async () => {
  const paths = fixture();
  const backend = await synthetic();
  const frontend = await synthetic(
    'process.stdin.once("data", () => { console.log("http://localhost:5205/"); setTimeout(() => process.exit(3), 200); }); setInterval(() => {}, 1000)',
  );
  vi.mocked(spawnConvexDev).mockReturnValueOnce(backend);
  vi.mocked(waitForBackend).mockResolvedValueOnce({
    deploymentName: "local-synthetic",
    ports: { cloud: 3210, site: 3211 },
    adminKey: "synthetic",
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => frontend.stdin!.write("ready"));
    return frontend;
  });
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  vi.mocked(stopRecordedProcesses).mockRejectedValue(new Error("SYNTHETIC_STOP_FAILURE"));
  await expect(dev({ root: paths.root })).rejects.toThrow("SYNTHETIC_STOP_FAILURE");
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
  expect(readProcessRecord(paths)?.pids).toEqual([backend.pid, frontend.pid]);
}, 30000);

/** Um lock de dev como o que `withOperation` grava, com o dono informado. */
async function devLock(paths: ReturnType<typeof worktreePaths>, owner: ChildProcess) {
  const { readProcessIdentity } = await vi.importActual<
    typeof import("../lib/worktree/process-identity.mjs")
  >("../lib/worktree/process-identity.mjs");
  const record = {
    version: 1,
    runId: randomUUID(),
    pid: owner.pid,
    identity: readProcessIdentity(owner.pid!),
    command: "dev",
    startedAt: new Date().toISOString(),
    outcome: "running",
  };
  writeFileSync(join(paths.convexDir, "worktree-operation.lock"), JSON.stringify(record));
  return record;
}

it("cleanup libera o lock de um dev que morreu sem soltá-lo, depois de parar os filhos", async () => {
  const paths = fixture();
  const actual = await vi.importActual<typeof import("../lib/worktree/process-identity.mjs")>(
    "../lib/worktree/process-identity.mjs",
  );
  vi.mocked(stopRecordedProcesses).mockImplementation(actual.stopRecordedProcesses);
  const owner = await synthetic();
  await devLock(paths, owner);
  // O filho continua vivo depois que o dono morre, como o Vite e o Convex de
  // um dev encerrado à força.
  const orphan = await synthetic();
  const orphanExited = once(orphan, "exit");
  writeProcessRecord(paths, { cwd: paths.root, pid: orphan.pid, pids: [orphan.pid] });
  const ownerExited = once(owner, "exit");
  owner.kill("SIGKILL");
  await ownerExited;
  expect(readOperation(paths).state).toBe("interrupted");

  await cleanup({ root: paths.root, quiet: true });

  await orphanExited;
  expect(processIsRunning(orphan.pid!)).toBe(false);
  expect(readProcessRecord(paths)).toBeNull();
  expect(readOperation(paths).state).toBe("idle");
}, 30000);

it("cleanup mantém o lock de um dev vivo", async () => {
  const paths = fixture();
  const actual = await vi.importActual<typeof import("../lib/worktree/process-identity.mjs")>(
    "../lib/worktree/process-identity.mjs",
  );
  vi.mocked(stopRecordedProcesses).mockImplementation(actual.stopRecordedProcesses);
  const owner = await synthetic();
  const lock = await devLock(paths, owner);

  await cleanup({ root: paths.root, quiet: true });

  expect(readOperation(paths)).toMatchObject({ state: "running", runId: lock.runId });
  expect(processIsRunning(owner.pid!)).toBe(true);
}, 30000);
