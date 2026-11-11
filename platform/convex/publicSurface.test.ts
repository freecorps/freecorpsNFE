import { isDeepStrictEqual } from "node:util";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { action, mutation, query } from "./_generated/server";
import { requireMembership } from "./lib/organizationAccess";
import { register } from "../test-setup";
import { validationTarget } from "../../scripts/lib/validation.mjs";
import { modules } from "../../tests/helpers/convex-modules";
import {
  publicFunctions,
  refusals,
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
// ids de A, c1 com os de B, c2 com `organizationId` de A e o resto de B, c3 com os ids de A pelo
// operator. O oráculo reprova B (ou a empresa de A, no c3) na resposta, escrita ou agendamento
// com eles, resposta a B diferente da resposta a um id inexistente, erro sem código e leitura que
// muda quando B ganha outro lote.

const address = {
  street: "Rua sintética",
  number: "1",
  complement: "",
  district: "Centro",
  city: "São Paulo",
  state: "SP",
  postalCode: "01000000",
};
// Argumentos fixos, iguais em todos os casos, que levam a chamada com ids de A além da
// validação de formato. Os ids continuam vindo do caso.
const isolationOverrides: Record<string, Record<string, unknown>> = {
  ...argumentOverrides,
  "projects:grantCompany": { scopes: ["documents:read"], environments: ["sandbox"] },
  "keys:create": { scopes: ["documents:read"], expiresAt: Date.UTC(2027, 0, 1) },
  "keys:rotate": { scopes: ["documents:read"], expiresAt: Date.UTC(2027, 0, 1) },
  "companies:create": { cnpj: "11222333000181", name: "Empresa sintética", address },
  "companies:update": { name: "Empresa sintética", address },
  "webhooks:create": {
    name: "Webhook",
    url: "https://webhook.example.com/fnfe",
    events: ["document.received"],
  },
  "webhooks:update": {
    name: "Webhook",
    url: "https://webhook.example.com/fnfe",
    events: ["document.received"],
  },
};

// Funções em que o owner de A, com os ids de A, não chega ao que leria: recusa, erro sem código
// ou conteúdo corrompido, porque os dados gerados não alcançam o caminho. A varredura prova só
// que B recebe a mesma recusa de um id inexistente. Cada entrada cita o teste que prova o
// isolamento com dados reais.
const unreachedFromA: Record<string, string> = {
  "access:diagnostics":
    "sonda da validação, só para operator e sem argumento de escopo (access.test.ts)",
  "access:overview": "papel da sessão na validação, sem argumento de escopo (access.test.ts)",
  "certificateWorker:rewrap":
    "exige envelope cifrado real; certificates.test.ts, 'rewrap recusa estranho, ... certificado de outra empresa'",
  "companies:create":
    "a confirmação pela consulta exige campos escolhidos; companies.test.ts, 'consulta antes do cadastro só para owner/admin da organização dona da consulta'",
  "companies:setGrant":
    "o membro citado pelos registros de A é o próprio owner; companies.test.ts, 'forged IDs never cross them'",
  "contentRead:documentDetailToken":
    "exige conteúdo de documento real; documents.test.ts, 'rejects foreign documents, versions and artifacts'",
  "contentRead:documentItemsToken":
    "exige conteúdo de documento real; documents.test.ts, 'rejects foreign documents, versions and artifacts'",
  "contentRead:importDetailToken":
    "exige conteúdo de documento real; imports.test.ts, 'isolates detail selectors by organization, company and file'",
  "documentContentNode:documentDetailRead":
    "exige conteúdo de documento real; documents.test.ts, 'rejects foreign documents, versions and artifacts'",
  "documentContentNode:documentItemsRead":
    "exige conteúdo de documento real; documents.test.ts, 'rejects foreign documents, versions and artifacts'",
  "documentContentNode:importDetailRead":
    "exige conteúdo de documento real; imports.test.ts, 'isolates detail selectors by organization, company and file'",
  "exportDownloads:ticket":
    "exige parte de exportação concluída e vigente; exports.test.ts, 'refuses download tickets for a part of another project, organization or member'",
  "issuanceConsole:detail":
    "exige o snapshot completo da emissão; issuanceConsole.test.ts, 'isola organizações e empresas'",
  "issuanceConsole:resubmission":
    "exige o snapshot completo da emissão; issuanceConsole.test.ts, 'isola organizações e empresas'",
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
  // O c0 do owner vem primeiro. Ele não chega ao que leria quando recusa, falha sem código ou
  // acha o conteúdo corrompido, ou quando a validação que o barra também barra os ids de B: ela
  // vem antes do acesso, e os casos de B não provam nada.
  const c0 = new Map<string, string | null>();
  const unreached = new Set<string>();
  const findings = await sweepIsolation(await publicFunctions(), {
    overrides: isolationOverrides,
    onCall: (fn, caller, which, outcome: Outcome) => {
      if (caller !== "owner") return;
      const code = outcome.resolved ? null : outcome.code;
      if (which === "c0") {
        c0.set(fn, code);
        if (code && (refusals.includes(code) || code === "SEM_CODIGO" || code.endsWith("_CORRUPT")))
          unreached.add(fn);
      } else if (code && code === c0.get(fn)) unreached.add(fn);
    },
  });
  const refusedA = [...unreached];
  // Em texto, para que a falha mostre todos os achados, sem a abreviação das listas longas.
  expect(
    findings
      .map(line)
      .filter((found) => !isolationExceptions[found])
      .join("\n"),
  ).toBe("");
  // A lista de não alcançadas acompanha o código: uma função que passa a alcançar sai dela.
  expect(refusedA.sort()).toEqual(Object.keys(unreachedFromA).sort());
  for (const found of Object.keys(isolationExceptions)) expect(findings.map(line)).toContain(found);
}, 300_000);

// Meta-teste: cada oráculo reprova uma função vazada de propósito, quase sempre a que confere a
// membership da organização pedida e depois confia no id da empresa, o erro que a varredura
// existe para pegar.
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
  // O efeito fica para depois: agenda a escrita com o id de B.
  schedule: mutation({
    args: company,
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("leaky:rename"), args);
    },
  }),
  // Falha sem código só quando a empresa é de outra organização.
  throws: query({
    args: company,
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      const found = await ctx.db.get("companies", args.companyId);
      if (found && found.organizationId !== args.organizationId)
        throw new Error("empresa de outra organização");
      return null;
    },
  }),
  // Lista as empresas da organização sem olhar a concessão de quem chama.
  listAll: query({
    args: { organizationId: v.id("organizations") },
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      const all = await ctx.db.query("companies").take(100);
      return all.filter((c) => c.organizationId === args.organizationId).map((c) => c.name);
    },
  }),
  // Seleciona a organização pelo slug, sem membership.
  bySlug: query({
    args: { slug: v.string() },
    handler: async (ctx, args) => {
      const found = await ctx.db
        .query("organizations")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug))
        .unique();
      return found?.name ?? null;
    },
  }),
  // Confere só o primeiro id da lista e devolve todos.
  firstOnly: query({
    args: { organizationId: v.id("organizations"), companyIds: v.array(v.id("companies")) },
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      const first = await ctx.db.get("companies", args.companyIds[0]!);
      if (first?.organizationId !== args.organizationId) return [];
      return Promise.all(args.companyIds.map((id) => ctx.db.get("companies", id)));
    },
  }),
  // Conta os documentos da organização sem filtrar pela concessão de quem chama.
  countDocuments: query({
    args: { organizationId: v.id("organizations") },
    handler: async (ctx, args) => {
      await requireMembership(ctx, args.organizationId);
      const all = await ctx.db.query("fiscalDocuments").take(100);
      return all.filter((d) => d.organizationId === args.organizationId).length;
    },
  }),
  // A contagem atravessa uma action.
  countAction: action({
    args: { organizationId: v.id("organizations") },
    handler: (ctx, args): Promise<number> =>
      ctx.runQuery(makeFunctionReference<"query", typeof args, number>("leaky:count"), args),
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
  expect(problems("leaky:schedule")).toContainEqual(
    expect.stringMatching(/^owner c2: escreveu em \d+_scheduled_functions/),
  );
  expect(problems("leaky:throws")).toContainEqual(
    expect.stringMatching(/^owner c2: erro sem código: .*empresa de outra organização/),
  );
  expect(problems("leaky:listAll")).toContainEqual(
    expect.stringMatching(/^operator c3: resposta traz inquilino-a-7c1e-empresa/),
  );
  expect(problems("leaky:bySlug")).toContainEqual(
    expect.stringMatching(/^owner c1: resposta traz inquilino-b/),
  );
  expect(problems("leaky:firstOnly")).toContainEqual(
    expect.stringMatching(/^owner c2: resposta traz inquilino-b/),
  );
  expect(problems("leaky:countAction")).toContain("owner c0: muda com lote extra de B");
  expect(problems("leaky:countDocuments")).toContain(
    "operator c3: muda com lote extra da empresa de A",
  );
}, 60_000);
