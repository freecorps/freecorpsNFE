# Motor NFC-e no backend existente

## Situação em 21/10/2026

> O adaptador NFC-e SP descrito aqui vivia no backend legado
> (`convex/engine/nfce/`) e foi removido com ele pela PR [#373](https://github.com/freecorps/freecorpsNFE/pull/373), no
> commit [`e1156c5`](https://github.com/freecorps/freecorpsNFE/commit/e1156c58a126bcc664403163e63bd69c17e3b611). A plataforma atual não emite NFC-e; uma retomada exige
> decisão nova.
> O código histórico continua no Git: `git show e1156c5^:<caminho>` mostra
> cada arquivo como era antes da remoção. O texto abaixo registra a decisão
> como foi tomada e não foi reescrito.

Em 08/09/2026, escolhemos implementar um adaptador NFC-e SP no Convex Node,
reutilizando o cofre A1, `xml-crypto`, `xmlbuilder2`, a fila e a outbox. O
adaptador recebe o snapshot fiscal do contrato v1, guarda o XML assinado antes
do envio e consulta a SEFAZ antes de repetir uma transmissão ambígua. A1/CSC
reais estão pendentes por decisão do usuário; os testes locais não substituem
a autorização de uma NFC-e do restaurante em homologação.

Foram avaliadas as fontes disponíveis nesta data:

| Opção                                                                                                          | Compatibilidade, manutenção e licença                                                                                                                                                                                                   | Decisão                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [NFeWizard](https://github.com/nfewizard-org/nfewizard-io/tree/ce2f93409f8ad6316069f80019a88b077abb9810)       | Monorepo ativo, GPL-3.0; o pacote compartilhado usa `libxmljs2`, `pem` e `xsd-schema-validator`. Sua infraestrutura de arquivos, validação nativa e transporte exigiria adaptação ao runtime e ao cofre existentes.                     | Não incorporar a biblioteca inteira. A licença também exigiria avaliação específica antes de distribuição. |
| [@brasil-fiscal/nfe 2.0.7](https://github.com/brasil-fiscal/nfe/tree/ed72d00bc2794ba16e65418dbd446ef9c3035474) | MIT, Node ≥18; fonte atualizada em julho/2026. O pacote depende de `@brasil-fiscal/core` e Zod e oferece construção de XML/QR. Ainda seria necessário adaptar o contrato e provar a preservação dos snapshots e dos grupos tributários. | Alternativa possível; não adotada neste recorte.                                                           |
| Adaptador próprio com [libxml2-wasm 0.7.2](https://github.com/jameslan/libxml2-wasm/tree/v0.7.2)               | Reaproveita os componentes já usados em NFS-e; valida os XSDs oficiais em memória, sem instalar validador Java ou addon nativo. O pacote WASM usa licença MIT e libxml2.                                                                | Adotado; assinatura, XSD e storage foram exercitados no Convex local.                                      |

A contrapartida é manter explicitamente o mapeamento tributário e acompanhar
as notas técnicas. O motor cobre o recorte e as limitações descritos em
NFC-E-SP.md; grupos não representáveis são recusados. A troca
futura do construtor não deve alterar a identidade já reservada nem reconstruir
XML de uma transmissão pendente.
