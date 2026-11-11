# CI

Referência do que o CI confere, de como reproduzi-lo localmente e de onde os
jobs rodam. A escolha dos checks durante o desenvolvimento está na seção
"Verificando" do [AGENTS.md](../../AGENTS.md#verificando). CI aprovado não
comprova autorização fiscal real, piloto humano nem aceite da release; a fila
de aceite fica na [matriz de aceite](../v1.0/ACCEPTANCE.md). Os registros de candidatos e
entregas da preparação da 1.0 estão no
histórico das entregas no CI.

## Workflows e gatilhos

`.github/workflows/ci.yml` executa em PRs, incluindo Draft, em push na `main`,
por `workflow_dispatch` e como workflow reutilizável. `deploy-validation.yml` e
`deploy-issuance-production.yml` o chamam, quando disparados manualmente na
`main`; `deploy.yml` não o chama nem espera por ele ([Produção sem nova validação](#produção-sem-nova-validação)). Não usa `pull_request_target` (só o check dos [termos de contribuição](#termos-de-contribuição) usa), environments com credenciais ou secrets
herdados. O token do job tem `contents: read`, `actions: read` e
`pull-requests: read`; os dois últimos servem só ao push na `main`, que procura
o run da PR mesclada e baixa o cache dela ([Cache do grafo](#cache-do-grafo)), e
o token só chega a esses passos. O repositório é público: as duas permissões
leem o que qualquer pessoa vê. Um workflow chamado não recebe mais que o
chamador concede, então `deploy-validation.yml` e
`deploy-issuance-production.yml` concedem as mesmas três ao job que chama o
CI. Checkout não persiste credenciais. Em PR, um push novo cancela a execução
anterior do mesmo PR; cada push na `main` tem grupo próprio e termina, para
salvar o cache que as PRs seguintes restauram.

Em PR, o checkout padrão é o merge sintético. `revision.json` registra
`checkedSha`, `headSha`, `baseSha`, tipo e estado Draft separadamente. O script
confere o commit realmente obtido por `git rev-parse HEAD` com `GITHUB_SHA`.
Não descrever o head como testado quando o runner executou outro commit.

`Validate` começa classificando a mudança (`scripts/ci/ci-changes.mjs`). Numa PR
que só muda documentação, confere formatação, credenciais e os testes que leem
toda a documentação e termina aprovado, sem `tested_sha`
([Mudança só de documentação](#mudança-só-de-documentação)). Nos demais casos,
instala pelo lockfile, executa o grafo `validate` (formatação, lint, tipos,
testes, provas de consumidor e empacotamento do console, sem publicar) e depois
`vp run ci:boundaries`. Somente após esses checks o job produz `tested_sha`. Em seguida, o passo `Require successful checks for
the same commit` recusa SHA diferente e produz `publication_sha` apenas para
`workflow_dispatch` de `deploy-validation.yml` na `main` do repositório
esperado. Até a #51 esse passo era o job `Validation publication gate`; como
só compara variáveis do ambiente, virou o último check de `Validate` e poupa
a cada execução o início de outro runner, o checkout e o setup. PR, fork, outra branch e os outros chamadores
não recebem esse output de validação. Em `workflow_call`, evento, ref e
`GITHUB_WORKFLOW_REF` são os do workflow chamador. Falha em qualquer check
impede o gate. `continue-on-error` aparece só nos passos que transferem o cache
(baixar o da PR mesclada, enviá-lo e salvá-lo), que não conferem nada: sem eles,
as tarefas executam. Output não é
credencial nem autoriza publicação sozinho: o chamador deve depender do
sucesso do workflow e publicar esse SHA.

A validação automática não publica serviços. A
[publicação de validação](../operacao/deploy-validacao.md) conecta o CI ao
deploy em um workflow com dependência explícita, checkout do `tested_sha` e
conferência do evento, repositório e SHA antes de escrever; a de produção
segue [deploy-producao.md](../operacao/deploy-producao.md). O push na `main`
executa o `ci.yml` só para repetir os resultados da PR mesclada e salvar o
cache; nada nele publica. Reexecuções manuais passam pelos mesmos checks e pela
conferência de elegibilidade.

### Produção sem nova validação

O `Validate` da PR é a validação da plataforma. O merge na `main` publica pelo
`deploy.yml` sem rodar o CI de novo nem esperar aprovação, como os outros
projetos da Freecorps: `Publish production` compila o commit e roda o smoke. Até 03/11/2026 o `deploy.yml` repetia o `Validate` no commit da
`main` e o publicador exigia `CI_TESTED_SHA` igual a ele; em outubro de 2026
essa repetição foi cerca de um terço do gasto de CI do projeto, e das oito vezes
em que reprovou, sete foram testes instáveis.

O ruleset da `main` não exige PR atualizada e aceita merge, squash e rebase.
O `Validate` da PR testa o merge sintético com a `main` do momento em que
rodou: se outra PR entrou depois, a combinação publicada não passou pelo CI
inteiro antes do deploy. A compilação e o smoke do publicador continuam
valendo para ela. Desde 04/11/2026 o `CI` roda também no push na `main`, ao lado
do deploy e sem bloqueá-lo: repete do cache o que a PR já aprovou e executa só
as tarefas cujas entradas a combinação mudou. Uma falha ali aparece depois da
publicação, como sinal para corrigir. A publicação de validação e a da produção
fiscal da emissão, ambas manuais, continuam validando o SHA que publicam, sem
cache.

## O grafo `validate`

O job instala as dependências uma vez e executa
`vp run --verbose --log grouped validate`, com o cache do Vite Task em PR e push
na `main` e com `--no-cache` nas execuções manuais e nas publicações que chamam
o CI ([Cache do grafo](#cache-do-grafo)). As tarefas ficam em `vite.config.ts`,
na chave `run.tasks`; o Vite Task as executa em ordem de dependência, até quatro
ao mesmo tempo, e agrupa a saída de cada uma no log, com um resumo no final que
diz, tarefa a tarefa, se executou ou repetiu um resultado e por quê.

| Tarefa              | Comando                                                                | Depende de                         | Cache               |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------------- | ------------------- |
| `ci:packages`       | `node scripts/build/build-fiscal-packages.mjs`                         |                                    | sim                 |
| `ci:sdk`            | `bun run sdk:prove`                                                    | `ci:packages`                      | não: registro e Git |
| `ci:contracts`      | `bun scripts/contracts/check-contracts-ci.mjs`                         | `ci:packages`                      | sim, lê o Git       |
| `ci:xml-prove`      | `node scripts/distribution/prove-xml-package.mjs`                      | `ci:packages`                      | não: registro       |
| `ci:distribution`   | `bun run licenses:check && bun run distribution:prove`                 | `ci:sdk`, `ci:xml-prove`           | não: registro e Git |
| `ci:check`          | `vp check`                                                             | `ci:packages`, `ci:sdk`            | sim                 |
| `ci:secrets`        | `node scripts/public-copy/check-secrets.mjs`                           |                                    | não: índice do Git  |
| `ci:knip`           | `bun run knip:check`                                                   |                                    | não: manifests      |
| `ci:typecheck`      | `node scripts/build/typecheck.mjs -p tsconfig.platform.json`           | `ci:packages`, `ci:sdk`            | sim                 |
| `ci:test:<área>`    | `node scripts/ci/ci.mjs test-area <área>`                              | `ci:packages`                      | sim                 |
| `ci:tests`          | `node scripts/ci/ci.mjs collect-tests`                                 | cada `ci:test:<área>`              | não: revisão        |
| `ci:tooling`        | `node .github/scripts/check-tooling.mjs`                               |                                    | sim                 |
| `ci:docs`           | `node apps/docs/scripts/build.mjs`                                     |                                    | sim, só local       |
| `ci:console`        | `node scripts/console/console.mjs package`                             | `ci:packages`, `ci:sdk`, `ci:docs` | sim                 |
| `ci:auth-worker`    | `node --experimental-strip-types scripts/proofs/prove-auth-worker.mjs` |                                    | não: Git            |
| `ci:privacy-worker` | `node scripts/proofs/prove-privacy-mail-worker.mjs`                    |                                    | sim                 |

As tarefas sem cache têm um motivo cada uma. `ci:sdk`, `ci:xml-prove` e
`ci:distribution` instalam os tarballs num consumidor limpo com dependências do
registro npm, que o Vite Task não registra como entrada, e as provas do SDK e da
distribuição carimbam no recibo o commit e o estado do checkout, lidos do Git;
`ci:auth-worker` também carimba. `ci:secrets` varre a lista do índice do Git: um
arquivo novo não estaria entre as entradas da execução anterior; `ci:knip`
lê os manifests e o `node_modules`, que também ficam fora das entradas. `ci:tests` lê
a revisão do checkout. Somadas, levam cerca de 15 a 20 s no runner, lado a lado
com as demais. `ci:contracts` usa cache com `CONTRACT_BASE` na chave e lê o
objeto da base pelo Git; o Vite Task não registrou nada dentro de `.git` nos
clones medidos, e a tarefa, de menos de 1 s, repete quando a base é a mesma.
`ci:docs` executa em todo run do CI: o build do React Router informa toda
variável de ambiente como entrada, e `GITHUB_RUN_ID` muda a cada run; a saída
é a mesma e `ci:console` continua repetindo. `ci:console` lê o Git só para carimbar o SHA em
`dist/build.json` e no bundle, que o CI nunca publica; `.git` fica fora das
entradas dela, e uma repetição traz o pacote carimbado com o SHA do run que o
compilou.

`bun run build` equivale a `ci:packages`, `ci:typecheck`, `ci:docs` e à
compilação do console. O que lê a árvore espera o SDK, porque os tsconfigs da
raiz incluem `packages/sdk/dist`. Os testes resolvem os pacotes pelo
código-fonte e não leem o SDK compilado; cada `ci:test:<área>` espera só
`ci:packages`, porque o teste de fronteiras inspeciona o `dist` fiscal quando
ele existe e `ci:packages` o apaga e recria.

### Cache do grafo

Em PR e push na `main`, o job restaura `node_modules/.vite/task-cache` depois do
`vp install`, como no [guia do Vite+](https://viteplus.dev/guide/github-actions-cache):
a chave é `vite-task-<OS>-<arquitetura>-<run>-<tentativa>`, com o prefixo
`vite-task-<OS>-<arquitetura>-` para restaurar a entrada mais recente que o ref
pode ler, a da própria PR ou a da `main`. O Vite Task registra os arquivos que
cada tarefa leu, as variáveis da chave e os argumentos, e só repete uma tarefa,
com a saída no log e os arquivos que ela gravou, quando tudo isso é igual ao de
uma execução aprovada. Uma execução que falhou nunca entra no cache. O resumo
do grafo diz, tarefa a tarefa, se executou ou repetiu e por quê
(`cache miss: 'arquivo' modified`).

O Vite Task registra também a listagem de cada pasta que a tarefa leu. O runner
começa de um checkout novo, sem o que a execução anterior criou: `dist` dos
pacotes e do console, `.react-router` e `build` da documentação, `.wrangler`,
os caches em `node_modules` e as entradas de `.browser-results`. Com essas
listagens nas entradas, nenhuma tarefa repetia num clone novo, embora a segunda
execução no mesmo checkout repetisse todas. Por isso a constante `generated` de
`vite.config.ts`, usada por toda tarefa com cache, tira das entradas as
listagens dessas pastas e os caches das ferramentas; o conteúdo de cada arquivo
lido nelas continua entrada. A raiz não pode sair assim (`!.` exclui a árvore
inteira), e `node scripts/ci/ci.mjs identity` cria `.browser-results` antes do
grafo.

Medido em clones novos no mesmo caminho, um por execução, como no runner
(Windows local, dois workers por área, 04/11/2026): o grafo da `main` sem cache
levou 158 s; a PR que muda um arquivo do console, com o cache da `main`, 106 s,
executando só o que lê o arquivo; o push do commit squash, com o cache da PR,
30 a 34 s, executando só as tarefas sem cache e `ci:docs`. O grafo antigo,
com a suíte numa tarefa só e sem cache, levou 362 s no mesmo clone. O efeito no
Actions ainda não foi visto.

Cada área de testes de `scripts/lib/test-projects.mjs` é uma tarefa
`ci:test:<área>`, que roda os projetos do Vitest dela e grava o recibo
`.ci-results/tests/<área>.json` (resultado, contagens e o run e o commit em que
os testes de fato rodaram). O recibo é a saída guardada no cache: uma repetição
o restaura para as mesmas entradas. Ele não lê `revision.json`, que muda a cada
commit. `ci:tests` junta os recibos em `tests.json`, sob a revisão do checkout,
e reprova se uma área falta, falhou ou contou outro número de arquivos que os
dela no checkout. Com `CI=true`, a área reprova também quando pulou mais
testes que o teto de `pendingBudget` em `scripts/lib/ci.mjs`, que registra o
motivo de cada pendente aceito; área fora da lista aceita zero. Um `skipIf` ou
`runIf` novo que pula no runner Linux entra nessa lista com o motivo, ou não
aprova. Fora do CI o teto não vale: no Windows ou sem o `age`, outros testes
ficam pendentes de propósito. `node scripts/ci/ci.mjs identity` apaga os recibos antes do
grafo, e o passo `approve` só emite `tested_sha` com todas as áreas aprovadas
nesse `tests.json`. O resumo do job mostra, por área, se ela executou neste
checkout ou repetiu o resultado de qual run.

O push na `main` não lê o cache do Actions de uma PR, que o GitHub restringe ao
ref dela. Por isso o run de cada PR, quando aprovado, envia o diretório do cache
como artifact `vite-task-cache` (7 dias), e o push procura a PR mesclada pelo
commit (`GET /repos/{repo}/commits/{sha}/pulls`, com `merge_commit_sha` igual ao
SHA), o run aprovado mais recente do `ci.yml` na ponta final dela e o artifact
desse run (`scripts/lib/ci-task-cache.mjs`). Só vale um run deste repositório:
uma PR de fork executa o próprio código e grava o artifact que quiser, então o
dela nunca é usado. Achado o artifact, ele substitui o diretório inteiro do
cache restaurado da `main`; nenhum desses passos reprova o job. Depois do grafo,
o push salva o cache para as próximas PRs. A PR também salva o seu, até depois
de uma falha, para que uma nova tentativa repita o que passou; num fork, o
token do cache é só de leitura e o passo apenas avisa.

O artifact é gerado pelo código da PR, inclusive `vite.config.ts` e os scripts,
e o que ele restaura chega ao cache da `main`. Aceitá-lo equivale a confiar no
código revisado que a PR mesclou. As publicações manuais não leem cache nenhum.

Execuções manuais do `ci.yml` e as chamadas por `workflow_call` (publicação de
validação e da produção fiscal da emissão) rodam o grafo com `--no-cache`, sem
restaurar nem salvar: toda tarefa executa, como antes de 04/11/2026. Para uma
execução limpa de uma revisão, dispare o CI manualmente.

### Mudança só de documentação

`scripts/lib/ci-changes.mjs` compara o merge sintético da PR com o primeiro pai
(a base). Se todo arquivo mudado é documentação que só a formatação e a
varredura leem, o job instala as dependências, roda `vp fmt --check`,
`node scripts/public-copy/check-secrets.mjs` e os testes que leem toda a documentação
versionada (`scripts/public-copy/public-identifiers.test.ts`,
`scripts/public-copy/public-tree.test.ts`, `scripts/repo/adr-status.test.ts` e
`scripts/repo/doc-links.test.ts`)
e termina aprovado, sem executar o grafo nem
emitir `tested_sha`. O check obrigatório continua sendo o mesmo `Validate`:
`paths-ignore` deixaria o check ausente.

Documentação, aqui, é `*.md` da raiz, `docs/**/*.md`, `.agents/**/*.md` e
`.claude/**/*.md`, menos o que um teste ou build consome: `README.md`,
`AGENTS.md`, `CONTRIBUTING.md`, `docs/worktrees.md`,
`docs/operacao/deploy-producao.md` e os `docs/operacao/*-email.md` (comandos
citados), `CONTRIBUICOES.md` (frase de aceite), `LICENSING.md` e
`docs/licenses/**`, `docs/v1.0/**` (contrato REST gerado, evidências e matriz
de aceite), `docs/termos/**` (termos arquivados), os `SKILL.md` de
`.agents/skills/`, os Markdown da raiz dessa pasta e `.claude/skills/**`. A lista
saiu das entradas que o Vite Task registrou para cada tarefa do grafo (em
03/11/2026); `tests/ci.changes.test.ts` recusa um
caminho de documentação citado entre aspas no código-fonte fora das menções
conhecidas. Apagar ou renomear um arquivo roda o grafo, porque
`tests/fixtureCorpus.test.ts` confere a existência das evidências citadas em
`tests/coverage-matrix.json`. Se o diff não puder ser resolvido, o grafo roda.

O risco que sobra é um teste ou script passar a ler um desses arquivos por um
caminho calculado, que o teste não vê. O push na `main` roda o grafo depois do
merge e executaria esse teste ali. Depois do grafo, o job executa
`vp run ci:boundaries`, que inspeciona o `dist` dos pacotes fiscais, e só então
aprova o SHA.

`ci:docs` compila a documentação pública em `apps/docs/dist`, e `ci:console`
só a copia para a saída do console; uma falha da documentação aparece na
própria tarefa ([PUBLIC.md](../plataforma/PUBLIC.md#fontes-e-construção)).
`scripts/console/console.mjs` executa `scripts/console/prove-public-site.mjs` depois do build:
landing e páginas da documentação legíveis sem JavaScript, sem script ou estilo
inline, referências locais existentes e nenhum chunk das telas de
desenvolvimento (`apps/console/src/dev/`) no bundle.
`tests/publicSite.test.ts` confere os links e o contrato da documentação
pública, além do opt-in de indexação.

### Tipos

`tsconfig.platform.json` estende o `tsconfig.json` da raiz e confere a
plataforma, os pacotes, `tests/` inteiro e os scripts. A raiz inclui a
mesma árvore porque o editor e o lint type-aware de `vp check` precisam de um
projeto que contenha cada arquivo; nenhum comando confere os tipos por ela.
Até a #345, um `tsconfig.legacy.json` conferia o backoffice de `src/`, o motor
de `convex/` e seus testes, e o grafo tinha as tarefas `ci:legacy-*` e
`validate:legacy`; esse código saiu do repositório, e os helpers de
`platform/convex/lib/` que ele reutilizava (`apiKeyCrypto.ts`, `webhookUrl.ts`
e `publicAddress.ts`) passaram a ter só a plataforma como consumidora.

As checagens de tipos usam o TypeScript 7, o compilador nativo, instalado como
`typescript-7` (`scripts/build/typecheck.mjs`). O pacote `typescript` continua no 6.0
para o editor, as builds que emitem código e a prova do consumidor do SDK.

O `check` dos workspaces encaminha ao mesmo verificador. Em `platform/` e
`packages/contracts/` ele confere o projeto inteiro de `tsconfig.platform.json`,
que contém os dois; `contracts` não tem projeto próprio. Em `apps/console/`
confere `apps/console/tsconfig.json`. Os três compilam antes os pacotes
fiscais, cujos tipos são lidos de `dist/`, e não chamam `platform:check`.
`xml:check` e o `check` de `fiscal-nfe` e `fiscal-nfse` ficam no TypeScript
6.0: conferem o `tsconfig.json` de cada pacote, o mesmo que a build emite
com o 6.0.

## Testes

`scripts/lib/test-projects.mjs` divide a suíte em projetos do Vitest por área,
que `vite.config.ts` monta com as tarefas `test:<área>` do ciclo local e
`ci:test:<área>` do grafo. No CI, cada área roda com três workers e timeout de
60 s por teste, e só quando alguma entrada dela mudou
([Cache do grafo](#cache-do-grafo)); os projetos dão a cada área o seu timeout
local. `bun run ci:test` ainda roda a suíte inteira num processo só.

| Projeto             | Arquivos                                                  | Timeout |
| ------------------- | --------------------------------------------------------- | ------- |
| `platform`          | `platform/`, Workers de `apps/console/`, dois de `tests/` | 20 s    |
| `platform-isolated` | Os arquivos de `platform` que usam `vi.mock`              | 20 s    |
| `packages`          | `packages/`                                               | 20 s    |
| `console`           | `apps/*/src/` (jsdom por arquivo)                         | 20 s    |
| `tooling`           | `scripts/`, `tooling/`, worktree, validação, CI e corpus  | 60 s    |
| `repository`        | Os quatro testes que leem a árvore inteira                | 60 s    |
| `benchmark`         | `*.benchmark.test.ts` de `platform/` e `tests/`           | 120 s   |

Cada teste fica ao lado do código que exercita: os da plataforma em
`platform/convex/` (com `lib/` e `testing/`), os dos Workers do console em
`apps/console/`, os dos pacotes na raiz de cada pacote e os de scripts em
`scripts/<domínio>/`. Em `tests/` ficam só os transversais (`ci.*`,
`worktree*`, `validation*`, os corpus de fixtures e `publicSite`), com
`helpers/`, `setup/`, `fixtures/` e `coverage-matrix.json`. Os testes ao lado
dos módulos do Convex carregam a pasta por `tests/helpers/convex-modules.ts`,
que tira os `*.test.ts` da lista; o Convex não publica arquivo com mais de um
ponto no nome, e `platform/convex/tsconfig.json` deixa os testes fora do
typecheck do deploy. Nenhum projeto recolhe o restante: um arquivo novo sem
projeto reprova `tests/ci.testProjects.test.ts`.

`repository` reúne os testes cujas entradas são quase todo o repositório:
`scripts/public-copy/public-identifiers.test.ts` (todo Markdown), `scripts/public-copy/public-tree.test.ts`
(a lista do Git, para classificar cada arquivo da cópia pública),
`scripts/repo/adr-status.test.ts` (todo Markdown, atrás de status de ADR fora
do cabeçalho dela), `scripts/repo/doc-links.test.ts` (todo Markdown, atrás de
link relativo para arquivo ou âncora que não existe) e
`tests/ci.changes.test.ts` (todo código-fonte, atrás de caminhos de
documentação). Juntos levam poucos segundos e executam em toda mudança. Dentro
de `tooling`, cerca de 95 s localmente, eles faziam a área inteira executar a
cada arquivo alterado do console ou da plataforma; separados, `tooling` repete
o resultado enquanto não muda o que ela lê.

Todos usam o pool `threads`, que inicia mais rápido e gasta menos CPU que
processos. Os testes que precisam de sinais ou de `process.exit` os
exercitam num processo filho.

O projeto `platform` roda sem isolamento por arquivo (`shared` em
`test-projects.mjs`). Com isolamento, cada arquivo ganhava um worker novo e
o primeiro teste de cada um carregava de novo o grafo de `platform/convex`,
Better Auth e os componentes, 5 a 7 s dentro do timeout do teste. Sem ele, o
grafo carrega uma vez por worker. `tests/setup/file-isolation.ts` devolve ao
arquivo seguinte o worker como um worker novo o receberia: timers reais,
nenhum timer pendente do arquivo anterior, `process.env` original, globais
de `vi.stubGlobal` desfeitos e spies originais. Uma atribuição direta em
`globalThis` fica, porque apagá-la quebraria um módulo já carregado que a fez
ao ser importado. `tests/ci.fileIsolation.test.ts` prova isso com dois arquivos num
worker, que falham sem o setup. `vi.mock` não substitui um módulo que outro
arquivo do worker já carregou, então os arquivos que mocam, direto ou por um
helper de `tests/`, vão para `platform-isolated`, com worker novo por
arquivo. A lista vem da leitura dos arquivos e não precisa de manutenção.
`vp run test:platform` e o `test` de `platform/` rodam os dois projetos;
`--project platform` sozinho deixa os isolados de fora.

Com três workers, como no CI, a área `platform` cai de 32,0 s para 21,9 s
(mediana de três pares intercalados), e o primeiro teste de cada arquivo de 5
a 7 s para menos de 2 s. Na suíte toda, o ganho fica dentro do ruído da
máquina (101,7 s contra 98,3 s), porque o tempo dela é o trabalho somado de
todas as áreas dividido pelos workers. Quatro seeds de `--sequence.shuffle`
(1234, 11, 4242 e 777777) passam sem isolamento.

`tests/setup/sequencer.ts`
mantém uma fila só, dos arquivos mais longos aos mais curtos, porque o
sequenciador padrão ordena projeto a projeto e o mais lento do último projeto
alongava a suíte. O timeout só separa um teste travado de um lento. No CI, o
limite é de 60 s, ou o do projeto quando ele pede mais, como os 120 s do
`benchmark`: a opção de linha de comando sobrepõe o limite de cada projeto.
`VITEST_MAX_WORKERS` e `VITEST_TEST_TIMEOUT` ajustam os dois limites sem mudar
o resultado.

A mesma lista dá a cada projeto a suíte do relatório do CI (`platform` ou
`infrastructure`); `scripts/lib/ci.mjs` classifica cada arquivo
pelo projeto que o contém e recusa um arquivo sem projeto ou em dois.
`tests/ci.testProjects.test.ts` exige que cada arquivo de teste pertença a um
único projeto.

Nos testes, `@freecorps/fiscal-core`, `fiscal-nfe` e `fiscal-nfse` resolvem
para `src/` por alias. Nenhum build precede os testes, e o processo carrega um
módulo por pacote. O `dist` continua provado por `ci:packages`,
`ci:xml-prove` e `ci:boundaries`.

Localmente, cada projeto tem a tarefa `vp run test:<área>`. O Vite Task
registra os arquivos que a execução leu, inclusive fixtures lidas por
`node:fs` e arquivos lidos nas threads, e repete o resultado aprovado enquanto
nenhum deles muda; falhas não ficam no cache. `bun run test:changed` usa
`vp test run --changed origin/main`, que segue o grafo de imports, inclusive o
`import.meta.glob` do convex-test. Mudanças em fixtures, configuração,
scripts `.mjs`, `deploy/` e workflows rodam a suíte toda
(`forceRerunTriggers`, com caminhos absolutos porque o `**` do Vitest não
atravessa `.claude/worktrees/`).

### Rodar e escrever testes

Durante o desenvolvimento, rode só a área alterada:

| Comando                 | O que roda                                                 |
| ----------------------- | ---------------------------------------------------------- |
| `vp run test:<área>`    | Um projeto; repete o resultado aprovado se nada lido mudou |
| `bun run platform:test` | `test:platform` e `test:packages`                          |
| `test` de um workspace  | Só aquele workspace; em `platform/`, a área `platform`     |
| `bun run test:changed`  | Só os testes alcançados pelas mudanças desde `origin/main` |
| `vp test run <arquivo>` | Um arquivo, sem cache                                      |
| `vp test run`           | A suíte toda, sem cache                                    |

Com vários agentes na mesma máquina, `VITEST_MAX_WORKERS=2` (ou `50%`) divide
os núcleos e `VITEST_TEST_TIMEOUT` amplia o limite por teste.

Os testes importam de `vite-plus/test`. Um caminho novo de teste entra num
único projeto em `scripts/lib/test-projects.mjs`, que define também a suíte do
relatório do CI. A integração da plataforma fica em
`platform/convex/<módulo>.test.ts`, ao lado do módulo, com o schema de
`platform/convex`, os módulos de `tests/helpers/convex-modules.ts` e os
componentes registrados por `platform/test-setup.ts`; sessões Better Auth são
simuladas com `t.withIdentity`. Parsing e validação de NF-e têm testes em
`packages/fiscal-nfe` (`bun run xml:test`), e a montagem e a assinatura da DPS
NFS-e em `packages/fiscal-nfse` (`bun run nfse:test`). Nenhum desses testes
comprova autorização ou emissão homologada.

Os testes de cifra do arquivo frio, do backup incremental e do recibo selado
cifram e decifram com o `age` real, achado por `hasAge` de
`tests/helpers/age.ts` (`AGE_BIN` e `AGE_KEYGEN_BIN`, ou o PATH). Sem os dois
binários eles ficam pendentes numa máquina local; com `CI=true`, o arquivo
reprova. O `validate` instala no PATH a mesma versão e o mesmo checksum do
`offsite-backup.yml`, porque a tarefa de testes do Vite Task não recebe
`AGE_BIN`, e `tests/ci.age.test.ts` confere o passo.

`platform/convex/publicSurface.test.ts` varre a superfície pública do Convex:
descobre toda query, mutation e action pública de `platform/convex`, inclusive
de módulos novos, gera argumentos válidos pelo validador com IDs forjados e
chama cada função diretamente, sem sessão. Só `access:session` e
`account:capabilities` respondem sem sessão, com o valor declarado no teste;
qualquer outra resposta ou recusa fora de `UNAUTHENTICATED`, `ACCESS_DENIED`
e `NOT_FOUND` reprova o CI. Funções que carregam o registro antes de checar a
sessão recusam o ID forjado com `NOT_FOUND`; papéis, membership e dados reais
de outra organização continuam cobertos pelos testes de cada domínio.

### Isolamento

`convex-test` cria bancos em memória por instância. Casos de filesystem usam
diretórios temporários exclusivos. Os testes de request que não exercitam o
motor fiscal usam timers falsos e descartam agendamentos ao terminar.
Certificados descartáveis são gerados em memória; não há A1 real no CI.

Regras para um teste novo, das falhas que suítes parecidas já tiveram:

- **Nada de estado para trás.** Env com `vi.stubEnv` e `vi.unstubAllEnvs`
  (`usePlatformEnvironment` faz isso), timers falsos desfeitos no
  `afterEach`, nenhum estado mutável no topo de um helper compartilhado: no
  projeto `platform`, o topo de um módulo roda uma vez por worker, não por
  arquivo. O setup de isolamento é a rede, não o contrato.
- **Mock de módulo isola o arquivo.** Um `vi.mock` leva o arquivo para
  `platform-isolated`, mais lento. Prefira injetar o transporte ou usar
  `vi.spyOn`.
- **Relógio fixo para dia, semana e mês.** Um teste que grava num balde de
  dia e relê pelo relógio real falha perto da meia-noite, ainda mais quando
  `vi.runAllTimers()` adianta o relógio falso por timeouts de minutos. Fixe o
  instante longe de viradas (`now` de `usePlatformEnvironment` ou
  `vi.setSystemTime`). A suíte de `platform`, `console` e `packages`
  passou com o relógio deslocado para 23:59 de São Paulo, fim de mês e fim de
  ano. `freecorps/no-wall-clock-in-tests` reprova `Date.now()`,
  `performance.now()`, `new Date()` e timers reais num arquivo sem relógio
  falso, e loop de polling em qualquer teste
  ([lint.md](lint.md#no-wall-clock-in-tests)).
- **Bytes grandes por hash ou primeira diferença.** `toEqual` em dois
  `Uint8Array` de megabytes compara elemento por elemento e leva segundos;
  compare um hash ou o primeiro índice que difere.
- **Rode a área inteira.** `vp run test:platform`, não `--project platform`.

`tests/setup/offline.ts` bloqueia `fetch`, `http.request/get` e
`https.request/get` sem mock explícito. Mesmo quando o código captura a falha,
o teardown reprova o caso. Isso detecta chamadas acidentais nos transportes
usados pelo projeto; **não é uma sandbox de rede para código hostil**, DNS
direto, sockets próprios ou subprocessos. PRs externos não recebem credenciais
de deploy, certificados ou dados de clientes. Não usar snapshots da validação
persistente em testes destrutivos ou no CI comum.

Testes e builds recebem uma lista explícita de variáveis de runtime em
`scripts/lib/subprocess-environment.mjs`: caminhos do sistema, diretórios
locais, locale, terminal e controles de CI. Nomes desconhecidos, inclusive
`ACTIONS_RUNTIME_TOKEN`, tokens de publicação e credenciais personalizadas,
não são herdados. A comparação dos nomes preserva `Path`/`SystemRoot` no
Windows. Metadados de evento necessários ao publicador são adicionados
separadamente; não há liberação genérica de `GITHUB_*` ou `ACTIONS_*`. O
filtro reduz a exposição de credenciais nos subprocessos; não isola arquivos,
sockets ou executáveis hostis.

## Checks de fronteiras e contratos

- Grafo de pacotes com classificação de puro, conector Node e ferramenta de
  desenvolvimento. Novo workspace não classificado falha; pacotes fiscais
  independentes não importam a plataforma, Convex, autenticação, frontend ou
  runtime Cloudflare.
- Instalação limpa do artefato e execução do consumidor sem conta,
  configuração ou dependências SaaS, incluindo o verificador de webhook do SDK
  (`ci:sdk`) e os pacotes fiscais (`ci:xml-prove`).
- Origem canônica dos contratos com geração/verificação determinística de
  OpenAPI, SDK e referência de documentação. `scripts/contracts/contract-drift.test.ts`
  roda essa prova em toda execução do CI: altera as rotas que a geração lê
  (escopo de uma rota existente e rota nova), exige que a mesma comparação de
  `contracts:check` aponte OpenAPI, referência REST e cópia pública como
  desatualizados e aceite os artefatos regenerados numa pasta temporária.
  Também recusa cópia pública editada à mão ou ausente. Nenhum arquivo do
  checkout é alterado; `scripts/contracts/prove-contract-drift.mjs` continua como prova
  manual do comando completo.
- Corpus compartilhado com versão, hash, procedência e resultado esperado por
  etapa ([corpus versionado](../../tests/fixtures/fiscal-v1/README.md), com
  bytes sintéticos). Cobertura do corpus e licença para distribuição são
  verificações distintas.

### Fronteiras dos pacotes independentes

`vp run ci:boundaries` descobre os workspaces do `package.json` e exige uma
entrada para cada um em `scripts/build/package-boundaries.json`. Classificação
ausente, inválida ou sem workspace correspondente reprova a execução. Os
padrões aceitos são caminhos relativos com `*` e `**`; sintaxes não suportadas
são recusadas. O CI executa esse check depois do grafo `validate`, que compila
os pacotes fiscais, e antes da aprovação do SHA.

As classes são `pure`, `node` e `platform`. Pacotes independentes declaram
explicitamente os workspaces e dependências externas permitidos. Um pacote
puro não pode importar um conector Node; nenhum dos dois pode alcançar a
plataforma. `fiscal-core` é puro; `contracts` é puro e reutiliza seu CNPJ.
`convex-rate-limiter`, componente Convex da plataforma, fica na classe
`platform`.
`fiscal-nfe` é uma biblioteca Node independente: depende de core e dos
validadores XML explicitamente permitidos no manifesto. Não depende dos
contratos do SaaS. `fiscal-nfse` segue o mesmo desenho, com core, xmldom,
xml-crypto, libxml2-wasm, pdf-lib e qrcode. A classificação Node permite
criptografia nativa, sem permitir dependências da plataforma ou configuração
ambiente implícita. `platform`, `apps/console` e `apps/docs` pertencem à
plataforma.

Um subpath de `exports` pode ter classificação própria em `entryPoints`, mais
estreita que a do workspace, nunca mais larga: tipo `pure` ou `node` e listas
de workspaces e dependências externas contidas nas do pacote. O export
`./pure` de `fiscal-nfse`, importado pelas funções Convex de emissão, é
`pure`, só com `fiscal-core`. O verificador parte do arquivo compilado, se
existir, e da fonte que `outDir`/`rootDir` do tsconfig do pacote associam a
ele, e segue os imports relativos, inclusive de tipo, com as regras do ponto
de entrada. Um `node:` ou uma dependência fora da lista alcançável a partir de
`./pure` reprova, com a cadeia
`packages/fiscal-nfse/package.json [exports ./pure] -> src/pure.ts -> ...`.
Subpath classificado ausente dos `exports` ou sem implementação também
reprova. Por isso os tipos do transporte ficam em `src/http.ts` e a política de
assinatura em `src/targets.ts`: a PTAX e os alvos importam só tipos, sem
alcançar `node:zlib` ou xml-crypto.

O verificador percorre `dependencies`, `optionalDependencies` e
`peerDependencies`, inclusive a árvore externa instalada. Recusa Convex,
Better Auth/Clerk, React e Cloudflare, inclusive aliases npm cujo nome real
seja proibido. Dependências opcionais de terceiros ausentes neste sistema
operacional são verificadas por nome; sua árvore ausente não é inspecionada.
A classificação Node/puro é aplicada ao código próprio; o check não certifica
compatibilidade de runtime de todo o código de terceiros.

O parser do TypeScript lê imports/reexports, tipos, imports dinâmicos literais,
`require` e referências de declarations. O resolvedor segue `tsconfig.json`,
inclusive `extends`/`paths`, e caminhos relativos. O percurso entre workspaces
informa a cadeia de origem até a violação. Imports calculados ou não resolvidos
reprovam. Aliases exclusivos de bundlers não são executados: devem ser
resolvíveis também pelo TypeScript para passar.

Imports sem extensão incluem os candidatos de implementação e `index`, mesmo
quando um `.d.ts` existe ao lado do JavaScript. Workspaces aninhados usam o
dono mais específico; conter uma subpasta não cria uma dependência por si só.
`module`/`node:module` são recusados, inclusive em conectores Node, pois suas
fábricas como `createRequire` criam loaders que o analisador não acompanha.
Também são recusados aliases de `require`, `module.require`, acessos
calculados a runtimes, aliases dos objetos globais e acesso ambiente por
`process`, `Bun`, `Deno` e `import.meta.env`. Use imports ou `require`
literais nos pacotes independentes; configuração necessária chega por
argumentos explícitos.

Testes, fixtures e configurações de ferramentas ficam fora das raízes de
runtime, assim como `devDependencies`. Se código de runtime importar esses
arquivos, eles passam a ser inspecionados. Entradas públicas e arquivos de
tipos existentes declarados por `exports`/`main`/`module`/`types`/`bin` também
são verificados, inclusive em `dist`; por isso o build precede o check no CI.
Isso verifica dependências estáticas, não constitui sandbox contra execução
arbitrária ou carregadores próprios construídos em runtime.

`scripts/build/package-boundaries.test.ts` cria repositórios sintéticos isolados e
prova recusa de import direto, reexport/tipos, alias, caminho relativo,
dependência transitiva e pacote sem classificação. Para pontos de entrada,
prova `node:fs` importado direto, por módulo relativo e por import de tipo a
partir de um `./pure`, dependência e workspace fora da lista do ponto de
entrada, `dist` compilado e classificação ausente dos exports ou mais larga
que a do workspace. Remover a violação faz passar.

`scripts/distribution/prove-xml-package.mjs` (`vp run xml:prove`) empacota fiscal-core,
fiscal-nfe e fiscal-nfse, inspeciona cada tarball e os instala num diretório
limpo fora do monorepo. Para fiscal-nfse, `scripts/lib/nfse-consumer.mjs`
importa `.`, `./pure` e `./danfse` do pacote instalado: monta uma DPS
sintética e a confere no XSD embutido, recusa um `cTribNac` inválido, assina
com uma chave RSA gerada em memória e verifica a assinatura, resolve a rota e
gera um DANFSe com a marca de simulado. O recibo fica em
`.ci-results/nfse/independent.json`. Localmente, a prova exige npm junto do
Node. Nada disso prova autorização fiscal.

### Distribuição

`ci:distribution` roda depois dos consumidores SDK/XML, confere inventário
contra o lock e avisos de runtime e inspeciona os cinco tarballs finais:
contracts, fiscal-core, fiscal-nfe, fiscal-nfse e SDK. Antes, `contracts:build`
grava o pacote de contracts em `packages/contracts/dist`. O consumidor limpo
exercita NF-e, NFS-e, SDK e os seis exports de contracts pelos mesmos bytes
inspecionados, e confere os tipos de contracts e do SDK com resolução NodeNext.
Em contracts, só os quatro arquivos do escopo MIT podem ter o cabeçalho MIT, e
`LICENSE-MIT` precisa acompanhá-los. Em fiscal-nfe e fiscal-nfse, o
catálogo `dist/schemas.json` precisa corresponder arquivo a arquivo aos hashes
`runtimeUtf8Sha256` do `schemas/manifest.json` do próprio tarball; em fiscal-nfse,
sob CC BY-ND, esses hashes precisam ser os dos originais.
`scripts/distribution/distribution.test.ts` cobre arquivos proibidos, credencial incorporada,
aviso ausente, export quebrado, catálogo sem manifesto ou fora dos hashes,
pacote aceito fora da versão ou do acesso público e contracts sem `private`. O recibo em `.ci-results/83/tarballs.json`
contém lista, hashes, identidade e schemas incorporados. Sucesso desse check
valida os bytes; a publicação vale só para os hashes aceitos na #83
([release.md](../operacao/release.md)). `scripts/deploy/platform-release.test.ts` recusa destinos, SHA,
registro de instalação incompleto ou alterado, candidato obsoleto, sonda
alterada e smoke incompleto, com precondições próprias de bootstrap e release, e
confere a atualização automática da `main` e o
bootstrap exclusivamente manual.

Os testes que conferem workflows (`deploy.yml`, `deploy-validation.yml` e a
posição de `ci:boundaries` em `ci.yml`) leem o YAML com o pacote `yaml` e
comparam gatilhos, jobs, passos e expressões sem `${{ }}` nem espaços.
Reformatar o arquivo não os quebra; remover o gate de SHA, a etapa obrigatória
ou a restrição de publicação, sim. Ausências, como `CLERK`, continuam
conferidas no texto inteiro. `tests/ci.changes.test.ts` confere no `ci.yml` que
aprovação, gate, grafo e fronteiras rodam sob a mesma condição, que o modo de
documentação não emite SHA, a chave do cache e que o token só chega aos passos
do push. `tests/ci.testProjects.test.ts` executa `scripts/ci/ci.mjs test-area` de
cada área com o Vitest substituído e confere que, juntas, elas rodam cada
projeto do Vitest uma vez, sem arquivo, `--changed` ou `--shard`, e que
`scripts/ci/ci.mjs test` roda a suíte toda.

### Arquivos e dependências sem uso

`ci:knip` (`bun run knip:check`) roda o knip com `--include files,dependencies`
sobre os workspaces do `package.json`, com a configuração de `knip.jsonc`.
Reprova arquivo que nenhuma entrada alcança e dependência declarada num
manifest sem import no workspace. A checagem de `exports` fica de fora.

O knip lê os comandos do `package.json` e dos workflows e as configurações das
ferramentas que reconhece. O que ele não enxerga entra em `knip.jsonc` com o
motivo: os comandos das tarefas de `vite.config.ts`, os consumidores de
`scripts/lib/*-consumer.mjs` que as provas de distribuição copiam e executam,
as fixtures que os testes de CI leem pelo caminho, os exemplos de
`apps/console/public/developer/`, servidos como arquivo estático, e as
dependências carregadas sem import (`oxfmt`, `oxlint` e `oxlint-tsgolint`, na
versão que o Vite+ exige, e `contracts` e `zod` do SDK, empacotados por caminho
relativo).

Um helper órfão de `platform/convex/lib/` não aparece: o plugin Convex do knip
toma `convex/**` como entrada, porque o Convex publica todo módulo da pasta, e
os testes da plataforma carregam a pasta inteira por `import.meta.glob`.

Quando a tarefa reprova, remova o arquivo ou a dependência órfã. Se o uso for
real e o knip não o enxergar, declare a entrada em `knip.jsonc` com o motivo,
em vez de ignorar o achado.

Todo script de `scripts/` e de `scripts/<domínio>/` é entrada do knip, porque
cada um é chamado pelo caminho. Um roteiro que nenhum comando, workflow ou
documento cita não aparece como órfão.

### Organização de `scripts/`

Cada script fica na pasta do seu domínio, com o teste ao lado. Os helpers que
mais de um domínio usa ficam em `scripts/lib/`.

| Pasta           | Conteúdo                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| `backup/`       | Backup offsite, exportação incremental, custódia e provas de restauração        |
| `billing/`      | Conferência da conta Stripe e estado da migração de uso                         |
| `build/`        | Build dos pacotes fiscais, typecheck e fronteiras entre pacotes                 |
| `ci/`           | Executores do CI (`ci`, `ci-changes`, `validate-local`, `prove-acceptance`)     |
| `cold-tier/`    | Arquivo frio, travas no R2 e provas locais e hospedadas do tier frio            |
| `console/`      | Build e publicação do console, prova do site público e medições de bundle       |
| `contracts/`    | Geração e deriva dos contratos, build e prova do SDK                            |
| `deploy/`       | Publicação hospedada e da produção NFS-e, gate de emissão, liberação da captura |
| `distribution/` | Provas dos pacotes npm e publicação                                             |
| `fiscal/`       | Prova fiscal, schemas NF-e e NFS-e, corpus, referências, captura e certificados |
| `licenses/`     | Inventário de licenças, licenças próprias e avisos dos pacotes                  |
| `proofs/`       | Provas hospedadas e locais sem domínio mais estreito                            |
| `public-copy/`  | Varredura pública, `pre-push` e varredura de credenciais                        |
| `repo/`         | Catálogo de `bun run help` e guardas do próprio repositório                     |
| `validation/`   | Deployment de validação e diagnóstico do smoke                                  |
| `worktree/`     | `bun run dev`, prova de isolamento e testes do ciclo de vida dos worktrees      |

Seis arquivos ficam na raiz de `scripts/`, porque algo de fora do checkout os
chama pelo caminho:

- `worktree.mjs`: `scripts/lib/worktree/lifecycle.mjs` roda o `worktree.mjs`
  do checkout recém-criado, que pode vir de uma ref anterior.
- `selfhost.mjs`: a documentação pública da instalação própria manda o
  operador rodá-lo pelo caminho.
- `contribution-terms.mjs` e o teste dele: o workflow `pull_request_target` faz
  checkout da base da PR e roda o script pelo caminho.
- `sync-claude-skills.mjs` e o teste dele: o caminho está gravado nos atalhos
  gerados de `.claude/skills/` e marca quais são dele.

Um script em `scripts/<domínio>/` acha a raiz do repositório por `repoRoot` ou
`repoUrl`, de `scripts/lib/repo-root.mjs`, e não subindo pastas a partir de si
mesmo nem pela pasta de execução (`process.cwd()`). Um `..` a mais ou a menos
não falha: lê e grava no lugar errado; e quem roda o script de outra pasta
gravaria os recibos fora da raiz. `scripts/repo/scripts-layout.test.ts`
reprova arquivo novo solto na raiz de `scripts/`, cálculo de raiz pela própria
pasta ou pela pasta de execução e caminho de `scripts/` citado
por `package.json`, workflow, `vite.config.ts`, `knip.jsonc` ou `CODEOWNERS`
que não existe.

### Segredos no repositório

Duas barreiras evitam que uma credencial entre por acidente. O `.gitignore`
recusa variantes privadas de configuração (`.env.*`, `.dev.vars.*`) e
certificados ou chaves (`*.pfx`, `*.p12`, `*.key`, `*.pem`), com exceção
explícita para as fixtures sintéticas de `tests/fixtures/nfe/4.00/`. `ci:secrets` (`bun run secrets:check`) roda
`scripts/public-copy/check-secrets.mjs` sobre todo arquivo de texto de `git ls-files` e
falha com arquivo, linha e regra, sem imprimir o valor. As regras ficam em
`scripts/lib/credentials.mjs`, as mesmas que a checagem dos tarballs usa:
cabeçalho de chave privada PEM, tokens de serviço com prefixo conhecido
(GitHub, Stripe, AWS, Google, Slack, npm, deploy key do Convex) e a chave de
API `fnfe_` no formato gerado, `fnfe_` seguido de exatamente 43 caracteres
base64url. Menções como `fnfe_...` ou o prefixo curto exibido na lista de
chaves não disparam. Os falsos positivos conhecidos ficam numa lista no próprio
script, por arquivo e regra, cada um com o número exato de ocorrências que
cobre e o motivo. Uma ocorrência a mais da mesma regra naquele arquivo
bloqueia o grupo inteiro, para que uma credencial real não passe atrás de uma
exceção; uma a menos faz a exceção falhar como obsoleta.
`scripts/public-copy/check-secrets.test.ts` prova a detecção de um canário sintético
montado em tempo de execução, a exceção restrita ao arquivo, à regra e à
contagem, o bloqueio de uma ocorrência extra e o binário ignorado.

Limites:

- Ignorar não remove nem revoga o que já está versionado. Um segredo que
  chegou a um commit continua no histórico até ser revogado na origem. O
  repositório é público: todo push fica exposto, e o push protection do
  GitHub e este scanner são a barreira antes dele.
- O scanner lê só texto e pula binários. Ele não vê um segredo dentro de uma
  imagem, como as capturas de chave saneadas na #342; roteiros de captura
  precisam mascarar o campo (veja `apps/console/e2e/keys.mjs` e
  `docs/v1.0/evidence/console-design-telas-gestao/capture.mjs`).
- Segredos sem prefixo fixo (senhas, segredos de webhook, chaves de
  integração) não têm formato reconhecível e dependem do caminho ignorado e da
  revisão.
- Os arquivos não versionados ficam fora da varredura até o `git add`.
- Só arquivos regulares são lidos: symlinks versionados não são seguidos; o
  alvo é versionado e varrido por conta própria. Os atalhos em
  `.claude/skills/` são arquivos comuns, gerados por
  `scripts/sync-claude-skills.mjs`, e entram na varredura.

Desde 03/11/2026 o repositório é público, e secret scanning e push protection
estão ligados (`security_and_analysis` de `gh api repos/freecorps/freecorpsNFE`).
Em 21/10/2026, com o repositório privado, a API não informava nenhum dos dois
(`security_and_analysis: null`). Eles não substituem `ci:secrets`, que roda no
mesmo grafo do job Validate.

### Termos de contribuição

O workflow `Contribution terms` (`.github/workflows/contribution-terms.yml`)
roda em toda PR aberta, editada ou atualizada. Uma PR de dono, membro ou
colaborador do repositório, ou de um bot, passa. As demais só passam com a
frase de aceite de `CONTRIBUICOES.md` no texto visível da descrição; a
frase dentro de um comentário HTML, como no modelo de PR, não conta. A
frase vem do próprio `CONTRIBUICOES.md` (`scripts/contribution-terms.mjs`).

É o único workflow que usa `pull_request_target`: assim o workflow e o script
são os da `main`, e a PR não muda o check que a julga, e ele roda numa PR de
fork sem esperar a aprovação dos workflows de contribuidores externos. Ele
não faz checkout, build nem execução do código da PR, não tem secret e só lê
do evento a associação e o tipo do autor e a descrição, por `env:`.

### Varredura pública

O workflow `Public scan` (`.github/workflows/public-scan.yml`) roda em todo
PR, em todo push na `main` e por disparo manual. Ele confere o que é, ou vai
ser, público com `scripts/public-copy/public-tree.mjs`: as regras de
`scripts/public-copy/check-secrets.mjs`, o Gitleaks 8.21.2, baixado com o SHA-256 fixado,
CNPJ, CPF (com e sem máscara) e chave de acesso reais, e-mail externo, caminho
local, deployment Convex desconhecido e os nomes restritos. O relatório
`varredura.json` fica no artefato `public-scan`, com caminho, linha e tipo de
cada achado, sem o valor.

`scripts/public-copy/public-scan.mjs` escolhe o modo pelo checkout:

- **No repositório arquivado**, onde a lista em custódia existe, ele monta a
  cópia pública do commit, com seleção e edições, e a varre. Um drift de
  edição ou um nome novo aparece no PR que o causa.
- **No repositório público**, ele varre todo arquivo versionado
  (`--checkout`), sem seleção nem edição. Os nomes restritos vêm do secret
  `FNFE_PUBLIC_DENYLIST`, o JSON da lista em custódia, que guarda só os
  SHA-256 dos nomes. PR de fork não recebe secrets: ele é varrido sem os
  nomes, com aviso, e o push na `main` repete a varredura com eles.

Desde a fase 1e da #267, uma varredura bloqueada reprova o check
(`PUBLIC_SCAN_ENFORCE: "true"`), assim como um erro de uso, como Gitleaks
ausente. Com `"false"`, ela só avisaria. Para rodar localmente, com o Gitleaks 8.21.2 no PATH ou em
`GITLEAKS_BIN`: `node scripts/public-copy/public-scan.mjs <pasta vazia fora do repositório>`.

Sem a lista de nomes restritos, os nomes não são procurados e as exceções
deles (`mantenedor`, `cliente`, `deployment-teste`, `produto-freecorps`) não
são julgadas obsoletas; com a lista, uma exceção sem a ocorrência bloqueia.

### Hook pre-push

O `Public scan` roda depois do push, quando a branch já está pública. O hook
`.vite-hooks/pre-push` chama `scripts/public-copy/pre-push.mjs`, que varre cada commit
enviado com `scripts/public-copy/public-tree.mjs --checkout` antes de ele sair da
máquina, em cerca de 2 segundos. Um achado que bloqueia recusa o push e
mostra caminho, linha e tipo, sem o valor; o relatório fica numa pasta
temporária, sem a cópia da árvore.

O script `prepare` (`vp config --no-agent`) instala o dispatcher do Vite+ em
`.vite-hooks/_` a cada `vp install` e aponta `core.hooksPath` para ele. A
configuração é do repositório e vale para todos os worktrees; um worktree sem
`.vite-hooks/_` (antes do `vp install` ou numa branch anterior a este hook)
envia sem varrer. `vp hooks status` mostra o estado.

Limites:

- Sem o Gitleaks 8.21.2 no PATH ou em `GITLEAKS_BIN`, o hook passa
  `--sem-gitleaks` e avisa; as regras de `scripts/public-copy/check-secrets.mjs` e os
  identificadores continuam. Os nomes restritos, que vêm do secret do CI,
  nunca são conferidos no hook.
- Ele varre o commit na ponta de cada ref enviada, como o CI. Um dado
  adicionado num commit intermediário e removido no seguinte passa pelos dois
  e fica no histórico público.
- Título e corpo de PR, issue, comentário e mensagem de commit não são
  arquivos e ficam fora do hook e do `Public scan`. Quem escreve passa o
  texto, gravado em arquivo, por `node scripts/public-copy/scan-public-text.mjs`, que
  aplica as regras de credenciais e identificadores, sem Gitleaks nem nomes
  restritos.
- `git push --no-verify` e `VP_GIT_HOOKS=0` pulam o hook. Agentes não usam
  nenhum dos dois para passar um bloqueio (AGENTS.md, Credenciais e dados
  reais).

## Instalação reproduzível e cache

Bun `1.4.0`, Node `24.22.1`, Vite+ `1.4.0` e dependências resolvidas pelo
`bun.lock`. Actions são fixadas por SHA; upload de artifacts usa v7.0.2. O CI
não usa cache de dependências e executa `vp install --frozen-lockfile` em runner
novo. O único cache é o do Vite Task ([Cache do grafo](#cache-do-grafo)). Um
checkout limpo precisa compilar, e as publicações manuais rodam o grafo com
`--no-cache`. O patch de tipos do Better Auth também é aplicado pelo lockfile.

A atualização de dependências mantém Better Auth em 1.6.x, conforme o peer
do adaptador Convex, e React/tipos em 19.2.x; mudar de linha fica separado.
TypeScript 6 continua disponível para os scripts que usam sua API JavaScript;
o alias `typescript-7` atende às checagens nativas. Os tipos do Node seguem a
linha 24 do CI. Vite+ e seu alias `vite` avançam juntos, com `oxfmt`, `oxlint`
e `oxlint-tsgolint` na versão exata que o Vite+ exige; a linha 1.x traz o
Vitest 5. Mudanças de linha do plugin React e xmldom ficam separadas. O
adaptador `@convex-dev/better-auth` e `convex-test` preservam as versões dos patches locais em `patchedDependencies`.

A regra anterior pedia OS, arquitetura, Node, Bun e hash do lockfile na chave de
qualquer cache. Ela valia para um cache que o Actions restaura sem conferir o
conteúdo, como o de `node_modules`. O cache do Vite Task confere sozinho: o
lockfile, o `node_modules` instalado e os executáveis lidos são entradas
registradas de cada tarefa, e uma mudança neles faz a tarefa executar. Pôr esses
hashes na chave do Actions só impediria a restauração antes de o Vite Task
decidir; por isso a chave segue o guia do Vite+, com OS, arquitetura e run.
Continua valendo: nunca restaurar `node_modules`, builds fora do cache do Vite
Task ou o recibo de aprovação no lugar dos checks (`tests.json` é refeito a cada
execução, e `approve` exige recibo aprovado de cada área), e manter uma execução
limpa verificável, o disparo manual do CI.

```powershell
bunx bun@1.4.0 install --frozen-lockfile
bunx bun@1.4.0 run ci:local
```

`ci:local` executa o mesmo grafo do job e a checagem de fronteiras. Como no CI
das PRs, o Vite Task repete as tarefas cujas entradas não mudaram, inclusive as
áreas de teste (cache em `node_modules/.vite/task-cache`; `vp cache clean` o
apaga); `vp run --no-cache validate` repete a execução limpa. As provas de
consumidor do SDK, do XML e da distribuição, a prova do proxy de autenticação e
a varredura de credenciais nunca usam cache. `ci:test` continua executando só a
suíte, inteira. As tarefas `test:<área>` ficam fora do grafo `validate`; as do
grafo são as `ci:test:<área>`, com o mesmo comando mais o recibo.

`ci:local` aceita arquivos staged, unstaged e novos. Produz automaticamente
recibo e resumo, inclusive quando uma etapa falha, em
`.ci-results/local/<tentativa>/`. O terminal imprime os caminhos absolutos.
O modo é `local`: `codeSha` permanece nulo, e o SHA aparece como **HEAD de
referência**, acompanhado do estado inicial e final da árvore. Mesmo uma
árvore limpa neste modo não recebe aprovação de commit. O fingerprint detecta
mudanças observáveis pelo Git entre essas duas leituras; não prova ausência
de edição intermediária revertida nem acompanha arquivos ignorados.

Para provar um commit já preparado, use `bun run ci:prove`. Ele exige árvore
limpa antes e depois, HEAD estável e grafo sem cache. Não crie commit apenas
para satisfazer esse comando quando a tarefa pede alterações locais.
O T3 oferece **Validar alterações** e **Provar commit**, que chamam esses
mesmos scripts; `bun run help` descreve as duas entradas.

Ambos aceitam `--base <ref>` e resolvem a base uma vez: o SHA registrado é
exatamente o passado em `CONTRACT_BASE`. O padrão comum é `origin/main`;
isso substitui o fallback `HEAD^` do antigo encadeamento de `ci:local`.
Em uma stack, informe a base apropriada. CI usa checkout e base do evento.

### Conferir só o que mudou

`bun run check:changed` é a conferência antes de cada push. Compara o
merge-base entre `origin/main` (ou `--base <ref>`) e `HEAD` com a árvore de
trabalho, inclusive o que está no índice, fora dele e os arquivos novos, e roda
só o que essa mudança pede. As etapas rodam mesmo quando uma anterior falha, e o
comando sai com 1 se alguma falhou:

| Etapa                  | O que roda                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Formatação             | `vp fmt --check` nos arquivos alterados que existem                                 |
| Pacotes fiscais        | `vp run ci:packages`, do cache quando nada deles mudou                              |
| Lint                   | `vp lint --deny-warnings` nos JS e TS alterados: um aviso novo reprova              |
| Typecheck              | `scripts/build/typecheck.mjs` em cada projeto que contém um arquivo alterado        |
| Fronteiras dos pacotes | `check-package-boundaries.mjs`, quando muda um pacote, manifest ou `bun.lock`       |
| Testes alcançados      | `vp test run --changed <merge-base>`, pelo grafo de imports, nos projetos do Vitest |

O projeto de typecheck entra pelo programa real de cada `tsconfig`
(`tsc --listFilesOnly`) e não só pelo grafo de pacotes: o console importa
`platform/convex` por caminho relativo, sem declarar a dependência. Uma mudança
em `tsconfig*.json`, `package.json` ou `bun.lock`, ou um arquivo de código
apagado, checa os cinco projetos. O resumo também lista os pacotes de
`scripts/build/package-boundaries.json` alterados e os que dependem deles. Uma
mudança só de documentação, pela mesma regra do job Validate, roda a formatação
e os testes que leem toda a documentação. `--dry-run` mostra arquivos, projetos
e comandos sem executar.

`check:changed` não substitui `ci:local`: não roda as provas de consumidor,
distribuição, contratos, Workers, varredura de credenciais nem os testes que
o grafo de imports não alcança. Antes de abrir a PR, `ci:local` ou `ci:prove`
continuam valendo. Ele também não entra no hook pre-push, que segue só com a
varredura pública: typecheck e testes deixariam cada push um ou dois minutos
mais lento.

O Vite Task já faz aqui o papel do Turborepo usado em outros projetos da Freecorps: registra os
arquivos efetivamente lidos, inclusive fixtures, sem `inputs` declarados à
mão, e `vp test run --changed` escolhe arquivos de teste, mais fino que o
`--affected` do Turborepo. Desde 04/11/2026 o Validate usa o cache dele como esses
projetos usam o do Turborepo: restaurado do Actions, com o artifact da PR
mesclada repetido no push da `main`. Adotar o Turborepo poria um segundo
executor de tarefas ao lado do Vite Task, com a dependência `turbo` e os
`inputs` manuais.

## Custo dos locks no Windows

Os locks consultam criação, executável e linha de início do processo para não
confundir um PID reutilizado com seu dono original. No Windows, uma consulta
abre PowerShell e chama `Get-CimInstance`. A identidade válida do próprio
processo é reaproveitada em memória durante essa instância; falhas e PIDs
externos sempre exigem nova consulta. A validação do prazo acontece antes do
cache. Os campos observados estão documentados em
[Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process).
O cache não se aplica a Linux/macOS, onde alterar `process.title` pode alterar
a linha observada; veja [Node process](https://nodejs.org/api/process.html#processtitle).

Para comparar uma revisão anterior com os módulos locais:

```powershell
bun run bench:workflow --base 4691d78a32e3ad0c8f7327a07ed3041045cb23d9
```

O comando copia cinco módulos para snapshots em `.ci-results/workflow-bench`,
sem alterar fontes, compartilhar dependências ou iniciar serviços. Cada amostra
abre um processo Node novo e executa quatro ciclos com aquisição, participação,
recusa de concorrente e liberação dos locks reais. A primeira sonda entra no
tempo medido; a preparação dos snapshots e importação dos módulos ficam fora.
Há um aquecimento por variante e cinco pares em ordem alternada. Uma falha
interrompe a comparação e permanece registrada. O recibo contém runtime, SHA
da base e hashes das fontes de ambas as variantes, inclusive alterações locais.

Na comparação em Windows x64 com Node 22.15.0 em 21/10/2026:

| Variante                    |    Mediana |      Mínimo–máximo | Amostras |
| --------------------------- | ---------: | -----------------: | -------: |
| Base                        | 5.352,4 ms | 5.304,5–5.372,2 ms |        5 |
| Cache da identidade própria |   363,2 ms |     356,5–386,9 ms |        5 |

O [recibo da medição](workflow-locks-20261021.json) registra todas as amostras.
A redução de 93,2% vale para esse ciclo repetido de locks no mesmo processo.
Uma CLI que consulta a própria identidade uma única vez não elimina sua
primeira sonda. Não é uma medição do CI completo, do setup inteiro ou do
serviço hospedado. Os testes de tooling que adquirem vários locks no mesmo
processo exercitam o caminho beneficiado; observadores de outro processo
preservam a consulta atualizada.

A validação local também usa a mesma saída de `git status -z` para sujeira e
fingerprint dentro de cada observação. Isso elimina duas chamadas redundantes
por execução; início e fim continuam sendo leituras independentes. Não foi
atribuído um ganho de tempo isolado a essa segunda mudança.

## Relatórios e artifacts

O JSON bruto do Vitest fica em pasta temporária, é reduzido a contagens e
removido. O artifact `ci-*` de 14 dias contém `revision.json`, `tests.json`,
os recibos das áreas em `tests/<área>.json`,
`summary.md`, os recibos `nfe/independent.json`, `74/package.json`,
`74/sdk-metafile.json` e `83/tarballs.json` e o relatório sanitizado
`auth-worker/report.json` da prova do proxy no runtime Workers. O artifact
`sdk-*` guarda o tarball de validação do SDK, e o `vite-task-cache` de 7 dias,
só em PR aprovada, o cache do Vite Task que o push na `main` repete. Um recibo
repetido do cache traz o commit e o run em que a tarefa de fato rodou. Não inclui XML, resultados de
funções, nomes de testes, mensagens de falha, stack traces, caminhos
absolutos, env, arquivos de acesso ou HAR. Os logs de falha continuam
disponíveis no job e devem conter só dados sintéticos. Os relatórios também
são gerados quando o teste falha; ausência de execução aparece como tal.
Relatório não substitui a conclusão dos steps de build/lint.

## Roteiros de prova com recibo

`scripts/lib/proof-runner.mjs` é o executor comum das provas locais com
recibo. `runProof` recusa checkout sujo; `runLocalValidation` identifica
explicitamente a validação da árvore de trabalho. Ele roda as etapas em sequência com o ambiente
reduzido de `subprocess-environment.mjs`, grava o log de cada etapa com o hash
e escreve `receipt.json` com revisão, base de contrato (ref e SHA), runtime,
hashes do runner e das entradas, comandos, códigos de saída e duração. A
primeira etapa que falha interrompe a sequência e gera um recibo `failed` com
`failedStep` e o caminho do log; a prova também falha se o checkout mudar.
`scripts/ci/proof-runner.test.ts` cobre o executor com git e subprocessos
simulados.

A validação geral não tem lista própria de comandos: reaproveita o grafo
`validate` do CI, sem cache, e `ci:boundaries`, e copia o relatório sanitizado
`tests.json`. A base de contrato vem de `--base` (padrão `origin/main`) e a
saída de `--output`.

- **Recorrente:** `scripts/ci/prove-acceptance.mjs`, a validação geral, com
  alias `bun run ci:prove` e saída padrão `.ci-results/acceptance/<tentativa>`.
  `--input <arquivo>` (repetível)
  registra o hash de um schema ou corpus da entrega.
- **Recorrente:** `scripts/fiscal/prove-capture.mjs`, validação geral, TLS real em
  loopback e jornada de captura no navegador, com `bun run dev` ativo. Saída
  padrão `.ci-results/78`.

O recibo atual tem `schemaVersion: 2`. É gravado como `running` antes das
etapas e atualizado depois de cada uma, junto de `summary.md`. Uma execução
interrompida permanece incompleta; não reutiliza a aprovação da tentativa
anterior. O resumo registra resultado geral, modo, base, runtime, política
de cache, duração das etapas e links relativos para logs e relatório
sanitizado. Relatório ausente aparece como indisponível nesta execução.
Testes aprovados não encobrem falha de lint, build ou fronteiras.

Os builds e relatórios intermediários ainda usam destinos do checkout.
`.ci-results/validation.lock` impede validações concorrentes nesse checkout;
`ci:test` mantém identidade e suíte sob a mesma posse. As entradas diretas
de identidade, testes e resumo também respeitam a trava; subprocessos do
runner precisam apresentar o token da posse ainda ativa.
Worktrees diferentes podem validar independentemente. Uma interrupção,
timeout ou sinal preserva a trava, pois filhos podem continuar escrevendo.
Não a apague apenas pela idade ou pela morte do processo principal: confira
o encerramento de todos os executores desse checkout, sem outra validação
concorrente, antes da remoção manual. A trava do dev é independente.

Compare durações apenas entre execuções com máquina, runtime, revisão e
modo conhecidos. O resumo informa cache **permitido**, sem afirmar que houve
reutilização. A duração de `validate` abrange o grafo paralelo inteiro; somar
tempos de tarefas paralelas não mede tempo de parede. Recibos históricos sem
duração permanecem sem esse dado; uma execução não estabelece ganho,
percentil, custo mensal ou meta de desempenho.

Os recibos de entregas anteriores são históricos: ficam em
`docs/v1.0/evidence/<n>/` sem alteração e comparavam contratos com
`origin/feat/fiscal-platform-v1`. O `runnerSha256` de cada um corresponde ao
roteiro no `codeSha` registrado (`git show <codeSha>:scripts/<roteiro>`), não à
versão atual. Os roteiros `prove-webhook-checks.mjs`, `prove-sdk-checks.mjs`,
`prove-usage.mjs` e `prove-operational-support.mjs` foram removidos porque o
`validate` cobre o que repetiam.

As demais provas `scripts/<domínio>/prove-*` são roteiros próprios, fora do CI
obrigatório e sem esse executor. Exigem ambiente local, Convex local ou
operador, e não usam dados fiscais reais. Entre elas: `prove-usage-load.mjs`
(10 mil e 100 mil documentos sintéticos), `prove-operations.mjs` (Workpool
real e fonte HTTP loopback), `prove-selfhost.mjs` (servidor Docker, receptor
HTTPS e recuperação), `prove-reference-availability.mjs`,
`prove-smoke-diagnostics.mjs` (também executado por
`tests/validationSmoke.test.ts`) e `prove-document-expiry.mjs`, que só fala
com o backend local do worktree, embora grave em `.ci-results/hosted-79-80`.

Os roteiros hospedados não compartilham uma única guarda de destino. Cada um
confere o próprio alvo antes de escrever:

- `prove-hosted-operations.mjs` usa
  `hostedProof` (`scripts/lib/hosted-proof.mjs`). A credencial do operador,
  fora do checkout, precisa apontar para a validação persistente de
  `platform/validation.json` (`modest-seal-118`, tipo `dev`), e o helper
  recusa `CONVEX_DEPLOY_KEY`, `CONVEX_SELF_HOSTED_URL` e
  `CONVEX_SELF_HOSTED_ADMIN_KEY` herdados. `scripts/proofs/hosted-proof.test.ts`
  cobre essa recusa, inclusive de credencial do tipo `prod` e de outro host,
  antes de qualquer chamada de rede. Os outros roteiros abaixo não passam por
  esse helper nem por esse teste.
- `prove-hosted-rate-limits.mjs` exige a mesma credencial da instalação
  `elated-possum-295` que `prove-hosted-webhooks.mjs`, confere que o
  `/health` público serve o SHA informado com `appEnv: installation` e
  `productEnv: sandbox`, e só cria orçamentos sintéticos com prefixo aleatório
  no componente `rateLimiter`. No fim, reseta cada um e confere que nenhum
  ficou com a configuração de partições.
- `prove-hosted-webhooks.mjs` exige a credencial da instalação
  `elated-possum-295`, deployment Convex do tipo `prod`, e chama a REST pelo
  Worker público. Antes de escrever, confere que `/health` e `/build.json`
  servem o SHA informado, que o ambiente é `APP_ENV=installation`,
  `PRODUCT_ENV=sandbox`, `FISCAL_ENV=disabled`, `FNFE_CRONS=off` e
  `WEBHOOK_MODE=https`, que não há crons e que o inventário de endpoints e
  entregas está completo. Cria só organizações sintéticas e, no fim, compara
  ambiente, SHA e endpoints ativos com o estado inicial. O tipo `prod` do
  Convex não é produção fiscal: o ambiente continua sandbox.
- `prove-certificates-hosted.ts` publica num deployment `dev` isolado, com
  referência `dev/issue-77-certificates-proof` em
  `.ci-results/77/hosted-target.json`; recusa `modest-seal-118`, exige deploy
  key `dev:` do mesmo nome e checkout limpo.
- `deploy-nfe-proof.mjs` publica no deployment `dev` isolado
  `dev/issue-69-xml-proof` (`.ci-results/nfe/hosted-target.json`), com as
  mesmas recusas, e confere em `/health` o perfil de validação sandbox com
  fiscal e emissão desligados e o SHA publicado.
  `prove-nfe-runtime.mjs hosted` usa o mesmo alvo, com a chave em
  `NFE_PROOF_DEPLOY_KEY`, e exige que `/health` sirva o `HEAD` local; o modo
  `local` usa o backend do worktree.
- `fiscal-proof.mjs` segue as regras próprias de
  [CAPTURE.md](../plataforma/CAPTURE.md#execução-fiscal-manual-da-50).

## Matriz de entrega

`tests/coverage-matrix.json` relaciona entrega a arquivos reais de evidência.
Cada novo módulo atualiza esse arquivo e os testes no mesmo PR. Não marcar
`delivered` com fixture apenas ou teste todo/skip. O
estado de cada bloco, responsável e condição de saída fica na
[matriz de aceite](../v1.0/ACCEPTANCE.md).

## Revisão automática (Mira)

O app `freecorps-review` revisa cada commit enviado a uma PR e publica o check
`mira/review`, uma revisão e o comentário de walkthrough. O check não é
obrigatório; reprovado, deixa a PR `UNSTABLE` sem bloquear o merge.

Responder a um apontamento não reexecuta o check daquele commit. Na #171, o
Mira aceitou a resposta como falso positivo e o check continuou reprovado. A
API de checks recusa `rerequest` com o token do usuário (404). A forma
verificada de obter nova revisão é enviar um novo commit à PR. Antes de
mergear com o check reprovado, confirme que cada apontamento foi respondido.

O contrato da plataforma está em [API-REFERENCE.md](../v1.0/API-REFERENCE.md) e
[openapi.json](../v1.0/openapi.json).

## Runners e custo

### Onde cada job roda

Todos os jobs rodam no runner padrão do GitHub, `ubuntu-24.04`, com 4 vCPUs,
em VM efêmera. O repositório é público desde 03/11/2026, e esse runner é
gratuito e sem limite de minutos em repositório público. Os jobs saíram da
Blacksmith por decisão do mantenedor em 09/11/2026, quando a franquia
mensal dela já tinha acabado.

A troca mudou o suboperador que executa a publicação e o backup de produção.
Os termos de uso 1.4 e a política de privacidade 1.1 nomeiam o GitHub no
lugar da Blacksmith ([termos](../termos/README.md#termos-de-uso)). O aviso de
30 dias que os termos prometem foi dispensado porque o serviço ainda não tem
clientes.

`Deploy validation` e `Deploy NFS-e fiscal production` chamam o `CI` como
workflow reutilizável. `Validate` não recebe segredos. Os environments, os
secrets e as regras de concorrência não mudaram. Snapshot e monitor do backup
têm agendas independentes, mas compartilham o GitHub Actions: uma
indisponibilidade dele pode impedir ambos de iniciar. O operador confere os
horários das duas execuções.

O runner do GitHub é mais lento que o x64 da Blacksmith e pode ter fila: o
plano Free da organização admite 20 jobs simultâneos, somando todos os
repositórios. CI que não iniciou não é teste aprovado; registre esse
bloqueio separadamente das falhas de código.

### Histórico: Blacksmith

De 21/10 a 09/11/2026 todos os jobs rodaram na Blacksmith, escolhida quando
o repositório era privado e os minutos gratuitos dos repositórios privados
da organização se esgotaram. As medições abaixo são desse período.

#### Orçamento da Blacksmith

A organização tem 3.000 minutos gratuitos por mês na Blacksmith, medidos em
minutos de runner x64 de 2 vCPUs e divididos entre os projetos da Freecorps,
este inclusive. Cada job é cobrado por minuto iniciado. Um minuto de 4 vCPUs
conta 2; um de ARM com 2 vCPUs conta 0,625.

Medições de `Validate` com o grafo atual, em execuções reais:

| Runner      | Job       | Minutos cobrados | Custo por execução |
| ----------- | --------- | ---------------- | ------------------ |
| x64 2 vCPUs | 78 a 85 s | 2                | 2                  |
| x64 4 vCPUs | 48 a 54 s | 1                | 2                  |
| ARM 2 vCPUs | 190 s     | 4                | 2,5                |

O x64 de 4 vCPUs termina em menos de um minuto, mas com 6 a 12 s de folga:
passando de 60 s, a execução custa 4. O de 2 vCPUs custa 2 com cerca de 40 s
de folga. O ARM é mais lento e mais caro para este job. O gate, que só compara
SHAs, durava cerca de 20 s e custava 0,625 no ARM como job próprio; desde a
#51 é um passo de `Validate`.

Estimativa histórica, anterior à migração de produção e snapshot, com 150
execuções de `CI` em PRs, 25 publicações de validação e 5 de produção:

| Uso                                                 | Minutos 2 vCPU por mês |
| --------------------------------------------------- | ---------------------- |
| `CI` em PRs (150 × 2,625)                           | 394                    |
| `Deploy validation`: `CI` e publicação (25 × 8,625) | 216                    |
| `Deploy production`: `CI` (5 × 2,625)               | 13                     |
| Total                                               | cerca de 620           |

A publicação de validação (6 por execução) já rodava na Blacksmith. A tabela
não inclui publicação de produção, snapshots nem o monitor do backup na
configuração atual. Medir esses jobs após a migração antes de estimar o
total mensal. Um push novo numa PR cancela a validação anterior da mesma PR.

Com o cache do grafo (04/11/2026), uma PR paga a instalação, a restauração do
cache, as tarefas sem cache e as que a mudança alcança; uma PR só de
documentação paga a instalação, a formatação e dois arquivos de teste. Cada
merge na `main` passou a rodar o `CI` de novo, mas repetindo o que a PR
aprovou. Medir os minutos cobrados dessas execuções antes de atualizar a
estimativa acima.

#### Tempos

`Validate` em PRs, antes no VPS e agora no x64 de 2 vCPUs da Blacksmith:

| Medida                    | VPS (11 PRs, 22 e 23/09) | Blacksmith (3 execuções) |
| ------------------------- | ------------------------ | ------------------------ |
| Job `Validate`            | 7,4 min (6,6 a 8,7)      | 1,3 min (78 a 85 s)      |
| Suíte de testes           | 186 s                    | 47 s (43 a 50)           |
| Fila antes do job         | até 8,2 min              | 18 a 34 s                |
| Workflow do início ao fim | 9,3 min (máximo 26,4)    | 2,3 min (2,3 a 2,7)      |

Na mesma máquina local, os passos do job antigo em sequência levavam 41 s
(mediana de três rodadas intercaladas); o grafo leva 26 s sem cache e 22 s com
cache, limitado pelos testes. As checagens de tipos caem de 5,5 s para 1,5 s
na raiz e de 4,1 s para 1,0 s no console.

Com a suíte crescendo para cerca de 2.170 testes, o job chegou a 153 a 192 s
(cinco PRs de 09/10), com a suíte em 125 s como caminho crítico. Na primeira
execução com os projetos por área, a assinatura nativa dos certificados de
teste e o XSD da NF-e compilado uma vez, o job levou 127 s, o grafo 106 s e a
suíte 102 s. Os testes seguem como caminho crítico; o restante do grafo
termina antes deles.

Em 21/10, com cerca de 2.360 testes, o job no x64 de 2 vCPUs variava de 3,6 a
7,3 min. A suíte levava de 184 a 395 s porque disputava os dois núcleos com
builds, checagens de tipos e provas de pacote, que rodam ao mesmo tempo no
grafo. O arquivo mais lento era `scripts/licenses/license-inventory.test.ts` (38 a
87 s): cada caso `runtime-*` rodava o `licenses:check` inteiro, quadrático no
tamanho do lock (9 s localmente). Com o lock indexado uma vez, o check cai
para 0,3 s e o arquivo para 3 s. `Validate` passou para o x64 de 4 vCPUs,
com 3 workers do Vitest: o minuto conta 2, mas o job cobra cerca de metade
dos minutos.

### Infraestrutura anterior no VPS

Nenhum workflow atual do freecorpsNFE usa o VPS. O runner
`freecorps-linux-nfe-01` foi removido do repositório no GitHub em 21/10/2026.
Em 21/10/2026, o serviço `nfe` saiu do `compose.yaml` do host e o container
`freecorps-ci-nfe-1` e o volume `freecorps-ci_nfe` foram apagados, com
`_work/`, `_diag/` e a configuração do agente. Os runners de outros
projetos no mesmo host continuam ativos e não devem ser interrompidos.

Antes da migração, `Publish production` e `snapshot` usavam
`[self-hosted, Linux, X64, freecorps-linux]`. Cada repositório tinha um container
e credenciais próprios. Uma
trava compartilhada permite um job por vez entre os projetos da
Freecorps, este inclusive. O conjunto tem limite de 2 vCPUs e 4 GiB de RAM para preservar
o e-mail.

Uma espera no passo `Set up runner` significa que outro projeto ocupa a fila.
Os containers reiniciam e limpam o checkout depois de cada job; não possuem
Docker, sudo, montagens dos serviços de produção ou acesso às redes privadas
do servidor. Não use `container:` ou `services:` nos jobs dessa infraestrutura.

O parágrafo abaixo trata de outros repositórios do VPS: este repositório
não tem job mobile nem workflows `.yml.disabled`.
Nesses outros repositórios, o job mobile e os workflows nativos de
macOS/Windows estão pausados temporariamente por decisão da empresa. O job
mobile permanece comentado no `ci.yml` de cada um; os workflows inteiros preservam o conteúdo em `.yml.disabled`.
Para reativar, providencie o runner nativo, restaure o job/extensão e habilite
o workflow em Actions. Restaurar somente o arquivo não desfaz a desativação
administrativa aplicada no GitHub.

Operação no VPS: `cd /opt/freecorps-ci && docker compose ps` e
`docker compose logs --tail 100`. Pausa: `systemctl stop freecorps-ci`.
Retomada: `systemctl start freecorps-ci`. O runbook completo e os arquivos
de provisionamento estão em `/opt/freecorps-ci/README.md`, com cópia local
em `E:\projetos\freecorps-ci`. Nunca copie tokens ou senhas para este repo.

Fontes: [eventos de PR e SHA de merge](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
[outputs de workflows reutilizáveis](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-outputs-from-a-reusable-workflow)
e [upload-artifact v7.0.1](https://github.com/actions/upload-artifact/releases/tag/v7.0.1).
