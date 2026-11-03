/**
 * Catálogo dos scripts da raiz: aplicação e ambiente que cada um atinge.
 * `bun run help` imprime esta tabela; scripts/commands.test.ts confere que ela
 * cobre todos os scripts do package.json e que o README só cita nomes válidos.
 *
 * Aplicações: plataforma (apps/console + platform/convex), pacotes
 * (packages/*) e repositório (ferramentas e CI).
 * Ambientes: `local` não sai da máquina; `worktree` usa o Convex local do
 * worktree; `validação` lê ou escreve no deployment de validação; `produção`
 * publica na conta de produção; `nenhum` só compila ou confere arquivos.
 */
export const commands = {
  "backup:collect": [
    "plataforma",
    "Convex e R2 do plano versionado",
    "Simula coleta; --apply <hash> exige origem pausada e preserva locks dos objetos retidos",
  ],
  "backup:prove-capacity": [
    "plataforma",
    "dois worktrees locais explícitos e bucket R2 de ensaio opcional",
    "Restaura 2,25 GiB sintéticos; exige bancos vazios e não grava recibos",
  ],
  "content:prove-local": [
    "plataforma",
    "worktree",
    "Prova blob B4; --read avalia retorno completo pré-B5 no Convex local",
  ],
  "content:prove-hosted": [
    "plataforma",
    "preview Convex descartável",
    "Avaliação pré-B5 --read/--read-node com chave de preview em arquivo; recusa outros alvos",
  ],
  "cold:prove-hosted": [
    "plataforma",
    "preview Convex descartável e bucket frio real",
    "Prova a passagem fria com notas Sandbox sintéticas; apaga os objetos e retira gate e bucket do preview",
  ],
  "cold:prove-rehydration": [
    "plataforma",
    "worktree e bucket frio real",
    "Arquiva e reidrata só a janela (C2) no Convex local; apaga os objetos e retira as variáveis",
  ],
  "archive:prove-local": [
    "plataforma",
    "dois worktrees locais explícitos",
    "Ensaia arquivo e restauração Convex com dados sintéticos; substitui somente o destino descartável",
  ],
  "archive:cold": [
    "plataforma",
    "alvos explícitos",
    "Arquivo econômico administrativo; exige configuração da origem e destino local descartável",
  ],
  "plans:browser": [
    "plataforma",
    "worktree",
    "Prova contratação e upgrade com conta e pagamentos sintéticos no Convex local",
  ],
  help: ["repositório", "nenhum", "Lista os comandos, a aplicação e o ambiente de cada um"],
  "bench:workflow": [
    "repositório",
    "local",
    "Compara locks com uma revisão Git em snapshots isolados; exige --base <ref>",
  ],
  dev: [
    "plataforma",
    "worktree",
    "Convex local e console do worktree; recusa o checkout principal",
  ],
  "docs:dev": ["plataforma", "local", "Servidor da documentação pública em localhost:5180/docs"],
  build: [
    "plataforma",
    "configuração de validação",
    "Pacotes fiscais, tipos da plataforma e console/site; sem publicar",
  ],
  "packages:build": [
    "pacotes",
    "nenhum",
    "Compila fiscal-core, fiscal-nfe e fiscal-nfse para dist/",
  ],
  "platform:check": [
    "plataforma",
    "nenhum",
    "Compila os pacotes fiscais e confere os tipos da plataforma e do console",
  ],
  "platform:test": ["plataforma", "local", "Testes das áreas platform e packages, com cache local"],
  "usage:migration:status": [
    "plataforma",
    "deployment explícito (só leitura)",
    "Gera recibo agregado da migração de consumo; exige --deployment <nome>; não publica nem migra",
  ],
  "console:build": [
    "plataforma",
    "configuração de validação",
    "Build do console e do site com as URLs de validação; não publica",
  ],
  "docs:build": ["plataforma", "nenhum", "Documentação estática em apps/docs/dist, sem o console"],
  "test:changed": [
    "repositório",
    "local",
    "Só os testes alcançados pelas mudanças desde origin/main",
  ],
  "xml:check": ["pacotes", "nenhum", "Tipos de fiscal-nfe"],
  "xml:test": ["pacotes", "local", "Testes de fiscal-nfe"],
  "nfse:test": ["pacotes", "local", "Testes de fiscal-nfse"],
  "xml:prove": ["pacotes", "local", "Instala fiscal-nfe num consumidor limpo e confere o XML"],
  "xml:portal": [
    "pacotes",
    "portal da NF-e (só leitura)",
    "Compara a lista de esquemas do portal com o levantamento; --hashes confere os pacotes fixados",
  ],
  "xml:runtime": [
    "pacotes",
    "worktree ou hospedado",
    "Prova o runtime NF-e: local (worktree) ou hosted",
  ],
  "sdk:build": ["pacotes", "nenhum", "Compila e empacota o SDK"],
  "sdk:prove": ["pacotes", "local", "Instala o tarball do SDK num consumidor limpo"],
  "contracts:generate": [
    "plataforma",
    "nenhum",
    "Regrava OpenAPI e API-REFERENCE a partir de packages/contracts",
  ],
  "contracts:build": [
    "pacotes",
    "nenhum",
    "Compila contracts para packages/contracts/dist, o pacote privado; exige packages:build",
  ],
  "contracts:check": [
    "plataforma",
    "nenhum",
    "Confere artefatos REST e compatibilidade com a base",
  ],
  "licenses:inventory": ["repositório", "nenhum", "Regrava o inventário de licenças"],
  "licenses:check": [
    "repositório",
    "nenhum",
    "Confere inventário, licenças próprias e avisos dos pacotes",
  ],
  "distribution:prove": ["pacotes", "local", "Prova os artefatos distribuídos fora do monorepo"],
  "secrets:check": [
    "repositório",
    "nenhum",
    "Procura credenciais nos arquivos de texto versionados, sem mostrar o valor",
  ],
  "public:tree": [
    "repositório",
    "local",
    "Monta a árvore do repositório público (#267) de um SHA numa pasta fora do checkout e varre os bytes; exige --sha e --out; só roda no repositório privado (commit da auditoria e lista em custódia); não publica",
  ],
  "ci:local": [
    "repositório",
    "local",
    "Valida alterações locais pelo grafo Validate; resumo e recibo por tentativa, cache permitido",
  ],
  "ci:prove": [
    "repositório",
    "local",
    "Prova um commit limpo pelo grafo Validate sem cache; resumo e recibo por tentativa",
  ],
  "ci:test": ["repositório", "local", "Suíte de testes do CI, com recibo da revisão"],
  "ci:boundaries": ["repositório", "nenhum", "Fronteiras de importação entre pacotes"],
  "platform:browser": [
    "plataforma",
    "worktree",
    "Jornadas de conta no navegador contra o Convex do worktree",
  ],
  "platform:worker": ["plataforma", "local", "Prova o Worker de auth no workerd, sem rede"],
  "platform:privacy-worker": [
    "plataforma",
    "local",
    "Prova entrega e redirecionamentos da caixa no workerd, sem rede",
  ],
  "deploy:mail": [
    "plataforma",
    "produção (publica)",
    "Publica o Worker de e-mail freecorpsnfe-privacy-mail; --dry-run só empacota",
  ],
  "bench:navigation": [
    "plataforma",
    "worktree",
    "Benchmark de navegação do console contra o Convex local",
  ],
  "validation:browser": [
    "plataforma",
    "validação",
    "Jornada M0 no navegador contra o console de validação",
  ],
  "validation:accounts": [
    "plataforma",
    "validação (escreve)",
    "Cria as contas de teste por papel; exige --bootstrap",
  ],
  "validation:check": ["plataforma", "validação", "Confere o deployment de validação"],
  "validation:backup": ["plataforma", "validação", "Exporta backup do deployment de validação"],
  "validation:verify-persistence": [
    "plataforma",
    "validação",
    "Confere os dados após publicação na validação",
  ],
  "validation:deploy": [
    "plataforma",
    "validação (publica)",
    "Publica platform/convex na validação",
  ],
  "validation:console:deploy": [
    "plataforma",
    "validação (publica)",
    "Compila e publica o console de validação",
  ],
  "validation:probe:create": ["plataforma", "validação (escreve)", "Sonda de escrita na validação"],
  "validation:probe:read": ["plataforma", "validação", "Sonda de leitura na validação"],
  worktree: ["repositório", "worktree", "Ciclo de vida dos worktrees; ver docs/worktrees.md"],
  "worktree:create": ["repositório", "worktree", "Cria e prepara um worktree da plataforma"],
  "worktree:setup": [
    "repositório",
    "worktree",
    "Prepara o worktree atual; recusa o checkout principal",
  ],
  "worktree:dev": ["plataforma", "worktree", "Sessão local do worktree, chamada por dev"],
  "worktree:sync": [
    "plataforma",
    "worktree",
    "Reaplica ambiente, schema e funções no Convex local, sem inserir dados",
  ],
  "worktree:seed": ["plataforma", "worktree", "Nome antigo de worktree:sync; não insere dados"],
  "worktree:mail": ["plataforma", "worktree", "Lê o e-mail capturado pelo coletor local"],
  "worktree:list": ["repositório", "worktree", "Lista aplicativo, portas e ambientes registrados"],
  "worktree:status": [
    "do worktree",
    "local",
    "Consulta operação e resultado do setup; --json fornece saída sanitizada",
  ],
  "worktree:wait": [
    "do worktree",
    "local",
    "Aguarda o setup observado com prazo; timeout não interrompe a preparação",
  ],
  "worktree:doctor": [
    "repositório",
    "worktree",
    "Confere a configuração e o isolamento do ambiente",
  ],
  "worktree:cleanup": ["repositório", "worktree", "Encerra os processos registrados do worktree"],
  "worktree:remove": [
    "repositório",
    "worktree",
    "Remove um worktree conforme as proteções do script",
  ],
  "worktree:prune": ["repositório", "worktree", "Remove worktrees já integrados"],
  "worktree:finish": [
    "repositório",
    "worktree",
    "Conclui o worktree após o merge e remove os outros já integrados",
  ],
};

/**
 * Nomes antigos e o que os substitui. O script antigo só aponta o novo e
 * falha, para que nenhum consumidor execute outra aplicação por engano.
 */
export const renamed = {
  "xml:build": "packages:build",
  "xml:boundaries": "ci:boundaries",
  "console:deploy": "validation:console:deploy",
};

export function renamedMessage(name) {
  const next = renamed[name];
  if (!next) throw new Error(`Comando sem renomeação: ${name}`);
  const [app, environment] = commands[next];
  return `\`${name}\` foi renomeado. Use \`bun run ${next}\` (${app}, ambiente: ${environment}).`;
}

export function helpText() {
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  const lines = Object.entries(commands).map(
    ([name, [app, environment, description]]) =>
      `${name.padEnd(width)}  ${app} · ${environment}\n${" ".repeat(width + 2)}${description}`,
  );
  const old = Object.entries(renamed).map(([name, next]) => `${name} → ${next}`);
  return [
    "Comandos da raiz (bun run <comando>): aplicação · ambiente",
    "",
    ...lines,
    "",
    `Nomes antigos, que só indicam o novo: ${old.join(", ")}.`,
    "Testes por área: vp run test:<platform|packages|console|tooling|benchmark>.",
    "Grafo do CI: vp run validate. Publicação de produção: só pelos workflows Deploy production",
    "e Deploy NFS-e fiscal production; o Worker de e-mail, por deploy:mail.",
  ].join("\n");
}

/**
 * Decide o processo de `dev`. Ele roda só em worktree e inicia a plataforma; um
 * worktree preparado para o backoffice legado, aposentado na #345, é recusado.
 * @param {string} command
 * @param {{ linked: boolean, app?: string }} checkout
 */
export function resolveDev(command, { linked, app }) {
  if (command !== "dev") throw new Error(`Comando de dev desconhecido: ${command}`);
  if (!linked)
    throw new Error(
      "`bun run dev` roda só em worktree. Crie um com `bun run worktree:create <nome>`.",
    );
  if (app === "legacy")
    throw new Error(
      "Este worktree foi preparado para o backoffice legado, que foi aposentado. Crie outro worktree para a plataforma com `bun run worktree:create <nome>`.",
    );
  if (app !== "platform") throw new Error(`Aplicativo do worktree desconhecido: ${app}.`);
  return { args: ["run", "worktree:dev"], target: "plataforma local do worktree" };
}
