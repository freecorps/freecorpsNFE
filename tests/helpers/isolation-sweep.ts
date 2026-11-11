import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "../../platform/convex/schema";
import { register } from "../../platform/test-setup";
import { integrationScopes } from "../../packages/contracts/src/projects";
import type { Id, TableNames } from "../../platform/convex/_generated/dataModel";
import { person, type PlatformTest } from "./platform";
import { modulePath, modules as platformModules } from "./convex-modules";

/**
 * Descoberta da superfície pública do Convex e varredura de isolamento dela (#132). Duas
 * organizações, A e B, recebem um documento mínimo de cada tabela do schema, gerado do
 * validador, com os ids apontando para documentos da mesma organização e todo texto marcado com
 * o inquilino. Cada função pública é chamada como owner de A e como operator de A sem concessão
 * de empresa, com ids de A, de B e misturados; `sweepIsolation` lista o oráculo.
 */

type Validator = {
  type: string;
  value?: unknown;
  tableName?: string;
  keys?: Validator;
  values?: { fieldType: Validator };
};
type Field = { fieldType: Validator; optional: boolean };
type Kind = "query" | "mutation" | "action";
type Registered = {
  isPublic?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  exportArgs?: () => string;
};
export type PublicFunction = { name: string; kind: Kind; args: Validator };
type Modules = typeof platformModules;

/** Toda query, mutation e action pública dos módulos, com o validador dos argumentos. */
export async function publicFunctions(modules: Modules = platformModules) {
  const found: PublicFunction[] = [];
  for (const [path, load] of Object.entries(modules)) {
    if (path.includes("/_generated/") || path.endsWith(".config.ts")) continue;
    const module = modulePath(path);
    for (const [name, value] of Object.entries((await load()) as Record<string, Registered>)) {
      if (!value?.isPublic || !value.exportArgs) continue;
      const kind = value.isQuery ? "query" : value.isMutation ? "mutation" : "action";
      found.push({ name: `${module}:${name}`, kind, args: JSON.parse(value.exportArgs()) });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Valor mínimo aceito pelo validador. `id` decide cada id pela tabela; sem ele, o id é forjado
 * no formato do convex-test, sem documento correspondente.
 */
export function sample(
  validator: Validator,
  id: (table: string) => unknown = (table) => `1${table}`,
  text = "forjado",
): unknown {
  switch (validator.type) {
    case "string":
    case "any":
      return text;
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
    case "id":
      return id(validator.tableName!);
    case "literal":
      return validator.value;
    case "union": {
      // Um cursor `string | null` começa do início; o resto usa o primeiro membro.
      const members = validator.value as Validator[];
      return sample(members.find((m) => m.type === "null") ?? members[0]!, id, text);
    }
    case "array":
      return [];
    case "record":
      return {};
    case "object":
      return Object.fromEntries(
        Object.entries(validator.value as Record<string, Field>)
          .filter(([, field]) => !field.optional)
          .map(([name, field]) => [name, sample(field.fieldType, id, text)]),
      );
    default:
      throw new Error(`Validador sem amostra: ${validator.type}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Inquilinos

type Tables = Record<string, string[]>;
type Tenant = { name: string; marker: string; ids: Tables };
type Tenants = {
  a: Tenant;
  b: Tenant;
  /** O que só pertence à empresa de A, invisível ao operator sem concessão. */
  companyA: { marker: string; ids: Set<string> };
};

const tableJson = (name: string) =>
  (schema.tables as unknown as Record<string, { validator: { json: Validator } }>)[name]!.validator
    .json;
const tableFields = (name: string) => tableJson(name).value as Record<string, Field>;

/** Ids exigidos pelo documento, em qualquer profundidade obrigatória. */
function requiredTables(validator: Validator, out = new Set<string>(), optional = false) {
  if (validator.type === "id" && !optional) out.add(validator.tableName!);
  else if (validator.type === "object")
    for (const field of Object.values(validator.value as Record<string, Field>))
      requiredTables(field.fieldType, out, optional || field.optional);
  else if (validator.type === "union")
    requiredTables((validator.value as Validator[])[0]!, out, optional);
  return out;
}
const tableNames = Object.keys(schema.tables).sort();
const requires = new Map(
  tableNames.map((name) => [
    name,
    [...requiredTables(tableJson(name))].filter((t) => !t.startsWith("_") && t !== name),
  ]),
);
/** Tabelas na ordem em que os ids obrigatórios já existem. */
const seedOrder = (() => {
  const order: string[] = [];
  const visit = (name: string, path: string[]) => {
    if (order.includes(name)) return;
    if (path.includes(name))
      throw new Error(`Ciclo de ids obrigatórios: ${[...path, name].join(" > ")}`);
    for (const dep of requires.get(name)!) visit(dep, [...path, name]);
    order.push(name);
  };
  for (const name of tableNames) visit(name, []);
  return order;
})();
/** Tabela que pertence a uma organização: exige, direta ou indiretamente, um id dela. */
const tenantScoped = (name: string): boolean =>
  name === "organizations" || requires.get(name)!.some(tenantScoped);
/** Tabela de uma empresa: exige, direta ou indiretamente, o id de uma empresa. */
const companyScoped = (name: string): boolean =>
  name === "companies" || requires.get(name)!.some(companyScoped);
/** Tabelas da plataforma, sem dono: referências, filas de manutenção, e-mail de desenvolvimento. */
const globalTables = tableNames.filter((name) => !tenantScoped(name));

/**
 * Campos que levam o documento mínimo ao estado comum, para que a chamada com ids de A passe da
 * checagem de acesso e o mesmo caminho com ids de B prove a recusa: concessão de projeto ativa e
 * com todos os escopos, versão publicada completa, operação concluída, endpoint ativo.
 */
const coherent: Record<string, Record<string, unknown>> = {
  projectCompanies: { active: true, scopes: [...integrationScopes], environments: ["sandbox"] },
  documentVersions: { state: "complete" },
  operations: { state: "succeeded" },
  webhookEndpoints: { active: true },
  documentExports: { state: "succeeded", membershipVersion: 1 },
  importFiles: { state: "accepted" },
};
/**
 * Tabelas cujos registros o console cria pelo projeto de console (`kind: "console"`); o projeto
 * gerado é de integração, dono das chaves, webhooks e conexões.
 */
const consoleRecords = ["operations", "imports", "captureStreams"];

type Ctx = {
  db: {
    insert: (table: string, doc: unknown) => Promise<string>;
    patch: (table: string, id: string, fields: unknown) => Promise<void>;
  };
  storage: { store: (blob: Blob) => Promise<string> };
};

/**
 * Um documento de cada tabela de `tables` para o inquilino, gerado do validador. O id de outra
 * tabela aponta para o documento do mesmo inquilino (`ids`), e os ids opcionais do primeiro
 * nível são preenchidos depois, quando o inquilino tem o documento. Todo texto leva o marcador;
 * o de tabelas de empresa leva também `-empresa`.
 */
async function seedTables(ctx: Ctx, tenant: Tenant, tables: string[], into: Tables) {
  const storage = await ctx.storage.store(new Blob([tenant.marker]));
  const id = (table: string) =>
    table === "_storage"
      ? storage
      : table.startsWith("_")
        ? `1${table}`
        : (into[table]?.[0] ?? tenant.ids[table]?.[0] ?? `1${table}`);
  const text = (table: string) =>
    companyScoped(table) ? `${tenant.marker}-empresa` : tenant.marker;
  for (const table of seedOrder.filter((t) => tables.includes(t))) {
    const doc = { ...(sample(tableJson(table), id, text(table)) as object), ...coherent[table] };
    (into[table] ??= []).push(await ctx.db.insert(table, doc));
  }
  for (const table of tables)
    for (const [field, spec] of Object.entries(tableFields(table))) {
      if (!spec.optional || spec.fieldType.type !== "id") continue;
      const target = spec.fieldType.tableName!;
      if (target.startsWith("_") || target === table) continue;
      const value = into[target]?.[0] ?? tenant.ids[target]?.[0];
      if (value) await ctx.db.patch(table, into[table]!.at(-1)!, { [field]: value });
    }
  if (tables.includes("projects")) {
    const project = sample(tableJson("projects"), id, tenant.marker) as object;
    const consoleId = await ctx.db.insert("projects", { ...project, kind: "console" });
    into.projects!.push(consoleId);
    for (const table of consoleRecords)
      for (const row of into[table] ?? []) await ctx.db.patch(table, row, { projectId: consoleId });
  }
}

/**
 * Tabelas cujo documento mínimo põe o inquilino num estado terminal: com ele, toda função
 * recusaria antes de chegar ao escopo, e a varredura não provaria nada.
 */
const terminal = ["organizationClosures"];

/**
 * Um banco novo com A, B e as tabelas globais, e os dois chamadores de A. O owner é o membro que
 * os registros de A citam (quem pediu a exportação, criou o projeto, enviou o certificado).
 */
async function tenantsTest(modules: Modules = platformModules) {
  const t = convexTest(schema, modules);
  register(t);
  const scoped = tableNames.filter((name) => tenantScoped(name) && !terminal.includes(name));
  const a: Tenant = { name: "A", marker: "inquilino-a-7c1e", ids: {} };
  const b: Tenant = { name: "B", marker: "inquilino-b-4f9d", ids: {} };
  const shared: Tenant = { name: "global", marker: "global-plataforma", ids: {} };
  const seed = (tenant: Tenant, tables: string[]) =>
    t.run(async (ctx) => {
      const own: Tables = {};
      await seedTables(ctx as unknown as Ctx, tenant, tables, own);
      return own;
    });
  Object.assign(shared.ids, await seed(shared, globalTables));
  a.ids = { ...shared.ids };
  b.ids = { ...shared.ids };
  Object.assign(b.ids, await seed(b, scoped));
  Object.assign(a.ids, await seed(a, ["organizations"]));
  const organizationId = a.ids.organizations![0] as Id<"organizations">;
  const owner = await person(t, organizationId, "owner");
  const operator = await person(t, organizationId, "operator");
  a.ids.memberships = [owner.membershipId];
  Object.assign(
    a.ids,
    await seed(
      a,
      scoped.filter((name) => name !== "organizations" && name !== "memberships"),
    ),
  );
  const companyA = {
    marker: `${a.marker}-empresa`,
    ids: new Set(scoped.filter(companyScoped).flatMap((table) => a.ids[table] ?? [])),
  };
  return { t, tenants: { a, b, companyA } satisfies Tenants, owner, operator };
}

/** Um segundo lote de B: uma query que só lê A não muda com ele. */
async function seedMoreOfB(t: PlatformTest, b: Tenant) {
  const scoped = tableNames.filter(
    (name) => tenantScoped(name) && name !== "organizations" && !terminal.includes(name),
  );
  await t.run(async (ctx) => {
    const extra: Tables = {};
    await seedTables(ctx as unknown as Ctx, { ...b, marker: `${b.marker}-lote` }, scoped, extra);
    for (const [table, ids] of Object.entries(extra)) (b.ids[table] ??= []).push(...ids);
  });
}

/** Todos os documentos das tabelas do schema, por id. */
async function snapshot(t: PlatformTest) {
  const rows = await t.run(async (ctx) => {
    const all: [string, string][] = [];
    for (const table of tableNames)
      for (const doc of await ctx.db.query(table as TableNames).collect())
        all.push([
          String(doc._id),
          JSON.stringify(doc, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
        ]);
    return all;
  });
  return new Map(rows);
}

// ---------------------------------------------------------------------------------------------
// Varredura

/**
 * Ids públicos declarados como texto, pelo nome do argumento. O mesmo nome com outro sentido
 * numa função fica em `stringIdsByFunction`. Um argumento de texto terminado em `Id` ou `Ids`
 * sem tabela reprova a varredura: a função nova precisa dizer o que ele seleciona.
 */
const stringIds: Record<string, string> = {
  company: "companies",
  companyId: "companies",
  companyIds: "companies",
  projectId: "projects",
  projectIds: "projects",
  documentId: "fiscalDocuments",
  versionId: "documentVersions",
  issuanceId: "issuances",
  batch: "imports",
};
const stringIdsByFunction: Record<string, Record<string, string>> = {
  "documentDownloads:ticket": { artifactId: "documentArtifacts" },
  "issuanceConsole:artifactTicket": { artifactId: "issuanceArtifacts" },
  "observability:investigate": { reference: "operations" },
};

/**
 * c0: só ids de A; c1: só ids de B; c2: `organizationId` de A com os outros ids de B;
 * c3: ids de A, pelo operator sem concessão da empresa de A.
 */
type Case = "c0" | "c1" | "c2" | "c3";
type Caller = "owner" | "operator";
type Finding = { fn: string; caller: Caller; case: Case; problem: string };

type Resolve = (table: string) => string;
const tableOf = (fn: string, name: string) => stringIdsByFunction[fn]?.[name] ?? stringIds[name];
const idCount = (fn: string, validator: Validator, name = ""): number => {
  switch (validator.type) {
    case "id":
      return 1;
    case "string":
      return tableOf(fn, name) ? 1 : 0;
    case "array":
      return idCount(fn, validator.value as Validator, name);
    case "union":
      return Math.max(...(validator.value as Validator[]).map((m) => idCount(fn, m, name)));
    case "object":
      return Object.entries(validator.value as Record<string, Field>).reduce(
        (sum, [key, field]) => sum + idCount(fn, field.fieldType, key),
        0,
      );
    default:
      return 0;
  }
};

/** Argumentos de `fn` com cada id, inclusive os em texto, resolvido por `resolve`. */
function argsFor(fn: PublicFunction, resolve: Resolve): Record<string, unknown> {
  const walk = (validator: Validator, name: string): unknown => {
    switch (validator.type) {
      case "id":
        return resolve(validator.tableName!);
      case "string": {
        const table = tableOf(fn.name, name);
        if (table) return resolve(table);
        if (/Ids?$/.test(name)) throw new Error(`${fn.name}: ${name} é texto sem tabela`);
        return sample(validator);
      }
      case "array": {
        const item = validator.value as Validator;
        return idCount(fn.name, item, name) > 0 ? [walk(item, name)] : [];
      }
      case "union": {
        // O membro com mais ids alcança a checagem de cada um; sem ids, fica a amostra.
        const members = validator.value as Validator[];
        const best = Math.max(...members.map((m) => idCount(fn.name, m, name)));
        return best > 0
          ? walk(
              members.find((m) => idCount(fn.name, m, name) === best)!,
              name,
            )
          : sample(validator);
      }
      case "object":
        return Object.fromEntries(
          Object.entries(validator.value as Record<string, Field>)
            .filter(([key, field]) => !field.optional || idCount(fn.name, field.fieldType, key) > 0)
            .map(([key, field]) => [key, walk(field.fieldType, key)]),
        );
      default:
        return sample(validator);
    }
  };
  return walk(fn.args, "") as Record<string, unknown>;
}

export type Outcome =
  | { resolved: true; value: unknown }
  | { resolved: false; code: string; data: unknown; message: string };
const serialize = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? `${v}n` : v instanceof ArrayBuffer ? `bytes:${v.byteLength}` : v,
  ) ?? "undefined";
/** Recusas que não dizem se o registro existe; a varredura as trata como uma só. */
const refusals = ["UNAUTHENTICATED", "ACCESS_DENIED", "NOT_FOUND"];
/** Um id no formato do convex-test que nenhum documento usa. */
const ghost = (table: string) => `${"9".repeat(Math.max(1, 32 - table.length))}${table}`;

/**
 * Chama cada função de `functions` nos casos c0 a c3, num banco novo por função, e devolve o que
 * o oráculo encontrou:
 * - a resposta traz um id ou o marcador do que o chamador não pode ver;
 * - a chamada escreveu nesses documentos ou criou um que os cita;
 * - a resposta aos ids de B difere da resposta aos mesmos ids trocados por inexistentes;
 * - um erro sem código;
 * - a query muda quando B ganha um lote extra.
 * `overrides` completa argumentos que precisam passar da validação de formato.
 */
export async function sweepIsolation(
  functions: PublicFunction[],
  options: {
    modules?: Modules;
    overrides?: Record<string, Record<string, unknown>>;
    onCall?: (fn: string, caller: Caller, which: Case, outcome: Outcome) => void;
  } = {},
) {
  const findings: Finding[] = [];
  for (const fn of functions) {
    const { t, tenants, owner, operator } = await tenantsTest(options.modules);
    const { a, b, companyA } = tenants;
    const pick = (tenant: Tenant) => (table: string) => {
      const id = tenant.ids[table]?.[0];
      if (!id) throw new Error(`${fn.name}: tabela ${table} sem documento de ${tenant.name}`);
      return id;
    };
    const resolvers: Record<Case, Resolve> = {
      c0: pick(a),
      c1: pick(b),
      c2: (table) => (table === "organizations" ? pick(a) : pick(b))(table),
      c3: pick(a),
    };
    const bIds = new Set(
      Object.entries(b.ids)
        .filter(([table]) => !globalTables.includes(table))
        .flatMap(([, ids]) => ids),
    );
    const forbidden = (which: Case) =>
      which === "c3"
        ? { markers: [companyA.marker], ids: companyA.ids }
        : { markers: [b.marker], ids: bIds };
    /** Os argumentos do caso e os ids que eles levam. */
    const argsOf = (which: Case, ghosts = false) => {
      const passed: string[] = [];
      const args = argsFor(fn, (table) => {
        const real = resolvers[which](table);
        const id = ghosts && forbidden(which).ids.has(real) ? ghost(table) : real;
        passed.push(id);
        return id;
      });
      return { args: { ...args, ...options.overrides?.[fn.name] }, passed };
    };
    const own = serialize(argsOf("c0").args);
    // Um caso cujos argumentos repetem os de c0 (função sem ids, ou só com o da organização em
    // c2) não testa nada novo; c3 só se aplica a quem seleciona algo da empresa de A.
    const differs = (which: Case) => serialize(argsOf(which).args) !== own;
    const plan: [Caller, Case][] = [
      ...(differs("c1")
        ? (["owner", "operator"] as const).map((c) => [c, "c1"] as [Caller, Case])
        : []),
      ...(differs("c2")
        ? (["owner", "operator"] as const).map((c) => [c, "c2"] as [Caller, Case])
        : []),
      ...([...companyA.ids].some((id) => own.includes(id))
        ? [["operator", "c3"] as [Caller, Case]]
        : []),
      ["owner", "c0"],
    ];
    const call = async (caller: Caller, args: Record<string, unknown>): Promise<Outcome> => {
      const client = caller === "owner" ? owner : operator;
      try {
        const value =
          fn.kind === "query"
            ? await client.query(makeFunctionReference<"query">(fn.name), args)
            : fn.kind === "mutation"
              ? await client.mutation(makeFunctionReference<"mutation">(fn.name), args)
              : await client.action(makeFunctionReference<"action">(fn.name), args);
        return { resolved: true, value };
      } catch (error) {
        const data = (error as { data?: { code?: unknown } }).data;
        return {
          resolved: false,
          code: typeof data?.code === "string" ? data.code : "SEM_CODIGO",
          data: data ?? null,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    };
    /** A resposta sem os ids que o chamador mandou, com as recusas fundidas numa só. */
    const shape = (outcome: Outcome, passed: string[]) => {
      const text = outcome.resolved
        ? serialize(outcome.value)
        : refusals.includes(outcome.code)
          ? "recusa"
          : `erro ${outcome.code} ${serialize(outcome.data)}`;
      return passed.reduce((out, id) => out.replaceAll(id, "<id>"), text);
    };
    const outcomes = new Map<string, Outcome>();
    for (const [caller, which] of plan) {
      const report = (problem: string) =>
        findings.push({ fn: fn.name, caller, case: which, problem });
      const { args, passed } = argsOf(which);
      const before = fn.kind === "query" ? null : await snapshot(t);
      const outcome = await call(caller, args);
      outcomes.set(`${caller} ${which}`, outcome);
      options.onCall?.(fn.name, caller, which, outcome);
      const { markers, ids } = forbidden(which);
      // Um id que o chamador mandou e volta ecoado não revela nada; o resto, sim.
      const leaked = (text: string, echo: boolean) =>
        markers.find((m) => text.includes(m)) ??
        [...ids].find((id) => text.includes(id) && (echo || !passed.includes(id)));
      if (outcome.resolved) {
        const found = leaked(serialize(outcome.value), false);
        if (found) report(`resposta traz ${found}`);
      } else if (outcome.code === "SEM_CODIGO" && which !== "c0")
        report(`erro sem código: ${outcome.message.slice(0, 160)}`);
      if (before) {
        const after = await snapshot(t);
        for (const [id, doc] of after) {
          if (before.get(id) === doc) continue;
          const found = (before.has(id) && ids.has(id) ? id : undefined) ?? leaked(doc, true);
          if (found) report(`escreveu em ${id} (${found})`);
        }
        for (const id of before.keys()) if (!after.has(id) && ids.has(id)) report(`apagou ${id}`);
      }
      if (which !== "c0") {
        const ghosts = argsOf(which, true);
        const expected = shape(await call(caller, ghosts.args), ghosts.passed);
        const got = shape(outcome, passed);
        if (got !== expected)
          report(
            `responde diferente de um id inexistente: ${got.slice(0, 120)} ≠ ${expected.slice(0, 120)}`,
          );
      }
    }
    if (fn.kind === "query") {
      await seedMoreOfB(t, b);
      for (const [caller, which] of plan) {
        const { args, passed } = argsOf(which);
        const again = shape(await call(caller, args), passed);
        if (shape(outcomes.get(`${caller} ${which}`)!, passed) !== again)
          findings.push({ fn: fn.name, caller, case: which, problem: "muda com lote extra de B" });
      }
    }
  }
  return findings;
}
