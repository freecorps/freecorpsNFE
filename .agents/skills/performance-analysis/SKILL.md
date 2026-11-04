---
name: performance-analysis
description: "Otimizar, investigar regressões ou comprovar alegações de desempenho em runtime, compilação TypeScript e bundle, comparando revisões em condições equivalentes."
---

# Análise de desempenho

Use quando a tarefa envolver otimização, regressão ou comprovação de uma
alegação de desempenho. Uma mudança funcional sem requisito ou alegação de
desempenho não exige benchmark por esta skill.

Valide a correção do comportamento antes de medir. Escolha a operação real
afetada e reaproveite o benchmark ou medidor existente. Origem e adaptações
estão em [EXTERNAS.md](../EXTERNAS.md#importação-do-t3-code-em-20102026).

Para investigar a causa de um bug, use o ciclo de
[diagnosing-bugs](../diagnosing-bugs/SKILL.md). Para leituras, assinaturas,
contenção e limites do Convex, consulte
[convex-performance-audit](../convex-performance-audit/SKILL.md).
Esta skill define como sustentar a comparação.

## Preparar uma comparação repetível

Antes de executar a comparação, registre o protocolo: operação, métrica,
base e candidata por SHA, alterações locais incluídas, versões das ferramentas,
dados ou fixture, comando e condições de execução. Inclua o estado dos caches,
aquecimento, número de rodadas e prova de correção conforme o caso; explicite
o que não se aplica. Compare a mesma operação, dados e ambiente; se o runtime
ou compilador for o objeto da mudança, identifique essa diferença explicitamente.

Leia `docs/worktrees.md` antes de preparar ambientes adicionais. Use dados
sintéticos e integrações simuladas, preservando processos alheios.
Não misture medições feitas com cargas concorrentes diferentes.

Escolha o caminho:

- **Runtime:** derive a prova de `vite.config.ts`, dos testes benchmark e dos
  scripts existentes, como `bench:navigation`. Separe setup da operação
  medida, salvo quando setup for o objeto do teste. Defina aquecimento,
  rodadas e métricas antes de comparar; alterne base e candidata quando
  viável para reduzir efeitos da ordem.
- **TypeScript:** use `scripts/build/typecheck.mjs` e a configuração do projeto
  afetado. Compare o mesmo consumidor, controlando caches e mantendo o
  compilador fixo quando sua versão não for o objeto da comparação.
  Mudanças em inferência ou aceitação de código exigem também prova de
  correção dos tipos; tempo de compilação não a substitui.
- **Bundle:** faça um build novo de cada revisão e use
  `scripts/measure-console-bundle.mjs` para o console. Compare bytes e gzip
  dos artefatos equivalentes. O total inclui chunks lazy e não representa
  sozinho o carregamento inicial nem métricas de usuários reais.

## Interpretar e concluir

Antes de usar um número para decidir, confira o medidor e o trabalho observado:

- Leia o trecho cronometrado e verifique o que ele inclui e exclui. Aguarde
  promises, consuma iteradores e confira se os resultados foram usados.
  Para trabalho assíncrono, diferencie a aceitação do pedido da conclusão
  da operação; nomeie qual delas a métrica representa.
- Conte sucessos, rejeições, timeouts e retries. Confira a correção dos
  resultados e os efeitos esperados. Uma falha rápida ou um efeito omitido
  não representa ganho de desempenho.
- Investigue o recurso que limita a operação com perfil ou contadores,
  incluindo o gerador de carga. Colete perfis numa execução separada dos
  tempos usados no resultado. Se o gargalo não estiver demonstrado, informe
  que a explicação causal permanece incerta.
- Compare configurações equivalentes e relevantes ao uso esperado, como
  build, índices, lotes e caches, dentro do ambiente local seguro. Se a
  diferença for de configuração, limite a conclusão a ela. Um resultado de
  helper precisa ser relacionado ao caminho completo antes de prometer
  melhora percebida pelo usuário.
- Confira se o ganho cabe no custo que foi removido e na capacidade medida
  de CPU, disco ou rede. Se parecer impossível, procure trabalho ignorado,
  cache ou erro na medição antes de aceitar a conclusão.

Repita medições de tempo nas duas revisões e relate dispersão junto da
medida central. Preserve rodadas malsucedidas como falhas da comparação.
Uma execução isolada ou diferença dentro da variação observada não sustenta
uma alegação de melhoria. Um ensaio sem protocolo repetível é exploratório.
Duração isolada é observação, não prova de ganho causal. Registre resultado
inconclusivo como tal, sem convertê-lo em promessa percentual.

Antes de mudar um limite, registre o valor anterior, o resultado medido e
por que o novo limite representa o comportamento esperado. Confirme em
nova execução, sem usar o ajuste apenas para esconder uma regressão.

Apresente resultados, revisões, comandos, condições e limitações. Execute
os checks finais aplicáveis do `AGENTS.md` quando houver implementação.
Medições locais não comprovam capacidade do serviço hospedado nem
autorização fiscal.
