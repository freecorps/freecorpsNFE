import { v, type Infer, type Validator } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Readiness of the Início by task (#510): what the member still needs to import, issue in the
 * simulated sandbox, capture NF-e or integrate, each task with its own steps. The summary collects
 * the facts of the companies the member reaches; this file only turns them into steps, so the
 * rule of each task reads in one place.
 *
 * A step is `done`, `todo` (not done, and the member can take it now), `blocked` (it cannot:
 * `role` when its role does not take that step, `no-company` when it reaches no company for it
 * and cannot declare one, `freecorps` when Freecorps blocked the company's capture release,
 * `previous` when a prerequisite step is not done yet) or `unavailable` (`deployment`: the
 * deployment does not offer the task). The screen shows the first `todo`. `companyId` points it to
 * the company the step is about. A task is complete when every step but `permission` is done.
 */
const stepState = v.union(
  v.literal("done"),
  v.literal("todo"),
  v.literal("blocked"),
  v.literal("unavailable"),
);
const stepReason = v.union(
  v.literal("role"),
  v.literal("no-company"),
  v.literal("freecorps"),
  v.literal("previous"),
  v.literal("deployment"),
);
const taskValue = <K extends Validator<string, "required", string>>(key: K) =>
  v.object({
    complete: v.boolean(),
    steps: v.array(
      v.object({
        key,
        state: stepState,
        companyId: v.union(v.id("companies"), v.null()),
        reason: v.optional(stepReason),
      }),
    ),
  });
const company = v.literal("company"),
  permission = v.literal("permission"),
  certificate = v.literal("certificate");
export const tasksValue = v.object({
  /** `null` for a developer, like the rest of the fiscal work: it reads it through integrations. */
  import: v.union(
    v.null(),
    v.object({
      ...taskValue(v.union(company, permission, v.literal("document"))).fields,
      /** The demonstration company the member reaches, to import the example into. */
      demonstrationCompanyId: v.union(v.id("companies"), v.null()),
    }),
  ),
  issue: v.union(
    v.null(),
    taskValue(v.union(company, permission, certificate, v.literal("profile"))),
  ),
  capture: v.union(
    v.null(),
    taskValue(v.union(company, certificate, v.literal("authorize"), v.literal("start"))),
  ),
  integrate: taskValue(v.union(v.literal("project"), v.literal("key"))),
});
type CompanyId = Id<"companies">;
type Step<K extends string> = {
  key: K;
  state: Infer<typeof stepState>;
  companyId: CompanyId | null;
  reason?: Infer<typeof stepReason>;
};

/** What the summary read of one declared company the member reaches. */
export type DeclaredFacts = {
  companyId: CompanyId;
  /** Its own A1, active and valid at `asOf` (`ownCertificate`). */
  certificate: boolean;
  profile: boolean;
  /** Transport of a sandbox issuance for it is not the simulator (`transportModeFor`). */
  certificateForIssuance: boolean;
  /** Fiscal capture released (`captureReleaseState`). */
  released: boolean;
  /** Freecorps blocked the release: `captureRelease.enable` refuses it. */
  releaseBlocked: boolean;
  /** Production stream of the organization, not paused. */
  started: boolean;
};
export type TaskFacts = {
  role: Doc<"memberships">["role"];
  /** Owner or admin: declares companies, uploads certificates, saves profiles, releases capture. */
  manage: boolean;
  /** Owner, admin or operator: imports, issues and starts a capture. */
  write: boolean;
  companies: CompanyId[];
  demonstrationCompanyId: CompanyId | null;
  /** First company with a document in the base environment, if any. */
  documentCompanyId: CompanyId | null;
  declared: DeclaredFacts[];
  /** The simulated sandbox issuance: only on a sandbox deployment. */
  issuanceAvailable: boolean;
  captureAvailable: boolean;
  /** `null` when the role does not manage integrations. */
  integration: { project: boolean; key: boolean } | null;
};

const step = <K extends string>(
  key: K,
  done: boolean,
  companyId: CompanyId | null,
  allowed: boolean,
): Step<K> =>
  done
    ? { key, state: "done", companyId }
    : allowed
      ? { key, state: "todo", companyId }
      : { key, state: "blocked", companyId, reason: "role" };
const companyStep = (companyId: CompanyId | null, manage: boolean): Step<"company"> =>
  companyId
    ? { key: "company", state: "done", companyId }
    : manage
      ? { key: "company", state: "todo", companyId: null }
      : { key: "company", state: "blocked", companyId: null, reason: "no-company" };
/**
 * A step the member could take, but whose prerequisite is not done yet, is `blocked` by
 * `previous`: `todo` is only what it can do now. A step needs every step before it, unless
 * `needs` names its prerequisites. A step blocked for another reason keeps it.
 */
const taskOf = <K extends string>(steps: Step<K>[], needs: Partial<Record<K, K[]>> = {}) => {
  const open = new Set(steps.filter((item) => item.state !== "done").map((item) => item.key));
  const ordered = steps.map((item, index): Step<K> => {
    const prerequisites = needs[item.key] ?? steps.slice(0, index).map((other) => other.key);
    return item.state === "todo" && prerequisites.some((key) => open.has(key))
      ? { ...item, state: "blocked", reason: "previous" }
      : item;
  });
  // `permission` is about the member, not the task: a viewer sees a task the organization
  // already reached as complete, with that step still blocked by its role.
  return {
    complete: ordered.every((item) => item.key === "permission" || item.state === "done"),
    steps: ordered,
  };
};
const unavailable = <K extends string>(keys: K[]) =>
  taskOf(
    keys.map((key): Step<K> => ({
      key,
      state: "unavailable",
      companyId: null,
      reason: "deployment",
    })),
  );

/**
 * The declared company closest to done for a task, where a task is ready when one company is
 * ready for it: a complete one first; then the one with fewer steps nobody in the organization
 * can take (Freecorps' block); then fewer open steps; then the first.
 */
function closest<K extends string>(
  declared: DeclaredFacts[],
  steps: (company: DeclaredFacts) => Step<K>[],
) {
  const rank = (own: Step<K>[]) => [
    own.every((item) => item.state === "done") ? 0 : 1,
    own.filter((item) => item.reason === "freecorps").length,
    own.filter((item) => item.state !== "done").length,
  ];
  const before = (a: number[], b: number[]) => {
    const index = a.findIndex((value, i) => value !== b[i]);
    return index >= 0 && a[index]! < b[index]!;
  };
  let best: { company: DeclaredFacts; steps: Step<K>[]; rank: number[] } | null = null;
  for (const company of declared) {
    const own = steps(company);
    const score = rank(own);
    if (!best || before(score, best.rank)) best = { company, steps: own, rank: score };
  }
  return best;
}

export function consoleTasks(facts: TaskFacts) {
  const integrate = taskOf([
    step("project", facts.integration?.project ?? false, null, !!facts.integration),
    step("key", facts.integration?.key ?? false, null, !!facts.integration),
  ]);
  if (facts.role === "developer") return { import: null, issue: null, capture: null, integrate };

  // The company with a document, else the demonstration one, else the first.
  const importCompany =
    facts.documentCompanyId ?? facts.demonstrationCompanyId ?? facts.companies[0] ?? null;
  const importTask = {
    ...taskOf<"company" | "permission" | "document">([
      companyStep(importCompany, facts.manage),
      step("permission", facts.write, null, false),
      step("document", facts.documentCompanyId !== null, importCompany, facts.write),
    ]),
    demonstrationCompanyId: facts.demonstrationCompanyId,
  };

  // Sandbox issuance is simulated: the certificate is a step only where the transport needs it.
  const issueSteps = (company: DeclaredFacts | null): Step<"certificate" | "profile">[] => [
    ...(company?.certificateForIssuance
      ? [step("certificate", company.certificate, company.companyId, facts.manage)]
      : []),
    step("profile", company?.profile ?? false, company?.companyId ?? null, facts.manage),
  ];
  const issueBest = closest(facts.declared, issueSteps);
  const issue = facts.issuanceAvailable
    ? taskOf<"company" | "permission" | "certificate" | "profile">(
        [
          companyStep(issueBest?.company.companyId ?? null, facts.manage),
          step("permission", facts.write, null, false),
          ...(issueBest?.steps ?? issueSteps(null)),
        ],
        // Certificate and profile are the company's setup, by a manager: neither waits for the
        // other, nor for the permission to issue.
        { certificate: ["company"], profile: ["company"] },
      )
    : unavailable(["company", "permission", "profile"]);

  // Authorizing (the release, owner or admin) and starting (the stream) stay distinct steps.
  const captureSteps = (
    company: DeclaredFacts | null,
  ): Step<"certificate" | "authorize" | "start">[] => {
    const companyId = company?.companyId ?? null;
    return [
      step("certificate", company?.certificate ?? false, companyId, facts.manage),
      company && !company.released && company.releaseBlocked
        ? { key: "authorize", state: "blocked", companyId, reason: "freecorps" }
        : step("authorize", company?.released ?? false, companyId, facts.manage),
      step("start", company?.started ?? false, companyId, facts.write),
    ];
  };
  const captureBest = closest(facts.declared, captureSteps);
  const capture = facts.captureAvailable
    ? taskOf<"company" | "certificate" | "authorize" | "start">([
        companyStep(captureBest?.company.companyId ?? null, facts.manage),
        ...(captureBest?.steps ?? captureSteps(null)),
      ])
    : unavailable(["company", "certificate", "authorize", "start"]);

  return { import: importTask, issue, capture, integrate };
}
