---
name: codebase-design
description: "Projetar interfaces e responsabilidades de módulos, reduzir acoplamento e definir onde testar comportamentos. Use em decisões de design ou refatoração de código."
---

# Design de módulos

Procure módulos que escondem decisões difíceis atrás de uma interface simples.
Use estes conceitos para avaliar o problema solicitado, sem iniciar uma
reestruturação geral do projeto.

Leia [EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia) para as
convenções locais. Preserve a linguagem do domínio e as decisões aceitas;
o vocabulário abaixo ajuda a discutir design, sem renomear conceitos fiscais.

## Vocabulário

- **Módulo:** código com uma interface e uma implementação. Pode ser uma
  função, um conjunto de funções ou um pacote; não pressupõe classes.
- **Interface:** tudo que o chamador precisa saber, incluindo tipos,
  invariantes, ordem de operações, falhas, configuração e custos relevantes.
  É mais ampla que uma assinatura TypeScript.
- **Implementação:** decisões escondidas atrás dessa interface.
- **Profundidade:** quanto comportamento útil o módulo oferece em relação
  ao que seus chamadores precisam conhecer. Quantidade de linhas não mede isso.
- **Ponto de substituição, ou seam:** lugar onde se pode trocar comportamento
  sem editar quem o usa, por exemplo o transporte fiscal real e o simulado.
- **Adaptador:** implementação concreta de um contrato nesse ponto.
- **Localidade:** capacidade de concentrar uma mudança ou investigação perto
  da decisão responsável pelo comportamento.

## Critérios de avaliação

1. Liste os chamadores, o comportamento exigido e as invariantes que a
   interface precisa proteger. Reutilize contratos existentes quando bastarem.
2. Pergunte que complexidade o módulo esconde. Se removê-lo espalharia regras
   pelos chamadores, ele tem utilidade. Se só eliminar uma passagem sem
   responsabilidade, talvez seja dispensável.
3. Considere reduzir parâmetros, operações e conhecimento exigido do chamador.
   Uma interface menor só é melhor se continuar expressando os estados e
   restrições necessários.
4. Justifique pontos de substituição por variação real, como transporte de
   produção e teste. Não exponha detalhes internos só para que testes possam
   acessá-los, nem adicione adaptadores sem necessidade demonstrada.
5. Compare o custo da migração com a complexidade removida. Prefira a menor
   mudança que torna o comportamento correto previsível.

## Testabilidade

Separe cálculos e decisões de domínio das operações externas. Funções puras
podem retornar resultados; mutations e actions continuam responsáveis pelos
efeitos necessários. Injeção de dependências é uma opção nas bordas, não uma
exigência de substituir o contexto ou os padrões do Convex.

Teste resultados observáveis pelo contrato adequado. O projeto também precisa
de testes focados de XML, assinatura, transporte e políticas fiscais; uma
interface de nível mais alto não torna essas provas automaticamente inúteis.
Preserve os testes existentes até demonstrar que a nova cobertura protege os
mesmos comportamentos e regressões.

Ao definir a prova, use as interfaces já estabelecidas pelo pedido, código e
testes. Pergunte ao dev quando existir uma decisão de contrato materialmente
ambígua, sem exigir nova confirmação para cada teste ou ajuste interno.

## Referências conforme a tarefa

- Para reunir responsabilidades hoje espalhadas, leia
  [DEEPENING.md](DEEPENING.md): dependências, migração e cobertura.
- Para comparar alternativas de interface, leia
  [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md): propostas independentes e critérios
  de comparação. Essa exploração não autoriza implementar todas as propostas.
