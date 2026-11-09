# @freecorps/convex-rate-limiter

Componente Convex de limites de taxa da plataforma. É o
[`@convex-dev/rate-limiter`](https://github.com/get-convex/rate-limiter) 0.3.2
com o consumo conjunto e as partições que a Freecorps acrescentou. Até
09/11/2026 essas mudanças eram um patch sobre o pacote do npm; a #142 as
trouxe para cá, com código-fonte, testes e versão próprios. O pacote é
privado e não é publicado.

`platform/convex/convex.config.ts` o instala com o nome `rateLimiter`. As
tabelas do componente pertencem a esse nome, não ao pacote: trocar
`@convex-dev/rate-limiter` por este pacote manteve os contadores existentes.
Nunca mude o nome da instância nem o `defineComponent("rateLimiter")`, ou o
Convex cria um componente vazio e os saldos em uso ficam para trás.

## Licença

Apache-2.0, como o original; o texto está em [LICENSE](LICENSE). As
modificações da Freecorps ficam sob a mesma licença, e [NOTICE](NOTICE) é o
aviso de modificação da cláusula 4(b).

## Consumo conjunto de limites

`lib.rateLimitMany` confere e consome até 20 orçamentos distintos numa
chamada. Um orçamento recusado impede o consumo de todos. O ensaio hospedado
de #79/#80 reproduziu conflitos esgotados quando cada requisição fazia quatro
chamadas ao componente para conferir e consumir dois orçamentos.

`partitionShards: 8` ativa partições para os orçamentos REST e de uso. A tabela
aditiva `partitions` registra uma configuração imutável por nome/chave. Na
primeira chamada, a transação calcula o saldo do contador antigo e o divide
entre oito linhas, sem conceder uma cota nova. Migração repetida é inócua;
configuração divergente, dívida reservada ou layout já fragmentado são
recusados.

O caminho comum lê uma partição aleatória. Se ela não tiver um token, consulta
uma segunda e prefere a mais cheia. Isso evita ampliar o conjunto de conflito
com uma leitura desnecessária quando a primeira já tem saldo. Se faltar saldo,
procura nas demais e combina frações até completar um token; só recusa após
conferir todas. Capacidade e reposição totais permanecem as configuradas,
divididas entre as partições. Como a reposição tem teto por partição,
distribuição desigual pode repor menos que o contador único; não pode conceder
mais. As chamadas antigas `checkRateLimit` e `rateLimit` reconhecem o layout
migrado e usam a mesma regra.

`rateLimitMany` aceita `partitionLane` (#559): a partição a ler primeiro em
todos os orçamentos do lote, no lugar da primeira sorteada; as demais seguem a
ordem aleatória. Só a ordem de leitura muda, então saldo, consumo e recusa são
os mesmos. `getValue` soma as partições; `resetRateLimit` apaga o orçamento
inteiro. `clearAll` recusa enquanto houver partições, para não apagar linhas
isoladas.

O orçamento de importações participa do mesmo lote, com 20 admissões por
minuto e janela fixa iniciada em zero. A migração conserva saldo e início da
janela; a reposição acontece na fronteira original. Campos novos do layout são
opcionais para aceitar as partições token bucket já criadas.

A implementação fica em `src/component/lib.ts` e `src/component/partitioned.ts`.
O Convex empacota o componente direto do TypeScript, sem `dist`. Os arquivos
de `src/component/_generated/` saem do push local da plataforma
(`bun run worktree:sync`); não os edite à mão.

## Testes

`vp test run packages/convex-rate-limiter` roda os testes do pacote original,
adaptados ao Vite+. `platform/convex/rate-limits.test.ts` verifica
atomicidade, migração de saldo parcial, reposição, coexistência de chamadas
antigas e rejeição de orçamentos repetidos. Os testes de chaves e uso cobrem
HTTP, concorrência, revogação, isolamento e cotas.
`scripts/proofs/prove-hosted-rate-limits.mjs <credencial> <sha-publicado>`
repete a migração e 100 chamadas concorrentes em contadores sintéticos,
removidos ao final. A prova hospedada continua necessária para medir
contenção; `convex-test` não a reproduz.

## Mudanças e rollback

O componente guarda dados persistidos, então cada mudança segue estas regras:

- **Saldo.** Uma versão nova lê a tabela `partitions` e os contadores migrados
  sem conceder cota nova nem perder a reservada. Repita os testes de migração
  com saldo parcial e janela fixa.
- **Atomicidade.** Um orçamento recusado continua impedindo o consumo dos
  demais no mesmo lote.
- **Migração.** Um layout novo converte os contadores existentes na mesma
  transação que os lê, como a migração atual, e é repetível sem efeito.
- **Rollback.** Publique primeiro uma versão que leia os dois layouts. Só
  depois que ela estiver em produção, uma versão pode deixar de ler o layout
  antigo; até lá, voltar ao binário anterior precisa continuar lendo o que a
  nova escreveu. Um binário que desconheça `partitions` não interpreta os
  contadores migrados, e um que desconheça `partitionLane` recusa a chamada
  por validação.

Não altere a configuração de um orçamento existente sem migrar seu saldo.
Antes do aceite, rode a prova hospedada contra o SHA publicado.

## Voltar ao pacote do npm

O `@convex-dev/rate-limiter` 0.4.x seguiu outra arquitetura (`worker.ts`,
`pendingUpdates`) e não tem operação conjunta nem a migração para partições.
Trocar este pacote por uma versão publicada exige uma operação conjunta
equivalente e uma passagem que preserve os contadores atuais, sob as regras
acima, com a carga hospedada repetida antes do aceite.
