# Projetos, concessões e chaves de API

Recorte da gestão de projetos e chaves.
Backend em `platform/convex`, painel em `apps/console`. O legado mantém
seu host, autenticação e contratos. Better Auth identifica pessoas; a chave
identifica um projeto da organização, sem criar uma sessão humana.

Projeto e concessão servem às integrações: API keys e webhooks. Pessoas no
console trabalham direto na empresa, sem escolher projeto
([Console sem projeto](#console-sem-projeto), [ADR 0005](../adr/0005-console-sem-projeto.md)).

## Permissões e identidade

A importação XML acrescenta o consumidor real de `documents:import`, com reserva,
upload, confirmação e resultado por arquivo. O [contrato de importação](IMPORTS.md)
e seus recibos locais complementam as provas anteriores
de autorização. Essa entrega candidata não altera o ambiente publicado.

| Ator                                        | Gestão de integrações                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Owner/admin                                 | Projetos de integração da organização e empresas que a organização administra          |
| Developer                                   | Projetos criados pelo próprio membership ativo e empresas concedidas a esse membership |
| Operator/viewer, anônimo ou membro removido | Sem acesso à gestão de projetos/chaves                                                 |

Developer pode conceder escopos de leitura e `webhooks:manage`. Escritas
fiscais e administrativas permanecem limitadas ao papel. Owner/admin têm
o catálogo completo. Cada criação/alteração revalida o ator na mutation,
inclusive quando uma action gerou o segredo antes dessa transação.
`validationAccess` não participa desta autorização.

`projects` reserva referência externa única por organização. Repetir nome
e referência devolve o projeto acessível existente; divergência ou projeto
inacessível responde `PROJECT_CONFLICT`, sem revelar seu ID. Alterações exigem
a versão observada. O limite atual é de 50 empresas ativas por projeto e
50 empresas por chave. As listas administrativas são paginadas, até 50 linhas.

`projectCompanies` concede empresa, escopos e ambientes. Uma chave seleciona
um subconjunto de empresas e escopos, com um único ambiente. A autorização REST
é a interseção entre a chave e cada concessão vigente. Reduzir o acesso do
projeto afeta as chaves existentes. Revogar uma concessão incrementa sua época;
conceder novamente não reativa chaves da época anterior. Desativar um projeto
invalida todas as suas chaves, mesmo após reativação.

As credenciais pertencem ao projeto, não à sessão ou ao emprego de quem as criou.
Remover o criador ou sua concessão humana impede novas operações administrativas,
mas não encerra integrações existentes. Owner/admin podem revogar a chave,
remover a empresa do projeto ou desativá-lo. O retorno de um developer removido
não recupera automaticamente a administração de seus projetos antigos.

Empresas de demonstração aceitam apenas sandbox. O modelo reconhece sandbox e
production; o deployment de validação atende somente sandbox e mantém
`FISCAL_ENV=disabled`. Homologação fiscal não é um ambiente do produto.

## Segredo e ciclo de vida

- Uma action usa 32 bytes de Web Crypto para gerar `fnfe_...`. O banco guarda
  SHA-256, prefixo de identificação e metadados, nunca o segredo original.
- Criação e rotação devolvem `secretOnce` uma única vez. Listas não retornam
  hash nem segredo. Auditoria conserva ator, alvo, ação e data, sem credenciais.
- A data de expiração é obrigatória, futura e inteira em milissegundos UTC.
  REST usa o relógio do servidor e recusa exatamente em `expiresAt`.
- Revogação é idempotente e bloqueia novas chamadas após sua confirmação.
- Rotação cria outra credencial atomicamente e consome o direito de rotacionar
  a anterior. A coexistência padrão é zero; pode chegar a 24 horas, sempre
  limitada pela expiração anterior. A substituta preserva ou reduz validade,
  empresas e escopos. Duas rotações concorrentes não criam duas substitutas.
  Para renovar a validade, crie uma chave nova e revogue a anterior.

O painel descarta o segredo ao fechar, navegar, trocar organização, desconectar
ou perder o contexto autorizado. Respostas atrasadas não recuperam um segredo
de formulário desmontado/fechado. O valor não vai para URL, localStorage,
sessionStorage, exemplos, analytics, capturas, HAR ou traces.
O evento `pagehide` limpa estado e DOM antes de uma navegação completa poder
preservar a página no cache de Voltar/Avançar do navegador.

A listagem distingue chaves invalidadas pelo projeto e concessões alteradas.
Rotação só é oferecida quando há uma empresa na época/ambiente vigente e pelo
menos um escopo que a chave antiga, o projeto e o ator ainda permitem. O
formulário começa sem empresas ou escopos ocultos que o usuário perdeu.

## Painel de integrações

O projeto tem quatro abas próprias (`TabNav` "Seções do projeto"): Empresas e acesso,
Chaves de API, Webhooks e Primeira chamada. Os escopos aparecem agrupados por
intenção — Importar e consultar documentos, Emitir e cancelar NFS-e,
Webhooks, Cadastro e consulta CNPJ e Captura de NF-e — com descrição curta; o
código técnico (`documents:import` etc.) fica em "Ajustar escopos técnicos".
Uma concessão nova começa com documentos, webhooks e listagem de empresas
(limitados ao que o papel pode conceder), e a única empresa da organização já
vem selecionada.

A chave herda por padrão as empresas e os escopos concedidos ao projeto no
ambiente escolhido; marcar menos restringe. Só aparecem escopos que alguma
empresa concedida tem. Nenhuma empresa some por causa de escopo: se uma
empresa marcada não tem um escopo marcado, a linha mostra o que falta e
"Gerar chave" explica o bloqueio. O servidor continua exigindo chave ⊆
concessão. "Criar chave", "Rotacionar", "Gerar chave", "Salvar concessão" e
"Novo destino" mostram o motivo quando indisponíveis.

`projects.get` devolve `deploymentEnvironment`, o ambiente base do
deployment (`PRODUCT_ENV`; `sandbox` no site). Os ambientes que uma concessão
ou chave nova pode nomear para cada empresa vêm de
`projects.offeredEnvironments` e do campo `offeredEnvironments` de
`projects.companies`: o ambiente base e, no site, `production` enquanto a
captura fiscal da empresa estiver liberada
([liberação fiscal](CAPTURE.md#liberação-fiscal-no-site)). Ali, a chave de
produção lê empresa e documentos capturados, consulta e controla a captura e
gerencia webhooks; importação, emissão, referências e CNPJ continuam só no
sandbox. Na concessão, o painel mostra o ambiente não oferecido como
"indisponível neste ambiente da plataforma" e não o deixa marcar, e
`projects.grantCompany` recusa com `ENVIRONMENT_DENIED` um ambiente novo na
concessão que `environmentOffered` não oferece para a empresa (#493). O
ambiente que a concessão ativa já tem continua: depois de desativada a
captura, a concessão salva com Produção segue editável e removível, mas
Produção retirada dela, ou de uma concessão removida, só volta com a captura
liberada. Na chave nova, Produção fica desativada enquanto nenhuma empresa
concedida a oferece.

O servidor confere a chave de produção no site: criar uma exige a captura
fiscal liberada em cada empresa da chave (`environmentOffered`), senão
`ENVIRONMENT_DENIED`; a rotação só exige que a empresa ainda seja atendida em
leitura, o que inclui a captura desativada. Ligar a captura fiscal revoga as
chaves de `production` da organização que alcançam a empresa: uma chave de
produção existe só depois da liberação.

Desativar o projeto é um botão separado do nome. Desativar o projeto, revogar
chave, remover o acesso de uma empresa, desativar destino de webhook e
reenviar uma entrega pedem confirmação em diálogo modal (`ConfirmDialog`): o
foco começa em cancelar, fica preso no diálogo, Escape cancela, o resto da
página fica inerte, uma recusa do servidor aparece no próprio diálogo e o foco
volta ao botão de origem (ou à lista, se o botão sumiu). Segredos de chave e
de webhook aparecem uma vez, com aviso de uso único e botão Copiar com
retorno de sucesso ou falha.

### Conectar meu sistema

O percurso guiado (#512, `apps/console/src/connect-system.tsx`, rota
`…/developer/connect[/:projectId]`) leva do projeto à primeira chamada sem
juntar nada no servidor: chama `projects.create`, `projects.grantCompany` e
`keys.create`, com as mesmas validações, limites e erros das abas. A entrada
fica no cabeçalho e na lista vazia de Projetos; no projeto ativo, "Continuar
configuração guiada" retoma o percurso. Só `owner`, `admin` e `developer`
chegam a ele, como nas demais seções de Integrações.

As empresas vêm de `projects.grantCandidates`, uma consulta só de leitura e
paginada que devolve, para cada empresa que a pessoa pode conceder (as mesmas
de `companies.list`: todas para gestores, só as das próprias concessões para o
developer), os ambientes oferecidos (`offeredEnvironments`) e a versão salva
da concessão, também de uma concessão removida (0 sem nenhuma). Ela exige o
mesmo acesso ao projeto que `projects.companies` e não altera nada; o percurso
não abre uma assinatura por empresa.

1. **Projeto.** Nome e referência, sugerida a partir do nome e editável antes
   de criar. Depois de criado, só o `projectId` vai para o endereço; nenhum
   segredo ou escolha fica na URL ou no armazenamento do navegador. A mesma
   referência com o mesmo nome reabre o projeto (`reused`), e o painel avisa
   uma vez que ele foi reaberto; outro nome dá `PROJECT_CONFLICT`. Limite de
   criação e falta de vaga no plano aparecem com o aviso de Uso e limites.
2. **Empresas e permissões.** Ambiente, um preset de permissões e as
   empresas. Numa instalação de Produção, o ambiente é só Produção. No
   Sandbox hospedado, Produção só fica disponível quando alguma empresa a
   oferece (captura fiscal liberada); senão a opção fica desativada com o
   motivo. Ali, Produção atende só leitura, captura e webhooks: a lista
   `releasedProductionScopes`, de `packages/contracts`, que o servidor usa em
   `releasedPurposes` e o painel usa nas escolhas. Os presets com importação ficam desativados com o
   motivo e "Escolher uma a uma" oferece só esses escopos. Os presets só
   aparecem inteiros quando o papel pode conceder todos os escopos: o
   developer vê só os de leitura. A lista dos códigos exatos, com o nome em
   português, aparece antes de conceder e antes de gerar a chave. Uma empresa
   sem o ambiente escolhido não pode ser marcada e mostra o motivo (a de
   demonstração só em Sandbox).
3. **Chave de API.** Gera a chave com exatamente as empresas, os escopos e o
   ambiente do passo anterior. O segredo aparece uma vez em `OneTimeSecret`,
   guardado só no estado React (`useSecretOnce`), e recebe o foco. Enquanto a
   chave é gerada e enquanto o segredo está na tela, as escolhas do passo 2
   ficam travadas. A lista mostra só as chaves utilizáveis; as demais ficam
   em Chaves de API.
4. **Primeira chamada.** Decidida pela chave que conclui o passo 3, pelos
   escopos dela, em qualquer instalação. Com `documents:import` e
   `documents:read` em Sandbox e a empresa de demonstração entre as da chave,
   o link leva à aba Primeira chamada, porque o XML sintético só vale para
   ela. Senão, o painel diz o que falta (escopo, ou que só proprietários e
   administradores concedem a importação) ou orienta a importar um XML da
   própria empresa, e aponta o guia de importação ou da captura. O painel não
   declara a integração pronta: isso só a primeira chamada prova.

Retomar não duplica nem amplia em silêncio. As regras ficam em funções puras
de `connect-system.tsx` (`resumeChoice`, `servedScopes`, `grantSteps`,
`matchingKey`, `connectPlan`, `environmentChoices`, `firstCallFor`), e o passo
atual sai do servidor: `projects.get`, `projects.companies`,
`projects.grantCandidates` e `keys.list`. O ambiente retomado é o único que as
concessões e as chaves do projeto usam, quando há um só; senão, o da
instalação. As empresas e as permissões voltam da chave utilizável mais
recente nesse ambiente ou, sem ela, das concessões salvas, filtradas pelo que
o papel concede e o ambiente atende; um preset só fica marcado quando é
exatamente esse acesso, senão "Escolher uma a uma"; empresas salvas sem
escopo em comum começam em "Escolher uma a uma" sem nada marcado. Uma empresa
retomada que não está na página carregada aparece no topo da lista. Uma
empresa escolhida que nenhuma lista mostra mais (acesso perdido, concessão
removida em outra aba, ou ainda fora das páginas carregadas) continua visível
e desmarcável, com o motivo, e bloqueia "Conceder acesso" até ser desmarcada
ou encontrada.

Empresa cuja concessão já cobre o escolhido fica intocada. Se falta algo, a
proposta mantém tudo o que a concessão salva tem e acrescenta só o que falta
(`projects.grantCompany` substitui escopos e ambientes, então mandar só o
preset retiraria acesso de outras chaves); o painel lista o que entra por
empresa e só envia depois de "Confirmo estas alterações", com o
`expectedVersion` lido (`GRANT_CHANGED` se mudou nesse meio-tempo; a
confirmação vale só para aquela diferença). Se a concessão salva tem um
escopo que o papel não concede, como a importação que um proprietário deu, o
servidor recusaria a lista inteira (`SCOPE_DENIED`): o painel bloqueia com o
motivo e não oferece a confirmação. "Conceder acesso" espera a oferta e a
versão de cada empresa marcada e bloqueia antes de passar do limite de 50
empresas com acesso ativo no projeto, que `projects.grantCompany` recusaria
com `PROJECT_COMPANY_LIMIT`. A conta usa as concessões que a pessoa vê: um
desenvolvedor não vê as empresas fora do seu acesso, e aí o servidor pode
recusar com `PROJECT_COMPANY_LIMIT`, que o painel mostra. Se uma lista recomeça a carregar depois da
primeira vez, o painel mantém os últimos dados, e o passo com o segredo não
sai da tela.

O passo 3 só conta como concluído com uma chave no ambiente que cobre as
empresas e os escopos escolhidos e segue utilizável: não revogada, expirada,
invalidada pelo projeto, rotacionada nem com concessões alteradas. O painel
lê outras páginas de `keys.list` só enquanto não acha essa chave, sem
esconder o percurso. A validade é conferida pelo relógio local, a cada
minuto e quando a janela volta ao foco. Uma concessão salva com Produção cuja
liberação foi retirada não aceita chave nova: "Gerar chave" fica desativado
com o motivo. Como o segredo não volta, o painel oferece gerar outra chave e
revogar a anterior em Chaves de API.

Depois de uma ação da pessoa (criar o projeto, conceder, guardar o segredo,
gerar outra chave), o foco vai ao título do passo seguinte ou ao primeiro
campo. Uma mudança que vem de fora, como uma chave que expira ou outra aba,
só é anunciada numa região discreta, sem mover o foco. O teste
`apps/console/src/connect-system.test.tsx` cobre esses caminhos, e
`platform/convex/environmentIsolation.test.ts` cobre `projects.grantCandidates`
(papéis, outra organização, demonstração e empresa declarada, liberação e
versão de concessão removida).

A Primeira chamada é a jornada do guia público `/docs/primeira-chamada` (#514):
importar a NF-e sintética com `quickstart-curl.mjs`, um script Node que
executa curl, e consultar o documento. A aba mostra o ambiente (Sandbox, que o
script fixa em `X-Environment`), a URL da API sem `/v1`, os escopos
`documents:import` e `documents:read` e, com botão de copiar, o ID de cada
empresa com concessão ativa em Sandbox que tenha os dois. A empresa de
demonstração vem primeiro, marcada, porque o XML de exemplo só vale para ela
(`projects.companies` devolve o `kind` de cada empresa concedida). Sem nenhuma
empresa que sirva, ou sem a de demonstração entre elas, um aviso indica
Primeiros passos e Empresas e acesso. Seguem os passos (chave, downloads,
variáveis em PowerShell e Bash, execução), o resultado esperado e a
recuperação de cada erro. Webhooks ficam como próximo passo, com a verificação
de `X-Fnfe-Signature` em Node.js sem SDK. O teste
`apps/console/src/integration-flow.test.tsx` confere que os escopos são os das
rotas que o script chama no OpenAPI, que o guia traz os mesmos comandos e a
mesma tabela de erros e executa o verificador contra os vetores de
`packages/contracts/fixtures/webhooks.json`. As capturas em
console-fluxo-integracoes
são da aba anterior à #514, que consultava empresas. A jornada atual, do
cadastro ao JSON do documento e à repetição idempotente, está registrada em
evidence/514.

## Contrato REST disponível

A gestão de operações acrescenta [consulta e controle de operações](OPERATIONS.md), usando
o escopo da tarefa original e as concessões vigentes deste projeto.

| Método e rota                           | Resultado                                                    |
| --------------------------------------- | ------------------------------------------------------------ |
| `GET /v1/companies?limit=20&cursor=...` | `{ data: Company[], nextCursor: string ou null, requestId }` |
| `GET /v1/companies/:id`                 | `{ data: Company, requestId }`                               |

Ambas exigem `Authorization: Bearer ...`, `X-Environment` igual ao ambiente
da chave e `companies:read`. Uma chave de `production` lista só as empresas
que a Produção atende, as com a captura fiscal liberada ou já desativada.
`Company` contém `id`, `name`, `cnpj`, `kind`,
`registryStatus: not-consulted` e `fiscalAccess: not-configured`. IDs são strings
opacas; consumidores não dependem de `_id`, `_creationTime`, schema ou docs
internos do Convex. Cadastro declarado não significa autorização fiscal.

O cursor é vinculado à chave e ambiente, nunca concede acesso por si próprio.
Cada página revalida as concessões. Ela pode ficar vazia após uma revogação;
continue enquanto houver `nextCursor`. O limite aceito é de 1 a 50.

Erros retornam `{ requestId, error: { code, message, retryable } }`, sem stack.
Todas as respostas dessas rotas contêm `X-Request-Id` e `Cache-Control: no-store`.
O servidor gera requestId, sem confiar em valores do consumidor.

| HTTP | Código                                                  | Significado                                                   |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------- |
| 400  | `INVALID_QUERY`, `INVALID_PAGINATION`, `INVALID_CURSOR` | Consulta ou cursor inválido                                   |
| 401  | `INVALID_API_KEY`                                       | Ausente, inválida, expirada, revogada ou projeto desativado   |
| 403  | `SCOPE_DENIED`, `ENVIRONMENT_DENIED`                    | Escopo ou ambiente não autorizado                             |
| 404  | `NOT_FOUND`                                             | Empresa inexistente ou não visível, sem distinguir os casos   |
| 429  | `RATE_LIMITED`                                          | Limite técnico; `retryable: true` e `Retry-After` em segundos |
| 503  | `UNAVAILABLE`                                           | Dependência/configuração indisponível; retentativa permitida  |

Exemplo para bash, executado no ambiente seguro do integrador:

```bash
export FREECORPS_API_KEY='COLE_O_SEGREDO_NO_SEU_AMBIENTE'
curl --fail-with-body 'https://api.nfe.freecorps.com.br/v1/companies?limit=20' \
  -H "Authorization: Bearer $FREECORPS_API_KEY" \
  -H 'X-Environment: sandbox'
```

Na instalação hospedada, o quickstart e os downloads do console usam o endereço
público da API, que registra o IP de cada acesso. Outras instalações usam o
host do backend configurado no build.
Os demais escopos do catálogo atendem as rotas de documentos, importação,
captura, webhooks, referências e CNPJ listadas na
[referência REST](../v1.0/API-REFERENCE.md), com OpenAPI e SDK em [SDK.md](../v1.0/SDK.md).
`companies:write`, `certificates:read` e `certificates:write` não têm rota
REST; conceder um escopo não cria rota nova.

## Auditoria e medição

`integrationAudit` registra alterações na mesma transação. Consultas REST
de empresas autorizadas gravam recibos em `apiUsageEvents`, deduplicados por requestId,
com organização, projeto, chave, rota, ambiente, dia e partição de 0 a 15.
Não armazenam URL, corpo, segredo, hash da chave ou conteúdo da empresa.
Não há escrita em contador global ou `lastUsedAt` no caminho de cada chamada.
O [limite técnico REST](USAGE.md#proteção-das-requisições-rest) atua antes da
consulta: 60 requisições/minuto por chave e 120 por organização, com reposição
contínua. Recusas têm diagnóstico amostrado e não criam recibos. Após 30 dias
completos, os recibos são compactados em totais por organização, projeto,
ambiente e rota, sem apagar histórico fiscal. A [retenção](USAGE.md#retenção)
inclui ativação para recibos antigos. Esses totais não são cobrança nem
dashboard de consumo.

## Dependência para a importação

Projetos, concessões e geração de chaves são a base de autorização da importação.
Owner/admin podem conceder `documents:import` para uma empresa e ambiente;
developer não pode ampliar seus escopos para essa escrita. A gestão de operações consome a
mesma credencial em `operations.reserve` e na consulta REST de operações.
O teste em `platform/convex/keys.test.ts` cria a chave pelas funções públicas,
reserva uma operação sintética, recusa uma chave apenas de leitura e verifica
rotação sem duplicar a intenção e revogação do acesso REST.

Essa prova cobre autorização e identidade da solicitação. A reserva é interna
e recebe a tarefa construída pelo servidor. Ela não implementa um endpoint
de upload, não processa XML e não comprova deduplicação documental.
Reserva/upload/confirmação, storage privado, participantes, artefatos e
versões de processamento pertencem à importação XML. A rotação permite consultar e
reencontrar a intenção com a substituta; não altera a credencial de origem
da operação nem contorna a revalidação de execução da gestão de operações.

## Provas de execução

`platform/convex/keys.test.ts` cobre REST e funções diretas, concessões,
concorrência e tempo. `apps/console/src/secret-once.test.tsx` cobre respostas
atrasadas. `apps/console/e2e/keys.mjs` exercita UI e HTTP no Convex local.
Resultados e limitações ficam no recibo da gestão de projetos e chaves.

## Consulta documental

O contrato [DOCUMENTS.md](DOCUMENTS.md) consome `documents:read` sem exigir
`documents:import` para consultar itens, versões e originais. Reprocessamento
exige ambos. Projeto e concessão são revalidados em cada acesso; tickets do
painel incluem as versões de acesso. A matriz negativa e a jornada nativa
estão em evidence/72.

## Emissão NFS-e

`documents:issue` autoriza pedir emissões e `documents:cancel`, pedir
cancelamentos; consultar uma emissão aceita qualquer um dos dois. Valem como os
demais escopos: na chave, na concessão ativa do projeto para a empresa e o
ambiente, e só owner/admin podem concedê-los (developer não delega operação
fiscal). Membros do console não dependem de concessão de projeto (seção
abaixo). `documents:import` não autoriza emissão. Veja [ISSUANCE.md](ISSUANCE.md).

## Console sem projeto

Decisão dos sócios de 09/10/2026, registrada na
[ADR 0005](../adr/0005-console-sem-projeto.md). Pessoas no console trabalham na
empresa: membership ativa, acesso do membro à empresa (`findCompany`; gestores
veem todas, os demais pelas `companyGrants`) e papel. A regra fica em
`memberAccess` (`platform/convex/lib/operationAccess.ts`).

| Papel       | Leitura no console (documentos, importações, emissões, captura, operações) | Escrita (importar, reprocessar, emitir, cancelar, consultar CNPJ, controlar captura e operações) |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `owner`     | Todas as empresas                                                          | Sim; transferir captura e aplicar cadastro também                                                |
| `admin`     | Todas as empresas                                                          | Sim; transferir captura e aplicar cadastro também                                                |
| `operator`  | Empresas concedidas a ele                                                  | Sim                                                                                              |
| `viewer`    | Empresas concedidas a ele                                                  | Não (`SCOPE_DENIED`)                                                                             |
| `developer` | Não (`SCOPE_DENIED`); só pelas integrações que administra                  | Não; operações de projetos que administra só em `webhooks:manage`                                |

Sem acesso à empresa a resposta é `NOT_FOUND`; sem membership, membership
removida ou outra organização, `ACCESS_DENIED`. Municípios, NCM e o resultado
salvo da consulta CNPJ seguem com qualquer membro com acesso à empresa.

O que o console cria pertence ao projeto de sistema da organização
(`kind: "console"`, referência vazia), criado na primeira escrita por
`ensureConsoleProject`. Ele não tem concessões, chaves nem webhooks, não
aparece em `projects.list`/`projects.get` e não aceita edição, concessão,
chave ou webhook (`canManageProject` é falso). As chaves de idempotência das
pessoas ficam no namespace dele; `operations.reserve` recusa operação de
pessoa em projeto de integração. Uma chave apontando para o projeto do
console é recusada como inválida.

As listas do console são por empresa e incluem o que as integrações criaram.
A escrita, porém, vale só para registros do projeto do console: lote,
operação e captura de uma integração respondem `INTEGRATION_RECORD` com o nome
dela, e o console orienta a geri-los pela integração. Cancelar NFS-e é a
exceção: owner/admin/operator cancelam emissões de qualquer origem, notificando
só o projeto dono. Aceitar a perda de uma lacuna da captura é a outra (#442,
[ADR 0008](../adr/0008-perda-fiscal-em-captura-de-integracao.md)):
só o owner decide, com motivo registrado, como na captura do console, e a
captura segue na integração.
O contrário não vale: a chave de um projeto não enxerga lotes, emissões ou a
captura criados pelo console, porque pertencem ao projeto do console; os
documentos resultantes continuam disponíveis a qualquer chave com
`documents:read` da empresa. Revogar a concessão de uma integração não tira o
acesso das pessoas. A matriz por domínio está em
`platform/convex/consoleAccess.test.ts`.
