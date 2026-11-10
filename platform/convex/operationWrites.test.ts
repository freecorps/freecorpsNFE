import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

/**
 * O protocolo de operações (claim, lease, `generation`, estágio e resultado) só se escreve em
 * `operations.ts` e `lib/operationCore.ts` (docs/plataforma/OPERATIONS.md, "Escritas dos
 * domínios"). Os domínios usam `abandonBeforeEffect`, `patchOperationDomain`, `setResult` e
 * `continueOperation`. Testes e `testing/` montam estado sintético e ficam fora da varredura.
 */
const owners = new Set(["operations.ts", "lib/operationCore.ts"]);
const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Linhas, em qualquer formatação, de `db.patch|replace|insert|delete("operations", ...)` e das
 * escritas na forma antiga sem tabela (`db.patch(id, value)`, `db.replace(id, value)`,
 * `db.delete(id)`), que o Convex ainda aceita e que esconderiam uma escrita em operations.
 */
function writesOf(name: string, text: string) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found = { operations: [] as number[], tableless: [] as number[] };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /(^|\.)db$/.test(node.expression.expression.getText(source))
    ) {
      const method = node.expression.name.text;
      const [table] = node.arguments;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (
        ["patch", "replace", "insert", "delete"].includes(method) &&
        table &&
        ts.isStringLiteralLike(table) &&
        table.text === "operations"
      )
        found.operations.push(line);
      if (
        (["patch", "replace"].includes(method) && node.arguments.length === 2) ||
        (method === "delete" && node.arguments.length === 1)
      )
        found.tableless.push(line);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const modules = readdirSync(root, { recursive: true, encoding: "utf8" })
  .map((path) => path.replaceAll("\\", "/"))
  .filter(
    (path) =>
      path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !path.endsWith(".d.ts") &&
      !path.startsWith("_generated/") &&
      !path.startsWith("testing/"),
  );

describe("escritas em operations", () => {
  it("a varredura reconhece a escrita direta em qualquer formatação", () => {
    const sample = [
      'await ctx.db.patch("operations", id, { stage: "ready" });',
      "await ctx.db\n  .replace(\n    'operations',\n    id,\n    doc,\n  );",
      "await db.insert(`operations`, row);",
      'await ctx.db.patch("operationAttempts", id, {});',
      'await ctx.db.get("operations", id);',
      'await ctx.db.patch(op._id, { stage: "ready" });',
      "await ctx.db.replace(op._id, doc);",
      "await ctx.db.delete(op._id);",
      'await ctx.db.delete("operations", op._id);',
    ].join("\n");
    expect(writesOf("sample.ts", sample)).toEqual({
      operations: [1, 2, 8, 14],
      tableless: [11, 12, 13],
    });
  });

  it("só o núcleo do protocolo escreve em operations", () => {
    const found = modules
      .filter((path) => !owners.has(path))
      .flatMap((path) =>
        writesOf(path, readFileSync(root + path, "utf8")).operations.map(
          (line) => `${path}:${line}`,
        ),
      );
    expect(
      found,
      "use abandonBeforeEffect, patchOperationDomain, setResult ou continueOperation de lib/operationCore.ts",
    ).toEqual([]);
  });

  it("toda escrita nomeia a tabela, para a varredura enxergá-la", () => {
    const found = modules.flatMap((path) =>
      writesOf(path, readFileSync(root + path, "utf8")).tableless.map((line) => `${path}:${line}`),
    );
    expect(found, 'escreva `db.patch("<tabela>", id, ...)`').toEqual([]);
  });

  it("o núcleo do protocolo continua sendo onde as escritas estão", () => {
    for (const path of owners)
      expect(
        writesOf(path, readFileSync(root + path, "utf8")).operations.length,
        path,
      ).toBeGreaterThan(0);
  });
});
