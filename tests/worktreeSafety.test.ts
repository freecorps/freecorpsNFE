import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureBackendEnvFile,
  parseEnv,
  formatEnvFile,
  writeRuntimeEnv,
} from "../scripts/lib/worktree/env-file.mjs";
import { localNodeEnv } from "../scripts/lib/worktree/convex-local.mjs";
import { requestedWorktreeApp, worktreePaths } from "../scripts/lib/worktree/paths.mjs";
import { assertPlatformWorktree, RETIRED_LEGACY_WORKTREE } from "../scripts/lib/worktree/state.mjs";
import { assertPrivateDirectories, withOperation } from "../scripts/lib/worktree/operation.mjs";
import { readLocalConfig } from "../scripts/lib/worktree/deployment.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fnfe-worktree-test-"));
  roots.push(root);
  const paths = worktreePaths(root);
  mkdirSync(paths.convexDir);
  return paths;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reaplica crons off e retira credenciais extras mesmo em setup repetido", () => {
  const paths = fixture();
  writeFileSync(
    paths.backendEnv,
    "FNFE_CRONS=on\nFNFE_ALLOW_PRODUCTION=true\nRESEND_API_KEY=private\n",
  );
  ensureBackendEnvFile(paths, "http://localhost:5182");
  const env = parseEnv(readFileSync(paths.backendEnv, "utf8"));
  expect(env.get("FNFE_CRONS")).toBe("off");
  expect(env.has("FNFE_ALLOW_PRODUCTION")).toBe(false);
  expect(env.get("FNFE_WEBHOOK_MASTER_KEY")).toMatch(/^[0-9a-f]{64}$/);
  ensureBackendEnvFile(paths, "http://localhost:5182");
  expect(parseEnv(readFileSync(paths.backendEnv, "utf8")).get("FNFE_WEBHOOK_MASTER_KEY")).toBe(
    env.get("FNFE_WEBHOOK_MASTER_KEY"),
  );
});

it("o subprocesso Convex descarta chaves herdadas e usa o deployment deste worktree", () => {
  const paths = fixture();
  mkdirSync(dirname(paths.localConfig), { recursive: true });
  const config = { deploymentName: "local-fixture", ports: { cloud: 3214, site: 3215 } };
  writeFileSync(paths.localConfig, JSON.stringify(config));
  vi.stubEnv("CONVEX_DEPLOY_KEY", "private");
  vi.stubEnv("CONVEX_SELF_HOSTED_URL", "https://remote.invalid");
  vi.stubEnv("CONVEX_DEPLOYMENT", "prod:remote");
  for (const key of ["AUTH_PROXY_SECRET", "ACCOUNT_EMAIL_RECIPIENTS", "CLOUDFLARE_EMAIL_API_TOKEN"])
    vi.stubEnv(key, "private");
  const env = localNodeEnv(paths);
  for (const key of ["AUTH_PROXY_SECRET", "ACCOUNT_EMAIL_RECIPIENTS", "CLOUDFLARE_EMAIL_API_TOKEN"])
    expect(env[key]).toBeUndefined();
  expect(env.CONVEX_DEPLOY_KEY).toBeUndefined();
  expect(env.CONVEX_SELF_HOSTED_URL).toBeUndefined();
  expect(env.CONVEX_DEPLOYMENT).toBe("local:local-fixture");
  writeRuntimeEnv(paths, config, "http://localhost:5176");
  expect(parseEnv(readFileSync(paths.runtimeEnv, "utf8")).get("VITE_CONVEX_URL")).toBe(
    "http://127.0.0.1:3214",
  );
});

it("preserva espaços, # e quebras de linha em dotenv", () => {
  const values = { A: "one # two", B: "line1\nline2", C: "a=b=" };
  expect(Object.fromEntries(parseEnv(formatEnvFile(values, "fixture")))).toEqual(values);
});

it("recusa dois setups simultâneos no mesmo worktree e libera ao terminar", async () => {
  const paths = fixture();
  await withOperation(paths, "setup", async () => {
    await expect(withOperation(paths, "setup", async () => {})).rejects.toThrow(/já está rodando/);
  });
  await expect(withOperation(paths, "setup", async () => "ok")).resolves.toBe("ok");
});

it("recusa junção de node_modules sem alterar o destino", () => {
  const paths = fixture();
  const other = fixture();
  const marker = join(other.root, "preservar.txt");
  writeFileSync(marker, "intacto");
  const link = join(paths.root, "node_modules");
  symlinkSync(other.root, link, "junction");
  try {
    expect(() => assertPrivateDirectories(paths)).toThrow(/junção ou symlink/);
    expect(readFileSync(marker, "utf8")).toBe("intacto");
  } finally {
    // Remove somente a ligação, antes da limpeza das raízes temporárias.
    // `rmSync` do Node 23 segue o symlink e recusa o diretório de destino.
    if (process.platform === "win32") rmdirSync(link);
    else unlinkSync(link);
  }
});

it("recusa configuração de nuvem e pares de portas inválidos", () => {
  const paths = fixture();
  mkdirSync(dirname(paths.localConfig), { recursive: true });
  for (const config of [
    { deploymentName: "production", ports: { cloud: 3210, site: 3211 } },
    { deploymentName: "anonymous-agent", ports: { cloud: 3210, site: 3213 } },
  ]) {
    writeFileSync(paths.localConfig, JSON.stringify(config));
    expect(() => readLocalConfig(paths)).toThrow(/inválida/);
  }
});

it("starts new worktrees on the platform and refuses retired legacy databases intact", () => {
  const fresh = fixture();
  expect(fresh.app).toBe("platform");
  expect(requestedWorktreeApp(fresh, undefined)).toBe("platform");
  expect(() => assertPlatformWorktree(fresh)).not.toThrow();
  // Banco do backoffice na raiz, sem worktree-app.json: reconhecido e recusado.
  const prepared = fixture();
  const legacyConfig = join(prepared.convexDir, "local", "default", "config.json");
  mkdirSync(join(prepared.convexDir, "local", "default"), { recursive: true });
  writeFileSync(legacyConfig, "{}");
  const recognized = worktreePaths(prepared.root);
  expect(recognized.app).toBe("legacy");
  expect(recognized.localConfig).toBe(legacyConfig);
  expect(requestedWorktreeApp(recognized, undefined)).toBeUndefined();
  expect(() => assertPlatformWorktree(recognized)).toThrow(RETIRED_LEGACY_WORKTREE);
  expect(readFileSync(legacyConfig, "utf8")).toBe("{}");
  const chosen = fixture();
  writeFileSync(chosen.appFile, JSON.stringify({ app: "legacy" }));
  expect(worktreePaths(chosen.root).app).toBe("legacy");
  expect(requestedWorktreeApp(chosen, undefined)).toBeUndefined();
  expect(() => assertPlatformWorktree(worktreePaths(chosen.root))).toThrow(/aposentado/);
});

it("prepares distinct platform roots and secrets", () => {
  const a = fixture(),
    b = fixture();
  for (const original of [a, b]) {
    writeFileSync(original.appFile, JSON.stringify({ app: "platform" }));
    const paths = worktreePaths(original.root);
    expect(paths.backendRoot).toBe(join(original.root, "platform"));
    expect(paths.frontendRoot).toBe(join(original.root, "apps", "console"));
    expect(paths.localConfig).toBe(
      join(original.root, "platform", ".convex", "local", "default", "config.json"),
    );
    writeFileSync(paths.backendEnv, "RESEND_API_KEY=legacy-private\nFNFE_CRONS=on\n");
    ensureBackendEnvFile(paths, "http://localhost:5182");
    const initial = parseEnv(readFileSync(paths.backendEnv, "utf8"));
    expect(initial.get("EMAIL_MODE")).toBe("local");
    expect(initial.get("FISCAL_ENV")).toBe("disabled");
    expect(initial.has("RESEND_API_KEY")).toBe(false);
    expect(initial.get("BETTER_AUTH_SECRET")!.length).toBeGreaterThanOrEqual(32);
    ensureBackendEnvFile(paths, "http://localhost:5183");
    const repeated = parseEnv(readFileSync(paths.backendEnv, "utf8"));
    expect(repeated.get("BETTER_AUTH_SECRET")).toBe(initial.get("BETTER_AUTH_SECRET"));
    expect(repeated.get("SITE_URL")).toBe("http://localhost:5183");
    expect(() => ensureBackendEnvFile(paths, "https://foreign.invalid")).toThrow("loopback");
    writeRuntimeEnv(
      paths,
      { deploymentName: "anonymous-agent", ports: { cloud: 3224, site: 3225 } },
      "http://localhost:5183",
    );
    const runtime = parseEnv(readFileSync(paths.runtimeEnv, "utf8"));
    expect(runtime.get("VITE_APP_ENV")).toBe("development");
    expect(runtime.has("VITE_CLERK_PUBLISHABLE_KEY")).toBe(false);
    expect(runtime.has("BETTER_AUTH_SECRET")).toBe(false);
    vi.stubEnv("BETTER_AUTH_SECRET", "hosted-private");
    vi.stubEnv("VALIDATION_CONVEX_DEPLOY_KEY", "hosted-private");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "hosted-private");
    expect(localNodeEnv(paths).BETTER_AUTH_SECRET).toBeUndefined();
    expect(localNodeEnv(paths).VALIDATION_CONVEX_DEPLOY_KEY).toBeUndefined();
    expect(localNodeEnv(paths).CLOUDFLARE_API_TOKEN).toBeUndefined();
  }
  expect(parseEnv(readFileSync(a.backendEnv, "utf8")).get("BETTER_AUTH_SECRET")).not.toBe(
    parseEnv(readFileSync(b.backendEnv, "utf8")).get("BETTER_AUTH_SECRET"),
  );
  writeFileSync(a.appFile, JSON.stringify({ app: "../foreign" }));
  expect(() => worktreePaths(a.root)).toThrow("Invalid worktree application");
});
