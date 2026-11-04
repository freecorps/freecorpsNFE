# Período por aniversário nas assinaturas e nas cotas pagas

Data: 03/11/2026 · Status: **Aceita** pelo dono do projeto em 03/11/2026.
**Implementada no código nas fatias 0 a 2b** de
[Implementação](#implementação), descritas em
[BILLING.md](../plataforma/BILLING.md) e [USAGE.md](../plataforma/USAGE.md).
Ligar o catálogo ou o anual ainda espera a versão nova dos termos de uso e a
[prova hospedada](../plataforma/BILLING.md#prova-hospedada-e-ativação-do-anual-35).
Esta ADR substitui pontos da
[decisão 9 da ADR 0010](0010-guarda-em-camadas-e-custo-dos-planos.md#9-anual-reembolso-e-ciclo)
e das políticas mensais da #556, listados em [Consequências](#consequências).

## Contexto

Hoje todo plano pago vive no mês civil UTC. A mensalidade é integral mesmo
contratada no meio do mês, e o cartão renova no dia 1 (#556). No cartão, o
anual começa e é cobrado no dia 1 do mês seguinte; até lá, o mês corrente
fica no plano anterior. Para isso o
[Checkout anual](../plataforma/BILLING.md#checkout-anual) precisa de âncora no
dia 1, de uma conferência agendada depois dela e da recusa da admissão antes
da cobrança. As cotas de uso também são por mês civil UTC.

Quem assina em 20/11 paga um mês inteiro por 11 dias, ou espera o dia 1 para
começar o anual. Na manhã de 03/11/2026 o dono decidiu levar só o anual ao
aniversário, com o mensal e as cotas no mês civil. Horas depois, no mesmo
dia, substituiu essa decisão pelas três abaixo, que valem para todas as
assinaturas pagas e para as cotas delas.

## Decisão

O dono decidiu três coisas: toda assinatura paga vai de aniversário a
aniversário a partir da contratação, o anual no cartão começa e é cobrado na
contratação, e as cotas dos planos pagos seguem o mês da assinatura, com o
Gratuito no mês civil. Tudo o mais nesta seção é desenho, adotado para
cumprir essas decisões sem decisão própria do dono. Isso inclui os detalhes
das seções 1 e 2 (cálculo em UTC, ajuste ao último dia do mês, âncora
original, início e renovação pelo Pix, Grande desde o início do mês corrente
do termo, lista de métricas), as seções 3 e 4 inteiras e as consequências de
desenho em [Consequências](#consequências). A regra de
[um plano pago por vez](#um-plano-pago-por-vez), que cobre a troca de forma
de pagamento e a passagem do mensal ao anual, também é desenho, aprovado
pelo dono em 03/11/2026. Uma mudança no desenho não reabre as três decisões.

### 1. Assinaturas por aniversário

Toda assinatura paga, mensal ou anual, começa no instante da contratação e
vai até o mesmo dia e horário do mês seguinte, no mensal, ou do ano seguinte,
no anual. Ela renova nesse aniversário.

- O período é semiaberto, [início, fim).
- Aniversários, dia do mês e ajuste ao fim do mês são calculados em UTC. Uma
  contratação à noite em Brasília, a partir das 21:00, cai no dia seguinte em
  UTC, e o aniversário fica nesse dia.
- Se o dia não existe no mês de destino, vale o último dia desse mês, no
  mesmo horário: 31/01 10:00 UTC vai a 28/02 10:00 UTC, ou 29/02 em ano
  bissexto.
- Todo aniversário é calculado a partir da âncora original, nunca do
  anterior. Uma âncora em 31/01 dá 28/02 e depois 31/03, sem deriva.
- Os meses contam a partir de 1. O 1º mês vai do início, o aniversário 0, ao
  1º aniversário mensal; o k-ésimo, do aniversário k − 1 ao aniversário k. O
  termo anual tem 12 meses; o que começa na âncora termina no 12º
  aniversário mensal.
- Termos anuais e períodos de cota saem da âncora original da cadeia. Um
  termo cobre 12 meses seguidos da âncora, do aniversário mensal m ao
  m + 12, e a renovação continua do fim dele. No cartão, a âncora é o
  `billing_cycle_anchor` da assinatura do Stripe (invariante 6), e o n-ésimo
  termo vai do aniversário 12(n − 1) ao 12n. Uma assinatura iniciada em
  29/02/2028 tem termos que viram em 28/02/2029, 28/02/2030, 28/02/2031 e
  29/02/2032, sem intervalo, como o Stripe deve cobrar. No Pix, a âncora é
  a confirmação que abriu a cadeia, e as renovações a mantêm.
- No cartão, a cobrança acontece na contratação, e o período começa nela. O
  anual deixa de esperar o dia 1 do mês seguinte, e a admissão é reservada
  quando a primeira fatura é concedida, como no mensal.
- No Pix assistido, desligado desde 03/11/2026 em `platformPlanSettings.pix`,
  um plano novo começa na confirmação do pagamento, com âncora nova, e uma
  renovação começa no fim do plano em vigor. Não há mais a escolha de começar
  no dia 1 seguinte.
- O upgrade do Intermediário anual para o Grande anual cobra a diferença dos
  preços anuais dividida por 12 por mês restante do termo, com o corrente
  inteiro. O Grande vale desde o início do mês corrente do termo, e a data de
  renovação não muda.

#### Um plano pago por vez

Esta regra é desenho, aprovado pelo dono em 03/11/2026, e não uma quarta
decisão. Uma organização tem no máximo um plano pago em vigor. Enquanto ele
vale, só três vendas cabem:

- **Upgrade.** Fica na mesma cadeia, com a mesma âncora, e cobra a
  diferença. Num mensal Pix em vigor, o pedido de um tier maior é upgrade
  pela diferença, cobrada agora, no mesmo período, como hoje.
- **Renovação.** É pedida no último mês do plano em vigor, começa no fim
  dele e mantém a âncora. No cartão, a renovação é automática. Num mensal Pix
  em vigor, o pedido do mesmo tier ou de um tier menor é a renovação no fim
  dele, e o pedido de um anual Pix também. Um mensal pedido no último mês de
  um termo anual é renovação que começa no fim do termo, com a mesma âncora.
- **Anual no cartão sobre um mensal.** Com um mensal em vigor de tier igual
  ou menor, o anual no cartão é cobrado e começa na hora, com âncora nova, e
  substitui o mensal sem desconto (segunda decisão do dono). Se o mensal é do
  cartão, o cliente cancela antes a renovação dele, como hoje.

Qualquer outra venda espera o fim do plano em vigor. Ela é recusada com um
código que informa a data em que fica disponível. Entram aqui:

- o mensal no cartão com um plano Pix em vigor;
- o Pix com um plano do cartão em vigor, mesmo depois de cancelada a
  renovação, enquanto o período pago corre;
- a mudança para um tier menor fora da renovação;
- um mensal durante um termo anual, fora do último mês dele
  (`ANNUAL_TERM_ACTIVE`, como hoje);
- um anual menor que o mensal em vigor para começar na hora, como o
  Intermediário anual no cartão sobre o Grande mensal (`PLAN_UNAVAILABLE`,
  como hoje). Pelo Pix, ele só entra como renovação, no fim do mensal.

Não existe início adiado: nenhuma venda é paga agora para começar depois,
exceto a renovação. Trocar a forma de pagamento abre uma cadeia nova, com
âncora nova, e pode deixar um intervalo entre o fim de um plano e a compra do
outro. Com o Pix desligado, isso só importa quando ele voltar a ser ligado.

### 2. Cotas pagas pelo mês da assinatura

O período de cota de um plano pago começa na âncora da assinatura e vira a
cada aniversário mensal dela. Um termo anual tem 12 períodos de cota. O
Gratuito continua no mês civil UTC
([ADR 0010, decisão 10](0010-guarda-em-camadas-e-custo-dos-planos.md#10-importação-e-cota-de-notas-do-gratuito)).

A regra vale para todas as cotas mensais dos planos pagos:

- toda métrica de `usageTotals` sob a chave do período: importação, captura,
  CNPJ, bytes recebidos e webhooks, com cota, e documentos, `attempts` e
  `issuances`, só medidos. A cota de notas é só do Gratuito;
- as de capacidade, em `capacityTotals` e `capacityEvents`, por
  `capacityCore`: leituras REST, downloads, exportações e bytes de
  exportação;
- a retomada da captura parada por cota, que hoje espera
  `nextUsagePeriodStart` em `captureProcessing` e passa a esperar o fim do
  período de cota do plano.

As métricas de estoque, como os bytes guardados, não são periódicas e não
mudam.

### 3. Reembolso pelo mês da assinatura

As regras de dinheiro da decisão 9 da ADR 0010 continuam. Até 7 dias depois
de cada cobrança anual, o reembolso do termo é integral. Uma cobrança de
upgrade desfeita até 7 dias depois dela volta inteira, só ela
([ADR 0010, decisão de 31/10/2026](0010-guarda-em-camadas-e-custo-dos-planos.md#9-anual-reembolso-e-ciclo)).
Depois disso, o cliente recebe o total pago menos os meses usados, o corrente
contado inteiro, cada um pelo preço mensal cheio do tier em vigor nele,
nunca negativo.

Os meses contados passam a ser os da assinatura. Na rescisão fora dos 7
dias, o acesso vai até o fim do mês corrente da assinatura, e não mais do mês
civil. Um Intermediário anual iniciado em 15/10 às 14:30 UTC e rescindido em
20/01 está no 4º mês, de 15/01 a 15/02 às 14:30 UTC. Ele devolve
R$ 1.490 − 4 × R$ 149 = R$ 894 e mantém o acesso até 15/02 às 14:30 UTC.

### 4. Modelo do período de cota

- `usagePlans.periodAnchor`, opcional, é o instante cujos aniversários
  mensais abrem cada período de cota. Ele fica em milissegundos desde a
  época, como o Convex guarda instantes, truncado ao segundo inteiro, porque
  a âncora do Stripe é em segundos. No cartão, é o `billing_cycle_anchor` da
  assinatura; no Pix, a âncora descrita na seção 1. Sem âncora, o período é
  o mês civil UTC.
- A chave do período depende só do início dele. Um início no dia 1, às
  00:00:00.000 UTC, tem a chave `AAAA-MM`; qualquer outro, o instante na
  forma exata de `Date.prototype.toISOString()`, `AAAA-MM-DDTHH:mm:ss.sssZ`,
  como `2026-11-15T14:30:00.000Z`. Só essas duas formas são aceitas: outra
  escrita do mesmo instante (sem milissegundos, com `+00:00`) e o ISO de um
  dia 1 à meia-noite são recusados. As linhas `AAAA-MM` atuais continuam
  válidas, uma âncora no dia 1 às 00:00 dá as chaves de hoje, e a ordem
  alfabética das chaves canônicas é a cronológica.
- `quotaPeriod(plano, instante)` devolve o mês civil do instante quando o
  plano não tem âncora ou o instante é anterior a ela. Nos outros casos,
  devolve o mês da âncora que contém o instante, do aniversário mensal k − 1
  ao aniversário k. Um instante anterior à âncora só aparece quando a linha
  lida ainda não começou, como um plano agendado; até a âncora, vale o mês
  civil do instante.
- Cada linha de plano começa o próprio regime no seu `startsAt`: o ancorado,
  se tiver âncora, ou o mês civil, se não tiver. Uma linha que substitui
  outra ancorada, como a de `usage:assignPlan` com o catálogo desligado (há
  uma linha de `usagePlans` por organização), não herda a âncora dela. Os
  contadores já gravados na chave ancorada ficam nela.

| Mudança                                                                                      | Âncora                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do Gratuito para um plano pago no meio do mês                                                | Nova; a chave é nova e os contadores começam do zero                                                                                                                       |
| Renovação, inclusive do mensal ao anual pelo Pix e do anual ao mensal no último mês do termo | Mantida; o plano novo começa no fim do anterior                                                                                                                            |
| Upgrade, downgrade na renovação, pagamento atrasado, rescisão, upgrade desfeito em 7 dias    | Mantida                                                                                                                                                                    |
| Anual no cartão sobre um mensal de tier igual ou menor                                       | Nova, na contratação; o anual substitui o mensal                                                                                                                           |
| Plano novo sem plano pago em vigor, inclusive com outra forma de pagamento                   | Nova, na contratação ou na confirmação                                                                                                                                     |
| Outra venda com plano pago em vigor                                                          | Nenhuma: recusada até o fim do plano em vigor                                                                                                                              |
| Do plano pago para o Gratuito                                                                | Não há caminho automático: `plans:claimFree` recusa uma organização que já teve linha de plano                                                                             |
| Personalizado ou interno por `usage:assignPlan`, a partir da fatia Q                         | Catálogo desligado: nenhuma por padrão, e o operador pode passar uma até `startsAt`. Catálogo ligado: obrigatória, por padrão `startsAt`, e `endsAt` é um aniversário dela |
| Gratuito                                                                                     | Nunca tem                                                                                                                                                                  |

Invariantes:

1. O período de um contador é resolvido uma vez, na reserva, pelo plano lido
   na mesma transação, em vigor ou não. A liquidação usa o período gravado.
2. Toda chave gravada é canônica, exceto a chave fixa `stock`, que
   `capacityTotals` e `capacityEvents` usam para as métricas de estoque.
3. Sob uma âncora, os períodos de cota são contíguos e semiabertos, e os
   termos anuais da mesma cadeia também, porque todos saem da âncora
   original.
4. Toda linha paga do catálogo tem âncora até `startsAt`, e `endsAt` é um
   aniversário dela; a exigência vale a partir da fatia 2a. Uma linha do
   Gratuito não tem âncora. No Personalizado, a âncora é opcional com o
   catálogo desligado e obrigatória com ele ligado, a partir da fatia Q.
5. A mesma âncora dá sempre os mesmos períodos.
6. No cartão, a âncora é o `billing_cycle_anchor` da assinatura. Uma fatura
   mensal só concede o plano quando o período da linha é exatamente um mês
   dessa âncora, e uma fatura anual, quando é exatamente um ano dela. Senão,
   a fatura vai à revisão com `INVOICE_UNEXPECTED`.
7. Uma organização tem no máximo um plano pago em vigor. Com ele em vigor, só
   entram o upgrade, a renovação e o anual no cartão sobre um mensal de tier
   igual ou menor, e nenhuma outra venda paga agora para começar depois.

## Consequências

- Na decisão 9 da ADR 0010, as decisões do dono substituem "no cartão, o
  anual começa no dia 1 do mês seguinte; 'imediatamente' é só pelo Pix". O
  resto vem do desenho. Pela seção 1, a escolha do Pix entre o dia 1 e o
  início imediato deixa de existir: o Pix começa na confirmação ou, na
  renovação pedida no último mês, no fim do plano em vigor. Pela regra de um
  plano pago por vez, "Mensal para anual: começa no dia 1 do mês seguinte ou
  imediatamente, com cobrança cheia, à escolha do cliente" passa a ser o
  anual no cartão cobrado e iniciado no pagamento, com cobrança cheia, sobre
  um mensal de tier igual ou menor, ou o anual Pix como renovação no fim do
  mensal; no cartão, um anual menor que o mensal em vigor espera o fim dele.
  Pela seção 3, "o acesso vai até o fim do mês civil corrente", nas duas
  vezes em que aparece, passa a ser o fim do mês corrente da assinatura.
  Valores, prazos e a decisão 10 não mudam.
- Nas políticas mensais da #556, em BILLING.md, ficam substituídos o mês
  civil UTC, a renovação no dia 1 e o item avulso com a mensalidade do mês
  corrente seguido de preço ancorado no dia 1. Continuam a primeira
  mensalidade integral, o upgrade pela diferença integral e o downgrade e o
  cancelamento na renovação.
- As linhas "Mês já pago por Pix" de
  [Contratação e ciclo](../plataforma/BILLING.md#contratação-e-ciclo), com
  R$ 0 agora no mesmo plano, a diferença agora no plano maior e o plano menor
  na renovação, dão lugar a "espera o fim do plano em vigor": o mensal no
  cartão só é vendido depois que o plano Pix termina.
- Cada termo anual precisa conhecer a âncora da sua cadeia, gravada ou
  derivada; as fatias 1b e 2b decidem como.
- Os planos internos que já existem não têm âncora e continuam no mês civil.
  O esquema não exige migração.
- O contrato público da REST, do SDK e do OpenAPI não muda, porque não expõe
  o período. As funções Convex do console mudam. Como o console não consegue
  mais calcular a chave do período sozinho, `usage:overview` passa a receber
  a chave do período e `asOf`, opcionais, e devolve o período com início e
  fim e as chaves recentes. Os campos `period` da cobrança e do Pix ficam
  opcionais, e o console deixa de lê-los como `AAAA-MM`.
- A seção 5A dos [termos de uso 1.1](../termos/arquivo/termos-de-uso-2026-11-02.md)
  define o mês do plano como o mês civil, a renovação no dia 1, o anual no
  dia 1 seguinte e o acesso até o fim do mês civil na rescisão. Ela também
  diz que a contratação recusada antes do início é cancelada sem cobrança;
  com a cobrança na contratação, uma recusa da admissão depois do pagamento
  vira reembolso manual. Ligar o catálogo ou o anual passa a esperar a
  implementação desta ADR e uma versão nova dos termos no console.
- Só a prova mensal da
  [#668](https://github.com/freecorps/freecorpsNFE-arquivo/issues/668),
  contratada em 10/10/2026 com renovação ancorada no dia 1, e a matriz de
  sandbox de BILLING.md, também ancorada no dia 1, foram executadas e
  precisam ser refeitas
  ([ADR 0011](0011-entregas-graduais.md)). O roteiro da #35, em
  [Prova hospedada e ativação do anual](../plataforma/BILLING.md#prova-hospedada-e-ativação-do-anual-35),
  foi reescrito para este modelo na fatia 2b e ainda não rodou. As
  provas novas usam relógios de teste em 31/01, 31/03 e 29/02 para confirmar
  que o Stripe ajusta o dia e renova os anos da âncora como esta ADR.

## Implementação

As fatias 0 a 2b estão implementadas no código. Ligar o catálogo ou o anual
espera a fatia 8, os termos de uso 1.2, e a prova hospedada. A ordem das
fatias:

1. Fatia 0: esta ADR, só documentação.
2. Fatia 1a: aritmética de aniversário nos termos anuais, sem mudar
   comportamento. Num início no dia 1 às 00:00 UTC, o aniversário coincide
   com o mês civil, e os termos gravados continuam válidos.
3. Fatia Q: modelo do período de cota (`periodAnchor`, chaves canônicas,
   `quotaPeriod`) nas cotas de uso, nas de capacidade (`capacityCore`) e na
   retomada da captura (`captureProcessing`), sem mudar comportamento. Os
   termos anuais passam a âncora; os caminhos mensais ainda não. A regra do
   Personalizado começa a valer: a guarda de `usage:assignPlan` que hoje
   recusa com `INVALID_REQUEST` um `endsAt` depois de
   `nextUsagePeriodStart(now)` muda para que um Personalizado comercial
   termine num aniversário da sua âncora.
4. Fatia 1b: anual pelo Pix a partir da confirmação, âncora da cadeia nos
   termos e guardas de termo por instante.
5. Fatia 1c: mensal pelo Pix nos aniversários; as concessões mensais pelo Pix
   ganham âncora. Até a fatia 2a, as concessões mensais do cartão continuam
   no mês civil.
6. Fatia 2a: mensal no cartão renovado no aniversário, sem âncora no dia 1
   nem item avulso, com as invariantes 4 e 6.
7. Fatia 2b: anual no cartão cobrado na contratação, nos anos da âncora, sem
   o Checkout ancorado no dia 1.
8. Nova versão dos termos de uso.

Cada fatia aplica a regra de um plano pago por vez (invariante 7) aos
caminhos de venda que muda e atualiza BILLING.md e USAGE.md na mesma PR.

## Alternativas recusadas pelo dono

O dono escolheu entre estas e as decisões acima em 03/11/2026.

- Cotas no mês civil com as assinaturas por aniversário. Uma mensalidade de
  20/11 a 20/12 daria a cota de novembro e a de dezembro, e um anual iniciado
  em 20/11 toca 13 meses civis.
- Cota proporcional nos meses civis das pontas da assinatura. Com o período
  de cota igual ao mês pago, cada pagamento corresponde a uma cota inteira.
