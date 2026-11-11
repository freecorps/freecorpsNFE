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

const carriesId = (validator: Validator): boolean =>
  validator.type === "id" ||
  (["array", "union"].includes(validator.type) &&
    [validator.value as Validator | Validator[]].flat().some(carriesId)) ||
  (validator.type === "object" &&
    Object.values(validator.value as Record<string, Field>).some((f) => carriesId(f.fieldType)));

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
      // Sem id em jogo, `null` é o estado vivo (`revokedAt`, cursor do início); com id, o
      // primeiro membro, o mesmo que a ordem das tabelas segue.
      const members = validator.value as Validator[];
      const empty = members.some(carriesId) ? undefined : members.find((m) => m.type === "null");
      return sample(empty ?? members[0]!, id, text);
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
/**
 * Tabela que pertence a `root`: exige, direta ou indiretamente, um id dela, ou o leva como campo
 * opcional do primeiro nível (`billingEvents.organizationId`, `onboarding.companyId`).
 */
const scopedBy = (root: string, field: string) => {
  const memo = new Map<string, boolean>();
  const scoped = (name: string): boolean =>
    memo.get(name) ??
    (memo
      .set(
        name,
        name === root ||
          tableFields(name)[field]?.fieldType.tableName === root ||
          requires.get(name)!.some(scoped),
      )
      .get(name) as boolean);
  return scoped;
};
const tenantScoped = scopedBy("organizations", "organizationId");
const companyScoped = scopedBy("companies", "companyId");
/** Tabelas da plataforma, sem dono: referências, filas de manutenção, e-mail de desenvolvimento. */
const globalTables = tableNames.filter((name) => !tenantScoped(name));

/**
 * Campos que levam o documento mínimo ao estado comum, para que a chamada com ids de A passe da
 * checagem de acesso e o mesmo caminho com ids de B prove a recusa: concessão de projeto ativa e
 * com todos os escopos, versão publicada completa, operação concluída, endpoint ativo, emissão
 * com tomador legível. `text` é o texto marcado do inquilino.
 */
const coherent: Record<string, (text: string) => Record<string, unknown>> = {
  projectCompanies: () => ({
    active: true,
    scopes: [...integrationScopes],
    environments: ["sandbox"],
  }),
  documentVersions: () => ({ state: "complete" }),
  operations: () => ({ state: "succeeded" }),
  webhookEndpoints: () => ({ active: true }),
  documentExports: () => ({ state: "succeeded", membershipVersion: 1 }),
  importFiles: () => ({ state: "accepted" }),
  coldArchiveRuns: () => ({ reason: "free_inactive" }),
  issuances: (text) => ({
    snapshot: JSON.stringify({
      issueDate: text,
      competence: text,
      market: "domestic",
      amount: { currency: "BRL", value: "1.00" },
      taker: {
        kind: "national",
        document: text,
        name: text,
        address: {
          municipalityCode: text,
          postalCode: text,
          street: text,
          number: text,
          district: text,
        },
      },
    }),
  }),
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
  (into._storage ??= []).push(storage);
  const id = (table: string) =>
    table === "_storage"
      ? storage
      : table.startsWith("_")
        ? `1${table}`
        : (into[table]?.[0] ?? tenant.ids[table]?.[0] ?? `1${table}`);
  const text = (table: string) =>
    companyScoped(table) ? `${tenant.marker}-empresa` : tenant.marker;
  for (const table of seedOrder.filter((t) => tables.includes(t))) {
    const doc = {
      ...(sample(tableJson(table), id, text(table)) as object),
      ...coherent[table]?.(text(table)),
    };
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
  // O slug gerado de cada organização é o marcador do inquilino.
  const slugs = new Map([a, b].map((tenant) => [tenant.ids.organizations![0]!, tenant.marker]));
  return { t, a, b, companyA, slugs, owner, operator };
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

/**
 * Um segundo lote da empresa de A: o que o operator sem concessão lê da organização não muda
 * com ele.
 */
async function seedMoreOfCompanyA(t: PlatformTest, a: Tenant) {
  // Só as tabelas que exigem a empresa: as que a citam como opcional (`onboarding`) guardam um
  // estado por organização, que um segundo documento tornaria impossível.
  const required = (name: string): boolean =>
    name === "companies" || requires.get(name)!.some(required);
  const scoped = tableNames.filter(
    (name) => required(name) && name !== "companies" && !terminal.includes(name),
  );
  await t.run(async (ctx) => {
    const extra: Tables = {};
    await seedTables(ctx as unknown as Ctx, { ...a, marker: `${a.marker}-lote` }, scoped, extra);
  });
}

/** Todos os documentos das tabelas do schema e os agendamentos, com os argumentos, por id. */
async function snapshot(t: PlatformTest) {
  const rows = await t.run(async (ctx) => {
    const all: [string, string][] = [];
    const add = (doc: { _id: unknown }) =>
      all.push([
        String(doc._id),
        JSON.stringify(doc, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
      ]);
    for (const table of tableNames)
      for (const doc of await ctx.db.query(table as TableNames).collect()) add(doc);
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) add(job);
    for (const file of await ctx.db.system.query("_storage").collect()) add(file);
    return all;
  });
  return new Map(rows);
}

// ---------------------------------------------------------------------------------------------
// Varredura

/**
 * O que cada argumento de texto seleciona: a tabela do id (`companies`) ou uma forma derivada
 * dele (`organizations#slug`, `memberships#actor`). O mesmo nome com outro sentido numa função
 * fica em `textSelectorsByFunction`. Um texto fora destes mapas e de `plainText` reprova a
 * varredura: a função nova precisa dizer se ele seleciona algo.
 */
const textSelectors: Record<string, string> = {
  company: "companies",
  companyId: "companies",
  companyIds: "companies",
  projectId: "projects",
  projectIds: "projects",
  documentId: "fiscalDocuments",
  versionId: "documentVersions",
  issuanceId: "issuances",
  batch: "imports",
  slug: "organizations#slug",
  remembered: "organizations#slug",
  actor: "memberships#actor",
  actors: "memberships#actor",
};
const textSelectorsByFunction: Record<string, Record<string, string>> = {
  "documentDownloads:ticket": { artifactId: "documentArtifacts" },
  "issuanceConsole:artifactTicket": { artifactId: "issuanceArtifacts" },
  "observability:investigate": { reference: "operations" },
  // O slug de criação é o nome pedido, não um seletor; a disponibilidade dele é pública.
  "organizations:create": { slug: "" },
};
/** Argumentos de texto que não selecionam registro: conteúdo, chaves de idempotência, filtros. */
const plainText = new Set([
  "action",
  "activityCode",
  "campinasDpsSeries",
  "city",
  "cnae",
  "cnpj",
  "code",
  "competence",
  "complement",
  "confirmation",
  "contextKey",
  "country",
  "cTribMun",
  "cTribNac",
  "currency",
  "cursor",
  "date",
  "description",
  "district",
  "document",
  "domesticActivityCode",
  "dpsSeries",
  "email",
  "endCursor",
  "exportActivityCode",
  "externalReference",
  "from",
  "idempotencyKey",
  "issRate",
  "issueDate",
  "issuerEmail",
  "key",
  "kind",
  "label",
  "lc116Item",
  "municipalityCode",
  "municipalRegistration",
  "name",
  "nbs",
  "nif",
  "number",
  "password",
  "period",
  "postalCode",
  "q",
  "reason",
  "secret",
  "series",
  "sha256",
  "state",
  "street",
  "terms",
  "termsOfUse",
  "to",
  "token",
  "transferToken",
  "url",
  "value",
  "version",
  "cIndOp",
  "cst",
  "cClassTrib",
]);

/**
 * c0: só ids de A; c1: só ids de B; c2: `organizationId` de A com os outros ids de B, e listas
 * com um id de A e um de B; c3: ids de A, pelo operator sem concessão da empresa de A.
 */
type Case = "c0" | "c1" | "c2" | "c3";
type Caller = "owner" | "operator";
type Finding = { fn: string; caller: Caller; case: Case; problem: string };

/** Resolve um seletor (`tabela` ou `tabela#forma`) para o valor passado à função. */
type Resolve = (selector: string) => string;
const selectorOf = (fn: string, name: string) =>
  textSelectorsByFunction[fn]?.[name] ?? textSelectors[name];
const idCount = (fn: string, validator: Validator, name = ""): number => {
  switch (validator.type) {
    case "id":
      return 1;
    case "string":
      return selectorOf(fn, name) ? 1 : 0;
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

/**
 * Argumentos de `fn` com cada id, inclusive os em texto, resolvido por `resolve`. Com `also`, toda
 * lista de ids leva antes um valor de `also` (o id de A no c2).
 */
function argsFor(fn: PublicFunction, resolve: Resolve, also?: Resolve): Record<string, unknown> {
  const walk = (validator: Validator, name: string, by: Resolve): unknown => {
    switch (validator.type) {
      case "id":
        return by(validator.tableName!);
      case "string": {
        const selector = selectorOf(fn.name, name);
        if (selector) return by(selector);
        if (selector !== "" && !plainText.has(name))
          throw new Error(`${fn.name}: o texto ${name} não diz se seleciona um registro`);
        return sample(validator);
      }
      case "array": {
        const item = validator.value as Validator;
        if (idCount(fn.name, item, name) === 0) return [];
        return also ? [walk(item, name, also), walk(item, name, by)] : [walk(item, name, by)];
      }
      case "union": {
        // O membro com mais ids alcança a checagem de cada um; sem ids, fica a amostra.
        const members = validator.value as Validator[];
        const best = Math.max(...members.map((m) => idCount(fn.name, m, name)));
        return best > 0
          ? walk(
              members.find((m) => idCount(fn.name, m, name) === best)!,
              name,
              by,
            )
          : sample(validator);
      }
      case "object":
        return Object.fromEntries(
          Object.entries(validator.value as Record<string, Field>)
            .filter(([key, field]) => !field.optional || idCount(fn.name, field.fieldType, key) > 0)
            .map(([key, field]) => [key, walk(field.fieldType, key, by)]),
        );
      default:
        return sample(validator);
    }
  };
  return walk(fn.args, "", resolve) as Record<string, unknown>;
}

export type Outcome =
  | { resolved: true; value: unknown }
  | { resolved: false; code: string; data: unknown; message: string };
const serialize = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? `${v}n` : v instanceof ArrayBuffer ? `bytes:${v.byteLength}` : v,
  ) ?? "undefined";
/**
 * Recusas que a varredura trata como uma só, como a seção sem sessão: um id de outra organização
 * recebe `ACCESS_DENIED` e um inexistente, `NOT_FOUND`. Distinguir os dois exige já ter o id,
 * que o Convex não deixa adivinhar; o conteúdo do registro continua fechado.
 */
export const refusals = ["UNAUTHENTICATED", "ACCESS_DENIED", "NOT_FOUND"];
/** Um id no formato do convex-test que nenhum documento usa. */
const ghost = (table: string) => `${"9".repeat(Math.max(1, 32 - table.length))}${table}`;

/**
 * Chama cada função de `functions` nos casos c0 a c3, num banco novo por função, e devolve o que
 * o oráculo encontrou:
 * - a resposta traz um id ou o marcador do que o chamador não pode ver (B, ou a empresa de A
 *   no c3);
 * - a chamada escreveu nesses documentos, criou um que os cita ou agendou função com eles;
 * - a resposta aos ids de B difere da resposta aos mesmos ids trocados por inexistentes, com as
 *   `refusals` fundidas numa só;
 * - um erro sem código fora do c0;
 * - a query, ou a action que respondeu sem escrever, muda quando B ganha um lote extra, ou,
 *   para o operator no c3, quando a empresa de A ganha um.
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
    const { t, a, b, companyA, slugs, owner, operator } = await tenantsTest(options.modules);
    const pick = (tenant: Tenant) => (table: string) => {
      const id = tenant.ids[table]?.[0];
      if (!id) throw new Error(`${fn.name}: tabela ${table} sem documento de ${tenant.name}`);
      return id;
    };
    const ids: Record<Case, (table: string) => string> = {
      c0: pick(a),
      c1: pick(b),
      c2: (table) => (table === "organizations" ? pick(a) : pick(b))(table),
      c3: pick(a),
    };
    const forms: Record<string, (id: string) => string> = {
      slug: (id) => slugs.get(id) ?? `slug-${id}`,
      actor: (id) => `member:${id}`,
    };
    const bIds = new Set(
      Object.entries(b.ids)
        .filter(([table]) => !globalTables.includes(table))
        .flatMap(([, list]) => list),
    );
    const forbidden = (which: Case) =>
      which === "c3"
        ? { markers: [companyA.marker], ids: companyA.ids }
        : { markers: [b.marker], ids: bIds };
    /** Os argumentos do caso e os valores de seleção que eles levam. */
    const argsOf = (which: Case, ghosts = false) => {
      const passed: string[] = [];
      const by =
        (choose: (table: string) => string): Resolve =>
        (selector) => {
          const [table, form] = selector.split("#") as [string, string | undefined];
          const real = choose(table);
          const id = ghosts && forbidden(which).ids.has(real) ? ghost(table) : real;
          const value = form ? forms[form]!(id) : id;
          passed.push(value);
          return value;
        };
      const args = argsFor(fn, by(ids[which]), which === "c2" ? by(pick(a)) : undefined);
      return { args: { ...args, ...options.overrides?.[fn.name] }, passed };
    };
    const own = serialize(argsOf("c0").args);
    // Um caso cujos argumentos repetem os de c0 (função sem ids, ou só com o da organização em
    // c2) não testa nada novo, salvo pelo operator: c3 o chama sempre com os ids de A.
    const differs = (which: Case) => serialize(argsOf(which).args) !== own;
    // c0 vem primeiro, sobre o banco recém-semeado: é a medida de até onde os dados alcançam.
    const plan: [Caller, Case][] = [
      ["owner", "c0"],
      ...(differs("c1")
        ? (["owner", "operator"] as const).map((c) => [c, "c1"] as [Caller, Case])
        : []),
      ...(differs("c2")
        ? (["owner", "operator"] as const).map((c) => [c, "c2"] as [Caller, Case])
        : []),
      ["operator", "c3"],
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
    /** A resposta sem os valores que o chamador mandou, com as recusas fundidas. */
    const shape = (outcome: Outcome, passed: string[]) => {
      const text = outcome.resolved
        ? serialize(outcome.value)
        : refusals.includes(outcome.code)
          ? "recusa"
          : `erro ${outcome.code} ${serialize(outcome.data)}`;
      return passed.reduce((out, value) => out.replaceAll(value, "<id>"), text);
    };
    // O que respondeu sem escrever repete quando B ganha outro lote.
    const repeat = new Map<string, Outcome>();
    for (const [caller, which] of plan) {
      const report = (problem: string) =>
        findings.push({ fn: fn.name, caller, case: which, problem });
      const { args, passed } = argsOf(which);
      const before = await snapshot(t);
      const outcome = await call(caller, args);
      options.onCall?.(fn.name, caller, which, outcome);
      const { markers, ids: hidden } = forbidden(which);
      // Um id que o chamador mandou e volta ecoado não revela nada; o resto, sim.
      const leaked = (text: string, echo: boolean) =>
        markers.find((m) => text.includes(m)) ??
        [...hidden].find((id) => text.includes(id) && (echo || !passed.includes(id)));
      if (outcome.resolved) {
        const found = leaked(serialize(outcome.value), false);
        if (found) report(`resposta traz ${found}`);
      } else if (outcome.code === "SEM_CODIGO" && which !== "c0")
        report(`erro sem código: ${outcome.message.slice(0, 160)}`);
      const after = await snapshot(t);
      let wrote = false;
      for (const [id, doc] of after) {
        if (before.get(id) === doc) continue;
        wrote = true;
        const found = (before.has(id) && hidden.has(id) ? id : undefined) ?? leaked(doc, true);
        if (found) report(`escreveu em ${id} (${found})`);
      }
      for (const id of before.keys()) {
        if (after.has(id)) continue;
        wrote = true;
        if (hidden.has(id)) report(`apagou ${id}`);
      }
      if (fn.kind !== "mutation" && !wrote) repeat.set(`${caller} ${which}`, outcome);
      const ghosts = argsOf(which, true);
      if (which !== "c0" && serialize(ghosts.args) !== serialize(args)) {
        const expected = shape(await call(caller, ghosts.args), ghosts.passed);
        const got = shape(outcome, passed);
        if (got !== expected)
          report(
            `responde diferente de um id inexistente: ${got.slice(0, 120)} ≠ ${expected.slice(0, 120)}`,
          );
      }
    }
    if (repeat.size) {
      await seedMoreOfB(t, b);
      for (const [caller, which] of plan) {
        const first = repeat.get(`${caller} ${which}`);
        if (!first) continue;
        const { args, passed } = argsOf(which);
        if (shape(first, passed) !== shape(await call(caller, args), passed))
          findings.push({ fn: fn.name, caller, case: which, problem: "muda com lote extra de B" });
      }
      const first = repeat.get("operator c3");
      if (first) {
        await seedMoreOfCompanyA(t, a);
        const { args, passed } = argsOf("c3");
        if (shape(first, passed) !== shape(await call("operator", args), passed))
          findings.push({
            fn: fn.name,
            caller: "operator",
            case: "c3",
            problem: "muda com lote extra da empresa de A",
          });
      }
    }
  }
  return findings;
}
