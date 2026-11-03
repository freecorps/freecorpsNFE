# Importação privada de XML

Contrato da importação XML em `platform/convex` e `apps/console`, hoje
integrado em `main`. Os recibos distinguem a
prova local do aceite e da publicação. Não exige certificado do usuário.

## Reserva, envio e confirmação

A API exige chave de projeto, `X-Environment: sandbox` e concessão vigente
`documents:import` para a empresa. O painel usa a sessão Better Auth, o acesso
à empresa e o papel, sem projeto ([ADR 0005](../adr/0005-console-sem-projeto.md)):
o lote e suas operações pertencem ao projeto do console, e a lista do painel
mostra os lotes da empresa de todos os projetos. Owner/admin/operator podem
importar; viewer consulta. Developer não importa pelo painel. A chave de uma
integração não enxerga lotes criados pelo painel, e o painel lê mas não altera
lotes de integração (envio, confirmação, cancelamento, reprocessamento e
retomada respondem `INTEGRATION_RECORD`).

| Método e caminho                                       | Entrada e resultado                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/imports`                                     | `Idempotency-Key`; JSON com `companyId` e `files`, cada arquivo com `name`, `size`, `sha256`. Retorna `importId`, `fileIds` e `reused`. |
| `GET /v1/imports/{importId}`                           | Estado e resultado completo por arquivo, sem URL de download ou ID de storage.                                                          |
| `POST /v1/imports/{importId}/files/{fileId}/upload`    | Emite URL do endpoint de envio e token restrito ao arquivo por até 15 minutos.                                                          |
| `POST /v1/import-upload`                               | Bytes originais com `X-Upload-Token`. Confere tamanho e SHA-256 antes de armazenar e revalida acesso ao vincular.                       |
| `POST /v1/imports/{importId}/files/{fileId}/confirm`   | Confere metadados privados, aceita uma operação e invalida o token. Repetição recupera a operação inicial.                              |
| `POST /v1/imports/{importId}/files/{fileId}/reprocess` | `Idempotency-Key`; aceita processamento do original existente na versão atual.                                                          |
| `GET /v1/imports/{importId}/files/{fileId}/history`    | Até dez versões recentes, retornando somente as concluídas com operação bem-sucedida.                                                   |

Respostas aceitas usam HTTP 200 e envelope `data`. A confirmação aceita
trabalho assíncrono; o cliente acompanha seu estado. JSON é limitado a 16 KiB.
Reserva divergente com a mesma chave recebe 409. O limite é 20 novas reservas
por minuto por organização, 20 XMLs por reserva e 2 MiB por arquivo. ZIP fica
fora da 1.0. Limites são iniciais e devem ser revistos com o corpus e a carga.

A reserva dura 24 horas. Estados do envio são `reserved`, `uploaded`,
`accepted` e `expired`; depois da aceitação, a consulta mostra o estado da
operação. Perder a resposta do upload permite recuperar `uploaded` e confirmar
sem reenviar bytes. Nenhum cliente escolhe um `storageId`. Tokens são armazenados
como hash, consumidos ao vincular e revalidados contra revogação e expiração.
Cada ticket novo substitui o anterior do mesmo arquivo: um envio atrasado com o
token antigo é recusado e não deixa blob.

No painel, o envio tem dois prazos. Enquanto o navegador entrega os bytes, 30
segundos sem progresso (`UPLOAD_IDLE_MS`) interrompem o envio: conta-se o
silêncio, não a duração, e uma conexão lenta continua informando progresso.
Depois do último byte entregue, o progresso não diz mais nada, porque os bytes
podem estar parados no socket enquanto um link lento os escoa. A resposta então
tem um minuto para o servidor mais um segundo por 8 KiB (64 kbit/s, o link mais
lento considerado): cerca de 5 min 16 s para 2 MiB, dentro dos 15 minutos do
ticket. Se o navegador nunca sinalizar o fim da entrega (`xhr.upload.onload`), os
30 segundos sem progresso cobrem também a espera pela resposta. Interrompido,
recusado ou sem conexão, o painel consulta o estado
persistido do arquivo antes de decidir: `uploaded` é confirmado na hora, sem
novo envio; `reserved` não é reenviado na mesma execução, e a sequência segue
para o próximo arquivo. O aviso diz quais arquivos ficaram sem resposta, e
"Retomar esta importação" consulta o lote de novo e só pede outro ticket para o
que continua `reserved`. Uma recusa usa o código do servidor, e o aviso agrupa
os arquivos de cada código numa frase:

- `UPLOAD_EXPIRED` na resposta do envio (ticket vencido ou substituído) pede
  outro ticket ao retomar; na emissão do ticket ou na confirmação, a reserva
  venceu, e o aviso pede uma "Nova importação".
- `INVALID_FILE` e `FILE_TOO_LARGE` no envio, ou uma conexão perdida com o
  arquivo que o navegador já não consegue ler (arquivo alterado no disco depois
  de escolhido), descartam a cópia escolhida: a linha volta a pedir o XML, e
  escolhê-lo de novo recalcula o hash, que cai em "conteúdo diferente" se ele
  mudou.
- `INVALID_FILE` na confirmação quer dizer que o original guardado não confere
  com a reserva: o aviso pede uma "Nova importação", e a linha deixa de
  oferecer envio e confirmação nesta aba, como depois de `UPLOAD_EXPIRED` na
  emissão do ticket ou na confirmação. Recarregar a página volta a oferecê-los,
  e o servidor recusa de novo sem efeito.
- `ACCESS_REVOKED` (envio ou ticket) e `SCOPE_DENIED` (ticket ou confirmação,
  quando o papel ou a concessão mudaram; no envio, só chega por API key) dizem
  que o acesso mudou: "Retomar" confere de novo, e se for recusado é preciso
  pedir a quem administra a organização para conferir a permissão.
- Outro código no envio diz que o servidor não aceitou agora e que "Retomar"
  tenta de novo; da emissão do ticket ou da confirmação, segue o aviso comum
  (cota, lote de integração e demais).
- Se a reconsulta encontra o arquivo fora de `reserved` e `uploaded` (vencido,
  cancelado ou já aceito), o aviso diz que a reserva já não aceita envio, e a
  linha mostra o estado atual.

As frases ficam no singular ou no plural conforme o número de arquivos.

Como escolher arquivos substitui a escolha anterior, o motivo do botão e o aviso
pedem para selecionar de uma vez todos os XMLs que faltam.

Esses prazos valem só para o envio dos bytes. Ticket, confirmação e a consulta
do estado passam pelo cliente Convex, que guarda as chamadas na fila enquanto
está sem conexão e as envia quando ela volta; o painel não lhes dá prazo e
continua em "Enviando…" até a resposta. Depois que o lote existe, "Cancelar
uploads pendentes" encerra essa espera, e as respostas que chegarem depois não
iniciam nada. Antes disso não há o que cancelar: uma reserva ainda na fila sem
conexão deixa o painel em "Enviando…" até a conexão voltar.
Se a consulta falhar, o arquivo fica como estava, sem confirmação, e a
sequência segue.

A próxima ação de cada arquivo aparece na sua linha:

| Estado persistido                       | O que o painel mostra                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `reserved`, sem o XML nesta aba         | Pede de novo o XML original pelo nome; "Retomar" fica desabilitado e diz qual falta                                  |
| `reserved`, XML com mesmo nome e hash   | "Retomar" envia esse arquivo                                                                                         |
| `reserved`, mesmo nome e outro conteúdo | Diz que o conteúdo difere da reserva e que, para importá-lo, é preciso iniciar uma "Nova importação"; nada é enviado |
| `uploaded`                              | "Retomar" confirma sem enviar de novo                                                                                |
| Aceito, em processamento                | Estado da operação, sem ação                                                                                         |
| Concluído ou recusado                   | Resultado e, quando faz sentido, "Reprocessar" (abaixo)                                                              |
| Pausado                                 | "Retomar processamento"                                                                                              |
| `expired`                               | Pede para importar o arquivo de novo                                                                                 |

O navegador não guarda XML nem token: depois de recarregar a página, o arquivo
reservado precisa ser escolhido de novo, e só é enviado se nome e SHA-256
conferirem com a reserva.

Cancelar um envio pendente expira a reserva e remove seu blob. Cancelar um
arquivo já aceito recebe `ALREADY_ACCEPTED`; não desfaz processamento. No
painel, "Cancelar uploads pendentes" encerra de vez a sequência em curso, antes
de ouvir o servidor: o envio ativo é abortado e a resposta tardia de ticket,
upload ou confirmação não inicia o arquivo seguinte. Cada arquivo pendente é
cancelado por conta própria, e o aviso conta só o que o servidor confirmou:
envios cancelados e arquivos que ele já tinha aceitado, que seguem no
processamento. Cada arquivo cancelado mostra "Envio não concluído". O lote só
diz o mesmo quando nenhum outro arquivo foi importado, recusado, falhou, pausou
ou segue em andamento; senão vale o resultado dos outros: "Em andamento"
enquanto processam, "Requer atenção", "Parcial", "Falhou" ou "Pausada" com
recusa, falha ou pausa, e "Concluída com ressalva" ao lado de importados
(#507). Enquanto houver cancelamento sem resposta, inclusive sem
conexão, quando o cliente Convex guarda as mutations na fila, enviar, escolher
arquivos, "Nova importação" e a lista de recentes ficam bloqueados: nada novo
começa antes de o servidor responder. O aviso recebe o foco quando ele estava
na área de envio ou em lugar nenhum, e então não é região viva, para não ser
lido duas vezes; se a pessoa levou o foco a outro lugar, ele fica lá e o aviso
é anunciado por uma região viva que já estava na página, vazia, e só muda de
texto. "Retomar esta importação" depois disso é uma
execução nova, que relê o lote e envia só o que ainda está pendente. Um
coletor compartilhado varre janelas incrementais do storage em páginas de 50,
preserva blobs vinculados e remove órfãos do MIME exclusivo da importação e
do MIME do conteúdo das versões, descrito abaixo.
Reservas ativas mantêm o coletor agendado, independentemente dos crons fiscais.

Depois da reativação de uma organização do arquivo econômico, as rotas de
importação aceitam o ID anterior do lote e do arquivo e respondem o lote
atual; o lote e os arquivos que voltaram trazem `originalId`, o primeiro ID
([SDK.md](../v1.0/SDK.md#ids-depois-da-reativação)). O reprocessamento de um
arquivo compara o artefato pelo primeiro ID, então a repetição com a mesma
chave devolve a mesma operação.

## Original, identidade e publicação

O painel acompanha `imports.selected` com `includeResults: false` e usa a
mesma opção em `imports.get` ao retomar uploads. Os estados, códigos, IDs de
versão e links de documentos continuam reativos; `files[].result` fica `null`.
Sem essa opção, as duas queries mantêm a resposta completa. O contrato REST
`GET /v1/imports/{importId}` também continua devolvendo os resultados completos.

Ao abrir "Conferir resultado", a tela assina `imports.detail` para aquele
`fileId`, `versionId` e `expectedScope`. O servidor revalida a sessão, a
organização, o projeto, a empresa e suas concessões. Só devolve uma versão
completa da operação atual bem-sucedida; versão obsoleta ou em processamento
retorna `null`. Fechar o detalhe encerra a assinatura e desmonta o JSON. Uma
nova versão começa fechada. A formatação acontece apenas com o detalhe aberto
e é reutilizada enquanto o resultado não mudar.

Essa opção reduz o payload e o trabalho da tela, mas continua lendo as versões
no banco para montar o resumo. Não há projeção nova nem migração de dados.
As medições de #123 e #124 separam bytes de retorno,
leituras e trabalho de renderização.

`documentArtifacts` registra origem, data, tamanho e SHA-256 dos bytes
imutáveis, com vínculo privado ao storage e à solicitação. Cada importação
preserva sua procedência, mesmo que os bytes sejam iguais. Schema, versões do
parser e normalizador, diagnóstico e resultado pertencem a `documentVersions`.

Desde a B4 da [ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md),
cada versão publicada, de importação ou de captura, ganha também um blob
`document-content/1` (`application/vnd.freecorps.document-content+gzip`) com o
resultado, a evidência, os itens e o snapshot da evidência, e um cartão com os
campos da listagem. Desde a B8, o escritor relê o blob e retira a cópia em
linha (resultado, evidência, itens e snapshot); só a versão sem blob a
guarda. Desde a B5, a API
REST, a exportação e a projeção fiscal leem o conteúdo do blob por uma action
Node, e a listagem lê o cartão. Desde a B6, o console lê pelo mesmo caminho,
com um token reativo por leitor (`contentRead.ts`). O blob
conta na cota de arquivos pelo tamanho comprimido, sem
recusa por cota. Conteúdo acima de 8 MiB, ou com itens fora de posição, fica
só em linha, e a importação não muda de resultado.

O smoke B4 local
exercita publicação, scheduler e blob no Convex local, incluindo tamanhos
próximos e acima de 8 MiB. Usa fixtures após o parser e não prova produção
nem consumo de memória. A margem de memória do leitor Node foi medida num
preview (margin-hosted.md).

A avaliação pré-B5 local exercita uma
action interna de prova com retorno completo, fallback e erros de blob.
Não migra os leitores e não comprova o orçamento de memória exigido pela ADR.

A identidade lógica é organização + empresa + ambiente + modelo + chave
fiscal. Solicitações diferentes podem convergir para essa identidade. Hash
de bytes identifica artefatos, sem deduplicação global entre clientes.
Resumo pode evoluir para NF-e completa. Bytes idênticos recebem `DUPLICATE`;
outro XML completo da mesma identidade recebe `ARTIFACT_CONFLICT`, preserva
ambos os artefatos e mantém a versão publicada anterior para conferência.

NF-e completa aceita emitente ou destinatário como empresa participante.
Resumo exige o emitente conhecido; evento aceita autor ou emitente da chave.
Não inferimos acesso pelo destinatário ausente de um resumo. Schema desconhecido,
identidade inválida e empresa incompatível preservam diagnóstico e original,
sem criar documento lógico. Checagens técnicas e assinatura não equivalem a
autorização fiscal e continuam identificadas separadamente no resultado.

Itens são gravados em lotes de até 25, com limite de bytes por lote e por item.
A versão fica em staging até o checkpoint transacional confirmar todos os
itens. Consultas públicas exigem versão completa e operação bem-sucedida.
Retomada usa o cursor persistido e a posse vigente da operação. Resultado
divergente durante retomada falha com `PROCESSING_CHANGED`, evitando combinar
saídas de revisões diferentes. O hash de saída cobre cabeçalho e sequência
completa de itens, inclusive o prefixo já gravado. Versões antigas concluídas
continuam legíveis; staging sem esse hash não pode retomar. Revogação interrompe também a aceitação do
resultado e pausa a operação.

O histórico usa o índice `by_artifactId_and_publishedAt`. A operação marca
`publishedAt` por callback interno na mesma transação que confirma seu sucesso.
O limite de dez se aplica às publicações concluídas; tentativas em staging ou
sem sucesso não ocultam versões anteriores. As tabelas de importação são a base da consulta documental. A consulta de documentos acrescenta índices
e projeções opcionais; a estratégia para dados anteriores está em
[DOCUMENTS.md](DOCUMENTS.md). Dados sintéticos de worktree não comprovam
migração de dados de clientes.

O processamento atual é `xml-import/3`. A prova histórica executa também
`xml-import/1`: a segunda versão acrescenta a projeção de situação fiscal
`nfe-status/1`; desde a #395, a situação gravada na importação usa
`nfe-status/2` ([DOCUMENTS.md](DOCUMENTS.md#catálogo-de-schemas-mais-novo)). Ambas usam o mesmo parser e normalizador da validação XML, cujas versões
são registradas separadamente. O helper que inicia v1 exige ambiente local de
prova; a entrada pública sempre seleciona v3. Reprocessar preserva o resultado
anterior e o original, e só publica a nova versão após completá-la.

## Lotes NFS-e ABRASF (retirados)

Até 02/11/2026, o processador v3 também lia lotes NFS-e no leiaute de
exportação ABRASF (`ListaNotaFiscal/Nfse/InfNfse`, #141). Essa importação foi
retirada nessa data. Campinas passou o Simples Nacional para o Emissor Nacional
em 01/11/2026 (#199), os sistemas municipais ABRASF estão sendo trocados pela
NFS-e nacional, e a consulta da situação fiscal dessas notas (#142) não vale o
custo.

Hoje um XML ABRASF enviado pelo console, pela REST ou pelo SDK é recusado como
qualquer leiaute desconhecido, com `XML_NAMESPACE_UNSUPPORTED`. A importação
aceita só NF-e modelo 55: nota completa, resumo ou evento.

As NFS-e já importadas ficam só para leitura. Continuam na lista, na consulta,
no download do lote original e na exportação, como `model: nfse` e
`payload.kind: service-invoice`, com situação fiscal `unknown`. Os arquivos
desses lotes mantêm `NFSE_BATCH_IMPORTED` e `documents[]`, e códigos antigos
como `NFSE_LAYOUT_UNSUPPORTED` e `NFSE_BATCH_LIMIT` continuam nos arquivos
recusados na época. Reprocessar um arquivo ABRASF antigo é recusado com
`OPERATION_CONFLICT` (HTTP 409), porque o parser não existe mais. O painel não
oferece "Reprocessar" para um arquivo com `NFSE_BATCH_IMPORTED` e mostra "A
plataforma não lê mais lotes NFS-e ABRASF. As notas deste lote continuam
disponíveis para consulta."

A emissão NFS-e (DPS nacional, no sandbox) não muda: ela continua criando
documentos `service-invoice` ([ISSUANCE.md](ISSUANCE.md)).

## Painel e fronteiras de escopo

`/app/{organizationSlug}/imports` oferece seleção de empresa/projeto, entrada
por teclado ou dropzone, progresso, resultado por arquivo, sucesso parcial,
retomada e reprocessamento. Indisponível, a área de envio troca a borda
tracejada por uma contínua e, na linha dos limites, mostra o motivo com o texto
em contraste pleno: "Aguarde a leitura dos arquivos." enquanto os escolhidos são
lidos, com o botão em "Lendo arquivos…", "Aguarde o fim do envio." enquanto são
enviados e, nos outros bloqueios, o mesmo motivo escrito sob os botões, que o
leitor de tela lê uma vez só (#526). O campo de arquivo bloqueado fica
`aria-disabled`, nunca desabilitado de fato: quem escolheu pelo teclado mantém o
foco nele durante e depois da leitura, e ativá-lo nesse intervalo não abre o
seletor (#535). Empresa, projeto e lote ficam na URL,
permitindo refresh e acesso direto. O servidor normaliza os seletores textuais
antes de usá-los como IDs e devolve seleção vazia para URL inválida ou obsoleta.
Consultas revalidam esse escopo. A lista recente (`imports.recent`) mostra os
últimos 10 lotes da empresa, com data, número de arquivos, resultado
("Concluída", "Parcial", "Falhou", "Em andamento") e origem ("Console" ou
"Integração X"); o link direto continua válido para os anteriores. A lista lê só
arquivo, operação e versão de cada lote, sem as entradas publicadas nem os
resultados (medição da #284). Arquivos ainda
não enviados precisam ser selecionados novamente.

O resultado por arquivo tem tom e texto próprios: "Importado" (incluindo
`DUPLICATE`), "Importado com ressalva" (`ARTIFACT_CONFLICT`), "XML recusado"
(códigos `XML_*`, `NFSE_*`, `COMPANY_MISMATCH`, `IDENTITY_INVALID`…, mesmo com a
operação concluída), "Falha no processamento", "Processamento pausado" ou o
estado em andamento. A mensagem vem em pt-BR e o código fica como "Código para
suporte". O lote diz "Requer atenção" (recusa, falha ou pausa com arquivos
ainda em andamento), "Em andamento", "Parcial" (recusa, falha ou pausa ao lado
de arquivos importados), "Falhou", "Pausada", "Envio não concluído",
"Concluída com ressalva" ou "Concluída"; nunca concluída com arquivo recusado
ou pausado.

O desfecho de cada arquivo é uma regra pura,
`platform/convex/lib/importOutcome.ts`, que o console e o Início
(`consoleHome.summary`) usam (#507). Um lote com arquivo recusado, com falha ou
pausado é uma pendência do Início, uma vez por lote, mesmo com outros arquivos
ainda em andamento; a tela diz "Requer atenção" nesse caso. O Início lê o
código publicado na resposta da operação, sem carregar a versão inteira.

A regra lê o resultado atual do arquivo: o da operação apontada por
`importFiles.processingOperationId`. Um reprocessamento só tira uma recusa das
pendências e da tela se mover esse ponteiro para a sua operação. Isso
acontece em `reprocessArtifact`, `reprocessDocument` e no reprocessamento de
recusas técnicas quando a operação é do projeto do lote; um reprocessamento
em outro projeto, ou sem arquivo de importação, deixa a recusa anterior
visível.

Um lote NFS-e ABRASF importado antes da
[retirada](#lotes-nfs-e-abrasf-retirados) é um arquivo e um desfecho:
`NFSE_BATCH_IMPORTED`, mesmo quando todas as notas voltaram `DUPLICATE` ou
`ARTIFACT_CONFLICT` em `documents[]`. Nesse caso o lote aparece como
importado, e a ressalva fica só nos códigos de cada nota.

`imports.selected` acrescenta, só para o console, a origem do lote, o
processador atual e o `processorVersion` de cada resultado visível; o REST não
muda. "Reprocessar" só aparece para um arquivo importado ou recusado por um
processador anterior: uma recusa do conteúdo com o processador atual repetiria
o resultado, e a tela diz para corrigir e importar de novo. Uma recusa do
leitor (`XML_EVENT_UNSUPPORTED`, `XML_SCHEMA_UNSUPPORTED`) também não oferece
o botão, porque o processador não muda quando o parser muda; a tela aponta
"Reprocessar recusas técnicas" em "Arquivos recusados", no fim da página
([abaixo](#recusas-técnicas-de-um-leitor-anterior)). "Retomar esta
importação" desabilitado diz por quê (nenhum arquivo aguarda envio, falta o XML
original de tal arquivo, cancelamento aguardando resposta, lote de integração), e o aviso sobre "Cancelar uploads pendentes" só
aparece com o botão. Lotes de integração não oferecem envio, retomada,
cancelamento nem reprocessamento; o servidor continua respondendo
`INTEGRATION_RECORD`. Evidência em
console-fluxo-dados.

Na empresa de demonstração, quem envia XML (Operador, Administrador ou
Proprietário) tem "Importar o XML de exemplo" (#510): o navegador busca
`/examples/nfe-demonstracao.xml` no próprio console e o importa pelo mesmo
caminho de um arquivo escolhido (reserva, ticket, `/v1/import-upload`,
confirmação e worker), sem função nova no servidor; uso e limites valem como
em qualquer importação. A ação não aparece em empresa declarada, para papéis
de leitura nem em lote de integração. Com um lote aberto, arquivos escolhidos
ou outra espera (cancelamento, troca de lote), fica desabilitada e diz por quê;
o foco continua no botão. Falha ao buscar o arquivo (erro de rede ou de status,
15 s sem resposta, `Content-Length` ou corpo acima de 2 MiB, ou conteúdo que
não começa por `<?xml`, `<NFe` ou `<nfeProc`) não reserva nada; cada falha é
anunciada de novo, e o mesmo botão tenta outra vez. Sem resposta, o aviso pede
para conferir a conexão; com uma resposta que não é o arquivo, aponta o link
de download. Abrir um lote ou cancelar enquanto o arquivo chega impede a
reserva. Um clique duplo envia uma vez só.

Cada conjunto de arquivos enviado para reserva guarda sua intenção até a
"Nova importação". Se a resposta de uma reserva se perder, reenviar os mesmos
arquivos recupera o mesmo lote, e outros arquivos vão sob uma intenção nova em
vez de receber `IDEMPOTENCY_CONFLICT`; esse código, se vier, pede "Nova
importação". Um lote reservado antes, cuja resposta se perdeu, continua
reservado, e conta no uso, até vencer ou ser cancelado em "Importações
recentes". Repetir o exemplo depois de "Nova importação" cria outro lote, e a
nota já importada volta `DUPLICATE`.
O link "Baixar XML sintético" continua como alternativa. Histórico
por arquivo mostra versões recentes concluídas. A consulta de documentos completa listagem e
consulta documental, itens/JSON, download autorizado e projeção agregada de
eventos. A integração pelo SDK entrega o quickstart integrado. Esta entrega não publica
pacotes, não realiza operação fiscal real e não conclui esses acompanhamentos.

### Consulta pelo DANFE (#296)

"Consultar pelo DANFE", no cabeçalho de Importar XML e de Documentos, e
"Consultar NF-e pelo DANFE", na paleta de comandos de qualquer membro, abrem
`/app/{organizationSlug}/imports/danfe`. A tela não é uma importação: não
reserva lote, não cria documento, operação ou evento, não lê nem grava dados
fiscais nem altera a plataforma; só o layout da organização carrega o contexto
de sempre. A
pessoa digita ou cola a chave de acesso; a tela tira espaços, pontos, hífens,
barras e quebras de linha, passa a maiúsculas e devolve a chave ao campo em
grupos de quatro, para conferência com o DANFE. Nenhum caractere é completado
ou trocado.

A conferência usa `validateAccessKey` de `packages/fiscal-core`, a mesma regra
de chave que `validateIdentity` aplica a um XML importado: 44 posições, CNPJ
alfanumérico nas posições 7 a 18, dígito verificador, modelo 55, código da UF,
mês, número diferente de zero, `tpEmis` e CNPJ ou CPF do emitente. Quando as
14 posições valem como CNPJ e também como `000` seguido de um CPF, a chave não
diz qual é, e a tela mostra "CNPJ ou CPF do emitente" com as duas leituras. Cada recusa
tem mensagem própria, e só a chave válida mostra o resumo "Lido da chave" e o
link "Consultar no Portal da NF-e", que abre em outra aba
`https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&nfe=<chave>`.
O dígito conferir não prova que a nota exista ou esteja autorizada. O
preenchimento da chave pelo parâmetro `nfe` foi observado no ensaio manual
registrado na #296, em 20/10/2026, e não foi ensaiado de novo nesta entrega;
"Copiar chave" cobre o portal que deixar de preenchê-la.

O CAPTCHA e o resultado ficam no portal: nada volta ao console e a situação de
documentos já importados não muda. A tela avisa que o resumo pode ocultar
destinatário e produtos e que a Consulta Completa e o download do XML exigem
certificado no portal. A chave vive só no estado do componente: não entra na
URL do console, em `localStorage`, `sessionStorage`, logs nem analytics. Para
guardar a nota, alguém importa o XML: quem opera documentos recebe o link de
Importar XML; os outros papéis leem que a importação cabe a Operador,
Administrador, Proprietário ou a uma integração. Qualquer membro abre a tela,
porque ela não lê dados fiscais.

"Ler a chave pela foto" lê a chave do código de barras CODE-128 que o DANFE
imprime acima da chave. A pessoa tira uma foto ou escolhe uma imagem, também
arrastando-a para a área; o campo não força a câmera, então o celular oferece
a câmera e a galeria. Antes de decodificar, `image-size.ts` lê largura e
altura no cabeçalho do arquivo (PNG, JPEG com a orientação EXIF, GIF, WebP,
BMP, HEIC/AVIF) e recusa formato desconhecido e imagem acima de 50
megapixels, para que um arquivo pequeno com uma imagem enorme não esgote a
memória. O navegador decodifica direto no tamanho de leitura, no máximo
2560 px no lado maior, por `createImageBitmap` com `resizeWidth` e
`resizeHeight`. O leitor zxing-cpp, compilado em WebAssembly (`zxing-wasm`
3.1.6), procura CODE-128 e QR code e tenta a imagem girada em 90, 180 e 270
graus. O código fica em `danfe-photo.ts`, carregado só quando a pessoa
escolhe a primeira imagem, e o `.wasm` vem de `/assets/` do próprio console.
`apps/console/zxing-plugin.ts` tira do bundle o endereço de CDN que a
biblioteca usaria por padrão e falha o build se um chunk citar uma CDN.
A imagem não sai da aba: nada a envia, grava, registra ou põe na URL, e o
componente não guarda referência a ela depois da leitura. A CSP ganhou
`'wasm-unsafe-eval'` para compilar esse módulo ([PUBLIC.md](PUBLIC.md#csp)).

O resultado segue `danfe-barcode.ts`. Um texto lido só conta como chave com
44 posições de dígitos ou letras maiúsculas, sem corte nem complemento. Uma
chave vai para o campo em grupos de quatro e passa pela mesma conferência da
digitada, com o pedido "Compare com a chave impressa no DANFE" no campo, no
resumo e na região de status; a chave de NFC-e ou com dígito errado recebe a
mesma recusa da digitada. Chaves diferentes na mesma imagem aparecem numa
lista, e a pessoa escolhe uma. Um código com outro tamanho, como o de 36
posições do DANFE em contingência, não preenche o campo e a tela diz quantas
posições ele tem, ou que o código de 44 posições tem caracteres que uma chave
não tem. O QR code só serve para reconhecer o cupom NFC-e: o endereço de
consulta com a chave de modelo 65 em `p=` ou `chNFe=` faz a tela dizer que a
imagem é de uma NFC-e, sem tirar nem preencher a chave; outro QR code é
ignorado. Se a pessoa mexe no campo enquanto a foto é lida, o resultado não o
substitui, e a tela diz que manteve o que foi digitado. Sem código legível, a tela dá dicas de enquadramento, luz e
foco e mantém a digitação. Também há mensagem para arquivo que não é imagem,
mais de uma imagem, imagem acima de 25 MB ou de 50 megapixels, formato que o navegador não abre
(HEIC fora do Safari) e falha do leitor.

A prova usa imagens sintéticas geradas no teste com o escritor do próprio
`zxing-wasm` e `@napi-rs/canvas`: imagem limpa, girada em 90, 180, 270 e
±5 graus, duas chaves, chave de NFC-e num código de barras, QR code de cupom
NFC-e e de outro endereço, código de 10 posições, imagem em branco e barras
cobertas de ruído, sem nenhuma requisição de rede desde o carregamento do
leitor (`danfe-photo.test.ts`). O mesmo arquivo confere o cabeçalho de cada
formato e o limite de pixels. O servidor da instalação própria
(`scripts/lib/selfhost-server.mjs`) serve o `.wasm` como
`application/wasm`. Barras inclinadas além de
poucos graus não leem, porque nenhuma linha atravessa o código inteiro. Fotos
reais de câmera de celular não foram ensaiadas.

## Recusas técnicas de um leitor anterior

Um evento de tipo ainda não aceito (`XML_EVENT_UNSUPPORTED`) ou um leiaute
fora do catálogo (`XML_SCHEMA_UNSUPPORTED`) fica sem documento, com o
original preservado. Quando o parser passa a aceitá-lo, vale a regra decidida
em 26/10/2026 na #395: a interpretação nova substitui a recusa técnica, e as
duas ficam no histórico do artefato (#499).

O gatilho é uma pessoa, por empresa e ambiente: na página de importação,
"Arquivos recusados" oferece "Reprocessar recusas técnicas" a owner, admin e
operator com acesso à empresa. O console pergunta a `refusalReprocess.canRequest`,
que faz a mesma verificação de `refusalReprocess.request`. Viewer, developer,
quem não é membro e outra organização são recusados no servidor. Quem lê os
documentos da empresa (viewer incluído) acompanha o andamento
(`refusalReprocess.canRead`); só quem pode pedir vê o botão. Não há endpoint
REST nem mudança no SDK.

O ambiente é conferido para o propósito `capture-processing`, o mesmo do
processamento do que a captura já recebeu (#420): a tarefa só lê originais
guardados e transforma o que já foi recebido em documento. No sandbox, vale
sempre; em Produção do site, enquanto a liberação da captura da empresa vale e
depois de retirada, nunca numa empresa que nunca foi liberada (a divergência
com a ADR 0007 está registrada nela). A importação não existe em Produção do
site, então lá os originais são capturados. O acompanhamento
(`refusalReprocess.status`) usa `documents:read` e também continua depois da
retirada.

O pedido vira a operação `documents.reprocess_refusals` no projeto do console.
Enquanto a execução da empresa e ambiente está viva, pedir de novo devolve a
mesma execução; senão, o pedido abre uma nova. Viva quer dizer não terminal:
na fila, rodando, aguardando nova tentativa ou reconciliação, ou pausada
enquanto uma pessoa ainda pode retomá-la em Operação e suporte (com as mesmas
condições da retomada: recuperações e tentativas sobrando, ou um efeito
incerto a reconciliar, e a origem ainda autorizada). A execução cuja busca
terminou continua viva enquanto alguma das filhas lidas pela tela (até 200)
está pendente, inclusive uma filha pausada que ainda pode ser retomada.
Concluída sem filha pendente, falha ou pausada sem volta (acesso revogado,
tentativas esgotadas) não é viva. Um
registro por empresa e ambiente (`current:<empresa>:<ambiente>`) aponta a
execução mais recente; o pedido o lê e o reescreve na mesma transação, então
dois pedidos simultâneos não abrem duas execuções. A tela mostra sempre a
execução mais recente.

Cada execução percorre o que, naquele momento, ainda é recusa de um parser
anterior: o executor lê uma página de 50 artefatos sem documento por
tentativa, pelo índice `by_companyId_environment_documentId_importedAt`, e
guarda o cursor e o total na própria operação (`refusalSweep`) na mesma
transação das filhas; uma tentativa perdida retoma do cursor. É candidato o
artefato cuja versão publicada mais recente tem um desses códigos e foi
produzida por outro parser, desde que nenhuma operação viva já cuide dele: a
filha mais recente de qualquer execução, a operação apontada pelo artefato ou
pelo arquivo do lote (como um reprocessamento pedido pelo REST que ainda não
gravou versão), ou a de uma versão ainda não publicada. Uma versão que sobrou
de operação encerrada não segura o original. Assim, uma nova execução só pega
o que sobrou, inclusive o original cuja filha anterior parou sem concluir ou
que estava ocupado por uma operação que depois falhou; e uma execução antiga
retomada à mão não cria filha para um original que a mais nova já processa.

Cada candidato vira uma operação filha, registrada em `idempotencyRecords`
como `<execução>:<artefato>` (uma página repetida não processa o original duas
vezes) e como `latest:<artefato>` (a filha mais recente, que as outras
execuções conferem). O original importado é reprocessado como
`documents.reprocess`; o capturado, como `documents.capture`
([CAPTURE.md](CAPTURE.md)), sem certificado. Num arquivo do lote do console, o
ponteiro `processingOperationId` passa à filha. As filhas começam uma a cada 2
segundos ([OPERATIONS.md](OPERATIONS.md)).

A filha usa o mesmo pipeline da importação: a versão nova, aceita, liga o
evento à NF-e pela chave e cria o documento se ele ainda não existe, como na
ingestão normal; `document.event_received` sai uma vez por original e
fingerprint ([WEBHOOKS.md](WEBHOOKS.md)). A versão recusada continua no
histórico do artefato. A tela mostra o estado persistido: pedido registrado e
busca em andamento, com quantos originais já foram enviados, "Reprocessando:
X de N" e, só com a execução concluída e nenhuma filha pendente, "Concluído",
com quantos entraram no histórico, continuam recusados ou não concluíram. Uma
execução que não achou nada mostra "Nada restou para reprocessar nesta
empresa e ambiente". A busca conta, e guarda com o cursor, os originais que
pulou porque uma operação anterior ainda cuida deles; se ela não enviou nada
mas pulou algum, a tela diz quantos seguem com essa operação e leva a
Operação e suporte, em vez de "Nada restou". A contagem lê até 200 filhas; acima disso aparece como
parcial e nunca como concluída. Uma execução pausada que ainda pode ser
retomada diz isso e leva a Operação e suporte; uma que parou sem volta diz que
um novo pedido abre outra execução. O motivo aparece em português, numa
única região anunciada a leitores de tela, que não muda quando o tom muda.

Limites: a recusa do leitor registra o parser e não o catálogo
(`schema: null`), então a decisão usa só `nfe-parser/N`, e uma troca de
catálogo sem novo parser não reabre essas recusas. Um XML de raiz
desconhecida, recusado com `XML_SCHEMA_UNSUPPORTED`, continua recusado com o
parser novo, mas, se reprocessado, ganha uma versão a mais a cada troca de
parser. No deploy de um parser novo, uma operação que começou com o parser
anterior e ainda não gravou versão não é vista; no pior caso o original ganha
uma versão a mais, e o webhook continua deduplicado por original e
fingerprint.

## Troca de lote e diagnósticos armazenados

Enquanto a navegação para outra importação estiver pendente, o console bloqueia
seleção, envio e controles do lote, inclusive retomada e reprocessamento por
arquivo. Uma URL com lote ainda carregando ou indisponível não permite criar
outra importação implicitamente; a tela informa o estado e permite escolher
outro lote ou iniciar uma nova importação. Falha de navegação apresenta erro,
preserva os XMLs selecionados e a intenção anterior e libera nova tentativa.
Ao sair da tela, uploads em andamento são abortados; respostas tardias de
reserva ou ticket não iniciam outro envio ou confirmação.

Resultados armazenados com JSON inválido, inclusive texto vazio, tanto no
arquivo quanto no histórico de versões, aparecem como diagnóstico textual sem
derrubar a página. Conteúdo semelhante a HTML continua sendo texto. O estado
de processamento permanece o que o servidor informou.

A conferência de #71 e #72 registra
as regressões reproduzidas, a matriz de revogação e os limites da prova local.
