---
name: statechart
description: "Verificar um modelo finito de estados com TLC/TLA+ e explicar transições e contraexemplos em Mermaid. Use para investigar ordens de eventos, concorrência e invariantes de um fluxo."
---

# Verificar e desenhar estados

Modele a regra que importa ao leitor, execute o verificador e desenhe o que
foi observado. Esta adaptação usa TLC diretamente e Mermaid escrito a partir
do modelo e dos traces. Não inclui o gerador automático de diagramas do
pstack nem exige mise ou Pele.

## Preparar o modelo

Trabalhe em diretório temporário fora do repositório, com dados sintéticos.
Para manter uma verificação vinculada ao produto, use
[create-formal-verification-skill](../create-formal-verification-skill/SKILL.md).
Leia [execução do TLC](references/tlc.md) ao preparar a ferramenta ou precisar
de um modelo mínimo para conferir o ambiente.

- Escreva as regras como invariantes ou propriedades temporais explícitas.
  Modele as variáveis necessárias à regra, sem enfraquecê-la para passar.
- Dê nome às ações e escreva `Next` como sua disjunção, preservando os passos
  concorrentes reais. Documente atomicidade e hipóteses sobre o transporte.
- Limite constantes e domínios para terminar a exploração. Um limite é parte
  da conclusão; uma execução interrompida não prova a propriedade.
- Represente término válido por um passo que não altera estado, habilitado
  apenas nos estados terminais. Isso permite manter a detecção de deadlock
  para os demais estados.
- Registre restrições de estado/ação, simetria e fairness quando usadas e
  explique como restringem os comportamentos verificados.

## Executar e interpretar

Guarde modelo, configuração, versões, comando, saída completa e exit code.
Confira também a mensagem final: erro de sintaxe, limite, interrupção ou
falha da ferramenta não são aprovação nem contraexemplo do domínio.

TLC normalmente interrompe na primeira violação. Para investigar outra regra,
execute uma configuração diagnóstica separada, preservando a original e
registrando quais propriedades foram retiradas. Não apresente esse passe
como aprovação do conjunto original. Enumere as propriedades não concluídas.
Um trace observado não garante que todos os defeitos foram encontrados.

## Desenhar e explicar

Use `stateDiagram-v2` do Mermaid. Nomeie estados e setas pelo efeito que o
leitor entende, como "Em reconciliação" e "Resposta anterior chegou". Para
um contraexemplo, mantenha a ordem e os estados do trace e identifique a
regra violada. Diferencie transições observadas das extraídas apenas do modelo.

Simplifique rótulos apenas quando isso preservar a distinção entre estados
seguros e estados que violam regras. Informe agrupamentos e passos ocultos;
não una violações diferentes num único estado aparentemente equivalente.
Um desenho parcial ou de contraexemplo não representa todo o grafo explorado.
Use o renderizador disponível na sessão quando a visualização ajudar; o
Mermaid e os artefatos devem continuar disponíveis para revisão.

Relate o resultado por propriedade, as hipóteses, limites, contagem de estados
informada pelo TLC e o caminho da falha quando houver. Para um modelo de
código, confira se esse caminho ocorre na implementação antes de afirmar
que encontrou um bug real. A aprovação cobre somente o modelo configurado.
