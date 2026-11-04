# Esquemas XML da NF-e

Catálogo dos esquemas do Portal Nacional da NF-e que a plataforma usa, a
decisão sobre cada pacote publicado e o procedimento para perceber um pacote
novo. O pacote `@freecorps/fiscal-nfe` valida offline contra o catálogo em
memória gerado deste manifesto; nada é baixado em tempo de execução
([README do pacote](../../packages/fiscal-nfe/README.md#corpus-xsds-e-provas)).

| Arquivo                                                | O que guarda                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `packages/fiscal-nfe/schemas/manifest.json`            | URL, SHA-256 do ZIP, caminho no ZIP, SHA-256 e encoding de cada XSD fixado     |
| `packages/fiscal-nfe/schemas/portal-survey.json`       | A lista oficial do portal no último levantamento, com a decisão de cada pacote |
| `scripts/fiscal/sync-nfe-schemas.py`                          | Única entrada de XSD: baixa os pacotes revisados e recusa hash diferente       |
| `scripts/fiscal/check-nfe-schemas.mjs` (`bun run xml:portal`) | Compara o portal com o levantamento e, com `--hashes`, os ZIPs fixados         |

## Levantamento de 26/10/2026

Fonte: [lista de esquemas XML](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=),
seção "VERSÕES OFICIAIS (em uso)", lida em 26/10/2026 com 25 pacotes. As
seções "VERSÕES PARA TESTES" e "VERSÕES ANTERIORES (em desuso)" não entram no
levantamento. `bun run xml:portal --hashes` conferiu na mesma data que os sete
pacotes fixados continuam com o SHA-256 do manifesto.

### Pacotes fixados

| Pacote local               | Pacote do portal                                                 | Usado para                                           |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `nfe-4.00-010g`            | PL 010g v1.03, pasta `NFe/`, NT 2026.006 e 2026.008 (26/10/2026) | `NFe` e `nfeProc` 4.00                               |
| `nfe-4.00-010g`            | PL 010g v1.03, dois XSDs da pasta `Evento/` (26/10/2026)         | Detalhe do evento 110300                             |
| `events-1.00-alphanumeric` | PL 010d_v1.03, pasta `Evento/`, CNPJ alfanumérico (10/07/2026)   | Envelope `evento`/`procEventoNFe` 1.00               |
| `rtc-events-1.40`          | Eventos da NT 2025.002 v1.40, RTC (27/07/2026)                   | Detalhe dos eventos 112110 a 112150                  |
| `cancellation-1.01`        | Evento Cancelamento (21/12/2018)                                 | Detalhe do 110111                                    |
| `correction-1.01`          | Evento CC-e v1.01 (30/05/2014)                                   | Detalhe do 110110                                    |
| `manifestation-1.01`       | Evento Manifestação do Destinatário v1.01 (30/05/2014)           | Detalhe de 210200, 210210, 210220 e 210240           |
| `distribution-1.04`        | Distribuição de DF-e v1.04 (03/07/2026)                          | `distDFeInt`, `retDistDFeInt`, `resNFe`, `resEvento` |

O envelope de eventos vinha do PL 010d_v1.01 (08/06/2026). No 010d_v1.03, os
arquivos da pasta `Evento/` têm os mesmos bytes, exceto `tiposBasico_v1.03.xsd`,
que perdeu o histórico em comentário e mudou o texto de uma documentação
(`TCnpjVar`). Os tipos, padrões e elementos são os mesmos: a comparação dos dois
XSDs sem comentários e anotações dá igualdade. Os eventos já aceitos validam
igual e mantêm o fingerprint da evidência fiscal. Fora da pasta `Evento/`, o
pacote traz o leiaute da NF-e com o padrão do QR Code da NFC-e para CNPJ
alfanumérico, que o PL 010f já tinha e o PL 010g mantém, e o cadastro CCC sem mudança; por
isso só a pasta `Evento/` entra.

Da pasta `Evento/` do PL 010g entram só `e110300_v1.00.xsd` e o
`tiposBasico_v1.03.xsd` que ele inclui, gravados em `nfe-4.00-010g/` ao lado dos
XSDs de `NFe/`, sem colisão de nome. Esse `tiposBasico_v1.03.xsd` difere das
outras cópias fixadas: entre outras diferenças, acrescenta `TCnpjBase` (oito
posições), usado em `CNPJBasePSP`; cada detalhe de evento inclui o `tiposBasico` da própria pasta,
então os eventos já aceitos continuam validados como antes. O envelope
`evento`/`procEventoNFe` do 110300 é o mesmo dos outros eventos
(`events-1.00-alphanumeric`): a pasta não traz envelope próprio. O
`e110001_v1.00.xsd` da mesma pasta fica de fora, porque o cancelamento de
evento continua sem suporte (abaixo). O ZIP é o mesmo já fixado, então o
manifesto continua com sete pacotes e o mesmo SHA-256; muda o catálogo
(`catalogSha256` `4ffaa6…`, mesma política decimal).

O ZIP dos eventos RTC publica `e112120_v1.00 .xsd`, com espaço antes da
extensão. O sincronizador grava o arquivo como `e112120_v1.00.xsd`, com os
bytes intactos, e o manifesto conserva o nome original em `archivePath`.

### Decisão por item da #389

| Item                                                           | Decisão | Motivo                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eventos da Reforma Tributária (NT 2025.002 v1.40)              | Trazer  | Pacote no manifesto. Os cinco eventos do fornecedor que tratam da operação do comprador passam a ser aceitos; os demais tipos do pacote ficam adiados (tabela abaixo).                                                                                                                                                                                                |
| PL 010d_v1.03                                                  | Trazer  | Substitui o 010d_v1.01 como origem do envelope de eventos. Sem mudança de validação nos eventos aceitos (comparação acima).                                                                                                                                                                                                                                           |
| Averbação para exportação v1.01 (790700)                       | Adiar   | Evento da RFB sobre a exportação, de interesse do exportador. A captura recebe como destinatário, e o destinatário de uma exportação está fora do país.                                                                                                                                                                                                               |
| Conciliação Financeira (110750, 110751)                        | Adiar   | Sem evidência de que a distribuição a entregue ao destinatário (ver "Prioridade" abaixo).                                                                                                                                                                                                                                                                             |
| Insucesso na Entrega (110192, 110193)                          | Adiar   | Idem; evento logístico do emitente, sem efeito na situação da nota.                                                                                                                                                                                                                                                                                                   |
| Comprovante de Entrega (110130, 110131)                        | Adiar   | Idem; o par evento/cancelamento pede o vínculo entre eventos que a plataforma ainda não modela.                                                                                                                                                                                                                                                                       |
| Ator Interessado, transportador (110150)                       | Adiar   | Concede acesso ao XML a um transportador; não descreve a operação do destinatário.                                                                                                                                                                                                                                                                                    |
| EPEC (110140)                                                  | Adiar   | Contingência do emitente. A NF-e autorizada depois chega com o próprio protocolo, que é o que muda a situação aqui.                                                                                                                                                                                                                                                   |
| Suframa, vistoria e internalização (990900, 990910)            | Adiar   | Eventos do fisco para mercadoria destinada à Zona Franca; sem demanda das empresas cadastradas.                                                                                                                                                                                                                                                                       |
| Prorrogação de remessa para industrialização (111500 a 411503) | Adiar   | Pedido do emitente e resposta do fisco sobre suspensão do ICMS; não entra na captura de uma compradora.                                                                                                                                                                                                                                                               |
| Leiautes anteriores (PL 009x, versão 3.10)                     | Adiar   | A captura só alcança 90 dias, então recebe o leiaute vigente. Validar XML antigo exige escolher o pacote pela data de emissão e manter catálogos paralelos, o que muda o modelo de versões do processamento. A 4.00 continua validada contra o pacote fixado; 3.10 e anteriores seguem `XML_SCHEMA_UNSUPPORTED`. Volta à pauta com um pedido de importação de acervo. |
| Consulta GTIN, Consulta Situação                               | Excluir | São serviços de consulta, não documentos nem eventos recebidos.                                                                                                                                                                                                                                                                                                       |
| NFC-e (modelo 65), EPEC NFC-e e Cancelamento por Substituição  | Excluir | A plataforma 1.0 trata NF-e modelo 55.                                                                                                                                                                                                                                                                                                                                |

**Prioridade.** A rodada real de 22/10/2026
recebeu como destinatário 25 `resEvento` e um `procEventoNFe`, mas o recibo
sanitizado guarda só o schema de cada envelope, sem o tipo do evento. Por isso
a escolha dos eventos aceitos vem do autor declarado em cada XSD (`tpAutor`),
não de uma contagem observada. Gravar o `tpEvento` de cada envelope e levá-lo
ao recibo, sem dado de contribuinte, é o que decide o próximo evento a aceitar
(#500).

### Outros pacotes da lista oficial

| Pacote do portal                                      | Decisão     | Motivo                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PL 010g v1.03, NT 2026.006 e NT 2026.008 (26/10/2026) | Incorporado | Fixado pela #395 como `nfe-4.00-010g`, pasta `NFe/`. Da pasta `Evento/`, entram pela #405 o `e110300` (Vinculação Pagamento) e o `tiposBasico_v1.03.xsd` que ele inclui; o `e110001` novo (inclui 110300 entre os eventos cancelados) não entra. |
| PL 010f (31/08/2026)                                  | Excluir     | Substituído pelo PL 010g na #395; documentos já gravados conservam o catálogo antigo em `catalogSha256`.                                                                                                                                         |
| PL 010e_v1.02 (10/07/2026)                            | Excluir     | Leiaute da NF-e anterior ao PL 010f.                                                                                                                                                                                                             |
| PL 010d_v1.01 (08/06/2026)                            | Excluir     | Substituído pelo 010d_v1.03 neste levantamento.                                                                                                                                                                                                  |
| Evento Canc v1.01 (30/05/2014)                        | Excluir     | Substituído pelo Evento Cancelamento de 21/12/2018, fixado.                                                                                                                                                                                      |
| Evento Genérico v1.01 (30/05/2014)                    | Excluir     | Envelope antigo, substituído pelo do 010d.                                                                                                                                                                                                       |

`portal-survey.json` registra a decisão de cada um dos 25 pacotes.

## Eventos aceitos

Um evento só é aceito com parser, normalização, efeito no documento, fixture
sintética e teste. Os outros tipos retornam `XML_EVENT_UNSUPPORTED` em
`evento`, `procEventoNFe` e `resEvento`; o original fica preservado, fora do
histórico de um documento.

| Tipo   | Evento                                                                                | Detalhe validado contra | Efeito na situação relatada   |
| ------ | ------------------------------------------------------------------------------------- | ----------------------- | ----------------------------- |
| 110111 | Cancelamento                                                                          | `cancellation-1.01`     | Aceito (135/155): `cancelled` |
| 110110 | Carta de Correção                                                                     | `correction-1.01`       | Nenhum; entra no histórico    |
| 210200 | Confirmação da Operação                                                               | `manifestation-1.01`    | Nenhum; entra no histórico    |
| 210210 | Ciência da Operação                                                                   | `manifestation-1.01`    | Nenhum; entra no histórico    |
| 210220 | Desconhecimento da Operação                                                           | `manifestation-1.01`    | Nenhum; entra no histórico    |
| 210240 | Operação não Realizada                                                                | `manifestation-1.01`    | Nenhum; entra no histórico    |
| 112110 | Informação de efetivo pagamento integral para liberar crédito presumido do adquirente | `rtc-events-1.40`       | Nenhum; entra no histórico    |
| 112120 | Importação em ALC/ZFM não convertida em isenção                                       | `rtc-events-1.40`       | Nenhum; entra no histórico    |
| 112130 | Perecimento, perda, roubo ou furto durante o transporte contratado pelo fornecedor    | `rtc-events-1.40`       | Nenhum; entra no histórico    |
| 112140 | Fornecimento não realizado com pagamento antecipado                                   | `rtc-events-1.40`       | Nenhum; entra no histórico    |
| 112150 | Atualização da Data de Previsão de Entrega                                            | `rtc-events-1.40`       | Nenhum; entra no histórico    |
| 110300 | Vinculação Pagamento                                                                  | `nfe-4.00-010g`         | Nenhum; entra no histórico    |

Os eventos RTC aceitos são os do fornecedor (`tpAutor` 1 no XSD) sobre a
operação do comprador. O documento os mostra como os outros eventos: tipo,
descrição oficial (`descEvento`), autor, sequência, instante, ambiente e
recibo, com o webhook `document.event_received`. Os campos próprios de cada
evento (itens, valores de IBS e CBS, quantidades, data prevista de entrega)
ficam no XML original e aparecem em `unsupportedFields`; não há campo tipado
para eles no contrato. O resumo `resEvento` desses tipos também é aceito.

### Vinculação Pagamento (110300)

O evento 110300, "Evento de Vinculação da Transação de Pagamento no DF-e" (NT
2026.006 v1.00, seção 4), é aceito desde o `nfe-parser/7`. Só o emitente da
NF-e o registra (`tpAutor` 1 no XSD), com `cOrgaoAutor`, `tpAutor`, `verAplic`,
o protocolo de autorização da NF-e (`nProt`) e um grupo `gPgto` com
`idTransacao`, `tpMeioPgto`, `CNPJReceb` e `CNPJBasePSP`. A NT prevê
homologação em 05/10/2026 e produção em 03/11/2026 (NT 2026.006 v1.00,
[arquivo do portal](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=k7zG06n5M6I%3D),
SHA-256 `47a65abde315fed1e6a8c6085a67ca483935cb57877ae5715d365377a725e05d`).

"Só o emitente" vale em duas etapas: o XSD exige `tpAutor` 1, e a etapa de
identidade compara o CNPJ do autor com o emitente da chave de acesso (regra
abaixo, desde o `nfe-parser/8`).

Ele entra no histórico da NF-e pela chave de acesso, como os eventos RTC, com
`document.event_received`, e o `resEvento` desse tipo também é aceito. O
detalhe é validado contra o `e110300_v1.00.xsd`: outro `tpAutor`, um detalhe
sem `gPgto` ou fora dos formatos do XSD recusa a etapa XSD, e a situação
relatada o exclui como falha técnica. Mesmo recusado no XSD, o evento completo
entra no histórico e dispara `document.event_received`, como qualquer evento
(o `resEvento` não dispara esse webhook). O webhook avisa que há uma evidência
nova, não que ela vale, e sai antes de a situação ser recalculada. Antes de
agir, consulte o documento quando `summary.projectionState` for `ready`, ou
depois do `document.updated` que a projeção envia ao concluir com a situação
alterada; enquanto a projeção está `pending`, a API devolve
`fiscalSituation: null`. Então procure o `sha256` da versão do evento em
`fiscalSituation.excluded`: um 110300 válido aparece com
`EVENT_DOES_NOT_CHANGE_FISCAL_STATUS`, e um recusado no XSD, com
`TECHNICAL_VALIDATION_FAILED`. Em nenhum caso o evento quer dizer pagamento
confirmado. Os campos do detalhe, inclusive o `nProt`, ficam no XML original e em `unsupportedFields`; o contrato não ganha
campo tipado para eles.

Ler um 110300 não confirma pagamento nem liquidação de tributo. O evento é a
declaração do emitente de que a NF-e se vincula a uma transação de pagamento;
a plataforma não confere a transação com a instituição, o recebedor ou o
valor, e o evento não muda a situação relatada. O mesmo vale para o grupo
`gPgtoVinc` da própria NF-e ([DOCUMENTS.md](DOCUMENTS.md#vinculação-com-a-transação-de-pagamento-nt-2026006)).

Limites do 110300:

- O emitente o cancela pelo evento genérico 110001 (Cancelamento de Evento),
  que continua `XML_EVENT_UNSUPPORTED`. Um 110300 cancelado continua no
  histórico como se valesse; o original do 110001 fica preservado, fora do
  documento.
- Não há fonte oficial que diga se a distribuição (NFeDistribuicaoDFe) entrega
  o 110300 ao destinatário. A captura o aceita se ele chegar, mas a entrega não
  foi observada.
- A fixture é sintética, com CNPJs fictícios e o certificado do corpus.

### Autor dos eventos do emitente

Desde o `nfe-parser/8` (#532), a etapa de identidade confere o autor dos
eventos que só o emitente registra: cancelamento 110111, CC-e 110110, os
eventos RTC 112110 a 112150 e a Vinculação Pagamento 110300. O `CNPJ` (ou
`CPF`) de `infEvento` precisa ser o emitente da chave (`chNFe`, posições 7 a
20; um CPF ocupa as 11 últimas, depois de `000`). É a regra da SEFAZ, que
recusa outro autor com a rejeição 574 ("O autor do evento diverge do emissor
da NF-e"), comparando o documento inteiro, não a raiz do CNPJ. As
manifestações 210200 a 210240 são do destinatário, que a chave não traz, e
continuam sem essa comparação.

A conferência vale para `evento`, para `procEventoNFe` registrado (`cStat`
135, 136 ou 155) e para `resEvento`, cópia da distribuição de um evento
registrado. Um `procEventoNFe` com retorno de rejeição não passa por ela: o
retorno já é o fisco recusando o evento, e a situação o exclui como evento que
não muda a nota (`EVENT_DOES_NOT_CHANGE_FISCAL_STATUS`).

O desfecho de uma divergência é recusa técnica, `NFE_EVENT_AUTHOR_NOT_ISSUER`
na etapa de identidade, mesmo com o XSD aceito. A importação e a captura
gravam a versão com `IDENTITY_INVALID`, fora do histórico da NF-e, e
preservam o original como artefato, listado e baixável como qualquer recusa;
o evento não dispara `document.event_received`. Um cancelamento assinado por
outro CNPJ, ainda que com retorno 135, não cancela a nota.

A etapa de identidade faz parte do fingerprint da evidência fiscal, então a
divergência o altera. Um evento já aceito por um parser anterior continua
como estava até ser reprocessado; reprocessá-lo grava a versão nova ao lado
da antiga, e a reconstrução da situação, que vê duas interpretações dos
mesmos bytes, marca `PROCESSING_DISAGREEMENT` em vez de manter o efeito do
evento. As fixtures (`event-*-other-author`) são sintéticas, com CNPJs
fictícios.

### Retorno com descrição longa

O `xEvento` do retorno e do `resEvento` tem até 60 caracteres, e as descrições
oficiais de 112110 e 112130 são mais longas. O que a SEFAZ envia nesse campo
não foi observado. O resumo mostra o texto recebido; as fixtures sintéticas
desses dois eventos omitem `xEvento` do retorno, que é opcional.

### Tipos do pacote RTC que continuam sem suporte

| Tipo                                           | Autor no XSD   | Motivo                                                                                                                                                                                           |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 110001 Cancelamento de Evento                  | Sem `tpAutor`  | Cancela outro evento. Sem o vínculo entre os dois no histórico, o evento cancelado continuaria parecendo vigente. O PL 010g de 26/10/2026 republicou este XSD, com o 110300; ele não foi fixado. |
| 211110, 211124, 211128, 211130, 211140, 211150 | Adquirente (2) | Pedidos e declarações da própria empresa. Registrá-los é emitir evento, fora da 1.0; o recebimento da cópia pela distribuição não foi observado.                                                 |
| 212110, 212120                                 | Sucessora (8)  | Transferência de crédito em sucessão, fora da compra e venda.                                                                                                                                    |
| 412120, 412130                                 | Fisco (5)      | Resposta do fisco à transferência em sucessão.                                                                                                                                                   |

Eventos do fisco que a distribuição entrega como `resEvento` sem pacote no
portal (por exemplo, os da série 610, vinculação de CT-e e MDF-e) não fazem
parte da lista do portal e continuam sem suporte; dependem da contagem por
tipo descrita em "Prioridade".

## Acompanhar o portal

Não há tarefa agendada. A conferência roda à mão, só lendo o portal:

1. Rode `bun run xml:portal --hashes` antes de cada release, ao saber de uma
   NT nova e ao começar trabalho em XML da NF-e. Saída 0 quer dizer que a lista
   oficial e os sete ZIPs fixados são os do levantamento.
2. Saída 1 lista cada diferença: pacote novo, título trocado, pacote retirado
   da lista oficial, ZIP fixado com outro SHA-256 ou pacote fixado sem decisão.
   Saída 2 quer dizer que a página não foi lida; repita depois e não registre
   levantamento.
3. Para cada diferença, decida trazer, adiar ou excluir e registre aqui, com a
   data. Um pacote trazido entra em `SOURCES` e `PINNED` de
   `scripts/fiscal/sync-nfe-schemas.py`, depois de baixado e revisado; rode
   `python scripts/fiscal/sync-nfe-schemas.py --download` e confira o diff de
   `manifest.json`, `schemas.json` e `schema-policy.json`.
4. Atualize `portal-survey.json` (data, títulos e decisões). O teste
   `scripts/fiscal/nfe-portal.test.ts` recusa pacote fixado sem decisão.

`--page <arquivo>` compara um HTML salvo da lista, sem rede; serve para
reproduzir uma conferência.

## Limites

- As fixtures dos eventos RTC e do 110300 são sintéticas, com o certificado do corpus. A
  validação prova o leiaute publicado, não a aceitação pela SEFAZ nem o que a
  distribuição entrega de fato.
- Um evento recusado com `XML_EVENT_UNSUPPORTED`, por importação ou captura,
  conserva o original: bytes no storage, SHA-256 no artefato (e no envelope da
  captura), listagem em `GET /v1/document-artifacts` e download em
  `/original`. Ele não pertence a um documento, então o reprocessamento de
  documento não o alcança. Quando o tipo passa a ser aceito, "Reprocessar
  recusas técnicas" (console, por empresa e ambiente, #499) reprocessa as
  recusas `XML_EVENT_UNSUPPORTED` e `XML_SCHEMA_UNSUPPORTED` de um parser
  anterior: a interpretação nova substitui a recusa e as duas ficam no
  histórico (regra da #395). A recusa não registra catálogo, então só um novo
  `PARSER_VERSION` as reabre; regras em
  [IMPORTS.md](IMPORTS.md#recusas-técnicas-de-um-leitor-anterior).
  Um 110300 recusado antes do `nfe-parser/7` fica recusado e preservado até
  esse pedido; importar os mesmos bytes de novo cria outro artefato, aceito e
  ligado à NF-e.
- A troca do catálogo muda `catalogSha256` nos metadados de processamento. O
  fingerprint da evidência fiscal não usa esse hash.
