import { expect, it } from "vite-plus/test";
import { modulePath, modules } from "../../tests/helpers/convex-modules";

/**
 * Cada operação grava os nomes das funções da sua tarefa (`taskSpec`) como texto, e o protocolo
 * os resolve com `makeFunctionReference` só na hora de rodar (`operationWorker.run`,
 * `operations.checkpoint`, `operations.publish`). Renomear ou remover um export não quebra a
 * compilação; quebra a operação pendente que o gravou. Este teste descobre as tarefas
 * exportadas pelos módulos de platform/convex e confere cada nome contra os exports carregados.
 */
type FieldType = { type: string; tableName?: string };
type Validator = {
  type: string;
  value?: Record<string, { fieldType: FieldType; optional: boolean }>;
};
type Registered = {
  isInternal?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  exportArgs?: () => string;
};
type Task = {
  name: string;
  workload: string;
  scope: string;
  executor: string;
  reconciler?: string;
  checkpoint?: string;
  onSucceeded?: string;
};

const operationId: FieldType = { type: "id", tableName: "operations" };
/** O que o protocolo chama em cada papel: o tipo da função e os argumentos que passa. */
type Role = "effect" | "checkpoint" | "onSucceeded";
const roles: Record<Role, { kind: string; args: Record<string, FieldType> }> = {
  effect: {
    kind: "action",
    args: {
      operationId,
      generation: { type: "number" },
      fence: { type: "number" },
      request: { type: "string" },
    },
  },
  checkpoint: { kind: "mutation", args: { operationId, response: { type: "string" } } },
  onSucceeded: { kind: "mutation", args: { operationId } },
};
const fieldRoles = {
  executor: "effect",
  reconciler: "effect",
  checkpoint: "checkpoint",
  onSucceeded: "onSucceeded",
} as const satisfies Record<string, Role>;

/**
 * Todo nome que uma operação pode ter gravado, com o papel em que foi gravado. Trocar o nome numa
 * tarefa não tira o antigo daqui: ele continua precisando resolver enquanto houver operação
 * pendente com ele, como alias. Só saia da lista depois de migrar ou encerrar essas operações.
 */
const storedNames: Record<string, Role> = {
  "captureProcessing:checkpoint": "checkpoint",
  "captureProcessing:published": "onSucceeded",
  "captureWorker:execute": "effect",
  "importProcessing:checkpoint": "checkpoint",
  "importProcessing:published": "onSucceeded",
  "importWorker:execute": "effect",
  "issuanceProcessing:checkpointCancel": "checkpoint",
  "issuanceProcessing:checkpointIssue": "checkpoint",
  "issuanceWorker:cancel": "effect",
  "issuanceWorker:issue": "effect",
  "issuanceWorker:reconcileCancel": "effect",
  "issuanceWorker:reconcileIssue": "effect",
  "refusalReprocess:execute": "effect",
  "registryWorker:execute": "effect",
  "registryWorker:reconcile": "effect",
};

/**
 * Tarefas que o produto grava hoje. A descoberta precisa achar ao menos estas, para que um
 * filtro errado não aprove o teste sem conferir nada; uma tarefa nova exportada é conferida sem
 * entrar nesta lista. Uma tarefa montada dentro de uma função, sem export, escapa da descoberta.
 */
const knownTasks = [
  "connections.sync",
  "documents.cancel",
  "documents.capture",
  "documents.import",
  "documents.issue",
  "documents.reprocess",
  "documents.reprocess_refusals",
  "registry.lookup",
];

const isTask = (value: unknown): value is Task =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Task).name === "string" &&
  typeof (value as Task).workload === "string" &&
  typeof (value as Task).scope === "string" &&
  typeof (value as Task).executor === "string";

/** As tarefas exportadas pelos módulos do produto; `testing/` grava tarefas sintéticas. */
async function exportedTasks() {
  const found = new Map<string, { task: Task; from: string[] }>();
  for (const [path, load] of Object.entries(modules)) {
    const module = modulePath(path);
    // `*.config.ts` monta os componentes e não carrega fora do `convex dev`.
    if (/^(_generated|testing)\//.test(module) || module.endsWith(".config")) continue;
    for (const [name, value] of Object.entries((await load()) as Record<string, unknown>)) {
      if (!isTask(value)) continue;
      const entry = found.get(value.name);
      if (entry) {
        expect(value, `tarefa ${value.name} exportada com campos diferentes`).toEqual(entry.task);
        entry.from.push(`${module}:${name}`);
      } else found.set(value.name, { task: value, from: [`${module}:${name}`] });
    }
  }
  return found;
}

/** Cada nome gravado pelas tarefas: o papel e onde aparece (`tarefa (export), campo`). */
async function namesInTasks() {
  const names: { reference: string; role: Role; where: string }[] = [];
  for (const [taskName, { task, from }] of await exportedTasks())
    for (const [field, role] of Object.entries(fieldRoles)) {
      const reference = task[field as keyof typeof fieldRoles];
      if (reference !== undefined)
        names.push({ reference, role, where: `tarefa ${taskName} (${from.join(", ")}), ${field}` });
    }
  return names;
}

/** O export que o nome `módulo:função` resolve, ou o motivo de não resolver. */
async function resolve(reference: string): Promise<Registered | string> {
  const match = /^([\w/]+):(\w+)$/.exec(reference);
  if (!match) return "não tem a forma módulo:função";
  const [, module, name] = match;
  if (!module || !name) return "não tem a forma módulo:função";
  const load = modules[`../../platform/convex/${module}.ts`];
  if (!load) return `o módulo ${module} não existe`;
  const value = ((await load()) as Record<string, Registered | undefined>)[name];
  if (!value || typeof value !== "function") return `${module} não exporta a função ${name}`;
  return value;
}

/** O que impede o protocolo de chamar `fn` no papel `role`. */
function mismatches(fn: Registered, role: Role) {
  const problems: string[] = [];
  const kind = fn.isQuery ? "query" : fn.isMutation ? "mutation" : fn.isAction ? "action" : "?";
  if (kind !== roles[role].kind) problems.push(`é ${kind}, o protocolo chama ${roles[role].kind}`);
  if (!fn.isInternal) problems.push("é pública, precisa ser interna");
  const validator = JSON.parse(fn.exportArgs?.() ?? "{}") as Validator;
  if (validator.type !== "object" || !validator.value)
    return [...problems, "sem validador de objeto nos argumentos"];
  const passed = roles[role].args;
  for (const [arg, expected] of Object.entries(passed)) {
    const declared = validator.value[arg]?.fieldType;
    if (!declared) problems.push(`não declara ${arg}, que o protocolo passa`);
    else if (declared.type !== expected.type || declared.tableName !== expected.tableName)
      problems.push(
        `declara ${arg} como ${JSON.stringify(declared)}, o protocolo passa ${expected.type}`,
      );
  }
  for (const [arg, field] of Object.entries(validator.value))
    if (!field.optional && !(arg in passed))
      problems.push(`exige ${arg}, que o protocolo não passa`);
  return problems;
}

it("descobre todas as tarefas que o produto grava", async () => {
  expect([...(await exportedTasks()).keys()].sort()).toEqual(expect.arrayContaining(knownTasks));
});

it("todo nome gravado por uma tarefa está na lista de nomes gravados, no mesmo papel", async () => {
  const problems = (await namesInTasks())
    .filter(({ reference, role }) => storedNames[reference] !== role)
    .map(({ reference, role, where }) =>
      storedNames[reference]
        ? `${where} "${reference}": gravado como ${role}, listado como ${storedNames[reference]}`
        : `${where} "${reference}": falta em storedNames`,
    );
  expect(problems, problems.join("\n")).toEqual([]);
});

it("todo nome que uma operação pode ter gravado resolve para função interna do tipo e argumentos esperados", async () => {
  const users = new Map<string, string[]>();
  for (const { reference, where } of await namesInTasks())
    users.set(reference, [...(users.get(reference) ?? []), where]);
  const problems: string[] = [];
  for (const [reference, role] of Object.entries(storedNames)) {
    const where = `"${reference}" (${users.get(reference)?.join("; ") ?? "nenhuma tarefa atual"})`;
    const fn = await resolve(reference);
    const found = typeof fn === "string" ? [fn] : mismatches(fn, role);
    problems.push(...found.map((problem) => `${where}: ${problem}`));
  }
  expect(problems, problems.join("\n")).toEqual([]);
});
