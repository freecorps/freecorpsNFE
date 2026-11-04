---
name: council
description: "Convocar conselheiros independentes, cada um com uma lente do freecorpsNFE, para uma decisão arquitetural cara de reverter, e sintetizar uma recomendação com a divergência preservada."
disable-model-invocation: true
---

# Conselho

Uma decisão arquitetural importante tomada por uma cabeça só herda os pontos
cegos dela. O conselho dá a mesma pergunta a conselheiros que não se veem,
cada um com uma lente do projeto, confere o que afirmam no código e entrega ao
dev uma recomendação com a divergência à vista. O conselho recomenda; quem
decide é o dev.

Para comparar implementações candidatas, use `arena`; para interrogar um plano
com o próprio dev, `grilling`.

## 1. Enquadre

Escreva `.ci-results/council-<assunto>/brief.md`:

- a pergunta, em uma frase que admita mais de uma resposta;
- as opções conhecidas, incluindo "não mudar nada";
- as restrições: as cinco garantias de "O que o freecorpsNFE não pode
  perder" do `AGENTS.md`, as ADRs aceitas em `docs/adr/` e os contratos em
  `docs/plataforma/` que tocam a pergunta, com caminho;
- o custo de reverter e quem é afetado: console, API, SDK, workers, dados
  já gravados, consumidores externos;
- o que já se sabe e o que é suposição.

Se a decisão é barata de reverter ou já está decidida por uma ADR aceita,
diga isso ao dev e pare: o conselho custa vários agentes. Quando o código
contraria uma ADR aceita, a divergência entra no brief como fato, não como
opção a votar.

O passo termina com o brief escrito e com a pergunta tendo pelo menos duas
respostas defensáveis.

## 2. Convoque

Um subagente por cadeira, todos na mesma mensagem, com o mesmo brief e sem
ver os outros. Escolha de três a cinco cadeiras pela pergunta:

| Cadeira | Lente | Skills |
| --- | --- | --- |
| Fiscal | Conformidade, histórico fiscal, ambientes, prova do fisco | `fiscal-review` |
| Acesso | Servidor manda, escopos de organização, projeto, empresa e chave | `convex-authz` |
| Operação | Retentativa, idempotência, reconciliação, deploy por merge, custo | `principle-make-operations-idempotent`, `convex-performance-audit` |
| Simplicidade | O menor modelo que torna o comportamento previsível | `codebase-design`, `principle-redesign-from-first-principles` |
| Consumidor | Contrato REST, SDK, compatibilidade, console | `typescript-best-practices`, `ui-review` |

Cada conselheiro lê o código e os documentos, sem alterar arquivos, e
devolve:

- a opção recomendada, ou uma nova;
- os três maiores riscos dela, cada um com `caminho:linha` ou documento;
- o que o faria mudar de ideia;
- confiança de 1 a 5 e o que não conseguiu verificar.

Modelos diferentes por cadeira reduzem viés comum; use outro provedor só
quando a sessão oferece e o dev pediu. Cadeira que não responde fica
registrada como ausente; siga com as demais.

## 3. Confronte

Se as recomendações divergem, faça uma rodada: cada conselheiro recebe as
posições dos outros, sem identificação, e responde só aos argumentos que
mudam sua posição ou que considera errados. Uma rodada basta; mais rodadas
produzem consenso por cansaço.

## 4. Sintetize

Leia todas as respostas inteiras. Confira no código cada afirmação que pesa
na decisão; afirmação sem fonte não pesa. Escreva
`.ci-results/council-<assunto>/sintese.md`:

- a recomendação e por quê, em um parágrafo;
- as opções avaliadas, com o melhor argumento de cada uma;
- a divergência que restou, com quem discorda e por quê; não a apague para
  parecer unânime;
- as condições que reabririam a decisão;
- as perguntas que só o dev responde.

Convergência de todas as cadeiras é sinal forte; registre-a. Divergência
total indica brief mal enquadrado: volte ao passo 1.

## 5. Entregue ao dev

Apresente a recomendação, a divergência e as perguntas abertas, com os
caminhos dos dois arquivos. Se o dev aceitar, redija a ADR com
`domain-modeling`, no próximo número de `docs/adr/`, citando a síntese. A ADR
e a implementação seguem o fluxo normal de PR; o conselho não as autoriza.
