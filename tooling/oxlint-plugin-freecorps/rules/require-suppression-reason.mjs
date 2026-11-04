import { defineRule } from "vite-plus/lint/plugins";
import { memberPath, unwrap } from "../lib/ast.mjs";

/**
 * Toda supressão diz por quê:
 *
 * - `eslint-disable*` e `oxlint-disable*` (o oxlint respeita os dois) terminam
 *   em `-- <motivo>`, com pelo menos 10 caracteres;
 * - `it`/`test`/`describe`/`suite` com `.skip` ou `.todo` têm, logo acima,
 *   `// quarantine: #<issue> <motivo>`. `skipIf`/`runIf` ficam de fora: a
 *   condição já diz quando o teste não roda.
 */
const DIRECTIVE = /^\s*(eslint|oxlint)-disable(-next-line|-line)?\b/;
const REASON = /\s--\s+(\S.{9,})$/;
const QUARANTINE = /^\s*quarantine:\s*#\d+\s+\S.{9,}$/;
const RUNNERS = new Set(["it", "test", "describe", "suite"]);
const SKIPS = new Set(["skip", "todo"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Exige motivo nas supressões de lint e nos testes pulados.",
      url: "docs/desenvolvimento/lint.md#require-suppression-reason",
    },
    messages: {
      directive:
        "`{{directive}}` sem motivo. Termine com `-- <motivo>` (10+ caracteres) dizendo por que a regra não vale aqui.",
      skip: "`{{call}}` sem quarentena. Ponha acima `// quarantine: #<issue> <motivo>` (motivo com 10+ caracteres).",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          const value = comment.value.replace(/\*\/?$/, "").trim();
          const directive = DIRECTIVE.exec(value);
          if (directive && !REASON.test(value.replace(/\s*\n\s*\*?\s*/g, " ")))
            context.report({
              node: comment,
              messageId: "directive",
              data: { directive: `${directive[1]}-disable${directive[2] ?? ""}` },
            });
        }
      },
      CallExpression(node) {
        const path = memberPath(unwrap(node.callee));
        if (!path || path.length < 2 || !RUNNERS.has(path[0]) || !SKIPS.has(path[1])) return;
        let statement = node;
        while (
          statement.parent &&
          statement.parent.type !== "Program" &&
          statement.parent.type !== "BlockStatement"
        )
          statement = statement.parent;
        const above = sourceCode.getCommentsBefore(statement).at(-1);
        if (above && QUARANTINE.test(above.value)) return;
        context.report({ node, messageId: "skip", data: { call: path.slice(0, 2).join(".") } });
      },
    };
  },
});
