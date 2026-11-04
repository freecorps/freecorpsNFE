# Publicação coordenada de validação

Implementação da publicação de validação.
A publicação é manual: o mantenedor dispara `Deploy validation` na `main`, e o
workflow publica o topo da `main` no deployment dev persistente `modest-seal-118`
e no Worker `freecorpsnfe-validation` na conta
`ceccd1846b474bb179054a3c2c4a6185`. Não há gatilho de push. A produção usa outro
workflow, `deploy.yml`, que publica a cada push na `main`, descrito em
[deploy-producao.md](deploy-producao.md). Até 07/10/2026 a validação acompanhava por push a branch
`feat/fiscal-platform-v1`, que parou fora da `main`.

## Execução e revisão aprovada

`deploy-validation.yml` só tem `workflow_dispatch`, com o input `target`
restrito a `validation`. Os jobs exigem `github.ref == 'refs/heads/main'` e esse
input; a execução em outra branch não passa da condição. O workflow chama o CI
reutilizável sem segredos. `ci.yml` não tem trigger de push. PRs continuam
executando `ci.yml`, incluindo Drafts, sem acesso ao environment de
publicação. Falha no CI impede o job dependente de deploy.

O job `Publish validation` faz checkout de `tested_sha`, exige igualdade com
`github.sha` e usa o environment GitHub `validation`. O script repete a
verificação do SHA obtido pelo Git, do resultado do CI, evento
(`workflow_dispatch`), branch (`main`) e repositório. O merge sintético de um PR
e o push da `main`, que pertence à produção, não atendem esses critérios.

No mesmo job, a concorrência `validation-publication` com
`cancel-in-progress: false` mantém um único escritor. CI pode rodar em paralelo;
publicações não. Runs pendentes podem ser substituídos pelo GitHub, sem cancelar
uma publicação iniciada. Não colocar os dois provedores em jobs independentes.

A [validação no navegador](../desenvolvimento/navegador.md) roda após o smoke de publicação,
dentro desse mesmo job. Usa somente a conta viewer sintética, sem chaves dos
provedores, e compara os SHAs novamente. Falha no navegador deixa o job vermelho
e gera relatório separado; `deployment.json` continua descrevendo a publicação
e o smoke de API, sem presumir o aceite de acessibilidade ou de todas as jornadas.

Antes de escrever, o script verifica configuração remota, alvo, credenciais,
checkout limpo, build/empacotamento e existência da sonda persistente. Consulta
o topo da `main` pelo GitHub imediatamente antes da primeira publicação. Se o
SHA já for antigo, porque a `main` avançou depois do disparo, registra
`obsolete`, não escreve e reprova o job para não registrar
sucesso do environment para uma revisão que não publicou.

Se a `main` avançar depois dessa conferência, conclui backend, frontend e smoke
do SHA já iniciado. O próximo escritor avalia a revisão nova. Não há garantia
de ordem FIFO da fila do GitHub; o teste de elegibilidade recusa uma revisão
antiga que chegue depois da nova. O mantenedor não deve cancelar manualmente um
job entre provedores. Cancelamento forçado, timeout ou queda do runner exigem
conferir os dois SHAs antes de retomar.

## Credenciais

O environment deve permitir somente a `main` (a política criada no bootstrap
permitia `feat/fiscal-platform-v1`; ver [validacao.md](validacao.md)). Os
secrets necessários:

| Secret                            | Uso                                                     |
| --------------------------------- | ------------------------------------------------------- |
| `VALIDATION_CONVEX_DEPLOY_KEY`    | Chave dev exclusiva de `modest-seal-118`                |
| `VALIDATION_CLOUDFLARE_API_TOKEN` | Token dedicado, Workers Scripts Edit na conta indicada  |
| `VALIDATION_SMOKE_EMAIL`          | Conta sintética `@validation.invalid` com perfil viewer |
| `VALIDATION_SMOKE_PASSWORD`       | Senha da conta sintética já provisionada                |

O token Cloudflare não precisa de DNS, rotas, KV, D1 ou R2. A permissão Workers
Scripts é da conta, não constitui isolamento criptográfico por nome de Worker.
A guarda do script recusa outro Worker, conta, rota ou binding. Isolamento de
credenciais entre Workers da mesma conta exige uma conta separada ou outra
fronteira de publicação; não declarar essa garantia só pelo nome do secret.
Não copiar o OAuth pessoal do Wrangler nem reutilizar o token de produção no CI.

As credenciais ficam somente no step de publicação. Subprocessos de build não
recebem credenciais; o CLI Convex recebe somente a chave correspondente e o
Wrangler somente o token Cloudflare. O smoke usa a conta viewer e encerra sua
própria sessão. Nenhum seed ou reset é executado no deploy. Para inicializar
explicitamente uma sonda/conta, seguir o runbook de [validação](validacao.md).

## Identidade, compatibilidade e smoke

O script inclui o SHA completo em `platform/convex/buildInfo.ts` somente durante
o empacotamento do backend e restaura o arquivo local no `finally`. O fonte
normal retorna `null` como SHA de desenvolvimento, nunca uma revisão inventada.
O valor publicado faz parte do bundle executável, não de uma variável remota
que possa mudar independentemente do código. `/health` o retorna com `no-store`.
O console incorpora o mesmo SHA no bundle e em `/build.json`.

Backend e frontend são duas publicações, sem transação atômica. Alterações devem
seguir expansão, migração e contração: primeiro backend compatível com frontend
antigo, depois frontend novo, só em entrega posterior remover contratos antigos.
Esta entrega acrescenta somente `sha` ao health, sem mudar tabelas, dados ou
operações autenticadas existentes. Rollback de código não desfaz schema/dados.

O `/health` do backend precisa informar `issuanceEnv: disabled`
(`scripts/lib/validation-smoke.mjs`, estrito desde a #198, PR 6). Uma resposta
sem o campo é de uma revisão anterior à #337, ainda sendo substituída: conta
como SHA diferente e é repetida. Com o SHA publicado e sem o campo, é o
deployment errado (`ENVIRONMENT_MISMATCH`). O `modest-seal-118` foi publicado
pela última vez em 05/10/2026, antes da #337; a próxima publicação da
validação traz o `issuanceEnv`. Nada antes da publicação lê o `/health`: o
build antigo leva a uma republicação normal (teste em
`tests/validationDeploy.test.ts`).

Após publicar, o smoke confere os SHAs completos, os ambientes, as rotas da SPA,
login por Better Auth, emissão de JWT, `access:overview` autenticado como viewer,
logout e recusa do JWT revogado. A sonda persistente é comparada antes e depois
por hash de todos os campos. Nenhum certificado fiscal real ou conector é usado.
Rotas HTML disponíveis não substituem os testes completos de navegador.
As leituras públicas dos SHAs podem ser repetidas até seis vezes, com intervalo
de três segundos, para aguardar propagação dos assets. Login e consulta
autenticada não são repetidos automaticamente. Divergência persistente reprova
o deploy; HTTP indisponível também mantém o estado parcial.

## Falha parcial e recuperação

`.validation-results/deployment.json` registra fases antes de qualquer chamada
que pode publicar: `backend`, `frontend`, `smoke`. Depois da confirmação do
backend, inclui `backendSha`. `validated` só aparece após smoke e persistência.
Erro após início de publicação gera `partial`, mesmo quando o resultado remoto
de uma chamada interrompida é incerto. Não tratar ausência de resposta como
prova de que nada mudou. O artifact sanitizado tem retenção de 30 dias e guarda
SHA, fases, estado e hashes, sem respostas de autenticação ou dados da sonda.

Depois que a revisão serve, a publicação chama `termsOfUseNotice:start`, o
aviso por e-mail de versão nova dos termos de uso, e grava o desfecho em
`termsOfUseNotice` no `deployment.json` e no sumário. Na validação, só as
contas de `ACCOUNT_EMAIL_RECIPIENTS` recebem. `failed` não reprova a
publicação; a próxima chama de novo, sem repetir envios.

O sumário sempre inclui URL, SHA, estado e etapa. Falha no setup antes do script
aparece como `not-started`; falha após publicação reprova o environment. Se o
runner desaparecer antes do upload, usar o status incompleto do job e os SHAs
consultados nos serviços. Não há rollback automático.

### Diagnóstico do smoke

O recibo e o sumário incluem `diagnostic` nas falhas do smoke. `phase` identifica
`revision`, `spa-login`, `spa-console`, `login`, `token`, `query`, `logout` ou
`revocation`; `service` distingue `frontend`, `backend` e `auth`. A fase externa
do recibo continua `smoke` e seu estado continua `partial`.

Depois que o smoke passa, a fase externa muda para `persistence` antes de ler
novamente a sonda. Sonda ausente, alterada ou indisponível nessa etapa mantém
`partial`, sem atribuir um diagnóstico de smoke a uma operação que passou.

| Código                 | Leitura operacional                                                  |
| ---------------------- | -------------------------------------------------------------------- |
| `TIMEOUT`              | A requisição ou a leitura do corpo excedeu o prazo.                  |
| `UNAVAILABLE`          | Falha de transporte, corpo interrompido ou HTTP 5xx.                 |
| `HTTP_ERROR`           | Outro status HTTP recusado.                                          |
| `INVALID_RESPONSE`     | JSON, formato, SHA ou HTML esperado ausente/inválido.                |
| `SHA_MISMATCH`         | SHA válido divergiu após as tentativas de propagação.                |
| `ENVIRONMENT_MISMATCH` | Serviço respondeu com configuração incompatível.                     |
| `AUTH_FAILED`          | HTTP 401/403, sessão/JWT ausente ou consulta viewer recusada.        |
| `REVOCATION_FAILED`    | A consulta após logout não confirmou a recusa do JWT.                |
| `UNKNOWN`              | Erro sem diagnóstico reconhecido; nenhuma mensagem remota é copiada. |

`httpStatus` só aparece após resposta HTTP. `expectedSha` e `observedSha`
aceitam exclusivamente SHAs hexadecimais completos; o observado identifica o
serviço divergente. `requestId`, quando disponível, vem de `x-request-id`,
`x-convex-request-id` ou `cf-ray`. Aceita UUID, hexadecimal de 16 a 32 caracteres
ou Ray ID com sufixo de região. Outros formatos são omitidos; não truncados para
parecerem identificadores válidos. Valores conhecidos de credenciais, sessão
e JWT também são recusados. O campo tem limite de 64 caracteres.

Os demais campos têm vocabulário fechado, SHA de 40 caracteres e status HTTP
inteiro de 100 a 599. São no máximo sete campos por diagnóstico, sem mensagens
arbitrárias, URLs, payload de login, cookies, tokens ou corpo remoto. A
sanitização ocorre antes do recibo e novamente ao gerar texto. Se a operação
autenticada e o logout falharem juntos, `diagnostic` preserva a primeira causa e
`cleanupDiagnostic` registra a falha de encerramento. O login não é repetido.
O smoke de produção usa o mesmo vocabulário e acrescenta as fases `spa-root`
e `crons`, o serviço `api` e os códigos `POLICY_MISMATCH` e `QUERY_FAILED`;
veja [deploy-producao.md](deploy-producao.md).

No run do Actions, abrir o sumário de `Publish validation` e o artifact
`validation-<run>-<tentativa>`, arquivo `deployment.json`. Usar fase, serviço,
status e requestId para correlacionar a ocorrência nos serviços, sem acrescentar
conteúdo privado ao recibo. Comparar os SHAs e seguir a recuperação abaixo.
Um diagnóstico mais específico não aprova o deploy nem reinicia a publicação.

O ensaio `node scripts/validation/prove-smoke-diagnostics.mjs` exercita o smoke e o registro
de publicação com transporte controlado e gera
`.validation-results/smoke-diagnostics.json`. Não publica, não usa credenciais
reais e não provoca falha no ambiente compartilhado. As
evidências da preservação de diagnósticos complementam M0-P08. A causa exata da
primeira tentativa histórica de `4f834e5` permanece indisponível.

O smoke de produção usa o mesmo vocabulário e acrescenta as fases `spa-root`
e `crons`, o serviço `api` e os códigos `POLICY_MISMATCH` e `QUERY_FAILED`;
veja [deploy-producao.md](deploy-producao.md).

1. Conferir `/health` e `/build.json`, o último run e a fase registrada.
2. Escolher a correção compatível na revisão atual da `main`. Não resetar
   a base nem restaurar snapshot como parte de recuperação de publicação.
3. Reexecutar **todos os jobs** do run elegível, incluindo CI, ou integrar a
   correção na `main` por PR e disparar o workflow de novo. Um run de SHA
   antigo será recusado.
4. Conferir smoke, hashes da sonda e estado `validated` antes de anunciar sucesso.

Para publicar: Actions → Deploy validation → Run workflow, com a branch `main`
e o target `validation`. Para repetir a mesma revisão: run elegível → Re-run
all jobs. Execução em outra branch não passa da condição dos jobs.

## Ensaio antes da integração

O operador pode executar o mesmo script com `--rehearsal` em checkout commitado
e já testado, usando credenciais locais autorizadas. A exceção recusa GitHub
Actions e consulta a `main`: se `deploy-validation.yml` existe nela, exige o
pipeline. Como o workflow está na `main`, a exceção fica fechada; um ensaio
local poderia concorrer com um disparo manual, que não passa pelo lock local.
Um lock no diretório Git comum impede outro ensaio das worktrees.
O ensaio pressupõe que não haverá merge habilitando o escritor durante sua
execução. O modo registrado é `operator-rehearsal`, não uma publicação aprovada.

```powershell
node scripts/validation/deploy-validation.mjs --rehearsal --fail-after-backend
node scripts/validation/deploy-validation.mjs summary
# Preservar o recibo parcial antes da próxima execução.
node scripts/validation/deploy-validation.mjs --rehearsal
node scripts/validation/deploy-validation.mjs summary
```

A primeira execução falha deliberadamente antes de publicar o frontend. A
segunda repete a revisão e verifica recuperação. A flag só provoca falha;
nunca permite ignorar checks. Não há essa opção no workflow.
Se o operador for interrompido, conferir o processo antes de remover o diretório
`validation-rehearsal.lock` no Git comum; não expirar locks automaticamente.

`tests/validationDeploy.test.ts` exercita commit antigo, avanço da branch entre
serviços, ordem invertida de revisões, falha parcial, recuperação e exclusão de
dois operadores pelo lock real. Esses testes não substituem a observação do
primeiro disparo manual na `main` e da fila real no GitHub. Guardar os runs,
identidades e resultados no registro local de publicação; não marcar aceite operacional sem essa evidência.

Fontes: [concorrência e environments do GitHub](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments),
[eventos e workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch),
[permissões Cloudflare](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
e [Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/).

## Credenciais e artefato do console

O build usa o ambiente reduzido de `subprocess-environment.mjs`. Credenciais
Cloudflare e Convex não chegam ao TypeScript, Vite ou build dos pacotes.
`scripts/validation/deploy-validation.mjs` prepara o console antes da publicação e chama
`node scripts/console.mjs publish` para publicar o artefato já produzido.
Esse comando exige `dist/build.json` com o mesmo SHA e ambiente `validation`,
revalida o site público e mantém as restrições de alvo, escritor e checkout limpo.

`console.mjs deploy` continua disponível: compila com ambiente reduzido e só
entrega o token Cloudflare ao subprocesso Wrangler de publicação.
`console.mjs package` compila e executa Wrangler com `--dry-run`, sem token.
O publicador da plataforma também separa o ambiente de build das credenciais.
Um recibo de SHA identifica a revisão preparada; não substitui o controle do
artefato e do runner pelo operador autorizado.
