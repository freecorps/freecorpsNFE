// Checks of the GitHub workflows that operate the NFS-e fiscal production (#198, ADR 0004 §8):
// turning a company's gate on (approved by another person), turning it off in an emergency (an
// authorized person, no approval) and the read-only probe and verification; the publication of
// the second target reuses the run and approval check. Pure functions, except `githubRun`, which
// only reads the GitHub API: the runners read the files and the environment and hand them here.
// Everything fails closed: no named deployment, a run that is not the one the workflow says, an
// approval that is not another authorized person's, and nothing reaches Convex.
import { isProjectRepository } from "./repository.mjs";

/** One protected GitHub environment per action; their protections are a human step. */
export const GATE_WORKFLOWS = {
  plan: { file: null, environment: null },
  enable: {
    file: ".github/workflows/nfse-gate-enable.yml",
    environment: "nfse-production-gate",
    approved: true,
  },
  emergency_disable: {
    file: ".github/workflows/nfse-gate-emergency.yml",
    environment: "nfse-production-emergency",
  },
  probe: {
    file: ".github/workflows/nfse-production-probe.yml",
    environment: "nfse-production-read",
  },
  "verify-issued": {
    file: ".github/workflows/nfse-production-probe.yml",
    environment: "nfse-production-read",
  },
};

export class GateRefusal extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
const refuse = (code, message) => {
  throw new GateRefusal(code, message);
};

const DEPLOYMENT = /^[a-z]+-[a-z]+-\d+$/;
/**
 * The deployment of `deploy/issuance-production.json`. While it names none (`deployment: null`),
 * no workflow runs: there is no fiscal production deployment to call.
 */
export function productionTarget(plan) {
  if (!plan || typeof plan !== "object" || plan.version !== 1)
    refuse("PLAN_INVALID", "deploy/issuance-production.json fora do formato da versão 1.");
  if (plan.deployment === null)
    refuse(
      "PLAN_NOT_NAMED",
      "deploy/issuance-production.json ainda não nomeia o deployment de produção fiscal " +
        '("deployment": null). Nenhum deployment é produção fiscal; o workflow não chama o ' +
        "Convex. Nomear o deployment é um commit revisado (docs/operacao/emissao-nfse.md, fase 4).",
    );
  if (
    typeof plan.deployment !== "string" ||
    !DEPLOYMENT.test(plan.deployment) ||
    plan.url !== `https://${plan.deployment}.convex.cloud`
  )
    refuse("PLAN_INVALID", "deploy/issuance-production.json com deployment ou url inválidos.");
  return {
    deployment: plan.deployment,
    cloud: plan.url,
    site: `https://${plan.deployment}.convex.site`,
  };
}

/** GitHub login: 1 to 39 letters, digits or single hyphens, not at either end. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** `deploy/issuance-gate.json`: who may trigger the emergency switch-off and the probe. */
export function gateConfig(config) {
  if (!config || typeof config !== "object" || config.version !== 1)
    refuse("GATE_CONFIG_INVALID", "deploy/issuance-gate.json fora do formato da versão 1.");
  const actors = config.authorizedActors;
  if (
    !Array.isArray(actors) ||
    actors.length === 0 ||
    !actors.every((login) => typeof login === "string" && GITHUB_LOGIN.test(login)) ||
    new Set(actors.map((login) => login.toLowerCase())).size !== actors.length
  )
    refuse("GATE_CONFIG_INVALID", "authorizedActors precisa ser uma lista de logins do GitHub.");
  // Keeps the version: the runners validate the file once and `verifiedRun` validates it again.
  return { version: 1, authorizedActors: actors };
}

/**
 * C0 and C1 controls, DEL and every Unicode `Bidi_Control`, the same rule as `hasUnsafeText` in
 * `platform/convex/lib/issuanceGate.ts` (a test keeps both equal).
 */
export function hasUnsafeText(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
}

const CONVEX_ID = /^[a-z0-9]{16,64}$/;
/**
 * The dispatch inputs, read from `env:` (never interpolated in a shell): the organization and
 * company ids, the reason and, to verify a note, the issuance id. Convex validates the ids again.
 */
export function dispatchInputs(env, action) {
  const id = (name, label) => {
    const value = (env[name] ?? "").trim();
    if (!CONVEX_ID.test(value)) refuse("INPUT_INVALID", `${label} inválido.`);
    return value;
  };
  const organizationId = id("GATE_ORGANIZATION_ID", "organization_id");
  const companyId = id("GATE_COMPANY_ID", "company_id");
  const reason = (env.GATE_REASON ?? "").trim();
  if (reason.length < 10 || reason.length > 500 || hasUnsafeText(reason))
    refuse("INPUT_INVALID", "reason precisa ter de 10 a 500 caracteres, sem controles.");
  return {
    organizationId,
    companyId,
    reason,
    ...(action === "verify-issued" ? { issuanceId: id("GATE_ISSUANCE_ID", "issuance_id") } : {}),
  };
}

/** The deploy key must be the fiscal production deployment's, never another one's. */
export function deployKeyFor(key, deployment) {
  const prefix = `prod:${deployment}|`;
  if (typeof key !== "string" || !key.startsWith(prefix) || key.length === prefix.length)
    refuse(
      "DEPLOY_KEY_MISMATCH",
      "CONVEX_DEPLOY_KEY do environment não é a do deployment do plano.",
    );
  return key;
}

/** The deployment answers as fiscal production (`/health`), before any call. */
export function productionHealth(health) {
  if (health?.status !== "ok" || health?.issuanceEnv !== "production")
    refuse(
      "DEPLOYMENT_NOT_FISCAL",
      "O /health do deployment do plano não responde issuanceEnv production.",
    );
}

/**
 * What `verifiedRun` checks, read from the GitHub API with the job's token (`GH_TOKEN`, with
 * `actions: read`): this run's attempt and, for an approved action, the run's approvals. The one
 * network read of this file, shared by the gate's runner and the publication's; it checks
 * nothing itself.
 */
export async function githubRun(env, approved, request = fetch) {
  const github = async (path) => {
    const response = await request(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) refuse("GITHUB_API_FAILED", `GitHub respondeu ${response.status}.`);
    return response.json();
  };
  const runId = encodeURIComponent(env.GITHUB_RUN_ID),
    attempt = encodeURIComponent(env.GITHUB_RUN_ATTEMPT);
  const run = await github(`/actions/runs/${runId}/attempts/${attempt}`);
  const approvals = approved ? await github(`/actions/runs/${runId}/approvals`) : null;
  return { run, approvals };
}

/**
 * The GitHub run, read from the API, is this very workflow on `main`, dispatched by hand and
 * still running; who triggered it, and for an approved action who approved it, come from the
 * API, never from an input:
 *
 * - `operator` is `triggering_actor` (who triggered this attempt); `actor` is `actor` (who
 *   dispatched the run) when it is someone else;
 * - an approved action (`enable`, and `publish` of the second target) needs exactly one approval,
 *   for its environment, by someone in `authorizedActors` who is neither, and only on the first
 *   attempt: the approvals of a run do not say which attempt they belong to;
 * - the others (emergency switch-offs, the probe, the verification) need `operator` in
 *   `authorizedActors`.
 *
 * `workflows` maps each action to its file and environment; the capture and the publication of
 * the second target pass their own.
 */
/**
 * @param {{
 *   action: string;
 *   env: Record<string, string | undefined>;
 *   run: any;
 *   approvals: unknown;
 *   config: unknown;
 *   workflows?: Record<string, { file: string | null; environment: string | null; approved?: boolean }>;
 * }} input
 */
export function verifiedRun({ action, env, run, approvals, config, workflows = GATE_WORKFLOWS }) {
  const workflow = workflows[action];
  if (!workflow?.file) refuse("ACTION_INVALID", "Ação desconhecida.");
  const repository = env.GITHUB_REPOSITORY;
  if (!isProjectRepository(repository))
    refuse("RUN_INVALID", "O run não é de um repositório do projeto.");
  if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch")
    refuse("RUN_INVALID", "O workflow só roda por workflow_dispatch na main.");
  if (env.GITHUB_WORKFLOW_REF !== `${repository}/${workflow.file}@refs/heads/main`)
    refuse("RUN_INVALID", `Esta ação só roda pelo workflow ${workflow.file}.`);
  const runId = String(env.GITHUB_RUN_ID ?? "");
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!/^[1-9]\d{0,19}$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt < 1)
    refuse("RUN_INVALID", "Run ou tentativa inválidos.");
  if (
    String(run?.id) !== runId ||
    run?.run_attempt !== runAttempt ||
    run?.event !== "workflow_dispatch" ||
    run?.head_branch !== "main" ||
    run?.head_sha !== env.GITHUB_SHA ||
    run?.path !== workflow.file ||
    run?.status !== "in_progress" ||
    run?.repository?.full_name !== repository
  )
    refuse("RUN_INVALID", "A API do GitHub não confirma este run.");
  const operator = run.triggering_actor?.login;
  const dispatcher = run.actor?.login;
  if (typeof operator !== "string" || !GITHUB_LOGIN.test(operator))
    refuse("RUN_INVALID", "O run não tem triggering_actor válido.");
  if (typeof dispatcher !== "string" || !GITHUB_LOGIN.test(dispatcher))
    refuse("RUN_INVALID", "O run não tem actor válido.");
  const actor = same(dispatcher, operator) ? undefined : dispatcher;
  const base = { operator, ...(actor ? { actor } : {}), runId, runAttempt };
  const allowed = gateConfig(config).authorizedActors;
  if (workflow.approved) {
    if (runAttempt !== 1)
      refuse(
        "RUN_ATTEMPT_REFUSED",
        "Uma ação aprovada não aceita nova tentativa: a API de aprovações não diz de qual " +
          "tentativa é a aprovação. Dispare o workflow de novo.",
      );
    if (!Array.isArray(approvals)) refuse("APPROVAL_MISSING", "Sem a lista de aprovações.");
    const forEnvironment = approvals.filter((entry) =>
      entry?.environments?.some((environment) => environment?.name === workflow.environment),
    );
    if (forEnvironment.some((entry) => entry.state !== "approved"))
      refuse("APPROVAL_REJECTED", `Há revisão não aprovada em ${workflow.environment}.`);
    if (forEnvironment.length !== 1)
      refuse(
        "APPROVAL_MISSING",
        `O run precisa de uma única aprovação em ${workflow.environment}.`,
      );
    const approver = forEnvironment[0].user?.login;
    if (typeof approver !== "string" || !GITHUB_LOGIN.test(approver))
      refuse("APPROVAL_MISSING", "A aprovação não tem um login válido.");
    if (same(approver, operator) || (actor && same(approver, actor)))
      refuse("APPROVER_INVALID", "Quem aprova precisa ser outra pessoa, não quem disparou.");
    // The environment's reviewers are a repository setting; the list is a reviewed commit.
    if (!allowed.some((login) => same(login, approver)))
      refuse(
        "APPROVER_NOT_AUTHORIZED",
        `${approver} aprovou, mas não está em authorizedActors de deploy/issuance-gate.json.`,
      );
    return { ...base, approver };
  }
  if (!allowed.some((login) => same(login, operator)))
    refuse(
      "ACTOR_NOT_AUTHORIZED",
      `${operator} não está em authorizedActors de deploy/issuance-gate.json.`,
    );
  if (actor && !allowed.some((login) => same(login, actor)))
    refuse(
      "ACTOR_NOT_AUTHORIZED",
      `${actor} não está em authorizedActors de deploy/issuance-gate.json.`,
    );
  return base;
}

/** The Convex function and its arguments for each action; `kind` is fixed here, never an input. */
export function convexCall(action, inputs, run) {
  const person = {
    operator: run.operator,
    reason: inputs.reason,
  };
  const scope = { organizationId: inputs.organizationId, companyId: inputs.companyId };
  if (action === "enable" || action === "emergency_disable")
    return {
      path: "issuance:setProductionGate",
      args: {
        ...scope,
        kind: action,
        ...person,
        ...(run.actor ? { actor: run.actor } : {}),
        ...(run.approver ? { approver: run.approver } : {}),
        runId: run.runId,
        runAttempt: run.runAttempt,
      },
    };
  if (action === "probe") return { path: "issuanceProbe:verify", args: { ...scope, ...person } };
  if (action === "verify-issued")
    return {
      path: "issuanceProbe:verifyIssued",
      args: { ...scope, issuanceId: inputs.issuanceId, ...person },
    };
  return refuse("ACTION_INVALID", "Ação desconhecida.");
}

/** What the log shows: codes and outcomes, never response bodies or the note's data. */
export function summary(action, result) {
  if (action === "enable" || action === "emergency_disable")
    return { production: result?.production, version: result?.version };
  if (action === "probe")
    return {
      consultations: (result?.consultations ?? []).map((c) => ({
        target: c.target,
        outcome: c.outcome,
        code: c.code ?? null,
        httpStatus: c.httpStatus ?? null,
      })),
      adhesion: (result?.adhesion ?? []).map((a) => ({
        source: a.source,
        httpStatus: a.httpStatus ?? null,
        aderenteEmissorNacional: a.aderenteEmissorNacional ?? null,
      })),
    };
  return {
    single: result?.single ?? null,
    dps: result?.dps?.outcome ?? null,
    nfse: result?.nfse?.outcome ?? null,
  };
}
