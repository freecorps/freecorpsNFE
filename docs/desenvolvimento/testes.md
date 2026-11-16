# Testes

Guia de quem escreve ou revisa um teste: o que testar, em que camada, como
provar uma correção e como esperar trabalho assíncrono. Comandos, projetos do
Vitest, cache e isolamento entre arquivos estão em [ci.md](ci.md#testes); as
regras do lint, em [lint.md](lint.md); os checks mínimos por camada e o
registro da evidência na PR, na skill
[test-and-verify](../../.agents/skills/test-and-verify/SKILL.md).

## O que testar

Um teste afirma algo que o chamador observa: resposta, erro com código,
estado persistido, arquivo, e-mail ou webhook simulado. O critério completo
está em
[principle-test-behavior-not-implementation](../../.agents/skills/principle-test-behavior-not-implementation/SKILL.md).

- **O caminho alterado e o caso negado.** Mudança de acesso testa o papel
  insuficiente, o login sem membership, a chave sem escopo ou sem concessão e
  o dado de outra organização, projeto ou empresa.
- **O efeito proibido ao lado do permitido.** "Sem permissão não cria
  operação" só prova algo junto de "com permissão cria", que mostra que o
  teste enxerga a operação.
- **Repetição, retry e timeout.** Operação que pode ser reenviada testa a
  duplicidade (mesma identidade devolvida, nada novo persistido), o retry e o
  timeout. A lista completa está em "Cubra todos os caminhos" do
  [AGENTS.md](../../AGENTS.md#cubra-todos-os-caminhos).
- **O valor esperado vem do requisito.** Use uma entrada concreta e escreva o
  resultado à mão. Um esperado calculado pelo próprio código testado esconde o
  defeito. Valor fiscal se compara como texto decimal (`"10.00"`), nunca como
  número.

## O que não testar

- **Código gerado.** `platform/convex/_generated/` sai do Convex;
  `docs/v1.0/openapi.json` e `docs/v1.0/API-REFERENCE.md` saem de
  `bun run contracts:generate`, e `bun run contracts:check` confere que estão
  atualizados.
- **A biblioteca sem regra nossa.** Convex, React, Better Auth e o Vitest já
  têm testes; teste a regra que o projeto põe por cima deles.
- **A implementação.** Ordem de chamadas a helpers internos e mocks que só
  devolvem o que o teste afirma prendem o teste ao código, não ao contrato.
  O payload enviado a um serviço externo pode ser o contrato, e então se
  afirma.
- **A aparência por classe CSS.** Teste de componente afirma texto, papel
  acessível e estado; cor, espaço e layout se provam por captura e
  [ui-review](../../.agents/skills/ui-review/SKILL.md).
- **Snapshot.** Não use `toMatchSnapshot`; afirme os valores que importam.

Mudança sem comportamento novo, como renomear, mover ou documentar, não pede
teste novo, e os testes existentes continuam passando.

## Estender antes de adicionar

Antes de criar arquivo, helper ou fixture, procure o que já existe:

| Precisa de                                    | Onde já existe                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Testar um módulo                              | O `<módulo>.test.ts` ao lado dele, onde entra um `it` novo                                                                                                                                 |
| Banco, ambiente, pessoas, concessões e chaves | `tests/helpers/platform.ts`: `platformTest`, `usePlatformEnvironment`, `signedIn`, `membership`, `person`, `companyGrant`, `projectGrant`, `issuerScope`, `syntheticApiKey`, `capturePlan` |
| Caso de borda de regra compartilhada          | `tests/helpers/ruleCases.ts`, cuja tabela roda contra a regra, a normalização do servidor e o formulário do console                                                                        |
| XML de NF-e                                   | O corpus de `tests/fixtures/nfe/4.00/manifest.json`, por `tests/helpers/nfe-corpus.ts`                                                                                                     |
| XML de NFS-e ABRASF                           | `nfseXml` e `legacyNfseImport` de `tests/helpers/nfse.ts`                                                                                                                                  |
| Certificado A1                                | `syntheticCertificate` e afins de `tests/helpers/certificates.ts`, gerados em memória                                                                                                      |
| Acesso de função pública ou rota nova         | `platform/convex/publicSurface.test.ts` e `httpSurface.test.ts` já alcançam o que é novo; o que exigem está em [ci.md](ci.md#rodar-e-escrever-testes)                                      |

Crie arquivo de teste só para um módulo novo, ao lado dele. Um caminho que
nenhum padrão de projeto alcança reprova o CI
([ci.md](ci.md#rodar-e-escrever-testes)). Um helper vai para `tests/helpers/`
quando mais de um arquivo precisa dele; o que serve a um arquivo fica nele.

## Testar na camada mais baixa que falha na `main`

Escreva o teste na camada mais baixa em que o defeito aparece, e confira que
ele falha na `main`. Se o teste passa na `main`, ou ele não reproduz o
defeito, ou o defeito está numa camada acima.

| Camada                 | Onde                                                                   | O que ela vê                                                             |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Função pura            | `packages/*/` e os núcleos de `platform/convex/lib/`                   | Regra, cálculo, parsing, validação e assinatura, sem banco               |
| Integração Convex      | `platform/convex/<módulo>.test.ts`, com `convex-test`                  | Acesso, persistência, idempotência, agendamento e rotas HTTP (`t.fetch`) |
| Componente do console  | `apps/console/src/**/*.test.ts(x)`, jsdom por arquivo, Testing Library | Estado da tela, formulário e navegação, com dados simulados              |
| Componente no Chromium | `apps/console/src/**/*.browser.test.tsx`, modo browser do Vitest       | Foco, layout, CSS e eventos reais, com router e cache de consultas reais |
| Jornada no navegador   | `apps/console/e2e/`, com Playwright e Convex local                     | Console e backend juntos, acessibilidade e largura                       |
| Comando e CI           | `scripts/<domínio>/*.test.ts` e `tooling/`                             | Saída, código de saída e arquivos de um comando                          |

A jornada no navegador exige Convex local e a trava do navegador
([navegador.md](navegador.md)); use-a para o que as camadas de baixo não
enxergam. Um teste de camada alta não substitui as provas especializadas de
parsing, assinatura XML, precisão decimal, isolamento e transições fiscais.

## jsdom ou navegador

Um teste de componente do console roda em jsdom, salvo quando o que ele afirma
só existe num navegador. jsdom não calcula layout nem aplica CSS, e não tira o
foco de um elemento que fica desabilitado ou escondido. Vai para o navegador o
teste que afirma:

- para onde o foco vai, ou que ele fica onde a pessoa o deixou;
- o que está visível, escondido ou fora da área de clique;
- a interação que depende do evento real: arquivo escolhido, teclado, clique
  num controle estilizado;
- o endereço que a navegação deixa, com o router de verdade.

O resto (texto, papel acessível, estado da tela, a chamada que um botão faz)
fica em jsdom, que começa mais rápido e não precisa do Chromium. Os testes em
jsdom continuam; o navegador não é a camada padrão.

O teste de navegador fica em `<módulo>.browser.test.tsx`, ao lado do
`<módulo>.test.tsx`, no projeto `console-browser`: o Vitest roda cada arquivo
numa página do Chromium headless, pelo Playwright. Na primeira vez em cada
máquina, instale o Chromium que o `playwright` travado espera:

```sh
vp exec playwright install chromium
vp run test:console-browser
```

O teste monta a tela por `render` de `apps/console/test/render.tsx`, sempre com
`await using` (prova: `freecorps/require-disposable-render`):

```tsx
const convex = new FakeConvex();
convex.answer(api.captureRelease.status, release("none"));
await using screen = await render(<Captures org={org} companyId={id} />, { convex });
await screen.getByRole("button", { name: "Ativar captura fiscal" }).click();
convex.answer(api.captureRelease.status, release("released"));
await expect.element(screen.getByRole("button", { name: "Iniciar captura fiscal" })).toHaveFocus();
```

- **Desmonta ao fim do bloco.** Mesmo quando uma asserção falha, a tela sai da
  página antes do teste seguinte. Para montar de novo no mesmo teste, feche a
  primeira num bloco `{ }`.
- **Router de verdade.** A tela fica sob o TanStack Router numa história em
  memória (`path` dá o endereço inicial); `screen.router.state.location` diz
  para onde ela navegou.
- **Convex simulado, cache real.** `FakeConvex` faz o papel do
  `ConvexReactClient`: uma consulta sem resposta fica carregando, `answer`
  responde pela assinatura (com `match`, só aos argumentos que têm aqueles
  valores), e cada mutation e action fica em `convex.calls`, respondida por
  `handle`. O cache de consultas do console roda de verdade por cima dele, sem
  `vi.mock` de `convex/react` nem do router.
- **Estilos do console.** Os CSS de `src/main.tsx` entram na página; só as
  fontes ficam de fora.
- **Espere pela tela.** Depois da montagem, cliques e respostas chegam como
  chegariam à pessoa: afirme com `expect.element(...)`, que tenta de novo até
  o limite, ou `expect.poll` para um valor fora da tela.

Os três primeiros, um por arquivo de fluxo (`captures-production`,
`console-shell` e `imports-review`), saíram de jsdom na #146. Medidos no
Windows, cada um leva de 0,14 a 0,46 s no Chromium, contra 0,15 a 0,20 s em
jsdom, e a área inteira roda em cerca de 4 s, com o Chromium aberto uma vez:
o clique real espera o elemento ficar visível e estável.

## Provar uma correção

### Lógica e dados

1. Escreva o teste antes da correção e rode-o. Ele falha pelo defeito
   (o valor errado, o efeito a mais), não por erro de import ou de setup.
2. Aplique a correção e rode o mesmo teste. Ele passa.
3. Registre as duas execuções no bloco de verificação da PR.

Para repetir a execução vermelha depois, faça o commit do teste antes do
commit da correção. Com a árvore limpa:

```bash
git switch --detach <sha do commit do teste>
vp test run <arquivo de teste>
git switch -
```

Quando a reprodução não é viável, como numa corrida entre processos ou num
defeito que só o ambiente hospedado mostra, registre-a como **Inconclusiva**
no bloco de verificação, com o motivo.

### Visual

Capture a tela na `origin/main` e na branch, com os mesmos dados sintéticos,
na matriz de temas e larguras do passo 2 da
[ui-review](../../.agents/skills/ui-review/SKILL.md). As capturas vão para
`.ci-results/<assunto>/` e para a PR, com a conclusão escrita no texto.
Evidência versionada segue [EVIDENCE-STORAGE.md](../v1.0/EVIDENCE-STORAGE.md).

## Esperar trabalho assíncrono

Teste não dorme nem escreve laço de polling.
`freecorps/no-wall-clock-in-tests` reprova relógio real num arquivo sem
relógio falso e laço com espera em qualquer teste; o relógio fixo e as
substituições estão em [lint.md](lint.md#no-wall-clock-in-tests). Espere pelo
evento, não pelo tempo:

| Para esperar                                   | Use                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agendamentos e filas do Convex até esvaziarem  | `await t.finishAllScheduledFunctions(vi.runAllTimers)`, que executa todos, até os de prazo longo                                                             |
| Só os agendamentos que vencem agora            | `vi.advanceTimersByTime(0)` e `await t.finishInProgressScheduledFunctions()`, repetidos para as continuações, como `settleNow` em `tests/helpers/closure.ts` |
| Um prazo                                       | `vi.advanceTimersByTime(<ms>)` até o prazo vencer, e depois `finishInProgressScheduledFunctions()`                                                           |
| Uma promise que o teste controla               | Uma promise adiada resolvida dentro de `act` (`apps/console/src/async-action.test.tsx`)                                                                      |
| Um efeito de outra tarefa, arquivo ou processo | `await vi.waitFor(() => expect(...), { timeout, interval })`                                                                                                 |
| A tela, num teste de navegador                 | `await expect.element(<locator>)...` e `await expect.poll(() => <valor>)...`, que tentam de novo até o limite ([jsdom ou navegador](#jsdom-ou-navegador))    |
| A fila de macrotasks                           | `setImmediate` de `node:timers/promises`                                                                                                                     |

`platform/test-setup.ts` liga timers falsos para o `setTimeout` que o
`convex-test` usa nos agendamentos. Com eles:

- `vi.setSystemTime` muda o que `Date.now()` devolve, mas desloca junto os
  timers pendentes, e nenhum agendamento vence por isso; quem faz um prazo
  vencer é `vi.advanceTimersByTime`;
- os timers falsos encurtam para 1 ms todo atraso acima de 2^31 ms (cerca de
  24 dias). Um avanço de 1 ms dispara um prazo de 30 dias, e o handler roda
  em "agora + 1 ms", não no instante do prazo. Para manter um prazo longo
  pendente, avance 0 ms, como `settleNow`.

## Convenções de `convex-test`

- **Um banco por teste.** Cada `it` chama `platformTest()`, que cria um banco
  em memória com o schema, os módulos e os componentes registrados. Fixtures
  do arquivo recebem o `t` e não guardam estado entre testes.
- **Ambiente no topo do arquivo.** `usePlatformEnvironment({ siteUrl,
  convexSiteUrl, secret, now })` aplica o ambiente sandbox local
  (`FISCAL_ENV=disabled`, crons e webhooks desligados, e-mail local), liga os
  timers falsos e desfaz tudo depois de cada teste. Variável específica do
  teste usa `vi.stubEnv`.
- **Atores reais.** `signedIn(t)` cria usuário e sessão no Better Auth e
  devolve `{ user, session, client }`, com `client` autenticado e sem
  membership; as opções fixam nome, e-mail, e-mail não verificado e
  vencimento da sessão. `membership(t, organizationId, user, role)` dá a esse
  usuário a membership ativa. `person(t, organizationId, role, { companyId })`
  junta os dois e devolve o cliente `t.withIdentity`. Sem `companyId`, papéis
  abaixo de admin não alcançam empresa. Concessões e chaves vêm de
  `companyGrant`, `projectGrant` e `syntheticApiKey`, em vez de uma
  identidade ou um registro de acesso montado à mão.
- **Monte o estado, aja como o chamador.** `t.run((ctx) => ctx.db.insert(...))`
  monta o que não está sob teste. A ação testada passa pela função ou rota
  que o chamador real usa (`query`, `mutation`, `action` ou `t.fetch`), e a
  asserção confere a resposta e o estado lido de volta com `t.run`.
- **Transporte injetado, não módulo mocado.** Fisco, e-mail e webhooks ficam
  simulados por transporte injetado ou `vi.spyOn`. Um `vi.mock` deixa o
  arquivo mais lento ([ci.md](ci.md#isolamento)), e `tests/setup/offline.ts`
  reprova rede sem mock (`tests/setup/browser-offline.ts`, nos testes de
  navegador).
- **Dados sintéticos.** `SYNTHETIC_ISSUER_CNPJ`, e-mails em
  `@development.invalid` e certificados gerados em memória. Nenhum CNPJ,
  chave de acesso, XML ou valor real.

## A prova de cada área

Os comandos mínimos de cada camada estão no passo 2 de
[test-and-verify](../../.agents/skills/test-and-verify/SKILL.md). Esta tabela
diz o que conta como prova em cada área:

| Área     | O teste prova                                                                                                  | O que só outra prova mostra                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform | A função ou rota chamada por um ator real, com o caso negado, o isolamento e o estado persistido               | Tipos do deploy (`bun run platform:check`) e contrato REST gerado (`bun run contracts:check`)                                                |
| Packages | A regra pura com entrada concreta, inclusive o corpus de NF-e e a DPS NFS-e                                    | O pacote empacotado num consumidor limpo (`bun run xml:prove`, `bun run sdk:prove`) e o SDK contra a versão publicada (`bun run sdk:compat`) |
| Console  | O estado da tela, o formulário e a navegação com dados simulados                                               | A integração com o backend na jornada de `apps/console/e2e/`, o build (`bun run build`) e, se muda o visual, capturas e ui-review            |
| Tooling  | A saída, o código de saída e os arquivos do comando; quando escreve arquivos, num diretório temporário próprio | O efeito no GitHub, no Convex ou na Cloudflare, no run do workflow ou no [recibo](ci.md#roteiros-de-prova-com-recibo)                        |

Transporte simulado prova o comportamento local, não a autorização do fisco.
