# Exportação privada de documentos

A exportação privada reúne documentos NF-e, versões publicadas, itens, eventos e bytes
originais. É uma operação de leitura, disponível mesmo sem plano ativo ou
com a cota comercial esgotada. O backup operacional inclui outras tabelas e
envelopes cifrados e segue [o roteiro de recuperação](../operacao/restauracao.md).

## Escopo e autorização

No console, proprietários e administradores podem solicitar a organização
inteira. Qualquer membro com leitura atual de um documento (acesso à empresa e
papel de leitura) pode exportar aquele documento; a exportação pertence ao
projeto do console ([ADR 0005](../adr/0005-console-sem-projeto.md)). A API aceita exportação de um
documento com `documents:read`, empresa e ambiente concedidos à chave.
Exportações pertencem ao solicitante.

No site, `production` existe só para as empresas com a captura fiscal
liberada ou já desativada ([liberação fiscal](CAPTURE.md#liberação-fiscal-no-site)):
desativar a captura mantém a leitura e a exportação do que foi capturado. A
chave de produção exporta documentos dessas empresas; ela só é criada depois
da liberação, que revoga as chaves de `production` anteriores da empresa
([PROJECTS.md](PROJECTS.md#painel-de-integrações)). A exportação da
organização em `production` lê só essas empresas e é recusada com
`ENVIRONMENT_DENIED` quando nenhuma empresa da organização está nesse estado.
`exports.environments` devolve ao console os ambientes que o gestor pode
escolher: o do deployment e, quando alguma empresa atende a leitura em
`production`, também esse. A geração e cada download conferem de novo o
ambiente da empresa. Outra chave, mesmo no mesmo projeto,
não herda sua exportação; deve solicitar uma própria.

O servidor guarda a identidade do solicitante e as versões de acesso da
associação, projeto e concessão. A geração, publicação, consulta de partes
e cada acesso ao download revalidam esses vínculos. Uma revogação seguida de
nova concessão não ressuscita arquivos antigos. Mudar de organização desmonta
a tela e interrompe downloads em andamento no console.

Numa organização encerrada, só a exportação da organização inteira continua
disponível, por 30 dias, a proprietários e administradores. Chaves de API e
exportações por documento deixam de funcionar no encerramento. Ao fim da
janela, as exportações e seus arquivos são excluídos com as demais classes
elegíveis; ver [Retenção](RETENTION.md#encerramento-implementado-d01).

Numa organização em arquivo econômico, o Proprietário pede a exportação
assistida ao suporte ([ADR 0009, §7](../adr/0009-custodia-fria-de-organizacoes-abertas.md#7-consulta-somente-leitura-enquanto-arquivada)).
Ela tem este mesmo formato, gerado pelo mesmo código a partir do pacote
restaurado num deployment isolado, e chega como uma exportação da
organização em nome do Proprietário, com o mesmo ticket e as mesmas 24 horas.
Enquanto a organização está arquivada, a lista, as partes e o ticket servem
só a essa exportação; pedir uma nova pelo console continua recusado com
`ORGANIZATION_ARCHIVED`. A Freecorps paga as partes e o download, fora da
capacidade e da cota da organização. O procedimento, a regra de um pedido do
Proprietário a cada 30 dias e a exceção do pedido de titular estão no
[arquivo econômico](../operacao/arquivo-economico.md#exportação-assistida).

## Contrato

As rotas de exportação entraram no contrato 2.0.0 e seguem no 7.0.0,
preservando os endpoints existentes. O OpenAPI e o SDK gerados incluem:

| Método e caminho                        | Resultado                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `POST /v1/exports`                      | Solicita documento por `companyId` e `documentId`; exige `Idempotency-Key`. |
| `GET /v1/exports/{exportId}`            | Escopo, estado, partes, bytes e prazo.                                      |
| `GET /v1/exports/{exportId}/parts`      | Manifesto paginado de partes, com sequência, tamanho e SHA-256.             |
| `POST /v1/exports/{exportId}/revoke`    | Interrompe a geração e invalida o download.                                 |
| `POST /v1/export-parts/{partId}/ticket` | Ticket privado, válido por até 60 segundos.                                 |
| `GET /v1/export-download`               | Bytes da parte, usando `X-Download-Token`.                                  |

Os endpoints JSON exigem API key e `X-Environment`. O download usa somente
o ticket no cabeçalho, sem token na URL. O ticket mantém o vínculo com a
chave ou membro original, revalidado antes e depois de carregar o arquivo.
Respostas usam `Cache-Control: no-store`. Não se entrega URL de storage.

Repetir a chave de idempotência com a mesma seleção retorna a exportação
original, inclusive quando terminal. Seleção diferente retorna conflito.
Para outra tentativa após falha ou expiração, use uma nova chave. A retenção
do registro de idempotência é de 30 dias.

No detalhe do documento, “Exportar documento e histórico” pede confirmação em
linha (o que o pacote contém, o formato e o prazo de 24 horas) e, depois do
pedido, mostra o estado vivo da exportação (na fila, processando, pronta para
baixar ou falha) com o link para Exportações.
“Solicitar nova exportação” gera uma nova chave
depois que o servidor confirma o pedido anterior. Falhas de transporte
preservam a chave para a retentativa. Os schemas HTTP representam apenas
exportações de documento; organização inteira usa a mutation administrativa
do console. A chave de idempotência segue o contrato geral de 1–128 caracteres
ASCII imprimíveis sem espaço; operações de webhook mantêm sua regra própria.

## Console

Exportar a organização e revogar uma exportação pedem confirmação em linha,
que recebe o foco e fecha com Esc. Depois do pedido, a tela acompanha o
estado pela assinatura da lista: "Na fila" enquanto nenhuma parte foi
publicada, "Processando" com as partes prontas, "Pronta para baixar" com o
acesso aos arquivos, ou a falha com o estilo de erro. Uma falha de rede
preserva a chave de idempotência, e a nova tentativa devolve o pedido já
aceito.

A lista do console (`exports.list`) acrescenta `description` ao resumo: para
documento, empresa, modelo e chave fiscal, lidos depois de `exportAllowed`;
para a organização, `null`, e a tela mostra o nome dela e a data de corte. O
id da exportação e do documento fica em "Referência para suporte". O REST não
muda. A tela explica o formato `.jsonl.gz`. Quem não pode exportar a
organização vê quem pode e como exportar uma nota pelo detalhe em Documentos.
Quando a organização tem Produção (alguma empresa com a captura fiscal
liberada ou já desativada), o diálogo de exportar a organização traz o campo
"Ambiente" com Produção já selecionada e a ajuda "Produção: documentos reais
das empresas com captura fiscal (inclusive as já desativadas)"; o Sandbox
continua escolhível. Cada exportação da lista diz o ambiente dela.

## Formato e consistência

Cada parte é JSON Lines comprimido com gzip. Os registros discriminados por
`type` são `manifest`, `document`, `version`, `item`, `artifact`,
`unclassified-artifact`, `original` e `part-end`. Referências documentais
usam os mesmos IDs públicos dos contratos de consulta. `original.content`
contém os bytes em base64 e `original.sha256` permite verificá-los. O hash da
parte cobre os bytes comprimidos. O console o confere antes de salvar.

As versões usam a projeção pública da consulta de documentos, com decimais exatos. Eventos são
versões com `payload.kind` específico. Informação fora da projeção pública
permanece nos originais. O pacote nunca contém IDs de storage, PFX, senhas,
chaves, envelopes, hashes de API keys ou tokens de sessão.

A seleção usa o instante da solicitação como limite superior de publicação
das versões e importação dos artefatos. Metadados documentais e situação
fiscal são observados durante a geração, com `observedAt`; o manifesto declara
essa consistência. Não é um snapshot transacional de todas as tabelas. Durante
ingestão ou reprocessamento concorrente, solicite outra exportação depois da
conclusão para obter o resultado final. A exportação da organização inclui
também originais ainda sem classificação, sem fabricar uma identidade fiscal.

As partes são sequenciais; o manifesto paginado lista o conjunto completo e
o último `part-end` tem `final: true`. Baixe todas as partes. Uma parte isolada
não representa a organização inteira. Nenhuma parte pode ser baixada antes
de toda a operação terminar com sucesso.

## Estados, limites e retenção

`running` termina em `succeeded`, `failed`, `revoked` ou `expired`. O Workpool
executa dois lotes simultâneos e retenta cada lote até três vezes. Um cursor
persistido e uma sequência de commit impedem partes duplicadas. Falta de
original ou divergência de hash falha a operação inteira, sem pacote parcial
anunciado como completo. O usuário pode revogar a exportação em andamento.

Há no máximo duas exportações em andamento por organização, duas admissões
por minuto e 60 tickets por minuto por solicitante. São limites técnicos,
independentes do plano. Cada action processa até 40 etapas do cursor e encerra o lote
ao atingir 4 MiB de conteúdo antes de compressão; a última etapa e seu original podem
aumentar esse tamanho. Cada original tem teto de 10 MiB. Uma exportação tem
teto de 10 mil partes ou 2 GiB comprimidos; exceder falha explicitamente.

Novos jobs usam o checkpoint `keyset-v1`. Uma query agrupa até oito etapas
sequenciais, incluindo fases vazias, e revalida o acesso antes de começar.
O paginador por chave de `convex-helpers` permite percorrer os índices de
mais de uma fase na mesma query; os cursores nunca são executados em paralelo.
Jobs anteriores, sem esse marcador, continuam pelo paginador nativo de uma
etapa por query até terminar, preservando os cursores já persistidos.

O lote para depois da etapa que atingir 512 KiB de registros serializados,
4 MiB lidos do banco ou 64 registros lidos, conforme as métricas da transação.
Esses são limiares de parada, com possível acréscimo da última etapa indivisível.
As páginas mantêm os limites anteriores de uma linha, ou 25 itens, e limites
de bytes por página entre 200.000 e 800.000. As leituras pontuais também entram
no orçamento de banco. O worker informa o saldo das 40 etapas e dos 4 MiB;
uma consulta não multiplica esses limites pelo tamanho do lote.

Cada query devolve no máximo um original, sempre depois dos registros que o
precedem. O worker verifica tamanho e SHA-256 antes de avançar o checkpoint.
Somente o commit publica a parte e persiste o próximo checkpoint, com nova
verificação de autorização, prazo e sequência. Uma resposta perdida de leitura,
storage ou commit não autoriza pular dados nem publicar duas partes da mesma
sequência. Revogação entre queries é observada na próxima leitura; revogação
durante a geração impede o commit e o download.

Arquivos vencem 24 horas após a solicitação. A autorização verifica o prazo
mesmo antes da limpeza. Tarefas agendadas removem partes em lotes de 20 e
metadados após 30 dias. Revogação e falha antecipam a remoção das partes.
Tickets duram no máximo 60 segundos e têm limpeza própria. A auditoria segue
a retenção operacional existente, com referências e resultado, sem conteúdo.
O scanner de storage reconhece o MIME privado da exportação e apaga blobs
órfãos de actions interrompidas; não apaga partes vinculadas.

## Validação

`tests/platform.exports.test.ts` cobre bytes/hashes, idempotência, chaves e
concessões revogadas, isolamento, membro removido, permissão de gestor,
expiração, revogação explícita e perda de acesso antes da publicação.
Também cobre os limites do lote, versões e originais posteriores ao pedido,
eventos, respostas perdidas e originais ausentes ou corrompidos.
`tests/platform.exports.benchmark.test.ts` compara o worker completo com
paginação nativa e em lotes sobre a mesma massa e exige igualdade de todos
os hashes das partes. O relógio é congelado somente no teste em memória.
`node scripts/proofs/prove-export-batches.mjs`, com o worktree `platform` em execução,
repete a medição no Convex nativo local com dados sintéticos. O ensaio grava
chamadas, bytes, leituras, partes, hashes e duração em `.ci-results/125/native.json`.
Resultados e limitações estão em evidence/125/README.md.
`scripts/backup/prove-restore.mjs` exercita importação, exportação e download HTTP no
Convex nativo local antes de produzir o snapshot do ensaio.
