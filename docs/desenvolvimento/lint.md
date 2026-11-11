# Regras de lint do projeto

Referência das regras do plugin oxlint `freecorps`, que transformam regras do
[AGENTS.md](../../AGENTS.md) em verificação mecânica. O plugin fica em
`tooling/oxlint-plugin-freecorps/`, com uma regra por arquivo em `rules/` e o
teste de cada uma ao lado. `vite.config.ts` o registra em `lint.jsPlugins` e
define o escopo de cada regra em `lint.rules` e `lint.overrides`. As regras
rodam em `vp lint` e `vp check`, portanto em `ci:check` do grafo `validate`.

Os plugins JS do oxlint recebem a AST sem informação de tipos. Por isso os
critérios abaixo reconhecem valores e chamadas pelo nome e pela forma do
código, não pelo tipo TypeScript.

| Regra                                                                                     | Protege                                       | Escopo                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| [`no-float-fiscal-values`](#no-float-fiscal-values)                                       | AGENTS.md §3, decimal exato                   | Todo arquivo, exceto `packages/fiscal-core/` |
| [`require-access-helper-in-convex-functions`](#require-access-helper-in-convex-functions) | AGENTS.md §1 e §4, servidor confere o acesso  | `platform/convex/`                           |
| [`no-wall-clock-in-tests`](#no-wall-clock-in-tests)                                       | [ci.md](ci.md#isolamento), relógio nos testes | `*.test.*`, exceto benchmarks                |
| [`require-suppression-reason`](#require-suppression-reason)                               | Toda supressão diz por quê                    | Todo arquivo                                 |

Desligar uma dessas regras numa linha exige motivo, como qualquer supressão:
`// oxlint-disable-next-line freecorps/<regra> -- <motivo>`.

## no-float-fiscal-values

Valor fiscal é texto decimal exato e só se calcula com `decimal`, `quantize`,
`add` e `multiply` de `@freecorps/fiscal-core`. A regra reprova, fora de
`packages/fiscal-core/`:

- `Number(v)`, `parseFloat(v)`, `parseInt(v)`, `Number.parseFloat(v)`,
  `Number.parseInt(v)` e `Math.*(v)`;
- `v.toFixed()` e `v.toPrecision()`;
- `+v` e `-v` unários;
- `+`, `-`, `*`, `/`, `%`, `**` e as atribuições compostas com `v` de um dos
  lados. `+` com literal de texto ou template é concatenação e passa.

`v` é um valor fiscal quando o nome bate com um destes critérios:

| Critério                                         | Nomes                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tag de valor da NF-e/NFS-e, em qualquer contexto | `v` seguido de radical fiscal: `vNF`, `vProd`, `vBC`, `vICMS`, `vIPI`, `vPIS`, `vCOFINS`, `vISS`, `vFCP`, `vST`, `vFrete`, `vDesc`, `vUnCom`, `vServ`, `vLiq`, `vTotTrib` e afins              |
| Alíquota, em qualquer contexto                   | `pICMS`, `pIPI`, `pPIS`, `pCOFINS`, `pISS`, `pFCP`, `pMVA`, `pRed…`, `pCredSN`                                                                                                                 |
| Quantidade, em qualquer contexto                 | `qCom`, `qTrib`                                                                                                                                                                                |
| Campo do contrato, em qualquer contexto          | `unitPrice`, `tributaryUnitPrice`, `tributaryQuantity`, `brlAmount`, `serviceBrl`, `issRate`                                                                                                   |
| Nome genérico dentro de contêiner fiscal         | `value`, `total`, `amount`, `quantity`, `rate` como propriedade de `amount`, `payload`, `tax`, `taxes`, `totals`, `item`, `items[i]`, `service`, `conversion`, `values[i]` ou `declaredTotals` |

O contêiner evita confundir `event.total` de um upload, o `rate` de um limite
de requisições ou um contador `total`. Valores do Stripe em centavos inteiros
(`amount_due`, `unit_amount`) já chegam como número e não batem com os nomes.

Limites: a regra não segue o valor por variáveis intermediárias
(`const x = doc.vNF; Number(x)` passa) e não vê comparações (`a.vNF > b.vNF`).

## require-access-helper-in-convex-functions

Toda função pública de `platform/convex/` (`query`, `mutation`, `action`,
`httpAction` e `observedAction`, inclusive o `httpAction` registrado direto
em `http.route`) confere o acesso antes de tocar em dado. Funções internas
(`internalQuery`, `internalMutation`, `internalAction`) ficam de fora: só o
servidor as chama, e quem chama já conferiu.

- **Checagem** é uma chamada a uma função de `checks` ou `wrappers` em
  `tooling/oxlint-plugin-freecorps/access-helpers.mjs`, importada ou do próprio
  módulo, ou a uma função interna que confere primeiro (veja
  [Delegação](#delegação)).
- **Caminhos:** a regra segue os ramos de `if` e `?:`. Depois deles, só conta a
  checagem feita em todos os ramos que seguem adiante; um ramo que sai da
  função (`return`, `throw`) não precisa conferir. Uma checagem no lado direito
  de `&&`, `||`, `??` ou `||=`, num `case`, num laço, no `try` de um
  `try/catch`, no `catch` ou numa função aninhada (callback de `map`, por
  exemplo) pode não rodar, e não vale para o que vem depois. Dentro do próprio
  ramo, ela vale até o fim dele.
- **Contexto** é o primeiro parâmetro do handler, inteiro (`ctx`) ou
  desestruturado (`{ db }`, `{ runQuery: run }`); uma forma que a regra não lê,
  como padrão aninhado, reprova.
- **Toque em dado** é `ctx.db.query/insert/patch/replace/delete`,
  `ctx.db.system`, `ctx.runQuery/runMutation/runAction`, `ctx.scheduler`,
  `ctx.storage` ou qualquer função importada que receba `ctx`.
- **Carrega e confere:** `ctx.db.get` antes da checagem é aceito, desde que a
  checagem venha antes de qualquer outro toque em dado. É o padrão do
  [AGENTS.md](../../AGENTS.md) §1: o servidor carrega o registro e confere quem
  pode agir sobre ele. Um `ctx.db.get` sem checagem depois reprova.
- A regra segue as funções locais do arquivo, inclusive as guardadas num
  objeto (`selectors.x(ctx)`), com o `ctx` repassado.

### Helpers de acesso

`access-helpers.mjs` classifica cada função exportada dos `lib/*Access.ts`:

- `checks` conferem quem chama sobre o tenant, como `requireMembership`,
  `requireCompany`, `memberAccess`, `keyAccess` e `webhookAccess`.
- `utilities` não conferem: auditoria, resumo, leitura sem checagem
  (`findMembership`, `findCompany`, `projectGrant`) e gates de ambiente
  (`environmentServed`).

`access-helpers.test.ts` reprova uma função nova de um `*Access.ts` sem
classificação. `wrappers` são funções fora dos `*Access.ts` que conferem antes
de ler, como `documentAccess` e `issuanceAccess`. Ao lintar o módulo de um
wrapper, a regra confere que ele chama uma checagem antes de tocar em dado.

### Delegação

Uma action que chama `ctx.runQuery`, `ctx.runMutation` ou `ctx.runAction` com
`internal.<módulo>.<fn>` confere o acesso quando `fn` confere antes de tocar em
dado:

- `fn` do mesmo arquivo: a regra lê o handler ali mesmo;
- `fn` de outro módulo: precisa estar em `delegates` de `access-helpers.mjs`.
  Ao lintar o módulo de `fn`, a regra confere que o handler chama uma checagem
  antes do primeiro toque em dado e reprova a entrada que não existe. Tirar o
  helper do destino, ou movê-lo para um ramo, reprova ali.

Uma interna de outro módulo fora de `delegates` é toque em dado.

### Exceções

Uma função pública que não passa pela checagem leva, logo acima do export:

```ts
// freecorps-access: <categoria> — <motivo com 10+ caracteres>
```

| Categoria    | Quando usar                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `sem-tenant` | Lê só a sessão ou a conta de quem chama, sem dado de organização (`account:profile`, `/health`) |
| `ticket`     | Rota HTTP autorizada por um ticket emitido depois da checagem (downloads, upload)               |
| `assinatura` | Webhook recebido, autenticado pela assinatura do remetente antes de qualquer efeito             |

Categoria desconhecida ou motivo curto reprova. Um marcador numa função que
já confere o acesso também reprova, para que a lista de exceções não envelheça.

Limites: a regra lê um arquivo por vez; o que atravessa arquivos passa pelas
listas de `access-helpers.mjs`, conferidas no módulo de cada função. Ela não
correlaciona condições: duas checagens sob `if (a)` e `if (!a)` separados não
somam. O encadeamento opcional (`a?.b(check(ctx))`) não conta como ramo. Um `return` antecipado sem checagem não é conferido, nem o que ele
devolve de um `ctx.db.get` anterior. O teste de cada domínio e
`platform/convex/publicSurface.test.ts` continuam provando o comportamento.

## no-wall-clock-in-tests

Teste não depende do relógio real. Num arquivo de teste sem
`vi.useFakeTimers`, `vi.setSystemTime` ou `usePlatformEnvironment`, reprovam:

- `Date.now()`, `performance.now()` e `new Date()` sem argumento;
- `setTimeout` e `setInterval` globais ou de `node:timers/promises`.

Em qualquer arquivo de teste, reprova o loop de polling: `while`, `do`, `for`,
`for…of` ou `for…in` com `await` de uma espera (`sleep`, `delay`, timer ou
`new Promise((r) => setTimeout(r, n))`) dentro.

| Em vez de                              | Use                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Fixture relativa a `Date.now()`        | `vi.setSystemTime(<instante fixo>)` e `afterAll(() => vi.useRealTimers())` |
| Espera por tempo                       | `vi.useFakeTimers()` e `vi.advanceTimersByTime(...)`                       |
| Loop que espera um arquivo ou processo | `await vi.waitFor(() => expect(...), { timeout, interval })`               |
| Ceder a vez à fila de macrotasks       | `setImmediate` de `node:timers/promises`, que não depende do relógio       |
| Valor único                            | `randomUUID()`                                                             |

Sem timers falsos ligados, `vi.setSystemTime` fixa só o `Date` e mantém os
timers reais de React e do convex-test. Escolha um instante longe de virada de
dia e de mês, como `2026-06-15T15:00:00Z` (meio-dia em São Paulo).

A detecção de timers falsos é por arquivo. `*.benchmark.test.ts` mede tempo de
propósito e fica de fora. Um teste que mede tempo real inerente, como o
encerramento de um processo bloqueado, desliga a regra na linha com motivo.

## require-suppression-reason

Toda supressão diz por quê:

- `eslint-disable`, `eslint-disable-line`, `eslint-disable-next-line` e as
  variantes `oxlint-disable*` (o oxlint respeita as duas) terminam em
  `-- <motivo>`, com pelo menos 10 caracteres;
- `it`, `test`, `describe` ou `suite` com `.skip` ou `.todo` têm, logo acima,
  `// quarantine: #<issue> <motivo>`, com o número da issue que acompanha a
  quarentena.

`skipIf` e `runIf` ficam de fora: a condição já diz quando o teste não roda.
`worker-configuration.d.ts`, gerado pelo wrangler com `/* eslint-disable */`,
tem a regra desligada em `vite.config.ts`.

## Ciclo de imports no backend

Além do plugin `freecorps`, `vite.config.ts` liga a regra nativa
`import/no-cycle` em `platform/convex/`. Ela reprova um ciclo de imports de
valor entre módulos do backend; `import type` some na compilação e não conta.
Num ciclo, a ordem de carga decide se um módulo lê o export do outro já
inicializado ou `undefined`. O plugin `import` fica em `lint.plugins`, ao lado
dos quatro padrão do Oxlint, porque só ali ele monta o grafo de módulos: ligado
só no override, a regra não dispara. As duas regras que o plugin liga por
padrão, `import/default` e `import/namespace`, repetem o typecheck e ficam
desligadas em `lint.rules`.

`ignoreTypes` também ignora `import { type X } from`, que com
`verbatimModuleSyntax` ainda carrega o módulo. Por isso o mesmo override liga
`typescript/no-import-type-side-effects`: quando todos os nomes importados são
tipos, o import se escreve `import type`.

Para quebrar um ciclo, mova a função que puxa a dependência de volta para um
módulo do domínio que importa os dois lados. `createCompany` saiu de
`lib/companyAccess.ts` para `lib/companyCore.ts` por esse motivo: o consumo de
cota em `lib/planCore.ts` chegava de volta aos helpers de acesso (#112).

## Adicionar uma regra

1. Crie `tooling/oxlint-plugin-freecorps/rules/<regra>.mjs` com `defineRule`
   de `vite-plus/lint/plugins` e `docs.url` apontando para a seção dela aqui.
2. Escreva `<regra>.test.ts` ao lado, com o `RuleTester` de
   `vite-plus/lint/plugins-dev`, casos válidos e inválidos.
3. Registre a regra em `index.mjs` e ligue-a em `vite.config.ts`, com
   `overrides` quando o escopo não for o repositório inteiro.
4. Rode `vp lint` no repositório inteiro antes de corrigir o código: se a regra
   gera falsos positivos, ajuste a regra.
5. Documente a regra aqui e troque a prosa correspondente do AGENTS.md pelo
   nome dela.
