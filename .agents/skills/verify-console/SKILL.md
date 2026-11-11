---
name: verify-console
description: "Verificar no navegador as telas principais do console local (organização, empresas, documentos, chaves de API e webhooks) nos estados dados, vazio, carregando e erro, com capturas antes e depois de uma mudança. Use ao conferir uma mudança visível do console num worktree."
---

# Verificar o console local

Roteiro para conferir, num worktree da plataforma, como as telas principais do
console ficam antes e depois de uma mudança. Os scripts estão em
[`scripts/`](scripts/) e gravam tudo em `.ci-results/verify-console/`, fora do
Git. Rode cada comando da raiz do worktree. As jornadas cobertas e seus
limites estão em [`features/README.md`](features/README.md).

Regras que valem em todos os passos:

- **Dados sintéticos.** A conta, as organizações e a NF-e vêm de
  `seed-account.mjs`, pelo caminho real de cadastro e importação. Capturas e
  relatórios ficam locais: não os anexe com credenciais, e o `account.json`
  (e-mail e senha da conta sintética) nunca sai da máquina.
- **Processos.** Encerre só o que esta skill iniciou, pelo PID que
  `start-dev.mjs` gravou e com a identidade conferida, usando `stop-dev.mjs`.
  Processos de outros worktrees e um dev que já rodava antes ficam como estão.
- **Uma jornada por vez.** Os scripts usam a trava de navegador do worktree
  (`withLocalBrowser`); feche outras abas deste console antes de começar.

## 1. Preparar

1. `bun run worktree status --json`. Se `setup` não for `succeeded`, aguarde
   com `bun run worktree wait --timeout-ms 600000`; num checkout sem setup,
   rode `bun run worktree:setup` antes.
2. `node .agents/skills/verify-console/scripts/start-dev.mjs`. Ele reaproveita
   o dev que já roda ou inicia um, e termina quando o preflight do navegador
   confirma backend e frontend deste worktree.

Pronto quando o script imprime `dev: pronto em http://localhost:<porta>`. Se
ele sair com erro, leia `.ci-results/verify-console/dev.log` e relate o
bloqueio; não siga para os passos seguintes.

## 2. Ter a conta sintética

`node .agents/skills/verify-console/scripts/seed-account.mjs`

Na primeira vez cria a conta (cadastro, código do coletor local, verificação,
login) e, como a própria conta:

- a organização "Verificação do console", com a empresa de demonstração, um
  projeto, uma chave de API, um webhook e uma NF-e sintética importada pela
  REST;
- a "Organização vazia".

Nas seguintes, reaproveita `account.json` enquanto a conta entrar e as duas
organizações existirem. A espera inicial de 65 segundos é o ritmo do login
local, não uma falha.

Pronto quando imprime `seed: organizações ... ` ou `seed: conta e organizações
reaproveitadas`.

## 3. Capturar antes da mudança

Antes de aplicar a mudança, ou num worktree da base com o próprio dev e a
própria conta:

`node .agents/skills/verify-console/scripts/capture-screens.mjs --label antes`

O script entra pela tela de login e percorre as cinco telas nos quatro estados:

| Estado     | Como aparece                                                        |
| ---------- | ------------------------------------------------------------------- |
| dados      | Organização com dados                                               |
| vazio      | Organização vazia                                                   |
| carregando | URL de dados com as respostas do Convex retidas no navegador         |
| erro       | Organização, empresa ou projeto forjado, que o backend recusa        |

Para cada captura grava o PNG, o que a tela mostrou (título, carregamento,
alerta), o veredito e as violações do axe em
`.ci-results/verify-console/capturas/antes/report.json`. `--screen <id>` e
`--state <estado>` refazem só parte da rodada. Pronto quando o relatório tem
`result` e as 20 capturas.

## 4. Capturar depois da mudança

Volte a mudança para a árvore e repita com `--label depois`. Com o dev aberto,
o Vite recarrega o frontend; mudança em `platform/convex/` é publicada pelo
`convex dev` do próprio dev.

## 5. Comparar e relatar

Abra os PNG de `capturas/antes/` e `capturas/depois/` lado a lado, tela por
tela e estado por estado, e compare os dois `report.json`. Relate no formato de
[test-and-verify](../test-and-verify/SKILL.md):

- cada estado conferido, com o veredito do relatório e o que mudou na imagem;
- `divergente` e violações do axe novas como achados, com o caminho da
  captura;
- `não exercitado` com o motivo, sem simular o estado por outro caminho.

A verificação termina quando cada uma das 20 capturas da rodada `depois` tem
veredito e comparação com a `antes`.

## 6. Encerrar

`node .agents/skills/verify-console/scripts/stop-dev.mjs`

Ele pede a parada ao supervisor do dev, que encerra Convex e Vite e libera a
trava do worktree; só se o dev não sair no prazo encerra a árvore daquele PID.
Se o dev já rodava antes da skill, nada é encerrado. Rode mesmo quando um passo
anterior falhou.

Pronto quando o script imprime `dev encerrado` ou explica por que não encerrou,
e `bun run worktree status --json` não mostra operação `dev` em andamento
iniciada pela skill. As capturas e os relatórios continuam em
`.ci-results/verify-console/` para a revisão.
