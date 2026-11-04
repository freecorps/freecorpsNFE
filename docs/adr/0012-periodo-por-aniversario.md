# Período por aniversário nas assinaturas e nas cotas pagas

Data: 03/11/2026 · Status: **Aceita** pelo dono do projeto em 03/11/2026.
**Não implementada:** até cada fatia de [Implementação](#implementação) ser
publicada, o código segue o mês civil UTC descrito em
[BILLING.md](../plataforma/BILLING.md) e [USAGE.md](../plataforma/USAGE.md).
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
começar o anual. Em 03/11/2026 o dono decidiu primeiro levar só o anual ao
aniversário, com as cotas no mês civil. No mesmo dia estendeu a decisão a
todas as assinaturas pagas e às cotas delas. Esta ADR registra o resultado.

## Decisão

O dono decidiu três coisas: toda assinatura paga vai de aniversário a
aniversário a partir da contratação, o anual no cartão começa e é cobrado na
contratação, e as cotas dos planos pagos seguem o mês da assinatura, com o
Gratuito no mês civil. O resto desta seção, inclusive as transições, o modelo
da seção 4 e o limite do 29/02 em [Consequências](#consequências), foi
adotado no desenho para cumprir essas decisões, sem decisão própria do dono;
uma mudança nesses pontos não reabre as três decisões.

### 1. Assinaturas por aniversário

Toda assinatura paga, mensal ou anual, começa no instante da contratação e
vai até o mesmo dia e horário do mês seguinte, no mensal, ou do ano seguinte,
no anual. Ela renova nesse aniversário.

- O período é semiaberto, [início, fim).
- Se o dia não existe no mês de destino, vale o último dia desse mês, no
  mesmo horário: 31/01 10:00 vai a 28/02 10:00, ou 29/02 em ano bissexto.
- Todo aniversário é calculado a partir do início original, nunca do
  anterior. Um início em 31/01 dá 28/02 e depois 31/03, sem deriva.
- O k-ésimo mês da assinatura vai do k-ésimo ao (k+1)-ésimo aniversário
  mensal. O termo anual tem 12 desses meses e termina no 12º.
- No cartão, a cobrança acontece na contratação, e o período começa nela. O
  anual deixa de esperar o dia 1 do mês seguinte, e a admissão é reservada
  quando a primeira fatura é concedida, como no mensal.
- No Pix assistido, desligado desde 03/11/2026 em `platformPlanSettings.pix`,
  o período começa na confirmação do pagamento, mensal ou anual. Não há mais
  a escolha de começar no dia 1 seguinte. A renovação de um termo Pix, pedida
  no último mês dele, começa no fim do termo corrente.
- Do mensal para o anual, o anual começa no pagamento, no cartão, ou na
  confirmação, no Pix, com cobrança cheia, e substitui o mensal sem desconto.
  No cartão, o cliente cancela antes a renovação do mensal, como hoje.
- O upgrade do Intermediário anual para o Grande anual cobra a diferença dos
  preços anuais dividida por 12 por mês restante do termo, com o corrente
  inteiro. O Grande vale desde o início do mês corrente do termo, e a data de
  renovação não muda.

### 2. Cotas pagas pelo mês da assinatura

O período de cota de um plano pago começa na âncora da assinatura e vira a
cada aniversário mensal dela. Um termo anual tem 12 períodos de cota. O
Gratuito continua no mês civil UTC
([ADR 0010, decisão 10](0010-guarda-em-camadas-e-custo-dos-planos.md#10-importação-e-cota-de-notas-do-gratuito)).

### 3. Reembolso pelo mês da assinatura

As regras de dinheiro da decisão 9 da ADR 0010 continuam: reembolso integral
até 7 dias depois de cada cobrança anual ou de upgrade; depois disso, o total
pago menos os meses usados, o corrente contado inteiro, cada um pelo preço
mensal cheio do tier em vigor nele, nunca negativo. Os meses contados passam
a ser os do termo. Na rescisão fora dos 7 dias, o acesso vai até o fim do mês
corrente do termo, e não mais do mês civil. Um Intermediário anual
iniciado em 15/10 às 14:30 e rescindido em 20/01 usou 4 meses, devolve
R$ 1.490 − 4 × R$ 149 = R$ 894 e mantém o acesso até 15/02 às 14:30.

### 4. Modelo do período de cota

- `usagePlans.periodAnchor`, opcional, é o instante cujos aniversários
  mensais abrem cada período de cota, em segundos inteiros. No cartão, é o
  `billing_cycle_anchor` do Stripe; no Pix, a confirmação truncada ao
  segundo. Sem âncora, o período é o mês civil UTC.
- A chave do período depende só do início dele. Um início no dia 1, às
  00:00:00.000 UTC, tem a chave `AAAA-MM`; qualquer outro, o instante em
  ISO 8601 UTC, como `2026-11-15T14:30:00.000Z`. Só essas formas são
  aceitas, e o ISO de um dia 1 à meia-noite é recusado. As linhas `AAAA-MM`
  atuais continuam válidas, uma âncora no dia 1 às 00:00 dá as chaves de
  hoje, e a ordem alfabética das chaves é a cronológica.
- `quotaPeriod(plano, instante)` devolve o mês civil do instante quando o
  plano não tem âncora ou o instante é anterior a ela. Nos outros casos,
  devolve o mês da âncora que contém o instante, do k-ésimo ao (k+1)-ésimo
  aniversário.

| Mudança                                                            | Âncora                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Do Gratuito para um plano pago no meio do mês                      | Nova; a chave é nova e os contadores começam do zero                                           |
| Renovação mensal, upgrade, downgrade, pagamento atrasado, rescisão | Mantida                                                                                        |
| Upgrade desfeito em 7 dias                                         | Mantida                                                                                        |
| Mensal para anual, assinatura nova ou início de termo anual        | Nova, no início da assinatura ou do termo                                                      |
| Personalizado ou interno por `usage:assignPlan`                    | Nenhuma, por padrão; o operador pode passar uma âncora até o início do plano                   |
| Personalizado comercial com o catálogo ligado                      | Obrigatória, por padrão o início do plano; o fim não passa do fim do período ancorado corrente |
| Gratuito                                                           | Nunca tem                                                                                      |

Invariantes:

1. O período de um contador é resolvido uma vez, na reserva, pelo plano lido
   na mesma transação, em vigor ou não. A liquidação usa o período gravado.
2. Toda chave gravada é canônica.
3. Sob uma âncora, os períodos são contíguos e semiabertos.
4. Uma linha paga do catálogo tem âncora até `startsAt`, e `endsAt` é um
   aniversário dela. Uma linha do Gratuito não tem âncora. A exigência de
   âncora em toda linha paga entra com o mensal no cartão (fatia 2a).
5. A mesma âncora dá sempre os mesmos períodos.
6. No cartão, a âncora é o `billing_cycle_anchor` da assinatura. Uma fatura
   mensal só concede o plano quando o período da linha é exatamente um mês
   dessa âncora; senão vai à revisão com `INVOICE_UNEXPECTED`.

## Consequências

- Na decisão 9 da ADR 0010, ficam substituídos "o acesso vai até o fim do mês
  civil corrente", nas duas vezes em que aparece; "no cartão, o anual começa
  no dia 1 do mês seguinte; 'imediatamente' é só pelo Pix"; e "Mensal para
  anual: começa no dia 1 do mês seguinte ou imediatamente". Valores, prazos e
  a decisão 10 não mudam.
- Nas políticas mensais da #556, em BILLING.md, ficam substituídos o mês
  civil UTC, a renovação no dia 1 e o item avulso com a mensalidade do mês
  corrente seguido de preço ancorado no dia 1. Continuam a primeira
  mensalidade integral, o upgrade pela diferença integral e o downgrade e o
  cancelamento na renovação.
- Os planos internos que já existem não têm âncora e continuam no mês civil.
  A mudança no esquema só acrescenta campos, sem migração.
- O contrato público da REST, do SDK e do OpenAPI não muda, porque não expõe
  o período. As funções Convex do console só ganham campos novos ou tornam
  campos opcionais.
- A seção 5A dos [termos de uso 1.1](../termos/arquivo/termos-de-uso-2026-11-02.md)
  define o mês do plano como o mês civil, a renovação no dia 1, o anual no
  dia 1 seguinte e o acesso até o fim do mês civil na rescisão. Uma versão
  nova dos termos precisa entrar no console antes de o catálogo ou o anual
  serem ligados.
- As provas no Stripe de teste da
  [#668](https://github.com/freecorps/freecorpsNFE-arquivo/issues/668) e da
  #35 assumiram o início no dia 1. Elas precisam ser refeitas
  ([ADR 0011](0011-entregas-graduais.md)), com relógios de teste em 31/01,
  31/03 e 29/02 que confirmem que o Stripe ajusta o dia como esta ADR.
- Um termo no cartão iniciado em 29/02 termina em 28/02, e a renovação começa
  nesse dia. Se o Stripe voltar a cobrar em 29/02 no bissexto seguinte, a
  cadeia fica um dia sem termo a cada quatro anos. Esse intervalo fica como
  limite conhecido, documentado e não corrigido.

## Implementação

Não implementada. A ordem das fatias:

1. Fatia 0: esta ADR, só documentação.
2. Fatia 1a: aritmética de aniversário nos termos anuais, sem mudar
   comportamento. Num início no dia 1 às 00:00 UTC, o aniversário coincide
   com o mês civil, e os termos gravados continuam válidos.
3. Fatia Q: modelo do período de cota (`periodAnchor`, chaves canônicas,
   `quotaPeriod`), sem mudar comportamento. Os termos anuais passam a âncora;
   os caminhos mensais ainda não.
4. Fatia 1b: anual pelo Pix a partir da confirmação e guardas de termo por
   instante.
5. Fatia 1c: mensal pelo Pix nos aniversários.
6. Fatia 2a: mensal no cartão cobrado na contratação, com as invariantes
   4 e 6.
7. Fatia 2b: anual no cartão cobrado na contratação, sem o Checkout
   ancorado no dia 1.
8. Nova versão dos termos de uso.

Cada fatia atualiza BILLING.md e USAGE.md na mesma PR.

## Alternativas recusadas pelo dono

O dono escolheu entre estas e as decisões acima em 03/11/2026.

- Só o anual por aniversário, com o mensal e as cotas no mês civil, como na
  primeira decisão do dia. Com a cota no mês civil, um pagamento em 20/11
  cobre até 20/12 e dá duas cotas mensais, a de novembro e a de dezembro.
- Cota proporcional nos meses civis das pontas da assinatura. Com o período
  de cota igual ao mês pago, cada pagamento corresponde a uma cota inteira.
