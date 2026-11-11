# @freecorps/fiscal-nfe

Parsing específico de NF-e 55, normalização versionada e validação técnica
offline em Node. Nenhuma API exige conta, variáveis do SaaS ou Convex.
O conector de distribuição DF-e (`distributionRequest`, `parseDistribution` e
`distribute`) recebe transporte e credencial do chamador; a fronteira está
descrita em `docs/plataforma/CAPTURE.md`, na documentação da plataforma.

> [!WARNING]
> Este componente exige atenção reforçada nas próximas integrações. A revisão
> técnica e os testes cobrem as falhas conhecidas, mas combinações de
> XML fora do corpus e o uso na jornada completa ainda podem revelar erros.
> Priorize a investigação de parsing, identidade da chave e composição da
> situação fiscal se houver rejeição inesperada, lentidão ou estado divergente.
> Considere o componente ainda não validado para produção antes de ampliar o uso.

```js
import {
  parseNfeModel,
  normalizeNfe,
  processNfe,
  deriveFiscalSituation,
} from "@freecorps/fiscal-nfe";

const parsed = parseNfeModel(originalBytes, "imported-xml");
const normalized = normalizeNfe(parsed); // cria outro objeto; preserva parsed
const result = processNfe(originalBytes, { evaluatedAt: "2026-09-12T15:00:00Z" });
const situation = deriveFiscalSituation([result], "nfe-status/2");
```

O chamador conserva os bytes originais como fonte integral. A importação XML persiste
arquivo, hash, data de importação e metadados; a consulta de documentos expõe o DTO público.
`normalized` pode existir quando outra etapa falhou: use os resultados de cada
verificação. Não há um booleano que declare validade fiscal.

## Responsabilidade e migração

O pacote se chama `fiscal-nfe` porque schema, chave, tributos e eventos
pertencem à NF-e. Não é uma biblioteca XML genérica. `fiscal-core` contém somente CNPJ (também usado pelos contratos),
decimais exatos e tipos de resultados/versões compartilhados. Não antecipamos
um modelo universal, `br-documents` ou um pacote de fixtures sem consumidor.

O extrator antigo `parseNfe(string)`, com `MAX_XML_BYTES` e `FiscalXmlError`,
existe na 0.1.0 publicada e saiu do código-fonte; a próxima versão publicada
será minor, por ser mudança incompatível. Quem o usava passa os bytes originais
a `parseNfeModel` ou `processNfe`: o limite de tamanho fica em `LIMITS.bytes`,
e a recusa vem como `NfeError`, com o código em `code`, ou em `checks.parsing`
do resultado de `processNfe`.

## Estruturas e etapas

| Entrada                   | Versão        | Modelo específico                                         |
| ------------------------- | ------------- | --------------------------------------------------------- |
| `NFe`, `nfeProc`          | 4.00, PL 010g | Nota, participantes, itens, tributos e protocolo separado |
| `resNFe`                  | 1.01          | Resumo, sem inventar itens ou assinatura                  |
| `evento`, `procEventoNFe` | 1.00, PL 010d | Pedido de evento e retorno separado                       |
| `resEvento`               | 1.01          | Resumo de evento                                          |

Eventos: cancelamento 110111, CC-e 110110, confirmação 210200, ciência 210210,
desconhecimento 210220 e operação não realizada 210240. Desde o `nfe-parser/5`,
também os eventos do fornecedor da Reforma Tributária (NT 2025.002 v1.40):
112110, 112120, 112130, 112140 e 112150, com o detalhe validado contra o XSD
oficial de cada um. Eles entram no histórico sem mudar a situação relatada, e
os campos próprios ficam no XML e em `unsupportedFields`. Desde o
`nfe-parser/7`, também a Vinculação Pagamento 110300 (NT 2026.006 v1.00), do
emitente, validada contra o `e110300_v1.00.xsd` do PL_010g e tratada do mesmo
modo: entra no histórico, não confirma pagamento e não muda a situação. O
cancelamento dela (110001) segue `unsupported`. Outros modelos,
versões ou eventos retornam `unsupported`. A decisão sobre cada pacote e evento
do portal está em `docs/plataforma/NFE-SCHEMAS.md`, na documentação da plataforma.

Desde `nfe-parser/2`, a identidade confere UF, mês, número positivo e tipo
de emissão na chave de todas as entradas, além de modelo, documento e dígito.
Em nota e resumo, AAMM também precisa corresponder a `dhEmi`. A data do evento
não é usada como data de emissão da nota. Erros de componentes retornam
`NFE_KEY_COMPONENT_INVALID`; divergência com a emissão retorna
`NFE_KEY_ISSUED_AT_MISMATCH`. Desde `nfe-parser/8`, um evento que só o
emitente registra (110111, 110110, 112110 a 112150 e 110300), sem retorno ou
registrado, e o `resEvento` desses tipos precisam ter como autor o emitente
da chave; outro CNPJ ou CPF retorna `NFE_EVENT_AUTHOR_NOT_ISSUER`
(`docs/plataforma/NFE-SCHEMAS.md`). A normalização continua em `nfe-normalizer/1`;
resultados históricos do parser anterior conservam sua versão e precisam
ser reprocessados a partir do XML para receber as novas verificações.

`parseNfeModel` preserva strings declaradas, NCM/CEST/CFOP, pedido/item do
pedido, quantidades e unidades comercial/tributável. Tributos conservam cada
grupo e campo em caminhos tipados, incluindo ICMS monofásico e IBS/CBS.
Campos não interpretados aparecem em `unsupportedFields`; o XML continua
sendo a representação completa. Endereços, transporte, cobrança e todas as
variações cadastrais não são prometidos como campos tipados nesta versão.

A extração de tributos conta irmãos uma vez por grupo, com custo linear
na quantidade de campos. O corpus cobre um grupo largo rejeitado pelo XSD,
e o teste do pacote exercita 20 mil irmãos dentro dos limites de entrada.

`normalizeNfe` copia o modelo, aplica `nfe-normalizer/1` e converte decimais
para `{ coefficient, scale, declared }`, sem arredondar nem recalcular imposto.
Valores monetários têm até 2 casas, quantidades até 4 e preço unitário até 10.
Os campos tributários usam a tabela por caminho/tipo gerada dos XSDs fixados,
inclusive alíquotas `adRem`; escalas excessivas são recusadas. Identificadores
continuam strings. O núcleo oferece arredondamento explícito para consumidores
que precisem dele; esta normalização não o aplica.

A NF-e traz `purpose` (`finNFe`, `tpNFCredito`, `tpNFDebito`) desde o
`nfe-parser/3`. O `nfe-parser/4` lê também os campos da NT 2026.008 em
`nt2026008`, na nota (`vProdLiqTot`) e em cada item (`vUnComLiq`, `vProdLiq`,
`vICMSPrevisto`), com as escalas da NT e `null` para campo ausente. O PL_010g
fixado, publicado em 26/10/2026, valida esses elementos, e as coleções
genéricas representam `vProdLiqTot` e `vICMSPrevisto` como `decimal`. O
`nfe-parser/6` lê o grupo `gPgtoVinc` da NT 2026.006 em
`nt2026006.gPgtoVinc`: um item por `gPgto`, com `nPag`, `idTransacao`,
`tpMeioPgto`, `CNPJReceb` e `CNPJBasePSP` em texto, `null` sem o grupo e `[]`
para o grupo vazio que o XSD recusa. O parser confere os formatos exatos de
`TPgtoVinc` (`nPag` de 1 a 990, `idTransacao` em `TStringRTC` com 2 a 35
caracteres, códigos e CNPJs) e, como em `vProdLiqTot`, recusa o XML fora deles
com `XML_FIELD_INVALID`; reprocessar um original assim dá uma versão recusada,
que não substitui a publicada. Não confere as regras da NT nem a unicidade que
o `xs:unique` do PL_010g declara sem alcançar os elementos. `tpMeioPgto` fica
só como código: um código fora da tabela do IT DFe 2026.001 v1.01 não é
recusado, e a descrição é derivada na projeção pública
(`@freecorps/contracts`), não aqui. Esses campos descritivos ficam fora de
`fiscalEvidenceIdentity`, para que reprocessar um original não mude o
fingerprint gravado por versões anteriores do parser.

`processNfe` registra parsing, XSD, identidade, normalização, integridade da
assinatura, confiança da cadeia, validade temporal, consistência da evidência
fiscal e confiança da origem separadamente. Uma etapa não executada permanece
`not_checked`. Metadados incluem origem declarada, SHA-256 dos bytes, versão
do parser/normalizador, schema e hash do catálogo inteiro de XSDs; este último
fixa também os schemas de detalhe dos eventos. Erros retornam códigos estáveis,
sem XML ou mensagens internas do validador.

## Limites e assinatura

Aceita UTF-8 estrito, com BOM opcional, e namespaces por URI, inclusive prefixos.
Rejeita DTD, entidades declaradas, outras instruções de processamento e encoding
incompatível. Limites: 2 MiB, profundidade 64, 50.000 elementos e 990 itens.
A contagem de profundidade e elementos lê o texto uma vez, antes de qualquer
parser, e recusa como `XML_MALFORMED` comentário, CDATA, instrução de
processamento, tag ou valor de atributo sem fechamento.
Schemas vêm exclusivamente do catálogo em memória; `schemaLocation` recebido
nunca determina download ou leitura de arquivo.

A assinatura deve referenciar o `Id` exato de `infNFe`/`infEvento`, único em todo
o documento. São recusadas assinaturas múltiplas, wrapping, referências externas
e transformações fora do perfil fixado. O modelo usado após a verificação vem
da referência autenticada pelo `xml-crypto`, não de uma busca independente.
O perfil dos XSDs usa RSA-SHA1, digest SHA1 e C14N com transformação enveloped;
outros perfis não são aceitos silenciosamente. O certificado deve ser RSA com
pelo menos 2048 bits. `referenceSha256` identifica o conteúdo autenticado.

Integridade não comprova cadeia ICP-Brasil, revogação, titularidade ou origem
do protocolo. `certificateTrust` e `originTrust` ficam `not_checked`.
`certificateTime` só é avaliado no instante explícito `evaluatedAt`; não usa
relógio oculto nem prova validade na data da emissão. Protocolos e retornos
fora da referência assinada são declarações preservadas, não autenticadas.

## Situação relatada pelos arquivos

`deriveFiscalSituation` recebe resultados e versão de regra, sem IO ou relógio.
Retorna `reportedStatus`, `basis: "preserved-claims"`,
`assurance: "unverified-origin"` e `liveConsultation: false`. Não há campo
`status` que possa ser confundido com consulta atual à SEFAZ.

Ausência de evidência dá `unknown`. Parsing/assinatura válidos sem protocolo
não autorizam. Protocolo 100/150 relata autorização; 110/301/302/303 relatam
denegação. Resumo usa sua situação declarada. Cancelamento aceito 135/155
prevalece sobre autorização; ciência, CC-e e manifestações não mudam esse
estado. Resposta 136 sem vínculo e rejeição/duplicidade não apagam aceitação.
Esses eventos excluídos também não contribuem identidade, autor, instante ou
outras declarações para conflitos. A correção conserva `nfe-status/1`, conforme
essa regra já especificada; resultados persistidos não são reescritos, e os
recibos históricos continuam reproduzíveis pelo SHA que os produziu.

`nfe-status/2` (#395) muda um comportamento especificado, por isso é outra
versão; `nfe-status/1` continua aceita por `deriveFiscalSituation`. Na versão 2,
uma interpretação aceita por um catálogo de schemas mais novo substitui outra,
dos mesmos bytes, que um catálogo mais antigo recusou só no XSD.
`replacedInterpretations` confere isso pelo fingerprint exato que o catálogo
antigo teria produzido. A ordem dos catálogos é `SCHEMA_CATALOGS`, pelo
`catalogSha256` gravado em cada interpretação. Ao incorporar um pacote, acrescente
o catálogo novo ao fim da lista, com os campos que ele passou a tipar como
decimal; um teste exige que o catálogo em uso seja o último.

A regressão usa XMLs assinados sintéticos com respostas 573 e 136, autor/data
divergentes e outra chave/ambiente. Confere as seis ordens de chegada,
duplicatas e um controle aceito que continua produzindo conflito.
`node scripts/fiscal/prove-excluded-events.mjs`, após `bun run packages:build`, compara a
função de situação anterior à correção com a atual usando o mesmo parser.
O runner precisa do histórico Git do commit `2947b9c`; não é uma reprodução
integral da release antiga. O CI normal executa o mesmo contrato sobre a função
atual no pacote e no consumidor instalado, sem depender desse histórico.

Duplicatas exatas não alteram resultado. A ordem de chegada é irrelevante.
Chaves, ambientes, protocolos, conteúdo imutável ou processamento incompatíveis
produzem `conflict` com códigos estáveis. Respostas diferentes ao mesmo pedido
de evento são observações separadas; a identidade do pedido vem do conteúdo
assinado. Evidências descartadas e seus motivos permanecem no resultado.
Um XML importado pode mentir nos trechos não assinados: esta API relata a
declaração e mantém sua origem não verificada. A consulta de documentos deve conservar essa
distinção ao apresentar o documento.

## DANFE

`@freecorps/fiscal-nfe/danfe` gera o DANFE A4 retrato de NF-e 55 em PDF a
partir do XML original, com `pdf-lib`. É um subpath separado para que o
parsing não carregue a biblioteca de PDF:

```js
import { DANFE_GENERATOR_VERSION, renderDanfe } from "@freecorps/fiscal-nfe/danfe";

const pdf = await renderDanfe(xml, { events: [procEventoNFe], origin });
```

A situação impressa vem de `processNfe` e `deriveFiscalSituation`, as mesmas
da importação: sem assinatura XML válida e protocolo completo da mesma chave e
ambiente, o PDF sai com "SEM VALOR FISCAL". Denegação, cancelamento, conflito e
homologação também são marcados. Leiaute, marcas, limites e
fontes estão em `docs/plataforma/DANFE.md`, na documentação da plataforma.

## Corpus, XSDs e provas

O corpus compartilhado está em `tests/fixtures/nfe/4.00`, com origem, hashes,
versões e esperado por etapa em `manifest.json`. Dados e certificado são
sintéticos; a chave privada versionada só reproduz assinaturas de teste e não
é credencial de integração. Pacote, contratos e backend usam esse corpus.

`schemas/manifest.json` registra arquivos oficiais, URLs, hashes e conversões
de encoding dos XSDs antigos. `scripts/fiscal/sync-nfe-schemas.py --download` recusa
archives diferentes dos hashes revisados. Os bytes originais permanecem
intactos; o catálogo runtime converte somente encoding para UTF-8. Dois
entrypoints (`nfeProc` e `evento`) são wrappers locais dos tipos oficiais;
o schema de assinatura ausente no ZIP de distribuição vem do PL 010g. Do
PL_010g, o script copia para `nfe-4.00-010g` a pasta `NFe/` e, da pasta
`Evento/`, só o `e110300_v1.00.xsd` e o `tiposBasico_v1.03.xsd` que ele inclui.
O envelope de eventos vem da pasta `Evento/` do PL 010d_v1.03, e o arquivo
`e112120_v1.00 .xsd` do pacote RTC, publicado com um espaço no nome, é gravado
sem ele. O levantamento do portal (26/10/2026) fica em
`schemas/portal-survey.json`; `bun run xml:portal` aponta pacote novo,
retirado ou com outro hash (procedimento em `docs/plataforma/NFE-SCHEMAS.md`).

Os XSDs históricos contêm peculiaridades do material publicado. O `TChNFe`
do pacote de cancelamento aceita vírgula em um ramo de UF, mas esse tipo não
é usado para a chave no fluxo do pacote: o envelope usa o XSD de eventos
alfanumérico, seguido pela verificação independente de identidade. Um teste
de regressão confere a rejeição nas duas etapas. O `TDec_0302a04Opc` do XSD
de eventos permite zero apesar do comentário descritivo; o envelope de evento
não usa esse tipo. Preservamos o contrato publicado e seus bytes. Aprovação
no XSD não representa aprovação de regras fiscais de negócio.

O código próprio usa a Licença de Código Disponível Freecorps 1.0. Os ZIPs oficiais não declaram licença explícita,
e acesso público não foi tratado como permissão de redistribuição. O artefato
composto usa `SEE LICENSE IN LICENSING.md` e foi publicado no npm pela decisão de
20/10/2026 sobre os XSDs e pelo aceite de 01/11/2026.
Confira [LICENSING.md](LICENSING.md), inclusive para os XSDs embutidos no JSON.

Na raiz: `bun run packages:build`, `bun run ci:boundaries`, `bun run xml:test`,
`bun run xml:prove` e `bun run xml:runtime local` com a worktree em execução.
A prova independente empacota os dois módulos, instala fora do monorepo com
scripts de instalação desativados, remove variáveis do SaaS e verifica o JSON
inteiro. A prova hospedada exige deployment dev isolado e chave explícita.
Recibos sanitizados ficam em `.ci-results/nfe`.
