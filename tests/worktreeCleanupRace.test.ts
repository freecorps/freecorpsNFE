import { expect, it, vi } from "vite-plus/test";
import { stopRecordedProcesses } from "../scripts/lib/worktree/process-identity.mjs";
import { processIsRunning, stopProcessTree } from "../scripts/lib/worktree/exec.mjs";

vi.mock("../scripts/lib/worktree/exec.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/lib/worktree/exec.mjs")>()),
  processIsRunning: vi.fn(),
  stopProcessTree: vi.fn(),
}));

// PID inexistente: a leitura real do SO devolve null. A sondagem simulada
// reproduz o processo que termina entre kill(pid, 0) e a consulta de identidade.
const record = { pids: [2147483647], identities: { 2147483647: "previous-identity" } };

it("cleanup aceita processo encerrado durante a consulta de identidade", async () => {
  vi.mocked(processIsRunning).mockReset().mockReturnValueOnce(true).mockReturnValue(false);
  await expect(stopRecordedProcesses(record)).resolves.toEqual([]);
  expect(stopProcessTree).not.toHaveBeenCalled();
});

it("cleanup ainda recusa processo vivo cuja identidade não consegue ler", async () => {
  vi.mocked(processIsRunning).mockReset().mockReturnValue(true);
  await expect(stopRecordedProcesses(record)).rejects.toThrow(/identidade/);
  expect(stopProcessTree).not.toHaveBeenCalled();
});

it("falha parcial ainda tenta os demais registros e mantém erro", async () => {
  vi.mocked(processIsRunning).mockReset().mockReturnValue(true);
  const pids = [2147483646, 2147483647];
  await expect(stopRecordedProcesses({ pids })).rejects.toThrow(/identidade/);
  for (const pid of pids) expect(processIsRunning).toHaveBeenCalledWith(pid);
  expect(stopProcessTree).not.toHaveBeenCalled();
});
