# Camada fria dos documentos

Este guia descreve a passagem do conteúdo das notas para a camada fria da
[ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md), fase C1
([#689](https://github.com/freecorps/freecorpsNFE/issues/689)). **A passagem
está ligada em produção** (`elated-possum-295`) desde 02/11/2026, por
autorização do dono registrada na #689, com o bucket
`freecorpsnfe-cold-documents` e regras de lock até 2033. A extensão anual das
regras está na [#739](https://github.com/freecorps/freecorpsNFE/issues/739). As provas em caminho real
(passagem, leitura, backup, expurgo e reidratação só da janela) estão em
docs/v1.0/evidence/689.

## O que a passagem faz

Uma nota fica quente por 3 meses no Gratuito e por 12 meses em qualquer outro
plano, inclusive o personalizado e a organização sem plano. A contagem começa
na entrada da nota na plataforma (`fiscalDocuments.createdAt`), e vale o plano
em vigor no momento da varredura. Passado esse prazo, o blob de cada versão
publicada (o gzip da fase B) vai, byte a byte, para o bucket da camada fria e
sai do armazenamento de arquivos do Convex.

Ficam no banco a linha da nota, a listagem, o cartão e a chave de
deduplicação. A listagem do console e da REST continua igual. O detalhe, os
itens, as versões e os eventos são lidos do bucket, e o SHA-256 do conteúdo é
conferido em toda leitura. Um objeto ausente ou divergente responde
`UNAVAILABLE` (503), e a leitura nunca cai para outra cópia.

Uma nota não passa enquanto:

- a organização tem um run da ADR 0009 em qualquer estado diferente de
  `hot`;
- a organização tem uma retenção legal ativa;
- a nota tem uma versão em processamento (`staging`), uma versão publicada sem
  blob, ou um blob ainda não verificado pela auditoria da B7.

Nesses casos, a nota fica quente e a varredura seguinte confere de novo.

## O XML original

O XML original da nota vai junto para o bucket (ADR 0010, item 8 da seção
Decisão). Depois das versões, a action grava cada original da nota como o
gzip dos bytes do XML, sempre os mesmos bytes para o mesmo original, relê o
objeto, compara o hash e só então aponta o artefato para ele
(`documentArtifacts.objectKey`). A chave segue o lock das versões:

- `documents/production/guard-<ano>/<organização>/<artefato>/original-<sha256>.gz`
  para Produção;
- `documents/sandbox/<organização>/<artefato>/original-<sha256>.gz` para
  Sandbox.

O `<sha256>` é o do XML, o mesmo de `documentArtifacts.sha256`. O ano de
guarda é o maior entre as versões que leem o original. O artefato frio guarda
também o SHA-256 e o tamanho do objeto (`objectSha256` e `objectSize`) e fica
sem `storageId`: o original está em exatamente um lugar. O arquivo do import
deixa de apontar para o mesmo arquivo, e o arquivo quente sai uma hora depois,
como o das versões.

Vai para o bucket só o original que é da nota: o artefato de uma versão da
nota, cujo `documentId` é a própria nota, que nenhuma versão de outro
documento lê e cujo arquivo nenhuma outra linha segura. O lote de NFS-e e as
suas entradas, que dividem o arquivo do lote, ficam quentes, assim como
qualquer original compartilhado. Esses não impedem a nota de ficar fria.

A nota só fica `cold` quando todas as versões publicadas e todos os seus
originais estão no bucket. Um original cujo ano de guarda ainda não tem regra
de lock confirmada fica quente, e a nota continua em `moving` até a varredura
que o move.

Quando a nota fica fria, o PDF guardado do DANFE sai (a linha na hora, o
arquivo uma hora depois). O próximo download gera o DANFE de novo a partir do
original no bucket. Uma recusa guardada do gerador fica.

A leitura do original passa por `lib/documentOriginalRead.ts`, que confere o
SHA-256 e o tamanho do objeto, descompacta e confere o SHA-256 e o tamanho do
XML. Um objeto ausente ou divergente responde `UNAVAILABLE` (503), e a leitura
nunca cai para outra cópia. Leem por esse caminho:

- o download do original pela REST
  (`/v1/document-artifacts/{id}/original`) e pelo ticket do console, com os
  mesmos bytes e cabeçalhos da nota quente; o consumo de download conta o
  tamanho do XML, como antes;
- a geração do DANFE;
- a exportação, que leva o original no registro `original`;
- o worker de projeção fiscal e o reprocessamento (`importWorker`), em que um
  objeto indisponível vira falha temporária, repetida, e não original perdido.

A listagem de arquivos do documento mostra o original frio como disponível.
As notas que ficaram frias antes desta mudança mantêm o original quente; uma
nota assim volta à passagem se for posta em `moving` com `coldClaimedAt: 0`.
Em 02/11/2026 não havia nota fria em produção.

## Configuração

| Variável                         | Valor                                                     |
| -------------------------------- | --------------------------------------------------------- |
| `FNFE_COLD_TIER`                 | `enabled` liga a passagem; qualquer outro valor a desliga |
| `FNFE_COLD_R2_ENDPOINT`          | `https://<conta>.r2.cloudflarestorage.com`                |
| `FNFE_COLD_R2_BUCKET`            | O bucket próprio da camada fria, sem outro conteúdo       |
| `FNFE_COLD_R2_ACCESS_KEY_ID`     | Token S3 com leitura e escrita restritas a esse bucket    |
| `FNFE_COLD_R2_SECRET_ACCESS_KEY` | Segredo do mesmo token, guardado no cofre                 |
| `FNFE_COLD_LOCKED_THROUGH`       | Último ano de guarda com regra de lock confirmada         |

As quatro variáveis do bucket vão juntas: com só parte delas, a leitura de
uma nota fria falha com erro de configuração. Sem `FNFE_COLD_TIER=enabled` e
sem o bucket, a passagem não roda.

## Como a passagem roda

Não há cron registrado, porque o smoke da publicação exige zero crons. Depois
de ligar o gate, o operador inicia a primeira varredura:

```sh
cd platform
npx convex run coldTier:start
```

A resposta é `started`, `running` (já há uma varredura em curso) ou `disabled`
(gate desligado ou bucket sem configuração). Cada varredura que termina agenda
a seguinte para um dia depois. Rodar `start` à mão cancela a próxima varredura
agendada, e assim só existe uma cadeia.

Cada passo lê 16 notas, e há um minuto entre os passos. Para cada nota
elegível, o passo agenda uma action, com 2 segundos entre elas. A action
grava o objeto, relê do bucket, compara os bytes e só então aponta a versão
para o objeto (`documentVersions.contentObjectKey`). O arquivo quente sai uma
hora depois, para os leitores que já tinham selecionado a versão.

Uma falha devolve a nota ao estado anterior. Se uma versão da nota já tiver
passado, a nota fica em `moving` e a próxima varredura retoma depois de 6
horas. Uma organização com nota em `moving` não recebe aviso nem é congelada
pela ADR 0009 (`ARCHIVE_COLD_TIER_MOVING`). Com notas só `cold`, ela é
arquivada como qualquer outra: o pacote referencia os objetos frios pelo hash
([arquivo econômico](arquivo-economico.md#documentos-frios-no-pacote)).

O estado da varredura fica em `coldTierSweeps`, com contagens por motivo
(`claimed`, `hotWindow`, `archive`, `legalHold`). Uma nota reclamada que não
está pronta (versão em processamento, sem blob ou com blob não verificado) é
devolvida pela action, que registra o motivo no log da função; a varredura
seguinte a lê de novo.

## Desligar

Remova `FNFE_COLD_TIER` ou troque o valor por outro diferente de `enabled`.
Os passos e as actions já agendados conferem o gate e não fazem nada, e a
cadeia de varreduras termina. As notas que já estão frias continuam sendo
lidas do bucket enquanto as quatro variáveis do bucket existirem. **Não remova
as credenciais do bucket com notas frias**: elas ficariam indisponíveis.

## Expurgo

Quando a guarda fiscal expurga uma versão fria ou um original frio, ela grava
o objeto em `coldObjectDeletions`, na mesma transação. A próxima varredura agenda
`coldTierWorker:collect`, que apaga esses objetos do bucket.

## Backup

Os objetos frios ficam fora do export do Convex. Cada versão fria guarda no
banco a chave, o SHA-256 e o tamanho do objeto (`contentObjectSha256` e
`contentObjectSize`), e cada original frio, os campos `objectKey`,
`objectSha256` e `objectSize` de `documentArtifacts`. O banco cifrado vai no
snapshot. O backup e o pacote da ADR 0009 reconhecem os originais frios por
esses campos na [#740](https://github.com/freecorps/freecorpsNFE/pull/740). O manifesto do
formato 2 amarra a lista ordenada desses objetos em `coldDocuments`, com o
bucket, a contagem e um digest
([backup.md](backup.md#documentos-frios-da-adr-0010)).

Antes de ligar o gate:

1. Acrescente `"coldTier": { "bucket": "<bucket frio>" }` em
   `deploy/offsite-backup.json`. Sem isso, o snapshot com nota fria falha.
2. Crie um token R2 **Object Read only** restrito ao bucket frio e grave-o
   nos secrets `R2_COLD_READ_ACCESS_KEY_ID` e `R2_COLD_READ_SECRET_ACCESS_KEY`
   dos environments `offsite-backup` e `offsite-backup-issuance`. O snapshot e
   a conferência leem o bucket frio só com ele; o token de escrita do backup
   não ganha acesso ao bucket frio. Sem esses secrets, o backup usa as
   próprias credenciais R2, que então precisam de leitura no bucket frio.
3. Acrescente `"coldBucket": "<bucket frio>"` na configuração do executor do
   arquivo econômico (`scripts/cold-archive.mjs`) e defina as mesmas
   `R2_COLD_READ_*` ao rodá-lo. Sem leitura no bucket frio, o pacote de uma
   organização com nota fria não é selado.
4. Grave as regras de lock e defina `FNFE_COLD_LOCKED_THROUGH`, como na seção
   [Lock](#lock).

## Lock

O R2 não tem prazo de retenção por objeto, só regras por prefixo. Por isso, a
chave leva o que o lock precisa:

- `documents/production/guard-<ano>/<organização>/<versão>/content-<hash>.gz`
  para Produção. O ano é aquele em que termina a guarda da nota pela D01:
  31/12 do quinto ano depois da emissão, em Brasília, ou da entrada na
  plataforma quando o cartão não tem data.
- `documents/sandbox/<organização>/<versão>/content-<hash>.gz` para Sandbox,
  sem lock, para não impedir o expurgo antecipado da organização sem
  Produção.

Cada ano de guarda tem uma regra de lock por data, que vence em 01/01 do ano
seguinte, às 00:00 de Brasília. Para gravar as regras, use um token da API do
Cloudflare com administração do R2:

```sh
CLOUDFLARE_API_TOKEN=<token> node scripts/cold-tier-locks.mjs --through 2033
```

O script acrescenta as regras que faltam do ano corrente até `--through`, ou
as estende. Nunca encurta nem remove uma regra, e relê as regras depois de
gravar. Defina então `FNFE_COLD_LOCKED_THROUGH` com o mesmo ano. Uma nota de
Produção cuja guarda termina depois desse ano fica quente: nenhum objeto vai
ao bucket sem a regra do seu ano. Renove as regras antes de virar o ano.

O pacote da ADR 0009 que referencia notas frias estende o lock delas até o
`retainUntil` do pacote, com uma regra por organização e ano de guarda
(`archive-<runId>-<ano>`), conferida antes da selagem
([arquivo econômico](arquivo-economico.md#documentos-frios-no-pacote)). O
executor usa o mesmo `CLOUDFLARE_API_TOKEN`.

## Na REST, no SDK e no console

A REST e o SDK não mudam: o contrato v1 já foi publicado, e o gate de
compatibilidade recusa qualquer campo novo num schema existente sem uma
versão major. As rotas, a listagem e o conteúdo são os mesmos nas duas
camadas. Só o console mostra "Na camada fria" na listagem; a nota em passagem
(`moving`) conta como quente.

## Objetos órfãos

Antes de gravar um objeto, a action registra a intenção em
`coldObjectUploads`, e o vínculo da versão a apaga. Uma intenção que sobra por
mais de um dia, porque a action caiu ou o vínculo foi recusado, entra na
coleta junto com a fila de expurgo:

- se uma versão ou um original aponta para a chave, só a intenção sai;
- se a chave ainda está no lock do seu ano de guarda, a coleta espera o fim
  do lock;
- senão, a intenção é marcada em coleta, o objeto é apagado e a intenção sai.

Enquanto a coleta apaga uma chave, uma nova gravação da mesma chave é
recusada, e a nota volta para a varredura seguinte. Uma exclusão que o bucket
recusa volta para a fila depois do lock.

## Na reidratação

Quando uma organização arquivada pela ADR 0009 é reidratada, só a janela
quente do plano volta ao armazenamento de arquivos do Convex (ADR 0010,
decisão 5, fase C2). As notas mais antigas voltam com o resíduo inteiro no
banco (nota, listagem, versões, artefatos e demais linhas) e com o conteúdo e
o original no bucket frio, em `cold`. A janela é a mesma da varredura
(`coldTier.hotWindowCutoff`), com o plano em vigor no começo da reidratação.

O executor do arquivo econômico não grava no bucket frio. Ele deixa os
arquivos dessas notas fora da etapa de arquivos e, depois das linhas, sobe
cada lote ao Convex. Cada nota do lote passa por esta mesma passagem,
reivindicada pelo run da reidratação: intenção em `coldObjectUploads`,
gravação, releitura, chave com o ano de guarda e espera pelo lock do ano. O
arquivo quente sai na hora, porque a organização continua fora de alcance
até o fim da reidratação. O próximo lote só sobe depois disso.

Nessa etapa, valem as mesmas condições da varredura:

- com retenção legal ativa no começo, não há etapa fria e tudo volta quente;
  uma retenção criada durante a etapa devolve ao quente as notas que ainda
  não passaram;
- a nota de Produção cujo ano de guarda passa de `FNFE_COLD_LOCKED_THROUGH`
  volta quente, e a admissão já a conta como quente;
- com o gate desligado ou sem bucket, não há etapa fria.

A varredura diária não toca na organização enquanto o run não voltar a
`hot`. Depois disso, ela move as notas que a reidratação deixou quentes,
quando puderem passar. O procedimento está em
[arquivo-economico.md](arquivo-economico.md#etapa-fria-adr-0010-c2).
