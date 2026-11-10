> **Versão 1.4 publicada em 09/11/2026.** O texto em vigor é o arquivo
> [`termos-de-uso-2026-11-09.md`](../termos/arquivo/termos-de-uso-2026-11-09.md),
> com a [cláusula de operadora](OPERADORA-DRAFT.md) no fim. Ela troca a
> Blacksmith pelo GitHub nos itens 7 e 8 da cláusula. A 1.3,
> [`termos-de-uso-2026-11-05.md`](../termos/arquivo/termos-de-uso-2026-11-05.md),
> foi publicada em 05/11/2026 (#169), a 1.2,
> [`termos-de-uso-2026-11-04.md`](../termos/arquivo/termos-de-uso-2026-11-04.md),
> em 04/11/2026 (ADR 0012), a 1.1,
> [`termos-de-uso-2026-11-02.md`](../termos/arquivo/termos-de-uso-2026-11-02.md),
> em 02/11/2026 (#142), e a 1.0,
> [`termos-de-uso-2026-11-01.md`](../termos/arquivo/termos-de-uso-2026-11-01.md),
> em 01/11/2026 (#428). Cada arquivo é a única cópia do seu
> texto: o console mostra a versão em vigor no aceite e nas páginas públicas
> `/termos` e `/termos/uso/<versão>`, e o servidor guarda o SHA-256 em
> `TERMS_OF_USE_ARCHIVE`. Versões, hash e o que acontece com quem não aceita
> estão em [Termos](../termos/README.md#termos-de-uso). Este documento guarda
> só a origem de cada afirmação e as decisões; uma mudança do texto é uma
> versão nova, num arquivo novo.

Estes termos tratam do serviço que a Freecorps opera. O uso do código em
infraestrutura própria segue a licença do repositório
([LICENSING.md](../../LICENSING.md)), não este texto.

## De onde vem cada afirmação

| Seção | Fonte                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | [README](../../README.md#o-que-existe), [ACCEPTANCE.md](ACCEPTANCE.md#capacidades-e-limites), [ISSUANCE.md](../plataforma/ISSUANCE.md), [LAUNCH.md](LAUNCH.md) e ADR 0007, §3                                      |
| 2     | [ADR 0007](../adr/0007-captura-fiscal-no-site.md), §1 e §2, e a tabela "Efeito" de [CAPTURE.md](../plataforma/CAPTURE.md#liberação-fiscal-no-site)                                                                 |
| 3     | [ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md), [PROJECTS.md](../plataforma/PROJECTS.md) e [ACCOUNT-EMAIL.md](../plataforma/ACCOUNT-EMAIL.md)                                                                  |
| 4     | [RETENTION.md](../plataforma/RETENTION.md#guarda-após-o-encerramento-d01), [USAGE.md](../plataforma/USAGE.md#admissão-e-recuperação)                                                                               |
| 5     | [USAGE.md](../plataforma/USAGE.md#plano-e-autorização) e [EXPORTS.md](../plataforma/EXPORTS.md): a exportação não depende de plano nem de cota                                                                     |
| 6     | D04 e D05 em [RETENTION.md](../plataforma/RETENTION.md#proposta-operacional-de-06102026): RPO e RTO são metas internas, "não é SLA contratado"; [OPERATIONS.md](../plataforma/OPERATIONS.md)                       |
| 8     | `captureRelease.set` e a [retirada de emergência](../operacao/captura-fiscal.md)                                                                                                                                   |
| 9     | [Encerramento implementado](../plataforma/RETENTION.md#encerramento-implementado-d01), [Minha conta](../plataforma/RIGHTS.md#exclusão-de-conta) e [ADR 0009](../adr/0009-custodia-fria-de-organizacoes-abertas.md) |

## Decisões de 28/10/2026

O dono decidiu na #428:

- **Contratação:** aceite no console, com versão e SHA-256 registrados por
  organização, como nos termos da captura; a cláusula de operadora é parte
  destes termos. O fluxo de aceite no console existe desde a #586, sem
  versão em vigor até a publicação
  ([ORGANIZATIONS.md](../plataforma/ORGANIZATIONS.md#termos-de-uso)).
- **Foro:** comarca de Campinas/SP, sede da Freecorps.
- **Lacunas:** cláusulas usuais de SaaS B2B, comparadas com os textos
  publicados de plataformas parecidas.
- **Aprovação, na #586:** a Freecorps não tem assessoria jurídica. O
  mantenedor leu as cláusulas propostas e as aprovou como estão, assumindo o
  risco, como fez com a licença em 20/10
  ([DISTRIBUTION.md](../licenses/DISTRIBUTION.md#decisões-do-mantenedor-em-20102026)).

| Tema                    | Proposta                                                | Referência de mercado lida em 28/10/2026                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suporte e manutenção    | E-mail sem prazo garantido; 48 h de aviso de manutenção | [Focus NFe](https://focusnfe.com.br/termos-de-uso/), cl. 3.1, e [eNotas](https://enotas.com.br/termos-de-uso), cl. 5.2: só canais eletrônicos; nenhuma fixa antecedência de manutenção. Prazo: decisão de 27/10 |
| Suspensão               | Motivos listados, 5 dias para corrigir, contestação     | Focus NFe, cl. 6.3, e [Qive](https://qive.com.br/termos-de-uso) suspendem sem aviso nem contestação; aqui há os dois                                                                                            |
| Encerramento            | 30 dias sem motivo; falta de pagamento depois de 60     | Focus NFe, cl. 12.1, e Qive: 30 dias de aviso; eNotas, cl. 4.6.4: cancelamento com 30 dias de atraso                                                                                                            |
| Responsabilidade        | Teto dos 12 meses pagos, sem lucros cessantes           | Qive: teto do pago nos 12 meses anteriores; Focus NFe, cl. 11.1, exclui lucros cessantes                                                                                                                        |
| Alterações              | 30 dias de aviso; quem não aceitar sai sem multa        | [Webmania](https://webmania.com.br/termos-de-uso/): sair antes da vigência; Qive: 30 dias para variação de preço                                                                                                |
| Cobrança                | Pré-pago, sem carência, sem reembolso parcial           | Qive: sem devolução, acesso até o fim do ciclo; eNotas, cl. 4.6.2: bloqueio após 7 dias; [proposta de planos](../plataforma/PLATFORM-PLAN-PROPOSAL.md#condições-de-contratação)                                 |
| Abuso do plano gratuito | Aviso, 10 dias para esclarecer, 30 para regularizar     | Qive suspende o uso fraudulento do teste; as outras não tratam                                                                                                                                                  |

Em 29/10/2026 a seção 5A foi alinhada às regras de cobrança que o mantenedor
decidiu em 28/10 na #556 ([BILLING.md](../plataforma/BILLING.md#políticas-decididas-em-28102026)):
mês civil UTC com primeira mensalidade integral, renovação do cartão no dia 1,
upgrade pela diferença integral, um meio de pagamento por vez, inadimplência
sem carência (a carência de 7 dias da proposta anterior saiu) e reembolso e
contestação sem efeito automático no plano, analisados pela equipe.

## Decisões de 01/11/2026

O mantenedor decidiu na #428:

- **Texto completo na 1.0.** A seção 5A traz o mensal e o anual, e a seção 9
  traz o arquivamento e a organização só com Sandbox, cada trecho condicionado
  à venda no console ou à ativação, com aviso. Assim a oferta do catálogo
  (#549), do anual (#690) e da custódia fria (#691) não exige outra versão dos
  termos. O preço não está no texto: vale o que o console mostra na
  contratação.
- **Sem revisão jurídica.** As regras do anual (ADR 0010, decisão 9) e as da
  custódia fria entram aprovadas pelo mantenedor como estão, sem advogado,
  como em 28/10. A Freecorps não tem assessoria jurídica; o mantenedor assume
  o risco. Isso substitui a revisão jurídica que a ADR 0010 pedia para a seção
  5A, inclusive a confirmação do arrependimento nas renovações e no upgrade.
- **Textos públicos.** Termos e política ficam em páginas abertas sem login
  (`/termos` e `/privacidade`), ligadas no rodapé do site.
- **Prova do corte.** O aviso, o recebimento, o aceite e a auditoria se provam
  na instalação; o corte de quem não aceita, que só ocorre em 01/12/2026, se
  prova em teste com relógio simulado e numa instalação local com uma versão
  de data anterior (evidência).

## Decisão de 02/11/2026

O mantenedor retirou a importação de lotes NFS-e ABRASF (#142) e pediu a
versão 1.1 na hora. Ela muda só a seção 1: a importação passa a ser só de
NF-e modelo 55, e as NFS-e ABRASF já importadas continuam para leitura,
download e exportação
([IMPORTS.md](../plataforma/IMPORTS.md#lotes-nfs-e-abrasf-retirados)). A
publicação segue a seção 11: aviso por e-mail e no console, e 30 dias para o
aceite, até 02/12/2026.

## Decisão de 03/11/2026

O dono aprovou em 03/11/2026, sem revisão jurídica, o texto da versão 1.2:
o primeiro parágrafo da seção 5 e a seção 5A inteira. O resto do texto é o
da 1.1. A fonte é a [ADR 0012](../adr/0012-periodo-por-aniversario.md), que
leva toda assinatura paga e as cotas dela ao aniversário da contratação e
pedia uma versão nova dos termos
([Consequências](../adr/0012-periodo-por-aniversario.md#consequências)).

- **Seção 5, primeiro parágrafo.** As cotas do Gratuito seguem o mês civil
  UTC; as dos planos pagos, o mês da assinatura.
- **Seção 5A.** Os planos pagos são só por cartão, pela Stripe; o Pix
  assistido está desligado desde 03/11/2026, e a escolha do meio de pagamento
  sai. Cada mês da assinatura vai da data e hora da contratação ao mesmo dia
  e hora do mês seguinte, no horário UTC, com o ajuste ao último dia num mês
  mais curto. O mensal e o anual são cobrados na contratação e renovam no
  aniversário; o anual deixa de esperar o dia 1 seguinte, e a contratação
  recusada antes do início sai. O upgrade não muda a data de renovação. Na
  rescisão do anual fora dos 7 dias, os meses contados e o acesso seguem o
  mês da assinatura, com os mesmos valores. A falha de pagamento, quitada no
  primeiro mês da assinatura do novo período, devolve o plano até o fim desse
  período sem mudar a data de renovação.

A versão 1.2 entrou no console em 04/11/2026, com o aviso e os 30 dias da
seção 11: as organizações aceitam até 04/12/2026.

## Decisão de 04/11/2026

Na #108, o mantenedor decidiu que uma NF-e importada no Sandbox com `tpAmb`
1 no XML conta como Produção para a guarda, e a plataforma passou a guardá-la
([RETENTION.md](../plataforma/RETENTION.md#organização-sem-produção-decidido-em-27102026)).
A versão 1.2 ainda dizia que o Sandbox não tem efeito fiscal; a #169 pede a
versão 1.3, que muda só isto:

- **Seção 2.** O Sandbox tira o efeito fiscal da emissão de NFS-e, que é
  simulada, não da NF-e importada, que não perde a validade que tiver.
- **Seção 9, primeiro parágrafo.** Uma nota recebida conta como dado de
  Produção, mesmo guardada no Sandbox, salvo quando o XML a declara emitida
  em homologação.
- **Seção 9, "Organização só com Sandbox".** O mesmo critério; o texto diz
  que nenhum documento da organização tem validade fiscal.
- **Cláusula de operadora, item 11.** Remete ao critério da seção 9.

A publicação segue a seção 11: aviso por e-mail e no console, e 30 dias para
o aceite, até 05/12/2026.
