---
name: code-review
description: "Revisar branch, PR ou alterações locais em dois eixos independentes: padrões do projeto e atendimento ao pedido ou especificação."
---

# Revisão de código em dois eixos

Uma mudança pode seguir os padrões e resolver o problema errado, ou cumprir
o pedido violando uma regra do projeto. Examine e relate os dois eixos
separadamente. Revisar produz achados; editar código ou publicar comentários
depende do escopo solicitado.

Leia [EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia) para as
convenções locais de documentação, ferramentas e autorização.

## 1. Fixar o escopo

Use a referência indicada pelo dev. Para uma PR, consulte sua base e seu head.
Para uma branch, use a base estabelecida pelo projeto e pelo contexto. Pergunte
apenas se houver alternativas plausíveis que mudem a revisão.

- **Commits de uma branch:** resolva as referências para SHAs e registre o
  merge-base. Inspecione `git diff <merge-base-sha> <head-sha>` e a lista de
  commits entre esses pontos.
- **Trabalho sem commit:** confira `git status --short`, `git diff` e
  `git diff --cached`; leia também os arquivos novos relevantes. Um diff de
  commits vazio não encerra esta revisão.
- **Branch com trabalho local incluído no pedido:** examine o diff da branch
  e as alterações locais, identificando de qual parte veio cada achado.

Confirme que as referências resolvem e que há mudanças no escopo. Preserve
arquivos locais e o índice. Se a árvore mudar durante a análise, releia os
trechos afetados antes de concluir.

## 2. Reunir as fontes dos dois eixos

**Padrões:** leia `AGENTS.md`, as instruções aplicáveis aos caminhos alterados
e os documentos que elas apontam. Confira ADRs pertinentes. Para código
Convex, leia primeiro as guidelines indicadas pelo projeto e use
[convex-reviewer](../convex-reviewer/SKILL.md) quando a revisão envolver suas
funções. Não crie um arquivo de padrões para poder revisar.

**Especificação:** use o pedido do dev e as decisões da conversa, além da
issue, especificação ou critérios de aceite fornecidos. Consulte referências
em commits e documentos relacionados quando necessário. Sem especificação
formal, o pedido ainda pode definir o resultado esperado. Se nenhuma fonte
definir esse resultado, registre a limitação e continue o eixo de padrões.

## 3. Examinar os eixos independentemente

Faça duas passagens separadas, uma por eixo. Uma revisão pequena pode ser
concluída diretamente; delegue quando a independência das frentes ou o volume
da mudança agregar valor e a sessão permitir. Nesse caso, use subagentes em
leitura, sem arquivos de saída compartilhados, com ferramentas e modelos
disponíveis na sessão. Cada revisor recebe as referências fixadas, a lista
de arquivos, acesso aos trechos locais incluídos e as fontes do seu eixo.
Na execução direta, registre cada eixo separadamente antes de consolidar;
na delegada, um eixo não recebe os achados do outro antes de terminar.

- **Revisor de padrões:** encontre violações documentadas, bugs e riscos
  introduzidos pela mudança. Cite a regra e o trecho quando houver violação.
  Trate as heurísticas abaixo como hipóteses, justificadas pelo impacto, sem
  impor refatoração por preferência. Use resultados de verificadores para
  regras mecânicas, sem reapresentá-las como descobertas independentes.
- **Revisor de especificação:** procure requisitos ausentes ou parciais,
  comportamento errado e ampliação de escopo. Relacione cada achado ao
  requisito ou decisão que o sustenta. Confira os caminhos afetados listados
  no `AGENTS.md`, conforme se apliquem à mudança.

Leia os chamadores e consumidores necessários para verificar cada hipótese.
Execute a menor prova local pertinente, com integrações simuladas. Informe
quais resultados foram observados e o que ficou sem execução.

Quando houver requisito ou alegação de desempenho, confira o protocolo e a
evidência conforme [performance-analysis](../performance-analysis/SKILL.md),
incluindo as condições da comparação e os limites da conclusão.

Amplie a leitura quando uma hipótese ou requisito ainda não verificado exigir
outro caminho. Conclua quando os dois eixos tiverem sido examinados no escopo,
os achados tiverem evidência e as lacunas estiverem explícitas. Resultado vazio
de uma busca não prova que um consumidor ou proteção inexiste; informe o
alcance da consulta quando isso limitar uma conclusão.

### Compatibilidade de contratos

Quando a mudança afetar API, SDK ou dados persistidos, confira consumidores
existentes além do diff de assinaturas:

- exports e caminhos, entradas aceitas, defaults, overloads e tipos inferidos;
- resultados, erros, ordenação, concorrência e ciclo de vida dos recursos;
- formatos serializados, protocolo e leitura de dados anteriores.

Uma quebra exige que um consumidor antes válido mude para continuar
compilando ou funcionando conforme o contrato anterior. Use as provas de
contratos, SDK e consumidor já existentes; quando inferência ou aceitação de
tipos fizer parte da mudança, prove esse comportamento com um consumidor
representativo. Um diff de OpenAPI ou typecheck aprovado não decide sozinho
a compatibilidade semântica. Registre migração necessária sem introduzir
outro processo de versionamento.

## Ruído, gates e operação

### Ruído introduzido pelo diff

Confira casts para `any` que escondem um erro de contrato, comentários que
repetem o código, condicionais excessivamente aninhadas e wrappers sem função
observável. Compare com o estilo e as responsabilidades dos arquivos vizinhos.
Relate o impacto concreto, sem transformar preferência de estilo em defeito.
Uma limpeza autorizada deve ser pequena e preservar comportamento; correção
de bug precisa ser identificada e verificada como tal.

Antes de sugerir a remoção de uma validação ou `try/catch`, rastreie a entrada
e o efeito protegido. Tipos internos não comprovam permissão nem estado atual.
Preserve verificações de membership, concessão, ambiente, idempotência e
histórico fiscal, além de comentários que explicam essas decisões.

### Gates e ambiente de desenvolvimento

Quando o diff mudar gates, autorização ou transporte, siga também as entradas
alternativas: console, REST, SDK, filas, reconciliação e execução agendada.
Confira o caso negado no servidor. Não conclua que esconder um botão protege
o efeito nem que uma função interna já recebeu autorização válida para sempre.

Mudanças em variáveis, portas, scripts, dependências ou configuração precisam
ser comparadas com o setup e a validação documentados. Identifique a nova
pré-condição e a menor prova local do caminho afetado. Leia
[deploy-producao.md](../../../docs/operacao/deploy-producao.md) quando o alvo
for CI ou publicação, sem executar deploy como parte da revisão.

Relacione os achados ao comportamento introduzido ou afetado pelo diff.
Leia consumidores fora dele para fechar a hipótese antes de reportar.
Uma remoção intencional não é, por si só, defeito, mas não elimina a análise
de efeitos não previstos ou de conflito com um ADR aceito.

## Heurísticas de design

Adaptadas de Martin Fowler. Os padrões e as decisões aceitas do projeto
prevalecem; nenhuma heurística abaixo exige sozinha uma alteração.

| Sinal | Pergunta para verificar o impacto |
| --- | --- |
| Nome impreciso | O nome oculta um comportamento ou invariante relevante? |
| Código duplicado | A mesma regra de domínio pode divergir entre entradas? |
| Feature Envy | A função precisa conhecer detalhes que outro módulo deveria proteger? |
| Data Clumps | Campos que sempre viajam juntos formam um conceito já existente? |
| Primitive Obsession | Falta um tipo que impeça um estado inválido real? |
| Condicionais repetidas | Uma política está sendo reimplementada em vários lugares? |
| Shotgun Surgery | Uma decisão exige mudanças espalhadas que podem ficar inconsistentes? |
| Divergent Change | O mesmo módulo acumula responsabilidades sem relação? |
| Speculative Generality | A abstração atende a algum requisito atual? |
| Message Chains | O chamador depende da organização interna de outro módulo? |
| Middle Man | A delegação protege um contrato ou só acrescenta indireção? |
| Refused Bequest | O implementador quebra as expectativas do contrato que assume? |

## 4. Conferir e apresentar os achados

Valide cada achado no código atual antes de repassá-lo. Agrupe por eixo,
ordenando por gravidade dentro de cada um. Para cada achado, apresente o
arquivo e a linha, o cenário que dispara o problema, o impacto e a evidência
ou regra que o sustenta. Separe defeitos de sugestões de design.

Informe as limitações de cada eixo e os checks executados. Ausência de achados
significa apenas que a revisão não encontrou problemas no escopo examinado.
Se o dev pediu também correções, verifique-as antes de encerrar; caso
contrário, entregue o relatório sem modificar o trabalho revisado.
