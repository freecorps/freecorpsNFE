---
name: why
description: "Investigar a motivação histórica de uma decisão, alternativa rejeitada, defesa ou valor no código. Começa pelas fontes ligadas ao alvo e amplia quando falta evidência. Para explicar o comportamento atual, use how; para reproduzir uma falha, diagnosing-bugs."
---

# Por que foi feito assim

Use esta skill para perguntas sobre intenção e história: por que uma decisão
foi tomada, qual restrição a motivou ou de onde veio um limite. Código mostra
o comportamento; intenção exige um registro ou uma inferência identificada.
Uma pergunta causal sobre uma falha atual pode exigir
[diagnosing-bugs](../diagnosing-bugs/SKILL.md). Para fluxo de execução e
responsabilidades, use [how](../how/SKILL.md).

## 1. Delimitar a pergunta

Identifique a decisão, os arquivos ou símbolos relevantes e o período, se
conhecido. Use o contexto da sessão para resolver o alvo. Pergunte somente
quando a ambiguidade mudar materialmente a investigação.

Consulta em leitura não exige branch nova, instalação ou setup. Use as fontes
e ferramentas disponíveis, dentro das permissões da sessão. A skill não
autoriza escrita, publicação ou ampliação de acesso.

## 2. Investigar diretamente

Comece pelo trecho que implementa a decisão e pelos registros ligados a ele:
comentários, ADRs, documentação, testes e histórico pertinente. Distinga o
contrato atual da plataforma do legado. Consulte primeiro um registro já
indicado no pedido ou no código, sem refazer buscas resolvidas no contexto.

Use `rg`, `git log -- <arquivo>`, `git blame -L <início>,<fim> <arquivo>` ou
`git show <sha>` conforme a pergunta. Se a origem ainda estiver incerta,
`git log -S '<texto>' -- <arquivo>` ou `git log --follow -- <arquivo>` pode
localizar a introdução da regra. O último commit que tocou a linha pode ser
apenas formatação. Leia o diff e a justificativa da mudança relevante.

Quando uma PR ou issue explicar a decisão, leia seu contexto e as discussões
pertinentes com as ferramentas disponíveis. Registre fonte, revisão ou data e
o que sustenta a conclusão. Um teste demonstra o caso protegido; sozinho, não
prova a motivação do autor. Uma explicação atual não prova a intenção original.

Encerre quando a pergunta estiver respondida por evidência suficiente, com as
contradições relevantes resolvidas ou explicitadas. Um ADR ou uma PR pode
bastar. Não é necessário consultar todas as categorias de fontes.

## 3. Ampliar diante de uma lacuna concreta

Nomeie o que falta antes de expandir. Exemplos: o commit aponta para um
incidente; a PR remete a uma discussão; a justificativa não explica o valor do
limite; duas fontes divergem sobre a alternativa rejeitada. Escolha a fonte
capaz de esclarecer essa lacuna e faça uma consulta dirigida.

O [índice de fontes](references/source-playbook.md) oferece roteiros opcionais.
Leia apenas o roteiro pertinente. Descubra uma integração quando a pergunta
ou uma pista justificar consultá-la. Sem a ferramenta ou acesso necessário,
registre o limite e continue com as fontes disponíveis; a investigação não
exige instalar integrações nem mudar permissões.

Registre os termos, filtros, período e cobertura de uma busca vazia. Ela
significa que a consulta não encontrou o registro, não que ele inexiste nem
que a decisão não foi discutida. Retenção, indexação e acesso podem limitar a
busca. Evite repetir consultas equivalentes sem uma nova pista.

Delegue apenas quando permitido e quando houver frentes independentes cuja
investigação agregue valor. Escolha ferramentas e modelos disponíveis na
sessão, respeitando a seleção do dev. Defina pergunta, fonte, lacuna e ponto
de parada de cada frente; compartilhe o que já foi encontrado para evitar
repetição. O [template de investigação](references/investigator-prompt.md)
serve tanto à investigação direta quanto a essa divisão opcional. Delegação
não exige elevação de permissões nem um agente separado para sintetizar.

Se as pistas pertinentes se esgotarem ou dependerem de uma fonte inacessível,
encerre com a parte respondida e a lacuna específica. Não transforme uma
história plausível em resposta comprovada.

## 4. Responder com evidência

Responda em pt-BR, começando pela conclusão que as fontes sustentam. Cite os
registros junto às afirmações. Separe justificativa explícita, inferência e
desconhecido; exponha fontes contraditórias e hipóteses concorrentes quando
elas mudarem a resposta. Preserve a incerteza ao resumir achados de terceiros.

Para evidência indireta ou conflitante, consulte o
[guia de confiança](references/epistemics.md). O
[template de síntese](references/synthesizer-prompt.md) ajuda em investigações
com várias fontes, mas uma resposta curta com citação pode ser suficiente.
Informe buscas sem resultado e fontes indisponíveis que limitem a conclusão;
não preencha um inventário de fontes que a pergunta não exigiu consultar.

Antes de concluir, confira se cada afirmação de intenção tem uma fonte que
realmente a sustenta, se cada parte da pergunta foi respondida ou marcada como
lacuna e se alguma inferência foi apresentada como fato. Se a investigação
anteceder uma mudança pedida, explicite as restrições a preservar, o que pode
mudar e quais riscos ainda precisam de prova.
