# Contrato externo, SDK e quickstart

A API de documentos da plataforma usa `platform/convex`. `@freecorps/sdk` 0.1.0 está
publicado no npm desde 01/11/2026 (#83). Plataforma e motor usam a licença Freecorps 1.0; o SDK cliente usa MIT; distribuição e bloqueios
por artefato estão no arquivo `LICENSING.md` da raiz do repositório.

## Fonte e atualização

A versão 3.0.0 do contrato, descrita em OpenAPI 3.1.0, amplia as respostas
documentais para `model: nfse` e `payload.kind: service-invoice`, além da NF-e
55 existente. O campo opcional
`documents[]` no resultado por arquivo lista as notas de um lote ABRASF. A
importação desses lotes saiu em 02/11/2026: o campo só aparece em arquivos
importados antes, cujas notas ficam só para leitura.
Clientes devem tratar essa nova variante; as URLs `/v1/*` permanecem iguais.
O filtro `key` também aceita a identidade `nfse:...` documentada em
[IMPORTS.md](../plataforma/IMPORTS.md#lotes-nfs-e-abrasf-retirados). Importação não implica
autorização fiscal. Capabilities anuncia os dois modelos, sem habilitar
captura de NFS-e.

A versão 4.0.0 acrescenta a emissão NFS-e em sandbox (`/v1/issuances`), os
escopos `documents:issue` e `documents:cancel`, os eventos `issuance.*`, os
códigos de erro da emissão e o campo opcional `error.field`. As rotas
anteriores continuam com os mesmos campos; o major vem dos enums ampliados de
eventos e erros.

A versão 5.0.0 torna obrigatório todo o endereço do tomador no exterior em
`createIssuance` (`taker.address.postalCode`, `state`, `street`, `number` e
`district`), que o XSD da DPS exige; um pedido sem eles seria recusado pelo
fisco. Sem bairro no endereço, informe a região, o distrito ou `N/A`. A
alíquota continua aceitando até 4 casas, mas a 3ª e a 4ª só podem ser zero. As
demais rotas não mudam.

A versão 6.0.0 acrescenta o evento `connection.release_withdrawn` (#422): o
último evento de uma captura em Produção cuja liberação fiscal foi retirada,
no console ou pela emergência da Freecorps. As rotas e os campos não mudam; o
major vem do enum de eventos ampliado, como na 4.0.0. Um destino que não
assina o evento não recebe nada novo.

A versão 7.0.0 acrescenta à NF-e completa (`payload.kind: "invoice"`) os campos
`declaredTotals` (`vNF` e `vNFTot`) e `purpose` (finalidade e tipos de nota de
crédito e débito), descritos em [DOCUMENTS.md](../plataforma/DOCUMENTS.md#totais-e-finalidade-da-nf-e).
`total` continua sendo `ICMSTot/vNF`. Como os objetos de resposta são
estritos, um SDK anterior recusa a resposta nova com `INVALID_RESPONSE`;
atualize o SDK antes de ler documentos pela 7.0.0.

A mesma 7.0.0 acrescenta `nt2026008` à NF-e completa (`vProdLiqTot`) e aos
itens (`vUnComLiq`, `vProdLiq` e `vICMSPrevisto`), os campos da NT 2026.008
descritos em [DOCUMENTS.md](../plataforma/DOCUMENTS.md#campos-da-nt-2026008).
As duas entregas chegam à `main` juntas, numa só versão major: o integrador
atualiza o SDK uma vez.

A versão 8.0.0 acrescenta o evento `connection.history_limited` (#442): o
Proprietário aceitou no console a perda de um trecho da fila que a Receita
não tem mais, numa captura ativada pela integração. É o único evento com
`data` (`lost.from`, `lost.to` e `decidedBy`), descrito em
[WEBHOOKS.md](../plataforma/WEBHOOKS.md); o SDK exporta o tipo
`HistoryLimitedData`. As rotas e os campos das respostas não mudam; o major
vem do enum de eventos ampliado, como na 4.0.0 e na 6.0.0. Um destino que
não assina o evento não recebe nada novo, e o envelope continua na versão
`1`.

A mesma 8.0.0 aceita `nfe-status/2` em `fiscalSituation.ruleVersion` (#395),
além de `nfe-status/1`. A regra nova deixa a interpretação de um catálogo de
schemas mais novo substituir uma recusa apenas no XSD por um catálogo mais
antigo ([DOCUMENTS.md](../plataforma/DOCUMENTS.md#catálogo-de-schemas-mais-novo)).
Uma situação gravada antes continua com `nfe-status/1` até a próxima
reconstrução do documento.

A mesma 8.0.0 acrescenta `nt2026006` à NF-e completa (#501): o grupo
`gPgtoVinc` da NT 2026.006, um item por pagamento vinculado (`nPag`,
`idTransacao`, `tpMeioPgto`, `CNPJReceb` e `CNPJBasePSP`, todos em texto,
mais `tpMeioPgtoLabel`, a descrição do meio de pagamento no IT DFe 2026.001
v1.01 ou `null` fora da tabela),
descrito em [DOCUMENTS.md](../plataforma/DOCUMENTS.md#vinculação-com-a-transação-de-pagamento-nt-2026006).
Como nenhum contrato foi publicado, a mudança fica na 8.0.0
([Versionamento](#versionamento)); um SDK gerado antes dela recusa a resposta
nova com `INVALID_RESPONSE`.

`packages/contracts/src/external.ts` é a única definição editável das estruturas
REST. Os schemas Zod 4.6.0 validam a borda HTTP e o cliente; `z.infer` deriva os
tipos TypeScript. `documents.ts` conserva a projeção explícita do modelo fiscal,
com tipos derivados dos schemas. Autorizações, concessões, transações, estados e
deduplicação continuam no domínio, independentes dos schemas externos.

Zod 4.6.0 já estava no lockfile e agora é uma dependência explícita dos contratos.
Sua conversão nativa produz JSON Schema 2020-12, compatível com OpenAPI 3.1.
Não há transforms/coerções nos schemas; a conversão de query string para número
acontece somente na borda HTTP. [Conversão Zod](https://zod.dev/json-schema) e
[OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0.html).

```sh
bun run contracts:generate
bun run contracts:check --base origin/main
bun run sdk:build
bun run sdk:prove
```

O gerador produz [OpenAPI](openapi.json), a referência em
`docs/v1.0/API-REFERENCE.md` no repositório e os
downloads do console. Ele não lê variáveis de ambiente ou credenciais. O check
recusa artefatos desatualizados.

### Versionamento

Desde a decisão do mantenedor de 26/10/2026, o gate compara o contrato com o
**último contrato publicado**, e não com a base da PR. Um major ainda não
publicado aceita mudanças. A fonte de verdade é
[`packages/contracts/published.json`](../../packages/contracts/published.json):
`published: null` registrava que nada tinha sido publicado. Desde a
publicação de 01/11/2026, o registro guarda a versão 8.0.0, o commit e o SHA-256
de `docs/v1.0/openapi.json` naquele commit. O gate lê esse arquivo pelo Git e recusa commit, hash ou versão
que não batam com o registro. O CI não consulta o npm.

| Situação                                              | Gate                                        |
| ----------------------------------------------------- | ------------------------------------------- |
| Nada publicado, ou major acima do publicado           | Aceita mudanças nesse major                 |
| Mesmo major do publicado, com ou sem incremento minor | Recusa mudança em operação/schema existente |
| Major abaixo da base da PR ou do publicado            | Recusa                                      |

A base da PR continua sendo lida, nunca um baseline alterado junto da
implementação: em pushes, o SHA anterior do evento; nas chamadas manuais sem
esse SHA, o primeiro pai do checkout. Ela serve para recusar a redução do
major. Na primeira entrega a base não tem OpenAPI; os testes negativos do
comparador continuam obrigatórios.

Dentro do major publicado, o comparador é conservador: novas operações são
permitidas; mudanças em uma operação/schema existente, inclusive algumas
mudanças aditivas, exigem incremento major explícito. Isso evita aprovar
silenciosamente keywords desconhecidas, mas pode recusar mudanças compatíveis.
Um incremento major não substitui a revisão
de migração/versionamento da API pelo mantenedor. A versão do contrato é 8.0.0;
documentos usam `documents/1`, e o envelope webhook usa `1`.

A captura NF-e amplia enums de origem com `distribution-xml`, de eventos com
`connection.attention_required` e de erros da captura. O snapshot OpenAPI
recebeu major 2 conforme essa política conservadora; o suporte documental a
NFS-e ABRASF elevou o contrato para major 3, a emissão NFS-e, para major 4, o endereço obrigatório do tomador no exterior, para major 5, o evento
`connection.release_withdrawn`, para major 6, os totais, a finalidade e
os campos da NT 2026.008 da NF-e, para major 7, e o evento `connection.history_limited`, para major 8. Antes de publicado, o 8.0.0 também recebeu o erro `SOURCE_COOLDOWN` com `error.nextAllowedAt` e o campo `sourceMaxNsu` da conexão NF-e (decisão de 28/10/2026, #600, PR #602), sem outro major. Um tarball 8.0.0 gerado antes da #602 não conhece `sourceMaxNsu` e recusa `getCapture` e `controlCapture` com `INVALID_RESPONSE`; só o pacote gerado depois dela vale como 8.0.0. O 8.0.0 recebeu ainda o erro `ORGANIZATION_ARCHIVED` (409), da organização em custódia fria (ADR 0009, §3), que antes chegava como `SCOPE_DENIED` (403), também sem outro major, pela mesma regra de major não publicado; um tarball anterior recebe essa resposta como `INVALID_RESPONSE`. Pela mesma regra, o 8.0.0 recebeu o campo opcional `originalId` nos documentos, versões, arquivos, importações, operações, emissões e artefatos de emissão e em `resource` do envelope de webhook (ADR 0009, §6, [IDs depois da reativação](#ids-depois-da-reativação)); só um recurso reidratado o traz, e um tarball anterior recusa essa resposta com `INVALID_RESPONSE`, enquanto o verificador de webhook anterior aceita o envelope. Também sem outro major, o 8.0.0 recebeu a rota `downloadDanfe` (`GET /v1/documents/{documentId}/danfe`, #402) e o erro `DANFE_UNAVAILABLE` (409); um tarball anterior recebe esse erro como `INVALID_RESPONSE`. As rotas existentes continuam em `/v1`. O DTO documental
segue em `documents/1`, porque a 7.0.0 só acrescenta campos e não muda o
significado de nenhum; o envelope de webhook não muda de versão. Consumidores com enum fechado devem atualizar
o SDK/schema antes de ativar captura ou assinar o novo evento. O 8.0.0
foi publicado com `@freecorps/sdk` 0.1.0 no npm em 01/11/2026 (#83); desde então o gate recusa mudança incompatível nesse major.

## Instalação independente

Num projeto consumidor, instale pelo npm:

```sh
npm install @freecorps/sdk
```

Os bytes publicados são os aceitos na #83; o SHA-256 de cada tarball e a prova
de instalação pelo registry estão em `docs/v1.0/evidence/83/2026-11-01`.

O roteiro completo para o consumidor fica em `/docs/` da instalação,
com downloads, PowerShell, Bash e diagnósticos. A geração abaixo é para
quem tem acesso ao código-fonte e quer testar um tarball local.

Com Bun 1.4.0 e dependências instaladas, `bun run sdk:build` produz
`.ci-results/74/freecorps-sdk-0.1.0.tgz`. Copie esse arquivo para um consumidor
limpo, junto dos três exemplos em `examples/`. Não copie `node_modules`.

```sh
npm init -y
npm install ./freecorps-sdk-0.1.0.tgz
```

O artefato contém JS ESM e declarações TypeScript, com Zod como dependência.
Não instala Convex, React, Clerk ou Better Auth. Os schemas são incorporados ao
artefato a partir da fonte canônica; não existe uma segunda definição editável.
O verificador em `@freecorps/sdk/webhooks` usa somente Web Crypto e pode ser
importado separadamente. Node 22 e 24 são os runtimes alvo; o receptor usa
`node:sqlite` e requer Node 22.13+ ou 24. Confira o runtime efetivamente exercitado
no recibo da entrega. Não há alegação de testes em outros runtimes.

## Jornada em sandbox

Use uma instalação de teste autorizada e uma empresa de demonstração. O XML em
`apps/console/public/examples/nfe-demonstracao.xml` é sintético e corresponde à
empresa de demonstração. Crie um projeto, conceda a empresa em sandbox e gere
uma chave restrita com `documents:import`, `documents:read` e, para cadastrar o
receptor, `webhooks:manage`. A chave pode ser obtida pelo console; o cliente REST
não depende de sessão humana nem de certificado fiscal.

No painel, use Primeiros passos → Explorar demonstração para preparar a
empresa sintética. Em Primeira chamada do projeto, copie a URL da API e o
companyId dessa empresa. A URL da API é diferente
da URL do painel e da URL do túnel; informe a origem sem `/v1`.
Os escopos da chave precisam caber na concessão. Se `companies:read` estiver
marcado por padrão, desmarque-o ou conceda também esse acesso ao projeto.

Primeiro configure o receptor e seu destino na área Webhooks, assinando
`document.received`, `document.updated`, `document.event_received` e
`import.completed`. O backend exige HTTPS público; um túnel de teste deve expor
somente o receptor sintético. Regras DNS/IP/porta e TLS são as mesmas da entrega de webhooks.

No diretório do consumidor, em terminal Bash:

```sh
export FREECORPS_BASE_URL='http://127.0.0.1:PORTA_HTTP_LOCAL'
export FREECORPS_COMPANY_ID='ID_DA_EMPRESA'
export FREECORPS_API_KEY='CHAVE_RESTRITA_DE_TESTE'
export FREECORPS_IDEMPOTENCY_KEY='importacao-sintetica-001'
export FREECORPS_XML='./nfe-demonstracao.xml'
node quickstart-curl.mjs
node --experimental-strip-types quickstart.ts
```

Use a mesma chave de idempotência nos dois comandos para conferir a mesma
reserva, operação e documento. Use outra chave para conferir uma nova reserva
com deduplicação documental. Os exemplos reservam, obtêm ticket, enviam os bytes,
confirmam, aguardam a operação e consultam JSON e todas as páginas de itens.
Cada exemplo repete a reserva internamente: `reused: true` pode aparecer na
primeira execução. Compare os IDs entre comandos para verificar a identidade.
`summary.resourceVersion` é a revisão pública do recurso, diferente de
`version.id` e `version.sha256`, que identificam a versão processada e o XML.
A operação pode concluir enquanto `summary.projectionState` ainda está `pending`.
Quando a projeção fiscal termina, ela pode emitir `document.updated` e avançar
`resourceVersion` de 1 para 2, mantendo a mesma versão processada e o mesmo XML.
Isso não indica outra importação: confira os IDs, o hash, o estado da projeção
e os eventos. Repetir a confirmação da mesma intenção não cria nova operação.
O curl usa Node apenas para coordenar os processos e ler JSON, sem SDK. A chave
e o token de upload entram no curl por stdin, sem argumentos de processo ou URL.

`GET /v1/capabilities` exige chave vigente e ambiente correto. Informa capacidades
implementadas, não concede permissões nem depende dos escopos da chave. Numa
chave de sandbox, `models` traz `55` e `nfse`; a NF-e 55 entra por importação,
e a NFS-e é emitida em sandbox, com transporte simulado. As NFS-e ABRASF
importadas antes de 02/11/2026 continuam legíveis.
`models` acompanha `capabilities`: `55` aparece com `documents.read`, e `nfse`
só com `documents.issue`, o único caminho por onde uma NFS-e entra desde a
retirada da importação ABRASF. Numa chave de sandbox, `capabilities` lista `companies.read`, `documents.import`,
`documents.read`, `documents.issue`, `documents.cancel`, `webhooks`,
`references.read`, `connections.read`, `connections.write` e `registry.read`. Conexões de captura NF-e, `connection.attention_required` e
`connection.release_withdrawn` estão disponíveis; a consulta de CNPJ usa `/v1/registry/cnpj/{cnpj}`. Trate
valores desconhecidos como capacidades futuras, sem falhar. `environment`
devolve o ambiente da chave. `limits` vem sempre; `importFiles` e
`importBytes` valem só onde há `documents.import`.

No site, uma chave de produção só responde enquanto alguma das suas empresas
tem a captura fiscal liberada ([CAPTURE.md](../plataforma/CAPTURE.md)).
`models` traz só `55`, a NF-e capturada, e
`capabilities` traz só o que a Produção atende: `companies.read`,
`documents.read`, `webhooks`, `connections.read` e `connections.write`.
Importação, emissão, cancelamento, referências e consulta de CNPJ ficam no
sandbox. Retirada a liberação, ou cortada a captura no deployment, restam
`companies.read`, `documents.read` e `connections.read`, para ler e exportar o
que já foi capturado. Com várias empresas na chave, uma capacidade aparece
quando a Produção a atende para ao menos uma delas, a mesma regra da entrada
de cada rota; cada chamada ainda confere a empresa pedida.

## Identidades, números e erros

- `Idempotency-Key` e hash canônico do pedido preservam a intenção por projeto e
  operação. A mesma chave com outro conteúdo produz `IDEMPOTENCY_CONFLICT`.
- A identidade documental inclui escopo de organização, empresa e ambiente,
  modelo e chave fiscal. Outro projeto autorizado pode consultar o mesmo documento;
  a chave do cliente não concede acesso fora das suas concessões.
- SHA-256 identifica os bytes do artefato original, não o pedido nem o evento.
- `eventId` identifica a mudança lógica; `deliveryId` identifica sua entrega a um
  destino. Reenvio conserva essas identidades. `requestId` identifica uma chamada.

Valores fiscais e quantidades são strings decimais exatas, inclusive zeros finais.
Não use `Number`, `parseFloat` ou arredondamento binário. Timestamps numéricos usam
milissegundos; datas fiscais preservam a representação documental. Não há conversão
das escalas do motor legado para esta API. Estados de processamento, completude e
situação fiscal são distintos. Um XML importado não comprova consulta ao fisco.

O cliente preserva `code`, `status` e `requestId` nos erros. `retryable` também
considera a segurança da operação: escritas sem idempotência e uploads de uso
único retornam `false`, mesmo se o erro HTTP permitir retry. Seu timeout
padrão é de 30 segundos para o conjunto de tentativas. Leituras JSON e escritas
explicitamente idempotentes admitem no máximo dois retries; a chave e o corpo são
preservados. 429/502/503/504 e falha de transporte permitem retry, respeitando
Retry-After e cancelamento, inclusive quando um gateway devolve HTML, texto ou
corpo vazio. Um erro JSON com `retryable=false` impede retry automático.
Cadastro/edição/rotação de webhook, upload, confirmação
e controles de operação não são repetidos automaticamente. Os downloads binários
`downloadOriginal` e `downloadDanfe` fazem uma tentativa; o chamador pode repetir essa leitura. Após perda de resposta
no upload, consulte a importação antes de obter outro ticket. Timeouts não apagam
nem desfazem o que o servidor já aceitou.

### IDs depois da reativação

Uma organização aberta que passou pelo arquivo econômico volta com IDs novos
em documentos, versões, arquivos originais, importações, arquivos de lote,
operações, emissões e artefatos de emissão
([ADR 0009, §6](../adr/0009-custodia-fria-de-organizacoes-abertas.md#6-ids-antigos)).
O ID que a integração guardou antes continua valendo: as rotas aceitam o ID de
qualquer ciclo, no caminho, em `versionId` e em `documentId` de
`createExport`, e respondem o recurso atual, com o `id` novo. O recurso que
voltou traz `originalId`, o primeiro ID que ele teve, também no
`resource.originalId` dos webhooks emitidos depois da reativação. Um recurso
nunca arquivado não tem `originalId`. Um ID anterior de outra organização
nunca resolve e responde `NOT_FOUND`.

Para deduplicar, guarde `originalId ?? id`. A chave de idempotência compara o
ID exatamente como foi enviado: repetir um pedido de antes do arquivamento com
o ID antigo devolve a mesma operação, agora com o ID novo; o ID novo com a
mesma chave é outro pedido e responde `IDEMPOTENCY_CONFLICT`. As referências
dentro de um recurso (`operationId`, `artifactId`, `versionId`, `documentId`)
já vêm com os IDs novos.

## Emissão NFS-e em sandbox

O contrato 4.0.0 acrescentou `createIssuance`, `getIssuance`, `listIssuances`,
`cancelIssuance` e `client.downloadIssuanceArtifact(...)`, descritos em
[ISSUANCE.md](../plataforma/ISSUANCE.md#api-rest). A chave precisa de `documents:issue` para
emitir e de `documents:cancel` para cancelar, com a empresa declarada, perfil
NFS-e e concessão do projeto em sandbox. `createIssuance` e `cancelIssuance`
exigem `idempotencyKey` (uma por intenção de nota ou de cancelamento) e
respondem `202`: aceito não é autorizado. Acompanhe `issuance.state` por
`getIssuance` ou pelos webhooks `issuance.*`. Valor e alíquota são texto
decimal (`"1500.00"`, `"2.5"`); um número é recusado antes da rede.

Erros de validação da emissão trazem `FreecorpsError.field` com o caminho do
campo (`taker.document`), e `FreecorpsError.missing` lista os campos do perfil
que faltam à emissão, pelo canal do município ou pelo IBS/CBS
(`NFSE_ROUTE_PROFILE_INCOMPLETE`). O transporte do sandbox é simulado e a NFS-e sai com
"sem validade fiscal". O exemplo `examples/nfse-issuance.ts` emite, acompanha o
estado e baixa o XML autorizado; o mesmo método baixa o PDF do DANFSe (artefato `danfse`).

Na captura NF-e, retomar um bloqueio 656 antes da janela da Receita recebe
`SOURCE_COOLDOWN` (409); o SDK não repete a chamada e expõe em
`FreecorpsError.nextAllowedAt` o instante, em epoch ms, a partir do qual a
retomada é aceita. A API manda `retryable: true`, mas o SDK expõe
`retryable === false`, porque só repete 429/502/503/504; o integrador espera
`nextAllowedAt` e então envia a retomada de novo. Com a organização em custódia fria (arquivo econômico, ADR 0009), as rotas de dados fiscais e as escritas da própria organização arquivada respondem `ORGANIZATION_ARCHIVED` (409), e não `SCOPE_DENIED` (403) nem `NOT_FOUND`; não é falta de permissão, e repetir não adianta até a reativação. Um recurso inexistente e um recurso de outra organização continuam respondendo `NOT_FOUND`. Continuam `listCompanies`, `getCompany`, `getCapabilities`, `listWebhookEndpoints`, `editWebhookEndpoint` só para desligar (`active: false`, demais campos iguais) e `rotateWebhookSecret`. `getCapture` traz `sourceMaxNsu`, o último NSU informado
pela Receita, `null` até a primeira consulta respondida.

## Receptor e verificador

`sdk-webhook-receiver.mjs` recebe os bytes originais antes de qualquer JSON parser.
O verificador confere HMAC-SHA256, headers assinados, versão, timestamp e segredos
da janela de rotação, com os vetores da entrega de webhooks. O relógio e a tolerância são explícitos;
a tolerância padrão é cinco minutos. Consulte `docs/plataforma/WEBHOOKS.md` no repositório para a
concatenação exata e a taxonomia. Falha de assinatura/replay temporal retorna 400;
falha temporária ao consultar o documento retorna 503 e permite nova entrega.
Em `connection.history_limited`, o receptor guarda `data.lost` e `data.decidedBy`
na mesma transação da deduplicação, mesmo que uma versão mais nova da conexão
tenha chegado antes: a perda aceita não depende da ordem das entregas.

Crie um arquivo de segredos protegido, fora do código e do controle de versão:

```json
[{ "version": 1, "secret": "SEGREDO_EXIBIDO_NO_CADASTRO" }]
```

Esse arquivo não vem nos downloads. Crie `segredos-locais.json` na pasta do
consumidor, por exemplo com `notepad .\segredos-locais.json` no Windows.
Substitua o texto entre aspas pelo **segredo do webhook**, não pela API key.
Salve JSON válido em UTF-8 sem BOM e confira que não foi acrescentado `.txt`.
O modelo usa a versão 1 de um destino recém-criado. Guarde o segredo antes
de dispensar a tela, pois não será exibido novamente.

Na rotação, acrescente o segredo novo e mantenha o anterior com `validUntil`
em milissegundos, conforme a expiração informada pelo servidor. O receptor relê
esse arquivo a cada entrega. Configure no terminal do receptor:

```sh
export FREECORPS_ENVIRONMENT='sandbox'
export FREECORPS_WEBHOOK_SECRETS_FILE='./segredos-locais.json'
export FREECORPS_WEBHOOK_DATABASE='./eventos.sqlite'
node sdk-webhook-receiver.mjs --serve
```

O receptor compartilha `FREECORPS_BASE_URL` e `FREECORPS_API_KEY` do quickstart.
Persistência de `eventId`, versão do recurso e efeito local ocorre na mesma
transação SQLite. Depois de verificar a assinatura, consulta o documento pela API
autenticada. Se a API já apresenta uma versão posterior, guarda essa versão para
evitar regressão. Reiniciar o processo conserva a deduplicação. Efeitos externos
exigem sua própria outbox/idempotência; o exemplo não promete exatamente uma vez.

## Passo a passo no Windows PowerShell

Use Node 22.23.4+ ou 24.22.1+ e mantenha os arquivos do exemplo numa pasta exclusiva.
O ensaio usou três terminais nessa pasta: túnel, receptor e importação.
O SDK já deve estar instalado para executar o receptor ou o exemplo TypeScript.

1. No terminal do túnel, use o executável obtido na
   [página oficial do cloudflared](https://developers.cloudflare.com/tunnel/downloads/).
   Salve-o na pasta do teste com o nome `cloudflared.exe` e execute:

   ```powershell
   .\cloudflared.exe --version
   .\cloudflared.exe tunnel --url http://127.0.0.1:8787
   ```

   Espere `Registered tunnel connection` e mantenha o terminal aberto.
   Se o comando não for reconhecido, confira o arquivo e o prefixo `.\`.
   A URL `https://….trycloudflare.com` é temporária; se ela mudar,
   atualize o destino no painel.

2. Em Webhooks → Novo destino, informe a URL do túnel seguida de `/webhook`.
   Assine Documento recebido, Documento atualizado, Evento fiscal recebido
   e Importação concluída. Clique em Criar destino e preencha o arquivo
   `segredos-locais.json` descrito acima com o segredo exibido.

3. Execute o bloco abaixo **nos terminais do receptor e da importação**.
   Cada janela PowerShell tem suas próprias variáveis. Obtenha a URL da API
   e o ID da empresa em Primeira chamada do projeto. No serviço hospedado, a
   URL da API é `https://api.nfe.freecorps.com.br`.

   ```powershell
   $env:FREECORPS_BASE_URL = Read-Host 'URL da API, sem /v1'
   $env:FREECORPS_COMPANY_ID = Read-Host 'ID da empresa de demonstração'
   $chave = Read-Host 'Chave de API do projeto' -AsSecureString
   $env:FREECORPS_API_KEY = [System.Net.NetworkCredential]::new('', $chave).Password
   Remove-Variable chave
   $env:FREECORPS_ENVIRONMENT = 'sandbox'
   $env:FREECORPS_XML = './nfe-demonstracao.xml'
   $env:FREECORPS_IDEMPOTENCY_KEY = 'importacao-sintetica-001'
   ```

4. No terminal do receptor, execute antes da primeira importação:

   ```powershell
   $env:FREECORPS_WEBHOOK_SECRETS_FILE = './segredos-locais.json'
   $env:FREECORPS_WEBHOOK_DATABASE = './eventos.sqlite'
   $env:PORT = '8787'
   node sdk-webhook-receiver.mjs --serve
   ```

   Espere `Receptor disponível em /webhook` e deixe o terminal aberto.
   O SQLite é criado automaticamente. O segredo é lido apenas quando chega
   uma entrega; a mensagem de início não valida seu conteúdo. Se mudar a porta,
   use o mesmo número no comando do túnel.

5. No terminal da importação, execute `node quickstart-curl.mjs` e depois
   `node --experimental-strip-types quickstart.ts`. Compare IDs, hash do XML
   e versões dos resultados. Confira o documento no painel em sandbox.

6. Em Webhooks, espere Entregue / HTTP 204 e consulte o SQLite no terminal
   da importação:

   ```powershell
   @'
   const { DatabaseSync } = require('node:sqlite');
   const db = new DatabaseSync('./eventos.sqlite', { readOnly: true });
   console.log('Eventos:', db.prepare('SELECT count(*) AS total FROM events').get());
   console.table(db.prepare('SELECT id, version, effects, document IS NOT NULL AS documentPresent FROM resources ORDER BY id').all());
   db.close();
   '@ | node
   ```

   Guarde as contagens. Reenvie a **mesma entrega já confirmada**, aguarde outro
   HTTP 204 e consulte novamente. Sem novas importações ou eventos no intervalo,
   contagem de eventos e efeitos por recurso devem permanecer iguais.
   Eventos distintos podem produzir efeitos adicionais. `documentPresent=1`
   é esperado para conteúdo documental consultado; eventos de importação
   não exigem esse campo.

7. Se cadastrou o destino depois de importar, defina
   `$env:FREECORPS_IDEMPOTENCY_KEY='importacao-sintetica-002'` e execute
   novamente o exemplo para gerar outra conclusão de importação. Um XML
   conhecido pode gerar `import.completed` sem novo `document.received`.

8. Ao terminar, guarde apenas evidências sanitizadas, desative o destino,
   revogue a chave de teste, encerre túnel e receptor com Ctrl+C, feche os
   terminais e remova o arquivo de segredos.

### Diagnóstico durante o quickstart

| Sintoma                                    | O que conferir                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pausada, zero tentativas, envio desativado | O servidor não tentou entregar. O operador habilita o transporte no deployment autorizado; depois, reenvie a entrega. Destino ativo não habilita o transporte.           |
| Túnel conectado, sem entrega               | URL atual com `/webhook`, mesma porta no túnel/receptor, ambos os terminais abertos e histórico em Ver tentativas. Abrir a URL no navegador não testa o POST do webhook. |
| HTTP 400                                   | JSON do arquivo, segredo e versão do destino, relógio e bytes da entrega. Não exponha o segredo no relato.                                                               |
| HTTP 503                                   | Terminal do receptor, URL da API, chave vigente, `documents:read`, empresa e ambiente; pode haver falha na consulta documental.                                          |
| `Defina FREECORPS_…`                       | Execute o bloco de variáveis nesse terminal, não apenas na janela da importação.                                                                                         |
| Avisos Type Stripping ou SQLite            | No Node 22 do ensaio, não impediram a conclusão. Confira o resultado final ou a mensagem de início do receptor.                                                          |
| `MODULE_TYPELESS_PACKAGE_JSON`             | No projeto novo e exclusivo do teste, `npm pkg set type=module` declara ESM e remove esse aviso. Não é necessário para interpretar um resultado já concluído.            |

O envio depende da configuração de cada instalação. No piloto hospedado de
07/10/2026, o operador ativou o transporte antes dos reenvios bem-sucedidos.
Isso não configura outros ambientes nem substitui a prova no destino escolhido.

## Prova e limites

`bun run sdk:prove` reconstrói o tarball a partir do checkout atual antes de
instalá-lo num consumidor temporário limpo. Não certifica um pacote anterior
com o SHA atual. A prova executa
os 14 vetores, duplicação, versão antiga e reabertura do SQLite. Essa prova usa
resposta documental sintética. `scripts/prove-webhooks.mjs --sdk` acrescenta a
jornada dos dois exemplos e o receptor empacotado contra Convex nativo local,
com HTTPS real para os eventos sintéticos. O ensaio recusa recibos de pacote
reprovados, de outro HEAD ou de checkout sujo, e confere o hash do tarball.
Recibos e limites ficam em
`docs/v1.0/evidence/74`. O aceite exige os critérios e recibos descritos nesse registro.
