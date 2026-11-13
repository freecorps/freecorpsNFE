/**
 * Catálogo dos scripts da raiz e dos roteiros chamados pelo caminho: aplicação e
 * ambiente que cada um atinge. `bun run help` imprime as duas tabelas;
 * scripts/repo/commands.test.ts confere que a primeira cobre todos os scripts do
 * package.json, que a segunda cobre os pontos de entrada sem outro chamador e
 * que o README só cita nomes válidos.
 *
 * Aplicações: plataforma (apps/console + platform/convex), pacotes
 * (packages/*) e repositório (ferramentas e CI).
 * Ambientes: `local` não sai da máquina; `worktree` usa o Convex local do
 * worktree; `validação` lê ou escreve no deployment de validação; `produção`
 * publica na conta de produção; `nenhum` só compila ou confere arquivos.
 */
export const commands = {
  prepare: [
    "repositório",
    "local",
    "Roda após vp install: instala o dispatcher de hooks do Vite+ (.vite-hooks/), com o pre-push da varredura pública",
  ],
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
  "check:changed": [
    "repositório",
    "local",
    "Antes do push: formatação, lint, typecheck afetado e testes alcançados desde origin/main (--base, --dry-run)",
  ],
  "budget:update": [
    "plataforma",
    "nenhum",
    "Grava em budget.json o gzip medido dos chunks principais do console; um aumento pede a label budget-increase na PR",
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
  "sdk:compat": [
    "pacotes",
    "nenhum",
    "Compara a API TypeScript do SDK com a versão publicada e exige o bump; --record grava uma publicação",
  ],
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
  "knip:check": [
    "repositório",
    "nenhum",
    "Procura arquivos e dependências sem uso nos workspaces e exports sem uso em platform/convex/lib/ (knip.jsonc)",
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
  worktree: [
    "repositório",
    "worktree",
    "bun run worktree <list|remove|prune|sync|status|wait|doctor|mail|config>; ver docs/worktrees.md",
  ],
  "worktree:create": ["repositório", "worktree", "Cria e prepara um worktree da plataforma"],
  "worktree:setup": [
    "repositório",
    "worktree",
    "Prepara o worktree atual; recusa o checkout principal",
  ],
  "worktree:dev": ["plataforma", "worktree", "Sessão local do worktree, chamada por dev"],
  "worktree:cleanup": ["repositório", "worktree", "Encerra os processos registrados do worktree"],
  "worktree:reap": [
    "repositório",
    "worktree",
    "Encerra processos deixados rodando por worktrees apagados",
  ],
  "worktree:finish": [
    "repositório",
    "worktree",
    "Conclui o worktree após o merge e remove os outros já integrados",
  ],
};

/**
 * Roteiros que se rodam pelo caminho (`node` ou `bun scripts/...`), sem atalho
 * no package.json: provas manuais, passos de runbook e geradores. A descrição
 * aponta o documento ou arquivo que manda rodá-lo. scripts/repo/commands.test.ts
 * confere que todo ponto de entrada de scripts/ é chamado por package.json,
 * workflow, vite.config.ts, hook do Git, outro script alcançável ou por esta lista.
 */
export const routines = {
  "scripts/backup/prove-closure-restore.mjs": [
    "plataforma",
    "dois worktrees locais",
    "Ensaio D05: expurgo depois de restaurar num deployment vazio, com dados sintéticos (docs/operacao/restauracao.md)",
  ],
  "scripts/backup/prove-restore.mjs": [
    "plataforma",
    "dois worktrees locais",
    "Ensaio de restauração: prepare na origem, restore no worktree de destino (docs/operacao/restauracao.md)",
  ],
  "scripts/billing/check-billing-stripe.mjs": [
    "plataforma",
    "conta Stripe (só leitura)",
    "Confere a conta Stripe antes de ligar o catálogo ou o anual; exige --key-file (docs/plataforma/BILLING.md)",
  ],
  "scripts/cold-tier/cold-tier-locks.mjs": [
    "plataforma",
    "bucket R2 da camada fria (escreve)",
    "Acrescenta ou estende as regras de lock por ano; nunca encurta (docs/operacao/camada-fria.md)",
  ],
  "scripts/console/measure-console-bundle.mjs": [
    "plataforma",
    "nenhum",
    "Mede JS e CSS do console com gzip depois de console:build (docs/v1.0/PILOT.md)",
  ],
  "scripts/contracts/prove-contract-drift.mjs": [
    "plataforma",
    "local",
    "Prova manual de que contracts:check recusa artefato REST desatualizado; grava .ci-results/74 (docs/desenvolvimento/ci.md)",
  ],
  "scripts/contracts/prove-webhook-contract.mjs": [
    "plataforma",
    "local",
    "Roda os vetores de webhook contra o receptor de exemplo; grava .ci-results/73 (docs/plataforma/WEBHOOKS.md)",
  ],
  "scripts/deploy/prove-selfhost.mjs": [
    "plataforma",
    "Docker local e túnel cloudflared",
    "Prova a instalação própria: servidor, receptor HTTPS e recuperação (docs/operacao/instalacao-propria.md)",
  ],
  "scripts/distribution/publish-packages.mjs": [
    "pacotes",
    "npm (publica)",
    "Publica os tarballs aceitos por distribution:prove; exige npm login e 2FA (docs/operacao/release.md)",
  ],
  "scripts/fiscal/deploy-nfe-proof.mjs": [
    "plataforma",
    "deployment dev isolado (publica)",
    "Publica o alvo dev/issue-69-xml-proof que xml:runtime hosted usa (docs/desenvolvimento/ci.md)",
  ],
  "scripts/fiscal/fetch-references.ts": [
    "plataforma",
    "fontes públicas de NCM e municípios (só leitura)",
    "Coleta as tabelas de referência em .reference-data/ (docs/plataforma/REFERENCES.md)",
  ],
  "scripts/fiscal/fiscal-proof.mjs": [
    "plataforma",
    "deployment dev/issue-50-fiscal-proof (publica) e fisco",
    "Execução fiscal manual, em Windows e fora do CI; recusa outros alvos (docs/plataforma/CAPTURE.md)",
  ],
  "scripts/fiscal/generate-nfe-corpus.mjs": [
    "pacotes",
    "local",
    "Regrava o corpus sintético de tests/fixtures/nfe/4.00 (origem no manifest.json da pasta)",
  ],
  "scripts/fiscal/prove-capture.mjs": [
    "plataforma",
    "worktree",
    "Prova recorrente da captura NF-e (entrega 78) com bun run dev ativo; grava .ci-results/78 (docs/desenvolvimento/ci.md)",
  ],
  "scripts/fiscal/prove-certificate-transport.ts": [
    "plataforma",
    "local",
    "TLS real em loopback com o bundle Node; prove-capture o compila (docs/plataforma/CERTIFICATES.md)",
  ],
  "scripts/fiscal/prove-certificates-hosted.ts": [
    "plataforma",
    "deployment dev isolado (publica)",
    "Prova de certificados no alvo dev/issue-77-certificates-proof (docs/plataforma/CERTIFICATES.md)",
  ],
  "scripts/fiscal/prove-excluded-events.mjs": [
    "pacotes",
    "local",
    "Compara a situação de eventos anterior à correção com a atual; exige packages:build (packages/fiscal-nfe/README.md)",
  ],
  "scripts/fiscal/prove-registry-provider.mjs": [
    "plataforma",
    "provedor de cadastro público (só leitura)",
    "Prova online do provedor com CNPJs públicos, sem semear banco (docs/plataforma/REGISTRY.md)",
  ],
  "scripts/fiscal/reference-local.mjs": [
    "plataforma",
    "worktree",
    "stage, current e publish das tabelas de referência no Convex local (docs/plataforma/REFERENCES.md)",
  ],
  "scripts/fiscal/sync-nfe-schemas.py": [
    "pacotes",
    "portal da NF-e (com --download)",
    "Única entrada de XSD da NF-e: fixa os pacotes e gera o catálogo offline (docs/plataforma/NFE-SCHEMAS.md)",
  ],
  "scripts/fiscal/sync-nfse-schemas.py": [
    "pacotes",
    "portal da NFS-e nacional (com --download)",
    "Fixa os XSDs da NFS-e nacional e gera o catálogo (packages/fiscal-nfse/README.md)",
  ],
  "scripts/licenses/rights-relation.mjs": [
    "pacotes",
    "nenhum",
    "Relação de direitos de cada arquivo dos tarballs aceitos, depois de distribution:prove (docs/operacao/release.md)",
  ],
  "scripts/proofs/prove-export-batches.mjs": [
    "plataforma",
    "worktree",
    "Mede exportação em lotes no Convex local com dados sintéticos; grava .ci-results/125 (docs/plataforma/EXPORTS.md)",
  ],
  "scripts/proofs/prove-hosted-operations.mjs": [
    "plataforma",
    "validação persistente (escreve)",
    "Prova hospedada de operações e carga com dados sintéticos; recusa outro alvo (docs/desenvolvimento/ci.md)",
  ],
  "scripts/proofs/prove-hosted-rate-limits.mjs": [
    "plataforma",
    "produção sandbox elated-possum-295 (escreve)",
    "Contenção do rateLimiter com orçamentos sintéticos, removidos no fim; exige o SHA publicado (packages/convex-rate-limiter/README.md)",
  ],
  "scripts/proofs/prove-operations.mjs": [
    "plataforma",
    "worktree",
    "Workpool real e fonte HTTP loopback com bun run dev ativo (docs/plataforma/OPERATIONS.md)",
  ],
  "scripts/proofs/prove-usage-load.mjs": [
    "plataforma",
    "worktree",
    "Carga de consumo com 10 mil e 100 mil documentos sintéticos (docs/desenvolvimento/ci.md)",
  ],
  "scripts/proofs/prove-webhooks.mjs": [
    "plataforma",
    "worktree",
    "Webhooks com HTTPS real no Convex local; --sdk inclui os exemplos (docs/plataforma/WEBHOOKS.md)",
  ],
  "scripts/public-copy/scan-public-text.mjs": [
    "repositório",
    "nenhum",
    "Varre título e corpo de PR, issue, comentário e commit antes de publicar (AGENTS.md)",
  ],
  "scripts/selfhost.mjs": [
    "plataforma",
    "instalação própria",
    "CLI da instalação própria do operador (docs/operacao/instalacao-propria.md)",
  ],
  "scripts/sync-claude-skills.mjs": [
    "repositório",
    "local",
    "Regrava os atalhos de .claude/skills a partir de .agents/skills (.agents/README.md)",
  ],
  "scripts/validation/prove-smoke-diagnostics.mjs": [
    "plataforma",
    "local",
    "Ensaia o smoke e o registro de publicação com transporte controlado (docs/operacao/deploy-validacao.md)",
  ],
};

export function helpText() {
  const entry =
    (width) =>
    ([name, [app, environment, description]]) =>
      `${name.padEnd(width)}  ${app} · ${environment}\n${" ".repeat(width + 2)}${description}`;
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  const routineWidth = Math.max(...Object.keys(routines).map((path) => path.length));
  return [
    "Comandos da raiz (bun run <comando>): aplicação · ambiente",
    "",
    ...Object.entries(commands).map(entry(width)),
    "",
    "Roteiros pelo caminho (node ou bun <caminho>; o documento indicado diz como):",
    "",
    ...Object.entries(routines).map(entry(routineWidth)),
    "",
    "Testes por área: vp run test:<platform|packages|console|tooling|repository|benchmark>.",
    "Grafo do CI: vp run validate. Publicação de produção: só pelos workflows Deploy production",
    "e Deploy NFS-e fiscal production.",
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
