---
name: how
description: "Explicar como um fluxo do código funciona, quem é responsável por ele e onde uma mudança deve ficar. Rastreia entrada, decisões, dados e efeitos. Faz crítica arquitetural quando pedida. Para motivação histórica, use why."
---

# Como funciona

Responda a perguntas sobre execução, limites entre módulos e responsabilidade
no código. Comece pela investigação direta, mesmo em subsistemas grandes;
amplie conforme as dependências e lacunas encontradas. Explicar não autoriza
alterar o código ou iniciar ambiente. Para intenção histórica, use
[why](../why/SKILL.md).

## 1. Fixar a pergunta e o caminho

Identifique o comportamento, símbolo ou decisão de localização em questão.
Use os arquivos e o contexto já fornecidos. Se houver ambiguidade que mude o
fluxo examinado, esclareça-a; nos demais casos, indique a interpretação e
prossiga. Distinga plataforma e legado ao escolher o ponto de entrada.

Localize a implementação com `rg` e `rg --files`, leia-a e siga os chamadores,
tipos e consumidores necessários. Nome de arquivo e assinatura não bastam.
Consulta em leitura dispensa branch nova, instalação e setup.

## 2. Rastrear o comportamento completo da pergunta

Siga o caminho desde a entrada ou gatilho até o retorno e os efeitos:

- quais dados entram e como são validados e transformados;
- quem autoriza a ação e qual escopo é conferido no servidor;
- quais decisões e transições ocorrem, incluindo erros e caminhos alternativos
  pertinentes à pergunta;
- onde o trabalho é persistido, agendado ou entregue a outro componente e
  como a conclusão chega ao consumidor.

Uma fila não encerra um fluxo que pergunta pelo resultado: leia também quem
consome o trabalho. Confira as entradas aplicáveis, como console, REST e SDK,
quando puderem mudar a resposta. Para localização de código, examine os
consumidores, a direção das dependências e as regras já aceitas do projeto.

Use testes existentes para conferir casos e invariantes. Diferencie leitura
do código, execução observada e hipótese. Se a pergunta exigir prova em
execução, use a menor verificação pertinente dentro do escopo autorizado.
Documente dependências externas ou caminhos que não conseguiu verificar.

Pare quando puder explicar cada etapa relevante da entrada ao efeito, com
referências que a sustentem, e responder às partes da pergunta. Se uma etapa
não puder ser rastreada, indique a fronteira e o que falta; não preencha o
trecho com uma suposição nem declare o fluxo completo.

## 3. Expandir quando necessário

Abra outro módulo quando uma chamada, contrato ou divergência deixar uma
lacuna concreta. Buscas sem resultado registram termos e escopo consultados;
não provam que uma implementação inexiste. Prefira seguir a dependência real
a mapear todo o repositório sem relação com a pergunta.

Quando permitido e útil, delegue partes independentes de uma investigação
ampla. Defina o fluxo ou fronteira de cada parte, a pergunta ainda aberta e
os achados já conhecidos. Use ferramentas e modelos disponíveis na sessão,
respeitando a seleção do dev e mantendo o trabalho em leitura. Os templates
de [exploração](references/explorer-prompt.md) e
[explicação](references/explainer-prompt.md) servem à execução direta ou
delegada; nenhum exige agentes adicionais.

Confira o código que conecta as partes e resolva divergências entre os
achados. Quantidade de agentes ou arquivos lidos não substitui um caminho
completo sustentado por evidência.

## 4. Explicar

Escreva em pt-BR. Comece pela resposta e desenvolva o fluxo com nomes concretos
de funções e arquivos. Inclua os conceitos necessários, decisões, efeitos e
limites que o leitor precisa para trabalhar nessa área. Use um mapa de
arquivos ou diagrama quando esclarecer relações; uma pergunta estreita pode
ser respondida em poucos parágrafos com referências.

Mantenha visíveis as lacunas e o alcance da verificação. Explique a motivação
histórica apenas se houver fonte, ou identifique-a como inferência. Releia a
pergunta antes de concluir: explicar um caminho feliz não responde sozinho
a uma pergunta sobre falha, retentativa ou autorização.

## Crítica arquitetural, quando pedida

Primeiro compreenda o fluxo com o procedimento acima. Faça então uma passagem
crítica direta usando os critérios pertinentes da
[rubrica](references/critique-rubric.md). Delegação é opcional quando houver
valor em perspectivas independentes e autorização na sessão; o
[template de crítica](references/critic-prompt.md) delimita essa análise.

Para cada achado, confira o código, o cenário, o impacto e as decisões aceitas
do projeto. Diferencie problemas que justificam ação, preocupações que ainda
precisam de prova e observações sem prioridade. Descarte achados falsos ou
preferências de estilo, explicando objeções relevantes. Não recomende uma
reescrita por hipótese de evolução sem requisito concreto.

Apresente a explicação e os achados de modo que o leitor consiga distinguir
o comportamento atual das propostas. Ausência de achados é um resultado
válido no escopo examinado. A crítica não autoriza implementar propostas.
