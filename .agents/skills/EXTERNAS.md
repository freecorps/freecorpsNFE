# Origem e uso das skills importadas

O catálogo reúne cópias de outro projeto do mantenedor (o projeto de origem) e importações adaptadas de Matt Pocock,
T3 Code e pstack, incluindo referências, templates, scripts e metadados
pertinentes. As instruções
deste projeto e o escopo autorizado pelo usuário prevalecem sobre os exemplos e
convenções dos projetos de origem.

## Procedência

O `skills-lock.json` na raiz preserva os 46 registros de origem disponíveis no
lock do projeto de origem. Outras 20 skills vieram de instalações locais
documentadas no inventário `.agents/skills/EXTERNAS.md` daquele projeto:

| Procedência registrada | Skills |
| --- | --- |
| `cursor/plugins`, `pstack/skills/`, commit `fd6dd6f`, MIT de Lauren Tan | `arena`, `blast-radius`, `how`, `why`, `show-me-your-work`, `unslop` e as quatro `principle-*`. |
| `mattpocock/skills`, commit `885e2ca`, MIT de Matt Pocock | `diagnosing-bugs`, `domain-modeling`, `grill-me`, `grilling`, `triage`, `wait-what`, `wizard`, `writing-for-agents`. |
| Mantidas no projeto de origem | `file-pr`, adicionada no commit `247150b`, e `babysit-pr`, adicionada no commit `eb60b46`. |

Esses commits identificam a procedência registrada no projeto de origem. A cópia traz a
versão local atual, incluindo os ajustes que o projeto de origem fez posteriormente.
As duas licenças MIT acompanham as skills em [licencas/](licencas/).

### Importação direta de Matt Pocock em 06/10/2026

Cinco skills foram adaptadas de
[`mattpocock/skills`, commit `6fd947921b935b7e1e69293a200400f0fdd5c15f`](https://github.com/mattpocock/skills/tree/6fd947921b935b7e1e69293a200400f0fdd5c15f/skills/engineering).
A licença MIT de Matt Pocock já consta em
[licencas/mattpocock-skills-LICENSE](licencas/mattpocock-skills-LICENSE).
As adaptações são locais; não são cópias idênticas à origem:

| Skill ou conteúdo | Adaptação |
| --- | --- |
| `retro` | Retrospectiva com evidência e propostas; mudanças no ambiente seguem o pedido. Reutiliza documentação e verificadores existentes. |
| `code-review` | Dois eixos independentes, incluindo alterações sem commit. Usa pedido e documentos locais, com delegação apenas quando disponível e permitida. |
| `codebase-design` | Vocabulário em pt-BR, padrões Convex preservados e refatoração limitada ao problema. Mantém provas fiscais especializadas ao mudar interfaces. Inclui `DEEPENING.md` e `DESIGN-IT-TWICE.md` adaptados. |
| `to-spec` | Síntese proporcional ao pedido; interfaces já acordadas dispensam reconfirmação. Usa o fluxo local de arquivos e publicação abaixo. |
| `to-tickets` | Entregas verificáveis e dependências explícitas; sem reconfirmar divisão já autorizada ou alterar automaticamente a issue pai. |
| Conteúdo de `pr` em `file-pr` | Representação visual opcional, evidência e impacto do merge, preservando a abertura pelo problema e o pt-BR. Créditos em [file-pr/CREDITS.md](file-pr/CREDITS.md). Não adiciona uma skill `pr`. |

Para o conteúdo incorporado ao `file-pr`, os arquivos de origem são
[pr/SKILL.md](https://github.com/mattpocock/skills/blob/6fd947921b935b7e1e69293a200400f0fdd5c15f/skills/engineering/pr/SKILL.md)
e [pr/CREDITS.md](https://github.com/mattpocock/skills/blob/6fd947921b935b7e1e69293a200400f0fdd5c15f/skills/engineering/pr/CREDITS.md).

Nessa etapa, o catálogo passou a 71 skills, das quais 25 têm procedência
registrada neste documento em vez de entradas no lock original. O `skills-lock.json` não foi
alterado: não há hashes de instalador para estas adaptações manuais. As oito
skills de Matt que vieram do projeto de origem permanecem na versão local anterior.

Os metadados de invocação foram preservados: `retro`, `to-spec` e `to-tickets`
continuam explícitas; `code-review` e `codebase-design` admitem seleção pelo
agente. Os títulos e descrições de interface foram traduzidos para pt-BR.

### Créditos

O projeto de origem é do mantenedor, e as skills vieram dele por cópia; em
20/10/2026 o mantenedor decidiu que basta creditar os autores. O catálogo tem
100 skills. Os textos de licença de cada origem estão em [licencas/](licencas/).

| Autor | Origem | Skills | Licença |
| --- | --- | --- | --- |
| Matt Pocock | `mattpocock/skills` | 13 | MIT |
| Lauren Tan (poteto) | `cursor/plugins`, `pstack/` | 18; também contribui com trechos em `diagnosing-bugs` e `performance-analysis` | MIT |
| Cursor | `cursor/plugins`, `cli-for-agent/`, `cursor-team-kit/` e `thermos/` | 1, `cli-for-agents`, e trechos em `code-review`, `blast-radius`, `principle-prove-it-works` e `file-pr` | MIT |
| Emil Kowalski | `emilkowalski/skills` | 14 | MIT |
| Leonxlnx | `Leonxlnx/taste-skill` | 13 | MIT |
| Convex | `convex/agent-skills` | 34 | Apache-2.0, com ícones Heroicons (MIT, Tailwind Labs) |
| Vercel | `vercel-labs/agent-skills` | 1, `vercel-react-best-practices` | MIT, declarada no README e no `SKILL.md`; texto em [vercel-agent-skills-LICENSE](licencas/vercel-agent-skills-LICENSE) |
| T3 Tools (Theo) | `pingdotgg/t3code` | Adaptações em `triage`, `babysit-pr` e `file-pr` | MIT |
| Effectful Technologies | `effect-smol`, pela cópia do T3 Code | 3, `dependency-maintenance`, `ci-maintenance` e `performance-analysis` | MIT |
| Freecorps | Projeto de origem | 2, `file-pr` e `babysit-pr` | Do mantenedor |
| Freecorps | `freecorps/brigade` | 1, `manager` | AGPL-3.0 |

### Licença da skill da Vercel

A origem [`vercel-labs/agent-skills`, commit `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62)
declara MIT na seção "License" do `README.md` e em `license: MIT` no
`SKILL.md` de `skills/react-best-practices`, mas não tem arquivo `LICENSE` nem
linha de copyright. O `SKILL.md` e o `metadata.json` locais são iguais aos dessa
revisão. O texto em
[vercel-agent-skills-LICENSE](licencas/vercel-agent-skills-LICENSE) é o MIT
padrão, com o titular tirado de `metadata.author: vercel` e sem ano, que a
origem não declara. Não é cópia de um arquivo da origem; se a origem publicar
um `LICENSE`, ele substitui este texto.

### Importação do T3 Code em 20/10/2026

Fonte fixada em
[`pingdotgg/t3code`, commit `67c0fc0cdaf963b103518862dd7b68a9c758ecf2`](https://github.com/pingdotgg/t3code/tree/67c0fc0cdaf963b103518862dd7b68a9c758ecf2).
As três skills novas vieram da cópia do Effect em
[`.repos/effect-smol/.agents/skills`](https://github.com/pingdotgg/t3code/tree/67c0fc0cdaf963b103518862dd7b68a9c758ecf2/.repos/effect-smol/.agents/skills).
São adaptações em pt-BR, com seleção automática habilitada, comandos locais
e sem dependência das ferramentas internas do Effect:

| Destino | Fonte e adaptação |
| --- | --- |
| `dependency-maintenance` | `dependency-maintenance/SKILL.md`, `manifest-roles.md` e `coordinated-upgrades.md`. O fluxo coordenado foi resumido no arquivo principal para Bun, Vite+, runtimes e patches daqui; preserva as provas de consumidores e os checks locais. |
| `ci-maintenance` | `ci-maintenance/SKILL.md` e `privileged-workflows.md`. Eventos, permissões e artefatos seguem as regras de publicação, revisão testada e runners do projeto. |
| `performance-analysis` | `performance-analysis/SKILL.md`, `runtime.md` e `types.md`; a orientação de bundle também usa `bundle-analysis/SKILL.md`. Procedimento consolidado para os benchmarks, compiladores e medidor de bundle existentes. |
| `triage` e `babysit-pr` | `.agents/skills/contribution-triage/SKILL.md` do T3: evidência inacessível é diferente de evidência omitida, releitura antes de escrita e reconciliação de respostas ambíguas. Sem importar políticas de fechamento, isenções ou Macroscope. |
| `file-pr` | A mesma `contribution-triage` fornece o critério de um problema por PR, considerando a relação entre mudanças. |
| `code-review` | `changesets/SKILL.md` do Effect fornece a auditoria de compatibilidade semântica. Não adiciona Changesets nem altera o processo de release. |
| `diagnosing-bugs` | Encaminha comparações de desempenho para a nova `performance-analysis`, preservando a investigação existente. |

As licenças MIT originais estão preservadas em
[effect-smol-LICENSE](licencas/effect-smol-LICENSE), de Effectful Technologies
Inc, e [t3code-LICENSE](licencas/t3code-LICENSE), de T3 Tools Inc. As fontes
são os arquivos `LICENSE` dos respectivos diretórios no mesmo commit.
Não há hashes de instalador novos no `skills-lock.json`; esta é uma
adaptação manual com revisão de origem fixada.

O catálogo tinha 87 skills antes desta importação e passou a 90. O
[índice](../README.md) também passa a listar as 16 adições de interface,
movimento e clientes já presentes, sem atribuir sua origem ao T3.

Dois ajustes locais acompanham a importação: `file-pr` documenta as palavras
em inglês para fechamento automático de issues, conforme a
[documentação do GitHub](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue);
`babysit-pr` prefere o acompanhamento por eventos do T3 quando disponível.
As autorizações da sessão e os checks do `AGENTS.md` continuam prevalecendo.

### Importação do pstack em 20/10/2026

Fonte fixada em
[`cursor/plugins`, commit `88d47514b82e7c44f00f2b2a72ff6dd12158038c`, `pstack/skills`](https://github.com/cursor/plugins/tree/88d47514b82e7c44f00f2b2a72ff6dd12158038c/pstack/skills).
A licença MIT de Lauren Tan já está preservada em
[cursor-plugins-pstack-LICENSE](licencas/cursor-plugins-pstack-LICENSE) e
confere com `pstack/LICENSE` nessa revisão.

| Destino | Fonte e adaptação |
| --- | --- |
| `principle-test-behavior-not-implementation` | Skill homônima: resultados, erros e efeitos observáveis; preserva testes especializados, cobertura fiscal e integrações simuladas. Remover testes exige demonstrar cobertura equivalente. |
| `typescript-best-practices` | Skill homônima e `references/patterns.md`: tipos derivados, narrowing e exaustividade, resumidos em um arquivo. Reutiliza tipos gerados pelo Convex, conserva contratos públicos e distingue validação de formato de autorização e estado atual. |
| `technical-writing` | Skill homônima: tutorial, guia de tarefa, referência e explicação, adaptados ao pt-BR e às fontes da documentação pública. Sem limites fixos de palavras ou convenções de formatação do inglês. |
| `performance-analysis` | `benchmark-checklist/SKILL.md`: confirma execução do trabalho medido, erros, efeitos e gargalo, incluindo o gerador de carga, sem importar comandos Linux ou exigir acesso à produção. |
| `diagnosing-bugs` | `principle-attack-the-premise/SKILL.md`: testa a premissa comum quando tentativas de correção sucessivas falham. Não adiciona as dependências de princípios da origem. |
| `show-me-your-work` | Skill homônima: a auditoria corrige entradas acrescentando registros, preservando o histórico, inclusive quando a entrada original estava errada. |
| `unslop` | Skill homônima, regras 32 e 33: combate frases ornamentais e compressão que elimina verbos e artigos. Preserva as regras e a invocação locais. |

As três novas skills são adaptações em pt-BR e admitem seleção pelo agente.
Não copiam `disable-model-invocation` nem o seletor `paths` do Cursor.
Os princípios de tipos pertinentes foram incorporados ao texto, sem exigir
outras skills do pstack, modelos específicos ou mudança de ferramentas.
As quatro skills existentes recebem apenas os trechos descritos acima.

Esta importação eleva o catálogo de 90 para 93. A procedência manual fica
registrada aqui, sem inventar hashes de instalador no `skills-lock.json`.

### Adaptação local do workflow em 21/10/2026

As skills abaixo mantêm a procedência e as licenças registradas acima. Esta
revisão altera as instruções locais e os templates alcançados, sem nova
importação nem mudança no `skills-lock.json`:

| Skill | Adaptação |
| --- | --- |
| `why` | Investigação direta das fontes ligadas à decisão; expansão por lacuna concreta. Roteiros de fontes opcionais, com parada por pergunta respondida ou limite de evidência explicitado. Busca vazia descreve a consulta, sem provar inexistência. |
| `how` | Rastreamento direto da entrada ao efeito, incluindo os caminhos pertinentes à pergunta. Exploração e crítica delegadas são opcionais; preserva conferência das conexões e distinção entre leitura e execução. |
| `code-review` | Mantém os dois eixos e admite duas passagens diretas mesmo quando há ferramentas de delegação. Delegar depende de valor para a revisão e das instruções da sessão. |
| `file-pr` | Usa contexto, template e convenções documentadas antes de buscar exemplos. Perguntas ficam restritas a decisões materiais ainda abertas; autorização prévia continua válida. |

`why`, `how` e seus templates deixam de exigir modelos nominais, ferramentas
do Cursor, mudança de permissões ou agentes separados para explicar e
sintetizar. Consulta em leitura e preparação de texto dispensam setup.
Evidência, contradições, rastreamento do fluxo e limites de verificação
continuam obrigatórios conforme a pergunta; quantidade de buscas ou agentes
não é critério de qualidade. Os exemplos de provedores nos roteiros de fontes
continuam como referência opcional, sem indicar serviços instalados aqui.

### Importação do Brigade em 26/10/2026

Fonte fixada em
[`freecorps/brigade`, commit `28d25f7e4eada891c9be9a3cbe7227ea6c54ac86`, `.agents/skills/manager/SKILL.md`](https://github.com/freecorps/brigade/blob/28d25f7e4eada891c9be9a3cbe7227ea6c54ac86/.agents/skills/manager/SKILL.md),
escrita na Freecorps no commit `9bcb05f`. O Brigade é um repositório
público da Freecorps sob AGPL-3.0. A decisão de 20/10/2026 sobre o projeto de origem
não cobre o Brigade, e não há outra registrada; por isso a cópia preserva o
texto da licença da origem, nessa revisão, em
[brigade-LICENSE](licencas/brigade-LICENSE).

| Destino | Adaptação |
| --- | --- |
| `manager` | Mantém o ciclo da origem: fatiar, delegar, revisão independente, verificação própria, PR, acompanhamento e merge pelo gerente. As RFCs do Brigade dão lugar ao `AGENTS.md`, aos ADRs e aos contratos; a revisão confere as garantias do `AGENTS.md`, arquivos gerados e dados reais. Comandos, checks do CI (`Validate`), worktrees e o aviso de que o merge publica seguem este projeto. A barra de UI usa `DESIGN.md`, pt-BR, estados honestos e ambientes distintos, sem o app mobile da origem. Perguntas ao dev cobrem Convex fora do worktree, produção fiscal e credenciais. Sem `before-and-after`, que não existe aqui. |

A skill segue em inglês, como `file-pr` e `babysit-pr`, e admite seleção pelo
agente. PRs, issues e relatórios que ela produz continuam em pt-BR. Sem hashes
de instalador no `skills-lock.json`; o catálogo passa de 93 para 94.

### Importação do Cursor Plugins em 27/10/2026

Fonte fixada em
[`cursor/plugins`, commit `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`](https://github.com/cursor/plugins/tree/c742dd61706fbacc1b95f1a20b7b988cf096ce6c).
As quatro frentes selecionadas correspondem a seis skills novas, em pt-BR,
com seleção automática habilitada. O catálogo passa de 94 para 100. São
adaptações locais, sem hashes de instalador inventados em `skills-lock.json`.

| Destino | Fonte relativa à revisão acima e adaptação |
| --- | --- |
| `create-verification-skill` | `pstack/skills/create-verification-skill/SKILL.md`. Gera roteiro em `.agents/skills/`, usa runners e contratos existentes, distingue console/REST/SDK, exige pré-condições sintéticas e prova de ao menos uma jornada. Não cria seed nem usa produção para suprir falha local. |
| `maintain-verification-skill` | `pstack/skills/maintain-verification-skill/SKILL.md`. Confere fonte e execução de cada jornada do escopo, preserva evidências e separa regressão de desatualização do roteiro. Delegação é opcional; dirigir uma instância compartilhada continua serializado. |
| `principle-make-operations-idempotent` | `pstack/skills/principle-make-operations-idempotent/SKILL.md`. Acrescenta escopos, autorização atual, geração/fence/lease, reconciliação e preservação do histórico. Ausência observada não libera automaticamente retransmissão. |
| `cli-for-agents` | `cli-for-agent/skills/cli-for-agents/SKILL.md`. Usa Bun/Vite+, catálogo de comandos, PowerShell e saídas sem credenciais. Confirmação não contorna gates; timeout da espera não significa cancelamento. |
| `create-formal-verification-skill` | `pstack/skills/create-formal-verification-skill/SKILL.md`. Vincula invariantes ao código, exige prova de capacidade de detectar falha e declara limites. A manutenção da correspondência fica no roteiro gerado, sem depender de outra skill ausente. |
| `statechart` | `pstack/skills/statechart/SKILL.md`. Usa TLC diretamente, trace e Mermaid. Referência local fornece comandos PowerShell e contador sintético; versão e hash do TLC vêm de `pstack/skills/statechart/scripts/run.ts`. Sem importar o motor de geração de gráficos, seus testes/corpus, mise ou Pele. Não promete enumerar todas as violações nem gerar o grafo completo automaticamente. |

Trechos incorporados às skills existentes, sem criar skills homônimas:

| Destino | Fonte relativa à mesma revisão e adaptação |
| --- | --- |
| `code-review` | `cursor-team-kit/skills/deslop/SKILL.md` e `thermos/skills/thermo-nuclear-review/SKILL.md`: ruído do diff, casts, gates, consumidores e pré-condições de desenvolvimento. Preserva os dois eixos, o escopo de revisão e validações de autorização/estado. |
| `blast-radius` | `thermos/skills/thermo-nuclear-review/SKILL.md`: caminhos alternativos a gates e efeitos sobre setup/validação, ligados à mudança e com evidência antes do achado. |
| `principle-prove-it-works` | `cursor-team-kit/skills/verify-this/SKILL.md`: alegação refutável, comparação equivalente e veredictos comprovado/não comprovado/inconclusivo. Baseline só é obrigatório para uma alegação que dependa dele; sem dados reais em artefatos. |
| `file-pr` | `cursor-team-kit/skills/make-pr-easy-to-review/SKILL.md`: ordem de leitura, distinção de mudanças mecânicas e conferência da árvore quando uma reescrita já foi autorizada. Não concede publicação nem reescrita de histórico por inferência. |

A licença MIT de Lauren Tan em
[cursor-plugins-pstack-LICENSE](licencas/cursor-plugins-pstack-LICENSE)
confere com `pstack/LICENSE` nessa revisão. A licença MIT do Cursor,
idêntica em `cli-for-agent/LICENSE`, `cursor-team-kit/LICENSE` e
`thermos/LICENSE`, está preservada em
[cursor-plugins-LICENSE](licencas/cursor-plugins-LICENSE).

Adicionar as skills não cria o roteiro `verify-freecorps`, não verifica as
operações reais por TLA+ e não instala serviços. Esses são trabalhos que as
skills orientam quando solicitados. O contador de `statechart` serve só para
conferir a ferramenta; não comprova nenhuma propriedade fiscal do produto.
O JAR fica fora do repositório e o download exige conferência do SHA-256.

Na validação da importação, os seis metadados passaram no validador de skills,
os links locais e o catálogo foram conferidos, e os 14 testes do verificador
de referências passaram. Não houve referência pendente nas skills alteradas.
A varredura do catálogo inteiro contra os nomes da origem encontrou quatro
falsos positivos preexistentes para `advisor`, em `convex-cost`,
`convex-optimize` e `improve-animations`: são referências ao advisor do Convex
ou ao papel de consultor, não chamadas à skill do Cursor. O verificador não
foi alterado nesta importação.

O roteiro PowerShell de TLC foi executado com Java 25: o contador válido
terminou com três estados distintos e exit code 0; a configuração com a
invariante inválida terminou com exit code 12 e trace de 0 a 2. Isso valida
o roteiro e a detecção de falha sintética, sem executar jornadas do produto
ou criar uma verificação formal do protocolo de operações.

### Skills locais de 04/11/2026

Seis skills escritas neste repositório, sem cópia de texto de outra origem:

| Skill | Invocação | O que faz |
| --- | --- | --- |
| `full-stop` | Agente e dev | Leva uma mudança até a PR verificada e pronta para merge, acompanha revisão e CI e para antes do merge. Subagente delegado devolve URL, head e estado, sem watch. |
| `full-send` | Só o dev | Executa o `full-stop`, aplica o gate de merge do `manager`, mergeia e confere o run de `Deploy production` e o SHA servido. |
| `fiscal-review` | Agente e dev | Lista de regras fiscais do projeto para revisar diffs de XML, valores, identificadores, emissão, captura e guarda. |
| `test-and-verify` | Agente e dev | Escolhe os checks pela camada tocada e registra o bloco de verificação com vereditos de `principle-prove-it-works`. |
| `ui-review` | Agente e dev | Revisa a interface rodando, em temas, larguras e estados, com o padrão visual que antes ficava em `manager`. |
| `council` | Só o dev | Convoca conselheiros independentes por lente do projeto para uma decisão arquitetural cara de reverter. |

`full-send` e `full-stop` têm os nomes de skills que o
[T3 Code](https://github.com/pingdotgg/t3code) cita: o caso
`child-babysit-calls-watch` de `evals/mcp-tool-use/cases/pull-requests.ndjson`,
no commit `8b44f42b14c8e273156474a924ccf29680dd7857`, registra um brief que
pedia "Use the full-stop skill" para levar a PR até ficar pronta sem mergear.
As skills em si não estão no repositório público nem no seu histórico, e o
conteúdo daqui foi escrito do zero a partir dessa descrição, de `manager`,
`babysit-pr` e `file-pr`. Não há licença de terceiros a preservar.

## Adaptações ao freecorpsNFE

- **Arquitetura e domínio:** use `docs/ARQUITETURA.md`, `docs/plataforma/`,
  `docs/v1.0/` e `docs/adr/` como referências existentes. Os exemplos de
  restaurantes e os milestones do projeto de origem não definem o modelo deste serviço
  fiscal.
- **Autenticação:** a plataforma usa Better Auth, membros com papéis por
  organização e API keys de projeto com escopos e concessões de empresa e
  ambiente. O legado usa Clerk com allowlist e API keys com restrições de
  emitente. Reutilize os helpers existentes. As contas ficam no componente
  Better Auth, fora do schema do app; isso não significa que o projeto esteja
  sem autenticação, apesar da suposição de uma tabela `users` na skill
  `convex-authz` importada.
- **Frontend:** o console mantém React, Vite+, TanStack Router e
  `convex/react`, com CSS próprio; o legado usa também TanStack Query e
  Tailwind. Aplique as skills visuais à tarefa solicitada. Exemplos de
  Next.js, SWR, GSAP ou estilos gráficos não são decisões de arquitetura
  deste projeto.
- **Cobrança:** `convex-billing` é referência para integrações com pagamentos e
  webhooks. A cobrança dos produtos consumidores continua nesses produtos;
  instalar a skill não implica adicionar checkout ou Stripe ao serviço fiscal.
- **Ferramentas:** use o shell, os modelos e as ferramentas realmente
  disponíveis na sessão. `Monitor`, `TaskStop`, os slugs de modelos do Cursor
  e as integrações MCP citadas não são dependências instaladas junto das skills.
  A skill `arena` só se aplica quando esse trabalho com múltiplos agentes for
  solicitado ou permitido pelas instruções da sessão.
- **Configuração:** os exemplos de `.env` devem seguir `.env.local` para o
  frontend local, que o setup gera em cada worktree, e as variáveis do
  deployment Convex para o backend.
- **PRs e CI:** use a branch base e as convenções reais do repositório.
  Quando Actions estiver indisponível por limite de uso, registre a validação
  local e o bloqueio do CI. Não trate um job que não iniciou como falha de código
  ou como teste aprovado. Deploy e merge dependem do escopo autorizado.

## Fluxo das skills de engenharia

As skills de engenharia e auditoria usam este mapeamento compartilhado:

- **Fontes:** comece pelo `AGENTS.md` e pelo mapa do `README.md`. Use os
  contratos e ADRs aplicáveis ao componente alterado, distinguindo a plataforma
  atual do legado. O glossário existente do projeto é a referência; não crie
  nem renomeie documentos para satisfazer a convenção `GLOSSARY.md` da origem.
- **Destino local:** reutilize o documento e o caminho indicados pelo dev.
  Sem destino estabelecido, guarde artefatos transitórios em
  `.ci-results/<assunto>/`, com `spec.md`, `issues/<NN>-<slug>.md`,
  `decisions.tsv` ou payloads locais conforme necessário. Escolha um assunto
  que não colida com relatórios do executor; preserve `validation.lock` e os
  demais arquivos gerados por ele. O diretório já é ignorado pelo Git e pela
  descoberta automática do formatter; passar um arquivo explicitamente como
  argumento pode incluí-lo na verificação. Crie apenas os arquivos necessários
  e informe seus caminhos, sem mover nem sobrescrever documentos e trilhas
  existentes. Para promover um artefato a documentação permanente, use um destino versionado adequado
  ao conteúdo, dentro do escopo pedido, sem forçar inclusão do arquivo ignorado.
- **Tracker:** o fluxo externo é o GitHub do repositório, identificado pelo
  remote atual. Publique issues, comentários ou edições apenas quando isso
  fizer parte do pedido. Sem publicação autorizada, entregue os arquivos locais.
  Use o mapeamento de triagem na seção abaixo, sem bootstrap ou labels novos.
  Escreva títulos e corpos em pt-BR, com arquivos UTF-8 e `--body-file` para
  corpos destinados ao GitHub.
- **Autorização:** decisões e permissões já dadas continuam válidas. Não exija
  confirmação a cada interface de teste, divisão em tickets ou etapa interna.
  Esclareça escolhas materiais ainda abertas; produzir uma spec, um relatório
  ou tickets não autoriza implementá-los, fazer commit, push, PR ou deploy.
  Se a ação externa ainda precisar de autorização, termine primeiro o artefato
  local revisável e só então peça a autorização que falta.
- **Ferramentas e dependências:** carregue skills pelos mecanismos disponíveis,
  sem pressupor uma ferramenta chamada `Skill`. Reaproveite os testes e comandos
  do projeto. As importações não dependem de `tdd`, `implement` ou
  `setup-matt-pocock-skills`, nem instalam ferramentas ou alteram configuração
  global. Paralelismo depende das ferramentas e instruções da sessão; uma
  análise em leitura não precisa de novos worktrees.

## Consultas e payloads de ferramentas

Selecione os campos necessários à decisão, como IDs, estado, revisão, caminho
e corpo do feedback, usando os argumentos estruturados da ferramenta ou
`--json`/`--jq` do `gh`. Agrupe leituras independentes e reutilize resultados
enquanto a revisão e o estado relevante permanecerem válidos. Antes de uma
escrita, releia o estado que pode invalidá-la.

Percorra coleções REST com `--paginate`. Em GraphQL, confira `pageInfo`,
`hasNextPage` e `endCursor` de cada conexão pertinente, inclusive as aninhadas,
e continue pelos cursores até completar a leitura. Um filtro de apresentação
não pode eliminar achados ainda não examinados. Leia o corpo integral do
feedback, incluindo `<details>`; resumos e trechos truncados servem apenas
para localizar itens. Erro ou resposta parcial não comprova ausência de dados.

Para GraphQL, serialize a query literal e suas variáveis num arquivo JSON
UTF-8 e use `gh api graphql --input <arquivo>`. No PowerShell, uma here-string
com aspas simples preserva `$variaveis`, aspas e quebras de linha. Exemplo de
uma página de reviews: defina `$payloadPath` como caminho absoluto num
diretório existente, conforme a convenção de destino acima.

```powershell
$query = @'
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $cursor) {
        nodes { id body state author { login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
'@
$payload = @{
  query = $query
  variables = @{ owner = '<owner>'; repo = '<repo>'; number = 123; cursor = $null }
}
$json = $payload | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($payloadPath, $json, [System.Text.UTF8Encoding]::new($false))
gh api graphql --input $payloadPath
```

Para a página seguinte, atribua `endCursor` a `$payload.variables.cursor`, serialize
novamente e repita enquanto `hasNextPage` for verdadeiro. Use o mesmo transporte
JSON UTF-8 para corpos de `gh api --input`; textos de PR, issue e comentário
usam `--body-file`. Passe caminhos e títulos como argumentos literais ou campos
estruturados, sem compor outro comando de shell com o texto.

Quando um comando local continuar executando, aguarde pelo identificador
retornado pela ferramenta. Ajuste o intervalo à duração esperada e mantenha
o dev informado; consultar processos repetidamente não traz a saída da execução.
Para acompanhar PRs por eventos, siga [babysit-pr](babysit-pr/SKILL.md#set-up-the-watch).

## Dependências e referências externas

As dependências entre skills disponíveis no projeto de origem foram trazidas juntas,
incluindo `file-pr` → `babysit-pr`, `grill-me` → `grilling`,
`triage` → `grilling`/`domain-modeling` e os princípios usados por `arena`.
As importações diretas usam `retro` → `writing-for-agents` e
`principle-encode-lessons-in-structure`, `code-review` → `convex-reviewer`
quando aplicável, e `to-spec` → `codebase-design` quando a interface precisar
ser discutida. Todas essas dependências estão no catálogo local.

Referências ausentes são tratadas de forma explícita:

1. O catálogo de `convex` lista `convex-agent` e
   `convex-improve-convex-plugin`. Essas duas skills estão excluídas porque não
   se aplicam ao projeto atual. São descrições do catálogo, não passos
   necessários para as outras skills. O verificador ignora somente essas
   linhas de catálogo; uma chamada em outro trecho continua sendo reportada.
2. `triage` menciona `/setup-matt-pocock-skills`, que também não existe no
   projeto de origem. Use o mapeamento local abaixo, sem instalar esse bootstrap.

A adaptação de `how` em 21/10 removeu a comparação com `interrogate`; seu
procedimento é autônomo. A exceção histórica no verificador não cria uma
dependência dessa skill.

Para triagem, consulte os labels atuais no GitHub. Os labels `bug` e
`enhancement` representam as categorias; `question` sinaliza dúvidas e
`help wanted` sinaliza pedido de ajuda. Os papéis `needs-triage`, `needs-info`,
`ready-for-agent` e `ready-for-human` são descrições do andamento nas notas da
issue ou PR, não labels obrigatórios. `wontfix` existe para decisões de não
implementação. A abertura ou o fechamento continua sendo o estado da issue;
um label sozinho não determina que ela deva ser fechada.

Verifique as referências com:

```powershell
python .agents/skills/check-refs.py <pasta-de-skills-de-origem>
python -B -m unittest discover -s .agents/skills -p 'test_*.py'
```

Para incluir as importações diretas na auditoria, passe também o diretório
`skills` de um checkout do Matt no commit registrado acima como segunda origem.
Os caminhos das origens são argumentos locais; não pressupõem esse layout em
um worktree do editor.

O verificador veio do projeto de origem e foi adaptado para aceitar uma ou mais origens,
contar apenas diretórios com `SKILL.md`, rejeitar origens inválidas e distinguir
as duas descrições de catálogo excluídas de chamadas reais.
Os testes versionados usam árvores temporárias e apenas a biblioteca padrão
do Python; não dependem de uma instalação local do projeto de origem.

## Cuidados com templates preservados

O inventário do projeto de origem registra limitações nos templates de origem que também
acompanham esta cópia. Ao usar `wizard/template.sh`, adapte `write_env` para
preservar valores com `#`, aspas ou quebras de linha e confirme que `open_url`
realmente abriu o navegador. O template de diagnóstico
`diagnosing-bugs/scripts/hitl-loop.template.sh` imprime o texto recebido;
remova credenciais antes de exibir ou compartilhar logs. Esses templates não
foram executados durante a migração.

O exemplo SSR `vercel-react-best-practices/rules/rendering-hydration-no-flicker.md`,
também reproduzido no guia compilado dessa skill, altera `className` antes da
hidratação sem refletir esse valor no JSX. A promessa de ausência de mismatch
nesse exemplo não é válida. Este projeto usa `createRoot`, sem SSR/hidratação;
o site público é HTML estático gerado no build, sem hidratar. Não aplique esse
trecho à SPA. Se SSR for adotado, garanta que o primeiro render
coincida com o DOM. `suppressHydrationWarning` é apenas uma exceção para uma
divergência intencional de um nível, não uma correção da divergência; consulte
a [documentação de hidratação do React](https://react.dev/reference/react-dom/client/hydrateRoot#suppressing-unavoidable-hydration-mismatch-errors).
