# Workflows privilegiados

Jobs com secrets ou credenciais de escrita devem executar apenas código da
origem e revisão autorizadas para aquele contexto. Examine em conjunto o
evento, o checkout e os dados consumidos; um evento privilegiado não torna
o conteúdo de uma PR confiável.

Antes de consumir artefatos ou outputs de outra execução, confira repositório,
workflow, execução e revisão esperados, além de tipo, formato e tamanho dos
dados. Valide também caminhos antes de extrair ou executar arquivos.

Preserve a separação entre validação sem credenciais de produção e publicação
da revisão aprovada. Reutilize as proteções atuais para trabalhos de forks.

A publicação em andamento precisa terminar suas etapas e verificações.
Preserve o grupo de concorrência e a política de não cancelamento descritos
em `docs/operacao/deploy-producao.md`. Checks substituíveis podem ter outra
política.

Confira as permissões de cada chamador de workflow reutilizável e o repasse
de secrets. Documente qualquer diferença necessária em relação ao fluxo atual.
