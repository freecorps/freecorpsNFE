import { afterEach, expect, it, vi } from "vite-plus/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { worktreePaths } from "./lib/worktree/paths.mjs";
import { operationIsRunning, readOperation, withOperation } from "./lib/worktree/operation.mjs";
import {
  readWorktreeStatus,
  waitForObservedSetup,
  waitForSetup,
} from "./lib/worktree/readiness.mjs";
import { cleanup, dev } from "./lib/worktree/session.mjs";
import { stopWorktreeBackends, waitForBackend } from "./lib/worktree/convex-local.mjs";
import { processIsRunning, stopWorktreeNodeExecutors } from "./lib/worktree/exec.mjs";
import {
  devIsRunning,
  readProcessRecord,
  removeProcessRecordFor,
  writeProcessRecord,
} from "./lib/worktree/state.mjs";
import { readLocalConfig } from "./lib/worktree/deployment.mjs";
import { readProcessIdentity, stopRecordedProcesses } from "./lib/worktree/process-identity.mjs";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
vi.mock("./lib/worktree/deployment.mjs", async (original) => {
  const actual = await original<typeof import("./lib/worktree/deployment.mjs")>();
  return { ...actual, readLocalConfig: vi.fn(actual.readLocalConfig) };
});
vi.mock("./lib/worktree/process-identity.mjs", async (original) => {
  const actual = await original<typeof import("./lib/worktree/process-identity.mjs")>();
  return { ...actual, stopRecordedProcesses: vi.fn(actual.stopRecordedProcesses) };
});

vi.mock("./lib/worktree/state.mjs", async (original) => {
  const actual = await original<typeof import("./lib/worktree/state.mjs")>();
  return {
    ...actual,
    assertLinkedWorktree: vi.fn(),
    devIsRunning: vi.fn(actual.devIsRunning),
    readProcessRecord: vi.fn(actual.readProcessRecord),
  };
});
vi.mock("./lib/worktree/convex-local.mjs", async (original) => ({
  ...(await original<typeof import("./lib/worktree/convex-local.mjs")>()),
  stopWorktreeBackends: vi.fn(async () => []),
}));
vi.mock("./lib/worktree/exec.mjs", async (original) => ({
  ...(await original<typeof import("./lib/worktree/exec.mjs")>()),
  stopWorktreeNodeExecutors: vi.fn(),
}));

const roots: string[] = [];
const children: ChildProcess[] = [];
const platform = process.platform;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fnfe-readiness-"));
  roots.push(root);
  const paths = worktreePaths(root);
  mkdirSync(paths.convexDir);
  return paths;
}
function config(paths: ReturnType<typeof worktreePaths>) {
  mkdirSync(dirname(paths.localConfig), { recursive: true });
  writeFileSync(
    paths.localConfig,
    JSON.stringify({
      deploymentName: "local-fixture",
      ports: { cloud: 3210, site: 3211 },
      adminKey: "private-fixture",
    }),
  );
}
function childScript(code: string, args: string[] = []) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  return { child, exited: once(child, "exit"), output: () => output };
}
const operationModule = pathToFileURL(resolve("scripts/lib/worktree/operation.mjs")).href;
const pathsModule = pathToFileURL(resolve("scripts/lib/worktree/paths.mjs")).href;
function operationChild(root: string, command = "setup") {
  return childScript(
    `
    import { withOperation } from ${JSON.stringify(operationModule)};
    import { worktreePaths } from ${JSON.stringify(pathsModule)};
    const release = new Promise(resolve => process.stdin.once('data', resolve));
    try {
      await withOperation(worktreePaths(process.argv[1]), process.argv[2], async () => {
        console.log('entered');
        await release;
      });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    process.stdin.destroy();
  `,
    [root, command],
  );
}
async function entered(runner: ReturnType<typeof operationChild>) {
  await vi.waitFor(() => expect(runner.output()).toContain("entered"), { timeout: 15000 });
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
  Object.defineProperty(process, "platform", { value: platform });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it("espera antes do setup, recusa concorrente real e só aprova o resultado persistido", async () => {
  const paths = fixture();
  const waiting = waitForSetup(paths.root, { timeoutMs: 25000, pollMs: 25 });
  const owner = operationChild(paths.root);
  await entered(owner);
  const running = readWorktreeStatus(paths.root);
  expect(running.setup.state).toBe("running");
  const contender = operationChild(paths.root);
  expect((await contender.exited)[0]).toBe(1);
  expect(contender.output()).not.toContain("entered");
  expect(readWorktreeStatus(paths.root).setup.runId).toBe(running.setup.runId);
  owner.child.stdin!.write("finish");
  expect((await owner.exited)[0]).toBe(0);
  expect(await waiting).toMatchObject({ outcome: "succeeded", runId: running.setup.runId });
  expect(readWorktreeStatus(paths.root).operation.state).toBe("idle");
}, 40000);

it("timeout do observador preserva dono, lock e recibo", async () => {
  const paths = fixture();
  const owner = operationChild(paths.root);
  await entered(owner);
  const lock = join(paths.convexDir, "worktree-operation.lock");
  const before = readFileSync(lock, "utf8");
  expect(await waitForSetup(paths.root, { timeoutMs: 0 })).toMatchObject({ outcome: "timeout" });
  expect(readFileSync(lock, "utf8")).toBe(before);
  expect(processIsRunning(owner.child.pid)).toBe(true);
  owner.child.stdin!.write("finish");
  await owner.exited;
}, 30000);

it("config parcial e sucesso anterior não encobrem falha de setup", async () => {
  const paths = fixture();
  config(paths);
  expect(readWorktreeStatus(paths.root).setup.state).toBe("unobserved");
  expect(await waitForSetup(paths.root, { timeoutMs: 0 })).toMatchObject({ outcome: "timeout" });
  await withOperation(paths, "setup", async () => {});
  await expect(
    withOperation(paths, "setup", async () => {
      expect(readWorktreeStatus(paths.root).setup.state).toBe("running");
      throw new Error("private-fixture");
    }),
  ).rejects.toThrow("private-fixture");
  const status = readWorktreeStatus(paths.root);
  expect(status.setup.state).toBe("failed");
  expect(status.configuration.state).toBe("present");
  expect(JSON.stringify(status)).not.toContain("private-fixture");
  expect(readFileSync(join(paths.convexDir, "worktree-setup.json"), "utf8")).not.toContain(
    "private-fixture",
  );
  expect(await waitForSetup(paths.root, { timeoutMs: 0 })).toMatchObject({ outcome: "failed" });
  await expect(waitForObservedSetup(paths.root)).rejects.toThrow("failed");
});

it("interrupção de dono real não vira sucesso nem recupera lock automaticamente", async () => {
  const paths = fixture();
  const owner = operationChild(paths.root);
  await entered(owner);
  owner.child.kill("SIGKILL");
  await owner.exited;
  expect(await waitForSetup(paths.root, { timeoutMs: 0 })).toMatchObject({
    outcome: "interrupted",
  });
  await expect(withOperation(paths, "sync", async () => {})).rejects.toThrow("lock sem conclusão");
  expect(operationIsRunning(paths)).toBe(true);
}, 30000);

it("PID reutilizado, identidade desconhecida e lock ilegível continuam bloqueados", async () => {
  const paths = fixture();
  const lock = join(paths.convexDir, "worktree-operation.lock");
  for (const [content, state] of [
    ["{", "indeterminate"],
    [JSON.stringify({ pid: process.pid, command: "setup" }), "indeterminate"],
    [
      JSON.stringify({
        pid: process.pid,
        command: "setup",
        identity: "0".repeat(64),
        runId: randomUUID(),
      }),
      "interrupted",
    ],
  ]) {
    writeFileSync(lock, content);
    expect(readOperation(paths).state).toBe(state);
    await expect(withOperation(paths, "sync", async () => {})).rejects.toThrow(
      "lock sem conclusão",
    );
    expect(readFileSync(lock, "utf8")).toBe(content);
  }
});

it("liberação distingue runId mesmo quando o PID não muda", async () => {
  const paths = fixture();
  const lock = join(paths.convexDir, "worktree-operation.lock");
  let replacement = "";
  await withOperation(paths, "sync", async () => {
    replacement = JSON.stringify({
      ...JSON.parse(readFileSync(lock, "utf8")),
      runId: randomUUID(),
    });
    writeFileSync(lock, replacement);
  });
  expect(readFileSync(lock, "utf8")).toBe(replacement);
});

it("não libera setup quando o resultado final não pode ser persistido", async () => {
  const paths = fixture();
  await expect(
    withOperation(paths, "setup", async () => {
      const receipt = join(paths.convexDir, "worktree-setup.json");
      rmSync(receipt);
      mkdirSync(receipt);
    }),
  ).rejects.toThrow();
  expect(operationIsRunning(paths)).toBe(true);
  expect(readWorktreeStatus(paths.root).setup.state).not.toBe("succeeded");
});

it("EPERM e erro desconhecido não declaram um PID morto", () => {
  const kill = vi.spyOn(process, "kill");
  for (const code of ["EPERM", "EACCES", "ESRCH"]) {
    kill.mockImplementation(() => {
      throw Object.assign(new Error("fixture"), { code });
    });
    expect(processIsRunning(123)).toBe(code !== "ESRCH");
  }
});

it.each(["setup", "sync"])("cleanup preserva todos os executores durante %s", async (command) => {
  const paths = fixture();
  await withOperation(paths, command, async () => {
    await cleanup({ root: paths.root, quiet: true });
    expect(stopWorktreeBackends).not.toHaveBeenCalled();
    expect(stopWorktreeNodeExecutors).not.toHaveBeenCalled();
  });
});

it("cleanup segura exclusão durante toda a varredura", async () => {
  const paths = fixture();
  vi.mocked(stopWorktreeBackends).mockImplementationOnce(async () => {
    const contender = operationChild(paths.root, "sync");
    expect((await contender.exited)[0]).toBe(1);
    expect(contender.output()).not.toContain("entered");
    return [];
  });
  await cleanup({ root: paths.root, quiet: true });
  expect(stopWorktreeNodeExecutors).toHaveBeenCalledOnce();
  expect(readOperation(paths).state).toBe("idle");
}, 30000);

it("cleanup para dev identificado sem varrer órfãos sob o lock de dev", async () => {
  const paths = fixture();
  const runner = childScript("setInterval(() => {}, 1000)");
  await once(runner.child, "spawn");
  await withOperation(paths, "dev", async () => {
    writeProcessRecord(paths, { cwd: paths.root, pid: runner.child.pid });
    const record = readProcessRecord(paths);
    await cleanup({ root: paths.root, quiet: true });
    await runner.exited;
    expect(readProcessRecord(paths)).toEqual(record);
    // O dono remove o registro ainda sob seu lock, como no encerramento de dev.
    removeProcessRecordFor(paths, runner.child.pid);
    expect(readProcessRecord(paths)).toBeNull();
    expect(stopWorktreeBackends).not.toHaveBeenCalled();
    expect(stopWorktreeNodeExecutors).not.toHaveBeenCalled();
  });
}, 30000);

it("dev espera setup observado e aceita ambiente antigo sem inventar recibo", async () => {
  const paths = fixture();
  config(paths);
  await waitForObservedSetup(paths.root);
  expect(readWorktreeStatus(paths.root).setup.state).toBe("unobserved");
  const owner = operationChild(paths.root);
  await entered(owner);
  const waiting = waitForObservedSetup(paths.root, { timeoutMs: 20000 });
  owner.child.stdin!.write("finish");
  await owner.exited;
  await waiting;
}, 30000);

it("CLI status funciona sem node_modules e não expõe conteúdo inválido", async () => {
  const paths = fixture();
  cpSync(resolve("scripts/lib/worktree"), join(paths.root, "scripts/lib/worktree"), {
    recursive: true,
  });
  cpSync(resolve("scripts/worktree.mjs"), join(paths.root, "scripts/worktree.mjs"));
  mkdirSync(join(paths.root, "lib"));
  cpSync(resolve("lib/worktree-local.ts"), join(paths.root, "lib/worktree-local.ts"));
  writeFileSync(paths.appFile, '{"app":"private-fixture"}');
  const cli = pathToFileURL(join(paths.root, "scripts/worktree.mjs")).href;
  const runner = childScript(
    `process.argv = [process.execPath, 'worktree.mjs', 'status', '--json']; await import(${JSON.stringify(cli)});`,
  );
  expect((await runner.exited)[0], runner.output()).toBe(0);
  const output = runner
    .output()
    .split("\n")
    .find((line) => line.startsWith("{"))!;
  expect(JSON.parse(output)).toMatchObject({ version: 1, configuration: { state: "invalid" } });
  expect(output).not.toContain("private-fixture");
  expect(existsSync(join(paths.root, "node_modules"))).toBe(false);
  for (const [outcome, exitCode] of [
    ["timeout", 2],
    ["failed", 1],
    ["succeeded", 0],
  ] as const) {
    if (outcome !== "timeout") {
      try {
        await withOperation(paths, "setup", async () => {
          if (outcome === "failed") throw new Error("fixture");
        });
      } catch {
        /* A CLI observa o resultado persistido abaixo. */
      }
    }
    const waiter = childScript(
      `process.argv = [process.execPath, 'worktree.mjs', 'wait', '--json', '--timeout-ms', '0']; await import(${JSON.stringify(cli)});`,
    );
    expect((await waiter.exited)[0], waiter.output()).toBe(exitCode);
    expect(JSON.parse(waiter.output())).toMatchObject({ version: 1, outcome });
  }
});

it("dev aguarda fora do lock e relê aplicativo depois do setup", async () => {
  const paths = fixture();
  let pending: Promise<unknown> | undefined;
  vi.mocked(devIsRunning).mockImplementationOnce((current) => {
    expect(current.app).toBe("platform");
    expect(readOperation(current).command).toBe("dev");
    return true;
  });
  await withOperation(paths, "setup", async () => {
    pending = expect(dev({ root: paths.root, timeoutMs: 20000 })).rejects.toThrow("dev rodando");
    expect(readOperation(paths).command).toBe("setup");
    writeFileSync(paths.appFile, JSON.stringify({ app: "platform" }));
  });
  await pending;
}, 30000);

it("espera não adota uma execução posterior ao runId observado", async () => {
  const paths = fixture();
  await withOperation(paths, "setup", async () => {});
  const previous = readWorktreeStatus(paths.root).setup.runId;
  await withOperation(paths, "setup", async () => {});
  expect(await waitForSetup(paths.root, { timeoutMs: 0, runId: previous })).toMatchObject({
    outcome: "indeterminate",
    runId: previous,
  });
});

it("cleanup revalida a operação antes de parar um registro recém-lido", async () => {
  const paths = fixture();
  const runner = childScript("setInterval(() => {}, 1000)");
  await once(runner.child, "spawn");
  await withOperation(paths, "dev", async () => {
    writeProcessRecord(paths, { cwd: paths.root, pid: runner.child.pid });
    const record = readProcessRecord(paths);
    vi.mocked(readProcessRecord).mockImplementationOnce(() => {
      const lock = join(paths.convexDir, "worktree-operation.lock");
      writeFileSync(
        lock,
        JSON.stringify({ ...JSON.parse(readFileSync(lock, "utf8")), runId: randomUUID() }),
      );
      return record;
    });
    await cleanup({ root: paths.root, quiet: true });
    expect(processIsRunning(runner.child.pid)).toBe(true);
    expect(readProcessRecord(paths)).toEqual(record);
    expect(stopWorktreeBackends).not.toHaveBeenCalled();
    expect(stopWorktreeNodeExecutors).not.toHaveBeenCalled();
  });
}, 30000);

it("cleanup de dev não abre a janela de leitura e remoção do registro seguinte", async () => {
  const paths = fixture();
  await withOperation(paths, "dev", async () => {
    const record = { cwd: paths.root, pid: 123, recordId: randomUUID() };
    writeFileSync(paths.processFile, JSON.stringify(record));
    vi.mocked(stopRecordedProcesses).mockResolvedValueOnce([]);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(rmSync).mockImplementationOnce((path, options) => {
      // Interleaving reproduzido: o próximo dev grava entre a comparação
      // do registro anterior e o delete do cleanup sem lock próprio.
      expect(path).toBe(paths.processFile);
      writeFileSync(path, JSON.stringify({ ...record, recordId: randomUUID() }));
      actualFs.rmSync(path, options);
    });
    await cleanup({ root: paths.root, quiet: true });
    expect(readProcessRecord(paths)).toEqual(record);
    expect(rmSync).not.toHaveBeenCalled();
    expect(stopRecordedProcesses).toHaveBeenCalledWith(record);
  });
});

it("cleanup preserva o novo registro publicado enquanto encerra os filhos antigos", async () => {
  const paths = fixture();
  await withOperation(paths, "dev", async () => {
    const oldRecord = { cwd: paths.root, pid: 123, recordId: randomUUID() };
    const newRecord = { ...oldRecord, pid: 456, recordId: randomUUID() };
    writeFileSync(paths.processFile, JSON.stringify(oldRecord));
    vi.mocked(stopRecordedProcesses).mockImplementationOnce(async () => {
      writeFileSync(paths.processFile, JSON.stringify(newRecord));
      return [];
    });
    await cleanup({ root: paths.root, quiet: true });
    expect(readProcessRecord(paths)).toEqual(newRecord);
  });
});

it.each(["cleanup", "remove"])(
  "sweep remove registro sob o próprio lock de %s",
  async (command) => {
    const paths = fixture();
    writeFileSync(paths.processFile, JSON.stringify({ cwd: paths.root, pid: 123 }));
    vi.mocked(stopRecordedProcesses).mockImplementationOnce(async () => {
      expect(readOperation(paths).command).toBe(command);
      return [];
    });
    const sweep = () => cleanup({ root: paths.root, quiet: true });
    if (command === "remove") await withOperation(paths, command, sweep);
    else await sweep();
    expect(existsSync(paths.processFile)).toBe(false);
    expect(stopWorktreeBackends).toHaveBeenCalledOnce();
    expect(stopWorktreeNodeExecutors).toHaveBeenCalledOnce();
  },
);

// Instante fixo dos registros: a espera mede pelo `performance.now` simulado, não pelo relógio
// real (freecorps/no-wall-clock-in-tests).
const FIXED_AT = "2026-06-15T15:00:00.000Z";
function timedObservation() {
  const paths = fixture();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  // Exercita a sonda via subprocesso também em hosts Linux, sem executar CIM.
  Object.defineProperty(process, "platform", { value: "win32" });
  const probeOutput = "synthetic-process";
  // A espera observa outro processo. O PID próprio pode reutilizar sua identidade.
  const observedPid = process.pid + 1;
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid !== observedPid) throw Object.assign(new Error("Processo ausente"), { code: "ESRCH" });
    return true;
  });
  const record = {
    version: 1,
    command: "setup",
    pid: observedPid,
    runId: randomUUID(),
    identity: createHash("sha256").update(probeOutput).digest("hex"),
    startedAt: FIXED_AT,
    outcome: "running",
  };
  const lock = join(paths.convexDir, "worktree-operation.lock");
  const receipt = join(paths.convexDir, "worktree-setup.json");
  return {
    paths,
    record,
    lock,
    receipt,
    advance: (ms: number) => {
      now += ms;
    },
    probeResult: { pid: 123, output: [], stdout: probeOutput, stderr: "", status: 0, signal: null },
  };
}

it.each(["lock", "receipt", "both"] as const)(
  "espera limita a sonda de %s ao orçamento restante e preserva os arquivos",
  async (source) => {
    const observation = timedObservation();
    const { paths, record, lock, receipt, advance, probeResult } = observation;
    const content = JSON.stringify(record);
    writeFileSync(source === "lock" ? lock : receipt, content);
    if (source === "both") writeFileSync(lock, JSON.stringify({ ...record, command: "dev" }));
    if (source === "receipt") {
      // O tempo gasto lendo configuração também consome o orçamento da sonda.
      vi.mocked(readLocalConfig).mockImplementationOnce(() => {
        advance(7);
        return null;
      });
    }
    const budgets: number[] = [];
    vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
      const budget = options?.timeout ?? Infinity;
      budgets.push(budget);
      if (source === "both" && budgets.length === 1) {
        advance(10);
        return probeResult;
      }
      advance(Math.min(1000, budget));
      return {
        ...probeResult,
        status: null,
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      };
    });
    expect(await waitForSetup(paths.root, { timeoutMs: 25 })).toMatchObject({
      outcome: "timeout",
      elapsedMs: 25,
    });
    expect(budgets).toEqual(source === "both" ? [25, 15] : [source === "lock" ? 25 : 18]);
    expect(readFileSync(source === "lock" ? lock : receipt, "utf8")).toBe(content);
  },
);

it("espera aceita conclusão dentro do prazo sem arredondar a comparação", async () => {
  const { paths, record, receipt, advance } = timedObservation();
  writeFileSync(receipt, JSON.stringify({ ...record, outcome: "succeeded", finishedAt: FIXED_AT }));
  vi.mocked(readLocalConfig).mockImplementationOnce(() => {
    advance(24.75);
    return null;
  });
  expect(await waitForSetup(paths.root, { timeoutMs: 25 })).toMatchObject({
    outcome: "succeeded",
    elapsedMs: 25,
  });
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each(["succeeded", "failed"])(
  "espera recusa resultado %s lido no prazo esgotado",
  async (outcome) => {
    const { paths, record, lock, receipt, advance, probeResult } = timedObservation();
    writeFileSync(lock, JSON.stringify(record));
    vi.mocked(spawnSync).mockImplementationOnce(() => {
      // Mesmo que a consulta devolva identidade, o dono terminou enquanto ela
      // rodava. A releitura do status encontra um terminal tarde demais.
      advance(25);
      writeFileSync(receipt, JSON.stringify({ ...record, outcome, finishedAt: FIXED_AT }));
      rmSync(lock);
      return probeResult;
    });
    expect(await waitForSetup(paths.root, { timeoutMs: 25 })).toMatchObject({
      outcome: "timeout",
      elapsedMs: 25,
      status: { setup: { state: outcome } },
    });
  },
);

it("espera não inicia outra sonda depois de I/O consumir o prazo", async () => {
  const { paths, record, receipt, advance } = timedObservation();
  writeFileSync(receipt, JSON.stringify(record));
  vi.mocked(readLocalConfig).mockImplementationOnce(() => {
    advance(26);
    return null;
  });
  expect(await waitForSetup(paths.root, { timeoutMs: 25 })).toMatchObject({
    outcome: "timeout",
    elapsedMs: 26,
  });
  expect(spawnSync).not.toHaveBeenCalled();
});

it("status padrão conserva o limite da sonda e timeout zero consulta o estado uma vez", async () => {
  const { paths, record, lock, receipt, probeResult } = timedObservation();
  writeFileSync(lock, JSON.stringify(record));
  vi.mocked(spawnSync).mockReturnValue(probeResult);
  expect(readWorktreeStatus(paths.root).setup.state).toBe("running");
  expect(spawnSync).toHaveBeenLastCalledWith(
    "powershell.exe",
    expect.any(Array),
    expect.objectContaining({ timeout: 10000 }),
  );
  expect(await waitForSetup(paths.root, { timeoutMs: 0 })).toMatchObject({ outcome: "timeout" });
  expect(spawnSync).toHaveBeenCalledTimes(2);
  rmSync(lock);
  writeFileSync(receipt, JSON.stringify({ ...record, outcome: "succeeded", finishedAt: FIXED_AT }));
  expect(await waitForSetup(paths.root, { timeoutMs: 0 })).toMatchObject({ outcome: "succeeded" });
  expect(readProcessIdentity(process.pid, { deadlineMs: 0 })).toBeNull();
  expect(spawnSync).toHaveBeenCalledTimes(2);
});

it("remover o próprio registro preserva o substituto mesmo com o mesmo PID", () => {
  const paths = fixture();
  const first = writeProcessRecord(paths, { cwd: paths.root, pid: process.pid });
  const replacement = writeProcessRecord(paths, { cwd: paths.root, pid: process.pid });
  removeProcessRecordFor(paths, process.pid, first.recordId);
  expect(readProcessRecord(paths).recordId).toBe(replacement.recordId);
});

it("preload do bootstrap mantém o pai do CLI bem-sucedido até o filho sair", async () => {
  const preload = pathToFileURL(resolve("scripts/lib/worktree/bootstrap-parent.mjs")).href;
  // O neto grava o marcador ao terminar: se o pai saiu depois dele, o marcador já existe.
  const marker = join(fixture().root, "neto-terminou");
  const child = spawn(
    process.execPath,
    [
      "--import",
      preload,
      "--input-type=module",
      "-e",
      `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'ok'), 300)", ${JSON.stringify(marker)}], {stdio: "ignore", windowsHide: true});
    console.log("started");
    process.exit(0);
  `,
      "--",
      "--skip-push",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const exited = once(child, "exit");
  await once(child.stdout!, "data");
  expect((await exited)[0]).toBe(0);
  expect(existsSync(marker)).toBe(true);
});

it("preload do bootstrap preserva erros e recusa uso sem --skip-push", () => {
  const preload = pathToFileURL(resolve("scripts/lib/worktree/bootstrap-parent.mjs")).href;
  for (const args of [["--skip-push"], []]) {
    const result = spawnSync(
      process.execPath,
      ["--import", preload, "-e", "process.exit(7)", "--", ...args],
      { encoding: "utf8", windowsHide: true },
    );
    expect(result.status).toBe(args.length ? 7 : 1);
  }
});

it("prontidão do backend repete descritor parcial sem aceitar configuração inválida", async () => {
  const paths = fixture();
  const runner = childScript("setTimeout(() => {}, 3000)");
  const config = {
    deploymentName: "local-fixture",
    ports: { cloud: 3210, site: 3211 },
    adminKey: "synthetic",
  };
  vi.mocked(readLocalConfig)
    .mockImplementationOnce(() => {
      throw new SyntaxError("partial fixture");
    })
    .mockReturnValue(config);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith(
      "/instance_name",
    )
      ? new Response("local-fixture")
      : Response.json({ status: "success" }),
  );
  await expect(waitForBackend(paths, runner.child)).resolves.toEqual(config);
  vi.mocked(readLocalConfig).mockImplementation(() => {
    throw new Error("INVALID_CONFIG");
  });
  await expect(waitForBackend(paths, runner.child)).rejects.toThrow("INVALID_CONFIG");
  vi.mocked(readLocalConfig).mockImplementation(() => {
    throw new SyntaxError("partial fixture");
  });
  await expect(waitForBackend(paths, runner.child, { timeoutMs: 10 })).rejects.toThrow(/Esgotou/);
});

it.each([undefined, "original-generation"])(
  "cleanup preserva registro substituto, geração=%s",
  async (recordId) => {
    const paths = fixture();
    writeFileSync(paths.processFile, JSON.stringify({ cwd: paths.root, pid: 123, recordId }));
    const replacement = { cwd: paths.root, pid: 456, recordId: "replacement" };
    vi.mocked(stopRecordedProcesses).mockImplementationOnce(async () => {
      writeFileSync(paths.processFile, JSON.stringify(replacement));
      return [];
    });
    await cleanup({ root: paths.root, quiet: true });
    expect(JSON.parse(readFileSync(paths.processFile, "utf8"))).toEqual(replacement);
  },
);
