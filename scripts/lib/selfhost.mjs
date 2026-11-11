import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { isIP } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatEnvFile,
  readEnvFile,
  parseEnv,
  PLATFORM_BACKEND_ENV,
} from "./worktree/env-file.mjs";
import { localEnvironment } from "./selfhost-environment.mjs";
import { installationOrigin } from "../../platform/installation.ts";
import { installationHeaders } from "./installation-headers.mjs";

export const root = fileURLToPath(new URL("../..", import.meta.url));
const projectFor = (name) =>
  `fnfe-${name}-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 8)}`;
export const versions = JSON.parse(
  readFileSync(join(root, "deploy/selfhost/versions.json"), "utf8"),
);
export const sha = () =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
export function isolatedEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(CONVEX_|VITE_|FNFE_|APP_ENV$|PRODUCT_ENV$|FISCAL_ENV$|SITE_URL$|BETTER_AUTH_|AUTH_PROXY_|ACCOUNT_|EMAIL_|WEBHOOK_|CLOUDFLARE_|MAIL_|VALIDATION_|NODE_OPTIONS$)/i.test(
          name,
        ),
    ),
  );
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: isolatedEnv(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Falha em ${command}: ${result.error?.message ?? result.stderr ?? result.status}`,
    );
  return result.stdout;
}
export function paths(name) {
  assert.match(name, /^[a-z][a-z0-9-]{0,39}$/, "Nome inválido de instalação");
  const directory = join(root, ".selfhost", name);
  return {
    name,
    directory,
    config: join(directory, "instance.json"),
    compose: join(directory, "compose.json"),
    env: join(directory, "backend.env"),
    selector: join(directory, "selector.env"),
    dist: join(directory, "dist"),
  };
}
export function load(name) {
  const p = paths(name);
  const config = JSON.parse(readFileSync(p.config, "utf8"));
  assert.equal(config.name, name);
  assert.equal(config.project, projectFor(name), "Instalação pertence a outro checkout");
  for (const [field, host] of [
    ["cloud", "127.0.0.1"],
    ["site", "127.0.0.1"],
    ["frontend", "localhost"],
  ]) {
    const url = new URL(config[field]);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, host);
    assert.equal(url.origin, config[field]);
    assert.ok(url.port);
  }
  assert.match(config.adminKey, /^[^\r\n]+$/);
  return { ...p, ...config };
}
export function compose(instance, args) {
  return run("docker", [
    "compose",
    "--project-name",
    instance.project,
    "--file",
    instance.compose,
    ...args,
  ]);
}
export function init(name, basePort = 4410, frontendPort = 5410) {
  const p = paths(name);
  assert.ok(!existsSync(p.directory), "Instalação já existe; nenhuma configuração foi substituída");
  for (const port of [basePort, basePort + 1, frontendPort])
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  assert.equal(new Set([basePort, basePort + 1, frontendPort]).size, 3);
  const config = {
    name,
    project: projectFor(name),
    cloud: `http://127.0.0.1:${basePort}`,
    site: `http://127.0.0.1:${basePort + 1}`,
    frontend: `http://localhost:${frontendPort}`,
    backendImage: versions.backendImage,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(p.directory, { recursive: true });
  const definition = {
    services: {
      backend: {
        ...(process.env.FNFE_SELFHOST_DNS
          ? {
              dns: process.env.FNFE_SELFHOST_DNS.split(",").map((value) => {
                assert.ok(isIP(value), "DNS precisa ser um IP explícito");
                return value;
              }),
            }
          : {}),
        image: versions.backendImage,
        stop_signal: "SIGINT",
        stop_grace_period: "10s",
        entrypoint: ["bash", "/fnfe-start.sh"],
        ports: [`127.0.0.1:${basePort}:${basePort}`, `127.0.0.1:${basePort + 1}:${basePort + 1}`],
        volumes: [
          "data:/convex/data",
          {
            type: "bind",
            source: join(root, "deploy/selfhost/start.sh"),
            target: "/fnfe-start.sh",
            read_only: true,
          },
        ],
        environment: {
          CONVEX_CLOUD_ORIGIN: config.cloud,
          CONVEX_SITE_ORIGIN: config.site,
          FNFE_LOCAL_CLOUD_PORT: String(basePort),
          FNFE_LOCAL_SITE_PORT: String(basePort + 1),
          INSTANCE_NAME: name,
          INSTANCE_SECRET: randomBytes(32).toString("hex"),
          DISABLE_BEACON: "true",
          DISABLE_METRICS_ENDPOINT: "true",
          DOCUMENT_RETENTION_DELAY: "172800",
        },
        healthcheck: {
          test: ["CMD", "curl", "-f", config.cloud + "/version"],
          interval: "5s",
          timeout: "3s",
          retries: 30,
          start_period: "10s",
        },
      },
    },
    volumes: { data: {} },
  };
  writeFileSync(p.compose, JSON.stringify(definition, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(p.config, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(
    p.env,
    formatEnvFile(
      {
        APP_ENV: "development",
        PRODUCT_ENV: "sandbox",
        FISCAL_ENV: "disabled",
        FNFE_CRONS: "off",
        EMAIL_MODE: "local",
        WEBHOOK_MODE: "disabled",
        SITE_URL: config.frontend,
        BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
        FNFE_WEBHOOK_MASTER_KEY: randomBytes(32).toString("hex"),
        FNFE_PLATFORM_CERT_KEYS: JSON.stringify({
          active: "selfhost-v1",
          keys: { "selfhost-v1": randomBytes(32).toString("hex") },
        }),
      },
      "Instalação própria local, apenas dados sintéticos",
    ),
    { mode: 0o600 },
  );
  return { ...p, ...config };
}
export function start(name) {
  const p = paths(name);
  const config = JSON.parse(readFileSync(p.config, "utf8"));
  assert.equal(config.project, projectFor(name), "Instalação pertence a outro checkout");
  const instance = { ...p, ...config };
  compose(instance, ["up", "--detach", "--wait", "--wait-timeout", "120"]);
  if (!config.adminKey) {
    config.adminKey = compose(instance, [
      "exec",
      "-T",
      "backend",
      "./generate_admin_key.sh",
    ]).trim();
    writeFileSync(p.config, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }
  writeFileSync(
    p.selector,
    formatEnvFile(
      { CONVEX_SELF_HOSTED_URL: config.cloud, CONVEX_SELF_HOSTED_ADMIN_KEY: config.adminKey },
      "Seletor exclusivo deste servidor",
    ),
    { mode: 0o600 },
  );
  return load(name);
}
export function cli(instance, args) {
  console.log(`target: self-hosted local ${instance.name} ${instance.cloud}; ${args[0]}`);
  try {
    return run(
      process.execPath,
      [join(root, "node_modules/convex/bin/main.js"), ...args, "--env-file", instance.selector],
      { cwd: join(root, "platform") },
    );
  } catch (error) {
    throw new Error(error.message.replaceAll(instance.adminKey, "[redacted]"));
  }
}
export async function call(instance, kind, path, args = {}) {
  const response = await fetch(`${instance.cloud}/api/${kind}`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${instance.adminKey}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    body: JSON.stringify({ path, args, format: "json" }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.equal(result.status, "success", `${path}: ${result.errorMessage ?? response.status}`);
  return result.value;
}
export async function configure(instance) {
  const values = localEnvironment(readEnvFile(instance.env), instance.frontend);
  writeFileSync(
    instance.env,
    formatEnvFile(Object.fromEntries(values), "Instalação local isolada"),
    {
      mode: 0o600,
    },
  );
  // env set does not remove old variables. Remove integrations before publishing functions.
  for (const name of parseEnv(cli(instance, ["env", "list"])).keys())
    if (!PLATFORM_BACKEND_ENV.has(name)) cli(instance, ["env", "remove", name]);
  cli(instance, ["env", "set", "--from-file", instance.env, "--force"]);
  run(process.execPath, [join(root, "scripts/build/build-fiscal-packages.mjs")]);
  const revision = run("git", ["status", "--porcelain"]).trim() ? null : sha();
  const buildFile = join(root, "platform/convex/buildInfo.ts");
  const original = readFileSync(buildFile);
  try {
    writeFileSync(
      buildFile,
      `export const buildSha: string | null = ${JSON.stringify(revision)};\n`,
    );
    cli(instance, ["dev", "--once", "--typecheck", "disable", "--codegen", "disable"]);
  } finally {
    writeFileSync(buildFile, original);
  }
  assert.deepEqual(await call(instance, "query", "_system/frontend/listCronJobs"), []);
  const health = await (await fetch(`${instance.site}/health`)).json();
  assert.equal(health.appEnv, "development");
  assert.equal(health.fiscalEnv, "disabled");
  // A self-hosted backend chooses its own origin: it is never the NFS-e fiscal production.
  assert.equal(health.issuanceEnv, "disabled");
  assert.equal(health.sha, revision);
  return health;
}
/**
 * Variables of the console build. `productEnv` is `sandbox` for every build but the console of
 * the NFS-e fiscal production deployment (#198), whose build alone gets
 * `VITE_PRODUCT_ENV=production` (the stamp before `deployment.current` answers). The sandbox
 * builds get exactly the variables they had before.
 */
export function consoleBuildEnvironment(instance, appEnv, productEnv, revision, base) {
  if (productEnv !== "sandbox" && productEnv !== "production")
    throw new Error("Unknown product environment of the console build");
  return {
    ...base,
    VITE_CONVEX_URL: instance.cloud,
    VITE_CONVEX_SITE_URL: instance.site,
    // REST origin for downloads and the quickstart. Hosted builds pass the
    // Worker's API domain as `site`, since direct REST calls are refused there.
    VITE_API_URL: instance.site,
    VITE_APP_ENV: appEnv,
    VITE_APP_SHA: revision,
    ...(productEnv === "production" ? { VITE_PRODUCT_ENV: "production" } : {}),
  };
}
export function build(instance, appEnv = "selfhost-local", productEnv = "sandbox") {
  const env = consoleBuildEnvironment(instance, appEnv, productEnv, sha(), isolatedEnv());
  // The docs are their own step (`ci:docs`); the console build only copies them.
  run(process.execPath, [join(root, "node_modules/vite-plus/bin/vp"), "run", "ci:docs"]);
  run(
    process.execPath,
    [join(root, "node_modules/vite-plus/bin/vp"), "build", "--outDir", resolve(instance.dist)],
    { cwd: join(root, "apps/console"), env },
  );
  writeFileSync(
    join(instance.dist, "build.json"),
    JSON.stringify({ environment: appEnv, sha: sha() }) + "\n",
  );
}
/**
 * The hosted console: the shared sandbox in `.selfhost/hosted`, or, with `productEnv`
 * `production`, the console of the NFS-e fiscal production deployment in
 * `.selfhost/hosted-production`.
 */
export function buildHosted(configPath, productEnv = "sandbox") {
  const config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  for (const name of ["api", "cloud", "site", "frontend"]) installationOrigin(config[name]);
  // The installation backend refuses direct REST calls, so the console uses the public API address.
  const output = productEnv === "production" ? "hosted-production" : "hosted";
  const target = { ...paths(output), ...config, site: config.api };
  // Configuration supplies public origins only, never an output path or credentials.
  assert.deepEqual(Object.keys(config).sort(), ["api", "cloud", "frontend", "site"]);
  build(target, "installation", productEnv);
  writeFileSync(
    join(target.dist, "_headers"),
    installationHeaders(readFileSync(join(target.dist, "_headers"), "utf8"), config),
  );
}
