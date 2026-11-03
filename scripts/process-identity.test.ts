import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const response = (stdout: string) => ({
  pid: 123,
  output: [],
  stdout,
  stderr: "",
  status: 0,
  signal: null,
});

beforeEach(() => {
  vi.resetModules();
  vi.mocked(spawnSync).mockReset();
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => Object.defineProperty(process, "platform", platform));

it("reutiliza somente a identidade própria válida e respeita prazo esgotado", async () => {
  vi.mocked(spawnSync).mockReturnValue(response("own-process"));
  const { readProcessIdentity } = await import("./lib/worktree/process-identity.mjs");
  const identity = readProcessIdentity(process.pid);
  expect(identity).toMatch(/^[a-f0-9]{64}$/);
  expect(readProcessIdentity(process.pid)).toBe(identity);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(readProcessIdentity(process.pid, { deadlineMs: 0 })).toBeNull();
  expect(readProcessIdentity(-1)).toBeNull();
  expect(spawnSync).toHaveBeenCalledTimes(1);
});

it("uma sonda própria sem resultado não impede recuperação posterior", async () => {
  vi.mocked(spawnSync)
    .mockReturnValueOnce(response(""))
    .mockReturnValueOnce(response("own-process"));
  const { readProcessIdentity } = await import("./lib/worktree/process-identity.mjs");
  expect(readProcessIdentity(process.pid)).toBeNull();
  expect(readProcessIdentity(process.pid)).toMatch(/^[a-f0-9]{64}$/);
  expect(spawnSync).toHaveBeenCalledTimes(2);
});

it("consulta novamente PID externo e observa identidade substituída ou indisponível", async () => {
  vi.mocked(spawnSync)
    .mockReturnValueOnce(response("external-original"))
    .mockReturnValueOnce(response("external-reused"))
    .mockReturnValueOnce(response(""));
  const { readProcessIdentity } = await import("./lib/worktree/process-identity.mjs");
  const pid = process.pid + 1;
  const original = readProcessIdentity(pid);
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  const replaced = readProcessIdentity(pid);
  expect(replaced).toMatch(/^[a-f0-9]{64}$/);
  expect(replaced).not.toBe(original);
  expect(readProcessIdentity(pid)).toBeNull();
  expect(spawnSync).toHaveBeenCalledTimes(3);
});

it("preserva consultas próprias sem cache fora do Windows", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.mocked(spawnSync)
    .mockReturnValueOnce(response("first-title"))
    .mockReturnValueOnce(response("changed-title"));
  const { readProcessIdentity } = await import("./lib/worktree/process-identity.mjs");
  const original = readProcessIdentity(process.pid);
  expect(readProcessIdentity(process.pid)).not.toBe(original);
  expect(spawnSync).toHaveBeenCalledTimes(2);
});

it("sonda POSIX distingue grupo ativo, zumbi e grupo diferente sem sinalizar", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { recordedGroupIsRunning } = await import("./lib/worktree/process-identity.mjs");
  vi.mocked(spawnSync).mockReturnValue(response("123 Z\n456 S"));
  expect(recordedGroupIsRunning(123)).toBe(false);
  vi.mocked(spawnSync).mockReturnValue(response("123 S\n123 Z"));
  expect(recordedGroupIsRunning(123)).toBe(true);
  vi.mocked(spawnSync).mockReturnValue({ ...response(""), status: 2 });
  expect(() => recordedGroupIsRunning(123)).toThrow(/verificar o grupo/);
});
