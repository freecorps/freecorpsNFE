---
name: to-tickets
description: "Dividir uma especificação, plano ou conversa em tickets verificáveis com dependências explícitas."
disable-model-invocation: true
---

# Do plano aos tickets

Divida o trabalho em entregas pequenas que percorram o caminho necessário para
um comportamento funcionar. Cada ticket declara seus critérios de aceite e
quais tickets realmente o bloqueiam.

Leia [EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia) para as fontes
do domínio, arquivos locais e publicação no tracker.

## Procedimento

1. Leia o plano ou especificação fornecida e as decisões da conversa. Se a
   referência for uma issue, leia também os comentários pertinentes. Sem um
   documento formal, use o pedido e registre as lacunas que afetem a divisão.
2. Confira os contratos e o código necessários para estimar dependências
   reais. Proponha uma refatoração preparatória somente se ela for necessária
   para a mudança; criação de tickets não inicia essa refatoração.
3. Divida em entregas verificáveis, pequenas o bastante para uma sessão.
   Inclua schema, API, UI e testes somente quando o comportamento os exigir.
   Não crie um ticket para cada camada se nenhum puder ser validado sozinho.
4. Mostre a divisão com título, resultado e bloqueadores. Use a granularidade
   já acordada. Se houver uma escolha material de escopo ou dependências,
   peça esclarecimento com a proposta concreta; ajustes rotineiros não exigem
   uma rodada obrigatória de aprovação.
5. Salve os tickets locais ou publique no destino autorizado, com bloqueadores
   primeiro. Confira identificadores, relações e critérios de aceite antes
   de informar os caminhos ou URLs.

## Dependências

O grafo deve ser acíclico. Um bloqueio significa que a outra entrega precisa
terminar antes de esta começar, não apenas que ambas tratam do mesmo assunto.
Tickets sem bloqueadores podem avançar independentemente. Pendências de
produto ou acesso precisam aparecer como impedimentos explícitos.

Em refatorações amplas que não permitem entregas verticais independentes, use
uma sequência compatível: introduzir a forma nova mantendo a antiga, migrar
consumidores em lotes verificáveis e remover a antiga depois. Se os lotes só
puderem funcionar juntos, explicite a branch de integração e a prova final;
não prometa que cada lote está pronto para merge. Mudanças em dados persistidos
seguem as políticas de migração do projeto.

## Destino e relações

- **Arquivos locais:** um arquivo por ticket, numerado em ordem de dependência
  no diretório de planejamento definido em `EXTERNAS.md`. Use links relativos
  para a especificação e os bloqueadores, mantendo identificadores estáveis.
- **GitHub:** uma issue por ticket, criada em ordem de dependência. Use relações
  nativas de bloqueio quando disponíveis; caso contrário, liste links no corpo.
  Relacione à issue de origem no corpo. Criar sub-issues ou alterar relações na
  issue pai exige que esse vínculo faça parte do escopo autorizado.

Consulte os labels reais conforme `EXTERNAS.md`; disponibilidade para execução
é uma avaliação do ticket, não um label obrigatório. Preserve o conteúdo e o
estado da issue pai. Em falha parcial, registre as issues já criadas e retome
a partir delas, sem duplicar tickets.

## Conteúdo de cada ticket

- **Título:** curto e descritivo em pt-BR.
- **Origem:** especificação ou decisão que justifica a entrega.
- **O que entregar:** comportamento observável e limites da fatia.
- **Critérios de aceite:** condições verificáveis, incluindo erro ou recusa
  quando aplicáveis.
- **Verificação:** menor prova apropriada e referências aos testes existentes.
- **Bloqueado por:** links ou identificadores dos bloqueadores, ou nenhum.
- **Pendências:** o que falta resolver antes da implementação, se houver.

Links para contratos e código existente ajudam a localizar o trabalho. Inclua
trechos de código apenas quando fixarem uma decisão melhor que a descrição.
Criar tickets não autoriza executá-los, fazer commit ou fechar a issue pai.
