---
name: full-stop
description: "Levar uma mudança até uma PR verificada e pronta para merge, acompanhar revisão e CI e parar antes do merge. Use para /full-stop, em briefs de subagente que pedem PR pronta, ou quando o dev quer mergear ele mesmo."
---

# Full stop

Leve o trabalho até uma PR que o dev possa mergear sem reabrir nada, e pare
ali. O merge é do dev: na `main`, ele publica `platform/convex` e
`apps/console` em produção sem outra aprovação
([deploy-producao.md](../../../docs/operacao/deploy-producao.md)). Para ir até
o merge, o dev usa [full-send](../full-send/SKILL.md).

Pedir `full-stop` autoriza commit, push, abrir a PR, responder e resolver
threads dela. Não autoriza merge, fechar PR, publicar Convex ou Cloudflare,
nem ação no fisco.

## 1. Enquadre

Escreva em uma ou duas frases o que muda e a lista do que é "pronto". Leia
as seções do `AGENTS.md` e os contratos, ADRs e skills do domínio tocado.
Ambiguidade cara vai ao dev como uma pergunta com sua recomendação; a barata,
você resolve e declara a leitura escolhida.

Trabalhe numa branch a partir de `origin/main`, nunca na `main`. Num worktree,
`git switch main` falha porque a `main` está aberta no checkout principal.
Rode `git fetch origin && vp install --frozen-lockfile` antes de começar.

O passo termina com o critério de pronto escrito.

## 2. Implemente

Uma preocupação por PR; se a descrição precisa de "também", divida. Inclua
na mesma mudança os testes do comportamento alterado, o caso negado e o
isolamento entre organizações, projetos e empresas quando houver acesso, e a
documentação descritiva que o código altera. Percorra "Cubra todos os
caminhos" do `AGENTS.md`.

## 3. Revise o próprio diff

Revise `git diff origin/main...HEAD` com [code-review](../code-review/SKILL.md).
Quando a sessão permite subagentes, um revisor independente lê o diff e o
critério de pronto, sem o seu raciocínio. Some a lente do domínio:

| O diff toca | Carregue |
| --- | --- |
| XML, valores, chaves, emissão, captura, eventos ou guarda fiscal | [fiscal-review](../fiscal-review/SKILL.md) |
| Algo que o usuário vê no console ou no site | [ui-review](../ui-review/SKILL.md) |
| Código em `platform/convex/` | `convex-reviewer` e `platform/convex/_generated/ai/guidelines.md` |

Leia o código por trás de cada achado. Corrija os reais; registre o motivo
dos descartados. O passo termina quando uma leitura nova não traz achado
real.

## 4. Verifique

Siga [test-and-verify](../test-and-verify/SKILL.md) e produza o bloco de
verificação. Ele entra no corpo da PR e no relatório final.

## 5. Abra a PR

Commit com mensagem em pt-BR por arquivo (`git commit -F`), push e PR com
[file-pr](../file-pr/SKILL.md). Quando o host T3 oferecer
`link_pull_request`, vincule a PR logo depois de criá-la.

## 6. Acompanhe

Use [babysit-pr](../babysit-pr/SKILL.md) até os checks obrigatórios ficarem
verdes no último commit e todo achado ter resposta. Correções da revisão
passam de novo pelos passos 3 e 4 antes do push.

**Subagente delegado** não registra watch nem faz polling de PR: termine
depois do push e de responder ao que já chegou, e devolva ao pai o estado
pendente.

## 7. Pare

O fim é o relatório, não o merge. Em pt-BR:

- link e título da PR, SHA do head;
- estado dos checks e das revisões, achados aplicados e descartados com motivo;
- o bloco de verificação, com o que ficou não comprovado;
- se a PR toca um caminho de `.github/CODEOWNERS`;
- o que falta para o merge, ou "pronta para merge".

Um subagente termina com a linha:
`PR <URL completa>, head <SHA>, checks e revisões <estado>`.

## Pare e pergunte

Uma pergunta concisa com recomendação, seguindo no que não depende dela:

- comando Convex que publica funções, altera variáveis ou escreve fora do
  deployment local do worktree; recurso Cloudflare além do desenvolvimento;
- qualquer coisa da produção fiscal: gate de emissão, liberação de captura,
  `deploy/issuance-production.json`, workflows de gate ou chamada real ao fisco;
- credencial, certificado A1, CSC ou serviço pago;
- decisão que ADRs e contratos não resolvem e é cara de reverter
  (considere `council`);
- a mesma falha depois de duas tentativas honestas.
