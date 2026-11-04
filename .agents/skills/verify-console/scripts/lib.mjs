// Regras puras dos scripts da skill verify-console: argumentos, telas, estados e a
// decisão de encerrar o dev. Os scripts leem disco, rede e processos; este módulo não.

/** Pasta das saídas, relativa à raiz do worktree; .ci-results/ não vai para o Git. */
export const outputDirectory = ".ci-results/verify-console";

/** Pedido de parada que dev-supervisor.mjs observa, dentro de outputDirectory. */
export const stopRequestName = "dev.stop";

/** Os estados que cada tela precisa mostrar. */
export const states = ["dados", "vazio", "carregando", "erro"];

/**
 * Telas principais e a URL de cada estado. `seed` é o account.json gravado por
 * seed-account.mjs: `data` é a organização com dados, `empty` a vazia.
 * O estado carregando usa a URL de dados com o Convex retido; o de erro, um
 * identificador forjado que o backend recusa.
 */
export const screens = [
  {
    id: "organizacao",
    title: "Organização",
    url: (seed, state) =>
      state === "erro"
        ? "/app/organizacao-inexistente"
        : `/app/${state === "vazio" ? seed.empty.slug : seed.data.slug}`,
  },
  {
    id: "empresas",
    title: "Empresas",
    url: (seed, state) =>
      state === "erro"
        ? `/app/${seed.data.slug}/companies/empresa-inexistente`
        : `/app/${state === "vazio" ? seed.empty.slug : seed.data.slug}/companies`,
  },
  {
    id: "documentos",
    title: "Documentos",
    url: (seed, state) =>
      state === "erro"
        ? `/app/${seed.data.slug}/documents?company=empresa-inexistente`
        : state === "vazio"
          ? `/app/${seed.empty.slug}/documents`
          : `/app/${seed.data.slug}/documents?company=${seed.data.companyId}`,
  },
  {
    id: "chaves",
    title: "Chaves de API",
    url: (seed, state) =>
      state === "erro"
        ? `/app/${seed.data.slug}/developer/keys/projeto-inexistente`
        : state === "vazio"
          ? `/app/${seed.empty.slug}/developer/keys`
          : `/app/${seed.data.slug}/developer/keys/${seed.data.projectId}`,
  },
  {
    id: "webhooks",
    title: "Webhooks",
    url: (seed, state) =>
      state === "erro"
        ? `/app/${seed.data.slug}/developer/webhooks/projeto-inexistente`
        : state === "vazio"
          ? `/app/${seed.empty.slug}/developer/webhooks`
          : `/app/${seed.data.slug}/developer/webhooks/${seed.data.projectId}`,
  },
];

const label = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Argumentos de capture-screens.mjs. `--label` nomeia a rodada (antes, depois);
 * `--screen` e `--state` restringem, e podem repetir.
 * @param {string[]} argv
 */
export function captureArgs(argv) {
  /** @type {{ label: string, screens: string[], states: string[], help: boolean }} */
  const options = { label: "", screens: [], states: [], help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("-")) throw new Error(`${arg} exige um valor`);
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--label") options.label = value();
    else if (arg === "--screen") options.screens.push(value());
    else if (arg === "--state") options.states.push(value());
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  if (options.help) return options;
  if (!label.test(options.label))
    throw new Error("--label exige um nome curto em minúsculas, como antes ou depois");
  for (const id of options.screens)
    if (!screens.some((screen) => screen.id === id)) throw new Error(`Tela desconhecida: ${id}`);
  for (const state of options.states)
    if (!states.includes(state)) throw new Error(`Estado desconhecido: ${state}`);
  return options;
}

/**
 * As capturas da rodada, na ordem: cada tela em cada estado pedido.
 * @param {{ data: { slug: string, companyId: string, projectId: string }, empty: { slug: string } }} seed
 * @param {{ screens?: string[], states?: string[] }} [filter]
 */
export function capturePlan(seed, { screens: only = [], states: wanted = [] } = {}) {
  const chosen = screens.filter((screen) => !only.length || only.includes(screen.id));
  const chosenStates = states.filter((state) => !wanted.length || wanted.includes(state));
  return chosen.flatMap((screen) =>
    chosenStates.map((state) => ({
      screen: screen.id,
      title: screen.title,
      state,
      path: screen.url(seed, state),
      file: `${screen.id}-${state}.png`,
    })),
  );
}

/**
 * Confere o que a captura mostrou contra o estado pedido. `observed` vem da
 * página: `busy` (indicador de carregamento visível), `alert` (alerta ou título
 * de erro visível) e `heading` (título principal).
 */
export function judgeCapture(state, observed) {
  if (state === "carregando")
    return observed.busy ? "conforme" : "não exercitado: a tela não mostrou carregamento";
  if (state === "erro") return observed.alert ? "conforme" : "divergente: nenhum erro visível";
  if (observed.busy) return "divergente: ainda carregando";
  if (observed.alert) return "divergente: erro visível";
  return observed.heading ? "conforme" : "divergente: sem título principal";
}

/**
 * Encerrar o dev só quando esta skill o iniciou e o processo ainda é o mesmo.
 * `record` é o dev.json de start-dev.mjs; `identity`, a identidade atual do PID
 * (hash de criação e comando) ou null quando o processo não existe.
 */
export function stopDecision(record, identity) {
  if (!record) return { stop: false, reason: "nenhum dev iniciado por esta skill" };
  if (!record.startedBySkill)
    return { stop: false, reason: "o dev já estava rodando; ele não é desta skill" };
  if (identity === null) return { stop: false, reason: "o processo já terminou" };
  if (identity !== record.identity)
    return { stop: false, reason: "o PID agora pertence a outro processo; nada foi encerrado" };
  return { stop: true, reason: `encerrando o PID ${record.pid}` };
}
