---
name: maintain-verification-skill
description: "Conferir e atualizar uma skill de verificação e seu mapa de jornadas contra o código e a aplicação local. Use quando o roteiro ficou desatualizado ou sua cobertura precisa ser auditada."
---

# Manter uma skill de verificação

Localize a skill com instruções de preparação, execução e evidências, além
do mapa de jornadas. Use o alvo indicado pelo dev; se não existir, encaminhe
para [create-verification-skill](../create-verification-skill/SKILL.md).
Esta manutenção altera só o roteiro, o mapa e os helpers que ele possui.
Uma correção no produto exige que faça parte do pedido.

## Conferir código e mapa

Confira se o índice corresponde aos arquivos de jornadas. Para cada jornada
no escopo, compare contrato, entradas, permissões, pré-condições e efeitos
esperados com as fontes atuais. Examine mudanças recentes para encontrar
entradas novas ou removidas, sempre com um caminho de código como evidência.
Reutilize os documentos de domínio; não transforme o mapa em outro contrato.

A leitura pode ser direta ou dividida entre agentes quando a sessão permitir
e isso reduzir o trabalho. Só o coordenador dirige uma instância compartilhada;
leitores não alteram dados nem competem pela mesma sessão de navegador.

## Executar as jornadas

Siga a preparação e o diagnóstico da skill mantida. Confira alvo e transportes
antes de executar scripts. Use fixtures sintéticas e serviços simulados.
Quando faltar uma pré-condição, registre a jornada como bloqueada em vez de
omitir o passo ou usar dados de produção.

Execute cada jornada do escopo pelo menos uma vez, observando a ação e o
desfecho. Reutilize estados iniciais quando não comprometerem independência
ou isolamento. Depois de uma falha inesperada, diagnostique a instância e
restabeleça um estado conhecido antes de continuar.

Limpe apenas recursos criados pela execução e confira que as evidências
capturadas continuam disponíveis. Faça essa limpeza também nas tentativas
interrompidas. Use o ciclo documentado em
[worktrees](../../../docs/worktrees.md), preservando serviços alheios.

## Decidir o que corrigir

- **Roteiro desatualizado:** o contrato aceito e o código mudaram; atualize
  passos, referências e resultados, citando a mudança que sustenta a revisão.
- **Regressão do produto:** o contrato continua válido e o comportamento o
  viola; relate a reprodução. Preserve a expectativa que detectou o defeito.
- **Ambiente indisponível:** registre a pré-condição e quais jornadas não
  puderam rodar. Leitura de código não equivale à execução dessas jornadas.

Reexecute os passos afetados por correções no roteiro ou helper. Entregue
o resultado por jornada e uma conclusão: sem ajustes, ajustado ou incompleto.
Informe comandos, evidências e lacunas. Commit, PR e publicação seguem o
escopo pedido; manter a skill não inicia agendamento recorrente.
