# Consulta documental

A consulta usa os documentos persistidos pela [importação XML](IMPORTS.md). Backend em `platform/convex`, painel em `apps/console`.
O contrato externo canônico está em `packages/contracts/src/external.ts`.
`documents.ts` projeta o modelo fiscal e deriva os tipos desse contrato. A integração pelo SDK
gera OpenAPI, tipos do SDK e referência; veja [SDK.md](../v1.0/SDK.md).

## API e autorização

Todas as rotas exigem chave Bearer de projeto, `X-Environment` igual ao
ambiente da chave (outro valor responde `ENVIRONMENT_DENIED`), `companyId` na
query e concessão vigente `documents:read`; o reprocessamento exige também
`documents:import`. No site, `production` atende só a empresa com a captura
fiscal liberada, ou já desativada, para ler o que foi capturado
([liberação fiscal](CAPTURE.md#liberação-fiscal-no-site)); outra empresa
responde `NOT_FOUND`. Importação não roda em `production` no site, então o
reprocessamento também não, nem pela API nem pelo console. A identidade do
projeto vem da chave. Os IDs públicos identificam documento, versão, artefato
e operação; não são IDs internos de storage nem concedem acesso por si mesmos.
O painel usa sessão Better Auth, vínculo ativo, acesso à empresa e papel, sem
projeto nem concessão ([ADR 0005](../adr/0005-console-sem-projeto.md)).
Owner/admin/operator consultam e reprocessam; viewer consulta; developer lê
pelas integrações, não pelo painel.

| Método e caminho                           | Conteúdo                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `GET /v1/documents`                        | `page`, `nextCursor`, `indexing`; filtros `status`, `source`, `from`, `to`, `key`, `limit`, `cursor` |
| `GET /v1/documents/{id}`                   | Envelope documental `documents/1`, `model` `55` ou `nfse`, resumo, payload, versão e situação fiscal |
| `GET /v1/documents/{id}/json`              | O mesmo DTO público do detalhe; aceita `versionId` histórico                                         |
| `GET /v1/documents/{id}/items`             | Itens da `versionId` obrigatória, com cursor e valores exatos                                        |
| `GET /v1/documents/{id}/events`            | Histórico paginado de `kind=event` (padrão) ou `event-summary`                                       |
| `GET /v1/documents/{id}/versions`          | Versões publicadas, origem e payload, incluindo resultados anteriores                                |
| `GET /v1/documents/{id}/files`             | Artefatos originais distintos com nome, tamanho, SHA-256 e disponibilidade                           |
| `GET /v1/document-artifacts`               | Originais sem documento reconhecido e respectivo diagnóstico                                         |
| `GET /v1/document-artifacts/{id}/original` | Bytes originais como attachment, autorização revalidada antes de responder                           |
| `GET /v1/documents/{id}/danfe`             | PDF do DANFE da NF-e 55 como attachment, gerado na primeira chamada ([DANFE](#danfe))                |
| `POST /v1/documents/{id}/reprocess`        | JSON vazio e `Idempotency-Key`; HTTP 202 com `operationId`, `reused` e `Location` da operação        |

JSON usa `{ data, requestId }`; erros usam `{ error, requestId }`. Campos de
query desconhecidos ou duplicados são rejeitados. Datas `from`/`to` são
milissegundos UTC inclusivos da primeira importação, não da emissão. A UI
converte datas de calendário para esse intervalo. `key` aceita os 44 caracteres da chave NF-e ou a identidade `nfse:...`; `source` aceita `imported-xml` ou `distribution-xml` (captura). Status: `unknown`,
`authorized`, `cancelled`, `denied`, `conflict`. O cursor vincula a consulta;
acesso é revalidado mesmo ao continuar uma página.
Na listagem, o escopo é autorizado uma vez por consulta e cada documento é
conferido no banco antes da resposta. Quando todos já estão indexados, o REST
dispensa a mutation de inicialização; uma lacuna no índice continua acionando
o backfill limitado. Uma mutation pequena ainda confere chave, projeto e
expiração a cada leitura HTTP, para que o cache da query não prorrogue acesso.
A comparação hospedada preservou
resposta e cursor com menos leituras por página.

O download nunca retorna uma URL privada de storage. A API usa proxy; a UI
emite ticket de 60 segundos, guarda apenas seu hash no banco e envia o token
em `X-Download-Token`. O endpoint aceita somente a origem do console. Confere
membro, acesso à empresa e suas versões antes e depois de ler o arquivo; o
ticket pertence ao projeto do console. A autorização do ticket é mutation para reavaliar o relógio a cada
requisição, inclusive com query cache aquecido. Respostas usam `no-store`,
`nosniff` e attachment. Retenção do original é independente da projeção.
Antes de servir um original quente, a REST e o ticket conferem o SHA-256 e o
tamanho do arquivo em `_storage` contra os gravados no artefato; divergência
responde `ORIGINAL_UNAVAILABLE` (404) sem cobrar o download, como o objeto
frio divergente responde `UNAVAILABLE`. Fora da reidratação (ADR 0009) e da
exclusão por retenção, só `lib/originalStore.ts` escreve `documentArtifacts`:
grava o hash conferido contra o arquivo e depois só muda vínculos ou a
passagem para a camada fria; `insertFiscal` e `patchFiscal` recusam a tabela
(#110).
A emissão de tickets é limitada a 60 por minuto por organização e membro.
Os metadados de `importFiles` aceitos são preservados junto da procedência;
não há política de exclusão dessa linha nesta entrega.

Depois da reativação de uma organização do arquivo econômico, as rotas de
documento aceitam o ID anterior do documento, da versão (`versionId`) e do
original, e respondem o recurso atual com o `id` novo. `summary`, `version`
e os arquivos que voltaram trazem `originalId`, o primeiro ID
([SDK.md](../v1.0/SDK.md#ids-depois-da-reativação)). O reprocessamento
compara a chave de idempotência pelo ID como foi enviado.

## DANFE

O DANFE é a representação auxiliar da NF-e; o documento continua sendo o XML,
preservado e baixado como antes ([DANFE.md](DANFE.md)). A rota
`GET /v1/documents/{id}/danfe` e o botão "Baixar DANFE (PDF)" do console
seguem as regras dos downloads acima: `documents:read`, concessão,
`X-Environment`, `companyId`, isolamento por organização, empresa e ambiente
e autorização conferida antes e depois de ler o arquivo. Os testes cobrem
chave sem escopo, revogada, concessão sem `documents:read`, outra organização,
outra empresa da mesma organização, `X-Environment` errado e Produção no
sandbox sem liberação; no console, login sem vínculo e `viewer` sem e com
concessão da empresa. O console usa o mesmo
ticket de 60 segundos (`documentDownloads.danfeTicket`), resgatado em
`/v1/document-download`. A resposta é `application/pdf`, com
`Content-Disposition: attachment; filename="danfe-<chave>.pdf"`, `no-store` e
`nosniff`. O download do DANFE é auditado como `http.danfeDownload`, com o
documento como alvo ([OBSERVABILITY.md](OBSERVABILITY.md)). O botão só aparece
na versão atual de uma NF-e 55 completa cujo original está disponível.

Só a NF-e modelo 55 cuja versão publicada tem o XML completo tem DANFE.
Resumo, evento sem nota, NFS-e e XML recusado pelo gerador respondem
`DANFE_UNAVAILABLE` (409). Um histórico com mais de 100 versões de evento ou
mais de 20 cancelamentos distintos responde o mesmo código, com mensagem
própria sobre o excesso de eventos. Original ou evento cujo arquivo não está
mais guardado responde `ORIGINAL_UNAVAILABLE` (404) antes de gerar: um DANFE
sem o cancelamento guardado mostraria a nota como válida.

A geração lê o XML original da versão publicada e os `procEventoNFe` de
cancelamento ligados ao documento na mesma organização, empresa e ambiente,
deduplicados por SHA-256, confere o hash
de cada arquivo e chama `renderDanfe` numa action Node
(`danfeWorker.render`). Evento sem retorno da SEFAZ e resumo de evento não
entram. Com cancelamento, a origem impressa é "evento de cancelamento
preservado na plataforma, sem consulta ao fisco". O XML não é alterado.

O PDF fica em `documentDanfes`, um por documento, com versão do gerador,
SHA-256 do XML, SHA-256 do conjunto ordenado de eventos com a origem, número
de eventos, origem, SHA-256 e tamanho do PDF e instante da geração. A próxima
chamada reutiliza o arquivo enquanto a versão e os dois hashes forem os
mesmos. Um cancelamento importado depois ou outra versão do gerador produzem
um PDF novo, que substitui o anterior (linha e arquivo). Ao gravar, a
plataforma recalcula a chave atual do documento: uma geração lenta de uma
chave que já mudou é descartada com seu arquivo e não substitui a linha mais
nova. Uma recusa do gerador também é gravada para a chave, sem arquivo, e a
nova tentativa responde `DANFE_UNAVAILABLE` sem gerar de novo. O worker recusa
gerar se a versão do pacote diferir da cópia da plataforma. A tabela é da classe
`closure`: um cache que sai no expurgo da organização, porque o PDF é refeito
do original, que segue na guarda fiscal. No arquivo econômico a linha fica
quente, o documento é reescrito na reativação e o PDF não entra no pacote
([RETENTION.md](RETENTION.md)).

A primeira chamada gera o PDF dentro da própria requisição: a HTTP action
chama a action Node com `ctx.runAction` e espera o resultado, sem operação
assíncrona; a geração leva poucos segundos ([DANFE.md](DANFE.md#prova)). Se a
evidência mudar durante a geração ou durante a leitura do arquivo, a resposta é
`UNAVAILABLE` (503, repetível), nunca o PDF antigo. Cada organização gera no
máximo 20 DANFEs por minuto (`organization-danfe-render`), além do limite REST
de cada chamada; uma requisição consome no máximo uma geração, e servir um PDF
já gerado ou uma recusa gravada não conta. Os PDFs não entram no estoque de
arquivos da organização ([USAGE.md](USAGE.md#estoque-e-tráfego)). O download conta em `downloadsBytes`, como o do
original, e a chamada REST em `restReads` quando o plano mede leituras. Não há
evento de uso próprio, porque a geração não é uma operação fiscal.

## Campos projetados e omitidos

O envelope comum carrega IDs públicos, modelo `55` ou `nfse`, identidade,
datas, completude, processamento e situação fiscal. `payload.kind` discrimina
`invoice`, `summary`, `event`, `event-summary` e `service-invoice`.
O `number` do envelope é o `nNF` da NF-e completa e o número da NFS-e. Resumo
e evento não trazem `nNF`: nesses casos, o número vem da chave de acesso,
posições 26 a 34, sem os zeros à esquerda, que o leiaute não permite no `nNF`.
É o mesmo número que a nota completa mostra quando chega depois. Sem chave
válida de modelo 55, `number` fica nulo, e o console nomeia a nota pelo
emitente e pela data. A série (posições 23 a 25) não entra no nome.
As NFS-e importadas de lotes ABRASF antes da
[retirada](IMPORTS.md#lotes-nfs-e-abrasf-retirados) dessa importação, em
02/11/2026, ficam só para leitura. Sua projeção contém número, município emissor,
inscrição municipal, código de verificação, emissão, competência,
prestador/tomador, serviço e valores declarados. Não contém itens de mercadoria
nem eventos NF-e. Sua situação fiscal permanece desconhecida. A aba de arquivos
informa que o download preserva o XML original completo, incluindo todas as
NFS-e do lote.

| Representação    | Projeção explícita                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NF-e completa    | chave, ambiente fiscal declarado, número, série, emissão, natureza da operação, finalidade, emitente/destinatário, total, `vNF`/`vNFTot`, totais declarados e protocolo |
| Resumo           | chave, emitente, emissão, total, status declarado, número de protocolo e recebimento                                                                                    |
| Evento           | chave, autor, tipo, sequência, ocorrência, descrição, ambiente, cancelamento, correção, manifestação e recibo                                                           |
| Resumo de evento | chave, autor, tipo, sequência, ocorrência, descrição, protocolo e registro                                                                                              |
| Item             | número, código, descrição, NCM, CFOP, CEST, pedido/item do pedido, unidades comercial/tributária, quantidades, preços, total e tributos declarados                      |
| Versão           | IDs públicos de versão/operação/artefato, SHA-256, origem, importação/publicação, parser, normalizador, processador, schema, diagnóstico e quantidade de itens          |

Valores monetários, quantidades, alíquotas e tributos decimais preservam a string
declarada e são conferidos contra coeficiente/escala antes da projeção. Não há
conversão por `Number` nem cálculo tributário. Tributos conservam caminho,
representação, valor e `basis: declared`. Texto tem limite de 6.000 caracteres;
chave 44, tipo de evento 6, sequência 8, decimal 64, coleção de tributos 400.
O parser e a importação também aplicam seus próprios limites.

### Totais e finalidade da NF-e

`total` é o `ICMSTot/vNF` declarado, na NF-e completa, e o `vNF` do resumo
`resNFe`. Esse significado não mudou. O valor da listagem (`summary.total`) é o
mesmo e nunca passa a ser `vNFTot`. A reforma tributária acrescentou
`total/vNFTot` ao leiaute. Para que o integrador saiba qual valor recebe, a
NF-e completa traz os dois em `declaredTotals`, cada um com a descrição oficial
do campo:

| Campo                   | Origem no XML  | Descrição oficial                        | Fonte                                                   | Ausente no XML |
| ----------------------- | -------------- | ---------------------------------------- | ------------------------------------------------------- | -------------- |
| `declaredTotals.vNF`    | `ICMSTot/vNF`  | "Valor Total da NF-e"                    | XSD PL_010f e PL_010g, `leiauteNFe_v4.00.xsd`, `vNF`    | não ocorre     |
| `declaredTotals.vNFTot` | `total/vNFTot` | "Valor total da NF-e com IBS / CBS / IS" | NT 2025.002 v1.52, seção 6, grupo W03, campo W60, p. 30 | `null`         |

A plataforma não deduz a composição de um valor pelo nome do campo; o console
usa essas descrições, e a nota técnica define o que cada valor contém.

Os dois são texto decimal exato, iguais ao declarado. A plataforma não soma
nem recalcula: `vNFTot` ausente é `null`, nunca zero nem um valor derivado de
`vNF`. Um `vNFTot` declarado como `0.00` aparece como `"0.00"`. A projeção lê
`vNFTot` da coleção `totals` que o parser sempre gravou. Por isso, documentos
importados antes desta mudança já expõem os dois campos, sem reprocessar e sem
tocar no XML original ou no histórico. O resumo `resNFe` não tem `vNFTot` e
continua sem `declaredTotals`.

`purpose` traz a finalidade (`finNFe`) e os tipos de nota de crédito
(`tpNFCredito`) e de débito (`tpNFDebito`). Os códigos ficam como foram
declarados, em texto, ao lado da descrição em português do PL_010g fixado
(`TFinNFe`, `TTpNFCredito` e `TTpNFDebito`, iguais aos do PL_010f). Um código
que esse schema não admite chega com `label: null`, e a etapa XSD do documento
registra a recusa. A finalidade é separada da natureza da operação (`operation`, o
`natOp`) e da situação fiscal. Uma nota de crédito não indica cancelamento.

| Valor                                           | Significado                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `purpose: null`                                 | Versão processada antes do parser `nfe-parser/3`. Reprocesse o documento. |
| `purpose.code: null`                            | O XML não informa `finNFe`; o XSD já o recusa.                            |
| `creditNoteType: null` ou `debitNoteType: null` | O XML não informa o tipo.                                                 |

`purpose.inconsistencies` lista as regras de combinação que o XML declarado
descumpre. São quatro regras da NT 2025.002 v1.52, seção 7 (Regras de
Validação), grupo B, p. 32, com a redação oficial:

| Regra    | Texto oficial                                                                                               | Rejeição da SEFAZ                                       |
| -------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| B25.1-10 | "Se informado tipo de nota de débito (tag: tpNFDebito) - Finalidade <> 6-Nota de débito (tag:finNFe)"       | 1139, "Tipo de nota de débito informado indevidamente"  |
| B25.1-20 | "Se finalidade = 6-Nota de débito (tag:finNFe) - Não informado tipo de nota de débito (tag: tpNFDebito)"    | 1009, "Não informado tipo de nota de débito"            |
| B25.2-10 | "Se informado tipo de nota de crédito (tag: tpNFCredito) - Finalidade <> 5-Nota de crédito (tag:finNFe)"    | 1163, "Tipo de nota de crédito informado indevidamente" |
| B25.2-20 | "Se finalidade = 5-Nota de crédito (tag:finNFe) - Não informado tipo de nota de crédito (tag: tpNFCredito)" | 1164, "Não informado tipo de nota de crédito"           |

Um `tpNFDebito` com `finNFe` ausente também conta como B25.1-10, porque a
finalidade não é 6; o XSD já recusa esse XML. O XSD aceita as quatro
combinações; a SEFAZ as rejeita na autorização. A plataforma não avalia
nenhuma outra regra da NT. A importação preserva o documento e mostra a lista.
O console explica o problema em português e não muda a situação fiscal. Um código sem o formato de código (`finNFe` com um dígito, tipos com
dois) recusa a importação com `XML_FIELD_INVALID`.

Documentos persistidos antes do `nfe-parser/3` não têm a finalidade gravada.
Para lê-la, reprocesse o documento pelo console, por
`POST /v1/documents/{documentId}/reprocess` ou pelo SDK. O reprocessamento
cria uma versão nova a partir do XML original preservado, com a chave de
idempotência e os escopos de sempre. As versões antigas continuam no histórico
com `purpose: null`.

O fingerprint da evidência fiscal ignora `purpose`. Sem isso, reprocessar um
original já importado criaria um segundo fingerprint para os mesmos bytes, e a
reconstrução marcaria `PROCESSING_DISAGREEMENT` em todo documento antigo. Os
testes fixam os fingerprints que o `nfe-parser/2` gravou para o corpus
sintético. Divergência em `total`, nos itens ou nas etapas técnicas continua
gerando conflito.

### Campos da NT 2026.008

A NT 2026.008 v1.00 acrescentou quatro campos ao leiaute. O pacote oficial que
os contém, o PL_010g v1.03 (NT 2026.006 v1.00 e NT 2026.008 v1.00), foi
publicado no portal em 26/10/2026 e é o pacote de NF-e fixado desde então. O
parser `nfe-parser/4` lê esses campos, e a projeção os entrega em
`nt2026008`. A descrição de cada um é a da NT, seção 2 (Leiaute da NF-e), p. 6,
e o console a mostra resumida sem mudar o sentido:

| Campo           | Onde                                         | Descrição oficial                                                             | No console                                                  | Ausente no XML |
| --------------- | -------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------- |
| `vUnComLiq`     | Item, `prod` (I11b)                          | "Valor Líquido Unitário do Produto ou Serviço (sem tributos)"                 | Valor líquido unitário (sem tributos)                       | `null`         |
| `vProdLiq`      | Item, `prod` (I11c)                          | "Valor Líquido do Produto ou Serviço (sem tributos)"                          | Valor líquido (sem tributos)                                | `null`         |
| `vICMSPrevisto` | Item, `ICMS/ICMSPrevistoPagtoAntecip` (NB02) | "Valor do ICMS Previsto", no "Grupo do ICMS Previsto no Pagamento Antecipado" | Valor do ICMS previsto                                      | `null`         |
| `vProdLiqTot`   | NF-e, `total` (W01a)                         | "Valor Total Líquido dos Produtos ou Serviços (sem tributos)"                 | Valor total líquido dos produtos ou serviços (sem tributos) | `null`         |

Uma versão processada antes do `nfe-parser/4` tem `nt2026008: null` na NF-e e
nos itens (`/items` e exportação); o reprocessamento extrai os campos do
original.

São decimais exatos, iguais ao declarado. A escala segue a NT: `vUnComLiq`
até 10 casas, os outros até 2. Um valor que não é decimal recusa a importação
com `XML_DECIMAL_INVALID`; uma escala maior falha na normalização, sem
arredondar; o XSD também recusa essa escala. `vICMSPrevisto` igual a zero, que
a NT manda informar quando não haverá ICMS, aparece como `"0.00"`. Nas coleções
genéricas `totals` e `taxes`, `vProdLiqTot` e `vICMSPrevisto` aparecem como
`decimal`, pela política gerada do PL_010g.

No PL_010g, `ICMSPrevistoPagtoAntecip` é uma das alternativas do grupo `ICMS`:
o item informa esse grupo no lugar de `ICMS00` a `ICMSSN900`, nunca ao lado de
um deles. Um XML com os dois grupos no mesmo item tem a etapa XSD recusada
(`XSD_INVALID`), é publicado com o original preservado, e a evidência fica
excluída da situação fiscal por `TECHNICAL_VALIDATION_FAILED`. O XSD descreve
`vICMSPrevisto` como "Valor do ICMS que incidirá no momento do fornecimento
futuro".

Documentos no leiaute anterior continuam passando no XSD: para a NF-e 55, o
PL_010g só acrescenta elementos opcionais (os quatro campos e `gPgtoVinc`, da
NT 2026.006, [descrito abaixo](#vinculação-com-a-transação-de-pagamento-nt-2026006)). O
fingerprint da evidência dos documentos sem os campos novos não muda com o
catálogo novo.

Um documento com os campos novos importado enquanto o PL_010f estava fixado
tem a etapa XSD recusada e a situação `unknown`. Reprocessá-lo ou reconstruir
sua situação pelos originais grava a interpretação do PL_010g, que passa no
XSD. A regra `nfe-status/2`, decidida pelo mantenedor em 26/10/2026, deixa
essa interpretação substituir a anterior; a seção
[Catálogo de schemas mais novo](#catálogo-de-schemas-mais-novo) define quando.
A evidência da #395 registra a
reprodução por etapa e a substituição; o
registro de 25/10 traz o calendário do
leiaute e das regras de 2027, que a plataforma não avalia.

Como `purpose`, os campos de `nt2026008` ficam fora do fingerprint da evidência
fiscal; reprocessar um original antigo não cria divergência por causa deles.

### Vinculação com a transação de pagamento (NT 2026.006)

O PL_010g traz também o grupo opcional `infNFe/gPgtoVinc`, "Informações da
Vinculação com a Transação de Pagamento" (NT 2026.006 v1.00), depois de
`infIntermed`, com o tipo `TPgtoVinc` de `DFeTiposBasicos_v1.00.xsd`. O parser
`nfe-parser/6` o lê, e a projeção o entrega em `nt2026006.gPgtoVinc`: um item
por `gPgto`, até 99, na ordem do XML. As descrições são as do XSD:

| Campo                    | Descrição no XSD                                                                | No console                            |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------- |
| `nPag` (atributo)        | "Número sequencial do pagamento"                                                | Título "Pagamento N"                  |
| `idTransacao` (atributo) | "Identificador da transação financeira, de acordo com a transação de pagamento" | Identificador da transação financeira |
| `tpMeioPgto`             | "Código do meio de pagamento (ver IT DFe 2026.001)"                             | Meio de pagamento: descrição e código |
| `CNPJReceb`              | "CNPJ do recebedor do pagamento"                                                | CNPJ com a pontuação                  |
| `CNPJBasePSP`            | "CNPJ base da instituição financeira ou de pagamento"                           | Oito posições, como `12.345.678`      |

Todos são texto, como declarados: códigos e CNPJs mantêm os zeros à esquerda
e nunca viram número. Cada item traz também `tpMeioPgtoLabel`, a descrição do
código na tabela abaixo, derivada na projeção e não declarada no XML.

| Situação                                  | `nt2026006`                    |
| ----------------------------------------- | ------------------------------ |
| XML sem o grupo                           | `{ "gPgtoVinc": null }`        |
| Grupo com pagamentos                      | `{ "gPgtoVinc": [ … ] }`       |
| Grupo sem `gPgto`, recusado pelo XSD      | `{ "gPgtoVinc": [] }`          |
| Versão processada antes do `nfe-parser/6` | `null`; reprocesse o documento |

O parser confere os formatos do XSD, nem mais nem menos: `nPag` de 1 a 990, sem
zero à esquerda; `idTransacao` do tipo `TStringRTC`, com 2 a 35 caracteres
entre U+0020 e U+00FF e sem espaço no início ou no fim; `tpMeioPgto` com dois
dígitos; `CNPJReceb` com 14 posições e `CNPJBasePSP` com 8. Como um
`vProdLiqTot` que não é decimal, um valor fora desses formatos recusa a
importação inteira com `XML_FIELD_INVALID`, e mais de 99 `gPgto` com
`XML_LIMIT_EXCEEDED`. Reprocessar um documento já importado cujo original tem
o grupo nesse estado grava uma versão recusada, que não substitui a versão
publicada. O contrato REST usa os mesmos formatos, então um valor aceito pelo
parser nunca falha na validação da resposta.

No console, a seção "Vinculação com a transação de pagamento" aparece na aba
Dados quando o XML declara o grupo. Numa versão processada antes do
`nfe-parser/6`, a seção diz que o grupo não foi extraído e pede o
reprocessamento; num XML sem o grupo, ela não aparece.

#### Meio de pagamento (`tpMeioPgto`)

O PL_010g não descreve os códigos de `tpMeioPgto`; o XSD confere só os dois
dígitos (`[0-9]{2}`). A tabela é a do "Informe Técnico 2026.001, Versão 1.01"
(título da capa), sobre meios de pagamento, publicado em 25/08/2026 no
[Portal da NF-e](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=vZg2QuZtVg0%3D)
(PDF com SHA-256
`1e58913755c4e617f30619448909dd9ef82b0c772bcd44dc85774e77bcd28900`), página 3:
"O grupo de informação da vinculação da transação de pagamento utilizará os
seguintes códigos estabelecidos nesta tabela". As descrições são as do IT,
sem o asterisco de 23 e 24 (abaixo, por quê):

| `tpMeioPgto` | `tpMeioPgtoLabel`            |
| ------------ | ---------------------------- |
| `15`         | Boleto                       |
| `17`         | Pix QRCode                   |
| `18`         | TED                          |
| `20`         | PIX chave ou QRCode estático |
| `23`         | Pix automático               |
| `24`         | TEF / booktransfer           |

O IT marca 23 e 24 com asterisco: "Novos códigos que serão atualizados na
tabela nacional". O rótulo não leva o asterisco porque a
[Tabela de Meios de pagamento](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=uekMIW1ydFM%3D)
nacional, publicada em 06/03/2026 (XLSX com SHA-256
`f85d4a6d50390f824921703d166d3f2f4ec637b7244fa922248ef14e782d8a2d`), já traz
23, "Pagamento Instantâneo (PIX) - Automático", e 24, `TEF - "Book Transfer"`,
válidos desde 04/05/2026 pelo
[IT 2024.002 v1.11](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=6KiYymMwdyQ%3D)
(PDF com SHA-256
`19953feb5695e728cf15a91be144b7115b3079a31be5ba0fa6eb46af58db1172`). Os rótulos
seguem as descrições do IT 2026.001, a fonte do grupo `gPgtoVinc`, e não as da
tabela nacional.

O rótulo fica num campo irmão, `tpMeioPgtoLabel`, e não no formato
`{ code, label }` de `purpose`: `tpMeioPgto` continua o texto com o nome da tag
XML, como saiu na #530, e a descrição vem de um Informe Técnico, não do schema
fixado, de onde vêm os rótulos de `purpose`.

A tabela fica em `packages/contracts/src/documents.ts`
(`nfePaymentMeansLabels`), com a versão do IT ao lado
(`nfePaymentMeansLabelsSource`). O IT diz que a inclusão de códigos válidos
será feita por atualizações dele; um código novo entra no contrato com a
versão nova do IT.

Um código fora da tabela não é recusado nem reescrito: `tpMeioPgto` continua
como declarado e `tpMeioPgtoLabel` é `null`. O console mostra "Fora da tabela
do IT DFe 2026.001 v1.01" com o código e avisa, no cartão, que o IT prevê a
rejeição, na autorização, de um meio de pagamento fora da tabela, e que a
plataforma não avalia essa regra. O aviso atribui a regra ao IT e não afirma a
rejeição: a NF-e pode trazer um protocolo de autorização (o do corpus
sintético com o código `03` é fictício), e uma versão nova do IT pode incluir o
código. O schema só confere o formato, e a plataforma não avalia a lista: o
documento segue as mesmas etapas e a situação fiscal não muda.

Os dois documentos oficiais divergem no código da rejeição. O IT DFe 2026.001
v1.01 diz que "A utilização de um código diferente dos relacionados acima
causará a rejeição 1003 – Tipo de Pagamento inválido"; a NT 2026.006 v1.00,
regra YC05-10, cita a rejeição 1273, "Meio de pagamento inválido", para a
mesma conferência. A plataforma não escolhe entre elas e não cita um código de
rejeição no console.

O rótulo não é gravado: a projeção o deriva do código, como os de `purpose`.
Ele não entra no resultado do parser nem no fingerprint da evidência fiscal,
do qual `nt2026006` inteiro já fica fora; documentos já importados com o
`nfe-parser/6` ganham o rótulo sem reprocessar, e uma versão nova da tabela
não cria divergência.

**O que a plataforma não avalia.** O que está acima é o leiaute: o que a
plataforma lê e expõe. As regras de validação da NT 2026.006, que a SEFAZ
aplica ao grupo na autorização, não são avaliadas. A plataforma também não
confere o pagamento com a transação financeira, o recebedor ou a instituição,
e o grupo não muda a situação fiscal. O XSD declara `nPag` e `idTransacao`
únicos no grupo (`xs:unique`), mas o seletor `gPgto`, sem prefixo, não alcança
os elementos do namespace da NF-e (`elementFormDefault="qualified"`, XSD 1.0):
a etapa XSD aceita a repetição, e a plataforma lê os dois pagamentos como
declarados. Um teste de `packages/fiscal-nfe` fixa esse comportamento.

O emitente também pode vincular a NF-e a uma transação de pagamento depois da
autorização, pelo evento 110300 (Vinculação Pagamento). Desde o
`nfe-parser/7` ele entra no histórico de eventos da NF-e, com os campos do
pagamento só no XML original; ele não altera `nt2026006`, não confirma
pagamento e não muda a situação fiscal
([NFE-SCHEMAS.md](NFE-SCHEMAS.md#vinculação-pagamento-110300)).

Uma versão processada antes do `nfe-parser/6` tem `nt2026006: null`. O
reprocessamento pelo console, por `POST /v1/documents/{documentId}/reprocess`
ou pelo SDK extrai o grupo do XML original numa versão nova; as versões
antigas continuam no histórico com `null`. Como `purpose` e `nt2026008`,
`nt2026006` fica fora do fingerprint da evidência fiscal: reprocessar um
original antigo não cria `PROCESSING_DISAGREEMENT`.

Cabeçalho não embute itens; estes têm paginação própria. São omitidos objetos
internos de parsing/normalização, coeficientes auxiliares, storage IDs, URLs de
storage, credenciais, assinatura/certificado bruto e campos fora da lista
explícita. A omissão do DTO não altera o modelo fiscal nem os bytes preservados.
XML é exibido com nó de texto React, sem interpretar HTML.

## Paginação e situação fiscal

Listagem usa quatro entradas por documento no índice empresa/ambiente/filtro/
data. A busca por chave usa a identidade documental indexada. Página de lista
aceita até 50 resultados; itens 25; eventos, versões e arquivos 20. Há limites
adicionais de linhas e bytes por chamada, podendo produzir página parcial com
cursor. Listagem não percorre histórico nem busca a base inteira no navegador.

`documentFiscalEvidence` materializa cada variante de `nfe-status/1` por
SHA-256 original e fingerprint da interpretação canônica do próprio pacote
fiscal. Reimportar ou reprocessar a mesma interpretação não amplia esse
conjunto. O fingerprint completo preserva divergências mesmo em campos
omitidos do snapshot fiscal compacto. O histórico de versões não é deduplicado.

### Catálogo de schemas mais novo

A situação fiscal usa a regra `nfe-status/2` desde a #395. Ela repete a
`nfe-status/1`, com uma diferença decidida pelo mantenedor em 26/10/2026:
quando um catálogo de schemas mais antigo recusou os bytes só na etapa XSD e um
catálogo mais novo os aceita, a interpretação nova substitui a anterior na
situação fiscal. As duas continuam em `documentFiscalEvidence` e no histórico
de versões, e o XML original não muda.

Cada interpretação grava seu catálogo em
`metadata.versions.schema.catalogSha256`, desde a primeira validação XML. A
ordem dos catálogos é a lista `SCHEMA_CATALOGS` de `packages/fiscal-nfe`, por
esse hash, e nunca a data de processamento: PL_010f (`1e871b…`), PL_010f
com os eventos da #389 (`de9e38…`, mesma política decimal), PL_010g com
esses eventos (`0122a6…`) e PL_010g com o detalhe do evento 110300 (`4ffaa6…`,
mesma política decimal, #405). Um catálogo fora da lista não é mais novo nem mais antigo
que outro. Cada entrada nova da lista declara os campos de `totals`/`taxes`
que passou a tipar como decimal.

Quando um original tem mais de uma variante, a reconstrução reabre esse
original e o processa com o código atual. Dessa interpretação completa, ela calcula o fingerprint exato que o catálogo mais
antigo teria produzido se recusasse os bytes no XSD: etapa XSD e evidência
fiscal recusadas, e os campos tipados depois sem a representação decimal. A
variante gravada só é substituída se o fingerprint dela for esse. Assim, total,
itens, as outras etapas técnicas e as declarações entram inteiros na
comparação. Continuam em `conflict`, com `PROCESSING_DISAGREEMENT`:

- diferença em total, itens ou qualquer etapa técnica além do XSD;
- duas interpretações com XSD aprovado que diferem;
- catálogo mais novo que recusa o que um mais antigo aceitou;
- catálogo não registrado, ou as duas interpretações do mesmo catálogo.

A tabela continua com a chave `ruleVersion: "nfe-status/1"`, porque o
fingerprint das variantes não mudou; só a resolução entre variantes do mesmo
original é nova. Uma situação gravada antes continua marcada com
`nfe-status/1` até a próxima reconstrução do documento, e
`deriveFiscalSituation(evidências, "nfe-status/1")` reproduz o resultado
anterior. Reprocessar ou reconstruir de novo os mesmos originais dá a mesma
situação.

Checkpoint conserva o resultado provisório na operação. O sucesso da operação,
a classificação de duplicidade/conflito e a troca da versão publicada acontecem
na mesma transação. Leitores continuam vendo a versão anterior durante o
processamento. A identidade idempotente do reprocessamento usa o documento
lógico; a execução fixa o artefato escolhido na reserva. Repetir a mesma chave
recupera essa operação mesmo após o documento evoluir de resumo para completo.
No mesmo projeto, o resumo da importação acompanha a operação mais recente.
Reprocessamento por outro projeto autorizado não muda o ponteiro desse lote.

A reconstrução lê no máximo 257 variantes, em páginas de até dez. Até 256 são
suportadas nesta versão; a 257ª informa `limit-exceeded`. Pendência, limite ou
original indisponível nunca publicam o estado anterior como atual: o status
indexado fica `unknown`, `fiscalSituation` fica nulo e o último resultado
permanece em `previousFiscalSituation`. A interface o identifica como histórico.
Completude e processamento do documento permanecem independentes.

O reducer da validação XML resolve cancelamento, eventos tardios/repetidos e conflitos,
com referências às evidências. Cada publicação incrementa a geração; jobs
antigos não podem finalizar sobre uma geração posterior. Conferência manual
reabre os originais, verifica seu SHA-256 e usa o instante de avaliação
preservado no processamento. Não realiza consulta fiscal externa. A reconstrução
manual exige permissão de importação e tem limite de dez pedidos/minuto/org.
O pedido de conferir os originais permanece na projeção durante indexação e
backfill. Uma publicação automática concorrente conserva essa intenção até
que a geração atual termine, inclusive quando os snapshots já estão salvos.

## Dados anteriores e implantação

Campos novos nas tabelas existentes são opcionais. A primeira leitura
autorizada inicializa uma manutenção idempotente da empresa: até 20 documentos
por mutation, dez versões por job. Esse reparo de leitura não concede novas
permissões nem executa processamento fiscal externo. Publicações antigas ganham
índice de histórico e snapshots recuperados dos originais; resultados e hashes
de saída anteriores não são reescritos. Operações antigas que terminarem após
a atualização também entram nesse caminho. A UI informa indexação pendente.
Cada continuação da indexação verifica sua geração antes de escrever; uma
solicitação nova invalida a cadeia anterior e agenda sua substituta. Se faltar
um original necessário ao backfill, a reconstrução permanece incompleta até
sua restauração. Evidências parciais não podem publicar um estado atual pronto.

A worktree prova as funções e índices no Convex anônimo local. Antes de uma
publicação em ambiente já populado, o responsável Backend/Operações deve
inventariar documentos/versões/bytes, ensaiar o backfill em cópia descartável e
conferir conclusão dos índices antes de ativar as consultas. Para volume que
exija staged indexes, publicar primeiro somente os índices, aguardar o backfill
e então o código leitor. Não remover índices anteriores nem estreitar campos
nesta etapa. A prova local não é medição de custo ou carga de produção.

## Painel e evidências

`/app/{organizationSlug}/documents` conserva seletores e filtros na URL.
Detalhe e versão histórica usam `document`/`version`. O detalhe é a página do
documento: no lugar do título da lista, das etapas e do seletor de empresa,
"Voltar à lista de documentos" (que conserva os filtros) e o h1 do documento.
Aberto a partir da lista, o detalhe a deixa montada e oculta: ao voltar, a
lista está na mesma página e na mesma rolagem. Mudar um filtro volta à
primeira página; outra empresa, outro documento ou outra versão começam do
zero. A
aba JSON mostra o DTO público, o mesmo corpo de `GET /v1/documents/{id}/json`
(`documents.detail` devolve o `PublicDocument`), com copiar e baixar. Lista,
itens, eventos, histórico e arquivos sem documento paginam com o mesmo controle
"Página anterior"/"Próxima página", com as páginas já percorridas numeradas; na
lista, a barra fica presa ao pé da janela e oferece 20 ou 50 por página
(`perPage` na URL). Os arquivos sem documento reconhecido ficam em "Arquivos
recusados", na página de importação, com o motivo em palavras, o código e o
original; a lista de documentos só mostra um aviso com o link quando
`documents.unclassifiedCount` conta algum (até 20, depois "20+"). A contagem
roda em toda página do console e lê só o índice dos artefatos sem documento,
no máximo 21, sem abrir arquivo, operação ou versão (#44). Um lote NFS-e
ABRASF aceito antes da retirada também fica sem documento próprio, mas não é
recusa: ele leva `nfseBatch` e fica fora desse índice, da contagem e da lista.
A marca segue a operação atual do arquivo: reprocessar uma nota do lote a
tira enquanto o lote é relido, e o arquivo volta a contar como o que a nova
operação disser. Os lotes importados antes da marca precisam de
`unclassifiedMigration:markNfseBatches` com `{"cursor":null}` em cada
deployment com dados, conferindo o alvo por
[deploy-producao.md](../operacao/deploy-producao.md); o log mostra
`nfse_batch_mark` até `isDone: true`. A migração pula as organizações sob
custódia do arquivo econômico (`skipped`), e uma organização restaurada de um
pacote anterior à marca volta sem ela: rode a migração de novo depois de cada
restauração. Até lá, um lote sem marca entra na contagem, mas não na lista.
Num ambiente que a página de importação não lê (Produção da captura liberada), a seção fica
na aba Captura da empresa, e o aviso de Documentos aponta para lá; quem tem papel
de desenvolvedor, sem essa aba, a vê no fim da própria lista. Abas consultam itens,
eventos e histórico sob demanda. Mudanças de contexto desmontam componentes e
cancelam leitura de XML. Concessões e vínculo são dependências reativas;
revogação remove o conteúdo privado aquecido. Teclado navega pelas abas com
setas, Home e End. Resumo oferece o seu próprio original, sem afirmar conter
XML completo da nota; arquivo não reconhecido conserva diagnóstico e original.

A lista mostra o ambiente escolhido no seletor da lateral; os documentos de
uma empresa com a captura fiscal liberada ficam em Produção
([CAPTURE.md](CAPTURE.md#liberação-fiscal-no-site)). O eyebrow da lista e o
do detalhe dizem o ambiente ("Documentos / Produção"), e todo link de dentro
da lista leva `env=`. O filtro "Conteúdo" lista só as notas que chegaram como
resumo, sem itens (`completeness: "summary"` em `documents.list`, só no
console): o servidor lê o índice de completude do documento, do mais recente
para o mais antigo, e aplica os outros filtros a cada linha lida, então uma
página pode vir menor que o limite e ainda ter a seguinte.
`documents.summaryCount` conta essas notas até 100 para o painel da captura,
pulando as que a lista esconde (ainda não publicadas, emitidas) sem que elas
ocupem o lugar das outras; lê no máximo 1.000 linhas do índice e, passando
disso, diz que pode haver mais.
A API REST não muda.

Provas de backend, navegador e critérios de aceite: evidence/72.
A integração desta entrega, publicação remota e aceite final são estados separados.
