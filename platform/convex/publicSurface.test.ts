import { isDeepStrictEqual } from "node:util";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { mutation, query } from "./_generated/server";
import { requireMembership } from "./lib/organizationAccess";
import { register } from "../test-setup";
import { validationTarget } from "../../scripts/lib/validation.mjs";
import { modules } from "../../tests/helpers/convex-modules";
import {
  publicFunctions,
  sample,
  sweepIsolation,
  type Outcome,
  type PublicFunction,
} from "../../tests/helpers/isolation-sweep";

// Varredura da superfície pública do Convex da plataforma: descobre toda
// query, mutation e action pública de platform/convex, inclusive módulos
// novos, e a chama diretamente. A primeira seção chama sem sessão e com IDs
// forjados; a segunda, com sessão em A e ids de outra organização (#132).
// Uma função que responda fora do declarado abaixo reprova o CI. Os testes de
// cada domínio continuam cobrindo papéis, membership e o fluxo completo.
beforeEach(() => {
  for (const [name, value] of Object.entries(validationTarget.environment))
    vi.stubEnv(name, value as string);
  vi.stubEnv("CONVEX_SITE_URL", validationTarget.siteUrl);
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-secret-used-only-in-isolated-tests");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Funções públicas que respondem sem sessão de propósito. Cada entrada diz o
// que devolve; nenhuma pode expor dado de organização, projeto ou empresa.
const answersWithoutSession: Record<string, { reason: string; value: unknown }> = {
  "access:session": { reason: "sessão atual; sem sessão é null", value: null },
  "account:capabilities": {
    reason: "flags públicas de cadastro, recuperação, convites e troca de e-mail do perfil",
    value: {
      emailChange: false,
      emailRecovery: false,
      invitationEmail: false,
      registration: false,
    },
  },
  "deployment:current": {
    reason: "ambiente do deployment para o selo do login e do shell; o endereço já o revela",
    value: { environment: "sandbox", fiscalProduction: false },
  },
};
// Argumentos que passam da validação de formato para chegar à checagem de
// acesso. O resto usa a amostra mínima do validador.
const argumentOverrides: Record<string, Record<string, unknown>> = {
  "invitations:send": { email: "convite@validation.invalid" },
};
// Recusas que não revelam se o registro existe.
const refusals = ["UNAUTHENTICATED", "ACCESS_DENIED", "NOT_FOUND"];

async function callWithoutSession(fn: PublicFunction) {
  const t = convexTest(schema, modules);
  register(t);
  type Args = Record<string, unknown>;
  const args: Args = { ...(sample(fn.args) as Args), ...argumentOverrides[fn.name] };
  try {
    const value =
      fn.kind === "query"
        ? await t.query(makeFunctionReference<"query", Args>(fn.name), args)
        : fn.kind === "mutation"
          ? await t.mutation(makeFunctionReference<"mutation", Args>(fn.name), args)
          : await t.action(makeFunctionReference<"action", Args>(fn.name), args);
    return { resolved: true as const, value };
  } catch (error) {
    const data = (error as { data?: { code?: unknown } }).data;
    return {
      resolved: false as const,
      code: typeof data?.code === "string" ? data.code : "SEM_CODIGO",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

it("enumerates every public Convex function of the platform, including new modules", async () => {
  const functions = await publicFunctions();
  const names = functions.map((fn) => fn.name);
  expect(new Set(names).size).toBe(names.length);
  // Âncoras conhecidas: se a descoberta parar de enxergar os módulos, o teste falha.
  expect(names).toEqual(
    expect.arrayContaining([
      "access:overview",
      "organizations:listMine",
      "keys:create",
      "documents:list",
      "webhooks:retry",
      "certificateWorker:upload",
    ]),
  );
  expect(new Set(functions.map((fn) => fn.kind))).toEqual(new Set(["query", "mutation", "action"]));
  for (const name of [
    ...Object.keys(answersWithoutSession),
    ...Object.keys(argumentOverrides),
    ...Object.keys(isolationOverrides),
    ...Object.keys(unreachedFromA),
  ])
    expect(names).toContain(name);
});

it("refuses a direct call without session to every public function with forged IDs", async () => {
  const leaks: string[] = [];
  for (const fn of await publicFunctions()) {
    const result = await callWithoutSession(fn);
    const expected = answersWithoutSession[fn.name];
    if (expected) {
      // Uma função liberada continua devolvendo apenas o valor declarado.
      if (!result.resolved || !isDeepStrictEqual(result.value, expected.value))
        leaks.push(`${fn.name}: resposta pública mudou`);
    } else if (result.resolved) leaks.push(`${fn.name}: respondeu sem sessão`);
    else if (!refusals.includes(result.code))
      leaks.push(`${fn.name}: recusa inesperada ${result.code} (${result.message.slice(0, 120)})`);
  }
  expect(leaks).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Isolamento entre organizações e empresas (#132)
//
// Duas organizações, A e B, com um documento mínimo de cada tabela (tests/helpers/isolation-sweep.ts).
// Cada função é chamada como owner de A e como operator de A sem concessão de empresa: c0 com os
// ids de A, c1 com os de B, c2 com `organizationId` de A e o resto de B, c3 com a empresa de A
// pelo operator. O oráculo reprova B na resposta, escrita em B, resposta a B diferente da
// resposta a um id inexistente, erro sem código e query que muda quando B ganha outro lote.

// Argumentos fixos, iguais em todos os casos, que levam a chamada com ids de A além da
// validação de formato. Os ids continuam vindo do caso.
const isolationOverrides: Record<string, Record<string, unknown>> = {
  ...argumentOverrides,
  "keys:create": { scopes: ["documents:read"] },
  "keys:rotate": { scopes: ["documents:read"] },
  "projects:grantCompany": { scopes: ["documents:read"], environments: ["sandbox"] },
};

// Funções que recusam o owner de A mesmo com os ids de A: os dados gerados não as alcançam, e a
// varredura prova só que B recebe a mesma recusa de um id inexistente. Cada entrada cita o teste
// que prova o isolamento delas com dados reais.
const unreachedFromA: Record<string, string> = {
  "access:diagnostics":
    "sonda da validação, só para operator e sem argumento de escopo (access.test.ts)",
  "access:overview": "papel da sessão na validação, sem argumento de escopo (access.test.ts)",
  "certificateWorker:rewrap":
    "exige envelope cifrado real; certificates.test.ts, 'rewrap recusa estranho, ... certificado de outra empresa'",
  "companies:setGrant":
    "o membro citado pelos registros de A é o próprio owner; companies.test.ts, 'forged IDs never cross them'",
  "exportDownloads:ticket":
    "exige parte de exportação concluída e vigente; exports.test.ts, 'refuses download tickets for a part of another project, organization or member'",
};

// Achado do oráculo aceito, com a prova de que não expõe B. A chave é a linha do achado.
const isolationExceptions: Record<string, string> = {};

const sweepEnvironment = () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 4, 12));
  vi.stubEnv("FNFE_WEBHOOK_MASTER_KEY", "ab".repeat(32));
  // Nenhuma chamada da varredura sai para a rede (Stripe, consulta de CNPJ, webhooks).
  vi.stubGlobal("fetch", async () => {
    throw new Error("rede desligada na varredura de isolamento");
  });
};
const line = (f: { fn: string; caller: string; case: string; problem: string }) =>
  `${f.fn} [${f.caller} ${f.case}] ${f.problem}`;

it("keeps every public function inside the caller's organization and company grants", async () => {
  sweepEnvironment();
  const refusedA: string[] = [];
  const findings = await sweepIsolation(await publicFunctions(), {
    overrides: isolationOverrides,
    onCall: (fn, caller, which, outcome: Outcome) => {
      if (caller === "owner" && which === "c0" && !outcome.resolved)
        if (refusals.includes(outcome.code)) refusedA.push(fn);
    },
  });
  expect(findings.map(line).filter((found) => !isolationExceptions[found])).toEqual([]);
  // A lista de não alcançadas acompanha o código: uma função que passa a alcançar sai dela.
  expect(refusedA.sort()).toEqual(Object.keys(unreachedFromA).sort());
  for (const found of Object.keys(isolationExceptions)) expect(findings.map(line)).toContain(found);
}, 300_000);

// Meta-teste: cada oráculo reprova uma função vazada de propósito. Todas conferem a membership
// da organização pedida e depois confiam no id da empresa, o erro que a varredura existe para
// pegar.
const company = { organizationId: v.id("organizations"), companyId: v.id("companies") };
const leaky = {
  get: query({
    args: company,
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      return ctx.db.get("companies", args.companyId);
    },
  }),
  exists: query({
    args: company,
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      return (await ctx.db.get("companies", args.companyId)) !== null;
    },
  }),
  count: query({
    args: { organizationId: v.id("organizations") },
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      return (await ctx.db.query("companies").take(100)).length;
    },
  }),
  rename: mutation({
    args: company,
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      await ctx.db.patch("companies", args.companyId, { name: "Renomeada por fora" });
    },
  }),
};

it("reproves a deliberately leaky function in each oracle", async () => {
  sweepEnvironment();
  const leakyModule = { "../../platform/convex/leaky.ts": async () => leaky };
  const findings = await sweepIsolation(await publicFunctions(leakyModule), {
    modules: { ...modules, ...leakyModule },
  });
  const problems = (fn: string) =>
    findings.filter((f) => f.fn === fn).map((f) => `${f.caller} ${f.case}: ${f.problem}`);
  expect(problems("leaky:get")).toContainEqual(
    expect.stringMatching(/^owner c2: resposta traz inquilino-b/),
  );
  expect(problems("leaky:exists")).toContainEqual(
    expect.stringMatching(/^owner c2: responde diferente de um id inexistente/),
  );
  expect(problems("leaky:count")).toContain("owner c0: muda com lote extra de B");
  expect(problems("leaky:rename")).toContainEqual(expect.stringMatching(/^owner c2: escreveu em /));
}, 60_000);
