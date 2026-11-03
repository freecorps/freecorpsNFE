---
name: ci-maintenance
description: "Criar ou revisar workflows GitHub Actions, incluindo eventos, permissões, revisões testadas, artefatos e concorrência."
---

# Manutenção do CI

Leia `docs/operacao/deploy-producao.md` antes de alterar CI e consulte
`docs/desenvolvimento/ci.md` para os workflows, gatilhos e runners
existentes. Origem e adaptações estão em
[EXTERNAS.md](../EXTERNAS.md#importação-do-t3-code-em-20102026).

Revisão produz achados; implementação faz a menor mudança dentro do pedido.
Identifique os workflows, actions reutilizadas e chamadores afetados.

## Conferir cada job afetado

Registre evento, origem do autor/fork, revisão do workflow, revisão obtida
pelo checkout, permissões, credenciais e entradas externas. Inclua caches,
artefatos, outputs, campos de PR, refs e parâmetros de dispatch.

- Conceda somente as permissões necessárias por job, partindo de permissões
  vazias quando aplicável. Confira persistência de credenciais no checkout.
- Fixe actions externas e workflows reutilizáveis por SHA completo,
  identificando a release em comentário e verificando a correspondência.
- Reutilize o setup existente quando os ambientes forem equivalentes;
  derive Bun, instalação e validação dos arquivos atuais.
- Passe expressões não confiáveis por variáveis de ambiente. Valide os
  valores e use o escape e as aspas adequados ao shell antes de executá-los.
- Defina timeouts e matrizes coerentes com o trabalho executado. Escolha
  concorrência pela possibilidade de interromper o job com segurança.
- Distinga SHA da PR, merge sintético e revisão publicada. Preserve a
  verificação de identidade entre código validado e publicado.

Para forks, credenciais privilegiadas, publicação ou dados de outra execução,
leia [privileged-workflows.md](privileged-workflows.md).

Consulte a documentação atual do GitHub para decisões sobre eventos,
tokens, secrets, environments, artefatos e workflows reutilizáveis. Exemplos
locais indicam convenções, mas não substituem a semântica da plataforma:

- [Eventos](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Sintaxe](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [Uso seguro](https://docs.github.com/en/actions/reference/security/secure-use)

## Verificar a mudança

Execute os verificadores existentes para os caminhos alterados e os checks
finais do `AGENTS.md`. Inspecione o diff completo e confira os chamadores.
Separe resultados locais do comportamento que só foi observado no GitHub.

Se um runner não iniciar ou houver limite de uso, registre o bloqueio.
Não transforme ausência de execução em aprovação ou falha do código.
Alterar o workflow não autoriza disparar publicação ou modificar secrets.
