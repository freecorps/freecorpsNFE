import { defineRule } from "vite-plus/lint/plugins";
import { unwrap } from "../lib/ast.mjs";

/**
 * Nos testes de navegador (`*.browser.test.tsx`), toda chamada `render(...)` é
 * `await using <nome> = await render(...)`. O `render` de
 * apps/console/test/render.tsx devolve um `AsyncDisposable`: com `await using`,
 * a tela desmonta ao fim do bloco mesmo quando o teste falha, e a página do
 * arquivo não leva a tela de um teste para o seguinte. O escopo vem do
 * override em vite.config.ts.
 */
const disposed = (call) => {
  const awaited = call.parent;
  const declarator = awaited?.type === "AwaitExpression" ? awaited.parent : null;
  return (
    declarator?.type === "VariableDeclarator" &&
    declarator.init === awaited &&
    declarator.parent?.type === "VariableDeclaration" &&
    declarator.parent.kind === "await using"
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Exige `await using` em cada render dos testes de navegador.",
      url: "docs/desenvolvimento/lint.md#require-disposable-render",
    },
    messages: {
      render:
        "`render(...)` sem `await using`. Escreva `await using screen = await render(...)`: a tela desmonta ao fim do bloco mesmo quando o teste falha.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee?.type !== "Identifier" || callee.name !== "render" || disposed(node)) return;
        context.report({ node, messageId: "render" });
      },
    };
  },
});
