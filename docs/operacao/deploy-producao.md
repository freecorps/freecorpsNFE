# Publicação da plataforma

A decisão de transição substitui o backend/backoffice
legado por `platform/convex` e `apps/console`, com Better Auth e banco vazio.
O destino continua sendo `elated-possum-295` e o Worker
`freecorpsnfe-backoffice`, em `https://nfe.freecorps.com.br`; o mesmo Worker
atende a API em `https://api.nfe.freecorps.com.br`.

A configuração publicada é gerada por `releaseWorker`
(`scripts/lib/platform-release.mjs`), com `deploy/selfhost/worker.ts`. Os
assets usam `not_found_handling: "none"`: o Worker responde aos endereços sem
arquivo pelas regras de `apps/console/asset-fallback.ts` (rotas do painel,
não encontrado da documentação e 404 sem cache), descritas em
[PUBLIC.md](../plataforma/PUBLIC.md#endereços-ausentes-favicon-e-cache). O
backoffice legado e seu Worker de dry-run saíram do repositório na #345. Dois
outros alvos ficam fora deste pipeline: a [produção fiscal da NFS-e](#segundo-alvo-produção-fiscal-da-nfs-e),
com workflow, script e Worker próprios, e o Worker das caixas de e-mail,
publicado à mão com `bun run deploy:mail` ([ativação](privacidade-email.md#ativação)).
`bun run build` compila a plataforma e o console.

O workflow `Deploy production` publica uma atualização a cada push na `main`.
A validação é o `Validate` da PR; o push não roda o CI de novo
([CI](../desenvolvimento/ci.md#produção-sem-nova-validação)). Backend e
frontend recebem o mesmo SHA.
A limpeza inicial não faz parte do deploy e nunca se repete em um retry.

Um push que não muda nada do que é publicado termina depois do preflight,
sem build e sem escrita, com recibo `state: "unchanged"` e `publishedSha`. A
comparação parte da revisão que backend (`/health`), frontend (`/build.json`)
e API dizem servir, não do commit anterior: pushes pulados em sequência se
acumulam. Só pulam os caminhos de `undeployedPaths`
(`scripts/lib/platform-unchanged.mjs`): testes, CI, agentes, `docs/` fora de
`docs/v1.0/` e os Markdown de colaboração da raiz. Mover um arquivo publicado
para um deles também publica, porque os dois lados da renomeação contam. Na
dúvida, publica: serviços com SHAs diferentes, revisão publicada que não é
ancestral do commit, histórico ausente, mais de 300 arquivos ou
`/health` sem resposta. O preflight continua conferindo o ambiente de
produção a cada push. Só o `release` automático de push pula; um
`workflow_dispatch`, o `--operator` e o `bootstrap` sempre publicam. O
environment `production` do GitHub registra o job como sucesso mesmo quando
pula; o SHA servido é o de `publishedSha`. O pipeline continua sequencial
(build, backend, frontend): a publicação inteira leva cerca de 30 s, e
rodar o build ao lado do push do Convex trocaria uma falha sem efeito por um
estado parcial para ganhar poucos segundos.

## Revisão do dono

Antes do build, o preflight do `release` e do `bootstrap` confere os
commits entre a revisão que a produção serve e o novo SHA
(`scripts/lib/owner-review.mjs`, ADR 0007, decisões de 26/10/2026). Desde
a decisão do dono do projeto de 26/10/2026, o `.github/CODEOWNERS` tem um
dono só, o dono do projeto, até ele decidir outra coisa. Cada commit que
toque um caminho do `CODEOWNERS`, na versão publicada ou na nova, precisa
de uma destas aprovações:

- **Dispatch do dono.** O `workflow_dispatch` do `Deploy production`,
  disparado por um dono, aprova o SHA inteiro, inclusive os commits de que
  ele é autor: o dispatch é o passo humano de aprovação. Quem repete
  (_re-run_) o dispatch de outra pessoa não herda a aprovação: o gate exige
  `GITHUB_TRIGGERING_ACTOR` igual a `GITHUB_ACTOR` e, sem um dos dois, não
  conta o dispatch. O gate só sabe que o dispatch saiu da conta do dono: os
  agentes usam o `gh` com a conta do dono, e por isso nenhum
  agente dispara o `Deploy production`.
- **PR aprovada.** O commit é de uma PR mesclada na `main` com revisão
  `APPROVED` de um dono do caminho, no último commit da PR, por alguém que
  não é o autor da PR nem do commit. Um push depois da aprovação a invalida.
  Com um dono só, que também é o autor dos commits, este caminho não passa;
  fica para quando houver outro dono.

O job `Owner review` do `deploy.yml` antecipa esse gate
(`scripts/owner-review-check.mjs`, #51). Ele roda sem environment nem
secrets, só com o `GITHUB_TOKEN` de leitura, e o `Publish production`
depende dele: um commit sem aprovação reprova a publicação em segundos,
antes do environment de produção. O
preflight do publicador continua chamando o mesmo gate
(`scripts/lib/owner-review-gate.mjs`), contra a revisão servida no momento da
publicação; o job antecipado não substitui essa conferência.

Se a produção serve uma revisão que não existe neste histórico, como a do
repositório arquivado antes da virada de 03/11/2026, o gate não tem a faixa
para conferir. A revisão publicada conta então como desconhecida: só o
dispatch de um dono publica, e o log diz `production serves <sha>, outside
this history`. Depois da primeira publicação feita daqui, a faixa volta a ser
conferida normalmente.

Um push na `main` não aprova nada. Um merge que traga um commit protegido
falha em `failed-before-publication`, nada é publicado e o log nomeia o
commit, os caminhos e o autor. Os pushes seguintes também falham, porque a
faixa parte da revisão publicada. Para publicar, o dono revisa os
commits nomeados e dispara o `Deploy production` com `operation: release`, o
SHA da `main` e o hash do plano. Até lá, a mudança está na `main`, mas não
em produção.

Nos dois caminhos, só aprova quem é dono do caminho em cada versão do
`CODEOWNERS` que o protege. Um caminho protegido em qualquer das duas
continua protegido, mas quem se põe como dono no próprio commit não se
aprova, e quem a faixa tira do arquivo, como o outro sócio na troca de
26/10/2026, deixa de aprovar na publicação que traz essa troca, por PR ou
por dispatch: a aprovação é conferida contra o `CODEOWNERS` do SHA
publicado e o do SHA novo.

Isso tem um efeito: trocar o dono de um caminho numa publicação só bloqueia
todo commit da faixa que toque esse caminho, porque ninguém é dono dele nas
duas versões. A troca se faz em duas publicações: primeiro somar o novo dono
ao antigo e publicar, depois tirar o antigo.

O gate também recusa quando a revisão publicada não é ancestral do novo SHA,
quando o `CODEOWNERS` dela não pode ser lido (mesmo com o dispatch do dono;
o publicador não troca o arquivo publicado pelo novo), e quando ela é
desconhecida (serviços com SHAs diferentes ou `/health` sem resposta). Com
a revisão publicada desconhecida, o dispatch de um dono publica mesmo assim,
e este é um limite conhecido: sem revisão anterior, o gate lê só o
`CODEOWNERS` do SHA novo e não confere commit a commit, então quem esse
arquivo lista como dono publica tudo o que veio desde a última revisão
conhecida. Desde a
[#525](https://github.com/freecorps/freecorpsNFE-arquivo/issues/525), o `bootstrap`
pelo workflow passa pelo gate como o `release`; depois de um reset a
revisão publicada costuma ser desconhecida, e então só o dispatch de um dono
publica. O `--operator`, rodado localmente com as credenciais de produção,
não passa pelo gate: é outro limite conhecido. O log do run
registra a PR ou o dispatch e o aprovador de cada commit protegido.

O limite é conhecido: o gate roda na versão do workflow que chegou à `main`.
Um commit sem revisão que altere o gate o desliga na publicação seguinte, e
um workflow alterado vale desde o merge, sem publicação.

O `CODEOWNERS` cobre o publicador, os scripts de build que ele executa e os
módulos que os três importam: rodam no mesmo runner e com o mesmo usuário do
processo que guarda as chaves, e o filtro de ambiente dos subprocessos não é
sandbox. `scripts/owner-review.test.ts` falha se um módulo desse grafo ficar
sem dono. As dependências também rodam no build, e as CLIs do Convex e do
wrangler recebem as chaves: `bun.lock` e o `package.json` da raiz e de cada
workspace também têm dono, e uma atualização de dependência precisa da
aprovação do dono como qualquer caminho protegido.

## Configuração

| Tipo     | Nome                    | Uso                                       |
| -------- | ----------------------- | ----------------------------------------- |
| Secret   | `CONVEX_DEPLOY_KEY`     | Chave do backend `prod:elated-possum-295` |
| Secret   | `CLOUDFLARE_API_TOKEN`  | Publicação do Worker na conta aprovada    |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Conta já registrada no plano              |

As credenciais existentes podem ser reutilizadas. A variável
`VITE_CLERK_PUBLISHABLE_KEY`, do legado, saiu do repositório em 03/11/2026,
e o build do console a recusa (`consoleEnvironment`). Better Auth, proxy assinado e e-mail são
configurados no backend e no Worker conforme [instalacao-propria.md](instalacao-propria.md).
O segredo `AUTH_PROXY_SECRET` precisa ser igual nos dois serviços.
O workflow não cria contas humanas nem configura secrets. A operação
`bootstrap` cria somente a sonda sintética de persistência, de forma idempotente,
e, como o `release`, chama o aviso dos termos de uso descrito abaixo.

O perfil hospedado é sandbox com transporte fiscal desativado e crons
desligados. A exceção é a captura de NF-e das empresas que a ligaram no
console (ADR 0007): com `FNFE_CAPTURE_FISCAL=enabled` e
`FNFE_CAPTURE_TRANSPORT=sefaz` no deployment, ela consulta a produção fiscal,
agendada por stream e sem cron; o preflight aceita `FNFE_CAPTURE_TRANSPORT`
vazio, `disabled` ou `sefaz` e não grava nenhuma das duas. Ligar, desligar e
conferir estão em [captura-fiscal.md](captura-fiscal.md). O corte foi
publicado com webhooks desativados; a ativação posterior está registrada
abaixo. O tipo `prod` do Convex não altera o ambiente sandbox do produto.

Atualização operacional de 07/10/2026: por autorização do mantenedor,
`WEBHOOK_MODE` foi alterado para `https` em `elated-possum-295`, para continuar
o piloto acompanhado. Fiscal permanece desativado e crons permanecem desligados.
O recibo identifica
o SHA publicado e a releitura das variáveis. O mantenedor confirmou HTTP 204
no piloto e a leitura do receptor
confirmou eventos e conteúdo documental persistidos. A
conferência posterior comprovou
o reenvio duplicado sem novo efeito no receptor e a publicação `79f2d08`
com `WEBHOOK_MODE=https`, recibo validado e sonda de persistência preservada.
Na mesma data, o mantenedor autorizou o merge da PR #168 mantendo os webhooks
ativados. O preflight de `scripts/deploy-platform.mjs` exige `https` na operação
`release` e conserva `disabled` somente no `bootstrap`. Ele verifica a configuração
existente, sem alterar variáveis do backend. As atualizações preservam esse envio;
fiscal desativado, sandbox e crons desligados continuam obrigatórios. Após publicar,
conferir `WEBHOOK_MODE=https` no deployment e os SHAs dos dois serviços.

A prova da emissão NFS-e em produção restrita (fase 3, #197) abre, por janela
autorizada pelo mantenedor, `FNFE_NFSE_SANDBOX_TRANSPORT=producao-restrita` e
`FNFE_NFSE_RESTRICTED_COMPANIES` só com a empresa da prova, sem tocar
`FISCAL_ENV`, `PRODUCT_ENV` nem crons. O preflight não confere essas duas
variáveis: publicações durante a janela as preservam. Passos, evidência e
reversão no [runbook](emissao-nfse.md).
Até a janela ser aberta e registrada, as duas ficam ausentes.

O preflight também recusa `FNFE_ISSUANCE_ENV`,
`FNFE_NFSE_PRODUCTION_COMPANIES` e `FNFE_FISCAL_PROOF`, com qualquer valor, e
aceita `FNFE_CAPTURE_TRANSPORT` só ausente, `disabled` ou `sefaz`, o adaptador
da [captura fiscal no site](../plataforma/CAPTURE.md#liberação-fiscal-no-site).
Publicar preserva `FNFE_CAPTURE_FISCAL`, `FNFE_CAPTURE_TRANSPORT` e
`FNFE_CAPTURE_ALERT_EMAIL`, o endereço dos
[alertas da captura](../plataforma/CAPTURE.md#supervisão-e-alertas-422); o
`/health` informa `captureFiscal`. O smoke recusa um
`/health` do backend ou da API pública cujo `issuanceEnv` não seja `disabled`
e, na API, também `productEnv` ou `fiscalEnv` fora do sandbox. O deployment
hospedado nunca é a produção fiscal da emissão NFS-e. `APP_ENV=installation`
deixou de significar só este sandbox: o deployment de produção fiscal da
emissão, quando existir, usa o mesmo perfil, com `PRODUCT_ENV=production` e o
marcador ([ISSUANCE.md](../plataforma/ISSUANCE.md#deployment-de-produção-fiscal)).

## Atualizações automáticas

O merge de uma PR na `main` dispara o workflow. Depois da revisão do dono, o
job `publish` publica o checkout exato do push, sem rodar o CI de novo: a
validação foi o `Validate` da PR. O plano é `deploy/platform-release.json` daquele
commit, com SHA-256 calculado no runner e recibos conferidos pelo publicador.
Cada publicação inclui todos os merges que pertencem ao commit publicado.
Não é preciso publicar PRs antigas uma por uma.

O plano separa o destino, conferido em toda publicação, do bloco
`installation`, o registro imutável da primeira instalação: estratégia
`replace-legacy-empty`, decisões do corte e recibos `legacyReset`,
`consumerTransition` e `authBootstrap`, com caminho e SHA-256. Esse bloco é
história; uma atualização não o altera nem acrescenta aceites a ele. A única
exceção é um novo reset (#525): o commit que o registra tira o recibo
`authBootstrap` e troca `legacyReset` e `consumerTransition` pelos recibos
versionados do novo corte. Só então o `bootstrap` volta a valer, e esse
commit toca `deploy/`, que passa pela [revisão do dono](#revisão-do-dono).

Em 03/11/2026 o bloco passou a apontar cópias sanitizadas dos três recibos,
em `docs/v1.0/evidence/84/publico/`, as únicas da pasta de recibos que vão
para o repositório público (decisão 6 de [ACCEPTANCE.md](../v1.0/ACCEPTANCE.md)).
Cada cópia registra em `sanitizedFrom` o SHA-256 do original, que continua no
repositório arquivado, e o gate da pausa do app consumidor passou a se chamar
`consumerTransition`. Os resultados registrados não mudaram.

Push aceita somente a operação `release` (`releasePreconditions`): exige a
instalação concluída, com os três recibos íntegros, e a sonda persistente;
preserva dados e não cria contas. A cada atualização valem destino,
credenciais, SHA aprovado, hash do plano, ambiente do backend,
concorrência, sonda antes e depois e smoke. `bootstrap`
(`bootstrapPreconditions`) exige os dois recibos do corte, recusa a
instalação concluída, com `authBootstrap`, e continua exclusivamente manual
(#525). Antes do build, passa pela [revisão do dono](#revisão-do-dono) como
o `release`. As credenciais e o environment `production` são os
mesmos do fluxo manual; uma proteção de aprovação configurada no GitHub ainda
pode exigir liberação do mantenedor.

O grupo `production` permite um publicador por vez e não cancela uma atualização
em andamento. Antes da primeira escrita, o script verifica se o SHA ainda é a
ponta da `main`; um candidato ultrapassado termina como `obsolete`, sem publicar.
Depois de iniciar, termina backend, frontend e verificações do mesmo SHA.
Conferir o recibo: CI verde isolado não significa publicação concluída.

Para verificar, comparar `sha` em `https://nfe.freecorps.com.br/build.json`,
`https://api.nfe.freecorps.com.br/health` e
`https://elated-possum-295.convex.site/health` com o commit do workflow. O recibo
`platform-release-<run>-<attempt>` deve registrar `state: validated` e a mesma
sonda antes/depois. Não basta o merge: o workflow precisa terminar com sucesso.

Depois que a revisão serve, inclusive sem mudança publicada e no bootstrap, o
publicador chama `termsOfUseNotice:start`, o aviso por e-mail de versão nova
dos termos de uso ([ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md#termos-de-uso)),
e grava o desfecho em `termsOfUseNotice` no recibo (`none`, `disabled`,
`started`, `resumed`, `done` ou `failed`). `failed` não reprova a publicação
nem a desfaz: a próxima publicação chama de novo, e a chamada é idempotente.

O smoke da plataforma consulta backend, frontend e API até seis vezes, com três
segundos entre leituras, somente quando uma revisão válida ainda difere do
SHA esperado. Não repete o deploy. HTTP inválido, timeout, ambiente incorreto,
HTML/CSP inválidos e falha na leitura de crons interrompem a verificação.
O recibo parcial identifica fase, serviço, código, status HTTP e revisões
quando disponíveis, sem copiar respostas remotas ou credenciais. A leitura
final da sonda pertence à fase `persistence`, inclusive no bootstrap.

Em caso de `partial`, conferir o diagnóstico e os dois SHAs públicos antes
de reexecutar. `SHA_MISMATCH` após as seis leituras continua sendo falha;
`UNKNOWN` não é aprovação nem evidência de perda de dados. A recuperação da
falha da #51 está em evidence/51-publication.
O smoke do workflow verifica publicação e sonda; login e consultas com a
sessão humana precisam de evidência própria após publicar.
Passos manuais pós-publicação de uma entrega ficam no roteiro do domínio. A
primeira publicação da coleta de originais de e-mail sem dono (#341) exige
liberar a retenção inicial, no [passo 8 da ativação](privacidade-email.md#ativação).

### Domínio novo do Worker

Um domínio acrescentado às `routes` de `releaseWorker` só passa a existir
durante o próprio deploy. O runner self-hosted usado anteriormente podia guardar a resposta
NXDOMAIN de uma consulta anterior à criação por até 1800 s, o TTL negativo da
zona `freecorps.com.br`. Como o smoke não repete falhas de transporte, o
primeiro deploy termina `partial` com `phase: "revision"`, o serviço do domínio
e `code: "UNAVAILABLE"` sem `httpStatus`. Foi o que ocorreu com
`api.nfe.freecorps.com.br` na #171.

Para evitar a falha, crie o domínio personalizado no Worker pelo painel da
Cloudflare antes do merge e confirme no runner que o nome resolve
(`getent hosts <domínio>`). Se a falha já ocorreu, confira o `sha` do domínio
por outra rede e reexecute o job com `gh run rerun <run> --failed` depois de
30 minutos.

### Web Analytics da Cloudflare

A coleta de métricas da Cloudflare não é necessária neste ambiente (decisão
do mantenedor, #454). A injeção automática do Web Analytics está desligada
desde 24/10/2026 no site `freecorps.com.br` do painel, que cobre a zona
inteira, `nfe.freecorps.com.br` incluído: Web Analytics, **Manage site** e,
em automatic setup, **Disable**. O site não foi apagado. A CSP de
`public/_headers` não libera `static.cloudflareinsights.com` nem
`cloudflareinsights.com` e não deve ser afrouxada para isso: se a injeção for
religada, o navegador bloqueia o beacon e registra erro de CSP em cada
página. Para conferir, buscar `/`, `/login`, `/signup` e `/docs/` com user
agent de navegador e `Accept: text/html`; o HTML não pode conter
`cloudflareinsights`. O token OAuth do Wrangler não tem acesso à API
`rum/site_info`, que exige `Account Settings`; a mudança é feita no painel.

## Backup externo

O workflow `Offsite backup` lê a produção, mas não publica nada. A cada
12 horas, uma VM Blacksmith exporta `elated-possum-295` com uma chave de
deploy própria, guardada no environment `offsite-backup`, e envia a cópia
cifrada ao R2. Outra VM Blacksmith confere a cópia 90 minutos depois. Ele
usa o grupo de concorrência `offsite-backup-*`, nunca `production`, para não
cancelar uma publicação pendente. Um snapshot que coincide com uma publicação
falha e é repetido no ciclo seguinte. Configuração, alerta e recuperação estão
em [Backup externo](backup.md).

## Primeira instalação e reexecução manual

1. Executar o corte descrito em transicao-legado.md.
   A limpeza e a pausa do app consumidor estão registradas nos recibos da #84.
   O bloco `installation` de `deploy/platform-release.json` guarda seus hashes
   e o recibo da prova de login executada no endereço definitivo.
2. Registrar `legacyReset` e `consumerTransition` em `installation.receipts`,
   com caminho e hash dos recibos.
   Configurar ambiente e secrets Better Auth/proxy/e-mail. Para a primeira
   instalação, escolher operação `bootstrap`: ela publica os dois serviços e
   cria a sonda, sem exigir login ou funções da plataforma antes de publicá-las.
   O recibo termina em `awaiting-auth-proof`. Após provar o login no endereço
   final, registrar `authBootstrap`; as publicações seguintes usam `release`,
   exigindo os três recibos e a sonda prévia. Com `authBootstrap` registrado,
   o `bootstrap` é recusado antes do build; um novo reset exige antes um novo
   registro de instalação, sem `authBootstrap` e com os recibos do novo
   corte, que toca `deploy/` e passa pela revisão do dono.
3. Abrir `Deploy production` no GitHub Actions, escolher `main` e informar
   a operação, seu SHA completo e o SHA-256 do plano versionado. O workflow usa o
   environment `production`, que pode receber as proteções do mantenedor.
4. O CI valida o SHA. O script confere destino, credenciais, ambiente,
   evidências e elegibilidade; compila pacotes e console e faz dry-run do Worker.
5. Publica backend e console em sequência, no grupo `production`, sem
   cancelar uma publicação em andamento. Confere `/health`, `/build.json`,
   HTML, política CSP para o backend da instalação e preservação da sonda.
   O recibo identifica sucesso ou fase parcial.
6. Conferir login e autorização no endereço definitivo e o comportamento
   combinado com o app consumidor. Health/SHA não substitui essa jornada humana.

PRs continuam executando CI sem credenciais de produção. O workflow separado
`Deploy validation` publica o ambiente de validação só por disparo manual na
`main` ([deploy-validacao.md](deploy-validacao.md)); ele não é uma etapa da atualização
automática do endereço definitivo.
Os limites de runner estão em [runners e custo](../desenvolvimento/ci.md#runners-e-custo).

## Histórico do corte antes do merge principal

O mantenedor autorizou concluir a #84 com emissão indisponível e deixou a
escolha da branch de publicação ao executor. Enquanto a #54 estava em rascunho,
o corte usou um candidato integrado em `feat/fiscal-platform-v1`. O procedimento
abaixo registra essa transição; não deve ser repetido em atualizações da `main`.

Para essa exceção operacional, desabilitar o workflow `Deploy production`
no GitHub e conferir que não existe execução antiga em andamento. Ele deve
permanecer desabilitado enquanto a `main` ainda contiver o publicador legado.
Só reativar depois que a configuração nova estiver integrada na `main`.

Usar Node 24.22.1, a mesma versão do CI.
`node scripts/deploy-platform.mjs --operator` exige checkout limpo, SHA atual
da integração, `Deploy validation` aprovado para esse SHA, workflow antigo
desabilitado, plano com recibos e credenciais dos destinos fixos. Recebe
`RELEASE_APPROVED_SHA`, `RELEASE_PLAN_HASH` e `RELEASE_OPERATION` por ambiente,
junto das credenciais privadas. Executa o mesmo bootstrap/release e grava
no recibo a origem e o run conferidos. Não usar variáveis GitHub fictícias.

A limpeza foi separada e já terminou. `scripts/publish-maintenance.mjs`
publicou a aplicação temporária de manutenção de `deploy/cutover`, sem crons,
autenticação ou endpoints de negócio, e `scripts/reset-legacy.mjs` limpou o
backend antigo em lotes, com segredo descartável, manifesto de tabelas e
recibo `reset.json` emitido só com tabelas, storage e jobs vazios. Esses
executores, a aplicação de manutenção, `scripts/prove-cutover.mjs`,
`scripts/inventory-legacy.mjs` e a prova `tests/convex.cutover.test.ts` saíram
do repositório na #345 e ficam no histórico do Git. Os recibos `legacyReset`,
`consumerTransition` e `authBootstrap` continuam versionados e exigidos pelo
release.

Cada recibo integrado altera o candidato: repetir o CI do novo SHA antes do
bootstrap e, após a prova de login, antes do release. A manutenção termina
com o bootstrap; a emissão permanece desativada durante e após a prova de login.
Não restaurar o backend legado nesse intervalo.

## Segundo alvo: produção fiscal da NFS-e

O deployment de produção fiscal da emissão (#198,
[ADR 0004, §8](../adr/0004-motor-de-emissao-nfse.md#8-ambientes-e-gates)) é
um alvo separado do sandbox hospedado. Ele tem console e API em domínios
próprios, num Worker próprio. O `Deploy production` acima continua publicando
só o `elated-possum-295`: `deploy.yml`, `scripts/deploy-platform.mjs` e
`scripts/lib/platform-release.mjs` não leem o plano da produção fiscal (teste
em `scripts/issuance-release.test.ts`).

**Plano.** `deploy/issuance-production.json` nomeia o deployment (`deployment`
e `url`) e a publicação (`release`: `worker`, `accountId`, `frontend` e `api`).
Hoje os três valem `null`. `issuanceReleaseTarget`
(`scripts/lib/issuance-release.mjs`) recusa:

- deployment `null` (`PLAN_NOT_NAMED`);
- `release` `null` (`RELEASE_NOT_PLANNED`);
- o Worker ou os domínios do sandbox, o console da validação e domínios
  do provedor (`*.convex.cloud`, `*.convex.site`, `*.workers.dev`)
  (`RELEASE_INVALID`).

**Workflow.** `Deploy NFS-e fiscal production`
(`.github/workflows/deploy-issuance-production.yml`) roda só por
`workflow_dispatch` na `main`, com `approved_sha`, nunca em push:

1. o job `plan`, sem segredo, roda `scripts/deploy-issuance-production.mjs
   plan`; com o plano de hoje, falha com `PLAN_NOT_NAMED` e o motivo, e a CI e
   a publicação nem começam;
2. a CI (`ci.yml`) valida o SHA aprovado;
3. o job `publish`, no environment `nfse-production-release`, roda
   `scripts/deploy-issuance-production.mjs publish`, com os segredos
   `FNFE_ISSUANCE_DEPLOY_KEY` e `FNFE_ISSUANCE_CLOUDFLARE_API_TOKEN`, a
   variável `CLOUDFLARE_ACCOUNT_ID` e o `github.token`, só com
   `contents: read` e `actions: read`, para ler as aprovações do run.

**Publicação.** Na ordem:

1. **Run e aprovação**, antes de qualquer uso da chave de deploy. O run e
   `/actions/runs/{id}/approvals` vêm da API do GitHub e passam pelo mesmo
   `verifiedRun` do `nfse-gate-enable.yml` (`scripts/lib/issuance-gate.mjs`),
   com `RELEASE_WORKFLOWS` (`scripts/lib/issuance-release.mjs`): o próprio
   workflow, na `main`, por dispatch, em andamento, no SHA do run, e uma única
   aprovação em `nfse-production-release` de alguém em `authorizedActors` de
   `deploy/issuance-gate.json` que não é `triggering_actor` nem `actor`. Sem
   aprovação, `APPROVAL_MISSING`; aprovador igual a quem disparou,
   `APPROVER_INVALID`; fora da lista, `APPROVER_NOT_AUTHORIZED`. Só a primeira
   tentativa do run publica (`RUN_ATTEMPT_REFUSED`): se a CI falhar, dispare
   de novo. O operador e o aprovador vão ao recibo.
2. **Revisão e credenciais.** A revisão precisa ser a aprovada e testada, na
   `main`, com o checkout limpo: o `HEAD` publicado é igual a
   `approved_sha`, ao SHA testado pela CI e ao `GITHUB_SHA` do run, que a API
   confirmou no passo anterior. A chave é a do deployment do plano e a conta
   Cloudflare é a do plano.
3. **Preflight do ambiente** (`issuanceReleaseEnvironment`):
   - `APP_ENV=installation`, `PRODUCT_ENV=production`, `FISCAL_ENV=disabled`,
     `FNFE_CRONS=off`, `FNFE_ISSUANCE_ENV=production` e `WEBHOOK_MODE=https`;
   - `SITE_URL` e `API_URL` com os domínios do plano e
     `AUTH_PROXY_MODE=signed`;
   - nenhuma variável do sandbox ou das provas de captura;
   - a política de contas e `BETTER_AUTH_SECRET`.
4. **Build.** Pacotes fiscais e o console da produção fiscal
   (`selfhost.mjs build-hosted-production`, com `VITE_PRODUCT_ENV=production`
   em `.selfhost/hosted-production`). Depois, o dry-run do Worker.
5. **Publicação.** O backend com o SHA, depois o Worker
   (`issuanceReleaseWorker`).
6. **Smoke estrito** (`issuanceHealth`). O `/health` do backend e o da API
   precisam responder a revisão publicada com `appEnv: installation`,
   `productEnv: production`, `fiscalEnv: disabled` e
   `issuanceEnv: production`.
7. **Aviso dos termos de uso.** `termsOfUseNotice:start` no deployment
   publicado, com o desfecho em `termsOfUseNotice` no recibo. `failed` não
   recusa a publicação; a próxima chama de novo.

O recibo vai a `.ci-results/issuance-release/receipt.json`, no artifact do run.
Um `approved_sha` que não seja o SHA completo da `main` deste run falha já no
job `plan`, com `APPROVED_SHA_MISMATCH`, em vez de pular a CI e a publicação
em silêncio.

**Fora do escopo, de propósito:**

- **Domínio próprio para o backend.** O Convex fica no
  `https://<nome>.convex.cloud` da `url` versionada. Os domínios próprios são
  os do Worker, como no sandbox. Um domínio próprio do Convex no lugar de
  `CONVEX_CLOUD_URL` travaria o deployment (erro de configuração, nunca
  abertura).
- **URL regional.** O deployment precisa ficar na região padrão do Convex
  Cloud. O plano só aceita `https://<nome>.convex.cloud`, e uma URL regional
  não passa.

Mudar qualquer um dos dois é decisão nova, com mudança no plano e no código.

**Backup externo.** O workflow `Offsite backup` ganhou os jobs
`snapshot-issuance` e `check-issuance`, com o mesmo bucket, custódia e
cadência, sob o prefixo do deployment da produção fiscal, no environment
`offsite-backup-issuance`. Antes deles, o job `issuance-plan`, sem segredo,
lê o plano. Com `deployment: null`, os dois jobs são pulados, o environment
não é usado e nada é copiado. `scripts/backup-offsite.mjs snapshot|check
--target issuance` também pula com `result: "skipped"` (`PLAN_NOT_NAMED`). O
alerta usa o rótulo `offsite-backup-issuance-alert`.

**Passos humanos antes da primeira publicação**, registrados na #198. Até
03/11/2026 o passo 4 estava bloqueado: com o repositório privado no plano Free
do GitHub, não havia required reviewers nem _Prevent self-review_ em
environment, e a API recusava a proteção da `main` com HTTP 403. Desde a
abertura, em 03/11/2026, o environment `nfse-production-release` tem required
reviewers com _Prevent self-review_ e aceita só a `main`, ainda sem os
segredos, e a `main` tem um ruleset que exige PR e os checks `Validate` e
`Public scan`, sem aprovação obrigatória. Sem uma aprovação no run,
`deploy-issuance-production.yml` recusa a publicação com `APPROVAL_MISSING`,
antes de usar a chave (passo 1 da publicação, acima): a falha é fechada, como
no `nfse-gate-enable.yml`. Sem aprovação obrigatória na `main`, porém, quem tem
escrita no repositório ainda pode mudar o próprio workflow ou o script sem
outra pessoa revisar. O estado conferido e o que falta estão em
[emissao-nfse.md](emissao-nfse.md#proteções-do-github).

1. Criar o deployment Convex na região padrão, com o acesso ao painel e ao
   time restrito a pessoas nomeadas, e configurar as variáveis do preflight.
2. Definir `FNFE_NFSE_PRODUCTION_COMPANIES` só com a empresa Freecorps, e
   `AUTH_PROXY_SECRET`, `BETTER_AUTH_SECRET` e e-mail como no sandbox, com
   valores próprios.
3. Escolher o nome do Worker e os domínios do console e da API na zona da
   Freecorps; publicar o segredo `AUTH_PROXY_SECRET` no Worker novo.
4. Criar o environment `nfse-production-release`, com required reviewers,
   _Prevent self-review_, deployment branches só `main`, e os segredos
   `FNFE_ISSUANCE_DEPLOY_KEY` e `FNFE_ISSUANCE_CLOUDFLARE_API_TOKEN`; conferir
   que `CLOUDFLARE_ACCOUNT_ID` é a conta do plano.
5. Criar o environment `offsite-backup-issuance`, só `main`, com
   `FNFE_ISSUANCE_DEPLOY_KEY` e as credenciais R2 de escrita e de leitura.
6. Num commit revisado, nomear `deployment`, `url` e `release` em
   `deploy/issuance-production.json`.

## Falhas de publicação

Falha de validação, evidência ou build impede o início da publicação. Se o
backend já foi publicado e o Worker falhar, conferir os dois serviços e
reexecutar o candidato vigente após corrigir a causa. O recibo não declara
sucesso para uma publicação parcial.

O deploy não limpa dados. Após a abertura, preservar os registros novos e
ensaiar mudanças incompatíveis antes de publicar. Reverter código não restaura
o banco descartado no corte nem desfaz efeitos externos. Enquanto a emissão
legada estiver desativada, o app consumidor precisa mostrar essa indisponibilidade.
