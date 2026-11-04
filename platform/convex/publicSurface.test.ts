import { isDeepStrictEqual } from "node:util";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import schema from "./schema";
import { register } from "../test-setup";
import { validationTarget } from "../../scripts/lib/validation.mjs";
import { modulePath, modules } from "../../tests/helpers/convex-modules";

// Varredura da superfície pública do Convex da plataforma: descobre toda
// query, mutation e action pública de platform/convex, inclusive módulos
// novos, e a chama diretamente, sem sessão e com IDs forjados. Uma função que
// responda sem estar declarada abaixo reprova o CI. Os testes de cada domínio
// continuam cobrindo papéis, membership e dados reais de outra organização.
beforeEach(() => {
  for (const [name, value] of Object.entries(validationTarget.environment))
    vi.stubEnv(name, value as string);
  vi.stubEnv("CONVEX_SITE_URL", validationTarget.siteUrl);
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-secret-used-only-in-isolated-tests");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Validator = {
  type: string;
  value?: unknown;
  tableName?: string;
  keys?: Validator;
  values?: { fieldType: Validator };
};
type Kind = "query" | "mutation" | "action";
type Registered = {
  isPublic?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  exportArgs?: () => string;
};

// Valor mínimo aceito pelo validador. IDs forjados usam o formato do
// convex-test para a tabela pedida; nenhum documento correspondente existe.
function sample(validator: Validator): unknown {
  switch (validator.type) {
    case "string":
      return "forjado";
    case "number":
      return 1;
    case "bigint":
      return 1n;
    case "boolean":
      return false;
    case "null":
      return null;
    case "bytes":
      return new ArrayBuffer(1);
    case "any":
      return "forjado";
    case "id":
      return `1${validator.tableName}`;
    case "literal":
      return validator.value;
    case "union":
      return sample((validator.value as Validator[])[0]);
    case "array":
      return [];
    case "record":
      return {};
    case "object":
      return Object.fromEntries(
        Object.entries(
          validator.value as Record<string, { fieldType: Validator; optional: boolean }>,
        )
          .filter(([, field]) => !field.optional)
          .map(([name, field]) => [name, sample(field.fieldType)]),
      );
    default:
      throw new Error(`Validador sem amostra: ${validator.type}`);
  }
}

async function publicFunctions() {
  const found: { name: string; kind: Kind; args: unknown }[] = [];
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes("/_generated/") || path.endsWith(".config.ts")) continue;
    const module = modulePath(path);
    for (const [name, value] of Object.entries((await load()) as Record<string, Registered>)) {
      if (!value?.isPublic || !value.exportArgs) continue;
      const kind = value.isQuery ? "query" : value.isMutation ? "mutation" : "action";
      found.push({
        name: `${module}:${name}`,
        kind,
        args: sample(JSON.parse(value.exportArgs()) as Validator),
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

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

async function callWithoutSession(fn: { name: string; kind: Kind; args: unknown }) {
  const t = convexTest(schema, modules);
  register(t);
  type Args = Record<string, unknown>;
  const args: Args = { ...(fn.args as Args), ...argumentOverrides[fn.name] };
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
  for (const name of [...Object.keys(answersWithoutSession), ...Object.keys(argumentOverrides)])
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
