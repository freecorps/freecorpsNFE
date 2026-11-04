// Executor comum dos roteiros de prova local: confere o checkout limpo, roda
// as etapas declaradas em sequência, guarda o log de cada uma com o hash e
// grava o recibo, aprovado ou com a etapa que falhou. Cada roteiro declara só
// as próprias etapas e entradas; a validação geral reaproveita o grafo do CI.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { subprocessEnvironment } from "./subprocess-environment.mjs";
import { acquireValidationLock, VALIDATION_LOCK_TOKEN } from "./validation-lock.mjs";
import { sleepSync } from "./worktree/exec.mjs";

/**
 * @typedef {{
 *   name: string,
 *   command: string[],
 *   env?: Record<string, string>,
 *   reports?: Record<string, string>,
 *   timeoutMs?: number,
 * }} ProofStep
 * @typedef {{
 *   name: string, command: string, startedAt: string, durationMs: number,
 *   exitCode: number | null, signal: string | null, logFile: string,
 *   logSha256: string | null, result: "running" | "passed" | "failed", reports: string[],
 * }} ProofCommand
 * @typedef {{
 *   schemaVersion: 2, proof: string, codeSha: string | null, dirty: boolean | null,
 *   base: { ref: string, sha: string } | null, runner: string, runnerSha256: string,
 *   inputs: Record<string, string>, environment: string, syntheticOnly: boolean,
 *   runtime: { bun: string | null, node: string, platform: string, arch: string },
 *   recordedAt: string, commands: ProofCommand[],
 *   result: "running" | "passed" | "failed", failedStep?: string, error?: string,
 *   mode: "local" | "proof", attemptId: string, output: string,
 *   headReference: string | null, checkout: { start: CheckoutState | null, end: CheckoutState | null, changed: boolean | null },
 *   cache: { policy: "eligible" | "disabled", observed: "not-measured" },
 *   durationMs: number, finishedAt?: string, limitation?: string, lockRetained?: boolean,
 * }} ProofReceipt
 * @typedef {{ head: string, dirty: boolean, changesSha256?: string }} CheckoutState
 * @typedef {(file: string, args: string[], options: { env: Record<string, string> } & Record<string, unknown>) =>
 *   { status: number | null, signal?: string | null, stdout?: string, stderr?: string, error?: Error }} ProofSpawn
 */

/** @param {string} root @param {string} path */
const resolveIn = (root, path) => (isAbsolute(path) ? path : join(root, path));

/** @param {string | Buffer} content */
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
// Ref de git sem hífen inicial, para não virar opção de `git rev-parse`.
const REF = /^(?!-)[\w/.-]+$/;

/**
 * `--base <ref>`, `--output <dir>` e `--input <arquivo>` (repetível); sem
 * `--base`, a comparação de contrato usa origin/main.
 * @param {string[]} argv
 * @param {{ output: string, base?: string, inputs?: string[] }} defaults
 * @returns {{ output: string, base: string, inputs: string[] }}
 */
export function proofArguments(argv, defaults) {
  /** @type {{ output: string, base: string, inputs: string[] }} */
  const options = { base: "origin/main", ...defaults, inputs: [...(defaults.inputs ?? [])] };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!["--base", "--output", "--input"].includes(flag))
      throw new Error(`Argumento desconhecido: ${flag}`);
    if (!value || value.startsWith("--")) throw new Error(`${flag} exige um valor`);
    if (flag === "--input") options.inputs.push(value);
    else if (flag === "--base") options.base = value;
    else options.output = value;
  }
  if (!REF.test(options.base)) throw new Error("Base inválida");
  return options;
}

/**
 * Validação geral: o mesmo grafo do job Validate e as fronteiras de pacote.
 * O padrão desabilita cache; apenas o modo local permite tarefas elegíveis.
 * A suíte de testes grava o relatório sanitizado em
 * `.ci-results/tests.json`, copiado para a saída da prova.
 * @param {string} base
 * @returns {ProofStep[]}
 */
export function acceptanceSteps(base, { cache = false } = {}) {
  return [
    { name: "identity", command: ["node", "scripts/ci/ci.mjs", "identity"] },
    {
      name: "validate",
      command: ["bun", "x", "vp", "run", ...(cache ? [] : ["--no-cache"]), "validate"],
      env: { CONTRACT_BASE: base },
      reports: { ".ci-results/tests.json": "tests.json" },
    },
    { name: "boundaries", command: ["bun", "run", "ci:boundaries"] },
  ];
}

/** @param {string} root */
function gitIn(root) {
  return (/** @type {string[]} */ ...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(
      /\r?\n$/,
      "",
    );
}

/** @param {string} name */
function resolveExecutable(name) {
  if (name === "bun" && process.versions.bun) return process.execPath;
  if (name === "node" && !process.versions.bun) return process.execPath;
  return name;
}

/**
 * Executa a prova e devolve o recibo. Falha de etapa interrompe a sequência,
 * marca o recibo como `failed` e registra a etapa e o log; o chamador decide o
 * código de saída. `spawn` e `git` são injetáveis para os testes.
 * @param {{
 *   root: string, proof: string, runner: string, output: string, base?: string,
 *   inputs?: string[], steps: ProofStep[], environment?: string, syntheticOnly?: boolean,
 *   env?: Record<string, string | undefined>, spawn?: ProofSpawn,
 *   git?: (...args: string[]) => string, now?: () => Date, uniqueAttempt?: boolean,
 * }} options
 * @returns {ProofReceipt}
 */
export function runProof(options) {
  return executeValidation(options, "proof");
}

/** Modo local deliberado; não é uma opção allow-dirty das provas existentes.
 * @param {Parameters<typeof runProof>[0]} options
 */
export function runLocalValidation(options) {
  return executeValidation({ ...options, uniqueAttempt: true }, "local");
}

/** Observa mudanças versionadas e conteúdo não rastreado, sem persistir conteúdo
 * nem nomes de arquivos. Não detecta uma edição revertida entre observações.
 * @param {string} root @param {(...args: string[]) => string} git @param {boolean} local
 * @returns {CheckoutState}
 */
function checkoutState(root, git, local) {
  const status = git("status", "--porcelain", ...(local ? ["-z"] : []), "--untracked-files=all");
  const state = {
    head: git("rev-parse", "HEAD"),
    dirty: status !== "",
  };
  if (!local) return state;
  const hash = createHash("sha256");
  hash.update(status);
  hash.update(git("diff", "--binary", "--no-ext-diff", "--no-textconv"));
  hash.update(git("diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"));
  for (const path of git("ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean)
    .sort()) {
    const file = join(root, path);
    hash.update(path).update("\0");
    hash.update(lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    hash.update("\0");
  }
  return { ...state, changesSha256: hash.digest("hex") };
}

/** @param {string} file @param {string} content */
function atomicWrite(file, content) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, content, "utf8");
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(temporary, file);
      return;
    } catch (error) {
      // O Windows recusa a substituição enquanto alguém lê o recibo, o que quem
      // acompanha a tentativa faz por alguns ms. Não é falha da validação.
      const transient = error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY";
      if (!transient || attempt >= 20) throw error;
      sleepSync(25);
    }
  }
}

/** O resumo contém só metadados do executor. Nunca incorpora stdout/stderr,
 * ambiente ou conteúdo dos relatórios de testes.
 * @param {ProofReceipt} receipt
 */
function summary(receipt) {
  const labels = { running: "em andamento / incompleta", passed: "aprovada", failed: "reprovada" };
  return [
    `# ${receipt.mode === "local" ? "Validação local" : "Prova de candidato"}: ${labels[receipt.result]}`,
    "",
    `Tentativa: ${receipt.attemptId}`,
    `HEAD de referência: ${receipt.headReference ?? "não observado"}`,
    `SHA da prova: ${receipt.codeSha ?? "não atribuído"}`,
    `Base: ${receipt.base ? `${receipt.base.ref} (${receipt.base.sha})` : "não resolvida"}`,
    `Árvore suja: início=${receipt.checkout.start?.dirty ?? "não observado"}; fim=${receipt.checkout.end?.dirty ?? "não observado"}.`,
    `Mudança entre observações: ${receipt.checkout.changed ?? "não observada"}.`,
    `Cache: ${receipt.cache.policy === "eligible" ? "permitido nas tarefas elegíveis" : "desabilitado"}; uso efetivo não medido.`,
    `Duração de parede observada: ${receipt.durationMs} ms. A etapa validate inclui o grafo paralelo; seus tempos não são somados.`,
    ...(receipt.failedStep ? [`Falha: ${receipt.failedStep}.`] : []),
    ...(receipt.limitation ? [receipt.limitation] : []),
    ...(receipt.lockRetained
      ? [
          "Trava preservada: confirme o encerramento de todos os executores antes da recuperação manual.",
        ]
      : []),
    "",
    "| Etapa | Resultado | Duração (ms) | Evidência |",
    "| --- | --- | ---: | --- |",
    ...receipt.commands.map(
      (command) =>
        `| ${command.name} | ${labels[command.result]} | ${command.durationMs} | [log](${command.logFile})${command.reports.map((report) => ` · [relatório](${report})`).join("")} |`,
    ),
    "",
    "[Recibo completo](receipt.json)",
    "",
  ].join("\n");
}

/** @param {Parameters<typeof runProof>[0]} options @param {"local" | "proof"} mode
 * @returns {ProofReceipt}
 */
function executeValidation(
  {
    root,
    proof,
    runner,
    output,
    base,
    inputs = [],
    steps,
    environment = "local-only",
    syntheticOnly = true,
    env = process.env,
    spawn = /** @type {ProofSpawn} */ (/** @type {unknown} */ (spawnSync)),
    git = gitIn(root),
    now = () => new Date(),
    uniqueAttempt = false,
  },
  mode,
) {
  // A exclusão vem antes de recibos, remoção de relatórios ou qualquer etapa.
  const release = acquireValidationLock(root);
  let retainLock = false;
  try {
    const began = now();
    const attemptId = `${began.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
    const directory = resolveIn(root, uniqueAttempt ? join(output, attemptId) : output);
    const display = relative(root, directory).replaceAll("\\", "/") || ".";
    /** @type {ProofReceipt} */
    const receipt = {
      schemaVersion: 2,
      proof,
      mode,
      attemptId,
      output: display,
      codeSha: null,
      headReference: null,
      dirty: null,
      checkout: { start: null, end: null, changed: null },
      cache: { policy: mode === "local" ? "eligible" : "disabled", observed: "not-measured" },
      durationMs: 0,
      base: null,
      runner,
      runnerSha256: "",
      inputs: {},
      environment,
      syntheticOnly,
      runtime: {
        bun: process.versions.bun ?? null,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      recordedAt: began.toISOString(),
      commands: [],
      result: "running",
    };
    mkdirSync(directory, { recursive: true });
    const persist = () => {
      receipt.durationMs = now().getTime() - began.getTime();
      // O recibo é autoritativo; um crash entre estes dois writes nunca aprova
      // uma tentativa em andamento por causa de um resumo anterior.
      atomicWrite(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      atomicWrite(join(directory, "summary.md"), summary(receipt));
    };
    persist();
    console.log(
      `${proof}: tentativa ${attemptId}; recibo ${join(directory, "receipt.json")}; resumo ${join(directory, "summary.md")}`,
    );
    let phase = "preconditions";
    try {
      const initial = checkoutState(root, git, mode === "local");
      receipt.checkout.start = initial;
      receipt.headReference = initial.head;
      receipt.dirty = initial.dirty;
      if (mode === "proof" && initial.dirty)
        throw new Error("Faça commit do candidato antes de registrar a prova");
      if (mode === "proof") receipt.codeSha = initial.head;
      if (base) {
        if (!REF.test(base)) throw new Error("Base inválida");
        receipt.base = { ref: base, sha: git("rev-parse", "--verify", `${base}^{commit}`) };
      }
      receipt.runnerSha256 = sha256(readFileSync(join(root, runner)));
      receipt.inputs = Object.fromEntries(
        inputs.map((path) => [path, sha256(readFileSync(resolveIn(root, path)))]),
      );
      if (mode === "local")
        receipt.limitation =
          "Validação da árvore local, sem aprovação de SHA. Observações do Git no início e fim não detectam arquivos ignorados nem edições revertidas durante a execução.";
      persist();
      for (const step of steps) {
        phase = step.name;
        console.log(`${proof}: ${step.name}`);
        const started = now();
        const logFile = `${step.name}.txt`;
        /** @type {ProofCommand} */
        const command = {
          name: step.name,
          command: step.command.join(" "),
          startedAt: started.toISOString(),
          durationMs: 0,
          exitCode: null,
          signal: null,
          logFile,
          logSha256: null,
          result: "running",
          reports: [],
        };
        receipt.commands.push(command);
        writeFileSync(join(directory, logFile), "", "utf8");
        // Remover antes da etapa é essencial: cache ou falha de startup não
        // autorizam atribuir à tentativa um relatório deixado por outra execução.
        for (const [source, target] of Object.entries(step.reports ?? {})) {
          rmSync(resolveIn(root, source), { force: true });
          rmSync(join(directory, target), { force: true });
        }
        persist();
        const [executable, ...args] = step.command;
        // Se o executor lançar ou sofrer timeout/sinal, seus filhos podem estar
        // vivos. Não liberar exclusão baseado apenas no término do pai.
        retainLock = true;
        const result = spawn(resolveExecutable(executable), args, {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          timeout: step.timeoutMs ?? 1_800_000,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...subprocessEnvironment(env),
            ...step.env,
            ...(receipt.base ? { CONTRACT_BASE: receipt.base.sha } : {}),
            [VALIDATION_LOCK_TOKEN]: release.token,
          },
        });
        retainLock = Boolean(result.signal || result.error || result.status === null);
        const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}${
          result.error ? `\n${result.error.message}` : ""
        }`;
        writeFileSync(join(directory, logFile), log, "utf8");
        const passed = result.status === 0 && !result.error && !result.signal;
        Object.assign(command, {
          durationMs: now().getTime() - started.getTime(),
          exitCode: result.status,
          signal: result.signal ?? null,
          logFile,
          logSha256: sha256(log),
          result: passed ? "passed" : "failed",
        });
        // O relatório da etapa também diagnostica a falha.
        for (const [source, target] of Object.entries(step.reports ?? {}))
          if (existsSync(join(root, source))) {
            copyFileSync(join(root, source), join(directory, target));
            command.reports.push(target);
          }
        persist();
        if (!passed) {
          receipt.failedStep = step.name;
          throw new Error(`${step.name} falhou; veja ${display}/${logFile}`);
        }
      }
      receipt.result = "passed";
    } catch (error) {
      receipt.result = "failed";
      receipt.failedStep ??= phase;
      receipt.error = error instanceof Error ? error.message : String(error);
      const active = receipt.commands.at(-1);
      if (active?.result === "running") {
        active.result = "failed";
        active.durationMs = now().getTime() - new Date(active.startedAt).getTime();
      }
    }
    try {
      receipt.checkout.end = checkoutState(root, git, mode === "local");
      receipt.checkout.changed =
        JSON.stringify(receipt.checkout.start) !== JSON.stringify(receipt.checkout.end);
      if (
        mode === "proof" &&
        (receipt.checkout.end.dirty || receipt.checkout.end.head !== receipt.headReference)
      ) {
        receipt.result = "failed";
        receipt.failedStep ??= "checkout";
        receipt.error ??= "A prova alterou o checkout";
      }
      if (mode === "local" && receipt.checkout.changed)
        receipt.limitation =
          "A árvore mudou entre as observações inicial e final. As etapas podem ter validado estados diferentes; execute novamente com a árvore estável. Esta validação não aprova um SHA.";
    } catch {
      receipt.result = "failed";
      receipt.failedStep ??= "checkout";
      receipt.error ??= "Não foi possível observar o checkout ao final";
    }
    receipt.finishedAt = now().toISOString();
    if (retainLock) receipt.lockRetained = true;
    persist();
    console.log(
      JSON.stringify({
        proof,
        result: receipt.result,
        codeSha: receipt.codeSha,
        commands: receipt.commands.length,
        receipt: join(directory, "receipt.json"),
        summary: join(directory, "summary.md"),
        error: receipt.error,
      }),
    );
    return receipt;
  } finally {
    if (!retainLock) release();
  }
}
