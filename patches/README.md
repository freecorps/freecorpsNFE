# Patches de dependências

Bun aplica os três patches deste diretório pelo `patchedDependencies` do
`package.json` da raiz e pelo lockfile.

## Licença e aviso de modificação

Os três pacotes são Apache-2.0, e o `LICENSE` de cada um continua no pacote
instalado. Os patches são modificações feitas pela Freecorps e ficam sob a
mesma Apache-2.0, inclusive os arquivos novos `partitioned.ts`,
`partitioned.js` e `partitioned.d.ts` do rate-limiter. Por decisão do
mantenedor de 20/10/2026, cada patch é o aviso de modificação exigido pela
cláusula 4(b): ele lista os arquivos alterados, e esta tabela registra autoria
e data.

| Pacote                           | Arquivos alterados pelo patch                                                                         | Desde      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| `@convex-dev/better-auth@0.12.5` | `dist/react/index.d.ts`, `src/component/schema.ts`, `dist/component/schema.js`                        | 09/09/2026 |
| `@convex-dev/rate-limiter@0.3.2` | `lib`, `internal`, `schema` e `_generated/component` em `src` e `dist`, mais os novos `partitioned.*` | 27/10/2026 |
| `convex-test@0.0.60`             | `dist/index.js`                                                                                       | 03/11/2026 |

Alterar um patch atualiza a data nesta tabela.

## Correção de tipos do Better Auth

`@convex-dev/better-auth@0.12.5` declara as opções do cliente React com um tipo
de plugin. A inferência de sessão resulta em `never` com Better Auth recente.
O patch corrige `dist/react/index.d.ts`, preservando o JavaScript
publicado do cliente e os tipos específicos dos plugins.

O mesmo patch acrescenta o índice `lastRequest` à tabela `rateLimit` do
componente, em `src/component/schema.ts` e `dist/component/schema.js`, usado
pela rotina descrita em [OBSERVABILITY.md](../docs/plataforma/OBSERVABILITY.md).

Base: [issue upstream #420](https://github.com/get-convex/better-auth/issues/420)
e [correção proposta #396](https://github.com/get-convex/better-auth/pull/396).
Mantemos Better Auth `1.6.33` fixado, sem retornar a versões anteriores para
contornar o erro. Bun aplica o patch pelo `patchedDependencies` e pelo lockfile.
O build do console no CI verifica a compatibilidade sem casts no aplicativo.

Remover o patch quando uma versão publicada do componente corrigir essa
declaração, após rodar o build do console e os testes de autenticação.

## Consumo conjunto de limites

`@convex-dev/rate-limiter@0.3.2` recebe `lib.rateLimitMany`. O ensaio hospedado
de #79/#80 reproduziu conflitos esgotados quando cada requisição fazia quatro
chamadas ao componente para conferir e consumir dois orçamentos.
O patch reúne verificação e consumo em uma chamada. Até 20 orçamentos distintos
podem participar; um orçamento recusado impede o consumo de todos.

`partitionShards: 8` ativa partições para os orçamentos REST e de uso. A tabela
aditiva `partitions` registra uma configuração imutável por nome/chave. Na primeira
chamada, a transação calcula o saldo do contador antigo e o divide entre oito
linhas, sem conceder uma cota nova. Migração repetida é inócua; configuração
divergente, dívida reservada ou layout já fragmentado são recusados.

O caminho comum lê uma partição aleatória. Se ela não tiver um token, consulta
uma segunda e prefere a mais cheia. Isso evita ampliar o conjunto de conflito
com uma leitura desnecessária quando a primeira já tem saldo. Se faltar saldo, procura
nas demais e combina frações até completar um token; só recusa após conferir
todas. Capacidade e reposição totais permanecem 60/120 por minuto, divididas
entre as partições. Como a reposição tem teto por partição, distribuição desigual
pode repor menos que o contador único; não pode conceder mais. As chamadas antigas
`checkRateLimit` e `rateLimit` reconhecem o layout migrado e usam a mesma regra.
`rateLimitMany` aceita `partitionLane` (#559): a partição a ler primeiro em todos
os orçamentos do lote, no lugar da primeira sorteada; as demais seguem a ordem
aleatória. Só a ordem de leitura muda, então saldo, consumo e recusa são os
mesmos. O argumento é opcional, e um binário anterior do patch o recusaria por
validação, então o rollback do patch exige antes publicar o aplicativo sem ele.
`getValue` soma as partições; `resetRateLimit` apaga o orçamento inteiro.
`clearAll` recusa enquanto houver partições, para não apagar linhas isoladas.

O orçamento específico de importações também participa do mesmo lote, com
20 admissões por minuto e janela fixa iniciada em zero. A migração conserva
saldo e início da janela; a reposição acontece na fronteira original. Campos
novos do layout são opcionais para aceitar as partições token bucket já criadas.
A admissão REST resolve a identidade por query e chama o componente diretamente
da action HTTP, encurtando a transação que disputa saldo. O domínio continua
validando chave, permissão e escopo antes de ler ou escrever dados.

O rollback do aplicativo deve conservar este componente: um binário anterior
que desconheça `partitions` não interpreta os contadores migrados. Não remova
o patch nem altere a configuração de um orçamento existente sem migrar seu saldo.

A implementação está em `src/component/lib.ts`, com JavaScript e declarações
compilados em `dist`. Os tipos do componente foram regenerados com Convex 1.45.0
por `convex codegen --component-dir .../src/component --typecheck disable`,
sem publicar funções, e compilados com TypeScript 6.0.3. Bun aplica o patch
fixado no lockfile. Não editar as saídas geradas do aplicativo para usá-lo.

`platform/convex/rate-limits.test.ts` verifica atomicidade, migração de saldo parcial,
reposição, coexistência de chamadas antigas e rejeição de orçamentos repetidos.
`scripts/proofs/prove-hosted-rate-limits.mjs <credencial> <sha-publicado>` repete a
migração e 100 chamadas concorrentes em contadores sintéticos, removidos ao final.
Os testes de chaves e uso
cobrem HTTP, concorrência, revogação, isolamento e cotas. A prova hospedada
continua necessária para medir contenção; `convex-test` não a reproduz.
Remover o patch quando o componente oferecer uma operação conjunta equivalente,
preservando os contadores na transição e repetindo a carga antes do aceite.

## Arquivos guardados por actions no convex-test

`convex-test@0.0.60` roda uma query ou mutation por vez, sob uma trava, e grava
o arquivo que uma action guarda (`ctx.storage.store`, `ctx.storage.delete`)
numa transação própria. Para decidir se abria essa transação, o pacote
perguntava se alguma função segurava a trava, e não se quem gravava era uma
mutation. Uma action que guardava um arquivo enquanto outra função rodava
gravava na transação dessa outra função; se ela terminasse antes do hash do
arquivo, a gravação falhava com `Write outside of transaction`. Duas entregas
concorrentes de `platform/convex/privacyMail.test.ts` caíram nisso no CI.

O patch troca a pergunta em `writeToDatabase`, de `dist/index.js`: fora de uma
query ou mutation, a gravação abre a própria transação e espera a trava. Só os
testes usam o pacote; o runtime do Convex não muda.
`platform/convex/convexTestStorage.test.ts` segura a trava com uma mutation
enquanto uma action guarda um arquivo e falha sem o patch com o mesmo erro do
CI. A 0.0.67, a mais recente em 03/11/2026, ainda tem o defeito. Remover o
patch quando uma versão publicada decidir pelo contexto de quem grava, depois
de rodar esse teste sem ele.

## Revisão a cada atualização

Revisado em 21/10/2026 (#294): os três patches continuam necessários. Nenhum
deles sai, nem uma dependência muda de versão, só para reduzir linhas. Bun
amarra cada patch à versão exata em `patchedDependencies`; subir a versão de um
desses pacotes exige portar o patch, retirá-lo com equivalente comprovado ou
manter a versão.

Em 09/11/2026 (#142), o patch do Workpool saiu: a 0.4.13 publica a mesma
correção de `src/component/shared.ts` (get-convex/workpool#242).

| Pacote                     | Por que permanece                                                                | Próxima revisão                                                  | Prova antes de retirar ou portar                                                                              |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@convex-dev/better-auth`  | Tipos do cliente React sem `never` e índice `rateLimit.lastRequest` da limpeza   | Versão publicada com a correção de #420 e o índice `lastRequest` | `bun run build`, testes de autenticação e a consulta de limpeza de OBSERVABILITY.md sem aviso                 |
| `@convex-dev/rate-limiter` | Consumo conjunto atômico e partições com saldo migrado                           | Versão publicada com operação conjunta equivalente               | `platform/convex/rate-limits.test.ts`, testes de chaves e uso e `scripts/proofs/prove-hosted-rate-limits.mjs` |
| `convex-test`              | O arquivo guardado por uma action entra na transação de outra função concorrente | Versão publicada que decida pelo contexto de quem grava          | `platform/convex/convexTestStorage.test.ts` sem o patch e `vp run test:platform`                              |

O índice `lastRequest` não tem equivalente no Better Auth publicado. Retirar a
correção de tipos não retira o patch: ele só sai quando o componente trouxer o
índice ou a limpeza deixar de depender dele, e o índice nunca pode sumir do
schema publicado enquanto a rotina o consulta.

O limitador exige mais cuidado, porque o patch mudou dados persistidos:

- **Saldo.** A versão nova lê a tabela `partitions` e os contadores migrados sem
  conceder cota nova nem perder a reservada. Repita os testes de migração com
  saldo parcial e janela fixa.
- **Atomicidade.** Um orçamento recusado continua impedindo o consumo dos
  demais no mesmo lote.
- **Migração.** Se o equivalente publicado usar outro layout, a passagem
  converte os contadores existentes na mesma transação que os lê, como a
  migração atual, e é repetível sem efeito.
- **Rollback.** Publique primeiro uma versão que leia os dois layouts. Só
  depois que ela estiver em produção, uma versão pode deixar de ler o layout
  antigo; até lá, voltar ao binário anterior precisa continuar lendo o que a
  nova escreveu.

Antes do aceite, rode a prova hospedada contra o SHA publicado; `convex-test`
não reproduz a contenção.

## Cache do console

O cache de consultas do console não tem patch, mas lê o registro interno de
`convex-helpers/react/cache`, fora da API documentada. `DropOnUnmount`, em
`apps/console/src/convex-query.tsx`, fecha as assinaturas ociosas na hora em
que o cache da organização desmonta; sem ele, elas esperariam a expiração de
60 s depois de sair, trocar de organização ou perder o membership. Ele depende
de:

- `ConvexQueryCacheContext` exportado por `convex-helpers/react/cache/provider`,
  com valor `{ registry }`;
- `registry.queries` como `Map` de entradas com `evictTimer` (timer de expiração
  ou `null`) e `unsub()`, que fecha a assinatura no cliente Convex;
- `registry.subs` e `registry.idle`, zerados junto, e `end(id)` ignorando um id
  que já não está em `subs`, para a liberação tardia de uma página não fechar
  nada duas vezes.

`convex-helpers` fica fixado em versão exata (`0.1.127`) em `apps/console` e
`platform`. Ao atualizar, `bun run platform:check` confere os nomes e tipos, e
`apps/console/src/query-cache.test.tsx` confere o comportamento: desmontar o
cache fecha as assinaturas ociosas e as mostradas sem timer pendente, e a
mudança de membership, a revogação, a saída, a reconexão e a troca de
organização fecham as da organização na hora. Se a biblioteca passar a
oferecer encerramento público do cache, troque o acesso interno por ele com os
mesmos testes.
