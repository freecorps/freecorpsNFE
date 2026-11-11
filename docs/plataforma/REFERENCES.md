# Municípios e NCM

A gestão de referências fiscais entrega consultas auxiliares em `platform/convex` e no console em
`/app/:organizationSlug/references`. Não calcula tributos, certifica regularidade
ou modifica os códigos declarados nos documentos importados. Consulta CNPJ
tem contrato próprio em [REGISTRY.md](REGISTRY.md).

## Fontes e cobertura

| Dataset    | Origem e formato                                                                                                                                                                                                          | Cobertura e condições                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Municípios | [API de localidades IBGE](https://servicodados.ibge.gov.br/api/docs/localidades), JSON de municípios                                                                                                                      | Snapshot coletado, código de sete dígitos e UF. Sem versão oficial ou datas individuais de vigência no retorno.                                                  |
| NCM        | [Download oficial Receita Federal](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/download-ncm-nomenclatura-comum-do-mercosul), JSON do Siscomex Classif | Tabela vigente na coleta. Somente códigos completos de oito dígitos; capítulos e posições são excluídos. Conserva as datas de início/fim, sem NESH ou alíquotas. |

O coletor grava os bytes originais, o manifesto e os registros normalizados em
`.reference-data/`, ignorado pelo Git. SHA-256 da fonte identifica os bytes;
SHA-256 do conteúdo identifica os campos normalizados em ordem de código.
O backend verifica o segundo hash antes de escrever. A procedência do primeiro
é responsabilidade do coletor/operador, não uma assinatura digital da fonte.

O manifesto separa `sourceVersion`, `retrievedAt`, `asOf`, `coverage`, hashes,
contagem e condições de uso. A versão local combina data e hash do conteúdo.
A [pesquisa de 21/10/2026](../licenses/DATA-SOURCES.md) define o fundamento
legal de reuso dos campos cadastrais e normativos e os textos de atribuição.
Não foi identificada uma licença nominal específica das APIs; a conclusão
não depende de estender a licença de um portal ao arquivo vinculado.
O coletor e os manifestos existentes continuam com `review-required`,
atribuição e URL de referência. Seus payloads ficam fora do repositório e
dos pacotes. Uma futura distribuição exige conferir o artefato selecionado
e incorporar os avisos conforme [LICENSING.md](../../LICENSING.md).

As fixtures em `tests/fixtures/references/1.0` são inventadas, publicáveis para
testes e identificadas como `synthetic`. Seu manifesto tem hashes e resultados
esperados, seguindo a organização por versão/cenário da validação XML. Os testes e a
jornada nativa usam esse mesmo corpus, sem copiar dados restritos para fixtures.

## Publicação e recuperação

`referenceVersions` guarda manifesto e estado; `referenceEntries` guarda linhas
imutáveis por versão; `referenceActive` seleciona a versão visível; `referenceAudit`
preserva cada troca e seu motivo. O arquivo normalizado fica no storage privado.

1. O operador obtém uma URL de upload por `referenceImport:uploadUrl`, interna.
2. `referenceLoad:stage` lê o blob, limita a 8 MB e 30 mil linhas, confere
   formato, datas, códigos, ordem, duplicidades, contagem e hash. Só depois cria
   a candidata e grava lotes de até 100 linhas.
3. A candidata só fica `ready` ao completar a contagem esperada. Nenhum leitor
   externo recebe candidatas ou versões prontas ainda não publicadas.
4. `referenceImport:publish` troca o ponteiro em uma mutation, exigindo a
   geração esperada. Duas publicações concorrentes da mesma geração não passam.
5. Rollback usa a mesma mutation com o ID de uma versão completa anterior,
   geração atual e motivo. Preserva linhas, arquivo e histórico de publicação.

Falha antes da publicação conserva a tabela ativa. Candidata interrompida não
é retomada automaticamente: preserve-a para diagnóstico e importe uma nova
versão identificada. Versões nunca são sobrescritas, mesmo se o conteúdo coincidir.
Não há cron de atualização, endpoint público de escrita ou expurgo automático.
Retenção de versões e limpeza de candidatos devem considerar os cursores em uso;
esta entrega conserva as versões para permitir reprodução e rollback.

Reprodução **somente no Convex local desta worktree**, com `bun run dev` ativo:

```powershell
bunx bun@1.4.0 scripts/fiscal/fetch-references.ts
bunx bun@1.4.0 scripts/fiscal/reference-local.mjs stage .reference-data/ncm.json
bunx bun@1.4.0 scripts/fiscal/reference-local.mjs current ncm
# Use o versionId retornado e a geração lida, sem adivinhá-los:
bunx bun@1.4.0 scripts/fiscal/reference-local.mjs publish <versionId> <geracao> "Atualiza NCM"
# Para rollback, repita publish com o ID anterior e a nova geração corrente.
```

O utilitário recusa checkout principal, perfil legado e alvo remoto. Publicação
remota continua seguindo `DEPLOY.md` e autorização contextual. Em produção não
há tabela preenchida por esta entrega nem migração automática de datasets.

## Contrato e acesso

| Operação SDK         | Endpoint GET                           |
| -------------------- | -------------------------------------- |
| `listMunicipalities` | `/v1/references/municipalities`        |
| `getMunicipality`    | `/v1/references/municipalities/{code}` |
| `listNcm`            | `/v1/references/ncm`                   |
| `getNcm`             | `/v1/references/ncm/{code}`            |

Todos exigem Bearer, `X-Environment`, escopo `references:read` e `companyId`
com concessão válida naquele projeto/ambiente. Os catálogos são compartilhados;
a empresa determina a autorização, não uma cópia particular da tabela.
Revogação, expiração, projeto inativo, mudança de concessão e empresa alheia são
reconferidos em cada chamada. A sessão humana usa membership e acesso à empresa,
sem fingir uma chave de integração. Escritas são exclusivamente internas.

Listas recebem `q`, `limit` de 1 a 50 e `cursor`. Busca é por prefixo do código
ou da descrição normalizada, sem acentos e sem distinguir maiúsculas. São índices
por versão+código e versão+descrição/código, sem varredura integral do catálogo.
`date` é `AAAA-MM-DD`, com calendário validado; o padrão REST é a data UTC da
requisição. Reenvie a data retornada nas páginas seguintes. `version` permite
consultar uma versão publicada anterior. O cursor inclui versão, data, busca e
última chave; mudança de parâmetros resulta em `INVALID_CURSOR`.

Cada resultado contém o manifesto completo e a data consultada. Nenhum DTO contém
storageId ou ID interno de versão. O contrato canônico está em
`packages/contracts/src/external.ts`, usando schemas de `references.ts`; OpenAPI,
referência e SDK seguem a geração/verificação da integração pelo SDK.

| Estado                  | Significado                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `valid`                 | Dentro do intervalo informado, ou presença na data do snapshot.                        |
| `out_of_validity`       | Antes do início ou depois do fim conhecido, ambos inclusivos.                          |
| `validity_unknown`      | Snapshot consultado em outra data, ou início desconhecido em uma fonte por intervalos. |
| `not_found`             | Código exato ausente **nesta versão**, sem afirmar inexistência em toda a história.    |
| `UNAVAILABLE`, HTTP 503 | Nenhuma tabela completa foi publicada; não é lista vazia.                              |
| `NOT_FOUND`, HTTP 404   | Versão solicitada ausente ou ainda não publicada.                                      |

O download NCM vigente não contém todos os códigos extintos. O backend não
inventa esses registros nem promete histórico anterior à primeira coleta.
`31/12/9999` da fonte NCM vira fim não informado. A data da coleta não vira
início de vigência dos municípios. A UI expõe esses limites junto à fonte.

```ts
const result = await client.call("getNcm", {
  path: { code: "01012100" },
  query: { companyId, date: "2026-09-22" },
  body: {},
});
console.log(result.data.status, result.data.manifest.version);
```

## Fronteira e provas

Não foi criado `fiscal-references`. Os consumidores atuais precisam do DTO no
SDK, da regra de vigência no backend e da pesquisa no console. Contratos puros
ficam em `packages/contracts`, validação do arquivo em
`platform/convex/lib/referenceDataset.ts`,
coleta em `scripts/` e persistência no Convex. Nenhum deles exige um pacote
distribuível com payloads oficiais. Uma extração futura depende de consumo
independente demonstrado e da revisão de distribuição.

`platform/convex/references.test.ts` cobre domínio, HTTP, SDK, concorrência,
rollback e autorização. `tests/referenceCorpus.test.ts` verifica os hashes e
resultados do corpus. `apps/console/e2e/references.mjs` exercita Convex nativo,
datasets completos, API/SDK, navegação direta, pesquisa, paginação e mobile.
Veja os recibos e limites em evidence/75.

A conferência conjunta de referências e CNPJ
registra fontes, versões e disponibilidade no Convex local em 30/09/2026.
As condições de redistribuição foram
transferidas explicitamente para #83, com responsável e condição de saída.
