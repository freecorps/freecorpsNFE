import { posix } from "node:path";
import { defineRule } from "vite-plus/lint/plugins";
import { memberPath, slashPath, unwrap } from "../lib/ast.mjs";
import { checks, exemptions, wrappers } from "../access-helpers.mjs";

/**
 * Toda função pública do Convex (query, mutation, action, httpAction e
 * observedAction) confere o acesso antes de tocar em dado (AGENTS.md, §1 e §4).
 * Funções internas ficam de fora: só o servidor as chama.
 *
 * - Checagem: chamada a uma função de `checks` ou `wrappers`
 *   (access-helpers.mjs), importada ou do próprio módulo.
 * - Toque em dado: `ctx.db.query/insert/patch/replace/delete`, `ctx.db.system`,
 *   `ctx.runQuery/runMutation/runAction`, `ctx.scheduler`, `ctx.storage` e
 *   qualquer função importada que receba `ctx`.
 * - Folga "carrega e confere": `ctx.db.get` antes da checagem é aceito, desde
 *   que a checagem venha antes de qualquer outro toque em dado.
 *
 * As funções locais do mesmo arquivo são seguidas, com o `ctx` repassado.
 * Exceções levam `// freecorps-access: <categoria> — <motivo>` acima do export.
 */
const BUILDERS = new Set(["query", "mutation", "action", "httpAction", "observedAction"]);
const ROUTE_BUILDERS = new Set(["httpAction", "observedAction"]);
const INTERNAL_BUILDERS = new Set(["internalQuery", "internalMutation", "internalAction"]);
const RUNNERS = new Set(["runQuery", "runMutation", "runAction"]);
const DB_TOUCH = new Set(["query", "insert", "patch", "replace", "delete", "system"]);
const CTX_TOUCH = new Set(["runQuery", "runMutation", "runAction", "scheduler", "storage"]);
const MARKER = /^\s*freecorps-access:\s*(\S+)\s+(?:—|--?)\s+(\S.{9,})$/;
const MARKER_PREFIX = /^\s*freecorps-access\b/;
const SKIP_KEYS = new Set([
  "parent",
  "type",
  "start",
  "end",
  "range",
  "loc",
  "typeAnnotation",
  "typeArguments",
  "typeParameters",
  "returnType",
]);

const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression" ||
  node?.type === "FunctionDeclaration";

class Decided extends Error {
  constructor(event) {
    super(event.kind);
    this.event = event;
  }
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Exige um helper de acesso antes do primeiro toque em dado nas funções públicas do Convex.",
      url: "docs/desenvolvimento/lint.md#require-access-helper-in-convex-functions",
    },
    messages: {
      dataFirst:
        "`{{fn}}` toca dado ({{what}}) antes de conferir o acesso. Chame antes um helper de lib/*Access.ts ou um wrapper registrado em tooling/oxlint-plugin-freecorps/access-helpers.mjs, ou marque a exceção com `// freecorps-access: <categoria> — <motivo>`.",
      noCheck:
        "`{{fn}}` lê o registro ({{what}}) e não confere o acesso depois. Chame um helper de lib/*Access.ts.",
      wrapperUnchecked:
        "O wrapper `{{fn}}` (access-helpers.mjs) toca dado ({{what}}) antes de conferir o acesso.",
      wrapperMissing:
        "access-helpers.mjs registra `{{fn}}` como wrapper deste módulo, mas ele não existe aqui.",
      badMarker:
        "Marcador inválido. Formato: `// freecorps-access: <categoria> — <motivo com 10+ caracteres>`; categorias: {{categories}}.",
      needlessMarker:
        "`{{fn}}` já confere o acesso antes de tocar em dado; remova o marcador `freecorps-access`.",
    },
    schema: [],
  },
  create(context) {
    const match = /(?:^|\/)platform\/convex\/(.+)\.ts$/.exec(slashPath(context.filename));
    if (!match || match[1].startsWith("_generated/") || /\.(test|d)$/.test(match[1])) return {};
    const self = match[1];
    const sourceCode = context.sourceCode;

    const imports = new Map();
    const locals = new Map();
    const internals = new Map();
    const ownChecks = new Set([...(checks[self] ?? []), ...(wrappers[self] ?? [])]);
    const isCheckImport = ({ module, imported }) =>
      checks[module]?.includes(imported) || wrappers[module]?.includes(imported);

    function moduleOf(specifier) {
      if (!specifier.startsWith(".")) return null;
      return posix.join(posix.dirname(self), specifier).replace(/\.(m?[jt]s)$/, "");
    }
    function collect(statement) {
      const declaration =
        statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
          ? statement.declaration
          : statement;
      if (!declaration) return;
      if (declaration.type === "FunctionDeclaration" && declaration.id)
        locals.set(declaration.id.name, declaration);
      if (declaration.type !== "VariableDeclaration") return;
      for (const d of declaration.declarations) {
        if (d.id.type !== "Identifier") continue;
        const init = unwrap(d.init);
        if (isFunction(init)) locals.set(d.id.name, init);
        // `const selectors = { a: (ctx, args) => ... }`: chamadas `selectors.a(ctx)`.
        if (init?.type === "ObjectExpression")
          for (const property of init.properties)
            if (
              property.type === "Property" &&
              !property.computed &&
              isFunction(unwrap(property.value))
            )
              locals.set(
                `${d.id.name}.${property.key.name ?? property.key.value}`,
                unwrap(property.value),
              );
        // `export const fn = internalQuery({ handler })`: alvo de `ctx.runQuery(internal.<módulo>.fn)`.
        if (
          init?.type === "CallExpression" &&
          unwrap(init.callee).type === "Identifier" &&
          INTERNAL_BUILDERS.has(unwrap(init.callee).name)
        )
          internals.set(d.id.name, init);
      }
    }

    /**
     * O contexto de um parâmetro: `ctx` inteiro (`names`) ou desestruturado (`aliases`, nome
     * local → propriedade do contexto, como `{ db }` ou `{ runQuery: run }`). `null` quando a
     * forma não é lida pela regra (chave calculada, padrão aninhado), que então reprova.
     */
    function contextOf(param) {
      const empty = { names: new Set(), aliases: new Map() };
      if (!param) return empty;
      if (param.type === "AssignmentPattern") return contextOf(param.left);
      if (param.type === "Identifier") return { names: new Set([param.name]), aliases: new Map() };
      if (param.type !== "ObjectPattern") return null;
      for (const property of param.properties) {
        if (property.type === "RestElement" && property.argument.type === "Identifier") {
          empty.names.add(property.argument.name);
          continue;
        }
        const value =
          property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
        if (property.type !== "Property" || property.computed || value?.type !== "Identifier")
          return null;
        empty.aliases.set(value.name, property.key.name ?? property.key.value);
      }
      return empty;
    }
    const UNREADABLE = "ctx numa forma que a regra não lê";

    /**
     * `ctx.runQuery(internal.<este módulo>.fn, ...)` em que `fn` é uma função interna deste
     * arquivo cujo handler confere o acesso antes de tocar em dado.
     */
    function delegatesToCheck(reference, stack) {
      const path = memberPath(reference);
      const prefix = ["internal", ...self.split("/")];
      if (!path || path.length !== prefix.length + 1 || prefix.some((p, i) => path[i] !== p))
        return false;
      const name = path.at(-1);
      const key = `internal:${name}`;
      if (!internals.has(name) || stack.has(key)) return false;
      const fn = handlerOf(internals.get(name));
      const ctx = fn && contextOf(fn.params[0]);
      if (!ctx) return false;
      return scan(fn, ctx, new Set([...stack, key])).event?.kind === "check";
    }

    /** Primeiro evento decisivo do corpo de `fn`, com `ctx` vindo de `contextOf`. */
    function scan(fn, ctx, stack) {
      const state = { loaded: null };
      const { names, aliases } = ctx;
      const isCtx = (node) => {
        const target = unwrap(node);
        return (
          target?.type === "Identifier" && (names.has(target.name) || aliases.has(target.name))
        );
      };
      function classify(call) {
        const callee = unwrap(call.callee);
        if (callee.type === "Identifier" && !aliases.has(callee.name)) {
          const name = callee.name;
          const imported = imports.get(name);
          if ((imported && isCheckImport(imported)) || (!imported && ownChecks.has(name)))
            throw new Decided({ kind: "check", name });
          if (!imported && locals.has(name)) return follow(name, call);
          if (call.arguments.some(isCtx))
            throw new Decided({ kind: "touch", what: `${name}(ctx)`, node: call });
          return;
        }
        const written = memberPath(callee);
        if (written?.length === 2 && locals.has(written.join(".")))
          return follow(written.join("."), call);
        // `{ db }` desestruturado: `db.query(...)` é `ctx.db.query(...)`.
        const path =
          written && aliases.has(written[0])
            ? ["ctx", aliases.get(written[0]), ...written.slice(1)]
            : written;
        if (!path || !(names.has(path[0]) || (written && aliases.has(written[0])))) {
          if (call.arguments.some(isCtx)) {
            const what = path ? `${path.join(".")}(ctx)` : "chamada com ctx";
            throw new Decided({ kind: "touch", what, node: call });
          }
          return;
        }
        if (path[1] === "db" && path[2] === "get") {
          state.loaded ??= { what: "ctx.db.get", node: call };
          return;
        }
        if (RUNNERS.has(path[1]) && delegatesToCheck(call.arguments[0], stack))
          throw new Decided({ kind: "check", name: memberPath(call.arguments[0]).join(".") });
        if ((path[1] === "db" && DB_TOUCH.has(path[2])) || CTX_TOUCH.has(path[1]))
          throw new Decided({ kind: "touch", what: path.slice(0, 3).join("."), node: call });
      }
      /** Segue uma função local do arquivo, com o `ctx` repassado na mesma posição. */
      function follow(name, call) {
        if (stack.has(name)) return;
        const target = locals.get(name);
        const passed = { names: new Set(), aliases: new Map() };
        call.arguments.forEach((argument, index) => {
          const value = unwrap(argument);
          if (value?.type !== "Identifier") return;
          const param = target.params[index];
          if (names.has(value.name)) {
            const inner = contextOf(param);
            if (!inner) throw new Decided({ kind: "touch", what: UNREADABLE, node: call });
            inner.names.forEach((n) => passed.names.add(n));
            inner.aliases.forEach((prop, local) => passed.aliases.set(local, prop));
          } else if (aliases.has(value.name) && param?.type === "Identifier")
            passed.aliases.set(param.name, aliases.get(value.name));
        });
        if (!passed.names.size && !passed.aliases.size) return;
        const inner = scan(target, passed, new Set([...stack, name]));
        if (inner.event) throw new Decided(inner.event);
        if (inner.loaded && !state.loaded) state.loaded = inner.loaded;
      }
      function visit(node) {
        if (!node || typeof node.type !== "string") return;
        for (const key of Object.keys(node)) {
          if (SKIP_KEYS.has(key)) continue;
          const value = node[key];
          if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === "object") visit(value);
        }
        if (node.type === "CallExpression") classify(node);
      }
      try {
        visit(fn.body);
      } catch (error) {
        if (error instanceof Decided) {
          const event = error.event;
          // A folga: `ctx.db.get` antes da checagem só vale se a checagem vier depois.
          return { event, loaded: state.loaded };
        }
        throw error;
      }
      return { event: null, loaded: state.loaded };
    }

    function handlerOf(call) {
      const [first] = call.arguments;
      if (!first) return null;
      const target = unwrap(first);
      if (isFunction(target)) return target;
      if (target.type === "Identifier") return locals.get(target.name) ?? null;
      if (target.type !== "ObjectExpression") return null;
      for (const property of target.properties) {
        if (property.type !== "Property" || property.key?.name !== "handler") continue;
        const value = unwrap(property.value);
        if (isFunction(value)) return value;
        if (value.type === "Identifier") return locals.get(value.name) ?? null;
      }
      return null;
    }

    function marker(statement) {
      const found = sourceCode
        .getCommentsBefore(statement)
        .filter((comment) => MARKER_PREFIX.test(comment.value));
      if (!found.length) return null;
      const comment = found.at(-1);
      const parsed = MARKER.exec(comment.value.trim());
      if (!parsed || !(parsed[1] in exemptions)) {
        context.report({
          node: comment,
          messageId: "badMarker",
          data: { categories: Object.keys(exemptions).join(", ") },
        });
        return { valid: false, comment };
      }
      return { valid: true, comment };
    }

    function verdict(fn) {
      const ctx = contextOf(fn.params[0]);
      if (!ctx) return { ok: false, messageId: "dataFirst", what: UNREADABLE, node: fn.params[0] };
      const { event, loaded } = scan(fn, ctx, new Set());
      if (event?.kind === "check") return { ok: true, checked: true };
      if (event) return { ok: false, messageId: "dataFirst", what: event.what, node: event.node };
      if (loaded) return { ok: false, messageId: "noCheck", what: loaded.what, node: loaded.node };
      return { ok: true, checked: false };
    }

    function checkFunction(name, call, statement) {
      const fn = handlerOf(call);
      if (!fn) return;
      const exemption = marker(statement);
      const result = verdict(fn);
      if (exemption) {
        if (exemption.valid && result.checked)
          context.report({
            node: exemption.comment,
            messageId: "needlessMarker",
            data: { fn: name },
          });
        return;
      }
      if (!result.ok)
        context.report({
          node: result.node ?? call,
          messageId: result.messageId,
          data: { fn: name, what: result.what },
        });
    }

    return {
      Program(program) {
        for (const statement of program.body) {
          collect(statement);
          if (statement.type === "ImportDeclaration") {
            const module = moduleOf(statement.source.value);
            if (!module) continue;
            for (const specifier of statement.specifiers)
              if (specifier.type === "ImportSpecifier")
                imports.set(specifier.local.name, {
                  module,
                  imported: specifier.imported.name ?? specifier.imported.value,
                });
          }
        }

        for (const statement of program.body) {
          if (statement.type !== "ExportNamedDeclaration") continue;
          const declaration = statement.declaration;
          if (declaration?.type !== "VariableDeclaration") continue;
          for (const d of declaration.declarations) {
            const call = unwrap(d.init);
            if (call?.type !== "CallExpression") continue;
            const callee = unwrap(call.callee);
            if (
              callee.type === "Identifier" &&
              BUILDERS.has(callee.name) &&
              d.id.type === "Identifier"
            )
              checkFunction(d.id.name, call, statement);
          }
        }

        // httpAction/observedAction registrados direto no roteador (`http.route({ handler })`).
        const exported = new Set();
        for (const statement of program.body)
          if (statement.type === "ExportNamedDeclaration")
            for (const d of statement.declaration?.declarations ?? []) exported.add(unwrap(d.init));
        const routes = [];
        (function find(node, statement) {
          if (!node || typeof node.type !== "string") return;
          if (
            node.type === "CallExpression" &&
            !exported.has(node) &&
            unwrap(node.callee).type === "Identifier" &&
            ROUTE_BUILDERS.has(unwrap(node.callee).name)
          )
            routes.push([node, statement]);
          for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            if (Array.isArray(value)) value.forEach((child) => find(child, statement));
            else if (value && typeof value === "object") find(value, statement);
          }
        })(program, null);
        for (const [call] of self.startsWith("lib/") ? [] : routes) {
          const statement = program.body.find((s) => s.start <= call.start && call.end <= s.end);
          checkFunction(unwrap(call.callee).name, call, statement ?? call);
        }

        for (const name of wrappers[self] ?? []) {
          const fn = locals.get(name);
          if (!fn) {
            context.report({ node: program, messageId: "wrapperMissing", data: { fn: name } });
            continue;
          }
          const ctx = contextOf(fn.params[0]);
          ownChecks.delete(name);
          const { event, loaded } = ctx
            ? scan(fn, ctx, new Set([name]))
            : { event: { kind: "touch", what: UNREADABLE, node: fn.params[0] }, loaded: null };
          ownChecks.add(name);
          if (event?.kind === "check") continue;
          const problem = event ?? loaded ?? { what: "nenhuma checagem", node: fn };
          context.report({
            node: problem.node ?? fn,
            messageId: "wrapperUnchecked",
            data: { fn: name, what: problem.what },
          });
        }
      },
    };
  },
});
