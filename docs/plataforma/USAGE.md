# Consumo, planos e capacidade

A plataforma mede consumo em `platform/convex`. O legado não participa
desses totais. A medição inicia com esta entrega; não reconstrói retroativamente
o consumo nem o estoque de arquivos anterior. Organização sem plano atribuído
fica em medição sem cota comercial, exceto para novas consultas de captura em
Produção: elas exigem plano vigente com cotas finitas de consultas (ou de
notas) e bytes, inclusive no plano gratuito. Desde a #429, cada unidade é medida
e cobrada no ambiente em que aconteceu, `sandbox` ou `production`
([Ambientes](#ambientes)).

## Unidades e período

| Unidade    | Identidade e momento                                                                                                                        | Limite                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Importação | Um `importFiles` confirmado, inclusive XML rejeitado pelo parser. Reserva no pedido e confirmação após upload validado.                     | Arquivos por mês             |
| Documento  | Um `fiscalDocuments` publicado; artefatos, resumos, eventos e reprocessamentos da mesma identidade não somam outra unidade.                 | Notas por mês ou informativo |
| Captura    | Consulta lógica de distribuição admitida antes do transporte. A reconciliação da mesma intenção conserva a identidade.                      | Consultas por mês            |
| CNPJ       | Despacho à fonte, mesmo com resultado incerto. Cache não conta.                                                                             | Despachos por mês            |
| Bytes      | Bytes de originais confirmados e lotes brutos/envelopes persistidos na captura. Não inclui índices, itens, PFX ou todo o estoque histórico. | Bytes recebidos por mês      |
| Webhook    | Uma entrega admitida por evento e destino. Retry e reenvio da mesma entrega não somam. Admissão não significa recebimento confirmado.       | Entregas por mês             |
| Tentativa  | Claim de operação, retomada ou tentativa de webhook.                                                                                        | Informativo                  |
| Emissão    | Uma NFS-e autorizada pela plataforma (`issuances`), contada no checkpoint da autorização; reconciliação e repetição não somam.              | Informativo, só medida       |

O período é o período de cota do plano no instante da reserva. Uma reserva
de setembro concluída em outubro continua em setembro. Os inteiros
representam unidades e bytes, sem conversão para dinheiro. Repetir outra
intenção de importação pode consumir outro arquivo e outros bytes, mas nunca
outro documento único da mesma identidade.

### Período de cota

Em 03/11/2026 o dono decidiu que o período dos planos pagos passa a ser o mês
da assinatura, a partir do instante da contratação, e que o Gratuito continua
no mês civil UTC ([ADR 0012](../adr/0012-periodo-por-aniversario.md)). A
fatia Q da ADR implementou o modelo do período em
`platform/convex/lib/quotaPeriod.ts`:

- **Âncora.** `usagePlans.periodAnchor`, opcional, é o instante, em
  milissegundos truncados ao segundo, cujos aniversários mensais abrem os
  períodos. Sem âncora, ou num instante anterior a ela, o período é o mês
  civil UTC. Com ela, `quotaPeriod(plano, instante)` devolve o mês da âncora
  que contém o instante, de um aniversário ao seguinte, calculados por
  `addMonths` a partir da âncora original: 31/01 10:00 UTC dá 28/02 10:00 e
  depois 31/03 10:00.
- **Chave.** Um período que começa no dia 1 às 00:00:00.000 UTC tem a chave
  `AAAA-MM`, como as linhas atuais; qualquer outro, o instante exato de
  `toISOString()`, como `2026-11-15T14:30:00.000Z`. Só essas duas formas são
  aceitas, e a ordem alfabética das chaves é a cronológica. `stock`, a chave
  fixa do estoque em `capacityTotals` e `capacityEvents`, é a única exceção.
- **Reserva.** `reserveUsage` e `reserveCapacity` resolvem o período uma
  vez, pela linha de `usagePlans` lida na mesma transação, em vigor ou não.
  Confirmação, liberação e estorno usam o período gravado no evento. Vale
  para todas as unidades de `usageTotals` e para as de capacidade por período
  (leituras REST, downloads, exportações e bytes de exportação).
- **Quem tem âncora.** As linhas concedidas por um termo anual levam a
  âncora da cadeia do termo (`platformPlanTerms.anchor`, ou o início dele),
  truncada ao segundo. O anual pelo Pix começa na confirmação desde a fatia
  1b: confirmado em 13/10/2026 às 14:30:07, tem os períodos
  `2026-10-13T14:30:07.000Z`, `2026-11-13T14:30:07.000Z` e assim por
  diante, e a renovação mantém a âncora: numa cadeia de 29/02/2028, o termo
  renovado começa em 28/02/2029, porque fevereiro não tem dia 29, e o
  período seguinte começa em 29/03/2029, não em 28/03. O anual no cartão ainda
  começa no dia 1 às 00:00 UTC, então as chaves dele continuam `AAAA-MM`
  ([BILLING.md](BILLING.md#plano-anual)). As ativações mensais, pelo
  Pix ou pelo cartão, ainda não têm âncora e seguem no mês civil até as
  fatias 1c e 2a. O Gratuito nunca tem. O Personalizado segue
  [Plano e autorização](#plano-e-autorização). Uma linha que substitui outra
  não herda a âncora dela; os contadores já gravados ficam na chave antiga.

A retomada automática da captura parada por cota espera o fim do período de
cota do plano (`quotaPeriod`, em `captureProcessing.ts`): o próximo dia 1 no
mês civil, ou o aniversário seguinte da âncora. Retomar no console ou
atribuir um plano continua liberando na hora.

`usageEvents` conserva a chave idempotente, o ambiente e o estado reservado,
confirmado ou liberado. `usageTotals` agrega por organização, período, unidade e
ambiente na mesma transação do evento e da escrita do domínio. Não existe
contador global compartilhado entre clientes. A disputa pela última unidade de
uma organização é serializada pelo controle transacional do Convex, inclusive
quando há duas chaves de API.

Desde a #559, o total de cada ambiente é dividido em 8 faixas
(`USAGE_LANES`, campo `lane`; a linha sem `lane` é a faixa 0 e guarda os totais
anteriores). O saldo é a soma das faixas; `usage:overview` e a conferência de
cota somam todas. Cada evento grava a sua faixa, e confirmação, liberação e
estorno voltam a ela. Uma faixa pode guardar uma parcela do limite do plano
(`allowance`), válida só para o plano, a versão e o limite que a concederam
(`grant`). Uma reserva que cabe na parcela da sua faixa a consome e lê e grava
só essa faixa; assim, admissões simultâneas da mesma organização disputam
documentos diferentes. Quando a parcela não basta, a reserva lê todas as
faixas e o total não atribuído, recusa só se o consumo contado mais a
quantidade passar do limite e reparte o que sobra, até um oitavo do limite por
faixa. Em qualquer momento, o consumo contado mais as parcelas válidas não
passa do limite, então nenhuma faixa admite além dele. Um plano novo, outra
versão ou outro limite anula as parcelas anteriores. Unidades só medidas nunca
são recusadas e gastam primeiro as parcelas, para que nenhuma sobra admita
além do limite. A prova está em `tests/platform.usageLanes.test.ts`.

Os campos novos são opcionais, mas o schema anterior às faixas não os
declara: depois que um documento os grava, publicar o código anterior falha na
validação do schema. Para voltar atrás, defina `FNFE_USAGE_LANES=off` no
deployment e execute `usageMigration:foldLanes` com `{"cursor":null}`. Com as
faixas desligadas, toda gravação de total vai para a faixa 0 e não grava
`lane`, `allowance` nem `grant`; uma linha que ainda tenha parcela a perde, o
que só reduz o que está reservado, então a cota continua exata. O fold soma
cada faixa na faixa 0, remove as parcelas e, na segunda etapa
(`foldLaneEvents`), tira `lane` dos eventos. Ao terminar, nenhum documento tem
os campos novos e o tráfego seguinte não os grava, então o código anterior pode
ser publicado com o deployment em uso.

A liquidação (confirmação, liberação, estorno) tira as unidades da faixa do
evento; se essa faixa não as tiver todas, porque o fold as levou para a faixa 0
e as faixas foram religadas antes do fim de `foldLaneEvents`, tira o que ela
tem e o resto da faixa 0 e das outras, na ordem, lendo no máximo as 8 faixas do
total. O saldo é a soma das faixas, então a cota não muda com as faixas que
pagam, e nenhuma fica negativa. Como as unidades de todo evento vivo estão em
alguma das faixas do seu total, religar as faixas, mesmo no meio do fold, não
exige desfazer nada.

## Ambientes

O ambiente de uma unidade é o do registro que a gerou: o lote de importação,
a operação (captura, CNPJ, tentativas), o documento, a NFS-e ou o destino do
webhook. A função que reserva recebe esse ambiente do registro, nunca do
chamador. Confirmar, liberar e estornar seguem o ambiente gravado no evento.
Uma chave pertence a um registro de um só ambiente; reservar a mesma chave em
outro ambiente é recusado com `OPERATION_CONFLICT`.

Cada ambiente tem saldo próprio sob os mesmos números do plano. O limite de
`imports`, `captures`, `registry`, `bytes` e `deliveries` vale inteiro no
`sandbox` e inteiro em `production`. A exceção é a cota de notas
(`notes`), que só existe em Produção e, no plano que a tem, substitui ali
`imports` e `captures` ([Cota de notas do Gratuito](#cota-de-notas-do-gratuito)). Até a #429 os dois ambientes somavam
contra um limite só: um teste no sandbox podia esgotar a cota e pausar a
captura fiscal no site, e o inverso também. Agora o limite atingido num
ambiente não recusa nem pausa nada no outro. Em consequência, a organização
pode consumir, somando os dois ambientes, até o dobro de cada limite do plano.
Os números de cada plano não mudaram.

### Cota de notas do Gratuito

Em 29/10/2026, o dono decidiu que o Gratuito, em Produção, admite no máximo
100 notas novas por mês, somando importação e captura
([ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md), decisões 10
e 11). O limite fica em `limits.notes` do plano e, no catálogo, só o Gratuito
o tem. Os planos pagos e o Personalizado do catálogo não têm `notes` e
continuam com as unidades de antes. `usage:assignPlan` aceita `notes` e pode
atribuí-lo a um Personalizado, que passa a seguir a mesma regra.

- **O que é uma nota.** É a unidade Documento em Produção: um
  `fiscalDocuments` publicado pela primeira vez. Como o documento é único por
  organização, empresa, ambiente, modelo e chave, uma chave de acesso conta 1
  nota por empresa. Resumo, XML completo, eventos e reprocessamento da mesma
  chave voltam ao mesmo documento e à mesma chave de uso (o id do documento),
  então não somam. A mesma chave em duas empresas da organização conta 2.
  Uma NFS-e ABRASF importada antes da retirada contou pela sua chave, como
  uma NF-e. Um documento
  emitido pela plataforma (`issuances`) não conta na emissão; conta só se o
  mesmo XML for importado depois e o documento for publicado ali pela
  primeira vez, coerente com "somando importação e captura".
- **Quando conta.** Na publicação da primeira versão do documento, no mês UTC
  dessa publicação. A contagem é só medida: nunca recusa, então uma consulta ou
  importação já admitida entra inteira, mesmo que passe de 100.
- **Notas pendentes da importação.** A reserva de um lote vale 24 horas e o
  upload e a confirmação não reconferem a cota. Por isso, em Produção e num
  plano com `notes`, cada arquivo admitido reserva uma nota provisória na
  unidade Documento (chave `import:<arquivo>`, liberada e nunca confirmada).
  Ela sai quando o arquivo expira sem envio, quando o processamento publica as
  notas reais, na mesma transação, ou quando ele falha de vez sem publicar
  nada. Um arquivo recusado pelo parser não publica nota e devolve a
  provisória. Uma operação de processamento pausada ou cancelada conserva a
  provisória até o fim do mês dela, o que só reduz o saldo. Repetir a admissão
  com a mesma chave de idempotência devolve o lote existente e não reserva de
  novo.
- **O lote NFS-e ABRASF conferia as notas na leitura
  ([#649](https://github.com/freecorps/freecorpsNFE-arquivo/issues/649)).** Até a
  [retirada da importação ABRASF](IMPORTS.md#lotes-nfs-e-abrasf-retirados),
  em 02/11/2026, um lote reservava só a nota provisória, mas podia publicar
  até 20. Em Produção e num plano com `notes`, o processamento conferia a cota
  quando o lote era lido, contando só as NFS-e novas. Se elas passassem do
  limite, o lote falhava inteiro com `NOTES_QUOTA_EXCEEDED`, sem publicar
  nenhuma nota. Hoje a importação aceita só NF-e, que publica no máximo uma
  nota, e não emite mais esse código. Arquivos antigos ainda podem mostrá-lo.
- **O que recusa.** Uma nova consulta de captura ou um novo arquivo de
  importação em Produção é recusado com `QUOTA_EXCEEDED`
  (`metric: "documents"`) quando as notas publicadas e as pendentes do mês já
  somam 100 ou mais. Num lote, os arquivos reservam um a um: se os do lote
  passam do limite, o lote inteiro é recusado e nada fica reservado. A
  reconciliação de uma consulta já cobrada e o reenvio de uma admissão
  existente não passam pela cota. A captura pausada pela cota volta sozinha no
  mês seguinte, como na cota de consultas.
- **O que deixa de valer em Produção.** Com `notes`, os limites de `imports` e
  `captures` não recusam nada em Produção; os dois continuam medidos. Os
  limites técnicos ficam: o teto de 120 consultas por hora por empresa, os
  intervalos da SEFAZ, a reserva de 18 MiB por consulta, a cota de `bytes` e
  os orçamentos de admissão.
- **Sandbox.** A cota de teste continua: 100 arquivos importados e 100
  consultas de captura por mês. O que entra no Sandbox não conta nota.

A plataforma hospedada tem base Sandbox, e nela a Produção serve só a captura
das empresas liberadas (ADR 0007); a importação em Produção só existe num
deployment de base Produção. A regra vale nos dois casos, no núcleo de uso
(`reserveUsage` e `requireQuota`, em `platform/convex/lib/usageCore.ts`),
então REST, console e workers passam por ela.

A conferência tem um custo de concorrência, só em planos com `notes`: cada
nova admissão em Produção lê os totais de `documents` da organização no mês, e
cada publicação de documento grava um deles. Uma admissão e uma publicação
simultâneas da mesma organização podem então conflitar e uma delas ser
repetida pelo Convex. O saldo continua exato; o efeito é latência, não medida.

Em 27/10/2026, o mantenedor decidiu que a captura em Produção exige plano
atribuído, inclusive no plano gratuito, com cotas explícitas. Ausência de
plano, limite `null` de `bytes` ou limite `null` de `captures` num plano sem
`notes` impedem novas consultas.
Plano fora da vigência continua recusado; limite zero é uma cota explícita
que bloqueia o consumo. A decisão não exige plano para testar a captura no
Sandbox nem altera a política das outras unidades sem plano.

O [catálogo e suas hipóteses comerciais](PLATFORM-PLAN-PROPOSAL.md) define
Gratuito permanente, Intermediário de R$ 149/mês, Grande de R$ 499/mês e
Personalizado por orçamento. A política começa desligada. O console permite
ativar o Gratuito ou contratar um plano pago quando o operador habilita
admissões com inventário e orçamento da empresa. Desde 03/11/2026 a venda nova
é só pelo cartão ([cobrança](BILLING.md)); o pedido por Pix descrito abaixo só
vale com o [interruptor do Pix](BILLING.md#interruptor-do-pix) ligado, e
desligado ele responde `PIX_DISABLED`. Não há atribuição automática no cadastro.

O pedido pago mantém o plano atual e não reserva o orçamento global. O servidor
confere disponibilidade, preço integral do mês UTC e diferença de upgrade.
A equipe verifica novamente capacidade e caixa antes de instruir o Pix; a
confirmação interna confere referência, valor e versão e reserva os recursos
na mesma transação da ativação. Se o orçamento se esgotar, a ativação recusa;
pagamento recebido exige conciliação ou devolução pelo atendimento. Nenhuma
chamada pública confirma pagamento. Cancelar pedido não muda plano nem cotas.
A renovação é manual após vencimento, sem débito automático. Personalizado
usa `usage:assignPlan`, com cotas finitas e condições comerciais auditadas.

Cada ativação de plano de catálogo (`activateCatalogPlan`, em
`platform/convex/lib/planCore.ts`) copia para `usagePlans` as cotas e a
capacidade de `planCatalog.ts` daquele momento, e os limites de empresas,
membros e integrações leem essa cópia. Uma mudança no catálogo chega a uma
organização na ativação seguinte: o mês pago seguinte, por cartão ou Pix, ou
um upgrade. O mês já ativado mantém o que foi vendido. Por exemplo, um
Intermediário ativado com 3 empresas passa a 5 no mês seguinte. O Gratuito não
vence e não é reativado, então mantém a cópia até outra ativação. A ativação
que vem de um termo anual também grava `termId`. Quando um termo anual se
sobrepõe ao período do plano mensal, a ativação mensal é recusada com
`ANNUAL_TERM_ACTIVE`: Pix (`plans:requestPaid`, `plans:confirmPayment`) e
`plans:claimFree`; `usage:assignPlan` é recusado quando um termo cobre o
instante atual. O cartão mensal é recusado enquanto houver qualquer termo
em vigor, mesmo agendado para depois ([BILLING.md](BILLING.md#plano-anual)).

### Estoque e tráfego

`capacityEvents`, `capacityTotals`, `capacityFiles` e `capacityRecords` medem
estoque e transferências por organização, somando os dois ambientes. Arquivos
originais e lotes brutos usam `filesBytes`; partes de exportação usam estoque
separado `temporaryBytes`, limitado por `capacity.exportsBytes`. Downloads,
quantidade e volume exportados e leituras REST têm cotas mensais próprias.
Os PDFs do DANFE guardados como cache (`documentDanfes`, #402) não entram
em `filesBytes` nem em outro estoque da organização: são refeitos do original,
que já conta, e só o download conta em `downloadsBytes`.
`databaseBytes` mede os registros fiscais com `getDocumentSize`, incluindo os
campos de sistema. Não mede índices, réplicas, dados operacionais, auth ou o
banco físico faturado pelo Convex. Não vender essa medida como tamanho total
do banco.

A exportação assistida de uma organização arquivada (ADR 0009, §7) não entra
nesses totais: a Freecorps a paga (decisão 3 de 30/10/2026). Suas partes não
reservam `temporaryBytes` nem `exportsBytes`, e o download não conta em
`downloadsBytes`.

A admissão verifica estoques e reserva antes do transporte; captura mantém
18 MiB, emissão 18 MiB e cancelamento 16 MiB. Na importação, com a política de
capacidade ligada, o lote reserva `filesBytes` na admissão e é recusado ali
se o estoque não comporta. Com ela desligada, nada é recusado por estoque e a
admissão não grava estoque: o upload reserva a mesma chave antes de guardar o
primeiro byte (`importUpload.inspect`), e o estoque mede o arquivo desde ali.
Assim as admissões simultâneas de uma organização não regravam o mesmo total
de estoque (#559). Se a política for ligada com um lote já admitido e ainda
sem upload, o upload passa pela checagem completa de estoque e plano e pode ser
recusado; nenhum byte é guardado sem reserva, e a reserva de uso do lote é
liberada na expiração. A revisão de `capacityAccounts` só sobe enquanto a conta
não está pronta, que é quando uma recontagem precisa saber de gravações
concorrentes. Uma resposta fiscal admitida
permanece preservada mesmo após vencimento ou mudança do plano. Materialização
fiscal interrompida por limite mantém o original para reparação. Exportar
continua possível com o estoque original cheio, sujeito à reserva temporária
e às cotas de tráfego. Não há cobrança de excedente nem exclusão por atingir cota.

Contas com dados anteriores ou restaurados exigem `capacity:inventory`, em
páginas. O inventário reconcilia fontes, remove contabilidade órfã e reconta
reservas e estoque; gravações concorrentes reiniciam a recontagem. Enquanto
não terminar, `CAPACITY_INVENTORY_REQUIRED` recusa novas admissões. Plano e
inventário concluídos reavaliam capturas pausadas. Estoque não renova no mês.

O mapa de IDs de uma organização reidratada do arquivo econômico
(`coldArchiveIdMap`, ADR 0009, §6) conta em `databaseBytes`, como os registros
fiscais: cada entrada é gravada com a linha nova, em modo de inventário, e
entra em `capacity:inventory`.

A reidratação (ADR 0009, §5) só começa se o estoque couber no plano atual,
com plano pago ativo. O executor mede com `getDocumentSize` as linhas das seis
tabelas de documentos que voltam, já com o par de origem, e as entradas do
mapa; o servidor soma uma margem de segurança de **10%**
(`REHYDRATION_MARGIN`, em `lib/coldArchiveRehydration.ts`) e compara com
`databaseBytes` do plano, e os bytes de arquivos do manifesto com
`filesBytes`. Com a camada fria ligada (ADR 0010, decisão 5), só a janela
quente volta ao armazenamento de arquivos: `filesBytes` conta os arquivos que
voltam quentes mais o maior lote da etapa fria, e `databaseBytes` conta todas
as linhas, o resíduo de toda nota, mais o que cada nota fria ganha. Sem
caber, recusa antes de gravar com `QUOTA_EXCEEDED` e o menor plano do
catálogo que comporta. Admitida, a reidratação grava linhas, arquivos e mapa
em modo de inventário, sem falhar no meio por cota, e não conta consumo
mensal. A exceção é o arquivo adiado que precisa voltar quente porque a nota
deixou de poder passar no meio da etapa fria: cada envio confere o estoque e
para com `QUOTA_EXCEEDED` antes de passar do plano.

A restauração isolada de uma organização arquivada, base da exportação
assistida (ADR 0009, §7), não passa por essa admissão. Ela não grava na
origem, não conta estoque nem consumo e não exige plano ativo. Seu custo, uma
execução num Convex descartável, fica fora do aporte.

Os orçamentos globais reservam a capacidade integral dos planos, inclusive
exportações temporárias e aporte da empresa. Cada proprietário pode obter
uma organização gratuita; empresas, membros e integrações têm limites. O
projeto interno do console não consome uma vaga de integração.

O [arquivo econômico](../operacao/arquivo-economico.md) tem gate próprio.
O ensaio real provou restauração isolada, mas o Convex recusa recriar na origem
os IDs já apagados. Por isso, organizações abertas conservam registros e
arquivos quentes; a remoção desse fluxo está bloqueada. Não há reativação
assistida comprovada nem economia fria para contas abertas inativas.
Encerramento e guarda fiscal continuam regidos por [RETENTION.md](RETENTION.md).
Com a organização em custódia fria, as leituras REST não fiscais
(`GET /v1/companies`, `GET /v1/companies/{id}`, `GET /v1/capabilities` e
`GET /v1/webhook-endpoints`) continuam cobradas em `restReads`, sem a recusa do
arquivo; qualquer outro `GET` responde `ORGANIZATION_ARCHIVED` antes da cobrança
(`usage.chargeRestRead`).
A leitura de documentos e emissões pelo console não consome cota, mas conta
como atividade do Gratuito para o arquivo econômico: o console grava no máximo
uma marca por organização a cada dia (`archiveNotice.markFiscalRead`, #641).

Um plano sem vencimento usa `endsAt: null`. Ele começa em `startsAt` e
continua sujeito às cotas mensais, sem expirar depois de um período de teste.
O saldo não utilizado não acumula. Ao atingir uma cota, novas operações
daquela unidade são recusadas e podem ser reenviadas no próximo período de
cota ou após a atribuição de um plano com mais capacidade. A captura volta a conferir
a cota no próximo período. O histórico e os
documentos guardados continuam disponíveis, sem cobrança automática de
excedentes ou obrigação de migrar para o pago.

Continuam por organização, sem separação por ambiente, a vigência do plano,
a concorrência dos leases (`usageLeases`), os orçamentos técnicos de
admissão (`usage-organization`, `usage-key`) e a proteção das requisições
REST. Um plano fora da vigência bloqueia os dois ambientes.

A recusa de cota leva `{ code: "QUOTA_EXCEEDED", metric, environment, period }`
nos dados internos. O REST conserva o código público `RATE_LIMITED` e a mesma
mensagem; a chave já define o ambiente da requisição.

### Registros anteriores à separação

Eventos e totais gravados antes da #429 não têm ambiente. Enquanto não forem
atribuídos, um total sem ambiente conta contra os dois ambientes, como
contava antes. A atribuição nunca concede a nenhum ambiente uma unidade que o
saldo compartilhado já tinha gasto. A tela Uso e limites avisa quando o
período ainda tem consumo sem ambiente e o mostra nos dois.

A mutation interna `usageMigration:backfillEnvironment` atribui cada evento
antigo ao ambiente do registro que a sua chave nomeia: o arquivo de
importação, a operação, o documento, a entrega de webhook ou a NFS-e. Na mesma
transação, ela move as unidades do evento do total sem ambiente para o total
do ambiente e conserva o início mais antigo. Esses registros têm ambiente e só
saem no encerramento da organização, então a atribuição é a do fato
registrado. Uma chave cujo registro não existe mais vai para `production`:
contar ali só pode pausar a captura fiscal mais cedo, nunca liberar uma
consulta real a mais. Eventos liberados recebem o ambiente sem mover saldo.

Depois de todos os eventos, `usageMigration:backfillTotals` apaga os totais
sem ambiente que ficaram zerados, porque suas unidades e seu início já foram
para os totais por ambiente. Um total sem ambiente que ainda tenha unidades
indicaria um total sem eventos; ele fica como está, conta nos dois ambientes
e aparece em `unresolved` para investigação. Nenhum evento é apagado.

Para ativar, publique as funções no deployment conferido conforme
[deploy-producao.md](../operacao/deploy-producao.md) e execute
`usageMigration:backfillEnvironment` com `{"cursor":null}` nesse mesmo alvo.
Repita em cada deployment existente com dados. O hospedado é nomeado no
procedimento de publicação; o da produção fiscal da NFS-e ainda está ausente,
com `deployment: null` em `deploy/issuance-production.json`, e não tem etapa
remota a executar enquanto não for criado. A rotina percorre 100 eventos por página, agenda a próxima página e,
ao fim, a etapa dos totais. Cada página registra no log uma linha
`usage_environment_backfill` com `stage`, `scanned`, `attributed`,
`unresolved` e `isDone`. Ela pode ser repetida e pode correr junto do
tráfego: evento já atribuído é pulado, e eventos novos já nascem com
ambiente. A rotina usa agendamento explícito e não depende de crons.

Confira o término da etapa `totals` com `isDone: true` e a soma de
`unresolved`. Só depois de todos os deployments concluídos o campo
`environment` passa a ser obrigatório e o total sem ambiente deixa de ser
lido, numa entrega posterior. Nessa entrega também sai `rows` de
`usage:overview`, o total somado que o console anterior à #429 ainda lê
durante a publicação.

#### Recibo sanitizado

Depois de publicar as queries `usageMigration:eventStatus` e
`usageMigration:totalStatus`, `bun run usage:migration:status` percorre suas
páginas e gera contagens e unidades por métrica, ambiente e estado. Não
devolve organizações, chaves de uso nem documentos. Exige o nome do deployment;
não publica código nem executa a migração. O comando usa o login da CLI do
Convex, sem imprimir credenciais.

No alvo conferido pelo procedimento de publicação, guarde o recibo antes e
depois do backfill autorizado. Exemplo de leitura, com arquivos fora do Git:

```powershell
$usageTarget = 'elated-possum-295'
$usageBefore = Join-Path $env:TEMP 'usage-429-before.json'
$usageAfter = Join-Path $env:TEMP 'usage-429-after.json'
bun run usage:migration:status --deployment $usageTarget --out $usageBefore
# Entre as leituras, executar o backfill autorizado e aguardar a etapa totals.
bun run usage:migration:status --deployment $usageTarget --out $usageAfter --compare $usageBefore
```

O script recusa sobrescrever arquivos. `localCheckout.commit` identifica quem
fez a coleta, não a revisão publicada: registre separadamente o `sha` de
`/health` do alvo. `observedZeroLegacy` indica ausência de eventos e totais
sem ambiente na leitura. `comparison.observedEqual` compara contagem de eventos
e unidades por métrica, somando os ambientes; os totais zerados apagados não
precisam manter a quantidade de linhas. Resíduos não zerados exigem investigação.

As páginas são transações distintas. Igualdade agregada não prova isolamento
por organização nem uma fotografia transacional, e diferenças podem vir de
tráfego entre as leituras. Para concluir conservação, registre uma janela sem
tráfego, encerramento de organizações ou backfill durante cada coleta, e sem
outros produtores de consumo entre elas. Sem essa condição, o recibo registra
somente o observado; não encerra sozinho a pendência operacional.

A leitura hospedada de 27/10/2026
encontrou legado ainda sem ambiente. Não houve execução de backfill nessa
leitura nem publicação das queries novas. O
backfill do mesmo dia,
já com as queries publicadas, terminou sem legado e com a soma observada igual
nesse deployment. A validação `modest-seal-118` foi migrada em 28/10.

## Admissão e recuperação

A importação reserva arquivos e bytes antes de emitir tickets. Cancelamento
ou expiração do upload libera a reserva. O console cancela só lotes criados
no console; a reserva de uma integração é liberada pela expiração do upload
(`tests/platform.usage.test.ts`). Confirmar novamente não aumenta uso.
O REST repete a mutation de admissão no máximo uma vez após erro técnico,
conservando chave e corpo. A transação pode ter concluído antes da perda da
resposta; nesse caso devolve a reserva existente. Erros de domínio não são
repetidos. Upload, confirmação, reprocessamento e transporte fiscal não usam
essa política. O ensaio hospedado identificou conflitos esgotados no rate
limiter sob rajadas; a repetição reduz a exposição ao erro, mas não amplia
cota nem comprova a meta de latência.
Uploads admitidos podem concluir depois do fim da vigência; novas intenções e
reprocessamentos exigem plano vigente quando existe plano atribuído.

Cada consulta de captura reserva 18 MiB antes de IO: 2 MiB de resposta bruta
e 16 MiB de envelopes expandidos, limites do conector. Ao persistir o lote,
confirma somente os bytes efetivos e libera a diferença. Assim, saldo inferior
a 18 MiB impede nova consulta mesmo se a próxima resposta pudesse ser pequena.
Resultado externo incerto conserva a reserva até reconciliação. Não libere
essa reserva por timeout nem avance o NSU sem persistência.
A reserva sai do saldo de `bytes` do ambiente da captura, que no site é
`production`. Importações e capturas do sandbox não consomem mais a margem de
18 MiB de que a captura fiscal precisa para a próxima consulta. Nos lotes
sintéticos dos testes, o que fica confirmado vai de 298 bytes (resposta 137,
sem documentos) a 376.531 bytes (50 NF-e completas de
`tests/fixtures/nfe/4.00/invoice-authorized.xml`), 0,002% a 2% da reserva.
A revisão técnica da #429 recomenda manter a reserva, que corresponde ao
teto aceito pelo conector. A [proposta comercial](PLATFORM-PLAN-PROPOSAL.md#limites-técnicos-propostos-para-manutenção)
explica o efeito no saldo e mantém o teto técnico de 120 consultas autorizadas
por empresa em qualquer hora. Esses limites não aumentam com o preço do plano.

O componente `@convex-dev/rate-limiter` existente aplica 120 admissões/minuto
por organização e 60 por chave, além dos limites específicos de cada domínio.
Os orçamentos REST e de uso dividem o saldo em oito partições, sem renovar
a cota na transição. A recusa consulta todo o saldo disponível e não consome
o outro orçamento. A reposição dividida pode ser mais conservadora sob consumo
desigual; os tetos totais permanecem os mesmos. A migração e as restrições
de rollback estão descritas em [patches/README.md](../../patches/README.md).
Desde a #559, uma chamada pode indicar a partição a ler primeiro
(`partitionLane`): todos os orçamentos cobrados juntos começam por ela, e uma
partição curta continua buscando saldo nas outras, então a escolha não muda
saldo nem recusa. A admissão de importação sorteia uma única faixa
(`pickLane`) e a usa nos totais de uso e nos três orçamentos de
`rateUsage`; a proteção REST faz o mesmo com os seus dois. Duas admissões
simultâneas da mesma organização só disputam documentos quando sorteiam a
mesma faixa, 1 em 8, em vez de sempre que qualquer das faixas sorteadas
independentemente coincide.
Importações conservam o limite específico de 20 admissões/minuto por organização.
Esse orçamento mantém sua janela fixa e participa do mesmo consumo atômico
dos limites de uso, inclusive quando a entrada é o console.
O CNPJ conserva 30 chamadas/minuto por provedor. A captura conserva o cooldown
da identidade fiscal, que não pode ser encurtado pelo plano ou retry manual.
Workpool mantém os limites de cada fila. Leases limitam adicionalmente a
concorrência de execução por organização, de 1 a 32, padrão 8 sem plano.
Saturação adia o claim sem consumir tentativa técnica; a recuperação mantém
os fences e regras de reconciliação existentes.

A admissão de importações agrupa pedidos de limpeza de storage em janelas
de um minuto, evitando regravar o mesmo registro global a cada pedido.
O arredondamento só amplia a cobertura do scanner; o prazo mínimo para
excluir um upload órfão e a janela paginada de varredura são preservados.

Cota ou vigência bloqueia novas admissões, sem apagar documentos ou impedir
leitura/download/exportação permitidos pelo escopo. Webhooks já criados
permanecem na outbox; os ainda não admitidos ficam pausados e podem ser
reenviados após revisão do plano. Os retries da entrega já admitida mantêm
a identidade comercial. CNPJ e captura mostram a operação pausada e seu motivo.

No REST, cota usa HTTP 429/`RATE_LIMITED`; vigência usa HTTP 403/`SCOPE_DENIED`.
A mensagem identifica o plano e `retryable` é `false`. Não tratar todo 429 como
retry automático. Limites técnicos mantêm o comportamento anterior. O console
usa os códigos internos `QUOTA_EXCEEDED`, `PLAN_INACTIVE` e `PLAN_REQUIRED`
para a orientação. `PLAN_REQUIRED` indica falta de plano com cotas de captura
e bytes para Produção; pedir o plano à Freecorps é a ação disponível.

A tela Uso e limites é só de proprietários e administradores, então a
orientação depende do papel (`apps/console/src/usage-errors.tsx`):
`usageErrorMessage(error, "manager")` e `UsageErrorNotice` levam o gestor à
tela, com link; para os demais papéis, a mensagem pede para falar com um
gestor da organização. Sem o papel, `usageMessages` usa um texto neutro que
serve aos dois públicos. As métricas da tela têm descrição em linguagem de
usuário e o critério técnico de contagem em "Critério técnico".
A tela mostra o consumo do ambiente escolhido no seletor da lateral, com o
saldo próprio contra os mesmos limites do plano, dito na abertura. Com limite
atingido no outro ambiente, um aviso diz isso e aponta o seletor. Num plano
com `notes`, Produção diz que
importações e consultas contam pelas notas novas, mostra a unidade Documento
como "Notas novas", com o limite e a barra, e põe "na cota de notas" no lugar
do limite de arquivos importados e de capturas. Na comparação de planos, o
Gratuito lista as notas novas em Produção e, à parte, as cotas de teste do
Sandbox. Na captura, o painel de Produção desse plano diz que cada nota nova
recebida conta no limite, não cada consulta (`captures.get`, `countsNotes`), e,
quando a pausa veio dela, que a organização chegou ao limite de notas novas do
mês (`notesQuota`, também no Início). Os dois campos chegam a quem lê a
captura, não só aos gestores. A recusa de uma importação pela cota de notas
traz `metric: "documents"` e `limit`, e o console diz "A organização chegou ao
limite de 100 notas novas do mês em Produção." antes da orientação pelo papel.
Em "Critério técnico", a unidade explica que os reservados são arquivos de
importação aguardando processamento.

Em cada unidade, o número grande, a barra e o percentual contam o mesmo que a
cota: confirmados mais reservados. A linha abaixo separa as duas partes
("4 confirmados e 1 reservado") ou diz "Nada reservado". O percentual é
arredondado para baixo, então "100% usado" só aparece com o limite atingido,
e a barra fica vazia em 0%. O volume aparece em unidades binárias com uma
casa decimal ("9,6 KiB de 1 MiB"), calculado com inteiros
(`apps/console/src/usage-format.ts`); o número exato de bytes fica em
"Critério técnico". `usage:overview` devolve `environments.sandbox`,
`environments.production` e `unattributed`, e mantém `rows`, a soma dos
ambientes, para o console publicado antes da #429.

O console não calcula a chave do período. `usage:overview` recebe `period`,
uma chave canônica, ou `asOf`, um instante em milissegundos, e exige ao menos
um deles, porque a query não lê o relógio. Sem `period`, o servidor usa o
período de cota do plano que contém `asOf`. A resposta traz `period`, com
`key`, `startsAt` e `endsAt`, e `recent`, até 12 períodos do mais novo ao mais
antigo: os que têm consumo gravado, o que contém `asOf` e o pedido. `endsAt` é
`null` numa chave ancorada cuja âncora o plano atual não guarda mais, como a
de uma linha substituída. Uma chave fora das duas formas canônicas, ou um
`asOf` que não é instante até o fim de 9999, responde `INVALID_REQUEST`. A
resposta traz também `current`, o período que contém `asOf`, ou `null` sem
ele. A tela pede `asOf` na hora cheia, a mesma do pré-carregamento da rota, e
o adianta quando um instante entre ele e o relógio muda o período: o fim do
período corrente, ou a âncora ou o início do plano. Um período anterior é
pedido pela chave listada em `recent`, e escolher o `current` volta a seguir
o período corrente. Diferente do campo de mês de antes, a lista só alcança
esses 12 períodos; um mais antigo continua acessível pela chave, chamando a
função diretamente.

## Proteção das requisições REST

O wrapper das rotas `/v1/*` autenticadas por API key admite até 60 requisições
por chave e 120 por organização, compartilhadas entre projetos e rotas.
Usa o componente `@convex-dev/rate-limiter` com token buckets de capacidade
60/120 e reposição contínua de 60/120 tokens por minuto. Os dois saldos são
conferidos e debitados na mesma mutation. Uma recusa por chave não consome o
saldo da organização. A mutation termina antes da validação do corpo,
consulta de domínio, leitura de storage e telemetria por chamada; falhas
posteriores de parâmetros, escopo ou domínio não devolvem os tokens.

Se a chamada direta do limitador terminar com o erro conhecido de conflito
OCC esgotado em `rateLimits`, o wrapper tenta uma vez adicional, após 25–74 ms.
Esse erro indica uma transação abortada, conforme a
[documentação do Convex](https://docs.convex.dev/error/#write-conflict-optimistic-concurrency-control).
A regra aceita somente a mensagem de sistema conhecida e exclui `ConvexError`;
se o formato mudar, a falha continua sendo propagada. Timeout, transporte,
erro desconhecido e recusa de cota não são repetidos. Assim, a nova tentativa
não trata uma resposta perdida após consumo como se o orçamento estivesse intacto.

Esse orçamento é independente de `usage-*`, das cotas e da vigência do plano.
Ler e exportar continuam permitidos após o vencimento, sujeitos ao escopo e
ao limite técnico. A admissão não substitui as verificações de autorização
do domínio. Rotação de chave não reinicia o saldo da organização.

Saturação retorna HTTP 429/`RATE_LIMITED`, `retryable: true`, `Retry-After`
em segundos inteiros arredondados para cima, `X-Request-Id` e
`Cache-Control: no-store`. O prazo indica quando haverá saldo se nenhuma outra
requisição o consumir antes. A resposta conserva o envelope de erro do REST.
Não há recibo, auditoria ou log HTTP por recusa. O diagnóstico
`http.rateLimited` é amostrado a no máximo um evento por organização por
minuto, com reposição contínua, e segue a retenção HTTP de 30 dias.
Esse evento não é um contador exato de recusas.

A proteção inclui listagens, detalhes, referências, operações, leitura de
artefatos e endpoints de escrita. Downloads por ticket usam o orçamento da
chave que criou a exportação ou do membro que solicitou o ticket, também
compartilhado por organização. Emitir outro ticket não cria outro orçamento.
A autorização é revalidada pelo download antes e depois de carregar o arquivo.
Uploads conservam o fluxo de ticket e limites próprios; `OPTIONS` e `/health`
não consomem esse orçamento. Headers Bearer acrescentados a transferências
por ticket não criam uma segunda auditoria de API key.

## Plano e autorização

`usage:assignPlan` é mutation **interna**, destinada ao administrador do
deployment. Com a política comercial ligada, aceita apenas Personalizado,
com cotas e capacidade finitas, preço, custos base/estresse, aporte e referência
de pagamento. Recusa organização encerrada e, do congelamento à remoção e
durante a reidratação, responde `ORGANIZATION_ARCHIVING`; uma organização já
arquivada recebe plano ([ADR 0009, §2](../adr/0009-custodia-fria-de-organizacoes-abertas.md#2-a-organização-continua-aberta)). Os planos de catálogo
usam `plans:claimFree` ou confirmação administrativa de `plans:requestPaid`;
o membro não escolhe os números das cotas nem confirma o próprio pagamento.
Com a política desligada, a atribuição assistida anterior continua disponível.
Recebe organização, nome, `startsAt`, `endsAt`, limites de
`imports/captures/registry/bytes/deliveries` e, opcionalmente, `notes`,
concorrência, `expectedVersion`,
referência do operador e motivo. Na atribuição anterior, `null` significa sem cota; zero bloqueia
novas unidades. Cada limite vale separadamente em cada ambiente
([Ambientes](#ambientes)). `startsAt` é epoch em milissegundos. `endsAt` pode
ser epoch em milissegundos, com fim exclusivo, ou `null`, sem vencimento.
Não use uma data distante para simular a ausência de vencimento. O valor
`null` de uma cota significa ausência de limite; o `null` de `endsAt`
significa ausência de prazo e não remove nenhuma cota.

`periodAnchor` é opcional e segue a
[ADR 0012](../adr/0012-periodo-por-aniversario.md#4-modelo-do-período-de-cota):
um instante em milissegundos, no segundo inteiro, até `startsAt`; senão, a
atribuição responde `INVALID_REQUEST`. Uma linha do Gratuito
(`catalogTier: "free"`) não aceita âncora.

- **Política desligada.** Sem `periodAnchor`, a linha não tem âncora e conta
  pelo mês civil UTC. O operador pode passar uma.
- **Política ligada.** O Personalizado sempre tem âncora: a passada ou, por
  padrão, `startsAt` truncado ao segundo. `endsAt` precisa ser o aniversário
  da âncora que fecha o mês da âncora em andamento, um mês pago por vez. Essa
  regra substitui a recusa de um `endsAt` depois do próximo dia 1. Para
  manter o mês civil, passe a âncora no dia 1 à meia-noite UTC; `endsAt` é
  então o dia 1 seguinte.

A linha nova nunca herda a âncora da linha que substitui.

A operação compara a versão, valida inteiros e grava antes/depois em
`usagePlanAudit`. Alterar plano não zera uso nem desfaz trabalho admitido.
O limite mostrado é o do plano atual, inclusive ao consultar meses anteriores.
Owner/admin consultam os totais organizacionais; papéis com acesso restrito a
empresas não podem inferir atividade de outras empresas pelos totais.

Para operar, identifique o alvo seguindo `docs/operacao/deploy-producao.md` e o runbook da
plataforma antes de chamar a mutation. Conserve o recibo sanitizado de alteração
e informe a versão retornada na próxima mudança. Não publique credencial
administrativa, XML, CPF/CNPJ ou dados de tomadores no motivo.

A ampliação de `endsAt` para aceitar `null` conserva os planos existentes
com datas; não os converte automaticamente. Publique o backend e o console
que reconhecem o valor antes de atribuir o primeiro plano sem vencimento.
Uma aba antiga do console pode interpretar `null` como data zero; peça a
reabertura da tela após a atualização. Um rollback para o schema anterior
não aceita os planos com `null`: não faça esse rollback sem uma migração
explicitamente planejada, nem imponha um vencimento aos planos gratuitos
para contornar a incompatibilidade.

## Retenção

Limite ou vencimento de plano não dispara expurgo. Originais seguem a política
documental; cache CNPJ conserva o expurgo próprio. Eventos de uso e alterações
de plano guardam apenas identificadores internos, unidades, datas e motivo
administrativo. Na 1.0 ficam retidos para reconciliação/auditoria, sem TTL que
permita cobrar novamente uma intenção antiga. Tentativas detalhadas permanecem
no histórico operacional existente. Qualquer redução dessa retenção exige
migração que preserve as chaves idempotentes e os totais; não é tarefa de um
job automático de vencimento comercial. A exceção é o encerramento da
organização: depois dele, uso, totais, planos, recibos e idempotência seguem
a [guarda após o encerramento](RETENTION.md#guarda-implementada-d01) e saem
juntos ao fim dela, quando nenhuma nova intenção pode mais chegar.

`apiUsageEvents` é uma classe diferente: recibos de consultas de empresas que
retornaram sucesso, sem relação com a idempotência comercial de `usageEvents`.
Cada recibo fica até 00:00 UTC do dia de criação mais 31 dias, conservando
30 dias completos após o dia da chamada. O TTL resulta do campo `day` e do
índice existente `by_organizationId_and_day_and_shard`, inclusive em registros
antigos que não possuem `expiresAt`.

`telemetryRetention:sweep` agrega até 50 recibos vencidos por transação e os
apaga na mesma transação. `apiUsageTotals` conserva contagem acumulada e
primeira/última data por organização, projeto, ambiente e rota. Reexecutar o
lote não duplica os totais. O total histórico é a soma do agregado com os
recibos ainda detalhados; não somar novamente os recibos já apagados.
O agregado não tem TTL nem dimensões de dia ou chave: há no máximo quatro
registros por projeto para as duas rotas e os dois ambientes atuais.
Não há novo endpoint público para esses totais.

O detalhe cresce com o tráfego admitido durante a janela, não com todas as
tentativas. No teto sustentado de 120/min por organização, o limite conservador
para 31 dias é 5.356.920 recibos, incluindo a rajada inicial, mais eventual
atraso do expurgo. Isso é um limite de cardinalidade, não uma medição de custo
ou uma aprovação de capacidade. Após um lote, a limpeza continua em outra
transação com intervalo mínimo de um segundo. Sem recibos ou outras classes
de telemetria pendentes, não mantém job recorrente.

### Ativação para os recibos existentes

Após publicar no deployment conferido conforme [deploy-producao.md](../operacao/deploy-producao.md), execute
a mutation interna `telemetryRetention:backfillApiUsage` com `{"cursor":null}`
nesse mesmo alvo. Ela percorre até 100 recibos por página, agenda a próxima
página e arma a limpeza de cada organização, inclusive sem tráfego futuro.
Pode ser repetida; não regrava recibos nem altera totais. Novos recibos já
armam a limpeza ao serem inseridos. A rotina usa agendamento explícito e não
depende de crons habilitados.

Confira no deployment o término das páginas, os agendamentos de
`telemetryRetention:sweep`, a ausência de recibos vencidos após drenar os
lotes e a conservação de `apiUsageTotals.count + quantidade de detalhes` por
organização/projeto/ambiente/rota. Se o expurgo atrasar, investigue falhas do
scheduler e reprocesse o backfill; não apague recibos manualmente. Essa ativação
e o ensaio hospedado de carga permanecem etapas operacionais de publicação.
Histórico fiscal, `usageEvents`, `usageTotals`, planos e outbox não participam
dessa compactação.

## Provas

A rodada hospedada de 05/10/2026
acompanha a republicação da validação e a contenção na admissão REST.
Uma chamada ao componente confere e consome os dois orçamentos REST na mesma
transação. O patch `rateLimitMany` reutiliza os contadores existentes e também
atende os limites de uso por organização/chave. Recusa continua sem consumir
qualquer orçamento, e os limites não mudam.

A admissão da importação reserva arquivos e bytes em paralelo por arquivo,
pois são métricas distintas; arquivos do mesmo lote continuam sequenciais.
O limite técnico é consumido ao final da mesma mutation, para reduzir a
janela de conflito dos contadores. Se recusar, a transação inteira desfaz
lote, arquivos, reservas e agendamentos. Uma cota comercial insuficiente
pode ser recusada antes do limite técnico; nenhum dos orçamentos é ampliado.

Para o piloto privado, o mantenedor selecionou p95 de até 1.200 ms nas leituras
e 2.500 ms nas admissões, com 20 clientes concentrados em duas organizações,
três rodadas e somente respostas 200. A prova de 100 mil metadados e suas
reprovações anteriores estão no recibo de 05/10. Os 800 ms/1 s continuam alvos
de otimização; nenhum desses critérios constitui SLA público. O
aceite da carga privada foi consolidado
em 06/10, sem nova execução. Retenção e decisões operacionais seguem nas
issues das entregas, conforme a ADR 0011. Em 06/10, os prazos foram aprovados para implementação e o mantenedor
assumiu operação e fiscal/privacidade; aplicação e aceite
público final continuam pendentes. A retenção dos
contadores e do layout de partições está em [RETENTION.md](RETENTION.md).

`tests/platform.usage.test.ts` cobre cotas, reversão, expiração, vigência,
auditoria, separação entre organizações, permissões e leases. Da #429, cobre
saldos separados por ambiente pelo REST e pelo núcleo, a conservação do ambiente
do evento, o total sem ambiente contado nos dois, a atribuição dos registros
antigos e sua repetição sem efeito, a leitura por papel e por organização.
`tests/platform.quotaPeriod.test.ts` prova o [período de cota](#período-de-cota):
as chaves canônicas e a recusa das outras escritas, `quotaPeriod` nas viradas
ao milissegundo, no dia 31 e no 29/02, o plano ancorado que vira no
aniversário com a liquidação no período da reserva, o Gratuito no mês civil,
a capacidade no período ancorado e o estoque em `stock`, a âncora das linhas
dos termos anuais, as regras de `usage:assignPlan` com a política ligada e
desligada e `usage:overview` com e sem `period` e `asOf`.
`tests/platform.siteCapture.test.ts` prova que a captura de um plano ancorado,
parada pela cota, retoma no aniversário da âncora, e que a cota esgotada no sandbox não
pausa a captura em produção e que a esgotada em produção não bloqueia o sandbox.
Na cota de notas do Gratuito, prova que a consulta sai com 99 notas, pausa com
100 e volta no mês seguinte, e que uma consulta admitida com 99 notas entra
inteira, com resumo, XML completo e evento da mesma chave contando uma nota.
A conclusão do processamento entregue de novo não conta nota, e `captures.get`
devolve `countsNotes` e, só quando as notas do mês da pausa chegaram ao
limite, `notesQuota`; o Início (`consoleHome.summary`) devolve `notesQuota` no
item `capture-attention`. Uma pausa do Gratuito por `bytes` não leva `notesQuota`.
`tests/platform.freeNotes.test.ts` prova o mesmo na importação em Produção,
além da mesma chave em duas empresas, do reenvio e do reprocessamento sem nova
nota, das notas pendentes (reservas sem envio
recusadas ao passar de 100, lote recusado inteiro, vaga devolvida na expiração,
no parser e na falha definitiva), do código `QUOTA_EXCEEDED` com
`metric: "documents"`, do Sandbox fora da conta, dos planos pagos sem `notes`,
do isolamento entre organizações e da virada do mês UTC.
Também cobre ausência de plano, cotas não definidas, vigência, isolamento de
organizações, pausa e retomada por atribuição, reconciliação sem nova cobrança
e recusa antes do envio quando o plano muda depois da reserva.
`tests/platform.usageMigration.test.ts` cobre várias páginas, repetição,
resíduos, tráfego durante o backfill e o limite da leitura sem snapshot.
`scripts/usage-migration-status.test.ts` confere seleção explícita do alvo,
agregação sem arredondamento e saída sanitizada, inclusive nos erros.
A jornada `imports.mjs --usage` grava, pelas mutations locais
`testing/usageProof:record` e `testing/usageProof:legacy`, consumo de produção e
um uso antigo sem ambiente; confere as duas abas, o aviso de atribuição e o seu
fim depois de `usageMigration:backfillEnvironment`, e fotografa cada estado em
1440 e 390 px com axe. Na mesma jornada, o painel reserva dois XMLs, segura o
envio do primeiro e cancela: o segundo nunca é enviado, o aviso conta os dois
cancelamentos e recebe o foco, e a cota é liberada (#506). O estado com o envio
em curso passa pelo axe inteiro, área de envio incluída, em 1440 e 390 px e nos
temas Claro e Escuro: a área indisponível troca a borda tracejada por uma
contínua e diz "Aguarde o fim do envio." com o texto em contraste pleno (#526).
A jornada nativa usa
`node --experimental-strip-types apps/console/e2e/imports.mjs --usage`. Massa,
latências, versão, recursos e limitações ficam em `docs/v1.0/evidence/79`. Metas
de p95 são critérios de ensaio, não SLA comercial. O ensaio hospedado de
30/09/2026 mede 10 mil e 100 mil metadados,
identifica contenção e compara a candidata. Mantém as metas de 800 ms para
leitura e 1 s para admissão; o baseline não recebeu aceite.

`tests/platform.keys.test.ts` reproduz as 130 chamadas da #126: 60 sucessos,
70 recusas, 60 recibos e 61 registros HTTP, sendo um diagnóstico amostrado.
Cobre chamadas concorrentes no `convex-test`, orçamento compartilhado entre
projetos, isolamento de organizações, reposição, erros, revogação, plano
vencido e compactação de recibos antigos em lotes. As suítes de documentos e
exportações verificam tickets e recusa antes do storage. Essas provas locais
não medem contenção, latência ou custo do deployment hospedado. A carga
hospedada tem aceite próprio no perfil privado acima; o perfil com plano e
leituras concorrentes foi aceito em 29/10 na #79
(parecer).
A aplicação das decisões operacionais de retenção segue as issues das
entregas, incluindo #80, #178 e #692, conforme a
[ADR 0011](../adr/0011-entregas-graduais.md).
