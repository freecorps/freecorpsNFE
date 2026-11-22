/**
 * Quem escuta na porta do backend local antes de receber a chave
 * administrativa dele.
 *
 * O `/instance_name` só repete o nome que o processo na porta quiser dizer, e
 * o nome também está no descritor. Numa máquina compartilhada, outro usuário
 * que tome a porta antes do backend responderia esse nome e receberia a chave.
 * A fronteira que importa é o usuário do sistema: um processo do mesmo usuário
 * já lê a chave no descritor, então não há o que esconder dele. Por isso a
 * chave só sai quando todo ouvinte da porta pertence ao usuário atual. Sem
 * ouvinte visível, ferramenta ausente ou dono ilegível, a resposta é não.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { fail } from "./exec.mjs";

const LISTEN = "0A";

/**
 * Uids dos sockets TCP em LISTEN na porta, de `/proc/net/tcp` ou `tcp6`. O
 * Linux mostra ali os sockets de todos os usuários com o uid de cada um, então
 * um ouvinte alheio nunca fica invisível.
 */
export function listenerUidsFromProcNet(text, port) {
  const uids = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields[3] !== LISTEN) continue;
    if (Number.parseInt(fields[1].split(":").pop() ?? "", 16) !== port) continue;
    uids.push(Number(fields[7]));
  }
  return uids;
}

/** Uids da saída de `lsof -F u`: linhas `p<pid>` seguidas de `u<uid>`. */
export function listenerUidsFromLsof(text) {
  return text
    .split("\n")
    .filter((line) => /^u\d+$/.test(line.trim()))
    .map((line) => Number(line.trim().slice(1)));
}

/** Uma linha `own` ou `foreign` por processo ouvinte, impressa pelo PowerShell abaixo. */
export function listenerOwnershipFromWindows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line === "own");
}

function windowsScript(port) {
  // GetOwnerSid de um processo de outro usuário falha sem elevação e deixa o
  // SID vazio: conta como alheio.
  return `
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($id in $owners) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  $sid = $null
  if ($process) { $sid = (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid }
  if ($sid -and $sid -eq $me) { 'own' } else { 'foreign' }
}
`;
}

function readListenerOwnership(port, platform) {
  if (platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", windowsScript(port)],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    return result.status === 0 ? listenerOwnershipFromWindows(result.stdout) : [];
  }
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  if (platform === "linux") {
    const uids = [];
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        uids.push(...listenerUidsFromProcNet(readFileSync(file, "utf8"), port));
      } catch {
        // Sem IPv6 o kernel não cria tcp6.
      }
    }
    return uids.map((owner) => owner === uid);
  }
  // macOS e outros: o lsof sem root pode não listar sockets de outros
  // usuários. Sem o nosso na lista, a resposta continua sendo não.
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fu"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return listenerUidsFromLsof(result.stdout ?? "").map((owner) => owner === uid);
}

/**
 * `own` quando a porta tem ouvinte e todo ouvinte dela é do usuário atual;
 * `foreign` quando algum é de outro usuário; `absent` sem ouvinte visível ou
 * sem como ler os donos.
 */
export function portOwnership(port, platform = process.platform) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "absent";
  const ownership = readListenerOwnership(port, platform);
  if (ownership.length === 0) return "absent";
  return ownership.every(Boolean) ? "own" : "foreign";
}

/** Recusa enviar a chave administrativa local a uma porta que não é só do usuário atual. */
export function assertBackendPortOwnedByCurrentUser(port) {
  const ownership = portOwnership(port);
  if (ownership === "absent") {
    fail(
      `Nenhum processo seu escuta na porta ${port} do backend local, ou não consegui ler o dono; a chave administrativa não foi enviada. Suba o backend com \`bun run dev\` neste worktree.`,
    );
  }
  if (ownership === "foreign") {
    fail(
      `A porta ${port} do backend local tem ouvinte de outro usuário do sistema; a chave administrativa não foi enviada. Confira quem ocupa a porta antes de rodar \`bun run dev\` de novo.`,
    );
  }
}
