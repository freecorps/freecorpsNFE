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

| Precisa de                                    | Onde já existe                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testar um módulo                              | O `<módulo>.test.ts` ao lado dele, onde entra um `it` novo                                                                                                       |
| Banco, ambiente, pessoas, concessões e chaves | `tests/helpers/platform.ts`: `platformTest`, `usePlatformEnvironment`, `person`, `companyGrant`, `projectGrant`, `issuerScope`, `syntheticApiKey`, `capturePlan` |
| Caso de borda de regra compartilhada          | `tests/helpers/ruleCases.ts`, cuja tabela roda contra a regra, a normalização do servidor e o formulário do console                                              |
| XML de NF-e                                   | O corpus de `tests/fixtures/nfe/4.00/manifest.json`, por `tests/helpers/nfe-corpus.ts`                                                                           |
| XML de NFS-e ABRASF                           | `nfseXml` e `legacyNfseImport` de `tests/helpers/nfse.ts`                                                                                                        |
| Certificado A1                                | `syntheticCertificate` e afins de `tests/helpers/certificates.ts`, gerados em memória                                                                            |
| Acesso de função pública ou rota nova         | `platform/convex/publicSurface.test.ts` e `httpSurface.test.ts` já alcançam o que é novo; o que exigem está em [ci.md](ci.md#rodar-e-escrever-testes)            |

Crie arquivo de teste só para um módulo novo, ao lado dele. Um caminho que
nenhum padrão de projeto alcança reprova o CI
([ci.md](ci.md#rodar-e-escrever-testes)). Um helper vai para `tests/helpers/`
quando mais de um arquivo precisa dele; o que serve a um arquivo fica nele.

## Testar na camada mais baixa que falha na `main`

Escreva o teste na camada mais baixa em que o defeito aparece, e confira que
ele falha na `main`. Se o teste passa na `main`, ou ele não reproduz o
defeito, ou o defeito está numa camada acima.

| Camada                | Onde                                                                   | O que ela vê                                                             |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Função pura           | `packages/*/` e os núcleos de `platform/convex/lib/`                   | Regra, cálculo, parsing, validação e assinatura, sem banco               |
| Integração Convex     | `platform/convex/<módulo>.test.ts`, com `convex-test`                  | Acesso, persistência, idempotência, agendamento e rotas HTTP (`t.fetch`) |
| Componente do console | `apps/console/src/**/*.test.ts(x)`, jsdom por arquivo, Testing Library | Estado da tela, formulário e navegação, com dados simulados              |
| Jornada no navegador  | `apps/console/e2e/`, com Playwright e Convex local                     | Console e backend juntos, acessibilidade e largura                       |
| Comando e CI          | `scripts/<domínio>/*.test.ts` e `tooling/`                             | Saída, código de saída e arquivos de um comando                          |

A jornada no navegador exige Convex local e a trava do navegador
([navegador.md](navegador.md)); use-a para o que as camadas de baixo não
enxergam. Um teste de camada alta não substitui as provas especializadas de
parsing, assinatura XML, precisão decimal, isolamento e transições fiscais.

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
- **Atores reais.** `person(t, organizationId, role, { companyId })` cria
  usuário e sessão no Better Auth e a membership da organização, e devolve um
  cliente `t.withIdentity`. Sem `companyId`, papéis abaixo de admin não
  alcançam empresa. Concessões e chaves vêm de `companyGrant`, `projectGrant`
  e `syntheticApiKey`, em vez de uma identidade ou um registro de acesso
  montado à mão.
- **Monte o estado, aja como o chamador.** `t.run((ctx) => ctx.db.insert(...))`
  monta o que não está sob teste. A ação testada passa pela função ou rota
  que o chamador real usa (`query`, `mutation`, `action` ou `t.fetch`), e a
  asserção confere a resposta e o estado lido de volta com `t.run`.
- **Transporte injetado, não módulo mocado.** Fisco, e-mail e webhooks ficam
  simulados por transporte injetado ou `vi.spyOn`. Um `vi.mock` deixa o
  arquivo mais lento ([ci.md](ci.md#isolamento)), e `tests/setup/offline.ts`
  reprova rede sem mock.
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
