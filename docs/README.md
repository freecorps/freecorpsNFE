# Documentação

Índice por tarefa da plataforma atual (`apps/console` e `platform/convex`).
Cada regra e procedimento tem uma referência principal; os demais documentos
apontam para ela. O [AGENTS.md](../AGENTS.md) resume as regras críticas para
agentes e aponta para as referências abaixo.

## Onde fica cada tipo de documento

| Pasta                                  | Responde                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`plataforma/`](plataforma/)           | Contrato atual de cada domínio e arquitetura do backend                                  |
| [`desenvolvimento/`](desenvolvimento/) | Regras do console, CI, lint e validação no navegador                                     |
| [`operacao/`](operacao/)               | Publicação, ambientes, backup, restauração e instalação própria                          |
| [`adr/`](adr/)                         | Decisões aceitas; mudança posterior entra em "Situação" datada, sem reescrever a decisão |
| [`v1.0/`](v1.0/)                       | Contrato REST gerado, aceite, evidências e material de lançamento                        |
| [`termos/`](termos/)                   | Termos da captura, termos de uso e política, com versão e hash, e o rascunho da captura  |

O estado tem uma fonte por pergunta. [ACCEPTANCE.md](v1.0/ACCEPTANCE.md)
mantém as capacidades com seus limites, os critérios de aceite e as lacunas
que bloqueiam o aceite, cada uma com sua condição de saída, evidência e issue;
[EVIDENCE.md](v1.0/EVIDENCE.md) cataloga os recibos e explica como registrar
uma execução. O andamento, as próximas ações e o aceite ficam na issue de cada entrega,
conforme a [ADR 0011](adr/0011-entregas-graduais.md). Não há lançamento
global da plataforma 1.0; `docs/v1.0` conserva seu nome e os contratos técnicos. Recibos
conservam SHA, data, ambiente e limites e não são atribuídos ao HEAD.

As referências `#NNN` escritas nos documentos até 03/11/2026 são issues e PRs
do repositório arquivado, `freecorps/freecorpsNFE-arquivo`, que é privado; as
issues que continuavam abertas foram recriadas aqui com números novos, e cada
uma cita o número antigo na primeira linha.

## Fluxo de desenvolvimento

### 1. Preparar o ambiente

Pré-requisitos e início rápido no [README principal](../README.md#desenvolvimento-local).
[worktrees.md](worktrees.md) é a referência para criar, preparar, iniciar e
limpar ambientes locais, com portas, crons e contas de teste. `bun run help`
lista cada script com a aplicação e o ambiente que ele atinge.

### 2. Localizar o domínio

A visão geral está em [ARQUITETURA.md](ARQUITETURA.md); responsabilidades e
fronteiras do backend, em [arquitetura-backend.md](plataforma/arquitetura-backend.md);
o mapa de pastas, em [ARQUITETURA.md](ARQUITETURA.md#mapa-do-repositório).

| Domínio                     | Contrato                                                                                                         | Código principal                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Organizações e membros      | [ORGANIZATIONS.md](plataforma/ORGANIZATIONS.md)                                                                  | `platform/convex/organizations.ts`, `lib/organizationAccess.ts`           |
| Empresas e concessões       | [COMPANIES.md](plataforma/COMPANIES.md)                                                                          | `platform/convex/companies.ts`, `lib/companyAccess.ts`                    |
| Projetos e API keys         | [PROJECTS.md](plataforma/PROJECTS.md)                                                                            | `platform/convex/projects.ts`, `keys.ts`, `lib/projectAccess.ts`          |
| Importação de XML           | [IMPORTS.md](plataforma/IMPORTS.md)                                                                              | `platform/convex/imports.ts`, `import*.ts`, `packages/fiscal-nfe`         |
| Esquemas XML da NF-e        | [NFE-SCHEMAS.md](plataforma/NFE-SCHEMAS.md)                                                                      | `packages/fiscal-nfe/schemas/`, `scripts/fiscal/sync-nfe-schemas.py`      |
| Documentos e downloads      | [DOCUMENTS.md](plataforma/DOCUMENTS.md)                                                                          | `platform/convex/documents.ts`, `document*.ts`                            |
| DANFE da NF-e (gerador)     | [DANFE.md](plataforma/DANFE.md)                                                                                  | `packages/fiscal-nfe/src/danfe*`                                          |
| Operações assíncronas       | [OPERATIONS.md](plataforma/OPERATIONS.md)                                                                        | `platform/convex/operations.ts`, `operation*.ts`                          |
| Certificados e captura NF-e | [CERTIFICATES.md](plataforma/CERTIFICATES.md) e [CAPTURE.md](plataforma/CAPTURE.md)                              | `platform/convex/certificate*.ts`, `capture*.ts`                          |
| Webhooks                    | [WEBHOOKS.md](plataforma/WEBHOOKS.md)                                                                            | `platform/convex/webhook*.ts`, `lib/webhook*.ts`                          |
| Emissão NFS-e (sandbox)     | [ISSUANCE.md](plataforma/ISSUANCE.md)                                                                            | `platform/convex/issuance*.ts`, `nfseProfiles.ts`, `packages/fiscal-nfse` |
| Conexão Stripe              | [STRIPE.md](plataforma/STRIPE.md)                                                                                | `platform/convex/stripe*.ts`                                              |
| Cobrança das assinaturas    | [BILLING.md](plataforma/BILLING.md)                                                                              | `platform/convex/billing*.ts`, `plans.ts`, `lib/billing*.ts`              |
| Municípios, NCM e CNPJ      | [REFERENCES.md](plataforma/REFERENCES.md) e [REGISTRY.md](plataforma/REGISTRY.md)                                | `platform/convex/reference*.ts`, `registry*.ts`                           |
| Consumo e cotas             | [USAGE.md](plataforma/USAGE.md)                                                                                  | `platform/convex/usage.ts`, `lib/usage*.ts`                               |
| Auditoria e monitores       | [OBSERVABILITY.md](plataforma/OBSERVABILITY.md)                                                                  | `platform/convex/observability.ts`, `lib/operational*.ts`                 |
| Exportação e retenção       | [EXPORTS.md](plataforma/EXPORTS.md), [RETENTION.md](plataforma/RETENTION.md) e [RIGHTS.md](plataforma/RIGHTS.md) | `platform/convex/export*.ts`, `lib/retentionClasses.ts`                   |
| E-mail de contas            | [ACCOUNT-EMAIL.md](plataforma/ACCOUNT-EMAIL.md)                                                                  | `platform/convex/mail.ts`, `lib/accountMail.ts`                           |
| E-mail de privacidade       | [RIGHTS.md](plataforma/RIGHTS.md) e [ativação](operacao/privacidade-email.md)                                    | `platform/convex/privacyMail*.ts`, `apps/console/privacy-mail-worker.ts`  |
| E-mail de segurança         | [SECURITY.md](../SECURITY.md) e [ativação](operacao/seguranca-email.md)                                          | `platform/convex/privacyMail*.ts`, `apps/console/privacy-mail-worker.ts`  |
| E-mail de suporte           | [Ativação](operacao/suporte-email.md), ainda não ativada                                                         | `platform/convex/privacyMail*.ts`, `apps/console/privacy-mail-worker.ts`  |
| E-mail de operação          | [Ativação](operacao/operacao-email.md), ativada em 28/10; recebe os alertas da captura                           | `platform/convex/privacyMail*.ts`, `apps/console/privacy-mail-worker.ts`  |
| API REST e SDK              | [SDK.md](v1.0/SDK.md), [API-REFERENCE.md](v1.0/API-REFERENCE.md) e [OpenAPI](v1.0/openapi.json)                  | `packages/contracts`, `packages/sdk`, `platform/convex/*Rest.ts`          |
| Console                     | [frontend.md](desenvolvimento/frontend.md) e [DESIGN.md](../DESIGN.md)                                           | `apps/console/src/` (rotas em `routes.tsx`)                               |
| Site e guias públicos       | [PUBLIC.md](plataforma/PUBLIC.md)                                                                                | `apps/console/src/site/`, `apps/docs/`                                    |

A [proposta de planos da plataforma](plataforma/PLATFORM-PLAN-PROPOSAL.md)
reúne Gratuito permanente, Intermediário, Grande e Personalizado, com
mensalidade, cotas e regras comerciais, sem implantação obrigatória. A [análise de custos](plataforma/PLATFORM-COSTS.md)
compara as assinaturas e o efeito da guarda e dos backups, retira as franquias
anteriores e define condições de capacidade para a #429. Não é oferta vigente.
A [comparação de mercado](plataforma/PLATFORM-MARKET-COMPARISON.md) confronta
a proposta com Focus NFe, Espião, NFE.io e Qive, distingue os escopos e
define metas de custo para redesenhar a entrada paga.

### 3. Entender as regras

| Regra                                    | Referência principal                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Autorização e escopos                    | Contrato do domínio, os `*Access.ts` de `platform/convex/lib/` e [lint.md](desenvolvimento/lint.md)                    |
| Valores fiscais em decimal exato (texto) | [fiscal-core](../packages/fiscal-core/README.md)                                                                       |
| Idempotência e deduplicação              | [OPERATIONS.md](plataforma/OPERATIONS.md), [IMPORTS.md](plataforma/IMPORTS.md) e [WEBHOOKS.md](plataforma/WEBHOOKS.md) |
| Ambientes e gate de produção fiscal      | [ISSUANCE.md](plataforma/ISSUANCE.md) e [deploy-producao.md](operacao/deploy-producao.md)                              |
| Guarda de dados                          | [RETENTION.md](plataforma/RETENTION.md)                                                                                |
| Termos e privacidade                     | [termos/](termos/README.md), [PRIVACY-DRAFT.md](v1.0/PRIVACY-DRAFT.md) e [TERMS-DRAFT.md](v1.0/TERMS-DRAFT.md)         |
| Visual do console e do site              | [DESIGN.md](../DESIGN.md) e [frontend.md](desenvolvimento/frontend.md)                                                 |
| Período das assinaturas e cotas pagas    | [ADR 0012](adr/0012-periodo-por-aniversario.md), ainda não implementada                                                |
| Decisões em aberto e expansões           | [ARQUITETURA.md](ARQUITETURA.md#decisões-em-aberto-e-expansões)                                                        |
| Convex                                   | `platform/convex/_generated/ai/guidelines.md`                                                                          |

O [AGENTS.md](../AGENTS.md) repete de propósito as cinco regras que não se
pode perder, em forma resumida; o detalhe fica na referência principal.

### 4. Implementar

Convenções de código em [AGENTS.md](../AGENTS.md#convenções-e-gosto). Uma
mudança de contrato REST começa em `packages/contracts`; `openapi.json`,
`API-REFERENCE.md` e as cópias públicas saem de `bun run contracts:generate`
([SDK.md](v1.0/SDK.md)). Atualize o contrato do domínio na mesma PR que muda o
comportamento.

### 5. Validar

A escolha dos checks está em [AGENTS.md](../AGENTS.md#verificando) e em
[CONTRIBUTING.md](../CONTRIBUTING.md). O que cada job confere, os runners e o
custo estão em [ci.md](desenvolvimento/ci.md). Jornadas no navegador seguem
[navegador.md](desenvolvimento/navegador.md).

### 6. Publicar e operar

| Tarefa                                   | Procedimento                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Produção (push na `main`)                | [deploy-producao.md](operacao/deploy-producao.md)                                                  |
| Ambiente de validação                    | [deploy-validacao.md](operacao/deploy-validacao.md) e [validacao.md](operacao/validacao.md)        |
| Emissão NFS-e: restrita e fiscal         | [emissao-nfse.md](operacao/emissao-nfse.md)                                                        |
| Captura fiscal no site: ligar e desligar | [captura-fiscal.md](operacao/captura-fiscal.md)                                                    |
| Backup e restauração                     | [backup.md](operacao/backup.md) e [restauracao.md](operacao/restauracao.md)                        |
| Arquivo econômico e reativação           | [arquivo-economico.md](operacao/arquivo-economico.md)                                              |
| Compactação dos documentos (ADR 0010)    | [compactacao-documentos.md](operacao/compactacao-documentos.md)                                    |
| Camada fria dos documentos (ADR 0010)    | [camada-fria.md](operacao/camada-fria.md)                                                          |
| Instalação própria                       | [instalacao-propria.md](operacao/instalacao-propria.md)                                            |
| Release, licenças e distribuição         | [release.md](operacao/release.md) e [LICENSING.md](../LICENSING.md)                                |
| Minutas sobre SDK MIT e Freecorps 1.0    | Análise preparatória e recomendações aos sócios                                                    |
| Fontes IBGE, NCM e OpenCNPJ              | [Fundamento, atribuição e limites](licenses/DATA-SOURCES.md)                                       |
| Dados pessoais na consulta CNPJ          | [Avaliação de legítimo interesse](licenses/CNPJ-LEGITIMATE-INTEREST.md)                            |
| Evidências e seu armazenamento           | [EVIDENCE.md](v1.0/EVIDENCE.md) e [EVIDENCE-STORAGE.md](v1.0/EVIDENCE-STORAGE.md)                  |
| Divulgação por entrega e piloto          | [LAUNCH.md](v1.0/LAUNCH.md), [RELEASE-NOTES.md](v1.0/RELEASE-NOTES.md) e [PILOT.md](v1.0/PILOT.md) |

## Histórico e legado

O planejamento da 1.0, a transição do serviço anterior e a documentação do
backoffice Clerk e do motor de emissão legado, retirados na #345, ficam no
repositório arquivado, privado, e não estão neste repositório.

## Manter a organização

Antes de acrescentar um Markdown permanente, identifique o público, a pergunta
respondida e o documento existente que poderia recebê-lo; crie outro arquivo
só quando houver responsabilidade própria. Mudança de comportamento atualiza a
referência atual na mesma PR; andamento vai para a issue; uma execução vai para
o recibo, apontado no índice de evidências. A matriz de aceite só muda quando
a execução altera uma capacidade, um limite, um critério, uma lacuna ou uma
condição de saída. Não crie documentos de status paralelos.
