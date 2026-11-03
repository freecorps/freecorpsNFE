# @freecorps/contracts

Tipos e schemas Zod compartilhados pela plataforma, pelo console e pelo SDK: o
contrato REST público (`./external`), webhooks, consultas de referência e
cadastro, além dos tipos de organizações, projetos, empresas e documentos. A
versão do contrato REST é `apiVersion`, hoje 8.0.0. O pacote não acessa rede,
ambiente nem backend.

Exports: `.`, `./organizations`, `./external`, `./webhooks`, `./references` e
`./registry`. Depende de `@freecorps/fiscal-core` e `zod`.

Pacote privado, sem publicação no registry. Build: `bun run packages:build` e
depois `bun run contracts:build` na raiz, que gravam o pacote em `dist/`.
