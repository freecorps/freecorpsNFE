import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { parse } from "yaml";
import { publishRevision } from "../lib/validation-deploy.mjs";
import {
  releaseTarget,
  releaseEnvironment,
  installationRecord,
  bootstrapPreconditions,
  releasePreconditions,
  releaseAuthorization,
  releaseWorker,
  bootstrapRevision,
  legacyEnvironmentNames,
} from "../lib/platform-release.mjs";
import { repoRoot, repoUrl } from "../lib/repo-root.mjs";
import viteConfig from "../../vite.config";

it("exige retirar credenciais legadas e de wipe sem remover chaves da plataforma", () => {
  expect(
    legacyEnvironmentNames([
      "FNFE_CUTOVER_TOKEN",
      "FNFE_CERT_PFX_PASSWORD",
      "CLERK_JWT_ISSUER_DOMAIN",
      "FNFE_CRONS",
      "FNFE_PLATFORM_CERT_KEYS",
      "FNFE_WEBHOOK_MASTER_KEY",
      "BETTER_AUTH_SECRET",
    ]),
  ).toEqual(["FNFE_CUTOVER_TOKEN", "FNFE_CERT_PFX_PASSWORD", "CLERK_JWT_ISSUER_DOMAIN"]);
});

const plan = {
  version: 3,
  productEnvironment: "sandbox",
  target: {
    deployment: "elated-possum-295",
    worker: "freecorpsnfe-backoffice",
    accountId: "a".repeat(32),
    frontend: "https://nfe.freecorps.com.br",
    api: "https://api.nfe.freecorps.com.br",
  },
};
it("preserva HTTPS no release autorizado e mantém o bootstrap sem envio externo", () => {
  const target = releaseTarget(plan);
  const actual = {
    APP_ENV: "installation",
    PRODUCT_ENV: "sandbox",
    FISCAL_ENV: "disabled",
    FNFE_CRONS: "off",
    WEBHOOK_MODE: "https",
    SITE_URL: target.frontend,
    AUTH_PROXY_MODE: "signed",
    API_URL: target.api,
  };
  expect(() => releaseEnvironment(actual, target, "release")).not.toThrow();
  expect(() => releaseEnvironment(actual, target, "bootstrap")).toThrow("WEBHOOK_MODE");
  const initial = { ...actual, WEBHOOK_MODE: "disabled" };
  expect(() => releaseEnvironment(initial, target, "bootstrap")).not.toThrow();
  expect(() => releaseEnvironment(initial, target, "release")).toThrow("WEBHOOK_MODE");
  expect(() => releaseEnvironment(actual, target, "unknown")).toThrow("Unknown release operation");
  // The variables of the NFS-e fiscal production never belong to the hosted sandbox, in any value.
  for (const name of ["FNFE_ISSUANCE_ENV", "FNFE_NFSE_PRODUCTION_COMPANIES"])
    for (const value of ["production", "disabled", ""])
      expect(() => releaseEnvironment({ ...actual, [name]: value }, target, "release")).toThrow(
        name,
      );
  // Nor the marker of the throwaway preview of the read evaluation (#642), in any value.
  for (const value of ["preview-642", ""])
    expect(() =>
      releaseEnvironment({ ...actual, FNFE_HOSTED_PROOF: value }, target, "release"),
    ).toThrow("FNFE_HOSTED_PROOF");
  // The #50 policy never reaches the site; its capture adapter is off or the real one.
  expect(() =>
    releaseEnvironment({ ...actual, FNFE_FISCAL_PROOF: "{}" }, target, "release"),
  ).toThrow("FNFE_FISCAL_PROOF");
  for (const value of ["", "disabled", "sefaz"])
    expect(() =>
      releaseEnvironment({ ...actual, FNFE_CAPTURE_TRANSPORT: value }, target, "release"),
    ).not.toThrow();
  expect(() =>
    releaseEnvironment({ ...actual, FNFE_CAPTURE_TRANSPORT: "simulated" }, target, "release"),
  ).toThrow("FNFE_CAPTURE_TRANSPORT");
  for (const key of Object.keys(actual)) {
    for (const invalid of [undefined, "unexpected"]) {
      expect(() => releaseEnvironment({ ...actual, [key]: invalid }, target, "release")).toThrow(
        key,
      );
    }
  }
});
it("reutiliza somente o destino autorizado e mantém produção fiscal bloqueada", () => {
  expect(releaseTarget(plan).deployment).toBe("elated-possum-295");
  expect(() => releaseTarget({ ...plan, target: null })).toThrow();
  // Version 2 mixed the one-time cutover strategy into every update.
  expect(() => releaseTarget({ ...plan, version: 2, strategy: "replace-legacy-empty" })).toThrow();
  for (const deployment of ["other-platform-123", "happy-animal-123", "modest-seal-118"])
    expect(() => releaseTarget({ ...plan, target: { ...plan.target, deployment } })).toThrow();
  expect(() => releaseTarget({ ...plan, productEnvironment: "production" })).toThrow();
  expect(() =>
    releaseTarget({
      ...plan,
      target: { ...plan.target, frontend: "https://other.example.com" },
    }),
  ).toThrow();
  for (const api of [undefined, "https://other.example.com", "https://nfe.freecorps.com.br"])
    expect(() => releaseTarget({ ...plan, target: { ...plan.target, api } })).toThrow(
      "Approved API address required",
    );
});
it("publica a API REST no mesmo Worker, em host próprio e com o IP assinado", () => {
  const worker = releaseWorker(releaseTarget(plan), "/repo");
  expect(worker.routes).toEqual([
    { pattern: "nfe.freecorps.com.br", custom_domain: true },
    { pattern: "api.nfe.freecorps.com.br", custom_domain: true },
  ]);
  expect(worker.vars.API_ORIGIN).toBe("https://api.nfe.freecorps.com.br");
  expect(worker.assets.run_worker_first).toEqual(["/api/auth/*", "/v1/*", "/health", "/docs/404"]);
  expect(worker.secrets.required).toEqual(["AUTH_PROXY_SECRET"]);
});
it.each(["push", "workflow_dispatch"])(
  "exige SHA aprovado, plano e credencial do alvo aprovado em %s",
  (event) => {
    const target = releaseTarget(plan),
      sha = "a".repeat(40),
      hash = "b".repeat(64);
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "freecorps/freecorpsNFE",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: event,
      RELEASE_OPERATION: "release",
      GITHUB_SHA: sha,
      RELEASE_APPROVED_SHA: sha,
      RELEASE_PLAN_HASH: hash,
      CONVEX_DEPLOY_KEY: `prod:${target.deployment}|synthetic`,
      CLOUDFLARE_API_TOKEN: "synthetic",
      CLOUDFLARE_ACCOUNT_ID: target.accountId,
    };
    expect(() => releaseAuthorization(env, sha, target, hash)).not.toThrow();
    for (const patch of [
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_EVENT_NAME: "workflow_run" },
      { GITHUB_REPOSITORY: "other/freecorpsNFE" },
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_SHA: "c".repeat(40) },
      { RELEASE_APPROVED_SHA: "c".repeat(40) },
      { RELEASE_OPERATION: "" },
      { RELEASE_APPROVED_SHA: "" },
      { RELEASE_PLAN_HASH: "" },
      { CONVEX_DEPLOY_KEY: "dev:happy-animal-123|synthetic" },
      { CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) },
    ])
      expect(() => releaseAuthorization({ ...env, ...patch }, sha, target, hash)).toThrow();
    const bootstrap = () =>
      releaseAuthorization({ ...env, RELEASE_OPERATION: "bootstrap" }, sha, target, hash);
    if (event === "push") expect(bootstrap).toThrow("bootstrap is manual only");
    else expect(bootstrap).not.toThrow();
  },
);
const allGates = ["legacyReset", "consumerTransition", "authBootstrap"];
function withInstallation(
  gates: string[],
  test: (root: string, installed: typeof plan & { installation: Installation }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "fnfe-release-test-"));
  try {
    mkdirSync(join(root, "docs/v1.0/evidence"), { recursive: true });
    writeFileSync(join(root, "docs/v1.0/evidence/receipt.json"), "synthetic");
    const sha256 = createHash("sha256").update("synthetic").digest("hex");
    test(root, {
      ...plan,
      installation: {
        strategy: "replace-legacy-empty",
        decisions: { discardLegacyData: true, reuseAddress: true, freshBetterAuthAccounts: true },
        receipts: gates.map((gate) => ({ gate, path: "docs/v1.0/evidence/receipt.json", sha256 })),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
type Installation = {
  strategy: string;
  decisions: Record<string, boolean>;
  receipts: { gate: string; path: string; sha256: string }[];
};
it("mantém o registro histórico do corte verificável pelos hashes", () => {
  withInstallation(allGates, (root, installed) => {
    const record = (installation: Partial<Installation>) =>
      installationRecord(
        { ...installed, installation: { ...installed.installation, ...installation } },
        root,
      );
    expect(record({})).toEqual({ complete: true });
    expect(() => record({ strategy: "other" })).toThrow("clean-start");
    expect(() => record({ decisions: {} })).toThrow("clean-start");
    const receipts = installed.installation.receipts;
    for (const patched of [
      [...receipts, receipts[0]],
      [...receipts, { ...receipts[0], gate: "release" }],
      [{ ...receipts[0], path: "../outside.json" }, ...receipts.slice(1)],
      [{ ...receipts[0], sha256: "pending" }, ...receipts.slice(1)],
    ])
      expect(() => record({ receipts: patched })).toThrow();
    writeFileSync(join(root, "docs/v1.0/evidence/receipt.json"), "changed");
    expect(() => record({})).toThrow("Evidence hash differs");
    expect(() => bootstrapPreconditions(installed, root)).toThrow("Evidence hash differs");
    expect(() => releasePreconditions(installed, root)).toThrow("Evidence hash differs");
  });
});
it("bootstrap exige o corte registrado, repete antes da prova de login e não depois dela", () => {
  withInstallation(["legacyReset", "consumerTransition"], (root, cutover) => {
    expect(installationRecord(cutover, root)).toEqual({ complete: false });
    expect(() => bootstrapPreconditions(cutover, root)).not.toThrow();
  });
  // Concluída a instalação, só o release publica (#525).
  withInstallation(allGates, (root, installed) =>
    expect(() => bootstrapPreconditions(installed, root)).toThrow("use release"),
  );
  for (const gates of [[], ["legacyReset"], ["consumerTransition", "authBootstrap"]])
    withInstallation(gates, (root, incomplete) =>
      expect(() => bootstrapPreconditions(incomplete, root)).toThrow("Missing evidence"),
    );
  expect(() => bootstrapPreconditions(plan, "/repo")).toThrow("clean-start");
});
it("release exige a instalação concluída sem pedir novos aceites do corte", () => {
  withInstallation(allGates, (root, installed) =>
    expect(() => releasePreconditions(installed, root)).not.toThrow(),
  );
  withInstallation(["legacyReset", "consumerTransition"], (root, cutover) =>
    expect(() => releasePreconditions(cutover, root)).toThrow("completed installation"),
  );
  withInstallation(["legacyReset", "authBootstrap"], (root, partial) =>
    expect(() => releasePreconditions(partial, root)).toThrow(
      "Missing evidence: consumerTransition",
    ),
  );
  expect(() => releasePreconditions(plan, "/repo")).toThrow("clean-start");
});
type Receipt = { state: string; phase: string; before?: string; after?: string };
function releaseOperations(calls: string[], overrides: Record<string, unknown> = {}) {
  return {
    preflight: async () => calls.push("preflight"),
    build: async () => calls.push("build"),
    eligible: async () => true,
    probe: async () => ({ key: "persistence-v1", nonce: "synthetic" }),
    backend: async () => calls.push("backend"),
    frontend: async () => calls.push("frontend"),
    smoke: async () => calls.push("smoke"),
    ...overrides,
  };
}
it("release publica o SHA validado e preserva a sonda existente", async () => {
  const calls: string[] = [];
  const receipt = await publishRevision("a".repeat(40), releaseOperations(calls), () => {});
  expect(receipt).toMatchObject({ state: "validated", backendSha: "a".repeat(40) });
  expect(receipt.before).toBe(receipt.after);
  expect(calls).toEqual(["preflight", "build", "backend", "frontend", "smoke"]);
});
it("release recusa candidato obsoleto, sonda ausente e dados alterados", async () => {
  const calls: string[] = [];
  const obsolete = await publishRevision(
    "a".repeat(40),
    releaseOperations(calls, { eligible: async () => false }),
    () => {},
  );
  expect(obsolete.state).toBe("obsolete");
  expect(calls).toEqual(["preflight", "build"]);
  const missing: string[] = [];
  await expect(
    publishRevision(
      "a".repeat(40),
      releaseOperations(missing, { probe: async () => null }),
      () => {},
    ),
  ).rejects.toThrow("state=failed-before-publication");
  expect(missing).not.toContain("backend");
  let nonce = "synthetic";
  const receipts: Receipt[] = [];
  await expect(
    publishRevision(
      "a".repeat(40),
      releaseOperations([], {
        probe: async () => ({ key: "persistence-v1", nonce }),
        smoke: async () => {
          nonce = "reset";
        },
      }),
      (r: Receipt) => receipts.push(r),
    ),
  ).rejects.toThrow("failed in persistence; state=partial");
  expect(receipts.at(-1)).toMatchObject({ state: "partial", phase: "persistence" });
});
it("release não é aprovado com smoke incompleto nem expõe o erro do provedor", async () => {
  const receipts: Receipt[] = [];
  await expect(
    publishRevision(
      "a".repeat(40),
      releaseOperations([], {
        smoke: async () => {
          throw new Error("private-provider-secret");
        },
      }),
      (r: Receipt) => receipts.push(r),
    ),
  ).rejects.toThrow("failed in smoke; state=partial");
  expect(receipts.at(-1)).toMatchObject({ state: "partial", phase: "smoke" });
  expect(receipts.some((r) => r.state === "validated")).toBe(false);
  expect(JSON.stringify(receipts)).not.toContain("private-provider-secret");
});
it("bootstrap publica sem exigir sonda anterior e aguarda prova de login", async () => {
  const calls: string[] = [];
  let probe: { key: string; nonce: string } | null = null;
  const operations = {
    preflight: async () => {
      calls.push("preflight");
    },
    build: async () => {
      calls.push("build");
    },
    eligible: async () => true,
    backend: async () => {
      calls.push("backend");
    },
    initializeProbe: async () => {
      calls.push("initialize");
      probe ??= { key: "persistence-v1", nonce: "synthetic" };
    },
    probe: async () => {
      expect(probe).not.toBeNull();
      return probe;
    },
    frontend: async () => {
      calls.push("frontend");
    },
    smoke: async () => {
      calls.push("smoke");
    },
  };
  const first = await bootstrapRevision("a".repeat(40), operations, () => {});
  expect(first.state).toBe("awaiting-auth-proof");
  expect(first.before).toBe(first.after);
  expect(calls).toEqual(["preflight", "build", "backend", "initialize", "frontend", "smoke"]);
  const second = await bootstrapRevision("a".repeat(40), operations, () => {});
  expect(second.after).toBe(first.after);
});
it("bootstrap recusa candidato obsoleto e registra publicacao parcial sem expor segredo", async () => {
  const calls: string[] = [];
  const receipts: { state: string; phase: string }[] = [];
  const operations = {
    preflight: async () => {},
    build: async () => {},
    eligible: async () => false,
    backend: async () => {
      calls.push("backend");
      throw new Error("private-provider-secret");
    },
  };
  expect(
    (
      await bootstrapRevision("a".repeat(40), operations, (r: { state: string; phase: string }) =>
        receipts.push(r),
      )
    ).state,
  ).toBe("obsolete");
  expect(calls).toEqual([]);
  await expect(
    bootstrapRevision(
      "a".repeat(40),
      { ...operations, eligible: async () => true },
      (r: { state: string; phase: string }) => receipts.push(r),
    ),
  ).rejects.toThrow("Bootstrap failed in backend; state=partial");
  expect(receipts.at(-1)).toMatchObject({ state: "partial", phase: "backend" });
  expect(JSON.stringify(receipts)).not.toContain("private-provider-secret");
});
type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = Record<string, unknown> & { steps?: Step[] };
// Expressões comparadas sem `${{ }}` e sem espaços, para que reformatar o
// workflow não quebre a prova e mudar a condição quebre.
const expression = (value: unknown) =>
  String(value)
    .replace(/^\$\{\{([\s\S]*)\}\}$/, "$1")
    .replace(/\s+/g, "");
it("o workflow publica as atualizações da main sem repetir a CI e conserva bootstrap manual", () => {
  const text = readFileSync(new URL(".github/workflows/deploy.yml", repoUrl), "utf8");
  const workflow = parse(text) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
  expect(workflow.on.push).toEqual({ branches: ["main"] });
  // A CI da PR é a validação e o merge publica sozinho: um job só, sem CI nem gate humano.
  expect(Object.keys(workflow.jobs)).toEqual(["publish"]);
  expect(workflow).not.toHaveProperty("permissions.pull-requests");
  expect(text).not.toContain("ci.yml");
  expect(text).not.toContain("tested_sha");
  const publishers = Object.values(workflow.jobs).filter((job) =>
    job.steps?.some((step) => step.run?.includes("deploy-platform.mjs")),
  );
  expect(publishers).toHaveLength(1);
  const publish = publishers[0]!;
  expect(publish.needs).toBeUndefined();
  expect(expression(publish.if)).toBe(
    "github.ref=='refs/heads/main'&&(github.event_name=='push'||inputs.approved_sha==github.sha)",
  );
  expect(publish.concurrency).toEqual({ group: "production", "cancel-in-progress": false });
  const steps = publish.steps!;
  const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
  const release = steps.findIndex(
    (step) => step.run?.trim() === "node scripts/deploy/deploy-platform.mjs",
  );
  expect(checkout).toBeGreaterThanOrEqual(0);
  expect(checkout).toBeLessThan(release);
  expect(expression(steps[checkout]!.with?.ref)).toBe("github.sha");
  const env = Object.fromEntries(
    Object.entries(steps[release]!.env ?? {}).map(([key, value]) => [key, expression(value)]),
  );
  expect(env).toMatchObject({
    RELEASE_OPERATION: "github.event_name=='push'&&'release'||inputs.operation",
    RELEASE_APPROVED_SHA: "github.event_name=='push'&&github.sha||inputs.approved_sha",
    RELEASE_PLAN_HASH:
      "github.event_name=='push'&&steps.plan.outputs.sha256||inputs.release_plan_hash",
  });
  // Ausências conferidas no texto inteiro: nenhum lugar do arquivo pode citá-las.
  expect(text).not.toContain("CLERK");
  expect(text).not.toContain("--cmd-url-env-var-name");
});

const publisher = fileURLToPath(new URL("deploy-platform.mjs", import.meta.url));
const repository = repoRoot;
/** O publicador sem credenciais nem variáveis do GitHub: só as precondições locais rodam. */
const publish = (operation: string) =>
  spawnSync(process.execPath, [publisher], {
    cwd: repository,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      RELEASE_OPERATION: operation,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
  });
it("o publicador recusa o bootstrap da instalação concluída antes de ler credenciais", (context) => {
  // A prova usa o plano versionado; ela só vale enquanto ele registra a instalação concluída.
  // Repositório público: os recibos do corte que o plano cita ficam no repositório arquivado.
  if (!existsSync(join(repository, "docs/v1.0/evidence")))
    return context.skip("recibos do corte fora da cópia pública");
  const live = JSON.parse(readFileSync(join(repository, "deploy/platform-release.json"), "utf8"));
  if (!installationRecord(live, repository).complete)
    return context.skip("deploy/platform-release.json não registra authBootstrap (novo reset)");
  const bootstrap = publish("bootstrap");
  expect(bootstrap.status).not.toBe(0);
  expect(bootstrap.stderr).toContain("Bootstrap requires an installation awaiting its login proof");
  // O release do mesmo plano passa da precondição e para só na autorização, que exige o workflow.
  const release = publish("release");
  expect(release.status).not.toBe(0);
  expect(release.stderr).not.toContain("Bootstrap requires");
  expect(release.stderr).toContain("Release requires the exact approved main SHA and plan");
});

type Tasks = Record<string, { command?: string; dependsOn?: string[] }>;

/**
 * O que roda com o publicador: os módulos locais que cada arquivo importa
 * (estático, de efeito ou dinâmico), os scripts que ele cita por caminho a
 * partir da raiz e, para cada `vp run <tarefa>`, o `vite.config.ts` e o
 * `node <script>` da tarefa e das que ela pede antes. Pacote do workspace e
 * import com caminho calculado reprovam: o código deles fica no repositório,
 * fora do grafo. Os outros pacotes do npm são do lockfile.
 */
function executableGraph(root: string, entries: string[], tasks: Tasks, notRun: string[] = []) {
  const seen = new Set<string>();
  const pending = [...entries];
  const task = (name: string) => {
    const definition = tasks[name];
    // `node [--flag[=valor]...] <script> [argumentos]`: o script é o primeiro caminho depois das flags.
    const script = /^node\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:[cm]?js|ts))(?:\s|$)/.exec(
      definition?.command ?? "",
    )?.[1];
    if (!script) throw new Error(`Tarefa ${name} não roda um script com node`);
    pending.push("vite.config.ts", script);
    for (const dependency of definition!.dependsOn ?? []) task(dependency);
  };
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    if (!existsSync(join(root, file))) throw new Error(`Arquivo ausente: ${file}`);
    seen.add(file);
    // Linhas de comentário citam imports de exemplo; o código fica com as demais.
    const source = readFileSync(join(root, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join("\n");
    if (/\bimport\s*\(\s*(?!["'`])/.test(source))
      throw new Error(`${file} importa um caminho calculado`);
    for (const [, , specifier] of source.matchAll(
      /\b(?:from|import)\s*\(?\s*(["'`])([^"'`]+)\1/g,
    )) {
      if (specifier!.startsWith("node:")) continue;
      if (specifier!.includes("${") || /^(?:#|@freecorps\/)/.test(specifier!))
        throw new Error(`${file} importa ${specifier}, fora do grafo`);
      if (!specifier!.startsWith(".")) continue;
      const target = posix.join(posix.dirname(file), specifier!);
      const found = ["", ".ts", ".mjs", ".js", ".cjs"]
        .map((ext) => target + ext)
        .find((path) => existsSync(join(root, path)));
      if (!found) throw new Error(`${file} importa ${target}, que não existe`);
      pending.push(found);
    }
    // Um script chamado por caminho a partir da raiz: run("scripts/x.mjs"),
    // spawnSync(process.execPath, [join(root, "scripts/x.mjs")]). Listas de dados ficam de fora.
    for (const [, path] of source.matchAll(
      /(?:\b(?:run|spawn|spawnSync|execFileSync)\(|\bjoin\(\w+,)\s*["'`]((?:[\w-]+\/)+[\w.-]+\.(?:[cm]?js|ts))["'`]/g,
    ))
      if (!path!.startsWith("node_modules/") && !notRun.includes(path!)) pending.push(path!);
    for (const [, name] of source.matchAll(/["']run["'],\s*["']([\w:-]+)["']/g)) task(name!);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Arquivos sem dono no CODEOWNERS. Vale a última regra que casa; uma regra com `/` no fim cobre a pasta. */
const uncovered = (rules: string[][], files: string[]) =>
  files.filter(
    (file) =>
      ![...rules]
        .reverse()
        .find(([rule]) =>
          rule!.endsWith("/") ? `/${file}`.startsWith(rule!) : rule === `/${file}`,
        )
        ?.slice(1).length,
  );

const codeownerRules = () =>
  readFileSync(join(repository, ".github/CODEOWNERS"), "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.trim().split(/\s+/));
const viteTasks = (viteConfig as unknown as { run: { tasks: Tasks } }).run.tasks;
// O publicador e o build regravam o arquivo com o SHA antes de usá-lo e o restauram depois.
const notRun = ["platform/convex/buildInfo.ts"];

it("CODEOWNERS cobre o que o publicador importa e o que ele roda com node, inclusive o build da documentação", () => {
  const rules = codeownerRules();
  const graph = executableGraph(
    repository,
    ["scripts/deploy/deploy-platform.mjs"],
    viteTasks,
    notRun,
  );
  // Os scripts chamados por caminho, o import dinâmico, o .ts fora de scripts/ e a tarefa ci:docs.
  expect(graph).toEqual(
    expect.arrayContaining([
      "scripts/build/build-fiscal-packages.mjs",
      "scripts/selfhost.mjs",
      "scripts/lib/selfhost-server.mjs",
      "lib/worktree-local.ts",
      "vite.config.ts",
      "apps/docs/scripts/build.mjs",
      "apps/docs/scripts/output.mjs",
    ]),
  );
  expect(uncovered(rules, graph)).toEqual([]);
  // A exceção continua citada pelo publicador; se sair, sai daqui também.
  expect(readFileSync(publisher, "utf8")).toContain(`"${notRun[0]}"`);
  // Casos negados: sem a regra, o build da documentação fica descoberto; uma regra
  // posterior sem dono tira a cobertura, porque vale a última.
  expect(
    uncovered(
      rules.filter(([rule]) => !rule!.startsWith("/apps/docs/")),
      graph,
    ),
  ).toEqual(["apps/docs/scripts/build.mjs", "apps/docs/scripts/output.mjs"]);
  expect(uncovered([...rules, ["/scripts/lib/repo-root.mjs"]], graph)).toEqual([
    "scripts/lib/repo-root.mjs",
  ]);
});

it("o grafo do publicador reprova o que não consegue seguir", () => {
  const root = mkdtempSync(join(tmpdir(), "fnfe-graph-"));
  try {
    const graph = (source: string, tasks: Tasks = {}) => {
      writeFileSync(join(root, "entry.mjs"), source);
      return () => executableGraph(root, ["entry.mjs"], tasks);
    };
    mkdirSync(join(root, "scripts"));
    for (const name of [
      "vite.config.ts",
      "scripts/child.mjs",
      "scripts/a.mjs",
      "scripts/b.mjs",
      "scripts/c.mjs",
      "scripts/plain.js",
    ])
      writeFileSync(join(root, name), "");
    // Import sem extensão de um arquivo .js.
    expect(graph('import "./scripts/plain";')()).toEqual(["entry.mjs", "scripts/plain.js"]);
    // Um arquivo importado que roda outro script leva esse script ao grafo.
    writeFileSync(
      join(root, "scripts/lib.mjs"),
      'spawnSync(process.execPath, [join(root, "scripts/child.mjs")]);\n// from "./comentario.mjs"',
    );
    expect(graph('import "./scripts/lib.mjs";')()).toEqual([
      "entry.mjs",
      "scripts/child.mjs",
      "scripts/lib.mjs",
    ]);
    // A tarefa do vp leva o vite.config.ts, o script dela e os das tarefas que ela pede antes.
    const tasks = {
      "ci:a": { command: "node scripts/a.mjs", dependsOn: ["ci:b"] },
      "ci:b": { command: "node --experimental-strip-types scripts/b.mjs", dependsOn: ["ci:c"] },
      "ci:c": { command: "node scripts/c.mjs -p tsconfig.json" },
    };
    expect(graph('run(vp, ["run", "ci:a"]);', tasks)()).toEqual([
      "entry.mjs",
      "scripts/a.mjs",
      "scripts/b.mjs",
      "scripts/c.mjs",
      "vite.config.ts",
    ]);
    expect(graph('run("scripts/gone.mjs");')).toThrow("Arquivo ausente: scripts/gone.mjs");
    writeFileSync(join(root, "scripts/spawned.mjs"), 'import "./missing.mjs";');
    expect(graph('run("scripts/spawned.mjs");')).toThrow("scripts/missing.mjs, que não existe");
    expect(graph('import { x } from "@freecorps/fiscal-core";')).toThrow("fora do grafo");
    expect(graph("await import(`./${name}.mjs`);")).toThrow("fora do grafo");
    expect(graph("await import(path);")).toThrow("caminho calculado");
    expect(graph('run(vp, ["run", "ci:x"]);', { "ci:x": { command: "vp build" } })).toThrow(
      "Tarefa ci:x não roda um script com node",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
