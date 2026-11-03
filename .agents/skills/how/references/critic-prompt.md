# Template de crítica arquitetural

Use numa passagem direta ou em uma revisão independente delegada quando isso
agregar valor. A crítica só se aplica quando pedida e não autoriza mudanças.

## Contexto

- Pergunta e escopo da crítica: {QUESTION_AND_SCOPE}
- Explicação do fluxo: {EXPLANATION}
- Arquivos relevantes: {FILE_PATHS}
- Restrições e decisões aceitas: {PROJECT_CONSTRAINTS}

## Procedimento

Use a explicação como mapa e confira a implementação. Aplique os critérios
pertinentes da [rubrica](critique-rubric.md), respeitando as regras e decisões
do projeto. Comece pelos riscos concretos no fluxo; siga dependências quando
forem necessárias para avaliar uma hipótese.

Para cada achado, informe:

- gravidade: problema estrutural, preocupação a investigar ou observação;
- componentes e fronteira envolvidos;
- cenário que expõe o problema e requisito ou invariante afetado;
- evidência em código, com referências;
- consequência prática e o que ainda depende de prova.

Não recomende uma reescrita por preferência de estilo ou por uma evolução
hipotética sem requisito concreto. Se o tradeoff for intencional e documentado,
explique por que haveria um problema apesar dele. Buscas vazias não provam que
um consumidor ou proteção não existe.

Pare quando as hipóteses relevantes ao escopo estiverem verificadas ou seus
limites explicitados. Devolva os achados sustentados e as lacunas. Ausência de
achados é válida; ela descreve o alcance da revisão, sem certificar todo o
sistema.
