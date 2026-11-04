---
name: ui-review
description: "Avaliar visual e funcionalmente uma tela ou mudança do console ou do site rodando a interface de verdade: temas, larguras, estados, teclado, acessibilidade e status honesto. Use antes de PR com mudança visível ou para revisar uma tela."
---

# Revisão de interface

O console diz ao usuário o que aconteceu com um documento fiscal e o que ele
pode fazer em seguida. Interface que só funciona é reprovada. As referências
são [DESIGN.md](../../../DESIGN.md) e
[frontend.md](../../../docs/desenvolvimento/frontend.md); este roteiro aplica
as duas a uma mudança concreta, olhando a tela rodando. Ler o diff não é
revisão visual.

| Trabalho | Carregue também |
| --- | --- |
| Qualquer tela | `design-taste-frontend` e `emil-design-eng` |
| Dados extremos | `break-ui` |
| Movimento | `review-animations` |
| Dependência nova de UI | `pick-ui-library` |
| Toasts | `ask-sonner` |

## 1. Delimite

Liste as rotas e componentes tocados (`apps/console/src/routes.tsx` tem as
rotas) e, para cada um, os estados que existem: carregando, vazio, erro, dados
parciais, sem permissão, contagem enorme, nome longo de empresa e documento.
Inclua cada ambiente fiscal que a tela distingue.

## 2. Rode

Use um worktree preparado com `bun run dev` (consulte
[navegador.md](../../../docs/desenvolvimento/navegador.md) para preflight,
trava do navegador e contas sintéticas). Quando a área já tem jornada em
`apps/console/e2e/`, rode-a: ela traz axe e recibo. Para a tela nova ou o
estado que a jornada não cobre, abra no navegador pelas ferramentas de
preview da sessão ou pelo Playwright.

Capture a mesma tela com os mesmos dados sintéticos nesta matriz:

- tema Claro e Escuro, e Sistema seguindo o sistema operacional;
- 1440 px e 375 px de largura;
- antes (na `origin/main`) e depois, quando a tela já existia.

## 3. Exercite

- Teclado do início ao fim: ordem do Tab, foco visível, diálogo prende e
  devolve o foco, Esc fecha, abas por setas.
- Rota aberta direto pela URL, recarga e voltar do navegador preservam o
  estado esperado; filtros sobrevivem à navegação.
- Ações assíncronas: botão desabilita durante o envio, erro do servidor
  aparece junto do campo ou da ação, repetir o clique não duplica efeito.
- axe sem violação nas telas tocadas, nos dois temas.
- `prefers-reduced-motion` ligado: nada essencial depende da animação.

## 4. Aplique o padrão

Reprove se qualquer item falhar:

- **Temas:** Claro e Escuro parecem projetados; o escuro é de primeira classe.
- **Língua:** toda string visível em pt-BR com acentos corretos, sem cortar,
  quebrar mal ou vazar.
- **Estados:** todos os do passo 1 desenhados, nenhum cai num padrão genérico.
- **Status honesto:** nada sugere sucesso enquanto a operação ou o fisco não
  respondeu. Rejeição, timeout e reconciliação se leem diferentes de sucesso.
- **Ambiente à vista:** sandbox, homologação e produção são inconfundíveis, e
  cor nunca é o único sinal; vem com texto ou ícone.
- **Formatos:** datas e dinheiro passam por `apps/console/src/format.ts`;
  data fiscal não muda com o fuso do navegador.
- **375 px:** sem rolagem horizontal; alvos de toque com pelo menos 44 px.
- **Acessibilidade:** texto e cores de status atingem WCAG AA nos dois temas.
- **Tokens:** espaço, tipo, raios e cores de `apps/console/src/ui/tokens.css`,
  componentes de `apps/console/src/ui/`. Nenhum valor avulso.
- **Movimento** tem propósito e nunca atrasa uma ação.
- **Segurança da tela:** XML e texto de terceiros renderizados como texto;
  nenhum token, chave ou PFX em URL ou armazenamento do navegador.

## 5. Relate

Cada achado com tela, tema e largura, o que está errado e a correção com
valores exatos ("o badge de rejeição usa só cor; acrescente o ícone
`AlertTriangle` e o texto `Rejeitada`"). "Parece bom" não é revisão.

Termine com **Aprovada** ou **Reprovada** e as evidências:

- capturas da matriz do passo 2 em `.ci-results/<assunto>/`, ou no diretório
  de evidência conforme
  [EVIDENCE-STORAGE.md](../../../docs/v1.0/EVIDENCE-STORAGE.md), com a
  conclusão escrita no texto, não só na imagem;
- o resultado do axe e de `horizontalOverflow` por tela;
- as linhas correspondentes no bloco de
  [test-and-verify](../test-and-verify/SKILL.md).

A revisão termina quando toda rota e estado do passo 1 foi visto nos dois
temas e nas duas larguras, ou consta como não visto com o motivo.
