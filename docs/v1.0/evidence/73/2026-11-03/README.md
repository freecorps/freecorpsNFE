# Publicação de @freecorps/freecorpsnfe-sdk 0.1.0 (#73)

Em 03/11/2026 o SDK passou a ser publicado no npm como
`@freecorps/freecorpsnfe-sdk`, nome dado na #72. O npm não aceita maiúsculas
em nomes novos, por isso o nome é todo em minúsculas. O antigo
`@freecorps/sdk` 0.1.0, publicado em 01/11/2026 (#83), continua no registry,
marcado como obsoleto.

## Aceite

O mantenedor aceitou na #73, em 03/11/2026, `rights` e `release-acceptance`
deste pacote, versão e hash. O lote tem só o SDK: `fiscal-core`,
`fiscal-nfe` e `fiscal-nfse` continuam na 0.1.0 de 01/11/2026.

| Pacote                        | Versão | SHA-256 do tarball                                                 |
| ----------------------------- | ------ | ------------------------------------------------------------------ |
| `@freecorps/freecorpsnfe-sdk` | 0.1.0  | `36c29407c77216f798aeb73601020554c51fb8bcf5c8a41f2cb80b6c72ba5159` |

- `accepted.json`: o lote passado a `scripts/publish-packages.mjs`.
- `rights.json`: a relação de `scripts/rights-relation.mjs` para os arquivos
  do tarball.

A prova é `bun run distribution:prove`, num checkout limpo de
`c138d933bf390b3908026198e5b4b67aecc06611` (merge da #72), com Node
v22.23.4 e Bun 1.4.0.

## Recibo

- O mantenedor publicou com `node scripts/publish-packages.mjs`, na conta da
  organização `freecorps` com 2FA. O registry registra a 0.1.0 em
  `2026-11-03T22:50:31.677Z`, com a tag `latest`.
- Integridade no registry:
  `sha512-FZGc5G4e9WKp1n+KNK2vutkY5/1UMhyecX3/uzmjAkqyLoAUZefTTHUXe1zhmJrReyLoWwzY5oIa2H7eElLGag==`.
  O SHA-256 do tarball baixado do registry é o aceito.
- `npm view @freecorps/freecorpsnfe-sdk@0.1.0`: licença MIT, dependência só
  `zod` 4.6.7.
- `npm deprecate @freecorps/sdk "Renomeado para @freecorps/freecorpsnfe-sdk"`,
  conferido com `npm view @freecorps/sdk@0.1.0 deprecated`.

## Instalação pelo registry

Num consumidor limpo, fora do repositório, `npm install
@freecorps/freecorpsnfe-sdk@0.1.0 @freecorps/fiscal-core@0.1.0` instalou três
pacotes (o SDK, fiscal-core e zod) com as integridades acima.
`scripts/lib/sdk-distribution-consumer.mjs`, com os vetores de
`packages/contracts/fixtures/webhooks.json`, respondeu
`{"runtime":"v22.23.4","vectors":14,"exactDecimal":"passed"}`.

`bun scripts/prove-distribution.mjs --registry` não serve para este lote: ele
compara os quatro pacotes publicados com os reconstruídos da revisão, e
`fiscal-nfe` e `fiscal-nfse` mudaram desde 01/11/2026 sem nova versão. A
prova recusa `fiscal-nfe` antes de chegar ao SDK.
