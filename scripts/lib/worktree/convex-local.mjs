/**
 * Falar com o backend local do Convex deste worktree.
 *
 * Duas coisas justificam o arquivo inteiro: o backend local exige Node 22 ou 24
 * (o worktree carrega o seu, fixado, em `.convex/runtime`), e o par de portas
 * precisa ser passado explicitamente, senão todo worktree escolhe 3210.
 */
import { spawnOwnedProcess } from "./owned-process.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

import { readProcessIdentity, stopRecordedProcesses } from "./process-identity.mjs";
import { localUrls, readLocalConfig } from "./deployment.mjs";
import { PLATFORM_BACKEND_ENV } from "./env-file.mjs";
import { commandResult, fail, processIsRunning } from "./exec.mjs";
import {
  bunExecutable,
  isWindows,
  NODE_RUNTIME_VERSION,
  nodeRuntimePackage,
  prependToPath,
} from "./paths.mjs";

export function localNodeEnv(paths) {
  const env = prependToPath({ ...process.env }, paths.nodeBinDir);
  for (const key of Object.keys(env)) {
    if (
      /^(ACCOUNT_|AUTH_PROXY_|CONVEX_|VITE_|FNFE_|RESEND_|VALIDATION_|BETTER_AUTH_|CLOUDFLARE_|MAIL_|CLERK_|APP_ENV$|PRODUCT_ENV$|FISCAL_ENV$|SITE_URL$|EMAIL_|WEBHOOK_)/.test(
        key,
      )
    )
      delete env[key];
  }
  env.CONVEX_AGENT_MODE = "anonymous";
  const config = readLocalConfig(paths);
  if (config) {
    // O Bun carrega o `.env.local` do worktree antes deste script rodar.
    // Sobrescreva esse valor velho no processo para todo comando Convex daqui
    // em diante mirar o deployment local DESTE worktree.
    env.CONVEX_DEPLOYMENT = `${config.deploymentName.startsWith("anonymous-") ? "anonymous" : "local"}:${config.deploymentName}`;
    delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
    delete env.CONVEX_SELF_HOSTED_URL;
  }
  return env;
}

export function convexRun(paths, args, options = {}) {
  if (!existsSync(paths.nodeExecutable) || !existsSync(paths.convexCli)) {
    fail("Falta o Node local ou o CLI do Convex. Rode `bun run worktree:setup` primeiro.");
  }
  return commandResult(paths.nodeExecutable, [paths.convexCli, ...args], {
    ...options,
    // Env commands run synchronously during bootstrap. Bound the wait so a
    // lost backend cannot prevent the caller's finally from stopping setup.
    timeoutMs: options.timeoutMs ?? 30_000,
    cwd: options.cwd ?? paths.backendRoot,
    env: localNodeEnv(paths),
  });
}

function localNodeVersion(paths) {
  return commandResult(paths.nodeExecutable, ["--version"], {
    capture: true,
    cwd: paths.root,
  }).trim();
}

export function ensureLocalNode(paths) {
  const runtimePackage = nodeRuntimePackage();
  if (!runtimePackage) {
    fail(`Não há pacote de runtime Node configurado para ${process.platform}/${process.arch}.`);
  }
  // Um worktree preparado antes da troca de versão ainda guarda o runtime
  // antigo, ou um binário que nem responde; reinstale em vez de recusar o setup.
  if (existsSync(paths.nodeExecutable)) {
    let installed = null;
    try {
      installed = localNodeVersion(paths);
    } catch {
      // Runtime corrompido: cai na reinstalação abaixo.
    }
    if (installed !== `v${NODE_RUNTIME_VERSION}`) {
      rmSync(paths.nodeRuntimeDir, { recursive: true, force: true });
    }
  }
  if (!existsSync(paths.nodeExecutable)) {
    mkdirSync(paths.nodeRuntimeDir, { recursive: true });
    writeFileSync(
      join(paths.nodeRuntimeDir, "package.json"),
      `${JSON.stringify(
        {
          name: "freecorpsnfe-worktree-runtime",
          private: true,
          dependencies: { [runtimePackage]: NODE_RUNTIME_VERSION },
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `Instalando runtime Node ${NODE_RUNTIME_VERSION} isolado para ${process.platform}/${process.arch}…`,
    );
    commandResult(bunExecutable, ["install", "--production"], {
      cwd: paths.nodeRuntimeDir,
    });
  }
  const version = localNodeVersion(paths);
  if (version !== `v${NODE_RUNTIME_VERSION}`) {
    fail(`O Convex local exige Node ${NODE_RUNTIME_VERSION}; achei ${version}.`);
  }
  return version;
}

/**
 * `ports` é o par que este worktree fixou. Enquanto a config em disco não
 * nomear esse par, o descritor ainda é o de antes do reinício — e sondar a
 * porta que ele nomeia responderia alegremente do backend de OUTRO worktree,
 * que é exatamente a confusão que a fixação existe para impedir.
 */
export async function waitForBackend(paths, child, options = {}) {
  const { ports, timeoutMs = 120_000 } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // `signalCode` também: morto por sinal (OOM, um `ensureBackendStopped` de
    // outro CLI, um Ctrl+C na janela errada) deixa `exitCode` em null, e olhar
    // só para ele gastaria os 120s inteiros para depois culpar o timeout.
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(
        `O backend local do Convex saiu antes de ficar pronto (${child.signalCode ?? child.exitCode}).`,
      );
    }
    let config;
    try {
      config = readLocalConfig(paths);
    } catch (error) {
      // O CLI reescreve o descritor no lugar durante o startup. JSON parcial não
      // é prontidão; só essa falha de parse é repetida, dentro do mesmo prazo.
      if (!(error instanceof SyntaxError)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      continue;
    }
    const bound =
      !ports || (config?.ports.cloud === ports.cloud && config?.ports.site === ports.site);
    if (config && bound) {
      try {
        const response = await fetch(`${localUrls(config).cloud}/instance_name`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (response.ok && (await response.text()).trim() === config.deploymentName) {
          // Deployments anônimos podem ter o mesmo nome. A chave local
          // distingue este banco de outro processo que tenha tomado a porta.
          const identity = await fetch(`${localUrls(config).cloud}/api/query`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Convex ${config.adminKey}`,
            },
            body: JSON.stringify({
              path: "_system/frontend/listCronJobs",
              args: {},
              format: "json",
            }),
            signal: AbortSignal.timeout(1500),
          });
          if (identity.ok && (await identity.json()).status === "success") return config;
        }
      } catch {
        // O backend ainda está subindo.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  fail("Esgotou o tempo esperando o backend local do Convex.");
}

/**
 * Sem isto o CLI pega o primeiro par livre a partir de 3210, que é onde todo
 * worktree criado enquanto nenhum backend rodava vai parar. Fixar o par
 * reservado é o que deixa dois worktrees rodarem ao mesmo tempo, e também
 * impede que um worktree que perdeu a corrida mude em silêncio para portas que
 * o próprio `.env.local` dele não aponta.
 */
export function localPortArgs(ports) {
  if (!ports) return [];
  return ["--local-cloud-port", String(ports.cloud), "--local-site-port", String(ports.site)];
}

export async function startBackendForSetup(paths, ports) {
  const child = spawnOwnedProcess(
    paths.nodeExecutable,
    [
      "--import",
      new URL("./bootstrap-parent.mjs", import.meta.url).href,
      paths.convexCli,
      "dev",
      "--env-file",
      paths.runtimeEnv,
      "--skip-push",
      "--tail-logs",
      "disable",
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
      ...localPortArgs(ports),
    ],
    {
      cwd: paths.backendRoot,
      env: localNodeEnv(paths),
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
      detached: !isWindows,
    },
    paths.nodeExecutable,
  );
  child.on("error", (error) => console.error(error));
  const processRecord = {
    pids: [child.pid],
    identities: { [child.pid]: readProcessIdentity(child.pid) },
  };
  try {
    const config = await waitForBackend(paths, child, { ports });
    return { child, config, processRecord };
  } catch (error) {
    // O chamador só consegue parar o que ele recebeu de volta, e num throw ele
    // não recebe nada: sem isto, um backend que estoura o timeout fica vivo
    // segurando o par de portas reservado e um handle dentro de `.convex/` — o
    // que no Windows depois impede o próprio `worktree:remove` de apagar a pasta.
    await stopRecordedProcesses(processRecord);
    await stopWorktreeBackends(paths);
    throw error;
  }
}

/**
 * Filtra, de uma listagem `pid comando`, os backends locais cujo banco fica
 * dentro deste worktree. O separador depois da raiz impede que
 * `/x/wt/platform/.convex/local` case com o banco de `/x/wt-2`. Os caminhos
 * seguem a plataforma informada, não a do host: a listagem de um Linux lida no
 * Windows não pode ganhar `\` no meio do caminho.
 */
export function backendPidsFromProcessList(lines, paths, platform = process.platform) {
  const windows = platform === "win32";
  const fold = (value) => (windows ? value.toLowerCase() : value);
  const path = windows ? win32 : posix;
  // Raiz dos bancos locais deste worktree; o CLI passa um subdiretório dela em `--local-storage`.
  const root = fold(`${path.join(paths.backendRoot, ".convex", "local")}${path.sep}`);
  const pids = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = fold(match[2]);
    if (!command.includes("convex-local-backend")) continue;
    if (
      !command.includes(`--local-storage ${root}`) &&
      !command.includes(`--local-storage "${root}`)
    )
      continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid);
  }
  return pids;
}

function listProcesses() {
  if (isWindows) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "Name=\'convex-local-backend.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    return result.status === 0 ? result.stdout.split(/\r?\n/) : [];
  }
  const result = spawnSync("ps", ["-ax", "-ww", "-o", "pid=,command="], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.split("\n") : [];
}

/**
 * Encerra backends locais que usam o banco DESTE worktree e que nenhum
 * processo de dev controla mais. `convex dev --once --skip-push` sai com
 * sucesso deixando o backend órfão na porta reservada; o `dev` seguinte o
 * reaproveita, e parar só o grupo do CLI deixava o backend vivo, o que fazia o
 * push seguinte falhar com "A local backend is still running".
 *
 * Só chame quando o dev deste worktree não estiver rodando. Processos de
 * outros worktrees ou projetos não casam com o diretório de dados e ficam.
 */
export async function stopWorktreeBackends(paths, options = {}) {
  const { timeoutMs = 10_000 } = options;
  const pids = backendPidsFromProcessList(listProcesses(), paths);
  for (const pid of pids) {
    if (isWindows) {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      continue;
    }
    // Só o PID: o backend órfão pode estar no grupo do próprio setup.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Já saiu.
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processIsRunning) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  for (const pid of pids.filter(processIsRunning)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Já saiu.
    }
  }
  return pids;
}

/**
 * Roda um comando do CLI do Convex ecoando o progresso, e guarda o stderr — o
 * fluxo em que o CLI reporta — para o chamador distinguir falha passageira de
 * falha de verdade. Resolve com o código de saída em vez de lançar.
 */
export function runConvexStreaming(paths, args, options = {}) {
  if (!existsSync(paths.nodeExecutable) || !existsSync(paths.convexCli)) {
    fail("Falta o Node local ou o CLI do Convex. Rode `bun run worktree:setup` primeiro.");
  }
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(paths.nodeExecutable, [paths.convexCli, ...args], {
      cwd: options.cwd ?? paths.backendRoot,
      env: localNodeEnv(paths),
      stdio: ["ignore", "inherit", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });
    child.once("error", rejectRun);
    // `close`, e não `exit`: o diagnóstico que decide se a falha é retentável
    // ainda pode estar em trânsito quando o processo em si termina.
    child.once("close", (code, signal) => resolveRun({ code, signal, stderr }));
  });
}

export function spawnConvexDev(paths, ports) {
  return spawnOwnedProcess(
    paths.nodeExecutable,
    [
      paths.convexCli,
      "dev",
      "--tail-logs",
      "pause-on-deploy",
      "--env-file",
      paths.runtimeEnv,
      ...localPortArgs(ports),
    ],
    {
      cwd: paths.backendRoot,
      env: localNodeEnv(paths),
      stdio: "inherit",
      windowsHide: true,
      detached: !isWindows,
    },
    paths.nodeExecutable,
  );
}

function backendEnvNames(paths) {
  const output = convexRun(paths, ["env", "list", "--env-file", paths.runtimeEnv], {
    capture: true,
  });
  return output
    .split(/\r?\n/)
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
    .filter(Boolean);
}

/**
 * Tira as variáveis que só fazem sentido na nuvem, herdadas do projeto copiado,
 * e aplica a lista permitida gerada localmente.
 */
export function syncBackendEnvironment(paths) {
  const extra = backendEnvNames(paths).filter((name) => !PLATFORM_BACKEND_ENV.has(name));
  for (const name of extra) {
    convexRun(paths, ["env", "remove", name, "--env-file", paths.runtimeEnv]);
  }
  convexRun(paths, [
    "env",
    "set",
    "--from-file",
    paths.backendEnv,
    "--force",
    "--env-file",
    paths.runtimeEnv,
  ]);
  if (extra.length > 0) {
    console.log(
      `Removi ${extra.length} variável(is) de ambiente herdada(s) que só valem na nuvem.`,
    );
  }
}
