---
name: to-spec
description: "Transformar a conversa e as decisões existentes em uma especificação verificável."
disable-model-invocation: true
---

# Da conversa à especificação

Sintetize o que já foi discutido. O objetivo é uma especificação suficiente
para implementar e verificar o comportamento acordado, sem abrir outra rodada
de entrevista nem aumentar a funcionalidade para preencher um template.

Leia [EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia) para as fontes
de domínio, o destino do documento e a publicação no tracker.

## Procedimento

1. Reúna o pedido, decisões, restrições e critérios já estabelecidos. Leia os
   contratos e ADRs pertinentes; explore o código apenas no que ainda faltar
   para distinguir o estado atual do resultado desejado.
2. Identifique os comportamentos verificáveis e as interfaces existentes pelas
   quais podem ser provados. Consulte
   [codebase-design](../codebase-design/SKILL.md) se a própria interface estiver
   em discussão. Use as decisões já tomadas, sem pedir aprovação novamente.
3. Escreva a especificação em pt-BR. Registre suposições e decisões pendentes;
   pergunte apenas pelo que impedir uma especificação útil ou alterar
   materialmente o contrato. Continue as partes independentes.
4. Salve ou publique no destino autorizado. Confira se cada requisito tem um
   critério verificável e se toda decisão descrita está sustentada na conversa
   ou nas fontes do projeto. Informe o caminho ou URL e as pendências reais.

## Estrutura sugerida

Dimensione o documento pela mudança. Use estas seções quando forem pertinentes:

- **Problema:** quem é afetado, em qual situação e o que acontece hoje.
- **Resultado esperado:** o comportamento que resolve o problema.
- **Cenários e aceite:** casos concretos com entradas, resultado esperado e
  condições de erro. Histórias de usuário são opcionais; não force uma lista
  longa de reformulações do mesmo requisito.
- **Decisões de implementação:** responsabilidades, interfaces, estados,
  schema e contratos afetados. Separe decisão aceita de proposta. Links para
  código ou contratos existentes são úteis; evite prescrever uma árvore de
  arquivos futura que a implementação ainda precisa descobrir.
- **Verificação:** interfaces a exercitar, fixtures ou testes existentes que
  servem de referência, casos positivos e negativos aplicáveis. Distinga
  simulação local de comprovação externa.
- **Fora do escopo:** limites que poderiam ser confundidos com parte do pedido.
- **Pendências:** perguntas que ainda impedem implementar ou verificar uma
  parte específica, com o efeito de deixá-las em aberto.

Para mudanças fiscais ou de acesso, use a lista de caminhos do `AGENTS.md`
conforme se aplique à funcionalidade. Um snippet pode registrar uma decisão
de estado ou contrato melhor que prosa; inclua apenas a parte que a explica.

Concluir a especificação não inicia sua implementação, não cria labels e não
marca automaticamente trabalho com pendências como pronto para execução.
