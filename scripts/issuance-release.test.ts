import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { verifiedRun } from "./lib/issuance-gate.mjs";
import {
  ISSUANCE_FORBIDDEN_VARIABLES,
  RELEASE_WORKFLOWS,
  approvedRevision,
  issuanceBackupTarget,
  issuanceHealth,
  issuanceReleaseEnvironment,
  issuanceReleaseTarget,
  issuanceReleaseWorker,
} from "./lib/issuance-release.mjs";
import { consoleBuildEnvironment } from "./lib/selfhost.mjs";
import { issuanceProductionForbiddenVariables } from "../platform/convex/lib/issuanceProduction";
import { repoRoot, repoUrl } from "./lib/repo-root.mjs";

/**
 * Publication and offsite backup of the second target, the NFS-e fiscal production deployment
 * (#198, PR 6b). Synthetic plans only: no Convex, Cloudflare, R2 or GitHub call.
 */
const root = repoRoot;
const read = (path: string) => readFileSync(new URL(`${path}`, repoUrl), "utf8");
const json = (path: string) => JSON.parse(read(path));
const sandbox = json("deploy/platform-release.json").target;
const validation = json("platform/validation.json");
const release = {
  worker: "freecorpsnfe-fiscal",
  accountId: "a".repeat(32),
  frontend: "https://fiscal.example.com.br",
  api: "https://api.fiscal.example.com.br",
};
const NAMED = {
  version: 1,
  deployment: "brave-otter-123",
  url: "https://brave-otter-123.convex.cloud",
  release,
};
const code = (run: () => unknown) => {
  try {
    run();
    return "OK";
  } catch (error) {
    return (error as { code?: string }).code ?? "THROWN";
  }
};

describe("alvo da publicação", () => {
  it("o plano da main não nomeia deployment nem release: nada é publicado", () => {
    expect(
      code(() =>
        issuanceReleaseTarget(json("deploy/issuance-production.json"), sandbox, validation),
      ),
    ).toBe("PLAN_NOT_NAMED");
  });

  it("deployment nomeado sem release também não publica", () => {
    expect(
      code(() => issuanceReleaseTarget({ ...NAMED, release: null }, sandbox, validation)),
    ).toBe("RELEASE_NOT_PLANNED");
  });

  it("publica no Worker e nos domínios próprios do plano", () => {
    expect(issuanceReleaseTarget(NAMED, sandbox, validation)).toEqual({
      deployment: "brave-otter-123",
      cloud: "https://brave-otter-123.convex.cloud",
      site: "https://brave-otter-123.convex.site",
      ...release,
    });
  });

  it.each([
    ["o Worker do sandbox", { worker: sandbox.worker }],
    ["o console do sandbox", { frontend: sandbox.frontend }],
    ["a API do sandbox", { api: sandbox.api }],
    ["o console da validação", { frontend: validation.consoleUrl }],
    ["console e API iguais", { api: release.frontend }],
    ["domínio do Convex", { api: "https://brave-otter-123.convex.site" }],
    ["domínio workers.dev", { frontend: "https://fiscal.freecorps.workers.dev" }],
    ["http", { frontend: "http://fiscal.example.com.br" }],
    ["caminho", { api: "https://api.fiscal.example.com.br/v1" }],
    ["conta inválida", { accountId: "x" }],
    ["campo a mais", { extra: "x" }],
  ])("recusa %s", (_, change) => {
    expect(
      code(() =>
        issuanceReleaseTarget(
          { ...NAMED, release: { ...release, ...change } },
          sandbox,
          validation,
        ),
      ),
    ).toBe("RELEASE_INVALID");
  });
});

describe("ambiente do deployment antes de publicar", () => {
  const target = issuanceReleaseTarget(NAMED, sandbox, validation);
  const env = {
    APP_ENV: "installation",
    PRODUCT_ENV: "production",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    FNFE_ISSUANCE_ENV: "production",
    WEBHOOK_MODE: "https",
    SITE_URL: release.frontend,
    AUTH_PROXY_MODE: "signed",
    API_URL: release.api,
    FNFE_NFSE_PRODUCTION_COMPANIES: "j97abcdefghijklmnopqrstuvwxyz345",
  };

  it("aceita o perfil de produção fiscal marcado", () => {
    expect(code(() => issuanceReleaseEnvironment(env, target))).toBe("OK");
    expect(
      code(() =>
        issuanceReleaseEnvironment({ ...env, FNFE_CAPTURE_TRANSPORT: "disabled" }, target),
      ),
    ).toBe("OK");
  });

  it.each([
    { FNFE_ISSUANCE_ENV: undefined },
    { PRODUCT_ENV: "sandbox" },
    { APP_ENV: "validation" },
    { FISCAL_ENV: "production" },
    { SITE_URL: sandbox.frontend },
    { FNFE_CAPTURE_TRANSPORT: "sefin" },
    ...ISSUANCE_FORBIDDEN_VARIABLES.map((name) => ({ [name]: "" })),
  ])("recusa %o", (change) => {
    expect(code(() => issuanceReleaseEnvironment({ ...env, ...change }, target))).toBe(
      "ENVIRONMENT_MISMATCH",
    );
  });

  it("recusa o marcador do preview da avaliação de leitura (#642), com qualquer valor", () => {
    for (const value of ["preview-642", ""])
      expect(
        code(() => issuanceReleaseEnvironment({ ...env, FNFE_HOSTED_PROOF: value }, target)),
      ).toBe("ENVIRONMENT_MISMATCH");
  });

  it("as variáveis proibidas são as mesmas da plataforma", () => {
    expect(ISSUANCE_FORBIDDEN_VARIABLES).toEqual([...issuanceProductionForbiddenVariables]);
  });

  it("o Worker serve só os domínios do plano, com o console de produção", () => {
    const worker = issuanceReleaseWorker(target, root);
    expect(worker.name).toBe("freecorpsnfe-fiscal");
    expect(worker.routes).toEqual([
      { pattern: "fiscal.example.com.br", custom_domain: true },
      { pattern: "api.fiscal.example.com.br", custom_domain: true },
    ]);
    expect(worker.assets.directory.replaceAll("\\", "/")).toMatch(
      /\.selfhost\/hosted-production\/dist$/,
    );
  });
});

describe("SHA aprovado no dispatch", () => {
  it("precisa ser o SHA completo do run, senão falha com código próprio", () => {
    const sha = "a".repeat(40);
    expect(approvedRevision(sha, sha)).toBe(sha);
    for (const approved of ["b".repeat(40), "a".repeat(7), "A".repeat(40), "", undefined])
      expect(code(() => approvedRevision(approved, sha))).toBe("APPROVED_SHA_MISMATCH");
  });
});

describe("smoke estrito da produção fiscal", () => {
  const sha = "a".repeat(40);
  const health = {
    status: "ok",
    sha,
    appEnv: "installation",
    productEnv: "production",
    fiscalEnv: "disabled",
    issuanceEnv: "production",
  };
  it("espera a revisão publicada e exige o perfil completo", () => {
    expect(issuanceHealth(health, sha)).toBe("ready");
    expect(issuanceHealth({ ...health, sha: "b".repeat(40) }, sha)).toBe("pending");
    expect(issuanceHealth(null, sha)).toBe("pending");
    for (const change of [
      { issuanceEnv: undefined },
      { issuanceEnv: "disabled" },
      { productEnv: "sandbox" },
      { status: "misconfigured" },
    ])
      expect(code(() => issuanceHealth({ ...health, ...change }, sha))).toBe(
        "ENVIRONMENT_MISMATCH",
      );
  });
});

describe("console de produção", () => {
  const instance = { cloud: "https://c.example", site: "https://api.example" };
  it("o build do sandbox recebe exatamente as variáveis de antes", () => {
    expect(
      consoleBuildEnvironment(instance, "installation", "sandbox", "s".repeat(40), { PATH: "p" }),
    ).toEqual({
      PATH: "p",
      VITE_CONVEX_URL: "https://c.example",
      VITE_CONVEX_SITE_URL: "https://api.example",
      VITE_API_URL: "https://api.example",
      VITE_APP_ENV: "installation",
      VITE_APP_SHA: "s".repeat(40),
    });
  });
  it("só o build da produção fiscal recebe VITE_PRODUCT_ENV=production", () => {
    expect(
      consoleBuildEnvironment(instance, "installation", "production", "s".repeat(40), {}),
    ).toMatchObject({ VITE_PRODUCT_ENV: "production" });
    expect(() => consoleBuildEnvironment(instance, "installation", "staging", "s", {})).toThrow();
  });
});

describe("backup offsite do segundo alvo", () => {
  it("sem deployment no plano, pula sem tentar copiar", () => {
    expect(
      code(() => issuanceBackupTarget(json("deploy/issuance-production.json"), sandbox.accountId)),
    ).toBe("PLAN_NOT_NAMED");
    expect(issuanceBackupTarget(NAMED, sandbox.accountId)).toEqual({
      deployment: "brave-otter-123",
      cloud: "https://brave-otter-123.convex.cloud",
      site: "https://brave-otter-123.convex.site",
      accountId: sandbox.accountId,
    });
  });

  it.each(["snapshot", "check"])(
    "%s --target issuance registra skipped e sai com 0, sem segredo nem rede",
    (mode) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/backup/backup-offsite.mjs", mode, "--target", "issuance"],
        {
          cwd: root,
          env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({
        mode,
        result: "skipped",
        error: expect.stringContaining("PLAN_NOT_NAMED"),
      });
      const receipt = JSON.parse(read(`.ci-results/offsite-backup/${mode}-issuance.json`));
      expect(receipt).toMatchObject({ result: "skipped" });
      expect(receipt).not.toHaveProperty("deployment");
    },
  );
});

describe("executor da publicação", () => {
  it.each(["plan", "publish"])(
    "%s recusa com o plano atual antes de qualquer segredo",
    (action) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/deploy-issuance-production.mjs", action],
        {
          cwd: root,
          env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /PLAN_NOT_NAMED: deploy\/issuance-production\.json ainda não nomeia/,
      );
    },
  );
});

// The run of the publication, as the GitHub API answers it, and its approvals.
const SHA = "a".repeat(40);
const WORKFLOW = RELEASE_WORKFLOWS.publish.file;
const releaseEnv = {
  GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: `freecorps/freecorpsNFE/${WORKFLOW}@refs/heads/main`,
  GITHUB_RUN_ID: "4242",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: SHA,
};
const releaseRun = (overrides: Record<string, unknown> = {}) => ({
  id: 4242,
  run_attempt: 1,
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: SHA,
  path: WORKFLOW,
  status: "in_progress",
  repository: { full_name: "freecorps/freecorpsNFE" },
  actor: { login: "wolf-stievano" },
  triggering_actor: { login: "wolf-stievano" },
  ...overrides,
});
const approval = (login: string, environment = "nfse-production-release") => ({
  environments: [{ name: environment }],
  state: "approved",
  user: { login },
});
// The real list (deploy/issuance-gate.json): wolf-stievano and hhs0001.
const gate = json("deploy/issuance-gate.json");

describe("aprovação da publicação, a mesma do ligar", () => {
  const publish = (approvals: unknown, overrides: Record<string, unknown> = {}, env = {}) =>
    verifiedRun({
      action: "publish",
      env: { ...releaseEnv, ...env },
      run: releaseRun(overrides),
      approvals,
      config: gate,
      workflows: RELEASE_WORKFLOWS,
    });

  it("aprovação válida: outra pessoa de authorizedActors, no environment da publicação", () => {
    expect(publish([approval("hhs0001")])).toEqual({
      operator: "wolf-stievano",
      approver: "hhs0001",
      runId: "4242",
      runAttempt: 1,
    });
  });

  it("sem aprovação, aprovação de outro environment ou revisão recusada: recusa", () => {
    expect(code(() => publish([]))).toBe("APPROVAL_MISSING");
    expect(code(() => publish(null))).toBe("APPROVAL_MISSING");
    expect(code(() => publish([approval("hhs0001", "nfse-production-gate")]))).toBe(
      "APPROVAL_MISSING",
    );
    expect(code(() => publish([{ ...approval("hhs0001"), state: "rejected" }]))).toBe(
      "APPROVAL_REJECTED",
    );
  });

  it("quem aprova não pode ser quem disparou, nem quem disparou o run original", () => {
    expect(code(() => publish([approval("wolf-stievano")]))).toBe("APPROVER_INVALID");
    expect(
      code(() =>
        publish([approval("hhs0001")], {
          actor: { login: "hhs0001" },
          triggering_actor: { login: "wolf-stievano" },
        }),
      ),
    ).toBe("APPROVER_INVALID");
  });

  it("quem aprova precisa estar em authorizedActors", () => {
    expect(code(() => publish([approval("carla")]))).toBe("APPROVER_NOT_AUTHORIZED");
  });

  it("só este workflow, na primeira tentativa, no SHA do run", () => {
    expect(
      code(() =>
        publish(
          [approval("hhs0001")],
          {},
          {
            GITHUB_WORKFLOW_REF: releaseEnv.GITHUB_WORKFLOW_REF.replace(
              "deploy-issuance-production",
              "nfse-gate-enable",
            ),
          },
        ),
      ),
    ).toBe("RUN_INVALID");
    expect(code(() => publish([approval("hhs0001")], { head_sha: "b".repeat(40) }))).toBe(
      "RUN_INVALID",
    );
    expect(
      code(() => publish([approval("hhs0001")], { run_attempt: 2 }, { GITHUB_RUN_ATTEMPT: "2" })),
    ).toBe("RUN_ATTEMPT_REFUSED");
  });
});

describe("executor da publicação com o plano nomeado", () => {
  // The runner itself, with a named plan, the GitHub API, Convex, git and the subprocesses
  // replaced in a preload (the pattern of console-execution.test.ts): every network call and
  // subprocess is recorded, so a refusal can show that nothing reached Convex.
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  type Calls = { fetch: Array<{ url: string; authorization: string | null }>; spawn: string[][] };
  const runner = (approvals: unknown, plan: unknown = NAMED) => {
    const dir = mkdtempSync(join(tmpdir(), "fnfe-issuance-release-"));
    roots.push(dir);
    const log = join(dir, "calls.json"),
      preload = join(dir, "preload.mjs");
    const scenario = { log, plan, sha: SHA, run: releaseRun(), approvals };
    writeFileSync(
      preload,
      `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const scenario = ${JSON.stringify(scenario)};
const read = fs.readFileSync, write = fs.writeFileSync, calls = { fetch: [], spawn: [] };
const save = () => write(scenario.log, JSON.stringify(calls));
save();
fs.readFileSync = (file, ...args) =>
  scenario.plan && String(file).replaceAll("\\\\", "/").endsWith("/deploy/issuance-production.json")
    ? JSON.stringify(scenario.plan)
    : read(file, ...args);
cp.execFileSync = (_file, args) => (args[0] === "rev-parse" ? scenario.sha : "");
cp.spawnSync = (_file, args) => {
  calls.spawn.push(args);
  save();
  return { status: 0 };
};
syncBuiltinESMExports();
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  calls.fetch.push({ url: href, authorization: init.headers?.Authorization ?? null });
  save();
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (href.endsWith("/actions/runs/4242/attempts/1")) return json(scenario.run);
  if (href.endsWith("/actions/runs/4242/approvals")) return json(scenario.approvals);
  // The preflight answers a sandbox profile, so a run that gets this far stops right here.
  if (href.includes(".convex.cloud/"))
    return json({ status: "success", value: [{ name: "APP_ENV", value: "validation" }] });
  return new Response("{}", { status: 404 });
};
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        "scripts/deploy-issuance-production.mjs",
        "publish",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
          ...releaseEnv,
          GH_TOKEN: "synthetic-github",
          RELEASE_APPROVED_SHA: SHA,
          CI_TESTED_SHA: SHA,
          CONVEX_DEPLOY_KEY: "prod:brave-otter-123|synthetic-convex",
          CLOUDFLARE_API_TOKEN: "synthetic-cloudflare",
          CLOUDFLARE_ACCOUNT_ID: release.accountId,
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    const calls = JSON.parse(readFileSync(log, "utf8")) as Calls;
    return { result, calls };
  };
  const github = (calls: Calls) =>
    calls.fetch.every(
      (call) =>
        call.url.startsWith("https://api.github.com/repos/freecorps/freecorpsNFE/actions/runs/") &&
        call.authorization === "Bearer synthetic-github",
    );

  it.each([
    ["sem aprovação", [], "APPROVAL_MISSING"],
    ["aprovada por quem disparou", [approval("wolf-stievano")], "APPROVER_INVALID"],
    [
      "aprovada por quem não está em authorizedActors",
      [approval("carla")],
      "APPROVER_NOT_AUTHORIZED",
    ],
  ])("%s: recusa sem chamar o Convex nem publicar", (_, approvals, refusal) => {
    const { result, calls } = runner(approvals);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`^${refusal}: `));
    expect(calls.fetch.map((call) => call.url.split("/actions/runs/")[1])).toEqual([
      "4242/attempts/1",
      "4242/approvals",
    ]);
    expect(github(calls)).toBe(true);
    expect(calls.spawn).toEqual([]);
  });

  it("aprovação válida: segue e só então usa a chave de deploy no Convex", () => {
    const { result, calls } = runner([approval("hhs0001")]);
    expect(result.status).toBe(1);
    // The synthetic preflight answers a sandbox profile: the refusal comes after the approval.
    expect(result.stderr).toMatch(/^ENVIRONMENT_MISMATCH: Variável do backend: APP_ENV/);
    expect(calls.fetch.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/freecorps/freecorpsNFE/actions/runs/4242/attempts/1",
      "https://api.github.com/repos/freecorps/freecorpsNFE/actions/runs/4242/approvals",
      "https://brave-otter-123.convex.cloud/api/query",
    ]);
    expect(calls.fetch.at(-1)!.authorization).toBe("Convex prod:brave-otter-123|synthetic-convex");
    expect(calls.spawn).toEqual([]);
  });

  it("com o plano da main, continua PLAN_NOT_NAMED antes de qualquer rede", () => {
    const { result, calls } = runner([approval("hhs0001")], null);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^PLAN_NOT_NAMED: /);
    expect(calls.fetch).toEqual([]);
    expect(calls.spawn).toEqual([]);
  });
});

type Step = {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
};
const expression = (value: unknown) =>
  String(value)
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .replace(/\s+/g, "");

describe("workflows", () => {
  it("a publicação da produção fiscal só roda por dispatch, depois do plano e da CI", () => {
    const workflow = parse(read(".github/workflows/deploy-issuance-production.yml")) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, Job>;
    };
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const { plan, validate, publish } = workflow.jobs;
    expect(Object.keys(workflow.jobs)).toEqual(["plan", "validate", "publish"]);
    expect(plan!.environment).toBeUndefined();
    const check = plan!.steps!.at(-1)!;
    expect(check.run!.trim()).toBe("node scripts/deploy-issuance-production.mjs plan");
    // The approved SHA reaches the plan check by env, never interpolated in the shell.
    expect(expression(check.env!.APPROVED_SHA)).toBe("inputs.approved_sha");
    expect(validate!.uses).toBe("./.github/workflows/ci.yml");
    expect([validate!.needs].flat()).toEqual(["plan"]);
    expect(expression(validate!.if)).toBe(
      "github.ref=='refs/heads/main'&&inputs.approved_sha==github.sha",
    );
    expect([publish!.needs].flat()).toEqual(["plan", "validate"]);
    expect(expression(publish!.if)).toBe("needs.validate.outputs.tested_sha==github.sha");
    expect(publish!.environment).toBe(RELEASE_WORKFLOWS.publish.environment);
    // Only the publication job reads the run's approvals; the plan keeps contents: read.
    expect(publish!.permissions).toEqual({ contents: "read", actions: "read" });
    expect(plan!.permissions).toBeUndefined();
    // The CI grants exactly what ci.yml's Validate declares (read only, used just
    // by a push on main to fetch a pull request's task cache), never a write.
    const ci = parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, Job> };
    expect(validate!.permissions).toEqual(ci.jobs.validate!.permissions);
    expect(validate!.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
    });
    const run = publish!.steps!.find((step) =>
      step.run?.includes("deploy-issuance-production.mjs"),
    )!;
    expect(run.run!.trim()).toBe("node scripts/deploy-issuance-production.mjs publish");
    expect(expression(run.env!.GH_TOKEN)).toBe("github.token");
    // The token reaches no other step, in particular not the dependency install.
    for (const step of publish!.steps!)
      if (step !== run) expect(step.env?.GH_TOKEN, step.run ?? step.uses).toBeUndefined();
    expect(expression(run.env!.CONVEX_DEPLOY_KEY)).toBe("secrets.FNFE_ISSUANCE_DEPLOY_KEY");
    expect(expression(run.env!.CLOUDFLARE_API_TOKEN)).toBe(
      "secrets.FNFE_ISSUANCE_CLOUDFLARE_API_TOKEN",
    );
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? []) {
        if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
        if (step.run) expect(step.run).not.toContain("${{");
      }
  });

  it("o deploy do sandbox na main não lê o plano, a chave nem o executor da produção fiscal", () => {
    for (const path of [
      ".github/workflows/deploy.yml",
      "scripts/deploy-platform.mjs",
      "scripts/lib/platform-release.mjs",
    ]) {
      const text = read(path);
      for (const forbidden of [
        "issuance-production",
        "FNFE_ISSUANCE_DEPLOY_KEY",
        "hosted-production",
        "build-hosted-production",
        "VITE_PRODUCT_ENV",
      ])
        expect(text, `${path} cita ${forbidden}`).not.toContain(forbidden);
    }
    // It still builds the sandbox console with the same command.
    expect(read("scripts/deploy-platform.mjs")).toContain(
      'run("scripts/selfhost.mjs", ["build-hosted", hostedConfig]);',
    );
  });

  it("o backup do segundo alvo só usa o environment próprio, depois do plano", () => {
    const workflow = parse(read(".github/workflows/offsite-backup.yml")) as {
      jobs: Record<string, Job>;
    };
    expect(Object.keys(workflow.jobs)).toEqual([
      "snapshot",
      "check",
      "issuance-plan",
      "snapshot-issuance",
      "check-issuance",
    ]);
    // The sandbox jobs never see the fiscal production key.
    for (const name of ["snapshot", "check"]) {
      expect(workflow.jobs[name]!.environment).toBe("offsite-backup");
      expect(JSON.stringify(workflow.jobs[name])).not.toContain("issuance");
    }
    expect(workflow.jobs["issuance-plan"]!.environment).toBeUndefined();
    for (const name of ["snapshot-issuance", "check-issuance"]) {
      const job = workflow.jobs[name]!;
      expect(job.environment).toBe("offsite-backup-issuance");
      expect([job.needs].flat()).toEqual(["issuance-plan"]);
      expect(expression(job.if)).toMatch(/^needs\.issuance-plan\.outputs\.named=='true'&&/);
      expect(job.steps!.some((step) => step.run?.includes("--target issuance"))).toBe(true);
    }
  });
});
