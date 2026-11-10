# Cláusula de operadora: fontes e decisões

> **Publicada em 01/11/2026 (#428), como parte dos termos de uso 1.0.** O
> texto em vigor, com o anexo técnico, está no fim do arquivo
> [`termos-de-uso-2026-11-01.md`](../termos/arquivo/termos-de-uso-2026-11-01.md),
> aceito no console por um Proprietário de cada organização, com versão e
> SHA-256 registrados ([Termos](../termos/README.md#termos-de-uso)). A
> [guarda](../plataforma/RETENTION.md#guarda-após-o-encerramento-d01) exige essa
> cláusula para guardar XML fiscal. Este documento guarda a origem de cada
> afirmação e as decisões.

## Conferência do anexo técnico

| Medida                   | Conferência na instalação                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Acesso pelo produto      | Testes `convex-test` de cada domínio                                                                                                            |
| Chaves de API            | [PROJECTS.md](../plataforma/PROJECTS.md)                                                                                                        |
| Certificados A1 e senhas | [CERTIFICATES.md](../plataforma/CERTIFICATES.md)                                                                                                |
| Criptografia em trânsito | TLS 1.3 e HSTS no console e na API; HTTP redirecionado para HTTPS por regra da zona desde 29/10/2026 (adendo de D03); o Convex redireciona HTTP |
| Registros                | [OBSERVABILITY.md](../plataforma/OBSERVABILITY.md)                                                                                              |
| Backup                   | D04 e D05, [backup](../operacao/backup.md)                                                                                                      |
| Acesso administrativo    | Logs dos provedores, D03: admins do GitHub, do time Convex e da conta Cloudflare; [deploy](../operacao/deploy-producao.md)                      |
| Incidentes               | [SECURITY.md](../../SECURITY.md)                                                                                                                |

## De onde vem cada afirmação

| Cláusula | Fonte                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 4, 9  | [RIGHTS.md](../plataforma/RIGHTS.md#papéis-e-responsáveis) e [RETENTION.md](../plataforma/RETENTION.md#guarda-após-o-encerramento-d01)                                             |
| 2, 3     | [README](../../README.md#o-que-dá-para-fazer), [CAPTURE.md](../plataforma/CAPTURE.md) e [EXPORTS.md](../plataforma/EXPORTS.md)                                                     |
| 5, 12    | [RETENTION.md](../plataforma/RETENTION.md#guarda-após-o-encerramento-d01) (acesso pelo painel) e [EXPORTS.md](../plataforma/EXPORTS.md)                                            |
| 6        | [CERTIFICATES.md](../plataforma/CERTIFICATES.md), [PROJECTS.md](../plataforma/PROJECTS.md), [OBSERVABILITY.md](../plataforma/OBSERVABILITY.md) e [backup](../operacao/backup.md)   |
| 7        | Seção 4 da [política publicada](../termos/arquivo/politica-de-privacidade-2026-11-01.md); D03 e D04 em [RETENTION.md](../plataforma/RETENTION.md#proposta-operacional-de-06102026) |
| 11       | [Encerramento e guarda implementados](../plataforma/RETENTION.md#encerramento-implementado-d01)                                                                                    |

A política lista também GitHub, para CI e publicação. A cláusula
o deixa de fora porque o CI usa dados sintéticos; confirmar no inventário de
D03 que nenhum dado de cliente passa por ele.

## Decisões de 28/10/2026

- **Forma:** parte dos termos de uso, aceita no console por um Proprietário,
  com versão e SHA-256 registrados por organização. Os clientes que já têm
  captura real aceitam pelo mesmo fluxo quando os textos forem publicados.
- **Lacunas:** cláusulas usuais, comparadas com o acordo da Qive.
- **Aprovação, na #586:** sem assessoria jurídica, o mantenedor aprovou as
  cláusulas propostas como estão, assumindo o risco.

| Cláusula                  | Proposta                                         | Referência lida em 28/10/2026                                                                                   |
| ------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 3, instruções             | Pedido por escrito, resposta em 5 dias úteis     | Qive, §4: instruções "formalizadas por escrito"                                                                 |
| 5, sigilo                 | Dever contratual que sobrevive à função          | Qive, §14, só entre as partes; aqui cobre a equipe                                                              |
| 7, suboperadores          | 30 dias de aviso, objeção em 15                  | Qive, §10, não prevê aviso; prazo usual de mercado                                                              |
| 8, transferência          | Art. 33 com as cláusulas-padrão da ANPD          | Qive, §11: Resolução CD/ANPD nº 19/2024                                                                         |
| 10, incidente             | 48 horas                                         | Qive, §9: "em até 48 (quarenta e oito) horas"; o controlador tem 3 dias úteis pela Resolução CD/ANPD nº 15/2024 |
| 11, apagamento antecipado | A pedido, com a guarda assumida pelo cliente     | Qive, §12: o que não pode ser excluído fica bloqueado                                                           |
| 12, auditoria             | Documentação; auditoria anual a custo do cliente | Nenhuma plataforma lida prevê; prática usual de mercado                                                         |

## Pendências para decisão

Nenhuma desde 29/10/2026: as regiões e o HTTPS do anexo foram conferidos no
adendo de D03.
