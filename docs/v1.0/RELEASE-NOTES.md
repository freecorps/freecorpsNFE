# Notas por entrega: rascunho

Rascunho para revisão. Não foi publicado como release, tag, anúncio ou
pacote. O aceite fica na issue da entrega, conforme a [ADR 0011](../adr/0011-entregas-graduais.md). Nome comercial:
Freecorps Fiscal, decidido em 18/10/2026. Antes de publicar, confira cada item contra o commit
candidato, o [contrato](API-REFERENCE.md) e as [evidências](EVIDENCE.md),
e remova o que não estiver no escopo autorizado. O
[material de lançamento](LAUNCH.md) traz o texto curto, o roteiro de
demonstração e o checklist de divulgação.

Referência histórica da consolidação de 26/10/2026: `71b754a8c724cd0e2ccb3b3417f62f0fdf4e6e38`, a `main`
depois do #502, com a consolidação de 26/10/2026.
Cada publicação escolhe seu SHA e recorte destas notas. As lacunas e seus
encaminhamentos estão em [ACCEPTANCE.md](ACCEPTANCE.md#pendências-atuais-e-condições-de-saída).

## Resumo

Infraestrutura fiscal para software brasileiro, com primeira cobertura em
NF-e modelo 55. A plataforma importa XML de NF-e, preserva os
originais e entrega documentos normalizados pelo painel, pela API REST
`/v1` e pelo SDK TypeScript, com notificações por webhook assinado. No site
hospedado, a empresa que ativa a captura fiscal no console recebe as NF-e
emitidas contra o CNPJ dela pela distribuição DF-e da Receita.
**Emissão com validade fiscal e cálculo tributário não fazem parte da oferta disponível.**

## Desde o rascunho de 22/10/2026

Entraram as PRs integradas de 22/10 a 26/10/2026: a captura fiscal no site
(ADR 0007) e os PRs #467–#502. Esta seção diz o que muda para quem integra e
para quem opera; as seções seguintes descrevem a versão inteira.

### Para quem integra

**Contrato 8.0.0: atualize o SDK antes de ler documentos.** A janela da 1.0
teve dois majors, e um SDK gerado de um contrato anterior recusa as respostas
novas com `FreecorpsError` de código `INVALID_RESPONSE`, mesmo com a API
respondendo com sucesso. O SDK confere as respostas com objetos e enums
estritos:

- **7.0.0.** A NF-e completa (`payload.kind: "invoice"`) ganhou
  `declaredTotals`, `purpose` e `nt2026008`, e cada item ganhou `nt2026008`.
- **8.0.0.** `fiscalSituation.ruleVersion` aceita `nfe-status/2`, a regra que
  toda situação reconstruída depois da publicação passa a usar. O evento de
  webhook `connection.history_limited` entrou no enum de eventos.

Isso vale para as rotas que devolvem o documento, o payload ou os itens de
uma NF-e: consulta do documento, JSON, versões e itens. A lista e o cadastro
de destinos de webhook também recusam um destino que assina o evento novo.
Listagem de documentos, importação, captura e exportação não mudaram de
forma.

O que fazer:

1. Instale o SDK pelo npm: `npm install @freecorps/freecorpsnfe-sdk`. A versão `0.1.0`, publicada
   em 01/11/2026 como `@freecorps/sdk`, já traz o contrato 8.0.0; o nome mudou
   em 03/11/2026.
2. Se você valida as respostas com schemas próprios gerados do OpenAPI,
   gere-os de novo do `openapi.json` 8.0.0.
3. Nenhum campo antigo mudou de significado: `total` continua sendo o
   `ICMSTot/vNF` declarado, e o código que já chama o SDK continua o mesmo.

A 6.0.0, da mesma janela, acrescentou o evento `connection.release_withdrawn`.
Um destino que não assina um evento novo não recebe nada novo.

**Campos fiscais da NF-e.** `declaredTotals.vNF` e `declaredTotals.vNFTot`
trazem os dois totais como declarados; `vNFTot` ausente é `null`, nunca
calculado. `purpose` traz a finalidade e os tipos de nota de crédito e de
débito, com o código declarado, a descrição oficial e as combinações que a
SEFAZ rejeitaria. `nt2026008` traz os valores líquidos e o ICMS previsto da
NT 2026.008, validados pelo pacote oficial PL_010g v1.03, publicado em
26/10/2026. Documentos processados antes desses campos vêm com
`purpose: null` ou `nt2026008: null`; reprocesse para extraí-los do
original. Um documento recusado no XSD pelo PL_010f passa a `authorized`
quando reprocessado ou reconstruído, se só o XSD o recusava; as duas
interpretações ficam no histórico. `nt2026006` traz o grupo `gPgtoVinc` da
NT 2026.006, a vinculação com a transação de pagamento, em texto como
declarado (#501). Cada pagamento traz o código do meio de pagamento
(`tpMeioPgto`) e, em `tpMeioPgtoLabel`, a descrição da tabela do IT DFe
2026.001 v1.01 (publicado em 25/08/2026), ou `null` para um código fora dela,
que continua como declarado; as regras de validação dessa NT não são
avaliadas.
Documentos anteriores vêm com `nt2026006: null` até o reprocessamento.

**Eventos da Reforma Tributária.** Os eventos do fornecedor 112110 a 112150
(NT 2025.002 v1.40), importados ou capturados, entram no histórico da NF-e e
disparam `document.event_received`, sem mudar a situação. Os campos próprios
deles ficam no XML e em `unsupportedFields`. Os outros eventos novos do
portal continuam recusados como `XML_EVENT_UNSUPPORTED`, com o original
guardado.

**Vinculação Pagamento (110300).** O evento do emitente que vincula a NF-e a
uma transação de pagamento (NT 2026.006 v1.00), importado ou capturado, entra
no histórico da NF-e pelo `nfe-parser/7`, validado contra o XSD do PL_010g, e
dispara `document.event_received`. Ler o evento não confirma pagamento nem
liquidação de tributo, e a situação não muda. Os campos do pagamento ficam no
XML e em `unsupportedFields`, sem mudança de contrato. O cancelamento dele
(evento 110001) continua `XML_EVENT_UNSUPPORTED`, e não há fonte oficial que
diga se a distribuição o entrega ao destinatário. Um 110300 recusado antes
continua recusado e guardado; importá-lo de novo cria um registro aceito.

**Autor dos eventos do emitente.** Desde o `nfe-parser/8` (#532), um
cancelamento, CC-e, evento RTC 112110 a 112150 ou 110300 cujo autor não é o
emitente da chave de acesso é recusado com `IDENTITY_INVALID`, na importação e
na captura, com o original guardado e fora do histórico da NF-e. Um
cancelamento assinado por outro CNPJ não cancela mais a nota. Reprocessar um
evento desses já aceito marca a divergência de processamento na situação.

**Produção para a empresa com captura fiscal.** No site, o ambiente
`production` existe só para a empresa que ativou a captura fiscal no
console, e atende captura, documentos capturados, exportação e webhooks.
Importação e emissão continuam só no sandbox. Ativar a captura revoga as
chaves de produção que já alcançavam a empresa: gere chaves novas depois.
Uma chave ou uma concessão de projeto em produção para empresa sem a ativação
recebe `ENVIRONMENT_DENIED`. `GET /v1/capabilities` com chave de produção
devolve só o que a produção atende, com `models: ["55"]`.

**Captura de NF-e.** O fluxo está em `/docs/captura-nfe`. A próxima consulta
sai em um segundo enquanto a fonte tem fila, e no fim da fila espera o
intervalo mínimo que a empresa escolheu, de 1 a 24 horas. `GET
/v1/connections/nfe` traz o motivo em `code` (`SOURCE_COOLDOWN`,
`CAPTURE_FISCAL_DENIED`, `CAPTURE_RELEASE_WITHDRAWN`,
`CAPTURE_FISCAL_HALTED` e outros) e, em `sourceMaxNsu`, o último NSU que a
Receita informou, `null` até a primeira resposta. Pela API, retomar um
bloqueio 656 antes de `nextAllowedAt` responde `SOURCE_COOLDOWN` (409,
`retryable: true`), com `nextAllowedAt` no corpo do erro; espere o horário em
vez de repetir. A plataforma não manifesta: uma nota que chega só
como resumo pode ganhar o XML completo depois que a empresa registra a
Ciência da Operação fora da plataforma.

**Perda aceita numa captura de integração.** Quando a fonte não tem mais um
trecho da fila, só o Proprietário da organização aceita a perda, no console e
com motivo, também numa captura que a integração ativou. A captura continua
da integração, com a chave dela, e o destino que assina
`connection.history_limited` recebe o intervalo perdido em `data.lost` e
`decidedBy: "owner"`, sem o motivo nem a pessoa. É o único evento com `data`.

**Cota por ambiente.** Cada ambiente tem saldo próprio sob os mesmos números
do plano: consumir o sandbox não pausa nem recusa nada em produção. A recusa
continua `RATE_LIMITED` (429). Somando os dois ambientes, uma organização
pode consumir até o dobro de cada limite.

### Para quem opera

**Atribuição do uso antigo: obrigatória em cada deployment com dados.**
O site (`elated-possum-295`, 27/10) e a validação (`modest-seal-118`, 28/10)
já foram migrados, e a produção fiscal da NFS-e não tem deployment; não
repita neles. Em outra instalação com dados, depois de publicar o candidato,
execute `usageMigration:backfillEnvironment` com `{"cursor":null}` em cada
deployment, conferindo o alvo por
[deploy-producao.md](../operacao/deploy-producao.md). Acompanhe as linhas
`usage_environment_backfill` do log até `stage: "totals"` com `isDone: true`
e anote a soma de `unresolved`. Até lá, nessa instalação, o consumo antigo
conta contra os dois ambientes, como antes. A entrega que tornar
`environment` obrigatório só pode sair depois de todos os deployments
concluídos ([USAGE.md](../plataforma/USAGE.md#registros-anteriores-à-separação)).

**Situação dos documentos já importados.** As situações gravadas continuam
com `nfe-status/1` até a próxima reconstrução de cada documento. Quantos
documentos com os campos da NT 2026.008 foram importados nos ambientes
hospedados antes do PL_010g não foi verificado; eles mudam de situação quando
reconstruídos.

**Eventos recusados antes do #498.** Os originais de evento recusados com
`XML_EVENT_UNSUPPORTED` (ou de leiaute com `XML_SCHEMA_UNSUPPORTED`) por um
leitor anterior, importados ou capturados, não entram sozinhos no histórico.
Em Documentos, "Arquivos sem documento reconhecido", owner, admin ou operator
pede "Reprocessar recusas técnicas" por empresa e ambiente (#499), também em
Produção do site com a captura liberada ou já retirada. A versão recusada
continua no histórico do original. Pedir de novo enquanto a execução anda
devolve a mesma; depois, uma nova execução pega só o que sobrou, sem repetir
webhook. As filhas entram uma a cada 2 segundos na fila de importação.

**Contrato publicado.** O gate de contrato compara com o último contrato
publicado, registrado em `packages/contracts/published.json`: o 8.0.0, desde
01/11/2026, com versão, commit e SHA-256 do OpenAPI
([release.md](../operacao/release.md)). Mudar uma rota existente volta a exigir
major.

**Termos da captura versionados.** O texto aceito de cada versão fica em
[`docs/termos/arquivo/`](../termos/README.md), com o SHA-256 no servidor, e
o aceite grava versão, hash, pessoa e hora. Uma versão nova vale só para
novas ativações: o produto não pede novo aceite a quem já ativou.

**Emergência, desbloqueio e parada geral.** Os workflows
`capture-release-emergency.yml`, `capture-release-unblock.yml`,
`capture-fiscal-halt.yml`, `capture-fiscal-resume.yml` e
`capture-release-list.yml` (desde a [#57](https://github.com/freecorps/freecorpsNFE/pull/57), operações de
`capture-fiscal.yml`) agem sem aprovação, para quem está em
`deploy/issuance-gate.json`. O desbloqueio é recusado com
`CAPTURE_RELEASE_NOT_BLOCKED` numa empresa sem bloqueio e nunca religa
nada. A parada geral adia as consultas de todas as empresas sem gastar cota
e termina sozinha; o corte por variável deixa cada captura em atenção, à
espera de "Retomar captura".

**Runbooks.** [captura-fiscal.md](../operacao/captura-fiscal.md) cobre
desligar tudo ou uma empresa, `/health` ruim, ligar de novo depois da
parada geral ou do corte por variável, 656 e esperas, renovação do A1,
lacunas e a perda aceita, alertas, dois consumidores do mesmo CNPJ e
restauração sem transporte.

**Supervisão.** Cada empresa liberada tem verificação de 6 em 6 horas, sem
cron, que registra alertas de atenção, parada, silêncio de 30 e 50 dias,
lacuna antiga e A1 perto do vencimento. Os alertas chegam à caixa de operação,
em `/console/operacao`, com entrega comprovada em 28/10 pelo e-mail de teste
de `capture-alert-test.yml` (#463), hoje a operação `alert_test` de
`capture-fiscal.yml` ([#57](https://github.com/freecorps/freecorpsNFE/pull/57)). Depois de 20
linhas de auditoria sem lote, o painel deixa de mostrar a fila da fonte
(#494).

## O que entra

### Contas, organizações e acesso

- Contas novas com verificação de e-mail e recuperação de senha. Login não
  concede acesso a dados: o acesso vem do papel na organização (`owner`,
  `admin`, `developer`, `operator` ou `viewer`) e de convites aceitos.
- Empresas por organização, com CNPJ numérico ou alfanumérico validado.
  Empresas de demonstração servem ao primeiro uso com XML sintético.
- Projetos de integração com API keys restritas por escopo, ambiente e
  concessão de empresa. O segredo aparece uma vez; rotação e revogação ficam
  no painel.
- Encerramento da organização pelo owner, com janela de exportação antes da
  exclusão do cadastro. Prazos e classes de dados em [RETENTION](../plataforma/RETENTION.md).

### Documentos

- Importação assíncrona de XML de NF-e 55 pelo painel e pela API, sem
  certificado fiscal: reserva idempotente, envio, confirmação e operação
  acompanhável, até 20 arquivos por reserva e 2 MiB por arquivo.
- A importação de lotes NFS-e no leiaute de exportação ABRASF saiu em
  02/11/2026. Um XML ABRASF é recusado com `XML_NAMESPACE_UNSUPPORTED`. As
  NFS-e importadas antes ficam só para leitura, com situação fiscal
  desconhecida, e seu reprocessamento é recusado.
- Consulta documental: resumo, JSON normalizado, itens paginados, eventos,
  versões, arquivos originais e reprocessamento. Valores como decimais exatos
  em texto.
- NF-e com `vNF` e `vNFTot` declarados lado a lado, sem recálculo, e com a
  finalidade e os tipos de nota de crédito e débito em códigos oficiais.
- Leitura dos campos da NT 2026.008 (valores líquidos e ICMS previsto no
  pagamento antecipado), validados pelo pacote oficial PL_010g v1.03,
  publicado em 26/10/2026 (#395). A situação fiscal passa à regra
  `nfe-status/2`: reprocessar ou reconstruir um documento recusado no XSD
  pelo PL_010f deixa a interpretação do PL_010g substituí-la, sem apagar a
  anterior.
- Eventos do fornecedor da Reforma Tributária no histórico da NF-e
  (NT 2025.002 v1.40, tipos 112110 a 112150), importados ou capturados, sem
  mudar a situação. O catálogo de schemas acompanha o portal por um
  levantamento datado e `bun run xml:portal` (#389).
- Evento 110300, Vinculação Pagamento (NT 2026.006), no histórico da NF-e,
  importado ou capturado, sem mudar a situação nem confirmar pagamento (#405).
- O autor de um evento do emitente precisa ser o emitente da chave de acesso
  (#532).
- Recusas técnicas de um leitor anterior são reprocessadas a pedido no
  console, por empresa e ambiente, com a recusa mantida no histórico (#499).
- Deduplicação por organização, empresa, ambiente, modelo e chave fiscal.
  Repetir um pedido com a mesma `Idempotency-Key` preserva a identidade.
- Exportação privada de documentos, com partes identificadas por SHA-256.

### Integração

- Contrato REST `/v1` descrito em OpenAPI 3.1, versão do contrato 8.0.0,
  com envelope de erro estável (`code`, `message`, `retryable`, `requestId`).
  As mudanças do contrato estão em [SDK.md](SDK.md).
- SDK TypeScript `@freecorps/sdk` 0.1.0 e verificador de webhook sem
  dependências SaaS. Publicado no npm em 01/11/2026, com
  `@freecorps/fiscal-core`, `@freecorps/fiscal-nfe` e `@freecorps/fiscal-nfse`.
- Webhooks assinados com HMAC-SHA256, rotação de segredo com coexistência,
  retentativas limitadas, reenvio manual e histórico de tentativas. A entrega
  é pelo menos uma vez, sem garantia de ordem; o receptor deduplica por
  `eventId`.
- Consultas auxiliares: municípios IBGE, NCM vigente na coleta e consulta
  cadastral de CNPJ por provedor público, sem indicar regularidade fiscal.
- Emissão e cancelamento de NFS-e só no sandbox, com transporte simulado e
  nota sem validade fiscal.

### Captura de NF-e

- No site hospedado, captura das NF-e destinadas pela distribuição DF-e da
  Receita, em produção, empresa por empresa. Proprietário ou Administrador
  ativa no console, com o certificado A1 da própria empresa, o aceite dos
  termos e o intervalo mínimo; Operador, Administrador ou Proprietário
  inicia. A plataforma só lê: não emite, não cancela e não manifesta.
- A primeira captura real no site foi de uma empresa piloto, em 22/10/2026:
  4 consultas, 184 envelopes e 69 documentos, com
  recibo lido do deployment. A NF-e
  indicada pela empresa chegou só como resumo. O mantenedor aceitou essa
  captura em 26/10/2026 (#50, #430).
- Desativar, suspensão pela Freecorps e parada geral pausam ou adiam as
  consultas; os documentos já recebidos continuam legíveis e exportáveis.
- A fonte não garante XML completo nem histórico além de 90 dias. Um trecho
  que saiu da fonte só é dado por perdido por decisão do Proprietário no
  console, com motivo, e a integração dona da captura recebe
  `connection.history_limited`.

### Operação

- Consumo por organização e por ambiente, com plano assistido e limites
  explícitos. A captura em produção exige plano vigente com cotas finitas,
  inclusive no Gratuito (#429). O catálogo segue desligado até a conclusão da
  #549 e, enquanto isso, a atribuição é assistida.
- Instalação própria em Docker com roteiro testado em ensaio isolado, e
  restore em volume novo. Não certifica alta disponibilidade.
- Landing e guias públicos estáticos, gerados no build e derivados do
  contrato.

## Fora da oferta disponível

Emissão com validade fiscal de qualquer modelo, cálculo ou conferência
tributária, captura de NFS-e, NFS-e nacional e outros leiautes municipais,
NFC-e, CT-e e outros modelos, manifestação do destinatário, XML completo
garantido, histórico ilimitado, SLA, checkout automático e SSO.

## Quem usava o serviço anterior

O endereço foi mantido e a plataforma começou com banco vazio. Sessões,
senhas, concessões, documentos e links do serviço anterior não foram
migrados: crie uma conta nova e peça convite. A API de emissão anterior não
é o contrato desta plataforma. Detalhes em
transicao-legado.md.

## Distribuição e licenças

Estas notas não declaram licença. O estado vigente de cada artefato está em
[LICENSING.md](../../LICENSING.md) e na
[avaliação por artefato](../licenses/DISTRIBUTION.md). sdk, fiscal-core,
fiscal-nfe e fiscal-nfse estão no npm desde 01/11/2026 (#83). Contracts continua privado.
O código está no repositório público https://github.com/freecorps/freecorpsNFE
desde 03/11/2026 (#267), sem o histórico anterior.

## Pendências antes de publicar estas notas

- Aceite do escopo anunciado na issue da entrega, com SHA, ambiente,
  evidências e limites, conforme [ACCEPTANCE.md](ACCEPTANCE.md#critérios-por-entrega).
- Publicação de termos de uso e política de privacidade, ou restrição da
  captura até eles existirem (#428).
- Pacotes: condições por artefato, versões no registry e registro do
  contrato publicado concluídos em 01/11/2026 (#83). Para anunciar fontes
  públicas, concluir a #267. Um anúncio do serviço não depende de distribuir esses artefatos.
- Autorização do mantenedor para site, indexação, pacotes, tag e anúncio.

O piloto assistido da #49 foi aceito pelo mantenedor em 07/10/2026 como
substituto do integrador externo. Não o descreva como integração externa
independente nem cite tempo de integração medido.
