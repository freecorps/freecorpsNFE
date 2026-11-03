# Catálogo de planos da plataforma

Redesenho comercial e de produto aprovado para a #429 em 27/10/2026.
Gratuito permanente, Intermediário de R$ 149/mês, Grande de R$ 499/mês e
Personalizado por orçamento, sem piso público. Não há implantação obrigatória.
Consultoria de integração é opcional, a R$ 180/h, mediante contratação prévia.
Esta versão substitui a referência assistida de R$ 299/R$ 999 e seu piso de
R$ 2.490, inclusive as taxas de implantação daquela referência.

**O catálogo permanece desligado para lançamento. Estes preços ainda não são
ofertados.** O aceite do desenho não prova restauração real, arquivo econômico,
margem medida nem configuração real dos fundos. Todos esses gates precisam
ser satisfeitos antes da admissão comercial. Não houve alteração remota de
assinatura, atribuição ou cobrança neste trabalho.

Em 27/10/2026, o mantenedor decidiu manter o catálogo desligado e registrar
o déficit da guarda quente de organizações abertas como bloqueio de
lançamento, sem rever agora preços, cotas, estoque ou aportes. O financiamento
dessa guarda, o backup integral do Grande, o R2 real, os textos e o aceite da
oferta seguem na [#549](https://github.com/freecorps/freecorpsNFE-arquivo/issues/549).
A #429 fica com plano obrigatório na captura em Produção, reserva de bytes,
migração do consumo por ambiente e prova complementar de carga.

Em 28/10/2026, o mantenedor decidiu financiar essa guarda pela custódia
fria de organizações abertas, com reidratação sob IDs novos
([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md)). Recusou
aporte maior, revisão de preço ou estoque e reserva mensal de margem. A
custódia está implementada e desligada, sem prova operacional completa
([consolidação na #549](https://github.com/freecorps/freecorpsNFE-arquivo/issues/549#issuecomment-6530738648)).
O catálogo continua desligado.

Em 29/10/2026, o mantenedor decidiu levar o Intermediário a 5 empresas
e criar o plano anual com dois meses grátis (R$ 1.490 e R$ 4.990, por cartão
no Stripe e Pix assistido), ligado só depois da fase E da ADR. No Gratuito,
a Produção passa a admitir no máximo 100 notas novas por mês, somando
importação e captura, no lugar da cota de consultas de captura; no Sandbox,
a cota de teste continua a de hoje. Os planos pagos mantêm as unidades atuais
([ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md), decisões 4,
9, 10 e 11). As 5 empresas do Intermediário e a cota de notas do Gratuito já
estão no catálogo. A #667 conferia as notas novas do lote NFS-e na leitura,
até a retirada da importação ABRASF em 02/11/2026. A série D3 já entregou preço, chave,
termo, Pix assistido, concessão pela fatura anual do Stripe e Checkout anual
(#655, #660, #663, #666 e #675), e o upgrade do Intermediário anual para o
Grande anual. Console e rescisão, com o reembolso, ainda faltam.
O interruptor anual e o catálogo continuam desligados, sem oferta anual
([cobrança](BILLING.md#plano-anual)).

A fonte das cotas é
[`planCatalog.ts`](../../platform/convex/lib/planCatalog.ts). O modelo
`paid-plans.mjs` importa esse
catálogo diretamente. A [memória de custos](PLATFORM-COSTS.md) documenta as
hipóteses e falhas; a [comparação de mercado](PLATFORM-MARKET-COMPARISON.md)
não demonstra equivalência de volume nem disposição a pagar.

## Preços e escopo

| Condição                                    | Gratuito                  | Intermediário | Grande             | Personalizado                               |
| ------------------------------------------- | ------------------------- | ------------- | ------------------ | ------------------------------------------- |
| Mensalidade do catálogo, ainda não ofertada | R$ 0                      | R$ 149        | R$ 499             | Por orçamento, sem piso público             |
| Implantação obrigatória                     | Não                       | Não           | Não                | Não                                         |
| Vigência                                    | Sem vencimento            | Mensal        | Mensal             | Acordada no orçamento                       |
| Organizações incluídas                      | 1                         | 1             | 1                  | Definidas no orçamento                      |
| Empresas administradas                      | 1                         | 5             | 10                 | Definidas no orçamento                      |
| Membros                                     | 2                         | 5             | 15                 | Definidos no orçamento                      |
| Projetos de integração                      | 1                         | 3             | 10                 | Definidos no orçamento                      |
| Concorrência de operações                   | 1                         | 2             | 4                  | Definida no orçamento                       |
| Suporte                                     | Documentação e comunidade | E-mail        | E-mail prioritário | Canal acordado                              |
| SLA de disponibilidade                      | Não                       | Não           | Não                | Exige contrato e infraestrutura compatíveis |

Todos incluem console, API REST e SDK para os modelos já suportados. Emissão
fiscal real, certificado A1, desenvolvimento sob medida e consultoria fiscal
ou contábil não estão incluídos. O certificado da empresa fica no cofre.
Incidentes do produto não viram consultoria cobrada.

Primeira resposta em dois dias úteis no Intermediário e um no Grande são
metas operacionais em avaliação, das 9h às 18h de Brasília. Não são SLA de
resolução nem disponibilidade do fisco. Os custos-alvo de suporte são apenas
R$ 12 e R$ 50 por organização/mês; sua capacidade de atender essas metas
precisa ser medida. Não anunciar os prazos antes dessa prova. A consultoria
opcional não financia o custo obrigatório do plano no modelo.

## Cotas mensais

As cotas por ambiente valem com saldos inteiros e independentes em Sandbox e
Produção. As notas novas só existem em Produção, e só no Gratuito: ali elas
substituem os arquivos importados e as consultas de captura, que no Gratuito
ficam como cota de teste do Sandbox. As cotas por organização somam os
ambientes. Nenhuma cota acumula. Uma consulta de captura pode retornar
documentos, resumos, eventos ou nenhum resultado; não equivale a uma nota.
Uma nota é uma chave de acesso nova por empresa, somando importação e captura;
resumo, XML completo e eventos da mesma chave contam uma vez
([USAGE.md](USAGE.md#cota-de-notas-do-gratuito)).

| Unidade                                   |     Gratuito | Intermediário |  Grande |
| ----------------------------------------- | -----------: | ------------: | ------: |
| Notas novas / Produção                    |          100 |             — |       — |
| Arquivos importados / ambiente            | 100, Sandbox |         1.000 |   5.000 |
| Consultas de captura / ambiente           | 100, Sandbox |         1.000 |   5.000 |
| Bytes recebidos / ambiente                |       64 MiB |       128 MiB | 512 MiB |
| Consultas CNPJ despachadas / ambiente     |           10 |           100 |     500 |
| Entregas de webhook / ambiente            |          300 |         3.000 |  15.000 |
| Leituras REST / organização               |        2.000 |        10.000 |  50.000 |
| Downloads / organização                   |      256 MiB |         1 GiB |   4 GiB |
| Exportações geradas / organização         |            2 |            10 |      30 |
| Bytes de exportação gerados / organização |      256 MiB |         1 GiB |   4 GiB |

O Personalizado fixa cada unidade no orçamento, sem cota ilimitada implícita.
MiB são 1.048.576 bytes e GiB são 1.073.741.824 bytes. Importação e captura
compartilham entrada em bytes; captura conta bruto e expandido. Cada download
conta outra transferência, inclusive ao baixar novamente o mesmo ZIP, sem
contar outra geração. Retry técnico mantém a identidade de [USAGE.md](USAGE.md).

A proposta usa mês civil UTC, com primeira mensalidade integral porque concede
a franquia inteira. O cliente escolhe iniciar agora ou no próximo mês antes
do pagamento. Implantação não é cobrada. Em 27/10/2026 o mantenedor escolheu
cobrar por cartão recorrente no Stripe, mantendo o Pix assistido (#556): o
cartão renova no dia 1, 00:00 UTC, com as mesmas regras de upgrade, downgrade e
cancelamento, e o Pix continua sem débito automático. Inadimplência sem
carência e reembolso ou contestação só sinalizados foram decididos em
28/10/2026. A integração está em [BILLING.md](BILLING.md) e não liga o
catálogo, que segue desligado.

A #639 já permite renovar reutilizando a alocação depois de `admissionsUntil`.
A janela continua exigida quando há nova reserva, como na primeira adesão
ou no upgrade; o catálogo precisa estar ligado em ambos os casos
([janela de admissão](BILLING.md#janela-de-admissão)).

## Estoque e crescimento

| Estoque acumulado por organização, somando ambientes | Gratuito | Intermediário |  Grande |
| ---------------------------------------------------- | -------: | ------------: | ------: |
| Arquivos originais e lotes de captura                |  128 MiB |       512 MiB |   2 GiB |
| Banco lógico medido pelo guard                       |   32 MiB |        64 MiB | 256 MiB |

Estoque não renova a cada mês e não é multiplicado por empresa, projeto ou
membro. O guard usa `getDocumentSize`, incluindo os campos de sistema dos
registros que contabiliza. Não mede índices nem equivale ao banco físico
faturado. A cobertura das tabelas, o inventário anterior e o consumo físico
precisam de reconciliação. Em especial, 64 MiB de banco lógico não são uma
promessa de quantidade de notas ou um teto de fatura.

O banco pode limitar antes dos arquivos. Itens, eventos, histórico e registros
de operação também crescem. Sem novas entradas, retenção e auditoria ainda
custam dinheiro. O modelo varia amplificação física, tamanho serializado do
snapshot, I/O e suporte separadamente; nenhum deles foi medido nesta revisão.

No Gratuito, a entrada máxima em ambos os ambientes pode preencher os 128 MiB
no primeiro mês. Intermediário e Grande podem preencher arquivos em dois
meses. A conta gratuita não vence, mas novas entradas param no limite. Não
apagar originais ou encurtar a [retenção](RETENTION.md) para liberar capacidade.
Exports temporários exigem capacidade própria e reserva do pico de geração.

As antigas expansões de R$ 39/GiB e R$ 129/256 MiB não integram este catálogo.
Ampliação de estoque, banco ou tráfego exige orçamento Personalizado, avaliação
de capacidade e aporte da Freecorps antes da admissão. Não há excedente automático.

## Contratação, mudanças e cancelamento

### Uso da faixa gratuita e prevenção de abuso

A gratuidade beneficia pequenos negócios e não pode ser multiplicada pelo
mesmo beneficiário ou por empresas sob controle comum para contornar as cotas
ou substituir um plano pago. Criar contas, organizações ou usar e-mails
diferentes não dá direito a acumular franquias gratuitas para essa finalidade.
Por exemplo, quem administra cinco CNPJs próprios não pode contratar cinco
Gratuitos para evitar o Intermediário, que inclui cinco empresas.

Suspeitas exigem revisão manual e oportunidade de esclarecimento. Compartilhar
contador, prestador de serviço ou endereço IP, isoladamente, não comprova abuso.
Confirmado o fracionamento, solicitar regularização em um plano compatível,
sem cobrança automática, exclusão de documentos ou redução da guarda.
O procedimento de aviso e eventual restrição do benefício deve constar dos
termos aprovados antes da oferta.

**Cobertura atual:** o produto limita a adesão gratuita a uma organização por
usuário proprietário e a uma empresa por organização gratuita. Ainda não
identifica controle comum entre CNPJs nem relaciona contas de pessoas distintas.
Essa verificação e o procedimento de tratamento são pendências de lançamento;
a regra comercial não deve ser apresentada como bloqueio automático implementado.

### Condições de contratação

- Atingir cota mensal recusa novas intenções daquela unidade; estoque continua
  ocupado na virada do mês. Trabalho já admitido termina ou reconcilia.
- Upgrade conserva consumo e cobra a diferença integral entre mensalidades
  quando amplia a franquia do mês corrente. Intermediário para Grande custa
  R$ 350 adicionais. A Freecorps complementa previamente o aporte em R$ 172;
  não transfere essa obrigação ao cliente como implantação ou taxa de custódia.
- Downgrade vale no próximo mês se uso, estoque e escopo couberem. Caso contrário,
  exige ajuste contratado ou encerramento, sem apagar histórico para enquadrar.
- Cancelamento impede renovação, sem multa ou permanência mínima. O período
  pago mantém seu acesso até o fim. Não há reembolso proporcional proposto,
  salvo exigência aplicável ou acordo. A seção 5A dos
  [termos de uso 1.0](../termos/arquivo/termos-de-uso-2026-11-01.md) traz estas regras
  e as da [cobrança](BILLING.md#políticas-decididas-em-28102026).
- Cancelar o plano e encerrar a organização são ações distintas. A janela de
  exportação e a guarda de [RETENTION.md](RETENTION.md) continuam valendo.
  Direitos de acesso e portabilidade têm atendimento autorizado quando
  necessário; franquia comercial não elimina esses direitos.
- O arquivo econômico de organizações abertas está implementado conforme a
  [ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md), com
  reidratação sob IDs novos, plano ativo nos pagos e estoque dentro da
  capacidade. Enquanto arquivada, a organização continua aberta, recusa
  novas admissões fiscais e atende direitos de acesso por exportação
  assistida. O gate segue desligado: registros e originais continuam quentes
  no hospedado, sem prova operacional completa nem promessa de reativação
  em dois dias.

Revisão contratual continua necessária para a oferta, inclusive renovação,
cancelamento e eventual reajuste. O catálogo aprovado não altera por si só
os termos publicados ou os prazos de retenção.

## Custódia e subsídio antes da admissão

| Aporte da Freecorps por organização                   |  Gratuito | Intermediário |       Grande |
| ----------------------------------------------------- | --------: | ------------: | -----------: |
| Caixa separado antes da admissão                      |     R$ 60 |        R$ 108 |       R$ 280 |
| Amortização econômica em 12 meses                     |  R$ 5/mês |      R$ 9/mês | R$ 23,33/mês |
| Custo operacional mensal em estresse, sem amortização | R$ 16,80* |      R$ 87,70 |    R$ 296,93 |

O Gratuito separa R$ 50 para custódia e R$ 10 para transição, além de subsídio
recorrente de R$ 17,00 no catálogo. *O custo exato em estresse é
R$ 16,8030583304. A reserva foi arredondada para cima e o assert compara
o valor sem arredondamento. Essa cobertura ainda depende das hipóteses do modelo.

Amortizar descreve o custo distribuído por 12 meses na análise. Não parcela o
aporte, não presume 12 mensalidades, não cria fidelidade e não libera caixa
reservado. Todo o dinheiro precisa existir antes de admitir a organização.
O cancelamento no primeiro mês deixa R$ 69,05 sem cobertura pela receita no
Intermediário e R$ 152,78 no Grande, após operação em estresse e alocação do
aporte inteiro. A Freecorps assume esse risco. Não financiar custódia com
conversão, renovação ou consultoria futura.

Esses aportes dependem de provar e ativar a custódia fria já implementada.
O modelo conserva `openOrganizationRetention` com o custo de manter
o estoque completo e o déficit do aporte, sem presumir encerramento futuro.
O horizonte de 72 meses e duas cópias é uma hipótese de orçamento, sem prazo
novo de exclusão. Guarda adicional, conta aberta indefinidamente e recuperações
repetidas exigem revisão anual e recomposição. No caminho quente modelado,
manter 72 meses o estoque sem novas operações custa aproximadamente R$ 660,55,
R$ 1.282,65 e R$ 5.009,12 só de infraestrutura. O aporte não cobre esse caminho.

O caminho decidido em 28/10/2026 é a custódia fria de contas abertas, com
reidratação sob IDs novos e catálogo compactado no R2
([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md)). No cenário
`openOrganizationColdCustody`, pacote frio com uma reidratação, transição de
um mês e a linha do run quente por 72 meses somam R$ 44,10, R$ 107,70 e
R$ 278,73, valores arredondados ao centavo. O aporte cobre esse total com
folga de R$ 15,90, R$ 0,30 e R$ 1,27, mas só na aritmética: o resultado vale
para organizações dentro dos limites do executor (100 mil registros fiscais,
256 MiB de JSON e 2 GiB de arquivos), que o Grande cheio e, com linhas
pequenas, qualquer plano pode passar. Exclui também as linhas `closure` e
`commercial` que continuam quentes durante a custódia. A folga do
Intermediário dificilmente absorve essas linhas. Também ficam fora as
exportações assistidas durante o arquivo e o rearquivamento depois de uma
reativação. Organizações abertas que só usaram Sandbox podem ser encerradas
após 90 dias sem atividade e aviso de 30 dias, se continuarem elegíveis e não
pedirem para manter a conta ativa. O fluxo está implementado, com expurgo
antecipado conforme [RETENTION.md](RETENTION.md), mas depende do operador e
do gate `FNFE_COLD_ARCHIVE`, que permanece desligado. Até sua ativação,
a inatividade por si só não encerra a organização nem elimina seu estoque
quente. Sem compactar
o catálogo, o déficit volta a cerca de R$ 632, R$ 647 e R$ 646. Nos planos
pagos, desde a decisão de 29/10/2026, a janela sem receita até o congelamento
é um mês, o do aviso, que o aporte financia: a falta de R$ 17,52 no
Intermediário e R$ 68,30 no Grande, com os dois meses de antes, deu lugar às
folgas de R$ 0,30 e R$ 1,27
([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md#decisões-de-29102026)).
Esses números são aritmética de planejamento; a custódia implementada segue
desligada e sem custo operacional medido
([memória](PLATFORM-COSTS.md#custódia-fria-de-organizações-abertas)).

O subsídio pode usar até 10% da margem positiva efetivamente recebida após
custos e provisões, sem contar a mesma reserva duas vezes. No modelo de um
bucket, cinco Intermediários na base ou seis no estresse cobrem R$ 17,00/mês;
dois Grandes cobrem esse valor em ambos. São razões aritméticas condicionais,
sem financiar o aporte inicial de R$ 60 nem vagas ilimitadas. Sem verba
previamente alocada, novas adesões são zero. Preservar 30% de folga operacional
e limitar vagas pelo menor orçamento de caixa, estoque, banco, tráfego e backup.

## Personalizado por orçamento

Sem preço mínimo público, implantação obrigatória ou capacidade-base implícita.
Cada proposta fixa limites, suporte, retenção aplicável e capacidade financiada.
O custo inclui infraestrutura, rateio, contingência, suporte e amortização do
aporte integral da empresa. Como referência interna, com deduções hipotéticas
de 15%, calcular `máximo(custo_base / 0,60, custo_estresse / 0,65)` para buscar
25% e 20% de margem. Isso não é piso público nem lucro garantido. Consultoria
opcional a R$ 180/h fica separada da operação necessária para entregar o plano.

## Limites técnicos e condições de lançamento

Manter a reserva de 18 MiB por consulta, cobrindo até 2 MiB brutos e 16 MiB
expandidos. Confirmar só o persistido e liberar a diferença. Resultado incerto
mantém sua reserva até reconciliação. Não reduzir essa proteção para caber na
cota nem descartar resposta fiscal válida após enviá-la. O teto técnico de
120 consultas autorizadas por empresa em qualquer hora e os cooldowns da fonte
continuam independentes do plano. No Gratuito, as 100 consultas são cota de
teste do Sandbox; Produção usa a cota compartilhada de 100 notas novas.

A implementação da #429 introduz catálogo, controles de capacidade e caminho
incremental de backup, sujeitos à prova integrada. O backup incremental usa
um bucket e um objeto cifrado por hash, com manifesto. Não são duas cópias
independentes, e esse backup não implementa custódia fria após cancelamento.
Nenhum teste local autoriza declarar economia fria ou lançamento concluído.
O backup incremental conserva o teto global de 1 GiB, incluindo arquivos,
no preflight e na recuperação. Portanto, não cobre uma organização Grande
com os 2 GiB de arquivos ocupados. O pacote frio de até 2 GiB tem outro limite
e não resolve essa restrição. A prova real usou 993 bytes de arquivos;
capacidade integral e tempo de recuperação do Grande continuam sem prova.

Antes de ligar o catálogo, exigir restauração real integral, custódia fria
provada sem reduzir guarda, custo e margem medidos e fundos reais
configurados e conciliados. Também conferir inventário das contas existentes,
controle das entradas e permissões, limites globais e prevenção de múltiplas
contas gratuitas. Ausência de plano precisa recusar admissão quando a política
estiver habilitada. Metas de suporte dependem de capacidade de atendimento.

## Prova adicional de carga

A carga hospedada aceita de 05/10
usou organizações sem plano. Ela não mede o caminho de leitura de cotas de um
plano atribuído. A separação por ambiente conserva a atualização de um total
por evento, mas a checagem de cota lê até três totais e pode disputar gravações
dos dois ambientes da mesma organização. Inspeção de código não mede essa
contenção.

Proposta de ensaio complementar: cerca de 100 admissões sintéticas em Sandbox,
com plano atribuído, duas organizações e 20 clientes, em três rodadas no alvo
de validação autorizado, sem transporte fiscal real. O alvo não serve
importação em Produção (`PRODUCT_ENV=sandbox`); a disputa entre ambientes
fica coberta só pelos testes locais com `convex-test`. O comando é o modo
`plan-load` do runbook de 79-80.
Separar uma rodada com saldo suficiente de outra disputando a última unidade.
Registrar revisão publicada, plano, mistura de ambientes, respostas, p95,
conflitos, totais e ausência de efeito duplicado. Comparar o cenário com saldo
ao critério privado de 2.500 ms para admissão; na disputa, conferir aceites e
recusas esperados, sem somar recusas ao p95 de sucesso. O ensaio rodou na validação
em 28/10 e foi aceito em 29/10 na #79/#51
(parecer).

Não é necessário repetir a massa de 100 mil apenas por trocar a política de
admissão. Repeti-la passa a fazer sentido se a prova complementar revelar
regressão, ou se consultas, índices ou perfil de carga mudarem.
