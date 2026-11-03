# Template de exploração

Use como roteiro direto ou para delimitar uma frente delegada. Não pressupõe
outros exploradores nem um agente separado para escrever a explicação.

## Contexto

- Pergunta: {QUESTION}
- Fluxo ou fronteira a examinar: {EXPLORATION_SCOPE}
- Arquivos e achados já conhecidos: {KNOWN_FINDINGS}
- Etapa ou dúvida ainda aberta: {OPEN_QUESTION}

## Procedimento

Trabalhe em leitura com as ferramentas disponíveis. Use `rg`, `rg --files`
e a leitura da implementação para localizar o comportamento. Comece pelos
arquivos conhecidos; amplie quando uma dependência ou dúvida exigir.

1. Localize a entrada: ação no console, chamada de API, job ou outro gatilho.
2. Siga as funções, transformações e decisões até o retorno e os efeitos.
   Inclua o consumidor de um trabalho assíncrono quando o resultado fizer
   parte da pergunta.
3. Leia os tipos, validadores e regras de autorização relevantes. Confira
   quem carrega os registros e em que escopo permite a operação.
4. Identifique as fronteiras e o que cada componente recebe, persiste e devolve.
   Confira caminhos alternativos, erros e retentativas quando pertinentes.
5. Consulte os testes relacionados para entender os casos protegidos, sem
   chamar leitura de código de execução comprovada.

Pare quando o caminho atribuído estiver rastreado da entrada ao efeito com
referências. Se uma etapa não puder ser rastreada, registre o trecho exato
que falta e por quê. Uma busca vazia informa o alcance da consulta, não a
inexistência de uma implementação. Em trabalho delegado, devolva pistas
fora do escopo para integração, sem duplicar outras frentes.

## Resultado

Apresente os componentes e a sequência do fluxo, com arquivos, símbolos e
linhas pertinentes. Mostre os dados entre etapas, decisões, limites e efeitos.
Inclua os caminhos de falha relevantes, fatos não óbvios e perguntas abertas.
Identifique o que veio de código, documentação ou teste executado e informe
quais arquivos sustentam a explicação. Motivação histórica precisa de fonte;
a forma do código sozinha não a comprova.
