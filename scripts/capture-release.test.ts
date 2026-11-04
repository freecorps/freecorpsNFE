import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import {
  CAPTURE_WORKFLOW,
  CAPTURE_WORKFLOWS,
  CONVEX_REFUSALS,
  captureCall,
  captureInputs,
  captureOutcome,
  captureSummary,
  healthGate,
  listLines,
  siteHealth,
  siteTarget,
} from "./lib/capture-release.mjs";
import { deployKeyFor, gateConfig, verifiedRun } from "./lib/issuance-gate.mjs";
import { repoUrl } from "./lib/repo-root.mjs";

/**
 * Freecorps workflows over the fiscal capture of a company on the hosted site (ADR 0007, amendment
 * of 22/10/2026): emergency withdraw and unblock, by an authorized person, without approval. The
 * company releases it in the console. Everything here is synthetic.
 */
const read = (path: string) => readFileSync(new URL(`${path}`, repoUrl), "utf8");
const config = { version: 1, authorizedActors: ["ana-freecorps", "bruno"] };
const code = (run: () => unknown) => {
  try {
    run();
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? "THROWN";
  }
};
const ids = { GATE_ORGANIZATION_ID: "a".repeat(32), GATE_COMPANY: "b".repeat(32) };
const reason = { GATE_REASON: "Suspensão por consumo indevido" };

describe("alvo e entradas", () => {
  it("o alvo é o site do plano de publicação, só com produto sandbox", () => {
    const plan = JSON.parse(read("deploy/platform-release.json"));
    expect(siteTarget(plan)).toEqual({
      deployment: plan.target.deployment,
      cloud: `https://${plan.target.deployment}.convex.cloud`,
      site: `https://${plan.target.deployment}.convex.site`,
    });
    expect(code(() => siteTarget({ ...plan, productEnvironment: "production" }))).toBe(
      "PLAN_INVALID",
    );
    expect(code(() => siteTarget({ ...plan, version: 2 }))).toBe("PLAN_INVALID");
    expect(code(() => deployKeyFor(`prod:${plan.target.deployment}|x`, "brave-otter-123"))).toBe(
      "DEPLOY_KEY_MISMATCH",
    );
  });
  it("o deployment precisa responder como o site hospedado", () => {
    expect(
      code(() => siteHealth({ status: "ok", appEnv: "installation", productEnv: "sandbox" })),
    ).toBe("OK");
    for (const health of [
      null,
      { status: "ok", appEnv: "validation", productEnv: "production" },
      { status: "ok", appEnv: "installation", productEnv: "production" },
    ])
      expect(code(() => siteHealth(health))).toBe("DEPLOYMENT_NOT_SITE");
  });
  it("as entradas: a empresa só pelo id, a organização opcional e o motivo", () => {
    expect(captureInputs({ ...ids, ...reason }, "unblock")).toEqual({
      organizationId: ids.GATE_ORGANIZATION_ID,
      companyId: ids.GATE_COMPANY,
      reason: reason.GATE_REASON,
    });
    expect(captureInputs({ GATE_COMPANY: ids.GATE_COMPANY, ...reason }, "unblock")).toEqual({
      companyId: ids.GATE_COMPANY,
      reason: reason.GATE_REASON,
    });
    // The inputs of a run are public: a CNPJ, numeric or alphanumeric, is refused.
    for (const company of [
      "11.222.333/0001-81",
      " 11222333000181 ",
      "11222333/0001-81",
      "12.abc.345/01de-35",
    ])
      expect(
        code(() =>
          captureInputs(
            { GATE_COMPANY: company, GATE_ORGANIZATION_ID: "", ...reason },
            "emergency_withdraw",
          ),
        ),
        company,
      ).toBe("INPUT_INVALID");
    for (const env of [
      { ...ids, GATE_REASON: "curto" },
      { ...reason },
      { ...reason, GATE_COMPANY: "1122233300018" },
      { ...reason, GATE_COMPANY: "11 222 333 0001 81" },
      { ...reason, GATE_COMPANY: "11222333000181; rm" },
      { ...reason, GATE_COMPANY: "B".repeat(32) },
      { ...reason, GATE_COMPANY: ids.GATE_COMPANY, GATE_ORGANIZATION_ID: "org" },
    ])
      expect(
        code(() => captureInputs(env, "unblock")),
        JSON.stringify(env),
      ).toBe("INPUT_INVALID");
  });
  it("a parada geral só recebe o motivo; uma empresa informada recusa a parada", () => {
    for (const action of ["halt", "resume"]) {
      expect(captureInputs({ ...reason }, action)).toEqual({ reason: reason.GATE_REASON });
      // One form serves every operation (#57): an id given to halt means the person meant one
      // company, so the stop of every company is refused instead of running without it.
      for (const env of [
        { ...ids, ...reason },
        { GATE_COMPANY: ids.GATE_COMPANY, ...reason },
        { GATE_ORGANIZATION_ID: ids.GATE_ORGANIZATION_ID, ...reason },
      ])
        expect(
          code(() => captureInputs(env, action)),
          JSON.stringify(env),
        ).toBe("INPUT_UNEXPECTED");
    }
    // Empty inputs of the form are not given ones.
    expect(
      captureInputs({ GATE_COMPANY: "", GATE_ORGANIZATION_ID: " ", ...reason }, "halt"),
    ).toEqual({ reason: reason.GATE_REASON });
    expect(code(() => captureInputs({ GATE_REASON: "curto" }, "halt"))).toBe("INPUT_INVALID");
    expect(code(() => captureInputs({ ...reason }, "release"))).toBe("ACTION_INVALID");
  });
  it("a lista e o e-mail de teste não recebem entrada nenhuma", () => {
    for (const action of ["list", "alert_test"]) {
      expect(
        captureInputs({ GATE_COMPANY: "", GATE_ORGANIZATION_ID: "", GATE_REASON: "" }, action),
      ).toEqual({});
      for (const env of [
        { ...ids },
        { ...reason },
        { GATE_ORGANIZATION_ID: ids.GATE_ORGANIZATION_ID },
      ])
        expect(
          code(() => captureInputs(env, action)),
          JSON.stringify(env),
        ).toBe("INPUT_UNEXPECTED");
    }
  });
  it("health ruim: as paradas seguem com aviso; desbloquear e religar recusam", () => {
    const good = { status: "ok", appEnv: "installation", productEnv: "sandbox" };
    for (const action of Object.keys(CAPTURE_WORKFLOWS))
      expect(healthGate(action, good)).toEqual({ verified: true });
    for (const health of [
      null,
      { status: "misconfigured" },
      { ...good, productEnv: "production" },
    ]) {
      for (const action of ["emergency_withdraw", "halt"])
        expect(healthGate(action, health)).toMatchObject({
          verified: false,
          warning: expect.stringContaining("a parada segue"),
        });
      for (const action of ["unblock", "resume", "list", "alert_test"])
        expect(code(() => healthGate(action, health))).toBe("DEPLOYMENT_NOT_SITE");
    }
  });
});

describe("run, aprovação e chamada", () => {
  const envFor = (action: keyof typeof CAPTURE_WORKFLOWS) => ({
    GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `freecorps/freecorpsNFE/${CAPTURE_WORKFLOWS[action].file}@refs/heads/main`,
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
  });
  const runFor = (action: keyof typeof CAPTURE_WORKFLOWS, operator = "ana-freecorps") => ({
    id: 4242,
    run_attempt: 1,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "a".repeat(40),
    path: CAPTURE_WORKFLOWS[action].file,
    status: "in_progress",
    repository: { full_name: "freecorps/freecorpsNFE" },
    actor: { login: operator },
    triggering_actor: { login: operator },
  });
  const verify = (action: keyof typeof CAPTURE_WORKFLOWS, operator = "ana-freecorps") =>
    verifiedRun({
      action,
      env: envFor(action),
      run: runFor(action, operator),
      approvals: null,
      config,
      workflows: CAPTURE_WORKFLOWS,
    });

  it.each(Object.keys(CAPTURE_WORKFLOWS))(
    "%s: só quem está em authorizedActors, sem aprovação",
    (action) => {
      const key = action as keyof typeof CAPTURE_WORKFLOWS;
      expect(verify(key)).toEqual({ operator: "ana-freecorps", runId: "4242", runAttempt: 1 });
      expect(code(() => verify(key, "outra-pessoa"))).toBe("ACTOR_NOT_AUTHORIZED");
    },
  );
  it("aceita a config já validada pelo runner, como no workflow real", () => {
    // The runners pass `gateConfig(file)` to `verifiedRun`, which validates it again.
    const parsed = gateConfig(JSON.parse(read("deploy/issuance-gate.json")));
    expect(
      verifiedRun({
        action: "unblock",
        env: envFor("unblock"),
        run: runFor("unblock", "wolf-stievano"),
        approvals: null,
        config: parsed,
        workflows: CAPTURE_WORKFLOWS,
      }),
    ).toMatchObject({ operator: "wolf-stievano" });
  });
  it("o tipo vem da ação do workflow, nunca de uma entrada", () => {
    const run = { operator: "ana-freecorps", runId: "4242", runAttempt: 1 };
    const person = {
      operator: "ana-freecorps",
      reason: reason.GATE_REASON,
      runId: "4242",
      runAttempt: 1,
    };
    for (const action of ["emergency_withdraw", "unblock"] as const) {
      const inputs = captureInputs({ ...ids, ...reason, kind: "release" }, action);
      expect(captureCall(action, inputs, verify(action))).toEqual({
        type: "mutation",
        path: "captureRelease:set",
        args: {
          organizationId: ids.GATE_ORGANIZATION_ID,
          companyId: ids.GATE_COMPANY,
          kind: action,
          ...person,
        },
      });
      const byId = captureInputs({ GATE_COMPANY: ids.GATE_COMPANY, ...reason }, action);
      expect(captureCall(action, byId, run)).toEqual({
        type: "mutation",
        path: "captureRelease:set",
        args: { companyId: ids.GATE_COMPANY, kind: action, ...person },
      });
    }
    for (const action of ["halt", "resume"] as const)
      expect(captureCall(action, captureInputs({ ...reason }, action), verify(action))).toEqual({
        type: "mutation",
        path: "captureRelease:setHalt",
        args: { kind: action, ...person },
      });
    // The internal view (#422) takes no input and records no person.
    expect(captureInputs({}, "list")).toEqual({});
    expect(captureCall("list", {}, verify("list"))).toEqual({
      type: "mutation",
      path: "captureSupervisor:survey",
      args: {},
    });
    // The test e-mail (#463) takes no input; the run names it, and it is the only action.
    expect(captureInputs({}, "alert_test")).toEqual({});
    expect(captureCall("alert_test", {}, verify("alert_test"))).toEqual({
      type: "action",
      path: "captureSupervisor:sendTestAlert",
      args: { operator: "ana-freecorps", runId: "4242", runAttempt: 1 },
    });
    expect(code(() => captureCall("release", { reason: "x" }, run))).toBe("ACTION_INVALID");
  });
  it("o teste do e-mail só passa com o envio confirmado pelo provedor", () => {
    const sent = { alertDestination: "email", recipients: 2, delivery: "sent", sentAt: 0 };
    expect(captureSummary("alert_test", sent)).toEqual({
      ...sent,
      sentAt: "1970-01-01T00:00:00.000Z",
    });
    expect(captureOutcome("alert_test", sent)).toBe("passed");
    for (const delivery of ["failed", "uncertain"])
      expect(captureOutcome("alert_test", { ...sent, delivery })).toBe("failed");
    expect(
      captureOutcome("alert_test", {
        alertDestination: "unconfigured",
        recipients: 0,
        delivery: null,
        sentAt: null,
      }),
    ).toBe("failed");
    for (const action of ["emergency_withdraw", "unblock", "halt", "resume", "list"])
      expect(captureOutcome(action, {})).toBe("passed");
  });
  it("o log mostra a empresa resolvida pelos ids e o estado, nunca o CNPJ", () => {
    const value = {
      organizationId: "o".repeat(32),
      companyId: "c".repeat(32),
      released: false,
      blocked: true,
      version: 3,
    };
    expect(captureSummary("emergency_withdraw", value)).toEqual(value);
    expect(captureSummary("halt", { halted: true, version: 2 })).toEqual({
      halted: true,
      version: 2,
    });
    const survey = {
      deployment: {
        captureFiscal: true,
        transport: true,
        halted: false,
        alertDestination: "email",
      },
      companies: [
        {
          organizationId: "o".repeat(32),
          companyId: "c".repeat(32),
          name: "Empresa Sintética Ltda",
          release: "released",
          minIntervalHours: 2,
          releaseUpdatedAt: 0,
          stream: {
            id: "s".repeat(32),
            state: "paused",
            code: "PAUSED_BY_USER",
            lastSuccessAt: Date.UTC(2026, 8, 1),
            lastAttemptAt: null,
            nextAllowedAt: 0,
            operationState: "paused",
            recovering: false,
          },
          certificate: { own: true, notAfter: Date.UTC(2026, 10, 1) },
          supervision: { armed: true, checkedAt: 0, failing: false },
          alerts: [
            {
              kind: "quiet",
              code: "PAUSED_BY_USER",
              days: 50,
              delivery: "sent",
              createdAt: Date.UTC(2026, 9, 21),
            },
          ],
          error: null,
        },
      ],
      truncated: false,
      armed: 1,
      recent: [{ kind: "quiet", code: "PAUSED_BY_USER", count: 1 }],
      suppressed: 0,
      recentPartial: false,
    };
    expect(captureSummary("list", survey)).toEqual({
      ...survey.deployment,
      companies: 1,
      truncated: false,
      armed: 1,
      recent: survey.recent,
      suppressed: 0,
    });
    const lines = listLines(survey, Date.UTC(2026, 9, 22));
    expect(lines).toEqual([
      {
        organizationId: "o".repeat(32),
        companyId: "c".repeat(32),
        release: "released",
        minIntervalHours: 2,
        stream: "paused",
        code: "PAUSED_BY_USER",
        operation: "paused",
        lastSuccessAt: "2026-09-01T00:00:00.000Z",
        recovering: false,
        certificateDays: 10,
        certificateOwn: true,
        supervised: true,
        supervisionFailing: false,
        error: null,
        lastAlert: {
          kind: "quiet",
          code: "PAUSED_BY_USER",
          days: 50,
          delivery: "sent",
          at: "2026-10-21T00:00:00.000Z",
        },
      },
    ]);
    // The name stays in the receipt; the log line never carries it.
    expect(JSON.stringify(lines)).not.toContain("Sintética");
    expect(listLines(null)).toEqual([]);
    for (const code of [
      "CAPTURE_RELEASE_COMPANY_AMBIGUOUS",
      "CAPTURE_RELEASE_NOT_BLOCKED",
      "CAPTURE_FISCAL_NOT_HALTED",
    ])
      expect(CONVEX_REFUSALS).toHaveProperty(code);
  });
});

describe("workflow", () => {
  type Step = { uses?: string; run?: string; env?: Record<string, string> };
  type Job = {
    if?: string;
    environment?: string;
    permissions?: Record<string, string>;
    "runs-on"?: string;
    steps: Step[];
  };
  type Input = { required: boolean; type: string; default?: string; options?: string[] };
  const workflow = parse(read(CAPTURE_WORKFLOW)) as {
    on: { workflow_dispatch: { inputs: Record<string, Input> } };
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
  const expression = (value?: string) => value?.replace(/\$\{\{|\}\}|\s/g, "");
  const jobs = Object.values(workflow.jobs);
  const job = jobs[0]!;
  const runner = job.steps.find((step) => step.run?.startsWith("node scripts/"))!;

  it("todas as operações passam por um workflow, com o environment dele", () => {
    // One file since #57; the run check still confirms it.
    expect(new Set(Object.values(CAPTURE_WORKFLOWS).map(({ file }) => file))).toEqual(
      new Set([CAPTURE_WORKFLOW]),
    );
    expect(new Set(Object.values(CAPTURE_WORKFLOWS).map(({ environment }) => environment))).toEqual(
      new Set([job.environment]),
    );
  });
  it("só dispatch na main, um job com o environment, entradas por env", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(jobs).toHaveLength(1);
    expect(expression(job.if)).toBe("github.ref=='refs/heads/main'");
    expect(job.permissions).toEqual({ contents: "read", actions: "read" });
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      if (step.run) expect(step.run).not.toContain("${{");
    }
    expect(job.steps.filter((step) => step.run?.startsWith("node scripts/"))).toHaveLength(1);
    // The operation reaches the runner through the environment, never through the shell text.
    expect(runner.run!.trim()).toBe('node scripts/capture-release.mjs "$CAPTURE_OPERATION"');
    expect(expression(runner.env!.CAPTURE_OPERATION)).toBe("inputs.operation");
    expect(expression(runner.env!.CONVEX_DEPLOY_KEY)).toBe("secrets.FNFE_SITE_DEPLOY_KEY");
  });
  it("a operação é uma escolha entre as ações do runner, com a lista como padrão", () => {
    const operation = workflow.on.workflow_dispatch.inputs.operation!;
    expect(operation).toMatchObject({ type: "choice", required: true });
    expect([...operation.options!].sort()).toEqual(Object.keys(CAPTURE_WORKFLOWS).sort());
    // A dispatch without a choice changes nothing.
    expect(operation.default).toBe("list");
    expect(CAPTURE_WORKFLOWS.list.scope).toBe("read");
  });
  it("as entradas do workflow são as que o runner lê, opcionais no formulário", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(
      ["company", "operation", "organization_id", "reason"].sort(),
    );
    // captureInputs requires each one per operation and refuses the ones it does not take.
    for (const name of ["company", "organization_id", "reason"])
      expect(inputs[name], name).toMatchObject({ required: false, type: "string" });
    expect(
      Object.fromEntries(
        Object.entries(runner.env!)
          .filter(([name]) => name.startsWith("GATE_"))
          .map(([name, value]) => [name, expression(value)]),
      ),
    ).toEqual({
      GATE_COMPANY: "inputs.company",
      GATE_ORGANIZATION_ID: "inputs.organization_id",
      GATE_REASON: "inputs.reason",
    });
  });
  it("roda num runner do GitHub, sem depender de download, numa fila por operação", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.steps.map((step) => step.uses?.split("@")[0]).filter(Boolean)).toEqual([
      "actions/checkout",
      "actions/upload-artifact",
    ]);
    // An unblock, a resume, a list or a test never queues an emergency withdraw or the stop.
    expect(expression(workflow.concurrency.group)).toBe("capture-fiscal-inputs.operation");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    // The company releases in the console: no workflow releases the capture.
    expect(() => read(".github/workflows/capture-release.yml")).toThrow();
  });
  it("nenhum outro workflow recebe a chave do site para a liberação nem chama captureRelease", () => {
    const directory = new URL(".github/workflows/", repoUrl);
    const own = CAPTURE_WORKFLOW.split("/").at(-1);
    for (const name of readdirSync(directory).filter((n) => /\.ya?ml$/.test(n))) {
      if (name === own) continue;
      const text = readFileSync(new URL(name, directory), "utf8");
      expect(text, name).not.toContain("FNFE_SITE_DEPLOY_KEY");
      expect(text, name).not.toContain("capture-release.mjs");
      expect(text, name).not.toContain("captureRelease");
    }
  });
  it("CODEOWNERS cobre o runner e o código da liberação", () => {
    const paths = read(".github/CODEOWNERS")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/)[0]);
    for (const path of [
      "/scripts/capture-release.mjs",
      "/scripts/lib/capture-release.mjs",
      "/platform/convex/captureRelease.ts",
      "/platform/convex/lib/fiscalCaptureRelease.ts",
      "/platform/convex/lib/environmentAccess.ts",
      // What opens the transport of the hosted site (#424).
      "/platform/convex/lib/siteCapture.ts",
      "/platform/convex/captureProcessing.ts",
      "/platform/convex/captureWorker.ts",
      "/platform/convex/captures.ts",
      "/deploy/issuance-gate.json",
      "/.github/workflows/",
    ])
      expect(paths, path).toContain(path);
    for (const path of paths.filter((p) => !p.endsWith("/")))
      expect(() => read(path.slice(1)), `${path} existe`).not.toThrow();
  });
});
