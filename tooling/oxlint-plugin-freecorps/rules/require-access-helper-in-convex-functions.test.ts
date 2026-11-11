import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import rule from "./require-access-helper-in-convex-functions.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const header = `
import { action, httpAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMembership, requireUser, audit } from "./lib/organizationAccess";
import { documentAccess } from "./lib/documentCore";
import { readOther } from "./lib/other";
`;
const module = (code: string, filename = "platform/convex/widgets.ts") => ({
  code: header + code,
  filename,
});

new RuleTester().run("require-access-helper-in-convex-functions", rule, {
  valid: [
    // Checagem antes do primeiro toque em dado.
    module(`export const list = query({ args: {}, handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      return ctx.db.query("widgets").collect();
    } });`),
    // Wrapper registrado (lib/documentCore.documentAccess).
    module(`export const docs = query({ args: {}, handler: async (ctx, args) => {
      await documentAccess(ctx, args);
      return ctx.db.query("fiscalDocuments").take(10);
    } });`),
    // Folga "carrega e confere": db.get do id recebido, depois a checagem.
    module(`export const revoke = mutation({ args: {}, handler: async (ctx, args) => {
      const job = await ctx.db.get("jobs", args.jobId);
      if (!job) throw new Error("NOT_FOUND");
      await requireMembership(ctx, job.organizationId);
      await ctx.db.patch("jobs", job._id, { revoked: true });
    } });`),
    // Função local do mesmo arquivo, com o ctx repassado.
    module(`async function scoped(c, organizationId) { return requireMembership(c, organizationId); }
    export const get = query({ args: {}, handler: async (ctx, args) => {
      await scoped(ctx, args.organizationId);
      return ctx.db.get("widgets", args.id);
    } });`),
    // Membro de objeto local.
    module(`const readers = { one: async (c, args) => { await requireMembership(c, args.o); return c.db.query("w").first(); } };
    export const one = query({ args: {}, handler: (ctx, args) => readers.one(ctx, args) });`),
    // Action que delega a uma função interna do mesmo módulo que confere.
    module(`export const authorize = internalQuery({ args: {}, handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      return null;
    } });
    export const run = action({ args: {}, handler: async (ctx, args) => {
      await ctx.runQuery(internal.widgets.authorize, args);
      return ctx.runMutation(internal.widgets.save, args);
    } });`),
    // Action que delega a uma interna registrada em `delegates` (access-helpers.mjs).
    module(`export const read = action({ args: {}, handler: async (ctx, args) => {
      const cert = await ctx.runQuery(internal.certificates.authorizeRewrap, args);
      await ctx.runMutation(internal.certificates.saveRewrap, { id: cert._id });
    } });`),
    // A interna registrada confere antes de tocar em dado, no módulo dela.
    module(
      `export const reserve = internalMutation({ args: {}, handler: async (ctx, args) => {
        await requireMembership(ctx, args.organizationId);
        return ctx.db.insert("certificates", {});
      } });
      export const authorizeRewrap = internalQuery({ args: {}, handler: (ctx, args) => requireMembership(ctx, args.o) });`,
      "platform/convex/certificates.ts",
    ),
    // Os dois ramos conferem: vale para o que vem depois.
    module(`export const list = query({ args: {}, handler: async (ctx, args) => {
      if (args.keyHash) await documentAccess(ctx, args);
      else await requireMembership(ctx, args.organizationId);
      return ctx.db.query("widgets").collect();
    } });`),
    module(`export const list = query({ args: {}, handler: async (ctx, args) => {
      const actor = args.keyHash ? await documentAccess(ctx, args) : await requireUser(ctx);
      return ctx.db.query("widgets").collect();
    } });`),
    // Um ramo que sai da função não precisa conferir; o que segue confere.
    module(`export const list = query({ args: {}, handler: async (ctx, args) => {
      if (!args.organizationId) return null;
      if (args.keyHash) {
        await documentAccess(ctx, args);
        return ctx.db.query("fiscalDocuments").take(1);
      }
      await requireMembership(ctx, args.organizationId);
      return ctx.db.query("widgets").collect();
    } });`),
    // Depois da checagem, os ramos tocam à vontade.
    module(`export const list = query({ args: {}, handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      if (args.all) return ctx.db.query("widgets").collect();
      for (const id of args.ids) await ctx.db.patch("widgets", id, {});
      return args.ids.length && ctx.db.query("widgets").first();
    } });`),
    // Contexto desestruturado também é lido.
    module(`export const list = query({ args: {}, handler: async ({ db, ...ctx }, args) => {
      await requireMembership(ctx, args.organizationId);
      return db.query("widgets").collect();
    } });`),
    // Funções internas não são verificadas.
    module(`export const sweep = internalMutation({ args: {}, handler: async (ctx) => {
      for (const row of await ctx.db.query("widgets").collect()) await ctx.db.delete("widgets", row._id);
    } });`),
    // Sem toque em dado nenhum.
    module(`export const ping = query({ args: {}, handler: async () => "pong" });`),
    // Exceção marcada com categoria e motivo.
    module(`// freecorps-access: sem-tenant — lê só a sessão de quem chama, sem organização
    export const me = query({ args: {}, handler: async (ctx) => readOther(ctx) });`),
    module(`// freecorps-access: assinatura — webhook do Stripe, assinatura conferida antes do efeito
    export const hook = httpAction(async (ctx, request) => ctx.runMutation(internal.billing.record, {}));`),
    // Arquivos fora do escopo.
    module(
      `export const x = query({ args: {}, handler: (ctx) => ctx.db.query("w").collect() });`,
      "platform/convex/widgets.test.ts",
    ),
    module(
      `export const x = query({ args: {}, handler: (ctx) => ctx.db.query("w").collect() });`,
      "apps/console/src/x.ts",
    ),
  ],
  invalid: [
    // Checagem num ramo só não vale para o que vem depois (#131).
    ...[
      `if (args.strict) await requireMembership(ctx, args.organizationId);`,
      `const actor = args.keyHash ? null : await requireMembership(ctx, args.organizationId);`,
      `args.strict && (await requireMembership(ctx, args.organizationId));`,
      `args.strict || (await requireMembership(ctx, args.organizationId));`,
      `switch (args.kind) { case "a": await requireMembership(ctx, args.organizationId); break; default: }`,
      `switch (args.kind) { default: await requireMembership(ctx, args.organizationId); }`,
      `try { await requireMembership(ctx, args.organizationId); } catch {}`,
      `try { await audit(ctx, args); } catch { await requireMembership(ctx, args.organizationId); }`,
      `for (const id of args.ids) await requireMembership(ctx, id);`,
      `while (args.retry) await requireMembership(ctx, args.organizationId);`,
      `await Promise.all(args.ids.map((id) => requireMembership(ctx, id)));`,
      `let ok = args.ok; ok ||= await requireMembership(ctx, args.organizationId);`,
      `if (args.strict) { await requireMembership(ctx, args.organizationId); } else {}`,
    ].map((check) => ({
      ...module(`export const list = query({ args: {}, handler: async (ctx, args) => {
        ${check}
        return ctx.db.query("widgets").collect();
      } });`),
      errors: [{ messageId: "dataFirst" as const }],
    })),
    {
      // Função local chamada num ramo: a checagem dela também não vale depois.
      ...module(`async function scoped(c, organizationId) { await requireMembership(c, organizationId); }
      export const list = query({ args: {}, handler: async (ctx, args) => {
        if (args.strict) await scoped(ctx, args.organizationId);
        return ctx.db.query("widgets").collect();
      } });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // Interna do mesmo módulo chamada num ramo.
      ...module(`export const authorize = internalQuery({ args: {}, handler: (ctx, args) => requireMembership(ctx, args.o) });
      export const run = action({ args: {}, handler: async (ctx, args) => {
        if (args.strict) await ctx.runQuery(internal.widgets.authorize, args);
        return ctx.runMutation(internal.widgets.save, args);
      } });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // A categoria `delegada` saiu: a delegação conferida dispensa marcador.
      ...module(`// freecorps-access: delegada — certificates.reserve confere com requireCompany
      export const upload = action({ args: {}, handler: async (ctx, args) => ctx.runMutation(internal.certificates.reserve, args) });`),
      errors: [{ messageId: "badMarker" }],
    },
    {
      // Interna fora de `delegates` não conta como checagem.
      ...module(
        `export const run = action({ args: {}, handler: async (ctx, args) => ctx.runQuery(internal.certificates.encrypted, args) });`,
      ),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // O destino registrado que perde o helper reprova no módulo dele.
      ...module(
        `export const reserve = internalMutation({ args: {}, handler: (ctx, args) => ctx.db.insert("certificates", {}) });
        export const authorizeRewrap = internalQuery({ args: {}, handler: async (ctx, args) => {
          if (args.strict) await requireMembership(ctx, args.o);
          return ctx.db.get("certificates", args.id);
        } });`,
        "platform/convex/certificates.ts",
      ),
      errors: [{ messageId: "delegateUnchecked" }, { messageId: "delegateUnchecked" }],
    },
    {
      ...module(
        `export const reserve = internalMutation({ args: {}, handler: (ctx, args) => requireMembership(ctx, args.o) });`,
        "platform/convex/certificates.ts",
      ),
      errors: [{ messageId: "delegateMissing" }],
    },
    {
      ...module(`export const list = query({ args: {}, handler: async (ctx, args) => {
        const rows = await ctx.db.query("widgets").collect();
        await requireMembership(ctx, args.organizationId);
        return rows;
      } });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // Utilitário de *Access.ts não é checagem.
      ...module(`export const log = mutation({ args: {}, handler: async (ctx, args) => {
        await audit(ctx, args);
      } });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // Função importada que recebe ctx antes da checagem.
      ...module(`export const get = query({ args: {}, handler: async (ctx, args) => {
        const data = await readOther(ctx, args.id);
        await requireMembership(ctx, args.organizationId);
        return data;
      } });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // `{ db }` desestruturado não escapa da regra.
      ...module(
        `export const list = query({ args: {}, handler: async ({ db }) => db.query("widgets").collect() });`,
      ),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      ...module(
        `export const run = action({ args: {}, handler: async ({ runQuery: read }, args) => read(internal.other.read, args) });`,
      ),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // O alias repassado a uma função local continua sendo o contexto.
      ...module(`async function rows(database) { return database.query("widgets").collect(); }
      export const list = query({ args: {}, handler: async ({ db }) => rows(db) });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // Forma que a regra não lê reprova, em vez de passar calada.
      ...module(
        `export const list = query({ args: {}, handler: async ({ db: { query: q } }) => q("widgets").collect() });`,
      ),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // Carrega e não confere.
      ...module(
        `export const get = query({ args: {}, handler: async (ctx, args) => ctx.db.get("widgets", args.id) });`,
      ),
      errors: [{ messageId: "noCheck" }],
    },
    {
      // A folga só vale para db.get: query antes da checagem reprova.
      ...module(`export const get = mutation({ args: {}, handler: async (ctx, args) => {
        const job = await ctx.db.get("jobs", args.jobId);
        await ctx.db.patch("jobs", job._id, { seen: true });
        await requireMembership(ctx, job.organizationId);
      } });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // Action que delega a uma interna de outro módulo precisa de marcador.
      ...module(
        `export const run = action({ args: {}, handler: async (ctx, args) => ctx.runQuery(internal.other.read, args) });`,
      ),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      // Interna do mesmo módulo que não confere não conta como checagem.
      ...module(`export const read = internalQuery({ args: {}, handler: (ctx) => ctx.db.query("w").collect() });
      export const run = action({ args: {}, handler: async (ctx, args) => ctx.runQuery(internal.widgets.read, args) });`),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      ...module(
        `export const route = httpAction(async (ctx, request) => ctx.runQuery(internal.other.read, {}));`,
      ),
      errors: [{ messageId: "dataFirst" }],
    },
    {
      ...module(`// freecorps-access: publica — sem motivo aceito
      export const me = query({ args: {}, handler: async (ctx) => readOther(ctx) });`),
      errors: [{ messageId: "badMarker" }],
    },
    {
      ...module(`// freecorps-access: sem-tenant — curto
      export const me = query({ args: {}, handler: async (ctx) => readOther(ctx) });`),
      errors: [{ messageId: "badMarker" }],
    },
    {
      ...module(`// freecorps-access: sem-tenant — requireMembership já confere aqui mesmo
      export const list = query({ args: {}, handler: async (ctx, args) => {
        await requireMembership(ctx, args.organizationId);
        return ctx.db.query("widgets").collect();
      } });`),
      errors: [{ messageId: "needlessMarker" }],
    },
    {
      // O wrapper registrado é conferido no próprio módulo.
      code: `import { requireMembership } from "./organizationAccess";
      export async function documentAccess(ctx, scope) {
        const rows = await ctx.db.query("fiscalDocuments").take(1);
        await requireMembership(ctx, scope.organizationId);
        return rows;
      }
      export async function loadDocument(ctx, scope) { await documentAccess(ctx, scope); }
      export async function resolveDocumentVersion(ctx, scope) { await loadDocument(ctx, scope); }`,
      filename: "platform/convex/lib/documentCore.ts",
      errors: [{ messageId: "wrapperUnchecked" }],
    },
    {
      code: `export async function captureAccess(ctx) { return null; }`,
      filename: "platform/convex/lib/captureCore.ts",
      errors: [{ messageId: "wrapperUnchecked" }],
    },
    {
      code: `export const unrelated = 1;`,
      filename: "platform/convex/lib/issuanceCore.ts",
      errors: [{ messageId: "wrapperMissing" }],
    },
  ],
});
