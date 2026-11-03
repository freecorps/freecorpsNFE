# Template de explicação

Use para escrever a partir da leitura direta ou integrar achados delegados.
Nenhuma dessas formas exige um agente separado para explicar.

## Contexto

- Pergunta original: {QUESTION}
- Escopo, revisão e arquivos relevantes: {CODE_SCOPE}
- Fluxo rastreado e fontes: {FINDINGS}
- Lacunas e limites de verificação: {LIMITS}

## Procedimento

Confira o código nas conexões entre os componentes e nos pontos em que os
achados divergem. Resolva contradições pela fonte, sem escolher apenas a
descrição mais convincente. Expanda a leitura somente para esclarecer uma
lacuna que afete a pergunta.

Escreva em pt-BR para alguém que precisa entender e trabalhar nessa área.
Comece pela resposta, depois explique a sequência da entrada ao resultado,
as decisões e os efeitos. Cite arquivos e funções junto aos fatos que
sustentam. Inclua caminhos alternativos pertinentes, especialmente se a
pergunta tratar de falhas, permissões ou retentativas.

Apresente os conceitos necessários conforme surgirem. Um mapa de arquivos ou
diagrama pode esclarecer um fluxo com vários componentes; omita-o quando a
prosa já bastar. A pergunta simples dispensa seções fixas e inventário de tudo
o que foi lido.

Separe o comportamento atual de propostas e de motivação histórica. Para
intenção, cite o registro ou identifique a inferência. Não apresente código
lido como comportamento observado em execução.

Antes de concluir, verifique cada parte da pergunta e cada transição relevante.
Complete uma etapa ainda acessível que falte ao fluxo; quando não for possível,
declare a lacuna e a fronteira da explicação. Pare quando a resposta estiver
sustentada no escopo pedido, sem exigir exploração de módulos não relacionados.
