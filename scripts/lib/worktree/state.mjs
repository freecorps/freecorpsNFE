/**
 * Saúde e processos do worktree: o `doctor` e o registro de PIDs que deixa o
 * `cleanup` parar exatamente o que este worktree subiu, e nada mais.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { isLocalWorktreeSiteUrl } from "../../../lib/worktree-local.ts";
import { localUrls, readLocalConfig } from "./deployment.mjs";
import { PLATFORM_BACKEND_ENV, readEnvFile } from "./env-file.mjs";
import { commandResult, fail } from "./exec.mjs";
import { readProcessIdentity, recordedProcessIsRunning } from "./process-identity.mjs";
import { NODE_RUNTIME_VERSION, normalizePath } from "./paths.mjs";
import { randomUUID } from "node:crypto";
import { isLinkedWorktree } from "./registry.mjs";

export function readProcessRecord(paths) {
  if (!existsSync(paths.processFile)) return null;
  try {
    return JSON.parse(readFileSync(paths.processFile, "utf8"));
  } catch {
    return null;
  }
}

export function writeProcessRecord(paths, record, capturedIdentities) {
  // A prontidão não pode adotar um processo novo que reutilizou um PID já capturado.
  const identities =
    capturedIdentities ??
    Object.fromEntries(recordedPids(record).map((pid) => [pid, readProcessIdentity(pid)]));
  record = { ...record, identities, recordId: randomUUID() };
  writeFileSync(paths.processFile, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function recordedPids(record) {
  if (!record) return [];
  const pids = Array.isArray(record.pids) ? record.pids : [record.pid];
  return pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/**
 * A comparação passa por `normalizePath` porque a caixa da letra do drive não é
 * estável entre shells no Windows: `c:\users\...` gravado por um `dev` e
 * `C:\Users\...` derivado do git são o mesmo diretório, e compará-los como
 * string faria o `cleanup` recusar e o `devIsRunning` mentir "parado".
 */
export function recordIsForThisWorktree(record, paths) {
  return (
    Boolean(record) &&
    typeof record.cwd === "string" &&
    normalizePath(record.cwd) === normalizePath(paths.root)
  );
}

export function devIsRunning(paths) {
  const record = readProcessRecord(paths);
  if (!recordIsForThisWorktree(record, paths)) return false;
  return recordedPids(record).some((pid) => recordedProcessIsRunning(record, pid));
}

export function removeProcessRecordFor(paths, pid, expectedRecordId) {
  const record = readProcessRecord(paths);
  if (expectedRecordId && record?.recordId !== expectedRecordId) return;
  if (!record || record.pid === pid || recordedPids(record).includes(pid)) {
    rmSync(paths.processFile, { force: true });
  }
}

export const RETIRED_LEGACY_WORKTREE =
  "Este worktree foi preparado para o backoffice legado, aposentado na #345. Crie outro para a plataforma com `bun run worktree:create <nome>`; o banco em .convex/local foi preservado e só sai com `bun run worktree:remove`.";

/** Setup, dev e sync só preparam a plataforma; o legado é recusado sem tocar no banco. */
export function assertPlatformWorktree(paths) {
  if (paths.app !== "platform") fail(RETIRED_LEGACY_WORKTREE);
}

export function assertLinkedWorktree(paths) {
  if (!isLinkedWorktree(paths.root)) {
    fail(
      "Este comando só roda num worktree linked do git. Crie um com `bun run worktree:create <nome>` e rode lá.",
    );
  }
}

/**
 * Valida o isolamento de ponta a ponta: o checkout é linked, o runtime fixado
 * está presente, e todo arquivo gerado concorda sobre as mesmas URLs locais.
 */
export function doctor(paths, { quiet = false } = {}) {
  const checks = [];
  const add = (ok, label, detail = "") => checks.push({ ok, label, detail });

  let linked = false;
  try {
    linked = isLinkedWorktree(paths.root);
  } catch {
    // Reportado pela checagem abaixo.
  }
  add(linked, "Worktree do git", linked ? "linked" : "checkout principal");
  add(
    paths.app === "platform",
    "Aplicativo",
    paths.app === "platform" ? "plataforma" : "legado aposentado; crie outro worktree",
  );

  let nodeVersion = "ausente";
  if (existsSync(paths.nodeExecutable)) {
    try {
      nodeVersion = commandResult(paths.nodeExecutable, ["--version"], {
        capture: true,
        cwd: paths.root,
      }).trim();
    } catch {
      // Reportado pela checagem abaixo.
    }
  }
  add(nodeVersion === `v${NODE_RUNTIME_VERSION}`, "Node para o Convex", nodeVersion);

  // Config truncada ou malformada é UM check reprovado, não um erro solto: o
  // doctor existe justamente para dizer o que está quebrado num worktree meio
  // configurado, e um throw aqui derrubaria o relatório inteiro antes de montar.
  let config = null;
  let configDetail = "ausente";
  try {
    config = readLocalConfig(paths);
    if (config) configDetail = config.deploymentName;
  } catch {
    configDetail = "inválida";
  }
  add(config !== null, "Deployment Convex", configDetail);

  const runtime = readEnvFile(paths.runtimeEnv);
  const backend = readEnvFile(paths.backendEnv);
  const urls = config ? localUrls(config) : null;
  const runtimeSiteUrl = runtime.get("VITE_SITE_URL");

  add(
    runtime.get("CONVEX_DEPLOYMENT") ===
      `${config?.deploymentName.startsWith("anonymous-") ? "anonymous" : "local"}:${config?.deploymentName}` &&
      runtime.get("VITE_CONVEX_URL") === urls?.cloud &&
      runtime.get("VITE_CONVEX_SITE_URL") === urls?.site &&
      runtime.get("VITE_API_URL") === urls?.site &&
      isLocalWorktreeSiteUrl(runtimeSiteUrl),
    ".env.local",
    runtimeSiteUrl ?? "sem URL local",
  );
  add(
    backend.get("APP_ENV") === "development" &&
      backend.get("PRODUCT_ENV") === "sandbox" &&
      backend.get("FISCAL_ENV") === "disabled" &&
      backend.get("FNFE_CRONS") === "off" &&
      backend.get("EMAIL_MODE") === "local" &&
      backend.get("WEBHOOK_MODE") === "disabled" &&
      backend.get("SITE_URL") === runtimeSiteUrl &&
      (backend.get("BETTER_AUTH_SECRET")?.length ?? 0) >= 32 &&
      [...backend.keys()].every((key) => PLATFORM_BACKEND_ENV.has(key)),
    "Env do Convex",
    "crons off, produção desabilitada, coletor local",
  );

  for (const path of [".env.local", ".convex", "platform/.convex"]) {
    const ignored =
      spawnSync("git", ["check-ignore", "-q", path], {
        cwd: paths.root,
        stdio: "ignore",
        windowsHide: true,
      }).status === 0;
    add(ignored, `Git ignora ${path}`, ignored ? "ignorado" : "NÃO ignorado");
  }

  const record = readProcessRecord(paths);
  const pids = recordedPids(record);
  const running =
    recordIsForThisWorktree(record, paths) &&
    pids.some((pid) => recordedProcessIsRunning(record, pid));

  if (!quiet) {
    for (const check of checks) {
      console.log(`${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}`);
    }
    // Reportado, não checado: o par fixado só é escrito depois que o backend
    // sobe, então um worktree entre setups reprovaria numa checagem que ele
    // está prestes a satisfazer.
    console.log(
      `• Portas do backend Convex: ${
        config ? `${config.ports.cloud}/${config.ports.site}` : "não atribuídas"
      }`,
    );
    console.log(`• Processos de dev: ${running ? `rodando (PIDs ${pids.join(", ")})` : "parados"}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    fail(`${failed.length} checagem(ns) de saúde do worktree falhou(aram).`);
  }
  return { config, running };
}
