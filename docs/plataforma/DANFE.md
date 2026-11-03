# DANFE da NF-e

O DANFE é a representação auxiliar da NF-e modelo 55. Ele não é a nota e não
a substitui: o documento fiscal é o XML assinado e autorizado, que a
plataforma continua preservando como original ([DOCUMENTS.md](DOCUMENTS.md),
[RETENTION.md](RETENTION.md)). O gerador lê esse XML e produz um PDF; não
altera nem regrava o original.

Este documento descreve o gerador de `@freecorps/fiscal-nfe/danfe` (#402) e
sua entrega: `GET /v1/documents/{id}/danfe`, `client.downloadDanfe(...)` no
SDK e o botão "Baixar DANFE (PDF)" no documento do console
([Entrega](#entrega)).

## Uso

```ts
import { DANFE_GENERATOR_VERSION, renderDanfe } from "@freecorps/fiscal-nfe/danfe";

const pdf: Uint8Array = await renderDanfe(xmlOriginal, {
  // Opcional: até 20 procEventoNFe preservados para a mesma chave, como recebidos.
  events: [procEventoCancelamento],
  // Obrigatório com eventos e recusado sem eles: de onde vieram, até 200 caracteres.
  origin: "evento preservado pela plataforma, sem consulta ao fisco",
});
```

`xmlOriginal` é o XML preservado, `NFe` ou `nfeProc`, como texto ou como os
bytes guardados; com bytes, é exatamente o que a verificação recebe. A autorização só vem
do `protNFe` dentro do `nfeProc`: o pacote não lê protocolo avulso, e a
importação também não lê.

O subpath `./danfe` é separado da entrada principal para que quem só faz
parsing não carregue o `pdf-lib`. O pacote passou a declarar `pdf-lib@1.17.1`,
a mesma versão do `fiscal-nfse`.

A função é pura e determinística. O mesmo XML e os mesmos eventos produzem os
mesmos bytes: o PDF não tem data de criação nem produtor, e o gerador não
consulta o relógio. `DANFE_GENERATOR_VERSION` (hoje `"4"`) muda sempre que o
mesmo conjunto de entradas passar a produzir outro PDF. A chave de cache da
entrega combina essa versão com o hash do XML, dos eventos e da origem.

Entrada recusada lança `NfeError`:

| Código                    | Quando                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Erros de `decodeXml`      | XML acima dos limites do pacote, com DOCTYPE, fora de UTF-8 ou malformado                                                                                     |
| `DANFE_MODEL_UNSUPPORTED` | `mod` diferente de 55 (NFC-e e outros modelos)                                                                                                                |
| `DANFE_XML_INVALID`       | Raiz que não é `NFe` nem `nfeProc`, chave com dígito errado, `tpAmb` ausente ou valor que não é decimal exato (`field`)                                       |
| `DANFE_EVIDENCE_INVALID`  | Mais de 20 eventos; item que não é `procEventoNFe` legível; evento de outra chave (`chNFe`); `origin` vazia, acima de 200 caracteres ou sem eventos (`field`) |
| `DANFE_LAYOUT_OVERFLOW`   | Uma folha não comporta três linhas de item ou uma linha de continuação; com a origem limitada, não deve ocorrer                                               |

## Entrega

A plataforma gera o DANFE de uma NF-e 55 que ela guarda na primeira vez que
alguém o pede e guarda o PDF como cache. Acesso, cache, origem e limites estão
em [DOCUMENTS.md](DOCUMENTS.md#danfe). Em resumo:

- só a versão publicada com XML completo de NF-e 55 tem DANFE; o resto
  responde `DANFE_UNAVAILABLE` (409);
- eventos: os `procEventoNFe` de cancelamento ligados ao documento, com a
  origem "evento de cancelamento preservado na plataforma, sem consulta ao
  fisco";
- chave do cache: `DANFE_GENERATOR_VERSION`, SHA-256 do XML e SHA-256 do
  conjunto ordenado de eventos com a origem. A cópia da versão em
  `platform/convex/lib/danfeValues.ts` é presa ao pacote por teste;
- o original não muda; o PDF é refeito dele quando a chave muda.

A prova da entrega está em `tests/platform.danfe.test.ts`, com o corpus
sintético: PDF autorizado, cache, cancelamento importado depois, troca de
versão, nota sem autorização, recusa do gerador gravada e respondida sem gerar
de novo, original ausente, geração antiga descartada, as três corridas que
respondem 503, auditoria `http.danfeDownload`, recusas por escopo, chave
revogada, concessão, outra organização, outra empresa da mesma organização,
ambiente e Produção no sandbox, cancelamento da mesma chave numa empresa de
outra organização ou em outro ambiente ignorado, limite de gerações, ticket do console (dono, `viewer`
com e sem concessão, login sem vínculo, ticket vencido) e expurgo.

## Leiaute atendido

Um único leiaute: A4 retrato do modelo de referência da NT 2026.010 v1.00
("DANFE - Modelo55 - Vertical"), que mantém os quadros do MOC e acrescenta os
campos da Reforma Tributária. Os campos que dependem do XML só são preenchidos
quando a tag existe, como a NT determina no item 4.4.

Na folha 1, de cima para baixo:

1. Canhoto com "RECEBEMOS DE...", data de recebimento, assinatura, número e
   série, separado por linha tracejada.
2. Emitente; DANFE com 0 - ENTRADA / 1 - SAÍDA, número em grupos de três,
   série e FOLHA N/M; código de barras, chave em 11 grupos de 4 e o texto de
   consulta no portal nacional.
3. Marcas de situação, quando houver (seção seguinte).
4. Natureza da operação e protocolo de autorização de uso.
5. Inscrição estadual, IE do substituto, CNPJ/CPF, código do regime
   tributário e o campo reservado ao tipo de regime de apuração do IBS e da
   CBS, impresso vazio porque a NT ainda não definiu a tag.
6. Destinatário/remetente, com emissão, saída/entrada e hora como estão no
   XML, sem conversão de fuso.
7. Fatura e até seis duplicatas, só quando o XML tem `cobr`.
8. Total dos produtos e da nota; total do ICMS/IPI, com FCP, DIFAL e ICMS
   monofásico só quando as tags existem.
9. Total do IBS/CBS/IS, quando o XML tem `IBSCBSTot` ou `ISTot`; os quatro
   valores de monofasia só com `gMono`.
10. Cálculo do ISSQN, quando o XML tem `ISSQNtot`.
11. Transportador e até dois volumes (`vol`).
12. Produtos e serviços nas colunas da NT 2026.010: descrição com código,
    `infAdProd`, NCM e `cClassTrib`; CST (origem + CST ou CSOSN) e CFOP;
    quantidade e unidade; valor unitário; valor total; bases, alíquotas e
    valores por tributo (ICMS, IBS/CBS, IS e IPI, cada um só quando o grupo
    existe no item). Base, alíquota e valor de cada tributo ficam na mesma
    linha; a base única do IBS/CBS fica na linha da CBS.
13. Dados adicionais: informações complementares e "Reservado ao fisco".

Quando o item tem `gRed`, as alíquotas de IBS UF, IBS Município e CBS
impressas são a `pAliqEfet`; sem `gRed`, a alíquota vigente (`pIBSUF`,
`pIBSMun`, `pCBS`). O IS usa `pIS`. É a regra do item 4.3 da NT.

As folhas seguintes repetem emitente, chave, código de barras, natureza,
protocolo, inscrições e o cabeçalho da tabela de produtos, com FOLHA N/M.
Um item não é dividido entre folhas, salvo se for maior que uma folha
inteira.

Os quadros variáveis da folha 1 têm limite: até seis duplicatas e até dois
volumes. O título do quadro diz quantos foram mostrados ("6 de 120") e onde
estão os demais. Depois do último item seguem, nesta ordem, "FATURA /
DUPLICATAS (CONTINUAÇÃO)", "VOLUMES TRANSPORTADOS (CONTINUAÇÃO)" e "DADOS
ADICIONAIS (CONTINUAÇÃO)", com o texto de `infCpl` e `infAdFisco` que não
coube no quadro da folha 1. Nenhum dado desses grupos é descartado.

### Valores e textos

Valores saem do texto decimal do XML, conferidos por `decimal` do
`fiscal-core`, com todas as casas declaradas: `50.0000000001` vira
`50,0000000001`, sem arredondamento e sem ponto flutuante. O separador de
milhar é ponto. Datas e horas são recortadas do texto do XML.

CNPJ alfanumérico aparece no formato `12.ABC.345/01DE-35` e entra na chave e
no código de barras. As fontes são Helvetica e Helvetica Bold do PDF; um
caractere fora do WinAnsi vira "?". Data fora do calendário, como 30/02, sai
como está no XML, sem reformatação.

Alguns textos têm espaço fixo e podem terminar em "…":

- Campo de quadro: o valor diminui de corpo até 4,5 pt e quebra em duas
  linhas; se ainda faltar espaço, a segunda linha termina em "…".
- Nome do emitente: até três linhas a 10 pt.
- Endereço do emitente: o corpo cai de 7 pt até 5 pt para caber no quadro de
  112 pt; se ainda faltar espaço, a última linha que cabe termina em "…".
- Canhoto ("RECEBEMOS DE ..."): duas linhas.

Com os tamanhos máximos do XSD (`xNome` e `xLgr` com 60 caracteres), o
emitente cabe sem corte. Descrição, `infAdProd`, duplicatas, volumes e dados
adicionais não são cortados.

### Código de barras

CODE-128 desenhado em retângulos vetoriais, com zona de silêncio de 10
módulos de cada lado e 32 pt (1,13 cm) de altura. A chave numérica sai inteira
no conjunto C: início C (105), 22 pares, dígito verificador módulo 103 e
parada. A chave com CNPJ alfanumérico segue o modelo híbrido da NT Conjunta
2025.001, seção 6: começa em C, troca para A (código 101) antes das letras e
volta para C (código 99) em sequências de quatro dígitos ou mais. O teste
reproduz o exemplo da NT (`5225AB83`, dígito 30).

As larguras dos símbolos seguem a tabela padrão do CODE-128. A tabela impressa
na NT 2025.001 tem larguras trocadas e não foi usada.

## Situação e marcas

O DANFE não apresenta como autorizado um XML sem autorização comprovada. A
nota e os eventos passam por `processNfe`, o mesmo processamento da
importação, e a situação vem de `deriveFiscalSituation`. O gerador acrescenta
só as três regras de vínculo descritas adiante. Para a nota contar como
autorizada, tudo isto precisa passar:

- o XSD do pacote;
- a identidade: chave, protocolo da mesma chave e do mesmo ambiente, `nProt`,
  `dhRecbto` e `digVal` presentes num protocolo 100 ou 150, um único
  `DigestValue` e `digVal` igual a ele, com espaços ignorados;
- a assinatura XML, conferida com o certificado embutido. Um XML editado
  depois de autorizado falha aqui, mesmo que mantenha o `DigestValue`.

A cadeia ICP-Brasil do certificado e a validade na data não são conferidas,
como na importação. O gerador não consulta o fisco.

Os eventos seguem as mesmas regras: só conta o cancelamento 110111 com retorno
135 ou 155, com tipo, sequência, `Id`, `nProt` e `dhRegEvento` conferidos e
assinatura válida. Retorno 136, evento rejeitado ou de outro tipo não muda a
situação.

Regras de vínculo do próprio DANFE. Elas existem porque a nota não comprovada
fica fora de `deriveFiscalSituation` e, sem elas, não ancoraria chave nem
ambiente. A chave e o ambiente da nota são lidos do XML mesmo quando ela não
foi comprovada.

1. Evento de outra chave é recusado com `DANFE_EVIDENCE_INVALID`: é evidência
   de outra nota e não pode marcar esta como cancelada.
2. Evento que contaria na derivação (todas as verificações aprovadas e retorno
   135 ou 155, como na importação) e é de outro ambiente gera o conflito
   `ENVIRONMENT_MISMATCH`, com a nota comprovada ou não. Os demais códigos de
   conflito da derivação aparecem junto. Evento de outro ambiente que não
   contaria (rejeitado, 136, assinatura inválida) é ignorado, como os do mesmo
   ambiente.
3. Com mais de um cancelamento registrado, em sequências diferentes, o
   impresso é o de menor `nSeqEvento`, depois `dhRegEvento` e `nProt`; a
   ordem dos eventos na chamada não muda o PDF.

| Situação                                                                                                       | O que o PDF mostra                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autorizada                                                                                                     | Número e data do protocolo, sem marca                                                                                                                                         |
| Sem protocolo, verificação reprovada ou `cStat` que não autoriza                                               | "SEM VALOR FISCAL - documento não autorizado: motivo", com o código da verificação; marca "SEM VALOR FISCAL"; "NÃO AUTORIZADA - SEM PROTOCOLO VÁLIDO"                         |
| Denegada (110, 301, 302 ou 303)                                                                                | "NF-e DENEGADA - uso denegado pelo fisco (cStat ...). SEM VALOR FISCAL."; marca "NF-e DENEGADA"; "DENEGADA - protocolo" no campo do protocolo                                 |
| Cancelamento registrado sobre autorização comprovada                                                           | "NF-e CANCELADA - evento ... protocolo ... em data. Origem da informação: texto do chamador."; marca "NF-e CANCELADA"                                                         |
| Cancelamento registrado sem autorização comprovada                                                             | A linha de cancelamento e "SEM VALOR FISCAL - autorização da NF-e não comprovada: motivo"                                                                                     |
| Conflito: evento registrado de outro ambiente (regra 2), outro protocolo no cancelamento, denegada e cancelada | "SEM VALOR FISCAL - evidências fiscais em conflito: códigos de `deriveFiscalSituation` e, pela regra 2, `ENVIRONMENT_MISMATCH`"; "SITUAÇÃO EM CONFLITO" no campo do protocolo |
| `tpAmb` 2                                                                                                      | "SEM VALOR FISCAL - NF-e emitida em ambiente de homologação."; marca diagonal; o mesmo aviso nos dados adicionais                                                             |
| `tpEmis` diferente de 1                                                                                        | "Emitida em contingência ..." nos dados adicionais                                                                                                                            |

As marcas aparecem em todas as folhas.

## Não atendido

- DANFE paisagem (`tpImp` 2), o leiaute alternativo da NT 2026.010.
- DANFE Simplificado, inclusive o Tipo 2 da NT 2026.002, e a etiqueta.
- DANFE NFC-e (modelo 65): recusado com `DANFE_MODEL_UNSUPPORTED`.
- Regras próprias de contingência além da indicação nos dados adicionais: o
  segundo código de barras do FS-DA e os textos de EPEC do MOC.
- QR Code do grupo `infNFeSupl`: a NT 2026.010, item 4.5, deixa a regra para
  uma NT futura. O quadro não é impresso.
- Campos que a NT 2026.010 não lista no quadro de totais, como valor do II,
  valor aproximado dos tributos e `vNFTot`.

## Fontes e suposições

Fontes conferidas em 31/10/2026, baixadas do portal nacional:

- NT 2026.010 v1.00 (DANFE com IBS, CBS e IS; produção em 01/12/2026): lida
  na íntegra, incluindo os dois modelos de referência.
- NT Conjunta 2025.001 v1.00 (CNPJ alfanumérico), seção 6: código de barras.
- O link de MOC 7.0 da #402 abre o "Visão Geral" (150 páginas), não o Anexo
  II. Dele se confirmou que o DANFE é documento auxiliar e não substitui a
  NF-e (item 2.2.4) e que o Anexo II especifica DANFE e código de barras.

O Anexo II, Manual de Especificações Técnicas do DANFE e Código de Barras, não
foi localizado no portal. Sem ele, estas escolhas são suposições:

- Margem de 14 pt (cerca de 5 mm), fonte Helvetica e corpos de 4,5 a 14 pt.
- Textos das marcas de situação e do campo de protocolo sem autorização.
- Repetição dos quadros de cabeçalho nas folhas seguintes e continuação dos
  dados adicionais depois do último item.
- `infAdFisco` impresso nas informações complementares, com o prefixo
  "Inf. ao fisco:", e o quadro "Reservado ao fisco" em branco.
- Limites da folha 1 para duplicatas (seis) e volumes (dois) e a ordem das
  seções de continuação.

Pendente: a largura do código de barras. Ele ocupa 8,1 cm no quadro da
direita, com módulo entre 0,021 cm e 0,027 cm. A NT 2025.001 pede módulo
mínimo de 0,02 cm, atendido, e cita "largura mínima total" de 11,5 cm, que não
cabe no quadro do modelo da NT 2026.010. A divergência precisa ser conferida
com o Anexo II antes da entrega.

## Prova

`packages/fiscal-nfe/danfe.test.ts` gera PDFs a partir de NF-e sintéticas
(`packages/fiscal-nfe/tests/danfeFixtures.ts`), válidas no XSD e assinadas com
a chave sintética do corpus, que não é ICP-Brasil, e os lê com o pdf.js. O
teste confere texto, número de folhas, valores exatos, marcas, determinismo
por SHA-256, a situação para cada evidência, a sequência CODE-128 e a leitura
das barras desenhadas de volta para a chave. Cada texto precisa caber na folha
e nenhum texto pode se sobrepor a outro ou ao rodapé. Com
`DANFE_PNG_DIR=<pasta>`, o teste grava cada PDF e cada folha em PNG para a
conferência visual:

```sh
DANFE_PNG_DIR="$TEMP/danfe-png" vp test run packages/fiscal-nfe/danfe.test.ts
```

Os casos cobrem nota simples, 90 itens com RTC (7 folhas), descrições e
`infCpl` longos, 120 duplicatas e 200 volumes, emitente com nome e endereço
no tamanho máximo, CNPJ alfanumérico, protocolo ausente, incompleto, com
`digVal` errado ou de outro ambiente, XML adulterado depois de assinado,
denegada, homologação, cancelamento com e sem autorização, evento de outro
ambiente ou de outro protocolo, evento rejeitado, 136 ou adulterado de outro
ambiente (ignorado), evento de outra nota (recusado, inclusive com
a nota sem protocolo ou adulterada), dois cancelamentos em ordens diferentes,
bytes no lugar do texto, denegada com cancelamento,
duplicatas e ISSQN.

Desempenho, medido em 31/10/2026 na máquina de desenvolvimento: com 600 itens
de `infAdProd` de 500 caracteres sem espaço (XML de 740 KB), o leiaute leva
cerca de 1,1 s e a verificação da importação (`processNfe`, XSD e assinatura)
cerca de 2 s. O teste mede o leiaute descontando a verificação. Nenhum desses
XMLs foi autorizado; a leitura por scanner do código de barras impresso não
foi testada.
