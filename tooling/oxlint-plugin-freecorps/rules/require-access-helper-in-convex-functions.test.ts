import { describe, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import rule from "./require-access-helper-in-convex-functions.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const header = `
import { action, httpAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMembership, audit } from "./lib/organizationAccess";
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
      ...module(`// freecorps-access: delegada — requireMembership já confere aqui mesmo
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
