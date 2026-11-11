---
name: cli-for-agents
description: "Projetar ou revisar CLIs e scripts operáveis por agentes, com argumentos não interativos, ajuda acionável, saída estruturada e repetição segura."
---

# CLI para agentes

Use ao mudar a interface de um comando. Preserve os nomes e contratos
existentes; uma melhoria de automação não exige reorganizar toda a CLI.

## Entrada e descoberta

Cada operação deve ter um caminho não interativo com argumentos explícitos.
Uma entrada obrigatória ausente deve falhar com diagnóstico e exemplo válido,
sem esperar indefinidamente por teclado. Entrada por stdin serve para dados
quando fizer sentido; credenciais seguem o mecanismo protegido do projeto,
sem valores em argumentos, exemplos ou logs.

A ajuda deve permitir descoberta incremental: comando, subcomando e opções.
Inclua exemplos reais em `--help`, com alvo e efeitos claros. Neste projeto,
consulte `package.json` e `scripts/lib/commands.mjs`; um script público novo
entra no catálogo de `bun run help`. Preserve Bun, Vite+, `bun run worktree`
e seus atalhos `worktree:*` como pontos de entrada documentados.

## Resultado observável

- Use códigos de saída previsíveis e preserve os já documentados. Diferencie
  falha, timeout e sucesso quando o consumidor precisar dessa distinção.
- Em modo estruturado, stdout contém apenas o resultado parseável;
  diagnósticos vão para stderr. Identifique a versão do formato se ele for
  um contrato consumido por outras ferramentas.
- Retorne identificadores, estado e caminhos úteis. Omitir segredos deve
  acontecer na construção da saída, sem imprimir e tentar mascarar depois.
- Erros devem explicar a pré-condição ausente e indicar um comando existente
  para resolvê-la, sem disparar setup ou publicação como efeito oculto.

## Repetição, espera e efeitos

Use [principle-make-operations-idempotent](../principle-make-operations-idempotent/SKILL.md)
quando o comando alterar estado. Um timeout da espera não significa que a
operação foi cancelada. A retomada deve consultar seu estado antes de repetir.

Ofereça simulação quando ela ajudar a revisar uma ação destrutiva; documente
o que ainda pode ocorrer, como consultas de rede. Verifique efeitos reais
do modo simulado. Uma opção de confirmação não concede autorização nem
contorna gates fiscais, ownership de processos ou isolamento de worktrees.

## Verificação

Execute a ajuda, o erro de argumento relevante e um caso representativo do
comando alterado. Para saída JSON, confira que um consumidor consegue lê-la
sem remover banners. Para alterações de estado, confira os efeitos e a
repetição, preservando os processos do dev. Use diretórios temporários do
Windows via `$env:TEMP` e UTF-8 explícito em arquivos textuais.

Relate o contrato observado e eventuais caminhos que não puderam rodar.
Reaproveite testes de tooling; não crie testes que só fixam a redação da ajuda.
