# Skills do projeto

O fluxo de worktrees de outro projeto do mantenedor, o projeto de origem, também foi adaptado ao projeto, com ferramentas
próprias em `scripts/lib/worktree/`. Consulte [worktrees](../docs/worktrees.md)
para setup, isolamento do Convex, crons e limpeza. Essa importação é separada
do catálogo de skills abaixo.

Foram trazidas 66 das 69 skills de `.agents/skills` do projeto de origem.
A seleção inclui qualquer skill com utilidade direta ou indireta para o
freecorpsNFE: backend, operação, integrações, design web e trabalho de engenharia.

Depois foram adicionadas cinco skills de `mattpocock/skills`: `retro`,
`code-review`, `codebase-design`, `to-spec` e `to-tickets`, totalizando 71.
As orientações de `pr` foram incorporadas ao `file-pr` existente. Em 09/10,
16 skills de design, animação e mobile entraram pelo instalador, levando o
catálogo a 87. Em 20/10/2026, três skills adaptadas do Effect incluído no T3 Code elevaram
o total a 90: `dependency-maintenance`, `ci-maintenance` e
`performance-analysis`. A origem e as alterações nas skills existentes estão
registradas em [EXTERNAS.md](skills/EXTERNAS.md#importação-do-t3-code-em-20102026),
e os autores de cada origem, nos [créditos](skills/EXTERNAS.md#créditos).

Na mesma data, a seleção do pstack acrescentou
`principle-test-behavior-not-implementation`, `typescript-best-practices` e
`technical-writing`, levando o catálogo a 93. Também aprimorou as skills de
medição, diagnóstico, registro de decisões e escrita existentes. Consulte
[essa importação](skills/EXTERNAS.md#importação-do-pstack-em-20102026).

Em 26/10/2026, `manager` veio do Brigade, também da Freecorps, e levou o
catálogo a 94. Ela conduz um objetivo até PRs revisadas e mergeadas,
delegando implementação e revisão. Consulte
[essa importação](skills/EXTERNAS.md#importação-do-brigade-em-26102026).

Em 27/10/2026, quatro frentes do `cursor/plugins` acrescentaram seis skills:
criação e manutenção de roteiros de verificação, idempotência, CLIs para
agentes e verificação formal com diagramas de estados. O catálogo passa a
100 skills. Revisão de código, análise de impacto, prova de comportamento e
preparação de PR também receberam trechos adaptados. Consulte
[origem e limites](skills/EXTERNAS.md#importação-do-cursor-plugins-em-27102026).

Em 03/11/2026, `file-issue` entrou como skill local, irmã de `file-pr`, e
levou o catálogo a 101. Ela decide se o relato pode ser público, busca
duplicatas, segue os formulários de `.github/ISSUE_TEMPLATE/` e varre título
e corpo com `scripts/public-copy/scan-public-text.mjs` antes de publicar.

Em 04/11/2026, seis skills locais levaram o catálogo a 107. `full-stop` leva
uma mudança até a PR pronta para merge e para; `full-send`, só por invocação
do dev, vai até o merge e confere o deploy. Os nomes vêm de skills citadas no
T3 Code que não estão no repositório público, e o conteúdo foi escrito aqui.
`fiscal-review`, `test-and-verify`, `ui-review` e `council` cobrem as regras
fiscais do projeto, o bloco de verificação, a revisão da interface rodando e
as decisões arquiteturais caras de reverter. O padrão de interface de
`manager` passou a viver em `ui-review`. Consulte
[essa criação](skills/EXTERNAS.md#skills-locais-de-04112026).

Os diretórios vindos do projeto de origem preservam seu conteúdo e arquivos de apoio,
salvo as adaptações documentadas; as importações seguintes seguem o fluxo local.
Consulte [origem e adaptações](skills/EXTERNAS.md) antes de aplicar as convenções
importadas. O `skills-lock.json` na raiz conserva os 46 registros que já
existiam no lock da origem, mais os 16 de 09/10; a procedência das demais
está documentada.

Para revisão, use `code-review`; para discutir interfaces, `codebase-design`.
`retro`, `to-spec` e `to-tickets` preservam a invocação explícita da origem.
Specs e tickets podem ficar locais, sem configurar outro tracker. Consulte o
[fluxo de engenharia](skills/EXTERNAS.md#fluxo-das-skills-de-engenharia).

Para entender o código, `how` rastreia o comportamento e `why` investiga a
motivação histórica. Ambas começam diretamente e ampliam a investigação por
lacunas concretas. `code-review` mantém dois eixos com passagens diretas ou
delegação quando útil e permitida. `file-pr` usa as convenções conhecidas e
pergunta apenas por decisões ainda abertas. Consulte a
[adaptação local do workflow](skills/EXTERNAS.md#adaptação-local-do-workflow-em-21102026).

O Claude Code só encontra skills em `.claude/skills/<nome>/SKILL.md`. Por isso,
cada skill tem ali um atalho gerado, com o frontmatter original copiado e a
instrução de ler `.agents/skills/<nome>/SKILL.md`. São arquivos comuns, e não
symlinks, porque um checkout com `core.symlinks=false` no Windows transforma
symlinks em arquivos de uma linha. Depois de criar, remover ou renomear uma
skill, mudar o frontmatter de uma existente ou rodar `skills add`, execute
`node scripts/sync-claude-skills.mjs`. Ele apaga só os atalhos que gerou e os
symlinks antigos; outra pasta em `.claude/skills` aparece como sobra. O teste
`scripts/sync-claude-skills.test.ts` reprova atalho ausente, desatualizado ou
sem skill correspondente.

## Exclusões

| Skill | Motivo |
| --- | --- |
| `convex-agent` | Implementa agentes de IA e RAG dentro do produto; este serviço fiscal não tem essa funcionalidade. |
| `convex-improve-convex-plugin` | Envia transcrições da sessão para aprimorar o plugin do Convex, uma atividade externa ao desenvolvimento deste produto. |

`imagegen-frontend-mobile` foi excluída na importação inicial, mas foi
adicionada posteriormente e consta no catálogo atual.

As skills de design e integrações foram mantidas mesmo quando o uso é ocasional.
A seleção não exige instalar novos serviços ou alterar a arquitetura atual.
As skills são carregadas conforme a tarefa; o catálogo inteiro não é uma
sequência obrigatória de trabalho.

## Convex: desenvolvimento e operação — 34 skills

- [convex](skills/convex/SKILL.md)
- [convex-add](skills/convex-add/SKILL.md)
- [convex-advisor](skills/convex-advisor/SKILL.md)
- [convex-auth](skills/convex-auth/SKILL.md)
- [convex-authz](skills/convex-authz/SKILL.md)
- [convex-backup](skills/convex-backup/SKILL.md)
- [convex-billing](skills/convex-billing/SKILL.md)
- [convex-cost](skills/convex-cost/SKILL.md)
- [convex-create-component](skills/convex-create-component/SKILL.md)
- [convex-crons](skills/convex-crons/SKILL.md)
- [convex-deploy-guard](skills/convex-deploy-guard/SKILL.md)
- [convex-design](skills/convex-design/SKILL.md)
- [convex-docs](skills/convex-docs/SKILL.md)
- [convex-domains](skills/convex-domains/SKILL.md)
- [convex-env](skills/convex-env/SKILL.md)
- [convex-expert](skills/convex-expert/SKILL.md)
- [convex-explain-app](skills/convex-explain-app/SKILL.md)
- [convex-insights](skills/convex-insights/SKILL.md)
- [convex-launch-readiness](skills/convex-launch-readiness/SKILL.md)
- [convex-migrate](skills/convex-migrate/SKILL.md)
- [convex-migrate-rehearse](skills/convex-migrate-rehearse/SKILL.md)
- [convex-migration-helper](skills/convex-migration-helper/SKILL.md)
- [convex-monitor](skills/convex-monitor/SKILL.md)
- [convex-optimize](skills/convex-optimize/SKILL.md)
- [convex-performance-audit](skills/convex-performance-audit/SKILL.md)
- [convex-quickstart](skills/convex-quickstart/SKILL.md)
- [convex-reviewer](skills/convex-reviewer/SKILL.md)
- [convex-seed](skills/convex-seed/SKILL.md)
- [convex-self-heal](skills/convex-self-heal/SKILL.md)
- [convex-sentinel](skills/convex-sentinel/SKILL.md)
- [convex-setup-auth](skills/convex-setup-auth/SKILL.md)
- [convex-suggest](skills/convex-suggest/SKILL.md)
- [convex-test](skills/convex-test/SKILL.md)
- [convex-verify](skills/convex-verify/SKILL.md)

## Frontend e design web — 11 skills

- [brandkit](skills/brandkit/SKILL.md)
- [design-taste-frontend](skills/design-taste-frontend/SKILL.md)
- [gpt-taste](skills/gpt-taste/SKILL.md)
- [high-end-visual-design](skills/high-end-visual-design/SKILL.md)
- [imagegen-frontend-web](skills/imagegen-frontend-web/SKILL.md)
- [image-to-code](skills/image-to-code/SKILL.md)
- [industrial-brutalist-ui](skills/industrial-brutalist-ui/SKILL.md)
- [minimalist-ui](skills/minimalist-ui/SKILL.md)
- [redesign-existing-projects](skills/redesign-existing-projects/SKILL.md)
- [stitch-design-taste](skills/stitch-design-taste/SKILL.md)
- [vercel-react-best-practices](skills/vercel-react-best-practices/SKILL.md)

## Adições de interface, movimento e clientes — 17 skills

- [animate](skills/animate/SKILL.md)
- [animate-expo](skills/animate-expo/SKILL.md)
- [animation-vocabulary](skills/animation-vocabulary/SKILL.md)
- [apple-design](skills/apple-design/SKILL.md)
- [ask-sonner](skills/ask-sonner/SKILL.md)
- [break-ui](skills/break-ui/SKILL.md)
- [design-taste-frontend-v1](skills/design-taste-frontend-v1/SKILL.md)
- [emil-design-eng](skills/emil-design-eng/SKILL.md)
- [find-animation-opportunities](skills/find-animation-opportunities/SKILL.md)
- [imagegen-frontend-mobile](skills/imagegen-frontend-mobile/SKILL.md)
- [improve-animations](skills/improve-animations/SKILL.md)
- [mobile-native](skills/mobile-native/SKILL.md)
- [pick-ui-library](skills/pick-ui-library/SKILL.md)
- [prototype](skills/prototype/SKILL.md)
- [review-animations](skills/review-animations/SKILL.md)
- [ui-review](skills/ui-review/SKILL.md)
- [write-swift](skills/write-swift/SKILL.md)

## Diagnóstico, planejamento, escrita e PRs — 45 skills

- [arena](skills/arena/SKILL.md)
- [babysit-pr](skills/babysit-pr/SKILL.md)
- [blast-radius](skills/blast-radius/SKILL.md)
- [ci-maintenance](skills/ci-maintenance/SKILL.md)
- [cli-for-agents](skills/cli-for-agents/SKILL.md)
- [code-review](skills/code-review/SKILL.md)
- [codebase-design](skills/codebase-design/SKILL.md)
- [council](skills/council/SKILL.md)
- [create-formal-verification-skill](skills/create-formal-verification-skill/SKILL.md)
- [create-verification-skill](skills/create-verification-skill/SKILL.md)
- [dependency-maintenance](skills/dependency-maintenance/SKILL.md)
- [diagnosing-bugs](skills/diagnosing-bugs/SKILL.md)
- [domain-modeling](skills/domain-modeling/SKILL.md)
- [file-issue](skills/file-issue/SKILL.md)
- [file-pr](skills/file-pr/SKILL.md)
- [fiscal-review](skills/fiscal-review/SKILL.md)
- [full-send](skills/full-send/SKILL.md)
- [full-output-enforcement](skills/full-output-enforcement/SKILL.md)
- [full-stop](skills/full-stop/SKILL.md)
- [grilling](skills/grilling/SKILL.md)
- [grill-me](skills/grill-me/SKILL.md)
- [how](skills/how/SKILL.md)
- [manager](skills/manager/SKILL.md)
- [maintain-verification-skill](skills/maintain-verification-skill/SKILL.md)
- [performance-analysis](skills/performance-analysis/SKILL.md)
- [principle-encode-lessons-in-structure](skills/principle-encode-lessons-in-structure/SKILL.md)
- [principle-make-operations-idempotent](skills/principle-make-operations-idempotent/SKILL.md)
- [principle-prove-it-works](skills/principle-prove-it-works/SKILL.md)
- [principle-redesign-from-first-principles](skills/principle-redesign-from-first-principles/SKILL.md)
- [principle-separate-before-serializing-shared-state](skills/principle-separate-before-serializing-shared-state/SKILL.md)
- [principle-test-behavior-not-implementation](skills/principle-test-behavior-not-implementation/SKILL.md)
- [retro](skills/retro/SKILL.md)
- [show-me-your-work](skills/show-me-your-work/SKILL.md)
- [statechart](skills/statechart/SKILL.md)
- [technical-writing](skills/technical-writing/SKILL.md)
- [test-and-verify](skills/test-and-verify/SKILL.md)
- [to-spec](skills/to-spec/SKILL.md)
- [to-tickets](skills/to-tickets/SKILL.md)
- [triage](skills/triage/SKILL.md)
- [typescript-best-practices](skills/typescript-best-practices/SKILL.md)
- [unslop](skills/unslop/SKILL.md)
- [verify-console](skills/verify-console/SKILL.md)
- [wait-what](skills/wait-what/SKILL.md)
- [why](skills/why/SKILL.md)
- [wizard](skills/wizard/SKILL.md)
- [writing-for-agents](skills/writing-for-agents/SKILL.md)
