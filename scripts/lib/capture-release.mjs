// Checks of the GitHub workflows of Freecorps over the fiscal capture on the hosted site (ADR
// 0007, amendment of 22/10/2026, and #424): the company releases it in the console; Freecorps
// withdraws it from one company in an emergency, blocking a new release, and unblocks it later;
// and stops it for every company at once (`halt`), lifting the stop later (`resume`); lists
// the companies with their capture, for the internal view (`list`, #422); and sends a test of the
// alert e-mail (`alert_test`, #463). All by an authorized
// person, without approval. Pure functions: the runner in
// `scripts/deploy/capture-release.mjs` reads the files, the environment and the GitHub API and hands
// them here. The run checks are the NFS-e gate's (`verifiedRun`), with this file's workflows.
import { GateRefusal, hasUnsafeText } from "./issuance-gate.mjs";

/**
 * Every operation runs through one workflow, chosen by its `operation` input (#57); the run check
 * (`verifiedRun`) still confirms the file, and the runner refuses inputs the operation does not take.
 */
export const CAPTURE_WORKFLOW = ".github/workflows/capture-fiscal.yml";

/**
 * The environment holds the site's deploy key, limited to `main`; no reviewers. `scope` says what
 * the action names: one company, the whole deployment, or nothing (`read` and `alert`, without
 * inputs).
 * `stops` marks the actions that only close something, which go on when `/health` cannot confirm
 * the site (`healthGate`).
 */
export const CAPTURE_WORKFLOWS = {
  emergency_withdraw: {
    file: CAPTURE_WORKFLOW,
    environment: "capture-fiscal-emergency",
    scope: "company",
    stops: true,
  },
  unblock: {
    file: CAPTURE_WORKFLOW,
    environment: "capture-fiscal-emergency",
    scope: "company",
    stops: false,
  },
  halt: {
    file: CAPTURE_WORKFLOW,
    environment: "capture-fiscal-emergency",
    scope: "deployment",
    stops: true,
  },
  resume: {
    file: CAPTURE_WORKFLOW,
    environment: "capture-fiscal-emergency",
    scope: "deployment",
    stops: false,
  },
  list: {
    file: CAPTURE_WORKFLOW,
    environment: "capture-fiscal-emergency",
    scope: "read",
    stops: false,
  },
  alert_test: {
    file: CAPTURE_WORKFLOW,
    environment: "capture-fiscal-emergency",
    scope: "alert",
    stops: false,
  },
};

const refuse = (code, message) => {
  throw new GateRefusal(code, message);
};
const workflowOf = (action) =>
  Object.hasOwn(CAPTURE_WORKFLOWS, action)
    ? CAPTURE_WORKFLOWS[action]
    : refuse("ACTION_INVALID", "Ação desconhecida.");

const DEPLOYMENT = /^[a-z]+-[a-z]+-\d+$/;
/**
 * The hosted site's deployment, from `deploy/platform-release.json`, the same plan the publication
 * reads. The release only exists on a sandbox-based site.
 */
export function siteTarget(plan) {
  if (!plan || typeof plan !== "object" || plan.version !== 3)
    refuse("PLAN_INVALID", "deploy/platform-release.json fora do formato da versão 3.");
  if (plan.productEnvironment !== "sandbox")
    refuse("PLAN_INVALID", "O site hospedado precisa ter productEnvironment sandbox.");
  const deployment = plan.target?.deployment;
  if (typeof deployment !== "string" || !DEPLOYMENT.test(deployment))
    refuse("PLAN_INVALID", "deploy/platform-release.json sem o deployment do site.");
  return {
    deployment,
    cloud: `https://${deployment}.convex.cloud`,
    site: `https://${deployment}.convex.site`,
  };
}

/** The deployment answers as the hosted site (`/health`), before any call. */
export function siteHealth(health) {
  if (
    health?.status !== "ok" ||
    health?.appEnv !== "installation" ||
    health?.productEnv !== "sandbox"
  )
    refuse(
      "DEPLOYMENT_NOT_SITE",
      "O /health do deployment não responde como o site hospedado (installation, sandbox).",
    );
}

/**
 * What a `/health` that does not confirm the site means for each action (#424). The actions that
 * only stop (`stops`) go on with a warning: a site that is down or misconfigured is exactly when
 * the stop is needed, the deploy key is still bound to the plan's deployment (`deployKeyFor`), and
 * the Convex function refuses a deployment that is not sandbox-based
 * (`CAPTURE_RELEASE_DEPLOYMENT_DENIED`). The actions that let something run again (`unblock`,
 * `resume`) keep refusing until the site answers as itself.
 */
export function healthGate(action, health) {
  const workflow = workflowOf(action);
  try {
    siteHealth(health);
    return { verified: true };
  } catch (error) {
    if (!workflow.stops) throw error;
    return {
      verified: false,
      warning:
        "O /health do site não confirmou installation e sandbox; a parada segue mesmo assim, " +
        "e o Convex recusa um deployment que não seja o site.",
    };
  }
}

const CONVEX_ID = /^[a-z0-9]{16,64}$/;

/**
 * The dispatch inputs, read from `env:` (never interpolated in a shell), as in the NFS-e gate.
 * One company comes only as its Convex id (`GATE_COMPANY`), with the organization's id optional
 * (`GATE_ORGANIZATION_ID`) to cross-check it. The inputs of a run are public in the repository,
 * so a CNPJ is refused here even though Convex could resolve one. The deployment actions take
 * only the reason.
 */
export function captureInputs(env, action) {
  const workflow = workflowOf(action);
  // One workflow serves every operation (#57), so its form shows every input: one the chosen
  // operation does not take is refused, never ignored. A company id given to `halt` means the
  // person meant one company and chose the operation that stops all of them.
  const given = (name) => (env[name] ?? "").trim() !== "";
  if (workflow.scope !== "company" && (given("GATE_COMPANY") || given("GATE_ORGANIZATION_ID")))
    refuse(
      "INPUT_UNEXPECTED",
      `${action} não recebe company nem organization_id; para uma empresa, use emergency_withdraw ou unblock.`,
    );
  if (workflow.scope === "read" || workflow.scope === "alert") {
    if (given("GATE_REASON")) refuse("INPUT_UNEXPECTED", `${action} não recebe reason.`);
    return {};
  }
  const reason = (env.GATE_REASON ?? "").trim();
  if (reason.length < 10 || reason.length > 500 || hasUnsafeText(reason))
    refuse("INPUT_INVALID", "reason precisa ter de 10 a 500 caracteres, sem controles.");
  if (workflow.scope === "deployment") return { reason };
  const organization = (env.GATE_ORGANIZATION_ID ?? "").trim();
  if (organization && !CONVEX_ID.test(organization))
    refuse("INPUT_INVALID", "organization_id inválido.");
  const company = (env.GATE_COMPANY ?? "").trim();
  if (!CONVEX_ID.test(company))
    refuse(
      "INPUT_INVALID",
      "company precisa ser o id da empresa no Convex; o input do run é público, não use o CNPJ.",
    );
  return {
    ...(organization ? { organizationId: organization } : {}),
    companyId: company,
    reason,
  };
}

/**
 * The Convex call; `kind` is fixed by the action here, never an input. `type` is the endpoint:
 * a mutation, or the action that sends the test e-mail.
 */
export function captureCall(action, inputs, run) {
  const workflow = workflowOf(action);
  // The internal view (#422): it records no person, and only arms a missing supervision.
  if (workflow.scope === "read")
    return { type: "mutation", path: "captureSupervisor:survey", args: {} };
  // The test e-mail (#463) names the run that sent it, so its arrival matches the receipt.
  if (workflow.scope === "alert")
    return {
      type: "action",
      path: "captureSupervisor:sendTestAlert",
      args: {
        operator: run.operator,
        ...(run.actor ? { actor: run.actor } : {}),
        runId: run.runId,
        runAttempt: run.runAttempt,
      },
    };
  const person = {
    operator: run.operator,
    ...(run.actor ? { actor: run.actor } : {}),
    reason: inputs.reason,
    runId: run.runId,
    runAttempt: run.runAttempt,
  };
  if (workflow.scope === "deployment")
    return { type: "mutation", path: "captureRelease:setHalt", args: { kind: action, ...person } };
  return {
    type: "mutation",
    path: "captureRelease:set",
    args: {
      ...(inputs.organizationId ? { organizationId: inputs.organizationId } : {}),
      companyId: inputs.companyId,
      kind: action,
      ...person,
    },
  };
}

/** What the log says next to a Convex refusal code, so the person knows what to do. */
export const CONVEX_REFUSALS = {
  CAPTURE_RELEASE_COMPANY_AMBIGUOUS:
    "O CNPJ está em mais de uma organização; dispare de novo com organization_id.",
  CAPTURE_RELEASE_CNPJ_INVALID: "O CNPJ informado não é válido.",
  CAPTURE_RELEASE_NOT_BLOCKED: "A empresa não está bloqueada; nada a desbloquear.",
  CAPTURE_FISCAL_NOT_HALTED: "A captura fiscal não está parada; nada a religar.",
  NOT_FOUND: "Nenhuma empresa com esse id ou CNPJ (na organização informada).",
};

/** What the log shows: codes and outcomes. The company's ids, never its CNPJ. */
export function captureSummary(action, value) {
  const { scope } = workflowOf(action);
  if (scope === "alert")
    return {
      alertDestination: value?.alertDestination,
      recipients: value?.recipients,
      delivery: value?.delivery,
      sentAt: isoOrNull(value?.sentAt),
    };
  if (scope === "read")
    return {
      ...value?.deployment,
      companies: value?.companies?.length ?? 0,
      truncated: value?.truncated,
      armed: value?.armed,
      recent: value?.recent,
      suppressed: value?.suppressed,
    };
  if (scope === "deployment") return { halted: value?.halted, version: value?.version };
  return {
    organizationId: value?.organizationId,
    companyId: value?.companyId,
    released: value?.released,
    blocked: value?.blocked,
    version: value?.version,
  };
}

/**
 * Whether the run did what it was for. Only the test e-mail can be answered without doing it: a
 * destination left `unconfigured` or an e-mail the provider did not confirm (`failed`,
 * `uncertain`) is a failed run, not a passed one, though the call itself succeeded.
 */
export function captureOutcome(action, value) {
  if (workflowOf(action).scope !== "alert") return "passed";
  return value?.delivery === "sent" ? "passed" : "failed";
}

const DAY = 86_400_000;
const isoOrNull = (ms) => (typeof ms === "number" ? new Date(ms).toISOString() : null);
/**
 * One log line per company of the internal view (#422): ids, release, stream state and code,
 * last answered query, days left on the A1, interval and the latest alert. The company's name
 * stays in the sealed receipt; the CNPJ never leaves Convex.
 */
export function listLines(value, now = Date.now()) {
  return (value?.companies ?? []).map((company) => ({
    organizationId: company.organizationId,
    companyId: company.companyId,
    release: company.release,
    minIntervalHours: company.minIntervalHours,
    stream: company.stream?.state ?? null,
    code: company.stream?.code ?? null,
    operation: company.stream?.operationState ?? null,
    lastSuccessAt: isoOrNull(company.stream?.lastSuccessAt),
    recovering: company.stream?.recovering ?? false,
    certificateDays: company.certificate
      ? Math.floor((company.certificate.notAfter - now) / DAY)
      : null,
    certificateOwn: company.certificate?.own ?? null,
    supervised: company.supervision?.armed ?? false,
    supervisionFailing: company.supervision?.failing ?? false,
    error: company.error ?? null,
    lastAlert: company.alerts?.[0]
      ? {
          kind: company.alerts[0].kind,
          code: company.alerts[0].code,
          days: company.alerts[0].days,
          delivery: company.alerts[0].delivery,
          at: isoOrNull(company.alerts[0].createdAt),
        }
      : null,
  }));
}
