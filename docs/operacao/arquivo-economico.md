# Arquivo econômico

O arquivo econômico conserva os originais e os registros fiscais de uma
organização em um pacote cifrado com age, fora do storage quente do Convex:
de uma organização encerrada e `purged`, ou de uma organização aberta depois
do [aviso](#aviso-de-organização-aberta). Somente depois de baixar, decifrar,
importar em um Convex isolado e comparar a reexportação, o executor
administrativo autoriza a remoção em lotes. A organização encerrada se
recupera somente em destino isolado. A aberta volta à origem pela
[reidratação com IDs novos](#reidratação-com-ids-novos); enquanto está
arquivada, também pode ser restaurada em destino isolado para a
[exportação assistida](#recuperação-isolada-e-exportação-assistida). O fluxo é desligado
por padrão: exige `FNFE_COLD_ARCHIVE=enabled` no backend.

**Situação em 28/10/2026.** O dono do projeto decidiu a custódia fria de
organizações abertas, com reidratação sob IDs novos
([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md)). Para o
futuro, essa decisão substitui a de conservar quentes todos os registros das
organizações abertas, descrita abaixo, e a manutenção do catálogo
`coldArchiveEntries` quente depois de `archived`. A implementação vem em
partes. A primeira, de 29/10/2026, leva a organização aberta até o aviso,
com as decisões de 29/10/2026 da ADR; a seguinte leva a organização aberta só
com Sandbox até o encerramento pela Freecorps. Vale, para todo run em
`archived`, a [compactação do catálogo](#catálogo-compactado). Desde a PR 6,
de 30/10/2026, a organização aberta é congelada, arquivada e reidratada sob
IDs novos ([reidratação](#reidratação-com-ids-novos)), sempre atrás de
`FNFE_COLD_ARCHIVE`, desligado no hospedado. Isso só foi provado em
`convex-test`: nenhuma organização real foi arquivada nem reidratada. Desde
a PR 7, as rotas REST resolvem IDs anteriores
([IDs anteriores na REST](#ids-anteriores-na-rest)); desde a PR 8, a
[restauração isolada](#recuperação-isolada-e-exportação-assistida) (§7)
serve também a organizações abertas.

O executor está em `scripts/cold-archive.mjs`. Não há API REST nem mutation
pública que aceite um recibo de prova. As funções de `coldArchive.ts` são
internas e exigem a credencial administrativa do deployment. A autorização
vem desse executor; uma conta do console, mesmo owner, não a concede.

## O que sai do quente

O pacote inclui as 25 tabelas da classe `fiscal`, com seus IDs e
`_creationTime`, e os arquivos referenciados por `importFiles`,
`documentArtifacts`, `captureBatches` e `issuanceArtifacts`. Inclui NF-e 55,
NFS-e ABRASF, emissão, cancelamento, operações, versões, itens, eventos e
originais de lotes. Um teste compara a lista com a classificação de retenção.
Duas dessas tabelas entram no pacote mas não saem do quente: a
[cerca de numeração e captura](#a-cerca-de-numeração-e-captura).

O catálogo `coldArchiveEntries` mantém uma entrada por registro ou arquivo,
com ID original, hash, tamanho e estado da remoção. Arquivos também conservam
todos os metadados do `_storage`. O pacote cifrado não substitui esse
catálogo: ambos precisam ser recuperáveis. Depois de `archived`, o catálogo
sai do banco para um objeto cifrado no R2
([catálogo compactado](#catálogo-compactado)). `coldArchiveRuns` guarda a
versão, o aviso, os cursores, o manifesto imutável, as provas e o hash do
manifesto do catálogo.

O pacote admite até **256 MiB de JSON fiscal e 2 GiB de arquivos**, separados.
O ZIP64, o download e o age trabalham com arquivos em disco e streams; o
executor não carrega o pacote inteiro na memória. A comparação do banco
processa JSONL linha por linha e conserva somente IDs e hashes. Há um limite
de 100 mil registros fiscais por pacote. Acima dele, a varredura recusa antes
de qualquer remoção. O limite de ZIP descompactado é 3 GiB, incluindo a
reserva para metadados e estrutura.

O backup incremental da plataforma tem um limite global próprio de 1 GiB,
incluindo arquivos. Acima dele, o preflight recusa. O limite do pacote frio
não amplia o do backup: a prova desta entrega não cobre o backup de uma
conta Grande com 2 GiB ocupados, nem autoriza alegar essa capacidade testada.

Dados comerciais, controle, acesso e cadastro continuam no Convex. Até a
compactação, o catálogo frio e seus índices também continuam; depois dela,
ficam a linha do run e a cerca. **O custo quente não zera**;
o dimensionamento deve contar esses dados e a cópia externa. Não desconte
economia de uma organização antes de concluir `archived`, nem de contas
que excedem os limites operacionais abaixo.

`coldArchive:catalogueCost` mede o catálogo paginado com `getDocumentSize`
do Convex. Some `entryBytes` de todas as páginas e `runBytes` uma vez. A
consulta devolve contagens e mínimo/máximo por entrada, sem conteúdo fiscal,
e `catalogState`: `hot` antes da compactação, `verified`, `compacting` ou
`compacted` depois. Num run compactado, `entryBytes` zero quer dizer que o
catálogo está no R2, não que ele é vazio; as medições abaixo são do catálogo
ainda quente.
Uma amostra sintética com IDs de 32 caracteres, timestamp de 13 dígitos e
`application/xml` mediu 329 bytes por entrada `documentArtifacts`, 504 bytes
por entrada de arquivo e 1.356 bytes por run com manifesto de 740 bytes.
Cem mil registros e cinco mil arquivos nessa amostra ocupam **33,78 MiB**
quentes. São bytes lógicos; nomes, timestamps e metadados mudam o resultado,
e índices/replicação custam à parte. Uma linha fiscal menor que sua entrada
de catálogo pode aumentar o banco quente. A economia depende da medição do
conjunto, não apenas da quantidade removida.

A medição no Convex local
registrou 86 entradas de banco e três de arquivo, somando 29.486 bytes,
mais 1.350 bytes do run. Total: **30.836 bytes lógicos**, com entradas entre
319 e 508 bytes, sem índices nem dados comerciais. O catálogo dessa fixture
é maior que seus 21.505 bytes de JSON fiscal. Portanto esse ensaio não
demonstra economia de banco, mesmo no caso de recuperação isolada.

### A cerca de numeração e captura

As linhas de `dpsSequences` e `captureStreams` da organização são a cerca
mínima da [ADR 0009, §3](../adr/0009-custodia-fria-de-organizacoes-abertas.md#3-estado-arquivado-e-recusa-de-admissões)
(`ARCHIVE_FENCE_TABLES`, em `lib/coldArchiveCore.ts`). Elas impedem reusar
um número de DPS ou recomeçar a captura do zero enquanto a organização está
arquivada. São poucas: até mil streams, pelo limite do congelamento.

- **No pacote.** Cada linha da cerca tem entrada no catálogo com hash, conta
  em `rows`, `databaseBytes` e no `digest` do manifesto, e vai inteira para o
  pacote, com o ID original. A entrada guarda também o JSON lido na varredura
  (`snapshot`). O pacote leva essa cópia, e não a linha relida: como a cerca
  continua quente, ela pode mudar depois da varredura, por exemplo quando a
  retirada da liberação da captura pausa o stream em custódia. A restauração
  isolada importa e compara a cerca como qualquer outra linha.
- **Na remoção.** `removeHotBatch` não apaga a linha da cerca nem tira o
  inventário de capacidade dela (`capacityRecords`). Ela só confere que a
  linha ainda existe e ainda é da organização; se não, para com
  `ARCHIVE_FENCE_MISSING`, sem apagar nada do lote. Não compara o hash com o
  da varredura, porque a mudança em custódia é legítima. Depois de
  `archived`, a cerca continua no banco com os mesmos IDs.
- **Na reidratação**, a cerca não é recriada, não entra no mapa de IDs e as
  referências a ela não são reescritas. A primeira passagem só confere que
  cada linha da cerca do pacote ainda existe e é da organização, e a encadeia
  no hash como as outras.

Uma linha fiscal criada depois da varredura não tem entrada no catálogo, então
a remoção não a apaga. As ações que continuam permitidas em custódia gravam
linhas assim. A retirada da liberação da captura grava `captureAudit`, e a
revogação de certificado grava `certificateAudit`. Essas linhas ficam
quentes com seus IDs e apontam para linhas que também ficam quentes: o
stream, que é cerca, e o certificado, da classe `closure`. A varredura do
ciclo seguinte lê todas as linhas da organização e as leva. Recusar
`archived` por causa delas deixaria o run preso, porque o pacote selado é
imutável e não há uma nova varredura sobre ele.

### Catálogo compactado

Depois de `archived`, as entradas do run saem do banco
([ADR 0009, §4](../adr/0009-custodia-fria-de-organizacoes-abertas.md#4-catálogo-compactado)).
Vale para todo run que chega a `archived`, inclusive de organização
encerrada. O executor faz isso em quatro passos:

1. **Serializa.** Lê as entradas pela consulta interna `coldArchive:entries`,
   em páginas, na ordem do índice do run, e grava uma linha JSON canônica por
   entrada: tipo, tabela, ID original, hash, tamanho e, quando houver, os
   metadados de storage e o `snapshot` da cerca. Ficam de fora o `_id` e o
   `_creationTime` da entrada, o run, a organização e a marca de remoção. A
   contagem precisa bater com `rows` e `files` do run.
2. **Publica.** Cifra com age para os mesmos custodiantes do pacote (o
   executor recusa outro conjunto) e grava, por escrita condicional, o objeto
   `<prefixo><runId>/catalog.jsonl.age` e o manifesto imutável
   `<prefixo><runId>/catalog-manifest.json`, ao lado do pacote. O manifesto
   (`fnfe-cold-archive-catalog/1`) leva run, organização, versão, o hash do
   manifesto do pacote, contagens, `retainUntil`, hash e tamanho do texto
   claro e da cifra. O manifesto do pacote não muda.
3. **Confere.** Baixa o objeto, confere a cifra com o manifesto, decifra,
   confere o texto claro e compara linha a linha com as entradas do banco:
   contagem, IDs originais, hashes, tamanhos, metadados de storage e
   `snapshot` da cerca. Só então grava o hash do manifesto no run, em
   `catalog`, pela mutation interna `coldArchive:catalogVerified`. Ela recusa
   versão antiga (`ARCHIVE_STALE_FENCE`), run fora de `archived`
   (`ARCHIVE_NOT_ARCHIVED`), manifesto que não confere com o run
   (`ARCHIVE_CATALOG_MISMATCH`) e outro manifesto sobre um já gravado
   (`ARCHIVE_CATALOG_IMMUTABLE`); repetir o mesmo não faz nada.
4. **Apaga.** `coldArchive:compactCatalogBatch` apaga até 64 entradas por
   lote e soma a contagem no run, na mesma transação, até `compacted`. Recusa
   antes do registro (`ARCHIVE_CATALOG_UNVERIFIED`), com retenção legal ativa
   (`ARCHIVE_LEGAL_HOLD`) e quando o banco tem entradas além do objeto ou
   termina antes dele (`ARCHIVE_CATALOG_COUNT_MISMATCH`), sem apagar nada do
   lote.

Ficam quentes, da custódia, só a linha de `coldArchiveRuns` e a cerca.
Enquanto o catálogo está em `compacting` ou `compacted`, ler as entradas do
banco é recusado com `ARCHIVE_CATALOG_COMPACTED` (`coldArchive:entries`,
`restoreRemaining` e `verifyRestoredBatch`): uma página vazia passaria por
catálogo inteiro ou por restauração completa.

O objeto e o manifesto do catálogo têm o tratamento do pacote: o mesmo
prefixo do run, a mesma regra de lock e o `retainUntil` do selo, registrado
no manifesto. A [renovação](#prazo-do-pacote-e-lock-no-r2) vale para os dois.

### Base da reidratação: referências, mapa de IDs e versão do schema

A [reidratação com IDs novos](#reidratação-com-ids-novos)
([ADR 0009, §5 e §6](../adr/0009-custodia-fria-de-organizacoes-abertas.md#5-reidratação-com-identidades-novas))
usa estas peças:

- **Inventário de referências.** `archiveReferences`
  (`lib/coldArchiveReferences.ts`) percorre os validators do schema e lista
  todo campo `v.id` que aponta para uma tabela de `ARCHIVE_TABLES` ou para
  `_storage`, em qualquer tabela e profundidade (objetos, arrays, records,
  uniões e opcionais). `ARCHIVE_ID_REFERENCES` classifica cada um: 51
  reescritos para o ID novo, 11 mantidos (as referências à cerca, os arquivos
  que nunca entram no pacote: partes de exportação, referência pública e
  e-mail de privacidade; e `registryCache.pendingOperationId`, que só vale
  durante o lease de uma operação, impossível numa organização congelada) e
  1 recriado
  (`capacityFiles.storageId`). Os campos
  de texto que guardam ID de tabela arquivada têm lista própria,
  `ARCHIVE_TEXT_REFERENCES`: `capacityRecords.key` é recriado; chaves de
  deduplicação compostas por código (`idempotencyRecords.key`,
  `usageEvents.key`) usam o primeiro ID; os demais, como o outbox, as chaves
  de uso da captura, a auditoria operacional e o JSON de `operations`, mantêm
  o ID antigo e são resolvidos pelo mapa. O teste
  `tests/platform.coldArchiveReferences.test.ts` falha se um `v.id` desses
  ficar sem classe, se a classe citar campo que o schema não tem, se uma
  referência à cerca não for mantida, ou se um campo de texto com nome de ID
  (`*Id`, `*Key`, `key`, `body`, `request`, `response`, `target` e outros),
  numa tabela da organização ou ligada ao arquivo, não estiver em
  `ARCHIVE_TEXT_REFERENCES` nem em `ARCHIVE_TEXT_UNRELATED`.
- **Campos de arquivo.** `ARCHIVE_STORAGE_FIELDS` dá uma lista de campos por
  tabela, para os campos de arquivo que a fase B da ADR 0010 acrescenta. A
  varredura empacota cada arquivo citado por qualquer um deles, uma vez só.
  O primeiro deles é `documentVersions.contentStorageId`, o blob compactado
  da versão: a reidratação o sobe com ID novo e reescreve a referência, mas
  nunca reescreve o blob, então os IDs dentro dele continuam os antigos, como
  em `documentVersions.result`, e o `contentSha256` continua valendo.
- **Primeiro ID e primeira criação.** As tabelas de `ARCHIVE_TABLES`, menos a
  cerca, têm `originId` e `originCreationTime` opcionais. A reidratação os
  grava uma vez, no primeiro ciclo (`originFor`), e nunca os muda. Numa linha
  nunca reidratada eles não existem, e o JSON e o hash da linha continuam os
  de antes. `firstId` e `firstCreation` (`lib/coldArchiveOrigin.ts`) leem o
  par, ou o `_id` e o `_creationTime` da própria linha. As chaves de
  deduplicação compostas por código com o ID de uma linha que pode ser
  reidratada usam `firstId`: o uso de tentativas (`operation:…`), da consulta
  cadastral e da captura (`attemptUsageKey`), de documentos publicados e de
  emissões autorizadas, e as chaves do reprocessamento de recusas
  (`refusalReprocess.ts`). Sobre a ordenação, veja a
  [reidratação](#ordem-das-listagens).
- **Mapa de IDs.** `coldArchiveIdMap` guarda organização, run, tabela, `_id`
  e `_creationTime` anteriores e o ID novo, com índices por organização e ID
  anterior, por run e ID anterior e pelo ID novo. `recordArchiveId`
  (`lib/coldArchiveIdMap.ts`) grava a entrada na transação que insere a linha
  nova, só com o run da organização em `restoring`. Repetir a mesma entrada
  devolve a existente; outro ID novo para o mesmo anterior, ou um ID novo já
  mapeado, é recusado com `ARCHIVE_MAP_CONFLICT`. Cada entrada conta no
  estoque de banco da organização, em modo de inventário, e entra no
  inventário de `capacity:inventory`. O mapa é da classe `fiscal`: o expurgo
  ao fim da guarda o apaga com as linhas fiscais.
- **Versão do schema fiscal.** O manifesto do pacote leva `schemaVersion`,
  hoje 1 (`ARCHIVE_SCHEMA_VERSION`, em `lib/coldArchiveCore.ts` e
  `scripts/lib/cold-archive.mjs`, mantidos iguais por teste). Um manifesto
  sem o campo, de pacote anterior, é versão 1; o executor recusa versão maior
  que a sua, e `coldArchive:seal` recusa pacote novo fora da versão atual. A
  versão sobe, com uma migração de pacote, quando uma linha válida no schema
  antigo de uma tabela arquivada deixa de ser válida ou muda de sentido no
  novo; campo opcional que as linhas antigas não têm, como o par de origem,
  não muda a versão.

## Reidratação com IDs novos

A organização aberta arquivada volta à origem com IDs novos do Convex
([ADR 0009, §5](../adr/0009-custodia-fria-de-organizacoes-abertas.md#5-reidratação-com-identidades-novas)),
com o histórico inteiro: versões, itens, eventos, tentativas, auditorias e
originais de lotes. Com a camada fria ligada, só a janela quente do plano
volta ao armazenamento de arquivos; as notas mais antigas voltam com todas as
linhas e com o conteúdo e o original no bucket frio (emenda 1 da ADR 0010,
fase C2, na [etapa fria](#etapa-fria-adr-0010-c2)). Num plano pago, a
reativação começa com a
contratação ou renovação; no Gratuito, o owner pede pelo suporte, porque o
console ainda não tem o botão. Em todos os casos, quem executa é o operador:

```sh
node scripts/cold-archive.mjs rehydrate plano.json RUN_ID /caminho/identidade-age
```

Usa só a origem e o R2, sem destino isolado. As funções ficam em
`coldArchiveRehydration.ts`, internas e atrás de `FNFE_COLD_ARCHIVE`. O run
fica em `restoring` do começo ao fim, com o progresso em `rehydration`, e as
admissões continuam recusadas com `ORGANIZATION_ARCHIVED` até a volta a
`hot`. O executor:

1. **Prepara.** Um run de organização encerrada é recusado
   (`ARCHIVE_CLOSED_NOT_REACTIVATABLE`), e também uma organização com pedido
   de encerramento. Se a compactação do catálogo ficou pela metade, termina
   ela antes. Baixa e decifra pacote e catálogo, confere cada um com seu
   manifesto e o pacote com o catálogo.
2. **Admite** (`coldArchiveRehydration:begin`). Antes, o executor lê a
   regra da camada fria (`coldPolicy`) e separa as notas fora da janela que
   vão para o bucket ([etapa fria](#etapa-fria-adr-0010-c2)). Plano pago
   precisa estar ativo (`PLAN_INACTIVE`). Com a política de capacidade
   ligada, o estoque precisa caber no plano atual: o executor mede com
   `getDocumentSize` as linhas das seis tabelas de documentos, já com o par
   de origem, mais uma entrada do mapa por linha e arquivo e o que cada nota
   fria ganha; o servidor soma a margem de 10%
   ([USAGE.md](../plataforma/USAGE.md)). Os arquivos contam os bytes do
   manifesto, menos os das notas que vão para o bucket, mais o maior lote da
   etapa fria. Se não couber, recusa antes de gravar com `QUOTA_EXCEEDED`, a
   métrica, o total exigido e o menor plano do catálogo que comporta
   (`plan`). Recusa também catálogo não compactado
   (`ARCHIVE_CATALOG_NOT_COMPACTED`) e pacote de outra versão do schema
   fiscal (`ARCHIVE_SCHEMA_MIGRATION_REQUIRED`): ainda não há migração de
   pacote, porque só existe a versão 1. Só então o run passa a `restoring`.
3. **Envia os arquivos.** Para cada original quente, na ordem do catálogo,
   `beginUpload` grava a intenção (`coldArchiveUploads`: run, ID de storage
   original, criação, hash, tamanho e tipo esperados, número da tentativa) e
   devolve uma URL de upload; o executor envia os bytes e `recordUpload`
   grava o ID novo. O servidor só aceita um arquivo criado dentro da janela
   da tentativa (70 minutos, a validade da URL com folga) que nenhuma tabela
   de `storageHolders` nem outra intenção guarda (`ARCHIVE_UPLOAD_FOREIGN`):
   o executor nunca escolhe arquivo fora da intenção nem procura por hash.
   Com hash, tamanho ou tipo diferentes, apaga o arquivo, marca a tentativa
   como recusada e a reidratação para. Na mesma transação, grava a entrada
   `_storage` do mapa e o inventário do arquivo. Numa tentativa repetida,
   uma intenção concluída cujo arquivo ainda confere é reaproveitada sem
   novo envio; se o arquivo gravado sumiu ou mudou, para com
   `ARCHIVE_UPLOAD_LOST`, porque o mapa já o nomeia.
4. **Insere as linhas** (`rows`), em lotes de até 32 linhas ou 4 MiB, na
   ordem do catálogo, a partir do deslocamento gravado no run. Cada linha
   precisa ser o JSON canônico da linha do pacote; seu hash entra numa cadeia
   igual à da varredura, que precisa terminar igual ao `digest` do run
   (`ARCHIVE_REHYDRATE_DIGEST`). Linha com `organizationId` de outra
   organização é recusada (`ARCHIVE_ROW_FOREIGN`). A cerca só é conferida.
   As demais entram com `insert`, ID novo, o par de origem e, na mesma
   transação, a entrada do mapa e, nas tabelas de documentos, o inventário de
   capacidade, em modo de inventário. As referências ainda apontam para os
   IDs anteriores. Nenhum webhook é enfileirado e nada conta no consumo
   mensal.
5. **Reescreve as referências** (`references`), uma página por chamada, com
   fase e cursor no run. A fase 0 percorre o mapa deste ciclo e reescreve
   cada campo `rewritten` das linhas reidratadas, conferindo que o destino é
   uma das tabelas do campo, mais os recibos e as chamadas cadastrais de cada
   operação, achados pelo ID anterior; acima de 256 de cada por operação
   (`MAP_SIDE_LIMIT`, muito acima do normal: um recibo por tipo e uma
   chamada), para com `ARCHIVE_REFERENCE_SCAN_LIMIT` em vez de deixar uma
   linha com o ID anterior. As fases seguintes leem, pelo índice da
   organização, as linhas quentes que apontam para o arquivo
   (`HOT_REFERENCE_SOURCES`: streams da cerca, auditoria de certificados,
   downloads, exportações, chaves de idempotência, sondas da emissão,
   auditoria e falhas operacionais e eventos Stripe). Toda busca passa pelo
   mapa deste run; um ID já reescrito não está no mapa como anterior, então
   repetir uma página não muda nada. A `captureAudit` gravada em custódia
   não é lida: não tem índice da organização e só aponta para o stream, que
   é cerca.
6. **Move as notas antigas** para o bucket frio, em lotes, quando a camada
   fria está ligada ([etapa fria](#etapa-fria-adr-0010-c2)).
7. **Confere** (`check`), na ordem do catálogo, cada entrada: a linha
   reidratada é reconstruída como estava no pacote (sem o par de origem
   acrescentado neste ciclo, com as referências trocadas pelos IDs anteriores
   pelo mapa inverso e com o `_id` e o `_creationTime` anteriores) e seu
   SHA-256 precisa ser o da entrada (`ARCHIVE_CHECK_MISMATCH`). A versão e o
   original movidos na etapa fria voltam a ter o arquivo no lugar do objeto,
   depois de a chave, o SHA-256 e o tamanho do objeto conferirem com a
   intenção do upload; a nota que ficou fria nesta reidratação volta quente.
   O arquivo é reconstruído com o ID, a criação e o tipo originais e o hash e
   o tamanho do arquivo novo, ou os que `recordUpload` conferiu, quando ele
   foi para o bucket. A cerca precisa continuar quente. Os hashes das linhas
   se encadeiam de novo até o `digest`, e cada arquivo é conferido uma vez.
8. **Termina** (`finish`): o run volta a `hot` com versão nova, e as
   admissões reabrem. Um novo arquivamento abre outro run.
9. **Coleta os órfãos** das tentativas de upload que não chegaram a
   `recordUpload` ([abaixo](#uploads-órfãos)).

Cada passo retoma do progresso gravado no run. Uma resposta perdida é lida
de volta no run, nunca adivinhada: um lote de `rows` ou `check` já aplicado
devolve o deslocamento atual sem gravar de novo. Repetir `finish` não faz
nada; depois dele, a versão antiga é recusada (`ARCHIVE_STALE_FENCE`) e o
executor recusa um run fora de `archived` e `restoring`.

### Etapa fria (ADR 0010, C2)

Com `FNFE_COLD_TIER=enabled`, o bucket configurado e sem retenção legal
ativa, `coldArchiveRehydration:coldPolicy` devolve o corte da janela quente
do plano (o mesmo da varredura da [camada fria](camada-fria.md)) e o último
ano de lock confirmado. O executor aplica às linhas do pacote a regra da
passagem (`coldRehydrationPlan`). Uma nota quente no pacote, recebida, que
entrou antes do corte, sem versão em processamento, com ao menos uma versão
publicada, todo blob verificado e o ano de guarda com lock, tem adiados o
blob das versões e o seu original. As demais notas voltam com os arquivos na
etapa 3. O `begin` grava o corte no run e recusa um plano feito com outra
regra, mais de um dia velho ou com outro ano de lock
(`ARCHIVE_REHYDRATE_COLD_POLICY`).

Depois da reescrita das referências, o run fica na etapa `cold`:

1. O executor manda cada lote (`coldBatch`) pelos IDs anteriores das notas,
   até 16 notas e até o orçamento do lote: 64 MiB, ou `coldBatchMiB` na
   configuração, nunca menos que a maior nota. O servidor reivindica as notas
   que podem passar e lista os arquivos adiados do lote.
2. `coldStep` pede esses arquivos (`upload`), e o executor os envia pelas
   mesmas intenções da etapa 3. Sem espaço no plano, o envio para com
   `QUOTA_EXCEEDED`. `recordUpload` aponta para o arquivo novo as linhas que
   ainda guardavam o ID anterior.
3. Com o lote inteiro no Convex, o servidor agenda a passagem da camada fria
   para cada nota, com o run. O executor espera (`moving`) e consulta de novo
   a cada 2 segundos. Cada objeto é gravado, relido e conferido, e o arquivo
   quente sai na hora. Uma nota que não ficou fria é reivindicada de novo. Na
   quarta tentativa do mesmo lote, o executor para com
   `ARCHIVE_REHYDRATE_COLD_STALLED`; sem resposta em 30 minutos, com
   `ARCHIVE_REHYDRATE_COLD_TIMEOUT`.
4. Com o lote encerrado, vem o seguinte. No fim, o servidor percorre todas as
   notas da organização e move também a que o plano deixou quente e já pode
   passar. A etapa só termina com todos os arquivos do pacote enviados e
   nenhuma nota em `moving` (`ARCHIVE_REHYDRATE_COLD_INCOMPLETE`,
   `ARCHIVE_REHYDRATE_COLD_MOVING`).

A nota que deixa de poder passar no meio da etapa, por uma retenção legal
nova, um ano de lock retirado ou o gate desligado, recebe os arquivos de
volta no quente, e cada envio confere a capacidade. Rodar `rehydrate` de novo
retoma o lote em curso, e repetir um passo não faz nada duas vezes. A saída
traz `cold`, com os arquivos adiados, o maior lote, as notas movidas
(`moved`) e as que ficaram quentes fora da janela (`kept`). O executor nunca
recebe credencial do bucket frio.

### IDs anteriores na REST

Depois do `finish`, as rotas REST que recebem ID de documento, versão,
original, importação, arquivo de lote, operação, emissão ou artefato de
emissão, e o `documentId` de `POST /v1/exports`, procuram primeiro a linha e,
sem ela, o mapa da organização da chave (`currentRow`, em
`lib/coldArchiveCurrent.ts`). A busca segue a cadeia de ciclos (antigo →
novo1 → novo2) até a linha atual, até 32 saltos, e só então a rota confere
acesso, escopo e concessão sobre a linha encontrada. Um ID anterior de outra
organização nunca resolve e recebe `NOT_FOUND`. As respostas e os webhooks
emitidos depois da reativação trazem `originalId`, o `originId` da linha,
só num recurso reidratado. A chave de idempotência continua comparando o ID
como o chamador o enviou; o reprocessamento de um arquivo de lote compara o
artefato pelo primeiro ID. O contrato e o SDK estão em
[SDK.md](../v1.0/SDK.md#ids-depois-da-reativação).

### Uploads órfãos

Uma queda entre o envio de um arquivo e `recordUpload` deixa um arquivo que
nada referencia. `collectUploadOrphans` percorre as tentativas não concluídas
do run. A janela de cada uma vai do começo dela ao começo da tentativa
seguinte do mesmo original, mais um minuto de folga, porque o relógio do
storage e o da mutation não são o mesmo, ou aos 70 minutos sem tentativa
seguinte. Só é
julgada uma hora depois do fim da janela, mais que qualquer fluxo da
plataforma leva entre gravar um arquivo e registrá-lo. Dentro da janela,
apaga só o arquivo com exatamente o hash, o tamanho e o tipo do original, que
nenhuma tabela de `storageHolders` nem outra intenção guarda. Como o
`_storage` é global, a janela também tem uploads de outras organizações: cada
chamada lê uma tentativa e até 256 arquivos da janela (`ORPHAN_SCAN_PAGE`),
guarda na tentativa a posição (o instante `scannedThrough` e os IDs já julgados
nesse instante exato, `scannedIdsAtThrough`, porque vários arquivos podem ter
o mesmo `_creationTime`) e devolve o mesmo cursor
até a janela acabar, e o executor repete até `isDone`. O fim de
`rehydrate` faz uma coleta e informa `orphansPending`, o que ainda é recente
demais. Depois da hora de espera, o operador repete:

```sh
node scripts/cold-archive.mjs orphans plano.json RUN_ID
```

Repetir não apaga mais nada. A coleta de uploads de importação
(`importUpload.cleanup`) não apaga um original guardado por uma intenção da
reidratação, que ainda pode estar esperando a segunda passagem.

### Ordem das listagens

A primeira passagem insere as linhas na ordem do catálogo, que é a ordem de
criação original de cada tabela. Assim, as listagens que ordenam pelo
`_creationTime` implícito do índice (documentos, importações) mantêm a ordem
entre as linhas reidratadas, e elas ficam antes de tudo o que for criado
depois da reativação. As que ordenam por campo de data (`createdAt`,
`listedAt`, `date`) não mudam, porque os campos voltam iguais. A exceção é a
linha fiscal gravada em custódia, que ficou quente com o `_creationTime`
antigo, menor que o das reidratadas: o histórico da captura
(`captures.history`) ordena as linhas lidas pela primeira criação
(`firstCreation`), e ela aparece depois das reidratadas, na ordem em que
aconteceu.
Cursores de paginação emitidos antes do arquivamento não continuam depois
da reidratação.

## Elegibilidade e congelamento

- Organização encerrada: somente `organizationClosures.state=purged`, sem
  expiração fiscal, durante a guarda existente.
- Organização aberta no Gratuito: 90 dias sem atividade. Contam mudanças na
  organização e no plano, o consumo em `usageEvents`, as consultas REST,
  downloads e exports em `capacityEvents` e a leitura de documentos e
  emissões pelo console, na lista ou no detalhe, por qualquer membro ativo;
  login isolado não conta. Depois, o aviso de 30 dias.
- A leitura pelo console vem de uma query, que não grava. Ao receber a lista
  ou o detalhe, o console chama `archiveNotice.markFiscalRead`, que move
  `organizations.updatedAt` no máximo uma vez por dia por organização
  (`FISCAL_READ_WINDOW`); dentro do dia, a chamada só lê. Durante o aviso, a
  marca não o encerra, mas a nova avaliação de elegibilidade recusa o
  congelamento. Em custódia, a marca é recusada com `ORGANIZATION_ARCHIVED`,
  como a própria leitura.
- Organização aberta com plano pago: o aviso de 30 dias começa logo no fim
  do período pago (`endsAt`), sem renovação; atividade não conta. Fica um
  só mês quente depois do período pago, o do aviso (decisão de 29/10/2026).
- Organização aberta que só usou Sandbox, pelo critério de `sandboxOnly`
  (`fiscalGuard.ts`): inelegível, com `ARCHIVE_SANDBOX_ONLY` e sem run, para
  que o expurgo antecipado do encerramento continue a alcançá-la. Depois de
  90 dias sem atividade, a Freecorps a encerra, com aviso de 30 dias
  ([encerramento de organização só com Sandbox](#encerramento-de-organização-só-com-sandbox)).

O run guarda `eligibleAt`, 30 dias depois do aviso; antes dele, `freeze`
recusa com `ARCHIVE_NOTICE_PENDING`. O ensaio real encontrou um limite do
Convex: `import --append` recusa recriar um ID que já foi excluído da mesma
tabela. Por isso a organização aberta volta pela
[reidratação com IDs novos](#reidratação-com-ids-novos), nunca pelos IDs
originais. Desde a PR 6 da ADR 0009, `freeze`, `removeHotBatch` e o executor
aceitam o run dela, atrás de `FNFE_COLD_ARCHIVE`. A remoção confere de novo
a guarda de um run de organização encerrada; o de organização aberta não
relê a elegibilidade, porque, a partir de `frozen`, nada a reabre sozinho.
Nenhuma organização aberta real foi arquivada, então não há economia de banco
ou arquivos a declarar para elas.

## Aviso de organização aberta

`coldArchive:notice` cria o run em `notice` e, na mesma transação, registra
o e-mail do aviso no próprio run (`noticeMail`) e agenda o envio
(`archiveNotice.deliver`). Repetir o `notice` com a mesma chave devolve o
run, sem novo envio. O envio reserva a linha (`pending` → `sending`), lê os
`owner` e `admin` ativos pelo índice do papel e manda uma mensagem por
destinatário pelo canal do e-mail de contas, como o
[aviso dos termos de uso](../plataforma/ORGANIZATIONS.md#termos-de-uso):
fora do desenvolvimento, só os endereços de `ACCOUNT_EMAIL_RECIPIENTS`
recebem (`withheld` conta os outros); no desenvolvimento, o coletor guarda a
mensagem (`mail:inbox`, tipo `archive-notice`). Não há reenvio: `noticeMail`
termina `sent`, `partial`, `unconfirmed` ou `skipped`, com `recipients`,
`confirmed` e `withheld`, e fora de `sent` uma linha `archive_notice_delivery`
vai ao log, sem endereço. Com o e-mail de contas desligado, o run nasce com
`noticeMail.state: "skipped"` e nada é agendado; o aviso do console vale
sozinho.

Duas situações deixam o e-mail sem desfecho. `pending` antigo: o envio
agendado se perdeu antes de reservar a linha; nada saiu. `sending` antigo: a
reserva aconteceu e o fim não foi gravado; as mensagens podem ter saído. Para
conferir, pela CLI do Convex com o alvo conferido
([deploy](deploy-producao.md)):

```sh
bunx convex run archiveNotice:mailStatus '{"before":<epoch em ms de uma hora atrás>}' --deployment <deployment>
```

A resposta lista até 100 runs por estado (`pending` e `sending`) com aviso
criado antes de `before`, com `runId`, `organizationId`, o estado do run,
`noticeAt` e, nos `sending`, `claimedAt`.

- **`pending`:** `bunx convex run archiveNotice:resumePending '{}'
  --deployment <deployment>` agenda de novo o envio dos avisos `pending`
  criados há mais de 60 minutos (`olderThanMinutes` muda o prazo), até 100
  por chamada; repita enquanto `resumed` não for zero. Repetir é seguro: só
  uma reserva vence, então o envio original atrasado e o retomado não mandam
  duas vezes, e um aviso que terminou no meio tempo vira `skipped`.
- **`sending`, `partial` e `unconfirmed`:** nunca são retomados, porque o
  efeito é incerto. O operador confere no Email Sending da conta Cloudflare
  se saíram mensagens com o assunto do aviso perto de `claimedAt`; se não
  saíram, ou não dá para saber, o aviso do console continua valendo, e o
  operador decide avisar pelo suporte, fora da plataforma.

A mensagem diz a organização, a data a partir da qual ela pode ser
congelada (`eligibleAt`, em Brasília), o que o arquivamento faz (param
importação, captura e emissão; os dados fiscais vão para a guarda fria
cifrada; a consulta passa a ser por exportação assistida; a reativação não é
imediata), que a captura de NF-e para e a Receita pode não ter mais parte
dos documentos na volta, e a ação: "Manter ativa" no console, no Gratuito,
ou renovar em Uso e limites, na seção Cobrança, no plano pago.

O aviso termina antes do congelamento de dois jeitos, sempre com o run de
volta a `hot`, `version` nova e `noticeEnded`:

- **Manter ativa** (`archiveNotice.keepActive`), só no Gratuito, por owner
  ou admin ativo. Conta como atividade: atualiza a organização e grava
  `organization.kept-active` na atividade, então os 90 dias recomeçam.
  Repetir sobre o aviso já encerrado não faz nada. Responde
  `ARCHIVE_NOTICE_NOT_FOUND` sem aviso daquela organização,
  `PLAN_RENEWAL_REQUIRED` num aviso de plano pago e `ORGANIZATION_ARCHIVING`
  com o arquivamento em curso.
- **Qualquer novo plano** (`activateCatalogPlan`): renovação por Pix ou
  cartão, adesão ou troca. O aviso termina na mesma transação do plano.

O `freeze` também recarrega a elegibilidade e a versão do plano, então uma
renovação que escapasse disso ainda impediria o congelamento.

## Encerramento de organização só com Sandbox

Uma organização aberta que só teve Sandbox (`sandboxOnly`) não vai para o
arquivo: depois de 90 dias sem atividade, recebe um aviso de 30 dias e, sem
"Manter ativa", a Freecorps a encerra pelo encerramento de sempre, com o
expurgo antecipado do Sandbox (ADR 0009, decisão 2 de 29/10/2026). O aviso
fica em `sandboxClosureNotices`, fora de `coldArchiveRuns`, porque o
expurgo antecipado lê qualquer run como Produção. As funções são internas,
pela CLI do Convex com o alvo conferido ([deploy](deploy-producao.md)), e
exigem `FNFE_COLD_ARCHIVE=enabled`, como o resto do arquivo; não há cron.

```sh
bunx convex run sandboxClosure:notice '{"organizationId":"<id>","key":"<chave-unica>"}' --deployment <deployment>
```

`notice` confere, na mesma transação: organização aberta, sem encerramento,
só com Sandbox, sem plano pago em vigor (`SANDBOX_CLOSURE_PAID_PLAN`: plano
não `free` ainda não terminado, pedido aguardando pagamento ou cartão
renovando) e 90 dias sem atividade, com a atividade do Gratuito acima, em
qualquer plano ou sem plano. Recusa com `SANDBOX_CLOSURE_PRODUCTION`,
`SANDBOX_CLOSURE_CLOSED`, `SANDBOX_CLOSURE_ACTIVE`, `SANDBOX_CLOSURE_NOT_FOUND`
ou `SANDBOX_CLOSURE_NOTICE_EXISTS`, se já há um aviso pendente. É
idempotente pela chave: repetir devolve o mesmo aviso, sem novo envio; a
mesma chave em outra organização recusa com `SANDBOX_CLOSURE_KEY_REUSED`. O
aviso grava `closeAt`, 30 dias depois, e o e-mail único (`noticeMail`), com
as mesmas regras, estados e contagens do
[aviso de organização aberta](#aviso-de-organização-aberta), pelo tipo
`sandbox-closure-notice` no coletor local e pela linha
`sandbox_closure_notice_delivery` no log fora de `sent`. A mensagem diz a
organização, a data, o porquê (só Sandbox, 90 dias sem atividade), que os
dados do Sandbox não têm validade fiscal e são apagados depois dos 30 dias
de exportação, que a conta de cada pessoa continua, e o caminho de "Manter
ativa" no console.

Para o e-mail sem desfecho, o mesmo procedimento, com as funções próprias:
`sandboxClosure:mailStatus '{"before":<epoch em ms>}'` lista os `pending` e
`sending`, e `sandboxClosure:resumePending '{}'` reagenda só os `pending`
antigos; `sending` nunca é retomado.

Passado `closeAt`, o operador lista os avisos vencidos e encerra cada um com
o `noticeId` e a `version` da lista:

```sh
bunx convex run sandboxClosure:due '{"before":<epoch em ms de agora>}' --deployment <deployment>
bunx convex run sandboxClosure:close '{"noticeId":"<id>","version":1}' --deployment <deployment>
```

`close` recusa antes de `closeAt` (`SANDBOX_CLOSURE_NOTICE_PENDING`) e com
`version` antiga (`SANDBOX_CLOSURE_STALE_FENCE`). Na mesma transação,
confere de novo a elegibilidade, agora sem atividade depois do aviso.
Atividade, dado de Produção, plano pago ou um encerramento pelo owner no meio
tempo terminam o aviso como `cancelled`, com `activity`, `production`,
`paid_plan` ou `organization_closed`, e nada é encerrado. Senão, abre o
encerramento pelo mesmo caminho do owner (`requestClosure`), com
`requestedBy` `freecorps:sandbox-inactive`, auditoria
`organization.closure-requested` com o ator `operator:freecorps` e a linha
`organization.closure-sandbox-inactive` no log, só com ids. Repetir `close`
depois que o aviso terminou não faz nada e devolve como ele terminou
(`closed`, `kept_active` ou `cancelled`). Daí em diante valem as janelas e o
expurgo do encerramento, com a remoção antecipada do Sandbox
([RETENTION.md](../plataforma/RETENTION.md#organização-sem-produção-decidido-em-27102026)).

"Manter ativa" (`sandboxClosure.keepActive`), por owner ou admin ativo,
termina o aviso como `kept_active` e conta como atividade
([ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md#organização-só-com-sandbox)).

O congelamento recarrega a elegibilidade e a versão do plano. Na mesma
transação, consulta operações ativas ou incertas, leases, exports, uploads,
capturas e webhooks. Se uma chamada ao fisco está em andamento, mantém
`notice`; o worker ainda pode persistir sua resposta. Só grava `frozen`
quando provou ausência de trabalho admitido. Admissões e escritas devem
ler `assertOrganizationHot` na própria transação, participando da mesma
verificação de concorrência do Convex.

Do congelamento ao fim da reidratação, só passam as ações que a ADR 0009, §2
mantém: revogar chaves, certificados, conexões e acessos, retirar a liberação
da captura, desligar e rotacionar webhooks, remover membros e convites, pedir
o encerramento, ler o que não é fiscal no console e nas quatro rotas REST não
fiscais, e trocar de plano já em `archived` (`allocateOffer` responde
`ORGANIZATION_ARCHIVING` nos outros estados). Elas declaram
`archived: "allowed"` em `requireMembership` ou `authenticateKey`; tudo o mais
continua em `assertOrganizationHot`, e `companyScopeAccess` não tem exceção.
A REST responde `ORGANIZATION_ARCHIVED` com HTTP 409, código próprio do
contrato 8.0.0 (antes era `SCOPE_DENIED` 403). Um encerramento pedido nesse
período espera, no expurgo, o run sair de `deleting` ou `restoring`
(`PURGE_ARCHIVE_WAIT`, uma hora entre conferências). O detalhe está em
[ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md#organização-arquivada) e
[WEBHOOKS.md](../plataforma/WEBHOOKS.md#organização-arquivada).

Os índices de operações permitem qualquer quantidade de histórico
concluído. Os limites conservadores são mil streams por organização e mil
entradas por estado ativo global de upload/webhook. Excedê-los recusa o
congelamento, sem bloquear workers. A varredura posterior do snapshot é
paginada; a resolução das relações recusa registros sem proprietário
demonstrável.

Uma retenção legal ativa impede movimentação para o frio. A guarda fiscal
existente não muda. O horizonte comercial de 72 meses **não é autorização
de exclusão**. Não há GC por idade neste executor; um objeto ainda referido
por catálogo ou backup retido não pode sair, mesmo depois de uma recuperação.

## Execução administrativa

Prepare um arquivo JSON de configuração fora do repositório, sem segredos:

```json
{
  "sourceUrl": "https://deployment.convex.cloud",
  "destinationUrl": "http://127.0.0.1:3260",
  "destinationIsDisposable": true,
  "retentionConfigured": true,
  "accountId": "identificador-da-conta",
  "bucket": "bucket-de-backup",
  "prefix": "deployment/cold/",
  "recipients": ["destinatario-age-custodiante-1", "destinatario-age-custodiante-2"]
}
```

Use os mesmos custodiantes do backup. `retentionConfigured` confirma que o
bucket tem retenção por referências; o lock de cada run é do executor
([abaixo](#prazo-do-pacote-e-lock-no-r2)). O destino
precisa ser um Convex local separado e descartável, com as funções desta
versão, `FNFE_CRONS=off`, `FISCAL_ENV=disabled` e captura fiscal desativada.
O executor verifica esses controles antes do ensaio. Somente esse destino
recebe `import --replace-all`. O executor verifica novamente os controles
imediatamente antes de cada importação destrutiva e recusa origem igual ao
destino. A primeira tentativa real com `--replace` falhou por colisão de
números de tabelas; a troca para `--replace-all` vale exclusivamente para o
destino descartável identificado. Uma admin key separada não substitui a
verificação de URLs, deployment e controles fiscais.

O ambiente do processo fornece `CONVEX_DEPLOY_KEY`,
`COLD_ARCHIVE_DESTINATION_ADMIN_KEY`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` e `R2_LOCK_API_TOKEN`, um token da API Cloudflare com
Workers R2 Storage Edit na conta do bucket, para as regras de lock. A identidade age é um caminho do custodiante;
o programa age a consome. Não copie esses valores para argumentos de chat,
logs ou arquivos versionados. O executor não imprime saída do CLI Convex.
O diretório temporário, fora do checkout, é removido ao terminar.

```sh
node scripts/cold-archive.mjs notice plano.json ORGANIZATION_ID chave-unica-do-aviso
# Depois do prazo persistido, usando o runId devolvido pelo notice:
node scripts/cold-archive.mjs freeze plano.json RUN_ID
node scripts/cold-archive.mjs archive plano.json RUN_ID /caminho/identidade-age
# Retoma ou faz só a compactação do catálogo de um run em archived:
node scripts/cold-archive.mjs compact plano.json RUN_ID /caminho/identidade-age
```

`archive` termina com a [compactação do catálogo](#catálogo-compactado).
`compact` faz só essa etapa e não usa o destino isolado: precisa da origem,
do R2 e da identidade age, e aceita qualquer run em `archived`. Uma falha na
compactação depois de `archived` não reabre nada; repita `compact`:

- **Antes do registro** (`catalog` ausente no run), a compactação começa de
  novo. Um manifesto do catálogo já publicado é reaproveitado se descrever o
  mesmo texto claro; senão, o executor para com "Catálogo publicado diverge do
  banco". Uma cifra publicada sem manifesto é reaproveitada só se decifrar no
  mesmo catálogo; senão, para com "Catálogo órfão no R2 diverge do banco" e
  exige revisão administrativa. Nada é sobrescrito.
- **Depois do registro** (`verified` ou `compacting`), o executor confere o
  manifesto gravado no R2 pelo hash do run e a cifra pelo manifesto, e
  continua os lotes de onde pararam.
- **Comparação divergente**, cifra corrompida, objeto ausente ou contagem
  diferente param antes do registro: nenhuma entrada sai do banco.

`notice` é idempotente pela chave, em organizações encerradas e abertas
elegíveis. `freeze`, `archive` e `restore` aceitam as duas, e `rehydrate`, só
a aberta. O operador dispara `freeze` quando o
prazo termina; esta versão não registra cron. Falha de quiescência exige
resolver a operação pendente e repetir o congelamento.

O executor varre todas as tabelas, conserva hashes no catálogo e reconstrói
o snapshot a partir desse catálogo. Isso permite retomar uma resposta
perdida da varredura. O R2 recebe pacote e manifesto por escrita condicional;
um manifesto existente nunca é sobrescrito. Depois de selado, a retomada
baixa o mesmo pacote. Uma interrupção entre publicar a cifra e publicar o
manifesto deixa um objeto órfão e conserva todos os dados quentes; exige
revisão administrativa, sem apagar automaticamente o objeto.

A prova importa o pacote no destino isolado e reexporta banco e storage.
Compara cada registro, ID, metadado e byte original antes de gravar a prova
interna. A prova vale 24 horas para a remoção; depois disso o executor precisa
refazer o ensaio. Os lotes verificam novamente versão, prova, retenção legal
e hashes dos registros, salvo os da cerca, que não saem
([cerca](#a-cerca-de-numeração-e-captura)). Arquivos saem antes das linhas fiscais; referências
de outra organização, referência desconhecida ou mais de mil referências
ao mesmo arquivo impedem a remoção. Cada lote altera storage, banco e
contabilidade de capacidade na mesma transação.

### Prazo do pacote e lock no R2

O R2 não tem retenção por objeto, só regras de lock por prefixo, e no máximo
1.000 por bucket. Cada run tem a sua, `fnfe-cold-<runId>`, no prefixo
`<prefix><runId>/`, que guarda pacote, manifesto, catálogo e manifesto do
catálogo. A condição é uma data: a primeira meia-noite UTC depois do
`retainUntil`. Enquanto vale, sobrescrever ou apagar esses objetos responde
HTTP 409.

`archive` e `compact` criam ou conferem a regra antes de escrever qualquer
objeto, com a data do `retainUntil` do run. A API da Cloudflare só troca o
conjunto inteiro de regras: o executor relê as regras, mantém as outras como
estavam, grava e relê de novo. Ele recusa uma regra do run com outro prefixo
ou com condição de idade, nunca troca uma regra indefinida por uma data e
para no limite de 1.000. Um único operador por vez: dois escritores
simultâneos podem perder uma regra do outro.

Enquanto a organização aberta segue arquivada (ADR 0009, §2, "Prazo do
pacote"), o operador renova:

```sh
# Runs com pacote cujo prazo termina nos próximos N dias:
node scripts/cold-archive.mjs due plano.json 400
node scripts/cold-archive.mjs renew plano.json RUN_ID
```

`renew` pede ao servidor o prazo de hoje (`coldArchive:retention`): a guarda
contada da data atual, ou do encerramento, se a organização foi encerrada
depois do arquivamento. Primeiro estende a regra no R2, depois grava o novo
`retainUntil` no run (`coldArchive:renewRetention`); o run nunca promete uma
data que o R2 ainda não garante. Só estende, é idempotente, e uma retenção
legal não o impede. Como a guarda conta por ano civil, o prazo só anda na
virada do ano: rode `due` e `renew` ao menos uma vez por ano para cada run
arquivado. Os manifestos continuam com a data do selo; o catálogo compactado
depois de uma renovação também leva essa data.

Um run sem pacote recusa com `ARCHIVE_NOT_SEALED`, e um run já reidratado,
com `ARCHIVE_ORGANIZATION_HOT`: depois de `hot` a regra fica na última data e
o pacote vence nela, sem ser apagado antes. Retirar a regra exige uma
credencial com Workers R2 Storage Edit; o lock não é WORM de conformidade, e
a proteção depende de quem guarda esse token.

## Recuperação isolada e exportação assistida

```sh
node scripts/cold-archive.mjs restore plano.json RUN_ID /caminho/identidade-age
```

A restauração isolada é a base da exportação assistida (ADR 0009, §7). Ela
serve a organizações encerradas e abertas e não reativa nenhuma delas. A
organização aberta volta à origem só pela
[reidratação](#reidratação-com-ids-novos), que não usa importação.

O run precisa ter pacote selado: aceita os estados `sealed`, `verified`,
`deleting`, `archived` e `restoring`. Em `notice` e `frozen` recusa com
`ARCHIVE_NOT_SEALED`. Os dados ainda estão quentes, e quem faz o pacote é
`archive`, nunca `restore`. Num run de organização aberta que já voltou a
`hot`, recusa com `ARCHIVE_ORGANIZATION_HOT` antes de ler o R2; nesse caso a
exportação normal ([EXPORTS.md](../plataforma/EXPORTS.md)) vale. Um pacote de
outra versão do schema fiscal recusa com `ARCHIVE_SCHEMA_MIGRATION_REQUIRED`,
porque ainda não há migração de pacote.

O comando baixa e decifra o pacote, importa no destino isolado com
`--replace-all`, reexporta e compara IDs, registros, metadados e bytes.
Num run com catálogo compactado, antes de importar, baixa o manifesto do
catálogo, confere seu hash com o do run e o do pacote com o manifesto do
catálogo, baixa e decifra o objeto e confere que cada linha e cada metadado
de storage do pacote têm sua entrada, com a mesma tabela e o mesmo hash, e que
nenhuma entrada fica sem linha. Catálogo ausente, manifesto diferente do
registrado ou pacote que não confere com o catálogo interrompem a
restauração.

Não importa na origem nem altera seu estado. Também não grava no R2, não
registra prova e não usa a cerca de versão do run. Por isso pode ser
repetida, e uma interrupção se resolve rodando de novo, sem retomada. Pode
correr durante o arquivamento ou a reidratação do mesmo run sem interferir.
Não reabre uma organização encerrada. A função interna `beginRestore` recusa
com `ARCHIVE_SAME_ORIGIN_RESTORE_UNSUPPORTED`.

O destino recebe o pacote como ele foi selado, só com as linhas e os
originais daquela organização:

- **Primeiro ciclo:** os IDs são os originais.
- **Ciclo seguinte**, depois de uma reativação: os IDs são os do ciclo
  anterior, e cada linha reidratada traz o primeiro ID e a primeira criação
  (`originId`, `originCreationTime`). O recibo conta essas linhas em
  `rehydratedRows`. O mapa de IDs não vai ao destino: os IDs intermediários
  resolvem na origem, pelo mapa quente e pelas rotas REST.
- **Cerca** (`dpsSequences`, `captureStreams`): vai como a varredura a leu,
  não como está agora na origem.
- **Linha fiscal gravada em custódia depois da varredura**, como a
  `captureAudit` da retirada da liberação: não está no pacote e continua
  quente na origem. A exportação do cliente não inclui auditorias.

O recibo, em JSON, traz `reason`, o estado do run (`runState`), linhas,
arquivos, `rehydratedRows` e o hash do manifesto, sem nenhum dado fiscal.

O destino tem o pacote em JSONL do Convex e os originais. Esse conteúdo não
sai da Freecorps: o cliente recebe a exportação assistida, abaixo. Cada
restauração custa uma execução isolada que o aporte não financia.

### Exportação assistida

Pelas decisões de 30/10/2026 da ADR 0009, o cliente recebe a mesma exportação
de [EXPORTS.md](../plataforma/EXPORTS.md), só com os documentos fiscais da
organização, pelo mesmo download com ticket e prazo de 24 horas. Nunca por
anexo de e-mail. O pedido chega pelo suporte; o console não tem botão.

O suporte grava o pedido num JSON fora do repositório:

```json
{
  "key": "chamado-do-suporte",
  "email": "conta-que-pediu@exemplo.invalid",
  "basis": "owner",
  "environments": ["production"]
}
```

`key` é o chamado e torna o pedido idempotente. `email` é o da conta de onde
o pedido veio, não um endereço digitado no chamado. `basis` é `owner` ou,
para atender um pedido de titular encaminhado ao cliente
([RIGHTS.md](../plataforma/RIGHTS.md#como-atender)), `rights`, com
`rightsReference`, a referência do registro restrito. `environments` lista
os ambientes, como no diálogo do console; cada um vira uma exportação.

```sh
node scripts/cold-archive.mjs export plano.json RUN_ID /caminho/identidade-age pedido.json
```

O comando segue esta ordem:

1. **Pedido na origem** (`assistedExport:request`), antes de baixar qualquer
   coisa do R2. Recusa com `ASSISTED_EXPORT_NOT_OWNER` se a conta do e-mail
   não tem e-mail verificado ou não é Proprietário ativo da organização do
   run. Recusa com `ASSISTED_EXPORT_RATE_LIMITED`, e o instante `retryAt`, se
   houve outro pedido `owner` da organização nos últimos 30 dias. O pedido
   `rights` não conta nem é limitado. Repetir o chamado com o mesmo conteúdo
   devolve o mesmo pedido, mesmo dentro dos 30 dias; outro conteúdo recusa
   com `IDEMPOTENCY_CONFLICT`. O run precisa estar entre `sealed` e
   `restoring`, como na restauração isolada, e o pedido fica em
   `assistedExports`.
2. **Restauração isolada** (`restore`), sem mudança.
3. **Exportação da origem** (`assistedExport:prepare`): uma exportação da
   organização em nome do Proprietário, em `running`, com o prazo de 24
   horas contado daqui. Ela aparece em Exportações no console, mas nenhum
   worker roda na origem. A preparação devolve também as empresas da
   organização e se a origem serve o ambiente a cada uma, porque o pacote só
   leva a classe `fiscal`.
4. **Geração no destino** (`assistedExport:generate` e
   `exportWorker:run`): o mesmo gerador da exportação normal, com a mesma
   organização, ambiente, corte e prazo, e o ID da exportação da origem no
   manifesto. O comando conduz cada etapa; o destino não usa Workpool,
   capacidade nem auditoria. A geração recusa com
   `ASSISTED_EXPORT_NOT_ISOLATED` onde a organização existe ou sem
   `FNFE_CRONS=off`, `FISCAL_ENV=disabled` e captura desligada.
5. **Publicação na origem**: cada parte é baixada do destino em loopback,
   conferida por SHA-256 e tamanho, enviada a uma URL de upload da origem com
   o MIME privado das partes e anexada (`assistedExport:attachPart`) na ordem
   da sequência. A origem confere de novo o hash, o tamanho e o MIME
   gravados, que o arquivo é novo e que nenhuma parte o guarda. Se não
   conferir, apaga o arquivo e não anexa. A última parte põe a exportação em
   `succeeded`.

O suporte avisa o Proprietário, pelo canal do pedido, que a exportação está
em Exportações; ele baixa pelo ticket normal. Com a organização arquivada,
`exports.list`, `exports.environments`, as partes e o ticket da exportação
assistida passam; qualquer outra exportação, inclusive uma feita antes do
congelamento, continua recusada com `ORGANIZATION_ARCHIVED`. A Freecorps paga
a exportação assistida: as partes e o download não entram na capacidade nem
na cota da organização.

Repetir o comando é seguro. O mesmo chamado devolve o mesmo pedido; uma
exportação já publicada não é gerada de novo; o job do destino e as partes
já anexadas são reaproveitados. Se o destino foi perdido depois de algumas
partes anexadas, o comando falha a exportação parcial da origem
(`ASSISTED_EXPORT_RESTARTED`) e recomeça outra, porque as partes de duas
gerações não se misturam. Depois das 24 horas de uma exportação publicada, o
mesmo pedido recusa com `ASSISTED_EXPORT_DELIVERED`: é preciso outro pedido,
sujeito ao limite. O executor imprime só o recibo, com o pedido, o ID e o
número de partes de cada exportação. Numa recusa do servidor, ou de uma
verificação do próprio executor com código `ARCHIVE_*`, como
`ARCHIVE_ORGANIZATION_HOT`, imprime só o código.

**Depois da entrega, apague o destino isolado**, como em
[restauração](restauracao.md#exportação-assistida-e-destino-isolado). O
comando não o apaga.

O CLI real recusou `--append` na origem após a exclusão com a mensagem
sanitizada: `Cannot recreate document with _id [synthetic-id] that was deleted`.
O recibo do bloqueio
registra essa falha. Não use `--replace` na origem, não troque IDs e não
interprete a importação isolada como prova de reativação comercial.

Os verificadores internos de estado legado continuam conferindo hashes e
fences; não são um mecanismo de ressurreição. Os testes que montam esse estado
sinteticamente não provam restauração same-origin. O console/API deve mostrar
estado explícito para dados arquivados e orientar atendimento, sem anunciar
retomada imediata.

## Backup e recuperação da plataforma

O backup incremental inclui `coldArchives`, com o corpo e hash dos
manifestos frios do snapshot. Antes de publicar ou recuperar um backup,
confere o manifesto remoto e percorre a cifra para verificar seu hash e
tamanho. Catálogo sem manifesto, objeto ausente ou cifra alterada interrompe
o backup. Durante `deleting` ou `restoring`, o backup também recusa: não
publica um snapshot de uma movimentação parcial. Num run com catálogo
compactado ou em compactação, a referência leva também o hash do manifesto
do catálogo (`catalogSha256`), e o backup confere o manifesto do catálogo no
R2 e percorre a cifra dele como a do pacote. O snapshot de um run em
`compacting` tem só parte das entradas; o resto está no objeto conferido.

A recuperação da plataforma preserva o catálogo e o estado arquivado;
organizações encerradas têm recuperação somente isolada. Uma organização
aberta arquivada volta arquivada e pode ser reidratada a partir do
deployment restaurado, se ele passar a ser a origem. Os casos de um snapshot
anterior a uma reidratação ou feito no meio de um arquivamento estão em
[Restauração operacional](restauracao.md#arquivo-econômico-na-restauração).
Os pacotes frios são dependências permanentes do backup. O formato 1 recusa
organizações já arquivadas: use o formato incremental 2.

Rotação de custódia precisa considerar todos os pacotes e catálogos
compactados referenciados, inclusive cópias históricas: depois da
compactação, o catálogo só existe no objeto cifrado. Não aplique o lifecycle dos
snapshots de 14 dias ao prefixo `cold/`. A política de coleta precisa provar
ausência de referência no banco, catálogo e todos os backups retidos,
além de conferir guarda e retenções legais.

### Documentos frios no pacote

Desde a fase C da [ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md)
([camada-fria.md](camada-fria.md)), o conteúdo de uma nota antiga pode estar
no bucket da camada fria, fora do Convex. O pacote leva a linha da versão,
com a chave, o SHA-256 e o tamanho do objeto, mas não copia o objeto
(decisão 6 da ADR 0010). O mesmo vale para o XML original de uma nota fria
(`documentArtifacts`, decisão 8), que entra na mesma lista.

- **Selagem:** o executor lê a configuração `coldBucket`, relê cada objeto
  frio e confere o SHA-256. Grava a lista imutável
  `<prefixo>cold/<runId>/cold-documents.txt` antes do manifesto, e o
  manifesto leva `coldDocuments` (bucket, contagem e SHA-256 da lista).
  Objeto ausente ou alterado impede a selagem.
- **Backup:** confere a lista pelo hash do manifesto e cada objeto no bucket
  frio, por HEAD na publicação e pelo SHA-256 na recuperação. A coleta de
  objetos do backup não lê o bucket frio.
- **Reidratação:** recria a versão e o original com a mesma chave; o objeto
  não volta ao Convex. Uma nota que estava quente no pacote e saiu da janela
  vai para o bucket na [etapa fria](#etapa-fria-adr-0010-c2), com a chave do
  ID novo.

Uma nota ainda em passagem (`moving`) impede o aviso e o congelamento
(`ARCHIVE_COLD_TIER_MOVING`). Antes de selar, o executor estende o lock das
notas frias de Produção até o `retainUntil` do pacote. Ele grava uma regra por
organização e ano de guarda (`archive-<runId>-<ano>`) com `CLOUDFLARE_API_TOKEN`,
e só sela depois de reler as regras ([lock da camada fria](camada-fria.md#lock)).

## Provas e limites da entrega

`tests/platform.coldArchive.test.ts` cobre autorização, isolamento, versão,
aviso, operações incertas, proibição de excluir antes da prova, retenção
legal, prova vencida, arquivos compartilhados e remoção idempotente. Cobre
também a cerca: as linhas e a cópia da varredura no pacote mesmo depois de
uma escrita em custódia, a remoção retomada em lotes até `archived` sem
apagar a cerca nem o inventário dela e a `captureAudit` gravada depois da
varredura, que continua quente. E cobre a compactação do catálogo: recusa
antes de `archived` e antes do registro, versão antiga, manifesto
divergente ou trocado, lotes retomáveis até `compacted` com a cerca quente,
contagem a mais ou a menos, retenção legal e os diagnósticos antigos
recusados num run compactado.
`tests/platform.archiveNotice.test.ts` cobre a elegibilidade das organizações
abertas, o e-mail único a owners e admins e sua retomada pelo operador, "manter ativa" com os papéis
recusados e outra organização, o fim do aviso na renovação, o congelamento
só depois dos 30 dias do aviso e a leitura fiscal no console durante o aviso,
que faz o congelamento recusar (`ARCHIVE_FREE_ACTIVE`).
`tests/platform.coldArchiveRehydration.test.ts` roda o executor de
`scripts/lib/cold-archive.mjs` contra as funções reais em `convex-test`, com
o R2 em memória e o age trocado por cópia: arquiva uma organização aberta
(congelamento, varredura, selo, prova, remoção e compactação) e a reidrata,
conferindo cada linha com ID novo, par de origem e o mesmo conteúdo, as
referências reescritas (uma à frente, arquivos, filhos e linhas quentes de
outras classes), a cerca com o mesmo ID, os bytes dos originais, o mapa e o
inventário. Cobre a queda no meio das linhas e a retomada, a resposta perdida
de `rows` e `check`, a repetição de cada passo e a recusa depois de `hot`,
duas organizações sem vazamento (linha e arquivo da outra recusados, a outra
continua arquivada e intocada e os IDs de uma não resolvem na outra), o
órfão de um upload interrompido, coletado só depois da espera e sem tocar o
arquivo igual guardado por outra organização, a conferência canônica que
para com uma linha alterada, a admissão (plano pago vencido, capacidade com
o plano que comporta, organização com encerramento) e a cobertura das
referências reescritas pelas fontes quentes. Cobre também a restauração
isolada de organização aberta (`restoreIsolated`), com uma fonte que registra
cada mutation e não recebe nenhuma. O teste restaura em `archived`, de novo
com o mesmo resultado, e em `restoring`, no meio de uma reidratação, que
depois termina em `hot`. Em `hot`, a restauração recusa antes de ler o R2. A
outra organização continua intocada e restaura só o próprio pacote. Num
segundo ciclo, depois da reativação, o pacote traz os IDs do primeiro ciclo
com `originId`, e o mapa continua na origem. A etapa fria da ADR 0010, C2,
roda no mesmo arquivo com o bucket frio em memória atrás de `fetch`. O teste
cobre a nota da janela quente, a nota antiga que vai fria com o resíduo
inteiro, a nota já fria no pacote intocada, a listagem, a deduplicação e a
leitura byte a byte do conteúdo e do original nas duas camadas. Cobre
também a admissão dos arquivos quentes mais um lote, com a recusa de um byte
a menos, e a nota de Produção sem ano de lock, que volta quente e entra quente
na admissão. Sem gate ou com retenção legal antes da reidratação, tudo volta
quente. A retenção criada no meio da etapa devolve os arquivos ao quente e
para com `QUOTA_EXCEEDED` sem passar do plano. A passagem do servidor move o
que o plano deixou quente. O teste repete a queda no meio de um lote, o
bucket que falha uma vez ou sempre, cada passo enviado duas vezes e a
conferência que para quando a versão fria diverge do que a passagem gravou.
`scripts/cold-archive.test.ts` confere o plano do executor contra a regra do
servidor e a ordem dos lotes.
`tests/platform.coldArchiveIds.test.ts` importa um documento pelas rotas e
simula no banco um ou dois ciclos como a reidratação os deixa: cobre o ID
anterior resolvido nas rotas de documento, versão, original, importação e
operação, com `originalId` presente só depois da reidratação, a cadeia de
dois ciclos a partir do primeiro ID e do intermediário, o ID anterior de
outra organização recusado com `NOT_FOUND`, a repetição idempotente do
reprocessamento com o ID antigo e a exportação pelo ID antigo, e
`resource.originalId` no webhook, aceito por `verifyWebhook`.
`tests/platform.assistedExport.test.ts` cobre a exportação assistida. Gera a
exportação da organização no mesmo banco depois de apagar toda tabela fora da
classe `fiscal`, como o destino a recebe, e confere que as partes têm os
mesmos bytes e hashes da exportação normal da organização ainda quente, que só
há os tipos de registro de EXPORTS.md e nenhum campo interno (IDs de storage,
`_creationTime`, `originId`, hashes de controle, `checkpoint`, IDs de
membro ou projeto) e que a geração recusa onde a organização existe. Cobre a
recusa de admin, viewer, conta sem membro e membro removido, a repetição do
mesmo chamado, o conflito, o limite de 30 dias até o último milissegundo e a
exceção de titular. Cobre também a publicação com a organização arquivada:
partes com outros bytes ou outro hash recusadas e apagadas, a repetição sem
parte dobrada, o download do Proprietário pelo ticket normal, a recusa da
exportação feita antes do arquivo e de outro membro, o pedido já entregue e o
recomeço depois de um destino perdido. Em `scripts/cold-archive.test.ts`, o
executor recusa o pedido antes de restaurar, para numa parte que mudou entre
o destino e a origem, não gera de novo uma exportação publicada e recomeça a
da origem com um destino novo.
`tests/platform.sandboxClosure.test.ts` cobre o encerramento de organização
só com Sandbox: a elegibilidade com as recusas, o aviso idempotente e seu
e-mail único, "manter ativa" com os papéis recusados e outra organização, o
encerramento recusado antes do prazo, feito uma vez depois dele e seguido do
expurgo antecipado, e o cancelamento por atividade ou por dado de Produção.
`scripts/cold-archive.test.ts` usa age real quando instalado e uma fixture
XML, compara ZIP/JSONL/metadados/bytes e recusa corrupção, inclusive a
restauração sem as linhas da cerca. Na compactação do catálogo, com age real
e o R2 simulado, cobre o objeto e o manifesto publicados, a recusa de
sobrescrever, a cifra órfã reaproveitada só quando é o mesmo catálogo, a
comparação que recusa catálogo corrompido, ausente, curto ou alterado sem
apagar nada, a remoção retomada depois de uma interrupção, a restauração
isolada de um run compactado e a recusa com catálogo ausente, registrado
com outro hash ou que não confere com o pacote, além do catálogo como
dependência do backup. Na reidratação, com age real, decifra pacote e
catálogo, envia o original com seu tipo, manda as linhas na ordem do catálogo
uma vez só, mesmo depois de uma resposta perdida, e confere todas as
entradas; recusa um run encerrado ou fora de `archived` e `restoring` antes
de ler o R2. Na restauração isolada, com age real, restaura um run compactado
de organização aberta em `archived` e em `restoring` duas vezes, com o mesmo
recibo, sem gravar na origem nem no R2. Recusa custódia divergente antes de
importar e, para organizações encerradas e abertas, recusa `notice` e
`frozen` (`ARCHIVE_NOT_SEALED`) e `hot` (`ARCHIVE_ORGANIZATION_HOT`) sem
chamar mutation. Seu adaptador de restauração é local em arquivos; **não comprova
o import do Convex**, e o envio real a uma URL de upload do Convex não foi
exercitado.

O ensaio da #691, em 02/11/2026, rodou o
ciclo de uma organização aberta sintética contra um Convex de nuvem
descartável, um destino local isolado e um bucket de ensaio no R2:
congelamento, arquivamento interrompido e retomado, lock recusando
sobrescrita e exclusão, renovação e extensão da regra, restauração isolada
pelos dois custodiantes, exportação assistida publicada por upload real,
reidratação interrompida e retomada até `hot` e os IDs antigos no mapa.
Limites: uma só cópia, identidades age sintéticas, renovação real só como
no-op (o prazo só anda na virada do ano) e volume pequeno.

O ensaio real local importou e reexportou 86 registros fiscais e três arquivos
com os IDs originais, metadados e bytes. O
recibo dessa etapa
mostra também a falha posterior do incremental por serialização `uniform`.
Esse ensaio anterior ao bloqueio removeu dados de uma fixture aberta sintética;
a tentativa de devolvê-los à origem revelou o tombstone. Não é prova de um
fluxo comercial aprovado. A fixture permanece preservada no destino local.

O incremental real aprovado
comparou 165 tabelas, três arquivos e 993 bytes após import/reexport no destino 3252. Os três IDs reutilizam dois objetos por hash. A segunda cópia reutilizou
os três arquivos. A importação validou `phase=0`, `ready=false`, reservas de
18 MiB de arquivos e 16 MiB de banco preservadas e export em `expired`.
Antes de substituir o destino, o runner verificou 89 entradas contra o catálogo
da origem e conservou o ZIP completo de 91.998 bytes e sua cifra fora do Git.
Ambas as identidades age sintéticas decifraram os mesmos bytes.

O runner `scripts/prove-cold-archive-local.mjs` exige o caminho do destino e
portas explícitas. Não possui caminho de máquina padrão:

```sh
bun run archive:prove-local CAMINHO_DO_WORKTREE_DESCARTAVEL --source-port 3250 --destination-port 3252
```

Ele exporta o destino completo e verifica cada byte de storage e os hashes
do catálogo da fixture na origem antes de qualquer escrita. Conserva o ZIP,
a cifra e duas identidades sintéticas fora do Git, mesmo em falha. Só depois
pode importar o incremental com `--replace-all` no destino. O incremental é
feito dos dados preservados desse destino; a origem fica somente leitura.
Os recibos agregados ficam em `docs/v1.0/evidence/429/restore/`. Diagnósticos
completos e a localização privada da recuperação ficam no temporário do
sistema, fora do Git. O runner imprime apenas código e fase de falha.
Não remova o destino ou o material de recuperação sem concluir sua custódia.

A comparação exclui apenas o localizador transitório `internalId` que o
export acrescenta a `_storage/documents.jsonl`. Não exclui `_id`,
`_creationTime`, hash, tamanho, MIME nem campos homônimos de tabelas fiscais.
O incremental preserva tokens `uniform` de int64 e float64, inclusive valores
aninhados, e modifica apenas estado de exports e inventário de capacidade.

Esse runner não exercita R2 real, lock, lifecycle, RTO nem restauração de 2 GiB.
Não há economia medida em produção; o gate permanece desligado. Novos tipos
Convex binários/int64 no schema fiscal do pacote frio são recusados até
incorporar seu `generated_schema.jsonl`; o schema fiscal atual usa JSON.
