# Custos e capacidade dos planos da plataforma

A medição de 31/10/2026 da #557 acrescenta
medições reais do formato 1, tamanho do ZIP e da cifra, bytes enviados e tempo
de exportação. O modelo reproduzível separa observação de projeção e mantém
custo total atribuível ao backup e economia incremental como desconhecidos.
As capturas posteriores confirmam Workers Paid e R2 Paid, além de totais e
desconto exibidos pela Blacksmith. Ainda faltam consumo e cobrança por período
para conciliar a parcela do backup; o plano Convex não foi confirmado.
Na continuação desta entrega, o mantenedor dispensou aprofundar essa
conciliação porque os valores dos planos da plataforma já foram decididos.
Isso encerra essa frente no escopo solicitado, sem afirmar custo real ou
economia incremental ainda não medidos e sem alterar os preços.
A capacidade e a recuperação continuam condicionadas à
#688.

Revisão de 27/10/2026 para a #429. O mantenedor aprovou o redesenho de produto
e comercial: Gratuito permanente, Intermediário R$ 149/mês, Grande R$ 499/mês,
Personalizado por orçamento sem piso público, sem implantação obrigatória e
consultoria opcional a R$ 180/h. A [tabela](PLATFORM-PLAN-PROPOSAL.md) substitui
a antiga referência assistida. **O catálogo fica desligado e os preços não
são ofertados enquanto persistirem a falta de prova operacional da custódia,
o financiamento insuficiente da guarda quente, a falta de margem medida
e de configuração real dos fundos.** Em 28/10/2026, o dono do projeto
decidiu financiar a guarda de organizações abertas pela custódia fria com
reidratação sob IDs novos ([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md));
ela está implementada, mas segue desligada e sem prova operacional completa,
conforme a [consolidação de 30/10 na #549](https://github.com/freecorps/freecorpsNFE/issues/549#issuecomment-6530738648).

Em 29/10/2026, o dono do projeto decidiu reduzir o banco quente em vez de
espaçar o backup: o conteúdo derivado do XML vai para blobs imutáveis, e as
notas de organizações ativas ficam quentes por 3 meses no Gratuito e 12 nos
pagos, depois em camada fria. Decidiu também 5 empresas no Intermediário, o
plano anual, ligado só depois da fase E da ADR, e, no Gratuito, 100 notas
novas por mês em Produção, somando importação e captura, com a cota de teste
de hoje no Sandbox
([ADR 0010](../adr/0010-guarda-em-camadas-e-custo-dos-planos.md), decisões 4,
9, 10 e 11). O modelo
será refeito depois da medição. A B4 já grava também o blob compactado, mas
mantém o conteúdo no banco; leitores, migração e remoção dos campos ainda
estão pendentes. O texto abaixo conserva o cenário de banco lógico inteiro
quente e suas hipóteses, sem medir a economia final da ADR 0010.

O modelo importa cotas, preços, aportes e subsídio de
[`planCatalog.ts`](../../platform/convex/lib/planCatalog.ts). A redução de preço
acompanha banco lógico de 32/64/256 MiB, arquivos de 128/512/2.048 MiB,
suporte-alvo de R$ 0/12/50, rateio de R$ 2/10/30 e I/O da aplicação de
1/10/20 GB. Não se aplicam os preços novos às cotas ou ao suporte antigos.

Convex Professional compartilhado entre produtos é a base de planejamento
aprovada pelo mantenedor. Não foram consultados fatura, painel, quantidade de
assentos, região nem saldo compartilhado. Esta revisão usa as fontes de preços
já conferidas no repositório e não alterou assinatura ou configuração remota.
A [comparação comercial](PLATFORM-MARKET-COMPARISON.md) usa unidades diferentes
e não prova equivalência de volume nem aceitação dos preços.

## Preços publicados

Valores em US$, consultados em 27/10/2026. As franquias Convex são da equipe,
compartilhadas entre aplicações e ambientes, não de cada organização cliente.
GB comercial e GiB da cota não são intercambiáveis: os cálculos usam
1 GB = 1.000.000.000 bytes e 1 GiB = 1.073.741.824 bytes. Conferir a unidade
efetiva no painel ao reconciliar a conta.

| Recurso Convex     | Free/Starter: franquia; excedente Starter | Professional: franquia; excedente |
| ------------------ | ----------------------------------------- | --------------------------------- |
| Assinatura         | US$ 0; Starter cobra consumo adicional    | US$ 25 por desenvolvedor/mês      |
| Banco, com índices | 0,5 GB; US$ 0,22/GB-mês                   | 50 GB; US$ 0,20/GB-mês            |
| Arquivos e backups | 1 GB; US$ 0,033/GB-mês                    | 100 GB; US$ 0,03/GB-mês           |
| I/O do banco       | 1 GB/mês; US$ 0,22/GB                     | 50 GB/mês; US$ 0,20/GB            |
| Saída de dados     | 1 GB/mês; US$ 0,132/GB                    | 50 GB/mês; US$ 0,12/GB            |
| Chamadas           | 1 milhão/mês; US$ 2,20/milhão             | 25 milhões/mês; US$ 2/milhão      |
| Actions            | 20 GB-h/mês; US$ 0,33/GB-h                | 250 GB-h/mês; US$ 0,30/GB-h       |

Fontes: [preços Convex](https://www.convex.dev/pricing) e
[limites e abrangência](https://docs.convex.dev/production/state/limits).
Free impõe limites; Starter permite excedentes faturados. Professional também
não é ilimitado. Outras regiões têm multiplicador de 1,3 nos recursos.
Busca tem medição própria; não presumir que está dentro da franquia de banco.

| Serviço efetivamente usado | Referência de preço e implicação                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Workers         | Paid: US$ 5/mês, 10 milhões de requisições e 30 milhões de ms CPU; adicionais de US$ 0,30/milhão de requisições e US$ 0,02/milhão de ms. Assets estáticos não equivalem a chamadas dinâmicas. [Fonte](https://developers.cloudflare.com/workers/platform/pricing/) |
| Cloudflare R2 Standard     | 10 GB-mês incluídos; US$ 0,015/GB-mês adicional. Operações A: 1 milhão incluído, depois US$ 4,50/milhão; B: 10 milhões, depois US$ 0,36/milhão. Saída gratuita. Há arredondamento por unidade faturável. [Fonte](https://developers.cloudflare.com/r2/pricing/)    |
| Cloudflare Email Sending   | No Workers Paid, 3.000 envios/mês incluídos, depois US$ 0,35/mil. Destinatários arbitrários exigem Paid. Não acrescentar uma assinatura Resend: o código usa Cloudflare. [Fonte](https://developers.cloudflare.com/email-service/platform/pricing/)                |
| Blacksmith                 | Ubuntu x64 de 2 vCPU: US$ 0,004/min, com 3.000 minutos gratuitos/mês. Backup e validação disputam a franquia; duração cresce com o snapshot. [Fonte](https://www.blacksmith.sh/pricing)                                                                            |

Cloudflare Pro de zona, Workers Paid e R2 são produtos distintos. Não inferir
que uma assinatura cobre todos. Domínio, suporte humano, cobrança, impostos,
logs, CI, consulta cadastral e eventuais serviços contratados entram no custo
total conforme suas faturas. Nenhuma compra ou mudança de assinatura foi feita.

## Rateio do Professional entre produtos

A assinatura fixa da empresa é `US$ 25 × desenvolvedores faturáveis/mês`.
Distribuir esse total entre produtos por pesos de orçamento registrados cuja
soma seja 100%; não cobrar a assinatura inteira em cada produto nem tratá-la
como custo inexistente. A soma das parcelas precisa reconciliar com a fatura.
Não foi escolhido um peso para o freecorpsNFE sem conhecer os demais produtos.

Para capacidade, reservar uma parcela por recurso: banco, arquivos, I/O,
saída, chamadas e actions. Somar os orçamentos de todos os produtos, incluindo
desenvolvimento, validação, backups e folga, sem exceder a franquia corporativa
ou o excedente explicitamente financiado. O orçamento do gratuito é uma parte
do orçamento do freecorpsNFE; não é uma parte nova da franquia da equipe.

Para estimar o incremento de um recurso, usar:

```text
U = consumo dos outros produtos e da carga já admitida
X = consumo adicional avaliado; A = franquia da equipe; p = preço excedente
custo incremental = [max(0, U + X - A) - max(0, U - A)] × p
```

Exemplo só de saída de dados: o cenário de 128 MiB em arquivos gera
24,15919104 GB/mês nas hipóteses do modelo. Com 40 GB já consumidos pelos
demais produtos, o incremento é US$ 1,70; com 50 GB já consumidos, US$ 2,90.
Com a franquia inteira livre, seria zero de excedente, mas ainda haveria
custo fixo rateado e consumo de capacidade. Esses exemplos não medem tráfego
real nem incluem banco, suporte ou os outros recursos.

Os cenários isolados abaixo continuam úteis para comparar provedores, mas
não autorizam dedicar todos os 50 GB de saída ou 100 GB de arquivos do
Professional ao gratuito. O limite de 1 GiB do nosso runner de backup também
continua existindo após uma mudança de assinatura.

## Estoque lógico, banco físico e backup

Originais e captura bruta/expandida ficam no storage; versões, itens, listagens,
uso e auditoria ficam no banco. `bytes` de entrada não limita o estoque acumulado.
A [retenção](RETENTION.md) conserva originais enquanto a organização existe.
Limite comercial não autoriza apagar dados ou encurtar a guarda.

O guard lógico usa `getDocumentSize`, incluindo campos de sistema nos registros
contabilizados, sem índices. Inventário e cobertura de tabelas precisam ser
conferidos. A fatura depende de armazenamento físico e outros recursos; a
medição lógica não é substituto. Os 64 MiB do Intermediário não garantem uma
quantidade de notas. A fixture do ensaio #79
mediu 9.596 bytes lógicos por documento mais versão, excluindo itens, índices,
listagens e outras tabelas. Não extrapolar esse número para a oferta.

O caminho anterior exporta banco e storage completos a cada 12 horas, conservando
28 snapshots por 14 dias no R2. A [cobrança de backup Convex](https://docs.convex.dev/database/backup-restore#how-are-they-priced)
inclui leituras e ZIP. Os cálculos contam o download do ZIP como saída adicional,
hipótese conservadora ainda a medir. O limite de 1 GiB do snapshot é global;
a falha após exportar já pode ter consumido recursos. Exports temporários de
clientes também amplificam esse caminho. `model.mjs` abaixo preserva essa
referência anterior, sem afirmar que é medição do caminho incremental.

A implementação incremental da #429 separa o snapshot dos registros dos objetos
imutáveis, elimina partes temporárias do conjunto restaurável e usa manifesto,
hash e cifra. Há **um bucket e um objeto por hash**, sem duas cópias independentes.
A habilitação no bucket real ainda precisa de evidência. O snapshot de
registros continua recorrente; separar os originais não elimina seu I/O, sua
serialização nem seu teto global. O backup incremental sozinho não transfere
contas canceladas para custódia fria. O [arquivo econômico](../operacao/arquivo-economico.md)
tem executor administrativo e gate desligado. O ensaio anterior provou
importação isolada, mas encontrou bloqueio ao recriar IDs apagados na origem.
A ADR 0009 já implementa reidratação sob IDs novos e compactação do catálogo
no R2 depois de `archived`. Esses caminhos têm provas em `convex-test` e
testes de script, sem ensaio operacional completo. Com o gate desligado,
contas abertas continuam quentes; mesmo após arquivar, permanecem no banco
dados comerciais, controle e a cerca de numeração e captura.

## Referência anterior: export completo reproduzível

O modelo (`docs/v1.0/evidence/429/costs/model.mjs`) fica nos recibos do
repositório privado da Freecorps e não acompanha esta cópia. O script é
local, não consulta serviços e confere âncoras aritméticas. O resultado é um teste de
sensibilidade de **arquivos e backup**, não o custo completo nem um teto.

Para um estoque constante durante um mês de 30 dias:

```text
F = arquivos vivos em GB; Z = ZIP completo em GB; D = linhas de banco em GB
60 = exports/mês; 28 = cópias externas retidas
saída modelada do Convex = 60 × (F + Z da geração + Z do download)
I/O de backup do banco = 60 × D, além do I/O da aplicação
storage Convex modelado = F + 2 × Z (duas cópias nativas assumidas)
storage R2 modelado = 28 × Z
custo do recurso = max(0, uso total da equipe - franquia) × preço
```

No cálculo, `Z = F`, sem compressão e sem banco, com duas cópias nativas
retidas apenas como hipótese. O produto limita Free/Starter a dois backups
por deployment, mas isso não comprova a retenção dos exports CLI. Não há
evidência da quantidade atual de exports retidos nem de backup nativo
periódico configurado. Usar tamanho real, medição de tráfego e tempo de
retenção no orçamento final. O script inclui sensibilidades de ZIP a 25%
e sem saída adicional de download para expor o impacto dessas hipóteses.

Os cenários usam as franquias inteiras da equipe uma só vez e consumo anterior
zero. Não conceder essa mesma sobra a cada cliente numa planilha separada.
Excluem banco/índices/I/O, chamadas, actions, downloads do cliente, exports,
busca, e-mail excedente, operações R2, runner, suporte e tributos.

| Estoque hipotético ao atingir o marco                                   | Arquivos GB | Saída GB/mês | Starter: arquivos + backup US$/mês | Professional: arquivos + backup US$/mês |
| ----------------------------------------------------------------------- | ----------: | -----------: | ---------------------------------: | --------------------------------------: |
| Gratuito anterior, 1 organização, 1 mês cheio nos dois ambientes        |        2,15 |       386,55 |                              51,84 |                                   41,15 |
| Gratuito anterior, 1 organização, 12 meses cheios                       |       25,77 |     4.638,56 |                             625,36 |                                  561,31 |
| Gratuito anterior, 10 organizações, 12 meses cheios                     |      257,70 |    46.385,65 |                           6.256,34 |                                5.688,56 |
| 64 MiB/mês por ambiente, sem teto de estoque, 1 organização em 12 meses |        1,61 |       289,91 |                              38,80 |                                   29,33 |
| Estoque limitado a 128 MiB totais, 1 organização                        |        0,13 |        24,16 |                               3,06 |                                    0,00 |
| Estoque limitado a 128 MiB totais, 10 organizações                      |        1,34 |       241,59 |                              32,28 |                                   23,41 |
| Pago anterior, 1 organização, 12 meses cheios                           |      128,85 |    23.192,82 |                           3.128,01 |                                2.839,71 |

São custos mensais para **manter o estoque já atingido**, não a soma das
faturas dos meses anteriores. No cenário Professional, somar US$ 25 por
desenvolvedor; em ambos, somar Workers Paid de US$ 5 se contratado. Um zero
significa caber na franquia hipoteticamente livre, não custo econômico zero.

Exceto a linha de 128 MiB de uma organização, esses ZIPs excederiam o limite
do caminho completo. As linhas são extrapolações de capacidade caso o backup
conseguisse continuar; nesse caminho o runner falharia após exportar. Não são projeções
de operação saudável. Mesmo com ZIP a 25%, a segunda linha fica em US$ 309,82
Starter ou US$ 274,88 Professional, antes dos demais custos.

Oito organizações com 128 MiB já ocupam 1 GiB só em arquivos: com `Z = F`,
não sobra nada no snapshot completo para banco, temporários ou clientes pagos.
Esse número não é uma autorização de oito vagas; com a folga operacional e
os demais dados, a capacidade real é menor e precisa ser medida.

No Free, a linha de 128 MiB **não cabe**: os 24,16 GB de saída modelados
superam a franquia de 1 GB. Com `Z = F` e o backup completo, essa franquia só
comporta cerca de 5,56 MB de arquivos estáveis (`1 GB / 180`), antes de
banco, aplicação e qualquer outro projeto. Isso não é tamanho máximo de
arquivo: é o estoque constante hipotético que a franquia de tráfego consegue
recopiar. Com ZIP a 25%, seriam cerca de 11,11 MB. O Free não sustenta a
promessa anterior; habilitar Starter apenas troca interrupção por cobrança,
sem resolver o limite de 1 GiB do runner nem financiar usuários gratuitos.

Também há um problema de banco independente: 100 mil documentos da fixture
já somam 0,96 GB lógicos nas duas tabelas medidas, acima dos 0,5 GB Free,
antes de seus índices e das demais tabelas. Os 100 GB de arquivos Professional
não são 100 GB de banco nem 100 GB de transferência mensal.

## Memória de preço dos planos pagos

O script `docs/v1.0/evidence/429/costs/paid-plans.mjs`, que roda com Node
22.18 ou mais recente e as dependências locais instaladas, fica nos recibos
do repositório privado da Freecorps e não acompanha esta cópia. O script importa o catálogo
TypeScript, sem acessar rede ou dados reais. Emite resultados e todas as
checagens antes do assert final. As checagens `required` preservam a matemática
anterior, explicitamente sem catálogo quente; nenhuma meta foi reduzida.
As checagens `diagnostic` expõem os déficits dos cenários adicionais, sem
transformar o sucesso do assert em aprovação comercial. A saída mantém
`launchReady: false` e `launchReadiness: false`, com falhas mensuráveis em
`launchBlockers`. O catálogo reserva R$ 17,00 para cobrir
o custo gratuito exato de R$ 16,8030583304 no cenário de estresse.
O assert compara os valores antes de arredondar a apresentação.

### Hipóteses e arquitetura

As taxas de planejamento são R$ 6,50/US$ na base e R$ 7,50 no estresse, sem
pretensão de representar câmbio atual. Deduzir 15% do preço bruto como hipótese
conjunta de tributos e pagamento, sem afirmar alíquota real. A infraestrutura
recebe 25% de contingência. Nenhuma franquia compartilhada é descontada outra
vez por cliente; o crédito de franquia no modelo é zero.

| Orçamento interno mensal                          |  Gratuito | Intermediário |  Grande |
| ------------------------------------------------- | --------: | ------------: | ------: |
| Arquivos acumulados                               |   128 MiB |       512 MiB |   2 GiB |
| Banco lógico                                      |    32 MiB |        64 MiB | 256 MiB |
| Chamadas Convex, incluindo internas e reatividade |    10 mil |       100 mil | 500 mil |
| Actions                                           | 0,25 GB-h |        5 GB-h | 20 GB-h |
| I/O da aplicação, além do backup                  |      1 GB |         10 GB |   20 GB |
| E-mails                                           |        10 |           100 |     500 |
| Runner e logs, US$                                |      0,20 |          1,00 |    3,00 |
| Suporte-alvo, R$                                  |         0 |            12 |      50 |
| Fixo rateado, R$                                  |         2 |            10 |      30 |
| Aporte da Freecorps antes da admissão, R$         |        60 |           108 |     280 |

São envelopes para medir, sem cotas secretas que impeçam a entrega anunciada.
O rateio deve reconciliar com a parcela corporativa efetiva, sem multiplicar
assinatura ou capacidade entre produtos. Suporte não foi medido; documentação
e comunidade também consomem trabalho, que deve aparecer no rateio e ser
revisto. O orçamento pequeno não prova a meta de primeira resposta.

O cenário principal estima o caminho incremental de um bucket. Conserva
28 snapshots de registros no R2 e duas cópias temporárias de ZIP no Convex,
ainda como hipótese de custo. Usa uma leitura e uma transferência por novo
original e duas saídas por snapshot, sem compressão. O volume mensal recebido
soma os dois ambientes. Downloads e exports são orçados separadamente.
O estoque temporário médio é o volume exportado dividido por 30, por TTL de
24 horas; não representa o pico, que exige reserva própria.

A amplificação física inicial é 1, uma referência otimista para banco com
índices. Índices aumentam storage faturado, mas não entram no ZIP exportado.
Por isso a sensibilidade física varia o armazenamento, enquanto tamanho
serializado do snapshot e I/O da aplicação têm cenários próprios. Não tratar
a multiplicação de bytes físicos como multiplicação automática de todas as
linhas exportadas. Tampouco presumir que bytes lógicos sejam iguais a JSON/ZIP.
Operações R2 recebem provisão de US$ 0,05 por cópia/mês, sem nova franquia;
objetos pequenos, verificação e restaurações podem excedê-la. Medir esse custo.

### Resultado condicional com um bucket, sem custear o catálogo quente

| Resultado mensal, R$ salvo indicação                |    Gratuito | Intermediário | Grande |
| --------------------------------------------------- | ----------: | ------------: | -----: |
| Infraestrutura, US$                                 |        1,58 |          7,01 |  23,14 |
| Operação na base, com contingência, suporte e fixos |       14,83 |         78,94 | 268,00 |
| Operação em estresse                                |      16,80* |         87,70 | 296,93 |
| Amortização do aporte em 12 meses                   |        5,00 |          9,00 |  23,33 |
| Custo base com amortização                          |       19,83 |         87,94 | 291,34 |
| Custo em estresse com amortização                   |       21,80 |         96,70 | 320,26 |
| Saldo base após deduções e amortização              |      -19,83 |         38,71 | 132,81 |
| Saldo em estresse após deduções e amortização       |      -21,80 |         29,95 | 103,89 |
| Margem base sobre receita bruta                     | Sem receita |        25,98% | 26,62% |
| Margem em estresse                                  | Sem receita |        20,10% | 20,82% |

*O custo exato é R$ 16,8030583304. O catálogo reserva R$ 17,00;
o script compara antes de arredondar. Os R$ 5 mensais de amortização
gratuita já estão antecipados nos R$ 60; o subsídio recorrente não deve pagar
o mesmo aporte outra vez. Na análise econômica completa, o custo é R$ 21,80.

As metas pagas de 25% na base e 20% no estresse passam apenas nesse cenário
incompleto, que amortiza aportes sem financiar o catálogo quente por 72 meses.
O Intermediário tem cerca de R$ 0,15 de folga até o teto de custo em estresse;
o Grande, R$ 4,09. Não são margens medidas, lucro auditado ou evidência para
ligar o catálogo. Os custos de lançamento, churn e suportes extraordinários
precisam de capital e medição próprios.

### Sensibilidade e riscos

| Cenário                                   | Margem de estresse Intermediário | Margem de estresse Grande | Consequência                                            |
| ----------------------------------------- | -------------------------------: | ------------------------: | ------------------------------------------------------- |
| Um bucket, hipótese-base de recursos      |                           20,10% |                    20,82% | Passa aritmeticamente, sem prova real                   |
| Futuro com duas cópias independentes      |                           19,50% |                    20,44% | Intermediário falha; faltam R$ 0,68/R$ 0,71 nos aportes |
| Banco físico 2 vezes o lógico, só storage |                           20,01% |                    20,72% | Intermediário praticamente sem folga                    |
| Banco físico 4 vezes o lógico, só storage |                           19,84% |                    20,52% | Intermediário falha; faltam R$ 0,68/R$ 0,71 nos aportes |
| Banco físico 8 vezes o lógico, só storage |                           19,51% |                    20,11% | Intermediário falha; aportes insuficientes em ambos     |
| Snapshot serializado 2 vezes maior        |                            8,74% |                     7,25% | Ambos falham; custódia e transição também insuficientes |
| I/O da aplicação 2 vezes maior            |                            7,51% |                    13,30% | Ambos falham                                            |
| Suporte 2 vezes maior                     |                           12,04% |                    10,80% | Ambos falham                                            |

No cenário futuro, cada cópia conserva seus 28 snapshots, totalizando 56.
A segunda cópia viria do R2, sem baixar novamente do Convex; sua implementação,
isolamento e recuperação não existem como prova nesta entrega. A provisão
adicional cobre storage e operações, sem fingir que a cifra em um bucket
seja redundância independente. Não reduzir retenção, quantidade de snapshots
ou requisitos de restauração para fazer a margem passar.

Dobrar o suporte significa R$ 24/R$ 100 mensais por organização, ainda valores
modestos para atendimento humano. As metas de resposta não podem ser ofertadas
com base na planilha. Medir tempo de atendimento e custo das funções reais,
incluindo leituras reativas e falhas, antes de aceitar esses envelopes.
Os cenários variam uma hipótese por vez; riscos combinados podem custar mais.

### Aporte integral, amortização e cancelamento no primeiro mês

O fundo vem da empresa e deve existir antes da admissão. Não há taxa de
implantação, custódia cobrada separadamente, obrigação de consultoria ou
presunção de permanência mínima. A amortização em 12 meses é uma alocação
para comparar margens; não é autorização para formar a reserva com receitas
futuras. O registro de aporte precisa corresponder a dinheiro real segregado.

A provisão do pacote frio considera originais e registros, duas cópias
Standard, um atendimento de recuperação e 50% de contingência. Duas cópias
independentes continuam sendo hipótese financeira; o executor implementado
usa um bucket. Esta conta ainda exclui o catálogo quente:

```text
pacote frio = (2 × (arquivos + registros serializados) em GB × US$ 0,015
            × 72 meses × R$ 7,50 + recuperação) × 1,50
transição = arredondar para cima um mês ocioso quente em estresse
aporte parcial do cenário = pacote frio + transição
aporte completo >= pacote frio + transição + catálogo quente durante a guarda
```

Recuperação tem orçamento de R$ 20/50/100. Os 72 meses são horizonte de
planejamento, sem autorização de exclusão ou teto universal de guarda.
Contas abertas, exceções e recuperações repetidas exigem revisão e recomposição.

| Recursos por organização, R$                                     | Gratuito | Intermediário |   Grande |
| ---------------------------------------------------------------- | -------: | ------------: | -------: |
| Pacote frio estimado, sem catálogo quente                        |    34,08 |         89,68 |   208,71 |
| Transição quente, mês em estresse arredondado para cima          |       10 |            18 |       70 |
| Aporte aprovado                                                  |       60 |           108 |      280 |
| Residual para catálogo quente e custos ainda não medidos         |    15,92 |          0,32 |     1,29 |
| Saldo do primeiro mês após operação em estresse e aporte inteiro |   -76,80 |        -69,05 |  -152,78 |
| Parte não amortizada após um mês                                 |    55,00 |         99,00 |   256,67 |
| Manter quente 72 meses, apenas infraestrutura ociosa             |   660,55 |      1.282,65 | 5.009,12 |

O Gratuito separa explicitamente R$ 50 para custódia e R$ 10 para transição.
O caixa inicial ainda inclui o primeiro mês operacional. Nos pagos, a receita
do primeiro mês cobre parte do aporte; o saldo negativo mostra a exposição
da empresa se houver cancelamento imediato. A parte não amortizada é outra
medida, não uma segunda cobrança ou outro passivo a somar ao mesmo aporte.
Não contar margem, reserva e subsídio como usos simultâneos do mesmo dinheiro.

**Os aportes não financiam a manutenção quente de organizações abertas.**
A decisão de 28/10/2026 troca essa manutenção pela custódia fria descrita em
[Custódia fria de organizações abertas](#custódia-fria-de-organizações-abertas);
os parágrafos seguintes conservam o cenário anterior de guarda quente.
O ensaio anterior do arquivo econômico passou na importação e reexportação em
destino isolado, mas falhou no retorno à origem: o Convex recusa recriar IDs
que já foram apagados. A remoção de registros e arquivos de organizações
abertas fica bloqueada. Não se aplica a economia fria a contas gratuitas
inativas ou pagas sem renovação. O cenário `openOrganizationRetention` do
modelo mantém o estoque completo: R$ 660,55, R$ 1.282,65 e R$ 5.009,12 por
72 meses ilustrativos, antes de custos adicionais de catálogo. Uma conta
aberta não tem esse horizonte como limite de guarda ou de custo.

O cenário abaixo conserva a hipótese de catálogo sem compactação, inclusive
para organizações encerradas. Também não é financiado pelos aportes atuais.
`coldArchiveEntries` conserva uma entrada por registro fiscal e arquivo, e
`coldArchiveRuns` conserva manifesto e provas. Dados comerciais, cadastro,
controle e acesso também permanecem. Contas sem elegibilidade, com retenção
legal ou acima dos limites do executor continuam exigindo orçamento quente.
Nenhum horizonte desta planilha autoriza apagar esses dados.

### Catálogo quente por 72 meses

O script reproduz a conta do exemplo informado na revisão da #429:
329 bytes por entrada de registro, 504 por entrada de arquivo e 1.356 por
execução, medidos com `getDocumentSize`, incluindo campos de sistema. Com
100 mil registros, 5 mil arquivos e uma execução, são **35.421.356 bytes,
ou 33,780437 MiB**, antes de índices e dados comerciais. São registros
fiscais de várias tabelas, não 100 mil notas. As contagens são entradas
explícitas do cenário e não são deduzidas de cotas de nenhum plano.

Para permitir repetir também a medição, o script monta objetos sintéticos
com os campos de `coldArchiveSchema.ts` e do executor, hashes SHA-256 reais
de textos fictícios e timestamp fixado. Essa fixture mede 327/524/1.328 bytes,
totalizando 35.321.328 bytes nas mesmas contagens. A diferença é esperada:
IDs, nomes de tabelas, metadados de storage, manifesto, campos opcionais e
representação textual de timestamps variam. O exemplo informado e a fixture
são identificados separadamente na saída; nenhum é tamanho universal ou
medição de produção. O script imprime somente agregados, sem os objetos.

A combinação dessas contagens com o envelope frio de cada plano é um teste
de sensibilidade do financiamento, não uma afirmação de que essa carga cabe
nas cotas de todos os planos. Conferir bytes fiscais e de arquivos, número de
registros e limites do executor antes de admitir cada organização.

O primeiro diagnóstico conta apenas storage Convex lógico, a US$ 0,20/GB-mês.
O segundo acrescenta os mesmos 60 snapshots mensais, duas cópias temporárias
no Convex e 28 retidas em um bucket R2 da hipótese operacional. Para `H` GB
de catálogo, com amplificação física e serialização iguais a 1:

```text
storage mensal US$ = H × 0,20
storage e backup mensal US$ = H × (0,20 + 2 × 0,03
                                  + 60 × (0,20 + 2 × 0,12) + 28 × 0,015)
catálogo 72 meses R$ = mensal US$ × 72 × 7,50 × 1,25
déficit = max(0, pacote frio + transição + catálogo - aporte aprovado)
máximo de bytes quentes = piso(max(0, residual) / custo de um byte por 72 meses)
```

São custos incrementais sem nova franquia compartilhada. O R2 aqui usa
storage linear, sem arredondamento por organização. Excluem operações,
runner, índices, dados comerciais, custo de arquivar, recuperações repetidas
e guarda além de 72 meses. São contas otimistas, não tetos. A sensibilidade
de storage físico 2 vezes maior não aumenta automaticamente o snapshot;
a de serialização 2 vezes maior é independente. Nenhuma reduz retenção.

No exemplo informado, apenas storage custa R$ 4,78 pelos 72 meses. Com
backup recorrente, são R$ 647,47. Usando valores completos antes de arredondar:

| Efeito do catálogo informado, R$ salvo indicação            |    Gratuito | Intermediário |    Grande |
| ----------------------------------------------------------- | ----------: | ------------: | --------: |
| Déficit do aporte contando só storage                       |        0,00 |          4,46 |      3,49 |
| Déficit contando storage e backup                           |      631,54 |        647,14 |    646,17 |
| Aporte mínimo parcial com storage e backup                  |      691,54 |        755,14 |    926,17 |
| Máximo de bytes quentes que o residual financia, só storage | 117.949.159 |     2.394.751 | 9.579.005 |
| Máximo de bytes quentes com storage e backup                |     871.116 |        17.686 |    70.745 |
| Margem base após amortizar a recomposição em 12 meses       | Sem receita |       -10,22% |    15,83% |
| Margem em estresse após a mesma recomposição                | Sem receita |       -16,10% |    10,03% |

O máximo é o orçamento para **todo** o residual quente sob cada hipótese,
não uma nova cota nem permissão para remover entradas. Os aportes mínimos
ainda excluem os custos não medidos acima. As margens corrigidas acrescentam
somente o déficit à amortização original; não cobram o catálogo outra vez
como despesa mensal. Só storage já deixa o Intermediário em 19,85% no
estresse. Com backup, ambos ficam abaixo de 25%/20%. A matemática anterior
continua válida sob suas hipóteses, mas não prova viabilidade do implementado.
Preços, cotas e aportes de catálogo permanecem sem alteração; resolver esses
déficits exige decisão de financiamento ou arquitetura e nova medição.

Esta conta é a do catálogo que fica quente para sempre. Desde a PR 4 da
ADR 0009, o executor compacta o catálogo depois de `archived`: as entradas
viram um objeto cifrado no R2 e saem do banco
([catálogo compactado](../operacao/arquivo-economico.md#catálogo-compactado)),
e o cenário `openOrganizationColdCustody` abaixo já supõe isso. Os números
desta seção continuam valendo como o custo de não compactar. O objeto do
catálogo no R2 não foi medido nem entra no modelo; o fluxo continua atrás de
`FNFE_COLD_ARCHIVE`, desligado.

### Custódia fria de organizações abertas

Em 28/10/2026, o dono do projeto decidiu o caminho de financiamento da guarda
de organizações abertas ([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md)).
O Gratuito inativo e o plano pago sem renovação vão para o pacote frio. Na
reativação, os dados voltam à origem com IDs novos, sem recriar os apagados.
Depois de `archived`, o catálogo por entrada vira um objeto cifrado no R2, e
a linha do run fica quente, além dos dados comerciais, controle e cerca
descritos abaixo. Aporte maior, revisão de preço ou estoque e reserva mensal
de margem foram recusados. A custódia está implementada, com o gate
`FNFE_COLD_ARCHIVE` desligado e sem prova operacional completa.

O cenário `openOrganizationColdCustody` do modelo soma, por organização:

```text
custódia = pacote frio + transição + linha do run quente por 72 meses
linha do run = catálogo 72 meses com H = 1.356 bytes, um bucket,
               60 snapshots por mês e 28 retidos
```

Os 1.356 bytes são o run do exemplo informado na revisão da #429. O pacote
frio já inclui uma recuperação, R$ 20/50/100 com 50% de contingência: é a
reidratação, contada uma única vez. Seu custo real não foi medido.

| Custódia fria por organização, R$, arredondado ao centavo | Gratuito | Intermediário |   Grande |
| --------------------------------------------------------- | -------: | ------------: | -------: |
| Pacote frio, com uma reidratação                          |    34,08 |         89,68 |   208,71 |
| Reidratação dentro do pacote, com contingência            |    30,00 |         75,00 |   150,00 |
| Transição quente, um mês em estresse                      |       10 |            18 |       70 |
| Linha do run quente por 72 meses                          |     0,02 |          0,02 |     0,02 |
| Custódia fria total                                       |    44,10 |        107,70 |   278,73 |
| Aporte aprovado                                           |       60 |           108 |      280 |
| Folga do aporte                                           |    15,90 |          0,30 |     1,27 |
| Bytes quentes adicionais que a folga financia             |  869.760 |        16.330 |   69.389 |
| Antes: estoque quente ocioso por 72 meses                 |   660,55 |      1.282,65 | 5.009,12 |
| Sem compactar o catálogo: aporte mínimo                   |   691,54 |        755,14 |   926,17 |
| Sem compactar o catálogo: déficit                         |   631,54 |        647,14 |   646,17 |

A linha do run custa R$ 0,0248 antes de arredondar. As checagens diagnósticas
"aporte cobre custódia fria de conta aberta com catálogo compactado" passam
nos três planos, mas esse "cobre" é aritmético e tem limites. Vale só para
organizações dentro dos limites do executor: 100 mil registros fiscais,
256 MiB de JSON fiscal e 2 GiB de arquivos por pacote. O banco lógico cheio só
cabe em 100 mil registros com média por linha de cerca de 2.684 bytes no
Grande (256 MiB), 671 no Intermediário (64 MiB) e 335 no Gratuito (32 MiB),
condição necessária, não suficiente: o executor conta as 25 tabelas fiscais, e
a cota só as seis de documentos. Acima de qualquer desses limites, a
organização fica no caminho quente, até os limites subirem com prova. O
resultado também exclui as linhas das classes `closure` e `commercial` que
continuam quentes durante a custódia: idempotência, recibos, consumo, entregas
e tentativas de webhook, outbox, downloads e auditorias. Elas crescem com cada
operação da vida ativa e não foram medidas. A folga do Intermediário paga
cerca de 16 mil bytes quentes além do run, pela mesma fórmula, e dificilmente
absorve essas linhas e a cerca de numeração e captura (`dpsSequences` e
`captureStreams`). As linhas sem compactação reutilizam o cenário
`reported_example_329_504_1356/one_bucket_60_snapshots_28_retained` do
catálogo quente: sem compactar, o aporte não cobre nenhum plano.

Organizações abertas e inativas que só usaram Sandbox não são elegíveis à
custódia, para preservar o expurgo antecipado de
[RETENTION.md](RETENTION.md#organização-sem-produção-decidido-em-27102026), e
podem ser encerradas pela Freecorps após 90 dias sem atividade e aviso de
30 dias, se continuarem elegíveis e não pedirem para manter a conta ativa.
O fluxo está implementado, com expurgo antecipado do Sandbox, mas depende
do operador e do mesmo gate `FNFE_COLD_ARCHIVE`, que permanece desligado.
Até sua ativação, a inatividade por si só não encerra a organização nem
elimina seu estoque quente. O valor de
R$ 660,55 em 72 meses de `openOrganizationRetention` conserva a hipótese de
estoque cheio mantido quente; não mede esse fluxo de encerramento.

A janela sem receita do plano pago fecha desde a decisão de 29/10/2026
([ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md#decisões-de-29102026)):
o aviso começa no fim do período pago e o congelamento fica possível 30 dias
depois, então há um só mês quente sem receita, o do aviso, que a transição
financia (`paidHotMonthsWithoutRevenueBeforeFreeze = 1`). A checagem "aporte
cobre a janela quente sem receita até o congelamento" passa a exigir o mesmo
que a custódia, R$ 107,70 no Intermediário e R$ 278,73 no Grande, e passa,
com as folgas de R$ 0,30 e R$ 1,27. Antes, com dois meses, ela exigia
R$ 125,52 e R$ 348,30 e falhava com déficit de R$ 17,52 e R$ 68,30. O
Gratuito inativo fica quente pelo subsídio mensal de R$ 17,00, maior que o
mês ocioso de R$ 9,17, e não entra nessa checagem; no Gratuito, os R$ 10 de
transição ficam como folga conservadora, não como um mês contado duas vezes.
O tempo de prova e remoção depois do aviso fica fora do modelo; com folgas
tão pequenas, qualquer atraso do congelamento depois do aviso volta a ser
déficit.

O pacote frio do modelo usa o estoque de banco do plano, e `databaseBytes`
conta só as seis tabelas de documentos. O pacote real carrega também as
tabelas fiscais não rastreadas (operações, tentativas, auditorias, envelopes):
cada 64 MiB extras custam cerca de R$ 1,63 em 72 meses, com duas cópias. A
folga paga cerca de 12 MiB extras no Intermediário e 50 MiB no Grande
(`untrackedFiscalTables` na saída), e o veredito "cobre" desses planos depende
do tamanho dessas tabelas, que não foi medido.

O modelo também exclui o objeto do catálogo no R2, o mapa de IDs depois da
reidratação, as restaurações isoladas da exportação assistida durante o
arquivo, a execução do arquivo, reidratações repetidas, o rearquivamento
depois de uma reativação, as organizações abertas só com Sandbox, os pacotes
de ciclos anteriores, que custam no R2 até o `retainUntil` vigente, e guarda
além de 72 meses. A exportação assistida não tem financiamento: o pacote frio
inclui só a reidratação. `openOrganizationRetention` continua na saída como o
diagnóstico de antes. O gate `open_organization_hot_retention_funding` deu
lugar a `open_organization_cold_custody_implementation`, e `launchReadiness`
continua `false`. O nome desse gate no modelo é anterior à implementação;
não é inventário do código entregue. Preços, cotas, aportes e checagens
obrigatórias não mudaram.

### Subsídio, adesão, upgrade e Personalizado

Reservar ao Gratuito no máximo 10% da margem positiva recebida após custos e
provisões, dentro da capacidade realmente financiada. Com os R$ 17,00 do
catálogo, seriam cinco Intermediários na base ou seis no estresse por Gratuito;
dois Grandes em ambos. O aporte inicial de R$ 60 é separado. Essas relações
dependem das hipóteses de custo e não prometem conversão.
Sem verba prévia, novas vagas são zero. Conservar 30% de folga operacional e
limitar vagas pelo menor orçamento de caixa, banco, arquivos, tráfego e backup.

Adesão paga e upgrade usam mensalidade/diferença integral ao liberar franquia
inteira no mês civil UTC, com opção de começar no próximo mês. O upgrade de
Intermediário para Grande acrescenta R$ 350 de receita bruta e R$ 223,55 de
custo mensal em estresse, com amortização. A Freecorps complementa R$ 172 de
reserva antes da ampliação e conserva o consumo. Não cobrar implantação nem
presumir que o cliente ficará mais meses para completar o fundo.

Personalizado e expansões são orçados por escopo, sem piso público. Definir
limites, suporte e aporte integral antes do aceite. Como referência interna,
`máximo(custo_base / 0,60, custo_estresse / 0,65)` preserva as metas sob 15%
de deduções, incluindo amortização. Consultoria opcional a R$ 180/h não cobre
no modelo a operação indispensável do plano. Os antigos adicionais de
R$ 39/GiB e R$ 129/256 MiB deixam de ser preços de catálogo.

## Cobrança da mensalidade

Tarifas do Stripe Brasil para a cobrança por cartão da #556, consultadas em
28/10/2026 na [página pública](https://stripe.com/br/pricing) e não conferidas
na conta: cartão nacional 3,99% + R$ 0,39, cartão internacional + 2%, Stripe
Billing 0,7% do volume recorrente e contestação recebida R$ 55,00. Reembolso
não devolve as tarifas da cobrança original.

| Por mensalidade, cartão nacional | Cartão | Billing | Total | % do preço |
| -------------------------------- | -----: | ------: | ----: | ---------: |
| Intermediário, R$ 149            |   6,34 |    1,04 |  7,38 |      4,95% |
| Grande, R$ 499                   |  20,30 |    3,49 | 23,79 |      4,77% |

O upgrade de R$ 350 é cobrança avulsa: ≈ R$ 14,36 de cartão, sem Billing, e
eventual tarifa de Invoicing pela fatura pós-compra. Esses valores cabem na
dedução hipotética de 15% da memória acima, que soma tributos e pagamento; a
parcela de tributos não foi medida. O Pix assistido não tem tarifa de
intermediário, mas custa conferência manual. Repasse em BRL, com prazo a
conferir na conta. A fatura do Stripe não é NFS-e; a nota da mensalidade sai
pelo processo fiscal próprio da Freecorps ([BILLING.md](BILLING.md#tarifas-e-tratamento-fiscal)).
Nada disso altera `paid-plans.mjs`, que continua com a dedução agregada.

## Condições para habilitar o catálogo

O aceite comercial não liga a política. A implementação local de catálogo,
inventário, reservas e backup deve passar pela validação integrada da #429.
Os gates de lançamento continuam fechados até provar operacionalmente a
custódia fria de contas abertas da [ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md),
com reidratação sob IDs novos e catálogo compactado, medir a margem e
configurar os fundos reais. A janela sem receita do plano pago está
financiada desde a decisão de 29/10/2026, só na aritmética do modelo. A
operação de restauração e retenção no R2 real também precisa de prova. O
ensaio isolado não demonstra economia nem reativação.
Também conferir todos os caminhos de admissão, ausência de plano, isolamento,
estoque antigo, múltiplas contas gratuitas e orçamento global. O contador
lógico não substitui a reconciliação com o banco físico e a fatura.
Desde 27/10/2026, esses gates de lançamento são acompanhados na
[#549](https://github.com/freecorps/freecorpsNFE/issues/549).

A retenção e os direitos de acesso permanecem. Não reduzir segurança, RPO ou
guarda para fechar a conta. Spending limits e usage limits do provedor são
última proteção, não isolamento entre gratuitos e pagantes; podem interromper
o deployment inteiro. A configuração real não foi conferida nem alterada.
Testes do modelo são prova de aritmética, sem atestar custo real, suporte,
restauração ou disponibilidade comercial.
