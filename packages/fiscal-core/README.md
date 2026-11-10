# @freecorps/fiscal-core

Conceitos compartilhados por consumidores existentes: CNPJ (contratos e NF-e),
CPF (NF-e, emissão NFS-e e console),
decimais exatos, resultados de verificações e versões de processamento. Não contém
modelo universal de documento fiscal, acesso a ambiente, rede ou SDK do SaaS.

`ExactDecimal` usa `{ coefficient: string, scale: number, declared: string }`.
`declared` preserva a escrita recebida, inclusive zeros; `coefficient` permite
JSON sem perder inteiros grandes. Cálculos usam `bigint` internamente. Limites:
40 dígitos inteiros e 20 fracionários. `add` preserva a maior escala e recusa
resultado fora desses limites. `multiply` devolve o produto exato, com a soma
das escalas, sem arredondar; recusa escala acima de 20 (`DECIMAL_SCALE`) e
resultado fora dos limites. `quantize` exige escolha explícita entre `reject`,
`truncate`, `half-up` e `half-even`; o modo `reject` recusa perda de precisão.
Escalas fiscais pertencem ao pacote do modelo, não a este núcleo.

`validateAccessKey` aceita só chave de acesso de NF-e modelo 55: uma chave
válida de outro modelo, como a NFC-e 65, é recusada com o motivo `model`
(`NFE_MODEL_MISMATCH`). É regra de projeto, não lacuna: a plataforma importa
só NF-e 55, e aceitar outro modelo exige decisão e pacote próprios.

Instalação: `npm install @freecorps/fiscal-core`. Licença em [LICENSING.md](LICENSING.md).
