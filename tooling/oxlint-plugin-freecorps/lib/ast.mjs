// Utilitários de AST compartilhados pelas regras. Os plugins JS do oxlint
// recebem a AST ESTree (com os nós do TypeScript), sem informação de tipos.

/** Remove os invólucros que não mudam o valor: `x!`, `x as T`, `(x)`, `a?.b`. */
export function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === "TSNonNullExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "ChainExpression")
  )
    current = current.expression;
  return current;
}

/** Nome da propriedade de um MemberExpression não calculado, ou null. */
export function propertyName(member) {
  if (member.computed)
    return member.property.type === "Literal" ? String(member.property.value) : null;
  return member.property.type === "Identifier" || member.property.type === "PrivateIdentifier"
    ? member.property.name
    : null;
}

/** `a.b.c` → ["a", "b", "c"]; null quando há trecho calculado ou chamada no caminho. */
export function memberPath(node) {
  const target = unwrap(node);
  if (target?.type === "Identifier") return [target.name];
  if (target?.type === "ThisExpression") return ["this"];
  if (target?.type !== "MemberExpression") return null;
  const head = memberPath(target.object);
  const name = propertyName(target);
  return head && name !== null && !target.computed ? [...head, name] : null;
}

/** Caminho do arquivo com `/`, para comparar sufixos independentemente do sistema. */
export function slashPath(filename) {
  return filename.replaceAll("\\", "/");
}

/** O arquivo é um teste do Vitest (benchmarks não contam). */
export function isTestFile(filename) {
  const file = slashPath(filename);
  return /\.test\.[cm]?[jt]sx?$/.test(file) && !/\.benchmark\.test\.[cm]?[jt]sx?$/.test(file);
}
