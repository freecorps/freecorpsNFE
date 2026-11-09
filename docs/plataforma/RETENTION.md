# Revisão da retenção para o serviço público

Revisão técnica de 05/10/2026, com proposta operacional de 06/10, vinculada
a #79/#80 e aos aceites por entrega da
[ADR 0011](../adr/0011-entregas-graduais.md). Em 06/10, o mantenedor aprovou os prazos
operacionais para implementação e assumiu operação e fiscal/privacidade.
Estado: **política pública ainda não aprovada**. Este documento reúne o
comportamento implementado e as decisões necessárias para aprová-la. Não
altera os TTLs em execução, agenda expurgos ou executa exclusão de documentos.

A plataforma atual usa `platform/convex`. O ensaio de expurgo demonstra o funcionamento de classes específicas;
não concede aceite fiscal, contratual ou de privacidade.

**Situação em 29/10/2026.** O dono do projeto decidiu guardar as notas de
organizações ativas em duas camadas: quente no banco por 3 meses no Gratuito
e 12 meses nos planos pagos, e fria depois, até completar no mínimo cinco
anos, pela contagem da D01, com o conteúdo derivado do XML em blobs
imutáveis conferidos por hash
([ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md)). Até a
implementação, vale o texto abaixo: organizações abertas conservam todos os
registros quentes.

## Inventário conferido no código

Para consulta CNPJ, esta entrega acrescenta `registryRestrictions`, controle
global separado do cache. Conserva somente CNPJ, estado, referência do pedido,
executor, versão e data para cumprir a restrição e sua eventual reversão.
Não expira junto com o cache nem com uma organização. Necessidade de manutenção
é revista em D02; decisões de supressão são reaplicadas antes de reabrir acesso
após restore. Histórico confirmado tem expurgo por empresa mediante decisão
do cliente controlador. Procedimento e limites em
[Direitos sobre CNPJ](../operacao/cnpj-direitos.md).

A caixa de privacidade foi ativada e ensaiada pelo responsável em 21/10,
conforme [roteiro operacional](../operacao/privacidade-email.md#ensaio-pelo-console-em-21102026-1647-utc).
Essa prova atualiza as pendências de ativação descritas nas seções históricas
abaixo. O primeiro acesso do substituto ainda não foi comprovado. O aviso
específico CNPJ acompanha esta entrega; a revisão geral de D06 permanece
separada do aviso dessa funcionalidade.

| Classe e finalidade                                                                       | Prazo e destino implementados                                                                                                                                                                                                                                                                                                       | Fonte                                                                                                        |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Auditoria HTTP, diagnóstico de requisições                                                | 30 dias desde a gravação, com remoção por organização. Apenas campos permitidos; sem corpo, headers ou XML.                                                                                                                                                                                                                         | `platform/convex/lib/operationalAudit.ts`                                                                    |
| Projeção operacional, investigação e suporte                                              | 365 dias desde a gravação. A remoção da projeção não apaga a auditoria original do domínio.                                                                                                                                                                                                                                         | `platform/convex/lib/operationalAudit.ts`                                                                    |
| Notificações no painel                                                                    | 30 dias desde a criação. O prazo não define o ciclo de vida do alerta atual.                                                                                                                                                                                                                                                        | `platform/convex/observability.ts`                                                                           |
| Amostras de falha por fonte                                                               | 7 dias; o monitor consulta uma janela de uma hora.                                                                                                                                                                                                                                                                                  | `platform/convex/lib/operationCore.ts`                                                                       |
| Recibos REST de consultas de empresas                                                     | Até 00:00 UTC do dia da chamada mais 31 dias. Compactação e remoção na mesma transação, preservando contagem e primeira/última data por organização, projeto, ambiente e rota.                                                                                                                                                      | `platform/convex/lib/apiUsageRetention.ts`, [consumo](USAGE.md#retenção)                                     |
| Totais REST, eventos comerciais de uso, reservas e planos                                 | Sem TTL enquanto a organização existe. Preservam reconciliação, totais e identidade comercial; não apagar chaves idempotentes para liberar cota. Após o encerramento, mesma guarda dos documentos.                                                                                                                                  | [Consumo](USAGE.md#retenção), [guarda](#guarda-implementada-d01)                                             |
| Cache cadastral CNPJ                                                                      | Validade de 24 horas para encontrado e uma hora para ausente; retenção de até 30 dias desde o resultado bem-sucedido. Erro não renova a retenção anterior. Durante uma chamada, o expurgo pode conservar só a reserva até terminar a lease.                                                                                         | `platform/convex/lib/registryValues.ts`, `platform/convex/registryStore.ts`                                  |
| Cadastro confirmado e seu histórico                                                       | Conservados com a empresa; não são apagados pelo expurgo do cache.                                                                                                                                                                                                                                                                  | [Consulta cadastral](REGISTRY.md#confirmação)                                                                |
| XML NF-e/NFS-e, lotes, versões, identidade fiscal, tentativas e auditorias originais      | Sem exclusão enquanto a organização existe. Após o encerramento, [guarda até 31/12 do quinto ano seguinte ao encerramento](#guarda-implementada-d01), salvo retenção legal; depois, expurgo.                                                                                                                                        | [Documentos](DOCUMENTS.md), [observabilidade](OBSERVABILITY.md#retenção-e-revisão-antes-da-operação-pública) |
| Certificados e senhas                                                                     | Ciclo de vida próprio do cofre. Revogação não remove cópias em backups; versões mestras continuam necessárias enquanto houver envelopes ou backups dependentes.                                                                                                                                                                     | [Certificados](CERTIFICATES.md#chaves-auditoria-e-recuperação)                                               |
| Organização, cadastro, membros, convites, credenciais, certificados, chaves e integrações | Excluídos pelo [encerramento da organização](#encerramento-implementado-d01): 30 dias de exportação e expurgo em lotes, com prazo de 7 dias. Contas de usuário e sessões são globais e não saem com a organização; saem quando o titular [exclui a conta](RIGHTS.md#exclusão-de-conta).                                             | `platform/convex/organizationClosure.ts`, [Organizações](ORGANIZATIONS.md#encerramento)                      |
| Dados do atendimento a direitos                                                           | Registro restrito fora do produto, conforme D02. Cinco anos a partir do encerramento do pedido.                                                                                                                                                                                                                                     | [Atendimento a direitos](RIGHTS.md)                                                                          |
| Logs de runtime, logs do Worker e destinos de exportação                                  | Retenção efetiva depende de configuração e provedor; não é o TTL de `operationalAudit`. Configuração da instalação pública não conferida nesta revisão.                                                                                                                                                                             | [Observabilidade](OBSERVABILITY.md), documentação dos provedores                                             |
| Backups e exportações administrativas                                                     | Cópia externa cifrada a cada 12 horas, retida por 14 dias em R2, [configurada em 08/10](../operacao/backup.md); custódia do substituto e do mantenedor desde 19/10 (#248); ensaio de perda do host pendente. Expurgo do banco vivo não apaga snapshots anteriores. Desde 22/10, as cópias têm NF-e reais da captura fiscal no site. | [Backup externo](../operacao/backup.md), [Restauração](../operacao/restauracao.md)                           |

O expurgo da telemetria usa até 50 registros por classe por transação e
continua pelo scheduler. Prazo vencido torna o registro elegível; uma falha ou
atraso do scheduler pode adiar sua remoção. A política pública precisa distinguir
esse prazo de uma garantia de apagamento instantâneo de todas as cópias.

## Metadados de limitação de requisições

Complemento conferido em
[`6e92497`](https://github.com/freecorps/freecorpsNFE-arquivo/commit/6e924978e71e0b4a4942c815d6612038b792d4af),
publicado em validação após a revisão inicial. O patch de
`@convex-dev/rate-limiter` adiciona `partitions` dentro do componente
`rateLimiter`. Cada registro identifica o orçamento por `name` e `key`
opcional, com quantidade de partições, taxa, capacidade e período. Os
orçamentos REST e de admissão de uso dessa revisão distribuem o saldo em oito
registros `rateLimits`, com valor, instante e índice da partição.

Esses registros controlam concorrência e cotas técnicas. Não contêm corpo de
requisição, XML, dado fiscal ou segredo da API key. A chave do orçamento pode
vinculá-lo a um ator ou organização; ausência de corpo e segredo não torna
esses identificadores anônimos. Aplicam-se as decisões de acesso,
encerramento e conservação dos metadados técnicos da instalação.

Não há TTL novo nem expurgo agendado para essa classe. `resetRateLimit`
remove as linhas do orçamento e seu registro `partitions`. Isso é uma
operação de reinicialização do limite, não uma política automática de
retenção. Apagar só o layout ou uma parte do saldo pode invalidar o orçamento;
resetar um orçamento ativo pode devolver capacidade antes do prazo. Sua
remoção deve preservar a aplicação das cotas e não substitui o tratamento
dos eventos comerciais idempotentes em `usageEvents`.

A revisão
[`cc02903`](https://github.com/freecorps/freecorpsNFE-arquivo/commit/cc02903a28a9e29a1a9895624286a75341e4a481),
conferida no patch e nos SHAs públicos do backend e console de validação,
inclui `kind` e `start` opcionais no layout para distinguir token bucket e
janela fixa. São metadados da regra e de sua janela, sob a mesma classe de
retenção técnica; não representam TTL. A presença desses campos não altera
os prazos de telemetria nem concede aceite público de retenção. A prova de
migração e os resultados de carga pertencem aos recibos dessa revisão,
separados dos ensaios operacionais e de retenção executados em `4192e63`.

## Parecer técnico e condições de aprovação

Manter os prazos de telemetria e a compactação descritos acima é a proposta
para revisão. Não ampliar o TTL documental nem introduzir exclusão fiscal
para fazer a carga passar. Reduzir uso comercial ou auditoria original exige
projeto próprio que preserve deduplicação, exportação autorizada e histórico.

| Decisão pendente                                                      | Responsável funcional           | Evidência necessária para aprovar                                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finalidade, papel da Freecorps e fundamento de conservação por classe | Mantenedor e fiscal/privacidade | Política e contrato aplicáveis, com revisor identificado, data e versão. Separar NF-e e NFS-e quando suas obrigações diferirem.                                                  |
| Guarda após encerramento e pedidos dos titulares                      | Mantenedor e fiscal/privacidade | Canal de atendimento, verificação de identidade/escopo, prazos aplicáveis, exceções justificadas e procedimento de execução. Não prometer exclusão automática ainda inexistente. |
| Logs e subprocessadores da instalação pública                         | Operação e privacidade          | Provedor, região, retenção configurada, exportações, controle de acesso e descarte de cada destino. Não inferir a configuração de produção a partir do Dev.                      |
| Backups, cópia fora do host e chaves mestras                          | Operação e mantenedor           | Agenda efetiva, prazo de cada cópia, responsáveis pela custódia, recuperação testada e tratamento de dados já expirados ou cuja exclusão foi deferida.                           |
| Expurgo após restauração                                              | Backend e operação              | Ensaio que reestabeleça os agendamentos necessários e remova dados vencidos antes de reabrir acesso. Preservar documentos e idempotência.                                        |
| Texto oferecido aos clientes                                          | Produto e mantenedor            | Texto coerente com a implementação e com as decisões anteriores, com data de vigência e aprovação registrada.                                                                    |

A [LGPD, arts. 15, 16 e 18](https://planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
trata do término do tratamento, hipóteses de conservação e direitos dos
titulares. Os TTLs de engenharia não demonstram por si só o atendimento a
esses requisitos nem estabelecem um prazo universal de guarda fiscal.

A documentação do Convex consultada em 05/10 informa retenção de sete dias
para backups manuais/diários e de 14 dias para semanais. Isso descreve o
produto, sem comprovar a agenda desta instalação. O snapshot não inclui
funções agendadas, código ou variáveis de ambiente; restaurar as tabelas de
controle não comprova que seus jobs voltaram a existir.
[Fonte do provedor](https://docs.convex.dev/database/backup-restore).

O painel de logs do Convex oferece histórico recente e permite configurar
exportação para outro destino. A página consultada não define um prazo
contratual numérico para esta instalação. Registrar a configuração real antes
de oferecer um prazo público. [Fonte do provedor](https://docs.convex.dev/dashboard/deployments/logs).

## Procedimento para atendimento e encerramento

1. Registrar referência do pedido, organização, classes solicitadas e operador
   autorizado em local restrito. Não anexar XML, PFX ou senha à investigação.
2. Conferir identidade, papel, empresas e apps abrangidos. Exportar somente
   o que o solicitante pode acessar, pelo fluxo existente.
3. Submeter as classes conservadas à decisão fiscal/privacidade, incluindo
   motivo e prazo de cada exceção. Bloqueio de plano ou revogação de chave
   não equivale a exclusão de dados.
4. Preparar a execução aprovada com inventário de dependências, backups e
   destinatários. O [encerramento da organização](#encerramento-implementado-d01)
   executa a exclusão das classes elegíveis; outras exclusões exigem
   implementação e prova próprias.
5. Registrar o resultado por classe, cópias ainda retidas e respectivos prazos.
   Uma restauração deve reaplicar as decisões de exclusão antes de liberar
   acesso, sem perder a identidade fiscal ou permitir nova cobrança da mesma
   intenção.

## Registro do aceite

O aceite deve identificar versão/hash desta política, instalação abrangida,
revisores nominalmente responsáveis, data, decisões da tabela, evidências e
exceções com prazo. Até que essas informações existam, #80 e o aceite
operacional nas issues das entregas continuam pendentes. Aprovar uma proposta de prazo não
significa que sua aplicação, backup ou atendimento já foram comprovados.

## Proposta operacional de 06/10/2026

Aprovada para implementação em 06/10/2026 pelo mantenedor,
com a manifestação "aprovado, eu assumo", registrada na
[#80](https://github.com/freecorps/freecorpsNFE-arquivo/issues/80).
Ele assume operação,
atendimento a direitos e fiscal/privacidade do piloto. Em 07/10 o mantenedor
designou um substituto, o outro sócio; ver as
[decisões de 07/10/2026](#decisões-de-07102026). A aprovação dos prazos não equivale à aplicação comprovada
nem à liberação da política pública.
O aceite técnico de carga, monitores e expurgo está consolidado no
registro de #79/#80. Os prazos abaixo
são decisões aprovadas para a operação; não são prazos legais de guarda
fiscal nem garantias já oferecidas aos clientes.

O mantenedor definiu em 06/10 que o piloto usará `https://nfe.freecorps.com.br`.
O [plano de publicação](../../deploy/platform-release.json) identifica
`prod:elated-possum-295` e o Worker `freecorpsnfe-backoffice`, com perfil de
produto `sandbox`. Essa identificação vem do plano versionado; logs e backups
efetivos ainda não foram consultados no ambiente. A medição em
`dev:modest-seal-118`, com dados sintéticos, conserva seu alvo de validação.
Responsável por operação e fiscal/privacidade: o mantenedor.
Substituto designado em 07/10: o outro sócio. Falta conferir
a configuração efetiva.

O perfil `sandbox` não quer dizer banco sem dado fiscal real. Desde
22/10/2026 o site captura NF-e reais das empresas que liberaram a captura
fiscal ([ADR 0007](../adr/0007-captura-fiscal-no-site.md),
evidência da #430). O banco, e
portanto cada cópia do [backup externo](../operacao/backup.md), guarda XML e
resumos de NF-e de produção, os documentos normalizados, a liberação e o
checkpoint da captura e o A1 dessas empresas, cifrado no cofre. Cada tabela
segue a classe dela na [guarda implementada](#guarda-implementada-d01). Um
deployment restaurado sobe sem as variáveis da captura
([restauração](../operacao/backup.md#recuperação-após-perda-do-host)).

| Decisão                     | Aprovado para implementação                                                                                                                                                                                                                                      | Motivo e condição para vigorar                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D01, encerramento           | Bloquear novas operações e revogar integrações no encerramento; oferecer 30 dias para exportação assistida por pessoa autorizada. Depois, executar a exclusão das classes elegíveis em até 7 dias corridos.                                                      | A janela permite retirar os dados antes da exclusão. Exige finalidade e fundamento para a conservação transitória, procedimento implementado e exceções documentadas por classe. Não se aplica como prazo de guarda de XML, identidade fiscal, auditoria original ou registros comerciais necessários.             |
| D02, atendimento a direitos | Atendimento manual por canal dedicado e registro restrito. Conferir identidade e escopo; meta interna de triagem em até 2 dias úteis, sem adiar atendimento imediato nem prazos legais aplicáveis.                                                               | Registrar pedido, responsável, decisão por classe, motivo de eventual conservação, prazo e comprovante da execução. O responsável é o mantenedor; canal atualizado para `privacidade@nfe.freecorps.com.br` em 21/10, falta ativar e exercitar a caixa no console. Não anexar PFX, senha ou XML em issues públicas. |
| D03, logs dos provedores    | Usar retenção nativa documentada no piloto, sem criar novo destino de exportação contínua. Cópias pontuais de diagnóstico ficam em acesso restrito por até 30 dias, salvo incidente com exceção e data de revisão registradas.                                   | Inventariar destinos já existentes e comprovar plano, configuração, região, acesso e descarte. A aprovação não demonstra que não existam streams hoje. Um TTL da aplicação não apaga logs ou cópias nos provedores.                                                                                                |
| D04, backups                | Manter cópia de banco e storage fora do host de origem a cada 12 horas, cifrada e retida por 14 dias; backups nativos diários, quando contratados, seguem a retenção do provedor. Custodiar configuração e todas as versões de chaves necessárias separadamente. | Metas internas aprovadas: RPO de 24 horas e RTO de 24 horas. Medir idade do último backup íntegro, alertar falhas e agir antes de violar RPO. Validar custo e acesso, registrar o aceite do substituto e provar recuperação sem a origem. Não é SLA contratado nem agenda já configurada.                          |
| D05, restauração            | Manter acesso e transportes suspensos até reconciliar expirações e reaplicar exclusões deferidas. Manter o registro mínimo dessas decisões fora do snapshot restaurado.                                                                                          | Provar recriação dos agendamentos ausentes, expurgo completo das classes elegíveis e preservação de dados atuais, documentos conservados e idempotência. Só reabrir com recibo e liberação do operador responsável. [Ensaio local de 07/10 aprovado](#prova-de-d05); com backup real em 19/10.                     |
| D06, divulgação             | Publicar política e termos na #428 para o serviço disponível, com provas, revisão fiscal por classe e limites da instalação identificada. Desde 31/10, D01 segue na #80 sem bloquear globalmente a publicação, conforme a ADR 0011.                              | Registrar versão/hash, revisores, vigência e exceções. Aceite técnico do perfil privado não aprova política pública.                                                                                                                                                                                               |

Para D01, a decisão fiscal/privacidade ainda precisa relacionar finalidade,
papel da Freecorps, fundamento, prazo e destino de cada classe conservada:
NF-e, NFS-e, auditorias originais, cadastros, contas, atendimento e registros
comerciais/idempotentes. O prazo aprovado de 30 dias é uma janela de exportação,
não um prazo universal de guarda nem autorização para conservar tudo
indefinidamente. O encerramento, o expurgo das classes excluídas e o
[expurgo das classes conservadas ao fim da guarda](#guarda-implementada-d01)
estão implementados.

Na D02, confirmação da existência e acesso têm regras próprias no art. 19
da LGPD, incluindo resposta simplificada imediata ou declaração completa
em até 15 dias. A triagem interna de dois dias não substitui esses deveres
nem estende esse prazo a todos os direitos. Conservação e exceções precisam
ser avaliadas por classe conforme os arts. 15, 16 e 18.
[Texto oficial consultado em 06/10/2026](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm).

Para D03, a documentação de Workers Logs consultada em 06/10 informa três
dias no plano Free e sete no Paid. A conferência de 18 e 19/10
achou Workers Logs desligado no Worker, sem Logpush nem Tail Worker ligados a
ele, nenhum log stream no Convex e artefatos do Actions em até 30 dias; a
retenção dos logs do Actions caiu de 90 para 30 dias. Logpush, OpenTelemetry,
logs HTTP da zona e Email Sending ficam na retenção nativa de 30 dias. O painel Convex
guarda só um histórico curto, sem integração configurada. Os workflows agora
usam VMs efêmeras Blacksmith; falta confirmar a execução e conferir o descarte
dos dados remanescentes no antigo VPS. O Worker de privacidade tem Workers Logs
habilitado e exige conferência própria após ativação. O painel Convex oferece histórico recente;
exportações para outro destino têm retenção própria a inventariar.
[Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[logs do Convex](https://docs.convex.dev/dashboard/deployments/logs).
Os destinos a conferir, o que a aplicação escreve e o roteiro do inventário
estão em [Logs dos provedores](OBSERVABILITY.md#logs-dos-provedores-d03).

Para D04/D05, o backup Convex pode incluir storage, mas não inclui código,
variáveis de ambiente ou funções agendadas. A documentação consultada em
06/10 informa sete dias para backups manuais/diários e 14 para semanais.
Restaurar não remove arquivos já existentes no destino. Por isso, a prova
de expurgo após restore deve usar destino vazio e conferir também os
arquivos, além das tabelas e das tarefas recriadas.
[Backup e restore do Convex](https://docs.convex.dev/database/backup-restore).

Para D06, a [política de privacidade](../v1.0/PRIVACY-DRAFT.md) foi publicada
em 01/11/2026 (#428), em `/privacidade`, com versão e SHA-256; o documento
guarda as fontes de cada seção e o histórico das condições.

### Prova de D05

Roteiro do ensaio. A execução de 07/10/2026, no SHA `d54d104`, está
registrada na evidência de D05 e
cumpriu os seis passos em ambiente local, com massa sintética. Em 19/10/2026,
o roteiro rodou sobre o backup real de
`elated-possum-295`, no SHA `d454198`.

1. Em ambiente descartável, preparar dados sintéticos atuais e expirados das
   classes já suportadas pelo expurgo, recibos REST e suas agregações, um
   documento fiscal a conservar e um registro cuja exclusão seja deferida
   depois do snapshot. Guardar a decisão de exclusão fora dele.
2. Restaurar banco e storage em destino vazio, com transportes desligados e
   sem acesso de usuários. Conferir código, schema, configuração e chaves.
3. Recriar os agendamentos necessários por mecanismo idempotente; não confiar
   em IDs de tarefas preservados nas tabelas de controle. Conferir execução
   e continuação dos lotes até não restarem registros elegíveis.
4. Reaplicar a exclusão deferida conforme a implementação autorizada para
   aquela classe. Conferir ausência nas tabelas, storage, índices e consultas;
   manter as exceções fiscais e comerciais explicitamente conservadas.
5. Conferir hashes, relações, acesso negado, totais REST e identidade comercial.
   Repetir o processamento de retenção e conferir que não altera saldo,
   contagem nem dados atuais. Não resetar orçamentos ativos para limpar dados.
6. Emitir recibo sanitizado com SHA, alvo, relógio, contagens antes/depois,
   hashes, tarefas recriadas e resultado. Só então o operador pode liberar
   o acesso ao destino. Recusa ou falha mantém o destino isolado.

Prazos, alvo e responsável principal estão decididos. A guarda por classe,
o canal e o substituto foram decididos em 07/10, conforme a seção seguinte.
D01 e D05 têm implementação e prova local; a guarda após o encerramento
(#186) tem prova em `convex-test`. A cópia externa de D04 foi
[configurada em 08/10](../operacao/backup.md) e tem cópias íntegras manuais de 08/10 e
18/10; as execuções agendadas falharam de 09/10 a 18/10 e o RPO de 24 horas
foi violado nesse intervalo. As agendadas de 19/10 passaram, e a #248 trocou
a custódia provisória pela chave do mantenedor. D02 e D03 estão documentados em
[RIGHTS](RIGHTS.md) e [OBSERVABILITY](OBSERVABILITY.md#logs-dos-provedores-d03),
sem aplicação na instalação. Permanecem o canal `privacidade@`, a conferência
dos logs dos provedores, a entrega do cofre compartilhado, o custo e o ensaio de perda do
host. Em 19/10, depois da #259, `retentionRecovery:recover` rodou na instalação
com `missing` zero, e D05 passou com o backup real.

## Decisões de 07/10/2026

O mantenedor decidiu em 07/10/2026 a guarda por classe
para D01, o canal de D02 e o substituto de D02/D04. São decisões para
implementação. Não constituem parecer jurídico nem comprovam aplicação.

### Guarda após o encerramento, D01

O contribuinte, cliente da Freecorps, é quem tem a obrigação de guardar os
documentos fiscais. A Freecorps atua como operadora. A conservação após o
encerramento segue o prazo decadencial do
[CTN, art. 173, I](https://www.planalto.gov.br/ccivil_03/leis/l5172compilado.htm):
cinco anos contados de 1º de janeiro do ano seguinte ao fato. Para uma nota
emitida em 2026, a guarda termina em 31/12/2031. A janela de 30 dias e a
execução em até 7 dias continuam valendo para as classes excluídas.

| Classe                                                                                                                               | Guarda após o encerramento                                    | Finalidade e fundamento                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| XML NF-e e NFS-e, eventos, protocolos e recibos das autoridades                                                                      | Até 31/12 do quinto ano seguinte ao da emissão ou do evento   | Guarda em favor do contribuinte, por conta da obrigação dele. LGPD art. 16, I. Exige cláusula contratual de operadora e exportação a pedido.   |
| Auditoria original das operações fiscais                                                                                             | Mesmo prazo do documento a que se refere                      | Demonstra a origem e a integridade do documento conservado.                                                                                    |
| Registros comerciais, cobrança e eventos idempotentes                                                                                | Cinco anos a partir de 1º de janeiro do ano seguinte ao fato  | Obrigações da própria Freecorps, que atua como controladora (CTN art. 173 e Código Civil art. 1.194). Preserva a deduplicação.                 |
| Históricos do gate e do probe NFS-e (`issuanceGateEvents`, `issuanceProbeEvents`) e da liberação da captura (`captureReleaseEvents`) | Mesmo prazo dos documentos fiscais que justifica              | Defesa da própria Freecorps, controladora (LGPD art. 7º, VI). Não é obrigação legal; [revisão fiscal/privacidade]. Ver nota abaixo.            |
| Registros de acesso à aplicação (data, hora e IP)                                                                                    | Seis meses                                                    | [Marco Civil, art. 15](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm). Console e API REST implementados, ver abaixo. |
| Cadastro, contas, membros, credenciais, PFX e chaves de API                                                                          | Excluídos após 30 dias de exportação e até 7 dias de execução | Sem fundamento de conservação depois do encerramento. Revogar as credenciais no início da janela.                                              |
| Registros de atendimento a direitos                                                                                                  | Cinco anos a partir do encerramento do pedido                 | Comprova o atendimento (LGPD art. 16, I e II). Conservar o mínimo, sem anexos sensíveis.                                                       |

Quando houver fiscalização, processo ou pedido formal da autoridade, o
documento é conservado além do prazo. A exceção registra a referência, o
responsável e a data de revisão. Com o prazo vencido, as classes conservadas
entram no expurgo. Exceção e expurgo estão em
[guarda implementada](#guarda-implementada-d01).

Nota de 27/10/2026: esta guarda vale para a organização que teve dados de
Produção. A que nunca teve só tem dados do Sandbox, sem validade fiscal, e os
perde logo depois do encerramento
([organização sem Produção](#organização-sem-produção-decidido-em-27102026)).

Os registros de acesso por seis meses não cabem na D03. A retenção nativa
dos provedores, de três ou sete dias, não atende a esse prazo.

A tabela `accessRecords` de `platform/convex` guarda usuário, IP e data/hora
de cada acesso autenticado ao console. Grava a primeira ocorrência por
usuário, IP e hora, depois de login, leitura de sessão ou emissão de token
bem-sucedidos. O IP é o que o Worker assina; um IP enviado pelo chamador
nunca é aceito, e o modo local não grava. Cada registro expira em 184 dias,
o máximo de seis meses consecutivos. Uma única tarefa agendada, revista no
máximo a cada sete dias, remove os vencidos em lotes de 100. A tabela não
tem consulta pública: o acesso é pelo painel do deployment, restrito a quem
opera a instalação. Encerrar a conta não apaga esses registros antes do prazo.
Falha na gravação não bloqueia o login; gera o aviso `ACCESS_RECORD_UNAVAILABLE`
no log.

A API REST tem endereço público próprio, `https://api.nfe.freecorps.com.br`,
decidido em 07/10. O Worker recebe `/v1/*` e `/health` nesse host e repassa
a chamada ao `convex.site` com o IP de borda assinado pelo `AUTH_PROXY_SECRET`.
A assinatura cobre método, caminho, IP e horário, com validade de 30 segundos.
O corpo não é assinado, para que uploads e downloads passem direto pelo Worker;
a chave de API continua autenticando a chamada. Depois da admissão, o Convex
grava `key:<id>` ou `member:<id>`, IP e hora em `accessRecords`, com a mesma
deduplicação por hora e o mesmo prazo de 184 dias do console. Uma assinatura
forjada, vencida ou recebida sem proxy configurado é recusada com
`INVALID_REQUEST`.

Na instalação (`APP_ENV=installation`), o backend também recusa com
`INVALID_REQUEST` qualquer chamada REST direta ao `convex.site` sem assinatura,
inclusive downloads e uploads. Assim, nenhum acesso REST escapa do registro.
`API_URL` informa ao backend o endereço público usado nas URLs de upload, e
`/health` continua aberto no `convex.site` para o monitoramento. Em 07/10 o
mantenedor confirmou que os apps consumidores da Freecorps não usam esta API, e por isso
não há consumidores a migrar.

### Encerramento implementado, D01

Só o owner encerra a organização, digitando o endereço dela para confirmar.
O encerramento grava `organizationClosures` e vale na mesma transação: o
console recusa as funções da organização com `ORGANIZATION_CLOSED`, as chaves
de API passam a receber `INVALID_API_KEY` e as operações em andamento perdem
o acesso. Em seguida, uma tarefa em lotes desativa projetos, revoga as chaves,
desativa webhooks e monitores e revoga convites abertos. Antes dessa tarefa,
a conferência e o aceite de convite já recusam com `INVITATION_UNAVAILABLE`.

Quando ninguém consegue entrar para encerrar (sobras sintéticas de teste de
carga, organizações de teste), a Freecorps usa a função interna
`organizationClosure:closeByOperator`, só pelo CLI do Convex, com
`organizationId`, `actor` (login do GitHub) e `reason` (10 a 500
caracteres). Ela segue o mesmo fluxo, janelas e expurgo de D01, grava
`requestedBy` como `operator:<login>`, registra na auditoria da organização
`operator:freecorps` e no log `organization.closure-by-operator` com o motivo,
que só fica nesse log e na issue ou PR do pedido. Recusa com `PAID_PLAN` a
organização com plano ainda não encerrado de tier diferente de `free` (pago,
`custom` ou sem tier, da atribuição assistida antiga), com recibo de plano da
plataforma ou com pedido de plano aguardando pagamento; com `PRODUCTION_DATA`
a que tenha sondagem de emissão em `producao`, ou empresa com gate de emissão
em produção, captura liberada alguma vez, conexão Stripe em `production`, ou
documento, artefato, importação, emissão ou stream de captura em
`production`; com `OPERATOR_CLOSURE_LIMIT` a que passe de 100 empresas ou
100 sondagens; com `ORGANIZATION_CLOSED` a que já tem encerramento e com
`NOT_FOUND` a que não existe. Essas checagens evitam encerrar o id errado; não
provam que não há cliente por trás, e o operador confere a organização antes.
Como só passam organizações sem Produção, os dados fiscais delas costumam sair
logo depois do expurgo, pela regra da
[organização sem Produção](#organização-sem-produção-decidido-em-27102026),
decidida de novo no expurgo com a conferência própria da guarda.

A Freecorps também encerra, sem pedido do owner, a organização aberta que só
teve Sandbox e ficou 90 dias sem atividade, depois de um aviso de 30 dias por
e-mail e no console em que owners e admins podem mantê-la ativa (ADR 0009,
decisão 2 de 29/10/2026). O encerramento é o mesmo, com `requestedBy`
`freecorps:sandbox-inactive` e a auditoria `operator:freecorps`, e os dados
do Sandbox saem logo depois do expurgo pela regra da organização sem
Produção. O aviso (`sandboxClosureNotices`, classe `closure`) sai com o
expurgo. Procedimento em
[arquivo econômico](../operacao/arquivo-economico.md#encerramento-de-organização-só-com-sandbox).

Durante 30 dias, proprietários e administradores podem pedir e baixar a
[exportação da organização](EXPORTS.md). Exportações por documento dependem
de projeto ativo e deixam de funcionar. Ao fim da janela, o expurgo remove em
lotes de 200 registros: exportações e seus arquivos, links de download,
eventos e entregas de webhook, empresas, concessões, histórico cadastral,
certificados, perfis de emissão NFS-e, projetos, chaves, auditoria de integrações e da organização,
monitores, alertas, notificações, telemetria do painel, convites, membros e a
própria organização. O prazo para concluir é de 7 dias.

Ficam conservados documentos fiscais, artefatos e originais no storage,
importações, versões e itens, operações, tentativas, auditoria das operações e
dos certificados, idempotência, captura, uso, planos, recibos REST e seus
totais, e registros de acesso. Cada classe segue a guarda da tabela acima,
aplicada conforme a [guarda implementada](#guarda-implementada-d01), salvo
numa [organização sem Produção](#organização-sem-produção-decidido-em-27102026). Contas
de usuário e sessões são globais; a pessoa pode participar de outras
organizações.

`organizationClosures` guarda só ids, datas, estado e contagem; sobrevive ao
expurgo e segue a [classe `decision`](#prazo-da-classe-decision-decidido-em-19102026).
Ao concluir, o expurgo registra no log uma linha `organization.purged`, com
a contagem. O operador copia `organizationClosure:decisions` para
o registro restrito de D02 a cada encerramento e a cada expurgo; é a decisão
que um restore precisa reaplicar.

Depois de um restore, antes de liberar o acesso:

1. Para cada retenção legal ativa do registro restrito, `fiscalGuard:hold`
   com os valores registrados. Vem primeiro porque o passo seguinte pode
   expurgar na hora uma guarda vencida.
2. `retentionRecovery:recover` com `{"phase":0,"cursor":null}` reagenda os
   prazos de encerramento, guarda, classe `decision`, telemetria, registros
   de acesso, cache cadastral e exportações cujo job não voltou com o
   snapshot. A função
   continua sozinha até o fim.
3. `retentionRecovery:inspect`, página a página, precisa terminar com
   `missing` igual a zero.
4. Para cada decisão do registro restrito, `organizationClosure:reapply` com
   `organizationId` e `requestedAt` originais. Prazo vencido expurga na hora;
   repetir não muda nada. Uma decisão cujo próprio prazo já venceu responde
   `absent` e não volta ao banco.
5. Para cada `account.deleted` do registro restrito, `account:reapplyDeletion`
   com o `authUserId`, conforme
   [Atendimento a direitos](RIGHTS.md#depois-de-um-restore).

A limpeza de uploads órfãos e os monitores não entram nessa recuperação.

### Guarda implementada, D01

Cada tabela da plataforma tem uma classe de retenção em
`platform/convex/lib/retentionClasses.ts`. O typecheck recusa uma tabela nova
sem classe, e o teste do expurgo usa essa lista para conferir que nenhuma
linha da organização sobra.

| Classe       | Tabelas                                                                                                                                             | Destino                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `closure`    | Organização, membros, convites, empresas, perfis e gates de emissão NFS-e, projetos, chaves, certificados, webhooks, exportações, DANFE, telemetria | Expurgo ao fim da janela de 30 dias, em até 7 dias                                                                             |
| `fiscal`     | Documentos, artefatos e originais, versões, itens, importações, captura, emissões NFS-e e sua numeração, operações, tentativas e auditorias         | Guarda após o encerramento, depois expurgo                                                                                     |
| `commercial` | Uso, totais, planos e sua auditoria, recibos de operação e REST, idempotência, chamadas cadastrais, históricos do gate e do probe de produção NFS-e | Mesma guarda, por obrigação da própria Freecorps                                                                               |
| `access`     | `accessRecords`                                                                                                                                     | 184 dias pelo job próprio, com ou sem encerramento                                                                             |
| `decision`   | `organizationClosures`, `retentionHolds`                                                                                                            | Fim da guarda fiscal mais um ano, só com ids e datas, depois expurgo ([prazo](#prazo-da-classe-decision-decidido-em-19102026)) |
| Demais       | Cache cadastral, controle de jobs, tabelas de referência pública e tabelas locais/de validação                                                      | Ciclo próprio, sem dado da organização                                                                                         |

O mapa de IDs antigos do arquivo econômico (`coldArchiveIdMap`, ADR 0009, §6)
é da classe `fiscal`: acompanha a organização enquanto ela e a guarda
existirem e sai com as linhas fiscais no fim da guarda.

As intenções de upload da reidratação (`coldArchiveUploads`) são da classe
`control`, como o run: guardam só IDs de storage, hashes e tamanhos, sem
conteúdo fiscal, e ficam para a coleta de uploads órfãos.

A restauração isolada de uma organização arquivada, encerrada ou aberta (ADR
0009, §7), só lê o pacote e o catálogo. Ela não muda o `retainUntil` do run,
o lock no R2 nem a guarda. Quem os muda é a renovação do operador, enquanto a
organização aberta segue arquivada: estende a regra de lock do run no R2 e
depois o `retainUntil`, só para frente
([arquivo econômico](../operacao/arquivo-economico.md#prazo-do-pacote-e-lock-no-r2)). O destino descartável e a exportação entregue são
cópias a mais dos dados fiscais: o destino é descartado depois da entrega, e
a entrega segue [RIGHTS.md](RIGHTS.md).

Os pedidos de exportação assistida (`assistedExports`, ADR 0009, §7) são da
classe `closure`: guardam a conta e o membro que pediram, a base do pedido e
a data, que conta o limite de um pedido do Proprietário a cada 30 dias, e
saem com o expurgo do encerramento. A exportação entregue é uma exportação
comum da organização e segue o prazo de 24 horas das demais.

Quando o expurgo do encerramento termina, uma tarefa passa a esperar o fim da
guarda: `fiscalGuardUntil`, 1º de janeiro do sexto ano seguinte ao
encerramento, 00:00 de Brasília. Para um encerramento em 2026, a guarda vai
até 31/12/2031. A tarefa é revista no máximo a cada 7 dias, sem ficar
agendada por anos. Vencido o prazo, `fiscalGuard:expire` remove em lotes de
200 todas as linhas das classes `fiscal` e `commercial` da organização e seus
arquivos no storage, e registra `expiredAt` em `organizationClosures`. O log
recebe `organization.guard-expired`, com a contagem e o prazo da classe
`decision`, que o operador copia para o registro restrito de D02. Repetir não
muda nada. `organizationClosure:decisions` passa a exportar `guardUntil`,
`expiredAt` e `decisionUntil`.
Encerramentos expurgados antes desta versão não têm a tarefa: depois de
publicar, `retentionRecovery:recover` a cria, e `inspect` conta cada guarda
sem job como `missing`.

O prazo conta do ano do encerramento, não de cada fato. O encerramento
bloqueia novas operações na mesma transação, então nenhum fato conservado é
posterior a ele e nenhuma linha sai antes da própria guarda. Fatos de anos
anteriores ficam até a mesma data. Separar por documento exigiria dividir
originais, lotes e operações compartilhados entre documentos. Em 19/10/2026,
o mantenedor aceitou essa regra, e confirmou o aceite em 21/10/2026: ela
nunca apaga antes do prazo, ao custo de conservar fatos antigos por mais tempo
do que a tabela acima exige.

Uma retenção legal (fiscalização, processo ou pedido formal da autoridade)
usa as mutations internas, executadas pelo operador no painel do deployment:

- `fiscalGuard:hold` com `organizationId`, `reference` (a referência do
  registro restrito, sem nome de titular ou documento), `responsible` e
  `reviewAt` futuro. A mesma referência só atualiza a revisão. Vale para
  organização ativa ou encerrada, e para toda a parte conservada dela.
- Enquanto houver retenção ativa, o expurgo não roda. Passada a data de
  revisão sem liberação, o log recebe `retention.hold-review-due` a cada
  verificação; a retenção não vence sozinha.
- `fiscalGuard:release` com `organizationId` e `reference` encerra a
  retenção. Sem outra ativa e com o prazo vencido, o expurgo começa na hora.
- `fiscalGuard:holds` exporta as retenções para o registro restrito; um
  restore precisa reaplicá-las antes da recuperação.

Uma retenção registrada depois de o expurgo começar não devolve o que já
saiu; registre-a antes do fim da guarda. Os registros de acesso não entram
nesse expurgo e seguem os 184 dias. A prova está em
`platform/convex/closure.test.ts`: o expurgo só começa no prazo, a retenção
segura as linhas mesmo depois da revisão, a liberação expurga todas as linhas
das duas classes e os arquivos, outra organização fica intacta e um restore
rearma a guarda perdida. Nenhum ensaio fora do `convex-test` foi executado.

### Organização sem Produção, decidido em 27/10/2026

Em 27/10/2026, o mantenedor decidiu que uma organização que nunca teve dados
de Produção não precisa da guarda: nada do que ela guardaria tem validade
fiscal. Uma organização com qualquer dado de Produção segue a guarda inteira,
como antes, inclusive para os dados do Sandbox.

Em 04/11/2026, na #108, o mantenedor precisou a regra: o Sandbox tira a
validade fiscal da emissão, que é simulada, mas não de uma NF-e real
importada. O `tpAmb` do XML de uma nota importada no Sandbox pode ser 1, e o
documento continua autêntico. Por isso uma nota recebida conta como Produção
quando o próprio XML não declara homologação (`tpAmb` 2), seja qual for o
ambiente em que está guardada. Os termos de uso 1.3
(`termos-de-uso-2026-11-05`, #169) dizem o mesmo nas seções 2 e 9 e no item
11 da cláusula de operadora. Até o aceite de cada organização, vale a versão
que ela aceitou, que ainda diz que o Sandbox não tem efeito fiscal; o código
guarda mais do que essa versão promete, nunca menos.

- **Regra.** Ao fim da janela de 30 dias, o expurgo do encerramento não muda
  e arma a guarda para o mesmo instante. Se a organização nunca teve
  Produção e não há retenção ativa, a verificação da guarda remove, já
  nessa hora, as linhas das classes `fiscal` e `commercial` dela e seus
  arquivos, com o mesmo código e os mesmos lotes de 200 do expurgo do prazo
  (`fiscalGuard:early`). Entram também as linhas sem ambiente próprio (uso
  anterior à #429, auditoria do certificado, idempotência, históricos do
  gate, do probe e da liberação), porque a organização inteira só teve
  Sandbox. Ficam até o prazo os registros da própria Freecorps sobre planos,
  pagamentos, capacidade e aceite dos termos de uso, que servem às obrigações
  dela e não dependem do ambiente: `usagePlans`, `usagePlanAudit`,
  `termsOfUseAcceptances`, `platformPlanTerms`,
  `platformPlanReceipts`, `platformPlanAllocations`, `platformFreeClaims`,
  `billingAccounts`, `billingCheckouts`, `billingGrants`, `billingEvents`,
  `capacityAccounts`, `capacityEvents` e `capacityTotals`. Os rastreadores
  por linha e por arquivo (`capacityRecords`, `capacityFiles`) saem com a
  linha ou o arquivo que acompanham. A contagem soma em `expired`, como no
  expurgo do prazo, e não em `removed`, que continua igual à de
  `organization.purged`; cada lote registra `organization.sandbox-purged` no
  log, que o operador copia para o registro restrito. A linha de encerramento e as
  retenções seguem a classe `decision`, contada do prazo nominal da guarda.
- **Decidido uma vez.** O expurgo do encerramento decide, antes do primeiro
  lote e com os dados ainda no lugar, e grava em `sandboxOnly` no registro do
  encerramento. Nunca teve Produção quer dizer: nenhuma linha com ambiente
  `production` em documentos, importações, fluxos de captura, emissões,
  numeração DPS, simulações, operações, uso e totais e recibos REST e seus
  totais, cada um conferido com `.first()` no índice
  `by_organizationId_and_environment`; nenhuma nota recebida (sem
  `direction`) com `tpAmb` 1 ou sem a marca, cada caso conferido com
  `.first()` no índice `by_organizationId_and_direction_and_tpAmb`; nenhum
  original importado sem documento que guarde nota real (veja "O original
  recusado"); nenhuma
  liberação da captura fiscal concedida (`captureReleaseEvents`), nenhum gate da emissão em produção
  (`issuanceGateEvents`), nenhum probe em `producao` (`issuanceProbeEvents`)
  e nenhum arquivo frio (`coldArchiveRuns`), que tira linhas das tabelas
  conferidas. Um arquivo frio iniciado depois da decisão também conta: antes
  de cada lote, `early` confere `coldArchiveRuns`, as notas recebidas e os
  originais recusados sem
  homologação; se houver um ou outra, grava `sandboxOnly` falso, registra
  `organization.sandbox-purge-stopped` uma vez, com `reason` `cold-archive`
  ou `fiscal-document`, e deixa o resto para o prazo. A segunda conferência
  cobre a decisão gravada antes da #108, que não lia o `tpAmb`; numa decisão
  de hoje ela sempre passa, porque nada grava notas de uma organização
  expurgada. Mais de 100 eventos de um desses históricos contam como
  Produção. Uma conexão Stripe de Produção só emite pelo gate da emissão,
  então o histórico do gate a cobre; a conexão em si é da classe `closure`.
  As tabelas conferidas pelo ambiente formam `PRODUCTION_TABLES`, e
  `fiscalGuard.test.ts` reprova uma tabela do schema com `environment` que
  não está nela nem entre as exceções com motivo, e uma com `tpAmb` que a
  decisão não lê.
- **A marca da nota.** `fiscalDocuments.tpAmb` guarda o `tpAmb` que o XML
  declara, na nota, no protocolo de autorização, no evento ou no recibo dele.
  Cada versão gravada pela importação o escreve (`publishVersion`), também a
  que não vira a versão publicada, como um original em conflito; "1" nunca é
  trocado. Sem a marca ficam o resumo (`resNFe`), a NFS-e ABRASF importada e
  as notas publicadas antes da #108, e nenhuma dessas é dada como
  homologação. Não há preenchimento retroativo: uma organização com nota
  antiga só perde o expurgo antecipado e segue a guarda. A NFS-e emitida
  (`direction` `emitted`) fica fora da conferência: no Sandbox ela sai do
  simulador, e em Produção já tem linha de Produção.
- **O original recusado.** Um arquivo importado e recusado sem documento
  (`COMPANY_MISMATCH`, `IDENTITY_INVALID`, ou recusado pelo parser, como uma
  NFC-e, uma NF-e 3.10 ou um evento não suportado) não tem
  `fiscalDocuments.tpAmb`. `importProcessing.stage` grava em
  `documentArtifacts.tpAmb` o `tpAmb` que ele declara: o da nota normalizada,
  ou, sem ela, o de todo elemento `tpAmb` lido como texto nos bytes; "1" nunca
  é trocado. A decisão (`realOriginal`) confere com `.first()` um original sem
  documento com `tpAmb` 1 no índice `by_organizationId_and_documentId_and_tpAmb`
  e lê até 100 originais sem documento e sem a marca, de qualquer origem, com
  até 10 versões cada. Entre os importados, conta como Produção o que não se
  sabe ser teste: o resumo, a recusa de antes da marca, o arquivo que o parser
  não conseguiu ler e o original cuja importação não gravou versão. Não conta
  o arquivo cuja raiz o parser leu fora do namespace da NF-e
  (`XML_NAMESPACE_UNSUPPORTED`, `XML_SOURCE_INVALID`, inclusive a NFS-e ABRASF
  recusada desde 02/11/2026), nem o lote NFS-e aceito, cujas notas têm
  documento. O original capturado só chega por liberação da captura, já
  conferida. Passar de um desses limites conta como Produção.
- **Retenção legal.** Com retenção ativa, nada sai antes do prazo. Depois da
  liberação, a remoção vem na verificação seguinte, em até 7 dias.
- **Encerramentos anteriores.** Um encerramento expurgado antes desta versão
  não tem `sandboxOnly`: a verificação seguinte da guarda, em até 7 dias,
  decide com a mesma regra, inclusive o arquivo frio, grava o resultado e só
  então age.
- **Falha.** Cada lote roda como subtransação, com cerca de metade dos
  limites de leitura, escrita, consultas e agendamentos de uma mutation, para
  que a verificação que o chama ainda tenha folga para rearmar a guarda. Um
  erro ou o estouro desses limites desfaz o lote, o log recebe
  `organization.sandbox-purge-failed`, e a guarda é rearmada para o prazo,
  revista no máximo a cada 7 dias; os dados ficam até o prazo ou até uma
  verificação que dê certo. Isso não cobre uma falha da verificação inteira,
  como o limite de tempo de execução da mutation: aí nada é gravado, nem o
  rearme; o job falho aparece como `missing` em `retentionRecovery:inspect`, e
  `retentionRecovery:recover` o recria.
- **Arquivos compartilhados.** Antes de apagar um arquivo, o expurgo da
  guarda, no prazo ou antes dele, lê quem mais o guarda, no mesmo conjunto que
  o arquivo frio confere (`lib/storageHolders.ts`): artefatos, arquivos de
  importação, blobs de conteúdo das versões (ADR 0010, fase B), lotes da
  captura, artefatos da emissão, versões de referência, mensagens e entradas
  da caixa de privacidade, partes de exportação e rastreadores de capacidade,
  até 20 por tabela. Versões de referência e
  mensagens de privacidade nunca são da organização. Se alguma linha for de
  outra organização, ou se houver mais de 20 numa tabela, o arquivo fica e o log recebe
  `organization.file-kept`; a linha sai mesmo assim. Se o dono de uma delas
  não puder ser lido, a remoção antecipada desfaz o lote e tenta de novo na
  verificação seguinte, sem apagar a linha; no expurgo do prazo, o arquivo
  fica, o log recebe `organization.file-kept` e a linha sai, para que a
  guarda nunca pare. As linhas da própria organização não impedem: ela sai
  inteira.
- **Deploy.** Os índices `by_organizationId_and_environment` das onze tabelas
  acima e `by_organizationId_and_direction_and_tpAmb` de `fiscalDocuments`
  são preenchidos no deploy, que espera o preenchimento.

A prova está em `platform/convex/closure.test.ts`: a organização só com
Sandbox perde os dados fiscais, inclusive as linhas sem ambiente, mas não os
registros de planos, pagamentos e capacidade, sem tocar outra organização;
uma linha de Produção em uso, importações ou emissões, uma liberação da
captura, um gate em produção, um probe em `producao`, mais de 100 eventos de
gate, um arquivo frio, uma NF-e com `tpAmb` 1 ou uma nota sem a marca mantêm
tudo até o prazo, e a nota real de outra organização não muda a decisão; a
remoção antecipada chamada direto não remove a NF-e real, que sai na
expiração do prazo; uma decisão de só Sandbox gravada antes da #108 para uma
vez diante de uma nota sem marca (`platform/convex/importProcessing.test.ts`
prova a marca: o `tpAmb` do XML, e "1" mantido diante de outro original que
diz homologação); a retenção segura a remoção
até a liberação; a remoção chamada direto não age em encerramento não
concluído; o encerramento anterior à decisão perde os dados na verificação
seguinte, em lotes; o sem decisão gravada a toma uma vez, perdendo os dados
se só teve Sandbox e conservando-os se houver arquivo frio; um arquivo frio
iniciado depois da decisão para a remoção uma vez; um erro desfaz o lote e
mantém a agenda; um dono ilegível desfaz o lote antecipado e, no prazo,
mantém o arquivo sem parar a guarda; e um arquivo também guardado por outra organização fica,
enquanto o guardado por mais de 20 linhas da própria organização sai. O
estouro dos limites da subtransação não tem teste. O ensaio D05
(`scripts/backup/prove-closure-restore.mjs`) semeia uma cópia de Produção na
organização encerrada; ela fica fora da remoção antecipada, e o ensaio
continua conferindo a conservação. O ensaio não foi repetido depois da
mudança, e nada foi executado fora do `convex-test`.

### Histórico da liberação da captura fiscal

`captureReleaseEvents` registra cada liberação e retirada da
[captura fiscal no site](CAPTURE.md#liberação-fiscal-no-site). Nas mudanças
do console, guarda a pessoa da organização, a versão dos termos aceitos e,
desde a #428, o SHA-256 do texto ([termos arquivados](../termos/README.md));
nas da Freecorps (emergência e desbloqueio), os logins GitHub, o run e a
tentativa, como o histórico do gate abaixo. Também guarda o intervalo mínimo
e quantas chaves de produção foram revogadas. Segue a classe `commercial` e a
base legal proposta do gate da NFS-e: documenta quem autorizou ler, em
produção, os documentos fiscais de uma empresa. O estado corrente,
`captureReleases`, é da classe `closure` e sai no expurgo da organização.

### Aceite dos termos de uso

`termsOfUseAcceptances` registra cada aceite dos
[termos de uso](../termos/README.md#termos-de-uso) por um proprietário (#586):
organização, membership de quem aceitou, versão, SHA-256 do texto e horário.
É o registro do contrato da própria Freecorps com a organização, e segue a
classe `commercial` com os planos e pagamentos: fica até o fim da guarda,
inclusive na organização que nunca teve Produção, e sai no expurgo do prazo
(`fiscalGuard`). O membership de quem aceitou sai no expurgo da organização;
o id fica na linha. A primeira versão entrou em vigor em 01/11/2026 (#428).

`termsOfUseNotices` registra o aviso por e-mail de cada versão nova a uma
organização (#594): versão, estado do envio, quantos destinatários, quantos
confirmados e quantos fora da allowlist, e horários, sem endereço. É da classe `closure` e sai no expurgo da organização.
`termsOfUseNoticeRuns`, o cursor da varredura de cada versão, é `control`.

`captureFiscalHalts` guarda a parada geral da captura no site (#424): tipo,
logins GitHub, motivo, run e tentativa de cada parada e retomada. Não tem
organização nem dado de cliente e fica na classe `control`, com ciclo
próprio; nenhum job a apaga.

### Histórico do gate de produção

`issuanceGateEvents` registra cada troca do
[gate de produção da emissão NFS-e](ISSUANCE.md#gate-de-produção): empresa,
versão, tipo, motivo, run e tentativa do GitHub Actions, revisão publicada,
URL do deployment e hora, mais os logins GitHub de quem disparou, de quem
iniciou o run quando for outra pessoa e de quem aprovou. Os logins são de
colaboradores da Freecorps, não de usuários do cliente.

- **Papel.** A Freecorps é controladora desse registro: ele documenta uma
  decisão da própria Freecorps, a de liberar a emissão com validade fiscal
  para uma empresa, e quem da equipe a tomou e aprovou.
- **Finalidade e base legal proposta.** Comprovar quem autorizou cada nota
  real e defender essa decisão diante do cliente, do fisco ou de um processo:
  exercício regular de direitos (LGPD, art. 7º, VI), com legítimo interesse
  (art. 7º, IX) para o uso durante a vigência. Nenhuma lei obriga a guardar
  este registro; o prazo vem da finalidade de defesa, que dura enquanto a
  nota pode ser questionada. [Confirmar na revisão fiscal/privacidade, com a
  mesma revisão das demais classes.]
- **Classe `commercial`.** É registro da própria Freecorps, como os de uso,
  cobrança e idempotência, mas com outro fundamento: aqueles seguem obrigações
  legais da Freecorps, este segue a defesa. Tem o mesmo prazo das notas que
  justifica: fica
  enquanto a organização existe e, depois do encerramento, até o fim da guarda
  (`fiscalGuardUntil`), quando sai no expurgo de `fiscalGuard` junto das
  classes `fiscal` e `commercial`. A classe `fiscal` guarda dados do cliente,
  tratados pela Freecorps como operadora, e não descreve este registro. A
  classe `decision`, mais longa, é o registro de encerramentos e retenções
  legais, e ao fim da guarda reduz o conteúdo a ids e datas: apagaria
  justamente quem ligou e por quê, e duraria mais que as notas.
- **Exportação.** O histórico não entra na exportação a pedido do cliente: a
  exportação reúne os dados que a Freecorps trata como operadora, e este é
  registro dela como controladora. O cliente vê o estado do gate da própria
  empresa no console, quando a tela existir. Um colaborador que peça os
  próprios dados segue o [canal de atendimento](#canal-de-atendimento-d02).

### Histórico do probe

`issuanceProbeEvents` registra cada uso do certificado A1 do cliente numa
leitura de operador (o probe de mTLS, adesão e parâmetros, e a verificação de
uma nota autorizada): o login GitHub de quem executou, o motivo, a empresa, a
emissão conferida, o ambiente, o resultado de cada leitura (sem corpo), as
recusas com o código, revisão e hora.

- **Papel.** A Freecorps é controladora desse registro: ele documenta o uso,
  por colaboradores da Freecorps, de um certificado que o cliente confiou ao
  cofre.
- **Finalidade e base legal proposta.** Documentar cada uso do A1 do cliente
  fora de uma emissão e responder por ele diante do cliente, do fisco ou de um
  processo: exercício regular de direitos (LGPD, art. 7º, VI), com legítimo
  interesse (art. 7º, IX) para o uso durante a vigência. [Confirmar na revisão
  fiscal/privacidade.]
- **Classe `commercial`.** Pelo mesmo motivo do histórico do gate: registro da
  própria Freecorps, com o prazo das notas e do certificado que ele explica, e
  o mesmo expurgo ao fim da guarda.
- **Exportação.** Não entra na exportação a pedido do cliente. O cliente vê na
  auditoria do certificado quando o A1 foi usado (`nfse-probe` ou
  `nfse-probe-production`), com o ator genérico.

### Prazo da classe `decision`, decidido em 19/10/2026

O mantenedor escolheu conservar os registros de encerramento e de retenção
legal até o fim da guarda fiscal mais um ano. Esses registros comprovam que
o expurgo aconteceu e precisam sobreviver à guarda dos documentos. Para a
implementação futura, o mantenedor escolheu limitar o conteúdo a ids e datas.
A implementação está [abaixo](#implementação-250).

Por exemplo, se a guarda fiscal termina em 31/12/2031, os registros da classe
`decision` ficam até 31/12/2032. O ano adicional conta do fim da guarda
fiscal, não da criação do registro de decisão.

#### Implementação, #250

Enquanto encerramento, guarda e retenção estão em curso, as linhas mantêm os
campos de que esses fluxos dependem: quem pediu, revogação, contagens e, na
retenção ativa, `reference` e `responsible`. Quando `fiscalGuard:expire`
conclui, a linha de encerramento perde `requestedBy`, `revoked`, `removed` e
`expired`, e as retenções da organização perdem `reference` e `responsible`,
em lotes de 200. Ficam ids, datas e o controle do próprio job: `state`,
sempre `purged` a essa altura, `generation` e `scheduledId`. As contagens
saem antes no log, em `organization.purged` e `organization.guard-expired`, e
a referência já está no registro restrito; por isso `decisions` exporta
`removed` nulo e `holds` exporta `reference` e `responsible` nulos depois da
guarda.

`decisionGuardUntil`, em `platform/convex/lib/retentionClasses.ts`, calcula o
prazo em anos civis de Brasília: 1º de janeiro do segundo ano seguinte ao
último dia da guarda fiscal, 00:00. A data fica em `decisionUntil` quando a
guarda termina e é exportada por `decisions`.

Uma retenção legal que segura a guarda além do prazo nominal adia também a
classe `decision`. O fim da guarda passa a ser a liberação da última retenção
posterior ao prazo nominal, e o ano conta daí até o fim do ano civil seguinte:
liberada em 14/03/2034, a decisão fica até 31/12/2035, nunca menos de um ano
completo. Um atraso de outra causa, como um job perdido no restore, não muda
o prazo: a decisão pode sair logo depois do expurgo fiscal, nunca antes.

`fiscalGuard:forget` aplica o prazo. Antes de `expiredAt`, não faz nada,
qualquer que seja a data. Com retenção ativa, espera como a guarda. Vencido o
prazo, remove as retenções da organização em lotes de 200 e, por último, a
linha de encerramento, e registra `organization.decision-expired` no log, que
o operador copia para o registro restrito. A tarefa é revista no máximo a
cada 7 dias, como a da guarda. Repetir não muda nada; depois disso,
`fiscalGuard:hold` responde `NOT_FOUND` e `organizationClosure:reapply`
responde `absent`.

Encerramentos cuja guarda venceu antes desta versão não têm a tarefa: depois
de publicar, `retentionRecovery:recover` a cria, e a primeira execução grava
`decisionUntil` e reduz as linhas ao mesmo mínimo. `inspect` conta cada
decisão sem job como `missing`.

A prova está em `platform/convex/closure.test.ts`: o cálculo no fuso de
Brasília, inclusive a virada do ano; nada sai antes do prazo ou antes do
expurgo fiscal, nem com retenção ativa; a retenção liberada depois do prazo
nominal adia a decisão; o expurgo no instante exato do prazo, em vários
lotes, sem atingir outra organização; repetição; e o rearme após restore,
inclusive de encerramentos expirados antes desta versão. Nenhum ensaio fora
do `convex-test` foi executado, e nada foi aplicado na instalação.

### Canal de atendimento, D02

O canal dedicado é `privacidade@nfe.freecorps.com.br`, escolhido em 21/10/2026
em substituição ao alias do domínio principal. A caixa fica no console,
restrita ao responsável e ao substituto por allowlist do servidor. Mensagens,
originais, anexos e notas ficam nas tabelas globais `privacy*` e no storage,
fora das organizações clientes. A classe `control` identifica seu ciclo
próprio: cinco anos após encerrar o pedido, o expurgo remove conversa,
mensagens e originais; reabrir cancela esse prazo. Tickets de download
expiram em dois minutos. A manutenção é chamada pelo Worker dedicado a cada
cinco minutos, sem habilitar os crons fiscais do backend. Ela também apaga
originais de e-mail sem intake nem mensagem depois de uma hora, como os de
uma entrega que falhou antes de se registrar; `privacyMaintenance`, classe
`control`, guarda o cursor dessa varredura. Original referenciado não é
apagado por ela. O `message/rfc822` genérico só é elegível se criado antes
da linha de controle; um arquivo enviado à mão pelo dashboard com esse tipo
antes disso e sem referência seria apagado, e nenhum envio manual pode usar
o tipo privado dos originais. Na D05, com o Worker desligado, nem o expurgo
nem essa coleta rodam. A coleta falha fechada: nasce retida, retém tudo
que foi criado desde a última execução depois de mais de 30 minutos sem
execução e, no restore, é retida explicitamente com `holdOriginals` antes de
religar o Worker ([restauração](../operacao/restauracao.md#retenção-e-encerramentos-após-o-restore)).
O operador recupera os originais posteriores ao snapshot e libera com
`releaseHeldOriginals`, conforme o roteiro. A fila R2 e os
passos de ativação estão no [roteiro](../operacao/privacidade-email.md#falha-recuperação-e-retenção).
As mesmas tabelas guardam a caixa de segurança, separada por conversa, com
o mesmo ciclo de cinco anos, confirmado pelo mantenedor em 21/10/2026
([roteiro](../operacao/seguranca-email.md)). A caixa de suporte, ainda não
ativada, segue o mesmo ciclo no código; a guarda dos chamados é decisão do
mantenedor pendente ([roteiro](../operacao/suporte-email.md)). A caixa de
operação, dos alertas da captura, segue o mesmo ciclo até decisão própria
([roteiro](../operacao/operacao-email.md)).
O canal deve ser publicado junto com a identificação do encarregado
([LGPD, art. 41](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)).
Para vigorar, falta habilitar o recebimento e comprovar o atendimento por
quem tem acesso. Issues públicas continuam vedadas para os pedidos. O
procedimento de atendimento, os campos do registro restrito e o que o produto
permite executar hoje estão em [Atendimento a direitos](RIGHTS.md).
Em 19/10/2026, o mantenedor decidiu atender correção e exclusão de conta
por procedimento manual do operador até o fluxo existir no produto. A #254
implementou a [correção e a exclusão pelo titular](RIGHTS.md#correção-e-exclusão-de-conta)
e aposentou o procedimento manual.

### Substituto, D02 e D04

O substituto do mantenedor é o outro sócio. Ele cobre a
custódia dos backups, da configuração e das chaves e o atendimento a direitos.
Para D04, a identidade age dele foi registrada em 08/10 (#192) e a custódia
provisória usou uma segunda chave dele (#193) até 19/10, quando a #248 a
trocou pela chave do mantenedor. Em 19/10/2026, o mantenedor
registrou que o substituto aceitou, em conversa presencial, ser substituto em
D02. A participação dele no ensaio de perda do host, o primeiro acesso à
caixa de privacidade e a destruição da identidade provisória foram adiados pelo
mantenedor em 28/10/2026. Desde 31/10, recuperação e descarte seguem na #178,
e atendimento pelo substituto na #692, sem marco global. Só a custódia e o
atendimento do mantenedor foram provados. Em 02/11/2026, o segundo custodiante
executou a recuperação e destruiu a identidade offline de teste dele
(recibo); o aceite foi registrado na #178 no mesmo dia.
O [roteiro do backup externo](../operacao/backup.md#configuração-única) define esses
acessos: identidade age própria, token R2 de leitura e cofre de chaves.
