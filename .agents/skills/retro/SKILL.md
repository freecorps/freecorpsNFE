---
name: retro
description: "Revisar uma sessão de desenvolvimento e propor melhorias no ambiente do agente."
disable-model-invocation: true
---

# Retrospectiva de uma sessão

Encontre mudanças no ambiente que tornariam a próxima sessão mais previsível.
O resultado é uma lista de propostas sustentadas pelo que aconteceu na sessão.
Implementar essas propostas depende do escopo pedido pelo dev.

## Procedimento

1. Leia [writing-for-agents](../writing-for-agents/SKILL.md) antes de propor
   alterações de instruções ou documentação.
2. Use a sessão indicada pelo dev; na ausência de indicação, use a atual.
   Consulte conversa, diff, comandos e resultados disponíveis. Se faltarem logs
   ou evidências de uma sessão passada, delimite o que conseguiu analisar.
3. Procure oportunidades nas categorias abaixo. Para cada uma, identifique o
   episódio concreto, a causa e a menor mudança que evitaria a repetição.
4. Apresente as propostas por gravidade, com arquivo ou ferramenta afetada,
   benefício esperado e uma forma de verificar o resultado. Distinga falha
   observada de hipótese. Se não houver achados sustentados, diga isso.

## O que procurar

- **Navegação:** tempo perdido procurando uma informação que já existia.
  Prefira um link no ponto onde a dúvida surgiu a copiar a informação.
- **Verificações automáticas:** erro que lint, tipos ou testes poderiam pegar.
  Leia os scripts e o CI reais antes de sugerir outra ferramenta. Um check
  existente que não roda pede conserto da ligação, não um segundo check.
- **Padrões de código:** se a violação é mecânica, proponha uma regra no
  verificador existente. Reserve instruções escritas para decisões que exigem
  julgamento. Consulte
  [principle-encode-lessons-in-structure](../principle-encode-lessons-in-structure/SKILL.md)
  para transformar uma correção recorrente em proteção estrutural.
- **Instruções:** contradições, repetições ou regras que não mudaram nenhuma
  decisão. Confira os consumidores antes de mover uma regra para outro arquivo.
- **Uso de ferramentas:** chamadas caras ou repetidas que um comando menor
  resolveria; resultados excessivos que ocultaram a informação útil.
- **Acesso à informação:** logs, dados sintéticos ou acesso ao navegador que
  faltaram para diagnosticar o problema. Sugira acesso apenas ao necessário,
  preservando as restrições de ambiente do projeto.

## Aplicação no projeto

Leia [EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia) para as
convenções locais. Reutilize os documentos existentes em vez de criar
`CODING_STANDARDS.md`, outro glossário ou uma nova etapa obrigatória de CI por
convenção da skill de origem. A implementação continua responsável pelos
padrões do projeto, mesmo quando haverá revisão independente depois.

Se o dev também pediu as correções, aplique as que cabem nesse escopo e
verifique o comportamento afetado. Uma retrospectiva, por si só, não autoriza
alterar configuração global, instalar dependências ou publicar resultados.
