# Emissão NFS-e

Fase 2 da [ADR 0004](../adr/0004-motor-de-emissao-nfse.md) (issue
[#196](https://github.com/freecorps/freecorpsNFE-arquivo/issues/196)). A plataforma
aceita pedidos de emissão e cancelamento de NFS-e pela [API REST](#api-rest)
(`/v1/issuances`), pelo SDK, pelo [console](#console), com sessão Better Auth,
e por funções internas do Convex (`platform/convex/issuance.ts`), e avisa as
transições por [webhooks](#webhooks). O perfil hospedado é sandbox: o
transporte é simulado e a nota sai "sem validade fiscal". Produção fica atrás
de um [gate por empresa](#gate-de-produção), desligado. O núcleo fiscal é
`@freecorps/fiscal-nfse` ([README](../../packages/fiscal-nfse/README.md)).

> [!WARNING]
> Os testes usam o provedor simulado do sandbox ou um transporte substituído,
> com dados e certificado sintéticos, e não comprovam autorização no fisco. A
> única prova real é a fase 3, em produção restrita, pelo
> [runbook](../operacao/emissao-nfse.md): em
> 09/10/2026, uma nota doméstica de teste foi autorizada e cancelada na
> homologação da IMA de Campinas, sem validade fiscal
> (evidência). Exportação e Sefin Nacional seguem
> sem autorização vista ([O que não está provado](#o-que-não-está-provado)).

## Ambientes e transporte

| Ambiente do projeto | Transporte                                               | Certificado                        | Condição                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox`           | `simulated` (padrão): autoridade sintética, sem rede     | Não usa                            | Nenhuma. É o perfil hospedado e o transporte de toda empresa fora da lista abaixo.                                                                                                                            |
| `sandbox`           | `producao-restrita`: Sefin/ADN real em produção restrita | A1 ativo da empresa no cofre, mTLS | `FNFE_NFSE_SANDBOX_TRANSPORT=producao-restrita` **e** o id da empresa em `FNFE_NFSE_RESTRICTED_COMPANIES` no deployment (fase 3)                                                                              |
| `production`        | `producao`: produção real                                | A1 ativo da empresa no cofre, mTLS | O [deployment de produção fiscal](#deployment-de-produção-fiscal), que não existe (fase 4), **e** a empresa em `FNFE_NFSE_PRODUCTION_COMPANIES` com o [gate](#gate-de-produção) ligado pelo workflow aprovado |

O transporte é escolhido na aceitação e congelado na emissão. Se a variável,
a lista de empresas ou o gate mudarem com a operação em andamento, o executor
para: falha definitiva (`ISSUANCE_TRANSPORT_DISABLED`) se nada foi enviado, ou
resultado incerto, que fica em reconciliação, se algo pode ter chegado ao
fisco. O cancelamento só sai pelo mesmo transporte que autorizou a nota
(`ISSUANCE_TRANSPORT_CHANGED`).

`FNFE_NFSE_RESTRICTED_COMPANIES` lista ids de `companies` separados por
vírgula. O perfil hospedado atende várias organizações: só a variável de
transporte mandaria ao fisco toda empresa com A1 no cofre. Uma lista vazia ou
malformada vale como nenhuma empresa. O console mostra, por empresa, o
transporte que o deployment usaria (`issuanceConsole.context`).

No transporte real, a action Node abre o A1 do cofre uma vez por tentativa
(`withCertificate` em `lib/certificateRuntime.ts`): o mesmo material assina a
DPS ou o evento e autentica o mTLS, somente para a origem do alvo resolvido
pelo pacote (`sefin.producaorestrita.nfse.gov.br` ou
`preprod-nfseapi.ima.sp.gov.br` na produção restrita, `sefin.nfse.gov.br` na
produção; `allowedOrigins` do transporte, sem redirects). Em produção, o
executor ainda confere a origem contra uma lista fixa no código
(`PRODUCTION_ORIGINS` em `issuanceWorker.ts`, só `https://sefin.nfse.gov.br`),
qualquer que seja o alvo resolvido, antes da tentativa e de novo antes do
cofre. Outra origem recusa a tentativa sem nada sair (`ISSUANCE_TARGET_INVALID`),
e o banco decide o desfecho (`issuanceProcessing.stopIfClosed`): rejeitada de
vez se nada foi enviado, em reconciliação se algo foi. O ADN de produção (`adn.nfse.gov.br`) só
recebe os `GET` da [verificação](#verificação-de-mtls-e-adesão). A chave não é
persistida, retornada nem registrada em log. A PTAX real vem da API pública
Olinda do Banco Central (`olinda.bcb.gov.br`), por HTTPS comum, sem
certificado; o executor recusa outro host. O Convex não tem allowlist de
saída: as origens permitidas são essas, fixadas no código.

Hoje nenhum deployment da plataforma serve a emissão em `production`. No
sandbox hospedado, um pedido `production` termina em `NOT_FOUND` pelo acesso,
com o gate ligado ou desligado. O alvo da #50 tem `PRODUCT_ENV=production`, mas
só lê a distribuição de NF-e: lá, emitir ou cancelar em `production` passa pelo
acesso e termina em `NOT_FOUND` logo depois dele, antes do gate e de qualquer
número reservado, porque o deployment não é a produção fiscal da emissão
(`requireProductionGate` em `issuance.ts`). O cofre também recusa o A1 da
emissão em qualquer `production`. O gate existe para a fase 4.

### Deployment de produção fiscal

A emissão real fica num deployment Convex próprio, separado do sandbox
hospedado, que atende várias organizações, com console e API em domínios
próprios. A decisão dos sócios está na
[ADR 0004, §8](../adr/0004-motor-de-emissao-nfse.md#8-ambientes-e-gates)
(fase 4, [#198](https://github.com/freecorps/freecorpsNFE-arquivo/issues/198)). O nome
e a URL do deployment ficam versionados em `deploy/issuance-production.json`;
hoje `deployment` e `url` valem `null` e nenhum deployment é produção fiscal.
Uma variável de ambiente sozinha nunca transforma um deployment em produção:
só um commit revisado nomeia o alvo. Um teste de ferramentas
(`scripts/deploy/issuance-production-plan.test.ts`) lê o plano, o do sandbox
hospedado (`deploy/platform-release.json`) e o da validação
(`platform/validation.json`) e falha se o plano nomear um dos dois.

`requirePlatformEnvironment` (`environment.ts`, com
`lib/issuanceProduction.ts`) trata o deployment como produção fiscal só quando
as três condições valem juntas:

- o plano nomeia um deployment, e `CONVEX_CLOUD_URL` é igual, caractere a
  caractere, à `url` versionada;
- `APP_ENV=installation`;
- `FNFE_ISSUANCE_ENV=production`, exatamente.

Qualquer combinação parcial é erro de configuração
(`Invalid platform configuration: FNFE_ISSUANCE_ENV`), nunca um sandbox
silencioso: o marcador definido (inclusive vazio ou com espaços) fora do
deployment nomeado, o que inclui o alvo da #50 (`APP_ENV=validation`), e o
deployment nomeado sem o marcador exato ou fora de `APP_ENV=installation`.
O erro derruba toda função que confere o perfil por
`requirePlatformEnvironment`: o `/health` (503), a autenticação, o REST e o
acesso de membros, chaves e operações, inclusive o pedido de emissão.

No deployment de produção fiscal, `PRODUCT_ENV` precisa ser `production`,
`FISCAL_ENV` continua `disabled` (a captura não roda ali),
`FNFE_CAPTURE_TRANSPORT` fica ausente, vazio ou `disabled` e as variáveis do
sandbox e das provas de captura (`FNFE_NFSE_SANDBOX_TRANSPORT`,
`FNFE_NFSE_RESTRICTED_COMPANIES`, `FNFE_FISCAL_PROOF`, `FNFE_PROOF_FISCAL_ENV`,
`FNFE_CERT_PROOF_ORIGIN`, `FNFE_CERT_PROOF_CA`, `FNFE_CAPTURE_FISCAL`) precisam estar ausentes.
`FNFE_NFSE_PRODUCTION_COMPANIES`, a lista de empresas do
[gate](#gate-de-produção), só pode existir nesse deployment; em qualquer outro,
mesmo vazia, é erro de configuração. O
`/health` informa `issuanceEnv`: `production` só nesse deployment, `disabled`
nos demais. Os smokes da instalação e da validação, a publicação da prova da
#50 e a instalação própria recusam um `/health` com outro valor; o smoke da
instalação confere também o `/health` da API pública, servido pelo Worker. Os
dois smokes recusam o campo ausente no SHA publicado; o da validação repete uma
revisão anterior à #337, ainda sendo substituída. O smoke da publicação da
produção fiscal exige
`issuanceEnv: production`
([deploy-producao.md](../operacao/deploy-producao.md#segundo-alvo-produção-fiscal-da-nfs-e)).

Duas limitações ficaram fora da publicação, de propósito (#198, PR 6):

- **Domínio próprio do backend.** Um domínio que substitua `CONVEX_CLOUD_URL`
  não é a `url` versionada e trava o deployment (o erro de configuração acima,
  nunca uma abertura). O backend fica no `https://<nome>.convex.cloud`; os
  domínios próprios do console e da API são os do Worker, em `release`.
- **URL regional.** Uma URL regional do Convex Cloud
  (`https://<nome>.<região>.convex.cloud`) não passa no formato aceito pelo
  plano, que só admite `https://<nome>.convex.cloud`. O deployment fica na
  região padrão.

Mudar qualquer uma é decisão nova, com mudança no plano e no código.

O vínculo pela URL só vale no Convex Cloud, que define `CONVEX_CLOUD_URL` do
deployment. Um backend próprio escolhe a própria origem; quem o opera controla
também o código, e o vínculo não o protege de si mesmo. A instalação própria
(`scripts/lib/selfhost.mjs`) roda com `APP_ENV=development`, onde o marcador é
sempre recusado, e confere `issuanceEnv: disabled` depois de publicar.

Uma única resposta decide se uma emissão (ou cancelamento) `production` pode
sair: `productionTransportAllowed` (`lib/issuanceCore.ts`). Ela exige a emissão
em `production`, congelada com transporte `producao` para `sefin-nacional`, no
deployment de produção fiscal, com a empresa em
`FNFE_NFSE_PRODUCTION_COMPANIES`. O executor a lê antes de cada tentativa e o
cofre a lê ao entregar o A1, então os dois nunca discordam. Se ela fecha antes
de uma tentativa que não enviou nada, a emissão termina rejeitada com
`ISSUANCE_TRANSPORT_DISABLED`, de vez e sem reconciliação.

O [gate](#gate-de-produção) desligado barra só notas novas (ADR 0004, §8,
terceira emenda):

- **Primeiro envio.** Exige também o gate da empresa ligado, na mesma
  organização.
- **Cancelamento de nota autorizada.** Não exige o gate: cancelar não cria nota
  nova e precisa continuar possível numa emergência, depois de o gate ser
  desligado. Exige o deployment de produção fiscal e a empresa ainda na lista;
  fora dela, o pedido é recusado (`ISSUANCE_PRODUCTION_DISABLED`) e um
  cancelamento já aceito para de vez sem enviar.
- **Reconciliação de emissão já enviada** (`submissions` maior que zero). Segue
  a regra do cancelamento: com o gate desligado, a tentativa consulta a DPS
  pelo Id e, se a nota existe, autoriza sem reenviar. Reenviar depois de um 404
  é um novo envio e exige o gate ligado, conferido na mesma transação que marca
  o envio (`issuanceProcessing.markSubmitted`): com ele desligado, nada é
  reenviado e a operação fica em `reconciling` com `ISSUANCE_RESEND_BLOCKED`,
  consultando de novo a cada tentativa. Esgotadas as tentativas, ela pausa com
  `RECONCILIATION_REQUIRED` e só anda de novo por retomada manual
  ([Retomada](#transmissão-e-reconciliação)): religar o gate e retomar a
  operação. Sem a DPS gravada, uma emissão já enviada nunca recebe DPS nova:
  fica incerta com `DPS_UNAVAILABLE`.
- **Corte total.** Tirar a empresa de `FNFE_NFSE_PRODUCTION_COMPANIES` para
  tudo, inclusive cancelamento e consulta: a emissão já enviada fica em
  reconciliação sem nada sair (`ISSUANCE_TRANSPORT_DISABLED`).

Além disso, em `production`:

- **Só a Sefin Nacional.** O canal de Campinas (`campinas-adn`) não tem
  autorização vista em produção. Uma rota que resolva para ele é recusada
  antes de reservar número (`NFSE_ROUTE_UNSUPPORTED`), sem forçar outro canal.
- **Sem marcadores do simulador.** Uma descrição com `[simular:` (sem
  diferenciar caixa) é recusada antes de reservar número
  (`ISSUANCE_FIELD_INVALID` com `field` `description`): o marcador iria como
  texto para uma nota real. O mesmo vale para o motivo do cancelamento, que o
  simulador também lê e que iria para o evento real (`CANCEL_REASON_INVALID`).
  Os códigos são os do contrato atual: um código novo exigiria uma versão
  major da API.

O nome do deployment, o Worker e os domínios ainda não foram escolhidos. Até
lá, o plano fica com `deployment`, `url` e `release` em `null`, e nada é
provisionado, publicado ou copiado
([deploy-producao.md](../operacao/deploy-producao.md#segundo-alvo-produção-fiscal-da-nfs-e)).

### Política do cofre na emissão

`certificateUse.authorize` trata a emissão como finalidade própria, separada
da captura. Para `documents.issue` e `documents.cancel`, entrega o certificado
só quando a emissão da operação tem transporte congelado `producao-restrita`,
está no `sandbox` e a empresa continua liberada pelas duas variáveis acima.
Em `production`, entrega só para operação e emissão em `production`, com
transporte congelado `producao` para `sefin-nacional`, quando
`productionTransportAllowed` responde sim, a mesma resposta que o executor lê
([Deployment de produção fiscal](#deployment-de-produção-fiscal)). O alvo da
#50 nunca recebe o A1 da emissão: lá o perfil não é a produção fiscal. Se o
cofre recusa o A1, uma única mutation
(`issuanceProcessing.stopIfClosed`) decide o desfecho na mesma transação, sob
o claim da tentativa e pelo que está gravado. Se algo já foi enviado antes
(`submissions` maior que zero na emissão ou no cancelamento), a operação segue
em reconciliação e nada é rejeitado. Se a política continua aberta, a recusa é
do próprio certificado (revogado, trocado, vencido) e a tentativa espera. Só
sem nenhum envio e com a política fechada (variável, lista, gate ou perfil
mudaram durante a tentativa) a emissão ou o cancelamento termina de vez com
`ISSUANCE_TRANSPORT_DISABLED`; um cancelamento rejeitado assim deixa a nota
autorizada. Claim perdido não grava nada. A decisão não depende
de `FISCAL_ENV`, que pertence à captura e fica `disabled` no perfil hospedado
(`APP_ENV=installation` exige isso).

Cada uso entra em `certificateAudit` com a ação `nfse-transport` na produção
restrita ou `nfse-production` na produção fiscal (resultado `authorized`,
`denied`, `success`, `failed` ou `stale`), e na auditoria operacional como
`certificate.nfse-transport` ou `certificate.nfse-production`. O ator é a
origem da operação (a chave, a conexão Stripe ou o membro do cliente), nunca
um login da equipe da Freecorps. A captura continua usando
`transport` e a política `FNFE_FISCAL_PROOF`, inalteradas; como as ações são
distintas, emitir não consome o orçamento da prova de captura e a política de
captura não libera a emissão.

### Gate de produção

Desligado para toda empresa. Muda só por `internal.issuance.setProductionGate`
(`issuance.ts`, validação em `lib/issuanceGate.ts`), que nenhum membro, chave
de API ou função pública alcança, e segue as decisões da
[ADR 0004, §8](../adr/0004-motor-de-emissao-nfse.md#8-ambientes-e-gates). Toda
troca vem de um workflow do GitHub Actions; não há caminho previsto de
chamada direta.

- **Só no deployment de produção fiscal.** Em qualquer outro, inclusive o
  sandbox hospedado e o alvo da #50, a troca é recusada
  (`ISSUANCE_GATE_DEPLOYMENT_DENIED`) e nada é gravado.
- **Ligar** (`kind: "enable"`) vem do workflow com aprovação e exige:
  - a empresa em `FNFE_NFSE_PRODUCTION_COMPANIES`, com ids de `companies`
    separados por vírgula. Vazia vale como nenhuma empresa, e um único item
    inválido (inclusive vazio, como numa vírgula no fim) anula a lista
    inteira, mesmo com a empresa nela (`ISSUANCE_GATE_COMPANY_DENIED`);
  - a organização fora de encerramento (`ORGANIZATION_CLOSED`);
  - `approver`, o login de quem aprovou o run, diferente de `operator` e de
    `actor`, mesmo trocando maiúsculas e minúsculas
    (`ISSUANCE_GATE_APPROVER_INVALID`).
- **Desligar em emergência** (`kind: "emergency_disable"`) vem de um workflow
  separado, sem aprovação, que uma pessoa autorizada dispara. Vale também para
  organização em encerramento e para empresa que já saiu da lista: desligar
  nunca abre nada. `approver` é opcional.
- **Toda troca** leva `operator`, o login de quem disparou esta execução ou
  tentativa (`github.triggering_actor`); `actor`, o `github.actor`, quem
  disparou o run original, só quando for outra pessoa (uma nova tentativa
  disparada por alguém diferente); `reason`;
  `runId`; e `runAttempt` (`ISSUANCE_GATE_RUN_INVALID` para run ou tentativa
  inválidos). Logins seguem o formato do GitHub (1 a 39 letras, dígitos ou
  hífens simples, sem hífen nas pontas). `reason` tem de 10 a 500 caracteres
  e recusa controles C0 e C1, DEL e todos os controles bidirecionais do
  Unicode (`Bidi_Control`: U+061C, U+200E, U+200F, U+202A a U+202E e U+2066 a
  U+2069), que fariam o texto aparecer diferente do que foi gravado
  (`INVALID_REQUEST`). A [verificação de mTLS](#verificação-de-mtls-e-adesão)
  usa a mesma regra para operador e motivo. Empresa de demonstração e empresa
  de outra organização são recusadas.

Cada troca acrescenta uma linha a `issuanceGateEvents` (versão, tipo, ligado ou
desligado, operador, `actor` quando diferente, aprovador, motivo, run,
tentativa, `buildSha`, URL do deployment e hora), regrava `issuanceGates`, o
estado atual, com o id desse evento, e grava `issuance.production_enabled` ou
`issuance.production_disabled` na auditoria operacional, tudo na mesma
transação. O estado atual e a auditoria, que o cliente pode ver, levam o ator
genérico `operator:freecorps`; os logins da equipe ficam só no histórico, que
é registro da Freecorps. A versão sai do maior número entre o último evento da empresa e o
estado atual, mais um: um estado derivado apagado, ou restaurado mais antigo
ou mais novo que o histórico, nunca faz um número se repetir. O histórico só
recebe acréscimos ([Retenção](#documento-emitido-artefatos-uso-e-auditoria)).

**O limite desta garantia.** Dentro do Convex não há como provar que uma
chamada veio do workflow. Uma função interna aceita a chamada de quem tiver a
chave de deploy do deployment, e quem tem acesso ao dashboard do Convex desse
deployment consegue chamar a mutation com operador, aprovador e run
inventados. A chave de deploy dá acesso administrativo completo ao
deployment: os environments de emergência e de leitura, que dispensam
aprovação, também a recebem, e quem dispara esses workflows poderia, alterando o
comando, chamar `kind: "enable"` com um aprovador inventado. Por isso mudar um
workflow exige a revisão de outra pessoa (`CODEOWNERS` e a proteção da `main`). O Convex não oferece chave de
deploy restrita a uma função, então separar uma chave para ligar e outra para
desligar não reduz esse poder (a conferir no provisionamento). O controle é
operacional, em duas partes.

O que está no repositório (PR 6 da #198):

- os três workflows, só por `workflow_dispatch` na `main`:
  `nfse-gate-enable.yml` (environment `nfse-production-gate`),
  `nfse-gate-emergency.yml` (`nfse-production-emergency`) e
  `nfse-production-probe.yml` (`nfse-production-read`), com a chave em
  `FNFE_ISSUANCE_DEPLOY_KEY`;
- o de emergência só chama `emergency_disable`: o tipo é fixo em
  `convexCall` (`scripts/lib/issuance-gate.mjs`), sem entrada que o escolha,
  e quem o dispara precisa estar em `authorizedActors` de
  `deploy/issuance-gate.json`, como no probe;
- o de ligar confere o run na API do GitHub antes de chamar a mutation:
  `/actions/runs/{id}/attempts/{n}` com o workflow, a `main`, o evento, o SHA,
  o estado, `actor` e `triggering_actor`, e `/actions/runs/{id}/approvals` com
  o aprovador, que precisa ser outra pessoa e estar em `authorizedActors`
  (`verifiedRun`). Só a primeira tentativa liga. A publicação do deployment
  (`deploy-issuance-production.yml`) passa pela mesma conferência antes de
  usar a chave;
- `.github/CODEOWNERS` com o dono do projeto, único dono desde a decisão dele de
  26/10/2026 (ADR 0007), em `.github/workflows`, `deploy/`, nos scripts dos
  workflows e no código do gate.

O passo a passo está no
[runbook da fase 4](../operacao/emissao-nfse.md#fase-4-produção-fiscal).

O que fica com os sócios, como passo humano registrado na #198
([lista](../operacao/emissao-nfse.md#passos-humanos)):

- a chave de deploy do deployment de produção fiscal só nos três environments
  protegidos; o de ligar com aprovação de outra pessoa (_Prevent
  self-review_);
- os environments só aceitam a branch padrão, e a `main` exige revisão de code
  owner, sem bypass de administrador, para que ninguém altere o comando de um
  workflow sem outra pessoa revisar;
- o acesso ao dashboard e ao time Convex desse deployment fica restrito a
  pessoas nomeadas, com a lista registrada junto da evidência da publicação.

Enquanto `deploy/issuance-production.json` não nomear o deployment, os
workflows recusam rodar antes de ler segredo (`PLAN_NOT_NAMED`), nenhum
deployment é produção fiscal e toda troca é recusada.

Emitir e cancelar em `production` conferem, nesta ordem: o acesso do chamador
(organização, projeto, empresa, concessão, escopo e ambiente, em
`issuanceAccess`); o deployment, que precisa ser a
[produção fiscal](#deployment-de-produção-fiscal) da emissão (`NOT_FOUND` em
qualquer outro); a empresa em `FNFE_NFSE_PRODUCTION_COMPANIES`; e, para
emitir, o gate ligado (`ISSUANCE_PRODUCTION_DISABLED`). Emitir confere ainda o
marcador do simulador na descrição e o canal; cancelar, o marcador no motivo.
Tudo acontece antes de reservar número. Quem não tem acesso recebe a mesma resposta (`NOT_FOUND`, `SCOPE_DENIED` etc.) com o
gate ligado ou desligado e não descobre o seu estado;
`ISSUANCE_PRODUCTION_DISABLED` só chega a quem poderia emitir ou cancelar na
empresa, no deployment de produção fiscal.

## Acesso e escopos

Todas as entradas conferem o acesso do chamador no servidor; organização,
projeto e empresa são seletores. `documents:issue` autoriza emitir e
`documents:cancel`, cancelar; ler uma emissão (consulta, lista, XML) aceita
qualquer um dos dois. A regra está em `issuanceAccess` (`lib/issuanceCore.ts`):

- **Chave de API** (`keyAccess`): chave vigente do projeto, com o escopo, no
  ambiente pedido, com a empresa entre as suas e a época da concessão em dia; a
  concessão ativa do projeto para a empresa precisa incluir o escopo e o
  ambiente. `operations.reserve` confere a chave de novo e a grava como origem
  da operação, revalidada a cada tentativa.
- **Membro** (`memberAccess`, [ADR 0005](../adr/0005-console-sem-projeto.md)):
  sem projeto nem concessão; exige acesso à empresa. Ler aceita `owner`,
  `admin`, `operator` e `viewer`; pedir e cancelar exigem `owner`, `admin` ou
  `operator`. `developer` não usa a emissão pelo console. O pedido de uma
  pessoa pertence ao projeto do console da organização, e a chave de
  idempotência fica no namespace dele.
- **Conexão Stripe** (`connectionAccess`,
  [ADR 0006](../adr/0006-conexao-stripe.md)): pede emissão e cancelamento,
  nunca lê, para o próprio projeto, empresa e ambiente, sob a concessão ativa
  do projeto com o escopo e com as épocas gravadas ao salvar a conexão.
  `operations.reserve` a grava como origem (`sourceStripeConnectionId`), e o
  executor revalida a conexão a cada tentativa. O fluxo está em
  [STRIPE.md](STRIPE.md).

`documents:import` não autoriza emissão. Só owner/admin concedem os escopos
novos ([PROJECTS.md](PROJECTS.md#emissão-nfs-e)).

As operações `documents.issue` e `documents.cancel` são conferidas pelo escopo
que vem do nome da tarefa (`documents:issue` ou `documents:cancel`, em
`requiredScope` de `lib/operationAccess.ts`), nunca pelo `task.scope` gravado.
Isso vale para `/v1/operations/{id}` (consulta, pausa e retentativa) e para a
revalidação do executor a cada tentativa. Antes da #206 o console gravava
`documents:import` nessas operações. Não há migração automática: um projeto
cuja concessão tem só `documents:import` precisa receber `documents:issue` e
`documents:cancel` para que suas chaves continuem emitindo e vendo as emissões
e operações feitas antes da #206; no console, pessoas com acesso à empresa as
veem sem concessão. Uma operação antiga ainda
na fila de um projeto sem o escopo para com `ACCESS_REVOKED` antes de
transmitir. A conferência se repete na transação que marca o envio
(`markSubmitted` e `markCancelSubmitted` em `issuanceProcessing.ts`): chave
revogada, concessão retirada, membro rebaixado ou A1 inutilizável depois da
preparação pausam a operação com `ACCESS_REVOKED`, sem marcar nem transmitir,
mesmo com o certificado já aberto pela tentativa; sem envio anterior, ela não
fica incerta. Editar os escopos da concessão não muda a época dela, então a
retentativa manual retoma a mesma operação depois da concessão.

## API REST

Rotas em `platform/convex/issuanceRest.ts`, contrato em
`packages/contracts/src/external.ts` ([referência gerada](../v1.0/API-REFERENCE.md)).
Headers `Authorization: Bearer fnfe_…` e `X-Environment` como nas demais rotas;
a admissão REST (60 chamadas por chave e 120 por organização por minuto) e a
telemetria por requisição valem aqui. O pedido aceito ainda passa pelo plano
ativo e pela taxa de operações de `operations.reserve`.

| Operação                                                          | Escopo                                  | Resposta                                                     |
| ----------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `POST /v1/issuances` (`Idempotency-Key` obrigatório)              | `documents:issue`                       | `202` `{ reused, issuance }`, `Location: /v1/issuances/{id}` |
| `GET /v1/issuances?companyId=&state=&limit=&cursor=`              | `documents:issue` ou `documents:cancel` | `{ page, nextCursor }`, mais nova primeiro, até 50           |
| `GET /v1/issuances/{id}?companyId=`                               | `documents:issue` ou `documents:cancel` | `Issuance`                                                   |
| `POST /v1/issuances/{id}/cancellation` (`Idempotency-Key` obrig.) | `documents:cancel`                      | `202` `{ reused, issuance }`                                 |
| `GET /v1/issuances/{id}/artifacts/{artifactId}?companyId=`        | `documents:issue` ou `documents:cancel` | XML ou PDF do DANFSe preservado, `application/octet-stream`  |

O corpo de `POST /v1/issuances` é `companyId` mais o
[`IssuanceInput`](#issuanceinput); o de cancelamento é
`{ companyId, reasonCode, reason }`. `issuerEmail` é opcional quando o perfil
NFS-e tem o e-mail do prestador. Valor (até 2 casas) e alíquota (até 4 casas,
a 3ª e a 4ª só zero) são texto decimal; um número JSON ou uma escala maior é recusado na borda com
`INVALID_REQUEST`, nunca arredondado. A borda confere tipos, escalas e
tamanhos; as regras fiscais respondem com o código específico da tabela de
[erros](#códigos-de-erro) e, quando há, `error.field` com o caminho do campo.
`NFSE_ROUTE_PROFILE_INCOMPLETE` traz `error.missing` com os campos do perfil que
faltam para o canal ou para o [grupo IBSCBS](#grupo-ibscbs) (por exemplo
`cTribMun`, `ibsCbs`).

`202` quer dizer **aceito**, não autorizado: a resposta reflete o estado
persistido, em geral `processing`. Acompanhe `state` pela consulta, pelos
webhooks ou por `GET /v1/operations/{operationId}`. A mesma chave de
idempotência com o mesmo pedido devolve a emissão original (`reused: true`),
sem reservar outro número; com outro pedido, `409 IDEMPOTENCY_CONFLICT`. No
cancelamento, um pedido em andamento ou já registrado também volta como
`reused`.

O DTO público é o [`IssuanceView`](#issuanceview) sem `organizationId` e sem
`documentId` (o documento emitido ainda não está em `documents/1`). A lista
filtra por `state` dentro da leitura limitada, então uma página pode vir com
menos itens e ainda ter cursor; o cursor é ligado ao escopo e ao filtro. O
download aceita os ids de `issuance.artifacts`: confere acesso, a emissão no
escopo da chave e o artefato daquela emissão, e confere de novo depois de ler
os bytes. Outra emissão, empresa, projeto ou organização responde `404`.

Depois da reativação de uma organização do arquivo econômico, a consulta, o
cancelamento e o download aceitam o ID anterior da emissão e do artefato e
respondem a emissão atual; ela e seus artefatos trazem `originalId`, o
primeiro ID ([SDK.md](../v1.0/SDK.md#ids-depois-da-reativação)). O
cancelamento compara a chave de idempotência pelo ID como foi enviado.

No SDK, as operações são `createIssuance`, `listIssuances`, `getIssuance` e
`cancelIssuance` por `client.call`, e `client.downloadIssuanceArtifact` para o
XML e o PDF do DANFSe (`danfse`, `filename="danfse.pdf"`) ([SDK.md](../v1.0/SDK.md#emissão-nfs-e-em-sandbox),
[exemplo](../../examples/nfse-issuance.ts)).

## Webhooks

| Evento                           | Transição persistida                                    | Assinatura exige   |
| -------------------------------- | ------------------------------------------------------- | ------------------ |
| `issuance.authorized`            | `checkpointIssue` grava `authorized`                    | `documents:issue`  |
| `issuance.rejected`              | `rejectIssue` grava `rejected`                          | `documents:issue`  |
| `issuance.cancelled`             | `checkpointCancel` grava `cancelled`                    | `documents:cancel` |
| `issuance.cancellation_rejected` | `rejectCancel` grava o pedido de cancelamento rejeitado | `documents:cancel` |

O evento entra na outbox na mesma transação da transição, com chave lógica
`issuance:{id}:{transição}` (na rejeição do cancelamento, por pedido): um
checkpoint repetido ou uma reconciliação não cria outro. Só destinos do projeto
que pediu a emissão, na mesma empresa e ambiente, recebem. O envelope tem
`resource: { type: "issuance", id, version }`, com a `version` da emissão, e
nenhum XML, tomador, motivo ou segredo. Veja [WEBHOOKS.md](WEBHOOKS.md).

## API interna

| Função                                | Tipo             | Argumentos                                                                                                                                                              | Retorno                                                    |
| ------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `internal.issuance.request`           | internalMutation | `organizationId`, `projectId`, `companyId`, `environment`, `keyHash?`, `idempotencyKey`, `input` (`IssuanceInput`)                                                      | `{ reused, issuance: IssuanceView }`                       |
| `internal.issuance.cancel`            | internalMutation | escopo, `keyHash?`, `idempotencyKey`, `issuanceId`, `reasonCode` (`"1"` erro na emissão, `"2"` serviço não prestado, `"9"` outros), `reason` (15 a 255)                 | `{ reused, issuance: IssuanceView }`                       |
| `internal.issuance.get`               | internalQuery    | escopo, `keyHash?`, `issuanceId`                                                                                                                                        | `IssuanceView`                                             |
| `internal.issuance.list`              | internalQuery    | escopo, `keyHash?`, `paginationOpts`                                                                                                                                    | página de `IssuanceView`, mais nova primeiro               |
| `internal.issuance.setProductionGate` | internalMutation | `organizationId`, `companyId`, `kind` (`enable` ou `emergency_disable`), `operator`, `actor?`, `approver?`, `reason`, `runId`, `runAttempt` ([Gate](#gate-de-produção)) | `{ production, version }`                                  |
| `internal.issuanceProbe.verify`       | internalAction   | `organizationId`, `companyId`, `operator`, `reason`, `municipalityCode?` (padrão `3509502`), `productionAdhesion?`                                                      | ver [Verificação](#verificação-de-mtls-e-adesão)           |
| `internal.issuanceProbe.verifyIssued` | internalAction   | `organizationId`, `companyId`, `issuanceId`, `operator`, `reason`                                                                                                       | ver [Verificação da nota](#verificação-da-nota-autorizada) |

Os mesmos fluxos estão exportados como helpers para uma mutation pública ou
HTTP action reaproveitar a transação: `requestIssuance(ctx, scope, key, input, keyHash?)`
e `requestCancellation(ctx, scope, key, { issuanceId, reasonCode, reason }, keyHash?)`;
a lista REST usa `listIssuancePage`. Com `keyHash`, a chave é conferida e
repassada a `operations.reserve`; sem ele, a sessão do membro.
Validators: `issuanceInput`, `issuanceView`, `cancelReason` em
`lib/issuanceValues.ts`. A chave de idempotência segue `operations.reserve`
(ASCII imprimível, até 128 caracteres) e vale por projeto e por tarefa.

### `IssuanceInput`

| Campo          | Regra                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activityCode` | `code` de uma atividade do [perfil NFS-e](COMPANIES.md) vigente (sem diferenciar caixa)                                                                                            |
| `competence`   | `AAAA-MM`. Não pode ser posterior ao mês da emissão. `dCompet` é o último dia do mês ou a data de emissão, o que vier antes (E0015)                                                |
| `issueDate?`   | `AAAA-MM-DD` em Brasília; padrão hoje. Não pode ser futura. É também a data de referência da PTAX. Data passada usa `T12:00:00-03:00` em `dhEmi`                                   |
| `issuerEmail?` | E-mail do prestador na DPS (`prest/email`). Opcional se o perfil tem e-mail, que então é usado; o do pedido prevalece                                                              |
| `market`       | `domestic` ou `export`                                                                                                                                                             |
| `taker`        | `national` (CPF/CNPJ com dígitos válidos, IBGE, CEP, logradouro, número, bairro) ou `foreign` (`nif` ou `nifAbsence` 1/2, país ISO2 diferente de BR e o endereço completo, abaixo) |
| `description`  | 1 a 2000 caracteres, sem caracteres de controle                                                                                                                                    |
| `amount`       | `{ currency, value }`, valor positivo em texto com até 2 casas. `BRL` no mercado interno; `USD`, `CAD`, `EUR` ou `GBP` na exportação                                               |
| `issRate?`     | Alíquota de ISS da competência em %, texto, maior que 0 e até 5. Até 4 casas, a 3ª e a 4ª só zero: a DPS leva 2 (`TSDec1V2`) e o valor nunca é arredondado                         |
| `issWithheld`  | ISS retido pelo tomador (`tpRetISSQN` 2). Exige tomador com CNPJ                                                                                                                   |

O `taker.document` nacional aceita máscara (pontos, barra, hífen e espaços),
mas a API pública é estrita quanto à caixa: as letras do CNPJ alfanumérico vão
em maiúsculas, e `12.abc.345/01de-35` responde `ISSUANCE_TAKER_DOCUMENT_INVALID`.
O pedido de uma integração é dado de máquina, e a forma canônica é uma só. As
entradas em que uma pessoa ou o Stripe escrevem o documento, o formulário do
console e a emissão automática do [Stripe](STRIPE.md), passam as letras para
maiúsculas antes de montar o pedido (`takerDocumentOf`, em
`platform/convex/lib/nfseProfileRules.ts`); a validação do servidor é a mesma.

O tomador no exterior tem todo o endereço obrigatório, porque o XSD da DPS
exige `endExt` completo e o fim de `TCEndereco` (`xLgr`, `nro`, `xBairro`) também
fora do país. Vazio ou longo demais responde `ISSUANCE_FIELD_INVALID` com
`field` no campo; sem a chave no JSON, a borda REST responde `INVALID_REQUEST`.

| Campo de `taker.address` | DPS           | Tamanho |
| ------------------------ | ------------- | ------- |
| `country`                | `cPais`       | 2       |
| `city`                   | `xCidade`     | 60      |
| `postalCode`             | `cEndPost`    | 11      |
| `state`                  | `xEstProvReg` | 60      |
| `street`                 | `xLgr`        | 255     |
| `number`                 | `nro`         | 60      |
| `district`               | `xBairro`     | 60      |

Sem bairro no endereço do exterior, informe a região, o distrito ou `N/A`: o
tipo do XSD (`TSBairro`) aceita qualquer texto de 1 a 60 caracteres, sem
espaço nas pontas.

Regras de ISS, conferidas com o perfil: não optante (`opSimpNac` 1) informa a
alíquota; optante do Simples sem retenção não informa (E0625); retenção exige
alíquota. A regra vale igual no canal de Campinas (ver
[Canal de Campinas](#canal-de-campinas)). Exportação não tem ISS (`tribISSQN` 3, LC 116/2003, art. 2º, I),
nem alíquota, nem retenção. O ISS da DPS (`vTotTribMun`) é valor × alíquota,
exato, arredondado em 2 casas half-up. Nenhum valor passa por ponto flutuante.

### `IssuanceView`

`id`, `originalId` (só numa emissão que voltou do arquivo econômico), escopo,
`operationId`, `operationState` (estado da operação de emissão),
`state`, `transport`, `target` (`sefin-nacional` ou `campinas-adn`), `series`, `number`, `dpsId`,
`issueDate`, `competence`, `market`, `amount` (como pedido), `serviceBrl`,
`exchange` (`currency`, `amount`, `rate`, `quoteDate`, `brlAmount`, `source`,
`frozenAt`), `accessKey`, `nfseNumber`, `documentId`, `code`, `rejections`
(`{ code, message }`, até 20), `artifacts` (`dps`, `nfse`, `danfse`,
`cancel-request`, `cancel-event`, com `sha256`, `size`, `signed`), `cancellation` (estado,
`sequence`, ordem do pedido na nota, motivo, código, rejeições, `alreadyRegistered`),
`version`, `createdAt`, `updatedAt`.

## Estados

```
processing ──▶ authorized ──▶ cancelled
     │
     └──────▶ rejected
```

| Emissão      | Significado                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `processing` | Aceita; em transmissão, nova tentativa ou reconciliação. Veja `operationState` (`queued`, `retry_wait`, `reconciling`, `paused`) |
| `authorized` | NFS-e autorizada, XML preservado, documento emitido criado                                                                       |
| `rejected`   | Rejeição definitiva do fisco ou erro local antes do envio; o número fica consumido                                               |
| `cancelled`  | Evento de cancelamento registrado                                                                                                |

| Cancelamento | Significado                                                                            |
| ------------ | -------------------------------------------------------------------------------------- |
| `processing` | Em envio ou reconciliação                                                              |
| `registered` | Evento registrado (inclusive "evento já registrado" após reenvio: `alreadyRegistered`) |
| `rejected`   | Rejeitado; a nota segue autorizada e um novo pedido sai com a `sequence` seguinte      |

Operação pausada (tentativas esgotadas, acesso revogado) deixa a emissão em
`processing`. Retomar é `operations.control` com `retry`, que reconcilia antes
de qualquer reenvio.

## Numeração e snapshot

- **Número da DPS.** `dpsSequences` guarda o último número por empresa,
  ambiente e série do perfil. A mutation que aceita o pedido reserva o próximo
  e cria a linha de `issuances` na mesma transação; o Convex serializa
  conflitos, então dois pedidos nunca recebem o mesmo número. A linha de
  `issuances` é o livro do número: cada número reservado pertence a uma emissão
  e registra o que aconteceu com ele (`authorized`, `rejected`, `cancelled`).
- **Política de rejeição.** Número rejeitado nunca volta ao estoque: a lacuna
  fica, como o padrão nacional aceita (ADR 0004, §7). Uma nova tentativa é um
  novo pedido, com nova chave de idempotência e novo número.
- **Série por canal.** A Sefin Nacional usa `dpsSeries` do perfil; Campinas usa
  `campinasDpsSeries` ou, sem ela, `dpsSeries` se estiver entre 10001 e 49999.
  A numeração é por empresa, ambiente e série, então dois canais com a mesma
  série nunca repetem número.
- **Número inicial.** Se a empresa já emitiu DPS com a série fora daqui, o Id
  coincidiria e a reconciliação acharia a nota alheia. Owner ou admin define
  o primeiro número da série no ambiente (`nfseProfiles.setDpsStart`, em
  [COMPANIES.md](COMPANIES.md#número-inicial-da-dps)) antes da primeira
  emissão; a primeira reserva trava a configuração (`DPS_START_LOCKED`). A
  plataforma não consulta o fisco para descobrir o último número usado: o
  número informado é responsabilidade de quem configura.
- **Snapshot.** Na aceitação, o pedido normalizado, o perfil vigente (versão,
  município, regime, série, atividade), a rota (`ruleId`, fonte), a decisão
  sobre o grupo `IBSCBS` (`ibsCbsGroup`, veja [Grupo IBSCBS](#grupo-ibscbs)),
  o transporte, `dhEmi`, `dCompet`, número e `dpsId` são congelados em
  `issuances.snapshot` (JSON com SHA-256). Mudar o perfil depois não altera a
  emissão; repetir o pedido com a mesma chave devolve a emissão original sem
  consultar o perfil.
- **PTAX.** Para moeda estrangeira, a primeira tentativa busca a PTAX de venda
  do dia útil anterior à `issueDate` (boletim de fechamento, recuo de até 10
  dias, taxa em 6 casas) e a congela em `issuances.exchange` antes de montar a
  DPS. No sandbox simulado, a cotação é fixa por moeda e o dia útil anterior
  pula sábado e domingo. Sem cotação, a tentativa é transitória
  (`PTAX_UNAVAILABLE`) e nenhuma DPS é montada.
- **Rota.** `resolveRoute` com município do perfil, regime (Simples ou não),
  subitem da atividade e data da emissão, antes de reservar número. Sem canal
  suportado: `NFSE_ROUTE_UNSUPPORTED` (com `reason` `ROUTE_ABRASF` ou
  `ROUTE_NO_RULE` e a mensagem da regra).
- **IBS/CBS.** `ibsCbsRequirement` com regime, subitem e `dCompet`, também
  antes de reservar número. Exportação com o grupo obrigatório:
  `ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED`; grupo obrigatório sem a classificação
  da atividade: `NFSE_ROUTE_PROFILE_INCOMPLETE` com `missing: ["ibsCbs"]`.

## Grupo IBSCBS

O grupo `IBSCBS` da DPS 1.01 tem ocorrência 0-1 no leiaute. A obrigação de
informá-lo na NFS-e vem do
[Ato Conjunto RFB/CGIBS nº 4, de 30/07/2026](https://www.cgibs.gov.br/upload/arquivos/202607/31091735-20260730-16h30-ato-conjunto-rfb-cgibs-na-c2-ba-4-260731-090909.pdf),
art. 1º, III e § 1º, "em relação aos fatos geradores que vierem a ocorrer a
partir" de cada data. A
[orientação da CGNFS-e de 07/08/2026](https://www.gov.br/nfse/pt-br/noticias/cgnfs-e-orienta-sobre-os-prazos-para%20destaque-de-ibs-cbs-nas-notas-fiscais-de-servico)
repete os prazos e diz que, até 31/12/2026, a ausência das informações de
IBS/CBS não gera rejeição no sistema nacional, mas deixa o documento em
desconformidade, sujeito às sanções do Ato. A plataforma trata a obrigação
como existente mesmo sem rejeição.

A regra é pura, em `packages/fiscal-nfse/src/ibsCbs.ts` (`IBSCBS_RULES`,
`ibsCbsRequirement`), no formato de `ROUTE_RULES`: a primeira regra que casa
regime e subitem dá o início da obrigação, com fonte.

| `ruleId`       | Regime                         | Subitem da LC 116 | Grupo obrigatório desde | Fonte (Ato Conjunto 4/2026) |
| -------------- | ------------------------------ | ----------------- | ----------------------- | --------------------------- |
| `ato4-simples` | Simples Nacional, MEI incluído | qualquer          | 01/01/2027              | art. 1º, § 1º               |
| `ato4-iii-b`   | não optante                    | 1.03, 1.05 e 1.09 | 01/12/2026              | art. 1º, III, "b"           |
| `ato4-iii-c`   | não optante                    | 16.01             | 01/12/2026              | art. 1º, III, "c"           |
| `ato4-iii-d`   | não optante                    | todos os outros   | 01/10/2026              | art. 1º, III, "d"           |

- _Data de referência._ O Ato conta pelo fato gerador, e a DPS o declara em
  `dCompet`: a regra usa `dCompet` (o último dia da competência ou a data da
  emissão, a anterior das duas), não a data da emissão. Uma nota de setembro
  emitida em 01/10/2026 sai sem o grupo; uma de outubro, com ele. A rota
  continua pela data da emissão, como o guia de Campinas. A regra E0850 do
  Anexo I, sobre o grupo, também vale a partir de uma competência (#338).
- _Escolha conservadora._ As plataformas digitais e os serviços que elas
  intermedeiam (alínea "a") e os fornecimentos fora da lista da LC 116
  (alíneas "e" a "h") começam em 01/12/2026, mas não se reconhecem pelo
  subitem; a NFS-e daqui sempre tem um subitem da lista. Todo subitem fora
  das alíneas "b" e "c" segue a data mais cedo, 01/10/2026. Mandar o grupo
  antes da obrigação não é rejeitado (0-1 no leiaute); omiti-lo depois é
  desconformidade.
- _Perfil._ Com o grupo obrigatório, a atividade precisa da classificação
  IBS/CBS (`cIndOp`, CST e `cClassTrib`) em qualquer canal. Sem ela, o pedido
  é recusado antes de reservar número com `NFSE_ROUTE_PROFILE_INCOMPLETE` e
  `missing: ["ibsCbs"]`. O perfil continua salvando sem ela; a proteção é a
  aceitação da emissão.
- _Exportação._ Com o grupo obrigatório pelo Ato, o tomador no exterior não pode levar
  a classificação da atividade nacional: o `cIndOp` 100501 localiza a operação
  no endereço do tomador no País (Anexo VII), e o `cIndOp`, o CST e o
  `cClassTrib` da exportação imune ainda não têm fonte oficial (veja
  [Exportação e E0187](#canal-de-campinas) e a
  [#198](https://github.com/freecorps/freecorpsNFE-arquivo/issues/198)). O pedido é
  recusado antes de reservar número com `ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED`,
  em qualquer canal, inclusive o de Campinas. Esse é o código das funções
  internas (console e Stripe). A API REST responde `409 NFSE_ROUTE_UNSUPPORTED`
  com mensagem própria, como os outros motivos internos de rota: o enum público
  de erros não muda sem versão major do contrato. O optante do Simples exporta sem
  o grupo até 31/12/2026, como a Freecorps pela Sefin em novembro; a partir de
  01/01/2027, a exportação dele também é recusada até a classificação oficial
  existir. A exportação do Simples pela IMA até 31/10/2026, que leva o grupo
  só pelo validador de Campinas, segue como antes.
- _Canal de Campinas._ O validador da IMA exige o grupo de todos, antes do Ato
  (L9999). Nesse canal ele vai sempre; quando é só pelo validador, o
  `ruleId` congelado é `campinas-ima`.
- _Snapshot._ A decisão fica em `ibsCbsGroup` (`required` e `ruleId`) e a DPS
  é montada por ela, não pelo destino. Uma emissão aceita antes desta regra
  não tem o campo e segue a regra da época, com o grupo só em Campinas: uma
  retentativa que ainda precise montar a DPS a monta como antes, e uma DPS já
  persistida nunca é remontada.
- _Conteúdo._ A plataforma modela só a classificação por atividade, sem
  cálculo nem valores de IBS/CBS, com `finNFSe` 0 e `indDest` 0. O leiaute
  segue o 1.01; a migração para a NT 009 é outro trabalho.

## Canal de Campinas

Prestador em Campinas (IBGE 3509502) segue as regras C2 a C5 da ADR 0004 para
o canal `campinas-adn`: não optante desde 01/10/2026 e optante do Simples de
01/10 a 31/10/2026. A partir de 01/11/2026, o Simples vai à Sefin Nacional
(C6) e nada desta seção se aplica a ele.

O validador da Prefeitura (IMA) exige, além do leiaute nacional, o que o legado
observou na homologação em 29/08/2026. Na aceitação, faltando qualquer item, o
pedido é recusado antes de reservar número com `NFSE_ROUTE_PROFILE_INCOMPLETE`,
`missing` (lista dos campos) e mensagem em pt-BR:

| Exigência                   | Origem no perfil ou no pedido                         | `missing`           |
| --------------------------- | ----------------------------------------------------- | ------------------- |
| `cTribMun` (L0017/E0314)    | `cTribMun` da atividade, três dígitos                 | `cTribMun`          |
| `cNBS` (E0316)              | `nbs` da atividade                                    | `nbs`               |
| Grupo `IBSCBS` (L9999)      | `ibsCbs` da atividade (`cIndOp`, `CST`, `cClassTrib`) | `ibsCbs`            |
| Série 10001 a 49999 (L0022) | `campinasDpsSeries`, ou `dpsSeries` na faixa          | `campinasDpsSeries` |

O endpoint novo da IMA valida o XSD nacional v1.01-20260209, o mesmo que a
plataforma incorpora: a primeira DPS real (09/10/2026) voltou com L9999
"Arquivo em desacordo com o XML Schema" e os nomes de tipo desse pacote. A DPS
de Campinas leva o grupo `IBSCBS` como último filho de `infDPS`, com
`finNFSe` 0, `indDest` 0 e `gIBSCBS` com `CST` e `cClassTrib`, sem valores, e,
quando há alíquota, `pAliq` depois de `tpRetISSQN`, com 2 casas. Não leva `dest`: no XSD ele é
filho de `IBSCBS` e o Anexo I só o admite com `indDest` 1 (E0910), quando o
destinatário difere do tomador. Não leva `cLocIncid`, que não existe na DPS
1.01 (o fisco calcula o local de incidência). O legado mandava `dest` depois do
tomador, `cLocIncid` e `pAliq` antes de `tpRetISSQN`, com 4 casas, e teve nota
autorizada no homolog antigo da IMA, que não validava o esquema. A Sefin
Nacional não recebe `cTribMun`, mesmo com o perfil preenchido, e recebe
`IBSCBS` só quando o Ato Conjunto 4/2026 o exige
([Grupo IBSCBS](#grupo-ibscbs)).

**Caminhos.** A base da IMA é `/notafiscal-ws/nfse` (guia de 18/09/2026, ADR
0004 §6): envio em `POST {base}`, consulta por DPS em `GET {base}/dps/{id}`,
NFS-e em `GET {base}/{chave}` e cancelamento em `POST {base}/{chave}/eventos`.
Na Sefin, a base é `/SefinNacional`, com `POST /nfse`, `GET /dps/{id}`,
`GET /nfse/{chave}` e `POST /nfse/{chave}/eventos`. Os caminhos são
explícitos por alvo no pacote (`submitUrl`, `dpsUrl`, `nfseUrl`,
`eventsUrl`). Até 09/10/2026 a IMA usava a base `/notafiscal-ws` com os
caminhos da Sefin, e a consulta por DPS ia a `/notafiscal-ws/dps/{id}`, rota
inexistente (veja [Transmissão e reconciliação](#transmissão-e-reconciliação)).

**Inscrição municipal.** Em Campinas, a DPS leva `<IM>` em `prest`, entre
`CNPJ` e `email`, quando o perfil tem `municipalRegistration`; sem ela, o
elemento fica de fora. A Sefin Nacional nunca a recebe, mesmo com o perfil
preenchido: pela regra E0120 do Anexo I, a IM não é informada quando o
contribuinte não tem cadastro complementar no CNC do município emissor, e
pela E0116 ela é obrigatória quando tem. Omitir a IM na Sefin parte da
premissa, não verificada, de que a empresa não tem esse registro no CNC de
Campinas; uma rejeição E0116 (ou E0084, que confere `cLocEmi`, CNPJ e IM no
CNC) a desmente e pede mudança no código. A IMA é o cadastro mobiliário de
Campinas, onde o prestador tem IM. A IM vem do snapshot congelado no aceite: emissões aceitas sem ela
continuam sem `<IM>`, sem migração.

**Alíquota.** Campinas segue a regra nacional: não optante e retenção informam
`issRate`; optante do Simples sem retenção não informa (E0625), e a DPS sai sem
`pAliq` e com `vTotTribMun` 0.00. Pedido de Simples sem retenção com alíquota
é recusado com `ISSUANCE_ISS_RATE_NOT_ALLOWED`; não optante ou retenção sem
alíquota, com `ISSUANCE_ISS_RATE_REQUIRED`. A prova é a homologação da IMA em
09/10/2026 (fase 3, #197), com prestador Simples ME/EPP (`opSimpNac` 3,
`regApTribSN` 1), `cTribNac` 010501, `cTribMun` 001 e tomador de Campinas, sem
substituição tributária:

| DPS                                         | Resposta da IMA                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pAliq` 2.00 (e 2.10), sem retenção         | L0006 "Alíquota ISS informada não confere com a alíquota identificada na regra de tributação municipal", com e sem `<IM>`                              |
| `pAliq` 2.00, com retenção (`tpRetISSQN` 2) | L0009 "A retenção do ISSQN foi informada na DPS, porém a regra tributária municipal da prestação determina que o serviço não está sujeito à retenção." |

Os parâmetros municipais do ADN dão 2,00% para 01.05.01.001, com incidência,
e a tabela de atividades da IMA também: o valor não era o problema. A IMA
valida o XSD 1.01 e as regras nacionais e, no Simples sem retenção, espera a
DPS sem `pAliq`: a mesma nota sem `pAliq` (nDPS 100007) foi autorizada e
cancelada na homologação da IMA no mesmo dia
(evidência). A regra anterior da plataforma
(alíquota em toda nota doméstica de Campinas) vinha da resposta "alíquota
0,0000% fora dos limites" do endpoint antigo da IMA, que não vale mais.

**Exportação e E0187.** Na mesma homologação, a DPS de exportação (tomador
estrangeiro, com ou sem NIF) passou no XSD e voltou com E0187; a mensagem cita
o `cIndOp` 100501. A causa não foi identificada. A DPS atende à regra 234 do
Anexo I, mas o `cIndOp` que ela leva contraria o Anexo VII.

- _Regra 234._ No Anexo I v1.01-20260209 (aba "RN DPS_NFS-e", regra 234, nível
  2), o E0187 diz que, com `cIndOp` 030102, 050102, 100101, 100301, 100501,
  030103, 050103, 100102, 100201, 100302, 100401, 100502 ou 100601, "o grupo
  toma deve ser informado". A DPS levava `toma` com `NIF` ou `cNaoNIF`, nome e
  `end/endExt` completo (E0223, E0234, E0242), no cenário 58 da aba
  "EXPORTACAO_EMISSÃO_NFS-e" (NBS, `cPaisResult` e `comExt`). Isso vale só
  para a regra 234.
- _O que foi enviado._ Na revisão `e66cdcc`, `issuanceDps.ts` copiava o
  `ibsCbs` da atividade do perfil para o `IBSCBS` de qualquer DPS de Campinas,
  sem distinguir mercado: a exportação levou a mesma classificação da nota
  doméstica. O `cIndOp` 100501 está na mensagem; o CST e o `cClassTrib`
  enviados não estão na evidência (só o `sha256` da DPS), e o perfil sugere
  `000`/`000001` ([COMPANIES.md](COMPANIES.md)).
- _Hipótese aberta principal: o `cIndOp` 100501 não serve ao adquirente no
  exterior._ No Anexo VII IndOp IBS/CBS v1.03.00 (NT 009,
  `anexovii-indop_ibscbs_v1-03-00-nt009.xlsx`, aba "cIndOp Public", linha
  34), o 100501 ("Demais bens, em operações onerosas") tem como local "Local
  do domicílio principal do adquirente residente ou domiciliado no País. Nas
  aquisições indicadas no art. 11, §4º, II, considera-se domicílio principal
  do adquirente o estabelecimento matriz" (LC 214/2025, art. 11, X, "a", 1 e
  §4º, II), com `NFSeLocIncidIBS` "Endereço do Tomador/Adquirente". Com
  tomador no exterior, não há domicílio no País para localizar a operação: a
  DPS contraria o Anexo VII, e o defeito pode ser da plataforma, que manda à
  exportação o `cIndOp` da nota doméstica. O Anexo VIII v1.01.00
  (`anexoviii-correlacaoitemnbsindopcclasstrib_ibscbs_v1-01-00.xlsx`, aba
  "tabela geral", linhas 32 e 33) correlaciona o 01.05 e a NBS 1.1103.22.00
  ao 100501 e ao `cClassTrib` 000001 só com "ADQ EXTERIOR?" = N; a tabela
  não tem linha de adquirente no exterior.
- _Hipótese contraditória: `cIndOp` 100502._ A aba "REGRA inc. X" do Anexo
  VIII manda a operação onerosa com "ADQ EXTERIOR" = SIM para 100102, 100302
  ou 100502. Mas o Anexo VII (linha 35) define o 100502 como "Local do
  domicílio principal do destinatário residente ou domiciliado no País, caso
  o adquirente não seja residente ou domiciliado no País", com
  `NFSeLocIncidIBS` "Endereço do Destinatário": pede um destinatário no País,
  informado em `dest` com `indDest` 1. Isso conflita com a decisão de não
  enviar `dest` (`indDest` 0, E0910; `issuanceDps.ts`) e não descreve a
  exportação da Freecorps, cujo destinatário é o próprio tomador no
  exterior. O Anexo C v1.01 (`anexo-c-indop-ibscbs-snnfse-v1-01.xlsx`, da
  documentação atual do Portal NFS-e, nota 5) traz a mesma restrição.
- _Hipótese aberta: classificação IBS/CBS._ CST `000` com `cClassTrib`
  `000001` é tributação integral; a exportação é imune (LC 214/2025, art.
  8º). Uma réplica de terceiros da tabela de classificação
  (buscadorncm.com.br, não oficial) dá CST `410` com `cClassTrib` `410004`
  para exportações; não conferimos na tabela oficial nem se o código é
  aceito em NFS-e, e o Anexo VIII não o lista para o 01.05.
- _Hipótese aberta: validador da IMA._ A IMA pode exigir tomador com
  endereço nacional para localizar a operação de 100501. A única nota aceita
  até aqui tinha tomador com CNPJ sintético.

A plataforma não muda a DPS sem resposta oficial: a pergunta sobre o
`cIndOp`, o CST e o `cClassTrib` da exportação imune do 1.05 está na consulta
à Prefeitura e à contadora da
[#198](https://github.com/freecorps/freecorpsNFE-arquivo/issues/198). Para a
Freecorps, isso vale até 31/10/2026: a partir de 01/11, o Simples exporta
pela Sefin, sem o grupo `IBSCBS` (o Ato só o exige do Simples em 2027) e,
portanto, sem `cIndOp`. A exportação do Simples pela IMA, até 31/10, segue
como antes, com a classificação da atividade, porque o validador exige o
grupo de todos. A do não optante de Campinas, quando o Ato já exige o grupo
(01/10/2026, ou 01/12/2026 nos subitens 1.03, 1.05, 1.09 e 16.01), é recusada
na aceitação com `ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED`, sem reservar número,
em vez de ir com a classificação doméstica que provavelmente volta com o
mesmo E0187. Antes dessas datas, ela vai como antes.

**IBS/CBS.** As datas da obrigação e o tratamento da exportação estão em
[Grupo IBSCBS](#grupo-ibscbs). O validador da IMA exige o grupo de todos,
antes do Ato. Esta seção dizia, pela pesquisa de 29/08/2026, que o grupo era obrigatório com
rejeição desde 03/08/2026 para o regime regular. Essa data vale para NF-e e
NFC-e (Ato Conjunto 4/2026, art. 1º, I e II), não para a NFS-e, e a
CGNFS-e informou que a ausência não gera rejeição na NFS-e até 31/12/2026.
A plataforma modela só a classificação por atividade, sem cálculo nem
valores: é o mínimo que o legado provou aceito, numa nota de optante do
Simples. Se o validador novo de Campinas exigir valores de IBS/CBS para não
optantes, a modelagem cresce na fase 3. A assinatura segue a política do alvo
(RSA-SHA1 em Campinas), já aplicada pelo executor; a IMA nova aceitou a DPS e o
pedido de cancelamento assinados assim em 09/10/2026.

## Transmissão e reconciliação

**XSD oficial antes de assinar.** O pacote `@freecorps/fiscal-nfse` incorpora
os esquemas da NFS-e nacional (pacote v1.01-20260209 do Portal NFS-e e o da
produção restrita de 20/10/2026, com manifesto e hashes em
`packages/fiscal-nfse/schemas/`) e confere cada DPS e
cada pedido de cancelamento montados contra eles, com `libxml2-wasm`, na action
Node, antes de assinar. Desvio do esquema rejeita a emissão (ou o
cancelamento) localmente com `DPS_SCHEMA_INVALID` (`EVENT_SCHEMA_INVALID`),
definitivo e sem transmitir; a rejeição traz o elemento e a regra que
falharam. O número da DPS fica consumido, como em qualquer rejeição. O
pedido de cancelamento não leva `nPedRegEvento`, que não existe no XSD nem no
Anexo II; `sequence` é só a ordem interna.

**Leiaute por ambiente.** A DPS para a Sefin Nacional com `tpAmb` 2
(produção restrita e o sandbox simulado) segue o leiaute da NT 009, do pacote
da produção restrita de 20/10/2026: `finNFSe` em `infDPS`, `xDescServ` depois
de `cNBS` e, no grupo `IBSCBS`, `CST` e `cClassTrib` direto em `trib`. Em
02/11/2026 a Sefin restrita recusou a DPS do leiaute anterior com E1235. A
DPS de produção (`tpAmb` 1) e a da IMA seguem o v1.01-20260209: a página
Documentação Atual do Portal ainda o publica, e a IMA aceitou esse leiaute em
09/10/2026. O leiaute sai do snapshot congelado (destino e `tpAmb`), então
uma nova tentativa monta os mesmos bytes.

O executor limita cada XML a 8 MiB em UTF-8. Uma DPS ou um pedido de
cancelamento montado acima desse teto termina com `NFSE_XML_LIMIT`, sem
gravar o artefato, transmitir ou agendar outra tentativa. Se o XML excedido
for uma resposta de autorização ou cancelamento, o desfecho permanece
incerto e segue para reconciliação: a recusa local de armazenamento não
prova rejeição pelo fisco. O pedido já persistido fica preservado. O
transporte também limita a descompressão das respostas a 8 MiB.

`issuanceWorker.ts` (Node) executa as duas tarefas, sob o claim e o fencing de
`operations`:

1. Monta a DPS a partir do snapshot congelado (`lib/issuanceDps.ts`), assina
   quando o transporte é real e **persiste** o XML (`issuanceArtifacts`, tipo
   `dps`) antes do primeiro envio. Tentativas seguintes enviam o texto
   persistido, nunca uma DPS remontada.
2. Incrementa `submissions` antes de cada transmissão.
3. Envia por `nacional.submitDps` (DPS já assinada) e classifica:
   `success` grava a NFS-e e publica no checkpoint; `definitive` marca a
   emissão como rejeitada; `transient` volta a tentar; `uncertain` (timeout,
   conexão interrompida, resposta ilegível, "DPS já existe") leva a operação a
   `reconciling`.
4. Sempre que `submissions > 0`, a tentativa seguinte, inclusive a do
   reconciliador, **consulta a DPS pelo Id** (`consultByDps`) antes de
   qualquer outra coisa. Encontrada: baixa a NFS-e pela chave
   (`consultByAccessKey`), confere que ela contém o `infDPS` com o Id
   consultado e autoriza sem reenviar (`recoveredByConsult`). NFS-e de outra
   DPS mantém a reconciliação com `NFSE_DPS_MISMATCH`, sem autorizar nem
   reenviar: a biblioteca `4success/nfse-campinas` registrou, em 29/07/2026, a
   IMA devolvendo para uma DPS a chave de uma nota de outra. Só um 404 com o
   JSON do fisco libera o reenvio do mesmo XML, com o mesmo número e Id.
   Consulta inconclusiva mantém a reconciliação.

**Critério do 404.** Um 404 na consulta só confirma ausência quando o corpo é
o JSON do fisco: um objeto com o envelope do padrão nacional (`tipoAmbiente`,
`versaoAplicativo` ou `dataHoraProcessamento`, que a IMA devolve até no 404 de
DPS ausente) ou com lista de `erros`, `erro` ou `alertas`. 404 vazio, HTML,
texto ou outro JSON, como o erro de rota do servidor de aplicação
(`timestamp`, `status`, `error`, `path`), pode ser uma rota inexistente ou um
proxy e vira `CONSULT_INCONCLUSIVE`: a operação continua em `reconciling` e
nada é reenviado. O simulador responde à DPS ausente com o envelope, e a uma
rota desconhecida com 404 vazio. Se a Sefin responder ao 404 de DPS ausente
sem esse JSON, a reconciliação dela para em `CONSULT_INCONCLUSIVE` em vez de
reenviar; o probe mostra o formato antes da emissão.

**Diagnóstico de respostas ilegíveis.** Quando o desfecho é incerto e houve
resposta (`RESPONSE_UNREADABLE`, `HTTP_UNEXPECTED`, `DPS_ALREADY_EXISTS`,
`CONSULT_INCONCLUSIVE`, `NFSE_DOWNLOAD_PENDING`), a tentativa em
`operationAttempts` guarda `diagnostic`: `httpStatus`, `contentType` (tipo de
mídia sem parâmetros), `body` (`empty`, `json-object`, `json-other`, `html`,
`xml` ou `text`) e `keys`, até 20 nomes das chaves de topo do JSON. Nunca
valores nem o corpo, e nada vai a log. É assim que se descobre o formato de
sucesso de um fisco sem expor a nota.

**Prova de 09/10/2026 (fase 3, #197).** Na homologação da IMA, o envio
voltou 2xx fora do formato da Sefin (`RESPONSE_UNREADABLE`), e a consulta da
época, numa rota inexistente, levou a reenvios respondidos com "DPS já existe".
Daí vieram a consulta em `{base}/dps/{id}`, o critério do 404 e o diagnóstico
acima; com eles, a consulta achou a nota e a emissão foi autorizada sem reenvio
(evidência). `DPS_ALREADY_EXISTS` continua
incerto: leva a reconciliar, nunca a rejeitar. O formato de sucesso do envio à
IMA segue desconhecido, e cada emissão em Campinas pode passar pela
reconciliação, que resolve o desfecho.

**Retomada de emissão incerta.** Uma emissão cuja operação esgotou as
tentativas ainda incerta pausa com `RECONCILIATION_REQUIRED`. "Retomar
operação" (ou `POST /v1/operations/{id}/retry`) concede uma reconciliação além
do limite, dentro do orçamento de recuperação
([OPERATIONS.md](OPERATIONS.md#recuperação-e-limites)). Ela executa
`reconcileIssue`: consulta a DPS pelo Id e só reenvia o mesmo XML assinado
depois de um 404 com o JSON do fisco. Se continuar incerta, pausa de novo e
pode ser retomada outra vez. Foi essa retomada que autorizou a emissão de
09/10/2026.

No cancelamento, o pedido de evento assinado também é persistido antes do
envio. O Id do evento é determinístico (`PRE` + chave + `101101`) e o fisco
responde a um evento repetido com "evento já registrado", que o adaptador
trata como sucesso. Por isso a reconciliação do cancelamento reenvia o mesmo
pedido em vez de consultar.

## Documento emitido, artefatos, uso e auditoria

- **Documento.** Ao autorizar, o checkpoint cria um `fiscalDocuments` com
  `model: "nfse"`, `direction: "emitted"` e `fiscalKey` = chave de acesso de 50
  dígitos, ligado por `issuances.documentId`. Ele ainda não tem versão
  publicada em `documents/1`: listagens, detalhe, downloads e onboarding do
  console e da API não o mostram (`completeness` -1, `listedAt` preenchido).
  A exportação da organização o inclui como documento sem versão publicada. A
  API expõe a emissão e seus XML por `/v1/issuances`; o DTO não leva
  `documentId` até o documento emitido entrar em `documents/1`.
- **Artefatos.** `issuanceArtifacts`: `dps` (DPS assinada; no simulado, sem
  assinatura, `signed: false`), `nfse` (XML autorizado), `danfse` (PDF),
  `cancel-request` (pedido de evento) e `cancel-event` (XML do evento
  devolvido, quando houver). Cada um com SHA-256 e tamanho, baixável por
  `GET /v1/issuances/{id}/artifacts/{artifactId}`.
- **DANFSe.** Gerado na mesma tentativa que recebe a NFS-e autorizada (envio
  ou recuperação por consulta), a partir do XML que será preservado, por
  `renderDanfse` de `@freecorps/fiscal-nfse/danfse`
  ([README](../../packages/fiscal-nfse/README.md#danfse)), e gravado com
  `recordAuthorization`, junto do XML. Transporte `simulated` sai com a marca
  "SEM VALOR FISCAL — SANDBOX/SIMULADO"; `producao-restrita`, com "SEM VALOR
  FISCAL — PRODUÇÃO RESTRITA" (que o pacote também impõe a todo `tpAmb` 2);
  só `producao` sai sem marca. O PDF é melhor esforço: se a geração falhar, a
  autorização segue, o evento `danfse_failed` registra o código e não há nova
  tentativa automática. Uma chamada repetida mantém o primeiro PDF. O PDF não
  é regenerado quando o cancelamento é registrado; o estado vigente é o da
  emissão.

  Por que na autorização, e não sob demanda: o DANFSe é artefato preservado
  pela ADR 0004 (§7), com hash, como o XML; gerado uma vez, o PDF entregue não
  muda se o renderizador mudar depois, e a leitura não precisa de uma action
  Node por download. A geração é pura sobre o XML, então uma falha não deixa
  estado parcial: só a ausência do artefato, registrada.

- **Uso.** Uma unidade `issuances` por emissão autorizada, com chave
  `issuance:{id}`, gravada no checkpoint. É só medida, sem limite de plano, e
  aparece em Uso e limites como "NFS-e emitidas".
- **Histórico e auditoria.** `issuanceEvents` registra `accepted`,
  `exchange_frozen`, `dps_saved`, `submitted`, `danfse_saved`,
  `danfse_failed`, `authorized`, `rejected`,
  `cancel_requested`, `cancel_submitted`, `cancelled` e `cancel_rejected`. A
  auditoria operacional recebe `issuance.accepted`, `issuance.authorized`,
  `issuance.rejected`, `issuance.cancel_requested`, `issuance.cancelled`,
  `issuance.cancel_rejected` e as trocas de gate, além dos eventos da operação.
  Falhas de tentativa entram em `operationalFailures` com origem `nfse-issuance`.
- **Retenção.** `issuances`, `dpsSequences`, `issuanceCancellations`,
  `issuanceArtifacts` (com os arquivos), `issuanceEvents` e
  `issuanceSimulations` são classe `fiscal`: ficam até o fim da guarda e saem
  no expurgo de `fiscalGuard`. `issuanceGateEvents`, o histórico do gate, é
  classe `commercial`: registro da própria Freecorps, como controladora, de
  quem da equipe liberou a produção de cada empresa, com o mesmo prazo e o
  mesmo expurgo das notas que justifica ([RETENTION.md](RETENTION.md#histórico-do-gate-de-produção)).
  `issuanceGates`, o estado atual, é classe `closure`.

## Console

`/app/:slug/issuances` (menu "Emissão NFS-e") usa as funções públicas de
`platform/convex/issuanceConsole.ts`, que só ligam a sessão aos helpers
`requestIssuance` e `requestCancellation`; as regras continuam neles.

| Função                           | Tipo     | Quem                         | O que faz                                                                                                                                                       |
| -------------------------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuanceConsole.context`        | query    | membro                       | Resolve a empresa da URL, `canIssue`, o transporte do deployment e, em produção fiscal, o gate da empresa para `owner` e `admin`                                |
| `issuanceConsole.list`           | query    | leitura                      | Página de `IssuanceView` da empresa, de todos os projetos, mais nova primeiro, com o tomador e a origem; filtros opcionais `state`, `from` e `to` (`createdAt`) |
| `issuanceConsole.detail`         | query    | leitura                      | `IssuanceView`, dados do snapshot (prestador, atividade, tomador, ISS), histórico, `canCancel`, origem                                                          |
| `issuanceConsole.resubmission`   | query    | leitura                      | O pedido congelado de uma emissão no formato de `IssuanceInput`, sem `issueDate`, para corrigir e pedir de novo                                                 |
| `issuanceConsole.recentTakers`   | query    | leitura                      | Tomadores das 50 últimas emissões da empresa, um por documento, até oito                                                                                        |
| `issuanceConsole.request`        | mutation | `owner`, `admin`, `operator` | `requestIssuance` com a chave de idempotência gerada pelo console                                                                                               |
| `issuanceConsole.cancel`         | mutation | `owner`, `admin`, `operator` | `requestCancellation` com motivo                                                                                                                                |
| `issuanceConsole.artifactTicket` | mutation | leitura                      | Ticket de um minuto para baixar um XML ou o DANFSe da emissão                                                                                                   |

Permissões: as de membro em [Acesso e escopos](#acesso-e-escopos), conferidas
pelo `issuanceAccess`, sem projeto ([ADR 0005](../adr/0005-console-sem-projeto.md)).
A tela escolhe só a empresa (`company-context.tsx`); leitura exige acesso a ela
(concessão por empresa abaixo de admin) e papel de leitura; `developer` não lê
pelo console. Emitir e cancelar seguem `operateDocuments`, os mesmos papéis que
importam XML: `canIssue` e `canCancel` refletem o papel. A lista e o detalhe
mostram todas as emissões da empresa, inclusive as pedidas por integrações, e
o console pode cancelar qualquer uma delas: é a exceção à regra de que o
console só altera o que criou. O que o console pede pertence ao
projeto do console, sem webhooks: os eventos de uma emissão feita no console
não vão a endpoints de integração; o cancelamento de uma emissão de
integração notifica o projeto dono dela. O ticket de download confere a mesma
regra de leitura quando é usado. Empresa de demonstração não emite
(`ISSUANCE_DEMONSTRATION_DENIED`). O ambiente do console é o do deployment
(`deployment.current`, ver [frontend.md](../desenvolvimento/frontend.md)):
o `PRODUCT_ENV` do deployment, lido por `requirePlatformEnvironment`. Num
deployment de produção que não é o de produção fiscal (o alvo da #50),
`context.canIssue` é falso e a tela não oferece emitir; ali, como no sandbox,
um `production` forjado esbarra no acesso (`NOT_FOUND`), antes do gate.

- **Idempotência.** O formulário gera uma chave por tentativa de envio
  (`console-<uuid>`). Clique duplo ou reenvio dos mesmos dados depois de uma
  resposta perdida reaproveitam a chave e recebem a mesma emissão; mudar os
  dados gera outra chave. O cancelamento faz o mesmo.
- **Tomador no exterior.** Código postal, estado/província/região,
  logradouro, número e bairro são obrigatórios, com os tamanhos do XSD; a
  ajuda do bairro sugere a região, o distrito ou `N/A` quando o endereço não
  tem bairro.
- **Destino.** Antes do pedido, o bloco "Para onde a nota vai" mostra o
  transporte que o deployment usaria para a empresa (`context.transport`) e o
  canal previsto, calculado no navegador pela mesma tabela de rotas
  (`resolveRoute` de `packages/fiscal-nfse/src/route.ts`) com município e
  regime do perfil, atividade e data da emissão. É uma previsão: o servidor
  resolve de novo na aceitação, pela regra vigente na data da emissão, e
  congela canal e transporte no snapshot. O detalhe mostra o destino ("Sefin
  Nacional (ADN)" ou "Campinas (IMA, padrão nacional)") e o transporte
  registrados. Em produção restrita, a página avisa que as DPS vão ao fisco de
  verdade, sem validade fiscal.
- **NIF do tomador.** "O tomador tem NIF?" pede a escolha explícita: "Tem
  NIF" mostra só o número; "Não tem NIF", só o motivo (dispensado ou não
  exigência). Trocar a escolha apaga o outro valor; o pedido leva `nif` ou
  `nifAbsence`, nunca os dois.
- **Valor.** Sob o campo, "Valor na nota" mostra o valor formatado na moeda
  ("USD 1.000,00"), para 1000 não ser lido como 1,00. Em moeda estrangeira,
  a ajuda junto ao campo explica a conversão pela PTAX de venda do dia útil
  anterior à data da emissão, congelada na primeira tentativa de envio.
- **Descrição.** Obrigatória no servidor (`normalizeIssuanceInput`) e no
  formulário: vai na DPS como descrição do serviço (`xDescServ`). Com uma
  única atividade, vem preenchida com a descrição da atividade no perfil, e a
  ajuda pede revisão.
- **Validação.** O formulário espelha `normalizeIssuanceInput` e as regras de
  ISS do perfil (alíquota obrigatória para não optante e na retenção, ausente
  no Simples sem retenção, também em Campinas, retenção só com CNPJ,
  exportação sem ISS e em moeda estrangeira), deixa
  o e-mail do prestador opcional quando o perfil tem um, aceita valores com vírgula e converte para texto decimal sem
  ponto flutuante. O servidor confere tudo de novo. Se o pedido não sai, o
  motivo fica junto ao botão "Pedir emissão" (os campos a conferir, ou a
  recusa do servidor com o nome do campo) e o foco vai ao primeiro campo
  inválido ou ao campo apontado pelo erro (`field`); sem campo visível, ao
  próprio motivo. Enquanto o servidor não responde, o botão fica desabilitado
  e diz por quê.
- **Estados.** "Autorizada" só depois da resposta registrada. Antes disso a
  tela diz "Aceita, na fila", "Transmitindo", "Aguardando nova tentativa",
  "Em reconciliação" (sem sugerir reenvio), "Pausada" ou "Sem desfecho",
  conforme `operationState`. Cancelamento em andamento mantém a nota
  autorizada e o aviso correspondente. O detalhe abre com o bloco "Situação":
  estado, código e mensagens da rejeição (quebram linha, mesmo as de XSD),
  ação disponível (cancelar só a nota autorizada, para quem tem papel de
  escrita; nas demais, o motivo de não haver ação), destino e transporte,
  seguido do índice das seções. A lista mostra o canal, o código da rejeição
  e o transporte em cada linha. As telas assinam as queries; não há polling.
- **Datas e valores.** Data da emissão e competência são datas civis de
  Brasília (`todayInBrasilia`), exibidas sem conversão de fuso; a
  competência aparece por extenso no formulário e no detalhe ("outubro de
  2026"); valores,
  alíquota e PTAX vêm como texto e são formatados por `format.ts`. O
  histórico do detalhe mostra o horário de cada evento com segundos, no fuso
  do navegador, para que eventos do mesmo minuto fiquem em ordem legível.
- **Downloads.** `artifactTicket` grava o ticket em `documentDownloads`, no
  projeto do console, cujo `artifactId` aceita `issuanceArtifacts`. O resgate
  em `/v1/document-download` confere de novo membro, acesso à empresa e sua
  versão, e que a emissão do artefato pertence à organização, empresa e
  ambiente do ticket.
- **Sandbox.** Com transporte `simulated`, a tela avisa que o simulador
  responde no lugar do fisco e que a nota não tem validade fiscal.
- **Produção fiscal.** Só no deployment de produção fiscal (transporte
  `producao`; `issuance-production.tsx`). O indicador de ambiente diz
  "Produção fiscal · Notas com validade fiscal"; a tela de emissão avisa, em
  tom de atenção, que as DPS vão à Sefin Nacional, assinadas com o A1 da
  empresa, com validade fiscal.
- **Gate na tela.** Para `owner` e `admin`, `context.productionGate` traz o
  gate da empresa só para leitura, abaixo da nota: "Liberada", neutro, com
  "desde dd/mm/aaaa hh:mm", ou "Desligada", em atenção, com o que continua
  (cancelamentos e consultas). A hora é o `updatedAt` do gate ligado, isto é,
  o último "ligar" (um desligar e religar mostra o religar); só conta com a
  empresa na lista e o gate na mesma organização. Com o gate desligado,
  "Nova emissão" e "Pedir emissão" dizem junto do botão que novos pedidos
  serão recusados. Não há botão de gate: ele só muda pelo workflow da
  operação ([Gate de produção](#gate-de-produção)), e o console nunca recebe
  quem ligou ou aprovou (logins e run ficam em `issuanceGateEvents`). Outros
  papéis e o sandbox recebem `null`.
- **Confirmação em produção.** O botão do formulário vira "Revisar pedido" e
  abre "Emitir NFS-e em produção?", que confirma com "Pedir emissão"; a nota
  abaixo dos botões diz que nada é enviado antes da confirmação. No
  cancelamento, o botão vira "Revisar cancelamento" e abre "Cancelar esta
  NFS-e em produção?", que confirma com "Confirmar cancelamento". O resumo, com
  o termo sobre o valor, traz:
  - a nota (NFS-e e DPS, no cancelamento);
  - o tomador, com o nome, que pode quebrar, e o documento (CPF/CNPJ formatado
    ou NIF), que nunca quebra (`fiscal-num`), e o nome do país no exterior;
  - o valor na moeda;
  - o destino "em produção";
  - no cancelamento, o motivo.

  O foco abre em "Revisar"; só a confirmação envia, com a mesma chave de
  idempotência da tentativa. Nos primeiros 350 ms depois de abrir, e para
  cliques repetidos (`detail > 1`), o fundo e os botões não respondem: o
  segundo clique ou toque de quem abriu não fecha nem confirma
  (`ConfirmDialog` com `settleMs`). No sandbox e em produção restrita, os
  dois botões seguem sem passo a mais e com os rótulos de sempre.

- **Transporte e DANFSe.** O transporte aparece como "Produção" e o DANFSe
  sai sem a marca "SEM VALOR FISCAL" (`DanfseMark` nulo só em `producao`, no
  worker).
- **Página da emissão.** Com `?issuance=`, o detalhe ocupa a tela: "Voltar à
  lista de emissões" (a lista fica montada sob o detalhe aberto a partir dela,
  com filtros, páginas carregadas e rolagem), h1 da DPS ou NFS-e,
  seções em h2, a origem ("Console" ou "Integração X", `recordOrigin`) e a
  referência da operação com copiar e link para Operação e suporte
  (`/operations?ref=`).
- **Corrigir e emitir de novo.** Numa emissão rejeitada, quem emite vê o botão,
  de qualquer origem. Ele abre o formulário preenchido por
  `issuanceConsole.resubmission`, com a data de hoje; o pedido é novo, com nova
  chave de idempotência e outro número de DPS, e a rejeitada não muda.
- **Tomador.** O formulário busca o município do tomador pelo começo do nome,
  com filtro de UF, na tabela de municípios (`references.search`); escolher
  preenche o código IBGE, e o código digitado mostra o nome do município. Não há
  base de CEP. "Tomador de emissões anteriores" sugere os tomadores da mesma
  empresa (`recentTakers`). O botão que sai do formulário é "Descartar", para
  não se confundir com "Cancelar NFS-e".
- **Sem perfil NFS-e.** A lista avisa antes de "Nova emissão", que fica
  desabilitado com o motivo, e aponta a aba Fiscal da empresa
  (`/companies/:id?aba=fiscal`).
- **Lista.** Filtros por situação e período do pedido (dias de Brasília). Em
  telas de até 760 px, as emissões viram cartões com situação e valor, e os
  filtros ficam recolhidos enquanto não estão em uso.
- **Downloads no console.** "Baixar XML/PDF" mostra "Preparando…" e
  "Baixando…", desiste com mensagem depois de 20 s sem ticket ou 45 s sem os
  bytes e oferece "Tentar de novo", com um ticket novo. O link temporário fica
  na página e a URL do blob dura 60 s, para o navegador não perder o download.

Prova no navegador: `node --experimental-strip-types
apps/console/e2e/issuances.mjs` no worktree com `bun run dev` aberto. Evidência
em evidence/issuance-console; a
reorganização da tela tem antes e depois em
evidence/console-ui-emissao, e o
fluxo de página, correção, filtros e cartões em
evidence/console-fluxo-dados.
O console ciente do ambiente (sandbox idêntico, estados de produção fiscal) tem
antes e depois em
evidence/console-ambiente-producao.

## Provedor simulado do sandbox

`issuanceSimulator.exchange` responde ao mesmo contrato ADN, pelo mesmo
adaptador `nacional`, com estado por empresa e ambiente e sem rede. A NFS-e
simulada traz `xOutInf` "sem validade fiscal", chave sintética de 50 dígitos
e o grupo `emit` com CNPJ e nome da empresa, como a NFS-e real.
Marcadores na descrição do serviço escolhem o desfecho, para ensaiar a
integração:

| Marcador                 | Emissão                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| (nenhum)                 | Autoriza no primeiro envio                                                                                            |
| `[simular:rejeicao]`     | Rejeição `SIM100` (definitiva)                                                                                        |
| `[simular:indisponivel]` | Primeiro envio 503 (transitório); depois autoriza                                                                     |
| `[simular:timeout]`      | Primeiro envio autoriza e a resposta se perde; a reconciliação encontra sem reenviar                                  |
| `[simular:perda]`        | Primeiro envio se perde antes do fisco; a reconciliação recebe 404 e reenvia o mesmo XML                              |
| `[simular:duplicada]`    | Como `timeout`, mas a primeira consulta ainda dá 404; o reenvio recebe "DPS já existe" e a consulta seguinte encontra |

No motivo do cancelamento, `[simular:rejeicao]` rejeita com `SIM200` e
`[simular:timeout]` registra o evento e perde a resposta.

## Verificação de mTLS e adesão

`internal.issuanceProbe.verify` prova o caminho real antes de qualquer nota:
abre o A1 ativo da empresa no cofre e faz só `GET`, sem corpo, para origens
fixas (o transporte do probe recusa qualquer outro método, `PROBE_GET_ONLY`).
Não assina nada, não reserva número, não cria operação nem grava artefato. A
política e os alvos dependem do deployment:

- **Sandbox, produção restrita.** A mesma política da emissão (variável de
  transporte e empresa em `FNFE_NFSE_RESTRICTED_COMPANIES`) e os alvos da
  tabela abaixo.
- **Deployment de produção fiscal.** A empresa em
  `FNFE_NFSE_PRODUCTION_COMPANIES` (o gate não é exigido: o probe não emite) e
  só a produção: a consulta de DPS inexistente na Sefin de produção
  (`sefin.nfse.gov.br`), a adesão e os parâmetros municipais no ADN de
  produção (`adn.nfse.gov.br`). A barreira de rede é o `allowedOrigins` do
  `certificateRequest`, fixado na origem de cada leitura; além dela, o probe
  confere o host contra uma lista fixa no código (`PRODUCTION_PROBE_HOSTS`) e
  recusa outro antes de qualquer chamada (`PROBE_HOST_DENIED`). `productionAdhesion` e
  `parameters.production` não mudam nada ali: toda leitura já é de produção.
  O formato do 404 de DPS ausente na Sefin de produção só o probe no
  deployment hospedado revela; os testes usam a Sefin substituída.

Fora da política, a resposta é `ISSUANCE_PROBE_DISABLED`. Empresa de
demonstração e sem A1 ativo e válido são recusadas. Operador e motivo seguem
a mesma regra do [gate de produção](#gate-de-produção) (`operatorAndReason`
em `lib/issuanceGate.ts`): login do GitHub e texto sem controles nem
caracteres bidirecionais, ou `INVALID_REQUEST`. Cada chamada grava
`nfse-probe` em `certificateAudit` (`authorized` ou `denied`, depois
`success`, `failed` ou `stale`), ou `nfse-probe-production` quando as leituras
vão à produção, para o cliente saber contra que ambiente o A1 foi usado, com
o ator genérico `operator:freecorps`: a auditoria do certificado é visível ao
cliente. Quem executou fica no [histórico do probe](#histórico-do-probe), da
Freecorps.

| Chamada                                                                                      | O que responde                                        |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET sefin.producaorestrita.nfse.gov.br/SefinNacional/dps/{Id}`                              | mTLS na Sefin de produção restrita                    |
| `GET preprod-nfseapi.ima.sp.gov.br/notafiscal-ws/nfse/dps/{Id}`                              | mTLS na homologação da IMA (Campinas)                 |
| `GET sefin.producaorestrita.nfse.gov.br/SefinNacional/parametros_municipais/{IBGE}/convenio` | Adesão do município, vista pela Sefin restrita        |
| `GET adn.producaorestrita.nfse.gov.br/parametrizacao/{IBGE}/convenio`                        | Adesão do município, vista pelo ADN restrito          |
| `GET adn.nfse.gov.br/parametrizacao/{IBGE}/convenio`, só com `productionAdhesion: true`      | Adesão no ADN de produção, a fonte citada na ADR 0004 |

O `{Id}` é uma DPS que não pode existir: CNPJ do certificado, município
consultado, série 99999 e número 999999999999999. A leitura no ADN de produção
é de parâmetros públicos do município, nunca de documento, e só acontece se o
operador pedir; nenhuma chamada vai à Sefin de produção nem à produção da IMA.

Resultado: `certificate` (`id`, `version`), `dpsId`, `consultations` (por
alvo: `outcome`, `code`, `httpStatus`, `transportError` e `diagnostic`, o
mesmo da emissão, quando o desfecho é `uncertain`) e `adhesion` (por
fonte: `httpStatus`, `aderenteAmbienteNacional`, `aderenteEmissorNacional`,
`code`) e `parameters` (vazio sem o argumento; veja
[Parâmetros municipais](#parâmetros-municipais)). Como ler:

| Consulta                                                      | Leitura                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `outcome: "not-found"`, `httpStatus: 404`                     | O fisco aceitou o certificado e a API respondeu com o JSON de ausência. É a prova esperada             |
| `outcome: "uncertain"`, `code: "CONSULT_INCONCLUSIVE"`, 404   | 404 sem o JSON do fisco (rota, proxy): leia `diagnostic`. Não prova a API; não emita                   |
| `outcome: "transient"`, `code: "ADN_ACCESS_DENIED"` (401/403) | O gateway recusou o certificado ou o acesso. Não emita                                                 |
| `outcome: "transient"`, `code: "TRANSPORT_FAILED"`            | Sem resposta: veja `transportError` (`CERTIFICATE_TIMEOUT`, `CERTIFICATE_NETWORK_ERROR`, ...)          |
| Outro `outcome: "uncertain"` ou `"found"`                     | Resposta fora do esperado. Investigue pelo `diagnostic`                                                |
| `aderenteEmissorNacional: 1`                                  | O município aderiu ao Emissor Nacional. Com `0`, ver [O que não está provado](#o-que-não-está-provado) |

### Verificação da nota autorizada

`internal.issuanceProbe.verifyIssued` confere, só com leitura, uma emissão
autorizada (ou cancelada) em `production`: consulta a DPS pelo Id
(`GET sefin.nfse.gov.br/SefinNacional/dps/{Id}`) e baixa a NFS-e pela chave
gravada (`GET .../nfse/{chave}`), com o A1 da empresa e o mesmo transporte só
`GET` do probe. `single` é verdadeiro quando a Sefin responde para o Id a chave
gravada e a NFS-e dessa chave traz o `infDPS` com o mesmo Id: é a evidência de
"uma única NFS-e para o Id" da fase 4. Não assina, não envia nem altera a
emissão.

Exige o deployment de produção fiscal e a empresa em
`FNFE_NFSE_PRODUCTION_COMPANIES` (`ISSUANCE_PROBE_DISABLED` fora disso);
emissão de outra empresa responde `NOT_FOUND`, e emissão que não esteja
autorizada ou cancelada em `production`, para `producao` e `sefin-nacional`,
com chave, responde `ISSUANCE_NOT_AUTHORIZED`. Argumentos: `organizationId`,
`companyId`, `issuanceId`, `operator`, `reason`. Resultado: `dpsId`,
`accessKey`, `dps` (`outcome`, `httpStatus`, a chave respondida,
`transportError`), `nfse` (`outcome`, `httpStatus`, `dpsMatches`,
`transportError`) e `single`:

- `true` quando a Sefin responde para o Id a chave gravada e a NFS-e dessa
  chave traz o `infDPS` com o mesmo Id;
- `false` só quando a Sefin responde outra coisa: outra chave para o Id, ou
  uma NFS-e sem essa DPS;
- `null` quando não houve resposta assim (ausente, transitória, ilegível ou
  sem resposta).

Uma leitura sem nenhuma resposta (falha de transporte) termina a execução como
`failed`, e o histórico não grava `single` nela.

A consulta da NFS-e pela chave no ADN de produção não é feita: a página
oficial de APIs (gov.br, "APIs de produção restrita e produção") só lista os
índices da documentação (`adn.nfse.gov.br/contribuintes/docs/index.html`), que
abrem só com certificado de cliente, e o caminho não foi confirmado.

### Histórico do probe

`issuanceProbeEvents` registra cada execução do probe e da verificação, desde
que operador e motivo sejam válidos:

- **Ao começar**, uma linha `authorized` ou `denied`. Toda recusa deixa linha
  `denied` com o código: organização, empresa ou emissão de outra, empresa de
  demonstração, emissão que não pode ser conferida, certificado indisponível e
  fora da política. Assim ninguém sonda uma nota sem rastro.
- **Ao terminar**, uma linha `success`, `failed` ou `stale` que aponta para a
  primeira (`startedId`). Só uma linha `authorized` da mesma empresa e
  certificado é fechada, e só uma vez. Operador, motivo, tipo e ambiente vêm
  da linha inicial, nunca de quem fecha.

Cada linha guarda o login GitHub do operador, o motivo, o tipo (`probe` ou
`verify-issued`), o ambiente (`producao-restrita` ou `producao`), a emissão
conferida, o código da recusa, o resultado de cada leitura (alvo, host,
desfecho e status HTTP, nunca corpo), `single` na verificação concluída,
`buildSha`, URL do deployment e hora. É registro da Freecorps, fora da
auditoria visível ao cliente, só de acréscimo e classe `commercial`
([RETENTION.md](RETENTION.md#histórico-do-probe)).

O login só é confiável quando vem do workflow do GitHub. O
`nfse-production-probe.yml` chama `verify` e `verifyIssued` com o
`triggering_actor` lido da API do GitHub, e só para quem está em
`authorizedActors` de `deploy/issuance-gate.json`. Chamado pelo painel ou pela
CLI do Convex, o operador é o que quem chamou digitou; por isso o acesso ao
painel fica restrito como o do gate.

### Parâmetros municipais

Com o argumento opcional `parameters`, o mesmo probe lê as regras que o fisco
aplica à DPS (por exemplo, a alíquota que gera a rejeição L0006), na API
"Parâmetros Municipais" do ADN. São só `GET`, sem corpo, com o mesmo A1, a
mesma política e a mesma auditoria. Na produção restrita, o ADN de produção
restrita sempre e o de produção (`adn.nfse.gov.br`) só com `production: true`;
no deployment de produção fiscal, só o ADN de produção. Nenhuma leitura de
parâmetros vai à Sefin nem à IMA.

| Argumento       | Formato                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `serviceCode`   | `cTribNac` (6 dígitos, complemento `000`) ou código completo com o complemento municipal (9) |
| `competence`    | `AAAA-MM` (vira o dia 1) ou `AAAA-MM-DD`                                                     |
| `benefitNumber` | Opcional: número do benefício municipal (`nBM`), até 14 dígitos                              |
| `production`    | Opcional: repete as leituras no ADN de produção                                              |

O ADN exige o código do serviço como `II.SS.DD.CCC` (o `cTribNac` mais o
complemento do código municipal) e a competência em data ISO; o probe monta os
dois e recusa outras grafias com `INVALID_REQUEST` antes de abrir o cofre.
Caminhos, todos sob `https://<host>/parametrizacao/{IBGE}`:

| Consulta (`query`)   | Caminho                                      |
| -------------------- | -------------------------------------------- |
| `aliquota`           | `/{serviço}/{competência}/aliquota`          |
| `historicoaliquotas` | `/{serviço}/historicoaliquotas`              |
| `regimes_especiais`  | `/{serviço}/{competência}/regimes_especiais` |
| `retencoes`          | `/{competência}/retencoes`                   |
| `beneficio`          | `/{benefitNumber}/{competência}/beneficio`   |

Fonte: o Swagger da API, `/parametrizacao/docs/index.html` (contrato em
`/parametrizacao/swagger/v1/swagger.json`) nos hosts do ADN listados em
[APIs de produção restrita e produção](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/apis-prod-restrita-e-producao).
A página só abre com certificado de cliente; o Swagger dos contribuintes da
Sefin traz os mesmos caminhos sob `/parametros_municipais`, rota que a Sefin
restrita não serve mais (404 no convênio). O Guia de Utilização das APIs dos
contribuintes (v1.2, out/2025) ainda lista consultas de retenções e benefícios
por CPF/CNPJ; nenhum dos dois Swaggers as tem, e o probe não as faz.

Cada leitura volta em `parameters` com `source`, `query`, `host`, `path`,
`httpStatus`, `bytes`, `code` (erro de transporte saneado) e o corpo: `json`
quando cabe em 8 KB e é um valor válido no Convex, senão `text` com até 8 KB e
`truncated`. O corpo não entra em log. Recusas do serviço também vêm com corpo,
com o motivo em `mensagem` (400 para formato, 404 sem dados). `Aliq` vem em
percentual, numa lista por código completo com `DtIni`/`DtFim` de vigência.

## Runbook

O procedimento do operador está em
[emissao-nfse.md](../operacao/emissao-nfse.md). A
[fase 3](../operacao/emissao-nfse.md#fase-3-produção-restrita) cobre a primeira
emissão em produção restrita. A
[fase 4](../operacao/emissao-nfse.md#fase-4-produção-fiscal) registra o que a
produção fiscal já tem na `main`, os passos humanos que faltam (deployment,
domínios, environments e segredos) e a ordem até a primeira nota.

## Códigos de erro

Na API REST, campos do pedido respondem `400`; estado da empresa, do perfil, da
nota ou da numeração, `409`; gate de produção, `403`. O status de cada código
está em `publicErrorStatus` (`packages/contracts/src/external.ts`), e
`error.field` acompanha os erros de campo.

| Código                                           | Quando                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_API_KEY`                                | Chave ausente, revogada, expirada ou de projeto desativado (`401`)                                                                                                                                                                                                                                                                                                      |
| `ENVIRONMENT_DENIED`                             | `X-Environment` diferente do ambiente da chave                                                                                                                                                                                                                                                                                                                          |
| `SCOPE_DENIED`                                   | Chave sem `documents:issue` (emitir) ou `documents:cancel` (cancelar), ou papel sem escrita                                                                                                                                                                                                                                                                             |
| `NOT_FOUND`                                      | Escopo inexistente, sem concessão, de outra organização/projeto/empresa, ambiente do deployment diferente ou `production` fora do deployment de produção fiscal                                                                                                                                                                                                         |
| `ISSUANCE_PRODUCTION_DISABLED`                   | `production` com a empresa fora de `FNFE_NFSE_PRODUCTION_COMPANIES` ou, para emitir, sem o gate ligado, só depois de o acesso passar                                                                                                                                                                                                                                    |
| `ISSUANCE_DEMONSTRATION_DENIED`                  | Empresa de demonstração                                                                                                                                                                                                                                                                                                                                                 |
| `NFSE_PROFILE_REQUIRED`                          | Empresa sem perfil NFS-e                                                                                                                                                                                                                                                                                                                                                |
| `NFSE_ACTIVITY_NOT_FOUND`                        | `activityCode` fora do perfil vigente                                                                                                                                                                                                                                                                                                                                   |
| `NFSE_ROUTE_UNSUPPORTED`                         | Rota sem canal suportado, ou, em `production`, rota para outro canal que não a Sefin Nacional. Na REST, só código e mensagem; o motivo interno (`ROUTE_ABRASF`, `ROUTE_NO_RULE`, `ROUTE_PRODUCTION`) só chega às funções internas. Na REST, também a exportação recusada por `ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED`, com mensagem própria                                 |
| `NFSE_ROUTE_PROFILE_INCOMPLETE`                  | Rota `campinas-adn` sem `cTribMun`, NBS, IBS/CBS ou série na faixa, ou grupo `IBSCBS` obrigatório pelo Ato Conjunto 4/2026 sem a classificação da atividade, em qualquer canal (`missing` lista os campos)                                                                                                                                                              |
| `ISSUANCE_ISSUER_EMAIL_REQUIRED`                 | Pedido sem `issuerEmail` e perfil sem e-mail do prestador                                                                                                                                                                                                                                                                                                               |
| `ISSUANCE_FIELD_INVALID`                         | Campo de texto, endereço (inclusive o do exterior, todo obrigatório), IBGE, CEP, país ou e-mail inválido (`field` aponta o campo); em `production`, também `description` com `[simular:`                                                                                                                                                                                |
| `ISSUANCE_TAKER_DOCUMENT_INVALID`                | CPF ou CNPJ do tomador com dígito inválido                                                                                                                                                                                                                                                                                                                              |
| `ISSUANCE_TAKER_NIF_INVALID`                     | Tomador estrangeiro sem `nif` e sem `nifAbsence`, ou com ambos                                                                                                                                                                                                                                                                                                          |
| `ISSUANCE_TAKER_INVALID`                         | Mercado interno com tomador estrangeiro                                                                                                                                                                                                                                                                                                                                 |
| `ISSUANCE_EXPORT_TAKER_REQUIRED`                 | Exportação com tomador nacional                                                                                                                                                                                                                                                                                                                                         |
| `ISSUANCE_EXPORT_CURRENCY_REQUIRED`              | Exportação em BRL                                                                                                                                                                                                                                                                                                                                                       |
| `ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED`             | Só nas funções internas (console, Stripe): exportação com o grupo `IBSCBS` obrigatório pelo Ato Conjunto 4/2026 (não optante desde 01/10/2026, ou 01/12/2026 nos subitens 1.03, 1.05, 1.09 e 16.01; Simples desde 01/01/2027), em qualquer canal; a classificação da exportação ainda não tem fonte oficial. Na REST, `409 NFSE_ROUTE_UNSUPPORTED` com mensagem própria |
| `ISSUANCE_CURRENCY_INVALID`                      | Mercado interno em moeda estrangeira                                                                                                                                                                                                                                                                                                                                    |
| `ISSUANCE_CURRENCY_UNSUPPORTED`                  | Moeda fora de BRL, USD, CAD, EUR e GBP                                                                                                                                                                                                                                                                                                                                  |
| `ISSUANCE_AMOUNT_INVALID`                        | Valor não positivo, com mais de 2 casas ou em notação inválida                                                                                                                                                                                                                                                                                                          |
| `ISSUANCE_ISS_RATE_INVALID`                      | Alíquota fora de (0, 5], com mais de 4 casas ou com 3ª/4ª casa diferente de zero                                                                                                                                                                                                                                                                                        |
| `ISSUANCE_ISS_RATE_REQUIRED`                     | Não optante ou retenção sem alíquota, em qualquer canal                                                                                                                                                                                                                                                                                                                 |
| `ISSUANCE_ISS_RATE_NOT_ALLOWED`                  | Optante do Simples sem retenção com alíquota (E0625; em Campinas, L0006 em 09/10/2026)                                                                                                                                                                                                                                                                                  |
| `ISSUANCE_ISS_NOT_LEVIED`                        | Alíquota na exportação                                                                                                                                                                                                                                                                                                                                                  |
| `ISSUANCE_WITHHOLDING_INVALID`                   | Retenção na exportação ou com tomador CPF                                                                                                                                                                                                                                                                                                                               |
| `ISSUANCE_COMPETENCE_INVALID`                    | Competência fora de `AAAA-MM`                                                                                                                                                                                                                                                                                                                                           |
| `ISSUANCE_COMPETENCE_FUTURE`                     | Competência posterior ao mês da emissão                                                                                                                                                                                                                                                                                                                                 |
| `ISSUANCE_DATE_INVALID` / `ISSUANCE_DATE_FUTURE` | `issueDate` inválida ou futura                                                                                                                                                                                                                                                                                                                                          |
| `CERTIFICATE_UNAVAILABLE`                        | Transporte real sem A1 ativo e válido da empresa                                                                                                                                                                                                                                                                                                                        |
| `ISSUANCE_PROBE_DISABLED`                        | `issuanceProbe.verify` ou `verifyIssued` fora da política do deployment (produção restrita no sandbox; empresa na lista no deployment de produção fiscal)                                                                                                                                                                                                               |
| `IDEMPOTENCY_CONFLICT`                           | Mesma chave com outro pedido                                                                                                                                                                                                                                                                                                                                            |
| `DPS_NUMBER_EXHAUSTED`                           | Série chegou a 15 dígitos                                                                                                                                                                                                                                                                                                                                               |
| `CANCEL_REASON_INVALID`                          | Motivo com menos de 15 ou mais de 255 caracteres ou, em `production`, com `[simular:`                                                                                                                                                                                                                                                                                   |
| `ISSUANCE_NOT_CANCELLABLE`                       | Cancelamento de emissão não autorizada                                                                                                                                                                                                                                                                                                                                  |
| `ISSUANCE_TRANSPORT_CHANGED`                     | Cancelamento com transporte do deployment diferente do que autorizou                                                                                                                                                                                                                                                                                                    |

Códigos da operação (em `operations.code` e na emissão rejeitada):
`ADN_REJECTED`, `ADN_UNAVAILABLE`, `ADN_RATE_LIMITED`, `ADN_ACCESS_DENIED`,
`TRANSPORT_UNCERTAIN`, `RESPONSE_UNREADABLE`, `HTTP_UNEXPECTED`,
`DPS_ALREADY_EXISTS`, `CONSULT_INCONCLUSIVE`, `TRANSPORT_FAILED`,
`NFSE_DOWNLOAD_PENDING`, `NFSE_DPS_MISMATCH`, `PTAX_UNAVAILABLE`,
`ISSUANCE_TRANSPORT_DISABLED`, `ISSUANCE_RESEND_BLOCKED` (reenvio em produção
com o gate desligado), `ISSUANCE_TARGET_INVALID` (origem fora da lista fixa de
produção),
`ISSUANCE_CHANGED`, códigos locais do pacote (`DPS_FIELD_INVALID`,
`DPS_SCHEMA_INVALID`, `EVENT_FIELD_INVALID`, `EVENT_SCHEMA_INVALID`,
`DPS_ID_MISMATCH`, `ENVIRONMENT_MISMATCH`...) e os genéricos de
[OPERATIONS.md](OPERATIONS.md). Os locais são definitivos e nada é
transmitido:

| Código                 | Quando                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DPS_FIELD_INVALID`    | Campo da DPS vazio, longo ou fora do formato, como `verAplic` acima de 20 ou endereço do exterior incompleto (snapshot anterior à regra) |
| `DPS_SCHEMA_INVALID`   | DPS montada em desacordo com o XSD oficial; a rejeição traz o elemento e a regra                                                         |
| `EVENT_FIELD_INVALID`  | Campo do pedido de cancelamento inválido                                                                                                 |
| `EVENT_SCHEMA_INVALID` | Pedido de cancelamento em desacordo com o XSD oficial                                                                                    |

## Divergências com a ADR 0004

- **Webhooks.** A ADR prevê eventos de emissão autorizada, rejeitada, cancelada
  e "em reconciliação". Não há evento de reconciliação: ela é estado da
  operação (`operationState: reconciling`), não transição da nota, e repetiria
  a cada tentativa. Em troca existe `issuance.cancellation_rejected`, porque a
  rejeição de um cancelamento muda o que o integrador pode fazer.
- **Reconciliação do cancelamento.** A ADR prevê consulta da NFS-e. O pacote não
  tem consulta de eventos; a reconciliação reenvia o pedido persistido, cujo Id
  é determinístico e cuja repetição volta como "evento já registrado".
- **Envio de XML persistido.** O adaptador `nacional` ganhou `submitDps` e
  `submitCancelEvent`, que enviam um XML já montado e assinado. `issue` e
  `cancel` continuam montando, assinando e chamando esses métodos.
- **Deployment de produção fiscal.** A ADR (§8, emendas de 21/10/2026) põe a
  produção num deployment separado. A plataforma exige, além do marcador no
  ambiente, o nome e a URL versionados em `deploy/issuance-production.json`;
  é uma restrição a mais, não muda a decisão.
- **Produção restrita por empresa.** A ADR (§8) liga a produção restrita
  pelo deployment. A plataforma exige também a empresa em
  `FNFE_NFSE_RESTRICTED_COMPANIES`, porque o deployment hospedado é
  compartilhado; é uma restrição a mais, não muda a decisão.
- **Série por destino.** A ADR fala em série por destino e ambiente. O perfil
  tem uma série para a Sefin Nacional e outra, opcional, para Campinas; o
  ambiente não muda a série, mas a numeração e o número inicial são separados
  por ambiente.

- **Grupo `dest` em Campinas.** A ADR lista `dest` entre as exigências da IMA,
  observadas no homolog antigo. O XSD oficial põe `dest` dentro de `IBSCBS` e
  o Anexo I (E0910) só o admite com `indDest` 1; a plataforma manda `indDest` 0
  e não envia `dest`. Pela mesma fonte, a DPS não leva `cLocIncid` e põe
  `pAliq` depois de `tpRetISSQN`.
- **Exportação com o grupo `IBSCBS` obrigatório (C7).** A ADR põe o Simples na
  Sefin Nacional, desde 01/01/2027, "com grupo IBS/CBS obrigatório", sem
  distinguir a exportação. A plataforma monta o grupo nessas notas, mas recusa
  a exportação com `ISSUANCE_EXPORT_IBSCBS_UNSUPPORTED` enquanto o `cIndOp`, o
  CST e o `cClassTrib` da exportação não tiverem fonte oficial (#198, #338); o
  mesmo vale para o não optante desde 01/10 ou 01/12/2026. Para a Freecorps,
  isso bloqueia a exportação a partir de 2027 até a resposta.

## O que não está provado

Em 02/11/2026, a fase 3 provou a exportação na Sefin Nacional: uma NFS-e de
exportação do Simples de Campinas (C6), com tomador sem NIF, foi autorizada e
cancelada na produção restrita, com a DPS no leiaute da NT 009
(evidência). Antes, em 09/10/2026,
a fase 3 provou uma nota doméstica de Simples sem retenção no
canal de Campinas, autorizada e cancelada na homologação da IMA com o A1 do
cofre (evidência): mTLS real na Sefin restrita e na
IMA, RSA-SHA1 na DPS e no evento, os caminhos `{base}`, `{base}/dps/{id}`,
`{base}/{chave}` com a chave de 50 dígitos e `{base}/{chave}/eventos` da IMA,
a reconciliação e a retomada da operação incerta, a PTAX real do BCB, os
parâmetros municipais e a adesão no ADN restrito e de produção e o DANFSe
gerado de uma NFS-e real. O que segue continua sem prova real:

- A produção fiscal: nenhuma nota saiu dela, e nenhum deployment é produção
  fiscal. Os testes cobrem o cofre, o transporte para `sefin.nfse.gov.br` com
  `tpAmb` 1, a reconciliação depois de um timeout e os casos negados com o
  plano substituído por um deployment sintético, A1 sintético e a Sefin
  substituída.
- Exportação na IMA: a DPS de exportação passa no XSD e volta com E0187, com
  ou sem NIF. Ela atende à regra 234, mas o `cIndOp` 100501 contraria o
  Anexo VII v1.03.00 para adquirente no exterior; a causa não foi
  identificada (veja [Canal de Campinas](#canal-de-campinas)). Nenhuma
  exportação foi autorizada. A exportação de não optante pelo `campinas-adn`,
  que continua nesse canal depois de 01/11 (C2 a C4), não tem prova e
  provavelmente volta com o mesmo E0187.
- Sefin Nacional de produção: nenhuma DPS foi a ela. Na produção restrita, a
  primeira DPS (02/11/2026, série 2 nº 100000) voltou com E1235 porque seguia
  o pacote de produção v1.01-20260209; com o leiaute da NT 009
  ([XSD oficial antes de assinar](#transmissão-e-reconciliação)), a seguinte
  foi autorizada e cancelada. Ficam sem prova o tomador com NIF e a
  reconciliação depois de um timeout real na Sefin. A Sefin de produção (`tpAmb` 1)
  continua no pacote v1.01-20260209, o da Documentação Atual; se ela adotar a
  NT 009 antes da fase 4, a DPS de produção também precisa trocar de leiaute
  (pré-condição 6 do
  [runbook](../operacao/emissao-nfse.md#pré-condições-para-ligar-o-gate)).
  Em 02/11/2026, o ADN de produção dava
  `aderenteEmissorNacional` 0 para Campinas, como em 09/10; uma notícia do Portal NFS-e de
  28/09/2026 indica, como hipótese sem prova, que a partir de 01/11/2026 o
  Simples pode usar os emissores nacionais independentemente da opção do
  município. O flag e o E0039 depois de 01/11/2026 são dados a colher
  ([adesão e E0039](../operacao/emissao-nfse.md#8-prova-da-exportação-na-sefin-a-partir-de-01112026)),
  e a pré-condição de adesão da fase 4 não muda. Os testes cobrem a Sefin com
  A1 sintético e transporte substituído, inclusive a exportação do Simples de
  Campinas desde 01/11 com NIF e `cNaoNIF` 1 e 2, no XSD oficial; o roteiro da
  prova real está em
  [emissao-nfse.md](../operacao/emissao-nfse.md#8-prova-da-exportação-na-sefin-a-partir-de-01112026).
  A IM nunca vai à Sefin (E0120), na premissa não verificada de que a empresa
  não tem registro complementar no CNC de Campinas; se tiver, a Sefin
  responde E0116 (ou E0084) e o envio da IM precisa mudar.
- IBS/CBS na Sefin: a DPS leva o grupo `IBSCBS` pelas datas do Ato Conjunto
  4/2026 ([Grupo IBSCBS](#grupo-ibscbs)), mas nenhuma DPS com o grupo foi
  enviada à Sefin: os testes provam o XSD com o fisco simulado. Os códigos
  `100501`/`000`/`000001` do perfil vêm da homologação de Campinas e não foram
  conferidos para o não optante nem para o Simples de 2027. A exportação com o
  grupo obrigatório fica recusada até a resposta oficial sobre `cIndOp`, CST e
  `cClassTrib` (#198); para a Freecorps, isso começa em 01/01/2027.
- O formato de sucesso do envio à IMA: o envio autorizado virou
  `RESPONSE_UNREADABLE` antes de existir o diagnóstico, e a tentativa não tem
  `diagnostic`. A reconciliação resolve o desfecho; o `diagnostic` da próxima
  emissão mostrará o formato.
- O critério do 404 contra o fisco: os probes de 09/10/2026 rodaram antes dele,
  e nenhuma consulta real voltou 404 depois. Os testes provam o 404 com e sem o
  JSON de ausência com o fisco substituído; não se sabe se a IMA e a Sefin
  trazem esse JSON no 404 de DPS ausente.
- Outros perfis no canal de Campinas: os códigos IBS/CBS e a exigência de
  valores IBS/CBS de não optante não foram conferidos. A retenção também não
  foi autorizada: para 01.05.01.001, a L0009 diz que o serviço não está
  sujeito a ela.
- A `<IM>` não resolveu a L0006 (a mesma rejeição veio com e sem ela) e foi na
  nota autorizada; não se sabe se a IMA a exige.
- O XSD é condição necessária, não suficiente: as regras de negócio do Anexo I
  (E0xxx) só o fisco aplica. O padrão oficial de `serie` (`TSSerieDPS`) traz
  `^` e `$`, que o XSD trata como caracteres; o catálogo de runtime tira as
  duas âncoras (registro no manifesto). Que o validador do fisco leia o padrão
  da mesma forma é inferência: a DPS real com série 20001 foi autorizada.
- O leiaute do DANFSe frente à norma do DANFSe nacional não foi conferido. O
  PDF da nota real foi gerado e tem o `sha256` na evidência; o rótulo e o nome
  do arquivo do download pelo console têm só teste de componente.
- REST, SDK e webhooks de emissão, inclusive o download do DANFSe pela REST e
  pelo SDK, foram provados com `convex-test`, transporte simulado e destinos
  sintéticos (`platform/convex/issuanceRest.test.ts`, `packages/sdk/index.test.ts`);
  nenhuma chamada passou pelo Worker hospedado nem entregou webhook de emissão
  a um receptor real.
- O gate de produção diante de um chamador com acesso: nenhum deployment é
  `production`, e o teste simula um (substituindo
  `requirePlatformEnvironment`) para provar que o acesso vem antes do gate.
