# Worktrees

Cada linha de trabalho pode usar um checkout, banco Convex local anônimo e portas próprios.
O setup funciona sem conta Convex e sem deployment de nuvem.
O checkout principal não roda aplicativo local: `bun run dev` só inicia em worktree.
Os worktrees usam frontend a partir de 5174 e pares cloud/site a partir de
3210/3211. O registro fica em `freecorpsnfe-worktrees.json`, dentro do diretório
comum do Git, com reserva sob lock e sondagem das portas. A sondagem faz binds
de teste em `127.0.0.1`, `0.0.0.0` e `::` e uma conexão de teste em
`127.0.0.1` e `::1`; uma porta que qualquer processo segura, inclusive o
backend Convex local de outro projeto, é pulada sem que o dono seja encerrado.

Use a versão do Bun fixada em `package.json`. O lockfile atual exige Bun 1.4;
Bun 1.3 não consegue instalar este projeto com `--frozen-lockfile`.
Se o Bun global ainda for 1.3, use `bunx bun@1.4.0 run worktree:create feat/minha-tarefa`
e, dentro do worktree, `bunx bun@1.4.0 run dev`. Os subprocessos preservam
o executável Bun que iniciou o comando.
O runtime Node 24 para actions do Convex é instalado dentro de cada worktree;
o backend local só publica actions `"use node"` com Node 22 ou 24.
O frontend usa Vite+, sem o inspector do plugin Cloudflare.

## Pré-requisitos e primeira execução

Requisitos: Git, Vite+, Bun 1.4.0, Node 22 ou 24 com npm e acesso à internet
para baixar dependências, runtime Node local, backend Convex e Chromium.
Confira `bun --version`, `node --version` e `npm --version` antes de começar.
O Node 24.22.1 das actions, o mesmo do CI, é instalado pelo setup em cada
worktree. Nenhuma conta Convex ou chave da Freecorps é exigida para o
perfil `platform`.

Para começar sem arquivos privados, clone `main` e instale as dependências do
checkout que executará os scripts:

```powershell
git clone --branch main https://github.com/freecorps/freecorpsNFE.git freecorpsNFE
cd freecorpsNFE
vp install --frozen-lockfile
```

Com outro Bun global, instale com `bunx bun@1.4.0 install --frozen-lockfile`
e use `bunx bun@1.4.0 run` nos comandos, como descrito acima; isso preserva a
instalação global.

## Criar e executar

Para a plataforma atual, use `main` como base e escolha o aplicativo:

```powershell
bun run worktree:create feat/minha-entrega --from origin/main --app platform
cd ../freecorpsNFE-worktrees/feat-minha-entrega
bun run dev
```

O perfil `platform` usa `platform/convex` e `apps/console`, sem copiar o
`.env.local` do mantenedor. O banco fica em `platform/.convex`; runtime Node,
segredo Better Auth, registro dos processos e locks ficam em `.convex`.
`worktree list` mostra o aplicativo de cada checkout. `platform` é o único
aplicativo; `--app platform` continua aceito e `--app legacy` é recusado.

Em um clone com outro nome, o diretório irmão de worktrees também muda; use o
caminho impresso por `worktree:create`. Aguarde o setup terminar e o `dev`
imprimir a URL do frontend antes de executar consultas ou o ensaio de
navegador.

O cadastro local está em `/signup`, com e-mail fictício e senha de 16 a 128
caracteres. Depois de cadastrar, leia o código com
`bun run worktree mail seu@development.invalid` em outro terminal do mesmo
worktree, mantendo `bun run dev` aberto, use o código mais recente em
`/verify-email` e entre em `/login`. A recuperação começa em
`/forgot-password` e termina em `/reset-password`. Verificação e recuperação
usam códigos de oito dígitos, com dez minutos de validade. O coletor recebe a
mensagem sem envio à internet e só atende à credencial administrativa do
banco local; não existe endpoint público para consultar mensagens. Ele guarda
mensagens por até dez minutos, remove até 100 expiradas em cada envio e não
executa cron; registros expirados podem permanecer até outro envio ou a
remoção do banco descartável. Nenhum código ou senha é colocado em URL ou
gravado pela aplicação em storage.

Um checkout criado pelo editor recebe `platform` no primeiro setup, sem
`--app`. Aguarde sempre o setup automático antes de iniciar outro comando.

O backoffice legado foi aposentado na #345. Um worktree preparado para ele
(`.convex/worktree-app.json` com `legacy`, ou banco em `.convex/local/` sem
esse arquivo) continua aparecendo em `worktree list` e sai normalmente por
`worktree cleanup`, `worktree remove`, `worktree prune` e `worktree finish`.
Setup, dev e sync o recusam com uma mensagem que pede outro worktree, e o
`doctor` reprova o aplicativo; nenhum desses comandos apaga o banco antigo.

O setup e o dev compilam `packages/fiscal-nfe` antes de publicar as funções.
Depois de editar esse pacote com o dev aberto, execute `bun run packages:build`;
o watcher do Convex detecta a saída compilada.

### Verificar os fluxos no navegador

Com `bun run dev` aberto, instale o navegador em outro terminal do mesmo
worktree e execute o ensaio de cadastro, verificação, sessão, recuperação,
jornadas, logout entre abas, axe e action Node:

```powershell
node apps/console/node_modules/playwright/cli.js install chromium
node --experimental-strip-types apps/console/e2e/foundation.mjs
```

O runner usa Node 22 ou 24 e o Chromium instalado pelo Playwright. As
capturas ficam em `.browser-results/foundation`; `failure-private.png` é
diagnóstico local e não deve ser publicado.

Antes do ensaio, feche as outras abas desse console. O `foundation` e os runners
que usam `local-auth-pacing.mjs` já reservam 65 segundos antes da primeira
requisição autenticada; não é necessário acrescentar essa espera manualmente.
Outras abas e programas podem consumir o orçamento durante a espera. No ambiente local, requisições sem
IP identificado compartilham os limites por rota, inclusive cinco logins por
janela de inatividade e 30 leituras por minuto em cada rota de sessão, token e
chaves públicas JWKS. Essas leituras usam janela fixa; login/OTP ainda exigem
inatividade para recuperar o orçamento. Uma sonda anterior pode consumir a
janela e causar a mensagem "Muitas tentativas". Preserve o recibo da falha e
repita após a janela completa, sem aumentar o limite de autenticação. Outras
jornadas e provas de navegador estão em
[navegador.md](desenvolvimento/navegador.md).

O `create` usa `origin/main` por padrão. Use `--from <ref>` para outra base;
`--path <caminho>` escolhe um destino exato, e `--into <diretório>` muda a pasta
que contém os worktrees. `bun run worktree config` mostra a configuração de local.
`--no-setup` só cria o checkout; `--no-install` pressupõe dependências já instaladas.

O Git só leva conteúdo commitado para um checkout novo. Ao importar esta
ferramenta, a branch escolhida como base precisa conter os scripts.

Para um worktree criado pelo editor, T3 Code, Codex ou `git worktree add`, execute
`bun run worktree:setup` dentro dele. O setup recusa o checkout principal.
No worktree, `bun run dev` inicia a sessão local completa da plataforma e
imprime o alvo; no checkout principal, ele recusa. Um comando Convex executado
diretamente fora dos scripts precisa de conferência própria do alvo.

O setup instala dependências próprias, cria o deployment local, configura o
ambiente e publica schema e funções. `bun run worktree sync` reaplica
ambiente, schema e funções no Convex local sem inserir nem apagar dados; recusa
o checkout principal e um worktree com dev rodando. Não há seed: contas, API
keys, empresas ou emitentes fictícios não são criados automaticamente.
`bun run worktree seed vazio` e `--seed vazio` em `create` e `setup`
continuam aceitos como nomes antigos do mesmo comportamento; outro perfil é
recusado.

O push do setup, do sync e do dev também regenera `platform/convex/_generated/`.
É esse o fluxo de codegen: `convex codegen` avulso exige um deployment, porque
a análise dos componentes e das variáveis de `convex.config.ts` roda no
backend. Se o worktree aparecer com `_generated/` alterado logo após o setup,
a `main` estava desatualizada; commite a regeneração na PR que mudou a fonte.
Não edite `_generated/` à mão para contornar um push que falhou.
`platform/convex/generated.test.ts` falha quando o tipo `Env` de `server.d.ts`
diverge das variáveis declaradas em `convex.config.ts`.

Se o push recusar com `DeploymentNotConfiguredForNodeActions` ("Node.js v22 or
24 is not installed"), o `node --version` do terminal não importa: o CLI e o
backend local rodam com o Node isolado do worktree, posto à frente no `PATH`
do processo. Até a #609 esse Node era 20.20.2 e o push falhava em qualquer
máquina. O setup reinstala o runtime quando a versão difere da fixada em
`scripts/lib/worktree/paths.mjs`; `bun run worktree doctor` mostra a versão
em uso.

## Ciclo de uma tarefa

Consultas e revisões somente leitura usam o checkout disponível. Preparar uma
entrega com alterações segue este ciclo:

1. **Início.** O editor (T3 Code, Codex) cria o worktree na ponta da base.
   Use uma branch própria a partir de `origin/main`, preservando a branch da
   tarefa quando ela já existir. Instale com `vp install --frozen-lockfile`
   quando precisar preparar as dependências. Código, testes, typecheck e build não usam
   o Convex local; `bun run worktree:setup` só é necessário para `bun run dev`,
   sync ou e2e.
2. **Entrega.** Valide as alterações com `bun run ci:local`. Commit, PR e merge
   seguem o escopo pedido pelo dev. `bun run ci:prove` prova um candidato já
   commitado, sem autorizar o commit por si só.
3. **Conclusão.** Depois do merge, `bun run worktree:finish` no próprio
   worktree. Ele atualiza `origin`, confere que a branch está integrada, para
   os processos registrados e os backends órfãos, libera as portas e roda o
   `prune` sobre os demais worktrees. Branch não integrada, alteração não
   commitada ou worktree destacado fazem o comando recusar sem remover nada.
   `--no-sweep` só conclui o próprio worktree; `--no-fetch` aceita o estado
   local. O diretório atual não se apaga de dentro, porque o shell e o editor
   o usam; ele sai na conclusão da próxima tarefa ou num `prune` feito de
   outro checkout.

Sem a conclusão, nada nesta máquina observa o merge feito no servidor, e os
worktrees se acumulam com `node_modules`, banco local e portas reservadas.

## Configuração local

O perfil `platform` usa Better Auth, segredos próprios e coletor de e-mail
local, conforme o fluxo de cadastro acima. Nada do `.env.local` do checkout
principal é copiado: o setup reescreve o `.env.local` do worktree para as URLs
locais. Chaves de deploy e seletores self-hosted herdados do processo são
descartados nos comandos locais.

O backend usa `.convex/worktree.env`. Os segredos são aleatórios por worktree.
O setup mantém apenas a allowlist definida em
`scripts/lib/worktree/env-file.mjs` e força crons, transporte fiscal, e-mail
e webhooks a permanecerem desligados. Não copia certificados A1, senhas,
chaves de e-mail ou credenciais de serviços fiscais.

As variáveis do backend ficam no deployment Convex; as `VITE_*` do frontend
entram no bundle durante o build. O runtime Node das actions do Convex não é o
runtime que serve os assets estáticos na Cloudflare.

## Crons, filas e previews

Um incidente em outro projeto do mantenedor veio de previews Convex que continuavam executando crons
mesmo sem tráfego. O levantamento de ambientes identificou 68 previews ativos e cerca de
1,65 milhão de chamadas mensais de tarefas agendadas. Por isso, o setup
desliga crons nos ambientes efêmeros e exige limpeza dos previews sem uso.

As definições ficam em `platform/convex/crons.ts`. O setup grava
`FNFE_CRONS=off` no deployment local antes de publicar as funções e também
fixa `PRODUCT_ENV=sandbox`, `FISCAL_ENV=disabled`, `EMAIL_MODE=local`
e `WEBHOOK_MODE=disabled`.

O setup e cada início de dev local seguem esta ordem:

1. Iniciar o backend com `--skip-push`, nas portas reservadas.
2. Remover variáveis fora da allowlist e gravar `FNFE_CRONS=off` no backend.
3. Publicar funções e schema com a seleção local explícita em `.env.local`.

`env set` sem novo push não reconcilia os crons. Definir `FNFE_CRONS=off`
somente no PowerShell, CI ou processo do CLI também não substitui a variável
do deployment. Depois de um push, confira os jobs registrados no backend.

Desligar crons não cancela funções já agendadas por `ctx.scheduler.runAfter`
ou `runAt`, nem impede actions chamadas diretamente. Este fluxo começa com
banco vazio e não importa snapshots de produção. Use fixtures sintéticas e
mocks dos testes existentes para emissão, webhooks e e-mail. Não coloque
certificados reais ou URLs de consumidores reais nesse banco local.
Ao parar o backend, nada roda nele; ao reiniciá-lo, tarefas pendentes podem
retomar. Para descartar também essas tarefas, remova o worktree e seu banco.

O workflow `Deploy production` publica atualizações após o CI de cada push
na `main`; `bootstrap` continua manual. O corte histórico não se repete nas
atualizações. Consulte [DEPLOY](operacao/deploy-producao.md).
Os scripts de worktree não criam previews de nuvem nem alteram defaults remotos.
Se previews forem introduzidos, configure **antes do primeiro preview** o
default de projeto `FNFE_CRONS=off` para o tipo `preview`, confira o primeiro
push e preveja sua remoção no fechamento da PR. O default só atende novos
deployments; previews existentes precisam de tratamento próprio. Nunca
aplique esse default ao tipo `prod` para resolver consumo de previews.

## Diagnosticar e limpar

### Estado e espera da preparação

```powershell
bun run worktree status --json
bun run worktree wait --timeout-ms 600000 --json
```

Os comandos funcionam sem subir serviços. `status` separa a operação atual, o
resultado do último setup e a presença de configuração. O JSON tem `version: 1`
e não inclui credenciais, variáveis de ambiente nem linhas de comando.
`configuration: present` significa apenas que o descritor local existe.

`wait` aguarda a preparação observada ou a primeira que aparecer quando ainda
não existe recibo. O prazo padrão é dez minutos. Sucesso sai com código 0;
falha, interrupção ou estado indeterminado, com 1; timeout, com 2. O timeout
encerra somente a espera. Não repete instalação, não apaga locks e não para
o processo de setup. Uma execução que substitui a observada exige nova consulta.

Um setup novo em andamento prevalece sobre o resultado anterior. Quando nenhum
setup está em andamento, o resultado terminal descreve a última execução, não
uma operação que o editor ainda não iniciou. Ambientes antigos sem recibo
aparecem como `unobserved`; continuam utilizáveis pelo `dev`, sem afirmar um
sucesso histórico. Execute setup para produzir o primeiro recibo, quando necessário.

`bun run dev` aguarda um setup que já esteja em execução, relê o aplicativo e
adquire a exclusão antes de iniciar os serviços. Se o editor ainda não iniciou
o primeiro setup, use `worktree wait`. O dev mantém o reparo de URLs locais;
não exige o `doctor` inteiro como pré-condição.

Os locks identificam a execução e o processo. Um arquivo incompleto ou uma
identidade que não pôde ser conferida é indeterminado. Um dono morto deixa uma
execução interrompida; nenhum comando recupera o lock por conta própria, pois
apagar depois de ler poderia remover o lock de outro processo concorrente.

Um `dev` encerrado à força (no Windows, `taskkill /F` ou o terminal fechado)
deixa o lock assim. `bun run worktree:cleanup` encerra os filhos que esse dev
registrou, pela identidade, apaga o registro e libera o lock, só se ele ainda
for o mesmo e o dono continuar morto. Um dono vivo ou de identidade ilegível
mantém o lock. Para outra operação interrompida, confira os processos e os
terminais do worktree, interrompa qualquer reinício automático e remova
somente `.convex/worktree-operation.lock` deste checkout
depois de confirmar que nenhum executor da operação continua vivo. Preserve
`worktree-setup.json` como diagnóstico; o próximo setup substitui seu resultado.

### Formatador e linter num worktree dentro do checkout principal

Um worktree criado dentro de outro checkout, como os de
`.claude/worktrees/` que os subagentes do Claude Code criam no checkout
principal, recebia de `vp fmt --check` um resultado diferente do CI para o
mesmo commit. Em 27/10/2026, `apps/console/src/issuances.test.tsx` falhou ali
e passou num worktree fora do checkout, com o mesmo lockfile (#570).

A causa era a resolução da ferramenta. O vite-plus procura `oxfmt`, `oxlint`
e `oxlint-tsgolint` a partir do diretório atual antes de usar a própria cópia,
e o Node sobe pelos diretórios pais. O linker isolado do Bun só põe no
`node_modules` da raiz o que o manifest declara, então a busca saía do
worktree e encontrava o `oxfmt` do checkout de fora, de outra versão. Desde a
correção, `package.json` declara as três ferramentas na versão exata exigida
pelo vite-plus, e a busca para no próprio checkout;
`tests/ci.toolchain.test.ts` falha quando a versão fixada diverge da que o
vite-plus instalado exige. Ao atualizar o vite-plus, atualize as três junto.

Um worktree com o `node_modules` desatualizado ou sem instalação continua
sujeito a resolver ferramentas de fora. Se o formatador local discordar do
`Validate` da PR, rode `vp install --frozen-lockfile` e confira de novo; não
reformate um arquivo que você não alterou só para agradar o formatador local.

### Configuração e processos

No perfil `platform`, o setup também gera `FNFE_PLATFORM_CERT_KEYS`, com chave
versionada exclusiva para o [cofre de certificados](plataforma/CERTIFICATES.md).
Certificados usados em worktree continuam exclusivamente sintéticos.

No perfil `platform`, o setup gera `FNFE_WEBHOOK_MASTER_KEY` exclusiva deste
banco local. Ela cifra os segredos de destinos e não deve ser reutilizada
em outro deployment. O transporte permanece `WEBHOOK_MODE=disabled`.
O ensaio controlado da entrega de webhooks habilita HTTPS temporariamente, apenas para seu
receptor sintético, e restaura o gate ao terminar. Veja
[o contrato e runner](plataforma/WEBHOOKS.md).

```powershell
bun run worktree list
bun run worktree doctor
bun run worktree:cleanup
```

`doctor` confere deployment, URLs, runtime, configuração local de segurança e
arquivos ignorados. Ele examina os arquivos locais, não substitui a inspeção
dos crons registrados no backend. `cleanup` confere a identidade do processo
(criação e comando) antes de encerrar os PIDs da sessão e os
executores Node do caminho exclusivo daquele worktree. Nunca encerre processos
por nome genérico ou pela porta de outro checkout.

O backend local do Convex pode sobreviver ao comando que o iniciou:
`convex dev --once --skip-push` sai com sucesso e o deixa vivo, e um dev morto
sem limpeza (SIGKILL no terminal ou no agente) deixa o backend órfão na porta
reservada. Por isso setup, sync, dev e cleanup encerram, antes de reservar as
portas e depois de cada etapa, os `convex-local-backend` cujo `--local-storage`
fica dentro do banco deste worktree (`platform/.convex/local/`, ou
`.convex/local/` num worktree antigo do legado). Backends de outros worktrees ou projetos não casam com esse
diretório e ficam intactos. O cleanup não faz essa varredura enquanto um setup
ou sync do mesmo worktree está em andamento. `bun run dev` repassa SIGINT,
SIGTERM e SIGHUP à sessão, então parar só o processo de topo também encerra
Convex e Vite.

Os comandos locais de ambiente do Convex, `env list`, `env set` e `env remove`,
têm limite de 30 segundos. Se o backend sair durante o bootstrap, a espera
termina com erro e o bloco de limpeza pode encerrar o backend temporário.
O limite não se aplica à instalação de dependências, ao build ou ao watcher.
Espere o comando terminar antes de repetir `dev`; timeout não comprova que
uma escrita anterior deixou de ser aplicada.

De outro checkout, remova com `bun run worktree remove <nome>`.
Setup, sync ou dev ativos impedem a remoção, inclusive com `--force`.
Execute `worktree:cleanup` e aguarde o terminal de dev terminar antes de remover.
Registros antigos sem identidade exigem verificar o processo manualmente;
o cleanup recusa encerrar um PID cuja identidade não consegue confirmar.
Alterações pendentes impedem a remoção; `--force` as descarta e só deve ser usado
quando esse descarte for desejado. A branch fica, salvo `--delete-branch`.
O comando recusa junções/symlinks em `node_modules` e `.convex`. Desfaça a
ligação sem seguir o destino antes de remover um checkout antigo desse tipo.

Use diretórios sob controle do seu usuário, sem escrita por terceiros não
confiáveis. A cópia de includes rejeita links que escapam do worktree, mas não
é uma sandbox contra outro processo que troca diretórios durante a cópia.
Os scripts e a instalação de dependências também executam código desse checkout.

Para limpeza em lote, comece com `bun run worktree prune --dry-run`.
O prune atualiza `origin` com `fetch --prune` e aborta se o fetch falhar;
`--no-fetch` aceita o estado local de propósito. Preserva worktrees sujos,
com operação ativa, destacados, da branch base ou do próprio comando.
Se os commits são ancestrais da base, pode apagar a branch junto. Se apenas
o upstream sumiu, remove o ambiente e mantém a branch com seus commits.
`--keep-branch` conserva todas as branches; não há `--force` no prune.
Worktrees sem commits próprios também contam como integrados, exceto nos
primeiros sete dias sem branch publicada: o editor cria o worktree na ponta da
base, e até o primeiro commit uma tarefa recém-começada é indistinguível de
uma integrada. Ter a própria base como upstream, como faz `git worktree add -b
x origin/main`, não conta como publicar. A idade vem do arquivo `.git` do
worktree. O `finish` aplica as mesmas regras ao próprio checkout e recusa a
branch base.

### Propriedade e encerramento dos processos

O registro de dev (`worktree-dev-process.json`) guarda PID e identidade
(criação e comando) de cada filho, além de uma geração (`recordId`). O dev grava o
backend assim que o cria e acrescenta o frontend antes de esperar a prontidão
dele. Se uma parada falhar no startup, o registro continua com os dois filhos,
e um `cleanup` posterior repete a parada. O registro só sai depois que todos
os filhos registrados terminam. Quem remove compara a geração e preserva um
registro substituto, mesmo que ele reutilize o PID. Um registro antigo, sem
geração, só é apagado se ainda for idêntico ao lido, sob o lock do cleanup.
Uma falha num PID não impede a tentativa nos demais; o erro volta no final.

Em Linux e macOS, setup e sync (backend temporário), o Convex do dev e o
frontend nascem sob um supervisor Node privado (`posix-group-owner.mjs`). Ele
lidera a própria sessão e grupo, criados pelo `spawn` com
[`detached`](https://nodejs.org/api/child_process.html#optionsdetached), e os
descendentes que não criam outra sessão herdam esse grupo. Quando recebe TERM,
INT ou HUP, ou quando o CLI sai, o supervisor manda TERM ao próprio grupo. Se o
grupo esvaziar em até 500 ms, ele sai com o mesmo código ou sinal do CLI, e
quem espera o processo vê o desfecho real; senão, manda KILL ao grupo, que o
inclui. Por continuar vivo até o último sinal, o PGID não pode ter sido
reciclado. Um CLI que sai deixando descendentes, como uma folha que ignora TERM
e segura uma porta, não deixa mais a porta presa.

A parada externa revalida a identidade e manda TERM só ao líder; nunca sinaliza
um PGID guardado. Depois espera até 10 segundos pelo grupo consultando apenas
PGID e estado no `ps -g` (sessão no Linux, grupo no macOS, com o PGID filtrado
explicitamente). Zumbis não contam. Um grupo que continua com processos ativos,
ou uma sonda que falha, gera erro e preserva o registro, sem sinal adicional.
No Windows os filhos são criados como antes e param por identidade e
`taskkill /T`.

Limites. Um descendente que crie a própria sessão escapa do grupo; isto não é um
gerenciador geral de processos. Um SIGKILL externo no supervisor pode exigir
limpeza manual, e o cleanup não adota grupos antigos nem procura processos por
nome. O comportamento POSIX foi provado só em Linux; macOS usa o mesmo
contrato de `ps -g` e de grupos, sem execução real registrada.

O backend temporário de setup e sync carrega o preload privado
`bootstrap-parent.mjs`. O entrypoint do CLI do Convex 1.48 chama
`process.exit()` ao concluir `--skip-push`, o que no Windows derrubou o backend
logo depois de ele responder. O preload anula só a saída com sucesso desse
subprocesso; erros continuam encerrando, e sem filho vivo o CLI sai sozinho. Ele
recusa carregar sem `--skip-push`. Ao atualizar o Convex, confira se o
entrypoint ainda precisa dele. Enquanto o backend sobe, um JSON parcial no
descritor de configuração conta como "ainda não pronto" e a leitura se repete no
mesmo prazo; outro erro de configuração falha na hora.

`dev()` aceita, por API, `signal` (`AbortSignal`) e `onReady`. Com `signal`, o
cancelamento substitui os handlers de SIGINT e SIGTERM do processo. No startup,
ele espera a etapa em curso terminar e não inicia filhos novos.

A prova real fica em `tests/worktreeProcesses.test.ts`, casos `grupo próprio e
porta real`: um CLI sintético cria uma folha que ignora TERM e segura uma porta.
Com supervisor, a porta fica livre depois do cleanup, com o CLI vivo ou já
encerrado, e um registro com identidade antiga não derruba o substituto. No
controle sem supervisor, o cleanup recusa declarar sucesso. Em 01/11/2026, no
Linux (`node:24.22.1-bookworm` em Docker, kernel 6.6 WSL2, Bun 1.4.0), os 59
testes de processos e sessão de worktree passaram. Trocar `spawnOwnedProcess`
por `spawn` direto reprovou os casos `alive` e `exited` com "O grupo … ainda
possui processos"; restaurado o arquivo (mesmo SHA-256), os oito casos do arquivo voltaram
a passar. No Windows os casos POSIX são pulados. Para repetir num Linux ou
macOS preparado:
`VITEST_MAX_WORKERS=2 vp test run tests/worktreeProcesses.test.ts`.

## T3 Code

Importe as ações de `t3.json` nas configurações do projeto e reimporte depois
de atualizar o catálogo. `Validar alterações` chama `ci:local`; `Provar commit`
chama `ci:prove`. `Estado do worktree` consulta a preparação e `Aguardar setup`
espera seu resultado com prazo. Os atalhos de testes e tipos continuam disponíveis.
`Setup worktree` tem `runOnWorktreeCreate`, mas pode continuar rodando enquanto
o primeiro turno do agente já começou. Use `worktree wait` para aguardar o
resultado sem repetir setup. O lock por worktree recusa operações concorrentes.
O comando versionado é `bun run worktree:setup`, sem `--app`, e prepara a
plataforma.
`Concluir worktree` roda `worktree:finish` depois do merge.
Threads antigas precisam de setup manual, e mudanças nas ações exigem nova
importação. O arquivo omite preview fixo: use a URL que o dev imprime, para
verificar a mudança no worktree correto.

## Origem e validação

Os scripts foram adaptados de outro projeto do mantenedor. As decisões operacionais estão descritas
a seguir e implementadas neste repositório.
As regras de isolamento são locais e não dependem do histórico de outro projeto:

- Um checkout, banco Convex local, conjunto de portas e dependências por trabalho.
- Crons desligados em ambientes efêmeros; remover previews sem uso.
- Prune distingue código integrado de uma branch remota apenas apagada.
- Seed versionado e adequado ao domínio. Aqui não há seed; `sync` só publica funções.
- Credenciais locais geradas, sem senha fixa no código.
- Aguardar o setup automático do editor antes de iniciar outra operação.

Os três jobs diários usam agora `crons.cron`, conforme as guidelines, com os mesmos horários UTC.

Execute `bun run -- vp test run` para testes de backend, crons, configuração,
locks, portas e decisões de prune. `bun run -- tsc --noEmit` confere os tipos.
Antes de alterar o ciclo de vida, valide também com dois worktrees descartáveis
reais: setup, dev simultâneo, URLs e bancos distintos, zero crons, cleanup de
um preservando o outro, remoção e liberação das reservas.

Na importação de 09/09/2026, o ensaio no Windows usou Bun 1.4.0,
Node 20.20.2 e Convex 1.45.0 instalado pelo lockfile. Dois frontends
responderam HTTP 200 simultaneamente em 5174/5175, com backends em
3210/3211 e 3212/3213. A consulta de sistema `_system/frontend/listCronJobs`
retornou `[]` em ambos. Uma mutation criou estado de manutenção no banco A;
o banco B permaneceu vazio. O cleanup de A fechou suas três portas e B
continuou respondendo. Um terceiro worktree reutilizou as portas liberadas.
Não houve publicação em deployment remoto.
