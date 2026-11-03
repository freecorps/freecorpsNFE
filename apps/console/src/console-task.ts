import type { FunctionReturnType } from "convex/server";
import type { MembershipRole } from "@freecorps/contracts";
import type { api } from "../../../platform/convex/_generated/api";
import type { Organization } from "./organizations";
import type { IconName } from "./ui/icons";

/**
 * The task the Início guides (#510): a closed list, with the URL value in Portuguese. The choice
 * is a preference of this browser, never access: the server computes every step (`tasks` of
 * `consoleHome.summary`) and checks every action again.
 */
export const consoleTasks = ["importar", "emitir", "capturar", "integrar"] as const;
export type ConsoleTask = (typeof consoleTasks)[number];
/** The key of each task in `consoleHome.summary.tasks`. */
export const summaryTask = {
  importar: "import",
  emitir: "issue",
  capturar: "capture",
  integrar: "integrate",
} as const satisfies Record<ConsoleTask, string>;

export const taskLabels: Record<ConsoleTask, string> = {
  importar: "Importar XML",
  emitir: "Emitir NFS-e (simulada)",
  capturar: "Capturar NF-e",
  integrar: "Integrar meu sistema",
};

/** A known task, or `undefined`: an unknown value is ignored. */
export function parseTask(value: unknown): ConsoleTask | undefined {
  return consoleTasks.find((task) => task === value);
}

/**
 * The search that carries a task to the next console address, or none: only a known task goes
 * on, so an unknown value stops at the first screen that reads it.
 */
export function taskSearch(value: unknown): { tarefa?: ConsoleTask } {
  const tarefa = parseTask(value);
  return tarefa ? { tarefa } : {};
}

/**
 * `validateSearch` of the addresses the task crosses on its way to the Início (`/console`,
 * `/app`): only a known `tarefa`; anything else in the query (another `redirect`, ids) is dropped.
 */
export const taskOnTheWay = (search: Record<string, unknown>): { tarefa?: ConsoleTask } =>
  taskSearch(search.tarefa);

/**
 * The public entry of a task (landing, guides, e-mails): the signup, which returns through the
 * login redirect (`safeRedirect`) to `/console?tarefa=…`; the console home then opens the
 * organization the server finds with the same task. Never an organization or company id: the
 * organization is authorized by the server when the Início loads. Permanent once public
 * (docs/plataforma/PUBLIC.md).
 */
export function taskEntryHref(task: ConsoleTask) {
  return `/signup?${new URLSearchParams({ redirect: `/console?tarefa=${task}` })}`;
}

/** The tasks the role works on: a developer reads the fiscal work through integrations. */
export const roleTasks = (role: MembershipRole): readonly ConsoleTask[] =>
  role === "developer" ? ["integrar"] : consoleTasks;
const defaultTask = (role: MembershipRole): ConsoleTask =>
  role === "developer" ? "integrar" : "importar";

export const taskStorageKey = (organizationSlug: string) => `fnfe:console-task:${organizationSlug}`;
export function rememberedTask(organizationSlug: string) {
  try {
    return parseTask(globalThis.localStorage?.getItem(taskStorageKey(organizationSlug)));
  } catch {
    return undefined;
  }
}
export function rememberTask(organizationSlug: string, task: ConsoleTask) {
  try {
    globalThis.localStorage?.setItem(taskStorageKey(organizationSlug), task);
  } catch {
    // Private mode or a full storage: the choice lasts while the page is open.
  }
}

/** `?tarefa=` wins, then this browser's last choice, then the role's default. */
export function chosenTask(
  role: MembershipRole,
  ...candidates: Array<ConsoleTask | undefined>
): ConsoleTask {
  const allowed = roleTasks(role);
  return candidates.find((task) => task && allowed.includes(task)) ?? defaultTask(role);
}

type Summary = FunctionReturnType<typeof api.consoleHome.summary>;
type Params = { organizationSlug: string };
/** A console address, ready for `<Link {...destination}>`. */
export type Destination =
  | { to: "/app/$organizationSlug/onboarding"; params: Params }
  | { to: "/app/$organizationSlug/companies"; params: Params }
  | {
      to: "/app/$organizationSlug/companies/$companyId";
      params: Params & { companyId: string };
      search: { aba: "certificado" | "fiscal" | "captura" };
    }
  | { to: "/app/$organizationSlug/imports"; params: Params; search: { company?: string } }
  | { to: "/app/$organizationSlug/documents"; params: Params; search: { company?: string } }
  | {
      to: "/app/$organizationSlug/issuances";
      params: Params;
      search: { company?: string; view?: "new" };
    }
  | {
      to: "/app/$organizationSlug/developer/$developerSection";
      params: Params & { developerSection: "projects" };
    };
export type TaskDestination = Destination & { label: string; icon: IconName };

/**
 * The company a task is about: the first one a step names (for importing, the company with a
 * document, else the demonstration one, else the first).
 */
export function taskCompany(summary: Summary | undefined, task: ConsoleTask) {
  const value = summary?.tasks[summaryTask[task]];
  return value?.steps.find((step) => step.companyId)?.companyId ?? null;
}

type Step = NonNullable<Summary["tasks"][keyof Summary["tasks"]]>["steps"][number];
export type StepAction = Destination & { label: string };
/** Where a step the member can take now is done; `demo` is the demonstration company. */
export function stepAction(
  org: Organization,
  task: ConsoleTask,
  step: Step,
  demo: string | null,
): StepAction | null {
  const params = { organizationSlug: org.slug };
  const company = (aba: "certificado" | "fiscal" | "captura", label: string): StepAction =>
    step.companyId
      ? {
          to: "/app/$organizationSlug/companies/$companyId",
          params: { ...params, companyId: step.companyId },
          search: { aba },
          label,
        }
      : { to: "/app/$organizationSlug/companies", params, label };
  const integrations = (label: string): StepAction => ({
    to: "/app/$organizationSlug/developer/$developerSection",
    params: { ...params, developerSection: "projects" },
    label,
  });
  const actions: Record<Step["key"], () => StepAction | null> = {
    company: () =>
      task === "importar"
        ? { to: "/app/$organizationSlug/onboarding", params, label: "Abrir os primeiros passos" }
        : { to: "/app/$organizationSlug/companies", params, label: "Cadastrar a empresa" },
    permission: () => null,
    // The demonstration company's example is imported on the import screen, with one click.
    document: () => ({
      to: "/app/$organizationSlug/imports",
      params,
      search: { company: step.companyId ?? undefined },
      label:
        step.companyId && step.companyId === demo ? "Importar o XML de exemplo" : "Importar XML",
    }),
    certificate: () => company("certificado", "Enviar o certificado"),
    profile: () => company("fiscal", "Configurar o perfil"),
    authorize: () => company("captura", "Autorizar a captura"),
    start: () => company("captura", "Iniciar a captura"),
    project: () => integrations("Criar o projeto"),
    key: () => integrations("Criar a chave"),
  };
  return actions[step.key]();
}

/**
 * The header's action for each task; `null` when the role does not act on it, while the summary
 * loads and where the deployment does not offer the task. Until the task has its company (and,
 * for issuing, its NFS-e profile), the action is the next step's (or none): the task's own
 * screen could not succeed without it.
 */
const prerequisites: Record<ConsoleTask, readonly Step["key"][]> = {
  importar: ["company"],
  // Without the profile, the issuance would be refused: the header never offers it.
  emitir: ["company", "profile"],
  capturar: ["company"],
  integrar: [],
};
export function taskDestinations(
  org: Organization,
  summary: Summary | undefined,
): Record<ConsoleTask, TaskDestination | null> {
  const none: Record<ConsoleTask, null> = {
    importar: null,
    emitir: null,
    capturar: null,
    integrar: null,
  };
  if (!summary) return none;
  const params = { organizationSlug: org.slug };
  const company = (task: ConsoleTask) => taskCompany(summary, task) ?? undefined;
  const captureCompany = company("capturar");
  const destinations: Record<ConsoleTask, TaskDestination | null> = {
    importar: org.capabilities.operateDocuments
      ? {
          to: "/app/$organizationSlug/imports",
          params,
          search: { company: company("importar") },
          label: "Importar XML",
          icon: "upload",
        }
      : null,
    emitir: org.capabilities.operateDocuments
      ? {
          to: "/app/$organizationSlug/issuances",
          params,
          search: { company: company("emitir"), view: "new" },
          label: "Nova emissão simulada",
          icon: "plus",
        }
      : null,
    capturar: !org.capabilities.readDocuments
      ? null
      : captureCompany
        ? {
            to: "/app/$organizationSlug/companies/$companyId",
            params: { ...params, companyId: captureCompany },
            search: { aba: "captura" },
            label: "Abrir captura",
            icon: "inbox",
          }
        : { to: "/app/$organizationSlug/companies", params, label: "Abrir captura", icon: "inbox" },
    integrar: org.capabilities.manageIntegrations
      ? {
          to: "/app/$organizationSlug/developer/$developerSection",
          params: { ...params, developerSection: "projects" },
          label: "Abrir integrações",
          icon: "code",
        }
      : null,
  };
  const demo = summary.tasks.import?.demonstrationCompanyId ?? null;
  for (const task of consoleTasks) {
    const value = summary.tasks[summaryTask[task]];
    if (!destinations[task] || !value) continue;
    if (value.steps.every((step) => step.state === "unavailable")) destinations[task] = null;
    else if (
      !value.complete &&
      value.steps.some((s) => prerequisites[task].includes(s.key) && s.state !== "done")
    ) {
      const next = value.steps.find((step) => step.state === "todo");
      const action = next ? stepAction(org, task, next, demo) : null;
      destinations[task] = action && { ...action, icon: "building" };
    }
  }
  return destinations;
}
