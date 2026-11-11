/**
 * Registro de portas reservadas, compartilhado por todos os worktrees do clone.
 *
 * Duas coisas são reservadas por worktree: a porta do frontend (o Vite) e o par
 * cloud/site do backend local do Convex. As duas saem da MESMA entrada, sob o
 * MESMO lock, para a origem do frontend e o backend de um worktree nunca
 * derivarem para as portas de outro.
 */
import { connect, createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isWorktreeConvexPort,
  isWorktreeFrontendPort,
  WORKTREE_CONVEX_PORT_END,
  WORKTREE_CONVEX_PORT_START,
  WORKTREE_CONVEX_PORT_STRIDE,
  WORKTREE_FRONTEND_ALLOCATION_START,
  WORKTREE_FRONTEND_PORT_END,
  worktreeConvexPorts,
} from "../worktree-local.ts";
import { readLocalConfig } from "./deployment.mjs";
import { fail, git, replaceFileSync, sleepSync } from "./exec.mjs";
import { currentRoot, normalizePath, worktreePaths } from "./paths.mjs";

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = "freecorpsnfe-worktrees.json";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
// A rodada só se repete quando outro worktree ganha a corrida pela mesma porta.
const PORT_CLAIM_ROUNDS = 5;

/**
 * O registro mora no diretório comum do git, então o checkout principal e todo
 * worktreee linked leem e escrevem as mesmas atribuições sem nunca commitar nada.
 */
export function registryPath(cwd = currentRoot) {
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  return join(commonDir, REGISTRY_FILE);
}

export function listGitWorktrees(cwd = currentRoot) {
  const output = git(["worktree", "list", "--porcelain"], { cwd });
  /** @type {Array<{path: string, head: string | null, branch: string | null, detached: boolean, bare: boolean, locked: boolean}>} */
  const entries = [];
  /** @type {(typeof entries)[number] | null} */
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length).trim(),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("locked")) current.locked = true;
  }
  return entries;
}

/** O git sempre lista a árvore de trabalho principal primeiro. */
export function mainWorktreePath(cwd = currentRoot) {
  const [first] = listGitWorktrees(cwd);
  if (!first) fail("Não consegui determinar o worktree principal do git.");
  return first.path;
}

export function isLinkedWorktree(cwd = currentRoot) {
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd });
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  return normalizePath(gitDir) !== normalizePath(commonDir);
}

/**
 * `mkdir` é atômico no Windows, macOS e Linux, o que faz dele a primitiva
 * portátil para proteger `worktree:create` concorrentes.
 */
function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let ageMs;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        // Quem segurava soltou entre o mkdir que falhou e o stat.
        continue;
      }
      if (ageMs > LOCK_STALE_MS) {
        rmSync(lockDir, { force: true, recursive: true });
        continue;
      }
      if (Date.now() > deadline) {
        fail(`Esgotou o tempo esperando o lock do registro de portas (${lockDir}).`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function readRegistryFile(filePath) {
  if (!existsSync(filePath)) return { version: REGISTRY_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.entries && typeof parsed.entries === "object") {
      return { version: REGISTRY_VERSION, entries: { ...parsed.entries } };
    }
  } catch {
    // Registro corrompido é reconstruído da lista viva de worktrees abaixo.
  }
  return { version: REGISTRY_VERSION, entries: {} };
}

function writeRegistryFile(filePath, registry) {
  // Escreve-e-renomeia: leitor nenhum chega a ver um registro truncado. Um
  // `list` concorrente segura o destino aberto por alguns ms no Windows.
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`);
  replaceFileSync(temporary, filePath);
}

/**
 * Descarta atribuição de worktree que o git já não conhece. A reserva do Convex
 * cai sozinha — uma entrada anterior a esse campo, ou sobrando de uma janela
 * mais larga, ainda tem uma porta de frontend utilizável.
 */
export function pruneEntries(entries, livePaths) {
  const kept = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!livePaths.has(key)) continue;
    const port = isWorktreeFrontendPort(value?.port) ? value.port : undefined;
    const convexPort = isWorktreeConvexPort(value?.convexPort) ? value.convexPort : undefined;
    // Os dois campos caem de forma independente. Descartar a entrada inteira por
    // falta do `port` apagava a reserva de Convex recém-feita, porque o `dev`
    // reserva o Convex ANTES do frontend: a poda da escrita seguinte jogava fora
    // o par que o backend estava prestes a usar.
    if (port === undefined && convexPort === undefined) continue;
    kept[key] = { ...value, port, convexPort };
  }
  return kept;
}

function withRegistry(cwd, mutate) {
  const filePath = registryPath(cwd);
  const lockDir = `${filePath}.lock`;
  acquireLock(lockDir);
  try {
    const registry = readRegistryFile(filePath);
    const livePaths = new Set(listGitWorktrees(cwd).map((entry) => normalizePath(entry.path)));
    registry.entries = pruneEntries(registry.entries, livePaths);
    const result = mutate(registry, livePaths);
    writeRegistryFile(filePath, registry);
    return result;
  } finally {
    rmSync(lockDir, { force: true, recursive: true });
  }
}

/** Um override só é honrado enquanto fica dentro da janela do próprio tipo. */
function envScanStart(variable, isValid, fallback) {
  const raw = Number(process.env[variable]);
  return isValid(raw) ? raw : fallback;
}

const FRONTEND_KIND = {
  end: WORKTREE_FRONTEND_PORT_END,
  field: "port",
  // Ficar dentro desta janela é também o que mantém válido o
  // `isLocalWorktreeSiteUrl` do lado do Convex.
  isValid: isWorktreeFrontendPort,
  label: "frontend",
  portsFor: (port) => [port],
  start: () =>
    envScanStart(
      "FNFE_WORKTREE_PORT_START",
      // Não é `isWorktreeFrontendPort`, que aceita 5173: um override começando
      // ali entregaria a um worktree a porta da qual o checkout principal não sai.
      (value) => isWorktreeFrontendPort(value) && value >= WORKTREE_FRONTEND_ALLOCATION_START,
      WORKTREE_FRONTEND_ALLOCATION_START,
    ),
  stride: 1,
};

/**
 * Portas em que o deployment de outro worktree já está, tendo ele reservado
 * aqui ou não. Um worktree criado direto no `git worktree add` — pelo editor ou
 * por um agente — tem config de deployment e nenhuma entrada no registro, e
 * entregar as portas dele para outro é justamente a colisão que este arquivo
 * existe para impedir.
 */
function convexPortsInUseElsewhere(cwd, selfKey) {
  const taken = new Set();
  for (const entry of listGitWorktrees(cwd)) {
    if (normalizePath(entry.path) === selfKey) continue;
    let config = null;
    try {
      config = readLocalConfig(worktreePaths(entry.path));
    } catch {
      // Config malformada não reserva nada.
    }
    // As duas metades. Uma config alheia não tem garantia de estar alinhada ao
    // passo — a alocação do próprio Convex pula uma porta site ocupada e deixa
    // um buraco —, então gravar só a cloud deixaria a site dela alocável.
    if (config) {
      taken.add(config.ports.cloud);
      taken.add(config.ports.site);
    }
  }
  return taken;
}

const CONVEX_KIND = {
  claimedElsewhere: convexPortsInUseElsewhere,
  end: WORKTREE_CONVEX_PORT_END,
  field: "convexPort",
  isValid: isWorktreeConvexPort,
  label: "backend do Convex",
  portsFor: (port) => {
    const ports = worktreeConvexPorts(port);
    return [ports.cloud, ports.site];
  },
  start: () =>
    envScanStart(
      "FNFE_WORKTREE_CONVEX_PORT_START",
      isWorktreeConvexPort,
      WORKTREE_CONVEX_PORT_START,
    ),
  stride: WORKTREE_CONVEX_PORT_STRIDE,
};

/**
 * Uma reserva só é reaproveitável se ainda está dentro da janela de onde este
 * tipo aloca. É isso que move um worktree que segura uma porta que a janela já
 * não cobre — 5173, fora da alocação desde que era a porta fixa do backoffice
 * legado no checkout principal — para uma vaga nova.
 */
function canAllocate(kind, port) {
  return kind.isValid(port) && port >= kind.start() && port <= kind.end;
}

/**
 * Uma reserva está tomada quando QUALQUER porta que ela cobre está. Comparar só
 * a porta cloud deixaria este worktree pegar um par que atravessa um par alheio
 * — conflito que a sondagem viva esconde enquanto aquele backend estiver de pé,
 * e que só aparece quando ele para.
 */
function slotIsTaken(kind, port, taken) {
  return kind.portsFor(port).some((candidate) => taken.has(candidate));
}

function nextFreeSlot(kind, taken) {
  for (let port = kind.start(); port <= kind.end; port += kind.stride) {
    if (!slotIsTaken(kind, port, taken)) return port;
  }
  fail(`Sem porta de ${kind.label} livre entre ${kind.start()} e ${kind.end}.`);
}

/**
 * Devolve a vaga estável deste worktree para um tipo de porta, alocando a menor
 * não usada na primeira vez. Um worktree mantém as portas entre reinícios, a
 * menos que alguma seja excluída porque outra coisa já a segura.
 */
function assignSlot(kind, root, options = {}) {
  const cwd = options.cwd ?? root;
  const excluded = new Set(options.exclude ?? []);
  return withRegistry(cwd, (registry) => {
    const key = normalizePath(root);
    const taken = new Set(excluded);
    for (const port of kind.claimedElsewhere?.(cwd, key) ?? []) taken.add(port);
    for (const [entryKey, entry] of Object.entries(registry.entries)) {
      if (entryKey !== key) taken.add(entry[kind.field]);
    }

    const existing = registry.entries[key];
    let port = options.preferred ?? existing?.[kind.field];
    if (!canAllocate(kind, port) || slotIsTaken(kind, port, taken)) {
      port = nextFreeSlot(kind, taken);
    }

    // Mescla em vez de substituir: a reserva do outro tipo mora aqui também.
    registry.entries[key] = {
      ...existing,
      path: root.replaceAll("\\", "/"),
      branch: options.branch ?? existing?.branch ?? null,
      [kind.field]: port,
      updatedAt: new Date().toISOString(),
    };
    return port;
  });
}

export function assignPort(root, options = {}) {
  return assignSlot(FRONTEND_KIND, root, options);
}

export function releasePort(root, cwd = currentRoot) {
  withRegistry(cwd, (registry) => {
    delete registry.entries[normalizePath(root)];
  });
}

export function readAssignments(cwd = currentRoot) {
  const filePath = registryPath(cwd);
  return readRegistryFile(filePath).entries;
}

// Endereços em que um bind de teste precisa passar. Um só não basta: no macOS
// (SO_REUSEADDR, que o libuv liga) um bind em 127.0.0.1 passa com outro
// processo escutando em `*:porta`, e um bind em `::` passa com outro em
// 127.0.0.1. Foi assim que o setup entregou a 3214, onde o backend Convex
// local de outro projeto escutava em `*:3214`.
const PROBE_BIND_HOSTS = ["127.0.0.1", "0.0.0.0", "::"];
// A conexão pega quem escuta só em loopback, inclusive só em `::1`, que nenhum
// bind acima acusa no macOS.
const PROBE_CONNECT_HOSTS = ["127.0.0.1", "::1"];
// Sem pilha IPv6 o endereço simplesmente não existe; não é sinal de ocupação.
const PROBE_UNSUPPORTED = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH", "EHOSTUNREACH"]);
const PROBE_CONNECT_TIMEOUT_MS = 1_000;

function bindSucceeds(port, host) {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => resolveBind(PROBE_UNSUPPORTED.has(error?.code)));
    server.listen({ exclusive: true, host, port }, () => server.close(() => resolveBind(true)));
  });
}

/** Verdadeiro só quando ninguém aceita a conexão (ECONNREFUSED ou sem IPv6). */
function nobodyAnswers(port, host) {
  return new Promise((resolveConnect) => {
    const socket = connect({ host, port });
    socket.unref();
    const finish = (free) => {
      socket.destroy();
      resolveConnect(free);
    };
    // Sem resposta no loopback é estranho; o lado conservador é dar como ocupada.
    socket.setTimeout(PROBE_CONNECT_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(false));
    socket.once("error", (error) =>
      finish(error?.code === "ECONNREFUSED" || PROBE_UNSUPPORTED.has(error?.code)),
    );
  });
}

/**
 * Uma porta está livre só se nenhum processo, deste ou de outro projeto, a
 * segura em endereço nenhum: binds de teste nos endereços curinga e de
 * loopback, mais uma conexão de teste no loopback. A sondagem só abre e fecha
 * sockets próprios, nunca encerra o processo dono da porta. O erro é para o
 * lado conservador: pular vaga livre é barato, entregar vaga ocupada não é.
 */
export async function portIsAvailable(port) {
  for (const host of PROBE_BIND_HOSTS) {
    if (!(await bindSucceeds(port, host))) return false;
  }
  for (const host of PROBE_CONNECT_HOSTS) {
    if (!(await nobodyAnswers(port, host))) return false;
  }
  return true;
}

async function slotIsAvailable(kind, port) {
  for (const candidate of kind.portsFor(port)) {
    if (!(await portIsAvailable(candidate))) return false;
  }
  return true;
}

/**
 * Resolve a vaga atribuída, andando para a seguinte só quando a porta está
 * genuinamente ocupada por um processo fora do registro.
 *
 * A sondagem acontece contra um único retrato do registro, e só a porta que
 * sobrevive à sondagem é reivindicada. Varrer pelo `assignPort` custaria um
 * lock, dois subprocessos de git e uma reescrita do registro por candidata.
 *
 * A reivindicação continua sendo a autoridade: ela relê sob o lock, então uma
 * porta tomada entre a sondagem e a reivindicação manda a gente para mais uma
 * rodada, em vez de entregar uma porta que é de outro worktree.
 */
async function resolveSlot(kind, root, options = {}) {
  const cwd = options.cwd ?? root;
  // `registryPath` é um `git rev-parse`: fica fora do laço porque o diretório
  // comum do git não muda no meio de uma resolução.
  const filePath = registryPath(cwd);
  const key = normalizePath(root);
  const excluded = new Set(options.exclude ?? []);

  for (let round = 0; round < PORT_CLAIM_ROUNDS; round += 1) {
    const entries = readRegistryFile(filePath).entries;
    // Poda exatamente como a reivindicação sob lock faz. Um worktree removido
    // com `git worktree remove` pelado deixa a entrada para trás, e contá-la
    // como tomada empurraria o próximo worktree para além de uma vaga livre.
    const livePaths = new Set(listGitWorktrees(cwd).map((entry) => normalizePath(entry.path)));
    const taken = kind.claimedElsewhere?.(cwd, key) ?? new Set();
    for (const [entryKey, entry] of Object.entries(entries)) {
      const reserved = entry?.[kind.field];
      if (entryKey !== key && livePaths.has(entryKey) && kind.isValid(reserved)) {
        taken.add(reserved);
      }
    }

    // A vaga do próprio worktree primeiro, para um reinício manter a URL.
    const ordered = [];
    if (canAllocate(kind, options.preferred)) ordered.push(options.preferred);
    if (canAllocate(kind, entries[key]?.[kind.field])) {
      ordered.push(entries[key][kind.field]);
    }
    for (let port = kind.start(); port <= kind.end; port += kind.stride) {
      ordered.push(port);
    }

    let candidate = null;
    for (const port of ordered) {
      if (excluded.has(port) || slotIsTaken(kind, port, taken)) continue;
      if (await slotIsAvailable(kind, port)) {
        candidate = port;
        break;
      }
      excluded.add(port);
    }
    if (candidate === null) {
      fail(`Sem porta de ${kind.label} livre entre ${kind.start()} e ${kind.end}.`);
    }

    const claimed = assignSlot(kind, root, {
      ...options,
      exclude: [...excluded],
      preferred: candidate,
    });
    if (claimed === candidate) return claimed;
    // Outro worktree reivindicou a candidata primeiro e nos deram outra vaga;
    // confira se essa está mesmo livre antes de usar.
    if (await slotIsAvailable(kind, claimed)) return claimed;
    excluded.add(claimed);
  }

  fail(
    `Não consegui reivindicar uma porta de ${kind.label} em ${PORT_CLAIM_ROUNDS} tentativas; outro worktree tomou antes toda vez.`,
  );
}

export function resolveFrontendPort(root, options = {}) {
  return resolveSlot(FRONTEND_KIND, root, options);
}

/**
 * Reserva o par cloud/site em que o backend local deste worktree fica fixado. O
 * par é passado ao `convex dev`, que senão escolheria 3210 para todo worktree
 * criado num momento em que nenhum outro backend estava rodando.
 */
export function resolveConvexPort(root, options = {}) {
  return resolveSlot(CONVEX_KIND, root, options);
}
