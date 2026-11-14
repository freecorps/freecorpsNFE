import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vite-plus/test";

/**
 * `platform/convex/_generated/` sai do `convex dev` do worktree (`bun run worktree:setup` ou
 * `bun run worktree sync`) e não pode ser editado à mão. Uma variável declarada em
 * `convex.config.ts` sem regenerar não quebra o typecheck: o `convex dev` de cada worktree
 * regravava `server.d.ts` e sujava o checkout dos outros. O tipo `Env` gerado precisa listar
 * exatamente o que o app declara, com a mesma opcionalidade.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Variáveis de `defineApp({ env })`, lidas do código sem executar os componentes. */
function declaredEnv() {
  const source = ts.createSourceFile(
    "convex.config.ts",
    read("./convex.config.ts"),
    ts.ScriptTarget.Latest,
  );
  let env: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "defineApp" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties)
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText(source) === "env" &&
          ts.isObjectLiteralExpression(property.initializer)
        )
          env = property.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(env, "convex.config.ts sem defineApp({ env: { ... } })").toBeDefined();
  return Object.fromEntries(
    env!.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) throw new Error("env com propriedade não literal");
      return [
        property.name.getText(source),
        property.initializer.getText(source).startsWith("v.optional("),
      ];
    }),
  );
}

it("o Env de server.d.ts acompanha as variáveis declaradas em convex.config.ts", () => {
  const block = /type Env = \{\n([\s\S]*?)\n\};/.exec(read("./_generated/server.d.ts"))?.[1];
  expect(block, "server.d.ts sem o tipo Env").toBeDefined();
  const generated = Object.fromEntries(
    block!
      .split("\n")
      .map((line) => /^\s*readonly (\w+): (.+);$/.exec(line))
      .filter((match) => match !== null)
      // Variáveis da própria plataforma Convex, sempre presentes.
      .filter(([, name]) => !["CONVEX_CLOUD_URL", "CONVEX_SITE_URL"].includes(name!))
      .map(([, name, type]) => [name!, type!.endsWith("| undefined")]),
  );

  expect(generated, "Regenere com `bun run worktree sync` num worktree da plataforma.").toEqual(
    declaredEnv(),
  );
});

/**
 * O Convex publica como módulo todo arquivo `.ts` de `platform/convex/` cujo nome não tem outro
 * ponto (`foo.test.ts` e `auth.config.ts` ficam de fora), exceto `schema.ts`. Mover ou criar um
 * módulo sem regenerar deixava `api.d.ts` sem ele, e nenhum typecheck reclamava (#221).
 */
it("api.d.ts lista exatamente os módulos de platform/convex", () => {
  const root = new URL("./", import.meta.url);
  const modules = readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => !file.startsWith("_generated/") && !file.includes("node_modules/"))
    .filter((file) => /^(?:[^/]+\/)*[^./]+\.ts$/.test(file))
    .map((file) => file.replace(/\.ts$/, ""))
    .filter((module) => module !== "schema");
  const listed = [...read("./_generated/api.d.ts").matchAll(/^ {2}"?([^":\s]+)"?: typeof /gm)].map(
    ([, module]) => module!,
  );

  expect(
    listed.toSorted(),
    "Regenere com `bun run worktree sync` num worktree da plataforma.",
  ).toEqual(modules.toSorted());
});
