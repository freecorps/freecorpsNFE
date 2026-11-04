import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import {
  GATE_WORKFLOWS,
  convexCall,
  deployKeyFor,
  dispatchInputs,
  gateConfig,
  hasUnsafeText,
  productionHealth,
  productionTarget,
  summary,
  verifiedRun,
} from "../lib/issuance-gate.mjs";
import { hasUnsafeText as convexUnsafeText } from "../../platform/convex/lib/issuanceGate";
import { repoRoot, repoUrl } from "../lib/repo-root.mjs";

/**
 * Workflows of the NFS-e fiscal production (#198): enable with another person's approval,
 * emergency disable by an authorized person, read-only probe and verification. Everything here is
 * synthetic: no GitHub API, no Convex, no tax authority.
 */
const root = repoRoot;
const read = (path: string) => readFileSync(new URL(`${path}`, repoUrl), "utf8");
const NAMED = {
  version: 1,
  deployment: "brave-otter-123",
  url: "https://brave-otter-123.convex.cloud",
};
const config = { version: 1, authorizedActors: ["ana-freecorps", "bruno"] };
const code = (run: () => unknown) => {
  try {
    run();
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? "THROWN";
  }
};

describe("plano versionado", () => {
  it("com deployment null, nenhum workflow chama o Convex e o motivo é claro", () => {
    expect(code(() => productionTarget({ version: 1, deployment: null, url: null }))).toBe(
      "PLAN_NOT_NAMED",
    );
    expect(() => productionTarget({ version: 1, deployment: null, url: null })).toThrow(
      /ainda não nomeia o deployment de produção fiscal/,
    );
  });

  it("o plano da main hoje não nomeia deployment: tudo fica fechado", () => {
    expect(code(() => productionTarget(JSON.parse(read("deploy/issuance-production.json"))))).toBe(
      "PLAN_NOT_NAMED",
    );
  });

  it("aceita só um deployment com a url do Convex Cloud correspondente", () => {
    expect(productionTarget(NAMED)).toEqual({
      deployment: "brave-otter-123",
      cloud: "https://brave-otter-123.convex.cloud",
      site: "https://brave-otter-123.convex.site",
    });
    for (const plan of [
      { ...NAMED, version: 2 },
      { ...NAMED, url: "https://outro-alvo-1.convex.cloud" },
      { ...NAMED, deployment: "Brave-Otter-123" },
      null,
    ])
      expect(code(() => productionTarget(plan))).toBe("PLAN_INVALID");
  });
});

describe("entradas e alvo", () => {
  const env = {
    GATE_ORGANIZATION_ID: "k57abcdefghijklmnopqrstuvwxyz012",
    GATE_COMPANY_ID: "j97abcdefghijklmnopqrstuvwxyz345",
    GATE_REASON: "Primeira nota de exportação da Freecorps",
  };

  it("valida ids, motivo e, só na verificação, a emissão", () => {
    expect(dispatchInputs(env, "enable")).toEqual({
      organizationId: env.GATE_ORGANIZATION_ID,
      companyId: env.GATE_COMPANY_ID,
      reason: env.GATE_REASON,
    });
    expect(code(() => dispatchInputs(env, "verify-issued"))).toBe("INPUT_INVALID");
    expect(
      dispatchInputs(
        { ...env, GATE_ISSUANCE_ID: "m11abcdefghijklmnopqrstuvwxyz678" },
        "verify-issued",
      ),
    ).toMatchObject({ issuanceId: "m11abcdefghijklmnopqrstuvwxyz678" });
    for (const change of [
      { GATE_COMPANY_ID: "$(curl evil)" },
      { GATE_ORGANIZATION_ID: "" },
      { GATE_REASON: "curto" },
      { GATE_REASON: "Motivo com controle ‮ invertido" },
      { GATE_REASON: "x".repeat(501) },
    ])
      expect(code(() => dispatchInputs({ ...env, ...change }, "enable"))).toBe("INPUT_INVALID");
  });

  it("recusa caracteres inseguros como a validação do Convex", () => {
    for (const text of [
      "ok texto",
      "tab\tno meio",
      "bidi ⁦ aqui",
      "c1 \u0085",
      "del \u007f",
      "árvore ç",
    ])
      expect(hasUnsafeText(text), text).toBe(convexUnsafeText(text));
  });

  it("a chave de deploy precisa ser a do deployment do plano", () => {
    expect(deployKeyFor("prod:brave-otter-123|abc", "brave-otter-123")).toBe(
      "prod:brave-otter-123|abc",
    );
    for (const key of [
      "prod:elated-possum-295|abc",
      "dev:brave-otter-123|abc",
      "prod:brave-otter-123|",
      "",
      undefined,
    ])
      expect(code(() => deployKeyFor(key, "brave-otter-123"))).toBe("DEPLOY_KEY_MISMATCH");
  });

  it("o deployment precisa responder como produção fiscal no /health", () => {
    expect(code(() => productionHealth({ status: "ok", issuanceEnv: "production" }))).toBe("OK");
    for (const health of [
      { status: "ok", issuanceEnv: "disabled" },
      { status: "misconfigured" },
      null,
    ])
      expect(code(() => productionHealth(health))).toBe("DEPLOYMENT_NOT_FISCAL");
  });

  it("a lista de pessoas autorizadas é de logins válidos e sem repetição", () => {
    expect(
      gateConfig(JSON.parse(read("deploy/issuance-gate.json"))).authorizedActors.length,
    ).toBeGreaterThan(0);
    for (const bad of [
      { version: 1, authorizedActors: [] },
      { version: 1, authorizedActors: ["-ruim"] },
      { version: 1, authorizedActors: ["ana", "ANA"] },
      { version: 2, authorizedActors: ["ana"] },
    ])
      expect(code(() => gateConfig(bad))).toBe("GATE_CONFIG_INVALID");
  });
});

describe("run e aprovação lidos da API do GitHub", () => {
  const envFor = (action: keyof typeof GATE_WORKFLOWS, attempt = 1) => ({
    GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `freecorps/freecorpsNFE/${GATE_WORKFLOWS[action].file}@refs/heads/main`,
    GITHUB_RUN_ID: "4242",
    GITHUB_RUN_ATTEMPT: String(attempt),
    GITHUB_SHA: "a".repeat(40),
  });
  const runFor = (
    action: keyof typeof GATE_WORKFLOWS,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: 4242,
    run_attempt: 1,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "a".repeat(40),
    path: GATE_WORKFLOWS[action].file,
    status: "in_progress",
    repository: { full_name: "freecorps/freecorpsNFE" },
    actor: { login: "ana-freecorps" },
    triggering_actor: { login: "ana-freecorps" },
    ...overrides,
  });
  const approval = (login: string, state = "approved", environment = "nfse-production-gate") => ({
    environments: [{ name: environment }],
    state,
    user: { login },
  });
  const enable = (
    overrides: Record<string, unknown> = {},
    approvals: unknown = [approval("bruno")],
  ) =>
    verifiedRun({
      action: "enable",
      env: envFor("enable"),
      run: runFor("enable", overrides),
      approvals,
      config,
    });

  it("ligar: operador e aprovador vêm do run, e são pessoas diferentes", () => {
    expect(enable()).toEqual({
      operator: "ana-freecorps",
      approver: "bruno",
      runId: "4242",
      runAttempt: 1,
    });
    // A new attempt by someone else records both: the approver differs from each.
    expect(code(() => enable({ triggering_actor: { login: "bruno" } }, [approval("bruno")]))).toBe(
      "APPROVER_INVALID",
    );
    expect(code(() => enable({}, [approval("ANA-FREECORPS")]))).toBe("APPROVER_INVALID");
    expect(code(() => enable({ actor: { login: "carla" } }, [approval("carla")]))).toBe(
      "APPROVER_INVALID",
    );
  });

  it("ligar: quem aprova precisa estar em authorizedActors", () => {
    expect(code(() => enable({}, [approval("carla")]))).toBe("APPROVER_NOT_AUTHORIZED");
    expect(enable({}, [approval("BRUNO")])).toMatchObject({ approver: "BRUNO" });
    expect(
      code(() =>
        verifiedRun({
          action: "enable",
          env: envFor("enable"),
          run: runFor("enable"),
          approvals: [approval("bruno")],
          config: { version: 1, authorizedActors: [] },
        }),
      ),
    ).toBe("GATE_CONFIG_INVALID");
  });

  it("ligar: sem aprovação, com revisão recusada, aprovação de outro environment ou duas", () => {
    expect(code(() => enable({}, []))).toBe("APPROVAL_MISSING");
    expect(code(() => enable({}, [approval("bruno", "rejected")]))).toBe("APPROVAL_REJECTED");
    expect(code(() => enable({}, [approval("bruno", "approved", "production")]))).toBe(
      "APPROVAL_MISSING",
    );
    expect(code(() => enable({}, [approval("bruno"), approval("carla")]))).toBe("APPROVAL_MISSING");
    expect(code(() => enable({}, null))).toBe("APPROVAL_MISSING");
  });

  it("ligar: só na primeira tentativa, porque a aprovação não diz de qual tentativa é", () => {
    expect(
      code(() =>
        verifiedRun({
          action: "enable",
          env: envFor("enable", 2),
          run: runFor("enable", { run_attempt: 2 }),
          approvals: [approval("bruno")],
          config,
        }),
      ),
    ).toBe("RUN_ATTEMPT_REFUSED");
  });

  it("o run precisa ser este workflow, na main, por dispatch, em andamento", () => {
    for (const overrides of [
      { id: 4243 },
      { event: "push" },
      { head_branch: "feature" },
      { head_sha: "b".repeat(40) },
      { path: ".github/workflows/nfse-gate-emergency.yml" },
      { status: "completed" },
      { repository: { full_name: "external/fork" } },
      { triggering_actor: { login: "-ruim" } },
    ])
      expect(
        code(() => enable(overrides)),
        JSON.stringify(overrides),
      ).toBe("RUN_INVALID");
    for (const env of [
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REPOSITORY: "external/fork" },
      // The probe workflow can never run the enable action.
      {
        GITHUB_WORKFLOW_REF:
          "freecorps/freecorpsNFE/.github/workflows/nfse-production-probe.yml@refs/heads/main",
      },
    ])
      expect(
        code(() =>
          verifiedRun({
            action: "enable",
            env: { ...envFor("enable"), ...env },
            run: runFor("enable"),
            approvals: [approval("bruno")],
            config,
          }),
        ),
        JSON.stringify(env),
      ).toBe("RUN_INVALID");
  });

  it("emergência, probe e verificação: só quem está em authorizedActors, sem aprovação", () => {
    for (const action of ["emergency_disable", "probe", "verify-issued"] as const) {
      const run = (login: string, actor = login) =>
        verifiedRun({
          action,
          env: envFor(action),
          run: runFor(action, { triggering_actor: { login }, actor: { login: actor } }),
          approvals: null,
          config,
        });
      expect(run("bruno")).toEqual({ operator: "bruno", runId: "4242", runAttempt: 1 });
      expect(run("Bruno", "ana-freecorps")).toEqual({
        operator: "Bruno",
        actor: "ana-freecorps",
        runId: "4242",
        runAttempt: 1,
      });
      expect(code(() => run("intruso"))).toBe("ACTOR_NOT_AUTHORIZED");
      expect(code(() => run("bruno", "intruso"))).toBe("ACTOR_NOT_AUTHORIZED");
    }
  });
});

describe("chamada ao Convex", () => {
  const inputs = {
    organizationId: "k57abcdefghijklmnopqrstuvwxyz012",
    companyId: "j97abcdefghijklmnopqrstuvwxyz345",
    reason: "Primeira nota de exportação da Freecorps",
    issuanceId: "m11abcdefghijklmnopqrstuvwxyz678",
  };
  const run = { operator: "ana-freecorps", approver: "bruno", runId: "4242", runAttempt: 1 };

  it("o tipo vem da ação do workflow, nunca de uma entrada", () => {
    expect(convexCall("enable", inputs, run)).toEqual({
      path: "issuance:setProductionGate",
      args: {
        organizationId: inputs.organizationId,
        companyId: inputs.companyId,
        kind: "enable",
        operator: "ana-freecorps",
        reason: inputs.reason,
        approver: "bruno",
        runId: "4242",
        runAttempt: 1,
      },
    });
    expect(
      convexCall("emergency_disable", inputs, { ...run, approver: undefined }).args,
    ).toMatchObject({
      kind: "emergency_disable",
    });
    expect(
      convexCall("emergency_disable", inputs, { ...run, approver: undefined }).args,
    ).not.toHaveProperty("approver");
    expect(convexCall("probe", inputs, run)).toEqual({
      path: "issuanceProbe:verify",
      args: {
        organizationId: inputs.organizationId,
        companyId: inputs.companyId,
        operator: "ana-freecorps",
        reason: inputs.reason,
      },
    });
    expect(convexCall("verify-issued", inputs, run).path).toBe("issuanceProbe:verifyIssued");
  });

  it("o log mostra desfechos, nunca a chave de acesso nem corpos", () => {
    const shown = summary("verify-issued", {
      accessKey: "35503082211222333000181000000000000726100000000007",
      dps: { outcome: "found", accessKey: "355" },
      nfse: { outcome: "found", dpsMatches: true },
      single: true,
    });
    expect(shown).toEqual({ single: true, dps: "found", nfse: "found" });
    expect(
      JSON.stringify(
        summary("probe", {
          consultations: [
            {
              target: "sefin",
              outcome: "not-found",
              code: null,
              httpStatus: 404,
              diagnostic: { keys: ["x"] },
            },
          ],
          adhesion: [{ source: "adn", httpStatus: 200, aderenteEmissorNacional: 1, code: null }],
        }),
      ),
    ).not.toContain("diagnostic");
  });
});

describe("executor", () => {
  it.each(["enable", "emergency_disable", "probe", "verify-issued"])(
    "%s recusa com o plano atual antes de ler qualquer segredo ou chamar a rede",
    (action) => {
      const result = spawnSync(process.execPath, ["scripts/deploy/issuance-gate.mjs", action], {
        cwd: root,
        // Without GH_TOKEN or a deploy key: reaching the network would fail differently.
        env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /PLAN_NOT_NAMED: deploy\/issuance-production\.json ainda não nomeia/,
      );
    },
  );
});

type Step = { uses?: string; run?: string; if?: string; env?: Record<string, string> };
type Job = {
  needs?: string | string[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
};
const expression = (value: unknown) =>
  String(value)
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .replace(/\s+/g, "");

describe("workflows", () => {
  const files = {
    enable: "nfse-gate-enable.yml",
    emergency_disable: "nfse-gate-emergency.yml",
    probe: "nfse-production-probe.yml",
  } as const;

  const workflowOf = (file: string) =>
    parse(read(`.github/workflows/${file}`)) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, Job & { "runs-on"?: string }>;
    };
  const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";

  it.each(Object.entries(files))(
    "%s: só dispatch na main, ações fixadas por SHA, entradas por env, sem setup-vp",
    (action, file) => {
      const workflow = workflowOf(file);
      expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
      expect(workflow.permissions).toEqual({ contents: "read" });
      const jobs = Object.entries(workflow.jobs);
      for (const [name, job] of jobs) {
        expect(expression(job.if), name).toBe("github.ref=='refs/heads/main'");
        for (const step of job.steps) {
          if (step.uses) expect(step.uses, step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
          // The runner uses only Node built-in modules: no Vite+ toolchain, no install.
          expect(step.uses ?? "", name).not.toContain("setup-vp");
          expect(step.run ?? "", name).not.toMatch(/\bvp install\b/);
          // Inputs reach the runner only through env:, never interpolated in the shell.
          if (step.run) expect(step.run, `${name}: ${step.run}`).not.toContain("${{");
        }
      }
      const credentialed = jobs.filter(([, job]) => job.environment);
      expect(credentialed).toHaveLength(1);
      const [, job] = credentialed[0]!;
      expect(job.environment).toBe(
        GATE_WORKFLOWS[action as keyof typeof GATE_WORKFLOWS].environment,
      );
      expect(job.permissions).toEqual({ contents: "read", actions: "read" });
      const runs = job.steps
        .filter((step) => step.run?.startsWith("node scripts/"))
        .map((step) => step.run!.trim());
      const expected =
        action === "probe"
          ? ["node scripts/deploy/issuance-gate.mjs probe", "node scripts/deploy/issuance-gate.mjs verify-issued"]
          : [`node scripts/deploy/issuance-gate.mjs ${action}`];
      expect(runs).toEqual(expected);
      for (const step of job.steps.filter((s) => s.run?.startsWith("node scripts/")))
        expect(expression(step.env?.CONVEX_DEPLOY_KEY)).toBe("secrets.FNFE_ISSUANCE_DEPLOY_KEY");
      if (action === "emergency_disable") return;
      // Enable and probe: a plan job without secrets first, so no approval is requested in vain.
      expect(jobs.map(([name]) => name)).toEqual(["plan", credentialed[0]![0]]);
      const [, plan] = jobs[0]!;
      expect(plan.environment).toBeUndefined();
      expect(plan.steps.at(-1)!.run).toBe("node scripts/deploy/issuance-gate.mjs plan");
      expect([job.needs].flat()).toEqual(["plan"]);
      for (const [, each] of jobs)
        expect(
          each.steps.map((step) => step.uses).filter((uses) => uses?.includes("setup-node")),
        ).toEqual([`${SETUP_NODE}`]);
    },
  );

  it("a emergência é um job só, num runner do GitHub, sem depender de download", () => {
    const jobs = Object.entries(workflowOf(files.emergency_disable).jobs);
    expect(jobs).toHaveLength(1);
    const [, job] = jobs[0]!;
    expect(job.needs).toBeUndefined();
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    const uses = job.steps.map((step) => step.uses).filter(Boolean);
    expect(uses.map((u) => u!.split("@")[0])).toEqual([
      "actions/checkout",
      "actions/upload-artifact",
    ]);
    // The Node of the runner image, checked explicitly instead of a download.
    expect(job.steps.some((step) => step.run?.includes("process.versions.node"))).toBe(true);
  });

  it("a emergência nunca espera na fila de um ligar parado na aprovação", () => {
    const group = (file: string) =>
      (parse(read(`.github/workflows/${file}`)) as { concurrency: { group: string } }).concurrency
        .group;
    expect(group(files.emergency_disable)).not.toBe(group(files.enable));
    expect(group(files.emergency_disable)).not.toBe(group(files.probe));
  });

  it("só a publicação e o backup do segundo alvo recebem a chave, e nenhum outro chama o gate", () => {
    const directory = new URL(".github/workflows/", repoUrl);
    // Publication and offsite backup of the fiscal production (#198, PR 6b): the key only in
    // their own environments; the backup uses the runner only to read the plan.
    const keyed = ["deploy-issuance-production.yml", "offsite-backup.yml"];
    for (const name of readdirSync(directory).filter((n) => /\.ya?ml$/.test(n))) {
      if ((Object.values(files) as string[]).includes(name)) continue;
      const text = readFileSync(new URL(name, directory), "utf8");
      if (!keyed.includes(name)) expect(text, name).not.toContain("FNFE_ISSUANCE_DEPLOY_KEY");
      expect(text, name).not.toContain("setProductionGate");
      const runs = text.match(/issuance-gate\.mjs\s+\S+/g) ?? [];
      expect(
        runs.every((run) => run === "issuance-gate.mjs plan;"),
        `${name}: ${runs.join(", ")}`,
      ).toBe(true);
    }
  });
});

describe("CODEOWNERS", () => {
  it("cobre workflows, planos e o código do gate, só com o dono do projeto", () => {
    const rules = read(".github/CODEOWNERS")
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/));
    const owners = new Set(rules.flatMap(([, ...names]) => names));
    // The project owner only, by his decision of 26/10/2026 (ADR 0007, #424).
    expect([...owners].sort((a, b) => a.localeCompare(b))).toEqual(["@wolf-stievano"]);
    const paths = rules.map(([path]) => path);
    for (const path of [
      "/.github/workflows/",
      "/.github/CODEOWNERS",
      "/deploy/",
      "/scripts/deploy/issuance-gate.mjs",
      "/scripts/lib/issuance-gate.mjs",
      "/scripts/deploy/deploy-issuance-production.mjs",
      "/scripts/lib/issuance-release.mjs",
      "/platform/convex/issuance.ts",
      "/platform/convex/lib/issuanceGate.ts",
      "/platform/convex/lib/issuanceProduction.ts",
    ])
      expect(paths, path).toContain(path);
    for (const [, ...names] of rules) expect(names).toEqual(["@wolf-stievano"]);
  });
});
