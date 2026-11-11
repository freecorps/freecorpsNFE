/**
 * Ciclo de vida visto DE FORA: criar, listar, remover e escolher onde os
 * worktrees nascem. São os comandos que rodam de qualquer checkout.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { worktreeConvexPorts } from "../worktree-local.ts";
import { readLocalConfig } from "./deployment.mjs";
import { fail, git, tryGit } from "./exec.mjs";
import {
  expandHome,
  resolveWorktreesRoot,
  setConfiguredWorktreesDir,
  unsetConfiguredWorktreesDir,
  WORKTREES_DIR_KEY,
} from "./location.mjs";
import { classifyPruneCandidate, parseBranchTracking } from "./merged.mjs";
import {
  bunExecutable,
  currentRoot,
  displayPath,
  normalizePath,
  slugifyWorktreeName,
  worktreePaths,
} from "./paths.mjs";
import {
  assignPort,
  listGitWorktrees,
  mainWorktreePath,
  readAssignments,
  releasePort,
} from "./registry.mjs";
import { assertLegacySeedProfile } from "./sync.mjs";
import { assertPrivateDirectories, operationIsRunning, withOperation } from "./operation.mjs";
import { cleanup } from "./session.mjs";
import { assertLinkedWorktree, devIsRunning } from "./state.mjs";

function branchExists(branch, cwd) {
  return tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
  }).ok;
}

function runSetupIn(targetRoot, { install, app }) {
  const args = [join(targetRoot, "scripts", "worktree.mjs"), "setup"];
  if (install === false) args.push("--no-install");
  if (app) args.push("--app", app);

  // Um worktree novo não pode herdar a seleção de Convex deste checkout.
  const env = { ...process.env };
  delete env.CONVEX_DEPLOY_KEY;
  delete env.CONVEX_DEPLOYMENT;
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  delete env.CONVEX_SELF_HOSTED_URL;

  return new Promise((resolveSetup) => {
    const child = spawn(bunExecutable, args, {
      cwd: targetRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (error) => {
      console.error(error);
      resolveSetup(1);
    });
    child.on("exit", (code) => resolveSetup(code ?? 1));
  });
}

export async function create(name, options = {}) {
  if (options.app !== undefined && options.app !== "platform")
    fail(
      "O backoffice legado foi aposentado na #345; worktrees preparam só a plataforma (`--app platform` ou sem `--app`).",
    );
  if (!name) {
    fail("Uso: bun run worktree:create <nome> [--from <ref>]");
  }
  assertLegacySeedProfile(options.profile);
  const mainRoot = mainWorktreePath(currentRoot);

  const branch = options.branch ?? name;
  const slug = slugifyWorktreeName(options.directory ?? branch);
  if (!slug) fail(`Não consegui derivar um nome de pasta de "${name}".`);

  // `--path` põe este worktree exatamente onde o chamador pedir; senão quem
  // decide é o container configurado.
  let container;
  let target;
  if (options.path) {
    const expanded = expandHome(options.path);
    target = isAbsolute(expanded) ? resolve(expanded) : resolve(mainRoot, expanded);
    container = dirname(target);
  } else {
    const location = resolveWorktreesRoot(mainRoot, {
      cwd: currentRoot,
      into: options.into,
    });
    container = location.path;
    target = join(container, slug);
  }

  if (existsSync(target)) {
    fail(`${displayPath(target)} já existe. Remova antes ou escolha outro nome.`);
  }
  const alreadyRegistered = listGitWorktrees(currentRoot).some(
    (entry) => normalizePath(entry.path) === normalizePath(target),
  );
  if (alreadyRegistered) {
    fail(`Já existe um worktree registrado em ${displayPath(target)}.`);
  }

  mkdirSync(container, { recursive: true });

  const addArgs = ["worktree", "add"];
  if (branchExists(branch, currentRoot)) {
    console.log(`Ligando o worktree à branch existente ${branch}.`);
    addArgs.push(target, branch);
  } else {
    addArgs.push("-b", branch, target, options.from ?? "origin/main");
  }
  git(addArgs, { cwd: currentRoot });

  const app = "platform";
  const targetPaths = worktreePaths(target);
  assertPrivateDirectories(targetPaths);
  mkdirSync(targetPaths.convexDir, { recursive: true });
  writeFileSync(targetPaths.appFile, JSON.stringify({ app }));

  const port = assignPort(target, {
    branch,
    cwd: currentRoot,
    preferred: options.port,
  });
  console.log(`Reservei http://localhost:${port} para ${slug}.`);

  if (options.setup === false) {
    console.log("");
    console.log(`Worktree criado em ${displayPath(target)}.`);
    console.log(`Termine com: cd "${displayPath(target)}" && bun run worktree:setup`);
    return { branch, path: target, port };
  }

  const code = await runSetupIn(target, { install: options.install, app });
  if (code !== 0) {
    fail(
      `O setup falhou em ${displayPath(target)}. Corrija e rode \`bun run worktree:setup\` lá, ou remova com \`bun run worktree remove ${slug} --force\`.`,
    );
  }

  // O setup sonda a porta reservada e move o worktree para outra vaga se algo
  // já a segura, então a atribuição final é a que vale reportar.
  const finalPort = readAssignments(currentRoot)[normalizePath(target)]?.port ?? port;

  console.log("");
  console.log(`Worktree pronto: ${displayPath(target)}`);
  console.log(`Branch: ${branch} — http://localhost:${finalPort}`);
  console.log(`Suba com: cd "${displayPath(target)}" && bun run dev`);
  return { branch, path: target, port: finalPort };
}

export function list() {
  const entries = listGitWorktrees(currentRoot);
  const assignments = readAssignments(currentRoot);
  const mainRoot = mainWorktreePath(currentRoot);

  const rows = entries.map((entry) => {
    const key = normalizePath(entry.path);
    const paths = worktreePaths(entry.path);
    const isMain = key === normalizePath(mainRoot);
    let deployment;
    let config = null;
    try {
      config = readLocalConfig(paths);
      deployment = config?.deploymentName ?? "—";
    } catch {
      deployment = "inválida";
    }
    // A config grava o que o backend ligou por último; o registro grava só o que
    // está reservado para a próxima subida.
    const reserved = assignments[key]?.convexPort;
    const pair = config?.ports ?? (reserved ? worktreeConvexPorts(reserved) : null);
    const backend = pair ? `${pair.cloud}/${pair.site}` : "—";
    return {
      path: entry.path,
      app: paths.app,
      branch: entry.branch ?? (entry.detached ? "(destacado)" : "—"),
      port: assignments[key]?.port ? String(assignments[key].port) : "—",
      backend,
      deployment,
      status: isMain ? "principal" : devIsRunning(paths) ? "rodando" : "parado",
    };
  });

  const columns = [
    { key: "path", title: "CAMINHO" },
    { key: "branch", title: "BRANCH" },
    { key: "app", title: "APP" },
    { key: "port", title: "PORTA" },
    { key: "backend", title: "BACKEND" },
    { key: "deployment", title: "CONVEX" },
    { key: "status", title: "ESTADO" },
  ];
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...rows.map((row) => row[column.key].length)),
  );
  const renderRow = (values) =>
    values
      .map((value, index) => (index === values.length - 1 ? value : value.padEnd(widths[index])))
      .join("  ")
      .trimEnd();

  console.log(renderRow(columns.map((column) => column.title)));
  for (const row of rows) {
    console.log(renderRow(columns.map((column) => row[column.key])));
  }
  return rows;
}

/**
 * Casa pelo nome da pasta e pela branch além do caminho completo, para um
 * worktree continuar endereçável por nome depois que o container configurado
 * muda, ou quando ele foi criado em outro lugar.
 */
function resolveTarget(nameOrPath) {
  const entries = listGitWorktrees(currentRoot);
  const mainRoot = mainWorktreePath(currentRoot);
  const container = resolveWorktreesRoot(mainRoot, { cwd: currentRoot }).path;
  const slug = slugifyWorktreeName(nameOrPath);

  const matches = entries.filter((entry) => {
    const key = normalizePath(entry.path);
    return (
      key === normalizePath(resolve(nameOrPath)) ||
      key === normalizePath(join(container, slug)) ||
      entry.branch === nameOrPath ||
      basename(entry.path) === nameOrPath ||
      basename(entry.path) === slug ||
      relative(container, entry.path) === nameOrPath
    );
  });

  if (matches.length === 0) {
    fail(`Nenhum worktree casa com "${nameOrPath}". Rode \`bun run worktree list\`.`);
  }
  if (matches.length > 1) {
    const paths = matches.map((entry) => `  ${displayPath(entry.path)}`).join("\n");
    fail(
      `"${nameOrPath}" casa com ${matches.length} worktrees:\n${paths}\nPasse o caminho completo.`,
    );
  }
  return matches[0];
}

/** Mostra ou muda onde os worktrees novos são criados. */
export function config(options = {}) {
  const mainRoot = mainWorktreePath(currentRoot);

  if (options.unsetDir) {
    const removed = unsetConfiguredWorktreesDir({
      cwd: currentRoot,
      global: options.global,
    });
    console.log(
      removed ? `Limpei ${WORKTREES_DIR_KEY}.` : `${WORKTREES_DIR_KEY} não estava definido.`,
    );
  } else if (options.setDir) {
    setConfiguredWorktreesDir(options.setDir, {
      cwd: currentRoot,
      global: options.global,
    });
    console.log(
      `Defini ${WORKTREES_DIR_KEY}=${options.setDir}${options.global ? " (global)" : ""}.`,
    );
  }

  const location = resolveWorktreesRoot(mainRoot, { cwd: currentRoot });
  console.log(`Checkout principal: ${displayPath(mainRoot)}`);
  console.log(`Worktrees vão para: ${displayPath(location.path)}`);
  console.log(`Resolvido de:       ${location.source}`);
  if (location.source === "padrão") {
    console.log("");
    console.log("Para mudar:");
    console.log('  bun run worktree config --set-dir "D:/meus-worktrees"       # este clone');
    console.log('  bun run worktree config --set-dir "~/worktrees" --global    # todo clone');
    console.log("  bun run worktree:create <nome> --into <dir>                 # uma vez só");
  }
  return location;
}

/**
 * Tira o worktree do registro do git e apaga o diretório.
 *
 * `--force` é sempre necessário porque todo worktree carrega saída de build
 * ignorada; quem de fato protege o trabalho é a trava de alterações versionadas
 * em `remove`.
 *
 * No Windows a chamada pode falhar PELA METADE: um handle preso (um shell
 * aberto na pasta, um executor do Convex que sobreviveu) deixa o git esvaziar o
 * diretório, desregistrar o worktree e ainda assim sair com erro ao apagar a
 * raiz. Deixar a exceção subir aí abandonaria a reserva de porta de um worktree
 * que o git já não conhece — órfã no registro para sempre. Se o worktree sumiu
 * do registro, o trabalho continua; só a pasta vazia é reportada.
 */
function detachWorktree(entry, cwd) {
  try {
    git(["worktree", "remove", "--force", entry.path], { cwd });
    return { leftover: false };
  } catch (error) {
    const stillRegistered = listGitWorktrees(cwd).some(
      (other) => normalizePath(other.path) === normalizePath(entry.path),
    );
    if (stillRegistered) throw error;
    return { leftover: true };
  }
}

export async function remove(nameOrPath, options = {}) {
  if (!nameOrPath) {
    fail("Uso: bun run worktree remove <nome|caminho> [--force] [--delete-branch]");
  }
  const mainRoot = mainWorktreePath(currentRoot);
  const entry = resolveTarget(nameOrPath);

  if (normalizePath(entry.path) === normalizePath(mainRoot)) {
    fail("Recusando remover o checkout principal.");
  }
  if (normalizePath(entry.path) === normalizePath(currentRoot)) {
    fail(
      "Rode isto de outro checkout — um worktree não remove o diretório de onde ele está rodando.",
    );
  }

  const paths = worktreePaths(entry.path);
  assertPrivateDirectories(paths);
  return withOperation(paths, "remove", async () => {
    const dirty = tryGit(["status", "--porcelain"], { cwd: entry.path });
    if (!dirty.ok) fail("Não consegui verificar alterações; remoção recusada.");
    if (dirty.stdout && !options.force) {
      fail(
        `${displayPath(entry.path)} tem alterações não commitadas:\n${dirty.stdout}\nCommite ou passe --force.`,
      );
    }

    // Parar os processos de dev registrados primeiro libera os handles de arquivo
    // que senão travariam a remoção do diretório no Windows.
    await cleanup({ root: entry.path, quiet: true });

    const { leftover } = detachWorktree(entry, currentRoot);
    releasePort(entry.path, currentRoot);
    console.log(`Removi o worktree ${displayPath(entry.path)}.`);
    if (leftover) {
      console.warn(
        `A pasta ${displayPath(entry.path)} ficou para trás: o git já a desregistrou, mas algo segura um handle dentro dela — quase sempre um shell aberto ali. Feche e apague a pasta.`,
      );
    }

    if (options.deleteBranch) {
      if (!entry.branch) {
        console.warn("O worktree estava destacado; não há branch para apagar.");
      } else {
        git(["branch", "-D", entry.branch], { cwd: currentRoot });
        console.log(`Apaguei a branch ${entry.branch}.`);
      }
    }
    return entry;
  });
}

/**
 * A base de comparação. `origin/HEAD` é o que o clone sabe sobre a branch
 * padrão do remoto; `origin/main` é o último recurso para clone que nunca
 * resolveu esse ponteiro.
 */
function resolvePruneBase(cwd) {
  const head = tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd });
  if (head.ok && head.stdout) return head.stdout;
  const fallback = tryGit(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd });
  if (fallback.ok) return "origin/main";
  return fail(
    "Não achei origin/HEAD nem origin/main para comparar. Rode `git remote set-head origin -a` (ou um `git fetch origin`) antes.",
  );
}

function branchIsMerged(branch, base, cwd) {
  // `refs/heads/` explícito para uma tag ou uma remote-tracking de mesmo nome
  // não responder no lugar da branch.
  return tryGit(["merge-base", "--is-ancestor", `refs/heads/${branch}`, base], {
    cwd,
  }).ok;
}

function worktreeIsDirty(root) {
  const status = tryGit(["status", "--porcelain"], { cwd: root });
  // Worktree que o git nem consegue ler não é candidato seguro a remoção
  // automática: conta como sujo, e quem decide é o operador.
  return !status.ok || status.stdout !== "";
}

/**
 * Prazo em que um worktree sem commits próprios ainda conta como tarefa em
 * andamento, e não como abandonado. O editor cria o checkout na ponta da base,
 * e até o primeiro commit ele é indistinguível de um já integrado.
 */
const FRESH_WORKTREE_MS = 7 * 24 * 60 * 60 * 1000;

/** O arquivo `.git` de um worktree linked nasce com ele. */
function worktreeIsFresh(root, now = Date.now()) {
  try {
    return now - statSync(join(root, ".git")).mtimeMs < FRESH_WORKTREE_MS;
  } catch {
    // Sem como datar, a dúvida protege o worktree.
    return true;
  }
}

/**
 * Atualiza `origin` e devolve a base, a branch base local e o rastreio das
 * branches, que o `prune` e o `finish` julgam do mesmo jeito.
 */
function remoteState(options) {
  if (options.fetch !== false) {
    const fetched = tryGit(["fetch", "--prune", "origin"], { cwd: currentRoot });
    if (!fetched.ok) {
      fail(
        `O fetch de origin falhou (${fetched.stderr || "sem detalhe"}). Rode de novo, ou passe --no-fetch para aceitar o estado local de propósito.`,
      );
    }
    console.log("Atualizei o estado do remoto.");
  }

  const base = resolvePruneBase(currentRoot);
  // `origin/main` -> `main`: a branch local que serve de base nunca é candidata.
  const baseBranch = base.slice(base.indexOf("/") + 1);
  const tracking = parseBranchTracking(
    git(
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
        "refs/heads",
      ],
      { cwd: currentRoot },
    ),
  );
  return { base, baseBranch, tracking };
}

/**
 * Remove de uma vez todo worktree cuja branch já acabou.
 *
 * Existe porque o merge acontece longe daqui: você mergeia a PR no servidor, e
 * o clone local segue com a branch, o worktree, o deployment do Convex e a
 * porta reservada — nada nesta máquina observa aquele evento. Sem uma varredura
 * explícita, worktree morto só sai quando alguém lembra do nome dele.
 *
 * Por isso o `fetch --prune` vem junto por padrão: sem atualizar o remoto, a
 * varredura enxerga o mundo de ontem e não acha nada. E ele nomeia `origin`,
 * porque um `git fetch` pelado segue o remoto configurado da branch atual —
 * que pode ser outro — enquanto o veredito daqui para baixo se decide contra
 * `origin/HEAD`; atualizar um remoto e julgar por outro é decidir sobre refs
 * velhas sem saber.
 *
 * Fetch que falha **aborta**. Estado velho não é sempre inofensivo: um
 * force-push na branch padrão faz a ref local guardar commits que o servidor já
 * não tem, e uma branch ancestral dessa ref velha passaria por integrada. Quem
 * aceita esse risco de propósito diz isso com `--no-fetch`; ninguém deve cair
 * nele por uma rede que caiu.
 */
export async function prune(options = {}) {
  const dryRun = options.dryRun === true;
  const deleteBranch = options.keepBranch !== true;
  const mainRoot = mainWorktreePath(currentRoot);

  const { base, baseBranch, tracking } = remoteState(options);

  console.log(`Comparando com ${base}.`);

  const kept = [];
  const pruned = [];
  const failed = [];

  for (const entry of listGitWorktrees(currentRoot)) {
    // O checkout principal não é candidato nem informação útil aqui: listá-lo a
    // cada rodada seria só ruído.
    if (normalizePath(entry.path) === normalizePath(mainRoot)) continue;

    const isCurrent = normalizePath(entry.path) === normalizePath(currentRoot);
    const isBaseBranch = entry.branch === baseBranch;
    const track = entry.branch ? tracking.get(entry.branch) : undefined;
    // Os fatos caros (`git status` em cada worktree, `merge-base`) só são
    // colhidos para quem ainda pode ser removido; as recusas estruturais
    // decidem sozinhas.
    const structural = isCurrent || entry.detached || !entry.branch || isBaseBranch;
    const verdict = classifyPruneCandidate(
      {
        branch: entry.branch,
        detached: entry.detached,
        isMain: false,
        isCurrent,
        isBaseBranch,
        running: structural
          ? false
          : devIsRunning(worktreePaths(entry.path)) ||
            operationIsRunning(worktreePaths(entry.path)),
        dirty: structural ? false : worktreeIsDirty(entry.path),
        merged: structural ? false : branchIsMerged(entry.branch, base, currentRoot),
        upstream: track?.upstream ?? null,
        gone: track?.gone ?? false,
        fresh: structural ? false : worktreeIsFresh(entry.path),
      },
      { base },
    );

    const name = basename(entry.path);
    if (!verdict.prune) {
      kept.push(`${name} — ${verdict.reason}`);
      continue;
    }

    // O SHA sai impresso porque o passo seguinte é um `git branch -D`: sem ele,
    // o recibo de onde a branch parou só existiria no reflog.
    const sha = tryGit(["rev-parse", "--short", `refs/heads/${entry.branch}`], {
      cwd: currentRoot,
    }).stdout;
    const label = `${name}: ${entry.branch}${sha ? ` @ ${sha}` : ""} — ${verdict.reason}`;
    // A branch só cai quando a integração está PROVADA. O worktree é ambiente e
    // se recria a partir dela; commit que ninguém integrou não se recria de
    // lugar nenhum.
    const removeBranch = deleteBranch && verdict.canDeleteBranch === true;

    if (dryRun) {
      console.log(`[dry-run] ${label}`);
      pruned.push(name);
      continue;
    }

    console.log(label);
    try {
      // Sem `force`: a trava de alteração não commitada do `remove` é a última
      // rede, e em lote ela nunca deve ser desarmada.
      await remove(entry.path, { deleteBranch: removeBranch });
      pruned.push(name);
    } catch (error) {
      failed.push(name);
      console.error(
        `  Não consegui remover: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (kept.length > 0) {
    console.log("");
    console.log("Mantidos:");
    for (const line of kept) console.log(`  ${line}`);
  }

  console.log("");
  if (pruned.length === 0 && kept.length === 0) {
    console.log("Não há worktree além do checkout principal.");
    return { failed, kept, pruned };
  }

  const alvo = pruned.length === 1 ? "1 worktree" : `${pruned.length} worktrees`;
  const restante = kept.length === 1 ? "1 mantido" : `${kept.length} mantidos`;
  console.log(
    dryRun
      ? `${alvo} a remover, ${restante}. Rode sem --dry-run para valer.`
      : `Removi ${alvo}; ${restante}.`,
  );
  if (failed.length > 0) {
    console.log(
      `${failed.length === 1 ? "1 falhou" : `${failed.length} falharam`}: ${failed.join(", ")}.`,
    );
    process.exitCode = 1;
  }
  return { failed, kept, pruned };
}

/**
 * Fecha a tarefa do worktree atual depois do merge: confere que a branch está
 * integrada, para os processos, libera as portas e varre os outros worktrees
 * já integrados. O próprio checkout não se apaga de dentro (o diretório está em
 * uso pelo shell e pelo editor); ele sai na varredura da próxima tarefa
 * concluída, ou num `prune` feito de outro checkout.
 */
export async function finish(options = {}) {
  const paths = worktreePaths(currentRoot);
  assertLinkedWorktree(paths);
  const { base, baseBranch, tracking } = remoteState(options);
  const head = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: currentRoot });
  if (!head.ok || !head.stdout) fail("O worktree está destacado; não há branch para concluir.");
  const branch = head.stdout;
  const track = tracking.get(branch);
  const verdict = classifyPruneCandidate(
    {
      branch,
      detached: false,
      isMain: false,
      // O próprio worktree é julgado como o prune julgaria os outros: a branch
      // base e uma tarefa recém-criada, sem commits, não são trabalho concluído.
      isCurrent: false,
      isBaseBranch: branch === baseBranch,
      running: false,
      dirty: worktreeIsDirty(currentRoot),
      merged: branchIsMerged(branch, base, currentRoot),
      upstream: track?.upstream ?? null,
      gone: track?.gone ?? false,
      fresh: worktreeIsFresh(currentRoot),
    },
    { base },
  );
  if (!verdict.prune) {
    fail(`Não concluí ${branch}: ${verdict.reason}. Termine o merge ou commite antes.`);
  }
  console.log(`${branch} ${verdict.reason}.`);
  await cleanup({ root: currentRoot });
  releasePort(currentRoot, currentRoot);
  console.log("Processos parados e portas liberadas.");
  if (options.sweep !== false) {
    console.log("");
    await prune({ fetch: false });
  }
  console.log("");
  console.log(
    `Este checkout (${displayPath(currentRoot)}) sai na limpeza da próxima tarefa concluída, ou com \`bun run worktree prune\` de outro checkout.`,
  );
}
