import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fail, processIsRunning, stopProcessTree } from "./exec.mjs";

// No Windows, criação/executável/linha de início do próprio processo permanecem
// os mesmos durante esta instância. Só reaproveitamos uma leitura bem-sucedida
// de nós mesmos; PIDs externos e falhas precisam de uma nova observação.
let ownWindowsIdentity = null;

/** PID sozinho pode pertencer a outro programa depois de um crash/reboot. */
export function readProcessIdentity(pid, { deadlineMs = Infinity } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const timeout = Math.min(10000, Math.floor(deadlineMs - performance.now()));
  // timeout: 0 em spawnSync significa espera ilimitada, não prazo esgotado.
  if (timeout <= 0) return null;
  const ownWindowsProcess = process.platform === "win32" && pid === process.pid;
  if (ownWindowsProcess && ownWindowsIdentity) return ownWindowsIdentity;
  try {
    let identity;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      identity = JSON.stringify([
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        started,
        readFileSync(`/proc/${pid}/cmdline`, "utf8"),
      ]);
    } else {
      const windows = process.platform === "win32";
      const result = spawnSync(
        windows ? "powershell.exe" : "ps",
        windows
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { @($p.CreationDate.ToUniversalTime().ToString('o'), $p.ExecutablePath, $p.CommandLine) | ConvertTo-Json -Compress }`,
            ]
          : ["-p", String(pid), "-o", "lstart=", "-o", "command="],
        { encoding: "utf8", windowsHide: true, timeout },
      );
      if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
      identity = result.stdout.trim();
    }
    // Não persiste a linha de comando, que pode conter credenciais.
    const hash = createHash("sha256").update(identity).digest("hex");
    if (ownWindowsProcess) ownWindowsIdentity = hash;
    return hash;
  } catch {
    return null;
  }
}

export function recordedProcessIsRunning(record, pid) {
  if (!processIsRunning(pid)) return false;
  const expected = record.identities?.[pid];
  const actual = expected ? readProcessIdentity(pid) : null;
  // Identidade indisponível conta como ocupado, mas nunca autoriza matar.
  return !expected || !actual || actual === expected;
}

export async function stopRecordedProcesses(record) {
  const stopped = [];
  const pids = Array.isArray(record.pids) ? record.pids : [record.pid];
  const errors = [];
  for (const pid of new Set(pids)) {
    try {
      if (!processIsRunning(pid)) {
        await waitForRecordedGroup(pid);
        continue;
      }
      const expected = record.identities?.[pid];
      const actual = readProcessIdentity(pid);
      // Parar um filho pode fazer o orquestrador encerrar os demais enquanto
      // consultamos a identidade. Processo já encerrado não exige intervenção.
      if (!actual && !processIsRunning(pid)) {
        await waitForRecordedGroup(pid);
        continue;
      }
      if (!expected || !actual) {
        fail(
          `Não consegui confirmar a identidade do PID ${pid}. Verifique o processo manualmente antes de remover o registro de dev.`,
        );
      }
      if (actual !== expected) {
        // Um zumbi perdeu a linha de comando, então o hash pode diferir sem
        // que o PID tenha sido reutilizado. Ele não segura recursos, mas os
        // membros restantes do grupo precisam terminar antes de apagar o registro.
        if (process.platform !== "win32") {
          const state = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
            encoding: "utf8",
            timeout: 5000,
          });
          if (state.error || state.stderr?.trim() || (state.status !== 0 && state.status !== 1)) {
            fail(`Não consegui verificar o estado do PID ${pid}.`);
          }
          if (!state.stdout.trim() || state.stdout.trim().startsWith("Z")) {
            await waitForRecordedGroup(pid);
          }
        }
        continue;
      }
      if (process.platform === "win32") {
        await stopProcessTree(pid);
      } else {
        // Só o líder vivo sinaliza o próprio grupo. A limpeza externa nunca
        // escala contra um PGID guardado depois de uma espera assíncrona.
        if (readProcessIdentity(pid) === expected) {
          try {
            process.kill(pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await waitForRecordedGroup(pid, expected);
      }
      stopped.push(pid);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) fail(errors.map((error) => error.message).join("\n"));
  return stopped;
}

// `ps -g` seleciona sessão no Linux e grupo no BSD/macOS. O líder detached é
// dono dos dois identificadores; o PGID é filtrado explicitamente em ambos os
// casos. Lê só estado e PGID, nunca nomes, argumentos ou comandos de outros worktrees.
export function recordedGroupIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const result = spawnSync("ps", ["-g", String(pid), "-o", "pgid=", "-o", "stat="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error || result.stderr?.trim() || (result.status !== 0 && result.status !== 1)) {
    fail(`Não consegui verificar o grupo ${pid}; preservando o registro.`);
  }
  return result.stdout
    .trim()
    .split("\n")
    .some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && state && !state.startsWith("Z");
    });
}

async function waitForRecordedGroup(pid, expectedIdentity) {
  if (process.platform === "win32") return;
  const deadline = performance.now() + 10000;
  while (
    recordedGroupIsRunning(pid) ||
    (expectedIdentity && processIsRunning(pid) && readProcessIdentity(pid) === expectedIdentity)
  ) {
    if (performance.now() >= deadline) {
      fail(
        `O grupo ${pid} ainda possui processos; preservando o registro para verificação manual.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
