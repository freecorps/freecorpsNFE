# Comparar alternativas de interface

Use quando o problema justificar explorar mais de um desenho. A técnica vem
de John Ousterhout: comparar alternativas ajuda a perceber custos que a
primeira ideia esconde.

## Delimitar o problema

Registre o comportamento esperado, as invariantes, os chamadores atuais e as
dependências, usando [DEEPENING.md](DEEPENING.md) quando necessário. Uma pequena
assinatura ou exemplo pode tornar as restrições concretas sem fixar a solução.

## Produzir alternativas

Explore duas ou três opções que variem uma decisão relevante. Por exemplo:

- reduzir o conhecimento exigido de todos os chamadores;
- simplificar o caminho mais comum preservando os casos existentes;
- isolar o transporte externo da regra de domínio.

Quando a delegação estiver disponível e permitida pela sessão, use subagentes
independentes em leitura, com o mesmo contrato e restrições. Dimensione a
quantidade pelos recursos disponíveis. Sem delegação, compare as alternativas
na própria sessão. Evite exploração de extensões que o pedido não exige.

Cada proposta precisa mostrar a interface, um exemplo de uso, os detalhes que
esconde, a estratégia de testes, o custo de migrar chamadores e as limitações.
Use os termos do domínio definidos no projeto e o vocabulário de
[SKILL.md](SKILL.md) para a discussão de arquitetura.

## Comparar e recomendar

Compare complexidade para os chamadores, localidade da mudança, invariantes
protegidas e esforço de migração. Recomende a opção que atende ao pedido com
menos complexidade total. Combine partes de propostas apenas quando o
resultado mantiver essas propriedades. Implemente conforme o escopo autorizado
e esclareça antes uma escolha que altere materialmente o contrato esperado.
