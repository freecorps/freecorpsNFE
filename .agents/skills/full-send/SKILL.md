---
name: full-send
description: "Levar uma mudança do pedido até a PR mergeada e publicada, conferindo o deploy depois do merge."
disable-model-invocation: true
---

# Full send

Faça todo o [full-stop](../full-stop/SKILL.md), passos 1 a 6, e depois mergeie
e confira a publicação. Só o dev dispara esta skill: invocá-la é o pedido
explícito de merge da PR desta tarefa, e merge na `main` é deploy em produção
de `platform/convex` e `apps/console`
([deploy-producao.md](../../../docs/operacao/deploy-producao.md)).

A autorização cobre uma PR, a desta tarefa, aberta por você. Não mergeia PR
de outra pessoa, não aprova PR (`gh` roda com a conta do dono) e não dispara
`Deploy production` à mão.

## 1. Gate de merge

Antes do merge, releia o estado atual e confira o gate do passo 8 de
[manager](../manager/SKILL.md#the-loop-for-every-unit-of-work):

- `Validate` verde no último commit; job que não rodou não é aprovação;
- todo achado respondido e toda thread resolvida;
- sua leitura final do diff inteiro passa, incluindo
  [ui-review](../ui-review/SKILL.md) quando há mudança visual e
  [fiscal-review](../fiscal-review/SKILL.md) quando o diff é fiscal;
- a PR ainda corresponde ao título e a uma preocupação só;
- a branch está atualizada com a `main` ou o merge não traz conflito.

Se um item falhar, volte ao full-stop. Se a PR toca a produção fiscal (gate de
emissão, captura, `deploy/issuance-production.json`), pare e pergunte mesmo
com tudo verde: o merge publica esse efeito.

## 2. Merge

```bash
gh pr merge <n> --squash
```

Nunca `--admin` nem outro desvio de proteção. Depois de timeout ou resposta
ambígua, leia o estado (`gh pr view <n> --json state,mergeCommit`) antes de
repetir.

## 3. Confira a publicação

Encontre o run de `Deploy production` do commit de merge e acompanhe até o
fim:

```bash
gh run list --workflow deploy.yml --commit <sha do merge> --json databaseId,status,conclusion,url
```

Um merge que só toca `undeployedPaths` termina com recibo
`state: "unchanged"`: é o resultado esperado, não falha. Quando houve
publicação, confira que `https://nfe.freecorps.com.br/build.json` e
`https://api.nfe.freecorps.com.br/health` servem o SHA do merge.

Run verde não prova a funcionalidade. Quando a mudança tem efeito observável
no hospedado (rota, tela, contrato), confira-o no ar sem escrever dados reais
e registre o que viu no bloco de [test-and-verify](../test-and-verify/SKILL.md).
Deploy vermelho é incidente: reporte ao dev no mesmo turno, com o run e o
passo que falhou. Revert, reexecução ou correção dependem do dev.

Depois, `bun run worktree:finish` no worktree concluído, se for um worktree
do projeto.

## 4. Relate

O relatório do full-stop, mais: SHA do merge, run de deploy e conclusão, o que
foi conferido no ar e o que não foi, e se tocou caminho de
`.github/CODEOWNERS`.
