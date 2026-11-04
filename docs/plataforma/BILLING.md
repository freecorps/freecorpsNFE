# Cobrança das assinaturas

A Freecorps cobra os planos pagos da plataforma por cartão, pelo Stripe, ou por
Pix assistido. As duas formas seguem as mesmas regras comerciais da
[proposta de planos](PLATFORM-PLAN-PROPOSAL.md): primeira mensalidade
integral, upgrade pela diferença integral, downgrade e cancelamento na
renovação. O mensal corre de aniversário a aniversário da contratação: pelo
Pix desde a fatia 1c da [ADR 0012](../adr/0012-periodo-por-aniversario.md)
([Mensal por Pix](#mensal-por-pix)) e no cartão desde a fatia 2a
([Contratação e ciclo](#contratação-e-ciclo)). O anual no cartão é cobrado e
começa na contratação desde a fatia 2b ([Checkout anual](#checkout-anual)).
Uma organização paga por uma
forma de cada vez. A decisão é de 27/10/2026 (#556), e as políticas de
inadimplência, reembolso e contestação foram decididas pelo mantenedor em
28/10/2026. Das políticas mensais da #556, a ADR 0012 substituiu o mês civil
UTC, a renovação no dia 1 e o item avulso com a mensalidade do mês corrente
seguido do preço ancorado no dia 1; continuam a primeira mensalidade
integral, o upgrade pela diferença integral e o downgrade e o cancelamento
na renovação.

**Por enquanto, só o cartão.** Em 03/11/2026 o mantenedor decidiu não aceitar
Pix: a venda nova é só pelo Stripe. O Pix assistido continua no código, atrás
do [interruptor do Pix](#interruptor-do-pix), desligado.

**O catálogo continua desligado.** A cobrança por cartão existe no código e nos
testes, mas toda contratação passa por `requirePlanAdmissions`: sem
`platformPlanSettings.enabled` e janela de admissão aberta, nada é vendido.
Mensal e anual foram exercitados numa conta Stripe de teste, conforme a
matriz de assinaturas, ainda com a renovação no dia 1; a matriz precisa ser
refeita para o período por aniversário, com relógios de teste
([Prova do mensal](#prova-do-mensal-no-stripe-de-teste-668)).
Não houve cobrança real nem configuração de cobrança no deployment.
A viabilidade dos planos foi aprovada com o fechamento da #34, em 03/11/2026.
Ligar a oferta continua sujeito aos termos e às provas da modalidade na issue
da entrega, conforme a [ADR 0011](../adr/0011-entregas-graduais.md): a prova
hospedada e a ativação do anual ficam na #35
([Prova hospedada e ativação do anual](#prova-hospedada-e-ativação-do-anual-35)).
Desde 03/11/2026, ligar o catálogo ou o anual também esperava uma versão nova
dos termos de uso e a implementação da
[ADR 0012](../adr/0012-periodo-por-aniversario.md): a ADR está implementada
no código, e a versão 1.2 dos termos, com o período por aniversário, entrou
no console em 04/11/2026
([Período por aniversário](#período-por-aniversário-decidido-em-03112026)).

Não confundir com a [conexão Stripe](STRIPE.md) (ADR 0006): ela recebe os
pagamentos dos apps consumidores para pedir emissão de NFS-e em nome deles.
Esta cobrança é da própria Freecorps, com conta, chave e endpoint próprios.

## Peças

| Peça                                                                              | Onde                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Tabelas `billingAccounts`, `billingCheckouts`, `billingGrants` e `billingEvents`  | `platform/convex/lib/billingSchema.ts`                            |
| Cliente da API, leitura de fatura e assinatura, regra de concessão (puro)         | `platform/convex/lib/billingStripe.ts`                            |
| Aplicação de fatura paga ao plano ou ao termo anual e bloqueio entre Pix e cartão | `platform/convex/lib/billingCore.ts`                              |
| Console, reconciliação e eventos                                                  | `platform/convex/billing.ts`                                      |
| Endpoint `POST /v1/billing/stripe/events`                                         | `platform/convex/billingRest.ts`                                  |
| Tela                                                                              | Uso e limites, `apps/console/src/plans.tsx` e `plans-billing.tsx` |
| Pix assistido, mensal e anual                                                     | `platform/convex/plans.ts` (`requestPaid`, `confirmPayment`)      |
| Checkout mensal e anual por cartão                                                | `platform/convex/billing.ts` (`checkout`, `prepareCheckout`)      |
| Início do anual, na hora ou agendado, para Pix e cartão                           | `platform/convex/lib/planCore.ts` (`startTerm`)                   |
| Início do anual agendado                                                          | `platform/convex/plans.ts` (`activateScheduledTerm`)              |
| Prazo, reembolso e upgrade do anual (puro)                                        | `platform/convex/lib/annualTerms.ts`                              |
| Termo anual: gravação e consulta do termo em vigor                                | `platform/convex/lib/planTerms.ts`                                |
| Upgrade do anual: termo a elevar, preço e concessão, para Pix e cartão            | `platform/convex/lib/planTerms.ts`, `lib/planCore.ts`             |

## O servidor manda

O console só manda a intenção (plano, ciclo e chave de idempotência). O servidor
confere papel, organização, catálogo e admissão, calcula o valor e cria a sessão
de Checkout com o preço que ele escolheu. O retorno do navegador
(`?cobranca=retorno`) só pede uma nova conferência; o plano muda quando uma
**fatura paga** é lida de volta da API do Stripe.

- **Papéis.** `owner` e `admin` contratam, mudam, cancelam e abrem o portal
  (`requireManager`, como o Pix). `developer`, `operator` e `viewer` não veem a
  cobrança; login sem membership e outra organização são recusados.
- **Preços.** Os dois preços recorrentes são criados no Stripe com as
  lookup keys `fnfe_plan_intermediate_monthly_brl` e
  `fnfe_plan_large_monthly_brl`. Antes de cada uso o servidor confere que estão
  ativos, em BRL, mensais, licenciados e com o valor exato de
  [`planCatalog.ts`](../../platform/convex/lib/planCatalog.ts). Um preço
  alterado no Stripe sem o catálogo para a venda (`BILLING_UNAVAILABLE`).
  Os preços anuais são opcionais e têm conferência própria
  ([Fatura anual do cartão](#fatura-anual-do-cartão)).
- **Organização e cliente.** Cada organização tem um Customer por modo do
  Stripe (`billingAccounts`, `by_organizationId_and_livemode`). O id do
  Customer é o único vínculo que volta do Stripe; metadados de outra organização
  numa fatura deste Customer bloqueiam a fatura (`ORGANIZATION_MISMATCH`), e um
  Customer desconhecido é ignorado (`UNKNOWN_CUSTOMER`).

## Contratação e ciclo

Desde a fatia 2a da [ADR 0012](../adr/0012-periodo-por-aniversario.md), o
mensal no cartão é cobrado na contratação e vai do instante do pagamento até o
mesmo dia e horário do mês seguinte, em UTC. O Stripe ancora a assinatura
nesse instante (`billing_cycle_anchor`) e a renova a cada aniversário dele,
sempre contado da âncora: assinada em 31/01 às 10:00:07 UTC, ela renova em
28/02 e depois em 31/03, no mesmo horário.

| Situação                                    | Cartão mensal                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contratar sem plano pago em vigor           | Checkout em modo `subscription` só com o preço recorrente do tier: a mensalidade integral é cobrada no pagamento, sem âncora no dia 1, item avulso, cupom nem pró-rata. O link vale 24 horas.                                                                                             |
| Plano Pix em vigor                          | Espera o fim do plano em vigor e de uma renovação dele já paga: `PAYMENT_METHOD_PIX`, com `availableAt`, em qualquer tier (ADR 0012).                                                                                                                                                     |
| Termo anual em vigor ou agendado            | Espera o fim do último termo: `ANNUAL_TERM_ACTIVE`, com `availableAt` (`termsEnd`). O cartão não tem início adiado.                                                                                                                                                                       |
| Mensal do cartão em vigor, renovação parada | Uma assinatura nova seria um segundo plano pago: `PLAN_UNAVAILABLE`, com `availableAt` no fim do mês pago. A renovação é "Retomar renovação".                                                                                                                                             |
| Renovação                                   | Fatura `subscription_cycle` no aniversário: concede o período da linha, um mês da âncora, com o preço do catálogo.                                                                                                                                                                        |
| Upgrade com assinatura que renova           | Checkout em modo `payment` pela diferença integral do mês do plano, com fatura pós-compra; ao pagar, o plano sobe até o mesmo fim, com a mesma âncora, e a assinatura passa ao preço maior com `proration_behavior: none` e `billing_cycle_anchor: unchanged`. Fecha a 45 minutos do fim. |
| Downgrade                                   | `changeRenewal`: confere que o uso cabe e troca o preço da próxima renovação; o mês pago não muda.                                                                                                                                                                                        |
| Cancelamento                                | `cancel_at_period_end`: sem multa, sem reembolso proporcional; o período pago continua. "Retomar renovação" desfaz antes do fim.                                                                                                                                                          |
| Encerramento da organização                 | A assinatura é cancelada na hora no Stripe, sem reembolso automático do mês pago.                                                                                                                                                                                                         |

Os metadados da assinatura (`subscription_data[metadata]`) levam
`organizationId`, `kind: "start"`, `tier` e `grantCents`, sem `period`: o mês
começa no pagamento, e a fatura diz qual é. A linha de `billingCheckouts` de
um início mensal também não grava `period`, e `billing:overview` devolve
`periodStartsAt` nulo para ele. Até a fatia 2a, o início mensal tinha item
avulso com a mensalidade do mês corrente, `create_prorations`, um cupom de
100% no produto recorrente e âncora no dia 1 seguinte; nenhum Checkout
aberto antes dela continua válido depois de 24 horas.

O upgrade cobra a diferença integral do mês do plano em vigor, o período de
cota da linha (`quotaPeriod`), e os metadados da fatura levam a chave
canônica desse período em `period`, como `2026-10-10T12:00:00.000Z`. Ele é
recusado a 45 minutos do fim do mês (`PERIOD_CLOSING`, com `availableAt` no
fim, `PERIOD_CLOSING_MARGIN` em `lib/billingCore.ts`), e a sessão expira 5
minutos antes do fim: o pagamento e a troca de preço não atravessam a
renovação. Uma linha concedida antes da fatia 2a, no mês civil, sobe com a
âncora no dia 1 desse mês, que dá as mesmas chaves `AAAA-MM`.

O anual no cartão também é cobrado na contratação, com a âncora no pagamento
([Checkout anual](#checkout-anual)). Enquanto há Checkout aberto ou
assinatura que renova, o Pix é recusado (`PAYMENT_METHOD_CARD`), e enquanto
há pedido Pix aguardando, o cartão é recusado (`PLAN_REQUEST_PENDING`). Para
trocar cartão por Pix: cancelar a renovação e pedir o Pix quando o período
terminar. Para trocar Pix por cartão: o Checkout mensal espera o fim do plano
Pix em vigor e de uma renovação dele já paga (`PAYMENT_METHOD_PIX`, com
`availableAt`); o Checkout anual substitui na hora um mensal Pix do mesmo
tier ou menor e espera só o início de uma renovação dele já paga (ADR 0012,
um plano pago por vez). Um mês do cartão é reconhecido por `paidByCard`
(`lib/billingCore.ts`), pela versão da linha que a fatura concedeu.
"Desistir" expira a sessão no Stripe.

Uma assinatura mensal contratada antes da fatia 2a, como a da prova da
[#668](https://github.com/freecorps/freecorpsNFE-arquivo/issues/668), tem a
âncora no dia 1 às 00:00 UTC: os meses dela são os civis, e as renovações
continuam concedidas, agora com `periodAnchor` nesse dia 1 e as mesmas chaves
`AAAA-MM`. A primeira fatura de um Checkout desse formato, com a linha
recorrente do pagamento até o dia 1, não é um mês da âncora e fica
`INVOICE_UNEXPECTED`; o catálogo nunca foi ligado, e uma sessão aberta antes
da fatia 2a expira em 24 horas.

### Período da fatura mensal

Cada fatura mensal é conferida contra a âncora da assinatura (invariante 6
da ADR 0012). A reconciliação lê o `billing_cycle_anchor` de cada assinatura
do Customer, inclusive das encerradas (`readSubscriptions`, `anchors`), e
`invoiceGrant` (`lib/billingStripe.ts`) exige que a linha no preço mensal
cubra exatamente um mês dessa âncora, `[addMonths(âncora, k),
addMonths(âncora, k + 1))`, na primeira fatura e em cada renovação
(`anchorMonth`). Uma linha fora disso fica `blocked` com `INVOICE_UNEXPECTED`.
A assinatura de uma fatura que a lista não trouxe, porque ela só lê 10
assinaturas ou porque a conferência correu junto com a conclusão do
Checkout, é lida pelo id (`GET /v1/subscriptions/{id}`). Se ainda assim a
âncora não for conhecida, a fatura não é registrada (`ANCHOR_UNKNOWN`, como
uma fatura não paga) e volta a ser pesada na conferência seguinte. Concedida, a
linha de `usagePlans` vai de agora ao fim da linha (`line.period.end`), com
`periodAnchor` igual à âncora em ms (invariante 4), e as cotas viram nos
aniversários ([USAGE.md](USAGE.md#período-de-cota)). `activateCatalogPlan`
recusa uma âncora depois de `startsAt` ou um fim que não seja aniversário
dela.

Se a troca de preço de um upgrade pago não chegar ao Stripe antes de ele
preparar a fatura do aniversário (falha da API, evento perdido), a renovação
sai pelo tier anterior. O dinheiro entrou por esse preço, então o mês é
concedido nesse tier, mas a concessão fica `applied` com
`RENEWAL_BELOW_UPGRADE` e aparece em `billing:overview` (`reviews`) até
`billing:resolveReview`, como no anual: a renovação abaixo do tier do mês
anterior enquanto a conta ainda renova por ele. `renewalTier` não muda, e a
troca, quando chegar, vale para o mês seguinte. Uma pessoa combina com o
cliente a diferença ou o reembolso.

### Como uma fatura vira plano

Cada fatura paga é pesada uma vez (`billingGrants.invoiceId`):

- `applied`: plano ativado por `activateCatalogPlan`, com auditoria
  `stripe:{in_…}`, até o fim do período comprado: o fim da linha mensal ou,
  no upgrade, o fim do mês do plano em vigor. A concessão grava em `period`
  a chave canônica do período, `AAAA-MM` ou o instante ISO.
  Uma fatura anual cria um termo, com `termId` na concessão
  ([Fatura anual do cartão](#fatura-anual-do-cartão)). Uma renovação anual
  cobrada abaixo do tier que um upgrade comprou fica `applied` com
  `RENEWAL_BELOW_UPGRADE` e aparece para a equipe
  ([Upgrade do anual](#upgrade-do-anual)), e a mensal também
  ([Período da fatura mensal](#período-da-fatura-mensal)).
- `skipped`: `ZERO_AMOUNT` (mês já pago, cobrado R$ 0) ou `SUPERSEDED` (um mês
  posterior já está em vigor; nunca encurta o plano).
- `blocked`: precisa de uma pessoa. `ANNUAL_TERM_ACTIVE` (fatura mensal paga
  para um mês coberto por um [termo anual](#plano-anual)), `DUPLICATE_PAYMENT` (mês já
  coberto pelo mesmo plano ou maior), `LATE_PAYMENT` (paga depois do mês que
  comprou, ou um upgrade pago quando o mês do plano em que foi precificado já
  não é o corrente),
  `AMOUNT_MISMATCH`, `PRICE_UNKNOWN`, `CURRENCY_MISMATCH`,
  `INVOICE_UNEXPECTED` (inclusive a fatura mensal fora de um mês da âncora),
  `ORGANIZATION_MISMATCH`, `ORGANIZATION_CLOSED`,
  `PLAN_CUSTOM` ou a recusa de admissão (`QUOTA_EXCEEDED`, `PLAN_UNAVAILABLE`,
  `CAPACITY_INVENTORY_REQUIRED`, `ORGANIZATION_ARCHIVING` do congelamento à
  remoção e durante a reidratação; uma organização já arquivada aceita o plano,
  [ADR 0009, §2](../adr/0009-custodia-fria-de-organizacoes-abertas.md#2-a-organização-continua-aberta)).

Fatura não paga não é registrada e volta a ser lida na próxima conferência.

## Políticas decididas em 28/10/2026

- **Inadimplência: sem carência.** Renovação recusada não estende o plano: ele
  vence no fim do mês pago, novas entradas param e documentos e guarda
  continuam. O Stripe tenta de novo (Smart Retries); o pagamento recuperado
  ativa o mês inteiro, sem pró-rata, como no Pix. Esgotadas as tentativas, a
  assinatura é cancelada pelo Stripe. A tela mostra a fatura aberta com o link
  de pagamento.
- **Reembolso e contestação: só sinalizam.** `charge.refunded`,
  `charge.dispute.created` e `charge.dispute.closed` de um Customer conhecido
  ficam em `billingEvents` com `review: true` e aparecem como "Em análise pela
  equipe". O plano não muda. Reembolso é sempre manual, pelo painel do Stripe.
- **Termos.** Estas regras estão na seção 5A dos
  [termos de uso 1.0](../termos/arquivo/termos-de-uso-2026-11-01.md), publicados em 01/11/2026 (#428). Elas valem quando um plano
  pago estiver à venda no console.

## Período por aniversário, decidido em 03/11/2026

Em 03/11/2026 o dono decidiu que toda assinatura paga, mensal ou anual, corre
do instante da contratação ao mesmo dia e horário do mês ou do ano seguinte e
renova nesse aniversário; que o anual no cartão começa e é cobrado na
contratação; e que as cotas dos planos pagos seguem o mês da assinatura
([ADR 0012](../adr/0012-periodo-por-aniversario.md)). Pelo desenho da ADR, o
Pix começa na confirmação ou, na renovação pedida no último mês, no fim do
plano em vigor. Isso substitui o mês civil UTC das políticas mensais da
#556, a renovação no dia 1 e o anual que começa no dia 1 do mês seguinte.
**A decisão está implementada no código, nas fatias 0 a 2b:** o código faz o
que este documento descreve. Da fatia Q,
já existe o modelo do período de cota, em
[USAGE.md](USAGE.md#período-de-cota): `usagePlans.periodAnchor`, as chaves
canônicas e `quotaPeriod`. A linha que um termo anual concede leva o início
do termo como âncora. Da fatia 1b, o anual pelo Pix começa
na confirmação ou, como renovação pedida no último mês do plano Pix em
vigor, no fim dele, com a âncora da cadeia gravada no termo
([Venda por Pix](#venda-por-pix)); as guardas de termo comparam instantes, e
as vendas Pix seguem a regra de um plano pago por vez. Da fatia 1c, o mensal
pelo Pix também corre de aniversário a aniversário, com âncora
([Mensal por Pix](#mensal-por-pix)), e o Checkout mensal espera o fim do
plano Pix em vigor. Da fatia 2a, o mensal no cartão é cobrado na
contratação e renova no aniversário dela, sem âncora no dia 1 nem item
avulso, e cada fatura mensal concede só um mês exato da âncora da assinatura
([Contratação e ciclo](#contratação-e-ciclo)). Da fatia 2b, o anual no
cartão é cobrado e começa na contratação, sem âncora no dia 1, e cada fatura
anual concede só um ano exato da âncora da assinatura, que o termo guarda
como a da cadeia ([Checkout anual](#checkout-anual)). A seção 5A dos
[termos de uso 1.2](../termos/arquivo/termos-de-uso-2026-11-04.md), no
console desde 04/11/2026, descreve este modelo, só por cartão. O catálogo e o
anual continuam desligados até a
[prova hospedada da #35](#prova-hospedada-e-ativação-do-anual-35), reescrita
para este modelo e ainda não executada; as provas já feitas no Stripe de
teste, com renovação ancorada no dia 1, precisam ser refeitas
([Prova do mensal](#prova-do-mensal-no-stripe-de-teste-668)).

## Mensal por Pix

Só com o [interruptor do Pix](#interruptor-do-pix) ligado. Desde a fatia 1c
da [ADR 0012](../adr/0012-periodo-por-aniversario.md), o mensal pelo Pix vai
de aniversário a aniversário, e a linha de `usagePlans` que ele concede leva
`periodAnchor`: as cotas viram nos aniversários
([USAGE.md](USAGE.md#período-de-cota)). O console manda só o tier e a chave;
o servidor decide pelo tier o que o pedido compra (`pixMonthlyStart`,
`plans.ts`) e o mostra em `plans:overview` (`monthlyStart`, por tier, com o
valor):

| Situação                                                 | Pedido mensal por Pix                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sem plano pago em vigor (sem plano, Gratuito ou vencido) | `now`: mensalidade integral; o mês começa na confirmação, truncada ao segundo, com âncora nova, e termina no 1º aniversário dela. O pedido vale 7 dias.                                           |
| Mensal Pix em vigor, mesmo tier ou menor                 | `renewal`: mensalidade integral; começa no fim do plano em vigor e mantém a âncora, até o aniversário seguinte. Vale até o fim do mês que compra.                                                 |
| Mensal Pix em vigor, tier maior                          | `upgrade`: diferença integral, cobrada agora; mesmo período, mesma âncora e mesmo fim. Vale até o fim do plano em vigor.                                                                          |
| Último mês de um termo anual Pix                         | `renewal`, em qualquer tier: começa no fim do termo, com a âncora da cadeia.                                                                                                                      |
| Termo anual Pix antes do último mês, ou agendado         | Recusado com `ANNUAL_TERM_ACTIVE` e `availableAt` no último mês do termo mais recente; um termo com a ativação recusada, no fim dele.                                                             |
| Plano do cartão em vigor, mesmo sem renovação            | Recusado com `PAYMENT_METHOD_CARD` e `availableAt` no fim dele, mesmo num tier maior; com o cartão renovando ou um Checkout aberto, sem data.                                                     |
| Acesso deixado por um termo rescindido                   | Recusado com `PLAN_UNAVAILABLE` e `availableAt` no fim do acesso.                                                                                                                                 |
| Renovação mensal já paga e não começada                  | Só o upgrade do mês em vigor, que não muda o tier da renovação. O resto é recusado com `PLAN_UNAVAILABLE` e `availableAt` no início dela; com a ativação recusada, no fim do mês que ela comprou. |
| Plano personalizado                                      | Recusado com `PLAN_UNAVAILABLE`, sem data.                                                                                                                                                        |

Todo aniversário sai da âncora original (`addMonths`): uma âncora em 31/01
às 10:00:07 UTC renova em 28/02 e depois em 31/03, no mesmo horário. A
renovação de um termo anual pelo mensal, e do mensal pelo anual
([Venda por Pix](#venda-por-pix)), continua a mesma cadeia. Um mensal
concedido antes da 1c não tem âncora e termina num dia 1 às 00:00 UTC; a
renovação dele abre uma cadeia nova nesse instante.

O pedido grava `start`, e a renovação, `firstPeriod` e `anchor`; em
`endsAt` fica o prazo de pagamento. Nenhum pedido novo grava `period`, e a
resposta de `plans:requestPaid` não o traz. `plans:confirmPayment` confere
valor e referência, como no anual, e:

- `now`: refaz a conta de `pixMonthlyStart`; um plano pago que entrou em
  vigor desde o pedido a recusa com o código e a data. Um plano alterado
  desde o pedido é recusado com `OPERATION_CONFLICT`;
- `upgrade`: concede o tier maior agora, até o fim do plano em vigor, com a
  mesma âncora, sobre a versão do pedido;
- `renewal` paga a partir do início dela: concede na hora, até o mesmo fim,
  com a âncora da cadeia;
- `renewal` paga antes: reserva o estoque do tier, encerra um aviso de
  arquivamento pendente, marca o pedido `activated` com `scheduled` e agenda
  `plans:activatePixRenewal` para o início; rodada antes dele, a tarefa se
  agenda de novo. Ela concede o plano sobre a versão em vigor nesse
  instante e apaga `scheduled`. Como a ativação de um termo agendado, ela
  substitui a linha que estiver em vigor, inclusive uma atribuída pelo
  operador (`usage:assignPlan`) entre a confirmação e o início, e o upgrade
  vendido no meio-tempo vale só até o início.

**Renovação recusada.** Se a admissão recusar, um termo cobrir o mês ou a
execução chegar depois do fim dele (`PERIOD_ENDED`), a tarefa grava
`blockedCode` sem conceder nada, e a organização fica sem plano pago até o
operador resolver e chamar a mesma mutation com o `requestId`. É o caso de
uma renovação para um tier menor que o uso, crescido desde o pedido, já não
cabe (`QUOTA_EXCEEDED`; o pedido confere o uso). Foi mantido de propósito,
igual à renovação do cartão, cuja fatura no tier menor fica `blocked` pela
mesma recusa, e ao termo agendado: conceder um plano menor que o uso
passaria a recusar entradas novas sem que uma pessoa visse o pagamento. Uma
renovação cujo início passou há 10 minutos sem concessão nem recusa, por uma
falha inesperada da tarefa, fica `overdue`. Recusada ou atrasada, aparece no
console como "Início pendente" e segura a organização até o fim do mês que
comprou: as outras vendas, o cartão e o arquivamento esperam
(`ARCHIVE_PAID_ACTIVE`). Agendada, ela também conta como plano pago
(`paidPlanInForce`) e aparece como "Renovação mensal paga"
(`scheduledRenewal` em `plans:overview`). Só as renovações iniciadas nos
últimos 31 dias são lidas, então linhas antigas que ficaram com `scheduled`
não escondem a atual.

**Plano pago por Pix.** Cada confirmação mensal grava em `planVersion` a
versão da linha que concedeu, e a ativação agendada também. O Checkout
mensal só espera por uma linha que um pedido Pix gravou (`paidByPix`,
`lib/billingCore.ts`): uma linha de tier do catálogo atribuída pelo operador
não é tomada por Pix, e um mensal Pix confirmado antes desse registro também
não, como antes da 1c.

Um pedido mensal feito antes da 1c, com `period`, continua repetido pela
mesma chave e confirmado como foi pedido: o mês civil, sem âncora. O
console mostra os instantes em UTC com `formatUtcInstant`, sem "dia 1" no
Pix, e as recusas com a data de `availableAt`.

## Interruptor do Pix

`platformPlanSettings.pix` (`enabled`, `evidence`, `updatedAt`) fica
desligado quando ausente. Só o operador o altera, pela mutation interna
`plans:configurePix`, com as mesmas regras de `plans:configureAnnual`:
`expectedVersion`, evidência de 8 a 500 caracteres, recusa com o catálogo
desligado (`PLANS_DISABLED`) e avanço da `version` comum. `pixOn` em
`planCore.ts` exige o catálogo e o Pix ligados, e `plans:configure` preserva o
campo.

Desligado, `plans:requestPaid` recusa todo pedido novo com `PIX_DISABLED`,
mensal, anual ou upgrade de termo Pix, antes de gravar qualquer coisa. Com o
anual também desligado, o pedido anual responde `ANNUAL_DISABLED`. A
repetição de um pedido já feito, pela mesma chave, continua respondendo, e
`plans:confirmPayment` ainda confirma um pedido feito antes. Termos pagos por
Pix não mudam. A adesão ao Gratuito não passa pelo Pix e continua.

`plans:overview` e `billing:overview` trazem `pixEnabled`. Com o Pix
desligado, o console troca os botões "Solicitar …" dos planos pagos por
"Assine pelo cartão em Cobrança.", não oferece o upgrade de um termo Pix e
tira o Pix dos textos de Cobrança. Sem Pix, o anual é vendido pelo
[Checkout anual](#checkout-anual), cobrado e iniciado no pagamento.

## Janela de admissão

`admissionsUntil`, em `platformPlanSettings`, limita só a **nova reserva** de
capacidade: o primeiro plano de uma organização e o upgrade, que reservam mais
estoque, custódia ou subsídio. Quem já tem a reserva da oferta renova, pelo
cartão ou pelo Pix, volta ao cartão ou desce de plano depois que a janela
fecha. A regra fica em `allocateOffer` (`platform/convex/lib/planCore.ts`),
que todos os caminhos de contratação e a fatura paga usam. O mantenedor a
decidiu em 29/10/2026 na #549. Antes, a renovação depois da janela ficava
`blocked` para a equipe, já paga.

## Plano anual

O anual dá 12 meses pelo preço de 10
([ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md), decisões 4.2
e 9). O Pix assistido e o [Checkout anual](#checkout-anual) do cartão
vendem o anual, só com o interruptor ligado, que segue desligado; o Pix
também depende do [interruptor do Pix](#interruptor-do-pix). Uma fatura
anual paga vira termo ([Fatura anual do cartão](#fatura-anual-do-cartão)). O
[upgrade](#upgrade-do-anual) do Intermediário anual para o Grande anual é
vendido pelas duas formas. A [rescisão](#rescisão-do-anual), com o
reembolso calculado pelo servidor, e o upgrade desfeito em 7 dias passam pelo
operador. A [tela do console](#tela-do-anual-no-console) só mostra o anual
com o interruptor ligado.

- **Preço.** `annualCents` em `planCatalog.ts`: R$ 1.490 no Intermediário e
  R$ 4.990 no Grande. O Gratuito não tem anual.
- **Interruptor.** `platformPlanSettings.annual` (`enabled`, `evidence`,
  `updatedAt`) fica desligado quando ausente. Só o operador o altera, pela
  mutation interna `plans:configureAnnual`, com `expectedVersion` e evidência
  de 8 a 500 caracteres, como `plans:configure`. Ligar é recusado com o
  catálogo desligado (`PLANS_DISABLED`), e `annualEnabled` em `planCore.ts`
  exige os dois ligados. Desligar interrompe só a venda nova: um pedido já
  feito continua valendo e os anuais pagos não mudam. Ligar ou
  desligar avança a `version` comum das configurações, como
  `plans:configure`, e uma chamada com a versão anterior recebe
  `OPERATION_CONFLICT`. `plans:configure` preserva o campo. A fase E da
  ADR (#642), a viabilidade, foi aprovada com o fechamento da #34; o anual
  só é ligado depois da prova da #35.
- **Cálculo.** `platform/convex/lib/annualTerms.ts`, puro, em centavos
  inteiros e instantes UTC em ms. O termo pode começar em qualquer instante
  e termina no aniversário: o mesmo dia e horário 12 meses depois
  (`termEndsAt`). O mês do termo de índice `k`, contado de 0 (o (k + 1)º
  mês da ADR 0012), vai de `termMonthStart(início, k)` a
  `termMonthStart(início, k + 1)`, sempre contado do início: o dia fica o
  mesmo, limitado ao último dia do mês, então um termo de 31/01 às 10:00
  vira o mês em 28/02 (29/02 no bissexto) e em 31/03, e termina em 31/01 do
  ano seguinte; um de 29/02 termina em 28/02. Cada mês começa no seu
  instante exato, nem 1 ms antes. Um termo que começa no dia 1 às 00:00 UTC,
  como os do cartão vendidos antes da fatia 2b, tem os meses civis UTC como
  meses do termo. O mês
  do termo em curso conta inteiro. Até 7 × 24 h da compra, o reembolso é
  integral; depois, é o valor pago menos os meses do termo usados pelo preço
  mensal, nunca negativo. O Intermediário cancelado no 4º mês devolve
  R$ 894; a partir do 10º mês, nada. O upgrade do Intermediário para o
  Grande cobra (R$ 4.990 − R$ 1.490) × meses do termo restantes / 12,
  arredondado para baixo uma vez, no total.
- **Termo.** Cada anual pago é uma linha de `platformPlanTerms`
  (`planSchema.ts`): `tier` a partir de `firstPeriod` (o instante de início,
  em ms: no cartão, o início da linha anual da fatura, um aniversário da
  âncora da assinatura; no Pix, a confirmação, truncada ao segundo, ou o fim
  do plano renovado), `anchor` (a âncora da cadeia, abaixo),
  `endsAt`, `source` (`stripe` ou `pix`), `references` (faturas ou
  referências Pix), `stripeSubscriptionId` (a assinatura que comprou um
  termo `stripe`), `paidCents` (tudo o que foi pago pelo termo: a cobrança
  anual mais os upgrades), `purchasedAt` (pagamento da cobrança anual
  corrente, que abre os 7 dias), `segments` (só os upgrades, com `tier` e
  `fromPeriod`), `upgrades` (cada cobrança de upgrade, com `fromTier`,
  `tier`, `fromPeriod`, `reference`, `paidCents` e `paidAt`), `state`
  (`scheduled`, `active`, `rescinded` ou `expired`) e, depois do suporte,
  `undoneUpgrades` (os upgrades desfeitos em 7 dias) e `rescission` (a
  rescisão, com o reembolso calculado e a devolução registrada), descritos
  em [Rescisão do anual](#rescisão-do-anual). Nenhum termo passa a
  `expired` por enquanto: um termo terminado continua `active`, e as
  guardas comparam `endsAt` com o momento.
  A linha de `usagePlans` concedida por um termo guarda `termId`. Os termos
  nascem da [venda por Pix](#venda-por-pix) e da
  [fatura anual do cartão](#fatura-anual-do-cartão), as duas por `startTerm`
  (`lib/planCore.ts`).
- **Âncora da cadeia** (ADR 0012, seção 1, decidido nas fatias 1b e 2b). O
  termo que renova outro pelo Pix grava `anchor`, a âncora original da
  cadeia: o início do primeiro termo, ou a âncora do mensal que ele renova.
  No cartão, a âncora é o `billing_cycle_anchor` da assinatura (invariante
  6): o termo da primeira fatura começa nela e não grava o campo, e cada
  renovação o grava. Sem o campo, o termo é a própria âncora, como os
  gravados antes da 1b e os do cartão antes da 2b; por isso não há migração.
  Os meses do termo, o `endsAt` e a
  âncora das cotas da linha concedida (`usagePlans.periodAnchor`, por
  `termAnchor` em `lib/planCore.ts`) contam da âncora: o termo que começa no
  aniversário mensal m dela vai do aniversário m ao m + 12
  (`termEndsAt(início, âncora)`). Uma cadeia de 29/02/2028 vira em
  28/02/2029, 2030 e 2031 e volta a 29/02/2032, e o 2º mês do termo de
  28/02/2029 começa em 29/03, não em 28/03. Gravar foi preferido a derivar
  do termo anterior porque a rescisão, a renovação atrasada e o fim do
  mensal renovado deixam o termo sem um antecessor em vigor para consultar.
- **Formato.** Todo termo é gravado por `insertTerm` (`lib/planTerms.ts`),
  que chama `assertTermShape` (`lib/annualTerms.ts`) e recusa:
  - `firstPeriod` que não seja um instante inteiro de ms, não negativo, ou
    `endsAt` diferente de `termEndsAt(firstPeriod)`;
  - `paidCents` que não seja inteiro maior que zero, ou `purchasedAt`
    inválido;
  - `references` vazio, repetido ou fora do formato `[a-zA-Z0-9_-]{8,120}`;
  - um segmento que não comece no início de um mês do termo
    (`isTermMonthStart`), depois do anterior (o primeiro, depois de
    `firstPeriod`) e antes de `endsAt`, ou cujo `tier` não seja maior que o
    anterior. Num termo de 15/10 às 14:30, o 5º mês começa em 15/02 às
    14:30, e um segmento em 01/02 é recusado. O downgrade só vale na
    renovação, e um upgrade no primeiro mês do termo cobre os 12 meses, então
    muda `tier` em vez de abrir segmento;
  - uma cobrança de upgrade fora do início de um mês do termo, antes de
    `endsAt`, com `tier`
    diferente do que o termo tem nesse mês ou não maior que `fromTier`, com
    referência fora de `references` ou repetida, com centavos que não sejam
    inteiros maiores que zero, ou cuja soma não fique abaixo de `paidCents`.
- **Guarda `ANNUAL_TERM_ACTIVE`.** Um termo `scheduled` ou `active` cobre os
  instantes de `firstPeriod` até antes de `endsAt` (`termCovering`). No
  cartão, o anual começa no pagamento e substitui na hora um mensal em vigor
  do mesmo tier ou menor, sem desconto. Recusam com `ANNUAL_TERM_ACTIVE`:
  - quando um termo se sobrepõe ao plano mensal, de `startsAt` até antes de
    `endsAt` (`monthlyBlockedByTerm`), porque o termo o encurtaria: a
    confirmação (`plans:confirmPayment`), a renovação mensal Pix agendada
    (`plans:activatePixRenewal`) e qualquer outra ativação mensal de
    `activateCatalogPlan`. Um plano sem fim,
    como o Gratuito (`plans:claimFree`), só é recusado se um termo cobre
    `startsAt`: a ativação do termo o substitui. O pedido mensal Pix
    (`plans:requestPaid`) é recusado com qualquer termo em vigor ou agendado
    antes do último mês do mais recente, com `availableAt` nesse último mês,
    quando o mensal entra como renovação ([Mensal por Pix](#mensal-por-pix));
  - quando um termo cobre o instante atual: a atribuição manual
    (`usage:assignPlan`). Um termo agendado para depois substitui a linha
    atribuída quando começa;
  - enquanto houver qualquer termo `scheduled` ou `active` não terminado,
    mesmo agendado para depois: o Checkout mensal (`billing:checkout`), com
    `availableAt` no fim do último termo (`termsEnd`), porque o cartão não
    tem início adiado, e "Retomar renovação" (`billing:changeRenewal` com
    `resume`), porque a assinatura renovaria mês a mês dentro do anual. A
    retomada da assinatura anual que comprou todos os termos em vigor é
    aceita (`termsInForce`, [Fatura anual do cartão](#fatura-anual-do-cartão)).
    Entre `prepareRenewal` e a chamada ao Stripe há uma janela de segundos
    em que um Pix anual pode ser confirmado; nesse caso a renovação do
    cartão fica `blocked` com `ANNUAL_TERM_ACTIVE` e o operador reembolsa,
    como no mensal.

  Uma fatura mensal paga para um mês coberto, ou paga num mês corrente
  coberto, fica `blocked` com o mesmo código, nunca `SUPERSEDED`: o
  dinheiro entrou e uma pessoa resolve. A fatura de um mês anterior ao
  termo, como uma retentativa do Stripe, é concedida normalmente se for paga
  antes de o termo começar. Com o termo expirado ou terminado, os caminhos
  mensais voltam a valer. Rescindido, o termo deixa o acesso até o fim do
  mês corrente dele, numa linha de plano com `termId`: enquanto ela vale,
  um plano pago por vez (ADR 0012) recusa o pedido Pix mensal e o Checkout
  mensal com `PLAN_UNAVAILABLE` e `availableAt` no fim do acesso, mesmo para
  um tier maior, e a fatura mensal paga fica `blocked` com
  `ANNUAL_TERM_ACTIVE`, em vez de `SUPERSEDED` ou `DUPLICATE_PAYMENT`.

  A guarda olha só o mês corrente: uma ativação mensal sob termo agendado
  pode ter `endsAt` além de `firstPeriod` (o Gratuito não tem fim). A
  ativação do termo, no início dele, substitui essa linha.

- **Concessão pelo termo.** `activateCatalogPlan` com `termId` recusa com
  `INVALID_REQUEST` o termo de outra organização, um termo fora de
  `scheduled` ou `active`, um tier diferente do que o termo tem no mês de
  `startsAt` (o último segmento já começado, ou `tier`), `startsAt` fora de
  `[firstPeriod, endsAt)` e um `endsAt` diferente do fim do termo.

- **Pix pago sob anual.** Um pedido Pix feito antes do termo e pago depois é
  recusado em `plans:confirmPayment`, e nada registra o dinheiro. O operador
  devolve o valor por Pix, à mão, e cancela o pedido ou o deixa vencer.
- **Encerramento.** Com um termo em vigor ou agendado, o owner não encerra
  a organização (`organizationClosure:close` recusa com
  `ANNUAL_TERM_ACTIVE`): o fim do anual passa pelo suporte ("Rescindir"),
  que calcula o reembolso. Rescindido o termo, o owner volta a encerrar a
  organização, mesmo com o acesso indo até o fim do mês. O termo também
  conta como plano pago
  (`paidPlanInForce`), e o operador não encerra uma organização que já teve
  qualquer termo, mesmo encerrado, como acontece com um recibo.
- **Pré-condição da venda.** Esta guarda não interrompe uma assinatura
  mensal que já renova nem um Checkout já aberto. As duas vendas a cumprem
  recusando. O pedido Pix, anual ou mensal, é recusado com `PAYMENT_METHOD_CARD`
  enquanto há cartão que renova ou Checkout aberto e, pela regra de um plano
  pago por vez, enquanto um plano pago pelo cartão vale, mesmo com a
  renovação cancelada, com `availableAt` no fim dele; o pedido pendente
  recusa o Checkout e a retomada da renovação (`PLAN_REQUEST_PENDING`). O
  Checkout anual é recusado enquanto há cartão que renova
  (`SUBSCRIPTION_RENEWING`) ou outro Checkout aberto (`CHECKOUT_PENDING`).
  Assim nenhum termo nasce ao lado de um cartão que renova.
- **Decisões de 30/10/2026** ([#642](https://github.com/freecorps/freecorpsNFE-arquivo/issues/642#issuecomment-6523073174)).
  As três estão implementadas ([Rescisão do anual](#rescisão-do-anual) e
  [Upgrade do anual](#upgrade-do-anual)):
  - O reembolso integral em 7 dias vale para cada cobrança anual, inclusive
    as renovações; a revisão jurídica da etapa D4 confirma.
  - Há duas ações de cancelamento. "Não renovar" é pelo próprio cliente: os
    meses pagos continuam e não há reembolso. "Rescindir" passa pelo
    suporte: o servidor calcula o reembolso, o operador devolve à mão pelo
    painel do Stripe ou por Pix, e o acesso vai até o fim do mês civil
    corrente, ou termina na hora dentro dos 7 dias. Pela
    [ADR 0012](../adr/0012-periodo-por-aniversario.md#3-reembolso-pelo-mês-da-assinatura),
    o acesso vai até o fim do mês corrente do termo.
  - O upgrade do Intermediário anual para o Grande anual mantém a data de
    renovação, e a renovação passa a ser do Grande anual.
- **Termos.** A seção 5A dos [termos de uso 1.0](../termos/arquivo/termos-de-uso-2026-11-01.md) trata o anual desde a
  publicação, em 01/11/2026: início no dia 1 no cartão e imediato só no Pix,
  recusa da admissão antes da cobrança, upgrade, "Não renovar", "Rescindir",
  arrependimento de 7 dias e reembolso depois deles. O mantenedor aprovou a
  redação sem revisão jurídica (#428, [decisões de 01/11](../v1.0/TERMS-DRAFT.md#decisões-de-01112026)).
  Desde a fatia 2b da ADR 0012, o código cobra e começa o anual no cartão na
  contratação e conta os meses da assinatura; a versão nova dos termos que
  diz isso ainda não existe, e o anual não é ligado antes dela.

### Venda por Pix

Só com o [interruptor do Pix](#interruptor-do-pix) ligado. O fluxo é o do Pix mensal, com `cycle: "annual"` em `plans:requestPaid`. Desde a fatia 1b da [ADR 0012](../adr/0012-periodo-por-aniversario.md), o anual pelo Pix corre de aniversário a aniversário e não há mais a escolha do dia 1:

1. **Pedido.** O owner ou admin escolhe o tier pago e `start`, que repete o
   que `plans:overview` oferece em `annualStart` (`pixAnnualStart`,
   `plans.ts`). O servidor cobra `annualCents` integral: o termo não se
   sobrepõe a nenhum período já pago. Os papéis, a chave de idempotência e
   `allocateOffer` (estoque e janela de admissão, sem reservar nada) são os
   do mensal. Um pedido aguardando pagamento recusa o seguinte
   (`PLAN_REQUEST_PENDING`) só até o prazo dele; vencido, o pedido seguinte
   o cancela (`pendingRequest`), e o Checkout, o Gratuito e a retomada da
   renovação no cartão deixam de recusar por ele.
   - `now`, sem plano pago em vigor (sem plano, Gratuito ou plano vencido):
     o termo começa na confirmação, com âncora nova.
   - `renewal`, no último mês do plano Pix em vigor: o termo começa no fim
     dele e mantém a âncora da cadeia. O último mês de um termo começa no
     11º aniversário mensal dele (`termLastMonth`, `lib/planTerms.ts`). Um
     mensal Pix em vigor é todo o último mês, então o anual o renova no fim,
     em qualquer tier, inclusive menor, porque o downgrade vale na
     renovação. O termo mantém a âncora do mensal
     ([Mensal por Pix](#mensal-por-pix)); um mensal concedido antes da fatia
     1c termina num dia 1, e o termo que o renova é a própria âncora.

   Com um plano pago em vigor, só a renovação e o upgrade
   (`start: "upgrade"`, [Upgrade do anual](#upgrade-do-anual)) cabem: é a
   regra de um plano pago por vez. As outras vendas são recusadas com um
   código e, quando a data é conhecida, `availableAt`, o instante em que
   ficam disponíveis, nos dados do erro (`deny`,
   `lib/organizationAccess.ts`), que o console mostra depois da mensagem:
   - `ANNUAL_TERM_ACTIVE`: um termo Pix em vigor antes do último mês, ou já
     renovado, até o último mês do termo mais recente; `now` com um termo
     Pix no último mês, até o fim dele. Um termo agendado com a ativação
     recusada espera até o próprio fim;
   - `PAYMENT_METHOD_CARD`: um plano pago pelo cartão em vigor, termo ou
     mensal, mesmo com a renovação cancelada, até o fim dele; enquanto o
     cartão renova ou há Checkout aberto, sem data;
   - `PLAN_UNAVAILABLE`: `now` com um mensal Pix em vigor, até o fim dele;
     uma renovação mensal Pix já paga e não começada, até o início dela;
     o acesso que um termo rescindido deixou, até o fim desse acesso;
     `renewal` sem plano pago em vigor, e o plano personalizado, sem data;
   - `ANNUAL_DISABLED`: o interruptor do anual está desligado. A repetição
     de um pedido já feito, pela mesma chave, continua respondendo;
   - `INVALID_REQUEST`: `start` ausente no anual ou presente no mensal,
     inclusive `upgrade`;
   - `OPERATION_CONFLICT`: a mesma chave com outro tier, ciclo ou início.

2. **Prazo (`payBy`).** O pedido guarda `cycle` e, em `endsAt`, o prazo de
   pagamento. `now` não guarda `firstPeriod` nem `period`, porque não compra
   um mês civil, e vale 7 dias. `renewal` guarda `firstPeriod`, o fim do
   plano renovado, e `anchor`, e vale até o fim do 1º mês do termo novo.
   Depois do prazo, `plans:confirmPayment` recusa com
   `PLAN_REQUEST_UNAVAILABLE`. Uma renovação paga dentro do seu 1º mês
   começa na hora, sem mudar o início nem o fim do termo.
3. **Confirmação.** O operador confere o Pix no banco e chama
   `plans:confirmPayment`, como no mensal: o valor precisa ser
   `annualCents` e a referência não pode ter sido usada. A confirmação vale
   mesmo com o interruptor desligado depois do pedido. Ela grava o termo
   (`source: "pix"`, `references: [referência]`, `paidCents`,
   `purchasedAt` na confirmação) e marca o pedido `activated` com a
   referência, que é o recibo, como no mensal; o termo faz o operador não
   encerrar a organização. Repetir a confirmação não cria outro termo.
   - `now`: o termo começa no instante da confirmação, truncado ao segundo,
     e termina 12 meses depois, no mesmo dia e horário. Confirmado em
     13/10/2026 às 14:30:07,250 UTC, vai de 13/10/2026 às 14:30:07 a
     13/10/2027 às 14:30:07 UTC. A confirmação refaz a conta de
     `annualStart`: um plano pago que entrou em vigor desde o pedido a
     recusa com o mesmo código. O termo fica `active`, e o plano é
     concedido até o fim dele, com `periodAnchor` igual ao início: as cotas
     viram nos meses do termo ([USAGE.md](USAGE.md#período-de-cota)). Como
     no mensal, um plano alterado depois do pedido é recusado
     (`OPERATION_CONFLICT`).
   - `renewal`: o termo grava `anchor` quando a âncora não é o próprio
     início, e um termo que se sobreponha a ele recusa a confirmação com
     `ANNUAL_TERM_ACTIVE`. Antes do início, o termo fica `scheduled`, o
     estoque do tier é reservado na hora, um aviso de arquivamento pendente
     termina (ADR 0009, §1) e `ctx.scheduler.runAt` agenda
     `plans:activateScheduledTerm` para o início, que concede o plano sobre
     a versão em vigor nesse instante, com `periodAnchor` igual à âncora da
     cadeia.
   - Upgrade, desfazimento e rescisão reescrevem a linha do plano com a
     mesma âncora.
4. **Início agendado.** `plans:activateScheduledTerm` (interna, com
   `termId`) relê o termo e não faz nada se ele não estiver `scheduled`,
   inclusive rescindido, ou se o início não chegou; por isso pode rodar de
   novo ou atrasada. Concede o plano e marca o termo `active`. Se a
   admissão recusar (por exemplo `PLANS_DISABLED`,
   `CAPACITY_INVENTORY_REQUIRED`, `QUOTA_EXCEEDED` ou
   `ORGANIZATION_ARCHIVING`, se a reidratação de uma organização arquivada
   começou antes do início), ou se a execução chegar depois do fim do termo
   (`TERM_ENDED`), grava o código em `blockedCode`, sem tentar de novo e
   sem conceder nada.
5. **Renovação.** A renovação começa no `endsAt` do plano que ela renova,
   instante que ele já não cobre, e substitui a linha do plano que vence,
   sem intervalo. Só um termo agendado por vez: a renovação seguinte abre
   no último mês da renovação.
6. **Custódia fria.** Um termo em vigor ou agendado mantém a organização
   quente: o aviso de arquivamento e o congelamento recusam
   (`ARCHIVE_PAID_ACTIVE`, `coldArchive.ts`) até o termo terminar.

**Operador.** Um termo `scheduled` com `blockedCode` está pago e sem plano,
e os caminhos mensais recusam o período que ele cobre. O operador resolve a causa
(estoque, inventário, uso acima do plano) e chama
`plans:activateScheduledTerm` com o `termId`, que apaga `blockedCode` ao
ativar. Se não houver solução, o operador rescinde o termo
(`plans:rescindTerm`): nada foi usado, então o reembolso é integral, e ele
devolve o Pix à mão ([Rescisão do anual](#rescisão-do-anual)). Depois do seu `endsAt`, ele já não impede uma
nova venda anual. A leitura do
plano não olha os termos: entre o início do termo e a execução da tarefa
agendada, a organização fica com o plano anterior, já vencido. Os crons
estão desligados no perfil hospedado, então a mesma chamada é a conferência
manual de um termo cujo início passou sem ativação.

### Fatura anual do cartão

Uma fatura anual paga vira termo como a confirmação de um Pix anual. O
[Checkout anual](#checkout-anual) cria a assinatura que a gera.

- **Preços anuais.** Lookup keys `fnfe_plan_intermediate_annual_brl` e
  `fnfe_plan_large_annual_brl`, lidas na mesma consulta dos preços mensais
  (`readAnnualPrices`, `lib/billingStripe.ts`). Cada uma vale se o preço
  estiver ativo, em BRL, recorrente anual (`interval: year`,
  `interval_count: 1`), licenciado e com `unit_amount` igual a `annualCents`.
  A conferência é por tier e opcional: um preço anual ausente ou diferente
  não para o mensal. O Checkout anual daquele tier é recusado
  (`BILLING_UNAVAILABLE`), e a fatura anual daquele tier fica
  `PRICE_UNKNOWN`.
- **Primeira fatura.** O Checkout marca a assinatura
  (`subscription_data[metadata]`) com os campos do mensal mais
  `cycle: "annual"` (`ANNUAL_CYCLE` e `ourMetadata`, em
  `lib/billingStripe.ts`):
  - `organizationId`, a organização do Customer;
  - `kind: "start"`;
  - `tier`, `intermediate` ou `large`;
  - `grantCents`, igual a `annualCents`.

  Desde a fatia 2b, os metadados não levam `period`: o ano começa no
  pagamento, e a fatura diz qual é. A primeira cobrança é a fatura
  `subscription_create` do pagamento, que precisa cobrar exatamente
  `annualCents` e ter a linha no preço anual conferido do tier; ela é
  concedida como um termo novo. De R$ 0, se vier, fica `skipped`
  (`ZERO_AMOUNT`). Uma primeira cobrança com outro `billing_reason` fica
  `blocked` com `INVOICE_UNEXPECTED`: o dinheiro entrou, nenhum termo é
  criado, e o operador reembolsa pelo painel do Stripe ou resolve à mão e
  marca com `billing:resolveReview`.

  Uma linha com preço mensal numa fatura marcada anual, ou uma fatura
  mensal de uma assinatura anual, fica `INVOICE_UNEXPECTED`. As faturas
  `subscription_cycle` são reconhecidas só pelo preço anual da linha.

- **Ano da âncora** (invariante 6 da ADR 0012, metade anual). Cada fatura
  anual, a primeira e as renovações, só concede quando a linha anual cobre
  exatamente um ano do `billing_cycle_anchor` da assinatura:
  `[addMonths(âncora, 12(n − 1)), addMonths(âncora, 12n))`, sempre contado
  da âncora (`anchorYear`, `lib/billingStripe.ts`). Assinada em 31/01/2027
  às 10:00:07 UTC, a assinatura cobra o 1º ano até 31/01/2028 no mesmo
  horário; uma de 29/02/2028 renova em 28/02/2029, 2030 e 2031 e em
  29/02/2032, e um ano contado do aniversário anterior (de 28/02/2031 a
  28/02/2032) fica `INVOICE_UNEXPECTED`. A âncora vem da reconciliação, como
  no mensal ([Período da fatura mensal](#período-da-fatura-mensal)): a
  assinatura fora da lista é lida pelo id, e uma âncora ainda desconhecida
  deixa a fatura sem registro (`ANCHOR_UNKNOWN`) até a conferência seguinte.
  Uma assinatura anual anterior à fatia 2b, ancorada no dia 1 às 00:00 UTC,
  continua renovando: os anos da âncora dela começam nesse dia 1.

- **Assinatura anual.** Uma assinatura é anual quando o preço do item tem
  uma lookup key anual ou cobrança anual, conferido ou não
  (`readSubscriptions`). Uma assinatura anual nunca passa a um preço
  mensal, que reiniciaria a âncora e cobraria na hora. Só passa a outro
  preço anual depois de um [upgrade](#upgrade-do-anual) pago, ou de volta
  ao preço anual anterior quando esse upgrade é desfeito em 7 dias, sempre
  com `billing_cycle_anchor: unchanged`. Com o preço anual
  sem conferência, a renovação fica `blocked` com `PRICE_UNKNOWN` e não é
  pesada de novo quando o preço volta a conferir (a deduplicação é por
  `invoiceId`): cada uma pede reembolso pelo painel do Stripe e
  `billing:resolveReview`. Uma assinatura mensal, mesmo a um preço que deixou de conferir,
  continua passando ao preço mensal conferido de `renewalTier`, como antes.
  O downgrade de uma assinatura anual é recusado (`PLAN_UNAVAILABLE`); ele
  virá na renovação, numa PR seguinte. "Não renovar" e "Retomar renovação"
  valem como no mensal. Com termos em vigor ou agendados, a retomada só é
  aceita quando todos foram comprados por esta assinatura anual
  (`stripeSubscriptionId` do termo), porque ela renova o próprio termo.
  Qualquer outro termo, como um anual por Pix agendado para o fim deste,
  recusa a retomada (`ANNUAL_TERM_ACTIVE`): a cobrança na âncora seria
  bloqueada por ele. A assinatura que comprou um termo rescindido também
  recusa a retomada (`ANNUAL_TERM_RESCINDED`).

- **Termo.** A fatura grava o termo do ano que a linha cobra, com
  `firstPeriod` no início da linha, `source: "stripe"`,
  `references: [id da fatura]`, `stripeSubscriptionId` (a assinatura da
  fatura), `anchor` (a âncora da assinatura, quando o termo não começa
  nela), `paidCents` e `purchasedAt` no pagamento
  (`status_transitions.paid_at`; sem ele, a leitura). O plano é concedido na
  hora até o fim do termo, com auditoria `stripe:{in_…}` e `periodAnchor`
  igual à âncora, e a admissão é reservada nessa concessão, como no mensal
  (`startTerm`, `allocatePlan`). Um mensal em vigor do mesmo tier ou menor,
  pelo cartão ou pelo Pix, é substituído na hora, sem desconto dos dias
  restantes (um plano pago por vez). O Stripe cobra a renovação no
  aniversário, que é o fim do termo: o termo novo vai do fim do anterior até
  12 meses da âncora depois, sem intervalo entre os termos e sem nova
  reserva, e o termo anterior não o bloqueia. O plano é concedido no
  pagamento: entre o fim do termo anterior e o pagamento não há plano em
  vigor, como na renovação mensal. Uma renovação paga antes do aniversário,
  o que é incomum, fica `scheduled` até ele, e
  `plans:activateScheduledTerm` a ativa. A concessão (`billingGrants`)
  guarda `tier`, `period` (a chave canônica do início do termo, como
  `2027-01-31T10:00:07.000Z`) e `termId`; a deduplicação por `invoiceId`
  garante um termo por fatura, em qualquer ordem e repetição. Uma
  conferência fica agendada duas horas depois do fim do termo.
- **Interruptor.** A fatura anual paga vale com o interruptor desligado: ele
  para a venda nova, e o dinheiro já entrou. A admissão (`allocateOffer`)
  continua valendo.
- **Bloqueios.** Ficam `blocked`, sem termo, para uma pessoa:
  - `LATE_PAYMENT`: paga depois do 1º mês do termo, como o prazo do Pix;
  - `ANNUAL_TERM_ACTIVE`: outro termo cobre o início do termo ou já há um
    termo agendado (`annualTermBlocks`);
  - `ANNUAL_TERM_RESCINDED`: a assinatura comprou um termo rescindido e
    devia ter sido cancelada (`billing:stopTermRenewal`); a cobrança não vira
    termo e espera reembolso;
  - `PLAN_UNAVAILABLE`: um plano mensal maior em vigor, porque o downgrade
    só vale na renovação (o Checkout recusa essa venda antes); ou a recusa
    de admissão. Desde a fatia 2b, uma recusa da admissão depois do
    pagamento vira reembolso manual (ADR 0012, Consequências);
  - `INVOICE_UNEXPECTED`: a linha anual que não é um ano da âncora, um ano
    que começa depois do fim do mês da âncora em curso (uma renovação paga
    mais de um mês antes), o id da fatura fora do formato de referência do
    termo ou a primeira fatura sem linha no preço anual conferido do tier;
  - os demais códigos de [Como uma fatura vira plano](#como-uma-fatura-vira-plano)
    (`AMOUNT_MISMATCH`, `PRICE_UNKNOWN`, `CURRENCY_MISMATCH`,
    `ORGANIZATION_MISMATCH`, `ORGANIZATION_CLOSED`, `PLAN_CUSTOM` e as
    recusas de admissão).

  Uma fatura anual bloqueada não tem plano a ajustar: o operador reembolsa
  pelo painel do Stripe e marca com `billing:resolveReview`.

  **Primeira fatura bloqueada.** Uma fatura `subscription_create` de uma
  assinatura anual que fica `blocked` cobrou um ano que não virou termo, e a
  assinatura cobraria de novo no aniversário. A concessão grava
  `subscriptionStop` (`pending`) e agenda `billing:stopBlockedAnnual`, que lê
  a assinatura pelo id e a cancela na hora (`DELETE`, sem pró-rata nem
  crédito) se ainda for do Customer e não tiver terminado; o reembolso
  continua manual. Uma falha do Stripe é repetida 5 vezes, com espera
  crescente a partir de 15 minutos, como na rescisão; esgotadas, a parada
  fica `failed`. Até ficar `done`, `billing:overview` mostra, além da fatura
  bloqueada, `SUBSCRIPTION_STOP_PENDING` ou `SUBSCRIPTION_STOP_FAILED`
  (`source: "grant"`). O operador repete com
  `bunx convex run billing:stopBlockedAnnual` e `organizationId`, `grantId`
  e `attempt: 0`. Nada é cancelado quando a assinatura já comprou um termo
  em vigor ou agendado, como numa segunda cobrança do ano já concedido: ela
  renova esse termo.

  Uma renovação agendada pode ser recusada no início (admissão, `TERM_ENDED`)
  enquanto a concessão da fatura continua `applied`: a recusa fica no
  `blockedCode` do termo (`termId` na concessão), e o operador a trata como
  na [venda por Pix](#venda-por-pix).

### Checkout anual

`billing:checkout` com `cycle: "annual"` abre o Checkout do anual; sem
`cycle`, continua o mensal. Desde a fatia 2b da
[ADR 0012](../adr/0012-periodo-por-aniversario.md), o anual no cartão é
cobrado e começa na contratação (segunda decisão do dono, de 03/11/2026): o
Stripe cobra o 1º ano no pagamento, ancora a assinatura nesse instante
(`billing_cycle_anchor`) e a renova a cada aniversário dela. Papéis,
membership, chave de idempotência e admissão (`allocateOffer`, conferida sem
reservar) são os do mensal. O servidor cobra `annualCents` integral, sem
desconto de um mês já pago. A reserva vem quando a primeira fatura é
concedida, como no mensal ([Fatura anual do cartão](#fatura-anual-do-cartão)).

A sessão, em modo `subscription`, tem só o preço anual do tier, sem âncora
no dia 1, item avulso, período de teste, cupom nem `proration_behavior`, e
vale 24 horas. Os metadados não levam `period`, e a linha de
`billingCheckouts` também não; `billing:overview` devolve `periodStartsAt`
nulo para ela. A conclusão da sessão só libera a vaga: não concede, não
reserva nem agenda nada. O termo nasce da fatura paga, mesmo que o
interruptor tenha sido desligado depois da venda.

Um plano pago por vez (ADR 0012): com um mensal em vigor do mesmo tier ou
menor, pelo cartão ou pelo Pix, o anual é vendido e substitui esse mensal na
hora, sem desconto dos dias restantes. Se o mensal é do cartão, o cliente
usa antes "Cancelar renovação" (`SUBSCRIPTION_RENEWING` até lá), e a
assinatura mensal termina no fim do período pago, sem cobrar de novo. Não
há início adiado.

Recusas, todas antes de qualquer chamada ao Stripe:

- `ANNUAL_DISABLED`: o interruptor está desligado. A repetição de uma
  sessão já aberta, pela mesma chave, continua respondendo;
- `ANNUAL_TERM_ACTIVE`: há um termo em vigor ou agendado, de qualquer
  forma de pagamento e mesmo no último mês dele, com `availableAt` no fim
  do último (`termsEnd`). O anual no cartão abre uma cadeia nova e não
  começa depois de um termo Pix, e o termo do cartão renova pela própria
  assinatura;
- `PLAN_REQUEST_PENDING`: há pedido Pix aguardando pagamento;
- `CHECKOUT_PENDING`: há outro Checkout aberto;
- `PAYMENT_METHOD_PIX`: há uma renovação mensal Pix já paga e não começada,
  com `availableAt` no início dela;
- `SUBSCRIPTION_RENEWING`: uma assinatura por cartão, mensal ou anual,
  ainda renova, e o cliente precisa usar "Não renovar" antes. O servidor
  não cancela a renovação por conta própria: um Checkout abandonado
  deixaria a organização sem renovação, e uma repetição no meio dessa troca
  poderia cobrar duas vezes;
- `PLAN_UNAVAILABLE`: plano personalizado ou admissão fechada; um mensal
  maior em vigor, como o Intermediário anual sobre o Grande mensal, com
  `availableAt` no fim dele, porque o downgrade só vale na renovação; ou o
  acesso deixado por um termo rescindido, com `availableAt` no fim desse
  acesso;
- as demais recusas de `allocateOffer`, com o código dela: catálogo
  desligado (`PLANS_DISABLED`), inventário de capacidade ausente
  (`CAPACITY_INVENTORY_REQUIRED`) ou uso acima do plano (`QUOTA_EXCEEDED`);
- `OPERATION_CONFLICT`: a mesma chave com outro tier ou ciclo.

Sem o preço anual conferido do tier, a vaga é liberada e a resposta é
`BILLING_UNAVAILABLE`, sem sessão. O Checkout mensal não faz upgrade de
uma assinatura anual (`PLAN_UNAVAILABLE`); o upgrade do anual é
`start: "upgrade"` ([Upgrade do anual](#upgrade-do-anual)).

O retorno do navegador não concede nada: a fatura paga cria o termo, e a
reconciliação grava a assinatura como anual (`subscription.annual`) e só
troca o preço dela depois de um upgrade.

Entre o pagamento e a concessão, a admissão pode recusar (catálogo
desligado, uso acima do tier, inventário, arquivamento, janela fechada para
uma reserva nova): a fatura fica `blocked` com o código, a assinatura é
cancelada antes de cobrar de novo
([Primeira fatura bloqueada](#fatura-anual-do-cartão)), e o reembolso é
manual, pelo painel do Stripe. Os termos de uso 1.0 e 1.1 dizem que a
contratação recusada antes do início é cancelada sem cobrança; a versão nova
dos termos precisa dizer isso antes de o anual ser ligado (ADR 0012,
Consequências).

**Antes de ligar o anual, confira todos os itens abaixo.** A matriz de
sandbox, refeita com relógios de teste
([Prova hospedada e ativação do anual](#prova-hospedada-e-ativação-do-anual-35)),
registra os resultados externos e as pendências; os testes de integração usam
Stripe simulado:

- a sessão só com o preço anual, sem âncora, cobra `annualCents` no
  pagamento e gera uma fatura `subscription_create` paga, com a linha anual
  do instante do pagamento, truncado ao segundo, ao mesmo dia e horário do
  ano seguinte, e a assinatura traz `billing_cycle_anchor` nesse instante;
- com relógios de teste em 31/01, 31/03 e 29/02, as renovações caem nos
  anos da âncora: 31/01 no ano seguinte, 31/03 e, para 29/02, 28/02 nos três
  anos seguintes e 29/02 no quarto, cada uma como `subscription_cycle` com
  a linha de exatamente um ano da âncora;
- o portal não deixa o cliente reativar a assinatura mensal antiga, já com
  "Não renovar". Reativada, ela e a anual cobrariam, e o servidor só
  sinalizaria `SUBSCRIPTION_DUPLICATE`.

**Proteção do portal conferida no sandbox em 31/10/2026:** com troca de
plano desativada e cancelamento ao fim do período habilitado, "Don't cancel
subscription" reativou o mensal antigo mesmo com uma assinatura anual já
criada. Por isso, o portal deve permitir apenas cartão e faturas, com
cancelamento e troca de plano desativados. O servidor confere a configuração
expandida da sessão antes de entregar sua URL e recusa configuração ausente,
inativa, de outro ambiente ou incompatível. Cancelamento e retomada passam
pelo console. A prova antes e depois
confirmou que a configuração corrigida não oferece retomada do mensal antigo.

Até a fatia 2b, o Checkout anual ancorava a assinatura no dia 1 seguinte,
não cobrava nada na sessão e reservava a admissão na conclusão, com uma
reconferência agendada seis horas antes da âncora e o cancelamento da
assinatura recusada. Essa máquina saiu do código; as linhas antigas de
`billingCheckouts` podem ter `subscriptionId` e `admission`, que nada lê, e
uma recusa antiga deixa de aparecer em `billing:overview`. Os nomes das
tarefas que ela agendava (`billing:recheckAnnualAdmission`,
`billing:stopRefusedAnnual` e `billing:retryAnnualStop`) continuam como
funções internas que só registram `billing.legacyAnnual` no log e não fazem
nada, para que uma tarefa ainda na fila de um deployment de sandbox ou de
validação não falhe. Uma assinatura recusada desse formato que ainda renove
é cancelada à mão no painel do Stripe. O catálogo e o anual nunca foram
ligados em produção, então nenhuma assinatura desse formato existe fora do
sandbox.

### Upgrade do anual

O Intermediário anual sobe para o Grande anual no meio do termo (ADR 0010,
decisão 9, e decisão do dono de 30/10/2026). O pedido é o do anual, com
`cycle: "annual"` e `start: "upgrade"`: em `plans:requestPaid` no Pix e em
`billing:checkout` no cartão. Cada termo sobe pela forma que o pagou, e a
regra é a mesma nas duas:

- **Preço.** (R$ 4.990 − R$ 1.490) × meses restantes / 12, com o mês
  corrente contado inteiro e o total arredondado para baixo uma vez
  (`termUpgradeCents`, `lib/planTerms.ts`). Do 2º ao 12º mês, R$ 3.208,33 a
  R$ 291,66; no 1º mês, R$ 3.500. O mês do termo da compra, contado da
  âncora da cadeia, fixa o preço: o pedido Pix vence no fim desse mês do
  termo, e o Checkout expira 5 minutos antes dele.
- **Termo.** `upgradeTerm` (`lib/planCore.ts`) abre um segmento do Grande a
  partir do início do mês corrente do termo (`termMonth`, contado da âncora
  da cadeia); no 1º mês, que o upgrade cobre inteiro, troca o `tier` do
  termo. Num termo de 10/10 às 12:00 UTC, pelo Pix ou pelo cartão, um
  upgrade pedido em 11/02 vale desde 10/02 às 12:00 UTC e vence em 10/03 às
  12:00 UTC. `endsAt`, a
  data de renovação e `purchasedAt` não mudam. A cobrança entra em
  `references`, em `paidCents` e em `upgrades`.
- **Aporte.** O plano sobe por `activateCatalogPlan`, cujo `allocatePlan`
  reserva, na mesma transação e antes de conceder, o estoque do Grande e a
  diferença do aporte de custódia, de R$ 108 para R$ 280: os R$ 172 que a
  Freecorps complementa ([custódia](PLATFORM-PLAN-PROPOSAL.md#custódia-e-subsídio-antes-da-admissão)).
  O orçamento de custódia (`platformPlanSettings.custodyCents`), o estoque e
  a janela de admissão precisam comportar a reserva; senão, nada sobe.
- **Renovação.** Passa a ser do Grande anual. No cartão, a assinatura muda
  de preço; no Pix, com o [interruptor do Pix](#interruptor-do-pix) ligado,
  o cliente pede a renovação (`renewal`) no último mês do termo e pode
  descer para o Intermediário nela, porque o downgrade vale na renovação.
- **Downgrade.** Continua recusado no meio do termo: o Intermediário num
  termo já Grande responde `PLAN_UNAVAILABLE`, e a assinatura anual não
  desce de preço (`billing:changeRenewal`). A exceção é o upgrade desfeito
  pelo operador em 7 dias ([Rescisão do anual](#rescisão-do-anual)).

Recusas, as mesmas nas duas formas e antes de qualquer chamada ao Stripe:

- `ANNUAL_DISABLED`: o interruptor está desligado, como nas outras vendas
  anuais. A repetição pela mesma chave continua respondendo;
- `ANNUAL_TERM_REQUIRED`: nenhum termo `active` cobre o instante do pedido;
- `ANNUAL_TERM_SCHEDULED`: há um termo `scheduled` não terminado, seja o
  próprio termo ainda não começado, seja a renovação já paga do termo em
  vigor. O termo agendado sobe depois de começar; a renovação foi paga pelo
  tier dela, e o termo que ela segue não sobe mais;
- `PLAN_UNAVAILABLE`: o termo já tem o tier pedido ou maior, o plano é
  personalizado ou a admissão recusa a nova reserva;
- `PLAN_REQUEST_PENDING`, `CHECKOUT_PENDING` e `PAYMENT_METHOD_CARD`, como
  nas outras vendas;
- `OPERATION_CONFLICT`: a mesma chave com outra escolha;
- as demais recusas de `allocateOffer` (`PLANS_DISABLED`,
  `CAPACITY_INVENTORY_REQUIRED`, `QUOTA_EXCEEDED`).

Só no Pix, com o Pix desligado, o pedido de upgrade responde `PIX_DISABLED`
depois de `ANNUAL_DISABLED` ([interruptor do Pix](#interruptor-do-pix)).

**Pix.** O pedido guarda `termId`, `firstPeriod` (o início do mês corrente
do termo) e a diferença em `amountCents`, e vence no fim desse mês do termo
(`endsAt`), não na virada do mês civil. Não reserva nada. Um termo pago pelo
cartão recusa o pedido com `PAYMENT_METHOD_CARD`.
O operador confere o Pix e chama `plans:confirmPayment`, como nos outros
pedidos. A confirmação exige que o termo ainda seja o pedido, no mesmo mês
do termo e pelo mesmo preço (`PLAN_REQUEST_UNAVAILABLE` ou
`OPERATION_CONFLICT`) e que o plano não tenha mudado desde o pedido
(`OPERATION_CONFLICT`). Uma recusa da admissão não grava nada: o pedido
continua aguardando, e o operador resolve a causa e confirma de novo dentro
do mês do termo, ou devolve o Pix e cancela o pedido. Repetir a confirmação
não sobe o termo duas vezes.

**Cartão.** Só o termo `stripe` cuja assinatura anual é a da conta sobe
pelo cartão. Um termo Pix recusa com `PAYMENT_METHOD_PIX`, e uma assinatura
encerrada ou diferente da do termo, com `SUBSCRIPTION_REQUIRED`. Uma
assinatura com "Não renovar" aceita o upgrade, que vale até o fim do termo.
Os 45 minutos antes do fim do mês do termo recusam com `PERIOD_CLOSING` e
`availableAt` no início do mês seguinte (`PERIOD_CLOSING_MARGIN`), como o
upgrade mensal, porque o preço muda com o mês; a virada do mês civil não
conta. As últimas 72 horas do termo também recusam com `PERIOD_CLOSING`, sem
data (`UPGRADE_SWITCH_MARGIN`, `lib/billingCore.ts`): a sessão expira em até
24 horas, então o pagamento deixa pelo menos 48 horas para a troca de preço
chegar ao Stripe antes do aniversário. Depois dele, o termo novo sobe no 1º
mês dele. Pelo Pix, o último mês inteiro continua aceito, porque a
renovação Pix é um pedido à parte.

- **Sessão.** Modo `payment`, como o upgrade mensal: um item avulso com a
  diferença e fatura pós-compra (`invoice_creation`), com os metadados
  `kind: "upgrade"`, `cycle: "annual"`, `tier`, `period` (a chave canônica
  do início do mês do termo, como `2027-02-10T12:00:00.000Z`; num termo
  anterior à fatia 2b, do dia 1, `AAAA-MM`) e `grantCents`. O item avulso
  diz o início desse mês em UTC. Exige o preço anual conferido do tier
  pedido; sem ele, `BILLING_UNAVAILABLE`, sem sessão. `billing:overview`
  devolve esse início em `periodStartsAt`.
- **Fatura paga.** Pesada uma vez por `invoiceId`, como as outras. Aplicada,
  sobe o termo, grava a concessão com `termId` e a versão do plano e muda
  `renewalTier` da conta. Fica `blocked`, sem mexer no termo nem no plano,
  com:
  - `LATE_PAYMENT`, paga depois do mês do termo que comprou, contado da
    âncora da cadeia, mesmo num termo que já terminou;
  - `INVOICE_UNEXPECTED`, `period` que não é o início de um mês do termo;
  - `AMOUNT_MISMATCH`, valor diferente do preço do termo naquele mês;
  - `DUPLICATE_PAYMENT`, termo que já tem o tier;
  - `ANNUAL_TERM_REQUIRED` e `ANNUAL_TERM_SCHEDULED`, sem o termo de cartão
    daquele mês em vigor;
  - `SUBSCRIPTION_REQUIRED`, termo cuja assinatura não é uma assinatura
    anual deste Customer, neste modo;
  - `PRICE_UNKNOWN`, sem o preço anual conferido do tier;
  - os demais códigos da [fatura anual](#fatura-anual-do-cartão),
    inclusive as recusas da admissão.

  Uma fatura bloqueada pede reembolso pelo painel do Stripe e
  `billing:resolveReview`.

- **Troca de preço.** A reconciliação passa o item da assinatura anual ao
  preço anual do novo tier, com `proration_behavior: none` e
  `billing_cycle_anchor: unchanged`, e com chave de idempotência. A troca só
  sobe, de um preço anual conferido para outro, e só quando um termo
  comprado por essa assinatura já tem o tier de `renewalTier` no mês
  corrente. A cobrança no aniversário é então do Grande anual e cria um
  termo do Grande, sem intervalo e sem nova reserva. Com "Não renovar", a
  troca espera a retomada.
- **Renovação abaixo do upgrade.** Se a troca não chegou ao Stripe antes da
  âncora (falha da API, evento perdido), a renovação sai pelo Intermediário
  anual. O dinheiro entrou por esse preço, então a fatura vira um termo do
  Intermediário, mas a concessão fica `applied` com `RENEWAL_BELOW_UPGRADE`
  e aparece em `billing:overview` (`reviews`) até `billing:resolveReview`.
  A conta passa a renovar pelo Intermediário. Se a troca chegou ao Stripe
  depois da fatura, a assinatura já está no Grande e renova por ele no ano
  seguinte; quem resolve confere o preço atual da assinatura no Stripe. Uma
  pessoa combina com o cliente: o upgrade no 1º mês do termo novo (a
  diferença cheia) ou o reembolso.

**Arrependimento e rescisão.** O upgrade pode ser desfeito em 7 dias, e a
rescisão pesa os meses pelo tier de cada um
([Rescisão do anual](#rescisão-do-anual)).

**Antes de ligar o anual, confira todos os itens abaixo.** A
matriz de sandbox registra os
resultados externos e as pendências; os testes de integração usam Stripe simulado:

- a sessão em modo `payment` com `invoice_creation` gera uma fatura paga sem
  assinatura, com os metadados de `invoice_data` e `status_transitions.paid_at`;
- a troca de preço de uma assinatura anual para outro preço anual, com
  `proration_behavior: none` e `billing_cycle_anchor: unchanged`, não cobra
  nada na hora, não gera fatura de pró-rata e mantém `current_period_end`;
- a renovação seguinte cai na mesma âncora, com a linha no preço anual do
  Grande;
- uma troca feita até 48 horas antes da âncora chega antes de o Stripe
  gerar a fatura da renovação. Se não chegar, a renovação fica com
  `RENEWAL_BELOW_UPGRADE` para uma pessoa;
- a lista de assinaturas devolve o preço do item expandido, com a lookup key
  anual, depois da troca;
- a volta ao preço anual do Intermediário depois de um upgrade desfeito, com
  `proration_behavior: none` e `billing_cycle_anchor: unchanged`, também não
  cobra nem credita nada na hora e mantém `current_period_end`, e a
  renovação seguinte sai pelo Intermediário anual.

### Rescisão do anual

Há duas formas de deixar o anual (ADR 0010, decisão 9, e decisão do dono de
30/10/2026). "Não renovar" é do cliente, sem reembolso e com os meses pagos
mantidos: no cartão, `billing:changeRenewal` com `cancel`; no Pix, basta não
pedir a renovação. "Rescindir" passa pelo suporte. O operador chama
`plans:rescindTerm`, o servidor calcula o reembolso e o grava no termo, e o
operador devolve o dinheiro à mão, por reembolso no painel do Stripe ou por
Pix. A plataforma nunca chama a API de reembolso do Stripe.

As três funções são internas (`internalMutation`), como as outras ações do
operador, e recebem `actor` (login do GitHub de quem age, como no gate da
emissão) e, nas duas primeiras, `key` (8 a 100 caracteres
`[a-zA-Z0-9_-]`) e `reason` (10 a 500 caracteres). Fora disso,
`INVALID_REQUEST`.

**Reembolso** (`termRescission`, `lib/planTerms.ts`, sobre
`rescissionCents`, `lib/annualTerms.ts`, em centavos inteiros):

- **Até 7 × 24 h de `purchasedAt`**, o pagamento da cobrança anual do termo,
  inclusive de uma renovação: tudo o que o termo recebeu (`paidCents`), e o
  acesso termina na hora.
- **Depois**: `paidCents` menos cada mês usado, o corrente contado inteiro,
  pelo preço mensal cheio do tier que o termo tinha nesse mês (o segmento do
  upgrade ou `tier`), nunca negativo. O acesso vai até o fim do mês corrente
  do termo (`termMonth`, contado da âncora da cadeia), ou até o fim do
  termo, se for antes; num termo do dia 1, é o fim do mês civil. Um
  Intermediário anual de 10/10 às 12:00 UTC rescindido em 15/01 está no 4º
  mês e mantém o acesso até 10/02 às 12:00 UTC. Exemplos:
  - Intermediário anual rescindido no 4º mês: R$ 1.490 − 4 × R$ 149 =
    R$ 894;
  - upgrade no 5º mês por R$ 2.333,33 e rescisão no 8º: R$ 3.823,33 −
    (4 × R$ 149 + 4 × R$ 499) = R$ 1.231,33;
  - a partir do 10º mês, zero.
- **Termo ainda não começado**, como uma renovação agendada, ou ainda
  `scheduled` depois do início porque a ativação foi recusada
  (`blockedCode`): nada foi usado, o reembolso é integral e não há acesso a
  encerrar.

**Upgrade desfeito em 7 dias.** O arrependimento vale também para a
cobrança de upgrade (decisão do dono de 31/10/2026, na decisão 9 da ADR; a
revisão jurídica da etapa D4 confirma, como nas renovações).
`plans:undoTermUpgrade` desfaz o último upgrade do
termo enquanto o pagamento dele (`paidAt`) está a até 7 × 24 h; depois,
`WITHDRAWAL_ENDED`, e sem upgrade, `UPGRADE_NOT_FOUND`. É uma ação separada
porque o termo continua, com as próprias regras:

- a cobrança volta inteira (`refundCents` igual ao `paidCents` do upgrade);
- o termo volta ao tier anterior: o segmento sai, ou, no 1º mês, `tier`
  volta a `fromTier`. A cobrança sai de `upgrades` e de `paidCents`, fica em
  `references`, para a referência nunca ser usada de novo, e passa a
  `undoneUpgrades`, com quem desfez, o motivo, o momento, a chave e a ação
  que desfez (`via`: `undo` ou `rescission`);
- o plano em vigor desce ao tier anterior até o fim do termo;
- no cartão, `renewalTier` da conta volta ao tier anterior, e a
  reconciliação passa a assinatura anual de volta ao preço anual dele, com
  `proration_behavior: none` e `billing_cycle_anchor: unchanged`. É a única
  troca para baixo que ela faz, e só para um termo dessa assinatura com o
  upgrade desfeito. A renovação volta a ser do Intermediário anual. Depois
  do fim do termo, a renovação já foi cobrada: `renewalTier` não muda, e o
  plano em vigor, que é o do termo novo, também não; o reembolso é só o da
  cobrança do upgrade.

Uma rescisão feita nos 7 dias de um upgrade, fora dos 7 dias da cobrança
anual, desfaz esse upgrade antes, do mesmo jeito, e calcula sobre o termo
sem ele. O cliente recebe o upgrade inteiro e os meses voltam ao preço do
Intermediário, o que nunca dá menos que manter o upgrade.

**O que a rescisão faz**, na mesma transação:

- grava em `rescission` a chave, quem, o motivo, o momento, `withdrawal`,
  `usedMonths`, `usedCents`, `refundCents` e `accessEndsAt`, e marca o termo
  `rescinded`. `endsAt` não muda;
- reescreve a linha de `usagePlans` concedida pelo termo, com auditoria em
  `usagePlanAudit`: `endsAt` passa a `accessEndsAt`, e uma conferência
  (`plans:refreshExpiry`) fica agendada para esse momento. No fim, o plano
  termina como qualquer plano vencido: a organização fica sem plano em
  vigor, não volta sozinha ao Gratuito;
- rescinde junto a renovação agendada do termo, já paga e sem uso, com
  reembolso integral e `after` apontando o termo. Assim nenhum termo
  sobra para renovar, e `plans:activateScheduledTerm` não a ativa;
- cancela o pedido Pix anual que aguarda pagamento, como uma renovação
  (`renewal`) ou um upgrade;
- expira o Checkout de upgrade aberto, como `billing:abandonCheckout`: a
  linha passa a `expired` na hora, e `billing:expireCheckout` expira a sessão
  no Stripe. Um pagamento que ainda passe não sobe o termo, que já não está
  em vigor, e fica `blocked` para uma pessoa;
- no cartão, agenda `billing:stopTermRenewal`, que lê a assinatura que
  comprou o termo pelo id (`GET /v1/subscriptions/{id}`), a cancela na hora
  se ainda for do Customer e não tiver terminado (`DELETE`, sem pró-rata nem
  fatura) e reconcilia. Uma falha do Stripe é repetida 5 vezes, com espera
  crescente a partir de 15 minutos, como no encerramento. Esgotadas, o termo
  rescindido fica com `rescission.renewalStopFailed`, que aparece em
  `billing:overview` (`reviews`, `source: "term"`,
  `SUBSCRIPTION_STOP_FAILED`). O operador repete à mão com
  `bunx convex run billing:stopTermRenewal` e `organizationId`,
  `subscriptionId` e `attempt: 0`; o cancelamento bem-sucedido apaga a
  marca. Se a assinatura ainda cobrar uma renovação, a fatura fica
  `blocked` com `ANNUAL_TERM_RESCINDED`, e a retomada é recusada com o
  mesmo código.

**Estoque e custódia.** A reserva da organização
(`platformPlanAllocations`) não muda na rescisão, no upgrade desfeito nem no
fim do plano. É o que já acontece no vencimento, no downgrade e no
encerramento: `allocateOffer` só aumenta a reserva, e só o expurgo legal
(`purgePlanRecords`) devolve arquivos e banco. O aporte de custódia não
volta. Os dados já guardados continuam ocupando o estoque, e nada é apagado
para caber no tier menor; acima dele, as guardas de capacidade recusam
entradas novas, como depois de qualquer downgrade.

**Repetição e recusas.** A mesma `key` responde a mesma rescisão ou o
mesmo upgrade desfeito, sem gravar nada, mesmo com outro `actor` ou
`reason`. A chave é da ação: a de uma rescisão usada para desfazer um
upgrade do termo, ou o contrário, é `OPERATION_CONFLICT`. Recusas:

- `TERM_RESCINDED`: termo já rescindido, com outra chave;
- `TERM_ENDED`: termo terminado (`endsAt` passou) ou `expired`;
- `NOT_FOUND`: termo inexistente.

Depois da rescisão, as guardas do anual deixam de valer: o owner volta a
encerrar a organização. Enquanto o acesso dura até o fim do mês do termo,
ele é o plano pago em vigor, e nenhuma venda nova entra, de qualquer tier:
o pedido Pix, mensal ou anual, e o Checkout mensal recusam com
`PLAN_UNAVAILABLE` e `availableAt` no fim do acesso, e uma fatura mensal
paga fica `blocked` com `ANNUAL_TERM_ACTIVE` (ADR 0012, um plano pago por
vez). Esse mês já foi pago e contado no reembolso. Depois dele, os caminhos
mensais e uma nova venda anual seguem as regras de sempre, com âncora nova.

**Devolução.** Depois de devolver o dinheiro, o operador chama
`plans:recordTermRefund` com `termId`, `amountCents`, `reference` (o
reembolso `re_…` do Stripe ou o identificador do Pix, no formato das
referências do termo) e `actor`; para um upgrade desfeito, também
`upgradeReference`, a referência da cobrança do upgrade. Uma chamada por
reembolso feito: no cartão, um reembolso não passa da fatura que devolve,
então o valor calculado pode precisar de um reembolso na fatura anual e
outro na do upgrade. Cada um fica em `refunds` (`cents`, `reference`,
`actor`, `at`), e a resposta traz `refundCents` (o devido) e
`refundedCents` (a soma registrada); a devolução está completa quando os
dois são iguais. Passar do devido é `AMOUNT_MISMATCH`, um reembolso zero
não é registrado (`REFUND_NOT_DUE`) e, sem rescisão ou upgrade desfeito, a
resposta é `NOT_FOUND`. A mesma `reference` com o mesmo valor não muda
nada; com outro valor, é `OPERATION_CONFLICT`. Um reembolso feito no painel
do Stripe também gera
`charge.refunded`, que continua só sinalizado em `billing:overview` até
`billing:resolveReview`.

**Antes de ligar o anual, confira todos os itens abaixo.** A
matriz de sandbox registra os
resultados externos e as pendências; os testes de integração usam Stripe simulado:

- `GET /v1/subscriptions/{id}` devolve `customer` como id e `status`, e
  `DELETE /v1/subscriptions/{id}` de uma assinatura anual cancela na hora,
  sem fatura de pró-rata nem crédito, e a lista de assinaturas a devolve
  `canceled`;
- `POST /v1/checkout/sessions/{id}/expire` de uma sessão de upgrade em
  modo `payment` impede o pagamento dela;
- o reembolso parcial de uma fatura anual pelo painel, no valor calculado,
  gera `charge.refunded` para o Customer.

Fica sem tratamento automático a volta de preço que não chega ao Stripe
antes da âncora (falha da API, ou upgrade desfeito nas últimas horas do
termo): a renovação sai pelo Grande anual e vira um termo do Grande, sem
sinalização, e a assinatura continua no Grande. Quem desfaz um upgrade perto
da âncora confere o preço da assinatura no Stripe depois da reconciliação.

### Tela do anual no console

Fica em Uso e limites (`apps/console/src/plans.tsx` e `plans-billing.tsx`),
só para owner e admin, como o resto da cobrança. O console mostra o que o
servidor calcula: `plans:overview` traz `annualEnabled`, o `annualCents` de
cada tier pago (só com o anual à venda), `annualStart` (como um anual novo
pelo Pix começa: `now`, `renewal` com `startsAt` e `endsAt`, ou recusado com
`code` e `availableAt`, por `pixAnnualStart`), `checkout` (há Checkout
aberto), os termos (`terms`, com `renewalFrom`, o início do último mês) e,
no pedido, `cycle`, `start`, `firstPeriod`, `periodStartsAt`, o início do
que o pedido compra (nulo no anual `now`, que começa na confirmação),
`periodEndsAt`, o fim do mês comprado, só no mensal, e `payBy`, o prazo de
pagamento. `billing:overview` traz
`annualEnabled`, `subscriptionTerm`, se a assinatura já comprou um termo em
vigor ou agendado, `annualBlocked`, se um termo em vigor ou agendado impede
o anual no cartão até o fim dele, e,
no Checkout aberto, `periodStartsAt`, o início do período que o upgrade
sobe, nulo num início, mensal ou anual, que começa no pagamento. O console
mostra esses instantes e não lê mais o `period` como `AAAA-MM`: pela
[ADR 0012](../adr/0012-periodo-por-aniversario.md#consequências), o `period`
do pedido Pix, da resposta de `plans:requestPaid` e do Checkout passou a ser
opcional nas funções do console, e só o console anterior a essa mudança o lê.

- **Interruptor.** Com o anual desligado, a tela não mostra o seletor, o
  preço anual nem os botões do anual no cartão. Um termo que já exista
  continua aparecendo.
- **Compra.** "Escolha seu plano" tem o seletor Mensal ou Anual, com o preço
  anual do catálogo e a economia sobre 12 mensalidades. O pedido Pix anual
  não tem escolha de início: a confirmação diz o que `annualStart` oferece,
  o início na confirmação do pagamento, com o pedido válido por 7 dias, ou
  a renovação do plano em vigor, do fim dele ao aniversário, com os
  instantes em UTC (`formatUtcInstant`). Recusado, o botão fica
  desabilitado com o motivo e a data em que o anual fica disponível. O
  pedido pendente mostra o início e o prazo de pagamento. Em Cobrança,
  "Assinar … anual no cartão" avisa que o ano é cobrado no pagamento e vai
  até o mesmo dia e horário do ano seguinte, em UTC, e que um mensal em
  vigor do mesmo plano ou menor é substituído na hora, sem desconto. O
  Checkout aberto mostra o valor cobrado agora e os 12 meses a partir do
  pagamento, sem "dia 1". Enquanto uma assinatura ainda renova, esse
  botão fica desabilitado até "Cancelar renovação", o "Não renovar" do
  console, e o aviso diz que o anual menor que o mensal em vigor espera o
  fim dele; a recusa do servidor mostra a data (`availableAt`).
- **Termo em vigor.** Com um termo em vigor ou agendado, a compra anual fica
  desabilitada, pelo Pix e pelo cartão, com o motivo e, no Pix, a data em
  que a renovação abre. No último mês do termo, o Pix aceita só a
  renovação, que começa no fim do termo, sem intervalo; o anual no cartão
  espera o fim do termo (`annualBlocked`), e as recusas do cartão também
  mostram a data em que a venda fica disponível.
- **Pedido vencido.** Passado `payBy`, o pedido aparece como "Prazo
  encerrado" (`expired`), não segura mais a compra e é substituído pelo
  pedido seguinte. Um pedido anual anterior à fatia 1b aparece com
  `start` `now` ou `next` e o dia 1 em que o termo começa
  (`startOf`); repetido pela mesma chave e confirmado, vale como foi
  pedido.
- **Termo.** Cada termo em vigor ou agendado, e o rescindido enquanto o
  acesso dura, mostra o tier, os upgrades (`segments`), a forma de
  pagamento, o início e o fim. `renews` diz se o termo do cartão ainda
  renova: a assinatura que o comprou está ativa e sem "Não renovar". Só
  então o fim aparece como data de renovação; senão, o termo diz que não
  renova. O termo Pix nunca renova sozinho e só fala no pedido do último mês,
  com a data em que ele abre (`renewalFrom`), com o anual e o Pix à venda.
  Um termo agendado com a ativação recusada aparece como
  "Início pendente". O reembolso calculado não aparece. Início, fim,
  segmentos e fim do acesso aparecem como instantes UTC
  (`formatUtcInstant`, `apps/console/src/format.ts`).
- **Upgrade.** Com o anual à venda e sem termo agendado, o termo `active`
  que cobre o instante traz `upgrade`: o preço de `termUpgradeCents`, os
  meses restantes, `from` e `until`, o início e o fim do mês corrente do
  termo, que é o prazo do pedido Pix, e, no cartão, `cardUntil`, 72 horas
  antes do fim. "Mudar para
  Grande anual" registra o pedido Pix ou abre o Checkout, conforme a forma
  de pagamento do termo, e fica desabilitado no cartão a partir de
  `cardUntil`. A confirmação só promete a renovação no Grande anual quando
  o termo renova. O pedido Pix de upgrade aparece como "Mudança
  solicitada", com o valor da diferença, e o Checkout de upgrade aberto,
  como a cobrança da mudança, não como um anual novo. Quando o Checkout some
  (concluído ou abandonado em "Desistir"), a próxima tentativa usa uma nova
  chave de idempotência.
- **Rescisão.** Não há botão para o cliente. O termo diz que "Rescindir"
  passa pelo suporte e resume a regra: integral em 7 dias; depois, o total
  pago menos os meses usados pelo preço mensal cheio. "Cancelar renovação"
  de uma assinatura anual mantém os meses pagos e mostra o fim do plano como
  instante UTC.
- **Pendências.** Um termo e a renovação agendada, rescindidos juntos e com
  o cancelamento da mesma assinatura falhando, aparecem como um só
  `SUBSCRIPTION_STOP_FAILED` em `billing:overview`. Desde a fatia 2b não há
  mais pendência de Checkout (`source: "checkout"`): uma recusa do anual
  depois do pagamento é uma fatura `blocked`, como as outras, e a parada da
  assinatura dela aparece como "Cancelamento em andamento" ou "pendente no
  Stripe da assinatura anual cuja cobrança não virou plano". Enquanto a
  assinatura anual não tem termo (`subscriptionTerm` falso), a próxima
  cobrança diz que a cobrança anual está em confirmação ou em análise, e
  "Cancelar renovação" não promete meses pagos.

## Eventos e reconciliação

`POST /v1/billing/stripe/events` confere `Stripe-Signature` contra
`STRIPE_BILLING_WEBHOOK_SECRET` (tolerância de 5 minutos), lê só os seletores
(id, tipo, modo, Customer, cobrança) e registra o evento uma vez por id. A
resposta é 200 depois do registro; 400 para assinatura ou corpo inválido; 404
sem cobrança configurada; 413 acima de 1 MB. Tipos fora da lista recebem 200 e
não são gravados. Evento de outro modo (teste num deployment real, ou o
contrário) fica `ignored` com `LIVEMODE_MISMATCH`.

O processamento não confia no conteúdo do evento: lê de novo assinaturas,
faturas e sessões abertas do Customer pela API (versão fixada
`2025-03-31.basil`) e aplica o estado atual. Por isso:

- **Repetido:** o id do evento e o id da fatura deduplicam.
- **Fora de ordem ou atrasado:** o estado é o atual; uma fatura antiga não
  encurta um plano mais novo.
- **Timeout ou falha do Stripe:** o evento fica `received` e tenta de novo com
  espera crescente (1 min, 4 min, 16 min… até 6 h), até 8 tentativas, e então
  `failed`. Criação de Customer, Checkout e troca de preço usam chave de
  idempotência, então repetir depois de um timeout não cria outro objeto.
- **Entrega perdida:** uma conferência é agendada duas horas depois do fim de
  cada mês pago, e "Conferir pagamento" no console (limitado a 5 por minuto)
  lê o Stripe a qualquer momento.

Eventos assinados: `checkout.session.completed`, `checkout.session.expired`,
`invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created` e
`charge.dispute.closed`.

### Operador

- `billing:resolveReview` com `eventId` ou `grantId` e `actor` marca uma
  pendência como tratada fora da plataforma (reembolso, ajuste manual). Vale
  para concessões `blocked` e para as `applied` com `RENEWAL_BELOW_UPGRADE`.
- O plano de um pagamento bloqueado é ajustado pelos caminhos existentes
  (`usage:assignPlan`, `plans:confirmPayment`), nunca editando `billingGrants`.
  Uma fatura de cartão bloqueada com `ANNUAL_TERM_ACTIVE` não tem plano a
  ajustar, porque esses caminhos também recusam o mês coberto: o operador
  reembolsa pelo painel do Stripe e marca com `billing:resolveReview`.
- A primeira fatura anual bloqueada para a assinatura sozinha
  (`billing:stopBlockedAnnual`). Com `SUBSCRIPTION_STOP_FAILED`, o operador
  repete a ação com `organizationId`, `grantId` e `attempt: 0`; depois do
  cancelamento, reembolsa pelo painel do Stripe e marca a fatura com
  `billing:resolveReview` (`grantId`)
  ([Primeira fatura bloqueada](#fatura-anual-do-cartão)).
- A rescisão do anual, o upgrade desfeito em 7 dias e o registro da
  devolução são `plans:rescindTerm`, `plans:undoTermUpgrade` e
  `plans:recordTermRefund` ([Rescisão do anual](#rescisão-do-anual)).

## Configuração

Variáveis do deployment Convex, as duas juntas ou nenhuma:

| Variável                        | Valor                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `STRIPE_BILLING_SECRET_KEY`     | Chave restrita (`rk_…`) ou secreta (`sk_…`). Chave `live` só no perfil `installation`. |
| `STRIPE_BILLING_WEBHOOK_SECRET` | `whsec_…` do endpoint `https://api.nfe.freecorps.com.br/v1/billing/stripe/events`.     |

Configuração parcial ou inválida derruba as funções de cobrança com
`Invalid platform configuration: STRIPE_BILLING`; a tela trata como cartão
indisponível, e o Pix, se ligado, continua. A chave restrita precisa de escrita em
Customers, Checkout Sessions, Subscriptions e Billing Portal, e leitura de
Prices, Invoices e Charges. Essa chave não lê Webhook Endpoints: a
conferência abaixo usa outra chave, só de leitura.

No painel do Stripe, antes de ligar:

1. Criar os produtos e os preços recorrentes mensais em BRL com as lookup keys
   acima e os valores do catálogo.
2. Antes do anual por cartão, criar nos mesmos produtos os preços
   recorrentes anuais em BRL (`fnfe_plan_intermediate_annual_brl` a
   R$ 1.490 e `fnfe_plan_large_annual_brl` a R$ 4.990, cobrança anual,
   licenciados) e fazer, no modo de teste, as provas do
   [Checkout anual](#checkout-anual).
3. Criar o endpoint com os eventos listados e guardar o segredo no deployment.
4. Portal do cliente: permitir trocar cartão e ver faturas; **desligar
   cancelamento e troca de plano** na configuração padrão usada pela aplicação.
   Cancelamento, retomada e troca de plano passam pelo console e suas regras
   de termos anuais. `billing.portal` pede `expand[]=configuration` e recusa
   entregar o link se essa configuração não corresponder à política.
   Não habilitar essas ações em configurações com sessões ainda válidas,
   nem distribuir links independentes do portal com permissões mais amplas.
5. Smart Retries ligados e "cancelar a assinatura" depois da última tentativa,
   com as tentativas terminando dentro do mês: uma cobrança recuperada depois
   do mês que comprou (no anual, depois do 1º mês do termo) fica
   `LATE_PAYMENT`, bloqueada com o dinheiro já recebido.
6. Pix não é habilitado no Stripe; continua assistido.

Os itens 1 a 4 são conferidos só lendo a conta, sem escrever no Stripe nem no
Convex:

```sh
node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto> [--endpoint <url>]
```

O arquivo guarda uma chave restrita própria da conferência (`rk_`, ou `sk_`;
`test` ou `live`), só com leitura em Prices, Webhook Endpoints e Customer
portal, separada da que o deployment usa. Sem `--endpoint`, a URL esperada é a
de produção. `--endpoint` muda a URL esperada,
por exemplo para a validação. O comando confere os quatro preços com as regras
de `readCatalogPrices` e `readAnnualPrices`, um único endpoint ativo nessa URL
com todos os eventos assinados e a configuração padrão do portal com as regras
de `readPortalSession`. Sai com 0 se tudo passar, 1 se algum item falhar e 2
se não conseguiu conferir (argumento, chave, rede ou resposta de erro do
Stripe), e
imprime um relatório sem chave nem ids da conta, com os itens 5 e 6 e os
e-mails do Stripe listados para conferência manual no painel.
`scripts/billing-stripe-check.test.ts` impede que essas regras se afastem das
da plataforma.

## Tarifas e tratamento fiscal

Preços do Stripe Brasil consultados em 28/10/2026 em
<https://stripe.com/br/pricing>; conferir na conta antes de ligar:

| Item                 | Tarifa                                                 |
| -------------------- | ------------------------------------------------------ |
| Cartão nacional      | 3,99% + R$ 0,39 por transação                          |
| Cartão internacional | + 2%                                                   |
| Stripe Billing       | 0,7% do volume do Billing (exclui faturas avulsas)     |
| Contestação recebida | R$ 55,00                                               |
| Reembolso            | sem tarifa; as tarifas da cobrança original não voltam |

Por mensalidade, cartão nacional mais Billing: Intermediário ≈ R$ 7,38 (4,95%)
e Grande ≈ R$ 23,79 (4,77%). O upgrade de R$ 350 é cobrança avulsa
(≈ R$ 14,36 de cartão); a fatura pós-compra pode ter tarifa de Invoicing, a
confirmar na conta. Moeda BRL; o prazo de repasse da conta brasileira não está
na página pública e precisa ser conferido na conta. A
[memória de custos](PLATFORM-COSTS.md#cobrança-da-mensalidade) registra esses
valores para a #549.

A fatura e o recibo do Stripe **não são NFS-e**. A nota da mensalidade da
Freecorps sai pelo processo fiscal próprio da empresa, fora desta integração;
a emissão da plataforma está só em sandbox e não é usada para isso.

## Retenção

As quatro tabelas e `platformPlanTerms` são `commercial`, como os demais
registros de planos e pagamentos: ficam até o fim da guarda fiscal e saem no
mesmo expurgo de `purgePlanRecords`.

## O que está provado e o que não está

Provado em `tests/platform.billing.test.ts` e
`apps/console/src/plans-billing.test.tsx`, com API do Stripe simulada por
`fetch` e eventos sintéticos assinados: contratação, renovação, recusa e
recuperação, upgrade, downgrade, cancelamento e retomada, o cartão que espera
o fim do plano Pix e da renovação dele já paga, duplicidade, evento repetido
e atrasado, timeout
com nova tentativa, reembolso e contestação só sinalizados, acesso negado por
papel, sessão e organização, isolamento por Customer, modo e assinatura
inválida, abandono do Checkout e encerramento. Da fatura anual: o termo da
âncora concedido na hora, com a admissão reservada na concessão, renovação
sem intervalo entre os termos e sem nova reserva, a renovação paga no último
mês agendada, fatura repetida e fora de ordem, preço anual ausente ou
diferente, valor, moeda, atraso, linha que não é um ano da âncora, âncora
desconhecida deixada para a conferência seguinte, renovação paga mais de um
mês antes, organização errada ou encerrada, plano personalizado, interruptor
desligado, recusa de admissão, a fatura mensal de um mês coberto, a retomada
recusada com outro termo agendado, a primeira fatura bloqueada que cancela
a assinatura sem reembolso automático, com a falha repetida e sinalizada
até o operador repetir, os jobs do Checkout do dia 1 que só registram, e os
anuais anteriores à fatia 2b, ancorados no dia 1, renovando. Do Checkout anual (fatia 2b): os parâmetros
exatos da sessão, sem âncora nem `proration_behavior` e sem `period`; a
assinatura de 31/01/2027 às 10:00:07 UTC cobrada na hora, com o termo até
31/01/2028 no mesmo horário, as cotas virando em 28/02 e 31/03 e a
renovação do ano seguinte com a mesma âncora; a cadeia de 29/02/2028
renovando em 28/02/2029, 2030 e 2031 e em 29/02/2032, com o mês de cota de
29/03 e o ano contado do aniversário anterior bloqueado; a primeira cobrança
de R$ 0, com outro `billing_reason` ou de um mês só; o evento e a fatura
reenviados sem efeito novo; a sessão concluída que não concede nada sem a
fatura; o anual sobre o mensal do cartão de tier igual, com a renovação
cancelada, e sobre o mensal Pix, substituindo-os na hora com âncora nova; o
anual menor sobre um mensal maior recusado com a data; a repetição pela
mesma chave, inclusive com o interruptor desligado depois; e as recusas por
papel, membership, organização, interruptor, preço anual ausente, termo em
vigor ou agendado com a data, acesso de um termo rescindido com a data, Pix
aguardando, cartão mensal ou anual que renova, Checkout aberto, plano
personalizado e admissão. Do upgrade do anual, em
`tests/platform.annualPix.test.ts` e `tests/platform.billing.test.ts`: o
preço pelos meses do termo restantes, contados da âncora, no 1º mês e no
último, o segmento desde o início do mês do termo ou a troca de `tier`, o
fim do termo mantido, a reserva dos R$ 172 de custódia, a confirmação e a
fatura repetidas, a troca de preço da assinatura anual uma vez, com
`billing_cycle_anchor: unchanged`, e a renovação no Grande na mesma âncora,
a troca adiada por "Não renovar" até a retomada, a renovação cobrada abaixo
do upgrade sinalizada para a equipe, e as recusas sem termo, com termo ou
renovação agendados, com o tier já em vigor, pela outra forma de pagamento,
com o interruptor desligado, com pedido ou Checkout pendente, a 45 minutos
do fim do mês do termo, com a data, e nas últimas 72 horas do termo no
cartão, paga depois do mês do termo (`LATE_PAYMENT`), com um `period` que
não é início de mês do termo, com assinatura de outro Customer, com valor
diferente e com a admissão recusada sem mexer no termo. Da rescisão, em
`tests/platform.annualTerms.test.ts`, `tests/platform.annualPix.test.ts`,
`tests/platform.billing.test.ts` e `tests/platform.closure.test.ts`: os
exemplos de R$ 894 no 4º mês, com o acesso até o fim do mês do termo
contado da âncora, de R$ 1.231,33 com o upgrade no 5º mês e rescisão no 8º,
e do zero a partir do 10º mês; o reembolso integral nos 7 dias da compra e
da renovação, com o acesso terminando na hora; o acesso até o fim do mês e o
plano terminando nele, com a reserva mantida; o upgrade desfeito em 7 dias
pelo Pix e pelo cartão, no 1º mês e depois, com a assinatura voltando ao
preço anual do Intermediário uma vez e a renovação seguinte no
Intermediário; a rescisão nos 7 dias do upgrade; a renovação agendada
rescindida junto e o pedido anual pendente cancelado; a assinatura
cancelada no Stripe sem reembolso automático, a retomada recusada e a
cobrança que escapou bloqueada; o cancelamento repetido depois de uma
falha e, esgotado, sinalizado até a repetição pelo operador; o Checkout de
upgrade aberto expirado; o termo agendado com a ativação recusada
devolvido inteiro; o upgrade desfeito depois do fim do termo sem mexer na
renovação; a devolução em vários reembolsos até o valor calculado, sem
passar dele; a repetição pela mesma chave e a chave de uma ação recusada
na outra; as recusas por termo rescindido, terminado, sem upgrade ou fora
dos 7 dias e por login, motivo ou chave inválidos; as funções só internas;
e o encerramento pelo owner depois da rescisão. Da tela do anual, com dados
simulados, em `apps/console/src/plans.test.tsx` e
`apps/console/src/plans-billing.test.tsx`: o anual escondido com o
interruptor desligado, o preço e a economia, o início do Pix na
confirmação, o anual no cartão cobrado no pagamento, sem "dia 1", o Checkout
anual aberto, a próxima cobrança anual e o fim do plano como instantes UTC,
o aviso de substituição do mensal e a recusa com a data, o termo em vigor,
agendado, pendente e rescindido, o upgrade pelo Pix e pelo cartão, fechado
nas últimas 72 horas, as pendências e as mensagens de cada código; a
leitura do servidor, em `tests/platform.annualPix.test.ts` e
`tests/platform.billing.test.ts`.

Do mensal por Pix nos aniversários, em `tests/platform.monthlyPix.test.ts`,
com o Pix ligado só pelo teste: a confirmação de 31/01 às 10:00:07 que
ancora a cadeia e renova em 28/02 e 31/03, sem deriva, com as cotas virando
no aniversário; a renovação paga antes, agendada, e paga depois do início,
na hora, e a recusada depois do prazo; o upgrade pela diferença no mesmo
período e com a mesma âncora; a renovação no último mês de um termo Pix com
a âncora da cadeia, inclusive em 29/02, e o anual que volta a renová-la; as
recusas com `availableAt` pelo cartão em vigor, mesmo sem renovação e num
tier maior, e pela renovação já paga; a ativação recusada repetida pelo
operador; o `now` recusado na confirmação; o pedido anterior à 1c repetido
e confirmado no mês civil; e `PIX_DISABLED`. A tela, em
`apps/console/src/plans.test.tsx`, mostra a renovação, o upgrade, as recusas
com a data e a renovação paga à espera.

Do mensal no cartão nos aniversários (fatia 2a), em
`tests/platform.billing.test.ts`, com Stripe simulado: o Checkout só com o
preço recorrente, sem âncora, item avulso nem cupom; a assinatura de 31/01 às
10:00:07 concedida até 28/02 e renovada até 31/03 e 30/04 no mesmo horário,
sem deriva, com as cotas virando nos aniversários e as faturas reenviadas
sem efeito novo; a fatura com um período fora do mês da âncora bloqueada
com `INVOICE_UNEXPECTED`; a assinatura fora da lista lida pelo id, e a fatura
sem âncora conhecida deixada para a conferência seguinte, sem registro; a
renovação cobrada abaixo de um upgrade cuja troca de preço falhou, concedida
com `RENEWAL_BELOW_UPGRADE`; a assinatura anterior
à 2a, ancorada no dia 1, renovando nas chaves `AAAA-MM` e subindo de plano
pelo mês civil; o upgrade no meio do mês pela diferença, com a mesma âncora
e o mesmo fim, recusado a 45 minutos do fim com a data e bloqueado com
`LATE_PAYMENT` se pago depois da virada; e as recusas com `availableAt`
pelo termo anual, pelo mensal do cartão com a renovação parada, pelo Pix e,
no anual no cartão, pelo mensal maior em vigor.
A tela, em `apps/console/src/plans-billing.test.tsx`, mostra a próxima
cobrança e o fim do plano como instantes UTC, sem "dia 1".

### Prova do mensal no Stripe de teste (#668)

Esta prova é anterior às fatias 2a e 2b: o Checkout mensal ainda tinha item
avulso, cupom e âncora no dia 1, e o anual ancorava no dia 1 seguinte. Pela
[ADR 0012](../adr/0012-periodo-por-aniversario.md#consequências), ela e a
matriz de sandbox precisam ser refeitas com os Checkouts novos e relógios de
teste em 31/01, 31/03 e 29/02, para confirmar que o Stripe ajusta o dia ao
fim do mês, volta ao dia da âncora (31/01, 28/02, 31/03) e renova os anos
da âncora como a ADR (29/02/2028, 28/02/2029, 2030 e 2031, 29/02/2032). O
roteiro está em
[Prova hospedada e ativação do anual](#prova-hospedada-e-ativação-do-anual-35).
Até lá, o período por aniversário do cartão, mensal e anual, está provado só
com Stripe simulado.

Em 31/10/2026, usando a API `2025-03-31.basil` e recursos sintéticos:

- O Checkout original, com item avulso e `none`, retornou HTTP 400
  `invalid_request_error`.
- O Checkout com `create_prorations` e cupom `once` restrito ao produto
  recorrente retornou total de 14900 centavos. A repetição com a mesma chave
  retornou a mesma sessão. As sessões foram expiradas após a verificação.
- Uma nova sessão foi paga na página do Checkout com cartão sintético de
  teste. Ela terminou `complete`, com `payment_status: paid` e fatura
  `subscription_create` paga de 14900 centavos. O Customer sintético foi
  removido após a prova, cancelando sua assinatura. O cancelamento direto
  da assinatura retornou 403 com a chave restrita utilizada. O ensaio posterior
  identificou `approval_required` e comprovou os três cancelamentos após
  aprovação humana, conforme a
  matriz de assinaturas.
- Pela API de assinaturas, o mesmo modelo de cobrança com item avulso e
  cupom gerou uma fatura `subscription_create` paga de 14900 centavos.
  Repetir a criação retornou a mesma assinatura.
- O relógio de teste avançou de 10/10/2026 para o dia 1 seguinte e mais duas
  horas para processamento. A fatura `subscription_cycle` ficou paga por
  14900 centavos, com a linha iniciando em 01/11/2026 às 00:00 UTC.
- O relógio foi removido e os produtos e preços criados diretamente foram
  desativados. Nenhuma chave ou identificador da conta faz parte desta evidência.

O pagamento no Checkout e a renovação pela API foram exercitados separadamente;
seus eventos não foram entregues ao backend hospedado. Concessão, isolamento,
eventos repetidos e recuperação de resposta perdida são cobertos por
`tests/platform.billing.test.ts`, com Stripe simulado. O simulador agora recusa
a combinação original; o anual e o mês já pago por Pix também são verificados.

Sem prova, dependendo de validação operacional:

- Entrega dos webhooks ao backend hospedado e concessão observada pelo console
  conectado. A prova do mensal acima não autoriza ligar o catálogo.
- A matriz de assinaturas
  comprovou no sandbox as faturas anuais e seus upgrades, inclusive datas,
  valores e metadados, cancelamentos, reembolsos e a configuração corrigida
  do portal, todos com a âncora no dia 1; com o anual cobrado na
  contratação (fatia 2b), as datas e as faturas do anual precisam ser
  provadas de novo. Ainda faltam a integração hospedada e os itens
  operacionais listados em [Checkout anual](#checkout-anual),
  [Upgrade do anual](#upgrade-do-anual) e [Rescisão](#rescisão-do-anual).
- Smart Retries, portal e e-mails do Stripe dependem da configuração da conta.
- Tarifas, repasse e Invoicing precisam ser conferidos na conta.

### Prova hospedada e ativação do anual (#35)

Esta prova cobre o que os testes com Stripe simulado não cobrem, no modelo da
[ADR 0012](../adr/0012-periodo-por-aniversario.md) implementado nas fatias
2a e 2b: as datas que o Stripe de teste cobra e renova, com relógios de
teste, e os eventos entregues a um backend hospedado, com a concessão gravada
e lida pelo console conectado. Ela nunca rodou. Tem duas partes: a matriz de
sandbox, só na API do Stripe de teste, e a jornada hospedada, no deployment
de validação (`modest-seal-118`). As duas usam chave de teste e recursos
sintéticos; a produção não liga o catálogo só para provar. Cada passo que
escreve no Stripe ou no deployment precisa de autorização do mantenedor, e
nenhuma chave, id da conta ou dado real entra no registro.

**Parte A: matriz de sandbox com relógios de teste.** O Customer que o
servidor cria no Checkout não tem relógio, então as renovações são provadas
direto na API (versão `2025-03-31.basil`), com uma chave restrita de teste,
criando a assinatura com os mesmos parâmetros que `billing:checkout` manda:
só o preço recorrente, sem `billing_cycle_anchor`, `proration_behavior`,
item avulso, período de teste nem cupom.

1. **Relógios.** Criar três relógios
   (`POST /v1/test_helpers/test_clocks`) com `frozen_time` em 31/01/2027
   10:00:07 UTC, 31/03/2027 10:00:07 UTC e 29/02/2028 10:00:07 UTC, e um
   Customer sintético em cada um (`POST /v1/customers` com `test_clock`).
2. **Anual.** Em cada Customer, criar a assinatura no preço
   `fnfe_plan_intermediate_annual_brl` (`POST /v1/subscriptions`, com
   `payment_behavior: error_if_incomplete` e um cartão de teste). Conferir:
   `billing_cycle_anchor` igual ao `frozen_time`; uma fatura
   `subscription_create` paga de 149000 centavos, com a linha anual de
   `frozen_time` ao mesmo dia e horário do ano seguinte; nenhuma outra
   fatura.
3. **Renovações.** Avançar cada relógio
   (`POST /v1/test_helpers/test_clocks/{id}/advance`) até duas horas depois
   de cada aniversário e conferir a fatura `subscription_cycle` paga, com a
   linha de exatamente um ano da âncora: 31/01/2028 e 31/01/2029; 31/03/2028;
   e, no relógio de 29/02/2028, 28/02/2029, 28/02/2030, 28/02/2031 e
   29/02/2032, sempre às 10:00:07 UTC. Uma linha que comece no aniversário
   anterior mais 12 meses (28/02/2032) reprova a prova.
4. **Mensal.** Repetir os passos 1 a 3 com o preço
   `fnfe_plan_intermediate_monthly_brl` nos relógios de 31/01 e 31/03:
   as renovações caem em 28/02, 31/03 e 30/04, e em 30/04, 31/05 e 30/06,
   às 10:00:07 UTC.
5. **Upgrade do anual.** Num novo Customer no relógio de 31/01/2027, depois
   do passo 2, avançar até 15/05/2027 e trocar o item ao preço
   `fnfe_plan_large_annual_brl` com `proration_behavior: none` e
   `billing_cycle_anchor: unchanged`, como a reconciliação faz depois de um
   upgrade pago. Conferir que nada é cobrado nem creditado na hora, que
   `current_period_end` continua 31/01/2028 10:00:07 UTC e, avançando até o
   aniversário, que a renovação sai pelo preço do Grande, na mesma data. A
   cobrança do upgrade em si é a sessão em modo `payment` com
   `invoice_creation`, provada na parte B.
6. **Limpeza.** Apagar os relógios (`DELETE /v1/test_helpers/test_clocks/{id}`),
   o que remove os Customers e as assinaturas deles.

**Parte B: jornada hospedada.**

1. **Conta de teste.** Preparar os itens 1 a 4 de
   [Configuração](#configuração), com o endpoint em
   `https://modest-seal-118.convex.site/v1/billing/stripe/events`, o host HTTP
   da validação: o Worker `freecorpsnfe-validation` só encaminha a
   autenticação e não chega a `/v1`.
   `node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto> --endpoint <essa URL>`
   passa com a chave de teste.
2. **Deployment.** Publicar na validação o SHA que contém a fatia 2b. Antes
   das variáveis, um `POST` sem assinatura nessa URL responde 404; depois de
   gravar `STRIPE_BILLING_SECRET_KEY` (`rk_test_…`) e
   `STRIPE_BILLING_WEBHOOK_SECRET`, responde 400. Ligar só na validação o
   catálogo (`plans:configure`, com a janela de admissão aberta) e o anual
   (`plans:configureAnnual`), com evidência citando a #35.
3. **Mensal.** O owner sintético contrata o Intermediário mensal pelo console
   com cartão de teste. Conferir os eventos `processed` em `billingEvents`, a
   concessão `applied` em `billingGrants`, com `period` igual à chave do
   `billing_cycle_anchor` da assinatura (a criação dela, em segundos), e o
   plano no console até o mesmo dia e horário do mês seguinte, sem "Conferir
   pagamento". "Cartão e faturas" abre o portal só com cartão e faturas.
4. **Anual sobre o mensal.** Com o mensal do passo 3 em vigor, "Assinar
   Intermediário anual no cartão" fica desabilitado até "Cancelar
   renovação". Depois dele, o anual do mesmo tier abre o Checkout, e o
   pagamento gera a fatura `subscription_create` de R$ 1.490. Conferir: o
   termo `active` com `firstPeriod` no `billing_cycle_anchor` da assinatura
   anual (a criação dela, em segundos) e `endsAt` no mesmo dia e horário do
   ano seguinte; a linha de `usagePlans` com `termId`, `periodAnchor` igual a
   essa âncora e o fim do termo, substituindo o mensal na hora; a reserva em
   `platformPlanAllocations`; a assinatura mensal com
   `cancel_at_period_end` e sem nova cobrança; e o console com o anual em
   vigor e a próxima cobrança anual como instante UTC.
5. **Anual menor sobre mensal maior.** Numa segunda organização sintética,
   o owner contrata o Grande mensal pelo cartão e usa "Cancelar renovação".
   "Assinar Intermediário anual no cartão" é recusado com
   `PLAN_UNAVAILABLE`, e o console mostra a data em que fica disponível, o
   fim do Grande mensal. Nenhum Checkout é aberto.
6. **Upgrade.** Na primeira organização, com o termo do cartão em vigor,
   "Mudar para Grande anual" abre a sessão em modo `payment` pela diferença
   dos meses restantes, com `period` no início do mês do termo. Paga,
   conferir o segmento do Grande desde esse início, o fim do termo mantido, a
   assinatura no preço anual do Grande com a mesma âncora
   (`current_period_end` inalterado) e o console.
7. **Arrependimento e rescisão.** Dentro dos 7 dias da cobrança anual,
   `plans:rescindTerm` devolve o total pago e termina o acesso na hora;
   conferir a assinatura anual cancelada no Stripe pela reconciliação, sem
   reembolso automático, e o console. Com o Pix desligado, o console não
   oferece o pedido Pix, e `plans:requestPaid` responde `PIX_DISABLED`.
8. **Repetição.** Reenviar pelo painel um evento já processado não cria
   efeito novo.
9. **Limpeza.** Cancelar as assinaturas de teste das duas organizações,
   desligar o anual (`plans:configureAnnual`) e fechar a janela de admissão
   na validação (`plans:configure` com `admissionsUntil` no passado: a
   mutation não desliga um catálogo já ligado) e retirar as variáveis, salvo
   decisão de manter o cartão de teste ali.
10. **Registro.** Num comentário da #35, registrar as datas, o SHA publicado
    na validação, as datas de cada fatura das partes A e B, os estados e
    códigos observados e o resultado de
    `node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto> --endpoint <URL do passo 1>`,
    sem chaves nem ids da conta.

A renovação anual na jornada hospedada não pode ser antecipada, porque o
Customer do console não tem relógio: ela fica provada pela parte A e pelos
testes com Stripe simulado. A ativação abaixo também espera uma versão nova
dos termos de uso no console (ADR 0012, Consequências).

Depois da prova, a ativação em produção segue esta ordem:
`node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto>`, sem `--endpoint`, com a chave
`live` contra o endpoint de produção, os
segredos no deployment de produção, o catálogo ligado e
`plans:configureAnnual` com `enabled: true` e evidência que cite a prova. O
Pix continua desligado.
Depois, conferir no console conectado que o anual aparece à venda. Os limites
da matriz continuam valendo: testes locais de Pix não são transferência real,
e 3DS, disputas, Smart Retries e e-mails não foram demonstrados.
