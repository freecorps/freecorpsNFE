# Custódia fria de organizações abertas

Data: 28/10/2026 · Status: **Aceita** pelo dono do projeto
em 28/10/2026, na [#549](https://github.com/freecorps/freecorpsNFE-arquivo/issues/549).
Esta ADR registra a decisão e as regras da implementação; o código vem em PRs
seguintes. Até a implementação ser publicada e provada, organizações abertas
conservam todos os registros e originais quentes, como descreve o
[arquivo econômico](../operacao/arquivo-economico.md).

## Contexto

O [arquivo econômico](../operacao/arquivo-economico.md) (`coldArchive.ts`,
`scripts/cold-tier/cold-archive.mjs`, `scripts/lib/cold-archive.mjs`) move as 25 tabelas
da classe `fiscal` e seus arquivos para um pacote cifrado com age no R2,
depois de aviso, congelamento com quiescência e prova de importação e
reexportação num Convex isolado. Ele só serve a organizações encerradas e
`purged`, porque o Convex recusa recriar na origem um ID apagado:
`import --append` falha com `Cannot recreate document with _id ... that was
deleted` (recibo).
Desde então, organizações abertas, inclusive o Gratuito inativo e o plano pago
sem renovação, conservam todo o estoque quente.

Esse estoque não tem receita. No modelo
`paid-plans.mjs`, cenário
`openOrganizationRetention`, manter quente por 72 meses o estoque de uma
organização sem novas operações custa R$ 660,55 no Gratuito, R$ 1.282,65 no
Intermediário e R$ 5.009,12 no Grande, só de infraestrutura ociosa em
estresse. Os aportes da Freecorps antes da admissão são R$ 60, R$ 108 e
R$ 280. Por isso o catálogo de planos pagos continua desligado
([PLATFORM-COSTS.md](../plataforma/PLATFORM-COSTS.md)).

O próprio catálogo frio pesa. `coldArchiveEntries` guarda uma entrada por
registro e arquivo arquivados. No exemplo de 100 mil registros e 5 mil
arquivos, são 35.421.356 bytes quentes; com o backup recorrente de um bucket,
custam R$ 647,47 em 72 meses
([Catálogo quente por 72 meses](../plataforma/PLATFORM-COSTS.md#catálogo-quente-por-72-meses)).
É a mesma ordem da guarda quente que o arquivo deveria evitar.

A #549 listou três caminhos: aporte maior, revisão de preço ou estoque, e
custódia fria que não dependa de recriar IDs na origem. Uma reserva mensal
tirada da margem foi discutida como variante do primeiro.

## Decisão

O dono do projeto escolheu, em 28/10/2026, a **custódia fria de organizações
abertas com reidratação sob identidades novas**. Uma organização aberta,
inativa ou sem renovação, vai para um pacote cifrado no R2. Na reativação, os
dados voltam à origem com novos IDs do Convex. Enquanto estiver arquivada, a
consulta é somente leitura, por exportação assistida do pacote. Aporte maior,
revisão de preço ou estoque e reserva mensal de margem foram recusados.

As regras abaixo são normativas para a implementação.

### 1. Elegibilidade, aviso e congelamento

A elegibilidade reutiliza a avaliação que já existe em `coldArchive.ts`:

- **Gratuito:** 90 dias sem atividade. Contam mudanças na organização e no
  plano, o consumo em `usageEvents` e os eventos de `capacityEvents`,
  inclusive leituras REST, downloads e exports. Login isolado não conta.
  Contam também as leituras de dados fiscais pelo console, como abrir a
  lista ou o detalhe de um documento
  ([#641](https://github.com/freecorps/freecorpsNFE-arquivo/issues/641)).
- **Plano pago:** 30 dias depois do fim do período pago (`endsAt`) sem
  renovação.

Depois disso vale o aviso de 30 dias, persistido no run. No Gratuito, o aviso
oferece a Proprietário e Administrador a ação "manter ativa", que conta como
atividade e cancela o aviso. No plano pago, a elegibilidade ignora atividade
(`coldArchive.ts` só confere `endsAt`), e o aviso oferece "renovar". O
congelamento recarrega elegibilidade e versão do plano e só grava `frozen`
quando prova, na mesma transação, que não há operação ativa ou incerta, lease,
export, upload, captura nem webhook pendente. Como ele refaz a avaliação,
qualquer atividade no Gratuito ou renovação no plano pago durante o aviso
também impede o congelamento; a organização só volta a ser elegível depois de
cumprir de novo o prazo inteiro.

Nada sai do quente antes da prova de importação e reexportação no destino
isolado, com a validade de 24 horas que o executor já aplica. Uma retenção
legal ativa impede o arquivamento. A guarda fiscal de
[RETENTION.md](../plataforma/RETENTION.md) nunca encurta: o horizonte de 72
meses do modelo é orçamento, não prazo de exclusão.

O executor recusa hoje pacotes acima de 100 mil registros fiscais, 256 MiB de
JSON fiscal ou 2 GiB de arquivos (`ARCHIVE_ROW_LIMIT`,
`ARCHIVE_DATABASE_LIMIT` e `ARCHIVE_FILE_LIMIT` em `lib/coldArchiveCore.ts`).
Com o banco lógico cheio, ficar em 100 mil registros exige média por linha de
cerca de 2.684 bytes ou mais no Grande (256 MiB), 671 bytes no Intermediário
(64 MiB) e 335 bytes no Gratuito (32 MiB). É condição necessária, não
suficiente: `databaseBytes` conta só as seis tabelas de documentos
(`fiscalDocuments`, `documentArtifacts`, `documentVersions`, `documentItems`,
`documentListings` e `documentFiscalEvidence`; `capacityCore.ts` e
[USAGE.md](../plataforma/USAGE.md)), enquanto o executor conta as 25 tabelas
de `ARCHIVE_TABLES`, inclusive operações, tentativas, auditorias e envelopes,
que a cota não mede. O JSON serializado também pode passar do banco lógico.
Uma organização acima de qualquer limite não é arquivada e fica no caminho
quente, sem financiamento por esta decisão, até os limites subirem com prova
([O que continua em aberto](#o-que-continua-em-aberto)).

**Organização só com Sandbox.** Uma organização que nunca teve dados de
Produção, pelo mesmo critério de `sandboxOnly` de
[RETENTION.md](../plataforma/RETENTION.md#organização-sem-produção-decidido-em-27102026),
não é elegível: o executor não cria run para ela. Assim o expurgo antecipado
do encerramento (`fiscalGuard:early`) continua valendo, porque ele trata
qualquer run em `coldArchiveRuns` como Produção. A alternativa, arquivar e
não contar o run, poria dados sem validade fiscal num pacote com lock no R2,
que não pode ser apagado antes do prazo; o expurgo antecipado deixaria de
alcançá-los. Uma organização com Produção arquiva também suas linhas de
Sandbox, que já seguem a guarda inteira. A consequência é que uma
organização aberta e inativa que só usou Sandbox fica quente sem prazo; o
custo está na seção 8, e o tratamento dela é decisão pendente do dono do
projeto.

### 2. A organização continua aberta

Só a classe `fiscal` vai para o frio, inclusive as auditorias fiscais
(`operationAudit`, `captureAudit` e `certificateAudit`). Ficam quentes as
demais classes de `retentionClasses.ts`: `closure` (organização, membros,
convites, empresas, projetos, chaves, credenciais no cofre, endpoints,
entregas e tentativas de webhook, eventos de outbox, downloads e as
auditorias da organização, da empresa, da integração e operacional),
`commercial` (planos, consumo, totais, recibos e chaves de idempotência),
`control` (inclusive `coldArchiveRuns`, mas não `coldArchiveEntries`, que a
seção 4 compacta), `decision` e `access`.

**O que continua permitido com a organização arquivada.** Hoje o arquivo é
recusado por quatro caminhos, todos com `assertOrganizationHot`:

- `requireMembership` (`platform/convex/lib/organizationAccess.ts`), em toda
  chamada do console, salvo as leituras de estado com `archived: "status"`
  (`plans.ts`, `usage.ts`). Isso recusa hoje até o encerramento (`close`, em
  `organizationClosure.ts`);
- `authenticateKey` e `companyScopeAccess`
  (`platform/convex/lib/operationAccess.ts`), em toda chamada REST com chave;
- `usage.chargeRestRead`, que cobra toda leitura `GET` da REST
  (`lib/externalHttp.ts`) por `reserveCapacity`, cuja
  `assertCapacityWritable` (`lib/capacityCore.ts`) chama
  `assertOrganizationHot` quando a política de capacidade está ligada;
- `allocateOffer` (`platform/convex/lib/planCore.ts`), na atribuição de plano.

A implementação muda esses caminhos para liberar exatamente as ações da tabela
abaixo. Na REST, as leituras liberadas são só as rotas não fiscais que
existem: `GET /v1/companies`, `GET /v1/companies/{id}`, `GET /v1/capabilities`
e `GET /v1/webhook-endpoints`. As escritas liberadas são o `PATCH` de
`/v1/webhook-endpoints/{id}`, só para desligar o endpoint (`active: false`),
e o `POST` de `/v1/webhook-endpoints/{id}/rotate-secret`. Essas leituras
continuam cobradas na cota `restReads`, sem a recusa do arquivo. Elas geram
`capacityEvents` e contam como atividade enquanto o run está em `notice`; a
partir de `frozen`, nada reabre a organização sozinho, e só a reativação
explícita da seção 6 a traz de volta.

| Ação                                                                                                                                 | `notice` | `frozen`, `sealed`, `verified`, `deleting` | `archived` | `restoring`              |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------ | ---------- | ------------------------ |
| Revogar chave de API ou credencial (certificado no cofre, conexão)                                                                   | Sim      | Sim                                        | Sim        | Sim                      |
| Revogar o acesso de um projeto a uma empresa, retirar a liberação da captura, desligar endpoint de webhook ou rotacionar seu segredo | Sim      | Sim                                        | Sim        | Sim                      |
| Remover membro ou cancelar convite                                                                                                   | Sim      | Sim                                        | Sim        | Sim                      |
| Pedido de direitos de titular ([RIGHTS.md](../plataforma/RIGHTS.md))                                                                 | Sim      | Sim                                        | Sim        | Sim                      |
| Solicitar o encerramento (Proprietário)                                                                                              | Sim      | Sim\*                                      | Sim        | Sim\*                    |
| Leituras não fiscais no console e nas rotas REST acima                                                                               | Sim      | Sim                                        | Sim        | Sim                      |
| Pedir a exportação assistida pelo console (seções 3 e 7)                                                                             | Não†     | Sim                                        | Sim        | Sim                      |
| Contratar, renovar ou mudar de plano                                                                                                 | Sim      | `ORGANIZATION_ARCHIVING`                   | Sim        | `ORGANIZATION_ARCHIVING` |
| "Manter ativa" (Gratuito) ou "reativar" (seção 6)                                                                                    | Sim      | `ORGANIZATION_ARCHIVING`                   | Sim        | Repete sem efeito        |

\*O pedido é aceito; o expurgo do encerramento espera o run sair de `deleting`
ou `restoring`. †Em `notice` os dados estão quentes e a exportação normal
continua valendo. `ORGANIZATION_ARCHIVING` é o código proposto para recusar a
troca de plano e a reativação enquanto o arquivamento ou a reidratação estão
em curso; a organização tenta de novo quando o run chegar a `archived` ou
`hot`. Os estados são os de `archiveState`, em `lib/coldArchiveSchema.ts`. **A
revogação de uma chave ou credencial vazada nunca pode ser bloqueada pelo
arquivo.**

Toda outra escrita e toda leitura de dado fiscal continuam recusadas com
`ORGANIZATION_ARCHIVED`.

**Prazo do pacote.** Para organização aberta, o executor grava `retainUntil`
pela guarda contada da data do arquivamento. Enquanto a organização continuar
aberta, o `retainUntil` do run e o lock dos objetos no R2 (pacote, catálogo e
mapa) são renovados antes de vencer. Um pacote nunca vence com a organização
aberta e arquivada. Depois da conferência final da reidratação e da volta a
`hot`, a renovação do lock daquele pacote para: ele vence no `retainUntil`
vigente e não é apagado antes. Até vencer, um pacote de ciclo anterior
continua custando no R2.

**Encerramento de uma organização arquivada.** Encerrar continua possível. A
janela de 30 dias da D01 vale como de costume, e a exportação nessa janela é
a assistida da seção 7, porque os dados estão no frio. A guarda após o
encerramento conta da data do encerramento, como em
[RETENTION.md](../plataforma/RETENTION.md#guarda-implementada-d01), e o
`retainUntil` do run e o lock passam ao maior entre o prazo atual e o do
encerramento: o lock só pode ser estendido. O run arquivado
continua como o arquivo de uma organização encerrada.

### 3. Estado arquivado e recusa de admissões

Do congelamento até o fim da reidratação, o servidor recusa toda admissão
fiscal da organização: importação, captura, emissão e cancelamento NFS-e e
exportação de dados fiscais. A recusa já existe em `assertOrganizationHot`,
lida na mesma transação da escrita, com o código interno
`ORGANIZATION_ARCHIVED`. Hoje o REST a traduz para `SCOPE_DENIED`, HTTP 403.
A implementação passa a responder `ORGANIZATION_ARCHIVED` como código próprio
do contrato, proposto com HTTP 409, para que a integração distinga arquivo de
falta de permissão. A versão do contrato segue o comparador de
`packages/contracts`.

Uma leitura REST de documento, operação, importação ou emissão de organização
arquivada responde `ORGANIZATION_ARCHIVED`, nunca `NOT_FOUND`. O console
mostra o estado arquivado, a data, o motivo e o caminho para reativar ou
pedir a exportação assistida, sem sugerir retomada imediata.

A recusa protege a regra "retentativa não pode duplicar efeito". Com a
identidade de deduplicação no frio, uma importação aceita durante o arquivo
passaria pela deduplicação sem encontrar o original; uma emissão poderia
reutilizar um número de DPS. Por isso:

- **Chaves de idempotência e recibos** (`idempotencyRecords`,
  `operationReceipts`) já são `commercial` e ficam quentes. Durante o
  arquivo, uma repetição com a mesma chave responde `ORGANIZATION_ARCHIVED`
  antes de ler o registro: `authenticateKey` e `companyScopeAccess`, em
  `platform/convex/lib/operationAccess.ts`, e `requireMembership`, no
  console, já chamam `assertOrganizationHot` antes de ler o registro de
  idempotência. A guarda que precisa manter `assertOrganizationHot` é
  `companyScopeAccess`: `memberAccess` a chama, e `keyAccess` e
  `connectionAccess` (`lib/stripeAccess.ts`) passam por ela em
  `projectAccess`. Assim a garantia vale mesmo com as exceções da seção 2,
  que não passam por essa guarda. Desligar e rotacionar um endpoint de
  webhook pela REST hoje passa por `endpointAccess`, `keyAccess` e
  `projectAccess` (`lib/webhookAccess.ts`); a implementação dá a essas duas
  ações um caminho próprio, que confere chave, projeto e concessão sem a
  recusa do arquivo e não lê dado fiscal, em vez de afrouxar
  `companyScopeAccess`. Depois da reidratação, a repetição devolve
  a operação sob o ID novo, resolvido pelo mapa da seção 6.
- **Numeração e captura** ficam quentes como cerca mínima: as linhas
  inteiras de `dpsSequences` e de `captureStreams` entram no pacote, mas não
  saem do banco. Ficam com os IDs originais. São poucas linhas por
  organização, até mil streams pelo limite do executor, e impedem reusar
  número ou recomeçar a captura do zero.
- **Identidade de deduplicação dos documentos** vai para o frio com o
  documento. A cerca é a própria recusa: nenhuma admissão reabre antes de a
  reidratação gravar e conferir todos os documentos. Uma cópia quente por
  documento custaria o mesmo que o catálogo que esta decisão compacta.

### 4. Catálogo compactado

Depois de `archived`, `coldArchiveEntries` não fica quente. As entradas do run
viram um objeto cifrado com age, com os mesmos custodiantes do backup, gravado
no R2 por escrita condicional. Um manifesto próprio do catálogo, imutável,
guarda hash e tamanho do texto claro e da cifra; o run guarda o hash desse
manifesto. O manifesto do pacote, já selado, não muda.

As entradas só saem do banco depois de baixar, decifrar e comparar o objeto
com elas: contagem, IDs originais, hashes e metadados de storage. Da custódia
ficam quentes somente a linha de `coldArchiveRuns` e a cerca da seção 3.
Também ficam quentes, como diz a seção 2, as classes `closure`, `commercial`,
`control` (sem `coldArchiveEntries`), `decision` e `access`. O objeto do
catálogo passa a ser dependência permanente do backup, como o pacote. A regra
vale para todo run que chega a `archived`, inclusive de organizações
encerradas, porque o custo do catálogo é o mesmo.

### 5. Reidratação com identidades novas

A reidratação nunca usa `import --append` nem `--replace` na origem com os IDs
originais. Ela:

1. Exige, para planos pagos, plano ativo, e para qualquer plano, que o
   estoque do pacote caiba na capacidade do plano atual de banco e arquivos.
   Se não couber, recusa antes de gravar e indica o plano que comporta. A
   checagem usa a unidade que `capacityCore` conta, o tamanho lógico de
   `getDocumentSize`, e não o `databaseBytes` do manifesto, que mede JSON. O
   executor soma só as linhas das tabelas rastreadas pela cota, as seis de
   documentos, já com os campos que a reidratação acrescenta, mais o mapa de
   IDs da seção 6. Acrescenta uma margem de segurança fixada e documentada em
   [USAGE.md](../plataforma/USAGE.md) e confere os arquivos pelos bytes do
   manifesto. O mapa passa a ser rastreado como estoque; essa contabilização
   é implementada no PR do mapa. Passada essa admissão, a reidratação não
   falha no meio por cota: as linhas entram na contabilidade em modo de
   inventário, como na recuperação (`restoringInventory`, em `capacity.ts`).
2. Baixa e decifra pacote e catálogo e confere seus hashes com os manifestos.
3. Trabalha em duas passagens. Na primeira, envia cada arquivo e insere cada
   linha com `insert`, que gera ID novo, gravando o mapa; as referências
   ainda apontam para os IDs originais. Na segunda, reescreve as
   referências. Assim uma referência à frente, como
   `documentVersions.operationId` para `operations`, encontra o ID novo
   qualquer que seja a ordem das tabelas. O SHA-256 e o tamanho de cada
   original precisam ser iguais aos do pacote; a diferença interrompe a
   reidratação. As linhas que ficaram quentes (`dpsSequences` e
   `captureStreams`) não são recriadas: mantêm os IDs, e as referências a
   elas não são reescritas.
4. Os uploads correm numa action, fora da transação. O mapa de arquivos usa
   como chave o ID de storage original. Antes de enviar, o executor grava a
   intenção de upload (run e ID de storage original) e, depois, o ID de
   storage novo nela. Numa tentativa repetida, reaproveita só o ID de storage
   gravado na intenção, se ele existir e tiver o SHA-256 e o tamanho
   esperados; se não, envia de novo. O executor nunca escolhe um arquivo que
   não esteja registrado na intenção nem procura arquivos por SHA-256 no
   `_storage`: não há índice, e originais iguais existem entre organizações e
   dentro de uma mesma organização. A regra de não compartilhar arquivo de
   `exclusiveFile` continua valendo. Uma queda entre `ctx.storage.store` e a
   gravação do ID novo na intenção deixa um arquivo órfão, que nenhum registro
   aponta. A limpeza desses órfãos fica em aberto.
5. Reescreve toda referência para o ID novo. A lista de campos sai do
   schema, não de uma enumeração escrita à mão: todo `v.id` que aponta para
   uma tabela de `ARCHIVE_TABLES` ou para `_storage`, em qualquer tabela,
   mais os campos de `ARCHIVE_STORAGE_FIELDS`. Os campos que `archiveOwner`
   segue (`documentId`, `operationId`, `batchId` e outros) são exemplos, não
   a lista. O inventário de capacidade não é reescrito: `removeHotBatch`
   (`coldArchive.ts`) já apaga `capacityRecords` e `capacityFiles` das
   linhas e arquivos removidos, e a reidratação os recria com
   `trackDatabaseRecord` e `trackStoredFile`, em modo de inventário, para os
   IDs novos. O inventário das linhas da cerca (`dpsSequences` e
   `captureStreams`) nunca sai e continua com os IDs delas. Referências
   guardadas como texto seguem regra explícita:
   - `capacityRecords.key` (`tabela:id`) é recriado com o ID novo, como
     acima, e não entra na lista de campos reescritos;
   - `outboxEvents.resourceId`, `logicalKey` e `body`, e `capacityEvents.key`
     registram o que já aconteceu e mantêm o ID antigo, resolvido pelo mapa
     quando lido;
   - `idempotencyRecords.key` não é reescrito. Algumas chaves são compostas
     com IDs de linhas arquivadas, como as do reprocessamento de recusas
     (`refusalReprocess.ts`: a operação anterior, e a operação com o
     artefato). Todo código que compõe uma chave assim usa o primeiro ID de
     cada linha (item 6), para que a chave continue a mesma em todos os
     ciclos e a repetição não refaça o efeito;
   - `operations.request` e `operations.response` são JSON da linha
     arquivada e entram na conferência de hash como estão. Os IDs dentro
     deles (`artifactId`, `previousOperationId`, `documentId`) não são
     reescritos; quem os lê depois da reidratação os resolve pelo mapa.

   Um teste de cobertura falha se um `v.id` desses ficar fora da lista, ou se
   um campo de texto que guarda ID de tabela arquivada não estiver
   classificado como reescrito ou mantido, como o `satisfies` de
   `retentionClasses.ts` falha com uma tabela sem classe.

6. Grava em cada linha o par "primeiro ID / primeira criação": o `_id` e o
   `_creationTime` que a linha teve antes do primeiro arquivamento. O par é
   gravado uma vez, no primeiro ciclo, e nunca muda. Listagens, ordenação e
   paginação usam a primeira criação, para que um documento reidratado não
   apareça como novo.
7. Reidrata o histórico inteiro: versões, itens, eventos, tentativas,
   auditorias e originais de lotes. Nada é descartado para caber.
8. Não enfileira webhooks. Eventos históricos não são entregues de novo; a
   integração lê o estado atual pela API.
9. Não conta como consumo mensal de importação ou captura. Conta no estoque.

**Mudança de schema durante a guarda.** O manifesto registra a versão do
schema fiscal com que o pacote foi feito. A reidratação e a restauração
isolada aplicam, antes do `insert`, as migrações de pacote versionadas desde
essa versão até a atual. A conferência de hash compara a forma anterior à
migração, o JSON do pacote, e não a linha migrada. As migrações de pacote são
idempotentes e testadas contra pacotes de cada versão anterior.

A reidratação é idempotente e retomável. O run fica em `restoring`, com
cursor e passagem; cada linha nova e sua entrada no mapa são gravadas na
mesma transação, então repetir um lote encontra o mapa e não duplica.

A conferência final tem uma forma canônica. Para cada linha reidratada, o
executor reconstrói a linha como ela estava no pacote deste ciclo: remove só
os campos acrescentados neste ciclo, troca cada referência pelo ID anterior
com o mapa inverso deste ciclo, devolve o `_id` e o `_creationTime` que o
mapa guarda como anteriores e serializa com `archiveRowJson`. No primeiro
ciclo, isso remove também o par "primeiro ID / primeira criação"; num ciclo
seguinte, o par já estava na linha arquivada e fica. O SHA-256 desse
texto precisa ser igual ao `sha256` da entrada do catálogo. Para arquivos, os
metadados de storage reconstruídos com o ID de storage, o `_creationTime` e o
`contentType` originais seguem a mesma regra, e os bytes do upload novo
precisam ter o SHA-256 e o tamanho gravados nesses metadados. Só depois de
todas as linhas e arquivos conferirem o estado volta a `hot` e as admissões
reabrem.

### 6. IDs antigos

Ao reidratar, a origem passa a guardar quente um mapa por organização. Cada
entrada guarda a tabela, o ciclo, o `_id` e o `_creationTime` anteriores e o
ID novo. O mapa só existe depois da reidratação e acompanha a organização
enquanto ela e a guarda existirem. Ele conta no estoque da organização e na
checagem da seção 5, item 1. Tem uma entrada por linha, a mesma ordem do
catálogo: pela medida do catálogo, cerca de 33 MiB por 100 mil linhas, valor
não medido para o mapa. Ao arquivar de novo, o mapa vai para o pacote ou é
compactado, como diz a regra abaixo.

Integrações guardaram IDs antigos em seus bancos e em webhooks já entregues.
Uma rota REST que recebe um ID primeiro busca o registro; não o encontrando,
busca o ID no mapa da organização da chave. Se houver, responde o recurso
atual, com o `id` novo, depois de conferir acesso, escopo e concessão sobre o
registro resolvido. `NOT_FOUND` só sai quando o ID não pertence à organização
em nenhum dos dois lugares. O SDK e o contrato documentam essa troca de `id`.
Um ID antigo de outra organização nunca resolve.

Depois da reativação, respostas REST e eventos de webhook de um recurso
reidratado trazem também o primeiro ID, num campo como `originalId`, e
opcionalmente a cadeia de IDs anteriores. Um
receptor que deduplica pelo ID reconhece o recurso que já conhece e não cria
outro efeito.

Uma chave de idempotência compara o pedido pelo `requestHash`, calculado
sobre o ID exatamente como o chamador o enviou. O servidor nunca traduz um ID
antigo pelo mapa antes do hash: a repetição legítima de um pedido feito antes
do arquivo precisa dar o mesmo hash, e não `IDEMPOTENCY_CONFLICT`.

**Arquivar de novo depois de uma reativação.** Uma organização reativada pode
voltar a ser elegível. O novo arquivamento leva o mapa no pacote seguinte, ou
o compacta no R2 como o catálogo; ele não fica quente por inteiro enquanto a
organização estiver arquivada. As referências se compõem: um ID de qualquer
ciclo, inclusive um intermediário, resolve pela cadeia antigo → novo1 → novo2
até o ID atual, sem parar no meio. Antes de cada novo arquivamento, a
Freecorps recompõe o aporte da organização para o ciclo seguinte. Se o
Gratuito terá limite de reativações é decisão pendente do dono do projeto.

**Quem reativa.** Num plano pago, a reativação começa com a contratação ou a
renovação do plano. No Gratuito, o Proprietário pede a reativação no console,
pela ação "reativar", equivalente ao "manter ativa" do aviso. Nos dois casos a
reidratação segue a seção 5, e o aporte é recomposto antes de um novo
arquivamento, pela regra acima.

### 7. Consulta somente leitura enquanto arquivada

Direitos de acesso e portabilidade não dependem de reativar. Enquanto a
organização estiver arquivada, o atendimento autorizado restaura o pacote no
destino isolado (`scripts/cold-tier/cold-archive.mjs restore`) e entrega
a exportação a quem tem papel para recebê-la, conforme
[RIGHTS.md](../plataforma/RIGHTS.md). Até a PR 8 esse comando recusava um
run com `reason` diferente de `closed` (`ARCHIVE_REACTIVATION_UNPROVEN`); desde
ela, serve a organizações encerradas e abertas
([O que continua em aberto](#o-que-continua-em-aberto)). Isso não é reativação
comercial, não exige plano ativo e não altera a origem. Cada exportação assistida custa uma
restauração isolada, que o aporte não financia: o pacote frio inclui só a
reidratação. Formato, canal e custo da entrega foram decididos em
[30/10/2026](#decisões-de-30102026).

### 8. Financiamento

O aporte de cada organização passa a financiar este caminho: pacote frio,
que já inclui uma reidratação, mais um mês de transição quente e a linha do
run quente por 72 meses. O modelo publica o cenário
`openOrganizationColdCustody`; a memória está em
[PLATFORM-COSTS.md](../plataforma/PLATFORM-COSTS.md#custódia-fria-de-organizações-abertas).

| R$ por organização, 72 meses, arredondado ao centavo | Gratuito | Intermediário |   Grande |
| ---------------------------------------------------- | -------: | ------------: | -------: |
| Antes: estoque quente ocioso                         |   660,55 |      1.282,65 | 5.009,12 |
| Custódia fria com catálogo compactado                |    44,10 |        107,70 |   278,73 |
| Aporte atual                                         |       60 |           108 |      280 |
| Folga do aporte                                      |    15,90 |          0,30 |     1,27 |
| Sem compactar o catálogo: déficit                    |   631,54 |        647,14 |   646,17 |

O aporte cobre essa soma só na aritmética e com três ressalvas. Vale apenas
para organizações dentro dos limites do executor da seção 1; com o banco
cheio e linhas pequenas, qualquer plano passa do limite de registros, e o
Grande é o mais exposto. Não inclui as linhas `closure` e
`commercial` que continuam quentes durante a custódia (idempotência, recibos,
consumo, entregas e tentativas de webhook, outbox, downloads e auditorias),
que crescem com cada operação da vida ativa e não foram medidas. A folga do
Intermediário, R$ 0,30, paga cerca de 16 mil bytes quentes e dificilmente as
absorve. Também não inclui as exportações assistidas da seção 7 nem o
rearquivamento depois de uma reativação.

O pacote frio do modelo usa o estoque de banco do plano, que conta só as
tabelas de documentos. O pacote real carrega também as tabelas fiscais não
rastreadas (operações, tentativas, auditorias, envelopes). Cada 64 MiB extras
custam cerca de R$ 1,63 em 72 meses, com duas cópias. A folga paga cerca de
12 MiB extras no Intermediário e 50 MiB no Grande; o veredito "cobre" desses
planos depende do tamanho dessas tabelas, que não foi medido.

Organizações abertas e inativas que só usaram Sandbox não são elegíveis
(seção 1) e ficam quentes sem prazo, fora deste financiamento. Num Gratuito
com o estoque cheio, isso custa até R$ 660,55 em 72 meses, o mesmo valor do
caminho quente de `openOrganizationRetention`. O tratamento delas é decisão
pendente do dono do projeto.

O mês de transição financia um dos meses quentes antes do congelamento. No
Gratuito, esses meses vêm do subsídio mensal, e a transição fica como folga
conservadora, sem ser contada duas vezes.

Na janela sem receita do plano pago, a conta não fecha. Entre o fim do
período pago e o congelamento passam no mínimo dois meses quentes, e o aporte
financia um. Só o segundo mês já deixa um déficit de R$ 17,52 no
Intermediário e R$ 68,30 no Grande; o tempo de prova e remoção depois do
aviso também fica fora do modelo. Fechar essa diferença fica em aberto.

## Consequências

- O catálogo deixa de ser bloqueado pela guarda quente das organizações
  abertas **quando** a custódia estiver implementada e provada. Até lá, nada
  muda no hospedado: o fluxo continua atrás de `FNFE_COLD_ARCHIVE=enabled`,
  desligado, e organizações abertas ficam quentes.
- A integração passa a lidar com um estado novo (`ORGANIZATION_ARCHIVED`) e
  com a troca de `id` depois da reativação. As duas coisas mudam o contrato
  REST e o SDK.
- Uma organização reativada continua com o mesmo histórico, mas cada registro
  fiscal recriado tem ID novo. O ID original fica no registro e no mapa.
- A reativação não é imediata: depende do tamanho do pacote e da operação
  assistida. O console e a API não prometem prazo antes de medi-lo.
- Enquanto a organização estiver arquivada, a captura NF-e fica parada. A
  Receita só distribui documentos por tempo limitado. Se, na volta, ela não
  tiver mais o começo do trecho, o stream fica em atenção com
  `RECONCILIATION_UNAVAILABLE`, como na
  [ADR 0008](0008-perda-fiscal-em-captura-de-integracao.md): só o
  Proprietário aceita a perda, com motivo, e ela nunca é aceita
  automaticamente. O aviso de 30 dias precisa dizer isso.
- O objeto do catálogo e o pacote são dependências permanentes do backup.
  Rotação de custódia e coleta precisam considerá-los.

## Decisões de 29/10/2026

O dono do projeto decidiu, na
[#549](https://github.com/freecorps/freecorpsNFE-arquivo/issues/549), duas regras que
completam a seção 1. O texto acima continua como foi aceito; onde ele diverge,
valem estas.

1. **Plano pago sem renovação: um só mês quente.** O aviso de 30 dias começa
   logo no fim do período pago (`endsAt`), e o congelamento fica possível 30
   dias depois do aviso. Antes eram 30 dias depois de `endsAt` e mais os 30
   do aviso, dois meses quentes. O mês que sobra é o do aviso, que o aporte
   financia como mês de transição. Com isso fecha o déficit da janela sem
   receita da seção 8: não há mais um segundo mês quente sem financiamento.
   Recalculado no modelo
   (`paid-plans.mjs`,
   `paidExpiryWindow`), o aporte exigido até o congelamento passa de
   R$ 125,52 para R$ 107,70 no Intermediário e de R$ 348,30 para R$ 278,73 no
   Grande, igual à custódia fria da tabela da seção 8. O déficit de R$ 17,52
   e R$ 68,30 vira folga de R$ 0,30 e R$ 1,27, e a checagem diagnóstica da
   janela passa. A folga é tão pequena que o tempo de prova e remoção depois
   do aviso, ainda fora do modelo, volta a ser déficit se atrasar o
   congelamento. O Gratuito não muda: 90 dias sem atividade e depois o aviso
   de 30 dias.
2. **Organização aberta só com Sandbox.** Continua inelegível ao arquivo:
   `coldArchive:notice` recusa com `ARCHIVE_SANDBOX_ONLY`, pelo mesmo critério
   de `sandboxOnly` (`fiscalGuard.ts`), e nenhum run é criado. Depois de 90
   dias sem atividade, ela recebe um aviso de 30 dias e, sem resposta, a
   Freecorps a encerra. O encerramento segue o caminho de hoje, com o expurgo
   antecipado do Sandbox (`fiscalGuard:early`). A implementação desse aviso e
   do encerramento fica numa PR própria, ainda pendente.

   **Implementada** na PR seguinte à primeira: aviso em
   `sandboxClosureNotices`, fora de `coldArchiveRuns`, criado e encerrado
   pelo operador (`sandboxClosure:notice` e `sandboxClosure:close`, atrás de
   `FNFE_COLD_ARCHIVE`), com e-mail único e "Manter ativa" no console. O
   encerramento passa pelo mesmo caminho do owner, com `requestedBy`
   `freecorps:sandbox-inactive`. Uma escolha da implementação, fora do texto
   da decisão: organização com plano pago em vigor, pedido aguardando
   pagamento ou cartão renovando não recebe aviso nem é encerrada, como no
   encerramento pelo operador
   ([arquivo econômico](../operacao/arquivo-economico.md#encerramento-de-organização-só-com-sandbox)).

### Emendas tomadas com a ADR 0010

Com a ADR 0010, da guarda em camadas
([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642), talvez ainda
não integrada), o dono do projeto decidiu duas emendas a esta ADR. O texto
das seções 4 e 5 continua como foi aceito; onde diverge, valem estas.

1. **Reidratação só da janela quente** (emenda ao item 7 e à checagem de
   capacidade do item 1 da seção 5). Volta ao banco quente só o que cai na
   janela quente do plano: 3 meses no Gratuito e 12 meses nos planos pagos.
   O resto vai direto para a camada fria da ADR 0010, sem apagar nada. A
   checagem de capacidade da reidratação conta a janela quente mais o
   resíduo de todas as notas. **Ordem mudada pelo dono do projeto:** a PR 6
   desta ADR reidrata o histórico inteiro no quente, como dizia o item 7 da
   seção 5, porque a camada fria da ADR 0010 (objeto no R2 e índice
   compacto) só existe depois da fase C dela, que vem depois da fase B, que
   depende da PR 6. Esta emenda entra na fase C2 da ADR 0010, depois da fase C.
   Até lá não há custo real: o catálogo e o arquivamento continuam
   desligados. A C2 foi implementada na
   [#689](https://github.com/freecorps/freecorpsNFE-arquivo/issues/689), com o desenho
   na [ADR 0010](0010-guarda-em-camadas-e-custo-dos-planos.md#fases).
2. **Pacote por referência** (emenda ao empacotamento das seções 4 e 5). O
   pacote desta ADR referencia por hash os objetos que já estão na camada
   fria da ADR 0010, sem copiá-los, e o lock do R2 segue o mais longo dos
   dois prazos. Por consequência, a camada fria da ADR 0010 fica no R2, fora
   do deployment. Pela ADR 0010, o XML original de uma nota fria também fica
   no R2, então os objetos referenciados incluem o original. A referência
   por hash entra na fase C da ADR 0010, e não nas PRs 4 e 6 desta ADR:
   antes da fase C não há objeto frio a referenciar.

## Decisões de 30/10/2026

Tomadas pelo dono do projeto, sobre a exportação assistida da seção 7, que a
PR 8 deixou em aberto:

1. **Formato.** O cliente recebe a mesma exportação de
   [EXPORTS.md](../plataforma/EXPORTS.md), só com os documentos fiscais da
   organização. O JSONL do Convex restaurado no destino isolado não sai da
   Freecorps: ele traz campos internos, como hashes, tabelas de controle e
   IDs internos, que não fazem parte do que o cliente recebe. A entrega usa
   o mesmo download assinado e com prazo das exportações, nunca anexo de
   e-mail. O destino isolado é apagado depois da entrega, como em
   [restauracao.md](../operacao/restauracao.md).
2. **Canal.** O pedido passa pelo suporte e só vale quando vem do
   Proprietário da organização, conferido pela conta. Não há botão no
   console na 1.0. O caminho principal para quem quer os dados continua
   sendo reativar e usar a exportação normal. A linha "Pedir a exportação
   assistida pelo console" da tabela da seção 2 descreve o fluxo futuro.
3. **Custo.** A Freecorps paga a restauração isolada, sem cobrar do cliente.
   Para conter abuso, vale no máximo uma exportação assistida a cada 30 dias
   por organização. O limite não se aplica a pedido de titular por
   [RIGHTS.md](../plataforma/RIGHTS.md), que segue os prazos de lá.

## O que continua em aberto

- **Implementação e prova.** Estado arquivado para organização aberta,
  código público, exceção da atribuição de plano, cerca mínima, compactação
  do catálogo, reidratação com IDs novos, teste de cobertura das referências,
  conferência canônica, mapa de IDs antigos e sua contabilização como
  estoque, versão do schema no manifesto e migrações de pacote testadas
  contra pacotes anteriores, caminho próprio para desligar e rotacionar
  endpoints, ajuste da restauração isolada para organizações abertas e
  limpeza de uploads órfãos de uma queda entre o envio e a gravação na
  intenção, com testes de isolamento entre organizações, repetição e
  retomada. Os PRs que implementarem atualizam,
  cada um na parte que mudar:
  [arquivo-economico.md](../operacao/arquivo-economico.md),
  [RETENTION.md](../plataforma/RETENTION.md),
  [DOCUMENTS.md](../plataforma/DOCUMENTS.md),
  [OPERATIONS.md](../plataforma/OPERATIONS.md),
  [IMPORTS.md](../plataforma/IMPORTS.md),
  [CAPTURE.md](../plataforma/CAPTURE.md),
  [ISSUANCE.md](../plataforma/ISSUANCE.md),
  [WEBHOOKS.md](../plataforma/WEBHOOKS.md),
  [ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md),
  [USAGE.md](../plataforma/USAGE.md), [RIGHTS.md](../plataforma/RIGHTS.md),
  [restauracao.md](../operacao/restauracao.md), o contrato em
  `packages/contracts` e o SDK.

  **Entregue na primeira PR (estado aberto até o aviso):** a elegibilidade
  com as decisões de 29/10/2026, o aviso de organização aberta
  (`coldArchive:notice`) com um único e-mail a proprietários e
  administradores, o aviso no console, "manter ativa" no Gratuito
  (`archiveNotice.keepActive`) e o fim do aviso em qualquer novo plano
  (`activateCatalogPlan`). Congelamento, remoção e o executor continuam
  recusando organização aberta com `ARCHIVE_REACTIVATION_UNPROVEN` até a
  reidratação ([arquivo econômico](../operacao/arquivo-economico.md)).

  **Entregue na segunda PR:** a decisão 2 de 29/10/2026, o aviso e o
  encerramento pela Freecorps da organização aberta só com Sandbox.

  **Entregue antes da PR 6 do plano
  ([#641](https://github.com/freecorps/freecorpsNFE-arquivo/issues/641)):** a
  leitura de documentos e emissões no console, na lista ou no detalhe, conta
  como atividade de qualquer membro ativo. Como as queries não gravam, o
  console chama `archiveNotice.markFiscalRead` depois da leitura, que move
  `organizations.updatedAt` no máximo uma vez por dia por organização.

  **Entregue na PR 2 do plano (o que continua permitido com a organização
  arquivada):** as ações da tabela da seção 2 em cada estado do run, a
  exceção da atribuição de plano (`ORGANIZATION_ARCHIVING`), o caminho
  próprio para listar, desligar e rotacionar endpoints de webhook, a espera
  do expurgo do encerramento em `deleting` e `restoring`, o código público
  `ORGANIZATION_ARCHIVED` (HTTP 409) no contrato 8.0.0 e o estado arquivado no
  console. O pedido da exportação assistida pelo console continua aberto: não
  há fluxo de pedido, e o atendimento é pelo suporte.

  **Entregue na PR 3 do plano (cerca mínima):** as linhas de `dpsSequences`
  e `captureStreams` (`ARCHIVE_FENCE_TABLES`, em `lib/coldArchiveCore.ts`)
  entram no pacote com entrada no catálogo, hash e a cópia lida na varredura,
  que é o que o pacote leva. A remoção não as apaga nem tira o inventário de
  capacidade delas, e elas ficam com os IDs originais. Uma linha fiscal
  gravada em custódia depois da varredura, como a `captureAudit` da retirada
  da liberação da captura, fica fora do pacote e continua quente, e a
  varredura do ciclo seguinte a leva
  ([arquivo econômico](../operacao/arquivo-economico.md#a-cerca-de-numeração-e-captura)).
  Hoje só organização encerrada chega à remoção.

  **Entregue na PR 4 do plano (catálogo compactado, seção 4):** depois de
  `archived`, o executor (`scripts/cold-tier/cold-archive.mjs compact`, também no fim
  de `archive`) grava as entradas do run como um objeto JSONL canônico
  cifrado com age para os custodiantes do pacote, ao lado dele no R2, com
  manifesto próprio e imutável, ambos por escrita condicional. Baixa, decifra
  e compara o objeto com cada entrada quente antes de gravar o hash do
  manifesto no run (`coldArchive:catalogVerified`); só então
  `coldArchive:compactCatalogBatch` apaga as entradas em lotes retomáveis,
  conferindo a contagem. A restauração isolada de um run compactado baixa e
  decifra o catálogo e confere o pacote com ele; os diagnósticos antigos que
  liam as entradas do banco recusam com `ARCHIVE_CATALOG_COMPACTED`. O backup
  passa a conferir o objeto do catálogo como dependência permanente
  ([arquivo econômico](../operacao/arquivo-economico.md#catálogo-compactado)).
  O pacote por referência à camada fria da ADR 0010 não faz parte desta PR.

  **Entregue na PR 5 do plano (base da reidratação, §5, itens 5 e 6, e §6):**
  o inventário das referências sai do schema (`archiveReferences`, em
  `lib/coldArchiveReferences.ts`), com cada `v.id` para tabela arquivada ou
  `_storage` classificado como reescrito, mantido ou recriado, e a lista
  explícita dos campos de texto com ID de tabela arquivada; o teste de
  cobertura falha com um campo sem classe. O par "primeiro ID / primeira
  criação" (`originId`, `originCreationTime`) existe, opcional, nas tabelas
  arquivadas fora da cerca, com `firstId` e `firstCreation`; listagens e
  ordenação passam a usá-lo na PR 6. O mapa de IDs (`coldArchiveIdMap`, classe
  `fiscal`) existe, com a gravação idempotente na transação da linha nova e a
  contabilização como estoque. `ARCHIVE_STORAGE_FIELDS` passou a tabela →
  lista de campos. O manifesto do pacote registra a versão do schema fiscal
  (`schemaVersion`, ausente = 1); as migrações de pacote ficam para a PR 6
  ([arquivo econômico](../operacao/arquivo-economico.md#base-da-reidratação-referências-mapa-de-ids-e-versão-do-schema)).
  Levar o mapa no pacote ou compactá-lo num novo arquivamento continua aberto.

  **Entregue na PR 6 do plano (reidratação com IDs novos, §5, itens 1 a 9):**
  a organização aberta passa por congelamento, remoção e reidratação, sempre
  atrás de `FNFE_COLD_ARCHIVE`; `ARCHIVE_REACTIVATION_UNPROVEN` fica só na
  restauração isolada, ainda restrita a organizações encerradas. O executor
  (`scripts/cold-tier/cold-archive.mjs rehydrate`, funções em
  `coldArchiveRehydration.ts`) baixa e decifra pacote e catálogo e os confere,
  admite (plano pago ativo, estoque no plano atual) e trabalha em duas
  passagens retomáveis, com progresso no run: primeiro os arquivos, por
  intenções de upload (`coldArchiveUploads`), e as linhas, inseridas com ID
  novo, par de origem e entrada do mapa na mesma transação, na ordem do
  catálogo e com o hash encadeado até o `digest` da varredura; depois as
  referências, nas linhas reidratadas e nas quentes da organização. A
  conferência canônica reconstrói cada linha e cada arquivo como o pacote os
  trazia, e só então o run volta a `hot`. Os uploads órfãos são coletados.
  As chaves de uso e de idempotência compostas com IDs de linhas que voltam
  usam o primeiro ID. O histórico da captura ordena pela primeira criação.
  Testes de ida e volta, queda e retomada, repetição, duas organizações e
  órfãos em `convex-test`
  ([arquivo econômico](../operacao/arquivo-economico.md#reidratação-com-ids-novos)).

  Escolhas da implementação onde esta ADR é omissa: a margem da admissão é
  de 10%, sobre a medida das seis tabelas de documentos e do mapa feita pelo
  executor, e a recusa indica o menor plano do catálogo que comporta; a
  reidratação exige o catálogo compactado; um pacote de outra versão do
  schema fiscal é recusado (`ARCHIVE_SCHEMA_MIGRATION_REQUIRED`), porque só
  existe a versão 1 e nenhuma migração de pacote; a intenção cujo arquivo
  gravado sumiu ou mudou para a reidratação (`ARCHIVE_UPLOAD_LOST`) em vez de
  enviar de novo, porque o mapa já nomeia esse arquivo; um arquivo só é aceito
  na intenção se foi criado na janela da tentativa (70 minutos) e nada o
  guarda; o órfão é o arquivo com o hash, o tamanho e o tipo do original,
  criado na janela de uma tentativa não concluída e que nada guarda, e só é
  julgado uma hora depois dessa janela; a ordem implícita pelo
  `_creationTime` se mantém porque as linhas entram na ordem de criação
  original, e só a linha fiscal gravada em custódia precisa ordenar pela
  primeira criação; a `captureAudit` gravada em custódia não é lida pela
  segunda passagem, porque não tem índice da organização e só aponta para a
  cerca; e `registryCache.pendingOperationId` passou a mantido, porque só
  vale durante o lease de uma operação, impossível numa organização
  congelada.

  **Entregue na PR 7 do plano (IDs antigos na REST e `originalId`, §6):** as
  rotas que recebem ID de documento, versão (`versionId`), original,
  importação, arquivo de lote, operação, emissão e artefato de emissão, e o
  `documentId` de `POST /v1/exports`, procuram primeiro a linha e, sem ela, o
  mapa da organização da chave (`currentRow`, em `lib/coldArchiveCurrent.ts`),
  seguindo a cadeia de ciclos até a linha atual; acesso, escopo e concessão
  são conferidos sobre a linha encontrada, e um ID anterior de outra
  organização responde `NOT_FOUND`. Documentos (`summary`), versões,
  arquivos e originais não classificados, operações, lotes e arquivos de
  importação, emissões e artefatos de emissão trazem `originalId`, o
  `originId` da linha, só quando ela foi reidratada; o envelope de webhook
  ganhou `resource.originalId`, nos eventos de documento, importação e
  emissão emitidos depois da reativação. O contrato 8.0.0 recebeu esses
  campos opcionais sem outro major, pela regra do major não publicado
  ([SDK.md](../v1.0/SDK.md#versionamento)); o envelope continua na versão
  `1`. Testes em `convex-test` com o ciclo simulado no banco
  ([arquivo econômico](../operacao/arquivo-economico.md#ids-anteriores-na-rest)).

  Escolhas da PR 7 onde esta ADR é omissa: só `originalId`, sem a cadeia
  opcional de IDs anteriores; o campo aparece no recurso cujo próprio `id`
  uma rota aceita ou um webhook nomeia, não no cancelamento de emissão nem
  nas referências internas (`operationId`, `artifactId`, `versionId`,
  `documentId`), que já saem com o ID novo; a cadeia segue até 32 saltos; o
  reprocessamento de documento passou a calcular o hash pelo `documentId`
  como foi enviado, igual ao `_id` sem reidratação, e o de arquivo de lote,
  que o chamador nomeia pelo arquivo, compara o artefato pelo primeiro ID; a
  exportação guarda o ID atual na seleção, porque a reidratação reescreve
  `selection.documentId` e a repetição com o ID antigo precisa achar a mesma
  exportação; e os eventos já gravados no outbox antes do arquivamento são
  entregues como estavam, sem `originalId`.

  **Entregue na PR 8 do plano (restauração isolada de organização aberta,
  §7):** `scripts/cold-tier/cold-archive.mjs restore` passa a servir a organizações
  encerradas e abertas, pela mesma função (`restoreIsolated`, em
  `scripts/lib/cold-archive.mjs`). Ela lê o run, baixa e decifra o pacote
  selado e, se o run tiver, o catálogo compactado, confere os dois com seus
  manifestos e um com o outro, importa no destino isolado e compara a
  reexportação com o pacote. Não grava nada na origem nem no R2: não registra
  prova, não usa a cerca de versão e pode ser repetida quantas vezes for
  preciso, inclusive durante o arquivamento ou a reidratação do mesmo run. O
  destino recebe o pacote como foi selado: no primeiro ciclo, com os IDs
  originais; num ciclo seguinte, com os IDs do ciclo anterior e o primeiro ID
  em `originId`. A cerca vai como a varredura a leu, e o mapa de IDs fica na
  origem. O recibo informa `reason`, o estado do run e quantas linhas vieram
  de uma reidratação (`rehydratedRows`). A limpeza de uploads órfãos já estava
  completa na PR 6 (`cold-archive.mjs orphans`). Esta PR não acrescentou
  coleta nova; documentou como ela se comporta depois de restaurar um backup.
  Testes em `convex-test` com as funções reais e em `scripts/` com age real:
  organização aberta em `archived` e em `restoring`, no meio de uma
  reidratação que depois termina, recusa em `hot` antes de ler o R2, duas
  organizações sem vazamento entre os destinos, repetição com o mesmo
  resultado e segundo ciclo com `originId`
  ([arquivo econômico](../operacao/arquivo-economico.md#recuperação-isolada-e-exportação-assistida)).

  Escolhas da PR 8 onde esta ADR é omissa:
  - A restauração aceita os estados de `sealed` a `restoring`. Ela recusa
    `notice` e `frozen` com `ARCHIVE_NOT_SEALED`, porque ainda não há pacote
    selado e os dados estão quentes. Também recusa `hot` com
    `ARCHIVE_ORGANIZATION_HOT`, porque a organização reidratada tem a
    exportação normal. Antes, um `restore` sem manifesto chegava a varrer,
    publicar e selar o pacote, alterando a origem; agora isso fica só com
    `archive`.
  - Um pacote de outra versão do schema fiscal é recusado
    (`ARCHIVE_SCHEMA_MIGRATION_REQUIRED`), como na reidratação.
  - O mapa de IDs não vai ao destino. As linhas de um ciclo seguinte já
    trazem o primeiro ID, e os IDs intermediários continuam resolvendo na
    origem, pelo mapa quente e pela REST.
  - A linha fiscal gravada em custódia depois da varredura, como a
    `captureAudit` da retirada da liberação, não está no pacote e continua
    quente na origem. Isso não afeta a exportação do cliente
    ([EXPORTS.md](../plataforma/EXPORTS.md)), que não inclui auditorias.
  - Num deployment restaurado de um backup para ensaio, só se usa o
    `restore`, que é somente leitura. `archive` e `compact` gravam no mesmo
    prefixo `cold/` do R2 que a produção usa, e `rehydrate` e `orphans`
    gravam na origem. A regra fica só documentada: o executor não tem como
    reconhecer um deployment restaurado.

  As três decisões que a PR 8 deixou para o dono do projeto (formato,
  canal e custo da exportação assistida) foram tomadas em 30/10/2026
  ([Decisões de 30/10/2026](#decisões-de-30102026)).

  **Entregue na PR 9 do plano (exportação assistida,
  [#658](https://github.com/freecorps/freecorpsNFE-arquivo/issues/658)):**
  `scripts/cold-tier/cold-archive.mjs export` aplica as três decisões. Grava o pedido na
  origem (`assistedExport:request`, tabela `assistedExports`, classe
  `closure`) antes de ler o R2. Aceita só o Proprietário ativo, achado pela
  conta do e-mail de onde o pedido veio e com e-mail verificado, e no máximo
  um pedido `owner` a cada 30 dias por organização; o pedido `rights`, de
  titular por RIGHTS.md, leva a referência do registro restrito e não conta
  nem é limitado. Depois restaura o pacote no destino isolado (`restore`, sem
  mudança) e gera ali, com o gerador da exportação normal (`exportSource`,
  `exportWorker`), a mesma exportação da organização, com o ID, o corte e o
  prazo de uma exportação criada na origem em nome do Proprietário. Como o
  pacote só leva a classe `fiscal`, as empresas vêm da origem, com o ambiente
  servido a cada uma. O comando publica as partes nessa exportação da origem
  por upload, conferidas por hash, tamanho e MIME. O Proprietário baixa pelo
  ticket normal, com as mesmas 24 horas; com a organização arquivada, só essa
  exportação passa pela lista, pelas partes e pelo ticket. Testes em
  `convex-test`: a geração com só a classe `fiscal` dá os mesmos bytes e
  hashes da exportação normal da mesma organização quente, sem campo interno;
  recusa de quem não é Proprietário (admin, viewer, conta sem membro, membro
  removido); limite de 30 dias e exceção de titular; publicação e download
  com a organização arquivada; repetição e retomada
  ([arquivo econômico](../operacao/arquivo-economico.md#exportação-assistida)).

  Escolhas da PR 9 onde esta ADR é omissa:
  - O pedido cobre um ou dois ambientes, como o diálogo do console; cada um
    vira uma exportação, e o pedido conta uma vez no limite.
  - As 24 horas contam da preparação da exportação na origem, não do pedido;
    o comando gera e publica logo em seguida. Depois do prazo de uma exportação
    publicada, o mesmo pedido recusa com `ASSISTED_EXPORT_DELIVERED`; é
    preciso outro pedido, sujeito ao limite.
  - A Freecorps paga a exportação assistida pela decisão 3: as partes e o
    download ficam fora da capacidade e da cota da organização.
  - A geração no destino recusa com `ASSISTED_EXPORT_NOT_ISOLATED` onde a
    organização existe ou sem os controles de `coldArchive:restoreSafety`.
    O destino não usa Workpool: o comando conduz cada etapa.
  - O comando não apaga o destino isolado, um processo local do operador;
    o passo fica em [restauracao.md](../operacao/restauracao.md#exportação-assistida-e-destino-isolado).
  - Não houve ensaio fora de `convex-test`: nem import real no Convex
    isolado nem upload real à origem.

  **Entregue na #691 (prazo do pacote e ensaio):** cada run tem uma regra
  de lock com data no prefixo próprio do R2, criada antes do pacote existir;
  `scripts/cold-tier/cold-archive.mjs renew` estende a regra e depois o `retainUntil`
  do run para a guarda contada de hoje, ou do encerramento, só para frente e
  só enquanto o pacote está selado e a organização arquivada; `due` lista os
  runs a renovar. Os manifestos guardam a data do selo. Escolha onde esta ADR
  é omissa: uma regra por run, com o teto de 1.000 regras por bucket do R2. O
  ensaio rodou o ciclo inteiro com R2 real,
  import isolado real e upload real numa origem de nuvem descartável, com
  uma cópia só e identidades age sintéticas.

  Continua aberto depois da PR 8 e da #691:
  - levar o mapa no pacote ou compactá-lo num novo arquivamento. Hoje um
    segundo arquivamento funciona, coberto pelo teste da PR 8, mas o mapa do
    ciclo anterior fica quente por inteiro durante a custódia, contra a seção
    6;
  - as migrações de pacote, quando houver a versão 2 do schema fiscal;
  - os botões "reativar" e "pedir exportação assistida" no console;
  - duas cópias independentes do pacote e a decifração com as identidades
    dos custodiantes reais, que o ensaio da #691 não cobriu.

  **Emendas da ADR 0010** ([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642)):
  a PR 6 reidrata o histórico inteiro no quente; a reidratação só da janela
  quente (emenda 1) veio na fase C2 da ADR 0010, depois da fase C; o pacote
  por referência à camada fria (emenda 2) vem na fase C da ADR 0010. Na PR 5,
  `ARCHIVE_STORAGE_FIELDS` passou de tabela → campo para tabela → lista de
  campos, para cobrir os campos de arquivo (`v.id("_storage")`) da ADR 0010.

- **Limites do executor.** Antes de uma organização acima de 100 mil
  registros usar este caminho, os limites de registros e de JSON do pacote
  precisam subir com prova. Com o banco cheio, isso acontece com média por
  linha abaixo de cerca de 2.684 bytes no Grande, 671 no Intermediário e
  335 no Gratuito. Até lá ela fica no caminho quente.
- **Janela sem receita do plano pago.** Fechada pela decisão 1 de
  29/10/2026, já implementada: o aviso começa no fim do período pago, e só o mês do aviso fica
  quente, financiado pelo aporte.
- **Custos não medidos.** Linhas `closure` e `commercial` quentes durante a
  custódia, organizações abertas só com Sandbox até o operador encerrá-las, cerca de numeração e captura,
  objeto do catálogo no R2, mapa de IDs após a reidratação (cerca de 33 MiB
  por 100 mil linhas pela medida do catálogo), pacotes de ciclos anteriores
  até o `retainUntil`, exportações assistidas durante o arquivo, execução do
  arquivo, reidratações repetidas, rearquivamento após reativação e guarda
  além de 72 meses.
- **Limite de reativações do Gratuito.** Decisão pendente do dono do projeto.
- **Organizações abertas só com Sandbox.** Decidido em 29/10/2026 (decisão 2)
  e implementado: aviso de 30 dias depois de 90 dias sem atividade e
  encerramento pela Freecorps, com o expurgo antecipado. Sem cron, o operador
  dispara aviso e encerramento; até isso acontecer, uma organização assim
  fica quente, até R$ 660,55 em 72 meses num Gratuito cheio.
- **Duas cópias independentes.** O R2 real com lock por run foi ensaiado na
  #691; o pacote ainda tem uma cópia só.
- **Backup integral do Grande**: o incremental recusa conjuntos acima de
  1 GiB, incluindo arquivos, e o Grande admite 2 GiB de arquivos.
- **Textos jurídicos** de aviso, arquivamento e reativação
  ([#428](https://github.com/freecorps/freecorpsNFE-arquivo/issues/428)).
- **Margem medida e fundos reais** configurados e conciliados.
- **Aceite final** e ligar o catálogo
  ([#51](https://github.com/freecorps/freecorpsNFE-arquivo/issues/51)).

Nada desta decisão foi medido em produção.
