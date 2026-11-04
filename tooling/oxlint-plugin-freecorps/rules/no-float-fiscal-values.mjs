import { defineRule } from "vite-plus/lint/plugins";
import { memberPath, propertyName, unwrap } from "../lib/ast.mjs";

/**
 * Valores fiscais são texto decimal exato e só se calculam com os helpers de
 * `packages/fiscal-core` (AGENTS.md, §3). Sem tipos na AST, "valor fiscal" é
 * reconhecido pelo nome (docs/desenvolvimento/lint.md#no-float-fiscal-values):
 *
 * - nomes fortes, em qualquer contexto: tags de valor da NF-e/NFS-e (`vNF`,
 *   `vProd`, `vUnCom`), alíquotas (`pICMS`), quantidades (`qCom`) e os campos
 *   do contrato listados em `STRONG_NAMES`;
 * - nomes genéricos (`value`, `total`, `amount`, `quantity`, `rate`) só como
 *   propriedade de um contêiner fiscal (`payload.total`, `amount.value`,
 *   `items[i].quantity`), para não confundir `event.total` de um upload ou o
 *   `rate` de um limite de requisições.
 */
const STRONG_PATTERNS = [
  /^v(NF|Prod|BC|ICMS|IPI|PIS|COFINS|ISS|FCP|ST|Frete|Seg|Desc|II|Outro|TotTrib|Un|Serv|Liq|Pag|Dup|Orig|Troco|Ded|Ret|CSLL|IRRF|INSS|IR|CP|Trib|Cred|Receb|Tot|Item|Aliq|Imp|Red)[A-Za-z0-9]*$/,
  /^p(ICMS|IPI|PIS|COFINS|ISS|FCP|MVA|Red|CredSN|Aliq)[A-Za-z0-9]*$/,
  /^q(Com|Trib)$/,
];
const STRONG_NAMES = new Set([
  "unitPrice",
  "tributaryUnitPrice",
  "tributaryQuantity",
  "brlAmount",
  "serviceBrl",
  "issRate",
]);
const GENERIC_NAMES = new Set(["value", "total", "amount", "quantity", "rate"]);
const CONTAINERS = new Set([
  "amount",
  "payload",
  "tax",
  "taxes",
  "totals",
  "item",
  "items",
  "service",
  "conversion",
  "values",
  "declaredTotals",
]);
const CONVERTERS = new Set(["Number", "parseFloat", "parseInt"]);
const ARITHMETIC = new Set(["-", "*", "/", "%", "**"]);
const ASSIGNMENTS = new Set(["+=", "-=", "*=", "/=", "%=", "**="]);

const strong = (name) => STRONG_NAMES.has(name) || STRONG_PATTERNS.some((p) => p.test(name));

/** Último nome do objeto de um acesso: `a.items[0]` → "items", `amount` → "amount". */
function containerName(node) {
  const target = unwrap(node);
  if (target?.type === "Identifier") return target.name;
  if (target?.type !== "MemberExpression") return null;
  if (target.computed) return containerName(target.object);
  return propertyName(target);
}

/** Nome fiscal da expressão, ou null quando ela não é um valor fiscal reconhecível. */
export function fiscalName(node) {
  const target = unwrap(node);
  if (target?.type === "Identifier") return strong(target.name) ? target.name : null;
  if (target?.type !== "MemberExpression") return null;
  const name = propertyName(target);
  if (name === null) return null;
  if (strong(name)) return name;
  if (GENERIC_NAMES.has(name) && CONTAINERS.has(containerName(target.object) ?? ""))
    return (memberPath(target) ?? [name]).join(".");
  return null;
}

const isText = (node) => {
  const target = unwrap(node);
  return (
    (target?.type === "Literal" && typeof target.value === "string") ||
    target?.type === "TemplateLiteral"
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Proíbe ponto flutuante sobre valores fiscais fora de packages/fiscal-core (AGENTS.md, §3).",
      url: "docs/desenvolvimento/lint.md#no-float-fiscal-values",
    },
    messages: {
      convert:
        "`{{call}}({{name}})` passa o valor fiscal por ponto flutuante. Use `decimal`/`quantize` de @freecorps/fiscal-core.",
      method:
        "`{{name}}.{{method}}()` trata o valor fiscal como número. Use `quantize` de @freecorps/fiscal-core.",
      arithmetic:
        "Operação `{{operator}}` sobre o valor fiscal `{{name}}`. Use `add`/`multiply` de @freecorps/fiscal-core.",
    },
    schema: [],
  },
  create(context) {
    const report = (node, messageId, data) => context.report({ node, messageId, data });
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const path = memberPath(callee);
        const call =
          callee.type === "Identifier" && CONVERTERS.has(callee.name)
            ? callee.name
            : path?.length === 2 &&
                ((path[0] === "Number" && /^parse(Float|Int)$/.test(path[1])) || path[0] === "Math")
              ? path.join(".")
              : null;
        if (call) {
          for (const argument of node.arguments) {
            const name = fiscalName(argument);
            if (name) report(node, "convert", { call, name });
          }
          return;
        }
        if (callee.type === "MemberExpression") {
          const method = propertyName(callee);
          if (method === "toFixed" || method === "toPrecision") {
            const name = fiscalName(callee.object);
            if (name) report(node, "method", { name, method });
          }
        }
      },
      UnaryExpression(node) {
        if (node.operator !== "+" && node.operator !== "-") return;
        const name = fiscalName(node.argument);
        if (name) report(node, "arithmetic", { operator: `${node.operator} unário`, name });
      },
      BinaryExpression(node) {
        const concatenation = node.operator === "+" && (isText(node.left) || isText(node.right));
        if (!ARITHMETIC.has(node.operator) && (node.operator !== "+" || concatenation)) return;
        const name = fiscalName(node.left) ?? fiscalName(node.right);
        if (name) report(node, "arithmetic", { operator: node.operator, name });
      },
      AssignmentExpression(node) {
        if (!ASSIGNMENTS.has(node.operator)) return;
        if (node.operator === "+=" && isText(node.right)) return;
        const name = fiscalName(node.left) ?? fiscalName(node.right);
        if (name) report(node, "arithmetic", { operator: node.operator, name });
      },
    };
  },
});
