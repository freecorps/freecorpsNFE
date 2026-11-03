# Console sem projeto

Data: 09/10/2026 · Status: **Aceita** pelos sócios da Freecorps (aceite registrado por
um dos sócios em 09/10/2026)

## Situação em 26/10/2026

> O dono do projeto aceitou uma segunda exceção ao §1 ("só altera registros
> do projeto do console") e à consequência "capturas de integração [...] são
> lidas mas não alteradas pelo console": numa captura de NF-e ativada por uma
> integração e parada numa lacuna que a fonte não tem mais, o Proprietário da
> organização aceita a perda pelo console ("Aceitar a perda e continuar"),
> com motivo obrigatório. Administrador e os demais papéis não aceitam. A
> captura continua da integração: a consulta seguinte roda no projeto dela,
> com a chave dela, e ela recebe o evento `connection.history_limited`.
> Pausar, retomar, sincronizar e liberar para transferência essa captura
> continuam respondendo `INTEGRATION_RECORD`. A primeira exceção, cancelar
> NFS-e, não muda. Decisão, alternativas e motivos na
> [ADR 0008](0008-perda-fiscal-em-captura-de-integracao.md). O texto abaixo
> registra a decisão como foi tomada e não foi reescrito.

Até esta decisão, as telas fiscais do console (importar XML, consultar
documentos, emitir NFS-e, captura, consulta cadastral, controle de operações)
exigiam que a pessoa escolhesse um projeto e que esse projeto tivesse
concessão (`projectCompanies`) com o escopo da tarefa para a empresa. O projeto
é a aplicação integradora, dona das API keys. Pedir que uma pessoa escolha uma
integração para trabalhar na própria empresa era o maior atrito do produto e
misturava dois escopos distintos (AGENTS.md, regra 4).

## Decisão

### 1. Pessoas trabalham na empresa

Quem usa o console com sessão Better Auth trabalha direto na empresa. O acesso
é a interseção de:

- membership ativa na organização (`requireMembership`; login sem membership
  não acessa);
- acesso do membro à empresa (`findCompany`: owner/admin veem todas; os demais
  só as empresas concedidas a eles em `companyGrants`);
- papel: leitura com `owner`, `admin`, `operator` ou `viewer`; escrita com
  `owner`, `admin` ou `operator`.

`developer` continua só com o que já tinha pelas integrações: projetos que
administra, suas chaves e webhooks, e as operações desses projetos (escrita só
em trabalho de `webhooks:manage`). Ele não lê documentos, importações ou
emissões pelo console. Municípios, NCM e a consulta cadastral salva seguem
como antes: qualquer membro com acesso à empresa.

As restrições de cada domínio continuam: transferir captura é só de gestor,
empresa de demonstração não emite nem consulta cadastro externo, e o gate de
produção e o perfil NFS-e valem para pessoas e chaves.

O helper é `memberAccess` em `platform/convex/lib/operationAccess.ts`. Sem
acesso à empresa a resposta é `NOT_FOUND`; com papel sem a permissão,
`SCOPE_DENIED`. `humanAccess` aplica a mesma regra a registros que já têm
projeto (uma operação ou emissão criada por integração), e mantém o caminho
antigo só para `developer`.

**Lê tudo, escreve só no que é do console.** A pessoa lê todos os registros da
empresa, de qualquer projeto, mas só altera registros do projeto do console.
Um lote de integração (envio, confirmação, cancelamento, reprocessamento), uma
operação de integração (pausar, retomar) e a captura ativada por uma integração
(pausar, retomar, sincronizar, liberar para transferência) são geridos pela
integração: a resposta é `INTEGRATION_RECORD`, com o nome da integração, e o
console diz "Criado pela integração X; gerencie pela integração"
(`requireConsoleRecord`). A exceção é cancelar NFS-e: owner, admin e operator
cancelam pelo console uma emissão de qualquer origem, e o evento vai só ao
projeto dono dela. Reprocessar e reconstruir um documento continuam permitidos,
porque o documento é da empresa e a nova operação pertence ao projeto do
console.

### 2. Projeto e concessão valem só para integrações

API keys e webhooks não mudam: uma chave continua exigindo projeto ativo,
concessão vigente da empresa com escopo e ambiente, e a interseção com os
escopos e empresas da própria chave (`keyAccess`). Nenhuma chave alcança o
projeto do console; `authenticateKey` recusa uma que aponte para ele.

### 3. O que o console cria pertence ao projeto do console

Operações, importações, emissões, cancelamentos, reprocessamentos, consultas
cadastrais, capturas ativadas pelo console, tickets de download e exportações
de documento precisam de dono para idempotência, uso e auditoria. O menor
desenho correto é um projeto de sistema por organização:

- `projects.kind = "console"`, `externalReference` vazio (que
  `projects.create` recusa) e nome "Console";
- criado de forma idempotente na primeira escrita do console da organização
  (`ensureConsoleProject` em `lib/projectAccess.ts`), sem migração dos dados
  existentes; é encontrado pelo índice `by_organizationId_and_kind`, nunca pela
  referência, então um projeto antigo com qualquer referência não se confunde
  com ele, e a busca usa `first` (o mais antigo), sem `unique` que possa falhar;
- sem concessões, API keys ou webhooks; `canManageProject` é sempre falso para
  ele, então não aparece em Integrações nem pode ser editado, desativado,
  concedido ou removido pela interface;
- é o `projectId` dos registros criados por pessoas; as chaves de
  idempotência das pessoas ficam no namespace dele (organização + projeto do
  console + nome da operação + chave);
- `operations.reserve` recusa operação de pessoa em projeto de integração,
  antes inclusive de reaproveitar uma chave de idempotência: pessoas só
  reservam no projeto do console.

A execução revalida o membro que aceitou o trabalho (papel com escrita,
acesso à empresa e versão desse acesso) e a época do projeto do console, cuja
"concessão" tem época 0. Encerrar a organização desativa também esse projeto.

Foi descartado tornar `projectId` opcional para operações humanas: mudaria o
schema e os índices de operações, idempotência, importações, emissões,
streams, tickets e auditoria, e cada consumidor teria de tratar a ausência.

### 4. Listas do console são por empresa

O console lista o que é da empresa, qualquer que seja o projeto: importações
recentes, emissões, a captura da empresa e as operações de seus registros. A
escrita segue a regra da seção 1.
Dados criados antes desta decisão por projetos de integração continuam
visíveis para quem tem acesso à empresa. Revogar a concessão de uma integração
não tira acesso das pessoas.

### 5. Webhooks e integrações

Os eventos seguem o projeto do recurso, como antes. Uma emissão feita pelo
console pertence ao projeto do console, que não tem webhooks: seus eventos não
vão a endpoints de nenhum projeto de integração. Cancelar pelo console uma
emissão criada por integração notifica o projeto dono da emissão, como já
acontecia com o cancelamento pela API. Eventos de documento continuam por
empresa, para os endpoints com escopo de leitura concedido.

Consequência para a API: o que o console cria é do projeto do console, então
a chave de uma integração não enxerga um lote importado no console nem a
captura ativada no console (`/v1/connections/nfe` devolve `null` e a ativação
pela chave recebe `STREAM_CONFLICT`). Os documentos resultantes continuam
disponíveis a qualquer chave com `documents:read` da empresa.

## Consequências

- As telas pedem só a empresa (`apps/console/src/company-context.tsx`),
  lembrada por organização no `localStorage` (somente o id) e na URL.
- `projects.list` e `projects.get` nunca devolvem o projeto do console; os
  totais de uso por projeto da REST não o incluem, porque ele não tem chave.
- Lotes, operações e capturas de integração, inclusive os criados antes desta
  decisão, são lidos mas não alterados pelo console (`INTEGRATION_RECORD`).
- `/v1/companies` passa pela mesma regra de chave (`authenticateKey`) das
  demais rotas.
- A navegação lateral e a página da empresa ficam para as próximas etapas.

Contratos e provas: [PROJECTS.md](../plataforma/PROJECTS.md#console-sem-projeto),
[OPERATIONS.md](../plataforma/OPERATIONS.md#identidade-e-autorização),
[ISSUANCE.md](../plataforma/ISSUANCE.md#console),
[frontend.md](../desenvolvimento/frontend.md#contexto-de-empresa) e
`tests/platform.consoleAccess.test.ts`.
