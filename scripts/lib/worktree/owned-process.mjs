import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Só os serviços criados explicitamente por aqui ganham um líder de grupo POSIX
// privado. No Windows o filho é criado como antes e parado por taskkill.
export function spawnOwnedProcess(command, args, options, ownerExecutable = process.execPath) {
  if (process.platform === "win32") return spawn(command, args, options);
  return spawn(
    ownerExecutable,
    [fileURLToPath(new URL("./posix-group-owner.mjs", import.meta.url)), command, ...args],
    { ...options, detached: true },
  );
}
