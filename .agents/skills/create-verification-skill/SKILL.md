---
name: create-verification-skill
description: "Criar uma skill local que executa jornadas reais e guarda evidências, reaproveitando os runners do projeto. Use ao criar ou consolidar um roteiro de verificação do console, REST, SDK ou CLI."
---

# Criar uma skill de verificação

Produza um roteiro executável por outro agente, com entradas, pré-condições,
ações e resultados observáveis. A skill gerada fica em
`.agents/skills/verify-<domínio>/`; o nome deve identificar a área coberta.
Criar esse roteiro não autoriza corrigir o produto, publicar ou abrir PR.

## Descobrir o caminho existente

Leia o contrato da área pelo [índice](../../../docs/README.md) e confira as
entradas no código. Consulte `package.json`, `scripts/lib/commands.mjs`,
`apps/console/e2e/` e os scripts `prove-*` pertinentes antes de criar um runner.
O nome de um script não prova seu alvo: leia como seleciona ambiente, dados,
transporte e credenciais antes de executá-lo.

Para navegador, siga [navegador.md](../../../docs/desenvolvimento/navegador.md)
e o procedimento de [worktrees](../../../docs/worktrees.md). Os comandos
`worktree:status --json`, `worktree:wait` e `worktree:doctor` ajudam a avaliar
o ambiente, mas não substituem a execução da jornada. Reutilize a automação
de navegador disponível na sessão ou o runner documentado para essa jornada.

Mapeie as entradas aplicáveis, como console, REST e SDK, e as diferenças entre
a NF-e 55 importada e a NFS-e emitida. Uma prova por mutation interna não cobre sozinha
autenticação, proxy, serialização e navegação dessas entradas.

## Escrever o roteiro

Use [writing-for-agents](../writing-for-agents/SKILL.md). O `SKILL.md` gerado
precisa ter `name`, `description` e instruções concretas para:

- **Preparar e iniciar:** comandos locais, alvo, pré-condições e sinal de
  prontidão. Use `bun run dev` quando a aplicação precisar rodar; testes e
  leitura de código não exigem setup do Convex. Aguarde setup em andamento.
- **Diagnosticar:** como conferir que a instância é deste worktree, está
  pronta e tem a sessão necessária. Depois de um resultado inesperado,
  confira novamente antes de continuar a dirigir a aplicação.
- **Executar:** comandos ou seletores reais e o estado inicial necessário.
  Worktrees não têm seed. Para jornadas autenticadas, siga o cadastro
  fictício e o coletor local documentados, sem pular o fluxo por injeção de
  sessão. Fixtures e `convex-test` servem às provas de domínio apropriadas.
- **Observar:** ação, resultado e efeitos persistidos, incluindo o desfecho
  de operações assíncronas. Um aceite HTTP não comprova conclusão. Inclua
  casos negados e isolamento quando houver acesso envolvido.
- **Guardar e limpar:** local das evidências, processos iniciados pela
  execução e sua limpeza. Preserve processos do dev e de outros worktrees.
  Evidências sintéticas devem continuar acessíveis após a limpeza.

Crie um índice em `features/README.md` e um arquivo por jornada inicial
relevante. Cada arquivo registra contrato de referência, entradas cobertas,
pré-condições, passos, resultado esperado, prova e limitações. Comece pelo
escopo pedido; não inventarie todo o produto por obrigação. Ligue o mapa aos
documentos existentes, incluindo [ACCEPTANCE.md](../../../docs/v1.0/ACCEPTANCE.md),
sem copiar seus contratos para outra fonte de verdade.

Mantenha dados sintéticos e transporte fiscal, e-mail e webhooks simulados
conforme o procedimento local. Não leia arquivos de credenciais para
diagnosticar acesso. Capturas, respostas e logs não devem expor segredos ou
dados reais. Um ensaio hospedado precisa de escopo e alvo próprios; não é
fallback automático para uma falha local.

## Provar a skill gerada

Siga suas instruções uma vez, da preparação à limpeza, executando ao menos
uma jornada completa. Confira que os artefatos ainda existem após limpar e
que não sobraram processos iniciados pela tentativa, inclusive se ela falhou.
Valide a sintaxe dos metadados e os links locais.

Relate separadamente as jornadas executadas, as apenas mapeadas e os bloqueios.
Sem execução, a skill gerada é um rascunho. Um problema do produto encontrado
durante a prova continua sendo um achado; não enfraqueça a jornada para
aprová-la. Encaminhe a manutenção para
[maintain-verification-skill](../maintain-verification-skill/SKILL.md).
