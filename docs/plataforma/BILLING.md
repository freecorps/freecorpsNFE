# Cobrança das assinaturas

A Freecorps cobra os planos pagos da plataforma por cartão, pelo Stripe, ou por
Pix assistido. As duas formas seguem as mesmas regras comerciais da
[proposta de planos](PLATFORM-PLAN-PROPOSAL.md): mês civil UTC, primeira
mensalidade integral, upgrade pela diferença integral, downgrade e cancelamento
na renovação. Uma organização paga por uma forma de cada vez. A decisão é de
27/10/2026 (#556), e as políticas de inadimplência, reembolso e contestação
foram decididas pelo mantenedor em 28/10/2026.

**Por enquanto, só o cartão.** Em 03/11/2026 o mantenedor decidiu não aceitar
Pix: a venda nova é só pelo Stripe. O Pix assistido continua no código, atrás
do [interruptor do Pix](#interruptor-do-pix), desligado.

**O catálogo continua desligado.** A cobrança por cartão existe no código e nos
testes, mas toda contratação passa por `requirePlanAdmissions`: sem
`platformPlanSettings.enabled` e janela de admissão aberta, nada é vendido.
Mensal e anual foram exercitados numa conta Stripe de teste, conforme a
matriz de assinaturas.
Não houve cobrança real nem configuração de cobrança no deployment.
A viabilidade dos planos foi aprovada com o fechamento da #34, em 03/11/2026.
Ligar a oferta continua sujeito aos termos e às provas da modalidade na issue
da entrega, conforme a [ADR 0011](../adr/0011-entregas-graduais.md): a prova
hospedada e a ativação do anual ficam na #35
([Prova hospedada e ativação do anual](#prova-hospedada-e-ativação-do-anual-35)).
Desde 03/11/2026, ligar o catálogo ou o anual também espera a implementação
da [ADR 0012](../adr/0012-periodo-por-aniversario.md) e uma versão nova dos
termos de uso ([Período por aniversário](#período-por-aniversário-decidido-em-03112026)).

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
| Checkout anual por cartão                                                         | `platform/convex/billing.ts` (`checkout`, `prepareCheckout`)      |
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

| Situação                         | Cartão                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contratar sem plano pago no mês  | Checkout em modo `subscription`: item avulso com a mensalidade integral do mês corrente e preço recorrente ancorado no dia 1 seguinte, 00:00 UTC, sem pró-rata. |
| Mês já pago por Pix, mesmo plano | Checkout sem item avulso (R$ 0 agora); a primeira cobrança é no dia 1.                                                                                          |
| Mês já pago por Pix, plano maior | Item avulso com a diferença integral; renova pelo plano maior.                                                                                                  |
| Mês já pago por Pix, plano menor | R$ 0 agora; o mês pago continua; renova pelo plano menor se o uso couber.                                                                                       |
| Renovação                        | Fatura `subscription_cycle` no dia 1: concede o mês da linha, com o preço do catálogo.                                                                          |
| Upgrade com assinatura ativa     | Checkout em modo `payment` pela diferença integral, com fatura pós-compra; ao pagar, o plano sobe e a assinatura passa ao preço maior, sem pró-rata.            |
| Downgrade                        | `changeRenewal`: confere que o uso cabe e troca o preço da próxima renovação; o mês pago não muda.                                                              |
| Cancelamento                     | `cancel_at_period_end`: sem multa, sem reembolso proporcional; o período pago continua. "Retomar renovação" desfaz antes do fim.                                |
| Encerramento da organização      | A assinatura é cancelada na hora no Stripe, sem reembolso automático do mês pago.                                                                               |

O início mensal com item avulso usa `create_prorations` e um cupom de 100%
restrito ao produto recorrente, com duração `once`. Assim, a primeira fatura
cobra apenas o item avulso integral, ou a diferença após Pix; o desconto é
consumido nessa fatura e a renovação cobra o preço mensal integral. O produto
do item avulso é separado do recorrente. O cupom tem uma utilização, expira
com o Checkout e é criado com chave de idempotência por contratação, assim
como a sessão. Uma resposta perdida reaproveita ambos.

O início sem cobrança após Pix e o anual continuam com
`proration_behavior: none`, sem cupom nem item avulso. Upgrades de assinaturas ativas continuam em
modo `payment`. O formato anterior do mensal, item avulso com `none`, foi
recusado com HTTP 400 pelo Stripe de teste na
[#668](https://github.com/freecorps/freecorpsNFE-arquivo/issues/668).

O Checkout expira em até 24 horas e sempre antes da virada do mês; a 45 minutos
da virada a contratação é recusada (`PERIOD_CLOSING`). Enquanto há Checkout
aberto ou assinatura que renova, o Pix é recusado (`PAYMENT_METHOD_CARD`), e
enquanto há pedido Pix aguardando, o cartão é recusado
(`PLAN_REQUEST_PENDING`). Para trocar cartão por Pix: cancelar a renovação e
pedir o Pix quando o período terminar. "Desistir" expira a sessão no Stripe.

### Como uma fatura vira plano

Cada fatura paga é pesada uma vez (`billingGrants.invoiceId`):

- `applied`: plano ativado por `activateCatalogPlan`, com auditoria
  `stripe:{in_…}`, até o primeiro dia do mês seguinte ao período comprado.
  Uma fatura anual cria um termo, com `termId` na concessão
  ([Fatura anual do cartão](#fatura-anual-do-cartão)). Uma renovação anual
  cobrada abaixo do tier que um upgrade comprou fica `applied` com
  `RENEWAL_BELOW_UPGRADE` e aparece para a equipe
  ([Upgrade do anual](#upgrade-do-anual)).
- `skipped`: `ZERO_AMOUNT` (mês já pago por Pix) ou `SUPERSEDED` (um mês
  posterior já está em vigor; nunca encurta o plano).
- `blocked`: precisa de uma pessoa. `ANNUAL_TERM_ACTIVE` (fatura mensal paga
  para um mês coberto por um [termo anual](#plano-anual)), `DUPLICATE_PAYMENT` (mês já
  coberto pelo mesmo plano ou maior), `LATE_PAYMENT` (paga depois do mês que
  comprou),
  `AMOUNT_MISMATCH`, `PRICE_UNKNOWN`, `CURRENCY_MISMATCH`,
  `INVOICE_UNEXPECTED`, `ORGANIZATION_MISMATCH`, `ORGANIZATION_CLOSED`,
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
**A decisão ainda não está implementada:** o código faz o que este documento
descreve, e cada fatia da ADR atualiza a seção correspondente. Da fatia Q,
já existe o modelo do período de cota, em
[USAGE.md](USAGE.md#período-de-cota): `usagePlans.periodAnchor`, as chaves
canônicas e `quotaPeriod`. A linha que um termo anual concede leva o início
do termo como âncora, e as concessões mensais, pelo Pix e pelo cartão, ainda
não têm âncora e seguem no mês civil. Da fatia 1b, o anual pelo Pix começa
na confirmação ou, como renovação pedida no último mês do plano Pix em
vigor, no fim dele, com a âncora da cadeia gravada no termo
([Venda por Pix](#venda-por-pix)); as guardas de termo comparam instantes, e
as vendas Pix seguem a regra de um plano pago por vez. O anual no cartão
continua começando no dia 1 seguinte até a fatia 2b. Até a
implementação e uma versão nova dos termos de uso entrar no console, o
catálogo e o anual não são ligados. A
[prova hospedada da #35](#prova-hospedada-e-ativação-do-anual-35) precisa ser
reescrita para o novo modelo antes de rodar, e as provas já feitas no Stripe
de teste, com renovação ancorada no dia 1, precisam ser refeitas.

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
tira o Pix dos textos de Cobrança. Sem Pix, o anual só começa no dia 1
seguinte, pelo [Checkout anual](#checkout-anual).

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
  como os vendidos hoje, tem os meses civis UTC como meses do termo. O mês
  do termo em curso conta inteiro. Até 7 × 24 h da compra, o reembolso é
  integral; depois, é o valor pago menos os meses do termo usados pelo preço
  mensal, nunca negativo. O Intermediário cancelado no 4º mês devolve
  R$ 894; a partir do 10º mês, nada. O upgrade do Intermediário para o
  Grande cobra (R$ 4.990 − R$ 1.490) × meses do termo restantes / 12,
  arredondado para baixo uma vez, no total.
- **Termo.** Cada anual pago é uma linha de `platformPlanTerms`
  (`planSchema.ts`): `tier` a partir de `firstPeriod` (o instante de início,
  em ms: dia 1, 00:00 UTC, no cartão; a confirmação, truncada ao segundo, ou
  o fim do plano renovado, no Pix), `anchor` (a âncora da cadeia, abaixo),
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
- **Âncora da cadeia** (ADR 0012, seção 1, decidido na fatia 1b). O termo
  que renova outro pelo Pix grava `anchor`, a âncora original da cadeia: o
  início do primeiro termo, ou a âncora do mensal que ele renova. Sem o
  campo, o termo é a própria âncora, como os gravados antes da 1b e os do
  cartão; por isso não há migração. Os meses do termo, o `endsAt` e a
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
  cartão, o anual ainda começa no dia 1 do mês seguinte, então o mês
  corrente continua mensal até lá. Recusam com `ANNUAL_TERM_ACTIVE`:
  - quando um termo se sobrepõe ao plano mensal, de `startsAt` até antes de
    `endsAt` (`monthlyBlockedByTerm`), porque o termo o encurtaria: o pedido
    Pix (`plans:requestPaid`, do instante do pedido ao fim do mês civil,
    com `availableAt` no fim do último termo), a confirmação
    (`plans:confirmPayment`) e
    qualquer outra ativação mensal de `activateCatalogPlan`. Um plano sem fim,
    como o Gratuito (`plans:claimFree`), só é recusado se um termo cobre
    `startsAt`: a ativação do termo o substitui. Um mês que termina antes de
    um termo agendado continua vendido;
  - quando um termo cobre o instante atual: a atribuição manual
    (`usage:assignPlan`). Um termo agendado para depois substitui a linha
    atribuída quando começa;
  - enquanto houver qualquer termo `scheduled` ou `active` não terminado
    (`activeTerm`), mesmo agendado para depois: o Checkout mensal
    (`billing:checkout`) e "Retomar renovação" (`billing:changeRenewal` com
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
  ativação do termo, no dia 1, substitui essa linha.

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
  recusando. O pedido Pix anual é recusado com `PAYMENT_METHOD_CARD`
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
     renovação. Enquanto o mensal ainda segue o mês civil (fatia 1c), essa
     renovação começa no dia 1 seguinte e é a própria âncora.

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
  - `period`, o 1º mês do termo em `AAAA-MM`;
  - `grantCents`, igual a `annualCents`.

  O Checkout não cobra nada: a primeira cobrança é a fatura
  `subscription_cycle` do dia 1, reconhecida pelo preço anual da linha e
  concedida como um termo novo. Diferente do Pix, que começa na
  confirmação, o cartão cobra no dia 1, não antes. Uma fatura `subscription_create` marcada anual, se aparecer,
  precisa cobrar exatamente `annualCents` e ter uma linha no preço anual
  conferido do tier; de R$ 0, fica `skipped` (`ZERO_AMOUNT`). Uma primeira
  cobrança com outro `billing_reason` fica `blocked` com
  `INVOICE_UNEXPECTED`: o dinheiro entrou, nenhum termo é criado, e o
  operador reembolsa pelo painel do Stripe ou resolve à mão e marca com
  `billing:resolveReview`.

  Uma linha com preço mensal numa fatura marcada anual, ou uma fatura
  mensal de uma assinatura anual, fica `INVOICE_UNEXPECTED`. As faturas
  `subscription_cycle` são reconhecidas só pelo preço anual da linha: o
  termo começa no mês em que a linha começa, que é o `endsAt` do termo
  anterior ou, na primeira cobrança, o dia 1 da âncora. Uma linha anual de
  `subscription_cycle` que comece fora do dia 1, às 00:00 UTC, fica
  `INVOICE_UNEXPECTED`.

- **Assinatura anual.** Uma assinatura é anual quando o preço do item tem
  uma lookup key anual ou cobrança anual, conferido ou não
  (`readSubscriptions`). Uma assinatura anual nunca passa a um preço
  mensal, que reiniciaria a âncora e cobraria na hora. Só passa a outro
  preço anual depois de um [upgrade](#upgrade-do-anual) pago, ou de volta
  ao preço anual anterior quando esse upgrade é desfeito em 7 dias. Com o preço anual
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

- **Termo.** A fatura grava o termo com `source: "stripe"`,
  `references: [id da fatura]`, `stripeSubscriptionId` (a assinatura da
  fatura), `paidCents` e `purchasedAt` no pagamento
  (`status_transitions.paid_at`; sem ele, a leitura). Com o 1º mês já
  chegado, o plano é concedido na hora até o fim do termo, com auditoria
  `stripe:{in_…}`; com o 1º mês no futuro, o termo fica `scheduled` e
  `plans:activateScheduledTerm` o ativa no dia 1, como a renovação Pix no
  início dela. O Stripe
  cobra a renovação na âncora, que é o fim do termo: o termo novo vai do
  fim do anterior até 12 meses depois, sem intervalo entre os termos e sem
  nova reserva, e o termo anterior não o bloqueia. O plano é concedido no
  pagamento: entre o fim do termo anterior e o pagamento não há plano em
  vigor, como na renovação mensal. Uma renovação paga antes da âncora, o
  que é incomum, fica agendada. A concessão (`billingGrants`) guarda `tier`,
  `period` (o 1º mês) e `termId`; a deduplicação por `invoiceId` garante um
  termo por fatura, em qualquer ordem e repetição. Uma conferência fica
  agendada duas horas depois do fim do termo.
- **Interruptor.** A fatura anual paga vale com o interruptor desligado: ele
  para a venda nova, e o dinheiro já entrou. A admissão (`allocateOffer`)
  continua valendo.
- **Bloqueios.** Ficam `blocked`, sem termo, para uma pessoa:
  - `LATE_PAYMENT`: paga depois do 1º mês do termo, como o prazo do Pix;
  - `ANNUAL_TERM_ACTIVE`: outro termo cobre o 1º mês ou já há um termo
    agendado (`annualTermBlocks`);
  - `ANNUAL_TERM_RESCINDED`: a assinatura comprou um termo rescindido e
    devia ter sido cancelada (`billing:stopTermRenewal`); a cobrança não vira
    termo e espera reembolso;
  - `PLAN_UNAVAILABLE`: começa no mês corrente com um plano mensal maior em
    vigor, porque o downgrade só vale na renovação; ou a recusa de admissão;
  - `INVOICE_UNEXPECTED`: o 1º mês depois do mês seguinte (inclusive uma
    renovação paga mais de um mês antes), o id da fatura fora do formato de
    referência do termo ou a primeira fatura sem linha no preço anual
    conferido do tier;
  - os demais códigos de [Como uma fatura vira plano](#como-uma-fatura-vira-plano)
    (`AMOUNT_MISMATCH`, `PRICE_UNKNOWN`, `CURRENCY_MISMATCH`,
    `ORGANIZATION_MISMATCH`, `ORGANIZATION_CLOSED`, `PLAN_CUSTOM` e as
    recusas de admissão).

  Uma fatura anual bloqueada não tem plano a ajustar: o operador reembolsa
  pelo painel do Stripe e marca com `billing:resolveReview`.

  Um termo agendado pode ser recusado no dia 1 (admissão, `TERM_ENDED`)
  enquanto a concessão da fatura continua `applied`: a recusa fica no
  `blockedCode` do termo (`termId` na concessão), e o operador a trata como
  na [venda por Pix](#venda-por-pix).

### Checkout anual

`billing:checkout` com `cycle: "annual"` abre o Checkout do anual; sem
`cycle`, continua o mensal. No cartão, o anual sempre começa no dia 1 do mês
seguinte e é cobrado nesse dia, e o mês corrente segue no plano em vigor
(decisão do mantenedor de 30/10/2026). Quem quer começar na hora usa o
[Pix](#venda-por-pix) com `start: "now"`. Papéis, membership, chave de
idempotência, admissão (`allocateOffer`, conferida sem reservar) e a virada
do mês (`PERIOD_CLOSING`) são os do mensal. O servidor cobra `annualCents`
integral, sem desconto do mês já pago. A reserva vem na conclusão da
sessão ([Reserva na conclusão](#reserva-na-conclusão)).

A sessão, em modo `subscription`, tem só o preço anual do tier, sem item
avulso nem período de teste, com `billing_cycle_anchor` no dia 1 do mês
seguinte, às 00:00 UTC (21:00 do dia anterior em Brasília), e
`proration_behavior: none`. Os metadados levam
`period` do mês seguinte. Nada é cobrado na sessão, que deve terminar como
`no_payment_required`, sem fatura. A conclusão não concede nada nem depende
do pagamento: a conferência marca a sessão `complete`, o que libera a vaga,
grava a assinatura anual, reserva a admissão e agenda uma nova conferência
duas horas depois do dia 1, para ler a cobrança da âncora mesmo sem o
evento. Uma conclusão repetida, por evento reenviado ou nova conferência,
não reserva nem agenda de novo: só a linha ainda `open` conclui. Se
vier uma fatura de R$ 0, ela fica `skipped` (`ZERO_AMOUNT`). O termo nasce
só da fatura paga no dia 1, mesmo que o interruptor tenha sido desligado
depois da venda. Das 00:00 UTC do dia 1 até essa fatura ser paga e lida, a
organização fica sem o plano pago: uma ou duas horas no caso normal, e
mais se o cartão for recusado.

A sessão expira em até 24 horas e antes da virada do mês, como a mensal;
depois dela, a âncora estaria no passado. Os meses são em UTC, como no
resto da cobrança: um Checkout de dezembro ancora em 1º de janeiro.

Recusas, todas antes de qualquer chamada ao Stripe:

- `ANNUAL_DISABLED`: o interruptor está desligado. A repetição de uma
  sessão já aberta, pela mesma chave, continua respondendo;
- `ANNUAL_TERM_ACTIVE`: há um termo em vigor ou agendado, de qualquer
  forma de pagamento e mesmo no último mês dele, com `availableAt` no fim
  do último (`termsEnd`). Pela regra de um plano pago por vez (ADR 0012),
  o anual no cartão, que ainda começa no dia 1 seguinte, não é vendido
  para começar depois de um termo Pix, e o termo do cartão renova pela
  própria assinatura;
- `PLAN_REQUEST_PENDING`: há pedido Pix aguardando pagamento;
- `CHECKOUT_PENDING`: há outro Checkout aberto;
- `SUBSCRIPTION_RENEWING`: uma assinatura por cartão, mensal ou anual,
  ainda renova, e o cliente precisa usar "Não renovar" antes. O servidor
  não cancela a renovação por conta própria: um Checkout abandonado
  deixaria a organização sem renovação, e uma repetição no meio dessa troca
  poderia cobrar duas vezes;
- `PLAN_UNAVAILABLE`: plano personalizado ou admissão fechada. Um
  plano mensal maior em vigor não impede: o mês corrente fica com ele;
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

#### Reserva na conclusão

Nenhum cartão é cobrado sem uma reserva que se mantenha até a âncora
(ADR 0010, D3). Na transação que marca a sessão `complete`,
`admitAnnualCheckout` (`lib/billingCore.ts`) chama `allocateOffer` reservando
o estoque, a custódia e o subsídio do tier, como a confirmação da renovação
anual pelo Pix. A linha de `billingCheckouts` guarda a assinatura da sessão
(`subscriptionId`, lido do campo `subscription` da sessão) e o resultado em
`admission`:

- **`reserved`.** Como `allocateOffer` só aumenta a reserva, a fatura do dia
  1 a encontra mantida: a janela de admissão fechada, o estoque tomado por
  outras vendas ou a falta de estoque não a recusam mais
  ([Janela de admissão](#janela-de-admissão)). A fatura é pesada como
  antes, sem regra própria. Seis horas antes da âncora
  (`ADMISSION_RECHECK_MARGIN`), `billing:recheckAnnualAdmission` confere de
  novo, sem gravar, o que a reserva não segura e bloquearia a fatura depois
  da cobrança: o catálogo desligado (`PLANS_DISABLED`, que
  `plans:configure` recusa depois de ligado; só uma alteração direta o
  causa), o uso acima do tier (`QUOTA_EXCEEDED`, possível só com um plano
  maior em vigor, porque as guardas seguem o plano em vigor e não a
  reserva), o inventário de capacidade (`CAPACITY_INVENTORY_REQUIRED`), um
  arquivamento ou reidratação em curso (`ORGANIZATION_ARCHIVING`) e um plano
  personalizado atribuído depois (`PLAN_CUSTOM`). Uma recusa aí cancela a
  assinatura como abaixo. Uma conclusão a menos de seis horas da âncora não
  agenda a reconferência: a conclusão acabou de conferir. A reconferência
  não faz nada quando a assinatura já não renova ("Não renovar",
  encerramento): o Stripe não cobra de qualquer forma.
- **`refused`.** A recusa grava o `code` e nada é reservado, porque
  `allocateOffer` recusa antes de gravar. Uma organização encerrada, ou com
  o encerramento em curso (`organizationClosures`), é recusada com
  `ORGANIZATION_CLOSED` antes de qualquer reserva; o encerramento já cancela
  a assinatura (`billing:stopForClosure`), e a repetição aqui não faz nada
  novo. `billing:stopRefusedAnnual`
  cancela a assinatura na hora (`DELETE`), sem cobrança, porque a âncora
  ainda não chegou. Uma assinatura já encerrada, desconhecida ou de outro
  Customer fica como está, e a repetição não faz nada novo. Uma falha do
  Stripe é repetida com espera crescente (15, 30, 45, 60 e 75 minutos,
  3 h 45 min ao todo, dentro das seis horas da reconferência); esgotadas as
  tentativas, `stop` passa a `failed`. Um cancelamento `done` é final: uma
  falha depois dele, como a da conferência que o segue, não o reabre. A
  partir da âncora o Stripe pode ter cobrado, e um termo pode até ter
  nascido, então nada é cancelado automaticamente: o cancelamento também
  fica `failed`. Antes de repetir `billing:stopRefusedAnnual` com
  `attempt: 0` ou de cancelar no Stripe, o operador confere se há um termo
  com `stripeSubscriptionId` igual ao `subscriptionId` do Checkout: se
  houver, a assinatura renova esse termo pago e não é cancelada (a ação
  também não a cancela); a cobrança que passou é tratada pela concessão.
  Resolvido, marca com `billing:resolveReview` (`checkoutId`).

`billing:overview` mostra a recusa em `reviews`, com `source: "checkout"` e o
código da recusa, até o fim do 1º mês do termo que não houve ou até um
Checkout anual seguinte da organização ser reservado; o cancelamento
`failed` aparece como `SUBSCRIPTION_STOP_FAILED` até ser tratado. Nenhum dos
dois aparece quando a assinatura comprou um termo agendado ou em vigor. A
leitura usa o índice `by_organizationId_and_admissionState_and_admissionStop`,
não só os últimos Checkouts concluídos. O console diz que o anual foi recusado antes da cobrança e por quê.

Limites conhecidos:

- **Entre a reconferência e a cobrança.** Uma mudança nessas seis horas,
  ou até o Stripe cobrar, ainda bloqueia a fatura do dia 1 com o código da
  recusa, como antes, para reembolso pelo painel do Stripe.
- **Reserva sem cobrança.** Com "Não renovar", o encerramento, a recusa na
  reconferência antes da âncora ou o cartão recusado na âncora (sem
  pagamento recuperado no 1º mês), nada é cobrado, mas a reserva continua,
  como a de um termo Pix agendado e rescindido: `allocateOffer` não a
  reduz, e só o expurgo legal a devolve.
- **Conclusão lida depois da âncora.** A reconciliação pesa as faturas
  antes das sessões. Uma cobrança já paga é concedida ou bloqueada pelas
  regras da fatura; a conclusão reserva em seguida ou, recusada, fica para
  uma pessoa, sem cancelamento automático.

**Antes de ligar o anual, confira todos os itens abaixo.** A
matriz de sandbox registra os
resultados externos e as pendências; os testes de integração usam Stripe simulado:

- o preço anual com `billing_cycle_anchor` no dia 1, às 00:00 UTC, e
  `proration_behavior: none`, sem item avulso: a sessão é aceita, termina
  como `no_payment_required` e não gera fatura, nem de R$ 0;
- os eventos dessa conclusão (`checkout.session.completed` e
  `customer.subscription.created`) trazem o Customer, sem fatura;
- a primeira cobrança chega no dia 1 como `subscription_cycle`, com a linha
  do preço anual começando exatamente na âncora. Com outro `billing_reason`
  ela fica `blocked` (`INVOICE_UNEXPECTED`) e o dinheiro espera um
  reembolso ou uma decisão;
- as renovações seguintes caem no aniversário da âncora, também às 00:00
  UTC do dia 1;
- o portal não deixa o cliente reativar a assinatura mensal antiga, já com
  "Não renovar". Reativada, ela e a anual cobrariam no mesmo dia 1, e o
  servidor só sinalizaria `SUBSCRIPTION_DUPLICATE`;
- a sessão concluída traz a assinatura em `subscription`, e o `DELETE`
  da assinatura antes da âncora a encerra sem fatura nem cobrança, nem de
  R$ 0.

**Proteção do portal conferida no sandbox em 31/10/2026:** com troca de
plano desativada e cancelamento ao fim do período habilitado, "Don't cancel
subscription" reativou o mensal antigo mesmo com uma assinatura anual já
criada. Por isso, o portal deve permitir apenas cartão e faturas, com
cancelamento e troca de plano desativados. O servidor confere a configuração
expandida da sessão antes de entregar sua URL e recusa configuração ausente,
inativa, de outro ambiente ou incompatível. Cancelamento e retomada passam
pelo console. A prova antes e depois
confirmou que a configuração corrigida não oferece retomada do mensal antigo.

### Upgrade do anual

O Intermediário anual sobe para o Grande anual no meio do termo (ADR 0010,
decisão 9, e decisão do dono de 30/10/2026). O pedido é o do anual, com
`cycle: "annual"` e `start: "upgrade"`: em `plans:requestPaid` no Pix e em
`billing:checkout` no cartão. Cada termo sobe pela forma que o pagou, e a
regra é a mesma nas duas:

- **Preço.** (R$ 4.990 − R$ 1.490) × meses restantes / 12, com o mês
  corrente contado inteiro e o total arredondado para baixo uma vez
  (`termUpgradeCents`, `lib/planTerms.ts`). Do 2º ao 12º mês, R$ 3.208,33 a
  R$ 291,66; no 1º mês, R$ 3.500. O mês do termo da compra fixa o preço: o
  pedido Pix vence no fim desse mês do termo, e o Checkout expira antes da
  virada do mês civil, que no cartão ainda é o mês do termo.
- **Termo.** `upgradeTerm` (`lib/planCore.ts`) abre um segmento do Grande a
  partir do início do mês corrente do termo (`termMonth`, contado da âncora
  da cadeia); no 1º mês, que o upgrade cobre inteiro, troca o `tier` do
  termo. Num termo Pix de 10/10 às 12:00 UTC, um upgrade pedido em 11/02
  vale desde 10/02 às 12:00 UTC e vence em 10/03 às 12:00 UTC. `endsAt`, a
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
A virada do mês recusa com `PERIOD_CLOSING`, como nas outras sessões, e
também as últimas 72 horas do termo (`UPGRADE_SWITCH_MARGIN`,
`lib/billingCore.ts`): a sessão expira em até 24 horas, então o pagamento
deixa pelo menos 48 horas para a troca de preço chegar ao Stripe antes da
âncora. Depois do dia 1, o termo novo sobe no 1º mês dele. Pelo Pix, o
último mês inteiro continua aceito, porque a renovação Pix é um pedido à
parte.

- **Sessão.** Modo `payment`, como o upgrade mensal: um item avulso com a
  diferença e fatura pós-compra (`invoice_creation`), com os metadados
  `kind: "upgrade"`, `cycle: "annual"`, `tier`, `period` (o mês corrente) e
  `grantCents`. Exige o preço anual conferido do tier pedido; sem ele,
  `BILLING_UNAVAILABLE`, sem sessão.
- **Fatura paga.** Pesada uma vez por `invoiceId`, como as outras. Aplicada,
  sobe o termo, grava a concessão com `termId` e a versão do plano e muda
  `renewalTier` da conta. Fica `blocked`, sem mexer no termo nem no plano,
  com:
  - `LATE_PAYMENT`, paga depois do mês que comprou;
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
no Checkout aberto, `periodStartsAt`, o início do 1º mês comprado. O console
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
  "Assinar … anual no cartão" avisa que nada é cobrado agora e que o 1º ano
  é cobrado no dia 1 seguinte. Enquanto uma assinatura ainda renova, esse
  botão fica desabilitado até "Cancelar renovação", o "Não renovar" do
  console.
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
  de uma assinatura anual ainda não cobrada avisa que a primeira cobrança
  não acontece, sem falar em período pago.
- **Pendências.** Um termo e a renovação agendada, rescindidos juntos e com
  o cancelamento da mesma assinatura falhando, aparecem como um só
  `SUBSCRIPTION_STOP_FAILED` em `billing:overview`. Um anual no cartão
  recusado antes da âncora (`source: "checkout"`) aparece como "Plano anual
  por cartão recusado antes da cobrança", com o motivo do código, e o
  cancelamento que falhou, como "Cancelamento pendente no Stripe da
  assinatura anual recusada" ([Reserva na conclusão](#reserva-na-conclusão)).

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

- `billing:resolveReview` com `eventId`, `grantId` ou `checkoutId` e
  `actor` marca uma pendência como tratada fora da plataforma (reembolso,
  ajuste manual). Vale para concessões `blocked`, para as `applied` com
  `RENEWAL_BELOW_UPGRADE` e para o anual recusado antes da âncora cuja
  assinatura não foi cancelada ([Reserva na conclusão](#reserva-na-conclusão)).
- O plano de um pagamento bloqueado é ajustado pelos caminhos existentes
  (`usage:assignPlan`, `plans:confirmPayment`), nunca editando `billingGrants`.
  Uma fatura de cartão bloqueada com `ANNUAL_TERM_ACTIVE` não tem plano a
  ajustar, porque esses caminhos também recusam o mês coberto: o operador
  reembolsa pelo painel do Stripe e marca com `billing:resolveReview`.
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
Customers, Checkout Sessions, Coupons, Subscriptions e Billing Portal, e leitura de
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
recuperação, upgrade, downgrade, cancelamento e retomada, Pix seguido de
cartão sem dupla cobrança, duplicidade, evento repetido e atrasado, timeout
com nova tentativa, reembolso e contestação só sinalizados, acesso negado por
papel, sessão e organização, isolamento por Customer, modo e assinatura
inválida, abandono do Checkout e encerramento. Da fatura anual: termo na hora
e agendado, renovação sem intervalo entre os termos e sem nova reserva,
fatura repetida e fora de ordem, preço anual ausente ou diferente, valor,
moeda, atraso, âncora fora do dia 1, organização errada ou encerrada,
plano personalizado, interruptor desligado, recusa de admissão, a fatura
mensal de um mês coberto e a retomada recusada com outro termo agendado. Do
Checkout anual: os parâmetros exatos da sessão, a sessão concluída sem
fatura que libera a vaga, a cobrança do dia 1 lida pela conferência agendada
e virando termo e plano, a primeira cobrança com outro `billing_reason`
bloqueada, o evento de conclusão reenviado com o interruptor desligado, a
âncora na virada do ano, a reserva na conclusão, sem repetir numa
conclusão reenviada, que mantém a cobrança do dia 1 concedida com a janela
fechada e o estoque tomado depois, a recusa na conclusão sem reserva, com a
assinatura cancelada antes da âncora e mostrada no console, a reconferência
com o catálogo desligado ou o uso acima do plano, o cancelamento repetido
depois de uma falha, esgotado ou alcançado pela âncora sinalizado para uma
pessoa, o Checkout mensal sem reserva na conclusão, o Pix e o encerramento
pelo operador recusados à espera da
âncora, "Não renovar" antes dela, a sessão expirada sem conferência
agendada, o termo Pix que termina na âncora, a repetição pela mesma chave, inclusive com o interruptor
desligado depois, e as recusas por papel, membership, organização,
interruptor, preço anual ausente, termo em vigor ou agendado, Pix
aguardando, cartão mensal ou anual que renova, Checkout aberto, plano
personalizado, admissão e virada do mês. Do upgrade do anual, em
`tests/platform.annualPix.test.ts` e `tests/platform.billing.test.ts`: o
preço pelos meses restantes, no 1º mês e no último, o segmento ou a troca
de `tier`, o fim do termo mantido, a reserva dos R$ 172 de custódia, a
confirmação e a fatura repetidas, a troca de preço da assinatura anual uma
vez e a renovação no Grande na mesma âncora, a troca adiada por "Não
renovar" até a retomada, a renovação cobrada abaixo do upgrade sinalizada
para a equipe, e as recusas sem termo, com
termo ou renovação agendados, com o tier já em vigor, pela outra forma de
pagamento, com o interruptor desligado, com pedido ou Checkout pendente, na
virada do mês e nas últimas 72 horas do termo no cartão, fora do mês do
pedido, com assinatura de outro Customer, com valor diferente e com a admissão
recusada sem mexer no termo. Da rescisão, em
`tests/platform.annualTerms.test.ts`, `tests/platform.annualPix.test.ts`,
`tests/platform.billing.test.ts` e `tests/platform.closure.test.ts`: os
exemplos de R$ 894 no 4º mês, de R$ 1.231,33 com o upgrade no 5º mês e
rescisão no 8º, e do zero a partir do 10º mês; o reembolso integral nos
7 dias da compra e da renovação, com o acesso terminando na hora; o acesso
até o fim do mês e o plano terminando nele, com a reserva mantida; o upgrade
desfeito em 7 dias pelo Pix e pelo cartão, no 1º mês e depois, com a
assinatura voltando ao preço anual do Intermediário uma vez e a renovação
seguinte no Intermediário; a rescisão nos 7 dias do upgrade; a renovação
agendada rescindida junto e o pedido anual pendente cancelado; a assinatura
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
interruptor desligado, o preço e a economia, a escolha do início no Pix, o
Checkout anual que não cobra nada agora, o termo em vigor, agendado,
pendente e rescindido, o upgrade pelo Pix e pelo cartão, fechado nas
últimas 72 horas, o cancelamento da assinatura anual ainda não cobrada, as
pendências e as mensagens de cada código; a leitura do servidor, em
`tests/platform.annualPix.test.ts` e `tests/platform.billing.test.ts`.

### Prova do mensal no Stripe de teste (#668)

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
  comprova no sandbox as faturas anuais e seus upgrades, inclusive datas,
  valores e metadados, cancelamentos, reembolsos e a configuração corrigida
  do portal. Ainda faltam a integração hospedada e os itens
  operacionais listados em [Checkout anual](#checkout-anual),
  [Upgrade do anual](#upgrade-do-anual) e [Rescisão](#rescisão-do-anual).
- Smart Retries, portal e e-mails do Stripe dependem da configuração da conta.
- Tarifas, repasse e Invoicing precisam ser conferidos na conta.

### Prova hospedada e ativação do anual (#35)

Esta prova cobre o que a matriz de sandbox não cobriu: eventos entregues a um
backend hospedado, concessão gravada e lida pelo console conectado, e a
configuração padrão da conta. Ela roda no deployment de validação
(`modest-seal-118`), com chave de teste e
organização sintética. A produção não liga o catálogo só para provar. Cada
passo que escreve no Stripe ou no deployment precisa de autorização do
mantenedor.

1. **Conta de teste.** Preparar os itens 1 a 4 de
   [Configuração](#configuração), com o endpoint em
   `https://modest-seal-118.convex.site/v1/billing/stripe/events`, o host HTTP
   da validação: o Worker `freecorpsnfe-validation` só encaminha a
   autenticação e não chega a `/v1`.
   `node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto> --endpoint <essa URL>`
   passa com a chave de teste.
2. **Deployment.** Antes das variáveis, um `POST` sem assinatura nessa URL
   responde 404; depois de gravar `STRIPE_BILLING_SECRET_KEY` (`rk_test_…`) e
   `STRIPE_BILLING_WEBHOOK_SECRET`, responde 400. Ligar só na validação o
   catálogo (`plans:configure`, com a janela de admissão aberta) e o anual
   (`plans:configureAnnual`), com evidência citando a #35.
3. **Mensal.** O owner sintético contrata o Intermediário mensal pelo console
   com cartão de teste. Conferir os eventos `processed` em `billingEvents`, a
   concessão `applied` em `billingGrants` e o plano no console, sem
   "Conferir pagamento". "Cartão e faturas" abre o portal só com cartão e faturas.
4. **Anual no cartão.** Depois de "Cancelar renovação" na mensal, "Assinar …
   anual no cartão" termina `no_payment_required`, sem fatura, e o console
   mostra o termo agendado com a reserva de admissão. O Customer nasce no
   Checkout, sem relógio de teste, então a cobrança do dia 1 não pode ser
   antecipada. Por isso o Checkout deve ser feito nos últimos dias do mês. No
   dia 1, a fatura `subscription_cycle` paga vira termo `active`, pelo
   evento ou pela conferência agendada duas horas depois, e o console mostra
   o anual em vigor.
5. **Upgrade e rescisão.** Com o termo do cartão em vigor, o upgrade
   para o Grande e a rescisão (`plans:rescindTerm`) aparecem no console como
   em [Tela do anual no console](#tela-do-anual-no-console). Com o Pix
   desligado, o console não oferece o pedido Pix, e `plans:requestPaid`
   responde `PIX_DISABLED`.
6. **Repetição.** Reenviar pelo painel um evento já processado não cria
   efeito novo.
7. **Limpeza.** Cancelar as assinaturas de teste, desligar o anual
   (`plans:configureAnnual`) e fechar a janela de admissão na validação
   (`plans:configure` com `admissionsUntil` no passado: a mutation não
   desliga um catálogo já ligado) e retirar as variáveis, salvo decisão de
   manter o cartão de teste ali.
8. **Registro.** Num comentário da #35, registrar as datas, o SHA publicado na
   validação, os estados e códigos observados e o resultado de
   `node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto> --endpoint <URL do passo 1>`,
   sem chaves
   nem ids da conta.

Este roteiro descreve o início no dia 1 e nunca rodou. Pela
[ADR 0012](../adr/0012-periodo-por-aniversario.md), ele precisa ser reescrito
para o período por aniversário antes de rodar, e a ativação abaixo também
espera a implementação da ADR e uma versão nova dos termos de uso.

Depois da prova, a ativação em produção segue esta ordem:
`node scripts/check-billing-stripe.mjs --key-file <arquivo absoluto>`, sem `--endpoint`, com a chave
`live` contra o endpoint de produção, os
segredos no deployment de produção, o catálogo ligado e
`plans:configureAnnual` com `enabled: true` e evidência que cite a prova. O
Pix continua desligado.
Depois, conferir no console conectado que o anual aparece à venda. Os limites
da matriz continuam valendo: testes locais de Pix não são transferência real,
e 3DS, disputas, Smart Retries e e-mails não foram demonstrados.
