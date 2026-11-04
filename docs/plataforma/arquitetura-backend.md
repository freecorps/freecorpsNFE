# Arquitetura do backend

Este documento aprofunda as responsabilidades e as fronteiras do backend da
plataforma (`platform/convex` e `packages/*`). A visão geral do produto, da
borda e do fluxo de uma requisição está em [ARQUITETURA.md](../ARQUITETURA.md);
cada domínio tem seu contrato nesta pasta. O plano B00–B11 que originou este
desenho é histórico e está em
planejamento-v1/backend.md.

## Camadas e organização dos arquivos

O backend é um monólito modular em Convex. Funções públicas existem apenas
para operações autenticadas do console (sessão Better Auth) e para as rotas
REST registradas em `platform/convex/http.ts`. Actions fazem I/O externo e
leem ou efetivam estado por queries e mutations internas. Toda função tem
validators; resultados públicos usam DTOs que não expõem segredos, campos
administrativos nem IDs internos de storage.

Cada domínio segue o mesmo arranjo de arquivos:

| Arquivo                           | Responsabilidade                                                      |
| --------------------------------- | --------------------------------------------------------------------- |
| `<domínio>.ts`                    | Queries e mutations do console e funções internas do domínio          |
| `<domínio>Rest.ts`                | Rotas REST do domínio, montadas sobre o transporte comum              |
| `<domínio>Worker.ts`              | Execução assíncrona em fila (Workpool) e actions Node                 |
| `lib/<domínio>Schema.ts`          | Tabelas e índices, reunidos em `schema.ts`                            |
| `lib/<domínio>Values.ts`          | Validators e tipos compartilhados pelas funções                       |
| `lib/<domínio>Core.ts`/`Rules.ts` | Regras puras e testáveis, sem acesso ao banco                         |
| `lib/<domínio>Access.ts`          | Autorização do domínio sobre organização, projeto, empresa e ambiente |

`lib/organizationAccess.ts` e `lib/projectAccess.ts` são a base dos demais
`*Access.ts`. Regras de autorização e de estado ficam na função que lê ou
escreve; validação no formulário ou no contrato REST é só feedback.

## Pacotes e grafo de dependências

O grafo permitido está em `scripts/build/package-boundaries.json` e é conferido por
`bun run ci:boundaries` (dentro de `ci:local` e do CI). Cada workspace precisa
de classificação explícita; um workspace novo sem classificação é recusado.

| Pacote               | Tipo       | Depende de                                             |
| -------------------- | ---------- | ------------------------------------------------------ |
| `fiscal-core`        | puro       | nada                                                   |
| `contracts`          | puro       | `fiscal-core`, `zod`                                   |
| `sdk`                | puro       | `contracts`, `zod`                                     |
| `fiscal-nfe`         | Node       | `fiscal-core` e bibliotecas de XML/assinatura          |
| `fiscal-nfse`        | Node       | `fiscal-core`, XML/assinatura, PDF e QR Code           |
| `fiscal-nfse/pure`   | puro       | `fiscal-core`; único subcaminho que mutations importam |
| `platform`, `apps/*` | plataforma | pacotes acima                                          |

Nenhum pacote importa Convex, Better Auth, Clerk, React ou Cloudflare, nem lê
`process`, variáveis de ambiente ou outro runtime ambiente; o verificador
falha nesses casos. Um subcaminho de export pode estreitar as regras do seu
workspace, nunca ampliá-las.

Pacotes não guardam estado. Conectores Node (distribuição em
`fiscal-nfe/src/distribution.ts`, transporte ADN em `fiscal-nfse`) recebem
transporte e credencial em tempo de execução e não armazenam cursor, agendam
retry, giram certificados nem decidem permissões. Só o backend coordena
certificados, checkpoints, tentativas e consumo. Os contratos públicos de
`packages/contracts` mapeiam o domínio; o schema do banco não é a API.

`fiscal-core` contém só conceitos compartilhados comprovados, como a
identificação fiscal e o decimal exato em texto. Cada modelo fiscal tem seu
pacote (`fiscal-nfe` para NF-e 55, `fiscal-nfse` para emissão NFS-e); a
importação de lotes NFS-e ABRASF foi retirada em 02/11/2026. Não se cria
representação universal de documentos nem pacote vazio antecipadamente; uma
extração nova exige consumo ou responsabilidade demonstrados.

## Modelo de dados

O schema vigente está em `platform/convex/schema.ts` e nos
`platform/convex/lib/*Schema.ts`. Tabelas por domínio:

| Domínio                   | Tabelas                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Organizações e contas     | `organizations`, `memberships`, `invitations`, `organizationAudit`, `emailChanges`, `developmentMail`, `onboarding`                                                                              |
| Empresas                  | `companies`, `companyGrants`, `companyAudit`                                                                                                                                                     |
| Projetos e chaves         | `projects`, `projectCompanies`, `apiKeys`, `integrationAudit`, `apiUsageEvents`, `apiUsageTotals`                                                                                                |
| Operações                 | `operations`, `operationAttempts`, `operationReceipts`, `operationAudit`, `idempotencyRecords`, `operationProofDocuments`                                                                        |
| Importação e documentos   | `imports`, `importFiles`, `importMaintenance`, `fiscalDocuments`, `documentVersions`, `documentItems`, `documentArtifacts`, `documentFiscalEvidence`, `documentListings`, `documentDownloads`    |
| Certificados e captura    | `certificates`, `certificateHeads`, `certificateAudit`, `captureStreams`, `captureBatches`, `captureEnvelopes`, `captureBatchEntries`, `captureAudit`, `captureProofResponses`                   |
| Emissão NFS-e             | `nfseProfiles`, `issuances`, `dpsSequences`, `issuanceCancellations`, `issuanceArtifacts`, `issuanceEvents`, `issuanceGates`, `issuanceGateEvents`, `issuanceProbeEvents`, `issuanceSimulations` |
| Webhooks                  | `webhookEndpoints`, `outboxEvents`, `webhookDeliveries`, `webhookAttempts`                                                                                                                       |
| Stripe                    | `stripeConnections`, `stripeEvents`                                                                                                                                                              |
| Referências e CNPJ        | `referenceVersions`, `referenceEntries`, `referenceActive`, `referenceAudit`, `registryCache`, `registryCalls`, `registryApplications`                                                           |
| Consumo                   | `usagePlans`, `usagePlanAudit`, `usageEvents`, `usageTotals`, `usageLeases`                                                                                                                      |
| Exportação e encerramento | `documentExports`, `exportParts`, `exportTickets`, `organizationClosures`, `retentionHolds`                                                                                                      |
| Observabilidade e acesso  | `operationalAudit`, `operationalFailures`, `operationalMonitors`, `operationalAlerts`, `operationalNotifications`, `operationalRetention`, `accessRecords`, `accessRetention`                    |
| Validação                 | `validationAccess`, `validationProbes`                                                                                                                                                           |

Invariantes do modelo:

- Todo registro privado carrega a organização e, quando aplicável, projeto,
  empresa e ambiente. Identidades externas são strings estáveis, independentes
  de `_id`.
- Índices nomeiam todos os campos, conforme as guidelines do Convex.
  Indexação não impõe unicidade: a leitura de reserva e a escrita ocorrem na
  mesma mutation, com teste de concorrência.
- Itens, eventos, tentativas e membros ficam em tabelas próprias; arrays não
  crescem sem limite dentro de um documento.
- O mesmo CNPJ pode existir em organizações diferentes, com autorização
  independente; isso não compartilha documentos entre clientes.
- Na captura, `captureStreams` tem um único stream por identidade fiscal
  efetiva, ambiente e serviço (`by_identity_environment_service`); a
  titularidade e a transferência estão em [CAPTURE.md](CAPTURE.md).
- A guarda de cada classe de dado, inclusive `accessRecords`, está em
  [RETENTION.md](RETENTION.md).

## Identidade, autorização e ambiente

Better Auth é a fonte única de sessões humanas, com o componente Convex e
e-mail OTP. Os plugins `organization` e `apiKey` do Better Auth não estão
instalados: organizações, memberships, convites e API keys pertencem ao
domínio do produto. `validationAccess` não concede membership. Organização,
projeto e empresa são autorizados pelos helpers de domínio, sem confiar no
`organizationId` enviado pelo cliente.

Os papéis e suas permissões estão em [ORGANIZATIONS.md](ORGANIZATIONS.md). Os
escopos de API key estão em `packages/contracts/src/projects.ts`
(`integrationScopes`) e o contrato de concessão em [PROJECTS.md](PROJECTS.md).
Membros não ampliam as próprias concessões: `grantableScopes` limita o que cada
papel delega (`developer` concede só leituras e `webhooks:manage`), e uma chave
tem a interseção dos seus escopos com as empresas e ambientes concedidos ao
projeto. Uma API key não representa a sessão de um membro. Cookies de
autenticação e headers secretos nunca entram na telemetria.

Cada deployment roda sob um perfil da plataforma (`APP_ENV`): `development`
(stack local em loopback), `validation` (deployment controlado de validação)
ou `installation` (instalação hospedada). `requirePlatformEnvironment`, em
`platform/convex/environment.ts`, confere as variáveis do perfil e recusa
qualquer outra combinação. O perfil não escolhe o ambiente do produto nem o
transporte fiscal.

Há dois eixos de ambiente, e toda operação conhece ambos:

- Ambiente do produto: `sandbox` ou `production` (`integrationEnvironments`),
  parte do escopo de chaves, empresas e documentos. Ele é resolvido por
  pedido ([ADR 0007](../adr/0007-captura-fiscal-no-site.md)): a chave ou a
  operação diz o ambiente, e `environmentServed`, em
  `platform/convex/lib/environmentAccess.ts`, decide se o deployment o atende
  para aquela empresa e escopo. O ambiente base do deployment
  (`baseEnvironment`, o `PRODUCT_ENV`) é sempre atendido; empresa de
  demonstração, só em `sandbox`. Um deployment de base `production` (#50,
  produção fiscal da NFS-e) não atende outro. Um de base `sandbox` atende
  `production` só para empresa com captura fiscal liberada
  (`platform/convex/lib/fiscalCaptureRelease.ts`) e só para captura, documentos, webhooks e
  monitores; importação, emissão, cadastro, referências e certificados nunca.
  Depois de retirada a liberação, sobra só a leitura do que foi capturado
  ([CAPTURE.md](CAPTURE.md#liberação-fiscal-no-site)). As
  verificações de acesso não leem `PRODUCT_ENV`, e
  `platform/convex/environmentIsolation.test.ts` falha se uma passar a ler.
- Ambiente fiscal: `FISCAL_ENV`, `disabled` por padrão. Transporte real é
  opt-in explícito por deployment (`platform/convex/environment.ts`); na
  emissão, o modo de transporte é `simulated`, `producao-restrita` ou
  `producao`, com o gate por empresa descrito em [ISSUANCE.md](ISSUANCE.md).

O usuário não escolhe endpoint fiscal arbitrário. Crons ficam desligados nos
ambientes de validação e locais (`FNFE_CRONS=off`).

## Contrato REST

As rotas e os schemas estão em [API-REFERENCE.md](../v1.0/API-REFERENCE.md) e
[openapi.json](../v1.0/openapi.json), gerados de `packages/contracts`. Regras
comuns da implementação:

- As rotas JSON (`*Rest.ts`) usam `jsonRoute` de
  `platform/convex/lib/externalHttp.ts`. O transporte confere o formato da
  chave, lê o corpo uma vez dentro do limite da rota (16 KiB; webhooks 8 KiB e
  reprocessamento 1 KiB respondem `413`), recusa UTF-8 ou JSON inválido, valida
  a entrada pelo contrato e entrega ao domínio a rota e a entrada
  interpretadas. O domínio continua validando autorização, escopo e estado na
  própria transação. O resultado é conferido contra a saída e o status do
  contrato antes da serialização, e as referências de operação e evento da
  telemetria vêm desse resultado, sem reler a resposta. Upload, downloads
  binários e o webhook do Stripe, que assina o corpo bruto, mantêm transportes
  próprios.
- Erros têm `requestId` e `error` com `code`, `message` e `retryable`; sem
  stack trace nem `200` com erro disfarçado. Códigos, status, campos seguros
  (como `field`) e mensagens públicas saem de
  `platform/convex/lib/publicErrors.ts`; cada rota informa só o texto de
  `NOT_FOUND` do seu domínio. Código fora do contrato vira `UNAVAILABLE`, sem
  copiar texto do erro interno. Os status em uso são `400`, `401`, `403`,
  `404` (inexistente ou não visível), `409` (conflito ou idempotência
  divergente), `413`, `429` e `503`.
- `Idempotency-Key` é obrigatória em pedidos assíncronos com efeito. A
  identidade é organização + projeto + operação lógica + chave, com hash do
  pedido: o mesmo pedido devolve o mesmo recurso, um pedido diferente devolve
  `409`. A reserva acontece antes do agendamento e dura 7 dias
  (`lib/operationCore.ts`); a deduplicação documental é independente.
- Paginação por cursor opaco, vinculado a filtros e escopo, com desempate
  estável. O limite de página é definido por rota no contrato (em geral até
  50). Uma lista vazia pode ter próxima página.
- Valores fiscais são decimais em texto canônico com escala documentada;
  inteiros ficam na faixa segura. Ver
  [fiscal-core](../../packages/fiscal-core/README.md).
- `parserVersion`, `schemaVersion`, `normalizerVersion`, `importedAt`, hash do
  artefato e datas da fonte são metadados distintos; DTOs expõem só os
  pertinentes ao consumidor autorizado.
- A evolução dentro de v1 é aditiva; mudança incompatível exige nova versão ou
  janela de migração publicada. O SDK não expõe tipos do banco ou do Convex.

### Identidades que não se substituem

| Identidade  | Chave e finalidade                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Solicitação | Organização + projeto + operação lógica + `Idempotency-Key`, com hash do pedido; recupera a intenção ou recusa com `409` |
| Documento   | Organização + empresa + ambiente + modelo + chave de acesso; pedidos diferentes podem apontar para a mesma nota          |
| Artefato    | SHA-256 dos bytes originais; distingue XMLs da mesma nota, conservando origem e conflito                                 |

O hash não concede acesso nem deduplica entre clientes. Um resumo que evolui
para XML completo mantém a identidade documental.

## Trabalho assíncrono e recuperação

A mutation grava a operação e agenda a execução na mesma transação; Workpool
limita a concorrência por domínio. A operação tem `generation` e lease
(`leaseUntil`): o resultado de uma execução antiga não sobrescreve o de uma
nova. O ciclo, os estados e a recuperação estão em
[OPERATIONS.md](OPERATIONS.md). Regras que valem para todos os workers:

- Distinguir falha transitória, rejeição definitiva e resultado externo
  incerto; só repetir automaticamente o que é comprovadamente idempotente.
- Timeout ou queda entre a chamada externa e a persistência exige
  reconciliação antes de repetir: filas não dão exactly-once para efeitos fora
  do banco. Na emissão, o reconciliador consulta a DPS antes de qualquer
  reenvio ([ISSUANCE.md](ISSUANCE.md)); na captura, o lote bruto e o NSU são
  persistidos antes de avançar o cursor ([CAPTURE.md](CAPTURE.md)).
- Próxima tentativa, backoff e orçamento de tentativas ficam persistidos;
  nenhuma action dorme esperando a fonte. Varreduras de recuperação são
  indexadas e limitadas por lote.
- Abortar uma execução impede passos futuros, mas não desfaz efeito fiscal já
  confirmado externamente; o retorno público informa essa distinção.
- O outbox de webhooks é gravado na mesma transação da alteração pública; uma
  nova tentativa de entrega não cria evento lógico novo
  ([WEBHOOKS.md](WEBHOOKS.md)).

## Documentos fiscais

O XML original é imutável e passa por representações separadas, sem exigir
quatro cópias no banco:

```text
XML original imutável
    → parsing → modelo específico do documento
    → normalização versionada
    → mapeamento autorizado → DTO público discriminado por modelo
```

Cada processamento identifica schema, parser e normalizador, com resultados
separados de parsing, XSD, assinatura e evidência fiscal. Reprocessar publica
uma versão completa nova sem alterar o original nem misturar resultados
parciais. A situação fiscal deriva de evidências preservadas por regra
determinística, reproduzível diante de repetição e ordem diferente; não há
event sourcing para os cadastros. Contratos em [IMPORTS.md](IMPORTS.md) e
[DOCUMENTS.md](DOCUMENTS.md).

## Certificados

PFX e senha são cifrados com AES-256-GCM por envelope versionado, com contexto
de organização, empresa e versão; o keyring vem de
`FNFE_PLATFORM_CERT_KEYS`, fora do banco. O material só é aberto no runtime de
transporte, a API devolve metadados (validade, fingerprint, estado) e nunca o
segredo, e o uso é auditado. A decisão está na
[ADR 0003](../adr/0003-cofre-de-certificados-da-plataforma.md); o contrato e a
rotação, em [CERTIFICATES.md](CERTIFICATES.md); a recuperação das chaves, em
[restauracao.md](../operacao/restauracao.md).

## Testes por camada

| Camada              | O que precisa estar coberto                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| Pacotes puros       | CNPJ/CPF, decimais, schemas, parsing, normalização e hash                          |
| Persistência Convex | Autorização negativa, unicidade concorrente, cursor, claims, idempotência e outbox |
| Contrato HTTP       | Validação, erros, paginação, compatibilidade, revogação e limites                  |
| Transporte          | mTLS, timeout, resposta incerta, bloqueio de hosts e descompressão                 |
| Operação            | Falha em pontos de persistência, restore, rotação e reenvio                        |
| Consumidor          | SDK e curl contra a API de teste                                                   |

Os testes de integração ficam ao lado do módulo, em `platform/convex/`; a escolha dos
checks está na seção "Verificando" do [AGENTS.md](../../AGENTS.md#verificando).
Testes com transporte simulado não comprovam integração fiscal real.
