import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { areaCommand, testProjects, vitestProjects } from "./scripts/lib/test-projects.mjs";
import { DurationSequencer } from "./tests/setup/sequencer";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// `vp test run --changed` segue o grafo de imports (inclusive o
// import.meta.glob do convex-test). O que os testes leem do disco ou executam
// como processo fica fora do grafo: uma mudança nesses caminhos roda a suíte
// toda. Caminhos absolutos porque o `**` do padrão do Vitest não atravessa
// diretórios com ponto, como `.claude/worktrees/`.
const root = fileURLToPath(new URL("./", import.meta.url)).replaceAll("\\", "/");
const forceRerunTriggers = [
  "{package.json,bun.lock,vite.config.ts,tsconfig.json}",
  "{apps,packages}/*/{package.json,tsconfig.json}",
  "platform/{package.json,tsconfig.json}",
  "{tests/fixtures,tests/setup,patches,.github,deploy}/**",
  "packages/*/{fixtures,schemas}/**",
  "scripts/**/*.{mjs,js,json}",
].map((pattern) => `${root}${pattern}`);
// `exclude` de um projeto substitui o padrão do Vitest; preserva o node_modules.
const exclude = (...patterns: string[]) => ["**/node_modules/**", "**/.git/**", ...patterns];
// Limites de recurso vêm do ambiente para que vários agentes na mesma máquina
// possam dividir os núcleos (VITEST_MAX_WORKERS=2, por exemplo).
const maxWorkers = process.env.VITEST_MAX_WORKERS;
// Sob carga (vários agentes ou o Windows), convex-test e processos filhos
// passam dos 5 s padrão mesmo passando sozinhos. Nenhum teste mede tempo pelo
// timeout; ele só separa um teste travado de um lento.
const timeout = (fallback: number) =>
  Number(process.env.VITEST_TEST_TIMEOUT) ||
  (process.platform === "win32" ? Math.max(fallback, 30_000) : fallback);

export default defineConfig({
  plugins: [react()],
  test: {
    // console-query-cache.ts: o cache de consultas do console responde pelos
    // mocks de `convex/react` de cada teste, inclusive os da plataforma que
    // desenham telas do console.
    setupFiles: ["./tests/setup/offline.ts", "./tests/setup/console-query-cache.ts"],
    environment: "node",
    forceRerunTriggers,
    ...(maxWorkers
      ? { maxWorkers: maxWorkers.endsWith("%") ? maxWorkers : Number(maxWorkers) }
      : {}),
    // Nos testes, os pacotes fiscais do workspace resolvem pelo código-fonte:
    // nenhum `build-fiscal-packages` antes de testar e um único módulo por
    // pacote no processo (antes, a plataforma carregava o dist e os testes o
    // src). O dist continua provado no CI por ci:packages, ci:xml-prove e
    // ci:boundaries.
    alias: [
      {
        find: /^@freecorps\/fiscal-nfse\/(pure|danfse)$/,
        replacement: source("./packages/fiscal-nfse/src/$1.ts"),
      },
      ...["fiscal-core", "fiscal-nfe", "fiscal-nfse"].map((name) => ({
        find: new RegExp(`^@freecorps/${name}$`),
        replacement: source(`./packages/${name}/src/index.ts`),
      })),
    ],
    // Threads iniciam mais rápido e gastam menos CPU que processos; nenhum
    // teste muda cwd, sinais ou a saída do próprio processo (os que precisam
    // disso iniciam um processo filho).
    pool: "threads",
    // Uma fila só, dos arquivos mais longos aos mais curtos, em vez de projeto
    // por projeto (tests/setup/sequencer.ts).
    sequence: { sequencer: DurationSequencer },
    // Um projeto por área: cada agente roda só o que mudou (`vp run
    // test:<área>`), e o CI roda todos. Padrões, timeouts e a suíte do
    // relatório do CI vêm de scripts/lib/test-projects.mjs. Uma área `shared`
    // roda sem isolamento por arquivo, e os arquivos dela que usam vi.mock
    // ficam em `<área>-isolated`, com worker novo por arquivo.
    projects: vitestProjects().map((project) => ({
      extends: true,
      test: {
        name: project.name,
        include: project.include,
        ...(project.exclude ? { exclude: exclude(...project.exclude) } : {}),
        testTimeout: timeout(project.timeout),
        isolate: project.isolate,
        // terms-of-use.ts: nos testes da plataforma, nenhuma versão dos termos de uso vigora;
        // as suítes dos termos usam a própria (tests/setup/terms-of-use.ts).
        setupFiles: [
          ...(project.isolate ? [] : ["./tests/setup/file-isolation.ts"]),
          ...(project.area === "platform" ? ["./tests/setup/terms-of-use.ts"] : []),
        ],
      },
    })),
  },
  // Grafo de validação do CI (`vp run validate`): o job Validate o executa com
  // --no-cache, em execução limpa (docs/desenvolvimento/ci.md); `bun run ci:local` o
  // executa com cache. O Vite Task registra o que cada tarefa lê e escreve e só
  // reaproveita um resultado local enquanto nada do que ela leu mudou. Tarefas
  // que gravam recibo da revisão ou instalam num consumidor temporário nunca
  // usam cache. Ordem em docs/desenvolvimento/ci.md (O grafo `validate`) e tempos em Runners e custo.
  run: {
    tasks: {
      // Testes por área para o ciclo local (`vp run test:<área>`). O Vite Task
      // registra cada arquivo que a execução leu (código importado, fixtures e
      // o que os testes leem do disco) e repete o resultado aprovado enquanto
      // nenhum deles muda. O CI não usa este cache: ci:tests roda a suíte toda
      // sem cache.
      ...Object.fromEntries(
        testProjects.map(({ name }) => [
          `test:${name}`,
          {
            command: areaCommand(name),
            // O Vitest grava a ordem dos testes em node_modules/.vite/vitest.
            cache: {
              input: [{ auto: true }, "!node_modules/.vite/**", "!.ci-results/**"],
              output: [],
              untrackedEnv: ["VITEST_MAX_WORKERS", "VITEST_TEST_TIMEOUT"],
            },
          },
        ]),
      ),
      // dist dos pacotes fiscais, importado por SDK, Convex, console e tipos.
      // A própria saída não é entrada.
      "ci:packages": {
        command: "node scripts/build-fiscal-packages.mjs",
        cache: {
          input: [
            { auto: true },
            "!packages/fiscal-core/dist/**",
            "!packages/fiscal-nfe/dist/**",
            "!packages/fiscal-nfse/dist/**",
          ],
          output: [
            "packages/fiscal-core/dist/**",
            "packages/fiscal-nfe/dist/**",
            "packages/fiscal-nfse/dist/**",
          ],
        },
      },
      // Compila o SDK (packages/sdk/dist, incluído pelo tsconfig da raiz) e
      // prova o tarball num consumidor limpo. O que lê a árvore espera por ele,
      // como no job sequencial.
      "ci:sdk": {
        command: "bun run sdk:prove",
        dependsOn: ["ci:packages"],
        cache: false,
      },
      // CONTRACT_BASE é o commit da comparação de compatibilidade; o workflow
      // o define e ci:local/ci:prove passam o SHA resolvido de origin/main
      // (ou --base). A task isolada conserva o fallback HEAD^ do script.
      "ci:contracts": {
        command: "bun scripts/check-contracts-ci.mjs",
        dependsOn: ["ci:packages"],
        cache: { env: ["CONTRACT_BASE"] },
      },
      "ci:xml-prove": {
        command: "node scripts/prove-xml-package.mjs",
        dependsOn: ["ci:packages"],
        cache: false,
      },
      "ci:distribution": {
        command: "bun run contracts:build && bun run licenses:check && bun run distribution:prove",
        dependsOn: ["ci:sdk", "ci:xml-prove"],
        cache: false,
      },
      "ci:check": { command: "vp check", dependsOn: ["ci:packages", "ci:sdk"] },
      // Credenciais nos arquivos de texto versionados (scripts/check-secrets.mjs).
      // Lê a lista do git, que o Vite Task não rastreia como entrada.
      "ci:secrets": { command: "node scripts/check-secrets.mjs", cache: false },
      "ci:typecheck": {
        command: "node scripts/typecheck.mjs -p tsconfig.platform.json",
        dependsOn: ["ci:packages", "ci:sdk"],
      },
      // Usa .ci-results/revision.json de `node scripts/ci.mjs identity`. Os
      // testes resolvem os pacotes pelo código-fonte e não leem o SDK
      // compilado; esperam ci:packages só porque o teste de fronteiras inspeciona
      // o dist fiscal quando ele existe, e ci:packages o apaga e recria.
      "ci:tests": {
        command: "node scripts/ci.mjs test",
        dependsOn: ["ci:packages"],
        cache: false,
      },
      // O Miniflare regrava o cache de request.cf em node_modules/.mf.
      "ci:tooling": {
        command: "node .github/scripts/check-tooling.mjs",
        cache: { input: [{ auto: true }, "!node_modules/.mf/**"], output: [] },
      },
      // Documentação pública (apps/docs) compilada para apps/docs/dist, o
      // artefato que o build do console copia para /docs. Entradas automáticas:
      // conteúdo MDX, o OpenAPI de docs/v1.0 e a CSP de
      // apps/console/public/_headers, lida para conferir o hash do estilo
      // inline. O que o próprio build apaga e recria não é entrada.
      "ci:docs": {
        command: "node apps/docs/scripts/build.mjs",
        cache: {
          input: [
            { auto: true },
            "!apps/docs/build/**",
            "!apps/docs/dist/**",
            "!apps/docs/.react-router/**",
          ],
          output: ["apps/docs/dist/**"],
        },
      },
      // Compõe landing, painel e documentação. A origem pública muda canonical,
      // sitemap e headers da saída.
      "ci:console": {
        command: "node scripts/console.mjs package",
        dependsOn: ["ci:packages", "ci:sdk", "ci:docs"],
        cache: {
          input: [{ auto: true }, "!apps/console/.wrangler/**"],
          output: [{ auto: true }, "!apps/console/.wrangler/**"],
          env: ["PUBLIC_SITE_ORIGIN"],
          untrackedEnv: ["WRANGLER_SEND_METRICS"],
        },
      },
      "ci:auth-worker": {
        command: "node --experimental-strip-types scripts/prove-auth-worker.mjs",
        cache: false,
      },
      "ci:privacy-worker": {
        command: "node scripts/prove-privacy-mail-worker.mjs",
        cache: false,
      },
      validate: {
        command: "echo validate: ok",
        cache: false,
        dependsOn: [
          "ci:sdk",
          "ci:contracts",
          "ci:xml-prove",
          "ci:distribution",
          "ci:check",
          "ci:secrets",
          "ci:typecheck",
          "ci:tests",
          "ci:tooling",
          "ci:console",
          "ci:auth-worker",
          "ci:privacy-worker",
        ],
      },
    },
  },
  fmt: {
    // Código gerado e skills importadas preservam a formatação de origem; os atalhos de
    // .claude/skills copiam o frontmatter delas byte a byte (scripts/sync-claude-skills.mjs).
    // Os termos arquivados são os bytes que alguém aceitou, identificados por SHA-256: o
    // formatador não os toca.
    ignorePatterns: [
      "platform/convex/_generated/**",
      ".agents/**",
      ".claude/skills/**",
      "skills-lock.json",
      "docs/termos/arquivo/**",
    ],
  },
  lint: {
    ignorePatterns: ["platform/convex/_generated/**", "apps/console/public/developer/**"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      // Regras do AGENTS.md como verificação mecânica (docs/desenvolvimento/lint.md).
      { name: "freecorps", specifier: "./tooling/oxlint-plugin-freecorps/index.mjs" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "freecorps/no-float-fiscal-values": "error",
      "freecorps/require-suppression-reason": "error",
    },
    overrides: [
      // O núcleo fiscal é quem implementa a aritmética decimal exata.
      { files: ["packages/fiscal-core/**"], rules: { "freecorps/no-float-fiscal-values": "off" } },
      // Gerado pelo wrangler com `/* eslint-disable */`; fica no lint por causa dos tipos.
      {
        files: ["**/worker-configuration.d.ts"],
        rules: { "freecorps/require-suppression-reason": "off" },
      },
      {
        files: ["platform/convex/**/*.ts"],
        rules: { "freecorps/require-access-helper-in-convex-functions": "error" },
      },
      {
        files: ["**/*.test.{ts,tsx,mts,mjs,js}"],
        rules: { "freecorps/no-wall-clock-in-tests": "error" },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
});
