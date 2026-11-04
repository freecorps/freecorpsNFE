# Arquitetura da plataforma

Este documento descreve como a plataforma funciona hoje. Os contratos por
módulo estão no [índice da documentação](README.md). O desenho original
do serviço de emissão legado, aposentado na #345, está em
arquitetura-legado.md.

## Produto atual e legado

A aplicação atual usa `apps/console` e `platform/convex`. A
transição substituiu o serviço de emissão no mesmo
endereço, com banco vazio e novas contas Better Auth. O código legado saiu do
repositório na #345 e fica no histórico do Git. A emissão NFS-e da plataforma existe em sandbox,
pela API REST (`/v1/issuances`), SDK e webhooks, com transporte simulado e sem
validade fiscal; produção fica atrás de um gate por empresa, desligado (veja
[ISSUANCE.md](plataforma/ISSUANCE.md)). Propostas e capacidades futuras ficam no
plano da 1.0 e na seção [Decisões em aberto e expansões](#decisões-em-aberto-e-expansões); o que existe e seus limites, na [matriz de aceite](v1.0/ACCEPTANCE.md#capacidades-e-limites).

## Entradas e borda

O console React usa TanStack Router; o site e os guias públicos são gerados
como HTML estático no build. O Worker serve esses arquivos e encaminha
autenticação ao backend. Better Auth mantém as sessões humanas. Integrações
REST usam API keys de projetos, com escopos e concessões de empresa e ambiente.
O Convex valida permissões em cada entrada e mantém dados, arquivos e tarefas.

Em produção, o Worker `freecorpsnfe-backoffice` é gerado por
`scripts/deploy/deploy-platform.mjs` a partir de `deploy/selfhost/worker.ts`. Ele
serve o console em `https://nfe.freecorps.com.br` e encaminha `/api/auth/*`
pelo proxy assinado. Em `https://api.nfe.freecorps.com.br`, aceita somente
`/v1/*` e `/health` e repassa a chamada ao backend com o IP do cliente
assinado. `apps/console/wrangler.json` descreve o Worker de validação.
Ambientes e gates de publicação estão em
[deploy-producao.md](operacao/deploy-producao.md).

## Domínio e trabalho assíncrono

Organização, projeto e empresa são entidades distintas. Operações de
importação preservam idempotência e arquivos originais; os documentos
normalizados têm processamento, disponibilidade e situação fiscal próprios.
NF-e 55 importada e NFS-e emitida seguem contratos específicos; as NFS-e
ABRASF importadas antes de 02/11/2026 ficam só para leitura. Actions Node
executam os conectores; Workpool controla o trabalho concorrente e retentativas.

A plataforma mantém [eventos de consumo e reservas](plataforma/USAGE.md) no Convex,
agregados por organização/ambiente/mês/unidade. Admissão e atualização de cotas são
transacionais; planos assistidos têm vigência e auditoria internas. A
[observabilidade](plataforma/OBSERVABILITY.md) acrescenta uma projeção de auditoria
sanitizada, monitores por organização/projeto/empresa/ambiente e investigação
no console; auditorias originais e dados fiscais permanecem nos respectivos
domínios.

Query do Convex não lê o relógio (#45): o resultado fica em cache e não é
reexecutado quando o tempo passa. Mutations e actions comparam prazos com o
próprio relógio. Uma query interna recebe o `now` da action ou do script que a
chama. Um helper compartilhado usa `clockOf(ctx)` (`lib/clock.ts`), que devolve
`null` em query; com `null`, ele confia no estado que o job agendado do prazo
grava (certificado, exportação, encerramento) ou na admissão REST, que já
comparou a validade da chave. Enquanto o job não roda, a query mostra o estado
anterior: o expurgo de um encerramento que espera um run do arquivo frio deixa a
janela de exportação aberta nas leituras, mas ticket e download, que são
mutations, já recusam. As queries do console devolvem o prazo, e a tela
o compara com o relógio do navegador. Planos e cobrança recebem `asOf`,
arredondado ao minuto. O relógio do cliente só decide o que a tela mostra e
habilita; a mutation decide de novo.

Municípios e NCM usam versões imutáveis, importação candidata e publicação
atômica. Persistência fica em `platform/convex`, contrato e vigência em
`packages/contracts` e pesquisa em `apps/console`. A fronteira, as fontes e o
rollback estão em [REFERENCES.md](plataforma/REFERENCES.md).

## Pacotes fiscais e contratos

Os pacotes `fiscal-core` e `fiscal-nfe` concentram conceitos e processamento
fiscal sem depender do backend ou da autenticação. `fiscal-core` define o
decimal exato em texto usado em todo valor fiscal da plataforma
([README](../packages/fiscal-core/README.md)). `fiscal-nfse` é o núcleo novo de
emissão NFS-e (DPS, assinatura, eventos, PTAX, roteamento e adaptador ADN com
transporte injetado). A plataforma o usa no workload `issuance`
(`documents.issue` e `documents.cancel`): a mutation de pedido congela o
snapshot fiscal e reserva o número da DPS; a action Node monta, assina quando o
transporte é real, persiste e transmite, e o reconciliador consulta a DPS antes
de qualquer reenvio. As mutations importam só o subcaminho
`@freecorps/fiscal-nfse/pure`, sem dependências de Node.

`packages/contracts` define as estruturas REST usadas na geração de OpenAPI e
no SDK. Os [contratos e limites do SDK](v1.0/SDK.md) descrevem o versionamento
externo.

## Decisões em aberto e expansões

Estas regras valem até uma decisão explícita mudá-las. Uma expansão começa
pela comparação entre comportamento existente, contrato e prova, e registra
objetivo, restrição e condição de conclusão.

| Decisão                      | Regra atual e condição de mudança                                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nomes e extrações de pacotes | `fiscal-core`, `fiscal-nfe` e `sdk` têm escopos definidos. Extrair documentos brasileiros, referências, fixtures ou webhooks somente por consumo/responsabilidade demonstrados; não criar pacotes vazios. |
| Novos conectores             | A captura inicial está em `fiscal-nfe`; outros serviços exigem contrato e runtime próprios, sem atribuir persistência ao pacote.                                                                          |
| Contratos externos           | Usar a origem editável descrita em [SDK.md](v1.0/SDK.md), sem duplicar validators de domínio nem confundir OpenAPI com autorização.                                                                       |
| Chave mestra ou KMS          | Envelope com secret versionado conforme [ADR](adr/0003-cofre-de-certificados-da-plataforma.md). KMS foi adiado; adoção futura exige necessidade e recuperação comprovadas.                                |
| Marca e distribuição         | Nome comercial Freecorps Fiscal, decidido em 18/10/2026. Plataforma/motor usam Freecorps 1.0 e cliente MIT; condições de distribuição estão em [LICENSING.md](../LICENSING.md).                           |

| Expansão                                           | Condição de entrada                                                                                                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFC-e, CT-e, MDF-e, NFS-e recebidas e novas fontes | A plataforma importa NF-e 55; a importação ABRASF saiu em 02/11/2026. Definir contrato e prova por modelo/fonte/ambiente; código legado não equivale a suporte novo.              |
| Emissão com validade fiscal e cálculo tributário   | A emissão NFS-e existe só em sandbox ([ISSUANCE.md](plataforma/ISSUANCE.md)). Produção exige gate por empresa, homologação e provas fiscais; cálculo tributário fica fora da 1.0. |
| PDF fiscal e novos documentos                      | Definir fonte, modelo e fidelidade; download exige geração comprovada.                                                                                                            |
| Provedores e tabelas adicionais                    | Revisar licença, atualização, custo e indisponibilidade antes da integração.                                                                                                      |
| PostgreSQL ou separação de API/worker              | Exigir necessidade medida; Convex e Bun Workspaces permanecem na arquitetura atual.                                                                                               |
| Testkit, playground ou UI compartilhada            | Adoção concreta deve justificar manutenção.                                                                                                                                       |
| Checkout automático, SSO e administração avançada  | Após organizações, concessões e contratação assistida.                                                                                                                            |
