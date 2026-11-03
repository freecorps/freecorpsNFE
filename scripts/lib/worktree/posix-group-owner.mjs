import { spawn, spawnSync } from "node:child_process";

// Este processo é o líder de sessão e grupo criado pelo spawn detached e nunca
// sai desse grupo. Sinalizar o PRÓPRIO grupo não alcança um PGID reciclado.
// O líder continua vivo depois que o CLI sai, até o grupo esvaziar ou a
// escalada para KILL alcançar todos os membros.
const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
let childExit;
let stopping = false;

// Outros membros vivos do grupo, sem zumbis. `ps -A` tem a mesma forma no
// Linux e no macOS; lê só PID, PGID e estado. O próprio `ps` roda em outro
// grupo (detached), senão contaria como membro.
function othersAlive() {
  const result = spawnSync("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], {
    encoding: "utf8",
    timeout: 2000,
    detached: true,
  });
  if (result.error || result.status !== 0) return true;
  return result.stdout.split("\n").some((line) => {
    const [pid, group, state] = line.trim().split(/\s+/);
    return Number(group) === process.pid && Number(pid) !== process.pid && !state?.startsWith("Z");
  });
}

// Com o grupo vazio, sai com o mesmo desfecho do CLI, para quem espera este
// processo ver o código ou o sinal reais.
function exitLikeChild() {
  for (const signal of signals) process.removeAllListeners(signal);
  const { code, signal } = childExit ?? {};
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
}

const stop = () => {
  if (stopping) return;
  stopping = true;
  process.kill(-process.pid, "SIGTERM");
  const deadline = Date.now() + 500;
  const poll = () => {
    if (childExit && !othersAlive()) return exitLikeChild();
    if (Date.now() >= deadline) return process.kill(-process.pid, "SIGKILL");
    setTimeout(poll, 50);
  };
  setTimeout(poll, 50);
};
for (const signal of signals) process.on(signal, stop);
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: "inherit", detached: false });
child.once("error", () => {
  childExit ??= { code: 127 };
  stop();
});
child.once("exit", (code, signal) => {
  childExit = { code, signal };
  stop();
});
