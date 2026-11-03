# Política de privacidade e retenção, D06: fontes e decisões

> **Publicada em 01/11/2026 (#428).** O texto em vigor é o arquivo
> [`politica-de-privacidade-2026-11-01.md`](../termos/arquivo/politica-de-privacidade-2026-11-01.md),
> versão 1.0, mostrado sem login em `/privacidade`, com a versão, a data, o
> SHA-256 (`PRIVACY_POLICY_ARCHIVE`, `platform/convex/lib/privacyPolicyArchive.ts`)
> e as versões anteriores. Ninguém aceita a política; os termos de uso apontam
> para ela. Uma mudança é uma versão nova, num arquivo novo, com o aviso da
> seção 9 quando ela muda o tratamento.
>
> O texto foi aprovado pelo mantenedor em 28/10/2026, sem revisão jurídica
> (#586). Em 01/11 ele recebeu, sem mudar prazos nem bases legais: a Stripe
> como provedora da cobrança por cartão, a classe "Cobrança" na seção 2 e um
> parágrafo sobre a guarda fria do arquivamento, que vale quando o
> arquivamento for ativado. As tabelas viraram listas, porque o console mostra
> só parágrafos, listas e títulos.

## Fontes de cada seção

| Seção | Fonte                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2  | [RIGHTS.md](../plataforma/RIGHTS.md#papéis-e-responsáveis), [CAPTURE.md](../plataforma/CAPTURE.md) e [BILLING.md](../plataforma/BILLING.md)                   |
| 3     | Bases legais por classe propostas em 25/10 e aprovadas em 28/10 (#586); [avaliação do CNPJ](../licenses/CNPJ-LEGITIMATE-INTEREST.md)                          |
| 4     | Inventário de D03 e o adendo de 29/10; [STRIPE.md](../plataforma/STRIPE.md)                                                                                   |
| 5     | [RETENTION.md](../plataforma/RETENTION.md), D03, D04 e a [documentação da Convex](https://docs.convex.dev/database/backup-restore) consultada em 05/10/2026   |
| 6     | [Encerramento implementado](../plataforma/RETENTION.md#encerramento-implementado-d01) e [Minha conta](../plataforma/RIGHTS.md#exclusão-de-conta)              |
| 7     | [Atendimento a direitos](../plataforma/RIGHTS.md#dados-de-pessoas-físicas-em-documentos-fiscais) e a [caixa de privacidade](../operacao/privacidade-email.md) |

## Histórico das condições de D06

Estado das condições em 18/10/2026 (histórico; D03 e D04 foram aceitos em 28/10, ver a nota acima), conforme [Retenção](../plataforma/RETENTION.md):

| Condição                              | Estado                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01, encerramento e guarda por classe | Encerramento, expurgo e expurgo ao fim da guarda (#186) implementados; prova só em `convex-test`; guarda contada do ano do encerramento aceita pelo mantenedor em 21/10/2026; aplicação na instalação pendente |
| D02, atendimento a direitos           | Caixa ativada em 21/10, com conta autorizada verificada e ensaio pelo console aceito; substituto indicado, sem conta nem acesso testado ([roteiro](../operacao/privacidade-email.md))                          |
| D03, logs dos provedores              | Roteiro do inventário documentado (#190); configuração da instalação não conferida                                                                                                                             |
| D04, backups                          | Cópia externa configurada em 08/10; agendamentos falharam de 09/10 a 18/10 (RPO violado), corrigidos pela #244 e aprovados em 19/10; custódia definitiva pela #248; ensaio de perda do host pendente           |
| D05, restauração                      | Ensaio local aprovado em 07/10                                                                                                                                                                                 |
| Revisão fiscal/privacidade por classe | Guarda decidida em 07/10; bases legais e papel por classe propostos em 25/10 e aprovados pelo mantenedor em 28/10, sem jurídico                                                                                |

Em 25/10/2026 (#428), o rascunho passou a cobrir a captura fiscal no site,
os dados de terceiros nas notas e uma proposta de base legal por classe, e
ganhou a [cláusula de operadora](OPERADORA-DRAFT.md) como anexo. O site
guardou notas reais de clientes de 22/10/2026 até a publicação sem a política
nem o contrato de operadora que a
[guarda](../plataforma/RETENTION.md#guarda-após-o-encerramento-d01) exige; a
publicação de 01/11/2026 fechou essa lacuna. D01 continua na #80, sem bloquear
a publicação (ADR 0011).
