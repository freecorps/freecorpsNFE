> **Versão 1.1 publicada em 02/11/2026 (#142).** O texto em vigor é o arquivo
> [`termos-de-uso-2026-11-02.md`](../termos/arquivo/termos-de-uso-2026-11-02.md),
> com a [cláusula de operadora](OPERADORA-DRAFT.md) no fim. A 1.0,
> [`termos-de-uso-2026-11-01.md`](../termos/arquivo/termos-de-uso-2026-11-01.md),
> foi publicada em 01/11/2026 (#428). Cada arquivo é a única cópia do seu
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
